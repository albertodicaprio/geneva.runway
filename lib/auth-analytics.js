const { isIP } = require('node:net');

const validWebsiteId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const EVENT_PATHS = {
    sign_in_started: '/auth/google',
    sign_in_succeeded: '/auth/google/callback',
    sign_in_cancelled: '/auth/google/callback',
    sign_in_failed: '/auth/google/callback',
    sign_out_succeeded: '/auth/logout'
};
const TELEGRAM_EVENT_PATHS = {
    telegram_connected: '/api/account/telegram/connect',
    telegram_disconnected: '/api/account/telegram/disconnect',
    telegram_test_sent: '/api/account/telegram/test',
    telegram_runway_change_sent: '/api/account/telegram/alerts',
    telegram_busy_arrivals_sent: '/api/account/telegram/alerts',
    telegram_holding_arrivals_sent: '/api/account/telegram/alerts',
    telegram_go_around_sent: '/api/account/telegram/alerts'
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
            logger.warn?.('Server analytics disabled: check UMAMI_AUTH_EVENTS_URL and APP_ORIGIN.');
        }
    }
    let pending = 0;
    let lastWarning = -Infinity;

    function warn() {
        if (clock() - lastWarning >= 60_000) {
            lastWarning = clock();
            logger.warn?.('Could not send server analytics to Umami; app operation is unaffected.');
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
        deliver(payload, userAgent);
    }

    function trackTelegram(event, { accountId, connection, notificationType } = {}) {
        const context = connection?.analyticsContext;
        if (!endpoint || !Object.hasOwn(TELEGRAM_EVENT_PATHS, event) || !context ||
            context.doNotTrack !== false || !context.userAgent || pending >= maxPending) return;
        const data = { provider: 'telegram', source: 'server' };
        const fields = { accountId, name: context.name, email: context.email,
            telegramName: connection.name, telegramUsername: connection.username };
        for (const [key, value] of Object.entries(fields)) {
            if (typeof value === 'string') data[key] = value.slice(0, 320);
        }
        if (['test', 'arrivalRunwayChange', 'busyArrivals', 'holdingArrivals', 'goArounds'].includes(notificationType)) data.notificationType = notificationType;
        // Background notifications have no current browser request. Reuse only
        // the saved browser agent, never an old IP address or request headers.
        deliver({ website, hostname, url: TELEGRAM_EVENT_PATHS[event], name: event, data,
            timestamp: Math.floor(clock() / 1000) }, context.userAgent);
    }

    function deliver(payload, userAgent) {
        pending++;
        // Deliberately not awaited by request handlers or notification delivery; cap in-flight requests and
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

    return { track, trackTelegram };
}

module.exports = { createAuthAnalytics, validWebsiteId };
