const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { advanceRunwayAlert, createRunwayAlerts, validRunwayAlert } = require('../lib/runway-alerts');
const { createTelegramStore } = require('../lib/telegram-store');
const { TelegramError } = require('../lib/telegram-client');
const { renderNotification } = require('../lib/notification-providers');

const start = Date.parse('2026-10-20T08:00:00Z');
const MINUTE = 60_000;
function flight(n, direction, minute = n) {
    const icao24 = n.toString(16).padStart(6, '0');
    return { id: `${icao24}:TEST${n}`, icao24, callsign: `TEST${n}`, direction, estimatedLandingAt: start + minute * MINUTE };
}
const snapshot = (arrivals, stale = false) => ({ arrivals, stale });
const advance = (state, flights, minute, reset = false) => advanceRunwayAlert(state, snapshot(flights), start + minute * MINUTE, reset);
const baselineFlights = [flight(1, '22', 0), flight(2, '22', 1)];
function baseline() { return advance(null, baselineFlights, 1, true).state; }

test('two consecutive distinct arrivals confirm a change; duplicate reads and a single opposite arrival do not', () => {
    let state = baseline();
    assert.equal(state.baseline, '22');
    const third = flight(3, '04', 2);
    let result = advance(state, [...baselineFlights, third], 2);
    assert.equal(result.event, null);
    result = advance(result.state, [...baselineFlights, third], 3);
    assert.equal(result.event, null);
    result = advance(result.state, [...baselineFlights, third, flight(4, '04', 4)], 4);
    assert.equal(result.event.from, '22');
    assert.equal(result.event.to, '04');
    assert.deepEqual(result.event.confirmedBy.map(item => item.callsign), ['TEST3', 'TEST4']);
    assert.equal(advance(result.state, [third, flight(4, '04', 4)], 5).event, null);
    const message = renderNotification('arrivalRunwayChange', result.event);
    assert.match(message, /22 → 04/);
    assert.match(message, /Two consecutive tracked arrivals/);
    assert.match(message, /TEST3.*TEST4/);
    assert.match(message, /Europe\/Zurich/);
    assert.match(message, /does not confirm touchdown/);
    assert.doesNotMatch(message, /wind|weather/i);
});

test('the user sequence 22,04,22,04,04 only alerts at the final arrival', () => {
    let state = baseline();
    for (const [n, direction] of [[3, '22'], [4, '04'], [5, '22'], [6, '04']]) {
        const result = advance(state, [flight(n, direction)], n);
        assert.equal(result.event, null);
        state = result.state;
    }
    assert.equal(advance(state, [flight(7, '04')], 7).event.to, '04');
});

test('unknown arrivals break the pair and the same aircraft cannot count twice after reappearing', () => {
    let state = advance(baseline(), [flight(3, '04')], 3).state;
    const repeated = { ...flight(3, '04'), estimatedLandingAt: start + 4 * MINUTE };
    assert.equal(advance(state, [repeated], 4).event, null);
    const renamed = { ...flight(4, '04'), icao24: flight(3, '04').icao24 };
    let result = advance(state, [renamed], 4);
    assert.equal(result.event, null);
    state = advance(result.state, [flight(5, 'unknown')], 5).state;
    result = advance(state, [flight(6, '04')], 6);
    assert.equal(result.event, null);
    assert.equal(advance(result.state, [flight(7, '04')], 7).event.to, '04');
});

test('both arrivals in one snapshot count, including equal timestamps, without an hour-long cooldown', () => {
    let result = advance(baseline(), [flight(4, '04', 4), flight(3, '04', 4)], 4);
    assert.equal(result.event.to, '04');
    result = advance(result.state, [flight(5, '22', 5), flight(6, '22', 6)], 6);
    assert.equal(result.event.to, '22');
});

test('stale tracking resets the pair and startup history establishes a baseline without alerting', () => {
    const candidate = advance(baseline(), [flight(3, '04')], 3).state;
    const stale = advanceRunwayAlert(candidate, snapshot([flight(4, '04')], true), start + 4 * MINUTE);
    assert.equal(stale.direction, null);
    assert.equal(stale.state.candidate, null);
    assert.equal(advance(stale.state, [flight(4, '04')], 4).event, null);
    const history = [...baselineFlights, flight(3, '04'), flight(4, '04')];
    const startup = advance(null, history, 5, true);
    assert.equal(startup.event, null);
    assert.equal(startup.state.baseline, '04');
    assert.equal(advance(startup.state, history, 6).event, null);
});

test('old weather state remains readable but is reset when changing to arrival confirmation', () => {
    const old = { state: { baseline: '04', observation: '2026-10-20T08:00', reportAt: start,
        candidate: '22', lastAlertAt: null }, pending: null };
    assert.equal(validRunwayAlert(old), true);
    const result = advance(old.state, baselineFlights, 2);
    assert.equal(result.event, null);
    assert.equal(result.state.source, 'arrivals');
    assert.equal(result.state.baseline, '22');
    assert.equal(validRunwayAlert({ state: result.state, pending: null }), true);
});

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-arrival-alerts-'));
    const filePath = path.join(directory, 'telegram.json');
    const store = createTelegramStore({ filePath });
    const account = (id, optedIn = true) => ({ chatId: id, userId: id, name: 'Spotter', username: null,
        connectedAt: start, alerts: { predictedRunwayChanges: optedIn } });
    await store.update(accounts => { accounts.alice = account('123'); accounts.bob = account('456', false); });
    let now = start + MINUTE;
    let data = snapshot(baselineFlights);
    let reads = 0;
    let failure;
    const sends = [];
    let queued = Promise.resolve();
    const serialize = action => { const result = queued.then(action); queued = result.catch(() => {}); return result; };
    const arrivals = async () => { reads++; return data; };
    const client = { async sendMessage(chatId, text) { sends.push({ chatId, text }); if (failure) throw failure; } };
    const options = { store, client, arrivals, serialize, clock: () => now, logger: {} };
    const alerts = createRunwayAlerts(options);
    t.after(async () => { await alerts.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    function set(flights, minute, stale = false) { now = start + minute * MINUTE; data = snapshot(flights, stale); }
    return { alerts, options, store, sends, filePath, reads: () => reads, set,
        advance(ms) { now += ms; }, fail(error) { failure = error; },
        async transition() {
            await alerts.check(); set([flight(3, '04')], 3); await alerts.check();
            set([flight(3, '04'), flight(4, '04')], 4); await alerts.check();
        } };
}

test('background checks notify opted-in users once and preserve account isolation', async t => {
    const f = await fixture(t);
    await f.transition();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].chatId, '123');
    await f.alerts.check(); f.advance(MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.store.read()).accounts.bob.runwayAlert, undefined);
});

test('no subscribers means no source reads; disabling and disconnecting cancel delivery', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.alerts.predictedRunwayChanges = false; });
    await f.alerts.check(); assert.equal(f.reads(), 0);
    await f.store.update(accounts => { accounts.alice.alerts.predictedRunwayChanges = true; });
    f.fail(new TelegramError('unavailable')); await f.transition();
    await f.store.update(accounts => { accounts.alice.alerts.predictedRunwayChanges = false; delete accounts.alice.runwayAlert; });
    f.advance(5 * MINUTE); await f.alerts.check();
    await f.store.update(accounts => { delete accounts.alice; }); await f.alerts.check();
    assert.equal(f.sends.length, 1);
});

test('pending retries honor rate limits, persist attempts, and stop after three tries', async t => {
    const f = await fixture(t);
    f.fail(new TelegramError(429, 120)); await f.transition();
    f.advance(MINUTE); await f.alerts.check(); assert.equal(f.sends.length, 1);
    f.fail(new TelegramError('unavailable'));
    f.advance(MINUTE); await f.alerts.check(); assert.equal(f.sends.length, 2);
    f.advance(2 * MINUTE); await f.alerts.check(); assert.equal(f.sends.length, 3);
    f.advance(4 * MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 3);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
});

test('expired, stale and blocked deliveries are discarded', async t => {
    for (const kind of ['expired', 'stale', 'blocked']) {
        const f = await fixture(t);
        f.fail(new TelegramError(kind === 'blocked' ? 403 : 'unavailable')); await f.transition();
        if (kind === 'expired') f.advance(16 * MINUTE);
        if (kind === 'stale') f.set([flight(3, '04'), flight(4, '04')], 5, true);
        await f.alerts.check();
        assert.equal(f.sends.length, 1);
        assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
    }
});

test('restart consumes cached history silently and discards old pending alerts', async t => {
    const f = await fixture(t);
    f.fail(new TelegramError('unavailable')); await f.transition();
    const restarted = createRunwayAlerts({ ...f.options, store: createTelegramStore({ filePath: f.filePath }) });
    f.fail(null); f.advance(MINUTE); await restarted.check();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
    f.set([flight(5, '22'), flight(6, '22')], 6); await restarted.check();
    assert.equal(f.sends.length, 2);
});

test('a single opposite arrival does not cancel a confirmed queued alert; a confirmed reversal replaces it', async t => {
    const f = await fixture(t);
    f.fail(new TelegramError('unavailable')); await f.transition();
    f.fail(null); f.set([flight(5, '22')], 5); await f.alerts.check();
    assert.equal(f.sends.length, 2);
    assert.match(f.sends.at(-1).text, /22 → 04/);
    f.set([flight(6, '22')], 6); await f.alerts.check();
    assert.match(f.sends.at(-1).text, /04 → 22/);
});

test('scheduler stops without overlap and reads the cached source once for multiple subscribers', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.bob.alerts.predictedRunwayChanges = true; });
    await f.alerts.check(); assert.equal(f.reads(), 1);
    const timers = [];
    let finish; let started;
    const sourceStarted = new Promise(resolve => { started = resolve; });
    let calls = 0;
    const alerts = createRunwayAlerts({ ...f.options,
        arrivals: () => { calls++; started(); return new Promise(resolve => { finish = resolve; }); },
        schedule(fn) { timers.push(fn); }, cancel() {} });
    alerts.start(); alerts.start(); await sourceStarted;
    const stopping = alerts.stop(); finish(snapshot(baselineFlights)); await stopping;
    assert.equal(calls, 1); assert.equal(timers.length, 0);
});

test('runway worker supplies its exact message and recipient to the shared delivery observer', async t => {
    const f = await fixture(t);
    const deliveries = [];
    const alerts = createRunwayAlerts({ ...f.options, sendNotification: async delivery => { deliveries.push(delivery); } });
    await alerts.check();
    f.set([flight(3, '04'), flight(4, '04')], 4);
    await alerts.check();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].accountId, 'alice');
    assert.equal(deliveries[0].connection.chatId, '123');
    assert.equal(deliveries[0].type, 'arrivalRunwayChange');
    assert.match(deliveries[0].text, /22 → 04/);
});
