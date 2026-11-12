const ITERATIONS = 100_000;
const encoder = new TextEncoder();

function fromBase64(value: string) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function passwordHash(password: string, salt?: Uint8Array) {
    const bytes = new Uint8Array(salt ?? crypto.getRandomValues(new Uint8Array(16)));
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
        'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: bytes, iterations: ITERATIONS },
        key,
        256,
    );
    return {
        salt: btoa(String.fromCharCode(...bytes)),
        hash: btoa(String.fromCharCode(...new Uint8Array(bits))),
    };
}

export async function passwordMatches(password: string, salt: string, expected: string) {
    const actual = fromBase64((await passwordHash(password, fromBase64(salt))).hash);
    const expectedBytes = fromBase64(expected);
    return (
        actual.length === expectedBytes.length &&
        actual.reduce((difference, value, index) => difference | (value ^ expectedBytes[index]), 0) === 0
    );
}
