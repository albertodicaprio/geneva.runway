const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout } = require('../lib/opensky');
const { createAircraftService } = require('../lib/aircraft-service');

const noCache = {
    async read() { const error = new Error('Cache missing'); error.code = 'ENOENT'; throw error; },
    async write() {}
};
const credentials = () => ({ clientId: 'test-client', clientSecret: 'test-secret' });
const tokenResponse = { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 1800 }) };
const noHistory = { async recordSnapshot() {} };

test('upstream deadline aborts a stalled request before headers', async () => {
    let aborted = false;
    const fetchMock = (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
    });
    await assert.rejects(fetchWithTimeout('https://example.test', {}, 5, fetchMock), { name: 'AbortError' });
    assert.equal(aborted, true);
});

test('upstream deadline aborts a body that stalls after headers arrive', async () => {
    let bodyStarted = false;
    const fetchMock = async (_url, { signal }) => ({
        ok: true, status: 200,
        json: () => {
            bodyStarted = true;
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        }
    });
    await assert.rejects(fetchWithTimeout('https://example.test', {}, 5, fetchMock), { name: 'AbortError' });
    assert.equal(bodyStarted, true);
});

test('upstream HTTP errors discard unused bodies while preserving status for retry logic', async () => {
    let signal;
    const fetchMock = async (_url, options) => {
        signal = options.signal;
        return { ok: false, status: 401, json() { throw new Error('Error body should not be consumed'); } };
    };
    const result = await fetchWithTimeout('https://example.test', {}, 100, fetchMock);
    assert.equal(result.status, 401);
    assert.equal(result.ok, false);
    assert.equal(signal.aborted, true);
});

test('concurrent refresh callers share one upstream request and persist the result', async () => {
    let stateRequests = 0;
    let historyWrites = 0;
    let saved;
    const fetchMock = async url => {
        const address = String(url);
        if (address.includes('/token')) return tokenResponse;
        if (address.includes('/states/all')) {
            stateRequests += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { ok: true, status: 200, json: async () => ({ time: 1, states: [] }) };
        }
        throw new Error(`Unexpected request: ${address}`);
    };
    const service = createAircraftService({ fetch: fetchMock, clock: () => Date.parse('2026-09-22T12:00:00Z'), credentials,
        historyStore: { async recordSnapshot() { historyWrites += 1; } },
        cacheStore: { ...noCache, async write(value) { saved = value; } } });
    const [first, second] = await Promise.all([service.refreshAircraftDataOnce(), service.refreshAircraftDataOnce()]);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(stateRequests, 1);
    assert.equal(historyWrites, 1);
    assert.equal(saved.version, 6);
    assert.deepEqual(saved.arrivals.aircraft, []);
    assert.deepEqual(saved.arrivals.recentTracks, []);
});

test('failed refreshes have one cooldown across stale reads, expired reads, and the scheduler', async () => {
    let now = Date.parse('2026-09-22T12:00:00Z');
    let calls = 0;
    let scheduledRefresh;
    const fetchMock = async url => {
        if (String(url).includes('/token')) return tokenResponse;
        calls += 1;
        return { ok: false, status: 503 };
    };
    const service = createAircraftService({ fetch: fetchMock, clock: () => now, credentials,
        historyStore: noHistory,
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: now - 60000, arrivals: { updatedAt: now / 1000 - 60, aircraft: [] } }) },
        schedule: callback => { scheduledRefresh = callback; return { unref() {} }; } });
    for (let index = 0; index < 3; index++) {
        assert.equal((await service.getAircraftData()).status, 200);
        await service.refreshAircraftDataOnce();
    }
    assert.equal(calls, 1);
    service.startAircraftRefreshScheduler();
    scheduledRefresh();
    assert.equal(calls, 1);
    now += 29999;
    await service.refreshAircraftDataOnce();
    assert.equal(calls, 1);
    now += 1;
    await service.refreshAircraftDataOnce();
    assert.equal(calls, 2);
    now += 600001;
    for (let index = 0; index < 3; index++) assert.equal((await service.getAircraftData()).status, 503);
    assert.equal(calls, 3);
});

test('a fresh on-disk snapshot retains its enrichment and serves without upstream access', async () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    const aircraft = { icao24: 'abc123', callsign: 'SWR123', latitude: 46.2, longitude: 6.1,
        altitude: 1000, route: { airline: { name: 'Swiss' } },
        aircraftDetails: { type: 'Airbus A320' }, track: { colorVersion: 3, points: [] } };
    const retained = { ...aircraft, disappearedAt: now / 1000 - 30, expiresAt: now / 1000 + 7000 };
    const store = { read: async () => ({ version: 6, lastFetchTime: now - 1000,
        arrivals: { updatedAt: now / 1000, aircraft: [aircraft], generalTraffic: [], recentTracks: [retained] },
        enrichment: { aircraft: { abc123: { fetchedAt: now, data: aircraft.aircraftDetails } }, flights: {} } }) };
    const service = createAircraftService({ clock: () => now, cacheStore: store,
        historyStore: noHistory,
        fetch: () => { throw new Error('Upstream should not be called'); } });
    const result = await service.getAircraftData();
    assert.equal(result.status, 200);
    assert.equal(result.headers['X-Cache'], 'HIT');
    assert.equal(result.body.aircraft[0].route.airline.name, 'Swiss');
    assert.deepEqual(result.body.recentTracks[0], retained);
});

test('a waiting aircraft request returns the next completed refresh', async () => {
    let now = Date.parse('2026-09-22T12:00:00Z');
    const initialTime = now - 10_000;
    const service = createAircraftService({ clock: () => now, credentials, historyStore: noHistory,
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: initialTime,
            arrivals: { updatedAt: initialTime / 1000, aircraft: [] } }), async write() {} },
        fetch: async url => String(url).includes('/token') ? tokenResponse :
            { ok: true, status: 200, json: async () => ({ time: now / 1000, states: [] }) }
    });
    let settled = false;
    const pending = service.getAircraftData({ after: initialTime }).then(result => {
        settled = true;
        return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    now += 20_000;
    await service.refreshAircraftDataOnce();
    const result = await pending;
    assert.equal(result.body.cacheUpdatedAtMs, now);
});

test('a waiting aircraft request returns stale data after its bounded wait', async () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    const lastFetchTime = now - 10_000;
    const service = createAircraftService({ clock: () => now, waitTimeoutMs: 5,
        cacheStore: { read: async () => ({ version: 6, lastFetchTime,
            arrivals: { updatedAt: lastFetchTime / 1000, aircraft: [] } }) },
        historyStore: noHistory, fetch: () => { throw Error('Refresh not due'); } });
    const result = await service.getAircraftData({ after: lastFetchTime });
    assert.equal(result.status, 200);
    assert.equal(result.body.cacheUpdatedAtMs, lastFetchTime);
});

test('a scheduler refresh loads cached arrivals before retaining their tracks', async () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    const previous = { icao24: 'abc123', callsign: 'SWR123', latitude: 46.2, longitude: 6.1,
        route: { airline: { name: 'Swiss' } }, aircraftDetails: { type: 'Airbus A320' },
        track: { color: 'hsl(35, 90%, 45%)', colorVersion: 3, points: [{ latitude: 46.2, longitude: 6.1, timestamp: now / 1000 - 30 }] } };
    let readCount = 0;
    let saved;
    const service = createAircraftService({ clock: () => now, credentials,
        historyStore: noHistory,
        cacheStore: {
            async read() {
                readCount += 1;
                await new Promise(resolve => setTimeout(resolve, 5));
                return { version: 6, lastFetchTime: now - 30000,
                    arrivals: { updatedAt: now / 1000 - 30, aircraft: [previous], generalTraffic: [], recentTracks: [] } };
            },
            async write(value) { saved = value; }
        },
        fetch: async url => String(url).includes('/token') ? tokenResponse :
            { ok: true, status: 200, json: async () => ({ time: now / 1000, states: [] }) }
    });
    const [refreshed, response] = await Promise.all([service.refreshAircraftDataOnce(), service.getAircraftData()]);
    assert.equal(refreshed, true);
    assert.equal(response.status, 200);
    assert.equal(readCount, 1);
    assert.equal(saved.arrivals.recentTracks.length, 1);
    assert.equal(saved.arrivals.recentTracks[0].route.airline.name, 'Swiss');
    assert.deepEqual(saved.arrivals.recentTracks[0].track.points, previous.track.points);
});
