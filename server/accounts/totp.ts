const encoder = new TextEncoder();
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomTotpSecret(bytes = crypto.getRandomValues(new Uint8Array(20))): string {
    let bits = 0,
        value = 0,
        output = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits) output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

export function base32Decode(value: string): Uint8Array {
    let bits = 0,
        buffer = 0;
    const out: number[] = [];
    for (const char of value.toUpperCase().replace(/=+$/g, '')) {
        const index = ALPHABET.indexOf(char);
        if (index < 0) throw new Error('Invalid base32 secret');
        buffer = (buffer << 5) | index;
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

export async function totpAt(secret: string, epochSeconds: number): Promise<string> {
    const counter = Math.floor(epochSeconds / 30);
    const message = new Uint8Array(8);
    let remaining = counter;
    for (let i = 7; i >= 0; i--) {
        message[i] = remaining & 255;
        remaining = Math.floor(remaining / 256);
    }
    const secretBytes: Uint8Array<ArrayBuffer> = Uint8Array.from(base32Decode(secret));
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, [
        'sign',
    ]);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    const offset = mac[mac.length - 1] & 0x0f;
    const binary =
        ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(binary % 1_000_000).padStart(6, '0');
}

function constantEqual(a: string, b: string): boolean {
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++)
        diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
}

export async function verifyTotp(
    secret: string,
    code: string,
    epochSeconds = Date.now() / 1000,
): Promise<number | null> {
    if (!/^\d{6}$/.test(code)) return null;
    const currentStep = Math.floor(epochSeconds / 30);
    let matched: number | null = null;
    for (const step of [currentStep - 1, currentStep, currentStep + 1]) {
        const candidate = await totpAt(secret, step * 30);
        if (constantEqual(candidate, code)) matched = step;
    }
    return matched;
}

export async function encryptTotpSecret(secret: string, base64Key: string): Promise<string> {
    const raw = Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0));
    if (raw.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must decode to 32 bytes');
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(secret)),
    );
    const all = new Uint8Array(iv.length + encrypted.length);
    all.set(iv);
    all.set(encrypted, iv.length);
    return btoa(Array.from(all, (byte) => String.fromCharCode(byte)).join(''));
}

export async function decryptTotpSecret(ciphertext: string, base64Key: string): Promise<string> {
    const raw = Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0));
    if (raw.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must decode to 32 bytes');
    const all = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
    if (all.length < 29) throw new Error('Invalid TOTP ciphertext');
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    return new TextDecoder().decode(clear);
}
