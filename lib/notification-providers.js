// Providers describe message content; the channel owns recipients and delivery.
// Add future airport/aircraft providers here without coupling them to Telegram.
const providers = Object.freeze({
    test: {
        render: () => 'Geneva Runway: your Telegram connection is working. Configure airport and aircraft notifications in the app settings.'
    },
    predictedRunwayChange: {
        render: ({ from, to, observation, windSpeed, windDirection, windGusts }) => {
            const value = (number, unit) => Number.isFinite(number) ? `${number} ${unit}` : 'unavailable';
            return `Geneva Airport · predicted runway change\nWind-based estimate: ${from} → ${to}.\n` +
                `Confirmed in two distinct weather reports. Latest report: ${observation.replace('T', ' ')} Europe/Zurich.\n` +
                `Wind: ${value(windSpeed, 'km/h')}, from ${value(windDirection, 'degrees')}; gusts ${value(windGusts, 'km/h')}.\n` +
                'This is a weather-based prediction. Actual runway use may differ.';
        }
    }
});

function renderNotification(type, context = {}) {
    if (!Object.hasOwn(providers, type)) throw new Error('Unknown notification provider');
    return providers[type].render(context);
}

module.exports = { renderNotification };
