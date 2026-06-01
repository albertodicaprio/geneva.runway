const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// In-memory cache for Vercel serverless function
const runtimeState = globalThis.__genevaRunwayAircraftState || {
    cachedData: null,
    lastFetchTime: 0,
    cachedToken: null,
    tokenExpiresAt: 0,
    tokenRefreshPromise: null
};
globalThis.__genevaRunwayAircraftState = runtimeState;

const CACHE_DURATION = 120000; // 120 seconds cache duration
const MAX_STALE_AGE = 600000; // Allow serving stale data up to 10 minutes old
const TOKEN_REFRESH_MARGIN = 30000; // Refresh 30 seconds before expiry
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const AIRCRAFT_CACHE_FILE = path.join(os.tmpdir(), 'geneva-runway-aircraft-cache.json');

async function loadCachedAircraftData() {
    if (runtimeState.cachedData) {
        return;
    }

    try {
        const cacheContents = await fs.readFile(AIRCRAFT_CACHE_FILE, 'utf8');
        const cache = JSON.parse(cacheContents);

        if (cache && cache.cachedData && Number.isFinite(cache.lastFetchTime)) {
            runtimeState.cachedData = cache.cachedData;
            runtimeState.lastFetchTime = cache.lastFetchTime;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('Failed to read aircraft cache file:', error.message);
        }
    }
}

async function saveCachedAircraftData(data) {
    runtimeState.cachedData = data;
    runtimeState.lastFetchTime = Date.now();

    try {
        await fs.writeFile(
            AIRCRAFT_CACHE_FILE,
            JSON.stringify({
                cachedData: runtimeState.cachedData,
                lastFetchTime: runtimeState.lastFetchTime
            })
        );
    } catch (error) {
        console.warn('Failed to write aircraft cache file:', error.message);
    }
}

function getOpenSkyCredentials() {
    const clientId = process.env.OPENSKY_NETWORK_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_NETWORK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Missing OPENSKY_NETWORK_CLIENT_ID or OPENSKY_NETWORK_CLIENT_SECRET');
    }

    return { clientId, clientSecret };
}

async function refreshOpenSkyToken() {
    if (runtimeState.tokenRefreshPromise) {
        return runtimeState.tokenRefreshPromise;
    }

    runtimeState.tokenRefreshPromise = (async () => {
        const { clientId, clientSecret } = getOpenSkyCredentials();
        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
        });

        const response = await fetch(OPENSKY_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        if (!response.ok) {
            throw new Error(`OpenSky token request failed with ${response.status}`);
        }

        const tokenData = await response.json();
        if (!tokenData.access_token) {
            throw new Error('OpenSky token response did not include an access token');
        }

        const expiresInMs = (tokenData.expires_in || 1800) * 1000;
        runtimeState.cachedToken = tokenData.access_token;
        runtimeState.tokenExpiresAt = Date.now() + expiresInMs - TOKEN_REFRESH_MARGIN;

        return runtimeState.cachedToken;
    })();

    try {
        return await runtimeState.tokenRefreshPromise;
    } finally {
        runtimeState.tokenRefreshPromise = null;
    }
}

async function getOpenSkyToken() {
    if (runtimeState.cachedToken && Date.now() < runtimeState.tokenExpiresAt) {
        return runtimeState.cachedToken;
    }

    return refreshOpenSkyToken();
}

async function fetchOpenSkyStates({ forceTokenRefresh = false } = {}) {
    const token = forceTokenRefresh ? await refreshOpenSkyToken() : await getOpenSkyToken();

    return fetch(OPENSKY_STATES_URL, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    });
}

async function fetchOpenSkyStatesWithRetry() {
    const response = await fetchOpenSkyStates();

    if (response.status === 401) {
        console.warn('OpenSky token expired or was rejected, refreshing token and retrying once');
        return fetchOpenSkyStates({ forceTokenRefresh: true });
    }

    return response;
}

module.exports = async (req, res) => {
    // CORS headers to allow frontend requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Only allow GET requests
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        await loadCachedAircraftData();

        const timeSinceLastFetch = Date.now() - runtimeState.lastFetchTime;

        // Return cached data if still valid (within 120 seconds)
        if (runtimeState.cachedData && timeSinceLastFetch < CACHE_DURATION) {
            console.log(`Returning fresh cached data (${Math.round(timeSinceLastFetch / 1000)}s old)`);
            res.setHeader('Cache-Control', 'public, max-age=120');
            res.setHeader('X-Cache', 'HIT');
            res.status(200).json(runtimeState.cachedData);
            return;
        }

        // If cache is older than 120s but newer than 10 min, serve stale but try to refresh
        if (runtimeState.cachedData && timeSinceLastFetch < MAX_STALE_AGE) {
            console.log(`Cache is ${Math.round(timeSinceLastFetch / 1000)}s old, attempting refresh...`);

            // Try to fetch fresh data
            try {
                const response = await fetchOpenSkyStatesWithRetry();

                if (response.ok) {
                    const data = await response.json();
                    await saveCachedAircraftData(data);
                    console.log('Successfully refreshed cache from OpenSky');
                    res.setHeader('Cache-Control', 'public, max-age=120');
                    res.setHeader('X-Cache', 'REFRESHED');
                    res.status(200).json(data);
                    return;
                } else if (response.status === 429) {
                    console.warn('OpenSky rate limited, returning stale cached data');
                    res.setHeader('Cache-Control', 'public, max-age=120');
                    res.setHeader('X-Cache', 'STALE-RATE-LIMITED');
                    res.status(200).json(runtimeState.cachedData);
                    return;
                } else {
                    console.warn(`OpenSky refresh failed with ${response.status}, returning stale cached data`);
                    res.setHeader('Cache-Control', 'public, max-age=120');
                    res.setHeader('X-Cache', 'STALE-REFRESH-ERROR');
                    res.status(200).json(runtimeState.cachedData);
                    return;
                }
            } catch (fetchError) {
                console.warn('Fetch attempt failed, returning stale cached data:', fetchError.message);
                res.setHeader('Cache-Control', 'public, max-age=120');
                res.setHeader('X-Cache', 'STALE-FETCH-ERROR');
                res.status(200).json(runtimeState.cachedData);
                return;
            }
        }

        // No cache available, must fetch fresh
        console.log('No cache available, fetching from OpenSky...');
        const response = await fetchOpenSkyStatesWithRetry();

        if (!response.ok) {
            console.error(`OpenSky API error: ${response.status}`);
            if (response.status === 429) {
                res.status(503).json({
                    error: 'Service temporarily unavailable - OpenSky API rate limited. Retrying in 2 minutes.',
                    retryAfter: 120
                });
            } else {
                res.status(response.status).json({ error: `OpenSky API returned ${response.status}` });
            }
            return;
        }

        const data = await response.json();
        await saveCachedAircraftData(data);

        res.setHeader('Cache-Control', 'public, max-age=120');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json(data);

    } catch (error) {
        console.error('Error fetching from OpenSky API:', error);
        if (runtimeState.cachedData) {
            console.log('Error occurred, returning stale cached data');
            res.setHeader('Cache-Control', 'public, max-age=120');
            res.setHeader('X-Cache', 'STALE-ERROR');
            res.status(200).json(runtimeState.cachedData);
        } else {
            res.status(500).json({ error: 'Failed to fetch aircraft data' });
        }
    }
};
