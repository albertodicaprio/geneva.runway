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
let selectedAircraftId = null;
const mapLayers = { arrivals: true, general: false };

function initMapLayers() {
    try {
        const saved = JSON.parse(localStorage.getItem('geneva-map-layers'));
        for (const key of Object.keys(mapLayers)) {
            if (typeof saved?.[key] === 'boolean') mapLayers[key] = saved[key];
        }
    } catch { /* Storage may be unavailable. Use the default layers. */ }
    for (const [key, id] of [['arrivals', 'showArrivals'], ['general', 'showGeneralTraffic']]) {
        const input = document.getElementById(id);
        input.checked = mapLayers[key];
        input.addEventListener('change', () => {
            mapLayers[key] = input.checked;
            try { localStorage.setItem('geneva-map-layers', JSON.stringify(mapLayers)); } catch { /* Keep the choice for this page. */ }
            updateMap();
        });
    }
}

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

function mapCoordinates(latitude, longitude) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude <= -85 || latitude >= 85) return null;
    const x = MAP_X_SCALE * longitude + MAP_X_OFFSET;
    const y = MAP_Y_SCALE * webMercatorLatitude(latitude) + MAP_Y_OFFSET;
    return { x, y };
}

function mapPosition(latitude, longitude) {
    const position = mapCoordinates(latitude, longitude);
    if (!position) return null;
    const { x, y } = position;
    if (x < 0 || x > MAP_WIDTH || y < 0 || y > MAP_HEIGHT) return null;
    return position;
}

function smoothMapPath(points) {
    if (points.length < 2) return '';
    const coordinate = value => value.toFixed(1);
    let path = `M ${coordinate(points[0].x)} ${coordinate(points[0].y)}`;

    for (let index = 0; index < points.length - 1; index += 1) {
        const previous = points[index - 1] || points[index];
        const current = points[index];
        const next = points[index + 1];
        const following = points[index + 2] || next;
        const firstControl = {
            x: current.x + (next.x - previous.x) / 6,
            y: current.y + (next.y - previous.y) / 6
        };
        const secondControl = {
            x: next.x - (following.x - current.x) / 6,
            y: next.y - (following.y - current.y) / 6
        };
        path += ` C ${coordinate(firstControl.x)} ${coordinate(firstControl.y)} ${coordinate(secondControl.x)} ${coordinate(secondControl.y)} ${coordinate(next.x)} ${coordinate(next.y)}`;
    }

    return path;
}

function mapPath(aircraft, includeEstimatedPosition = true, general = false) {
    const points = (aircraft.track?.points || [])
        .map(point => mapCoordinates(point.latitude, point.longitude))
        .filter(Boolean);
    if (includeEstimatedPosition) {
        const estimatedPosition = mapCoordinates(aircraft.latitude, aircraft.longitude);
        if (estimatedPosition) points.push(estimatedPosition);
    }
    if (points.length < 2 || !aircraft.track?.color) return '';
    const path = smoothMapPath(points);
    return `<path class="map-flight-path${general ? ' map-general-path' : ''}" d="${path}" stroke="${escapeHtml(aircraft.track.color)}"></path>`;
}

function mapMarker(aircraft, general = false) {
    const position = mapPosition(aircraft.latitude, aircraft.longitude);
    if (!position) return '';
    const callsign = aircraft.callsign || aircraft.icao24 || 'Unknown aircraft';
    const altitude = formatAltitude(aircraft.altitude);
    const heading = Number.isFinite(aircraft.heading) ? aircraft.heading : 0;
    const headingClass = Number.isFinite(aircraft.heading) ? '' : ' heading-unknown';
    const airportLabel = airport => airport?.iata_code || airport?.icao_code || airport?.name || 'Unknown';
    const routeLabel = `${airportLabel(aircraft.route?.origin)} → ${airportLabel(aircraft.route?.destination)}`;
    const label = `${callsign}, ${altitude}\n${routeLabel}`;
    const icon = Number.isFinite(aircraft.heading)
        ? `<g transform="scale(1.5)"><path class="map-aircraft-icon" d="M 0 -15 L 3 -5 L 12 0 L 12 4 L 3 2 L 2 11 L 6 15 L 6 18 L 0 14 L -6 18 L -6 15 L -2 11 L -3 2 L -12 4 L -12 0 L -3 -5 Z" transform="rotate(${heading})"></path></g>`
        : '<circle class="map-aircraft-icon" r="12"></circle>';
    return `<g class="map-aircraft${headingClass}${general ? ' map-general-aircraft' : ''}" transform="translate(${position.x} ${position.y})" role="button" tabindex="0" data-aircraft-id="${escapeHtml(aircraft.icao24)}" aria-controls="mapAircraftDetails" aria-expanded="${selectedAircraftId === aircraft.icao24}" aria-label="${escapeHtml(label)}. Show aircraft details">
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

function visibleMapAircraft() {
    return [
        ...(mapLayers.arrivals ? aircraftData : []),
        ...(mapLayers.general ? latestData?.generalTraffic || [] : [])
    ].filter(aircraft => mapPosition(aircraft.latitude, aircraft.longitude));
}

function updateMapDetails() {
    const panel = document.getElementById('mapAircraftDetails');
    const aircraft = visibleMapAircraft().find(aircraft => aircraft.icao24 === selectedAircraftId);
    panel.hidden = !aircraft;
    if (!aircraft) {
        selectedAircraftId = null;
        return;
    }
    const fullAirport = airport => {
        const code = airport?.iata_code || airport?.icao_code;
        return airport?.name ? `${airport.name}${code ? ` (${code})` : ''}` : code || 'Unknown airport';
    };
    const photo = document.getElementById('mapDetailsPhoto');
    const photoUrl = safeImageUrl(aircraft.aircraftDetails?.url_photo_thumbnail) || '';
    if (photo.dataset.photoUrl !== photoUrl) {
        photo.dataset.photoUrl = photoUrl;
        photo.innerHTML = photoUrl
            ? `<img src="${photoUrl}" alt="Selected aircraft" loading="lazy">`
            : '<p>Photo unavailable</p>';
    }
    document.getElementById('mapDetailsHeading').textContent = aircraft.callsign || aircraft.icao24;
    document.getElementById('mapDetailsModel').textContent = aircraft.aircraftDetails?.type || aircraft.aircraftDetails?.icao_type || 'Unknown model';
    document.getElementById('mapDetailsOrigin').textContent = fullAirport(aircraft.route?.origin);
    document.getElementById('mapDetailsDestination').textContent = fullAirport(aircraft.route?.destination);
}

function initMapDetails() {
    document.getElementById('mapDetailsPhoto').addEventListener('error', event => {
        if (event.target.tagName === 'IMG') {
            document.getElementById('mapDetailsPhoto').innerHTML = '<p>Photo unavailable</p>';
        }
    }, true);
    const markers = document.getElementById('mapMarkers');
    const select = event => {
        const marker = event.target.closest('[data-aircraft-id]');
        if (!marker) return;
        selectedAircraftId = selectedAircraftId === marker.dataset.aircraftId ? null : marker.dataset.aircraftId;
        updateMapDetails();
        for (const item of markers.querySelectorAll('[data-aircraft-id]')) {
            item.setAttribute('aria-expanded', String(item.dataset.aircraftId === selectedAircraftId));
        }
    };
    markers.addEventListener('click', select);
    markers.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(event);
        }
    });
    const close = () => {
        const id = selectedAircraftId;
        selectedAircraftId = null;
        updateMap();
        [...markers.querySelectorAll('[data-aircraft-id]')].find(marker => marker.dataset.aircraftId === id)?.focus();
    };
    document.getElementById('closeMapDetails').addEventListener('click', close);
    document.getElementById('mapSection').addEventListener('keydown', event => {
        if (event.key === 'Escape' && selectedAircraftId) close();
    });
}

function updateMap() {
    const focusedId = document.activeElement?.dataset?.aircraftId;
    updateMapDetails();
    const paths = document.getElementById('mapPaths');
    const markers = document.getElementById('mapMarkers');
    const recentTracks = mapLayers.arrivals ? unexpiredTracks() : [];
    const arrivals = mapLayers.arrivals ? aircraftData : [];
    const general = mapLayers.general && Array.isArray(latestData?.generalTraffic) ? latestData.generalTraffic : [];
    paths.innerHTML = [
        ...general.map(aircraft => mapPath(aircraft, true, true)),
        ...recentTracks.map(track => mapPath(track, false)),
        ...arrivals.map(aircraft => mapPath(aircraft, true))
    ].filter(Boolean).join('');
    const markerMarkup = [
        ...general.map(aircraft => mapMarker(aircraft, true)),
        ...arrivals.map(aircraft => mapMarker(aircraft))
    ].filter(Boolean).join('');
    const emptyMessage = !mapLayers.arrivals && !mapLayers.general
        ? 'Select a traffic layer to show aircraft.'
        : 'No aircraft in the selected layers are within this map area.';
    markers.innerHTML = markerMarkup || `<text class="map-empty" x="874" y="874" text-anchor="middle">${emptyMessage}</text>`;
    if (focusedId) [...markers.querySelectorAll('[data-aircraft-id]')].find(marker => marker.dataset.aircraftId === focusedId)?.focus();
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
    if (!latestData) document.getElementById('flightHistory').innerHTML = '<p class="no-aircraft">Flight history is currently unavailable.</p>';
}

function init() {
    initMapLayers();
    initMapDetails();
    fetchAircraftData();
    setInterval(fetchAircraftData, FETCH_INTERVAL);
    setInterval(() => {
        if (latestData) {
            updateFlightHistory();
            updateMap();
        }
    }, FETCH_INTERVAL);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
