// Google Identity Services — authentication helpers
// Token is stored in sessionStorage so it clears on browser close.

const TOKEN_KEY = 'gh_id_token';

export interface GoogleUser {
    email: string;
    name: string;
    picture: string;
}

// ---------- token storage ----------

export const getStoredToken = (): string | null =>
    sessionStorage.getItem(TOKEN_KEY);

export const storeToken = (token: string): void =>
    sessionStorage.setItem(TOKEN_KEY, token);

export const clearToken = (): void =>
    sessionStorage.removeItem(TOKEN_KEY);

// ---------- token refresh ----------

// Resolvers waiting for a fresh credential from GIS One Tap
let pendingRefreshResolvers: ((token: string | null) => void)[] = [];

/**
 * Attempt a silent token refresh via GIS One Tap.
 * Returns the new token, or null if GIS cannot silently re-authenticate.
 */
export const refreshToken = (): Promise<string | null> =>
    new Promise((resolve) => {
        pendingRefreshResolvers.push(resolve);
        (window as any).google?.accounts.id.prompt((notification: any) => {
            if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                pendingRefreshResolvers = pendingRefreshResolvers.filter(r => r !== resolve);
                resolve(null);
            }
        });
    });

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
    google.accounts.id.disableAutoSelect();
};

// ---------- authenticated fetch ----------

/**
 * Fetch wrapper that:
 * 1. Automatically attaches the stored Bearer token
 * 2. On 401, attempts a silent GIS token refresh and retries once
 */
export const apiFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const makeRequest = (token: string | null): Promise<Response> => {
        const headers = new Headers(options.headers as HeadersInit);
        if (token) headers.set('Authorization', `Bearer ${token}`);
        return fetch(url, { ...options, headers });
    };

    let res = await makeRequest(getStoredToken());

    if (res.status === 401) {
        const newToken = await refreshToken();
        if (newToken) {
            storeToken(newToken);
            res = await makeRequest(newToken);
        }
    }

    return res;
};
