const { randomBytes, createHash } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { createUserSettings } = require('./user-settings');

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FLOW_MS = 10 * 60 * 1000;
const RETURN_PATHS = new Set(['/', '/index.html', '/arrivals.html', '/stats.html', '/weather.html']);
const randomToken = () => randomBytes(32).toString('base64url');

function createAuth({ env = process.env, clock = Date.now, client, logger = console,
    analytics = { track() {} },
    settings = createUserSettings({ filePath: env.USER_SETTINGS_FILE }) } = {}) {
    const clientId = (env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
    const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
    const configuredOrigin = (env.APP_ORIGIN || '').trim();
    let origin;
    if (configuredOrigin) {
        const url = new URL(configuredOrigin);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((configuredOrigin !== url.origin && configuredOrigin !== `${url.origin}/`) || url.username || url.password ||
            (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
            throw new Error('APP_ORIGIN must be the website origin only (for example, https://gva-runway.ahpc.ch), without /auth/google/callback or any other path, query or fragment. HTTPS is required except on localhost.');
        }
        origin = url.origin;
    }
    const enabled = Boolean(clientId && clientSecret && origin);
    if (!enabled && (clientId || clientSecret || origin)) {
        console.warn('Google sign-in disabled: set APP_ORIGIN, GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
    }
    const oauth = enabled ? client || new OAuth2Client({
        clientId, clientSecret, redirectUri: `${origin}/auth/google/callback`,
        transporterOptions: { timeout: 8000, retry: false }
    }) : null;
    const secure = origin?.startsWith('https:');
    const sessionCookie = secure ? '__Host-gva-session' : 'gva-session';
    const flowCookie = secure ? '__Host-gva-login' : 'gva-login';
    const sessions = new Map();
    const flows = new Map();

    function report(event, req, data) {
        try {
            Promise.resolve(analytics.track(event, req, data)).catch(() => {});
        } catch {
            // Observability must never alter an authentication response.
        }
    }

    function prune(map) {
        for (const [key, value] of map) if (value.expires <= clock()) map.delete(key);
    }

    function cookie(req, name) {
        return (req.headers.cookie || '').split(';').map(value => value.trim())
            .find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
    }

    function setCookie(res, name, value, maxAge) {
        const valueString = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
        const existing = res.getHeader('Set-Cookie') || [];
        res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [existing]), valueString]);
    }

    function getSession(req) {
        prune(sessions);
        return sessions.get(cookie(req, sessionCookie)) || null;
    }

    async function getSettings(req) {
        const session = getSession(req);
        if (!session) return null;
        try {
            const saved = await settings.get(session.email);
            return { theme: saved.theme };
        } catch {
            logger.warn?.('Could not read account settings; the saved file has been preserved.');
            return { theme: null, unavailable: true };
        }
    }

    function redirect(res, location) {
        res.writeHead(303, { Location: location });
        res.end();
    }

    function json(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
    }

    async function handle(req, res, url) {
        const pathname = url.pathname;
        if (!['/api/auth/session', '/api/account/settings', '/auth/google', '/auth/google/callback', '/auth/logout'].includes(pathname)) return false;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const method = pathname === '/auth/logout' ? 'POST' : pathname === '/api/account/settings' ? 'PATCH' : 'GET';
        if (req.method !== method) {
            res.setHeader('Allow', method);
            json(res, 405, { error: 'Method not allowed' });
            return true;
        }
        if (pathname === '/api/auth/session') {
            const session = getSession(req);
            json(res, 200, { enabled, user: session?.user || null, csrfToken: session?.csrfToken || null,
                settings: await getSettings(req) });
            return true;
        }
        if (pathname === '/api/account/settings') {
            const session = getSession(req);
            if (!session) {
                json(res, 401, { error: 'Sign in to save your settings.' });
                return true;
            }
            if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== session.csrfToken) {
                json(res, 403, { error: 'Please refresh the page and try again.' });
                return true;
            }
            if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
                json(res, 415, { error: 'Send settings as JSON.' });
                return true;
            }
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (Buffer.byteLength(body) > 1024) {
                    json(res, 413, { error: 'Settings request is too large.' });
                    return true;
                }
            }
            let update;
            try { update = JSON.parse(body); } catch { /* Validated below. */ }
            if (!update || Object.keys(update).length !== 1 || !['auto', 'night', 'day'].includes(update.theme)) {
                json(res, 400, { error: 'Choose Auto, Night or Day.' });
                return true;
            }
            try {
                const saved = await settings.setTheme(session.email, update.theme);
                json(res, 200, { settings: saved });
            } catch {
                json(res, 503, { error: 'Could not save settings. Please try again.' });
            }
            return true;
        }
        if (!enabled) {
            if (pathname !== '/auth/logout') report('sign_in_failed', req, { reason: 'not_configured' });
            json(res, 503, { error: 'Google sign-in is not configured yet.' });
            return true;
        }
        if (pathname === '/auth/google') {
            prune(flows);
            if (flows.size >= 1000) {
                report('sign_in_failed', req, { reason: 'busy' });
                json(res, 503, { error: 'Sign-in is busy. Please try again later.' });
                return true;
            }
            const state = randomToken();
            const verifier = randomToken();
            const nonce = randomToken();
            const returnTo = RETURN_PATHS.has(url.searchParams.get('returnTo')) ? url.searchParams.get('returnTo') : '/';
            flows.delete(cookie(req, flowCookie));
            const doNotTrack = req.headers.dnt === '1';
            flows.set(state, { verifier, nonce, returnTo, doNotTrack, expires: clock() + FLOW_MS });
            setCookie(res, flowCookie, state, FLOW_MS / 1000);
            redirect(res, oauth.generateAuthUrl({
                scope: ['openid', 'profile', 'email'], state, nonce,
                code_challenge: createHash('sha256').update(verifier).digest('base64url'),
                code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account'
            }));
            report('sign_in_started', req, { doNotTrack });
            return true;
        }
        if (pathname === '/auth/logout') {
            const session = getSession(req);
            if (req.headers.origin !== origin || !session || req.headers['x-csrf-token'] !== session.csrfToken) {
                json(res, 403, { error: 'Please refresh the page and try signing out again.' });
                return true;
            }
            sessions.delete(cookie(req, sessionCookie));
            setCookie(res, sessionCookie, '', 0);
            json(res, 200, { user: null });
            report('sign_out_succeeded', req, { name: session.fullName, email: session.email,
                doNotTrack: session.doNotTrack });
            return true;
        }

        prune(flows);
        const state = url.searchParams.get('state');
        const flow = flows.get(state);
        if (!flow || cookie(req, flowCookie) !== state) {
            report('sign_in_failed', req, { reason: 'invalid_state', doNotTrack: flow?.doNotTrack });
            redirect(res, '/?auth=expired');
            return true;
        }
        flows.delete(state); // Every callback consumes the login attempt, including cancellation.
        setCookie(res, flowCookie, '', 0);
        if (url.searchParams.has('error')) {
            const cancelled = url.searchParams.get('error') === 'access_denied';
            report(cancelled ? 'sign_in_cancelled' : 'sign_in_failed', req,
                { reason: 'provider_error', doNotTrack: flow.doNotTrack });
            redirect(res, `${flow.returnTo}?auth=${cancelled ? 'cancelled' : 'failed'}`);
            return true;
        }
        let failureReason = 'invalid_callback';
        try {
            const code = url.searchParams.get('code');
            if (!code || code.length > 4096) throw new Error('Missing authorization code');
            failureReason = 'token_exchange';
            const { tokens } = await oauth.getToken({ code, codeVerifier: flow.verifier });
            failureReason = 'token_validation';
            const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
            const identity = ticket.getPayload();
            failureReason = 'invalid_identity';
            if (!identity?.sub || identity.nonce !== flow.nonce || identity.email_verified !== true ||
                typeof identity.email !== 'string' || !identity.email.includes('@')) {
                throw new Error('Invalid Google identity');
            }
            prune(sessions);
            failureReason = 'busy';
            if (sessions.size >= 10000) throw new Error('Session capacity exceeded');
            // Google tokens are discarded. Only an opaque session ID goes to the browser.
            const id = randomToken();
            const fullName = String(identity.name || identity.given_name || 'Spotter').slice(0, 200);
            const doNotTrack = flow.doNotTrack || req.headers.dnt === '1';
            sessions.delete(cookie(req, sessionCookie));
            sessions.set(id, {
                user: { id: identity.sub, name: String(identity.given_name || identity.name || 'Spotter').slice(0, 100),
                    fullName, email: identity.email.trim().toLowerCase() },
                email: identity.email.trim().toLowerCase(),
                fullName, doNotTrack,
                csrfToken: randomToken(), expires: clock() + SESSION_MS
            });
            setCookie(res, sessionCookie, id, SESSION_MS / 1000);
            logger.info(JSON.stringify({
                event: 'google_sign_in',
                timestamp: new Date(clock()).toISOString(),
                name: fullName,
                email: identity.email || null
            }));
            redirect(res, flow.returnTo);
            report('sign_in_succeeded', req, { name: fullName, email: identity.email.trim().toLowerCase(), doNotTrack });
        } catch {
            // OAuth errors can contain tokens/client secrets; never log the upstream error.
            redirect(res, `${flow.returnTo}?auth=failed`);
            report('sign_in_failed', req, { reason: failureReason, doNotTrack: flow.doNotTrack });
        }
        return true;
    }

    return { handle, getSettings, getUser: req => getSession(req)?.user || null,
        getAnalyticsContext(req) {
            const session = getSession(req);
            return { doNotTrack: req.headers.dnt === '1' || session?.doNotTrack === true,
                userAgent: String(req.headers['user-agent'] || '').slice(0, 1000),
                name: session?.user.fullName, email: session?.user.email };
        },
        isAccountRequestAuthorized(req) {
            const session = getSession(req);
            return Boolean(session && req.headers.origin === origin && req.headers['x-csrf-token'] === session.csrfToken);
        } };
}

module.exports = { createAuth };
