const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RUNWAYS, approachGate, advanceGoAroundAlert, validGoAroundAlert } = require('../lib/go-around-detector');
const { createGoAroundAlerts } = require('../lib/go-around-alerts');
const { createTelegramStore } = require('../lib/telegram-store');
const { createAircraftService } = require('../lib/aircraft-service');

const start = 1_000_000;
// Position a test flight relative to either landing threshold, in kilometres.
function sample(n, altitude = 650, before = 2, extra = {}, direction = '22') {
    const runway = RUNWAYS.find(r => r.direction === direction);
    const angle = runway.heading * Math.PI / 180;
    return { id: 'abc:SWR123', callsign: 'SWR123', observedAt: start + n * 30_000,
        latitude: runway.latitude - before * Math.cos(angle) / 111.195,
        longitude: runway.longitude - before * Math.sin(angle) / (111.195 * Math.cos(runway.latitude * Math.PI / 180)),
        heading: runway.heading, altitude, verticalRate: -3, onGround: false, ...extra };
}
const snapshot = (n, arrivals = [sample(n)]) => ({ arrivals, observedAt: start + n * 30_000, stale: false });
function advance(state, n, point) { return advanceGoAroundAlert(state, snapshot(n, point ? [point] : []), start + n * 30_000); }
function armed(direction = '22') {
    let state = advance(null, 0, sample(0, 800, 5, {}, direction));
    return advance(state, 1, sample(1, 650, 3, {}, direction));
}
function event(direction = '22') {
    let state = advance(armed(direction), 2, sample(2, 720, 1, { verticalRate: 3 }, direction));
    return advance(state, 3, sample(3, 820, -1, { verticalRate: 4 }, direction));
}

test('both runway corridors require low, aligned inbound positions', () => {
    for (const direction of ['04', '22']) {
        assert.equal(approachGate(sample(0, 800, 5, {}, direction)).direction, direction);
        for (const point of [sample(0, 1200, 5, {}, direction), sample(0, 800, 9, {}, direction),
            sample(0, 800, -1, {}, direction), sample(0, 800, 5, { heading: 140 }, direction),
            sample(0, 800, 5, { onGround: true }, direction), sample(0, 800, 5, { latitude: 46.7 }, direction)]) {
            assert.equal(approachGate(point), null);
        }
    }
});

test('two fresh climbing observations and at least 150 metres of gain confirm one event for either runway', () => {
    for (const direction of ['04', '22']) {
        let state = armed(direction);
        assert.equal(state.flights[0].phase, 'armed');
        state = advance(state, 2, sample(2, 720, 1, { verticalRate: 3 }, direction));
        assert.equal(state.flights[0].pending, null);
        state = advance(state, 3, sample(3, 799, -1, { verticalRate: 4 }, direction));
        assert.equal(state.flights[0].pending, null);
        state = advance(state, 4, sample(4, 800, -2, { verticalRate: 4 }, direction));
        assert.equal(state.flights[0].pending, null); // No meaningful altitude increase this update.
        state = event(direction);
        assert.equal(state.flights[0].pending.runway, direction);
        assert.equal(validGoAroundAlert(state), true);
    }
});

test('ordinary landings, departures, high approaches and single altitude spikes do not alert', () => {
    for (const sequence of [
        [sample(2, 500, 1), sample(3, 420, 0, { onGround: true })],
        [sample(2, 900, 1, { verticalRate: 4 }), sample(3, 660, -1, { verticalRate: -2 })],
        [sample(2, 720, 1, { verticalRate: 0 }), sample(3, 820, -1, { verticalRate: 0 })]
    ]) {
        let state = armed();
        for (let i = 0; i < sequence.length; i++) state = advance(state, i + 2, sequence[i]);
        assert.ok(state.flights.every(f => !f.pending));
    }
    let state;
    for (let n = 0; n < 4; n++) state = advance(state, n, sample(n, 500 + n * 100, -n, { verticalRate: 4 }));
    assert.equal(state.flights[0].pending, null);
    state = advance(null, 0, sample(0, 1600, 5));
    state = advance(state, 1, sample(1, 1500, 3));
    state = advance(state, 2, sample(2, 1700, 1, { verticalRate: 5 }));
    state = advance(state, 3, sample(3, 1900, -1, { verticalRate: 5 }));
    assert.equal(state.flights[0].pending, null);
});

test('duplicate positions cannot arm or confirm; malformed/stale/missing observations and monitoring gaps reset attempts', () => {
    let state = armed();
    state = advanceGoAroundAlert(state, snapshot(2, [sample(1, 820, 1, { verticalRate: 4 })]), start + 60_000);
    assert.equal(state.flights[0].climbs, 0);
    for (const data of [snapshot(2, []), { ...snapshot(2), stale: true }, snapshot(2, [sample(2, NaN)]),
        snapshot(2, [sample(2, 820, 1, { observedAt: start + 90_000 })]),
        snapshot(2, [sample(0)]), snapshot(2, [sample(2, 820, 1, { heading: null })])]) {
        let reset = advanceGoAroundAlert(armed(), data, start + 60_000);
        reset = advance(reset, 3, sample(3, 850, -1, { verticalRate: 4 }));
        assert.ok(reset.flights.every(f => !f.pending));
    }
    state = advance(armed(), 6, sample(6, 820, 1, { verticalRate: 4 }));
    assert.equal(state.flights[0].phase, 'idle');
});

test('an armed approach expires and a second event needs a new descending approach after departure', () => {
    let state = armed();
    for (let n = 2; n <= 8; n++) state = advance(state, n, sample(n, 650, 1, { verticalRate: 0 }));
    assert.equal(state.flights[0].phase, 'idle');
    state = event();
    state.flights[0].pending = null;
    for (let n = 4; n <= 6; n++) state = advance(state, n, sample(n, 820 + n * 100, -n, { verticalRate: 4 }));
    assert.equal(state.flights[0].pending, null);
    state = advance(state, 7, sample(7, 800, 5));
    state = advance(state, 8, sample(8, 650, 3));
    assert.equal(state.flights[0].phase, 'armed');
    state = advance(state, 9, sample(9, 720, 1, { verticalRate: 3 }));
    state = advance(state, 10, sample(10, 820, -1, { verticalRate: 4 }));
    assert.ok(state.flights[0].pending);
});

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-go-around-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'telegram.json');
    const store = createTelegramStore({ filePath });
    await store.update(accounts => {
        accounts.alice = { chatId: '123', userId: '123', name: 'Alice', username: null, connectedAt: start,
            alerts: { goArounds: true }, goAroundAlert: armed() };
        accounts.bob = { ...accounts.alice, chatId: '456', userId: '456', alerts: { goArounds: false } };
        delete accounts.bob.goAroundAlert;
    });
    let n = 2; let data = snapshot(2, [sample(2, 720, 1, { verticalRate: 3 })]); let failure; let reads = 0;
    const sends = []; let queue = Promise.resolve();
    const options = { store, clock: () => start + n * 30_000, logger: {},
        arrivals: async () => { reads++; return data; },
        serialize(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; },
        sendNotification: async delivery => { sends.push(delivery); if (failure) throw failure; } };
    return { store, filePath, options, alerts: createGoAroundAlerts(options), sends, reads: () => reads,
        set(value, override) { n = value; data = override || snapshot(n, [sample(n, 820 + (n - 3) * 50, -1, { verticalRate: 4 })]); },
        fail(value) { failure = value; } };
}

test('delivery identifies flight/runway, isolates accounts, and restart preserves pending detection and deduplication', async t => {
    const f = await fixture(t);
    await f.alerts.check(); assert.equal(f.sends.length, 0);
    f.set(3);
    const restarted = createGoAroundAlerts({ ...f.options, store: createTelegramStore({ filePath: f.filePath }) });
    await restarted.check(); assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].accountId, 'alice'); assert.equal(f.sends[0].type, 'goArounds');
    assert.match(f.sends[0].text, /possible go-around: SWR123/); assert.match(f.sends[0].text, /runway 22/);
    assert.match(f.sends[0].text, /does not confirm/);
    assert.equal((await f.store.read()).accounts.bob.goAroundAlert, undefined);
    f.set(4); await createGoAroundAlerts(f.options).check(); assert.equal(f.sends.length, 1);
});

test('delivery shares cooldown and honors Telegram retry delays, expiration and a three-attempt limit', async t => {
    const f = await fixture(t);
    await f.alerts.check();
    await f.store.update(accounts => { accounts.alice.nextSendAt = start + 4 * 30_000; });
    f.set(3); await f.alerts.check(); assert.equal(f.sends.length, 0);
    f.set(4); f.fail({ code: 429, retryAfter: 60 }); await f.alerts.check();
    f.set(5); await f.alerts.check(); assert.equal(f.sends.length, 1);
    f.set(6); f.fail({ code: 'unavailable' }); await f.alerts.check(); assert.equal(f.sends.length, 2);
    for (let n = 7; n <= 13; n++) { f.set(n); await f.alerts.check(); }
    assert.equal(f.sends.length, 3);
    assert.equal((await f.store.read()).accounts.alice.goAroundAlert.flights[0].pending, null);
    const g = await fixture(t); await g.alerts.check();
    await g.store.update(accounts => { accounts.alice.nextSendAt = start + 20 * 30_000; });
    for (let n = 3; n <= 13; n++) { g.set(n); await g.alerts.check(); }
    assert.equal(g.sends.length, 0);
    assert.equal((await g.store.read()).accounts.alice.goAroundAlert.flights[0].pending, null);
});

test('pending delivery cancels on stale/missing data, disconnect, opt-out or a blocked bot', async t => {
    for (const kind of ['stale', 'missing', 'disconnect', 'opt-out', 'blocked']) {
        const f = await fixture(t); await f.alerts.check();
        f.set(3); f.fail({ code: kind === 'blocked' ? 403 : 'unavailable' }); await f.alerts.check();
        if (kind === 'disconnect') await f.store.update(accounts => { delete accounts.alice; });
        if (kind === 'opt-out') await f.store.update(accounts => { accounts.alice.alerts.goArounds = false; delete accounts.alice.goAroundAlert; });
        f.set(5, kind === 'stale' ? { ...snapshot(5), stale: true } : kind === 'missing' ? snapshot(5, []) : undefined);
        await f.alerts.check(); assert.equal(f.sends.length, 1, kind);
        const account = (await f.store.read()).accounts.alice;
        if (account?.goAroundAlert) assert.equal(account.goAroundAlert.flights[0].pending, null, kind);
        if (kind === 'blocked') assert.equal(account.blocked, true);
    }
});

test('cache-only source returns actual arrival measurements and ignores general traffic/history', async () => {
    const point = sample(0);
    let now = start;
    const service = createAircraftService({ clock: () => now, fetch: () => assert.fail('No upstream requests'),
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: start, arrivals: {
            aircraft: [{ ...point, icao24: 'ABC', lastPositionUpdate: start / 1000, geoAltitude: 1000 }],
            generalTraffic: [{ ...point, icao24: 'OTHER' }], recentTracks: [{ ...point, icao24: 'OLD' }] } }) } });
    assert.deepEqual(await service.getGoAroundArrivals(), snapshot(0));
    now += 120_000; assert.equal((await service.getGoAroundArrivals()).stale, true);
});

test('scheduler reacts to refreshes, uses a thirty-second fallback and cancels subscriptions/checks on shutdown', async t => {
    const f = await fixture(t);
    let notify; let removed = false; let scheduled;
    let timerReady = new Promise(resolve => { scheduled = resolve; });
    const worker = createGoAroundAlerts({ ...f.options, subscribe(fn) { notify = fn; return () => { removed = true; }; },
        schedule(fn, delay) { scheduled(delay); }, cancel() {} });
    t.after(() => worker.stop());
    worker.start(); worker.start();
    assert.equal(await timerReady, 30_000);
    timerReady = new Promise(resolve => { scheduled = resolve; });
    f.set(3); notify();
    assert.equal(await timerReady, 30_000);
    assert.equal(f.sends.length, 1);
    await worker.stop(); assert.equal(removed, true);
    const reads = f.reads(); notify(); assert.equal(f.reads(), reads);
});

test('shutdown cancels an in-flight check and ignores queued refresh callbacks', async t => {
    const f = await fixture(t);
    let notify; let finish; let began;
    const started = new Promise(resolve => { began = resolve; });
    let reads = 0;
    const worker = createGoAroundAlerts({ ...f.options, subscribe(fn) { notify = fn; return () => {}; },
        arrivals: () => { reads++; began(); return new Promise(resolve => { finish = resolve; }); },
        schedule() { assert.fail('No timers after shutdown'); }, cancel() {} });
    worker.start(); await started;
    notify(); notify();
    const stopped = worker.stop(); finish(snapshot(3, [sample(3, 820, -1, { verticalRate: 4 })]));
    await stopped;
    assert.equal(reads, 1); assert.equal(f.sends.length, 0);
});

test('no subscribers means no cache reads and malformed saved detector state is rejected', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.alerts.goArounds = false; });
    await f.alerts.check(); assert.equal(f.reads(), 0);
    for (const state of [null, { lastCheckedAt: start, flights: [null] },
        { ...armed(), flights: [{ ...armed().flights[0], previous: null }] },
        { ...armed(), flights: [{ ...armed().flights[0], runway: null }] },
        { ...event(), flights: [{ ...event().flights[0], pending: { ...event().flights[0].pending, attempts: 4 } }] }]) {
        assert.equal(validGoAroundAlert(state), false);
    }
    await f.store.update(accounts => { accounts.alice.goAroundAlert = { lastCheckedAt: start, flights: [null] }; });
    await assert.rejects(f.store.read(), /Invalid Telegram go-around alert/);
});

test('the gain threshold is inclusive and duplicate-timestamp measurements cannot replace the previous sample', () => {
    let state = advance(armed(), 2, sample(2, 720, 1, { verticalRate: 3 }));
    state = advanceGoAroundAlert(state, snapshot(2, [sample(2, 500, 1, { verticalRate: 3 })]), start + 60_000);
    assert.equal(state.flights[0].previous.altitude, 720);
    state = advance(state, 3, sample(3, 800, -1, { verticalRate: 3 }));
    assert.ok(state.flights[0].pending); // Exactly 150 m above the low observation.
});

test('successful shared aircraft refreshes notify subscribers; reads and failures do not, and unsubscribe detaches', async () => {
    let now = start; let failed = false; let requests = 0; let notifications = 0;
    const service = createAircraftService({ clock: () => now,
        credentials: () => ({ clientId: 'test-client', clientSecret: 'test-secret' }),
        fetch: async url => {
            if (String(url).includes('/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
            requests++;
            return { ok: !failed, status: failed ? 503 : 200, json: async () => ({ time: now / 1000, states: [] }) };
        }, cacheStore: { read: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); }, write: async () => {} },
        historyStore: { recordSnapshot: async () => {} } });
    const remove = service.subscribeAircraftSnapshots(() => { notifications++; });
    service.subscribeAircraftSnapshots(() => { throw new Error('Notification failure'); });
    assert.deepEqual(await service.getGoAroundArrivals(), { arrivals: [], observedAt: 0, stale: true });
    await Promise.all([service.refreshAircraftDataOnce(), service.refreshAircraftDataOnce()]);
    assert.equal(requests, 1); assert.equal(notifications, 1);
    await service.getGoAroundArrivals(); assert.equal(notifications, 1);
    now += 30_000; failed = true;
    assert.equal(await service.refreshAircraftDataOnce(), false); assert.equal(notifications, 1);
    remove(); now += 30_000; failed = false;
    assert.equal(await service.refreshAircraftDataOnce(), true); assert.equal(notifications, 1);
});

test('an update received during evaluation is processed next instead of being dropped', async t => {
    const f = await fixture(t);
    let notify; let finish; let began; let scheduled;
    const started = new Promise(resolve => { began = resolve; });
    const done = new Promise(resolve => { scheduled = resolve; });
    let reads = 0;
    const worker = createGoAroundAlerts({ ...f.options, subscribe(fn) { notify = fn; return () => {}; },
        arrivals: () => { reads++; if (reads > 1) return f.options.arrivals(); began(); return new Promise(resolve => { finish = resolve; }); },
        schedule() { scheduled(); }, cancel() {} });
    t.after(() => worker.stop());
    worker.start(); await started;
    f.set(3); notify(); notify();
    finish(snapshot(2, [sample(2, 720, 1, { verticalRate: 3 })]));
    await done;
    assert.equal(reads, 2); assert.equal(f.sends.length, 1);
});
