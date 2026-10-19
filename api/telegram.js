function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readUpdate(req) {
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw Object.assign(new Error('Send JSON.'), { status: 415 });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 16_384) throw Object.assign(new Error('Request is too large.'), { status: 413 });
        chunks.push(chunk);
    }
    let update;
    try { update = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Checked below. */ }
    if (!update || typeof update !== 'object' || Array.isArray(update) || !Number.isSafeInteger(update.update_id)) {
        throw Object.assign(new Error('Invalid Telegram update.'), { status: 400 });
    }
    return update;
}

function createTelegramHandler({ auth, telegram }) {
    const routes = {
        '/api/account/telegram': 'GET',
        '/api/account/telegram/connect': 'POST',
        '/api/account/telegram/disconnect': 'POST',
        '/api/account/telegram/test': 'POST',
        '/api/account/telegram/qr': 'GET',
        '/api/telegram/webhook': 'POST'
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
            if (url.pathname === '/api/telegram/webhook') {
                if (!telegram.validSecret(req.headers['x-telegram-bot-api-secret-token'])) {
                    json(res, 403, { error: 'Forbidden' });
                    return true;
                }
                await telegram.accept(await readUpdate(req));
                json(res, 200, { ok: true });
                return true;
            }
            const user = auth.getUser(req);
            if (!user) {
                json(res, 401, { error: 'Sign in to manage Telegram.' });
                return true;
            }
            if (method === 'POST' && !auth.isAccountRequestAuthorized(req)) {
                json(res, 403, { error: 'Please refresh the page and try again.' });
                return true;
            }
            if (url.pathname.endsWith('/connect')) json(res, 200, await telegram.begin(user.id));
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
            // Never log upstream errors, webhook bodies or connection tokens.
            if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
            json(res, error.status || 503, { error: error.status ? error.message : 'Telegram is temporarily unavailable. Please try again.' });
        }
        return true;
    };
}

module.exports = { createTelegramHandler };
