(function () {
    const weather = typeof module === 'object' && module.exports ? require('./weather') : window.GenevaWeather;
    const dateFormat = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich'
    });
    const formatTime = value => dateFormat.format(new Date(value));
    const windFrom = data => data.windSpeed === 0 ? 'Calm' : data.variableWind ? 'Variable' : weather.windDirection(data.windDirection);
    const WX = { RA: 'Rain', DZ: 'Drizzle', SN: 'Snow', SG: 'Snow grains', PL: 'Ice pellets',
        GR: 'Hail', GS: 'Small hail', BR: 'Mist', FG: 'Fog', HZ: 'Haze', FU: 'Smoke',
        DU: 'Dust', SA: 'Sand', VA: 'Volcanic ash', TS: 'Thunderstorm', SH: 'Showers',
        FZ: 'Freezing', SQ: 'Squalls', FC: 'Funnel cloud', UP: 'Precipitation' };
    function description(data) {
        if (data.weather) return data.weather.split(/\s+/).map(group => {
            const parts = group.match(/[A-Z]{2}/g) || [];
            const decoded = parts.map(part => WX[part] || part).join(' ');
            const prefix = group.startsWith('-') ? 'Light ' : group.startsWith('+') ? 'Heavy ' : '';
            return prefix + decoded + ` (${group})`;
        }).join(' · ');
        if (data.cover === 'CAVOK') return 'Visibility and clouds OK (CAVOK)';
        if (data.clouds?.some(cloud => cloud.cover === 'OVC')) return 'Overcast';
        if (data.clouds?.some(cloud => cloud.cover === 'BKN')) return 'Broken cloud';
        if (data.clouds?.some(cloud => ['SCT', 'FEW'].includes(cloud.cover))) return 'Partly cloudy';
        if (data.clouds?.some(cloud => ['NSC', 'NCD', 'CLR', 'SKC'].includes(cloud.cover))) return 'No significant cloud';
        return 'No significant weather reported';
    }
    function visibility(value) {
        if (value === '6+') return '10 km or more';
        return value !== null && Number.isFinite(Number(value)) ? `${(Number(value) * 1.609344).toFixed(1)} km` : '—';
    }
    function cloudLabel(data) {
        if (data.cover === 'CAVOK') return 'No significant low cloud';
        const covers = { FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast',
            NSC: 'No significant cloud', NCD: 'No cloud detected', CLR: 'Clear', SKC: 'Clear', VV: 'Obscured', OVX: 'Sky obscured' };
        const layers = (data.clouds || []).map(cloud => `${covers[cloud.cover] || cloud.cover}${
            Number.isFinite(cloud.base) ? ` at ${cloud.base.toLocaleString('en-GB')} ft` : ''}${cloud.type ? ` (${cloud.type})` : ''}`);
        if (Number.isFinite(data.verticalVisibility)) layers.push(`Vertical visibility ${data.verticalVisibility} ft`);
        return layers.join(' · ') || '—';
    }

    function renderForecast(data, document) {
        const container = document.getElementById('weatherForecast');
        const cards = [];
        function cardFor(entry, title, date, current = false) {
            const card = document.createElement('article');
            card.className = current ? 'weather-day weather-now' : 'weather-day';
            const add = (tag, text, className, parent = card) => {
                const element = document.createElement(tag);
                element.textContent = text;
                if (className) element.className = className;
                parent.append(element);
                return element;
            };
            add('h3', title);
            add('p', date, 'weather-date');
            add('p', description(entry), 'weather-condition');
            if (current) {
                add('p', weather.number(entry.temperature, '°C'), 'weather-temperature');
                add('p', 'Observed temperature', 'weather-date');
            } else {
                add('p', `${entry.probability ? `${entry.probability}% chance · ` : ''}${entry.kind}`, 'weather-period');
                if (entry.previousWind) add('p', `Wind changing from ${windFrom(entry.previousWind)} at ${weather.number(entry.previousWind.windSpeed, ' km/h')}`, 'weather-date');
            }
            const runway = add('p', weather.runwayText(entry.runway), 'weather-runway');
            runway.title = entry.runway?.reason || 'Wind data unavailable';
            if (current) weather.addLastArrival(add, data.lastArrival);
            const metrics = add('dl', '', 'weather-metrics');
            const rows = [
                ['Wind', weather.number(entry.windSpeed, ' km/h')], ['Gusts', weather.number(entry.windGusts, ' km/h')],
                ['Wind from', windFrom(entry)], ['Visibility', visibility(entry.visibility)], ['Clouds (above airport)', cloudLabel(entry)]
            ];
            if (current) rows.push(['Dew point', weather.number(entry.dewPoint, '°C')],
                ['Pressure (QNH)', weather.number(entry.pressure, ' hPa')],
                ['Report', `${entry.automatic ? 'Automatic' : 'METAR'}${entry.stale ? ' · stale' : ''}`]);
            if (entry.windVariation) rows.push(['Direction varies', `${entry.windVariation.slice(0, 3)}° to ${entry.windVariation.slice(4)}°`]);
            if (!current) {
                for (const extreme of data.forecast.temperatures.filter(item => item.at >= entry.from && item.at < entry.to)) {
                    rows.push([`${extreme.kind} temperature`, `${weather.number(extreme.temperature, '°C')} · ${formatTime(extreme.at)}`]);
                }
            }
            for (const [label, value] of rows) {
                const row = add('div', '', '', metrics);
                add('dt', label, '', row);
                add('dd', value, '', row);
            }
            if (current) {
                const raw = add('details', '', 'weather-raw');
                add('summary', 'Raw METAR', '', raw);
                add('pre', entry.raw, '', raw);
            }
            return card;
        }
        if (data.current) cards.push(cardFor(data.current, 'Now (METAR)', `Observed ${formatTime(data.current.observedAt)}${data.current.stale ? ' · stale' : ''}`, true));
        else {
            const card = document.createElement('article');
            card.className = 'weather-day weather-now';
            const title = document.createElement('h3');
            title.textContent = 'Now (METAR)';
            const message = document.createElement('p');
            message.textContent = 'METAR currently unavailable. Retrying automatically.';
            card.append(title); card.append(message); cards.push(card);
        }
        for (const period of data.forecast?.periods || []) {
            const label = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/Zurich' }).format(new Date(period.from));
            cards.push(cardFor(period, `${label} (TAF)`, `${formatTime(period.from)} – ${formatTime(period.to)}`));
        }
        container.replaceChildren(...cards);
        const updated = document.getElementById('weatherUpdated');
        updated.replaceChildren();
        const info = document.createElement('p');
        info.textContent = [data.current ? `METAR fetched ${formatTime(data.current.updatedAt)}` : 'METAR unavailable',
            data.forecast ? `TAF issued ${formatTime(data.forecast.issuedAt)} · valid ${formatTime(data.forecast.validFrom)} – ${formatTime(data.forecast.validTo)}` : 'TAF unavailable',
            'Geneva time'].join(' · ');
        updated.append(info);
        if (data.forecast) {
            const raw = document.createElement('details'); raw.className = 'weather-raw';
            const summary = document.createElement('summary'); summary.textContent = 'Raw TAF';
            const report = document.createElement('pre'); report.textContent = data.forecast.raw;
            raw.append(summary); raw.append(report); updated.append(raw);
            if (!data.forecast.periods.length) {
                const message = document.createElement('p');
                message.textContent = 'No unexpired TAF forecast periods available.';
                updated.append(message);
            }
        }
    }

    function start({ document, fetchImpl = fetch, setIntervalImpl = setInterval }) {
        const status = document.getElementById('weatherStatus');
        const error = document.getElementById('weatherError');
        const forecast = document.getElementById('weatherForecast');
        let loading = false;
        let hasForecast = false;
        async function load() {
            if (loading) return;
            loading = true;
            forecast.setAttribute('aria-busy', 'true');
            try {
                const response = await fetchImpl('/api/aviation-weather', { signal: AbortSignal.timeout(15_000) });
                if (!response.ok) throw new Error('Weather request failed');
                const data = await response.json();
                renderForecast(data, document);
                hasForecast = true;
                status.textContent = data.stale ? 'Airport weather · incomplete or stale' : 'Airport weather available';
                status.classList.toggle('weather-status-warning', data.stale);
                const warnings = [];
                if (!data.current) warnings.push('METAR is unavailable.');
                else if (data.current.stale) warnings.push('METAR is stale; check its observation time.');
                if (!data.forecast) warnings.push('TAF is unavailable.');
                else if (data.forecast.stale) warnings.push('TAF is stale; check its issue time and validity.');
                error.hidden = warnings.length === 0;
                error.textContent = warnings.join(' ');
            } catch {
                status.textContent = 'Airport weather unavailable';
                status.classList.add('weather-status-warning');
                error.hidden = false;
                error.textContent = hasForecast ? 'Update failed. Previously loaded reports remain below; check their dates and validity.' : 'Could not load airport weather. Retrying automatically shortly.';
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
    if (typeof module === 'object' && module.exports) module.exports = { renderForecast, start, description, visibility, cloudLabel };
    else start({ document });
})();
