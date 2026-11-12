import React, { type InputHTMLAttributes, useEffect, useId, useState } from 'react';
import './passwordInput.css';
import { ActionButton } from '../ui/ActionButton';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string };

export function PasswordInput({ label, id, disabled, value, ...props }: PasswordInputProps) {
    const generatedId = useId();
    const inputId = id || generatedId;
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (value === '' || disabled) setVisible(false);
    }, [value, disabled]);

    return (
        <div className="password-field">
            <label htmlFor={inputId}>{label}</label>
            <span className="password-control">
                <input
                    {...props}
                    id={inputId}
                    type={visible ? 'text' : 'password'}
                    value={value}
                    disabled={disabled}
                />
            </span>
            <ActionButton
                type="button"
                className="password-toggle"
                aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
                aria-controls={inputId}
                disabled={disabled}
                unavailableReason="Please wait for the current action to finish before showing or hiding this password."
                onClick={() => setVisible((current) => !current)}
            >
                {visible ? 'Hide' : 'Show'}
            </ActionButton>
        </div>
    );
}
