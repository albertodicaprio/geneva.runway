const test = require('node:test');
const assert = require('node:assert/strict');
const { create, FETCH_INTERVAL } = require('../public/app');

function fixture(now) {
    return {
        updatedAt: now / 1000, cacheUpdatedAt: now / 1000,
        positionEstimate: { isEstimated: true },
        aircraft: [{ icao24: 'arrival', callsign: 'ARRIVAL', altitude: 1200, distanceKm: 10,
            velocity: 100, verticalRate: -2, approachDirection: '22' }],
        recentTracks: [{ callsign: 'RECENT', expiresAt: now / 1000 + 3,
            disappearedAt: now / 1000 - 60 }]
    };
}

function setup({ fetch, now, schedule } = {}) {
    const ids = ['nextPlane', 'arrivalCount', 'aircraftList', 'lastUpdated', 'dataStatus',
        'historyCount', 'flightHistory'];
    const elements = Object.fromEntries(ids.map(id => [id, {}]));
    const mapUpdates = [];
    const map = { initCalls: 0, init() { this.initCalls += 1; }, update(value) { mapUpdates.push(value); } };
    const listeners = [];
    const app = create({
        document: { getElementById: id => elements[id], addEventListener: (...args) => listeners.push(args) },
        fetch, now, schedule, map, logger: { error() {} }
    });
    return { app, elements, map, mapUpdates, listeners };
}

test('a successful poll renders cards, status, history, and the same map snapshot', async () => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    const data = fixture(now);
    const { app, elements, mapUpdates } = setup({ now: () => now,
        fetch: async () => ({ ok: true, json: async () => data }) });
    await app.poll();
    assert.equal(app.snapshot, data);
    assert.match(elements.nextPlane.innerHTML, /ARRIVAL/);
    assert.match(elements.aircraftList.innerHTML, /ARRIVAL/);
    assert.equal(elements.arrivalCount.textContent, '1 arrival');
    assert.equal(elements.historyCount.textContent, '1 flight');
    assert.equal(elements.dataStatus.textContent, 'Estimated positions · 0s since last update');
    assert.equal(mapUpdates.at(-1), data);
    now += 4_000;
    app.updateTimeSensitive();
    assert.equal(elements.historyCount.textContent, '0 flights');
    assert.match(elements.flightHistory.innerHTML, /No recent landings/);
    assert.equal(elements.dataStatus.textContent, 'Estimated positions · 4s since last update');
    assert.equal(mapUpdates.at(-1), data);
});

test('failed and rate-limited polls retain the snapshot, update age and expiry, and honor retry limits', async () => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    const data = fixture(now);
    let requests = 0;
    const responses = [
        { ok: true, json: async () => data },
        { ok: false, status: 429, json: async () => ({ retryAfter: 10 }) },
        { ok: true, json: async () => ({ ...data, aircraft: [] }) }
    ];
    const { app, elements, mapUpdates } = setup({ now: () => now, fetch: async () => responses[requests++] });
    await app.poll();
    now += 4_000;
    await app.tick();
    assert.equal(requests, 2);
    assert.equal(app.snapshot, data);
    assert.match(elements.aircraftList.innerHTML, /rate limited/);
    assert.equal(elements.historyCount.textContent, '0 flights');
    assert.equal(elements.dataStatus.textContent, 'Estimated positions · 4s since last update');
    await app.tick();
    assert.equal(requests, 2);
    assert.equal(mapUpdates.at(-1), data);
    now += 10_000;
    await app.tick();
    assert.equal(requests, 3);
    assert.equal(elements.arrivalCount.textContent, '0 arrivals');
    assert.match(elements.aircraftList.innerHTML, /No confirmed Geneva arrivals/);
});

test('one timer drives polling and expiry without concurrent requests', async () => {
    let resolveRequest;
    let requests = 0;
    const timers = [];
    const { app, map, listeners } = setup({ now: () => 100_000,
        fetch: () => { requests += 1; return new Promise(resolve => { resolveRequest = resolve; }); },
        schedule: (callback, interval) => timers.push({ callback, interval }) });
    app.start();
    app.start();
    assert.equal(map.initCalls, 1);
    assert.equal(listeners.length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].interval, FETCH_INTERVAL);
    await timers[0].callback();
    assert.equal(requests, 1);
    resolveRequest({ ok: true, json: async () => ({ aircraft: [] }) });
    await new Promise(resolve => setImmediate(resolve));
    const secondPoll = timers[0].callback();
    assert.equal(requests, 2);
    resolveRequest({ ok: true, json: async () => ({ aircraft: [] }) });
    await secondPoll;
});

test('network errors preserve the last snapshot until a later successful poll', async () => {
    const data = fixture(100_000);
    let requests = 0;
    const { app, elements, mapUpdates } = setup({ now: () => 100_000,
        fetch: async () => {
            requests += 1;
            if (requests === 2) throw Error('offline');
            return { ok: true, json: async () => data };
        } });
    await app.poll();
    await app.tick();
    assert.equal(app.snapshot, data);
    assert.match(elements.aircraftList.innerHTML, /Unable to load arrival data/);
    assert.equal(elements.historyCount.textContent, '1 flight');
    assert.equal(mapUpdates.at(-1), data);
    await app.tick();
    assert.match(elements.aircraftList.innerHTML, /ARRIVAL/);
    assert.equal(requests, 3);
});
