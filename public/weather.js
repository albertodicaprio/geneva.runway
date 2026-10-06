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

    function runwayText(runway) {
        return ['04', '22'].includes(runway?.direction)
            ? `Likely runway ${runway.direction}${runway.calmConditions ? ' (calm conditions)' : ''}` : 'Runway unknown';
    }

    function addLastArrival(add, arrival) {
        const known = arrival && ['04', '22'].includes(arrival.direction);
        const badge = add('p', known ? `Last arrival: runway ${arrival.direction}` : 'Last arrival: runway unknown', 'weather-runway weather-last-arrival');
        badge.title = arrival ? `Landing estimated ${new Intl.DateTimeFormat('en-GB', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich'
        }).format(new Date(arrival.estimatedLandingAt))}${arrival.stale ? ' · tracking stale' : ''}` : 'No recent arrival recorded';
    }

    function addWindCompass(add, document, data, daily = false) {
        const panel = add('div', '', 'weather-wind');
        const figure = add('figure', '', 'wind-compass', panel);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 160 160');
        svg.setAttribute('role', 'img');
        const speedKnown = Number.isFinite(data.windSpeed) && data.windSpeed >= 0;
        const gustKnown = Number.isFinite(data.windGusts) && data.windGusts >= 0;
        const calm = speedKnown && data.windSpeed === 0 && (!gustKnown || data.windGusts === 0);
        const directionKnown = Number.isFinite(data.windDirection) && data.windDirection >= 0 && data.windDirection <= 360;
        const directional = speedKnown && !calm && !data.variableWind && directionKnown;
        const from = calm ? 'Calm' : data.variableWind ? 'Variable' : directionKnown ? windDirection(data.windDirection) : 'Direction unavailable';
        svg.setAttribute('aria-label', `North-up compass. Geneva runway 04/22, 046°/226° true. Wind from ${from}, ${number(data.windSpeed, ' km/h')}; gusts ${number(data.windGusts, ' km/h')}.`);
        figure.append(svg);
        function shape(tag, attributes, text, parent = svg) {
            const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
            if (text) node.textContent = text;
            parent.append(node);
            return node;
        }
        shape('circle', { cx: 80, cy: 80, r: 57, class: 'compass-ring' });
        for (const [label, x, y] of [['N', 80, 13], ['E', 149, 84], ['S', 80, 155], ['W', 11, 84]]) {
            shape('text', { x, y, class: 'compass-cardinal', 'text-anchor': 'middle' }, label);
        }
        const runway = shape('g', { transform: 'rotate(46 80 80)', class: 'compass-runway' });
        shape('rect', { x: 72, y: 37, width: 16, height: 86, rx: 3 }, null, runway);
        shape('line', { x1: 80, y1: 59, x2: 80, y2: 101, class: 'compass-centerline' }, null, runway);
        for (const [label, y] of [['22', 48], ['04', 118]]) {
            shape('text', { x: 80, y, 'text-anchor': 'middle', class: 'compass-runway-label' }, label, runway);
        }
        if (directional) {
            const wind = shape('g', { transform: `rotate(${data.windDirection} 80 80)`, class: 'compass-wind' });
            // Use the same fixed scale for every card. Cap the drawing at 60 km/h
            // to keep it inside the compass; the readout retains the actual value.
            function arrowPath(speed) {
                const strength = Math.min(speed / 60, 1);
                const tip = 26 + 22 + 30 * strength;
                const neck = tip - (6 + 7 * strength);
                const shaft = 1.7 + 2.3 * strength;
                const head = 5 + 5 * strength;
                return `M ${80 - shaft} 26 L ${80 + shaft} 26 L ${80 + shaft} ${neck} L ${80 + head} ${neck} L 80 ${tip} L ${80 - head} ${neck} L ${80 - shaft} ${neck} Z`;
            }
            if (gustKnown && data.windGusts > 0) {
                shape('path', { d: arrowPath(data.windGusts), class: 'compass-gust-arrow' }, null, wind);
            }
            if (data.windSpeed > 0) {
                shape('path', { d: arrowPath(data.windSpeed), class: 'compass-wind-arrow' }, null, wind);
            }
        } else {
            shape('circle', { cx: 80, cy: 80, r: 25, class: 'compass-uncertain' });
        }
        add('figcaption', '04/22 · 046°/226° true', 'compass-caption', figure);
        const legend = add('div', '', 'compass-legend', figure);
        legend.title = 'Arrow length and width show strength on a shared scale, capped at 60 km/h. Solid: wind; outline: gusts.';
        add('span', 'Wind', 'compass-wind-key', legend);
        add('span', 'Gusts', 'compass-gust-key', legend);
        const metrics = add('dl', '', 'weather-metrics wind-metrics', panel);
        for (const [label, value] of [
            [daily ? 'Max wind' : 'Wind', number(data.windSpeed, ' km/h')],
            [daily ? 'Max gusts' : 'Gusts', number(data.windGusts, ' km/h')],
            ['Wind from', from]
        ]) {
            const row = add('div', '', '', metrics);
            add('dt', label, '', row);
            add('dd', value, '', row);
        }
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
            const runway = add('p', runwayText(day.runway), 'weather-runway');
            runway.title = day.runway?.reason || 'Wind data unavailable';
            if (day.isCurrent) {
                addLastArrival(add, data.lastArrival);
            }
            addWindCompass(add, document, day, !day.isCurrent);
            const metrics = add('dl', '', 'weather-metrics');
            for (const [label, value] of [
                ...(day.isCurrent ? [] : [['Precipitation chance', number(day.precipitationProbability, '%')]]),
                [day.isCurrent ? 'Recent precipitation' : 'Precipitation', number(day.precipitation, ' mm', 1)]
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
        const error = document.getElementById('weatherError');
        const forecast = document.getElementById('weatherForecast');
        let hasForecast = false;
        let loading = false;

        async function load() {
            if (loading) return;
            loading = true;
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
                    : 'Could not load the forecast. Retrying automatically shortly.';
                error.hidden = false;
                if (!hasForecast) forecast.replaceChildren();
            } finally {
                loading = false;
                forecast.setAttribute('aria-busy', 'false');
            }
        }
        setIntervalImpl(() => { if (!document.hidden) load(); }, 30 * 1000);
        load();
        return { load };
    }

    const api = { condition, number, windDirection, runwayText, addLastArrival, addWindCompass, renderForecast, start };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        window.GenevaWeather = api;
        if (document.body.dataset.weatherSource !== 'aviation') start({ document });
    }
})();
