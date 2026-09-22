const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createOpenSky } = require('./opensky');
const { createAdsbdb } = require('./adsbdb');
const { addArrivalTracks, addGeneralTraffic, normalizeOpenSkyData, projectAircraftData } = require('./traffic');

const CACHE_DURATION = 30000;
const MAX_STALE_AGE = 600000;
const CACHE_VERSION = 6;
const AIRCRAFT_CACHE_FILE = process.env.AIRCRAFT_CACHE_FILE || path.join(os.tmpdir(), 'geneva-runway-aircraft-cache.json');
const AIRCRAFT_REFRESH_PAUSE_START_HOUR = 1;
const AIRCRAFT_REFRESH_PAUSE_END_HOUR = 5;
const AIRCRAFT_REFRESH_TIME_ZONE = 'Europe/Zurich';

const fileCacheStore = {
    async read() { return JSON.parse(await fs.readFile(AIRCRAFT_CACHE_FILE, 'utf8')); },
    async write(data) {
        await fs.mkdir(path.dirname(AIRCRAFT_CACHE_FILE), { recursive: true });
        await fs.writeFile(AIRCRAFT_CACHE_FILE, JSON.stringify(data));
    }
};

function isAircraftRefreshPaused(now = Date.now()) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
        timeZone: AIRCRAFT_REFRESH_TIME_ZONE,
        hour: '2-digit',
        hourCycle: 'h23'
    }).format(new Date(now)));
    return hour >= AIRCRAFT_REFRESH_PAUSE_START_HOUR && hour < AIRCRAFT_REFRESH_PAUSE_END_HOUR;
}

function createAircraftService({ fetch: fetchImpl = globalThis.fetch, clock = Date.now,
    cacheStore = fileCacheStore, credentials, schedule = setInterval } = {}) {
    const state = {
        cachedData: null, lastFetchTime: 0, refreshPromise: null,
        nextRefreshAt: 0, refreshInterval: null,
        loadPromise: null, loaded: false
    };
    const openSky = createOpenSky({ fetch: fetchImpl, clock, credentials });
    const adsbdb = createAdsbdb({ fetch: fetchImpl, clock });

    function response(status, body, cacheStatus) {
        return { status, body, headers: { 'Cache-Control': 'no-store', 'X-Cache': cacheStatus } };
    }

    function cachedResponseBody() {
        return {
            ...projectAircraftData(state.cachedData, clock()),
            cacheUpdatedAt: Math.floor(state.lastFetchTime / 1000)
        };
    }

    async function loadCachedAircraftData() {
        if (state.loaded) return;
        if (!state.loadPromise) {
            state.loadPromise = (async () => {
                try {
                    const cache = await cacheStore.read();
                    if (cache?.version === CACHE_VERSION && cache.arrivals && Number.isFinite(cache.lastFetchTime)) {
                        state.lastFetchTime = cache.lastFetchTime;
                        state.cachedData = cache.arrivals;
                        adsbdb.restoreCache(cache.enrichment);
                    }
                } catch (error) {
                    if (error.code !== 'ENOENT') console.warn('Failed to read aircraft cache file:', error.message);
                } finally {
                    state.loaded = true;
                }
            })();
        }
        await state.loadPromise;
    }

    async function saveCachedAircraftData(data) {
        state.cachedData = data;
        state.lastFetchTime = clock();
        try {
            await cacheStore.write({
                version: CACHE_VERSION,
                arrivals: state.cachedData,
                lastFetchTime: state.lastFetchTime,
                enrichment: adsbdb.snapshotCache()
            });
        } catch (error) {
            console.warn('Failed to write aircraft cache file:', error.message);
        }
    }

    async function refreshAircraftData() {
        await loadCachedAircraftData();
        const statesResponse = await openSky.fetchStates();
        if (!statesResponse.ok) {
            console.warn(`OpenSky refresh failed with ${statesResponse.status}`);
            return false;
        }
        const normalization = {};
        const normalizedData = normalizeOpenSkyData(statesResponse.data, normalization);
        console.log(`OpenSky state filtering: ${normalization.stateCount} received; ${normalization.inBoundsAircraftCount} inside search bounds; ${normalization.outsideBoundsCount} outside bounds; ${normalization.invalidPositionCount} without valid position`);
        const arrivals = await adsbdb.enrichGvaArrivals(normalizedData);
        const withTracks = addArrivalTracks(arrivals, state.cachedData, clock());
        const withTraffic = addGeneralTraffic(withTracks, normalizedData, state.cachedData, clock());
        const data = await adsbdb.enrichGeneralTraffic(withTraffic);
        await saveCachedAircraftData(data);
        console.log(`Successfully refreshed cache from OpenSky with ${data.aircraft.length} confirmed Geneva arrivals`);
        return true;
    }

    function refreshAircraftDataOnce() {
        if (state.refreshPromise) return state.refreshPromise;
        if (clock() < state.nextRefreshAt) return Promise.resolve(false);
        // Limit attempts, including failures, across both polling and the scheduler.
        state.nextRefreshAt = clock() + CACHE_DURATION;
        state.refreshPromise = refreshAircraftData()
            .catch(error => {
                console.warn('Aircraft refresh failed:', error.message);
                return false;
            })
            .finally(() => { state.refreshPromise = null; });
        return state.refreshPromise;
    }

    function startAircraftRefreshScheduler() {
        if (state.refreshInterval) return;

        const refresh = () => {
            if (!isAircraftRefreshPaused(clock())) void refreshAircraftDataOnce();
        };
        refresh();
        state.refreshInterval = schedule(refresh, CACHE_DURATION);
        state.refreshInterval.unref?.();
    }

    async function getAircraftData() {
        try {
            await loadCachedAircraftData();
            if (isAircraftRefreshPaused(clock())) {
                if (state.cachedData) return response(200, cachedResponseBody(), 'PAUSED');
                return {
                    status: 503,
                    body: { error: 'Aircraft tracking is paused between 01:00 and 05:00 Geneva time.' },
                    headers: { 'Cache-Control': 'no-store', 'X-Cache': 'PAUSED' }
                };
            }
            const age = clock() - state.lastFetchTime;
            if (state.cachedData && age < MAX_STALE_AGE) {
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
            if (state.cachedData) return response(200, cachedResponseBody(), 'STALE-ERROR');
            return { status: 500, body: { error: 'Failed to fetch aircraft data' }, headers: {} };
        }
    }

    return { getAircraftData, refreshAircraftDataOnce, startAircraftRefreshScheduler };
}

const defaultService = createAircraftService();
module.exports = { createAircraftService, isAircraftRefreshPaused,
    getAircraftData: defaultService.getAircraftData,
    refreshAircraftDataOnce: defaultService.refreshAircraftDataOnce,
    startAircraftRefreshScheduler: defaultService.startAircraftRefreshScheduler };
