const GenevaStats = (() => {
    const INITIAL_CHART_ITEMS = 8;
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function chartContent(title, data, total) {
        const rows = data.items.map((item, index) => {
            const examples = item.examples?.length
                ? ` (${item.examples.join(', ')}${item.moreExamples ? ', …' : ''})` : '';
            const label = item.name + examples;
            return `<li${index >= INITIAL_CHART_ITEMS ? ' data-extra hidden' : ''}>
                <div class="stats-bar-label"><span>${escapeHtml(label)}</span><strong>${item.count}</strong></div>
                <progress value="${item.count}" max="${Math.max(total, 1)}" aria-label="${escapeHtml(label)}: ${item.count} of ${total} flights"></progress>
            </li>`;
        }).join('');
        return `<p class="history-note">Known for ${data.known} of ${total} flights</p>
            ${rows ? `<ol class="stats-bars">${rows}</ol>` : '<p class="no-aircraft">No known values yet.</p>'}
            ${data.items.length > INITIAL_CHART_ITEMS ? `<label class="stats-show-all"><input type="checkbox" data-stats-expand> Show all ${data.items.length} ${title.toLowerCase()}</label>` : ''}`;
    }

    function chart(title, data, total) {
        return `<section class="stats-chart"><h2>${title}</h2>${chartContent(title, data, total)}</section>`;
    }

    function modelChart(group, mode = 'icao') {
        return `<section class="stats-chart" data-model-chart>
            <div class="model-chart-header"><h2>Aircraft models</h2>
                <div class="model-toggle" role="group" aria-label="Aircraft model view">
                    <button type="button" data-model-choice="icao" aria-pressed="${mode === 'icao'}">Group</button>
                    <button type="button" data-model-choice="type" aria-pressed="${mode === 'type'}">Detail</button>
                </div>
            </div>
            <div data-model-mode="icao"${mode === 'icao' ? '' : ' hidden'}>${chartContent('Aircraft models', group.icaoTypes, group.total)}</div>
            <div data-model-mode="type"${mode === 'type' ? '' : ' hidden'}>${chartContent('Aircraft models', group.models, group.total)}</div>
        </section>`;
    }

    function renderGroup(group, prefix, document, filter = '') {
        const summary = document.getElementById(`${prefix}Summary`);
        if (summary.querySelector?.('[data-stats-filter]')) {
            summary.querySelector('[data-stats-total]').textContent = group.total;
        } else {
            summary.innerHTML = `<div class="stats-totals">
                <div><strong data-stats-total aria-live="polite">${group.total}</strong><span>Flights seen</span></div>
                <label class="stats-filter"><span>Filter</span><input type="search" data-stats-filter="${prefix}" value="${escapeHtml(filter)}" placeholder="Search flights…" aria-controls="${prefix}Charts" aria-label="Filter ${prefix === 'landing' ? 'landings' : prefix === 'general' ? 'other traffic' : prefix} by airline, airport, registration, or aircraft model"></label>
            </div>`;
        }
        const charts = [
            ['Airlines', group.airlines],
            ...(prefix === 'landing'
                ? [['Origin airports', group.origins], ['Registrations', group.registrations]]
                : prefix === 'takeoffs'
                    ? [['Registrations', group.registrations], ['Destination airports', group.destinations]]
                    : [['Origin airports', group.origins], ['Destination airports', group.destinations],
                        ['Registrations', group.registrations], ['Busiest routes', group.routes]])
        ];
        const container = document.getElementById(`${prefix}Charts`);
        const mode = container.querySelector?.('[data-model-choice="type"][aria-pressed="true"]') ? 'type' : 'icao';
        container.innerHTML = charts.map(([title, data]) => chart(title, data, group.total)).join('') + modelChart(group, mode);
    }

    function render(data, document, filters) {
        renderOverview(data.overview, document);
        for (const view of ['landing', 'general', 'takeoffs']) renderGroup(data[view], view, document, filters[view]);
    }

    function renderOverview(overview, document) {
        const cards = [[overview.total, 'Flights seen'], [overview.aircraft, 'Distinct aircraft'],
            [overview.airlines, 'Airlines'], [overview.airports, 'Airports']];
        document.getElementById('statsOverview').innerHTML = `<div class="stats-totals stats-overview-totals">
            ${cards.map(([count, label]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join('')}
            </div><p class="history-note stats-overview-split">${overview.landings} landings · ${overview.general} other traffic · ${overview.takeoffs} takeoffs</p>
            <p class="history-note stats-overview-help">Selected period · Distinct counts use known data. Airports exclude Geneva.</p>`;
    }

    function renderHourly(hours, document) {
        const container = document.getElementById('hourlyChart');
        const series = [
            { key: 'landings', label: 'Landings', className: 'hourly-landing', enabled: document.getElementById('showHourlyLandings').checked },
            { key: 'takeoffs', label: 'Takeoffs', className: 'hourly-takeoff', enabled: document.getElementById('showHourlyTakeoffs').checked }
        ].filter(item => item.enabled);
        if (!series.length) {
            container.innerHTML = '<p class="no-aircraft">Select Landings or Takeoffs to show the chart.</p>';
            return;
        }
        const maximum = Math.max(1, ...hours.flatMap(hour => series.map(item => hour[item.key])));
        const step = Math.max(1, Math.ceil(maximum / 4));
        const ceiling = Math.ceil(maximum / step) * step;
        const baseline = 260;
        let marks = '';
        for (let count = 0; count <= ceiling; count += step) {
            const y = baseline - count / ceiling * 220;
            marks += `<line class="hourly-gridline" x1="42" x2="902" y1="${y}" y2="${y}" />` +
                `<text class="hourly-axis" x="34" y="${y + 4}" text-anchor="end">${count}</text>`;
        }
        const rows = hours.map(({ hour, ...counts }) => {
            const label = String(hour).padStart(2, '0');
            const x = 48 + hour * 35.5;
            for (const [index, item] of series.entries()) {
                const height = counts[item.key] / ceiling * 220;
                const width = series.length === 1 ? 22 : 12;
                marks += `<rect class="${item.className}" x="${x + index * 14}" y="${baseline - height}" width="${width}" height="${height}"><title>${label}:00–${label}:59 · ${item.label}: ${counts[item.key]}</title></rect>`;
            }
            marks += `<text class="hourly-axis" x="${x + 11}" y="282" text-anchor="middle">${label}</text>`;
            return `<tr><th scope="row">${label}:00–${label}:59</th>${series.map(item => `<td>${counts[item.key]}</td>`).join('')}</tr>`;
        }).join('');
        const total = hours.reduce((sum, hour) => sum + series.reduce((count, item) => count + hour[item.key], 0), 0);
        container.innerHTML = `${total ? '' : '<p class="no-aircraft">No recorded flights for the selected traffic types.</p>'}
            <div class="hourly-chart-scroll"><svg class="hourly-chart" width="920" height="310" viewBox="0 0 920 310" role="img" aria-label="Hourly ${series.map(item => item.label.toLowerCase()).join(' and ')} counts in Geneva local time. Exact counts are in the table below.">
                <text class="hourly-axis" x="42" y="20">Flights seen</text>${marks}
                <text class="hourly-axis" x="472" y="306" text-anchor="middle">Hour (Europe/Zurich)</text>
            </svg></div>
            <details class="hourly-table"><summary>View hourly counts</summary><div class="history-table-wrap"><table class="history-table"><caption>Flights first seen per hour across the selected dates</caption><thead><tr><th scope="col">Hour</th>${series.map(item => `<th scope="col">${item.label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
    }

    function monthKey(date) { return date.slice(0, 7); }
    function shiftMonth(month, amount) {
        const [year, number] = month.split('-').map(Number);
        return new Date(Date.UTC(year, number - 1 + amount, 1)).toISOString().slice(0, 7);
    }
    function dateLabel(date) {
        return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
            .format(new Date(`${date}T00:00:00Z`));
    }

    function create({ document, fetch, logger = console, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
        let requestId = 0;
        const filters = { landing: '', general: '', takeoffs: '', hourly: '' };
        let filterTimer;
        let today;
        let available = new Set();
        let month;
        let from;
        let to;
        let awaitingEnd = false;
        let hourly = null;
        function showEmpty(message) {
            hourly = null;
            document.getElementById('statsOverview').innerHTML = `<p class="no-aircraft">${message}</p>`;
            document.getElementById('hourlyChart').innerHTML = `<p class="no-aircraft">${message}</p>`;
            for (const prefix of ['landing', 'general', 'takeoffs']) {
                document.getElementById(`${prefix}Summary`).innerHTML = `<p class="no-aircraft">${message}</p>`;
                document.getElementById(`${prefix}Charts`).innerHTML = '';
            }
        }
        function renderCalendar() {
            if (!month) return;
            const monthLabel = value => new Intl.DateTimeFormat('en-GB', {
                month: 'long', year: 'numeric', timeZone: 'UTC'
            }).format(new Date(`${value}-01T00:00:00Z`));
            const months = [month, shiftMonth(month, 1)];
            document.getElementById('statsCalendarMonth').textContent = months.map(monthLabel).join(' – ');
            document.getElementById('statsCalendar').innerHTML = months.map((value, index) => {
                const [year, number] = value.split('-').map(Number);
                const firstWeekday = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7;
                const dayCount = new Date(Date.UTC(year, number, 0)).getUTCDate();
                const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                    .map(day => `<span class="stats-weekday">${day}</span>`);
                for (let i = 0; i < firstWeekday; i++) cells.push('<span aria-hidden="true"></span>');
                for (let day = 1; day <= dayCount; day++) {
                    const date = `${value}-${String(day).padStart(2, '0')}`;
                    const enabled = available.has(date) && date <= today;
                    const selected = from && to && date >= from && date <= to;
                    const range = date === from && date === to ? 'both'
                        : date === from ? 'start' : date === to ? 'end' : 'middle';
                    cells.push(`<button type="button" data-stats-date="${date}" aria-label="${dateLabel(date)}"` +
                        `${enabled ? '' : ' disabled'} aria-pressed="${Boolean(selected)}"` +
                        `${selected ? ` data-range="${range}"` : ''}` +
                        `${date === today ? ' aria-current="date"' : ''}>${day}</button>`);
                }
                return `<div class="stats-calendar-pane" role="group" aria-labelledby="statsMonth${index}">
                    <h3 id="statsMonth${index}" class="stats-month-title">${monthLabel(value)}</h3>
                    <div class="stats-calendar">${cells.join('')}</div>
                </div>`;
            }).join('');
            const earliestMonth = available.size ? monthKey([...available].sort()[0]) : null;
            document.getElementById('statsPreviousMonth').disabled = !available.size || month <= earliestMonth;
            document.getElementById('statsNextMonth').disabled = !available.size || months[1] >= monthKey(today);
            document.getElementById('statsRangeLabel').textContent = !available.size
                ? 'No recorded flight days yet.'
                : `${dateLabel(from)}${from === to ? '' : ` – ${dateLabel(to)}`}${awaitingEnd ? ' · Choose an end day' : ''}`;
        }
        function chooseDate(date) {
            if (!available.has(date) || date > today) return;
            if (awaitingEnd) {
                [from, to] = date < from ? [date, from] : [from, date];
                awaitingEnd = false;
            } else {
                from = to = date;
                awaitingEnd = true;
            }
            renderCalendar();
            document.getElementById('statsCalendar').querySelector?.(`[data-stats-date="${date}"]`)?.focus();
            load();
        }
        function showView(view) {
            for (const name of ['landing', 'general', 'takeoffs', 'hourly']) {
                document.getElementById(`${name}Stats`).hidden = name !== view;
                document.querySelector(`[data-stats-view="${name}"]`).setAttribute('aria-pressed', String(name === view));
            }
        }
        async function load() {
            if (!from || !to) return;
            clearTimeout(filterTimer);
            const current = ++requestId;
            try {
                const params = new URLSearchParams({ from, to });
                for (const [view, query] of Object.entries(filters)) {
                    if (query.trim()) params.set(`${view}Filter`, query);
                }
                const response = await fetch(`/api/stats?${params}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                const data = await response.json();
                if (current === requestId) {
                    render(data, document, filters);
                    hourly = data.hourly;
                    renderHourly(hourly, document);
                }
            } catch (error) {
                logger.error('Error fetching flight stats:', error);
                if (current === requestId) {
                    hourly = null;
                    document.getElementById('statsOverview').innerHTML = '<p class="error">Unable to load period totals.</p>';
                    document.getElementById('hourlyChart').innerHTML = '<p class="error">Unable to load hourly stats.</p>';
                    for (const prefix of ['landing', 'general', 'takeoffs']) {
                        document.getElementById(`${prefix}Charts`).innerHTML = '<p class="error">Unable to load flight stats.</p>';
                        const summary = document.getElementById(`${prefix}Summary`);
                        const total = summary.querySelector?.('[data-stats-total]');
                        if (total) total.textContent = '—';
                        else summary.innerHTML = '<p class="error">Unable to load flight stats.</p>';
                    }
                }
            }
        }
        async function start() {
            try {
                const response = await fetch('/api/stats?available=1', { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                const data = await response.json();
                today = data.today;
                available = new Set(data.dates);
                const latest = data.dates.at(-1);
                month = shiftMonth(monthKey(today), -1);
                from = to = latest;
                renderCalendar();
                if (latest) load();
                else showEmpty('No recorded flights yet.');
            } catch (error) {
                logger.error('Error fetching available stats dates:', error);
                document.getElementById('statsRangeLabel').textContent = 'Unable to load available dates.';
                showEmpty('Unable to load flight stats.');
            }
            document.getElementById('statsPreviousMonth').addEventListener('click', () => {
                month = shiftMonth(month, -1);
                renderCalendar();
            });
            document.getElementById('statsNextMonth').addEventListener('click', () => {
                month = shiftMonth(month, 1);
                renderCalendar();
            });
            document.getElementById('statsCalendar').addEventListener('click', event => {
                const button = event.target.closest?.('[data-stats-date]');
                if (button && !button.disabled) chooseDate(button.dataset.statsDate);
            });
            document.addEventListener('change', event => {
                if (!event.target.matches?.('[data-stats-expand]')) return;
                const chart = event.target.closest('[data-model-mode]') || event.target.closest('.stats-chart');
                for (const row of chart.querySelectorAll('.stats-bars li[data-extra]')) {
                    row.hidden = !event.target.checked;
                }
            });
            document.addEventListener('input', event => {
                const view = event.target.dataset?.statsFilter;
                if (!Object.hasOwn(filters, view)) return;
                filters[view] = event.target.value;
                ++requestId;
                clearTimeout(filterTimer);
                filterTimer = setTimeout(load, 150);
            });
            for (const id of ['showHourlyLandings', 'showHourlyTakeoffs']) {
                document.getElementById(id).addEventListener('change', () => {
                    if (hourly) renderHourly(hourly, document);
                });
            }
            document.addEventListener('click', event => {
                const button = event.target.closest?.('[data-model-choice]');
                if (!button) return;
                const card = button.closest('[data-model-chart]');
                for (const choice of card.querySelectorAll('[data-model-choice]')) {
                    choice.setAttribute('aria-pressed', String(choice === button));
                }
                for (const panel of card.querySelectorAll('[data-model-mode]')) {
                    panel.hidden = panel.dataset.modelMode !== button.dataset.modelChoice;
                }
            });
            for (const button of document.querySelectorAll('[data-stats-view]')) {
                button.addEventListener('click', () => showView(button.dataset.statsView));
            }
        }
        return { start, load, showView };
    }

    return { create };
})();

if (typeof module !== 'undefined') module.exports = GenevaStats;
if (typeof document !== 'undefined') {
    const stats = GenevaStats.create({ document, fetch: (...args) => window.fetch(...args) });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stats.start);
    else stats.start();
}
