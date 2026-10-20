const SENT_EVENTS = Object.freeze({ test: 'telegram_test_sent',
    arrivalRunwayChange: 'telegram_runway_change_sent', busyArrivals: 'telegram_busy_arrivals_sent', holdingArrivals: 'telegram_holding_arrivals_sent' });

function createTelegramTelemetry({ client, analytics, logger = console, clock = Date.now } = {}) {
    function log(event, accountId, connection, details = {}) {
        // Explicit fields only. JSON escaping keeps names/messages on one log line.
        try {
            logger.info?.(JSON.stringify({ event, timestamp: new Date(clock()).toISOString(), accountId,
                name: connection.analyticsContext?.name || null, email: connection.analyticsContext?.email || null,
                telegramName: connection.name, telegramUsername: connection.username, ...details }));
        } catch { /* Observability must not change delivery or linking outcomes. */ }
    }
    function report(event, accountId, connection, notificationType) {
        try {
            Promise.resolve(analytics?.trackTelegram(event, { accountId, connection, notificationType })).catch(() => {});
        } catch { /* Collector failures never trigger a notification retry. */ }
    }
    async function send({ accountId, connection, type, text }) {
        log('telegram_notification_sending', accountId, connection, { notificationType: type, message: text });
        try { await client.sendMessage(connection.chatId, text); }
        catch (error) {
            log('telegram_notification_failed', accountId, connection, { notificationType: type,
                reason: error.code === 403 ? 'blocked' : error.code === 429 ? 'rate_limited' : 'unconfirmed' });
            throw error;
        }
        log('telegram_notification_sent', accountId, connection, { notificationType: type });
        if (Object.hasOwn(SENT_EVENTS, type)) report(SENT_EVENTS[type], accountId, connection, type);
    }
    return { send, report };
}
module.exports = { createTelegramTelemetry };
