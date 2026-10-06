const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAviationWeatherService, normalizeMetar, normalizeTaf } = require('../lib/aviation-weather');
const { createWeatherService, predictRunway } = require('../lib/weather-service');
const { createWeatherHandler } = require('../api/weather');
const ui = require('../public/aviation-weather');
const weatherUi = require('../public/weather');

const START = Date.parse('2026-10-04T10:00:00Z');
const hour = offset => START / 1000 + offset * 3600;
const metar = (extra = {}) => [{ icaoId: 'LSGG', obsTime: START / 1000,
    reportTime: '2026-10-04T10:30:00Z', temp: 20, dewp: 10, altim: 1020,
    wdir: 'VRB', wspd: 2, visib: '6+', cover: 'CAVOK', clouds: [],
    rawOb: 'METAR LSGG 041000Z AUTO VRB02KT CAVOK 20/10 Q1020 NOSIG', ...extra }];
const base = { timeFrom: hour(0), timeTo: hour(30), fcstChange: null,
    wdir: 'VRB', wspd: 2, wgst: null, visib: '6+', clouds: [{ cover: 'NSC', base: null }] };
const taf = (groups = [base], extra = {}) => [{ icaoId: 'LSGG',
    issueTime: new Date(START - 3600000).toISOString(), validTimeFrom: hour(0), validTimeTo: hour(30),
    rawTAF: 'TAF LSGG 040900Z 0410/0516 VRB02KT CAVOK TX22/0415Z TN12/0505Z', fcsts: groups, ...extra }];

test('calm fair weather prefers 22, including variable winds, while adverse/unknown conditions do not', () => {
    for (const direction of [30, 220, null]) {
        const result = predictRunway(direction, 3.7, { fairWeather: true });
        assert.equal(result.direction, '22');
        assert.equal(result.calmConditions, true);
        assert.equal(weatherUi.runwayText(result), 'Likely runway 22 (calm conditions)');
    }
    for (const options of [{}, { fairWeather: false }, { fairWeather: true, windGusts: 10 }]) {
        assert.equal(predictRunway(30, 3.7, options).direction, 'unknown');
    }
    assert.equal(predictRunway(null, 15, { fairWeather: true }).direction, 'unknown');
    assert.equal(predictRunway(40, 5, { fairWeather: true }).direction, '04');
    assert.equal(normalizeMetar(metar()).runway.calmConditions, true);
    for (const extra of [
        { cover: null, wxString: 'FG', visib: 0.5 },
        { cover: null, wxString: '-RA' },
        { cover: null, clouds: [{ cover: 'BKN', base: 500 }] },
        { cover: null, clouds: [{ cover: 'FEW', base: 3000, type: 'CB' }] },
        { cover: null, clouds: null }, { wgst: 10 }, { wspd: null }
    ]) assert.equal(normalizeMetar(metar(extra)).runway.direction, 'unknown');
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

test('METAR uses observation time, selects LSGG latest, converts knots and retains variations', () => {
    const records = [...metar({ obsTime: hour(-1) }), ...metar({ wdir: 30, wspd: 10, wgst: 20,
        rawOb: 'METAR LSGG 041000Z 03010G20KT 350V050 CAVOK' }),
        { ...metar()[0], icaoId: 'LSZH', obsTime: hour(1) }];
    const data = normalizeMetar(records);
    assert.equal(data.observedAt, START);
    assert.equal(data.windSpeed, 18.52);
    assert.equal(data.windGusts, 37.04);
    assert.equal(data.windVariation, '350V050');
    assert.equal(data.runway.direction, '04');
    assert.throws(() => normalizeMetar([]), /Invalid/);
});

test('TAF alternatives inherit prevailing wind without changing the base or later alternatives', () => {
    const data = normalizeTaf(taf([base,
        { timeFrom: hour(1), timeTo: hour(4), fcstChange: 'TEMPO', probability: 30,
            wdir: null, wspd: null, wgst: null, wxString: 'SHRA', clouds: [{ cover: 'FEW', base: 5000, type: 'TCU' }] },
        { timeFrom: hour(3), timeTo: hour(5), fcstChange: 'PROB', probability: 40, wxString: 'FG', visib: 0.43 }
    ]));
    assert.equal(data.periods.length, 3);
    const [prevailing, showers, fog] = data.periods;
    assert.equal(prevailing.runway.calmConditions, true);
    assert.ok(!prevailing.weather);
    assert.equal(showers.variableWind, true);
    assert.equal(showers.windSpeed, 3.704);
    assert.equal(showers.probability, 30);
    assert.equal(showers.runway.direction, 'unknown');
    assert.equal(fog.clouds[0].cover, 'NSC');
    assert.equal(fog.runway.direction, 'unknown');
    assert.deepEqual(data.temperatures.map(item => item.temperature), [22, 12]);
});

test('TAF FM and BECMG split prevailing periods and overlapping alternatives correctly', () => {
    const data = normalizeTaf(taf([base,
        { timeFrom: hour(4), timeTo: hour(30), fcstChange: 'FM', wdir: 40, wspd: 10, wgst: 20,
            visib: '6+', clouds: [{ cover: 'NSC', base: null }] },
        { timeFrom: hour(8), timeTo: hour(10), fcstChange: 'BECMG', wdir: 220, wspd: 12 },
        { timeFrom: hour(3), timeTo: hour(11), fcstChange: 'TEMPO', wxString: 'RA' }
    ]));
    const primary = data.periods.filter(period => !['Temporary', 'Possible'].includes(period.kind));
    assert.deepEqual(primary.map(period => [period.from, period.to, period.runway.direction]), [
        [START, hour(4) * 1000, '22'], [hour(4) * 1000, hour(8) * 1000, '04'],
        [hour(8) * 1000, hour(10) * 1000, 'unknown'], [hour(10) * 1000, hour(30) * 1000, '22']
    ]);
    assert.equal(primary[3].windGusts, null, 'new wind group clears old gusts');
    assert.equal(primary[2].previousWind.windDirection, 40);
    const alternatives = data.periods.filter(period => period.kind === 'Temporary');
    assert.equal(alternatives.length, 4);
    assert.equal(alternatives[0].variableWind, true);
    assert.equal(alternatives[1].windDirection, 40);
    assert.equal(alternatives[2].runway.direction, 'unknown');
    assert.equal(alternatives[3].windDirection, 220);
});

test('TAF NSW and new cloud conditions clear adverse weather but missing data does not invent good weather', () => {
    const fog = { ...base, wxString: 'FG', visib: 0.5, clouds: [{ cover: 'BKN', base: 300 }], vertVis: 100 };
    const data = normalizeTaf(taf([fog, { timeFrom: hour(2), timeTo: hour(3), fcstChange: 'BECMG',
        wxString: 'NSW', visib: '6+', clouds: [{ cover: 'NSC', base: null }] }]));
    assert.equal(data.periods.at(-1).runway.calmConditions, true);
    // Use a raw report that also lacks CAVOK: an explicit raw CAVOK is known fair weather.
    const genuinelyMissing = normalizeTaf(taf([{ ...base, clouds: null, visib: null }], {
        rawTAF: 'TAF LSGG 040900Z 0410/0516 VRB02KT'
    }));
    assert.equal(genuinelyMissing.periods[0].runway.direction, 'unknown');
    assert.throws(() => normalizeTaf(taf([], {})), /Invalid/);
    assert.throws(() => normalizeTaf(taf([base, { fcstChange: 'TEMPO' }])), /Invalid/);
});

test('raw CAVOK and NSW clear previous fog when JSON weather is null', () => {
    for (const marker of ['CAVOK', '9999 NSW NSC']) {
        const data = normalizeTaf(taf([
            { ...base, wxString: 'FG', visib: 0.5, clouds: [{ cover: 'BKN', base: 300 }] },
            { fcstChange: 'BECMG', timeFrom: hour(2), timeTo: hour(3), wxString: null,
                visib: '6+', clouds: [{ cover: 'NSC', base: null }] }
        ], { rawTAF: `TAF LSGG 040900Z 0410/0516 VRB02KT 0800 FG BKN003 BECMG 0412/0413 ${marker}` }));
        assert.equal(data.periods[0].runway.direction, 'unknown');
        assert.equal(data.periods.at(-1).runway.calmConditions, true);
    }
});

test('wind variation that spans conflicting runway estimates remains unknown', () => {
    const data = normalizeMetar(metar({ wdir: 70, wspd: 12,
        rawOb: 'METAR LSGG 041000Z 07012KT 020V160 CAVOK' }));
    assert.equal(data.runway.direction, 'unknown');
    assert.match(data.runway.reason, /variation/);
});

test('aviation products share/cache requests, isolate failures, throttle retries and suppress stale runway estimates', async () => {
    let now = START;
    const calls = { metar: 0, taf: 0 };
    let failMetar = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const service = createAviationWeatherService({ now: () => now, fetchImpl: async (url, options) => {
        const name = url.includes('/metar?') ? 'metar' : 'taf';
        calls[name]++;
        assert.match(url, /ids=LSGG&format=json$/);
        assert.ok(options.headers['User-Agent']);
        await gate;
        if (name === 'metar' && failMetar) return { ok: true, status: 204, json: () => assert.fail('204 must not be parsed') };
        return { ok: true, json: async () => name === 'metar' ? metar({ obsTime: now / 1000 }) : taf() };
    } });
    const requests = [service.getForecast(), service.getForecast(), service.getForecast()];
    release();
    const results = await Promise.all(requests);
    assert.deepEqual(calls, { metar: 1, taf: 1 });
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].stale, false);
    now += 9 * 60000;
    await service.getForecast();
    assert.deepEqual(calls, { metar: 1, taf: 1 });
    now += 60000;
    failMetar = true;
    const failed = await service.getForecast();
    assert.equal(failed.current.stale, true);
    assert.equal(failed.current.runway.direction, 'unknown');
    assert.equal(failed.forecast.stale, false);
    assert.equal(failed.forecast.periods[0].runway.direction, '22');
    await service.getForecast();
    assert.deepEqual(calls, { metar: 2, taf: 2 });
    now += 60000;
    failMetar = false;
    assert.equal((await service.getForecast()).current.stale, false);
    assert.deepEqual(calls, { metar: 3, taf: 2 });
});

test('old observations and expired TAFs remain explicit even when fetched successfully', async () => {
    const service = createAviationWeatherService({ now: () => START + 31 * 3600000,
        fetchImpl: async url => ({ ok: true, json: async () => url.includes('/metar?') ? metar() : taf() }) });
    const result = await service.getForecast();
    assert.equal(result.current.stale, true);
    assert.equal(result.current.runway.direction, 'unknown');
    assert.equal(result.forecast.stale, true);
    assert.equal(result.forecast.periods.length, 0);
});

test('missing METAR still serves TAF; total failure returns 503 without provider details', async () => {
    let calls = 0;
    const service = createAviationWeatherService({ now: () => START, fetchImpl: async url => {
        calls++;
        return url.includes('/metar?') ? { ok: true, status: 204 } : { ok: true, json: async () => taf() };
    } });
    const data = await service.getForecast();
    assert.equal(data.current, null);
    assert.equal(data.forecast.periods.length, 1);
    assert.equal(data.stale, true);
    await service.getForecast();
    assert.equal(calls, 2);
    const failed = createAviationWeatherService({ now: () => START, fetchImpl: async () => { throw new Error('provider details'); } });
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await createWeatherHandler(failed, async () => null)({ method: 'GET' }, res);
    assert.equal(res.code, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /provider details/);
});

test('five-day horizon retains every in-range TAF group without even-card truncation', async () => {
    const groups = [ { ...base, timeTo: hour(150) }, ...[1, 2, 3, 4, 5, 6].map(i => ({
        timeFrom: hour(i), timeTo: hour(i + 1), fcstChange: 'TEMPO', visib: '6+'
    })), { timeFrom: hour(120), timeTo: hour(150), fcstChange: 'TEMPO', wxString: 'FG' } ];
    const service = createAviationWeatherService({ now: () => START, fetchImpl: async url => ({ ok: true,
        json: async () => url.includes('/metar?') ? metar() : taf(groups, { validTimeTo: hour(150) }) }) });
    const data = await service.getForecast();
    assert.equal(data.forecast.periods.length, 7);
    assert.ok(data.forecast.periods.every(period => period.to <= START + 5 * 86400000));
    function element() { return { textContent: '', children: [], append(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children; } }; }
    const elements = { weatherForecast: element(), weatherUpdated: element() };
    const document = { createElement: element, getElementById: id => elements[id] };
    ui.renderForecast(data, document);
    assert.equal(elements.weatherForecast.children.length, 8);
    assert.equal(elements.weatherForecast.children[0].children[0].textContent, 'Now (METAR)');
    assert.ok(elements.weatherForecast.children.slice(1).every(card => card.children[0].textContent.endsWith('(TAF)')));
    const text = node => [node.textContent, ...node.children.map(text)].join(' ');
    assert.match(text(elements.weatherForecast), /22 \(calm conditions\)/);
    assert.match(text(elements.weatherUpdated), /Raw TAF/);
    ui.renderForecast({ ...data, current: null, forecast: { ...data.forecast, periods: data.forecast.periods.slice(0, 2) } }, document);
    assert.equal(elements.weatherForecast.children.length, 3);
    assert.match(text(elements.weatherForecast.children[0]), /unavailable/);
    assert.equal(ui.visibility('6+'), '10 km or more');
    assert.equal(ui.visibility(0), '0.0 km');
});
