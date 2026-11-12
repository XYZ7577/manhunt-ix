import type { Account } from '../../shared/types';
import { SUBMISSIONS_OPEN_SQL } from './submissionSettings';

export interface EvidencePreviewEnv {
    DB: D1Database;
    EVIDENCE: R2Bucket;
}
export interface EvidencePreviewDeps {
    currentAccount(request: Request, env: EvidencePreviewEnv): Promise<Account | null>;
}

export const MAX_EVIDENCE_PREVIEW_BYTES = 200 * 1024;
const MAX_MULTIPART_BYTES = MAX_EVIDENCE_PREVIEW_BYTES + 16 * 1024;
const json = (data: unknown, status = 200) =>
    Response.json(data, {
        status,
        headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' },
    });
const fail = (error: string, status = 400) => json({ error }, status);

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_MULTIPART_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

function previewType(bytes: Uint8Array): 'image/jpeg' | 'image/webp' | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    )
        return 'image/webp';
    return null;
}

export async function handleEvidencePreview(
    request: Request,
    env: EvidencePreviewEnv,
    deps: EvidencePreviewDeps,
): Promise<Response | null> {
    const match = new URL(request.url).pathname.match(/^\/api\/evidence\/([0-9a-f-]{36})\/preview$/i);
    if (!match) return null;
    const evidenceId = match[1];
    const method = request.method.toUpperCase();
    const me = await deps.currentAccount(request, env);
    if (!me) return fail('Sign in to access evidence.', 401);

    const row = await env.DB.prepare(
        `SELECT e.id,e.object_key AS original_key,s.group_id,s.status,p.object_key,p.media_type,p.size
    FROM evidence e JOIN submissions s ON s.id=e.submission_id
    LEFT JOIN evidence_previews p ON p.evidence_id=e.id
    WHERE e.id=?`,
    )
        .bind(evidenceId)
        .first<any>();
    if (!row || (me.role !== 'admin' && row.group_id !== me.groupId))
        return fail('Evidence preview not found.', 404);

    if (method === 'GET') {
        if (!row.object_key) return fail('Evidence preview not found.', 404);
        const preview = await env.EVIDENCE.get(row.object_key);
        if (!preview) return fail('Evidence preview not found.', 404);
        return new Response(preview.body, {
            headers: {
                'Content-Type': row.media_type,
                'Content-Length': String(row.size),
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
            },
        });
    }

    if (method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    if (me.role !== 'player' || row.group_id !== me.groupId || row.status !== 'draft')
        return fail('Only your group can preview draft evidence.', 404);
    if (row.object_key) return json({ previewUrl: `/api/evidence/${evidenceId}/preview` });

    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > MAX_MULTIPART_BYTES) return fail('Preview is larger than the 200 KiB limit.', 413);
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data;'))
        return fail('Choose a small JPEG or WebP preview.');
    const body = await readBoundedBody(request);
    if (!body) return fail('Preview request is too large. Create a smaller preview and try again.', 413);
    let form: FormData;
    try {
        const bodyCopy = new Uint8Array(new ArrayBuffer(body.byteLength));
        bodyCopy.set(body);
        form = await new Request(request.url, {
            method: 'POST',
            headers: request.headers,
            body: bodyCopy.buffer,
        }).formData();
    } catch {
        return fail('The image preview could not be read.');
    }
    const file = form.get('preview');
    if (!(file instanceof File) || file.size === 0) return fail('Choose an image preview to upload.');
    if (file.size > MAX_EVIDENCE_PREVIEW_BYTES) return fail('Preview is larger than the 200 KiB limit.', 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mediaType = previewType(bytes);
    if (!mediaType) return fail('Preview must be a JPEG or WebP image.');

    const objectKey = `evidence-previews/${evidenceId}/${crypto.randomUUID()}`;
    await env.EVIDENCE.put(objectKey, bytes, { httpMetadata: { contentType: mediaType } });
    try {
        const stored = await env.DB.prepare(
            `INSERT INTO evidence_previews(evidence_id,object_key,media_type,size,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM evidence e JOIN submissions s ON s.id=e.submission_id
        WHERE e.id=? AND s.group_id=? AND s.status='draft' AND ${SUBMISSIONS_OPEN_SQL}
          AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=s.group_id)
      ) ON CONFLICT(evidence_id) DO NOTHING`,
        )
            .bind(
                evidenceId,
                objectKey,
                mediaType,
                bytes.byteLength,
                new Date().toISOString(),
                evidenceId,
                me.groupId,
            )
            .run();
        if (!stored.meta.changes) await env.EVIDENCE.delete(objectKey).catch(() => {});
    } catch (error) {
        await env.EVIDENCE.delete(objectKey);
        throw error;
    }
    const saved = await env.DB.prepare('SELECT object_key FROM evidence_previews WHERE evidence_id=?')
        .bind(evidenceId)
        .first<{ object_key: string }>();
    return saved
        ? json({ previewUrl: `/api/evidence/${evidenceId}/preview` }, 201)
        : fail('Evidence changed while saving its preview.', 409);
}

export async function deleteEvidencePreview(env: EvidencePreviewEnv, evidenceId: string): Promise<void> {
    const row = await env.DB.prepare('SELECT object_key FROM evidence_previews WHERE evidence_id=?')
        .bind(evidenceId)
        .first<{ object_key: string }>();
    if (!row) return;
    await env.DB.prepare('DELETE FROM evidence_previews WHERE evidence_id=?').bind(evidenceId).run();
    await env.EVIDENCE.delete(row.object_key);
}
