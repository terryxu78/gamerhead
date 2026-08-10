// Google Identity Services — authentication helpers
//
// The ID token lives in localStorage (not sessionStorage) so that opening the
// app in a second tab, or an accidental tab close, does not throw the session
// away. The token itself still expires after ~1h, so the real fix is the
// refresh path below plus the `gh:session-expired` event, which lets the UI ask
// for a fresh sign-in WITHOUT unmounting and destroying in-progress work.

const TOKEN_KEY = 'gh_id_token';
const LEGACY_TOKEN_KEY = 'gh_id_token'; // same key, previously in sessionStorage

export interface GoogleUser {
    email: string;
    name: string;
    picture: string;
}

/** Fired when the server rejects our credentials and we could not silently recover. */
export const SESSION_EXPIRED_EVENT = 'gh:session-expired';

const emitSessionExpired = (reason: 'token' | 'proxy') => {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { reason } }));
};

// ---------- token storage ----------

export const getStoredToken = (): string | null => {
    try {
        return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(LEGACY_TOKEN_KEY);
    } catch {
        return null;
    }
};

export const storeToken = (token: string): void => {
    try {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
        /* storage disabled — fall through, requests will just 401 */
    }
};

export const clearToken = (): void => {
    try {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch { /* ignore */ }
};

/** Seconds until the stored token expires; null when unknown. */
export const getTokenSecondsRemaining = (): number | null => {
    const token = getStoredToken();
    if (!token) return null;
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (!payload?.exp) return null;
        return Math.floor(payload.exp - Date.now() / 1000);
    } catch {
        return null;
    }
};

// ---------- token refresh ----------

// Resolvers waiting for a fresh credential from GIS One Tap
let pendingRefreshResolvers: ((token: string | null) => void)[] = [];
let refreshInFlight: Promise<string | null> | null = null;

// GIS in FedCM mode no longer invokes the One Tap moment-notification callback,
// so the old implementation could leave this promise pending forever and freeze
// every caller of apiFetch. A hard timeout guarantees it always settles.
const REFRESH_TIMEOUT_MS = 8000;

/**
 * Attempt a silent token refresh via GIS One Tap.
 * Resolves with a new token, or null if GIS cannot silently re-authenticate.
 */
export const refreshToken = (): Promise<string | null> => {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (token: string | null) => {
            if (settled) return;
            settled = true;
            pendingRefreshResolvers = pendingRefreshResolvers.filter(r => r !== finish);
            clearTimeout(timer);
            resolve(token);
        };

        const timer = setTimeout(() => finish(null), REFRESH_TIMEOUT_MS);
        pendingRefreshResolvers.push(finish);

        const gis = (window as any).google?.accounts?.id;
        if (!gis) {
            finish(null);
            return;
        }

        try {
            gis.prompt((notification: any) => {
                // Present in the classic (non-FedCM) flow only.
                if (typeof notification?.isNotDisplayed === 'function'
                    && (notification.isNotDisplayed() || notification.isSkippedMoment())) {
                    finish(null);
                }
            });
        } catch {
            finish(null);
        }
    }).finally(() => {
        refreshInFlight = null;
    }) as Promise<string | null>;

    return refreshInFlight;
};

// ---------- GIS wrappers ----------

declare const google: any;

export const initGoogleSignIn = (
    clientId: string,
    onCredential: (idToken: string) => void
): void => {
    google.accounts.id.initialize({
        client_id: clientId,
        callback: (response: { credential: string }) => {
            const token = response.credential;
            // Resolve any pending refresh promises before calling the app callback
            pendingRefreshResolvers.forEach(r => r(token));
            pendingRefreshResolvers = [];
            onCredential(token);
        },
        auto_select: true,
    });
};

export const renderGoogleButton = (element: HTMLElement): void => {
    google.accounts.id.renderButton(element, {
        theme: 'filled_black',
        size: 'large',
        text: 'signin_with',
        shape: 'rectangular',
        width: 280,
    });
};

export const promptOneTap = (): void => {
    google.accounts.id.prompt();
};

export const signOut = (): void => {
    clearToken();
    try {
        google.accounts.id.disableAutoSelect();
    } catch { /* GIS not loaded (e.g. IAP mode) */ }
};

// ---------- authenticated fetch ----------

/**
 * True when a response is an auth-proxy interception rather than our API:
 * IAP answers expired sessions with a redirect to accounts.google.com or an
 * HTML error page, which used to surface as an opaque JSON parse error.
 */
const isAuthProxyResponse = (res: Response): boolean => {
    if (res.status === 401 || res.status === 403) {
        const type = res.headers.get('content-type') || '';
        if (type.includes('text/html')) return true;
    }
    if (res.type === 'opaqueredirect' || (res.redirected && new URL(res.url).origin !== window.location.origin)) {
        return true;
    }
    return false;
};

/**
 * Fetch wrapper that:
 * 1. Automatically attaches the stored Bearer token and the anonymous user id
 * 2. On 401, attempts a silent GIS token refresh and retries once
 * 3. Emits `gh:session-expired` when recovery is impossible, so the UI can ask
 *    for re-authentication without discarding the user's work
 */
export const apiFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const makeRequest = (token: string | null): Promise<Response> => {
        const headers = new Headers(options.headers as HeadersInit);
        if (token) headers.set('Authorization', `Bearer ${token}`);
        try {
            const anonId = localStorage.getItem('gameheads_uid');
            if (anonId) headers.set('X-Gh-User-Id', anonId);
        } catch { /* ignore */ }
        return fetch(url, { ...options, headers });
    };

    let res = await makeRequest(getStoredToken());

    if (isAuthProxyResponse(res)) {
        emitSessionExpired('proxy');
        return res;
    }

    if (res.status === 401) {
        const newToken = await refreshToken();
        if (newToken) {
            storeToken(newToken);
            res = await makeRequest(newToken);
        } else {
            emitSessionExpired('token');
        }
    }

    return res;
};
