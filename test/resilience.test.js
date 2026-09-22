const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout, refreshAircraftDataOnce } = require('../lib/aircraft-service');

test('fetchWithTimeout aborts a stalled upstream request', async () => {
    const originalFetch = global.fetch;
    let aborted = false;
    global.fetch = (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
    });
    try {
        await assert.rejects(fetchWithTimeout('https://example.test', {}, 5), { name: 'AbortError' });
        assert.equal(aborted, true);
    } finally {
        global.fetch = originalFetch;
    }
});

test('concurrent refresh callers share one in-flight refresh', async () => {
    const originalFetch = global.fetch;
    const originalClientId = process.env.OPENSKY_NETWORK_CLIENT_ID;
    const originalClientSecret = process.env.OPENSKY_NETWORK_CLIENT_SECRET;
    let stateRequests = 0;
    process.env.OPENSKY_NETWORK_CLIENT_ID = 'test-client';
    process.env.OPENSKY_NETWORK_CLIENT_SECRET = 'test-secret';
    global.fetch = async url => {
        const address = String(url);
        if (address.includes('auth.opensky-network.org')) return { ok: true, status: 200, json: async () => ({ access_token: 'test', expires_in: 60 }) };
        if (address.includes('opensky-network.org/api/states/all')) {
            stateRequests += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { ok: true, status: 200, json: async () => ({ time: 1, states: [] }) };
        }
        throw new Error(`Unexpected request: ${address}`);
    };
    try {
        const [first, second] = await Promise.all([refreshAircraftDataOnce(), refreshAircraftDataOnce()]);
        assert.equal(first, true);
        assert.equal(second, true);
        assert.equal(stateRequests, 1);
    } finally {
        global.fetch = originalFetch;
        if (originalClientId === undefined) delete process.env.OPENSKY_NETWORK_CLIENT_ID;
        else process.env.OPENSKY_NETWORK_CLIENT_ID = originalClientId;
        if (originalClientSecret === undefined) delete process.env.OPENSKY_NETWORK_CLIENT_SECRET;
        else process.env.OPENSKY_NETWORK_CLIENT_SECRET = originalClientSecret;
    }
});

test('upstream deadline aborts a body that stalls after headers arrive', async () => {
    const originalFetch = global.fetch;
    let bodyStarted = false;
    global.fetch = async (_url, { signal }) => ({
        ok: true, status: 200,
        json: () => {
            bodyStarted = true;
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
        }
    });
    try {
        await assert.rejects(fetchWithTimeout('https://example.test', {}, 5), { name: 'AbortError' });
        assert.equal(bodyStarted, true);
    } finally {
        global.fetch = originalFetch;
    }
});

test('failed refreshes have a shared cooldown for stale polls, cold polls, and scheduled refreshes', async () => {
    const { getAircraftData } = require('../lib/aircraft-service');
    const state = globalThis.__genevaRunwayAircraftState;
    const originalState = { ...state };
    const originalFetch = global.fetch;
    const originalNow = Date.now;
    let now = Date.parse('2026-09-22T12:00:00Z');
    let calls = 0;
    Date.now = () => now;
    Object.assign(state, {
        cachedData: { updatedAt: now / 1000 - 60, aircraft: [] },
        lastFetchTime: now - 60000, cachedToken: 'test', tokenExpiresAt: now + 120000,
        refreshPromise: null, nextRefreshAt: 0
    });
    global.fetch = async () => { calls++; return { ok: false, status: 503 }; };
    try {
        for (let index = 0; index < 3; index++) {
            const result = await getAircraftData();
            assert.equal(result.status, 200);
            await state.refreshPromise;
        }
        assert.equal(calls, 1);
        await refreshAircraftDataOnce();
        assert.equal(calls, 1);
        now += 29999;
        await refreshAircraftDataOnce();
        assert.equal(calls, 1);
        now += 1;
        await refreshAircraftDataOnce();
        assert.equal(calls, 2);
        // An expired snapshot follows the same refresh path as an empty cache.
        state.lastFetchTime = now - 600001;
        for (let index = 0; index < 3; index++) assert.equal((await getAircraftData()).status, 503);
        assert.equal(calls, 2);
    } finally {
        global.fetch = originalFetch;
        Date.now = originalNow;
        Object.assign(state, originalState);
    }
});

test('upstream HTTP errors discard unused bodies while preserving status for retry logic', async () => {
    const originalFetch = global.fetch;
    let signal;
    global.fetch = async (_url, options) => {
        signal = options.signal;
        return { ok: false, status: 401, json() { throw new Error('Error body should not be consumed'); } };
    };
    try {
        const result = await fetchWithTimeout('https://example.test', {}, 100);
        assert.equal(result.status, 401);
        assert.equal(result.ok, false);
        assert.equal(signal.aborted, true);
    } finally {
        global.fetch = originalFetch;
    }
});
