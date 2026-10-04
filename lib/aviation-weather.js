const { predictRunway } = require('./weather-service');

const CACHE_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_OBSERVATION_AGE = 45 * 60 * 1000;
const FIVE_DAYS = 5 * 86400000;
const finite = value => Number.isFinite(value) ? value : null;
const timestamp = value => Number.isFinite(value) && value > 0 ? value * 1000 : null;
const unknown = reason => ({ direction: 'unknown', reason });

function conditions(record) {
    return {
        windDirection: finite(record.wdir), variableWind: record.wdir === 'VRB',
        windSpeed: Number.isFinite(record.wspd) && record.wspd >= 0 ? record.wspd * 1.852 : null,
        windGusts: Number.isFinite(record.wgst) && record.wgst >= 0 ? record.wgst * 1.852 : null,
        visibility: record.visib ?? null, weather: record.cavok || record.noSignificantWeather ? '' : record.wxString ?? null,
        cover: record.cavok ? 'CAVOK' : record.cover ?? null, verticalVisibility: finite(record.vertVis),
        clouds: Array.isArray(record.clouds) ? record.clouds.map(cloud => ({
            cover: cloud.cover, base: finite(cloud.base), type: cloud.type ?? null
        })) : null
    };
}

function runwayFor(data) {
    // CAVOK is an explicit fair-weather report. Otherwise require good visibility,
    // a known cloud report, and no significant weather or low broken/overcast cloud.
    const visibilityKm = data.visibility === '6+' ? 10 : Number(data.visibility) * 1.609344;
    const fairWeather = !data.weather && data.verticalVisibility === null &&
        (data.cover === 'CAVOK' || (data.visibility !== null && visibilityKm >= 10 &&
            Array.isArray(data.clouds) && !data.clouds.some(cloud =>
                ['CB', 'TCU'].includes(cloud.type) ||
                (['BKN', 'OVC', 'VV'].includes(cloud.cover) && (cloud.base === null || cloud.base < 1500)))));
    return predictRunway(data.windDirection, data.windSpeed, { fairWeather, windGusts: data.windGusts });
}

function normalizeMetar(records) {
    const record = Array.isArray(records) ? records.filter(item => item.icaoId === 'LSGG' && timestamp(item.obsTime))
        .sort((a, b) => b.obsTime - a.obsTime)[0] : null;
    if (!record || typeof record.rawOb !== 'string') throw new Error('Invalid METAR');
    const data = { ...conditions(record), observedAt: timestamp(record.obsTime), raw: record.rawOb,
        temperature: finite(record.temp), dewPoint: finite(record.dewp), pressure: finite(record.altim),
        automatic: /\bAUTO\b/.test(record.rawOb), windVariation: record.rawOb.match(/\b\d{3}V\d{3}\b/)?.[0] ?? null };
    data.runway = runwayFor(data);
    if (data.windVariation && !data.runway.calmConditions) {
        const bounds = data.windVariation.split('V').map(Number);
        if (bounds.some(direction => predictRunway(direction, data.windSpeed).direction !== data.runway.direction)) {
            data.runway = unknown('Reported wind variation makes the runway estimate uncertain');
        }
    }
    return data;
}

function mergeConditions(base, record) {
    const result = { ...base };
    const next = conditions(record);
    // Missing TAF elements inherit the prevailing forecast. New wind groups replace
    // direction/speed/gust together, including clearing an earlier gust forecast.
    if (record.wdir != null || record.wspd != null) {
        for (const field of ['windDirection', 'variableWind', 'windSpeed', 'windGusts']) result[field] = next[field];
    }
    for (const [field, upstream] of [['visibility', 'visib'], ['weather', 'wxString'],
        ['clouds', 'clouds'], ['verticalVisibility', 'vertVis'], ['cover', 'cover']]) {
        if (record[upstream] != null) result[field] = next[field];
    }
    if (record.wxString === 'NSW') result.weather = '';
    if (record.visib != null || record.clouds != null || record.wxString != null) result.cover = next.cover;
    if (record.clouds != null && record.vertVis == null) result.verticalVisibility = null;
    if (record.noSignificantWeather) result.weather = '';
    if (record.cavok) {
        result.cover = 'CAVOK';
        result.weather = '';
        result.verticalVisibility = null;
    }
    return result;
}

function normalizeTaf(records) {
    const record = Array.isArray(records) ? records.filter(item => item.icaoId === 'LSGG' && Array.isArray(item.fcsts))
        .sort((a, b) => Date.parse(b.issueTime) - Date.parse(a.issueTime))[0] : null;
    const validFrom = timestamp(record?.validTimeFrom);
    const validTo = timestamp(record?.validTimeTo);
    if (!record || !validFrom || !validTo || validTo <= validFrom ||
        !Number.isFinite(Date.parse(record.issueTime)) || typeof record.rawTAF !== 'string' || !record.fcsts.length) {
        throw new Error('Invalid TAF');
    }
    // JSON null weather can mean unchanged, but raw CAVOK/NSW explicitly clears
    // earlier adverse weather. Recognize these markers without decoding the TAF.
    const markers = [...record.rawTAF.matchAll(/\b(?:PROB(?:30|40)(?:\s+TEMPO)?|TEMPO|BECMG|FM\d{6})\b/g)];
    const starts = [0, ...markers.map(match => match.index)];
    const sections = starts.map((start, index) => record.rawTAF.slice(start, starts[index + 1] ?? record.rawTAF.length));
    const groups = record.fcsts.map((group, index) => sections.length === record.fcsts.length ? {
        ...group, cavok: /\bCAVOK\b/.test(sections[index]), noSignificantWeather: /\bNSW\b/.test(sections[index])
    } : group);
    const initial = groups.find(group => !group.fcstChange);
    if (!initial) throw new Error('TAF has no prevailing conditions');
    let state = conditions(initial);
    let cursor = validFrom;
    const periods = [];
    const add = (from, to, data, extra = {}) => {
        if (to > from) periods.push({ ...data, from, to, kind: 'Prevailing', probability: null,
            runway: runwayFor(data), ...extra });
    };
    const changes = groups.filter(group => ['FM', 'BECMG'].includes(group.fcstChange))
        .sort((a, b) => a.timeFrom - b.timeFrom);
    for (const change of changes) {
        const from = timestamp(change.timeFrom);
        if (!from || from < cursor || from >= validTo) throw new Error('Invalid TAF change interval');
        add(cursor, from, state);
        const target = change.fcstChange === 'FM' ? conditions(change) : mergeConditions(state, change);
        if (change.fcstChange === 'BECMG') {
            const to = Math.min(timestamp(change.timeTo) || from, validTo);
            if (to <= from) throw new Error('Invalid TAF transition');
            add(from, to, target, { kind: 'Becoming', previousWind: {
                windDirection: state.windDirection, windSpeed: state.windSpeed, variableWind: state.variableWind
            }, runway: unknown('Conditions changing during this interval; runway uncertain') });
            cursor = to;
        } else cursor = from;
        state = target;
    }
    add(cursor, validTo, state);
    // Temporary/probability forecasts are alternatives, never replacements for
    // the prevailing state. Split them where that underlying state changes.
    const prevailing = [...periods];
    for (const group of groups.filter(group => ![null, undefined, 'FM', 'BECMG'].includes(group.fcstChange))) {
        const from = timestamp(group.timeFrom);
        const to = timestamp(group.timeTo);
        if (!from || !to || to <= from) throw new Error('Invalid TAF alternative interval');
        for (const base of prevailing) {
            const start = Math.max(from, base.from);
            const end = Math.min(to, base.to);
            if (end <= start) continue;
            const data = mergeConditions(base, group);
            const probability = [30, 40].includes(group.probability) ? group.probability : null;
            add(start, end, data, { kind: group.fcstChange === 'TEMPO' ? 'Temporary' : 'Possible', probability,
                runway: base.kind === 'Becoming' ? unknown('Conditions changing during this interval; runway uncertain') : runwayFor(data) });
        }
    }
    periods.sort((a, b) => a.from - b.from || (a.kind === 'Prevailing' ? -1 : b.kind === 'Prevailing' ? 1 : a.to - b.to));
    // TAF TX/TN extrema are useful for visitors, but are not hourly temperatures.
    const temperatures = [...record.rawTAF.matchAll(/\b(TX|TN)(M?\d{2})\/(\d{2})(\d{2})Z\b/g)].map(match => {
        const candidates = [-1, 0, 1].map(offset => {
            const date = new Date(validFrom);
            date.setUTCMonth(date.getUTCMonth() + offset, Number(match[3]));
            date.setUTCHours(Number(match[4]), 0, 0, 0);
            return date.getTime();
        });
        return { kind: match[1] === 'TX' ? 'Maximum' : 'Minimum',
            temperature: Number(match[2].replace('M', '-')),
            at: candidates.find(at => at >= validFrom && at <= validTo) ?? null };
    }).filter(item => item.at !== null);
    return { issuedAt: Date.parse(record.issueTime), validFrom, validTo, raw: record.rawTAF, periods, temperatures };
}

function createAviationWeatherService({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    function product(name, normalize) {
        let snapshot = null;
        let updatedAt = 0;
        let retryAfter = 0;
        let failed = false;
        let inFlight = null;
        async function refresh() {
            try {
                const response = await fetchImpl(`https://aviationweather.gov/api/data/${name}?ids=LSGG&format=json`, {
                    headers: { 'User-Agent': 'geneva-runway/1.0 (LSGG weather)' }, signal: AbortSignal.timeout(10_000)
                });
                if (!response.ok || response.status === 204) throw new Error('Weather unavailable');
                snapshot = normalize(await response.json());
                updatedAt = now();
                failed = false;
            } catch {
                failed = true;
                retryAfter = now() + RETRY_MS;
            }
        }
        return async () => {
            if ((!snapshot || now() - updatedAt >= CACHE_MS || failed) && now() >= retryAfter) {
                if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
                await inFlight;
            }
            if (!snapshot) return null;
            const expired = name === 'metar' ? now() - snapshot.observedAt > MAX_OBSERVATION_AGE || snapshot.observedAt > now() + 5 * 60000
                : snapshot.validTo <= now();
            return { ...snapshot, updatedAt, stale: failed || expired || now() - updatedAt >= CACHE_MS };
        };
    }
    const metar = product('metar', normalizeMetar);
    const taf = product('taf', normalizeTaf);
    return {
        async getForecast() {
            const [current, forecast] = await Promise.all([metar(), taf()]);
            if (!current && !forecast) throw new Error('Aviation weather unavailable');
            const limit = now() + FIVE_DAYS;
            return { location: 'Geneva Airport', timezone: 'Europe/Zurich',
                current: current && { ...current, runway: current.stale ? unknown('METAR is stale') : current.runway },
                forecast: forecast && { ...forecast, periods: forecast.periods
                    .filter(period => period.to > now() && period.from < limit)
                    .map(period => ({ ...period, to: Math.min(period.to, limit),
                        runway: forecast.stale ? unknown('TAF is stale') : period.runway })) },
                stale: !current || !forecast || current.stale || forecast.stale };
        }
    };
}

module.exports = { createAviationWeatherService, normalizeMetar, normalizeTaf };
