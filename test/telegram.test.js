const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createTelegram, telegramConfig } = require('../lib/telegram');
const { createTelegramStore } = require('../lib/telegram-store');
const { createTelegramClient, TelegramError } = require('../lib/telegram-client');
const { createTelegramHandler } = require('../api/telegram');
const { createAuth } = require('../lib/auth');
const { OAuth2Client } = require('google-auth-library');
const { createUserSettings } = require('../lib/user-settings');

const env = { TELEGRAM_BOT_TOKEN: '12345:private_bot_token', TELEGRAM_BOT_USERNAME: 'GenevaTestBot',
    APP_ORIGIN: 'http://localhost:3000',
    GOOGLE_OAUTH_CLIENT_ID: 'google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret' };
const tokenOf = link => new URL(link.url).searchParams.get('start');
function update(token, id = 123456) {
    return { update_id: 42, message: { text: `/start ${token}`, chat: { id, type: 'private' },
        from: { id, is_bot: false, first_name: '<Alice>', last_name: 'Example', username: 'alice' } } };
}
async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-telegram-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'connections.json');
    let now = Date.parse('2026-10-19T10:00:00Z');
    const calls = [];
    let failure;
    const client = { async sendMessage(chatId, text) { calls.push({ chatId, text }); if (failure) throw failure; } };
    const store = createTelegramStore({ filePath });
    const telegram = createTelegram({ env, store, clock: () => now, client, ...options });
    return { telegram, store, client, calls, filePath, directory, now: () => now,
        advance(ms) { now += ms; }, fail(error) { failure = error; } };
}

test('links are private, single-use and bind a Telegram account to the correct Google ID across restarts', async t => {
    const f = await fixture(t);
    const link = await f.telegram.begin('google-alice');
    assert.equal(new URL(link.url).pathname, '/GenevaTestBot');
    assert.equal(tokenOf(link).length, 43);
    assert.doesNotMatch(link.url, /google-alice|private_bot_token/);
    assert.equal(link.expiresAt, f.now() + 600_000);
    const svg = await f.telegram.qrCode('google-alice');
    assert.match(svg, /<svg/);
    assert.match(svg, /viewBox=/);
    await f.telegram.accept(update(tokenOf(link)));
    const state = await f.telegram.status('google-alice');
    assert.equal(state.connection.name, '<Alice> Example');
    assert.equal(state.connection.username, 'alice');
    assert.equal(state.expiresAt, null);
    assert.doesNotMatch(JSON.stringify(state), /123456|chatId|token/);
    assert.equal((await f.telegram.status('google-bob')).connection, null);
    await f.telegram.accept(update(tokenOf(link))); // Telegram retry is a no-op.
    await assert.rejects(f.telegram.begin('google-alice'), { status: 409 });
    const restarted = createTelegram({ env, store: createTelegramStore({ filePath: f.filePath }), client: f.client });
    assert.deepEqual((await restarted.status('google-alice')).connection, state.connection);
    assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await fs.readFile(f.filePath, 'utf8'), new RegExp(tokenOf(link)));
});

test('QR encodes the exact deep link and expired, replaced, disconnected or restarted links cannot connect', async t => {
    const encoded = [];
    const f = await fixture(t, { qr: async url => { encoded.push(url); return '<svg/>'; } });
    const first = await f.telegram.begin('alice');
    await f.telegram.qrCode('alice');
    assert.deepEqual(encoded, [first.url]);
    const replacement = await f.telegram.begin('alice');
    await f.telegram.accept(update(tokenOf(first)));
    assert.equal((await f.telegram.status('alice')).connection, null);
    f.advance(600_000);
    await f.telegram.accept(update(tokenOf(replacement)));
    await assert.rejects(f.telegram.qrCode('alice'), { status: 410 });
    const cancelled = await f.telegram.begin('alice');
    await f.telegram.disconnect('alice');
    await f.telegram.accept(update(tokenOf(cancelled)));
    assert.equal((await f.telegram.status('alice')).connection, null);
    const beforeRestart = await f.telegram.begin('alice');
    const restarted = createTelegram({ env, store: f.store });
    await restarted.accept(update(tokenOf(beforeRestart)));
    assert.equal((await restarted.status('alice')).connection, null);
});

test('ordinary commands, group chats, bot senders and mismatched identities cannot link', async t => {
    const f = await fixture(t);
    const token = tokenOf(await f.telegram.begin('alice'));
    for (const mutate of [
        value => { value.message.text = '/help'; },
        value => { value.message.text = '/start'; },
        value => { value.message.chat.type = 'group'; },
        value => { value.message.from.is_bot = true; },
        value => { value.message.from.id++; },
        value => { value.message.from.id = value.message.chat.id = -1; }
    ]) {
        const event = update(token);
        mutate(event);
        await f.telegram.accept(event);
        assert.equal((await f.telegram.status('alice')).connection, null);
    }
    await f.telegram.accept(update(token));
    assert.ok((await f.telegram.status('alice')).connection);
    assert.equal(f.calls.length, 0); // Linking and commands never send a message.
});

test('concurrent connections enforce one-to-one ownership and disconnect prevents replay', async t => {
    const f = await fixture(t);
    const alice = await f.telegram.begin('alice');
    const bob = await f.telegram.begin('bob');
    await Promise.all([f.telegram.accept(update(tokenOf(alice))), f.telegram.accept(update(tokenOf(bob)))]);
    assert.ok((await f.telegram.status('alice')).connection);
    assert.equal((await f.telegram.status('bob')).connection, null);
    assert.match((await f.telegram.status('bob')).linkError, /already connected/);
    await f.telegram.disconnect('alice');
    await f.telegram.accept(update(tokenOf(alice)));
    assert.equal((await f.telegram.status('alice')).connection, null);
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('bob'))));
    assert.ok((await f.telegram.status('bob')).connection);
});

test('failed atomic writes preserve connections and linking can retry after disk recovery', async t => {
    const f = await fixture(t);
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('alice'))));
    const before = await fs.readFile(f.filePath, 'utf8');
    let fail = true;
    const store = createTelegramStore({ filePath: f.filePath, storage: { ...fs,
        async rename(...args) { if (fail) throw new Error('disk failure'); return fs.rename(...args); } } });
    const telegram = createTelegram({ env, store, clock: f.now });
    await assert.rejects(telegram.disconnect('alice'));
    const token = tokenOf(await telegram.begin('bob'));
    await assert.rejects(telegram.accept(update(token, 654321)));
    assert.equal(await fs.readFile(f.filePath, 'utf8'), before);
    fail = false;
    await telegram.accept(update(token, 654321));
    assert.ok((await telegram.status('bob')).connection);
    assert.ok((await telegram.status('alice')).connection);
    assert.deepEqual(await fs.readdir(f.directory), ['connections.json']);
});

test('malformed connection files are preserved instead of overwritten', async t => {
    const f = await fixture(t);
    for (const contents of ['{broken', '{"version":1,"accounts":[]}', '{"version":1,"accounts":{"alice":{}}}']) {
        await fs.writeFile(f.filePath, contents);
        await assert.rejects(f.telegram.status('alice'));
        await assert.rejects(f.telegram.disconnect('alice'));
        assert.equal(await fs.readFile(f.filePath, 'utf8'), contents);
    }
});

test('test provider sends only to its owner, persists cooldown and honors Telegram rate limits', async t => {
    const f = await fixture(t);
    await assert.rejects(f.telegram.send('alice'), { status: 409 });
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('alice'))));
    await assert.rejects(f.telegram.send('bob'), { status: 409 });
    await f.telegram.send('alice');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].chatId, '123456');
    assert.match(f.calls[0].text, /connection is working/);
    await assert.rejects(f.telegram.send('alice'), { status: 429, retryAfter: 10 });
    const restarted = createTelegram({ env, store: f.store, client: f.client, clock: f.now });
    await assert.rejects(restarted.send('alice'), { status: 429 });
    f.advance(10_000);
    f.fail(new TelegramError(429, 60));
    await assert.rejects(f.telegram.send('alice'), { status: 429, retryAfter: 60 });
    f.advance(10_000);
    await assert.rejects(f.telegram.send('alice'), { status: 429, retryAfter: 50 });
    assert.throws(() => f.telegram.send('alice', '__proto__'), /Unknown notification provider/);
});

test('blocked chats report actionable status and transient delivery failures are not retried', async t => {
    const f = await fixture(t);
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('alice'))));
    f.fail(new TelegramError('unavailable'));
    await assert.rejects(f.telegram.send('alice'), { status: 503 });
    assert.equal(f.calls.length, 1);
    f.advance(10_000);
    f.fail(new TelegramError(403));
    await assert.rejects(f.telegram.send('alice'), { status: 409 });
    assert.equal((await f.telegram.status('alice')).connection.blocked, true);
    await assert.rejects(f.telegram.send('alice'), { status: 409 });
    assert.equal(f.calls.length, 2);
    await f.telegram.disconnect('alice');
    f.fail(null);
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('alice'))));
    await f.telegram.send('alice');
    assert.equal(f.calls.length, 3);
});

async function httpFixture(t, options = {}) {
    const f = await fixture(t, options);
    let identity;
    const oauth = new OAuth2Client({ clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${env.APP_ORIGIN}/auth/google/callback` });
    oauth.getToken = async () => ({ tokens: { id_token: 'test' } });
    oauth.verifyIdToken = async () => ({ getPayload: () => identity });
    const auth = createAuth({ env, settings: createUserSettings({ filePath: path.join(f.directory, 'settings.json') }),
        logger: { info() {}, warn() {} }, client: oauth });
    const handle = createTelegramHandler({ auth, telegram: f.telegram });
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, env.APP_ORIGIN);
        if (!await handle(req, res, url) && !await auth.handle(req, res, url)) { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const request = (url, options) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { redirect: 'manual', ...options });
    async function login(id = 'alice', loginHeaders = {}) {
        const start = await request('/auth/google', { headers: loginHeaders });
        const url = new URL(start.headers.get('location'));
        identity = { sub: id, email: `${id}@example.com`, email_verified: true, nonce: url.searchParams.get('nonce') };
        const callback = await request(`/auth/google/callback?code=test&state=${url.searchParams.get('state')}`, {
            headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] }
        });
        const cookie = callback.headers.getSetCookie().find(value => value.startsWith('gva-session=')).split(';')[0];
        const session = await (await request('/api/auth/session', { headers: { Cookie: cookie } })).json();
        return { Cookie: cookie, Origin: env.APP_ORIGIN, 'X-CSRF-Token': session.csrfToken };
    }
    async function receive(value) {
        let delivered;
        const finished = new Promise(resolve => { delivered = resolve; });
        let first = true;
        f.client.request = async (method, _payload, { signal }) => {
            if (method === 'getMe') return { id: 12345, is_bot: true, username: env.TELEGRAM_BOT_USERNAME };
            if (first) { first = false; return [value]; }
            delivered(); // Second poll means the first update was committed.
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        };
        t.after(() => f.telegram.stopPolling());
        void f.telegram.startPolling();
        await finished;
        await f.telegram.stopPolling();
    }
    return { ...f, request, login, receive };
}

test('account HTTP endpoints enforce real Google sessions, account isolation, CSRF and private QR responses', async t => {
    const f = await httpFixture(t);
    for (const route of ['', '/qr', '/connect', '/disconnect', '/test', '/alerts']) {
        const response = await f.request(`/api/account/telegram${route}`, { method: ['', '/qr'].includes(route) ? 'GET' : 'POST' });
        assert.equal(response.status, 401);
    }
    const alice = await f.login('alice');
    for (const headers of [{ ...alice, Origin: 'https://evil.example' }, { ...alice, 'X-CSRF-Token': 'forged' }]) {
        assert.equal((await f.request('/api/account/telegram/connect', { method: 'POST', headers })).status, 403);
    }
    assert.equal((await f.request('/api/account/telegram/connect', { headers: alice })).status, 405);
    const response = await f.request('/api/account/telegram/connect', { method: 'POST', headers: alice });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const link = await response.json();
    const bob = await f.login('bob');
    assert.equal((await f.request('/api/account/telegram/qr', { headers: bob })).status, 410);
    const image = await f.request('/api/account/telegram/qr', { headers: alice });
    assert.match(image.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await image.text(), /<svg/);
    await f.receive(update(tokenOf(link)));
    const state = await (await f.request('/api/account/telegram', { headers: alice })).json();
    assert.ok(state.connection);
    assert.doesNotMatch(JSON.stringify(state), /private|123456|chatId/);
    assert.equal((await (await f.request('/api/account/telegram', { headers: bob })).json()).connection, null);
    assert.equal((await f.request('/api/account/telegram/test', { method: 'POST', headers: alice })).status, 200);
    const rate = await f.request('/api/account/telegram/test', { method: 'POST', headers: alice });
    assert.equal(rate.status, 429);
    assert.equal(rate.headers.get('retry-after'), '10');
    assert.equal((await f.request('/api/account/telegram/disconnect', { method: 'POST', headers: alice })).status, 200);
    assert.equal((await f.request('/api/account/telegram/test', { method: 'POST', headers: alice })).status, 409);
    await f.request('/auth/logout', { method: 'POST', headers: alice });
    assert.equal((await f.request('/api/account/telegram', { headers: alice })).status, 401);
});

test('runway alert preferences are opt-in, account-isolated, persistent and protected by session/CSRF', async t => {
    const f = await httpFixture(t);
    const alice = await f.login('alice');
    const body = JSON.stringify({ predictedRunwayChanges: true, busyArrivals: false, busyArrivalThreshold: 10 });
    const save = (headers = alice, value = body) => f.request('/api/account/telegram/alerts', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: value
    });
    assert.equal((await save()).status, 409);
    await f.receive(update(tokenOf(await f.telegram.begin('alice'))));
    assert.deepEqual((await f.telegram.status('alice')).alerts, { predictedRunwayChanges: false, busyArrivals: false, busyArrivalThreshold: 10 });
    assert.equal((await save({ ...alice, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await save({ ...alice, 'X-CSRF-Token': 'forged' })).status, 403);
    for (const value of ['null', '[]', '{}', '{bad', '{"predictedRunwayChanges":"yes"}',
        '{"predictedRunwayChanges":true,"userId":"bob"}']) assert.equal((await save(alice, value)).status, 400);
    assert.equal((await save(alice, JSON.stringify({ padding: 'x'.repeat(1100) }))).status, 413);
    assert.equal((await f.request('/api/account/telegram/alerts', { method: 'POST', headers: alice, body })).status, 415);
    assert.equal((await save()).status, 200);
    assert.deepEqual((await f.telegram.status('alice')).alerts, { predictedRunwayChanges: true, busyArrivals: false, busyArrivalThreshold: 10 });
    assert.deepEqual((await f.telegram.status('bob')).alerts, { predictedRunwayChanges: false, busyArrivals: false, busyArrivalThreshold: 10 });
    const restarted = createTelegram({ env, store: createTelegramStore({ filePath: f.filePath }), client: f.client });
    assert.equal((await restarted.status('alice')).alerts.predictedRunwayChanges, true);
    await f.store.update(accounts => { accounts.alice.runwayAlert = { state: null, pending: null }; });
    assert.equal((await save(alice, JSON.stringify({ predictedRunwayChanges: false }))).status, 200);
    assert.equal((await f.store.read()).accounts.alice.runwayAlert, undefined);
    await f.telegram.disconnect('alice');
    await f.receive({ ...update(tokenOf(await f.telegram.begin('alice'))), update_id: 43 });
    assert.equal((await f.telegram.status('alice')).alerts.predictedRunwayChanges, false);
    assert.equal(f.calls.length, 0);
});

test('removed webhook URL accepts no incoming Telegram updates', async t => {
    const f = await httpFixture(t);
    for (const method of ['GET', 'POST']) {
        assert.equal((await f.request('/api/telegram/webhook', { method })).status, 404);
    }
    assert.equal(f.calls.length, 0);
});

test('Telegram API client contains secret-bearing network errors and times out stalled bodies', async () => {
    const token = env.TELEGRAM_BOT_TOKEN;
    const calls = [];
    const client = createTelegramClient({ token, fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    } });
    assert.deepEqual(await client.sendMessage('123', 'hello'), { message_id: 1 });
    assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/sendMessage`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: '123', text: 'hello' });
    const failing = createTelegramClient({ token, fetchImpl: async () => { throw new Error(`Network failed: ${token}`); } });
    await assert.rejects(failing.sendMessage('123', 'hello'), error => error.code === 'unavailable' && !error.message.includes(token));
    const timer = setTimeout(() => {}, 1000);
    try {
        const stalled = createTelegramClient({ token, timeoutMs: 10, fetchImpl: async (_url, { signal }) => ({
            ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
        }) });
        await assert.rejects(stalled.sendMessage('123', 'hello'), { code: 'unavailable' });
    } finally { clearTimeout(timer); }
});

test('Telegram configuration only needs a token and username and disabled integration never polls', async () => {
    let calls = 0;
    const telegram = createTelegram({ env: {}, client: { request() { calls++; } } });
    await telegram.startPolling();
    await telegram.stopPolling();
    assert.equal(calls, 0);
    assert.equal(telegramConfig({}).enabled, false);
    assert.equal(telegramConfig({ ...env, TELEGRAM_BOT_TOKEN: 'invalid' }).enabled, false);
    assert.equal(telegramConfig(env).enabled, true);
});

test('busy arrival preferences validate partial updates, preserve runway settings and reset only their own detector', async t => {
    const f = await httpFixture(t);
    const alice = await f.login('alice');
    const save = (body, headers = alice) => f.request('/api/account/telegram/alerts', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    await f.receive(update(tokenOf(await f.telegram.begin('alice'))));
    assert.equal((await save({ busyArrivals: true }, { ...alice, 'X-CSRF-Token': 'wrong' })).status, 403);
    for (const body of [{ busyArrivals: 'yes' }, { busyArrivalThreshold: 0 }, { busyArrivalThreshold: 101 },
        { busyArrivalThreshold: 1.5 }, { busyArrivalThreshold: '10' }, { busyArrivalThreshold: null }, { busyArrivals: true, account: 'bob' }]) {
        assert.equal((await save(body)).status, 400);
    }
    await save({ predictedRunwayChanges: true });
    await save({ busyArrivals: true, busyArrivalThreshold: 12 });
    assert.deepEqual((await f.telegram.status('alice')).alerts, { predictedRunwayChanges: true, busyArrivals: true, busyArrivalThreshold: 12 });
    await f.store.update(accounts => {
        accounts.alice.runwayAlert = { state: null, pending: null };
        accounts.alice.busyAlert = { active: true, belowSince: null, pending: null, lastCheckedAt: 1 };
    });
    await save({ busyArrivalThreshold: 15 });
    let account = (await f.store.read()).accounts.alice;
    assert.equal(account.busyAlert, undefined);
    assert.deepEqual(account.runwayAlert, { state: null, pending: null });
    const restarted = createTelegram({ env, store: createTelegramStore({ filePath: f.filePath }), client: f.client });
    assert.equal((await restarted.status('alice')).alerts.busyArrivalThreshold, 15);
    assert.equal((await restarted.status('alice')).alerts.busyArrivals, true);
    await f.store.update(accounts => { accounts.alice.busyAlert = { active: true, belowSince: null, pending: null, lastCheckedAt: 1 }; });
    await save({ predictedRunwayChanges: false });
    account = (await f.store.read()).accounts.alice;
    assert.equal(account.busyAlert.active, true);
    await save({ busyArrivals: false });
    assert.equal((await f.store.read()).accounts.alice.busyAlert, undefined);
    await f.telegram.disconnect('alice');
    assert.equal((await f.telegram.status('alice')).alerts.busyArrivals, false);
    assert.equal(f.calls.length, 0);
});

test('confirmed linking, test delivery and disconnect emit recipient-specific events once after persistence', async t => {
    const events = []; const logs = [];
    const f = await fixture(t, { analytics: { trackTelegram: (event, context) => events.push({ event, ...context }) },
        logger: { info: line => logs.push(JSON.parse(line)) } });
    const context = { doNotTrack: false, userAgent: 'Mozilla/5.0 Test Browser', name: 'Google Alice', email: 'alice@example.com' };
    const link = await f.telegram.begin('alice', context);
    assert.equal(events.length, 0); // Clicking Connect is not yet a connection.
    await f.telegram.accept(update(tokenOf(link)));
    await f.telegram.accept(update(tokenOf(link)));
    assert.deepEqual(events.map(item => item.event), ['telegram_connected']);
    assert.deepEqual(events[0].connection.analyticsContext, context);
    await f.telegram.send('alice');
    assert.equal(events.at(-1).event, 'telegram_test_sent');
    assert.equal(logs[0].message, f.calls[0].text);
    assert.equal(logs[0].telegramUsername, 'alice');
    assert.equal(logs[0].email, 'alice@example.com');
    const bob = await f.telegram.begin('bob', context);
    await f.telegram.accept(update(tokenOf(bob))); // Same Telegram identity is already owned.
    assert.equal(events.length, 2);
    const restarted = createTelegram({ env, store: createTelegramStore({ filePath: f.filePath }), client: f.client,
        logger: {}, analytics: { trackTelegram: (event, data) => events.push({ event, ...data }) } });
    await restarted.send('alice');
    assert.equal(events.at(-1).connection.analyticsContext.email, 'alice@example.com');
    await restarted.disconnect('alice');
    await restarted.disconnect('alice');
    assert.equal(events.filter(item => item.event === 'telegram_disconnected').length, 1);
    assert.equal(events.at(-1).accountId, 'alice');
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(tokenOf(link)));
});

test('HTTP linking captures verified identity and login Do Not Track; old connections gain context without analytics events', async t => {
    const events = [];
    const f = await httpFixture(t, { logger: {}, analytics: { trackTelegram: (event, context) => events.push({ event, ...context }) } });
    const alice = await f.login('alice', { DNT: '1' });
    const response = await f.request('/api/account/telegram/connect', { method: 'POST', headers: alice });
    const link = await response.json();
    await f.telegram.accept(update(tokenOf(link)));
    assert.equal(events.length, 1);
    const saved = (await f.store.read()).accounts.alice.analyticsContext;
    assert.equal(saved.doNotTrack, true); // Remembered from login, even though /connect has no DNT header.
    assert.equal(saved.email, 'alice@example.com');
    assert.equal(typeof saved.userAgent, 'string');
    assert.doesNotMatch(JSON.stringify(saved), /google-secret|test|gva-session|csrf|Cookie/);
    await f.store.update(accounts => { delete accounts.alice.analyticsContext; });
    const status = await f.request('/api/account/telegram', { headers: alice });
    assert.equal(status.status, 200);
    assert.doesNotMatch(await status.text(), /analyticsContext|alice@example.com/);
    assert.deepEqual((await f.store.read()).accounts.alice.analyticsContext, saved);
    assert.equal(events.length, 1);
    await f.request('/api/account/telegram/disconnect', { method: 'POST', headers: alice });
    assert.equal(events.at(-1).event, 'telegram_disconnected');
    assert.equal(events.at(-1).connection.analyticsContext.doNotTrack, true);
});

test('failed connection storage and delivery produce no successful analytics events', async t => {
    const events = [];
    const f = await fixture(t, { logger: {}, analytics: { trackTelegram: event => events.push(event) } });
    const store = createTelegramStore({ filePath: f.filePath, storage: { ...fs, async rename() { throw new Error('Disk failure'); } } });
    const failing = createTelegram({ env, store, logger: {}, client: f.client,
        analytics: { trackTelegram: event => events.push(event) } });
    const token = tokenOf(await failing.begin('alice'));
    await assert.rejects(failing.accept(update(token)));
    assert.equal(events.length, 0);
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('alice'))));
    assert.deepEqual(events, ['telegram_connected']);
    f.fail(new TelegramError('unavailable'));
    await assert.rejects(f.telegram.send('alice'));
    assert.deepEqual(events, ['telegram_connected']);
    await assert.rejects(failing.disconnect('alice'));
    assert.deepEqual(events, ['telegram_connected']);
});

test('a test request refreshes persisted Do Not Track for later automatic notification events', async t => {
    const events = [];
    const f = await fixture(t, { logger: {}, analytics: { trackTelegram: (event, context) => events.push({ event, ...context }) } });
    const context = { userAgent: 'Mozilla/5.0 Test Browser', doNotTrack: false, email: 'alice@example.com' };
    await f.telegram.accept(update(tokenOf(await f.telegram.begin('alice', context))));
    await f.telegram.send('alice', 'test', { ...context, doNotTrack: true });
    assert.equal(events.at(-1).connection.analyticsContext.doNotTrack, true);
    assert.equal((await f.store.read()).accounts.alice.analyticsContext.doNotTrack, true);
});
