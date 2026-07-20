const API_ENDPOINT = '/api/aircraft';
const FETCH_INTERVAL = 2000;
const MAP_WIDTH = 1748;
const MAP_HEIGHT = 1747;
const MAP_X_SCALE = 1023.9218009042783;
const MAP_X_OFFSET = -5412.222393087557;
const MAP_Y_SCALE = -58671.31391937124;
const MAP_Y_OFFSET = 54495.2374689763;

let aircraftData = [];
let isFetching = false;
let rateLimitResetTime = 0;
let latestData = null;

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

function webMercatorLatitude(latitude) {
    return Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
}

function mapPosition(latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude <= -85 || latitude >= 85) return null;
    const x = MAP_X_SCALE * longitude + MAP_X_OFFSET;
    const y = MAP_Y_SCALE * webMercatorLatitude(latitude) + MAP_Y_OFFSET;
    if (x < 0 || x > MAP_WIDTH || y < 0 || y > MAP_HEIGHT) return null;
    return { x, y };
}

function mapMarker(aircraft) {
    const position = mapPosition(aircraft.latitude, aircraft.longitude);
    if (!position) return '';
    const callsign = aircraft.callsign || 'Unknown aircraft';
    const altitude = formatAltitude(aircraft.altitude);
    const heading = Number.isFinite(aircraft.heading) ? aircraft.heading : 0;
    const headingClass = Number.isFinite(aircraft.heading) ? '' : ' heading-unknown';
    const label = `${callsign}, ${altitude}`;
    const icon = Number.isFinite(aircraft.heading)
        ? `<path class="map-aircraft-icon" d="M 0 -15 L 3 -5 L 12 0 L 12 4 L 3 2 L 2 11 L 6 15 L 6 18 L 0 14 L -6 18 L -6 15 L -2 11 L -3 2 L -12 4 L -12 0 L -3 -5 Z" transform="rotate(${heading})"></path>`
        : '<circle class="map-aircraft-icon" r="8"></circle>';
    return `<g class="map-aircraft${headingClass}" transform="translate(${position.x} ${position.y})" role="img" aria-label="${escapeHtml(label)}">
        <title>${escapeHtml(label)}</title>${icon}<text class="map-aircraft-label" x="17" y="4">${escapeHtml(callsign)}</text>
    </g>`;
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
    updateMap();
    updateAircraftList();
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

function updateMap() {
    const markers = document.getElementById('mapMarkers');
    const markerMarkup = aircraftData.map(mapMarker).filter(Boolean).join('');
    markers.innerHTML = markerMarkup || '<text class="map-empty" x="874" y="874" text-anchor="middle">No tracked aircraft are within this map area.</text>';
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
