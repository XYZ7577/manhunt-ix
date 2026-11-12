import { useEffect, useState } from 'react';
import type { ImageMetadataResponse } from '../../shared/evidence/imageMetadata';
import { ActionButton } from '../ui/ActionButton';
import './imageMetadata.css';

const missing = 'Not recorded';

function cameraTime(value: string | null, offset: string | null) {
    if (!value) return missing;
    const display = value.replace(/^(\d{4}):(\d{2}):(\d{2})([ T])/, '$1-$2-$3 ');
    return offset ? `${display} · UTC${offset}` : `${display} · timezone not recorded`;
}

function coordinate(value: number | null) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(6)}°` : missing;
}

function coordinates(latitude: number | null, longitude: number | null) {
    if (
        (typeof latitude !== 'number' || !Number.isFinite(latitude)) &&
        (typeof longitude !== 'number' || !Number.isFinite(longitude))
    )
        return missing;
    return `${coordinate(latitude)}, ${coordinate(longitude)}`;
}

function altitude(value: number | null, reference: ImageMetadataResponse['summary']['altitudeReference']) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return missing;
    const height = `${value.toFixed(1)} m`;
    return reference ? `${height} ${reference}` : height;
}

function phone(make: string | null, model: string | null) {
    const details = [make, model].filter((value): value is string => !!value?.trim());
    return details.length ? [...new Set(details)].join(' ') : missing;
}

export function ImageMetadata({ evidenceId, enabled = false }: { evidenceId: string; enabled?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const [metadata, setMetadata] = useState<ImageMetadataResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!enabled || !expanded || metadata || attempt === 0) return;
        let active = true;
        const controller = new AbortController();
        setLoading(true);
        setError('');
        void (async () => {
            try {
                const response = await fetch(`/api/evidence/${encodeURIComponent(evidenceId)}/metadata`, {
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                });
                const result = (await response.json().catch(() => ({}))) as
                    | ImageMetadataResponse
                    | { error?: string };
                if (!response.ok)
                    throw new Error(
                        'error' in result && result.error ? result.error : 'Could not load photo metadata.',
                    );
                if (!('summary' in result) || !result.summary)
                    throw new Error('Photo metadata is unavailable.');
                if (active) setMetadata(result);
            } catch {
                if (active) setError('Could not load photo metadata. Try again.');
            } finally {
                if (active) setLoading(false);
            }
        })();
        return () => {
            active = false;
            controller.abort();
        };
    }, [enabled, expanded, evidenceId, metadata, attempt]);

    if (!enabled) return null;
    return (
        <section className="image-metadata">
            <ActionButton
                type="button"
                className="text-button image-metadata-toggle"
                aria-expanded={expanded}
                onClick={() => {
                    if (expanded) setExpanded(false);
                    else {
                        setExpanded(true);
                        setAttempt((value) => value + 1);
                    }
                }}
            >
                {expanded ? 'Close metadata' : 'View metadata'}
            </ActionButton>
            {expanded && (
                <div className="image-metadata-panel">
                    {loading && (
                        <p className="image-metadata-status" role="status">
                            Loading photo metadata…
                        </p>
                    )}
                    {error && (
                        <div className="image-metadata-error" role="status">
                            <span>{error}</span>
                            <ActionButton
                                type="button"
                                className="text-button"
                                onClick={() => setAttempt((value) => value + 1)}
                            >
                                Try again
                            </ActionButton>
                        </div>
                    )}
                    {metadata && <ImageMetadataDetails metadata={metadata} />}
                </div>
            )}
        </section>
    );
}

export function ImageMetadataDetails({ metadata }: { metadata: ImageMetadataResponse }) {
    const { summary, sections, notice } = metadata;
    return (
        <>
            <dl className="image-metadata-summary">
                <div>
                    <dt>Camera time</dt>
                    <dd>{cameraTime(summary.capturedAtLocal, summary.capturedAtOffset)}</dd>
                </div>
                <div>
                    <dt>GPS coordinates</dt>
                    <dd>{coordinates(summary.latitude, summary.longitude)}</dd>
                </div>
                <div>
                    <dt>Phone / camera</dt>
                    <dd>{phone(summary.make, summary.model)}</dd>
                </div>
                <div>
                    <dt>GPS altitude</dt>
                    <dd>{altitude(summary.altitudeMeters, summary.altitudeReference)}</dd>
                </div>
            </dl>
            {notice && <p className="image-metadata-notice">{notice}</p>}
            {sections.length > 0 && (
                <details className="image-metadata-additional">
                    <summary>Additional metadata</summary>
                    <div className="image-metadata-sections">
                        {sections.map((section, index) => (
                            <section className="image-metadata-group" key={`${section.name}-${index}`}>
                                <h4>{section.name}</h4>
                                <dl>
                                    {section.entries.map((entry, entryIndex) => (
                                        <div key={`${entry.name}-${entryIndex}`}>
                                            <dt>{entry.name}</dt>
                                            <dd>{entry.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>
                        ))}
                    </div>
                </details>
            )}
        </>
    );
}
