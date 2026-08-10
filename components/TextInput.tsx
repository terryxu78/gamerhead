import React, { useEffect, useRef, useState } from 'react';

/**
 * IME-safe controlled text inputs.
 *
 * A plain controlled input breaks Chinese / Japanese / Korean input: while the
 * IME is composing, any parent re-render writes React's `value` back into the
 * DOM node and Chrome aborts the in-flight composition, so candidate characters
 * never commit. This app re-renders on every keystroke (script/segment
 * invalidation plus project autosave), which makes it reproducible.
 *
 * The fix is to let the DOM node own its text while it is focused or composing:
 * the field keeps a local draft, only adopts the external value when the user is
 * not editing, and does not notify the parent until the composition ends.
 */

type CommitHandler = (name: string, value: string) => void;

interface SharedProps {
    name: string;
    value: string;
    onCommit: CommitHandler;
    disabled?: boolean;
    placeholder?: string;
    className?: string;
    'aria-label'?: string;
    id?: string;
}

const useImeDraft = (value: string, name: string, onCommit: CommitHandler) => {
    const [draft, setDraft] = useState(value);
    const composingRef = useRef(false);
    const focusedRef = useRef(false);

    // Adopt programmatic updates (e.g. restoring a project) only when the user
    // is not mid-edit, so we never yank text out from under the IME.
    useEffect(() => {
        if (!composingRef.current && !focusedRef.current) setDraft(value);
    }, [value]);

    const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const next = e.target.value;
        setDraft(next);
        if (!composingRef.current) onCommit(name, next);
    };

    const onCompositionStart = () => { composingRef.current = true; };

    const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        composingRef.current = false;
        const next = e.currentTarget.value;
        setDraft(next);
        onCommit(name, next);
    };

    const onFocus = () => { focusedRef.current = true; };

    const onBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        focusedRef.current = false;
        composingRef.current = false;
        // Flush anything the IME left uncommitted.
        if (e.currentTarget.value !== value) onCommit(name, e.currentTarget.value);
    };

    return { draft, onChange, onCompositionStart, onCompositionEnd, onFocus, onBlur };
};

export const TextField: React.FC<SharedProps & {
    type?: 'text' | 'url';
    inputMode?: 'text' | 'url';
}> = ({ name, value, onCommit, type = 'text', ...rest }) => {
    const handlers = useImeDraft(value, name, onCommit);
    return (
        <input
            {...rest}
            type={type}
            name={name}
            value={handlers.draft}
            onChange={handlers.onChange}
            onCompositionStart={handlers.onCompositionStart}
            onCompositionEnd={handlers.onCompositionEnd}
            onFocus={handlers.onFocus}
            onBlur={handlers.onBlur}
        />
    );
};

export const TextArea: React.FC<SharedProps & { rows?: number }> = ({
    name, value, onCommit, rows = 3, ...rest
}) => {
    const handlers = useImeDraft(value, name, onCommit);
    return (
        <textarea
            {...rest}
            name={name}
            rows={rows}
            value={handlers.draft}
            onChange={handlers.onChange}
            onCompositionStart={handlers.onCompositionStart}
            onCompositionEnd={handlers.onCompositionEnd}
            onFocus={handlers.onFocus}
            onBlur={handlers.onBlur}
        />
    );
};
