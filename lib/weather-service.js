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
    windDirection: 'wind_direction_10m_dominant',
    sunrise: 'sunrise',
    sunset: 'sunset'
};

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
            day[name] = name === 'sunrise' || name === 'sunset'
                ? (typeof value === 'string' && new RegExp(`^${date}T\\d{2}:\\d{2}$`).test(value) ? value : null)
                : (Number.isFinite(value) ? value : null);
        }
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
                precipitation_unit: 'mm', daily: Object.values(DAILY_FIELDS).join(',')
            }).toString();
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error('Weather provider unavailable');
            const days = normalizeForecast(await response.json());
            if (days[0].date !== genevaDate(now())) throw new Error('Outdated forecast response');
            snapshot = { location: 'Geneva Airport', timezone: 'Europe/Zurich', updatedAt: now(), days };
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

module.exports = { createWeatherService };
