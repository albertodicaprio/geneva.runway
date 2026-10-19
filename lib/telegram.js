const { randomBytes, timingSafeEqual } = require('node:crypto');
const QRCode = require('qrcode');
const { createTelegramStore } = require('./telegram-store');
const { createTelegramClient } = require('./telegram-client');
const { renderNotification } = require('./notification-providers');

const LINK_MS = 10 * 60_000;
function problem(status, message, retryAfter = 0) {
    return Object.assign(new Error(message), { status, retryAfter });
}

function telegramConfig(env) {
    const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
    const username = (env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
    const secret = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    const any = Boolean(token || username || secret);
    const enabled = /^\d+:[A-Za-z0-9_-]+$/.test(token) && /^[A-Za-z0-9_]{5,32}$/.test(username) &&
        username.toLowerCase().endsWith('bot') && /^[A-Za-z0-9_-]{32,256}$/.test(secret);
    return { token, username, secret, enabled, any };
}

function createTelegram({ env = process.env, clock = Date.now, logger = console,
    store = createTelegramStore({ filePath: env.TELEGRAM_CONNECTIONS_FILE }), client,
    qr = url => QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 240 }) } = {}) {
    const config = telegramConfig(env);
    const telegram = client || createTelegramClient({ token: config.token });
    if (config.any && !config.enabled) logger.warn?.('Telegram disabled: check TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET.');
    const pending = new Map();
    let queue = Promise.resolve();
    // Serialize connection changes with test delivery so disconnect cannot race
    // with a send and two accounts cannot claim the same Telegram identity.
    function run(action) {
        const result = queue.then(action);
        queue = result.catch(() => {});
        return result;
    }
    function prune() {
        for (const [id, link] of pending) if (link.expiresAt <= clock()) pending.delete(id);
    }
    function summary(connection) {
        return connection ? { name: connection.name, username: connection.username,
            connectedAt: connection.connectedAt, blocked: Boolean(connection.blocked) } : null;
    }
    function requireEnabled() {
        if (!config.enabled) throw problem(503, 'Telegram integration is not configured yet.');
    }
    async function status(userId) {
        if (!config.enabled) return { enabled: false, connection: null };
        return run(async () => {
            prune();
            const connection = (await store.read()).accounts[userId];
            const link = pending.get(userId);
            return { enabled: true, connection: summary(connection),
                linkError: link?.error || null, expiresAt: link?.expiresAt || null };
        });
    }
    function begin(userId) {
        requireEnabled();
        return run(async () => {
            prune();
            if (Object.hasOwn((await store.read()).accounts, userId)) throw problem(409, 'Disconnect your existing Telegram account first.');
            if (!pending.has(userId) && pending.size >= 1000) throw problem(503, 'Telegram linking is busy. Please try again later.');
            const link = { token: randomBytes(32).toString('base64url'), expiresAt: clock() + LINK_MS };
            pending.set(userId, link);
            return { url: `https://t.me/${config.username}?start=${link.token}`, expiresAt: link.expiresAt };
        });
    }
    function qrCode(userId) {
        requireEnabled();
        return run(async () => {
            prune();
            const link = pending.get(userId);
            if (!link || link.error) throw problem(410, 'Connection link expired. Click Connect to create a new one.');
            return qr(`https://t.me/${config.username}?start=${link.token}`);
        });
    }
    function disconnect(userId) {
        return run(async () => {
            await store.update(accounts => { delete accounts[userId]; });
            pending.delete(userId);
        });
    }
    function accept(update) {
        requireEnabled();
        return run(async () => {
            prune();
            const message = update?.message;
            const token = typeof message?.text === 'string' ? /^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text)?.[1] : null;
            if (!token || message.chat?.type !== 'private' || message.from?.is_bot !== false ||
                !Number.isSafeInteger(message.from.id) || message.from.id <= 0 || message.chat.id !== message.from.id) return;
            const match = [...pending].find(([, link]) => !link.error && link.token === token);
            if (!match) return; // Includes duplicate updates after successful linking.
            const [userId, link] = match;
            const chatId = String(message.chat.id);
            let conflict = false;
            await store.update(accounts => {
                if (Object.hasOwn(accounts, userId) || Object.values(accounts).some(item => item.chatId === chatId)) {
                    conflict = true;
                    return;
                }
                accounts[userId] = { chatId, userId: chatId,
                    name: [message.from.first_name, message.from.last_name].filter(value => typeof value === 'string').join(' ').slice(0, 200) || 'Telegram user',
                    username: typeof message.from.username === 'string' ? message.from.username.slice(0, 100) : null,
                    connectedAt: clock() };
            });
            if (conflict) link.error = 'This Telegram account is already connected. Disconnect it from the other website account first.';
            else pending.delete(userId);
        });
    }
    function send(userId, type = 'test') {
        requireEnabled();
        const text = renderNotification(type);
        return run(async () => {
            const connection = (await store.read()).accounts[userId];
            if (!connection) throw problem(409, 'Connect Telegram before sending a test message.');
            if (connection.blocked) throw problem(409, 'Unblock the bot in Telegram, then disconnect and reconnect here.');
            const wait = Math.ceil(((connection.nextSendAt || 0) - clock()) / 1000);
            if (wait > 0) throw problem(429, `Please wait ${wait} seconds before sending another test.`, wait);
            // Record the attempt before sending: a timeout may mean Telegram
            // accepted the message. Test messages are never retried automatically.
            await store.update(accounts => { accounts[userId].nextSendAt = clock() + 10_000; });
            try { await telegram.sendMessage(connection.chatId, text); }
            catch (error) {
                if (error.code === 403) {
                    await store.update(accounts => { accounts[userId].blocked = true; });
                    throw problem(409, 'Telegram cannot deliver to this account. Unblock the bot, then disconnect and reconnect here.');
                }
                if (error.code === 429) {
                    const retry = error.retryAfter || 30;
                    await store.update(accounts => { accounts[userId].nextSendAt = clock() + retry * 1000; });
                    throw problem(429, `Telegram is busy. Please try again in ${retry} seconds.`, retry);
                }
                throw problem(503, 'Could not confirm delivery. Check Telegram before trying again.');
            }
        });
    }
    function validSecret(value) {
        if (!config.enabled || typeof value !== 'string') return false;
        const expected = Buffer.from(config.secret);
        const actual = Buffer.from(value);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    return { status, begin, qrCode, disconnect, accept, send, validSecret };
}

module.exports = { createTelegram, telegramConfig };
