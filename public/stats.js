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

    function modelChart(group) {
        return `<section class="stats-chart" data-model-chart>
            <div class="model-chart-header"><h2>Aircraft models</h2>
                <div class="model-toggle" role="group" aria-label="Aircraft model view">
                    <button type="button" data-model-choice="icao" aria-pressed="true">Group</button>
                    <button type="button" data-model-choice="type" aria-pressed="false">Detail</button>
                </div>
            </div>
            <div data-model-mode="icao">${chartContent('Aircraft models', group.icaoTypes, group.total)}</div>
            <div data-model-mode="type" hidden>${chartContent('Aircraft models', group.models, group.total)}</div>
        </section>`;
    }

    function renderGroup(group, prefix, document) {
        document.getElementById(`${prefix}Summary`).innerHTML = `<div class="stats-totals">
            <div><strong>${group.total}</strong><span>Flights seen</span></div>
        </div>`;
        const charts = [
            ['Airlines', group.airlines],
            ...(prefix === 'landing'
                ? [['Origin airports', group.origins], ['Registrations', group.registrations]]
                : prefix === 'takeoffs'
                    ? [['Registrations', group.registrations], ['Destination airports', group.destinations]]
                    : [['Origin airports', group.origins], ['Destination airports', group.destinations]])
        ];
        document.getElementById(`${prefix}Charts`).innerHTML = charts.map(([title, data]) => chart(title, data, group.total)).join('') + modelChart(group);
    }

    function render(data, document) {
        for (const view of ['landing', 'general', 'takeoffs']) renderGroup(data[view], view, document);
    }

    function create({ document, fetch, logger = console }) {
        let requestId = 0;
        function showView(view) {
            for (const name of ['landing', 'general', 'takeoffs']) {
                document.getElementById(`${name}Stats`).hidden = name !== view;
                document.querySelector(`[data-stats-view="${name}"]`).setAttribute('aria-pressed', String(name === view));
            }
        }
        async function load() {
            const current = ++requestId;
            const days = document.getElementById('statsDays').value;
            try {
                const query = days === 'yesterday' ? 'days=1&offset=1' : `days=${days}`;
                const response = await fetch(`/api/stats?${query}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                const data = await response.json();
                if (current === requestId) render(data, document);
            } catch (error) {
                logger.error('Error fetching flight stats:', error);
                if (current === requestId) {
                    for (const prefix of ['landing', 'general', 'takeoffs']) {
                        document.getElementById(`${prefix}Summary`).innerHTML = '<p class="error">Unable to load flight stats.</p>';
                    }
                }
            }
        }
        function start() {
            document.getElementById('statsDays').addEventListener('change', load);
            document.addEventListener('change', event => {
                if (!event.target.matches?.('[data-stats-expand]')) return;
                const chart = event.target.closest('[data-model-mode]') || event.target.closest('.stats-chart');
                for (const row of chart.querySelectorAll('.stats-bars li[data-extra]')) {
                    row.hidden = !event.target.checked;
                }
            });
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
            load();
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
