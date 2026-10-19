const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { advanceBusyAlert, createBusyArrivalAlerts } = require('../lib/busy-arrival-alerts');
const { createTelegramStore } = require('../lib/telegram-store');
const { TelegramError } = require('../lib/telegram-client');
const { createAircraftService } = require('../lib/aircraft-service');

const start = 1_000_000;
const minute = 60_000;
const snapshot = (count, now = start, stale = false) => ({ count, observedAt: now, stale });

test('busy threshold is strictly greater; one event per busy period, reset requires five fresh quiet minutes', () => {
    let state = advanceBusyAlert(null, snapshot(10), 10, start);
    assert.equal(state.pending, null);
    state = advanceBusyAlert(state, snapshot(11), 10, start);
    assert.equal(state.pending.count, 11);
    state.pending = null; // Delivered.
    state = advanceBusyAlert(state, snapshot(15, start + minute), 10, start + minute);
    assert.equal(state.pending, null);
    for (let n = 2; n <= 6; n++) {
        state = advanceBusyAlert(state, snapshot(10, start + n * minute), 10, start + n * minute);
        assert.equal(state.active, true);
    }
    state = advanceBusyAlert(state, snapshot(11, start + 7 * minute), 10, start + 7 * minute);
    assert.equal(state.pending, null); // A rebound before five minutes resets the quiet interval.
    for (let n = 8; n <= 13; n++) state = advanceBusyAlert(state, snapshot(9, start + n * minute), 10, start + n * minute);
    assert.equal(state.active, false);
    state = advanceBusyAlert(state, snapshot(11, start + 14 * minute), 10, start + 14 * minute);
    assert.equal(state.pending.count, 11);
});

test('stale, future and malformed snapshots cannot notify or re-arm a busy period', () => {
    const previous = advanceBusyAlert(null, snapshot(11), 10, start);
    for (const data of [snapshot(11, start, true), snapshot(11), snapshot(11, start + 9 * minute),
        { stale: false, count: -1, observedAt: start + 8 * minute }]) {
        const state = advanceBusyAlert(previous, data, 10, start + 8 * minute);
        assert.equal(state.pending, null);
        assert.equal(state.active, true);
        assert.equal(state.belowSince, null);
    }
});

test('busy source counts unique fresh live arrivals only and never fetches upstream', async () => {
    let now = start;
    const aircraft = [
        { icao24: 'ABC123', lastPositionUpdate: now / 1000 },
        { icao24: 'abc123', lastPositionUpdate: now / 1000 },
        { icao24: 'def456', lastPositionUpdate: now / 1000 - 119 },
        { icao24: 'old', lastPositionUpdate: now / 1000 - 120 },
        { icao24: 'ground', lastPositionUpdate: now / 1000, onGround: true },
        { icao24: 'missing' }, { icao24: 'future', lastPositionUpdate: now / 1000 + 1 }
    ];
    const service = createAircraftService({ clock: () => now,
        fetch: () => assert.fail('No upstream requests'),
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: start,
            arrivals: { aircraft, generalTraffic: [{ icao24: 'other' }], recentTracks: [{ icao24: 'landed' }] } }) } });
    assert.deepEqual(await service.getBusyArrivals(), snapshot(2));
    now += 120_000;
    assert.equal((await service.getBusyArrivals()).stale, true);
});

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-busy-alerts-'));
    const filePath = path.join(directory, 'telegram.json');
    const store = createTelegramStore({ filePath });
    await store.update(accounts => {
        accounts.alice = { chatId: '123', userId: '123', name: 'Alice', username: null,
            connectedAt: start, alerts: { busyArrivals: true, busyArrivalThreshold: 10 } };
        accounts.bob = { ...accounts.alice, chatId: '456', userId: '456', alerts: { busyArrivals: false } };
    });
    let now = start;
    let data = snapshot(11);
    let failure;
    let reads = 0;
    const sends = [];
    let queue = Promise.resolve();
    const options = { store, client: { async sendMessage(id, text) { sends.push({ id, text }); if (failure) throw failure; } },
        arrivals: async () => { reads++; return data; },
        serialize(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; },
        clock: () => now, logger: {} };
    const alerts = createBusyArrivalAlerts(options);
    t.after(async () => { await alerts.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { alerts, store, sends, options, filePath, reads: () => reads,
        set(count, n, stale = false) { now = start + n * minute; data = snapshot(count, now, stale); },
        fail(error) { failure = error; } };
}

test('opt-in delivery persists deduplication across restart and isolates other accounts', async t => {
    const f = await fixture(t);
    await f.alerts.check();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].id, '123');
    assert.match(f.sends[0].text, /11 aircraft.*more than 10/);
    assert.equal((await f.store.read()).accounts.bob.busyAlert, undefined);
    const restarted = createBusyArrivalAlerts({ ...f.options, store: createTelegramStore({ filePath: f.filePath }) });
    f.set(14, 1); await restarted.check();
    assert.equal(f.sends.length, 1);
    for (let n = 2; n <= 7; n++) { f.set(10, n); await restarted.check(); }
    f.set(12, 8); await restarted.check();
    assert.equal(f.sends.length, 2);
});

test('delivery honors shared send cooldown, Telegram retry delays and the three-attempt cap', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.nextSendAt = start + minute; });
    await f.alerts.check(); assert.equal(f.sends.length, 0);
    f.set(12, 1); f.fail(new TelegramError(429, 120)); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    f.set(13, 2); await f.alerts.check(); assert.equal(f.sends.length, 1);
    f.set(14, 3); f.fail(new TelegramError('unavailable')); await f.alerts.check();
    assert.equal(f.sends.length, 2);
    f.set(15, 4); await f.alerts.check(); assert.equal(f.sends.length, 2);
    // A fresh event has a five-minute lifetime; test the third attempt before expiry.
    const g = await fixture(t);
    g.fail(new TelegramError('unavailable')); await g.alerts.check();
    g.set(12, 1); await g.alerts.check();
    g.set(13, 3); await g.alerts.check(); assert.equal(g.sends.length, 3);
    g.set(14, 4); await g.alerts.check();
    assert.equal((await g.store.read()).accounts.alice.busyAlert.pending, null);
    assert.equal(g.sends.length, 3);
});

test('pending delivery cancels on stale data, quiet traffic, expiry, opt-out, disconnect and blocked bot', async t => {
    for (const kind of ['stale', 'quiet', 'expired', 'opt-out', 'disconnect', 'blocked']) {
        const f = await fixture(t);
        f.fail(new TelegramError(kind === 'blocked' ? 403 : 'unavailable'));
        await f.alerts.check();
        if (kind === 'opt-out') await f.store.update(accounts => { accounts.alice.alerts.busyArrivals = false; delete accounts.alice.busyAlert; });
        if (kind === 'disconnect') await f.store.update(accounts => { delete accounts.alice; });
        f.set(kind === 'quiet' ? 10 : 11, kind === 'expired' ? 6 : 1, kind === 'stale');
        await f.alerts.check();
        assert.equal(f.sends.length, 1, kind);
        const account = (await f.store.read()).accounts.alice;
        if (account?.busyAlert) assert.equal(account.busyAlert.pending, null, kind);
        if (kind === 'blocked') assert.equal(account.blocked, true);
    }
});

test('no subscribers means no cache reads; scheduler shutdown cancels an in-flight check', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.alerts.busyArrivals = false; });
    await f.alerts.check(); assert.equal(f.reads(), 0);
    await f.store.update(accounts => { accounts.alice.alerts.busyArrivals = true; });
    let finish; let started;
    const begun = new Promise(resolve => { started = resolve; });
    const timers = [];
    const alerts = createBusyArrivalAlerts({ ...f.options,
        arrivals: () => { started(); return new Promise(resolve => { finish = resolve; }); },
        schedule(fn) { timers.push(fn); }, cancel() {} });
    alerts.start(); alerts.start(); await begun;
    const stopped = alerts.stop(); finish(snapshot(11)); await stopped;
    assert.equal(f.sends.length, 0); assert.equal(timers.length, 0);
});

test('a long monitoring gap restarts the quiet interval instead of re-arming after downtime', () => {
    let state = advanceBusyAlert(null, snapshot(11), 10, start);
    state = advanceBusyAlert(state, snapshot(5, start + minute), 10, start + minute);
    state = advanceBusyAlert(state, snapshot(5, start + 10 * minute), 10, start + 10 * minute);
    assert.equal(state.active, true);
    assert.equal(state.belowSince, start + 10 * minute);
    state = advanceBusyAlert(state, snapshot(11, start + 11 * minute), 10, start + 11 * minute);
    assert.equal(state.pending, null);
});
