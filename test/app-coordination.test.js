const test = require('node:test');
const assert = require('node:assert/strict');
const { create, projectSnapshot, FETCH_INTERVAL, DISPLAY_INTERVAL } = require('../public/app');
const { projectAircraftData } = require('../lib/traffic');

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

test('client projection advances from the received position once per second and stops at 60 seconds', () => {
    const snapshot = {
        updatedAt: 1_000,
        positionEstimate: { estimatedAt: 1_010, isEstimated: true, maximumSecondsAhead: 60 },
        aircraft: [{ latitude: 46.2381, longitude: 6.1093, heading: 90, velocity: 100,
            altitude: 1_000, verticalRate: -2, distanceKm: 0, projectionSeconds: 10, positionEstimated: true }],
        generalTraffic: [], recentTracks: [{ expiresAt: 2_000 }]
    };
    const oneSecond = projectSnapshot(snapshot, 1_011_000);
    const later = projectSnapshot(snapshot, 1_100_000);
    const muchLater = projectSnapshot(snapshot, 1_200_000);
    assert.ok(oneSecond.aircraft[0].longitude > snapshot.aircraft[0].longitude);
    assert.equal(oneSecond.aircraft[0].altitude, 998);
    assert.equal(oneSecond.aircraft[0].projectionSeconds, 11);
    assert.equal(later.aircraft[0].projectionSeconds, 60);
    assert.deepEqual(muchLater.aircraft, later.aircraft);
    assert.equal(snapshot.aircraft[0].altitude, 1_000);
    assert.equal(snapshot.aircraft[0].projectionSeconds, 10);
    assert.equal(oneSecond.recentTracks, snapshot.recentTracks);
});

test('client projection matches the server calculation from the same source position', () => {
    const source = { updatedAt: 1_000, aircraft: [{ latitude: 46.2381, longitude: 6.1093,
        heading: 220, velocity: 120, altitude: 1_500, verticalRate: -3 }] };
    const received = projectAircraftData(source, 1_010_000);
    const expected = projectAircraftData(source, 1_025_000).aircraft[0];
    const actual = projectSnapshot(received, 1_025_000).aircraft[0];
    for (const key of ['latitude', 'longitude', 'altitude', 'distanceKm'])
        assert.ok(Math.abs(actual[key] - expected[key]) < 0.00001, `${key} differs`);
    assert.equal(actual.projectionSeconds, 25);
});

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

test('one-second display updates move aircraft without another request', async () => {
    let now = 1_000_000;
    const data = fixture(now);
    data.positionEstimate.estimatedAt = now / 1000;
    Object.assign(data.aircraft[0], { latitude: 46.2381, longitude: 6.1093, heading: 90,
        projectionSeconds: 0, positionEstimated: false });
    let requests = 0;
    const { app, mapUpdates } = setup({ now: () => now,
        fetch: async () => { requests += 1; return { ok: true, json: async () => data }; } });
    await app.poll();
    now += DISPLAY_INTERVAL;
    await app.tick();
    assert.equal(requests, 1);
    assert.ok(mapUpdates.at(-1).aircraft[0].longitude > data.aircraft[0].longitude);
    assert.equal(mapUpdates.at(-1).aircraft[0].projectionSeconds, 1);
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
    now += FETCH_INTERVAL;
    await app.tick();
    assert.equal(requests, 2);
    assert.equal(app.snapshot, data);
    assert.match(elements.aircraftList.innerHTML, /rate limited/);
    assert.equal(elements.historyCount.textContent, '0 flights');
    assert.equal(elements.dataStatus.textContent, 'Estimated positions · 30s since last update');
    await app.tick();
    assert.equal(requests, 2);
    assert.equal(mapUpdates.at(-1), data);
    now += 10_000;
    await app.tick();
    assert.equal(requests, 2);
    now += 20_000;
    await app.tick();
    assert.equal(requests, 3);
    assert.equal(elements.arrivalCount.textContent, '0 arrivals');
    assert.match(elements.aircraftList.innerHTML, /No confirmed Geneva arrivals/);
});

test('Caddy 429 honors Retry-After and resumes polling when the window clears', async () => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    let requests = 0;
    const responses = [
        { ok: false, status: 429, headers: { get: () => '7' }, json: async () => { throw Error('not JSON'); } },
        { ok: true, json: async () => fixture(now) }
    ];
    const { app, elements } = setup({ now: () => now, fetch: async () => responses[requests++] });
    await app.poll();
    assert.match(elements.nextPlane.innerHTML, /Retrying in 7 seconds/);
    now += 6_000;
    await app.tick();
    assert.equal(requests, 1);
    now += FETCH_INTERVAL - 6_000;
    await app.tick();
    assert.equal(requests, 2);
    assert.match(elements.nextPlane.innerHTML, /ARRIVAL/);
});

test('one timer drives polling and expiry without concurrent requests', async () => {
    let resolveRequest;
    let requests = 0;
    const timers = [];
    let now = 100_000;
    const { app, map, listeners } = setup({ now: () => now,
        fetch: () => { requests += 1; return new Promise(resolve => { resolveRequest = resolve; }); },
        schedule: (callback, interval) => timers.push({ callback, interval }) });
    app.start();
    app.start();
    assert.equal(map.initCalls, 1);
    assert.equal(listeners.length, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].interval, DISPLAY_INTERVAL);
    await timers[0].callback();
    assert.equal(requests, 1);
    now += FETCH_INTERVAL;
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
    data.recentTracks[0].expiresAt = 190;
    let requests = 0;
    let now = 100_000;
    const { app, elements, mapUpdates } = setup({ now: () => now,
        fetch: async () => {
            requests += 1;
            if (requests === 2) throw Error('offline');
            return { ok: true, json: async () => data };
        } });
    await app.poll();
    now += FETCH_INTERVAL;
    await app.tick();
    assert.equal(app.snapshot, data);
    assert.match(elements.aircraftList.innerHTML, /Unable to load arrival data/);
    assert.equal(elements.historyCount.textContent, '1 flight');
    assert.equal(mapUpdates.at(-1), data);
    now += FETCH_INTERVAL;
    await app.tick();
    assert.match(elements.aircraftList.innerHTML, /ARRIVAL/);
    assert.equal(requests, 3);
});

test('each page renders its own data without initializing the map elsewhere', async () => {
    const data = fixture(Date.parse('2026-01-01T12:00:00Z'));
    for (const pageIds of [
        ['nextPlane', 'lastUpdated'],
        ['arrivalCount', 'aircraftList'],
        ['historyCount', 'flightHistory']
    ]) {
        const elements = Object.fromEntries(['dataStatus', ...pageIds].map(id => [id, {}]));
        let mapInits = 0;
        let mapUpdates = 0;
        const app = create({
            document: { getElementById: id => elements[id] || null, addEventListener() {} },
            fetch: async () => ({ ok: true, json: async () => data }),
            now: () => Date.parse('2026-01-01T12:00:00Z'),
            schedule() {},
            map: { init() { mapInits += 1; }, update() { mapUpdates += 1; } }
        });
        app.start();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(mapInits, pageIds.includes('nextPlane') ? 1 : 0);
        assert.equal(mapUpdates > 0, pageIds.includes('nextPlane'));
        assert.match(elements.dataStatus.textContent, /since last update/);
        if (elements.nextPlane) assert.match(elements.nextPlane.innerHTML, /ARRIVAL/);
        if (elements.aircraftList) assert.match(elements.aircraftList.innerHTML, /ARRIVAL/);
        if (elements.flightHistory) assert.match(elements.flightHistory.innerHTML, /RECENT/);
    }
});
