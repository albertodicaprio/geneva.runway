const API_ENDPOINT = '/api/aircraft';
const FETCH_INTERVAL = 10000;

let aircraftData = [];
let isFetching = false;
let rateLimitResetTime = 0;
let latestData = null;
let latestCacheStatus = null;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function safeImageUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? escapeHtml(url.href) : null;
    } catch {
        return null;
    }
}

function formatAirport(airport) {
    if (!airport) return 'Origin unavailable';
    const code = airport.iata_code || airport.icao_code || '—';
    return [code, airport.municipality || airport.name].filter(Boolean).join(' · ');
}

function formatAltitude(altitude) {
    return Number.isFinite(altitude) ? `${Math.round(altitude).toLocaleString()} m` : '—';
}

function formatSpeed(velocity) {
    return Number.isFinite(velocity) ? `${Math.round(velocity * 3.6)} km/h` : '—';
}

function formatDescent(verticalRate) {
    if (!Number.isFinite(verticalRate)) return '—';
    return `${Math.round(verticalRate * 60).toLocaleString()} m/min`;
}

function formatEta(aircraft) {
    if (!Number.isFinite(aircraft.distanceKm) || !Number.isFinite(aircraft.velocity) || aircraft.velocity <= 0) return '—';
    const minutes = Math.max(1, Math.round((aircraft.distanceKm * 1000) / aircraft.velocity / 60));
    return `~${minutes} min`;
}

function approachLabel(aircraft) {
    return aircraft.approachDirection === 'unknown'
        ? 'Approach unknown'
        : `Likely runway ${aircraft.approachDirection}`;
}

function aircraftIdentity(aircraft) {
    const details = aircraft.aircraftDetails || {};
    return [details.type, details.icao_type, details.registration].filter(Boolean).join(' · ') || 'Aircraft details unavailable';
}

function aircraftPhoto(aircraft, className = 'aircraft-photo') {
    const url = safeImageUrl(aircraft.aircraftDetails?.url_photo_thumbnail);
    return url ? `<img class="${className}" src="${url}" alt="" loading="lazy" onerror="this.remove()">` : '';
}

function aircraftPhotoFrame(aircraft, frameClass, imageClass) {
    const photo = aircraftPhoto(aircraft, imageClass);
    return photo ? `<div class="${frameClass}">${photo}</div>` : '';
}

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
        latestCacheStatus = response.headers.get('X-Cache');
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
    updateAircraftList();
}

function updateStatus() {
    const updatedAt = latestData?.updatedAt ? new Date(latestData.updatedAt * 1000) : null;
    document.getElementById('lastUpdated').textContent = updatedAt ? updatedAt.toLocaleTimeString() : '—';

    const labels = {
        HIT: 'Live cache',
        MISS: 'Freshly updated',
        'STALE-REFRESHING': 'Refreshing in background'
    };
    const status = labels[latestCacheStatus] || 'Live data';
    document.getElementById('dataStatus').textContent = status;
}

function updateNextArrival() {
    const container = document.getElementById('nextPlane');
    const aircraft = aircraftData[0];
    if (!aircraft) {
        container.innerHTML = '<p class="no-aircraft">No confirmed Geneva arrivals are currently tracked.</p>';
        return;
    }

    const airline = aircraft.route?.airline?.name || 'Airline unavailable';
    const origin = formatAirport(aircraft.route?.origin);
    container.innerHTML = `
        ${aircraftPhotoFrame(aircraft, 'next-photo-wrap', 'next-photo')}
        <div class="next-copy">
            <div class="arrival-title-row">
                <div>
                    <p class="callsign">${escapeHtml(aircraft.callsign)}</p>
                    <p class="airline">${escapeHtml(airline)}</p>
                </div>
                <span class="approach-badge ${escapeHtml(aircraft.approachConfidence)}">${escapeHtml(approachLabel(aircraft))}</span>
            </div>
            <p class="route">${escapeHtml(origin)} <span>→</span> GVA</p>
            <p class="aircraft-model">${escapeHtml(aircraftIdentity(aircraft))}</p>
            <div class="metrics hero-metrics">
                <div><span>Altitude</span><strong>${formatAltitude(aircraft.altitude)}</strong></div>
                <div><span>Distance</span><strong>${aircraft.distanceKm.toFixed(1)} km</strong></div>
                <div><span>Descent</span><strong>${formatDescent(aircraft.verticalRate)}</strong></div>
                <div><span>Rough ETA</span><strong>${formatEta(aircraft)}</strong></div>
            </div>
        </div>`;
}

function updateAircraftList() {
    const list = document.getElementById('aircraftList');
    document.getElementById('arrivalCount').textContent = `${aircraftData.length} arrival${aircraftData.length === 1 ? '' : 's'}`;
    if (!aircraftData.length) {
        list.innerHTML = '<div class="no-aircraft">No confirmed Geneva arrivals are currently tracked.</div>';
        return;
    }

    list.innerHTML = aircraftData.map(aircraft => {
        const airline = aircraft.route?.airline?.name || 'Airline unavailable';
        const origin = formatAirport(aircraft.route?.origin);
        return `
            <article class="arrival-card">
                ${aircraftPhotoFrame(aircraft, 'card-photo-wrap', 'aircraft-photo')}
                <div class="arrival-card-main">
                    <div class="arrival-title-row">
                        <div>
                            <h3>${escapeHtml(aircraft.callsign)}</h3>
                            <p class="airline">${escapeHtml(airline)}</p>
                        </div>
                        <span class="approach-badge ${escapeHtml(aircraft.approachConfidence)}">${escapeHtml(approachLabel(aircraft))}</span>
                    </div>
                    <p class="route">${escapeHtml(origin)} <span>→</span> GVA</p>
                    <p class="aircraft-model">${escapeHtml(aircraftIdentity(aircraft))}</p>
                    <div class="metrics">
                        <div><span>Altitude</span><strong>${formatAltitude(aircraft.altitude)}</strong></div>
                        <div><span>Distance</span><strong>${aircraft.distanceKm.toFixed(1)} km</strong></div>
                        <div><span>Speed</span><strong>${formatSpeed(aircraft.velocity)}</strong></div>
                        <div><span>Descent</span><strong>${formatDescent(aircraft.verticalRate)}</strong></div>
                    </div>
                </div>
            </article>`;
    }).join('');
}

function displayError(message) {
    document.getElementById('aircraftList').innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
}

function init() {
    fetchAircraftData();
    setInterval(fetchAircraftData, FETCH_INTERVAL);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
