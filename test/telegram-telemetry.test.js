const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTelegramTelemetry } = require('../lib/telegram-telemetry');

const connection = { chatId: '123456', name: 'Alice\nExample', username: 'alice',
    analyticsContext: { name: 'Alice Example', email: 'alice@example.com' } };

test('notification logs include exact message and recipient as one JSON line; sent events follow confirmed acceptance', async () => {
    const logs = []; const events = []; const sends = [];
    const telemetry = createTelegramTelemetry({ clock: () => 1800000000000,
        logger: { info(line) { assert.equal(line.split('\n').length, 1); logs.push(JSON.parse(line)); } },
        client: { async sendMessage(id, text) {
            assert.equal(logs.at(-1).event, 'telegram_notification_sending');
            sends.push({ id, text });
        } }, analytics: { trackTelegram(event, context) { events.push({ event, context }); } } });
    for (const type of ['test', 'arrivalRunwayChange', 'busyArrivals', 'holdingArrivals']) {
        await telemetry.send({ accountId: 'google-alice', connection, type, text: 'Line one\nLine two' });
    }
    assert.deepEqual(events.map(item => item.event), ['telegram_test_sent', 'telegram_runway_change_sent', 'telegram_busy_arrivals_sent', 'telegram_holding_arrivals_sent']);
    assert.equal(sends.length, 4);
    assert.equal(logs[0].message, 'Line one\nLine two');
    assert.equal(logs[0].telegramName, connection.name);
    assert.equal(logs[0].email, 'alice@example.com');
    assert.equal(logs[0].accountId, 'google-alice');
    assert.equal(logs[0].timestamp, '2027-01-15T08:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(logs), /chatId|123456/);
});

test('unconfirmed and blocked sends log bounded failure reasons and never generate sent events', async () => {
    for (const [code, reason] of [[403, 'blocked'], [429, 'rate_limited'], ['unavailable', 'unconfirmed']]) {
        const logs = []; const events = [];
        const error = Object.assign(new Error('private-token https://secret-bot'), { code });
        const telemetry = createTelegramTelemetry({ client: { async sendMessage() { throw error; } },
            logger: { info: line => logs.push(JSON.parse(line)) }, analytics: { trackTelegram: event => events.push(event) } });
        await assert.rejects(telemetry.send({ accountId: 'alice', connection, type: 'test', text: 'Test message' }), error);
        assert.equal(events.length, 0);
        assert.equal(logs.at(-1).event, 'telegram_notification_failed');
        assert.equal(logs.at(-1).reason, reason);
        assert.doesNotMatch(JSON.stringify(logs), /private-token|secret-bot/);
    }
});

test('throwing loggers and rejected analytics never turn successful delivery into a retry', async () => {
    let sends = 0;
    const telemetry = createTelegramTelemetry({ client: { async sendMessage() { sends++; } },
        logger: { info() { throw new Error('Logging failure'); } },
        analytics: { trackTelegram() { return Promise.reject(new Error('Collector failure')); } } });
    await telemetry.send({ accountId: 'alice', connection, type: 'busyArrivals', text: 'Busy' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sends, 1);
});
