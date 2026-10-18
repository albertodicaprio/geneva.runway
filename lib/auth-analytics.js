const { isIP } = require('node:net');

const validWebsiteId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const EVENT_PATHS = {
    sign_in_started: '/auth/google',
    sign_in_succeeded: '/auth/google/callback',
    sign_in_cancelled: '/auth/google/callback',
    sign_in_failed: '/auth/google/callback',
    sign_out_succeeded: '/auth/logout'
};
const FAILURE_REASONS = new Set(['not_configured', 'busy', 'invalid_state', 'provider_error',
    'invalid_callback', 'token_exchange', 'token_validation', 'invalid_identity']);

function createAuthAnalytics({ env = process.env, fetchImpl = globalThis.fetch,
    logger = console, clock = Date.now, timeoutMs = 1500, maxPending = 32 } = {}) {
    const website = (env.UMAMI_WEBSITE_ID || '').trim();
    const configuredEndpoint = (env.UMAMI_AUTH_EVENTS_URL || '').trim();
    let endpoint;
    let hostname;
    if (configuredEndpoint && validWebsiteId(website)) {
        try {
            const url = new URL(configuredEndpoint);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
                url.pathname !== '/api/send' || url.search || url.hash) throw new Error('Invalid collector');
            endpoint = url.href;
            hostname = new URL(env.APP_ORIGIN).hostname;
        } catch {
            endpoint = null;
            logger.warn?.('Auth analytics disabled: check UMAMI_AUTH_EVENTS_URL and APP_ORIGIN.');
        }
    }
    let pending = 0;
    let lastWarning = -Infinity;

    function warn() {
        if (clock() - lastWarning >= 60_000) {
            lastWarning = clock();
            logger.warn?.('Could not send auth analytics to Umami; authentication is unaffected.');
        }
    }

    function track(event, req, { name, email, reason, doNotTrack = false } = {}) {
        // No request URLs, cookies, OAuth parameters or arbitrary error objects
        // enter the payload. The endpoint and event paths are server-controlled.
        if (!endpoint || !Object.hasOwn(EVENT_PATHS, event) || req.headers.dnt === '1' ||
            doNotTrack || pending >= maxPending) return;
        const data = { provider: 'google' };
        if (['sign_in_succeeded', 'sign_out_succeeded'].includes(event)) {
            if (typeof name === 'string') data.name = name.slice(0, 200);
            if (typeof email === 'string') data.email = email.slice(0, 320);
        }
        if (event === 'sign_in_failed' && FAILURE_REASONS.has(reason)) data.reason = reason;
        const forwarded = env.UMAMI_AUTH_EVENTS_TRUST_PROXY === 'true'
            ? req.headers['x-forwarded-for']?.split(',').at(-1).trim() : null;
        let ip = (forwarded && isIP(forwarded) ? forwarded : req.socket?.remoteAddress) || '';
        if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
        const payload = { website, hostname, url: EVENT_PATHS[event], name: event, data,
            timestamp: Math.floor(clock() / 1000) };
        if (isIP(ip)) payload.ip = ip;
        const userAgent = req.headers['user-agent'];
        if (!userAgent) return; // Umami requires the actual browser agent for attribution/bot checks.
        pending++;
        // Deliberately not awaited by auth handlers; cap in-flight requests and
        // abort stalled collectors. Failed events are dropped without retries.
        void (async () => {
            try {
                const response = await fetchImpl(endpoint, {
                    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
                    body: JSON.stringify({ type: 'event', payload })
                });
                await response.body?.cancel();
                if (!response.ok) warn();
            } catch {
                warn();
            } finally {
                pending--;
            }
        })();
    }

    return { track };
}

module.exports = { createAuthAnalytics, validWebsiteId };
