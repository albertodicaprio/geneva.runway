const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAuthAnalytics } = require('../lib/auth-analytics');

const env = { UMAMI_WEBSITE_ID: '11111111-2222-4333-8444-555555555555',
    UMAMI_AUTH_EVENTS_URL: 'http://umami:3000/api/send', APP_ORIGIN: 'https://gva-runway.ahpc.ch' };
const request = () => ({ headers: { 'user-agent': 'Mozilla/5.0 Test Browser',
    cookie: 'gva-session=private-session', authorization: 'Bearer private-token',
    'x-forwarded-for': '198.51.100.9, 203.0.113.7' }, socket: { remoteAddress: '::ffff:127.0.0.1' },
    url: '/auth/google/callback?code=private-code&state=private-state' });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
    const calls = [];
    const warnings = [];
    const analytics = createAuthAnalytics({ env, clock: () => 1800000000123,
        fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true }; },
        logger: { warn: value => warnings.push(value) }, ...overrides });
    return { ...analytics, calls, warnings };
}

test('auth events send verified identity as Umami properties without callback parameters or credentials', async () => {
    const f = fixture();
    f.track('sign_in_succeeded', request(), { name: 'Alice Example', email: 'alice@example.com',
        code: 'private-code', sessionId: 'private-session', token: 'private-token' });
    await flush();
    assert.equal(f.calls.length, 1);
    const { url, options } = f.calls[0];
    assert.equal(url, 'http://umami:3000/api/send');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 Test Browser' });
    assert.deepEqual(JSON.parse(options.body), { type: 'event', payload: {
        website: env.UMAMI_WEBSITE_ID, hostname: 'gva-runway.ahpc.ch', url: '/auth/google/callback',
        name: 'sign_in_succeeded', timestamp: 1800000000, ip: '127.0.0.1',
        data: { provider: 'google', name: 'Alice Example', email: 'alice@example.com' }
    } });
    assert.doesNotMatch(JSON.stringify(f.calls), /private-|authorization|cookie|state=/);
});

test('unverified events stay anonymous and failure categories come from a fixed allowlist', async () => {
    const f = fixture();
    f.track('sign_in_failed', request(), { name: 'Unverified Name', email: 'unverified@example.com', reason: 'invalid_identity' });
    f.track('sign_in_failed', request(), { reason: 'upstream-error-with-private-token' });
    f.track('sign_in_started', request(), { name: 'Unverified Name', email: 'unverified@example.com' });
    f.track('unknown_event', request());
    await flush();
    assert.equal(f.calls.length, 3);
    const data = f.calls.map(call => JSON.parse(call.options.body).payload.data);
    assert.deepEqual(data, [{ provider: 'google', reason: 'invalid_identity' }, { provider: 'google' }, { provider: 'google' }]);
});

test('Do Not Track suppresses events from both the current request and the original login flow', async () => {
    const f = fixture();
    f.track('sign_in_started', { ...request(), headers: { ...request().headers, dnt: '1' } });
    f.track('sign_in_succeeded', request(), { name: 'Alice', email: 'alice@example.com', doNotTrack: true });
    await flush();
    assert.equal(f.calls.length, 0);
});

test('forwarded client IP is used only when the app is explicitly behind its trusted proxy', async () => {
    const f = fixture({ env: { ...env, UMAMI_AUTH_EVENTS_TRUST_PROXY: 'true' } });
    f.track('sign_in_started', request());
    f.track('sign_in_started', { ...request(), headers: { ...request().headers, 'x-forwarded-for': 'invalid' } });
    await flush();
    assert.deepEqual(f.calls.map(call => JSON.parse(call.options.body).payload.ip), ['203.0.113.7', '127.0.0.1']);
});

test('missing or invalid configuration disables auth analytics without making requests', async () => {
    for (const changes of [{ UMAMI_WEBSITE_ID: '' }, { UMAMI_WEBSITE_ID: 'invalid' }, { UMAMI_AUTH_EVENTS_URL: '' },
        { UMAMI_AUTH_EVENTS_URL: 'https://user:secret@analytics.test/api/send' },
        { UMAMI_AUTH_EVENTS_URL: 'http://umami:3000/api/send?secret=private-token' },
        { UMAMI_AUTH_EVENTS_URL: 'file:///api/send' }, { APP_ORIGIN: 'invalid' }]) {
        const f = fixture({ env: { ...env, ...changes } });
        f.track('sign_in_started', request());
        await flush();
        assert.equal(f.calls.length, 0);
        assert.doesNotMatch(f.warnings.join(' '), /private-token|user:secret/);
    }
});

test('collector failures are contained, logs exclude event data, and pending work is bounded', async () => {
    let release;
    let calls = 0;
    const f = fixture({ maxPending: 1, fetchImpl: () => {
        calls++;
        return new Promise(resolve => { release = resolve; });
    } });
    f.track('sign_in_succeeded', request(), { name: 'Alice', email: 'alice@example.com' });
    f.track('sign_out_succeeded', request());
    assert.equal(calls, 1);
    release({ ok: false });
    await flush();
    f.track('sign_in_started', request());
    assert.equal(calls, 2);
    release({ ok: false });
    await flush();
    assert.equal(f.warnings.length, 1);
    assert.doesNotMatch(f.warnings[0], /Alice|alice@example.com/);
    const failing = fixture({ fetchImpl: async () => { throw new Error('private-token'); } });
    assert.doesNotThrow(() => failing.track('sign_in_started', request()));
    await flush();
    assert.equal(failing.warnings.length, 1);
    assert.doesNotMatch(failing.warnings[0], /private-token/);
});

test('stalled collector requests are aborted and release their pending slot', async () => {
    let aborted;
    const didAbort = new Promise(resolve => { aborted = resolve; });
    let calls = 0;
    const guard = setTimeout(() => {}, 2000); // Keep the process alive for the unref'ed abort timer.
    try {
        const f = fixture({ timeoutMs: 10, maxPending: 1, fetchImpl: (url, { signal }) => {
            calls++;
            return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
                reject(signal.reason);
                aborted();
            }, { once: true }));
        } });
        f.track('sign_in_started', request());
        await didAbort;
        await flush();
        f.track('sign_in_started', request());
        assert.equal(calls, 2);
        await new Promise(resolve => setTimeout(resolve, 20));
    } finally { clearTimeout(guard); }
});

const telegramConnection = () => ({ name: 'Telegram Alice', username: 'alice', chatId: '123456',
    analyticsContext: { name: 'Alice Example', email: 'alice@example.com',
        doNotTrack: false, userAgent: 'Mozilla/5.0 Test Browser' } });

test('Telegram collector sends distinct event names with recipient properties and no message, chat ID or saved IP', async () => {
    const f = fixture();
    for (const event of ['telegram_connected', 'telegram_disconnected', 'telegram_test_sent',
        'telegram_runway_change_sent', 'telegram_busy_arrivals_sent', 'telegram_holding_arrivals_sent']) {
        f.trackTelegram(event, { accountId: 'google-alice', connection: telegramConnection(),
            notificationType: event === 'telegram_holding_arrivals_sent' ? 'holdingArrivals' : 'busyArrivals',
            message: 'Private message body', token: 'private-token' });
    }
    await flush();
    assert.equal(f.calls.length, 6);
    for (const { options } of f.calls) {
        const { payload } = JSON.parse(options.body);
        if (payload.name === 'telegram_holding_arrivals_sent') assert.equal(payload.data.notificationType, 'holdingArrivals');
        assert.equal(payload.data.provider, 'telegram');
        assert.equal(payload.data.source, 'server');
        assert.equal(payload.data.accountId, 'google-alice');
        assert.equal(payload.data.name, 'Alice Example');
        assert.equal(payload.data.email, 'alice@example.com');
        assert.equal(payload.data.telegramName, 'Telegram Alice');
        assert.equal(payload.data.telegramUsername, 'alice');
        assert.equal(payload.ip, undefined);
        assert.equal(options.headers['User-Agent'], 'Mozilla/5.0 Test Browser');
        assert.doesNotMatch(options.body, /123456|Private message body|private-token/);
    }
    f.trackTelegram('unknown', { connection: telegramConnection() });
    const dnt = telegramConnection(); dnt.analyticsContext.doNotTrack = true;
    f.trackTelegram('telegram_connected', { connection: dnt });
    f.trackTelegram('telegram_connected', { connection: {} });
    await flush();
    assert.equal(f.calls.length, 6);
});

test('auth and Telegram events share the bounded collector queue and disabled configuration', async () => {
    let finish;
    const f = fixture({ maxPending: 1, fetchImpl: (url, options) => {
        f.calls.push({ url, options });
        return new Promise(resolve => { finish = resolve; });
    } });
    f.trackTelegram('telegram_busy_arrivals_sent', { connection: telegramConnection() });
    f.track('sign_in_started', request());
    assert.equal(f.calls.length, 1);
    finish({ ok: true }); await flush();
    f.track('sign_in_started', request()); assert.equal(f.calls.length, 2);
    finish({ ok: true }); await flush();
    const disabled = fixture({ env: {} });
    disabled.trackTelegram('telegram_connected', { connection: telegramConnection() });
    assert.equal(disabled.calls.length, 0);
});
