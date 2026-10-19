const { setTimeout: pause } = require('node:timers/promises');
const { TelegramError } = require('./telegram-client');

function createTelegramPoller({ client, username, store, onUpdate, logger = console,
    sleep = (ms, signal) => pause(ms, undefined, { signal }) }) {
    let controller;
    let task;

    async function loop(signal) {
        let botId;
        let nextUpdateId = 0;
        let failures = 0;
        while (!signal.aborted) {
            try {
                if (!botId) {
                    const identity = await client.request('getMe', {}, { signal });
                    if (signal.aborted) return;
                    if (!Number.isSafeInteger(identity?.id) || identity.id <= 0 || identity.is_bot !== true ||
                        identity.username?.toLowerCase() !== username.toLowerCase()) {
                        throw new TelegramError('identity');
                    }
                    const saved = await store.read();
                    botId = String(identity.id);
                    nextUpdateId = saved.polling?.botId === botId ? saved.polling.nextUpdateId : 0;
                    logger.info?.('Telegram polling started.');
                }
                const updates = await client.request('getUpdates', {
                    offset: nextUpdateId, limit: 100, timeout: 30, allowed_updates: ['message']
                }, { signal, timeout: 40_000 });
                if (signal.aborted) return;
                if (!Array.isArray(updates) || updates.length > 100 || updates.some(update =>
                    !Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER)) {
                    throw new TelegramError('invalid_response');
                }
                for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
                    if (signal.aborted) return;
                    if (update.update_id < nextUpdateId) continue;
                    const handled = await onUpdate(update);
                    // Do not acknowledge an event until its effects and cursor
                    // are durable. Retrying a consumed linking token is harmless.
                    const next = update.update_id + 1;
                    await store.update((_accounts, data) => { data.polling = { botId, nextUpdateId: next }; });
                    nextUpdateId = next;
                    if (!handled) {
                        // Fixed fields only: no text, command arguments, names,
                        // chat IDs, tokens or attachment content enter the log.
                        const message = update.message;
                        const kind = !message ? 'other' : typeof message.text !== 'string' ? 'attachment' :
                            message.text.startsWith('/') ? 'command' : 'message';
                        logger.info?.(JSON.stringify({ event: 'telegram_update_ignored', updateId: update.update_id, kind }));
                    }
                }
                failures = 0;
            } catch (error) {
                if (signal.aborted) return;
                if (['identity', 401, 404, 409].includes(error.code)) {
                    logger.warn?.(error.code === 409
                        ? 'Telegram polling stopped: this bot is in use by another receiver. Run one app instance per bot.'
                        : 'Telegram polling stopped: check TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME, then restart the app.');
                    return;
                }
                const retryAfter = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 0;
                const delay = Math.max(Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000), retryAfter * 1000);
                logger.warn?.(`Telegram polling failed; retrying in ${Math.ceil(delay / 1000)} seconds.`);
                try { await sleep(delay, signal); } catch { if (signal.aborted) return; throw new Error('Telegram polling delay failed'); }
            }
        }
    }
    function start() {
        if (task) return task;
        controller = new AbortController();
        task = loop(controller.signal).catch(() => {
            logger.warn?.('Telegram polling stopped unexpectedly; restart the app.');
        }).finally(() => { task = null; });
        return task;
    }
    async function stop() {
        controller?.abort();
        await task;
    }
    return { start, stop };
}

module.exports = { createTelegramPoller };
