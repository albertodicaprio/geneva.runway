(function () {
    const CONDITIONS = {
        0: ['Clear sky', '☀'], 1: ['Mainly clear', '☀'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'],
        45: ['Fog', '≋'], 48: ['Freezing fog', '≋'],
        51: ['Light drizzle', '☂'], 53: ['Moderate drizzle', '☂'], 55: ['Heavy drizzle', '☂'],
        56: ['Light freezing drizzle', '☂'], 57: ['Heavy freezing drizzle', '☂'],
        61: ['Light rain', '☂'], 63: ['Moderate rain', '☂'], 65: ['Heavy rain', '☂'],
        66: ['Light freezing rain', '☂'], 67: ['Heavy freezing rain', '☂'],
        71: ['Light snow', '❄'], 73: ['Moderate snow', '❄'], 75: ['Heavy snow', '❄'], 77: ['Snow grains', '❄'],
        80: ['Light showers', '☂'], 81: ['Moderate showers', '☂'], 82: ['Heavy showers', '☂'],
        85: ['Light snow showers', '❄'], 86: ['Heavy snow showers', '❄'],
        95: ['Thunderstorm', 'ϟ'], 96: ['Thunderstorm with hail', 'ϟ'],
        97: ['Heavy thunderstorm', 'ϟ'], 99: ['Thunderstorm with heavy hail', 'ϟ']
    };
    const number = (value, unit, digits = 0) => Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
    const condition = code => CONDITIONS[code] || ['Conditions unavailable', '—'];
    const daylight = value => typeof value === 'string' ? value.slice(11, 16) : '—';

    function windDirection(value) {
        if (!Number.isFinite(value)) return '—';
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        return `${directions[Math.round(((value % 360 + 360) % 360) / 45) % 8]} · ${Math.round(value)}°`;
    }

    function renderForecast(data, document) {
        const container = document.getElementById('weatherForecast');
        const cards = data.days.map(day => {
            const card = document.createElement('article');
            card.className = 'weather-day';
            const add = (tag, text, className, parent = card) => {
                const element = document.createElement(tag);
                element.textContent = text;
                if (className) element.className = className;
                parent.append(element);
                return element;
            };
            const date = new Date(`${day.date}T12:00:00Z`);
            add('h3', new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/Zurich' }).format(date));
            const dateLabel = add('time', new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Zurich' }).format(date), 'weather-date');
            dateLabel.dateTime = day.date;
            const [description, icon] = condition(day.weatherCode);
            add('div', icon, 'weather-icon').setAttribute('aria-hidden', 'true');
            add('p', description, 'weather-condition');
            add('p', `${number(day.temperatureMax, '°C')} / ${number(day.temperatureMin, '°C')}`, 'weather-temperature');
            add('p', 'High / low', 'weather-date');
            const metrics = add('dl', '', 'weather-metrics');
            for (const [label, value] of [
                ['Precipitation chance', number(day.precipitationProbability, '%')],
                ['Precipitation', number(day.precipitation, ' mm', 1)],
                ['Max wind', number(day.windSpeed, ' km/h')],
                ['Max gusts', number(day.windGusts, ' km/h')],
                ['Wind from', windDirection(day.windDirection)],
                ['Sunrise', daylight(day.sunrise)], ['Sunset', daylight(day.sunset)]
            ]) {
                const row = add('div', '', '', metrics);
                add('dt', label, '', row);
                add('dd', value, '', row);
            }
            return card;
        });
        container.replaceChildren(...cards);
        document.getElementById('weatherUpdated').textContent = `Forecast fetched ${new Intl.DateTimeFormat('en-GB', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich'
        }).format(new Date(data.updatedAt))} · Geneva time`;
    }

    function start({ document, fetchImpl = fetch, setIntervalImpl = setInterval }) {
        const status = document.getElementById('weatherStatus');
        const button = document.getElementById('weatherRefresh');
        const error = document.getElementById('weatherError');
        const forecast = document.getElementById('weatherForecast');
        let hasForecast = false;
        let loading = false;

        async function load() {
            if (loading) return;
            loading = true;
            button.disabled = true;
            forecast.setAttribute('aria-busy', 'true');
            try {
                const response = await fetchImpl('/api/weather', { signal: AbortSignal.timeout(15_000) });
                if (!response.ok) throw new Error('Forecast request failed');
                const data = await response.json();
                renderForecast(data, document);
                hasForecast = true;
                status.textContent = data.stale ? 'Cached forecast · stale' : 'Forecast available';
                status.classList.toggle('weather-status-warning', data.stale);
                error.hidden = !data.stale;
                error.textContent = data.stale ? 'Open-Meteo is unavailable. Showing the last saved forecast; check its dates and fetched time.' : '';
            } catch {
                status.textContent = hasForecast ? 'Forecast update failed' : 'Weather unavailable';
                status.classList.add('weather-status-warning');
                error.textContent = hasForecast
                    ? 'Could not update the forecast. Showing the previously loaded forecast; check its dates and fetched time.'
                    : 'Could not load the forecast. Please try Refresh shortly.';
                error.hidden = false;
                if (!hasForecast) forecast.replaceChildren();
            } finally {
                loading = false;
                button.disabled = false;
                forecast.setAttribute('aria-busy', 'false');
            }
        }
        button.addEventListener('click', load);
        setIntervalImpl(() => { if (!document.hidden) load(); }, 30 * 60 * 1000);
        load();
        return { load };
    }

    if (typeof module === 'object' && module.exports) module.exports = { condition, number, windDirection, renderForecast, start };
    else start({ document });
})();
