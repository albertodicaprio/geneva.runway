const { genevaDate, validDate } = require('./flight-history');

const CACHE_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const DAILY_FIELDS = {
    weatherCode: 'weather_code',
    temperatureMax: 'temperature_2m_max',
    temperatureMin: 'temperature_2m_min',
    precipitationProbability: 'precipitation_probability_max',
    precipitation: 'precipitation_sum',
    windSpeed: 'wind_speed_10m_max',
    windGusts: 'wind_gusts_10m_max',
    windDirection: 'wind_direction_10m_dominant'
};
const CURRENT_FIELDS = {
    weatherCode: 'weather_code', temperature: 'temperature_2m',
    precipitation: 'precipitation', windSpeed: 'wind_speed_10m',
    windGusts: 'wind_gusts_10m', windDirection: 'wind_direction_10m'
};

// Wind direction is where the wind comes from. Prefer the runway facing it.
// These approximate bearings match the app's existing 04/22 runway model.
function predictRunway(windDirection, windSpeed) {
    const unknown = reason => ({ direction: 'unknown', reason });
    if (!Number.isFinite(windDirection) || windDirection < 0 || windDirection > 360 ||
        !Number.isFinite(windSpeed) || windSpeed < 0) return unknown('Wind data unavailable');
    if (windSpeed < 5) return unknown('Light or calm wind');
    const difference = Math.abs(((windDirection - 40 + 540) % 360) - 180);
    const alignment = Math.min(difference, 180 - difference);
    if (alignment >= 75) return unknown('Wind mainly across the runway');
    return { direction: difference < 90 ? '04' : '22', reason: 'Runway faces the forecast wind' };
}

function normalizeCurrent(data) {
    const current = data?.current;
    if (!current || typeof current.time !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(current.time) ||
        !validDate(current.time.slice(0, 10)) ||
        !Object.values(CURRENT_FIELDS).every(field => Object.hasOwn(current, field))) {
        throw new Error('Invalid current conditions response');
    }
    const result = { time: current.time };
    for (const [name, field] of Object.entries(CURRENT_FIELDS)) {
        result[name] = Number.isFinite(current[field]) ? current[field] : null;
    }
    result.runway = predictRunway(result.windDirection, result.windSpeed);
    return result;
}

function normalizeForecast(data) {
    const daily = data?.daily;
    if (!Array.isArray(daily?.time) || daily.time.length !== 5 ||
        !daily.time.every(date => validDate(date)) ||
        daily.time.some((date, index) => index > 0 &&
            Date.parse(`${date}T00:00:00Z`) - Date.parse(`${daily.time[index - 1]}T00:00:00Z`) !== 86400000) ||
        !Object.values(DAILY_FIELDS).every(field => Array.isArray(daily[field]) && daily[field].length === 5)) {
        throw new Error('Invalid forecast response');
    }
    return daily.time.map((date, index) => {
        const day = { date };
        for (const [name, field] of Object.entries(DAILY_FIELDS)) {
            const value = daily[field][index];
            day[name] = Number.isFinite(value) ? value : null;
        }
        day.runway = predictRunway(day.windDirection, day.windSpeed);
        return day;
    });
}

function createWeatherService({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let snapshot = null;
    let inFlight = null;
    let retryAfter = 0;
    let lastRefreshFailed = false;

    function result() {
        if (!snapshot) throw new Error('Weather forecast unavailable');
        return { ...snapshot, stale: lastRefreshFailed || now() - snapshot.updatedAt >= CACHE_MS ||
            snapshot.days[0].date !== genevaDate(now()) };
    }

    async function refresh() {
        try {
            const url = new URL('https://api.open-meteo.com/v1/forecast');
            url.search = new URLSearchParams({
                latitude: '46.2381', longitude: '6.1093', timezone: 'Europe/Zurich',
                forecast_days: '5', temperature_unit: 'celsius', wind_speed_unit: 'kmh',
                precipitation_unit: 'mm', daily: Object.values(DAILY_FIELDS).join(','),
                current: Object.values(CURRENT_FIELDS).join(',')
            }).toString();
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error('Weather provider unavailable');
            const data = await response.json();
            const days = normalizeForecast(data);
            const current = normalizeCurrent(data);
            if (days[0].date !== genevaDate(now())) throw new Error('Outdated forecast response');
            snapshot = { location: 'Geneva Airport', timezone: 'Europe/Zurich', updatedAt: now(), current, days };
            lastRefreshFailed = false;
        } catch {
            lastRefreshFailed = true;
            retryAfter = now() + RETRY_MS;
        }
        return result();
    }

    return {
        async getForecast() {
            if (snapshot && now() - snapshot.updatedAt < CACHE_MS &&
                snapshot.days[0].date === genevaDate(now()) && !lastRefreshFailed) return result();
            if (now() < retryAfter) return result();
            if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
            return inFlight;
        }
    };
}

module.exports = { createWeatherService, predictRunway };
