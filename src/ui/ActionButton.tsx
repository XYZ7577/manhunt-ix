import { useEffect, useId, useState, type ButtonHTMLAttributes, type MouseEvent } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { unavailableReason?: string };

export function handleActionClick(
    event: MouseEvent<HTMLButtonElement>,
    blocked: boolean,
    explain: () => void,
    perform?: (event: MouseEvent<HTMLButtonElement>) => void,
) {
    if (blocked) {
        event.preventDefault();
        event.stopPropagation();
        explain();
        return;
    }
    perform?.(event);
}

export function ActionButton({
    disabled,
    unavailableReason = 'Please wait for the current action to finish.',
    onClick,
    title,
    'aria-describedby': describedBy,
    ...props
}: Props) {
    const reasonId = useId();
    const [showReason, setShowReason] = useState(false);
    const blocked = !!disabled;
    const showFeedback = blocked && showReason;
    useEffect(() => {
        if (!blocked) setShowReason(false);
    }, [blocked]);

    function handleClick(event: MouseEvent<HTMLButtonElement>) {
        handleActionClick(
            event,
            blocked,
            () => setShowReason(true),
            (availableEvent) => {
                setShowReason(false);
                onClick?.(availableEvent);
            },
        );
    }

    return (
        <>
            <button
                {...props}
                title={blocked ? unavailableReason : title}
                aria-disabled={blocked || undefined}
                aria-describedby={
                    [describedBy, blocked ? reasonId : ''].filter(Boolean).join(' ') || undefined
                }
                onClick={handleClick}
            />
            {blocked && (
                <span
                    id={reasonId}
                    className={showFeedback ? 'action-feedback' : 'action-reason'}
                    role={showFeedback ? 'status' : undefined}
                >
                    {unavailableReason}
                </span>
            )}
        </>
    );
}
