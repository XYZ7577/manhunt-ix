import type { Account } from '../../shared/types';

const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function handleDraftNote(
    request: Request,
    env: { DB: D1Database },
    account: Account,
): Promise<Response | null> {
    const match = new URL(request.url).pathname.match(/^\/api\/submissions\/([^/]+)\/note$/);
    if (!match || request.method !== 'PATCH') return null;
    if (account.role !== 'player' || !account.groupId)
        return json({ error: 'Only players can edit their group draft.' }, 403);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 24_000) {
                await reader.cancel();
                return json({ error: 'The draft note is too large.' }, 413);
            }
            chunks.push(chunk.value);
        }
    }
    let body: any;
    try {
        body = JSON.parse(await new Blob(chunks as BlobPart[]).text());
    } catch {
        return json({ error: 'Enter a draft note and its previous saved value.' }, 400);
    }
    if (
        typeof body?.note !== 'string' ||
        typeof body?.previousNote !== 'string' ||
        body.note.length > 2000 ||
        body.previousNote.length > 2000
    ) {
        return json({ error: 'Enter a note of up to 2,000 characters and its previous saved value.' }, 400);
    }
    const result = await env.DB.prepare(
        `UPDATE submissions SET note=? WHERE id=? AND group_id=? AND status='draft' AND note=?
    AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id)`,
    )
        .bind(body.note, match[1], account.groupId, body.previousNote)
        .run();
    if (result.meta.changes) return json({ note: body.note });
    const latest = await env.DB.prepare(
        `SELECT note,status FROM submissions WHERE id=? AND group_id=?
    AND NOT EXISTS (SELECT 1 FROM group_disbands d WHERE d.group_id=submissions.group_id)`,
    )
        .bind(match[1], account.groupId)
        .first<{ note: string; status: string }>();
    if (!latest) return json({ error: 'Draft submission not found.' }, 404);
    if (latest.status !== 'draft') return json({ error: 'This submission is no longer a draft.' }, 409);
    if (latest.note === body.note) return json({ note: latest.note });
    return json(
        { error: 'Another group member changed this note. Choose which version to keep.', note: latest.note },
        409,
    );
}
