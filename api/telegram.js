function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readPreferences(req) {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw Object.assign(new Error('Send alert preferences as JSON.'), { status: 415 });
    }
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) throw Object.assign(new Error('Alert preferences are too large.'), { status: 413 });
    }
    try { return JSON.parse(body); }
    catch { throw Object.assign(new Error('Invalid alert preferences.'), { status: 400 }); }
}

function createTelegramHandler({ auth, telegram }) {
    const routes = {
        '/api/account/telegram': 'GET',
        '/api/account/telegram/connect': 'POST',
        '/api/account/telegram/disconnect': 'POST',
        '/api/account/telegram/test': 'POST',
        '/api/account/telegram/alerts': 'POST',
        '/api/account/telegram/qr': 'GET'
    };
    return async function handle(req, res, url) {
        const method = routes[url.pathname];
        if (!method) return false;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method !== method) {
            res.setHeader('Allow', method);
            json(res, 405, { error: 'Method not allowed' });
            return true;
        }
        try {
            const user = auth.getUser(req);
            if (!user) {
                json(res, 401, { error: 'Sign in to manage Telegram.' });
                return true;
            }
            if (method === 'POST' && !auth.isAccountRequestAuthorized(req)) {
                json(res, 403, { error: 'Please refresh the page and try again.' });
                return true;
            }
            if (url.pathname.endsWith('/alerts')) json(res, 200, await telegram.setAlertPreferences(user.id, await readPreferences(req)));
            else if (url.pathname.endsWith('/connect')) json(res, 200, await telegram.begin(user.id));
            else if (url.pathname.endsWith('/disconnect')) {
                await telegram.disconnect(user.id);
                json(res, 200, { ok: true });
            } else if (url.pathname.endsWith('/test')) {
                await telegram.send(user.id, 'test');
                json(res, 200, { ok: true });
            } else if (url.pathname.endsWith('/qr')) {
                const svg = await telegram.qrCode(user.id);
                res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
                res.end(svg);
            } else json(res, 200, await telegram.status(user.id));
        } catch (error) {
            // Never log upstream errors or connection tokens.
            if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
            json(res, error.status || 503, { error: error.status ? error.message : 'Telegram is temporarily unavailable. Please try again.' });
        }
        return true;
    };
}

module.exports = { createTelegramHandler };
