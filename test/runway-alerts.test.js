const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { advanceRunwayAlert, createRunwayAlerts } = require('../lib/runway-alerts');
const { createTelegramStore } = require('../lib/telegram-store');
const { TelegramError } = require('../lib/telegram-client');
const { renderNotification } = require('../lib/notification-providers');

const start = Date.parse('2026-10-20T08:00:00Z');
const MINUTE = 60_000;
function report(direction, minute = 0, extra = {}) {
    return { stale: false, updatedAt: start + minute * MINUTE,
        current: { time: new Date(start + minute * MINUTE).toISOString().slice(0, 16),
            windSpeed: 12, windDirection: direction === '04' ? 40 : 220, windGusts: 18,
            runway: { direction } }, ...extra };
}
function advance(state, direction, minute, reset = false) {
    return advanceRunwayAlert(state, report(direction, minute), start + minute * MINUTE, reset);
}

test('first report establishes a baseline and only two distinct changed observations trigger an alert', () => {
    let result = advance(null, '22', 0);
    assert.equal(result.event, null);
    result = advance(result.state, '04', 30);
    assert.equal(result.event, null);
    const repeated = advanceRunwayAlert(result.state, report('04', 30), start + 35 * MINUTE);
    assert.equal(repeated.event, null);
    result = advance(repeated.state, '04', 60);
    assert.equal(result.event.from, '22');
    assert.equal(result.event.to, '04');
    assert.equal(advance(result.state, '04', 90).event, null);
    const message = renderNotification('predictedRunwayChange', result.event);
    assert.match(message, /22 → 04/);
    assert.match(message, /weather-based prediction/);
    assert.match(message, /Actual runway use may differ/);
    assert.match(message, /Europe\/Zurich/);
});

test('unknown, stale and failed reports reset confirmation without inventing a runway transition', () => {
    const initial = advance(advance(null, '22', 0).state, '04', 30).state;
    for (const forecast of [report('unknown', 40), report('04', 40, { stale: true }), null,
        report('04', 0), report('04', 40, { updatedAt: start + 50 * MINUTE })]) {
        const unavailable = advanceRunwayAlert(initial, forecast, start + 40 * MINUTE);
        assert.equal(unavailable.event, null);
        assert.equal(unavailable.state.candidate, null);
        assert.equal(advance(unavailable.state, '04', 60).event, null);
    }
});

test('reversals clear candidates, old observations are ignored, gaps and restart reset the baseline', () => {
    const baseline = advance(null, '22', 0).state;
    const candidate = advance(baseline, '04', 30).state;
    const reversal = advance(candidate, '22', 60);
    assert.equal(reversal.state.candidate, null);
    assert.equal(advance(reversal.state, '04', 90).event, null);
    assert.equal(advance(candidate, '04', 20).event, null);
    assert.equal(advance(candidate, '04', 120).event, null);
    assert.equal(advance(candidate, '04', 60, true).event, null);
});

test('one-hour cooldown suppresses a rapid reversal until new observations confirm it after cooldown', () => {
    let state = advance(null, '22', 0).state;
    state = advance(state, '04', 30).state;
    state = advance(state, '04', 60).state;
    state = advance(state, '22', 75).state;
    assert.equal(advance(state, '22', 90).event, null);
    state = advance(state, '22', 90).state;
    assert.equal(advance(state, '22', 120).event.to, '22');
});

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-runway-alerts-'));
    const filePath = path.join(directory, 'telegram.json');
    const store = createTelegramStore({ filePath });
    const account = (id, optedIn = true) => ({ chatId: id, userId: id, name: 'Spotter', username: null,
        connectedAt: start, alerts: { predictedRunwayChanges: optedIn } });
    await store.update(accounts => { accounts.alice = account('123'); accounts.bob = account('456', false); });
    let now = start;
    let forecast = report('22');
    let weatherCalls = 0;
    let failure;
    const sends = [];
    let queued = Promise.resolve();
    const serialize = fn => {
        const next = queued.then(fn);
        queued = next.catch(() => {});
        return next;
    };
    const weather = { async getForecast() { weatherCalls++; return forecast; } };
    const client = { async sendMessage(chatId, text) { sends.push({ chatId, text }); if (failure) throw failure; } };
    const options = { store, client, weather, serialize, clock: () => now, logger: {} };
    const alerts = createRunwayAlerts(options);
    t.after(async () => { await alerts.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    function set(direction, minute, extra) { now = start + minute * MINUTE; forecast = report(direction, minute, extra); }
    return { alerts, options, store, sends, filePath, weather, client, weatherCalls: () => weatherCalls,
        set, advance(ms) { now += ms; }, forecast(value) { forecast = value; }, fail(error) { failure = error; },
        async transition() {
            await alerts.check();
            set('04', 30); await alerts.check();
            set('04', 60); await alerts.check();
        } };
}

test('background checks notify only opted-in accounts and consume a confirmed event once', async t => {
    const f = await fixture(t);
    await f.transition();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].chatId, '123');
    assert.match(f.sends[0].text, /22 → 04/);
    await f.alerts.check();
    f.set('04', 90); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    const accounts = (await f.store.read()).accounts;
    assert.equal(accounts.alice.runwayAlert.pending, null);
    assert.equal(accounts.bob.runwayAlert, undefined);
});

test('no subscribers means no weather request, while disabling or disconnecting drops pending work', async t => {
    const f = await fixture(t);
    await f.store.update(accounts => { accounts.alice.alerts.predictedRunwayChanges = false; });
    await f.alerts.check();
    assert.equal(f.weatherCalls(), 0);
    await f.store.update(accounts => { accounts.alice.alerts.predictedRunwayChanges = true; });
    f.fail(new TelegramError('unavailable'));
    await f.transition();
    assert.equal(f.sends.length, 1);
    await f.store.update(accounts => { accounts.alice.alerts.predictedRunwayChanges = false; delete accounts.alice.runwayAlert; });
    f.advance(5 * MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    await f.store.update(accounts => { delete accounts.alice; });
    await f.alerts.check();
    assert.equal(f.weatherCalls(), 3);
});

test('retries are persisted, bounded, rate-limit aware, and cancelled by a stale or reversed prediction', async t => {
    const f = await fixture(t);
    f.fail(new TelegramError(429, 120));
    await f.transition();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending.attempts, 1);
    f.advance(MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    f.fail(new TelegramError('unavailable'));
    f.advance(MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 2);
    f.advance(2 * MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 3);
    f.advance(4 * MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 3);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
});

test('failed alerts expire and blocked accounts stop delivery', async t => {
    const f = await fixture(t);
    f.fail(new TelegramError('unavailable'));
    await f.transition();
    f.advance(16 * MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
    f.set('22', 90); await f.alerts.check();
    f.fail(new TelegramError(403));
    f.set('22', 120); await f.alerts.check();
    assert.equal(f.sends.length, 2);
    assert.equal((await f.store.read()).accounts.alice.blocked, true);
    f.advance(MINUTE); await f.alerts.check();
    assert.equal(f.sends.length, 2);
});

test('restart establishes a new baseline and discards old queued notifications', async t => {
    const f = await fixture(t);
    f.fail(new TelegramError('unavailable'));
    await f.transition();
    assert.ok((await f.store.read()).accounts.alice.runwayAlert.pending);
    const restarted = createRunwayAlerts({ ...f.options, store: createTelegramStore({ filePath: f.filePath }) });
    f.fail(null);
    f.advance(MINUTE); await restarted.check();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
    f.set('22', 90); await restarted.check();
    f.set('22', 120); await restarted.check();
    assert.equal(f.sends.length, 2);
});

test('scheduler runs without overlap, shares cached weather and stops scheduling on shutdown', async t => {
    const f = await fixture(t);
    const timers = [];
    let finish;
    let calls = 0;
    let started;
    const weatherStarted = new Promise(resolve => { started = resolve; });
    const alerts = createRunwayAlerts({ ...f.options,
        weather: { getForecast() { calls++; started(); return new Promise(resolve => { finish = resolve; }); } },
        schedule(fn, ms) { timers.push({ fn, ms }); return 1; }, cancel() {} });
    alerts.start(); alerts.start();
    await weatherStarted;
    assert.equal(calls, 1);
    const stopping = alerts.stop();
    finish(report('22'));
    await stopping;
    assert.equal(timers.length, 0);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert, undefined);
});

test('stale, unknown and reversed predictions discard pending delivery instead of replaying it', async t => {
    for (const variant of ['stale', 'unknown', 'reverse']) {
        const f = await fixture(t);
        f.fail(new TelegramError('unavailable'));
        await f.transition();
        assert.ok((await f.store.read()).accounts.alice.runwayAlert.pending);
        f.set(variant === 'reverse' ? '22' : variant === 'unknown' ? 'unknown' : '04', 61,
            variant === 'stale' ? { stale: true } : {});
        f.fail(null);
        await f.alerts.check();
        assert.equal(f.sends.length, 1);
        assert.equal((await f.store.read()).accounts.alice.runwayAlert.pending, null);
    }
});
