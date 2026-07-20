const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const runtimeState = globalThis.__genevaRunwayAircraftState || {
    cachedData: null,
    lastFetchTime: 0,
    cachedToken: null,
    tokenExpiresAt: 0,
    tokenRefreshPromise: null,
    refreshPromise: null,
    enrichmentCache: { aircraft: {}, flights: {} },
    transientFlightCache: {}
};
globalThis.__genevaRunwayAircraftState = runtimeState;

const CACHE_DURATION = 30000;
const MAX_STALE_AGE = 600000;
const MAX_POSITION_PROJECTION_SECONDS = 60;
const TOKEN_REFRESH_MARGIN = 30000;
const ADSBDB_TIMEOUT = 10000;
const OPENSKY_TIMEOUT = 10000;
const ADSBDB_CONCURRENCY = 4;
const FLIGHT_CACHE_DURATION = 24 * 60 * 60 * 1000;
const AIRCRAFT_CACHE_DURATION = 30 * 24 * 60 * 60 * 1000;
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
const ADSBDB_URL = 'https://api.adsbdb.com/v0';
const AIRCRAFT_CACHE_FILE = path.join(os.tmpdir(), 'geneva-runway-aircraft-cache.json');
const CACHE_VERSION = 6;
const GENEVA_AIRPORT = { icao: 'LSGG', iata: 'GVA', latitude: 46.2381, longitude: 6.1093 };
const MAX_DISTANCE_KM = 80;
const MAX_TRACK_AGE_SECONDS = 60 * 60;
const TRACK_COLOR_VERSION = 2;
const SEARCH_BOUNDS = { lamin: 45.51, lomin: 5.06, lamax: 46.97, lomax: 7.16 };
const RUNWAYS = [{ direction: '04', heading: 40 }, { direction: '22', heading: 220 }];
const RUNWAY_HEADING_TOLERANCE_DEG = 45;

function response(status, body, cacheStatus) {
    return { status, body, headers: { 'Cache-Control': 'no-store', 'X-Cache': cacheStatus } };
}

function cachedResponseBody() {
    return {
        ...projectAircraftData(runtimeState.cachedData),
        cacheUpdatedAt: Math.floor(runtimeState.lastFetchTime / 1000)
    };
}

async function loadCachedAircraftData() {
    if (runtimeState.cachedData) return;
    try {
        const cache = JSON.parse(await fs.readFile(AIRCRAFT_CACHE_FILE, 'utf8'));
        if (cache?.version === CACHE_VERSION && cache.arrivals && Number.isFinite(cache.lastFetchTime)) {
            runtimeState.lastFetchTime = cache.lastFetchTime;
            runtimeState.cachedData = cache.arrivals;
            runtimeState.enrichmentCache = cache.enrichment || { aircraft: {}, flights: {} };
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
            arrivals: runtimeState.cachedData,
            lastFetchTime: runtimeState.lastFetchTime,
            enrichment: runtimeState.enrichmentCache
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
        const startedAt = Date.now();
        const tokenResponse = await fetchWithTimeout(OPENSKY_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, OPENSKY_TIMEOUT);
        console.log(`OpenSky token request completed with ${tokenResponse.status} in ${Date.now() - startedAt}ms`);
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
    const startedAt = Date.now();
    const statesResponse = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, OPENSKY_TIMEOUT);
    console.log(`OpenSky states request completed with ${statesResponse.status} in ${Date.now() - startedAt}ms`);
    return statesResponse;
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

function projectPosition(latitude, longitude, heading, velocity, elapsedSeconds) {
    if (![latitude, longitude, heading, velocity].every(Number.isFinite) || velocity < 0 || elapsedSeconds <= 0) {
        return { latitude, longitude };
    }

    const earthRadiusMetres = 6_371_000;
    const angularDistance = velocity * elapsedSeconds / earthRadiusMetres;
    const bearing = heading * Math.PI / 180;
    const startLatitude = latitude * Math.PI / 180;
    const startLongitude = longitude * Math.PI / 180;
    const projectedLatitude = Math.asin(
        Math.sin(startLatitude) * Math.cos(angularDistance) +
        Math.cos(startLatitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const projectedLongitude = startLongitude + Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLatitude),
        Math.cos(angularDistance) - Math.sin(startLatitude) * Math.sin(projectedLatitude)
    );

    return {
        latitude: projectedLatitude * 180 / Math.PI,
        longitude: ((projectedLongitude * 180 / Math.PI + 540) % 360) - 180
    };
}

function projectAircraftData(data, now = Date.now()) {
    const datasetTimestamp = Number.isFinite(data?.updatedAt) ? data.updatedAt : null;
    const estimatedAt = Math.floor(now / 1000);
    const projectedAircraft = (data?.aircraft || []).map(aircraft => {
        const positionTimestamp = Number.isFinite(aircraft.lastPositionUpdate)
            ? aircraft.lastPositionUpdate
            : datasetTimestamp;
        const elapsedSeconds = positionTimestamp === null
            ? 0
            : Math.min(MAX_POSITION_PROJECTION_SECONDS, Math.max(0, estimatedAt - positionTimestamp));
        const position = projectPosition(aircraft.latitude, aircraft.longitude, aircraft.heading, aircraft.velocity, elapsedSeconds);
        const altitude = Number.isFinite(aircraft.altitude) && Number.isFinite(aircraft.verticalRate)
            ? Math.max(0, aircraft.altitude + aircraft.verticalRate * elapsedSeconds)
            : aircraft.altitude;

        return {
            ...aircraft,
            ...position,
            altitude,
            distanceKm: Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
                ? distanceInKm(position.latitude, position.longitude)
                : aircraft.distanceKm,
            positionEstimated: elapsedSeconds > 0,
            projectionSeconds: elapsedSeconds
        };
    }).sort((first, second) => (first.altitude ?? Infinity) - (second.altitude ?? Infinity));

    return {
        ...data,
        aircraft: projectedAircraft,
        positionEstimate: {
            isEstimated: projectedAircraft.some(aircraft => aircraft.positionEstimated),
            estimatedAt,
            maximumSecondsAhead: MAX_POSITION_PROJECTION_SECONDS
        }
    };
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

function normalizeOpenSkyData(data, diagnostics = null) {
    const states = Array.isArray(data.states) ? data.states : [];
    const summary = { stateCount: states.length, invalidPositionCount: 0, outsideRangeCount: 0, nearbyAircraftCount: 0 };
    const aircraft = states.map(state => {
        if (!Array.isArray(state) || !Number.isFinite(state[6]) || !Number.isFinite(state[5])) {
            summary.invalidPositionCount += 1;
            return null;
        }
        const distanceKm = distanceInKm(state[6], state[5]);
        if (distanceKm > MAX_DISTANCE_KM) {
            summary.outsideRangeCount += 1;
            return null;
        }
        summary.nearbyAircraftCount += 1;
        const approach = classifyApproachDirection(state[10]);
        return {
            icao24: state[0], callsign: state[1]?.trim() || null, country: state[2], timestamp: state[3], lastPositionUpdate: state[4],
            longitude: state[5], latitude: state[6], altitude: state[7], onGround: state[8], velocity: state[9], heading: state[10],
            verticalRate: state[11], geoAltitude: state[13], squawk: state[14], spi: state[15], positionSource: state[16],
            distanceKm, approachDirection: approach.direction, approachConfidence: approach.confidence, approachReason: approach.reason
        };
    }).filter(Boolean);
    if (diagnostics) Object.assign(diagnostics, summary);
    return { updatedAt: data.time || null, airport: GENEVA_AIRPORT, maxDistanceKm: MAX_DISTANCE_KM, aircraft };
}

function flightCacheKey(aircraft, updatedAt) {
    const timestamp = aircraft.lastPositionUpdate || aircraft.timestamp || updatedAt || Math.floor(Date.now() / 1000);
    return `${aircraft.callsign}:${aircraft.icao24}:${new Date(timestamp * 1000).toISOString().slice(0, 10)}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeoutId); }
}

function fetchJsonWithTimeout(url) {
    return fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, ADSBDB_TIMEOUT);
}

async function getAdsbdbCached(kind, key, url, duration, shouldPersist = () => true) {
    const entries = runtimeState.enrichmentCache[kind];
    const cached = entries[key] || (kind === 'flights' ? runtimeState.transientFlightCache[key] : null);
    if (cached && Date.now() - cached.fetchedAt < duration) return cached;
    try {
        const apiResponse = await fetchJsonWithTimeout(url);
        if (apiResponse.ok || apiResponse.status === 404) {
            const entry = { fetchedAt: Date.now(), notFound: apiResponse.status === 404, data: await apiResponse.json().catch(() => null) };
            if (shouldPersist(entry)) {
                entries[key] = entry;
            } else if (kind === 'flights') {
                runtimeState.transientFlightCache[key] = entry;
            }
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
function destinationCode(route) {
    return route?.destination?.iata_code?.toUpperCase() || route?.destination?.icao_code?.toUpperCase() || 'unknown';
}

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
    const excludedOnGroundCount = data.aircraft.filter(aircraft => aircraft.onGround).length;
    const excludedWithoutIdentityCount = data.aircraft.length - candidates.length - excludedOnGroundCount;
    const routed = await mapWithConcurrency(candidates, async aircraft => {
        const entry = await getAdsbdbCached(
            'flights',
            flightCacheKey(aircraft, data.updatedAt),
            `${ADSBDB_URL}/callsign/${encodeURIComponent(aircraft.callsign)}`,
            FLIGHT_CACHE_DURATION,
            candidate => isGvaArrival(flightRouteFrom(candidate.data))
        );
        const route = entry && !entry.notFound ? flightRouteFrom(entry.data) : null;
        return { aircraft, route };
    });
    for (const { aircraft, route } of routed) {
        console.log(`Route lookup: ${aircraft.callsign} → ${destinationCode(route)} (${isGvaArrival(route) ? 'confirmed GVA arrival' : 'not a confirmed GVA arrival'})`);
    }
    const gvaArrivals = routed.filter(({ route }) => isGvaArrival(route));
    const enriched = await mapWithConcurrency(gvaArrivals, async ({ aircraft, route }) => {
        const entry = await getAdsbdbCached('aircraft', aircraft.icao24.toLowerCase(), `${ADSBDB_URL}/aircraft/${encodeURIComponent(aircraft.icao24)}`, AIRCRAFT_CACHE_DURATION);
        return { ...aircraft, route: routeSummary(route), aircraftDetails: entry && !entry.notFound ? aircraftDetailsFrom(entry.data) : null };
    });
    const arrivals = { ...data, aircraft: enriched.sort((first, second) => (first.altitude ?? Infinity) - (second.altitude ?? Infinity)) };
    pruneEnrichmentCache(arrivals);
    console.log(`Arrival filtering: ${data.aircraft.length} nearby; ${candidates.length} route lookups; ${gvaArrivals.length} confirmed GVA; ${excludedOnGroundCount} on ground; ${excludedWithoutIdentityCount} missing callsign or ICAO24`);
    return arrivals;
}

function pruneEnrichmentCache(arrivals) {
    const flightKeys = new Set(arrivals.aircraft.map(aircraft => flightCacheKey(aircraft, arrivals.updatedAt)));
    const aircraftKeys = new Set(arrivals.aircraft.map(aircraft => aircraft.icao24.toLowerCase()));
    runtimeState.enrichmentCache.flights = Object.fromEntries(
        Object.entries(runtimeState.enrichmentCache.flights).filter(([key]) => flightKeys.has(key))
    );
    runtimeState.enrichmentCache.aircraft = Object.fromEntries(
        Object.entries(runtimeState.enrichmentCache.aircraft).filter(([key]) => aircraftKeys.has(key))
    );
}

function createTrackColor() {
    const hue = Math.floor(Math.random() * 360);
    const saturation = 75 + Math.floor(Math.random() * 26);
    const lightness = 38 + Math.floor(Math.random() * 15);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function addArrivalTracks(arrivals, previousArrivals = runtimeState.cachedData) {
    const previousByIcao = new Map((previousArrivals?.aircraft || [])
        .filter(aircraft => aircraft?.icao24)
        .map(aircraft => [aircraft.icao24.toLowerCase(), aircraft]));
    const timestamp = Number.isFinite(arrivals.updatedAt) ? arrivals.updatedAt : Math.floor(Date.now() / 1000);
    const oldestTimestamp = timestamp - MAX_TRACK_AGE_SECONDS;

    return {
        ...arrivals,
        aircraft: arrivals.aircraft.map(aircraft => {
            const previousTrack = previousByIcao.get(aircraft.icao24.toLowerCase())?.track;
            const points = (previousTrack?.points || [])
                .filter(point => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude) &&
                    Number.isFinite(point?.timestamp) && point.timestamp >= oldestTimestamp);
            const point = { latitude: aircraft.latitude, longitude: aircraft.longitude, timestamp };
            const lastPoint = points.at(-1);

            if (!lastPoint || lastPoint.latitude !== point.latitude || lastPoint.longitude !== point.longitude || lastPoint.timestamp !== point.timestamp) {
                points.push(point);
            }

            return {
                ...aircraft,
                track: {
                    color: previousTrack?.colorVersion === TRACK_COLOR_VERSION ? previousTrack.color : createTrackColor(),
                    colorVersion: TRACK_COLOR_VERSION,
                    points
                }
            };
        })
    };
}

async function refreshAircraftData() {
    const statesResponse = await fetchOpenSkyStatesWithRetry();
    if (!statesResponse.ok) {
        console.warn(`OpenSky refresh failed with ${statesResponse.status}`);
        return false;
    }
    const normalization = {};
    const normalizedData = normalizeOpenSkyData(await statesResponse.json(), normalization);
    console.log(`OpenSky state filtering: ${normalization.stateCount} received; ${normalization.nearbyAircraftCount} within ${MAX_DISTANCE_KM}km; ${normalization.outsideRangeCount} outside range; ${normalization.invalidPositionCount} without valid position`);
    const data = addArrivalTracks(await enrichGvaArrivals(normalizedData));
    await saveCachedAircraftData(data);
    console.log(`Successfully refreshed cache from OpenSky with ${data.aircraft.length} confirmed Geneva arrivals`);
    return true;
}

function refreshAircraftDataOnce() {
    if (runtimeState.refreshPromise) return runtimeState.refreshPromise;
    runtimeState.refreshPromise = refreshAircraftData()
        .catch(error => {
            console.warn('Aircraft refresh failed:', error.message);
            return false;
        })
        .finally(() => { runtimeState.refreshPromise = null; });
    return runtimeState.refreshPromise;
}

async function getAircraftData() {
    try {
        await loadCachedAircraftData();
        const age = Date.now() - runtimeState.lastFetchTime;
        if (runtimeState.cachedData && age < MAX_STALE_AGE) {
            if (age < CACHE_DURATION) {
                console.log(`Returning fresh cached data (${Math.round(age / 1000)}s old)`);
                return response(200, cachedResponseBody(), 'HIT');
            }
            console.log(`Returning stale cached data (${Math.round(age / 1000)}s old) while refreshing in the background`);
            refreshAircraftDataOnce();
            return response(200, cachedResponseBody(), 'STALE-REFRESHING');
        }
        console.log('No cache available, fetching from OpenSky...');
        const refreshed = await refreshAircraftDataOnce();
        if (refreshed) return response(200, cachedResponseBody(), 'MISS');
        return { status: 503, body: { error: 'Service temporarily unavailable - OpenSky API could not refresh.' }, headers: {} };
    } catch (error) {
        console.error('Error fetching from OpenSky API:', error);
        if (runtimeState.cachedData) return response(200, cachedResponseBody(), 'STALE-ERROR');
        return { status: 500, body: { error: 'Failed to fetch aircraft data' }, headers: {} };
    }
}

module.exports = { addArrivalTracks, classifyApproachDirection, distanceInKm, enrichGvaArrivals, fetchWithTimeout, getAircraftData, normalizeOpenSkyData, projectAircraftData, pruneEnrichmentCache, refreshAircraftDataOnce };
