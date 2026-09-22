const API_ENDPOINT = '/api/aircraft';
const FETCH_INTERVAL = 2000;
const card = AircraftCard;
const aircraftMap = AircraftMap.create({ document, storage: typeof localStorage === 'undefined' ? null : localStorage });
let aircraftData = [];
let isFetching = false;
let rateLimitResetTime = 0;
let latestData = null;
const escapeHtml = card.escapeHtml;

async function fetchAircraftData() {
    if (isFetching || rateLimitResetTime > Date.now()) return;
    isFetching = true;

    try {
        const response = await fetch(API_ENDPOINT, { cache: 'no-store' });
        if (response.status === 503 || response.status === 429) {
            const errorData = await response.json().catch(() => ({}));
            const retryAfter = errorData.retryAfter || 120;
            rateLimitResetTime = Date.now() + retryAfter * 1000;
            displayError(`Data source rate limited. Retrying in ${retryAfter} seconds.`);
            return;
        }
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);

        latestData = await response.json();
        aircraftData = Array.isArray(latestData.aircraft) ? latestData.aircraft : [];
        updateUI();
    } catch (error) {
        console.error('Error fetching aircraft data:', error);
        displayError('Unable to load arrival data.');
    } finally {
        isFetching = false;
    }
}

function updateUI() {
    updateStatus();
    updateNextArrival();
    aircraftMap.update(latestData);
    updateAircraftList();
    updateFlightHistory();
}

function unexpiredTracks() {
    const tracks = Array.isArray(latestData?.recentTracks) ? latestData.recentTracks : [];
    return tracks.filter(aircraft => Number.isFinite(aircraft.expiresAt) && aircraft.expiresAt > Date.now() / 1000);
}

function historyTime(aircraft) {
    // Older cached records predate disappearedAt and use the same two-hour retention.
    return Number.isFinite(aircraft.disappearedAt) ? aircraft.disappearedAt : aircraft.expiresAt - 2 * 60 * 60;
}

function updateFlightHistory() {
    const history = unexpiredTracks().sort((first, second) => historyTime(second) - historyTime(first));
    document.getElementById('historyCount').textContent = `${history.length} flight${history.length === 1 ? '' : 's'}`;
    const container = document.getElementById('flightHistory');
    if (!history.length) {
        container.innerHTML = '<p class="no-aircraft">No recent landings in the retained history.</p>';
        return;
    }
    const rows = history.map(aircraft => {
        const details = aircraft.aircraftDetails || {};
        const time = new Date(historyTime(aircraft) * 1000);
        const runway = ['04', '22'].includes(aircraft.approachDirection) ? `Likely ${aircraft.approachDirection}` : 'Unknown';
        const heading = Number.isFinite(aircraft.heading) ? ` · ${Math.round(aircraft.heading)}°` : '';
        return `<tr>
            <th scope="row">${escapeHtml(aircraft.callsign || aircraft.icao24 || 'Unknown')}</th>
            <td>${escapeHtml(aircraft.route?.airline?.name || '—')}</td>
            <td>${escapeHtml(details.type || details.icao_type || '—')}</td>
            <td>${escapeHtml(details.registration || '—')}</td>
            <td><time datetime="${time.toISOString()}">${escapeHtml(time.toLocaleTimeString('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }))}</time></td>
            <td>${escapeHtml(runway + heading)}</td>
        </tr>`;
    }).join('');
    container.innerHTML = `<div class="history-table-wrap" role="region" aria-label="Recent landings" tabindex="0">
        <table class="history-table">
            <thead><tr><th scope="col">Flight</th><th scope="col">Airline</th><th scope="col">Plane type</th><th scope="col">Registration</th><th scope="col">Landing (est.)</th><th scope="col">Last runway / heading</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function updateStatus() {
    const updatedAt = latestData?.updatedAt ? new Date(latestData.updatedAt * 1000) : null;
    document.getElementById('lastUpdated').textContent = updatedAt ? updatedAt.toLocaleTimeString() : '—';
    const now = Math.floor(Date.now() / 1000);
    const secondsSinceUpdate = Number.isFinite(latestData?.cacheUpdatedAt)
        ? Math.max(0, now - latestData.cacheUpdatedAt)
        : null;
    const updateAge = secondsSinceUpdate === null ? 'Update time unavailable' : `${secondsSinceUpdate}s since last update`;

    if (latestData?.positionEstimate?.isEstimated) {
        document.getElementById('dataStatus').textContent = `Estimated positions · ${updateAge}`;
        return;
    }

    document.getElementById('dataStatus').textContent = updateAge;
}

function updateNextArrival() {
    const container = document.getElementById('nextPlane');
    const aircraft = aircraftData[0];
    container.innerHTML = aircraft ? card.featured(aircraft)
        : '<p class="no-aircraft">No confirmed Geneva arrivals are currently tracked.</p>';
}

function updateAircraftList() {
    const list = document.getElementById('aircraftList');
    document.getElementById('arrivalCount').textContent = `${aircraftData.length} arrival${aircraftData.length === 1 ? '' : 's'}`;
    if (!aircraftData.length) {
        list.innerHTML = '<div class="no-aircraft">No confirmed Geneva arrivals are currently tracked.</div>';
        return;
    }

    list.innerHTML = aircraftData.map(card.list).join('');
}

function displayError(message) {
    document.getElementById('aircraftList').innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
    if (!latestData) document.getElementById('flightHistory').innerHTML = '<p class="no-aircraft">Flight history is currently unavailable.</p>';
}

function init() {
    document.addEventListener('error', card.handlePhotoError, true);
    aircraftMap.init();
    fetchAircraftData();
    setInterval(fetchAircraftData, FETCH_INTERVAL);
    setInterval(() => {
        if (latestData) {
            updateFlightHistory();
            aircraftMap.update(latestData);
        }
    }, FETCH_INTERVAL);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
