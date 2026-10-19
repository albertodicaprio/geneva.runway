// Providers describe message content; the channel owns recipients and delivery.
// Add future airport/aircraft providers here without coupling them to Telegram.
const providers = Object.freeze({
    test: {
        render: () => 'Geneva Runway: your Telegram connection is working. Future airport and aircraft notifications can be configured in the app when available.'
    }
});

function renderNotification(type, context = {}) {
    if (!Object.hasOwn(providers, type)) throw new Error('Unknown notification provider');
    return providers[type].render(context);
}

module.exports = { renderNotification };
