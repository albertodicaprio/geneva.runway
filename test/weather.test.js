const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWeatherService, predictRunway } = require('../lib/weather-service');
const { createWeatherHandler } = require('../api/weather');
const weather = require('../public/weather');

const START = Date.parse('2026-10-04T10:00:00Z');
function providerData(start = '2026-10-04') {
    const dates = Array.from({ length: 5 }, (_, index) => new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
    return { current: {
        time: `${start}T12:00`, weather_code: 2, temperature_2m: 18.5,
        precipitation: 0, wind_speed_10m: 15, wind_gusts_10m: 25, wind_direction_10m: 220
    }, daily: {
        time: dates, weather_code: [0, 2, 61, 95, null],
        temperature_2m_max: [20, 19, 18, 17, null], temperature_2m_min: [10, 9, 8, 7, null],
        precipitation_probability_max: [0, 10, 70, 90, null], precipitation_sum: [0, 0, 3.2, 5, null],
        wind_speed_10m_max: [10, 20, 25, 30, null], wind_gusts_10m_max: [20, 30, 40, 50, null],
        wind_direction_10m_dominant: [0, 90, 220, 360, null]
    } };
}

test('weather uses five Geneva days, metric units, and shares/cache requests', async () => {
    let now = START;
    let calls = 0;
    let release;
    const service = createWeatherService({ now: () => now, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url.origin, 'https://api.open-meteo.com');
        assert.equal(url.searchParams.get('timezone'), 'Europe/Zurich');
        assert.equal(url.searchParams.get('forecast_days'), '5');
        assert.equal(url.searchParams.get('latitude'), '46.2381');
        assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
        assert.ok(url.searchParams.get('current').includes('temperature_2m'));
        assert.ok(url.searchParams.get('current').includes('wind_direction_10m'));
        assert.doesNotMatch(url.searchParams.get('daily'), /sunrise|sunset/);
        assert.ok(options.signal);
        if (calls === 1) await new Promise(resolve => { release = resolve; });
        return { ok: true, json: async () => providerData() };
    } });
    const requests = [service.getForecast(), service.getForecast(), service.getForecast()];
    release();
    const results = await Promise.all(requests);
    assert.equal(calls, 1);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].stale, false);
    assert.equal(results[0].days.length, 5);
    assert.equal(results[0].days[2].precipitation, 3.2);
    assert.equal(results[0].days[4].temperatureMax, null);
    assert.equal(results[0].current.temperature, 18.5);
    assert.equal(results[0].current.runway.direction, '22');
    assert.equal(results[0].days[0].runway.direction, '04');
    assert.equal(results[0].days[4].runway.direction, 'unknown');
    assert.equal(results[0].days[0].sunrise, undefined);
    now += 29 * 60 * 1000;
    await service.getForecast();
    assert.equal(calls, 1);
    now += 60 * 1000;
    await service.getForecast();
    assert.equal(calls, 2);
});

test('failed refresh keeps the last forecast, throttles retries, and recovers', async () => {
    let now = START;
    let calls = 0;
    let failure = false;
    const service = createWeatherService({ now: () => now, fetchImpl: async () => {
        calls++;
        if (failure) throw new Error('Network failure');
        return { ok: true, json: async () => providerData() };
    } });
    const first = await service.getForecast();
    now += 30 * 60 * 1000;
    failure = true;
    const stale = await service.getForecast();
    assert.equal(stale.stale, true);
    assert.equal(stale.updatedAt, first.updatedAt);
    assert.deepEqual(stale.days, first.days);
    assert.deepEqual(stale.current, first.current);
    await service.getForecast();
    assert.equal(calls, 2);
    now += 60 * 1000;
    failure = false;
    assert.equal((await service.getForecast()).stale, false);
    assert.equal(calls, 3);
});

test('a Geneva date change refreshes a still-fresh cache', async () => {
    let now = Date.parse('2026-10-04T21:50:00Z');
    let calls = 0;
    const service = createWeatherService({ now: () => now, fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => providerData(calls === 1 ? '2026-10-04' : '2026-10-05') };
    } });
    await service.getForecast();
    now += 11 * 60 * 1000;
    assert.equal((await service.getForecast()).days[0].date, '2026-10-05');
    assert.equal(calls, 2);
});

test('empty cache failures and malformed provider responses do not masquerade as forecasts', async () => {
    for (const response of [
        { ok: false },
        { ok: true, json: async () => ({ daily: {} }) },
        { ok: true, json: async () => { const data = providerData(); delete data.current; return data; } },
        { ok: true, json: async () => { const data = providerData(); data.daily.temperature_2m_max.pop(); return data; } },
        { ok: true, json: async () => providerData('2026-10-03') }
    ]) {
        let calls = 0;
        const service = createWeatherService({ now: () => START, fetchImpl: async () => { calls++; return response; } });
        await assert.rejects(service.getForecast(), /unavailable/);
        await assert.rejects(service.getForecast(), /unavailable/);
        assert.equal(calls, 1);
    }
});

test('wind-based runway estimates choose the headwind direction and remain unknown for weak or crosswinds', () => {
    for (const direction of [0, 40, 360]) assert.equal(predictRunway(direction, 15).direction, '04');
    for (const direction of [180, 220, 270]) assert.equal(predictRunway(direction, 15).direction, '22');
    for (const direction of [115, 130, 145, 295, 310, 325]) {
        assert.equal(predictRunway(direction, 30).direction, 'unknown');
    }
    assert.equal(predictRunway(114, 15).direction, '04');
    assert.equal(predictRunway(146, 15).direction, '22');
    for (const [direction, speed] of [[40, 0], [220, 4.9], [null, 20], [40, null], [NaN, 20], [-1, 20], [361, 20], [220, -10]]) {
        assert.equal(predictRunway(direction, speed).direction, 'unknown');
    }
    assert.equal(predictRunway(40, 5).direction, '04');
});

test('weather cards start with Now, show runway estimates, omit daylight, and cap the count at an even six', async () => {
    function element() {
        return { textContent: '', children: [], append(child) { this.children.push(child); },
            setAttribute() {}, replaceChildren(...children) { this.children = children; } };
    }
    const forecast = element();
    const updated = element();
    const document = { createElement: element, createElementNS: (_, tag) => element(tag),
        getElementById: id => id === 'weatherForecast' ? forecast : updated };
    const text = node => [node.textContent, ...node.children.map(text)].join(' ');
    const service = createWeatherService({ now: () => START, fetchImpl: async () => ({ ok: true, json: async () => providerData() }) });
    const data = await service.getForecast();
    weather.renderForecast(data, document);
    assert.equal(forecast.children.length, 6);
    assert.equal(forecast.children[0].children[0].textContent, 'Now');
    assert.match(text(forecast.children[0]), /18.5|19°C/);
    assert.match(text(forecast.children[0]), /Likely runway 22/);
    assert.match(text(forecast.children[1]), /Likely runway 04/);
    assert.match(text(forecast.children[5]), /Cannot estimate runway/);
    assert.doesNotMatch(text(forecast), /Sunrise|Sunset/);
    assert.doesNotMatch(text(forecast.children[0]), /High \/ low|Max wind/);
    assert.match(text(forecast.children[0]), /Last arrival: runway unknown/);
    weather.renderForecast({ ...data, lastArrival: {
        direction: '04', callsign: 'SWR123', estimatedLandingAt: START - 60000, stale: true
    } }, document);
    assert.match(text(forecast.children[0]), /Last arrival: runway 04/);
    assert.doesNotMatch(text(forecast.children[0]), /SWR123|landing estimated|tracking stale/);
    const lastArrivalBadge = forecast.children[0].children.find(child => child.textContent === 'Last arrival: runway 04');
    assert.match(lastArrivalBadge.className, /weather-last-arrival/);
    assert.match(lastArrivalBadge.title, /Landing estimated/);
    assert.match(lastArrivalBadge.title, /tracking stale/);
    assert.match(text(forecast.children[0]), /Likely runway 22/);
    assert.doesNotMatch(text(forecast.children[1]), /Last arrival/);
    for (const days of [data.days.slice(0, 4), [...data.days, ...data.days]]) {
        weather.renderForecast({ ...data, days }, document);
        assert.equal(forecast.children.length % 2, 0);
        assert.ok(forecast.children.length <= 6);
        assert.equal(forecast.children[0].children[0].textContent, 'Now');
    }
});

test('weather HTTP adapter serves cached data and returns a useful 503 on failure', async () => {
    function res() {
        return { headers: {}, setHeader(name, value) { this.headers[name] = value; },
            status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    }
    const output = res();
    const handler = createWeatherHandler({ getForecast: async () => ({ days: [], stale: true }) }, async () => ({ direction: '22' }));
    await handler({ method: 'GET' }, output);
    assert.equal(output.code, 200);
    assert.equal(output.body.stale, true);
    assert.equal(output.body.lastArrival.direction, '22');
    assert.equal(output.headers['Cache-Control'], 'no-store');
    const invalid = res();
    await handler({ method: 'POST' }, invalid);
    assert.equal(invalid.code, 405);
    assert.equal(invalid.headers.Allow, 'GET');
    const unavailable = res();
    await createWeatherHandler({ getForecast: async () => { throw new Error('private provider details'); } }, async () => null)({ method: 'GET' }, unavailable);
    assert.equal(unavailable.code, 503);
    assert.match(unavailable.body.error, /temporarily unavailable/);
    assert.doesNotMatch(unavailable.body.error, /private/);
    const noTracking = res();
    await createWeatherHandler({ getForecast: async () => ({ days: [], stale: false }) }, async () => { throw new Error('Cache failure'); })({ method: 'GET' }, noTracking);
    assert.equal(noTracking.code, 200);
    assert.equal(noTracking.body.lastArrival, null);
});

test('forecast labels handle missing data, zero values, and prevailing wind from north', () => {
    assert.equal(weather.number(null, '%'), '—');
    assert.equal(weather.number(0, '%'), '0%');
    assert.equal(weather.windDirection(360), 'N · 360°');
    assert.equal(weather.windDirection(220), 'SW · 220°');
    assert.equal(weather.windDirection(null), '—');
    assert.equal(weather.condition(null)[0], 'Conditions unavailable');
    assert.equal(weather.condition(95)[0], 'Thunderstorm');
});

test('wind compasses use true runway bearing and inward arrows for north, east and wrapped bearings', () => {
    function render(data) {
        const root = { children: [], append(child) { this.children.push(child); } };
        const document = { createElementNS: (_, tag) => ({ tag, attributes: {}, children: [],
            setAttribute(name, value) { this.attributes[name] = value; }, append(child) { this.children.push(child); } }) };
        function add(tag, text, className, parent = root) {
            const node = { tag, textContent: text, className, children: [], append(child) { this.children.push(child); } };
            parent.append(node);
            return node;
        }
        weather.addWindCompass(add, document, data);
        return root.children[0].children[0].children[0];
    }
    for (const direction of [0, 90, 220, 360]) {
        const svg = render({ windDirection: direction, windSpeed: 12, windGusts: 20 });
        const runway = svg.children.find(node => node.attributes.class === 'compass-runway');
        assert.equal(runway.attributes.transform, 'rotate(46 80 80)');
        const arrow = svg.children.find(node => node.attributes.class === 'compass-wind');
        assert.equal(arrow.attributes.transform, `rotate(${direction} 80 80)`);
        const path = arrow.children.find(node => node.attributes.class === 'compass-wind-arrow');
        const coordinates = path.attributes.d.match(/[\d.]+/g).map(Number);
        assert.ok(coordinates[9] > coordinates[1], 'wind moves inward from its source');
        assert.match(svg.attributes['aria-label'], /12 km\/h; gusts 20 km\/h/);
    }
    function dimensions(speed, gusts, arrowClass) {
        const svg = render({ windDirection: 40, windSpeed: speed, windGusts: gusts });
        const arrow = svg.children.find(node => node.attributes.class === 'compass-wind');
        const path = arrow.children.find(node => node.attributes.class === arrowClass);
        if (!path) return null;
        const coordinates = path.attributes.d.match(/[\d.]+/g).map(Number);
        return { length: coordinates[9] - coordinates[1], width: coordinates[6] - coordinates[10] };
    }
    const light = dimensions(3, 8, 'compass-wind-arrow');
    const strongerWind = dimensions(30, 8, 'compass-wind-arrow');
    assert.ok(strongerWind.length > light.length);
    assert.equal(strongerWind.width, light.width, 'wind speed controls only length');
    const strongerGusts = dimensions(3, 45, 'compass-wind-arrow');
    assert.equal(strongerGusts.length, light.length, 'gusts do not resize arrow length');
    assert.ok(strongerGusts.width > light.width);
    assert.ok(dimensions(0.1, 0, 'compass-wind-arrow').length >= 30, 'light winds stay visible');
    assert.ok(dimensions(60, 60, 'compass-wind-arrow').length >= 100, 'strong winds span nearly the 114-unit circle');
    assert.deepEqual(dimensions(100, 150, 'compass-wind-arrow'), dimensions(60, 60, 'compass-wind-arrow'));
    assert.equal(dimensions(12, null, 'compass-wind-arrow').width, dimensions(12, 0, 'compass-wind-arrow').width);
    assert.ok(dimensions(0, 20, 'compass-wind-arrow').width > 0);
    for (const extra of [{ windSpeed: 0 }, { variableWind: true }, { windDirection: null },
        { windDirection: -1 }, { windDirection: 361 }, { windSpeed: null }]) {
        const svg = render({ windDirection: 40, windSpeed: 12, windGusts: null, ...extra });
        assert.ok(!svg.children.some(node => node.attributes.class === 'compass-wind'));
        assert.ok(svg.children.some(node => node.attributes.class === 'compass-uncertain'));
    }
});

test('calm fair weather prefers 22, including variable winds, while adverse/unknown conditions do not', () => {
    for (const direction of [30, 220, null]) {
        const result = predictRunway(direction, 3.7, { fairWeather: true });
        assert.equal(result.direction, '22');
        assert.equal(result.calmConditions, true);
        assert.equal(weather.runwayText(result), 'Likely runway 22 (calm conditions)');
    }
    for (const options of [{}, { fairWeather: false }, { fairWeather: true, windGusts: 10 }]) {
        assert.equal(predictRunway(30, 3.7, options).direction, 'unknown');
    }
    assert.equal(predictRunway(null, 15, { fairWeather: true }).direction, 'unknown');
    assert.equal(predictRunway(40, 5, { fairWeather: true }).direction, '04');

});

test('light-wind explanations distinguish gusts from adverse or missing fair weather', () => {
    assert.match(predictRunway(342, 3.4, { fairWeather: true, windGusts: 7.6 }).reason, /gusts/i);
    assert.match(predictRunway(260, 4, { fairWeather: false, windGusts: 21.6 }).reason, /fair conditions/i);
    assert.equal(predictRunway(342, 3.4, { fairWeather: true, windGusts: 4.9 }).direction, '22');
    assert.equal(predictRunway(342, 3.4, { fairWeather: true, windGusts: 5 }).direction, 'unknown');
});

test('Open-Meteo current and daily normalization also apply the calm fair-weather preference', async () => {
    const current = { time: '2026-10-04T12:00', weather_code: 0, temperature_2m: 20,
        precipitation: 0, wind_speed_10m: 2, wind_gusts_10m: 3, wind_direction_10m: 30 };
    const daily = { time: ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'],
        weather_code: [0, 45, 61, null, 0], temperature_2m_max: [20, 20, 20, 20, 20],
        temperature_2m_min: [10, 10, 10, 10, 10], precipitation_probability_max: [0, 0, 50, 0, 0],
        precipitation_sum: [0, 0, 1, 0, 0], wind_speed_10m_max: [2, 2, 2, 2, 2],
        wind_gusts_10m_max: [3, 3, 3, 3, 10], wind_direction_10m_dominant: [30, 30, 30, 30, 30] };
    const service = createWeatherService({ now: () => START, fetchImpl: async () => ({ ok: true, json: async () => ({ current, daily }) }) });
    const result = await service.getForecast();
    assert.equal(result.current.runway.calmConditions, true);
    assert.equal(result.days[0].runway.calmConditions, true);
    assert.ok(result.days.slice(1).every(day => day.runway.direction === 'unknown'));
});
