const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const runtimeState = globalThis.__genevaRunwayAircraftState || {
    cachedData: null,
    lastFetchTime: 0,
    cachedToken: null,
    tokenExpiresAt: 0,
    tokenRefreshPromise: null
};
globalThis.__genevaRunwayAircraftState = runtimeState;

const CACHE_DURATION = 120000;
const MAX_STALE_AGE = 600000;
const TOKEN_REFRESH_MARGIN = 30000;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const AIRCRAFT_CACHE_FILE = path.join(os.tmpdir(), 'geneva-runway-aircraft-cache.json');

function response(status, body, cacheStatus) {
    return {
        status,
        body,
        headers: {
            'Cache-Control': 'public, max-age=120',
            'X-Cache': cacheStatus
        }
    };
}

async function loadCachedAircraftData() {
    if (runtimeState.cachedData) return;

    try {
        const cache = JSON.parse(await fs.readFile(AIRCRAFT_CACHE_FILE, 'utf8'));
        if (cache && cache.cachedData && Number.isFinite(cache.lastFetchTime)) {
            runtimeState.cachedData = cache.cachedData;
            runtimeState.lastFetchTime = cache.lastFetchTime;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') console.warn('Failed to read aircraft cache file:', error.message);
    }
}

async function saveCachedAircraftData(data) {
    runtimeState.cachedData = data;
    runtimeState.lastFetchTime = Date.now();

    try {
        await fs.writeFile(AIRCRAFT_CACHE_FILE, JSON.stringify({
            cachedData: runtimeState.cachedData,
            lastFetchTime: runtimeState.lastFetchTime
        }));
    } catch (error) {
        console.warn('Failed to write aircraft cache file:', error.message);
    }
}

function getOpenSkyCredentials() {
    const clientId = process.env.OPENSKY_NETWORK_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_NETWORK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Missing OPENSKY_NETWORK_CLIENT_ID or OPENSKY_NETWORK_CLIENT_SECRET');
    return { clientId, clientSecret };
}

async function refreshOpenSkyToken() {
    if (runtimeState.tokenRefreshPromise) return runtimeState.tokenRefreshPromise;

    runtimeState.tokenRefreshPromise = (async () => {
        const { clientId, clientSecret } = getOpenSkyCredentials();
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
        const tokenResponse = await fetch(OPENSKY_TOKEN_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
        });
        if (!tokenResponse.ok) throw new Error(`OpenSky token request failed with ${tokenResponse.status}`);

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) throw new Error('OpenSky token response did not include an access token');
        runtimeState.cachedToken = tokenData.access_token;
        runtimeState.tokenExpiresAt = Date.now() + (tokenData.expires_in || 1800) * 1000 - TOKEN_REFRESH_MARGIN;
        return runtimeState.cachedToken;
    })();

    try { return await runtimeState.tokenRefreshPromise; }
    finally { runtimeState.tokenRefreshPromise = null; }
}

async function fetchOpenSkyStates({ forceTokenRefresh = false } = {}) {
    const token = forceTokenRefresh ? await refreshOpenSkyToken() :
        (runtimeState.cachedToken && Date.now() < runtimeState.tokenExpiresAt ? runtimeState.cachedToken : await refreshOpenSkyToken());
    return fetch(OPENSKY_STATES_URL, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
}

async function fetchOpenSkyStatesWithRetry() {
    const statesResponse = await fetchOpenSkyStates();
    if (statesResponse.status !== 401) return statesResponse;
    console.warn('OpenSky token expired or was rejected, refreshing token and retrying once');
    return fetchOpenSkyStates({ forceTokenRefresh: true });
}

async function getAircraftData() {
    try {
        await loadCachedAircraftData();
        const age = Date.now() - runtimeState.lastFetchTime;

        if (runtimeState.cachedData && age < CACHE_DURATION) {
            console.log(`Returning fresh cached data (${Math.round(age / 1000)}s old)`);
            return response(200, runtimeState.cachedData, 'HIT');
        }

        if (runtimeState.cachedData && age < MAX_STALE_AGE) {
            console.log(`Cache is ${Math.round(age / 1000)}s old, attempting refresh...`);
            try {
                const statesResponse = await fetchOpenSkyStatesWithRetry();
                if (statesResponse.ok) {
                    const data = await statesResponse.json();
                    await saveCachedAircraftData(data);
                    console.log('Successfully refreshed cache from OpenSky');
                    return response(200, data, 'REFRESHED');
                }
                if (statesResponse.status === 429) {
                    console.warn('OpenSky rate limited, returning stale cached data');
                    return response(200, runtimeState.cachedData, 'STALE-RATE-LIMITED');
                }
                console.warn(`OpenSky refresh failed with ${statesResponse.status}, returning stale cached data`);
                return response(200, runtimeState.cachedData, 'STALE-REFRESH-ERROR');
            } catch (error) {
                console.warn('Fetch attempt failed, returning stale cached data:', error.message);
                return response(200, runtimeState.cachedData, 'STALE-FETCH-ERROR');
            }
        }

        console.log('No cache available, fetching from OpenSky...');
        const statesResponse = await fetchOpenSkyStatesWithRetry();
        if (!statesResponse.ok) {
            console.error(`OpenSky API error: ${statesResponse.status}`);
            return statesResponse.status === 429
                ? { status: 503, body: { error: 'Service temporarily unavailable - OpenSky API rate limited. Retrying in 2 minutes.', retryAfter: 120 }, headers: {} }
                : { status: statesResponse.status, body: { error: `OpenSky API returned ${statesResponse.status}` }, headers: {} };
        }

        const data = await statesResponse.json();
        await saveCachedAircraftData(data);
        return response(200, data, 'MISS');
    } catch (error) {
        console.error('Error fetching from OpenSky API:', error);
        if (runtimeState.cachedData) {
            console.log('Error occurred, returning stale cached data');
            return response(200, runtimeState.cachedData, 'STALE-ERROR');
        }
        return { status: 500, body: { error: 'Failed to fetch aircraft data' }, headers: {} };
    }
}

module.exports = { getAircraftData };
