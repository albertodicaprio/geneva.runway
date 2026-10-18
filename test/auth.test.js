const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUserSettings } = require('../lib/user-settings');
const { createHash } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { createAuth } = require('../lib/auth');

async function fixture(t, { enabled = true, secure = false, settings, analytics } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-account-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const settingsFile = path.join(directory, 'user-settings.json');
    let now = Date.now();
    const env = enabled ? {
        APP_ORIGIN: secure ? 'https://gva-runway.ahpc.ch' : 'http://localhost:3000',
        GOOGLE_OAUTH_CLIENT_ID: 'test-client', GOOGLE_OAUTH_CLIENT_SECRET: 'private-secret'
    } : {};
    let payload;
    let exchange;
    let calls = 0;
    const logs = [];
    const events = [];
    let failVerification = false;
    const client = new OAuth2Client({ clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${env.APP_ORIGIN}/auth/google/callback` });
    client.getToken = async options => {
        calls++;
        exchange = options;
        return { tokens: { id_token: 'private-google-token' } };
    };
    client.verifyIdToken = async options => {
        assert.deepEqual(options, { idToken: 'private-google-token', audience: 'test-client' });
        if (failVerification) throw new Error('bad signature / audience / expiry');
        return { getPayload: () => payload };
    };
    const auth = createAuth({ env, client, clock: () => now, logger: { info: line => logs.push(line) },
        analytics: analytics || { track(event, req, data) { events.push({ event, ...data }); } },
        settings: settings || createUserSettings({ filePath: settingsFile }) });
    const server = http.createServer(async (req, res) => {
        if (!await auth.handle(req, res, new URL(req.url, 'http://localhost'))) {
            res.end(JSON.stringify(auth.getUser(req)));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    async function begin(returnTo = '/weather.html', email = 'spotter@example.com', headers = {}) {
        const response = await request(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`, { headers });
        assert.equal(response.status, 303);
        const url = new URL(response.headers.get('location'));
        const cookie = response.headers.getSetCookie()[0].split(';')[0];
        payload = { sub: 'google-user-123', given_name: '<Spotter>', email, email_verified: true,
            nonce: url.searchParams.get('nonce') };
        return { url, cookie, callback: `/auth/google/callback?code=one-time-code&state=${url.searchParams.get('state')}` };
    }
    return { env, request, begin, logs, events, settingsFile, advance: ms => { now += ms; }, payload: value => { payload = value; },
        exchange: () => exchange, calls: () => calls, fail: () => { failVerification = true; } };
}

test('Google login uses PKCE, verified identity, opaque expiring sessions, and CSRF-protected logout', async t => {
    const f = await fixture(t, { secure: true });
    const flow = await f.begin();
    assert.equal(flow.url.origin, 'https://accounts.google.com');
    assert.equal(flow.url.searchParams.get('redirect_uri'), 'https://gva-runway.ahpc.ch/auth/google/callback');
    assert.equal(flow.url.searchParams.get('scope'), 'openid profile email');
    assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
    assert.doesNotMatch(flow.url.href, /private-secret/);
    assert.match(flow.cookie, /^__Host-gva-login=/);
    const callback = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    assert.equal(callback.headers.get('location'), '/weather.html');
    assert.equal(createHash('sha256').update(f.exchange().codeVerifier).digest('base64url'), flow.url.searchParams.get('code_challenge'));
    const sessionHeader = callback.headers.getSetCookie().find(value => value.startsWith('__Host-gva-session='));
    assert.match(sessionHeader, /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
    assert.doesNotMatch(sessionHeader, /google-user|Spotter|private/);
    const cookie = sessionHeader.split(';')[0];
    const response = await f.request('/api/auth/session', { headers: { Cookie: cookie } });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const session = await response.json();
    assert.deepEqual(session.user, { id: 'google-user-123', name: '<Spotter>',
        fullName: '<Spotter>', email: 'spotter@example.com' });
    assert.ok(session.csrfToken);
    const headers = { Cookie: cookie, Origin: f.env.APP_ORIGIN, 'X-CSRF-Token': session.csrfToken };
    assert.equal((await f.request('/auth/logout', { headers })).status, 405);
    assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'forged' } })).status, 403);
    const logout = await f.request('/auth/logout', { method: 'POST', headers });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.getSetCookie()[0], /Max-Age=0/);
    assert.equal((await (await f.request('/api/auth/session', { headers: { Cookie: cookie } })).json()).user, null);
    assert.equal((await f.request(flow.callback, { headers: { Cookie: flow.cookie } })).headers.get('location'), '/?auth=expired');
    assert.equal(f.logs.length, 1);
    assert.equal(JSON.parse(f.logs[0]).name, '<Spotter>');
});

test('successful sign-in logs the full name, verified email and timestamp as one line without credentials', async t => {
    const f = await fixture(t);
    const flow = await f.begin();
    const name = 'Alice\nExample';
    const email = 'alice@example.com';
    f.payload({ sub: 'google-user-123', name, given_name: 'Alice', email, email_verified: true,
        nonce: flow.url.searchParams.get('nonce') });
    const callback = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('gva-session=')).split(';')[0];
    const session = await (await f.request('/api/auth/session', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(session.user, { id: 'google-user-123', name: 'Alice', fullName: name, email });
    assert.equal(f.logs.length, 1);
    const entry = JSON.parse(f.logs[0]);
    assert.deepEqual(entry, { event: 'google_sign_in', timestamp: entry.timestamp, name, email });
    assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
    assert.doesNotMatch(f.logs[0], /\n|private-secret|private-google-token|one-time-code|google-user-123/);
});

test('callbacks require matching state and browser cookie, and login attempts expire', async t => {
    const f = await fixture(t);
    const flow = await f.begin('//evil.example');
    assert.equal((await f.request(flow.callback)).headers.get('location'), '/?auth=expired');
    assert.equal((await f.request(flow.callback, { headers: { Cookie: 'gva-login=forged' } })).headers.get('location'), '/?auth=expired');
    assert.equal(f.calls(), 0);
    f.advance(10 * 60 * 1000);
    assert.equal((await f.request(flow.callback, { headers: { Cookie: flow.cookie } })).headers.get('location'), '/?auth=expired');
    assert.equal(f.calls(), 0);
    assert.equal(f.logs.length, 0);
});

test('return destinations are restricted and cancellation is recoverable', async t => {
    const f = await fixture(t);
    const flow = await f.begin('https://evil.example');
    const cancelled = await f.request(flow.callback + '&error=access_denied', { headers: { Cookie: flow.cookie } });
    assert.equal(cancelled.headers.get('location'), '/?auth=cancelled');
    assert.equal(f.calls(), 0);
    assert.equal((await f.request(flow.callback, { headers: { Cookie: flow.cookie } })).headers.get('location'), '/?auth=expired');
});

for (const failure of ['verification', 'nonce', 'email', 'subject']) {
    test(`failed ${failure} validation creates no session`, async t => {
        const f = await fixture(t);
        const flow = await f.begin();
        if (failure === 'verification') f.fail();
        else f.payload({ sub: failure === 'subject' ? '' : 'user',
            email: 'spotter@example.com', email_verified: failure !== 'email', nonce: failure === 'nonce' ? 'forged' : flow.url.searchParams.get('nonce') });
        const response = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
        assert.equal(response.headers.get('location'), '/weather.html?auth=failed');
        assert.ok(!response.headers.getSetCookie().some(value => value.startsWith('gva-session=')));
        assert.equal(f.logs.length, 0);
    });
}

test('sessions expire after seven days and forged session cookies are anonymous', async t => {
    const f = await fixture(t);
    assert.equal(await (await f.request('/', { headers: { Cookie: 'gva-session=forged' } })).json(), null);
    const flow = await f.begin();
    const callback = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('gva-session=')).split(';')[0];
    assert.equal((await (await f.request('/', { headers: { Cookie: cookie } })).json()).id, 'google-user-123');
    f.advance(7 * 86400000);
    assert.equal(await (await f.request('/', { headers: { Cookie: cookie } })).json(), null);
});

test('missing configuration keeps public access and reports disabled sign-in', async t => {
    const f = await fixture(t, { enabled: false });
    assert.equal((await f.request('/')).status, 200);
    assert.deepEqual(await (await f.request('/api/auth/session')).json(), { enabled: false, user: null, csrfToken: null, settings: null });
    assert.equal((await f.request('/auth/google')).status, 503);
});

test('production requires HTTPS and an explicit origin without paths or credentials', () => {
    for (const APP_ORIGIN of ['http://gva-runway.ahpc.ch', 'https://gva-runway.ahpc.ch/path', 'https://user:secret@example.com', 'https://example.com/?query=1', 'https://example.com/#fragment']) {
        assert.throws(() => createAuth({ env: { APP_ORIGIN } }));
    }
});

test('callback URLs in APP_ORIGIN explain that only the website origin belongs there', () => {
    assert.throws(() => createAuth({ env: {
        APP_ORIGIN: 'https://gva-runway.ahpc.ch/auth/google/callback'
    } }), /website origin only.*https:\/\/gva-runway\.ahpc\.ch.*without \/auth\/google\/callback/);
});

test('website origins accept an optional trailing slash', () => {
    for (const APP_ORIGIN of ['https://gva-runway.ahpc.ch/', 'http://127.0.0.1:3000/']) {
        assert.doesNotThrow(() => createAuth({ env: {
            APP_ORIGIN, GOOGLE_OAUTH_CLIENT_ID: 'test', GOOGLE_OAUTH_CLIENT_SECRET: 'test'
        } }));
    }
});

async function login(f, email = 'spotter@example.com') {
    const flow = await f.begin('/weather.html', email);
    const callback = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    const cookie = callback.headers.getSetCookie().find(value => /^gva-session=/.test(value)).split(';')[0];
    const session = await (await f.request('/api/auth/session', { headers: { Cookie: cookie } })).json();
    return { cookie, session, headers: { Cookie: cookie, Origin: f.env.APP_ORIGIN,
        'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' } };
}

test('theme saves use the verified email, sync between sessions, and persist after restart', async t => {
    const f = await fixture(t);
    const alice = await login(f, 'Alice@Example.com');
    const bob = await login(f, 'bob@example.com');
    assert.deepEqual(alice.session.settings, { theme: null });
    const saved = await f.request('/api/account/settings', {
        method: 'PATCH', headers: alice.headers, body: JSON.stringify({ theme: 'night' })
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { settings: { theme: 'night' } });
    assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(await fs.readFile(f.settingsFile, 'utf8')), { 'alice@example.com': { theme: 'night' } });
    const anotherDevice = await login(f, 'alice@example.com');
    assert.deepEqual(anotherDevice.session.settings, { theme: 'night' });
    assert.deepEqual((await (await f.request('/api/auth/session', { headers: bob.headers })).json()).settings, { theme: null });
    const restarted = await fixture(t, { settings: createUserSettings({ filePath: f.settingsFile }) });
    assert.equal((await (await restarted.request('/api/auth/session', { headers: alice.headers })).json()).user, null);
    assert.deepEqual((await login(restarted, 'alice@example.com')).session.settings, { theme: 'night' });
});

test('settings updates require a session, same-origin CSRF token and a valid theme-only JSON body', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/api/account/settings', { method: 'PATCH' })).status, 401);
    const alice = await login(f);
    const update = (body, headers = alice.headers) => f.request('/api/account/settings', { method: 'PATCH', headers, body });
    assert.equal((await f.request('/api/account/settings')).status, 405);
    assert.equal((await update('{"theme":"night"}', { ...alice.headers, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await update('{"theme":"night"}', { ...alice.headers, 'X-CSRF-Token': 'forged' })).status, 403);
    assert.equal((await update('{"theme":"night"}', { ...alice.headers, 'Content-Type': 'text/plain' })).status, 415);
    for (const body of ['{', '{}', 'null', '[]', '{"theme":"invalid"}', '{"theme":"night","email":"other@example.com"}']) {
        assert.equal((await update(body)).status, 400);
    }
    assert.equal((await update(JSON.stringify({ theme: 'x'.repeat(2000) }))).status, 413);
    await assert.rejects(fs.readFile(f.settingsFile), { code: 'ENOENT' });
});

test('unreadable settings keep the user signed in and failed saves report an error', async t => {
    const f = await fixture(t, { settings: {
        async get() { throw new Error('disk unavailable'); },
        async setTheme() { throw new Error('disk unavailable'); }
    } });
    const account = await login(f);
    assert.ok(account.session.user);
    assert.deepEqual(account.session.settings, { theme: null, unavailable: true });
    const response = await f.request('/api/account/settings', {
        method: 'PATCH', headers: account.headers, body: '{"theme":"night"}'
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Could not save/);
});

test('successful auth events include the verified full name/email and skip polling and rejected logout', async t => {
    const f = await fixture(t);
    const flow = await f.begin();
    f.payload({ sub: 'verified-user', name: 'Alice Example', given_name: 'Alice', email: 'Alice@Example.com',
        email_verified: true, nonce: flow.url.searchParams.get('nonce') });
    const callback = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('gva-session=')).split(';')[0];
    const session = await (await f.request('/api/auth/session', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(f.events.map(value => value.event), ['sign_in_started', 'sign_in_succeeded']);
    assert.equal(f.events[0].name, undefined);
    assert.deepEqual(f.events[1], { event: 'sign_in_succeeded', name: 'Alice Example', email: 'alice@example.com', doNotTrack: false });
    assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
    assert.equal(f.events.length, 2);
    assert.equal((await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie,
        Origin: f.env.APP_ORIGIN, 'X-CSRF-Token': session.csrfToken } })).status, 200);
    assert.deepEqual(f.events[2], { event: 'sign_out_succeeded', name: 'Alice Example', email: 'alice@example.com', doNotTrack: false });
});

test('cancelled, provider-failed and invalid-state callbacks report only general anonymous outcomes', async t => {
    const f = await fixture(t);
    for (const [error, event] of [['access_denied', 'sign_in_cancelled'], ['server_error', 'sign_in_failed']]) {
        const flow = await f.begin();
        await f.request(flow.callback + `&error=${error}&error_description=private-token`, { headers: { Cookie: flow.cookie } });
        assert.equal(f.events.at(-1).event, event);
        assert.equal(f.events.at(-1).reason, 'provider_error');
    }
    await f.request('/auth/google/callback?code=private-token&state=forged&name=Untrusted&email=untrusted@example.com');
    assert.equal(f.events.at(-1).reason, 'invalid_state');
    assert.doesNotMatch(JSON.stringify(f.events), /private-token|Untrusted|untrusted@example.com/);
});

test('invalid verified identity reports failure without including unverified identity fields', async t => {
    const f = await fixture(t);
    const flow = await f.begin();
    f.payload({ sub: 'user', name: 'Unverified', email: 'unverified@example.com', email_verified: false,
        nonce: flow.url.searchParams.get('nonce') });
    await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    assert.deepEqual(f.events.at(-1), { event: 'sign_in_failed', reason: 'invalid_identity', doNotTrack: false });
});

test('the original login Do Not Track preference is retained for success and sign-out', async t => {
    const f = await fixture(t);
    const flow = await f.begin('/weather.html', 'alice@example.com', { DNT: '1' });
    const callback = await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('gva-session=')).split(';')[0];
    const session = await (await f.request('/api/auth/session', { headers: { Cookie: cookie } })).json();
    await f.request('/auth/logout', { method: 'POST', headers: { Cookie: cookie,
        Origin: f.env.APP_ORIGIN, 'X-CSRF-Token': session.csrfToken } });
    assert.ok(f.events.every(value => value.doNotTrack === true));
    assert.equal(f.events.length, 3);
});

test('throwing, rejecting and stalled analytics cannot block sign-in or sign-out', { timeout: 1500 }, async t => {
    for (const track of [() => { throw new Error('collector failure'); },
        () => Promise.reject(new Error('collector failure')), () => new Promise(() => {})]) {
        const f = await fixture(t, { analytics: { track } });
        const account = await login(f);
        assert.ok(account.session.user);
        assert.equal((await f.request('/auth/logout', { method: 'POST', headers: account.headers })).status, 200);
    }
});
