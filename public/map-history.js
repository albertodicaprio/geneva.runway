/* The timeline controls only the map; arrival cards continue to show live data. */
const MapHistory = (() => {
    function create({ document, fetch, map, now = Date.now, defer = setTimeout, cancel = clearTimeout }) {
        const slider = document.getElementById('mapHistoryTime');
        if (!slider) return { init() {}, tick() {} };
        const status = document.getElementById('mapHistoryStatus');
        const liveButton = document.getElementById('mapHistoryLive');
        const earliest = document.getElementById('mapHistoryEarliest');
        const mode = document.getElementById('mapMode');
        const note = document.getElementById('mapPositionNote');
        const time = timestamp => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich',
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000));
        let selected = null, availableFrom = null, checkedAt = -Infinity, pending = null, request = 0;
        let availabilityRequest = false;
        function describe() {
            liveButton.disabled = selected === null;
            mode.textContent = selected === null ? 'LIVE POSITION' : 'HISTORY';
            note.textContent = selected === null ? 'Aircraft positions may be estimated for up to 60 seconds.'
                : 'Recorded positions · arrival cards above remain live.';
            slider.setAttribute('aria-valuetext', selected === null ? 'Live' : `${time(selected)}, Geneva time`);
        }
        async function availability() {
            if (availabilityRequest) return;
            availabilityRequest = true;
            checkedAt = now();
            try {
                const response = await fetch('/api/path-history', { cache: 'no-store' });
                if (!response.ok) throw new Error('History unavailable');
                const data = await response.json();
                availableFrom = data.availableFrom;
                slider.disabled = availableFrom === null;
                earliest.textContent = availableFrom === null ? 'No recordings yet' : time(availableFrom);
                if (selected === null) status.textContent = availableFrom === null
                    ? 'Waiting for recorded positions. History builds as aircraft are tracked.'
                    : 'Live map · move the slider to explore recorded paths.';
            } catch {
                if (selected === null) status.textContent = 'Path history is unavailable. Live tracking continues.';
            } finally { availabilityRequest = false; }
        }
        function tick() {
            const end = Math.floor(now() / 1000);
            slider.max = end;
            slider.min = Math.max(end - 86400, availableFrom ?? end - 86400);
            if (selected === null) slider.value = end;
            if (now() - checkedAt >= 60000) void availability();
        }
        async function show(at, token) {
            try {
                const response = await fetch(`/api/path-history?at=${at}`, { cache: 'no-store' });
                if (!response.ok) throw new Error('History unavailable');
                const data = await response.json();
                if (token !== request) return;
                map.setHistory(data);
                status.textContent = `${time(at - 7200)} – ${time(at)} (Geneva) · recorded trails. Gaps include the 01:00–05:00 tracking pause.`;
            } catch {
                if (token === request) status.textContent = 'Unable to load this time. Try moving the slider again or return to live.';
            }
        }
        function live() {
            request += 1;
            cancel(pending);
            selected = null;
            map.setHistory(null);
            status.textContent = 'Live map · move the slider to explore recorded paths.';
            describe();
            tick();
        }
        function init() {
            slider.disabled = true;
            slider.addEventListener('input', () => {
                if (Number(slider.value) >= Number(slider.max)) return live();
                selected = Number(slider.value);
                const token = ++request;
                cancel(pending);
                describe();
                status.textContent = `Loading recorded paths at ${time(selected)} (Geneva)…`;
                map.setHistory({ historical: true, aircraft: [], generalTraffic: [] });
                const at = selected;
                pending = defer(() => show(at, token), 180);
            });
            liveButton.addEventListener('click', live);
            describe();
            tick();
        }
        return { init, tick };
    }
    return { create };
})();
if (typeof module !== 'undefined') module.exports = MapHistory;
