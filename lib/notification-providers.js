// Providers describe message content; the channel owns recipients and delivery.
// Add future airport/aircraft providers here without coupling them to Telegram.
const providers = Object.freeze({
    test: {
        render: () => 'Geneva Runway: your Telegram connection is working. Configure airport and aircraft notifications in the app settings.'
    },
    arrivalRunwayChange: {
        render: ({ from, to, confirmedBy }) => {
            const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich',
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            const flights = confirmedBy.map(flight => `${flight.callsign} (${time.format(new Date(flight.estimatedLandingAt))})`).join(' and ');
            return `Geneva Airport · likely runway change: ${from} → ${to}.\n` +
                `Two consecutive tracked arrivals indicate runway ${to}: ${flights}, Europe/Zurich.\n` +
                'Inferred from arrival tracking; disappearance from tracking does not confirm touchdown.';
        }
    }
});

function renderNotification(type, context = {}) {
    if (!Object.hasOwn(providers, type)) throw new Error('Unknown notification provider');
    return providers[type].render(context);
}

module.exports = { renderNotification };
