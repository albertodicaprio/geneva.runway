// Providers describe message content; the channel owns recipients and delivery.
// Add future airport/aircraft providers here without coupling them to Telegram.
const providers = Object.freeze({
    test: {
        render: () => 'Geneva Runway: your Telegram connection is working. Configure airport and aircraft notifications in the app settings.'
    },
    goArounds: {
        render: ({ callsign, runway }) => `Geneva Airport · possible go-around: ${callsign}.\n` +
            `Aircraft climbed after a low approach toward runway ${runway}.\n` +
            'Inferred from tracking; this does not confirm a go-around or its cause.'
    },
    holdingArrivals: {
        render: ({ callsign, firstSeenAt, lastSeenAt }) =>
            `Geneva Airport · possible holding: ${callsign}.\n` +
            `Tracked inbound in the area for ${Math.floor((lastSeenAt - firstSeenAt) / 60_000)} minutes (more than 15 minutes).\n` +
            'Time in the tracked area alone does not confirm a holding pattern or a landing delay.'
    },
    busyArrivals: {
        render: ({ count, threshold }) => `Geneva Airport · busy arrivals: ${count} aircraft currently tracked inbound (more than ${threshold}).\n` +
            'These are tracked Geneva arrivals, not confirmed landings or a landing-time forecast.'
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
