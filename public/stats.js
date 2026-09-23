const GenevaStats = (() => {
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function chart(title, data, total) {
        const rows = data.items.map(item => `<li>
            <div class="stats-bar-label"><span>${escapeHtml(item.name)}</span><strong>${item.count}</strong></div>
            <progress value="${item.count}" max="${Math.max(total, 1)}" aria-label="${escapeHtml(item.name)}: ${item.count} of ${total} flights"></progress>
        </li>`).join('');
        return `<section class="stats-chart"><h2>${title}</h2>
            <p class="history-note">Known for ${data.known} of ${total} flights</p>
            ${rows ? `<ol class="stats-bars">${rows}</ol>` : '<p class="no-aircraft">No known values yet.</p>'}
        </section>`;
    }

    function renderGroup(group, prefix, document) {
        document.getElementById(`${prefix}Summary`).innerHTML = `<div class="stats-totals">
            <div><strong>${group.total}</strong><span>Flights seen</span></div>
        </div>`;
        document.getElementById(`${prefix}Charts`).innerHTML = [
            chart('Airlines', group.airlines, group.total),
            chart('Origin airports', group.origins, group.total),
            chart('Destination airports', group.destinations, group.total),
            chart('Aircraft models', group.models, group.total)
        ].join('');
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
                const response = await fetch(`/api/stats?days=${days}`, { cache: 'no-store' });
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
