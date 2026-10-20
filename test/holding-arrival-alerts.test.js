const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { advanceHoldingAlert, createHoldingArrivalAlerts, validHoldingAlert } = require('../lib/holding-arrival-alerts');
const { createTelegramStore } = require('../lib/telegram-store');
const { createAircraftService } = require('../lib/aircraft-service');

const start = 1_000_000;
const minute = 60_000;
const flight = (n, id = 'abc:TEST123') => ({ id, callsign: id.split(':')[1], observedAt: start + n * minute });
const snapshot = (n, arrivals = [flight(n)]) => ({ arrivals, observedAt: start + n * minute, stale: false });
function dwell() {
    let state;
    for (let n = 0; n <= 15; n++) state = advanceHoldingAlert(state, snapshot(n), start + n * minute);
    return state;
}

test('requires more than fifteen minutes of fresh observations; repeats cannot advance the timer', () => {
    let state = dwell();
    assert.equal(state.flights[0].pending, null);
    state = advanceHoldingAlert(state, snapshot(15), start + 16 * minute);
    assert.equal(state.flights[0].pending, null);
    state = advanceHoldingAlert(state, snapshot(16), start + 16 * minute);
    assert.equal(state.flights[0].pending.createdAt, start + 16 * minute);
    assert.equal(validHoldingAlert(state), true);
});

test('tracking gaps, missing aircraft, stale and invalid snapshots reset unfinished dwell', () => {
    for (const data of [snapshot(16, []), { ...snapshot(16), stale: true }, snapshot(14), snapshot(17),
        { ...snapshot(16), arrivals: [{ ...flight(16), observedAt: start + 17 * minute }] }]) {
        let state = advanceHoldingAlert(dwell(), data, start + 16 * minute);
        state = advanceHoldingAlert(state, snapshot(17), start + 17 * minute);
        assert.equal(state.flights[0].firstSeenAt, start + 17 * minute);
        assert.equal(state.flights[0].pending, null);
    }
    const state = advanceHoldingAlert(dwell(), snapshot(18), start + 18 * minute);
    assert.equal(state.flights[0].firstSeenAt, start + 18 * minute);
    assert.equal(state.flights[0].pending, null);
});

test('flight identity separates callsigns and aircraft; delivered identity survives disappearance', () => {
    let state = advanceHoldingAlert(dwell(), snapshot(16), start + 16 * minute);
    state.flights[0].pending = null;
    state = advanceHoldingAlert(state, snapshot(17, []), start + 17 * minute);
    state = advanceHoldingAlert(state, snapshot(18, [flight(18), flight(18, 'abc:NEW123'), flight(18, 'def:TEST123')]), start + 18 * minute);
    assert.equal(state.flights.length, 3);
    assert.equal(state.flights.find(f => f.id === 'abc:TEST123').alerted, true);
    assert.equal(state.flights.filter(f => f.pending).length, 0);
    state = advanceHoldingAlert(state, snapshot(139, []), start + 139 * minute);
    assert.equal(state.flights.length, 0);
});

test('holding source uses fresh live arrivals only without upstream requests or retained tracks', async () => {
    let now = start;
    const service = createAircraftService({ clock: () => now, fetch: () => assert.fail('No upstream requests'),
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: start, arrivals: {
            aircraft: [{ icao24: 'ABC', callsign: ' test123 ', lastPositionUpdate: start / 1000 },
                { icao24: 'abc', callsign: 'TEST123', lastPositionUpdate: start / 1000 },
                { icao24: 'ground', onGround: true, lastPositionUpdate: start / 1000 },
                { icao24: 'old', lastPositionUpdate: start / 1000 - 120 },
                { icao24: 'future', lastPositionUpdate: start / 1000 + 1 }, { icao24: 'missing' }],
            generalTraffic: [{ icao24: 'other' }], recentTracks: [{ icao24: 'landed' }] } }) } });
    assert.deepEqual(await service.getHoldingArrivals(), snapshot(0));
    now += 120_000;
    assert.equal((await service.getHoldingArrivals()).stale, true);
});

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-holding-alerts-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const store = createTelegramStore({ filePath: path.join(directory, 'telegram.json') });
    await store.update(accounts => {
        accounts.alice = { chatId: '123', userId: '123', name: 'Alice', username: null, connectedAt: start,
            alerts: { holdingArrivals: true }, holdingAlert: dwell() };
        accounts.bob = { ...accounts.alice, chatId: '456', userId: '456', alerts: { holdingArrivals: false } };
        delete accounts.bob.holdingAlert;
    });
    let n = 16; let data = snapshot(n); let failure; let reads = 0;
    const sends = [];
    let queue = Promise.resolve();
    const options = { store, clock: () => start + n * minute, logger: {},
        arrivals: async () => { reads++; return data; },
        serialize(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; },
        sendNotification: async delivery => { sends.push(delivery); if (failure) throw failure; } };
    return { store, options, alerts: createHoldingArrivalAlerts(options), sends, reads: () => reads,
        set(value, override) { n = value; data = override || snapshot(n); }, fail(value) { failure = value; } };
}

test('delivery includes flight and duration, persists deduplication after restart and isolates opt-outs', async t => {
    const f = await fixture(t);
    await f.alerts.check();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].accountId, 'alice');
    assert.equal(f.sends[0].type, 'holdingArrivals');
    assert.match(f.sends[0].text, /possible holding: TEST123/);
    assert.match(f.sends[0].text, /16 minutes/);
    assert.match(f.sends[0].text, /does not confirm/);
    assert.equal((await f.store.read()).accounts.bob.holdingAlert, undefined);
    f.set(17);
    await createHoldingArrivalAlerts(f.options).check();
    assert.equal(f.sends.length, 1);
});

test('shared cooldown, Telegram retry delay, expiration and attempt limit bound delivery', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.nextSendAt = start + 17 * minute; });
    await f.alerts.check(); assert.equal(f.sends.length, 0);
    f.set(17); f.fail({ code: 429, retryAfter: 120 }); await f.alerts.check();
    f.set(18); await f.alerts.check(); assert.equal(f.sends.length, 1);
    f.set(19); f.fail({ code: 'unavailable' }); await f.alerts.check(); assert.equal(f.sends.length, 2);
    f.set(20); await f.alerts.check(); assert.equal(f.sends.length, 2);
    f.set(21); await f.alerts.check(); assert.equal(f.sends.length, 2); // Expired.
    const g = await fixture(t); g.fail({ code: 'unavailable' });
    for (let n = 16; n <= 20; n++) { g.set(n); await g.alerts.check(); }
    assert.equal(g.sends.length, 3);
    assert.equal((await g.store.read()).accounts.alice.holdingAlert.flights[0].pending, null);
});

test('pending sends cancel on disappearance, stale tracking, opt-out, disconnect, and blocked bot', async t => {
    for (const kind of ['missing', 'stale', 'opt-out', 'disconnect', 'blocked']) {
        const f = await fixture(t); f.fail({ code: kind === 'blocked' ? 403 : 'unavailable' });
        await f.alerts.check();
        if (kind === 'opt-out') await f.store.update(accounts => { accounts.alice.alerts.holdingArrivals = false; delete accounts.alice.holdingAlert; });
        if (kind === 'disconnect') await f.store.update(accounts => { delete accounts.alice; });
        f.set(17, kind === 'missing' ? snapshot(17, []) : kind === 'stale' ? { ...snapshot(17), stale: true } : undefined);
        await f.alerts.check(); assert.equal(f.sends.length, 1, kind);
        const account = (await f.store.read()).accounts.alice;
        if (account?.holdingAlert) assert.equal(account.holdingAlert.flights[0].pending, null, kind);
        if (kind === 'blocked') assert.equal(account.blocked, true);
    }
});

test('no opt-ins means no reads, and shutdown cancels in-flight evaluation', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.alerts.holdingArrivals = false; });
    await f.alerts.check(); assert.equal(f.reads(), 0);
    await f.store.update(accounts => { accounts.alice.alerts.holdingArrivals = true; });
    let finish; let started;
    const begun = new Promise(resolve => { started = resolve; });
    const timers = [];
    const worker = createHoldingArrivalAlerts({ ...f.options,
        arrivals: () => { started(); return new Promise(resolve => { finish = resolve; }); },
        schedule(fn) { timers.push(fn); }, cancel() {} });
    worker.start(); worker.start(); await begun;
    const stopped = worker.stop(); finish(snapshot(16)); await stopped;
    assert.equal(f.sends.length, 0); assert.equal(timers.length, 0);
});

test('a later flight with the same identity starts over after the two-hour retention window', () => {
    let state = advanceHoldingAlert(dwell(), snapshot(16), start + 16 * minute);
    state = advanceHoldingAlert(state, snapshot(137), start + 137 * minute);
    assert.equal(state.flights[0].alerted, false);
    assert.equal(state.flights[0].firstSeenAt, start + 137 * minute);
});

test('simultaneous qualifying flights queue individually and share the send cooldown', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => {
        accounts.alice.holdingAlert.flights.push({ ...accounts.alice.holdingAlert.flights[0], id: 'def:OTHER123', callsign: 'OTHER123' });
    });
    f.set(16, snapshot(16, [flight(16), flight(16, 'def:OTHER123')]));
    await f.alerts.check(); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    f.set(17, snapshot(17, [flight(17), flight(17, 'def:OTHER123')]));
    await f.alerts.check();
    assert.equal(f.sends.length, 2);
    assert.match(f.sends[1].text, /OTHER123/);
});
