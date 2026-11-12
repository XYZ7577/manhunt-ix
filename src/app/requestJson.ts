type RequestErrorOptions = {
    fallbackMessage: string | ((response: Response) => string);
    messageFields?: readonly string[];
};

export async function fetchJson(path: string, options: RequestInit) {
    const response = await fetch(path, options);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, body };
}

export async function requestJson<T>(
    path: string,
    options: RequestInit,
    { fallbackMessage, messageFields = ['error'] }: RequestErrorOptions,
): Promise<T> {
    const { response, body } = await fetchJson(path, options);
    if (response.ok) return body as T;

    const responseMessage = messageFields.map((field) => body[field]).find(Boolean);
    if (responseMessage) throw new Error(String(responseMessage));
    const errorMessage = typeof fallbackMessage === 'function' ? fallbackMessage(response) : fallbackMessage;
    throw new Error(errorMessage);
}
