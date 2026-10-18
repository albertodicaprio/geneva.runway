const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { createAuth } = require('../lib/auth');

async function fixture(t, { enabled = true, secure = false } = {}) {
    let now = Date.now();
    const env = enabled ? {
        APP_ORIGIN: secure ? 'https://gva-runway.ahpc.ch' : 'http://localhost:3000',
        GOOGLE_OAUTH_CLIENT_ID: 'test-client', GOOGLE_OAUTH_CLIENT_SECRET: 'private-secret'
    } : {};
    let payload;
    let exchange;
    let calls = 0;
    const logs = [];
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
    const auth = createAuth({ env, client, clock: () => now, logger: { info: line => logs.push(line) } });
    const server = http.createServer(async (req, res) => {
        if (!await auth.handle(req, res, new URL(req.url, 'http://localhost'))) {
            res.end(JSON.stringify(auth.getUser(req)));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    async function begin(returnTo = '/weather.html') {
        const response = await request(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
        assert.equal(response.status, 303);
        const url = new URL(response.headers.get('location'));
        const cookie = response.headers.getSetCookie()[0].split(';')[0];
        payload = { sub: 'google-user-123', given_name: '<Spotter>', email_verified: true,
            nonce: url.searchParams.get('nonce') };
        return { url, cookie, callback: `/auth/google/callback?code=one-time-code&state=${url.searchParams.get('state')}` };
    }
    return { env, request, begin, logs, advance: ms => { now += ms; }, payload: value => { payload = value; },
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
    assert.deepEqual(session.user, { id: 'google-user-123', name: '<Spotter>' });
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
    await f.request(flow.callback, { headers: { Cookie: flow.cookie } });
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
            email_verified: failure !== 'email', nonce: failure === 'nonce' ? 'forged' : flow.url.searchParams.get('nonce') });
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
    assert.deepEqual(await (await f.request('/api/auth/session')).json(), { enabled: false, user: null, csrfToken: null });
    assert.equal((await f.request('/auth/google')).status, 503);
});

test('production requires HTTPS and an explicit origin without paths or credentials', () => {
    for (const APP_ORIGIN of ['http://gva-runway.ahpc.ch', 'https://gva-runway.ahpc.ch/path', 'https://user:secret@example.com', 'https://example.com/']) {
        assert.throws(() => createAuth({ env: { APP_ORIGIN } }));
    }
});
