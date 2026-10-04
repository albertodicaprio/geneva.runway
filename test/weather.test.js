const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWeatherService } = require('../lib/weather-service');
const { createWeatherHandler } = require('../api/weather');
const weather = require('../public/weather');

const START = Date.parse('2026-10-04T10:00:00Z');
function providerData(start = '2026-10-04') {
    const dates = Array.from({ length: 5 }, (_, index) => new Date(Date.parse(`${start}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
    return { daily: {
        time: dates, weather_code: [0, 2, 61, 95, null],
        temperature_2m_max: [20, 19, 18, 17, null], temperature_2m_min: [10, 9, 8, 7, null],
        precipitation_probability_max: [0, 10, 70, 90, null], precipitation_sum: [0, 0, 3.2, 5, null],
        wind_speed_10m_max: [10, 20, 25, 30, null], wind_gusts_10m_max: [20, 30, 40, 50, null],
        wind_direction_10m_dominant: [0, 90, 220, 360, null],
        sunrise: dates.map(date => `${date}T07:30`), sunset: dates.map(date => `${date}T19:00`)
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

test('weather HTTP adapter serves cached data and returns a useful 503 on failure', async () => {
    function res() {
        return { headers: {}, setHeader(name, value) { this.headers[name] = value; },
            status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    }
    const output = res();
    const handler = createWeatherHandler({ getForecast: async () => ({ days: [], stale: true }) });
    await handler({ method: 'GET' }, output);
    assert.equal(output.code, 200);
    assert.equal(output.body.stale, true);
    assert.equal(output.headers['Cache-Control'], 'no-store');
    const invalid = res();
    await handler({ method: 'POST' }, invalid);
    assert.equal(invalid.code, 405);
    assert.equal(invalid.headers.Allow, 'GET');
    const unavailable = res();
    await createWeatherHandler({ getForecast: async () => { throw new Error('private provider details'); } })({ method: 'GET' }, unavailable);
    assert.equal(unavailable.code, 503);
    assert.match(unavailable.body.error, /temporarily unavailable/);
    assert.doesNotMatch(unavailable.body.error, /private/);
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
