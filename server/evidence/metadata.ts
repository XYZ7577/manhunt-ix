import { GAME_DATE, getTaskDefinition } from '../../shared/event/tasks';
import type { MetadataResult } from '../../shared/types';

type Tags = Record<string, unknown>;
const pad = (n: number) => String(n).padStart(2, '0');

function localDate(value: unknown): string | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    }
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
    if (m) return validatedDateTime(m);
    const iso = value
        .trim()
        .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-]\d{2}:?\d{2}))?$/i);
    if (iso) return validatedDateTime(iso);
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
        const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
        if (parts) return `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}`;
    }
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function validatedDateTime(m: RegExpMatchArray): string | null {
    const [, year, month, day, hour, minute, second] = m;
    const y = Number(year),
        mo = Number(month),
        d = Number(day),
        h = Number(hour),
        mi = Number(minute),
        s = Number(second);
    const maxDay = mo >= 1 && mo <= 12 ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 0;
    if (d < 1 || d > maxDay || h > 23 || mi > 59 || s > 60) return null;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function offsetString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!m || Number(m[2]) > 14 || Number(m[3]) > 59) return null;
    return `${m[1]}${m[2]}:${m[3]}`;
}

function singaporeClock(raw: string, offset: string | null): string {
    const [date, time] = raw.split('T');
    if (!offset) return raw;
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi, s] = time.split(':').map(Number);
    const sign = offset[0] === '-' ? -1 : 1;
    const offMin = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    const utc = Date.UTC(y, mo - 1, d, h, mi, s) - offMin * 60_000;
    const sg = new Date(utc + 8 * 60 * 60_000);
    return `${sg.getUTCFullYear()}-${pad(sg.getUTCMonth() + 1)}-${pad(sg.getUTCDate())}T${pad(sg.getUTCHours())}:${pad(sg.getUTCMinutes())}:${pad(sg.getUTCSeconds())}`;
}

export function evaluatePhotoMetadata(tags: Tags, taskId: string): MetadataResult {
    const dateField =
        tags.DateTimeOriginal != null
            ? 'DateTimeOriginal'
            : tags.CreateDate != null
              ? 'CreateDate'
              : tags.DateTimeDigitized != null
                ? 'DateTimeDigitized'
                : null;
    const dateValue = dateField ? tags[dateField] : null;
    const raw = localDate(dateValue);
    const offsetTag =
        dateField === 'DateTimeOriginal'
            ? tags.OffsetTimeOriginal
            : dateField === 'CreateDate' || dateField === 'DateTimeDigitized'
              ? tags.OffsetTimeDigitized
              : null;
    const dateOffset =
        typeof dateValue === 'string'
            ? (dateValue.trim().match(/(?:Z|([+-]\d{2}:?\d{2}))$/i)?.[1] ??
              (dateValue.trim().endsWith('Z') ? '+00:00' : null))
            : null;
    const offset = offsetString(offsetTag ?? dateOffset);
    if (!raw) {
        const invalid = dateValue != null;
        return {
            capturedAt: null,
            rawDate: null,
            timezone: null,
            status: 'unavailable',
            flags: [
                invalid
                    ? 'The recorded capture date is invalid and cannot be checked.'
                    : 'Capture date is unavailable.',
            ],
            source: dateField,
        };
    }
    const hasOffset = !!offset;
    const sg = singaporeClock(raw, offset);
    const flags: string[] = [];
    let status: MetadataResult['status'] = hasOffset ? 'consistent' : 'uncertain';
    if (!hasOffset) flags.push('Capture timezone is not recorded; the camera clock cannot be confirmed.');
    if (sg.slice(0, 10) !== GAME_DATE) {
        status = 'mismatch';
        flags.push(`Recorded capture date does not match ${GAME_DATE}.`);
    }
    if (taskId === 'rapid-order') {
        const clock = sg.slice(11, 19);
        const task = getTaskDefinition(taskId);
        const inWindow = !!task?.timeWindows?.some(([start, end]) => clock >= start && clock <= end);
        if (sg.slice(0, 10) === GAME_DATE && !inWindow) {
            status = hasOffset ? 'mismatch' : 'uncertain';
            flags.push('Recorded capture time is outside the Rapid Order windows (Singapore time).');
        }
    }
    const capturedAt = hasOffset ? `${raw}${offset}` : raw;
    return {
        capturedAt,
        rawDate: raw,
        timezone: offset,
        status,
        flags,
        source: dateField ? `EXIF ${dateField}` : null,
    };
}
