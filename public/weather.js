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

    function windDirection(value) {
        if (!Number.isFinite(value)) return '—';
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        return `${directions[Math.round(((value % 360 + 360) % 360) / 45) % 8]} · ${Math.round(value)}°`;
    }

    function renderForecast(data, document) {
        const container = document.getElementById('weatherForecast');
        const entries = [{ ...data.current, isCurrent: true }, ...data.days].slice(0, 6);
        if (entries.length % 2) entries.pop();
        const cards = entries.map(day => {
            const card = document.createElement('article');
            card.className = day.isCurrent ? 'weather-day weather-now' : 'weather-day';
            const add = (tag, text, className, parent = card) => {
                const element = document.createElement(tag);
                element.textContent = text;
                if (className) element.className = className;
                parent.append(element);
                return element;
            };
            const dateString = day.isCurrent ? day.time.slice(0, 10) : day.date;
            const date = new Date(`${dateString}T12:00:00Z`);
            add('h3', day.isCurrent ? 'Now' : new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/Zurich' }).format(date));
            const label = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Zurich' }).format(date);
            const dateLabel = add('time', day.isCurrent ? `${label} · ${day.time.slice(11, 16)}` : label, 'weather-date');
            dateLabel.dateTime = day.isCurrent ? day.time : day.date;
            const [description, icon] = condition(day.weatherCode);
            add('div', icon, 'weather-icon').setAttribute('aria-hidden', 'true');
            add('p', description, 'weather-condition');
            add('p', day.isCurrent ? number(day.temperature, '°C') : `${number(day.temperatureMax, '°C')} / ${number(day.temperatureMin, '°C')}`, 'weather-temperature');
            add('p', day.isCurrent ? 'Current temperature' : 'High / low', 'weather-date');
            const direction = day.runway?.direction;
            const runway = add('p', direction === '04' || direction === '22' ? `Likely runway ${direction}` : 'Runway unknown', 'weather-runway');
            runway.title = day.runway?.reason || 'Wind data unavailable';
            if (day.isCurrent) {
                const arrival = data.lastArrival;
                const known = arrival && ['04', '22'].includes(arrival.direction);
                add('p', known ? `Last arrival: runway ${arrival.direction}` : 'Last arrival: runway unknown', 'weather-runway');
                const detail = arrival ? `${arrival.callsign} · landing estimated ${new Intl.DateTimeFormat('en-GB', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich'
                }).format(new Date(arrival.estimatedLandingAt))}${arrival.stale ? ' · tracking stale' : ''}` : 'No recent arrival recorded';
                add('p', detail, 'weather-arrival-note');
            }
            const metrics = add('dl', '', 'weather-metrics');
            for (const [label, value] of [
                ...(day.isCurrent ? [] : [['Precipitation chance', number(day.precipitationProbability, '%')]]),
                [day.isCurrent ? 'Recent precipitation' : 'Precipitation', number(day.precipitation, ' mm', 1)],
                [day.isCurrent ? 'Wind' : 'Max wind', number(day.windSpeed, ' km/h')],
                [day.isCurrent ? 'Gusts' : 'Max gusts', number(day.windGusts, ' km/h')],
                ['Wind from', windDirection(day.windDirection)]
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
        setIntervalImpl(() => { if (!document.hidden) load(); }, 30 * 1000);
        load();
        return { load };
    }

    if (typeof module === 'object' && module.exports) module.exports = { condition, number, windDirection, renderForecast, start };
    else start({ document });
})();
