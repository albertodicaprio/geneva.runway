const { randomBytes, createHash } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FLOW_MS = 10 * 60 * 1000;
const RETURN_PATHS = new Set(['/', '/index.html', '/arrivals.html', '/stats.html', '/weather.html']);
const randomToken = () => randomBytes(32).toString('base64url');

function createAuth({ env = process.env, clock = Date.now, client, logger = console } = {}) {
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
        if (!['/api/auth/session', '/auth/google', '/auth/google/callback', '/auth/logout'].includes(pathname)) return false;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const method = pathname === '/auth/logout' ? 'POST' : 'GET';
        if (req.method !== method) {
            res.setHeader('Allow', method);
            json(res, 405, { error: 'Method not allowed' });
            return true;
        }
        if (pathname === '/api/auth/session') {
            const session = getSession(req);
            json(res, 200, { enabled, user: session?.user || null, csrfToken: session?.csrfToken || null });
            return true;
        }
        if (!enabled) {
            json(res, 503, { error: 'Google sign-in is not configured yet.' });
            return true;
        }
        if (pathname === '/auth/google') {
            prune(flows);
            if (flows.size >= 1000) {
                json(res, 503, { error: 'Sign-in is busy. Please try again later.' });
                return true;
            }
            const state = randomToken();
            const verifier = randomToken();
            const nonce = randomToken();
            const returnTo = RETURN_PATHS.has(url.searchParams.get('returnTo')) ? url.searchParams.get('returnTo') : '/';
            flows.delete(cookie(req, flowCookie));
            flows.set(state, { verifier, nonce, returnTo, expires: clock() + FLOW_MS });
            setCookie(res, flowCookie, state, FLOW_MS / 1000);
            redirect(res, oauth.generateAuthUrl({
                scope: ['openid', 'profile', 'email'], state, nonce,
                code_challenge: createHash('sha256').update(verifier).digest('base64url'),
                code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account'
            }));
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
            return true;
        }

        prune(flows);
        const state = url.searchParams.get('state');
        const flow = flows.get(state);
        if (!flow || cookie(req, flowCookie) !== state) {
            redirect(res, '/?auth=expired');
            return true;
        }
        flows.delete(state); // Every callback consumes the login attempt, including cancellation.
        setCookie(res, flowCookie, '', 0);
        if (url.searchParams.has('error')) {
            redirect(res, `${flow.returnTo}?auth=cancelled`);
            return true;
        }
        try {
            const code = url.searchParams.get('code');
            if (!code || code.length > 4096) throw new Error('Missing authorization code');
            const { tokens } = await oauth.getToken({ code, codeVerifier: flow.verifier });
            const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
            const identity = ticket.getPayload();
            if (!identity?.sub || identity.nonce !== flow.nonce || identity.email_verified !== true) {
                throw new Error('Invalid Google identity');
            }
            prune(sessions);
            if (sessions.size >= 10000) throw new Error('Session capacity exceeded');
            // Google tokens are discarded. Only an opaque session ID goes to the browser.
            const id = randomToken();
            sessions.delete(cookie(req, sessionCookie));
            sessions.set(id, {
                user: { id: identity.sub, name: String(identity.given_name || identity.name || 'Spotter').slice(0, 100) },
                csrfToken: randomToken(), expires: clock() + SESSION_MS
            });
            setCookie(res, sessionCookie, id, SESSION_MS / 1000);
            logger.info(JSON.stringify({
                event: 'google_sign_in',
                timestamp: new Date(clock()).toISOString(),
                name: String(identity.name || identity.given_name || 'Spotter').slice(0, 200),
                email: identity.email || null
            }));
            redirect(res, flow.returnTo);
        } catch {
            // OAuth errors can contain tokens/client secrets; never log the upstream error.
            redirect(res, `${flow.returnTo}?auth=failed`);
        }
        return true;
    }

    return { handle, getUser: req => getSession(req)?.user || null };
}

module.exports = { createAuth };
