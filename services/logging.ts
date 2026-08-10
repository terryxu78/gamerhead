
import { LogEntry } from '../types';
import { getStoredToken } from './auth';

export const getUserId = (): string => {
    if (typeof window === 'undefined') return 'unknown';
    
    let uid = localStorage.getItem('gameheads_uid');
    if (!uid) {
        uid = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : `uid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem('gameheads_uid', uid);
    }
    return uid;
};

export const logEvent = async (
    type: LogEntry['type'], 
    model: string, 
    status: LogEntry['status'] = 'success',
    meta?: any
) => {
    try {
        const userId = getUserId();
        // Fire and forget. Deliberately NOT apiFetch: a background log must never
        // trigger a session-expired prompt or a token refresh.
        const token = getStoredToken();
        fetch('/api/log', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {})
            },
            body: JSON.stringify({
                userId,
                type,
                model,
                timestamp: Date.now(),
                status,
                meta
            })
        }).catch(err => console.error("Logging background error:", err));
    } catch (e) {
        console.error("Logging failed", e);
    }
};
