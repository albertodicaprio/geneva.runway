const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { validBusyAlert, validThreshold } = require('./busy-arrival-alerts');
const { validHoldingAlert } = require('./holding-arrival-alerts');
const { validRunwayAlert } = require('./runway-alerts');

// One app instance owns this file. Re-read on each transaction and replace
// atomically, so failed writes never erase previously saved connections.
function createTelegramStore({ filePath = process.env.TELEGRAM_CONNECTIONS_FILE ||
    path.join(__dirname, '..', 'data', 'telegram-connections.json'), storage = fs } = {}) {
    let pending = Promise.resolve();
    async function read() {
        let contents;
        try { contents = await storage.readFile(filePath, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return { version: 1, accounts: {} }; throw error; }
        const data = JSON.parse(contents);
        if (data?.version !== 1 || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) {
            throw new Error('Invalid Telegram connections file');
        }
        if (data.polling !== undefined && (!data.polling || typeof data.polling.botId !== 'string' ||
            !/^\d+$/.test(data.polling.botId) || !Number.isSafeInteger(data.polling.nextUpdateId) || data.polling.nextUpdateId < 0)) {
            throw new Error('Invalid Telegram polling cursor');
        }
        const chats = new Set();
        for (const connection of Object.values(data.accounts)) {
            if (!connection || !/^\d+$/.test(connection.chatId) || typeof connection.chatId !== 'string' ||
                connection.userId !== connection.chatId || !Number.isFinite(connection.connectedAt) ||
                typeof connection.name !== 'string' ||
                (connection.username !== null && typeof connection.username !== 'string') ||
                (connection.nextSendAt !== undefined && !Number.isFinite(connection.nextSendAt)) ||
                (connection.blocked !== undefined && typeof connection.blocked !== 'boolean') ||
                chats.has(connection.chatId)) throw new Error('Invalid Telegram connection');
            const context = connection.analyticsContext;
            if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context) ||
                typeof context.doNotTrack !== 'boolean' || typeof context.userAgent !== 'string' || context.userAgent.length > 1000 ||
                (context.name !== undefined && (typeof context.name !== 'string' || context.name.length > 200)) ||
                (context.email !== undefined && (typeof context.email !== 'string' || context.email.length > 320)))) {
                throw new Error('Invalid Telegram analytics context');
            }
            if (connection.alerts !== undefined && (!connection.alerts || typeof connection.alerts !== 'object' ||
                Array.isArray(connection.alerts) || (connection.alerts.predictedRunwayChanges !== undefined &&
                    typeof connection.alerts.predictedRunwayChanges !== 'boolean') ||
                    (connection.alerts.holdingArrivals !== undefined && typeof connection.alerts.holdingArrivals !== 'boolean') ||
                    (connection.alerts.busyArrivals !== undefined && typeof connection.alerts.busyArrivals !== 'boolean') ||
                    (connection.alerts.busyArrivalThreshold !== undefined && !validThreshold(connection.alerts.busyArrivalThreshold)))) throw new Error('Invalid Telegram alert preferences');
            if (connection.runwayAlert !== undefined && !validRunwayAlert(connection.runwayAlert)) throw new Error('Invalid Telegram runway alert');
            if (connection.busyAlert !== undefined && !validBusyAlert(connection.busyAlert)) throw new Error('Invalid Telegram busy arrival alert');
            if (connection.holdingAlert !== undefined && !validHoldingAlert(connection.holdingAlert)) throw new Error('Invalid Telegram holding arrival alert');
            chats.add(connection.chatId);
        }
        return data;
    }
    function update(change) {
        const write = pending.then(async () => {
            const data = await read();
            const result = change(data.accounts, data);
            await storage.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
            const temporary = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
            try {
                await storage.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
                await storage.rename(temporary, filePath);
            } finally { await storage.unlink(temporary).catch(() => {}); }
            return result;
        });
        pending = write.catch(() => {});
        return write;
    }
    return { read: async () => { await pending; return read(); }, update };
}

module.exports = { createTelegramStore };
