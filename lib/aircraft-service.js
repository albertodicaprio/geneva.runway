const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const runtimeState = globalThis.__genevaRunwayAircraftState || {
    cachedData: null,
    lastFetchTime: 0,
    cachedToken: null,
    tokenExpiresAt: 0,
    tokenRefreshPromise: null,
    adsbdbCache: { aircraft: {}, flights: {} }
};
globalThis.__genevaRunwayAircraftState = runtimeState;

const CACHE_DURATION = 120000;
const MAX_STALE_AGE = 600000;
const TOKEN_REFRESH_MARGIN = 30000;
const ADSBDB_TIMEOUT = 10000;
const ADSBDB_CONCURRENCY = 4;
const FLIGHT_CACHE_DURATION = 24 * 60 * 60 * 1000;
const AIRCRAFT_CACHE_DURATION = 30 * 24 * 60 * 60 * 1000;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const ADSBDB_URL = 'https://api.adsbdb.com/v0';
const AIRCRAFT_CACHE_FILE = path.join(os.tmpdir(), 'geneva-runway-aircraft-cache.json');
const CACHE_VERSION = 3;
const GENEVA_AIRPORT = { icao: 'LSGG', iata: 'GVA', latitude: 46.2381, longitude: 6.1093 };
const MAX_DISTANCE_KM = 80;
const SEARCH_BOUNDS = { lamin: 45.51, lomin: 5.06, lamax: 46.97, lomax: 7.16 };
const RUNWAYS = [{ direction: '04', heading: 40 }, { direction: '22', heading: 220 }];
const RUNWAY_HEADING_TOLERANCE_DEG = 45;

function response(status, body, cacheStatus) {
    return { status, body, headers: { 'Cache-Control': 'public, max-age=120', 'X-Cache': cacheStatus } };
}

async function loadCachedAircraftData() {
    if (runtimeState.cachedData) return;
    try {
        const cache = JSON.parse(await fs.readFile(AIRCRAFT_CACHE_FILE, 'utf8'));
        if (cache?.version === CACHE_VERSION && cache.cachedData && Number.isFinite(cache.lastFetchTime)) {
            runtimeState.cachedData = cache.cachedData;
            runtimeState.lastFetchTime = cache.lastFetchTime;
            runtimeState.adsbdbCache = cache.adsbdbCache || { aircraft: {}, flights: {} };
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
            version: CACHE_VERSION,
            cachedData: runtimeState.cachedData,
            lastFetchTime: runtimeState.lastFetchTime,
            adsbdbCache: runtimeState.adsbdbCache
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
        const tokenResponse = await fetch(OPENSKY_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
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
    const url = new URL(OPENSKY_STATES_URL);
    for (const [name, value] of Object.entries(SEARCH_BOUNDS)) url.searchParams.set(name, value);
    url.searchParams.set('extended', '1');
    return fetch(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
}

async function fetchOpenSkyStatesWithRetry() {
    const statesResponse = await fetchOpenSkyStates();
    if (statesResponse.status !== 401) return statesResponse;
    console.warn('OpenSky token expired or was rejected, refreshing token and retrying once');
    return fetchOpenSkyStates({ forceTokenRefresh: true });
}

function distanceInKm(latitude, longitude) {
    const earthRadiusKm = 6371;
    const toRadians = degrees => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(latitude - GENEVA_AIRPORT.latitude);
    const longitudeDelta = toRadians(longitude - GENEVA_AIRPORT.longitude);
    const a = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(toRadians(GENEVA_AIRPORT.latitude)) * Math.cos(toRadians(latitude)) * Math.sin(longitudeDelta / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function headingDifference(first, second) {
    return Math.abs(((first - second + 540) % 360) - 180);
}

function classifyApproachDirection(heading) {
    if (!Number.isFinite(heading)) return { direction: 'unknown', confidence: 'none', reason: 'No valid aircraft heading' };
    const nearest = RUNWAYS.map(runway => ({ ...runway, difference: headingDifference(heading, runway.heading) }))
        .sort((first, second) => first.difference - second.difference)[0];
    if (nearest.difference > RUNWAY_HEADING_TOLERANCE_DEG) {
        return { direction: 'unknown', confidence: 'none', reason: `Heading is ${Math.round(nearest.difference)}° from the nearest runway heading` };
    }
    const confidence = nearest.difference <= 15 ? 'high' : nearest.difference <= 30 ? 'medium' : 'low';
    return { direction: nearest.direction, confidence, reason: `Heading is ${Math.round(nearest.difference)}° from runway ${nearest.direction}` };
}

function normalizeOpenSkyData(data) {
    const aircraft = (Array.isArray(data.states) ? data.states : []).map(state => {
        if (!Array.isArray(state) || !Number.isFinite(state[6]) || !Number.isFinite(state[5])) return null;
        const distanceKm = distanceInKm(state[6], state[5]);
        if (distanceKm > MAX_DISTANCE_KM) return null;
        const approach = classifyApproachDirection(state[10]);
        return {
            icao24: state[0], callsign: state[1]?.trim() || null, country: state[2], timestamp: state[3], lastPositionUpdate: state[4],
            longitude: state[5], latitude: state[6], altitude: state[7], onGround: state[8], velocity: state[9], heading: state[10],
            verticalRate: state[11], geoAltitude: state[13], squawk: state[14], spi: state[15], positionSource: state[16],
            category: state[17] ?? null, distanceKm, approachDirection: approach.direction, approachConfidence: approach.confidence, approachReason: approach.reason
        };
    }).filter(Boolean);
    return { updatedAt: data.time || null, airport: GENEVA_AIRPORT, maxDistanceKm: MAX_DISTANCE_KM, aircraft };
}

function flightCacheKey(aircraft, updatedAt) {
    const timestamp = aircraft.lastPositionUpdate || aircraft.timestamp || updatedAt || Math.floor(Date.now() / 1000);
    return `${aircraft.callsign}:${aircraft.icao24}:${new Date(timestamp * 1000).toISOString().slice(0, 10)}`;
}

async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ADSBDB_TIMEOUT);
    try { return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal }); }
    finally { clearTimeout(timeoutId); }
}

async function getAdsbdbCached(kind, key, url, duration) {
    const entries = runtimeState.adsbdbCache[kind];
    const cached = entries[key];
    if (cached && Date.now() - cached.fetchedAt < duration) return cached;
    try {
        const apiResponse = await fetchJsonWithTimeout(url);
        if (apiResponse.ok || apiResponse.status === 404) {
            const entry = { fetchedAt: Date.now(), notFound: apiResponse.status === 404, data: await apiResponse.json().catch(() => null) };
            entries[key] = entry;
            return entry;
        }
        console.warn(`ADSBdb request failed with ${apiResponse.status}: ${url}`);
    } catch (error) {
        console.warn(`ADSBdb request failed: ${error.message}`);
    }
    return null;
}

function responseBody(data) { return data?.response || data; }
function flightRouteFrom(data) { return responseBody(data)?.flightroute || null; }
function aircraftDetailsFrom(data) { return responseBody(data)?.aircraft || null; }
function isGvaArrival(route) { return route?.destination?.iata_code?.toUpperCase() === GENEVA_AIRPORT.iata; }

async function mapWithConcurrency(items, mapper, concurrency = ADSBDB_CONCURRENCY) {
    const results = new Array(items.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index]);
        }
    }));
    return results;
}

function routeSummary(route) {
    return { callsign: route.callsign, callsignIcao: route.callsign_icao, callsignIata: route.callsign_iata, airline: route.airline, origin: route.origin, destination: route.destination };
}

async function enrichGvaArrivals(data) {
    const candidates = data.aircraft.filter(aircraft => !aircraft.onGround && aircraft.callsign && aircraft.icao24);
    const routed = await mapWithConcurrency(candidates, async aircraft => {
        const entry = await getAdsbdbCached('flights', flightCacheKey(aircraft, data.updatedAt), `${ADSBDB_URL}/callsign/${encodeURIComponent(aircraft.callsign)}`, FLIGHT_CACHE_DURATION);
        const route = entry && !entry.notFound ? flightRouteFrom(entry.data) : null;
        return isGvaArrival(route) ? { aircraft, route } : null;
    });
    const gvaArrivals = routed.filter(Boolean);
    const enriched = await mapWithConcurrency(gvaArrivals, async ({ aircraft, route }) => {
        const entry = await getAdsbdbCached('aircraft', aircraft.icao24.toLowerCase(), `${ADSBDB_URL}/aircraft/${encodeURIComponent(aircraft.icao24)}`, AIRCRAFT_CACHE_DURATION);
        return { ...aircraft, route: routeSummary(route), aircraftDetails: entry && !entry.notFound ? aircraftDetailsFrom(entry.data) : null };
    });
    return { ...data, aircraft: enriched.sort((first, second) => (first.altitude ?? Infinity) - (second.altitude ?? Infinity)) };
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
                    const data = await enrichGvaArrivals(normalizeOpenSkyData(await statesResponse.json()));
                    await saveCachedAircraftData(data);
                    console.log('Successfully refreshed cache from OpenSky');
                    return response(200, data, 'REFRESHED');
                }
                if (statesResponse.status === 429) return response(200, runtimeState.cachedData, 'STALE-RATE-LIMITED');
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
            return statesResponse.status === 429 ? { status: 503, body: { error: 'Service temporarily unavailable - OpenSky API rate limited. Retrying in 2 minutes.', retryAfter: 120 }, headers: {} } : { status: statesResponse.status, body: { error: `OpenSky API returned ${statesResponse.status}` }, headers: {} };
        }
        const data = await enrichGvaArrivals(normalizeOpenSkyData(await statesResponse.json()));
        await saveCachedAircraftData(data);
        return response(200, data, 'MISS');
    } catch (error) {
        console.error('Error fetching from OpenSky API:', error);
        if (runtimeState.cachedData) return response(200, runtimeState.cachedData, 'STALE-ERROR');
        return { status: 500, body: { error: 'Failed to fetch aircraft data' }, headers: {} };
    }
}

module.exports = { classifyApproachDirection, distanceInKm, enrichGvaArrivals, getAircraftData, normalizeOpenSkyData };
