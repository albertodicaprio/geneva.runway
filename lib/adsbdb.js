const { fetchWithTimeout } = require('./opensky');
const ADSBDB_TIMEOUT = 10000;
const ADSBDB_CONCURRENCY = 4;
const FLIGHT_CACHE_DURATION = 24 * 60 * 60 * 1000;
const AIRCRAFT_CACHE_DURATION = 30 * 24 * 60 * 60 * 1000;
const ADSBDB_URL = 'https://api.adsbdb.com/v0';
const MAX_ARRIVAL_ALTITUDE_METRES = 7000;
const GENEVA_IATA = 'GVA';

function createAdsbdb({ fetch: fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
    const state = { enrichmentCache: { aircraft: {}, flights: {} }, transientFlightCache: {} };

    function restoreCache(cache) {
        state.enrichmentCache = cache || { aircraft: {}, flights: {} };
    }

    function snapshotCache() {
        return state.enrichmentCache;
    }

    function flightCacheKey(aircraft, updatedAt) {
        const timestamp = aircraft.lastPositionUpdate || aircraft.timestamp || updatedAt || Math.floor(clock() / 1000);
        return `${aircraft.callsign}:${aircraft.icao24}:${new Date(timestamp * 1000).toISOString().slice(0, 10)}`;
    }

    function fetchJsonWithTimeout(url) {
        return fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, ADSBDB_TIMEOUT, fetchImpl);
    }

    async function getAdsbdbCached(kind, key, url, duration, shouldPersist = () => true) {
        const entries = state.enrichmentCache[kind];
        const cached = entries[key] || (kind === 'flights' ? state.transientFlightCache[key] : null);
        if (cached && clock() - cached.fetchedAt < duration) return cached;
        try {
            const apiResponse = await fetchJsonWithTimeout(url);
            if (apiResponse.ok || apiResponse.status === 404) {
                const entry = { fetchedAt: clock(), notFound: apiResponse.status === 404, data: apiResponse.data };
                if (shouldPersist(entry)) {
                    entries[key] = entry;
                } else if (kind === 'flights') {
                    state.transientFlightCache[key] = entry;
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
    function isGvaArrival(route) { return route?.destination?.iata_code?.toUpperCase() === GENEVA_IATA; }
    function destinationCode(route) {
        return route?.destination?.iata_code?.toUpperCase() || route?.destination?.icao_code?.toUpperCase() || 'unknown';
    }
    function flightDynamicsSummary(aircraft) {
        const altitude = Number.isFinite(aircraft.altitude) ? `${Math.round(aircraft.altitude).toLocaleString()} m` : 'unknown';
        const horizontalSpeed = Number.isFinite(aircraft.velocity) ? `${Math.round(aircraft.velocity * 3.6).toLocaleString()} km/h` : 'unknown';
        const verticalSpeed = Number.isFinite(aircraft.verticalRate) ? `${Math.round(aircraft.verticalRate * 60).toLocaleString()} m/min` : 'unknown';
        return `altitude ${altitude}; horizontal speed ${horizontalSpeed}; vertical speed ${verticalSpeed}`;
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

    async function lookupFlightRoute(aircraft, updatedAt, persistArrival = true) {
        if (!aircraft.callsign || !aircraft.icao24) return null;
        const entry = await getAdsbdbCached(
            'flights',
            flightCacheKey(aircraft, updatedAt),
            `${ADSBDB_URL}/callsign/${encodeURIComponent(aircraft.callsign)}`,
            FLIGHT_CACHE_DURATION,
            candidate => persistArrival && isGvaArrival(flightRouteFrom(candidate.data))
        );
        return entry && !entry.notFound ? flightRouteFrom(entry.data) : null;
    }

    async function lookupAircraftDetails(aircraft) {
        if (!aircraft.icao24) return null;
        const entry = await getAdsbdbCached('aircraft', aircraft.icao24.toLowerCase(), `${ADSBDB_URL}/aircraft/${encodeURIComponent(aircraft.icao24)}`, AIRCRAFT_CACHE_DURATION);
        return entry && !entry.notFound ? aircraftDetailsFrom(entry.data) : null;
    }

    async function enrichGeneralTraffic(data) {
        const generalTraffic = await mapWithConcurrency(data.generalTraffic, async aircraft => {
            const route = await lookupFlightRoute(aircraft, data.updatedAt, false);
            return { ...aircraft, route: route ? routeSummary(route) : null, aircraftDetails: await lookupAircraftDetails(aircraft) };
        });
        return { ...data, generalTraffic };
    }

    async function enrichGvaArrivals(data) {
        const hasEligibleAltitude = aircraft =>
            Number.isFinite(aircraft.altitude) && aircraft.altitude <= MAX_ARRIVAL_ALTITUDE_METRES;
        const candidates = data.aircraft.filter(aircraft =>
            !aircraft.onGround && aircraft.callsign && aircraft.icao24 &&
            hasEligibleAltitude(aircraft)
        );
        const excludedOnGroundCount = data.aircraft.filter(aircraft => aircraft.onGround).length;
        const excludedWithoutIdentityCount = data.aircraft.filter(aircraft =>
            !aircraft.onGround && (!aircraft.callsign || !aircraft.icao24)
        ).length;
        const excludedAltitudeCount = data.aircraft.filter(aircraft =>
            !aircraft.onGround && aircraft.callsign && aircraft.icao24 && !hasEligibleAltitude(aircraft)
        ).length;
        const routed = await mapWithConcurrency(candidates, async aircraft => {
            const route = await lookupFlightRoute(aircraft, data.updatedAt);
            return { aircraft, route };
        });
        for (const { aircraft, route } of routed) {
            console.log(`Route lookup: ${aircraft.callsign} → ${destinationCode(route)} (${isGvaArrival(route) ? 'confirmed GVA arrival' : 'not a confirmed GVA arrival'}; ${flightDynamicsSummary(aircraft)})`);
        }
        const gvaArrivals = routed.filter(({ route }) => isGvaArrival(route));
        const enriched = await mapWithConcurrency(gvaArrivals, async ({ aircraft, route }) => {
            return { ...aircraft, route: routeSummary(route), aircraftDetails: await lookupAircraftDetails(aircraft) };
        });
        const arrivals = { ...data, aircraft: enriched.sort((first, second) => (first.altitude ?? Infinity) - (second.altitude ?? Infinity)) };
        pruneEnrichmentCache({ ...arrivals, generalTraffic: data.aircraft.filter(aircraft => !aircraft.onGround && aircraft.icao24) });
        console.log(`Arrival filtering: ${data.aircraft.length} nearby; ${candidates.length} route lookups; ${gvaArrivals.length} confirmed GVA; ${excludedOnGroundCount} on ground; ${excludedWithoutIdentityCount} missing callsign or ICAO24; ${excludedAltitudeCount} above 7000 m or missing altitude`);
        return arrivals;
    }

    function pruneEnrichmentCache(arrivals) {
        const flightKeys = new Set(arrivals.aircraft.map(aircraft => flightCacheKey(aircraft, arrivals.updatedAt)));
        const aircraftKeys = new Set([...arrivals.aircraft, ...(arrivals.generalTraffic || [])].map(aircraft => aircraft.icao24.toLowerCase()));
        state.enrichmentCache.flights = Object.fromEntries(
            Object.entries(state.enrichmentCache.flights).filter(([key]) => flightKeys.has(key))
        );
        state.enrichmentCache.aircraft = Object.fromEntries(
            Object.entries(state.enrichmentCache.aircraft).filter(([key]) => aircraftKeys.has(key))
        );
    }

    return { enrichGeneralTraffic, enrichGvaArrivals, restoreCache, snapshotCache };
}

module.exports = { createAdsbdb };
