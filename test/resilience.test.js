const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiRateLimiter } = require('../lib/api-rate-limiter');
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

test('rate limiter allows a burst, returns Retry-After, and releases concurrency slots once', () => {
    let now = 0;
    const limiter = new ApiRateLimiter({ capacity: 2, requestsPerMinute: 60, maxConcurrent: 1, now: () => now });
    const first = limiter.acquire('127.0.0.1');
    assert.equal(first.allowed, true);
    assert.equal(limiter.acquire('127.0.0.2').status, 503);
    first.release();
    first.release();
    const second = limiter.acquire('127.0.0.2');
    assert.equal(second.allowed, true);
    second.release();
    const third = limiter.acquire('127.0.0.1');
    assert.equal(third.allowed, true);
    third.release();
    const limited = limiter.acquire('127.0.0.1');
    assert.equal(limited.status, 429);
    assert.equal(limited.retryAfterSeconds, 1);
    now += 1000;
    assert.equal(limiter.acquire('127.0.0.1').allowed, true);
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
