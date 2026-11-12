import type { Account } from '../../shared/types';
import { privateError as fail } from '../http/responses';

type EvidenceFileEnv = {
    DB: D1Database;
    EVIDENCE: R2Bucket;
};

type ByteRange = { start: number; end: number };
type ParsedByteRange = ByteRange | 'invalid' | null;

type EvidenceFileRow = {
    group_id: string;
    filename: string;
    media_type: string;
    object_key: string;
    size: number;
};

function parseByteRange(header: string | null, fileSize: number): ParsedByteRange {
    if (!header) return null;

    const match = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
    if (!match || fileSize <= 0 || (!match[1] && !match[2])) return 'invalid';

    let start: number;
    let end: number;

    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';

        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : fileSize - 1;

        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            start >= fileSize
        ) {
            return 'invalid';
        }

        end = Math.min(end, fileSize - 1);
    }

    return { start, end };
}

export async function handleEvidenceFile(
    request: Request,
    env: EvidenceFileEnv,
    account: Account,
): Promise<Response | null> {
    const match = new URL(request.url).pathname.match(/^\/api\/evidence\/([^/]+)\/file$/);
    const method = request.method.toUpperCase();
    if (!match || (method !== 'GET' && method !== 'HEAD')) return null;

    const evidence = await env.DB.prepare(
        'SELECT e.*,s.group_id FROM evidence e JOIN submissions s ON s.id=e.submission_id WHERE e.id=?',
    )
        .bind(match[1])
        .first<EvidenceFileRow>();

    if (!evidence || (account.role !== 'admin' && evidence.group_id !== account.groupId)) {
        return fail('Evidence not found.', 404);
    }

    const filename = evidence.filename;
    const safeName = filename.replace(/[^\x20-\x7E]|["\\;]/g, '_');
    const encodedName = encodeURIComponent(filename).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const disposition = evidence.media_type === 'application/octet-stream' ? 'attachment' : 'inline';
    const headers = {
        'Content-Type': evidence.media_type,
        'Content-Disposition': `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
    };

    if (method === 'HEAD' && !(await env.EVIDENCE.head(evidence.object_key))) {
        return fail('Evidence file not found.', 404);
    }

    const range = parseByteRange(request.headers.get('Range'), evidence.size);
    if (range === 'invalid') {
        return new Response(null, {
            status: 416,
            headers: {
                ...headers,
                'Content-Range': `bytes */${evidence.size}`,
                'Content-Length': '0',
            },
        });
    }

    if (range) {
        const byteLen = range.end - range.start + 1;
        const object =
            method === 'HEAD'
                ? null
                : await env.EVIDENCE.get(evidence.object_key, {
                      range: { offset: range.start, length: byteLen },
                  });

        if (method === 'GET' && !object) return fail('Evidence file not found.', 404);

        return new Response(object?.body ?? null, {
            status: 206,
            headers: {
                ...headers,
                'Content-Range': `bytes ${range.start}-${range.end}/${evidence.size}`,
                'Content-Length': String(byteLen),
            },
        });
    }

    const object = method === 'HEAD' ? null : await env.EVIDENCE.get(evidence.object_key);
    if (method === 'GET' && !object) return fail('Evidence file not found.', 404);

    return new Response(object?.body ?? null, {
        headers: { ...headers, 'Content-Length': String(evidence.size) },
    });
}
