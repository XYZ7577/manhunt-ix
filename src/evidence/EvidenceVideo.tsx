import { useEffect, useRef, useState } from 'react';
import { ActionButton } from '../ui/ActionButton';
import { formatEvidenceSize, isValidEvidenceSize } from './evidenceMediaPolicy';

type Props = { src: string; filename: string; size: number };
type PlaybackState = 'idle' | 'loading' | 'playing' | 'error';

export function EvidenceVideo({ src, filename, size }: Props) {
    return (
        <EvidenceVideoSession
            key={`${src}\u0000${filename}\u0000${size}`}
            src={src}
            filename={filename}
            size={size}
        />
    );
}

function EvidenceVideoSession({ src, filename, size }: Props) {
    const [requested, setRequested] = useState(false);
    const [state, setState] = useState<PlaybackState>('idle');
    const videoRef = useRef<HTMLVideoElement>(null);
    const sizeIsValid = isValidEvidenceSize(size);
    const label = filename || 'Evidence video';

    useEffect(() => {
        if (!requested) return;
        const video = videoRef.current;
        return () => {
            if (!video) return;
            video.pause();
            video.removeAttribute('src');
            video.load();
        };
    }, [requested]);

    function unload() {
        const video = videoRef.current;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        setRequested(false);
        setState('idle');
    }

    function handleError() {
        setState('error');
        setRequested(false);
    }

    function retry() {
        setState('loading');
        setRequested(true);
    }

    if (!sizeIsValid) {
        return (
            <div className="evidence-media evidence-media-message">
                <p>This file’s size is unavailable, so it can’t be previewed here.</p>
                <a href={src} target="_blank" rel="noreferrer">
                    Open or download original
                </a>
            </div>
        );
    }

    if (state === 'error' && !requested) {
        return (
            <div className="evidence-media evidence-media-message">
                <p>Couldn’t play this video. Try again or open the original.</p>
                <div className="evidence-media-actions">
                    <ActionButton type="button" className="button small-button" onClick={retry}>
                        Try again
                    </ActionButton>
                    <a href={src} target="_blank" rel="noreferrer" className="evidence-media-download">
                        Open original
                    </a>
                </div>
            </div>
        );
    }

    if (!requested) {
        return (
            <div className="evidence-media evidence-media-prompt">
                <span className="evidence-media-size">{formatEvidenceSize(size)}</span>
                <div className="evidence-media-actions">
                    <ActionButton
                        type="button"
                        className="button small-button"
                        aria-label={`Play ${label}`}
                        onClick={() => {
                            setState('loading');
                            setRequested(true);
                        }}
                    >
                        Play
                    </ActionButton>
                    <a href={src} target="_blank" rel="noreferrer" className="evidence-media-download">
                        Download original
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="evidence-media evidence-media-player">
            <video
                ref={videoRef}
                src={src}
                controls
                playsInline
                preload="none"
                autoPlay
                aria-label={label}
                onLoadStart={() => setState('loading')}
                onWaiting={() => setState('loading')}
                onCanPlay={() => setState('playing')}
                onPlaying={() => setState('playing')}
                onError={handleError}
            />
            <div className="evidence-media-status" aria-live="polite">
                {state === 'loading' && <span>Loading video…</span>}
                <div className="evidence-media-actions">
                    <ActionButton
                        type="button"
                        className="button small-button"
                        aria-label={`Stop playback of ${label}`}
                        onClick={unload}
                    >
                        Stop
                    </ActionButton>
                </div>
            </div>
        </div>
    );
}
