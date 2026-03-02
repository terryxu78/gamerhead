
import { LogEntry } from '../types';

export const getUserId = (): string => {
    if (typeof window === 'undefined') return 'unknown';
    
    let uid = localStorage.getItem('gameheads_uid');
    if (!uid) {
        uid = crypto.randomUUID();
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
        // Fire and forget
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
