import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ActionButton } from '../ui/ActionButton';
import { clearCaptures, recordCapture } from './cameraCapture';
import { formatEvidenceSize, shouldDeferOriginalImage } from './evidenceMediaPolicy';
import './evidencePicker.css';

export interface EvidencePickerProps {
    media?: 'photo' | 'video';
    multiple?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    heading?: string;
    queued?: boolean;
    onSelect: (files: FileList) => void;
}

export function EvidencePicker({
    media,
    multiple = false,
    disabled = false,
    disabledReason,
    heading = 'Add evidence',
    queued = false,
    onSelect,
}: EvidencePickerProps) {
    const cameraOpenedAt = useRef<number | null>(null);
    const cameraInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const input = cameraInput.current;
        if (!input) return;
        const clearOpenedAt = () => {
            cameraOpenedAt.current = null;
        };
        input.addEventListener('cancel', clearOpenedAt);
        return () => input.removeEventListener('cancel', clearOpenedAt);
    }, [media]);
    const select = (event: ChangeEvent<HTMLInputElement>) => {
        const files = event.currentTarget.files;
        if (files?.length) {
            clearCaptures(files);
            onSelect(files);
        }
        event.currentTarget.value = '';
    };
    const selectPhoto = (event: ChangeEvent<HTMLInputElement>) => {
        const files = event.currentTarget.files;
        if (files?.length) {
            const openedAt = cameraOpenedAt.current;
            if (openedAt === null) clearCaptures(files);
            else recordCapture(files, openedAt, Date.now());
            onSelect(files);
        }
        cameraOpenedAt.current = null;
        event.currentTarget.value = '';
    };
    const capturePhoto = media === 'photo';
    const captureVideo = media === 'video';

    return (
        <>
            <fieldset className="evidence-picker" disabled={disabled}>
                <legend>{heading}</legend>
                <p className="evidence-picker-help">
                    Evidence is visible to your group and authorised organisers. Original files may contain
                    location data. Get permission before uploading identifiable people; for anyone under 13,
                    ask their parent or guardian to <a href="/privacy#privacy-contact">contact us</a> first.
                    See the <a href="/privacy">Privacy Policy</a>.
                </p>
                {capturePhoto && (
                    <label className="evidence-picker-option">
                        <input
                            type="file"
                            accept="image/*"
                            capture="environment"
                            aria-label="Take a photo"
                            ref={cameraInput}
                            onClick={() => {
                                cameraOpenedAt.current = Date.now();
                            }}
                            onChange={selectPhoto}
                        />
                        <span className="evidence-picker-option-title">Take a photo</span>
                        <span className="evidence-picker-option-hint">Open your camera</span>
                    </label>
                )}
                {captureVideo && (
                    <label className="evidence-picker-option">
                        <input
                            type="file"
                            accept="video/*"
                            capture="environment"
                            aria-label="Record a video"
                            onChange={select}
                        />
                        <span className="evidence-picker-option-title">Record a video</span>
                        <span className="evidence-picker-option-hint">Open your camera</span>
                    </label>
                )}
                <label className="evidence-picker-option">
                    <input
                        type="file"
                        multiple={multiple}
                        disabled={disabled}
                        aria-label={multiple ? 'Choose files' : 'Choose a file'}
                        onChange={select}
                    />
                    <span className="evidence-picker-option-title">
                        {queued ? 'Add more files' : multiple ? 'Choose files' : 'Choose a file'}
                    </span>
                    <span className="evidence-picker-option-hint">
                        Photos, videos, or any file type · up to 2 GB each
                    </span>
                </label>
                <p className="evidence-picker-help" aria-live="polite">
                    {queued
                        ? 'Choose the same file again if its upload was interrupted.'
                        : 'Camera capture is optional; you can always choose an existing file instead.'}
                </p>
            </fieldset>
            {disabled && (
                <ActionButton
                    className="button secondary evidence-picker-disabled-reason"
                    type="button"
                    disabled
                    unavailableReason={disabledReason || 'Evidence selection is unavailable right now.'}
                >
                    Evidence selection unavailable
                </ActionButton>
            )}
        </>
    );
}

export interface EvidencePreviewProps {
    src: string;
    originalUrl: string;
    alt: string;
    size?: number;
}

export function EvidencePreview({ src, originalUrl, alt, size = 0 }: EvidencePreviewProps) {
    const [requestedSrc, setRequestedSrc] = useState('');
    const [failedSrc, setFailedSrc] = useState('');
    if (failedSrc === src)
        return (
            <div className="evidence-image-placeholder" role="status">
                <small>The image preview could not be loaded.</small>
                <ActionButton
                    className="button secondary small-button"
                    type="button"
                    onClick={() => setFailedSrc('')}
                >
                    Try again
                </ActionButton>
                <a href={originalUrl} target="_blank" rel="noreferrer">
                    Open original
                </a>
            </div>
        );
    if (shouldDeferOriginalImage(src, originalUrl, size) && requestedSrc !== src)
        return (
            <div className="evidence-image-placeholder">
                <small>Original image · {formatEvidenceSize(size)}</small>
                <ActionButton
                    className="button secondary small-button"
                    type="button"
                    onClick={() => setRequestedSrc(src)}
                >
                    Load original image
                </ActionButton>
            </div>
        );
    return (
        <a className="evidence-preview-link" href={originalUrl} target="_blank" rel="noreferrer">
            <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
        </a>
    );
}

const MAX_PREVIEW_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 200 * 1024;
const PREVIEW_SIZE = 960;

export async function createEvidencePreview(file: File): Promise<Blob | null> {
    if (!file.type.startsWith('image/') || file.size <= 0 || file.size > MAX_PREVIEW_SOURCE_BYTES)
        return null;

    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    let timeoutId = 0;
    try {
        await Promise.race([
            image.decode(),
            new Promise<never>((_, reject) => {
                timeoutId = window.setTimeout(() => reject(new Error('Image preview timed out.')), 10_000);
            }),
        ]);
        if (
            !image.naturalWidth ||
            !image.naturalHeight ||
            image.naturalWidth * image.naturalHeight > 24_000_000
        )
            return null;

        const scale = Math.min(1, PREVIEW_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
        let width = Math.max(1, Math.round(image.naturalWidth * scale));
        let height = Math.max(1, Math.round(image.naturalHeight * scale));
        for (let attempt = 0; attempt < 5; attempt++) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context) return null;
            context.drawImage(image, 0, 0, width, height);
            const preview = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, 'image/jpeg', Math.max(0.45, 0.82 - attempt * 0.08)),
            );
            canvas.width = 0;
            canvas.height = 0;
            if (preview && preview.size <= MAX_PREVIEW_BYTES) return preview;
            width = Math.max(1, Math.round(width * 0.75));
            height = Math.max(1, Math.round(height * 0.75));
        }
        return null;
    } catch {
        return null;
    } finally {
        window.clearTimeout(timeoutId);
        image.src = '';
        URL.revokeObjectURL(url);
    }
}

export async function saveEvidencePreview(evidenceId: string, preview: Blob): Promise<boolean> {
    if (
        !evidenceId ||
        preview.size > MAX_PREVIEW_BYTES ||
        !['image/jpeg', 'image/webp'].includes(preview.type)
    )
        return false;
    const form = new FormData();
    form.append('preview', preview, 'preview.jpg');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`/api/evidence/${encodeURIComponent(evidenceId)}/preview`, {
            method: 'POST',
            credentials: 'same-origin',
            signal: controller.signal,
            body: form,
        });
        return response.ok;
    } catch {
        return false;
    } finally {
        window.clearTimeout(timeout);
    }
}
