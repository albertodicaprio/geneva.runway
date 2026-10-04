const { createAviationWeatherService } = require('../lib/aviation-weather');
const { createWeatherHandler } = require('./weather');

module.exports = createWeatherHandler(createAviationWeatherService());
