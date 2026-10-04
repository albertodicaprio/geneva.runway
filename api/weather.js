const { createWeatherService } = require('../lib/weather-service');
const { getLastArrival } = require('../lib/aircraft-service');

function createWeatherHandler(service = createWeatherService(), lastArrival = getLastArrival) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return res.status(405).json({ error: 'Method not allowed' });
        }
        try {
            const [forecast, arrival] = await Promise.all([
                service.getForecast(), lastArrival().catch(() => null)
            ]);
            return res.status(200).json({ ...forecast, lastArrival: arrival });
        } catch {
            return res.status(503).json({ error: 'Weather forecast is temporarily unavailable. Please try again shortly.' });
        }
    };
}

module.exports = createWeatherHandler();
module.exports.createWeatherHandler = createWeatherHandler;
