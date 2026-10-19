const { telegramConfig } = require('../lib/telegram');
const { createTelegramClient } = require('../lib/telegram-client');

async function setupTelegram({ env = process.env, client } = {}) {
    const config = telegramConfig(env);
    if (!config.enabled) throw new Error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and a 32–256 character TELEGRAM_WEBHOOK_SECRET first.');
    let origin;
    try {
        const url = new URL(env.APP_ORIGIN);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
        origin = url.origin;
    } catch { throw new Error('APP_ORIGIN must be your publicly reachable HTTPS website origin.'); }
    const telegram = client || createTelegramClient({ token: config.token });
    const identity = await telegram.request('getMe');
    if (identity.username?.toLowerCase() !== config.username.toLowerCase()) {
        throw new Error('TELEGRAM_BOT_USERNAME does not match the bot token.');
    }
    await telegram.request('setWebhook', { url: `${origin}/api/telegram/webhook`,
        secret_token: config.secret, allowed_updates: ['message'], max_connections: 1 });
    return `${origin}/api/telegram/webhook`;
}

if (require.main === module) {
    setupTelegram().then(url => console.log(`Telegram linking webhook registered at ${url}`)).catch(() => {
        // Even failed API requests must not print a token-bearing URL.
        console.error('Could not register Telegram webhook. Check the Telegram environment settings, bot username, public HTTPS origin and network access.');
        process.exitCode = 1;
    });
}

module.exports = { setupTelegram };
