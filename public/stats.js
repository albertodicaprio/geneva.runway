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

    function render(data, document) {
        const summary = document.getElementById('statsSummary');
        summary.innerHTML = `<div class="stats-totals">
            <div><strong>${data.total}</strong><span>Total flights</span></div>
            <div><strong>${data.categories.arrivals}</strong><span>Geneva arrivals</span></div>
            <div><strong>${data.categories.departures}</strong><span>Geneva departures</span></div>
            <div><strong>${data.categories.other}</strong><span>Other traffic</span></div>
        </div>`;
        document.getElementById('statsCharts').innerHTML = [
            chart('Airlines', data.airlines, data.total),
            chart('Origin airports', data.origins, data.total),
            chart('Destination airports', data.destinations, data.total),
            chart('Aircraft models', data.models, data.total)
        ].join('');
    }

    function create({ document, fetch, logger = console }) {
        let requestId = 0;
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
                if (current === requestId) document.getElementById('statsSummary').innerHTML =
                    '<p class="error">Unable to load flight stats.</p>';
            }
        }
        function start() {
            document.getElementById('statsDays').addEventListener('change', load);
            load();
        }
        return { start, load };
    }

    return { create };
})();

if (typeof module !== 'undefined') module.exports = GenevaStats;
if (typeof document !== 'undefined') {
    const stats = GenevaStats.create({ document, fetch: (...args) => window.fetch(...args) });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stats.start);
    else stats.start();
}
