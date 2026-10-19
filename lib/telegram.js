const { randomBytes } = require('node:crypto');
const QRCode = require('qrcode');
const { createTelegramStore } = require('./telegram-store');
const { createTelegramClient } = require('./telegram-client');
const { renderNotification } = require('./notification-providers');
const { createTelegramPoller } = require('./telegram-poller');
const { createRunwayAlerts } = require('./runway-alerts');
const { getRunwayArrivals, getBusyArrivals } = require('./aircraft-service');
const { createBusyArrivalAlerts, validThreshold } = require('./busy-arrival-alerts');

const { createTelegramTelemetry } = require('./telegram-telemetry');

const LINK_MS = 10 * 60_000;
function problem(status, message, retryAfter = 0) {
    return Object.assign(new Error(message), { status, retryAfter });
}

function telegramConfig(env) {
    const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
    const username = (env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
    const any = Boolean(token || username);
    const enabled = /^\d+:[A-Za-z0-9_-]+$/.test(token) && /^[A-Za-z0-9_]{5,32}$/.test(username) &&
        username.toLowerCase().endsWith('bot');
    return { token, username, enabled, any };
}

function createTelegram({ env = process.env, clock = Date.now, logger = console, analytics,
    store = createTelegramStore({ filePath: env.TELEGRAM_CONNECTIONS_FILE }), client, arrivals = getRunwayArrivals, busyArrivals = getBusyArrivals,
    qr = url => QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 240 }) } = {}) {
    const config = telegramConfig(env);
    const telegram = client || createTelegramClient({ token: config.token });
    const telemetry = createTelegramTelemetry({ client: telegram, analytics, logger, clock });
    if (config.any && !config.enabled) logger.warn?.('Telegram disabled: check TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME.');
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
    function preferences(connection) {
        return { predictedRunwayChanges: connection?.alerts?.predictedRunwayChanges === true,
            busyArrivals: connection?.alerts?.busyArrivals === true,
            busyArrivalThreshold: connection?.alerts?.busyArrivalThreshold ?? 10 };
    }
    async function status(userId, analyticsContext) {
        if (!config.enabled) return { enabled: false, connection: null };
        return run(async () => {
            prune();
            const connection = (await store.read()).accounts[userId];
            if (connection && analyticsContext && JSON.stringify(connection.analyticsContext) !== JSON.stringify(analyticsContext)) {
                await store.update(accounts => { accounts[userId].analyticsContext = analyticsContext; });
                connection.analyticsContext = analyticsContext;
            }
            const link = pending.get(userId);
            return { enabled: true, connection: summary(connection),
                alerts: preferences(connection),
                linkError: link?.error || null, expiresAt: link?.expiresAt || null };
        });
    }
    function begin(userId, analyticsContext) {
        requireEnabled();
        return run(async () => {
            prune();
            if (Object.hasOwn((await store.read()).accounts, userId)) throw problem(409, 'Disconnect your existing Telegram account first.');
            if (!pending.has(userId) && pending.size >= 1000) throw problem(503, 'Telegram linking is busy. Please try again later.');
            const link = { analyticsContext, token: randomBytes(32).toString('base64url'), expiresAt: clock() + LINK_MS };
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
    function disconnect(userId, analyticsContext) {
        return run(async () => {
            let connection;
            await store.update(accounts => { connection = accounts[userId]; delete accounts[userId]; });
            pending.delete(userId);
            if (connection) telemetry.report('telegram_disconnected', userId,
                { ...connection, analyticsContext: analyticsContext || connection.analyticsContext });
        });
    }
    function setAlertPreferences(userId, update) {
        requireEnabled();
        if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).length === 0 ||
            Object.entries(update).some(([key, value]) => !['predictedRunwayChanges', 'busyArrivals', 'busyArrivalThreshold'].includes(key) ||
                (key === 'busyArrivalThreshold' ? !validThreshold(value) : typeof value !== 'boolean'))) {
            throw problem(400, 'Choose valid alert switches and a busy arrival threshold from 1 to 100.');
        }
        return run(async () => {
            await store.update(accounts => {
                const connection = accounts[userId];
                if (!connection) throw problem(409, 'Connect Telegram before configuring alerts.');
                if (connection.blocked && Object.values(update).some(value => value === true)) throw problem(409, 'Reconnect Telegram before enabling alerts.');
                if (Object.hasOwn(update, 'predictedRunwayChanges') &&
                    (connection.alerts?.predictedRunwayChanges === true) !== update.predictedRunwayChanges) delete connection.runwayAlert;
                if ((Object.hasOwn(update, 'busyArrivals') && (connection.alerts?.busyArrivals === true) !== update.busyArrivals) ||
                    (Object.hasOwn(update, 'busyArrivalThreshold') && (connection.alerts?.busyArrivalThreshold ?? 10) !== update.busyArrivalThreshold)) {
                    delete connection.busyAlert;
                }
                connection.alerts = { ...connection.alerts, ...update };
            });
            return { alerts: preferences((await store.read()).accounts[userId]) };
        });
    }
    function accept(update) {
        requireEnabled();
        return run(async () => {
            prune();
            const message = update?.message;
            const token = typeof message?.text === 'string' ? /^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text)?.[1] : null;
            if (!token || message.chat?.type !== 'private' || message.from?.is_bot !== false ||
                !Number.isSafeInteger(message.from.id) || message.from.id <= 0 || message.chat.id !== message.from.id) return false;
            const match = [...pending].find(([, link]) => !link.error && link.token === token);
            if (!match) return false; // Includes duplicate updates after successful linking.
            const [userId, link] = match;
            const chatId = String(message.chat.id);
            let conflict = false;
            let linkedConnection;
            await store.update(accounts => {
                if (Object.hasOwn(accounts, userId) || Object.values(accounts).some(item => item.chatId === chatId)) {
                    conflict = true;
                    return;
                }
                accounts[userId] = linkedConnection = { chatId, userId: chatId,
                    name: [message.from.first_name, message.from.last_name].filter(value => typeof value === 'string').join(' ').slice(0, 200) || 'Telegram user',
                    username: typeof message.from.username === 'string' ? message.from.username.slice(0, 100) : null,
                    connectedAt: clock(), ...(link.analyticsContext ? { analyticsContext: link.analyticsContext } : {}) };
            });
            if (conflict) link.error = 'This Telegram account is already connected. Disconnect it from the other website account first.';
            else {
                pending.delete(userId);
                telemetry.report('telegram_connected', userId, linkedConnection);
            }
            return true;
        });
    }
    function send(userId, type = 'test', analyticsContext) {
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
            await store.update(accounts => {
                accounts[userId].nextSendAt = clock() + 10_000;
                if (analyticsContext) accounts[userId].analyticsContext = analyticsContext;
            });
            try { await telemetry.send({ accountId: userId, connection: { ...connection,
                analyticsContext: analyticsContext || connection.analyticsContext }, type, text }); }
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
    const poller = createTelegramPoller({ client: telegram, username: config.username, store, onUpdate: accept, logger });
    const runwayAlerts = createRunwayAlerts({ store, client: telegram, arrivals, serialize: run, clock, logger, sendNotification: telemetry.send });
    const busyAlerts = createBusyArrivalAlerts({ store, client: telegram, arrivals: busyArrivals, serialize: run, clock, logger, sendNotification: telemetry.send });
    return { status, begin, qrCode, disconnect, accept, send, setAlertPreferences,
        startAlertScheduler: () => { if (config.enabled) { runwayAlerts.start(); busyAlerts.start(); } },
        stopAlertScheduler: () => Promise.all([runwayAlerts.stop(), busyAlerts.stop()]),
        startPolling: () => config.enabled ? poller.start() : Promise.resolve(),
        stopPolling: () => poller.stop() };
}

module.exports = { createTelegram, telegramConfig };
