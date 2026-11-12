export function authJson(data: unknown, status = 200, headers: HeadersInit = {}): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('Pragma', 'no-cache');
    return Response.json(data, { status, headers: responseHeaders });
}

export function authError(message: string, status = 400): Response {
    return authJson({ error: message }, status);
}
