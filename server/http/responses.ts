export function privateJson(data: unknown, status = 200, headers: HeadersInit = {}): Response {
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has('Cache-Control')) responseHeaders.set('Cache-Control', 'private, no-store');
    return Response.json(data, { status, headers: responseHeaders });
}

export function privateError(message: string, status = 400): Response {
    return privateJson({ error: message }, status);
}
