const { createWeatherService } = require('../lib/weather-service');

function createWeatherHandler(service = createWeatherService()) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return res.status(405).json({ error: 'Method not allowed' });
        }
        try {
            return res.status(200).json(await service.getForecast());
        } catch {
            return res.status(503).json({ error: 'Weather forecast is temporarily unavailable. Please try again shortly.' });
        }
    };
}

module.exports = createWeatherHandler();
module.exports.createWeatherHandler = createWeatherHandler;
