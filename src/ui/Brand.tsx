import '../styles/brand.css';

export function Brand({ compact = false, className = '' }: { compact?: boolean; className?: string }) {
    return (
        <span
            className={`manhunt-brand${compact ? ' manhunt-brand-compact' : ''}${className ? ` ${className}` : ''}`}
        >
            <img className="manhunt-brand-logo" src="/manhunt-ix-logo.jpg" alt="" />
            <span className="manhunt-brand-copy">
                <strong>Manhunt IX</strong>
                {!compact && <small>Group challenge portal</small>}
            </span>
        </span>
    );
}
