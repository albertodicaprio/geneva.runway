const { SEARCH_BOUNDS } = require('./traffic');
const TOKEN_REFRESH_MARGIN = 30000;
const OPENSKY_TIMEOUT = 10000;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl = globalThis.fetch) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (!response.ok && response.status !== 404) {
            // Error bodies are unused; abort them so they cannot hold a socket open.
            controller.abort();
            return { ok: response.ok, status: response.status, data: null };
        }
        // Consume successful/negative-cache JSON while the deadline is active.
        const data = await response.json();
        return { ok: response.ok, status: response.status, data };
    }
    finally { clearTimeout(timeoutId); }
}

function createOpenSky({ fetch: fetchImpl = globalThis.fetch, clock = Date.now, credentials = () => ({
    clientId: process.env.OPENSKY_NETWORK_CLIENT_ID,
    clientSecret: process.env.OPENSKY_NETWORK_CLIENT_SECRET
}) } = {}) {
    const state = { cachedToken: null, tokenExpiresAt: 0, tokenRefreshPromise: null };

    function getOpenSkyCredentials() {
        const { clientId, clientSecret } = credentials();
        if (!clientId || !clientSecret) throw new Error('Missing OPENSKY_NETWORK_CLIENT_ID or OPENSKY_NETWORK_CLIENT_SECRET');
        return { clientId, clientSecret };
    }

    async function refreshOpenSkyToken() {
        if (state.tokenRefreshPromise) return state.tokenRefreshPromise;
        state.tokenRefreshPromise = (async () => {
            const { clientId, clientSecret } = getOpenSkyCredentials();
            const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
            const startedAt = clock();
            const tokenResponse = await fetchWithTimeout(OPENSKY_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, OPENSKY_TIMEOUT, fetchImpl);
            console.log(`OpenSky token request completed with ${tokenResponse.status} in ${clock() - startedAt}ms`);
            if (!tokenResponse.ok) throw new Error(`OpenSky token request failed with ${tokenResponse.status}`);
            const tokenData = tokenResponse.data;
            if (!tokenData.access_token) throw new Error('OpenSky token response did not include an access token');
            state.cachedToken = tokenData.access_token;
            state.tokenExpiresAt = clock() + (tokenData.expires_in || 1800) * 1000 - TOKEN_REFRESH_MARGIN;
            return state.cachedToken;
        })();
        try { return await state.tokenRefreshPromise; }
        finally { state.tokenRefreshPromise = null; }
    }

    async function fetchOpenSkyStates({ forceTokenRefresh = false } = {}) {
        const token = forceTokenRefresh ? await refreshOpenSkyToken() :
            (state.cachedToken && clock() < state.tokenExpiresAt ? state.cachedToken : await refreshOpenSkyToken());
        const url = new URL(OPENSKY_STATES_URL);
        for (const [name, value] of Object.entries(SEARCH_BOUNDS)) url.searchParams.set(name, value);
        const startedAt = clock();
        const statesResponse = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, OPENSKY_TIMEOUT, fetchImpl);
        console.log(`OpenSky states request completed with ${statesResponse.status} in ${clock() - startedAt}ms`);
        return statesResponse;
    }

    async function fetchOpenSkyStatesWithRetry() {
        const statesResponse = await fetchOpenSkyStates();
        if (statesResponse.status !== 401) return statesResponse;
        console.warn('OpenSky token expired or was rejected, refreshing token and retrying once');
        return fetchOpenSkyStates({ forceTokenRefresh: true });
    }

    return { fetchStates: fetchOpenSkyStatesWithRetry };
}

module.exports = { createOpenSky, fetchWithTimeout };
