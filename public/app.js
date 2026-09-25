/* Fetch and display coordination for the browser modules. */
const GenevaApp = (() => {
    const API_ENDPOINT = '/api/aircraft';
    const FETCH_INTERVAL = 30_000;
    const DISPLAY_INTERVAL = 1_000;
    const cardModule = typeof AircraftCard !== 'undefined' ? AircraftCard : require('./aircraft-card');
    const mapModule = typeof AircraftMap !== 'undefined' ? AircraftMap : require('./aircraft-map');
    const { escapeHtml } = cardModule;

    function projectPosition(latitude, longitude, heading, velocity, elapsedSeconds) {
        if (![latitude, longitude, heading, velocity].every(Number.isFinite) || velocity < 0 || elapsedSeconds <= 0)
            return { latitude, longitude };
        const radius = 6_371_000;
        const distance = velocity * elapsedSeconds / radius;
        const bearing = heading * Math.PI / 180;
        const startLatitude = latitude * Math.PI / 180;
        const startLongitude = longitude * Math.PI / 180;
        const projectedLatitude = Math.asin(
            Math.sin(startLatitude) * Math.cos(distance) +
            Math.cos(startLatitude) * Math.sin(distance) * Math.cos(bearing)
        );
        const projectedLongitude = startLongitude + Math.atan2(
            Math.sin(bearing) * Math.sin(distance) * Math.cos(startLatitude),
            Math.cos(distance) - Math.sin(startLatitude) * Math.sin(projectedLatitude)
        );
        return {
            latitude: projectedLatitude * 180 / Math.PI,
            longitude: ((projectedLongitude * 180 / Math.PI + 540) % 360) - 180
        };
    }

    function projectSnapshot(snapshot, now) {
        const estimatedAt = snapshot?.positionEstimate?.estimatedAt;
        if (!Number.isFinite(estimatedAt)) return snapshot;
        const elapsed = Math.max(0, Math.floor(now / 1000) - estimatedAt);
        if (!elapsed) return snapshot;
        const projectList = list => (list || []).map(aircraft => {
            const priorSeconds = Number.isFinite(aircraft.projectionSeconds) ? aircraft.projectionSeconds : 0;
            const seconds = Math.min(elapsed, Math.max(0, 60 - priorSeconds));
            if (!seconds) return aircraft;
            const position = projectPosition(aircraft.latitude, aircraft.longitude, aircraft.heading, aircraft.velocity, seconds);
            const altitude = Number.isFinite(aircraft.altitude) && Number.isFinite(aircraft.verticalRate)
                ? Math.max(0, aircraft.altitude + aircraft.verticalRate * seconds) : aircraft.altitude;
            const latitudeDelta = (position.latitude - 46.2381) * Math.PI / 180;
            const longitudeDelta = (position.longitude - 6.1093) * Math.PI / 180;
            const a = Math.sin(latitudeDelta / 2) ** 2 +
                Math.cos(46.2381 * Math.PI / 180) * Math.cos(position.latitude * Math.PI / 180) *
                Math.sin(longitudeDelta / 2) ** 2;
            return {
                ...aircraft, ...position, altitude,
                distanceKm: Number.isFinite(position.latitude) && Number.isFinite(position.longitude)
                    ? 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) : aircraft.distanceKm,
                positionEstimated: true,
                projectionSeconds: priorSeconds + seconds
            };
        });
        const aircraft = projectList(snapshot.aircraft);
        const generalTraffic = projectList(snapshot.generalTraffic);
        return {
            ...snapshot, aircraft, generalTraffic,
            positionEstimate: {
                ...snapshot.positionEstimate,
                isEstimated: [...aircraft, ...generalTraffic].some(item => item.positionEstimated),
                estimatedAt: Math.floor(now / 1000)
            }
        };
    }

    function historyTime(aircraft) {
        // Older cached records predate disappearedAt and use the same two-hour retention.
        return Number.isFinite(aircraft.disappearedAt) ? aircraft.disappearedAt : aircraft.expiresAt - 2 * 60 * 60;
    }

    function create({ document, fetch, storage, now = Date.now, schedule = setInterval,
        logger = console, card = cardModule, map = mapModule.create({ document, storage, now }) }) {
        const hasOverview = Boolean(document.getElementById('nextPlane'));
        const hasArrivals = Boolean(document.getElementById('aircraftList'));
        const hasHistory = Boolean(document.getElementById('flightHistory'));
        let snapshot = null;
        let displayedSnapshot = null;
        let isFetching = false;
        let rateLimitResetTime = 0;
        let lastRequestAt = -Infinity;
        let started = false;

        function arrivals() {
            return Array.isArray(displayedSnapshot?.aircraft) ? displayedSnapshot.aircraft : [];
        }

        function unexpiredTracks() {
            const tracks = Array.isArray(snapshot?.recentTracks) ? snapshot.recentTracks : [];
            return tracks.filter(aircraft => Number.isFinite(aircraft.expiresAt) && aircraft.expiresAt > now() / 1000);
        }

        function updateFlightHistory() {
            if (!hasHistory) return;
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
            const updatedAt = snapshot?.updatedAt ? new Date(snapshot.updatedAt * 1000) : null;
            if (hasOverview) document.getElementById('lastUpdated').textContent = updatedAt ? updatedAt.toLocaleTimeString() : '—';
            const secondsSinceUpdate = Number.isFinite(snapshot?.cacheUpdatedAt)
                ? Math.max(0, Math.floor(now() / 1000) - snapshot.cacheUpdatedAt) : null;
            const updateAge = secondsSinceUpdate === null ? 'Update time unavailable' : `${secondsSinceUpdate}s since last update`;
            document.getElementById('dataStatus').textContent = displayedSnapshot?.positionEstimate?.isEstimated
                ? `Estimated positions · ${updateAge}` : updateAge;
        }

        function updateArrivals() {
            const aircraft = arrivals();
            if (hasOverview) document.getElementById('nextPlane').innerHTML = aircraft.length ? card.featured(aircraft[0])
                : '<p class="no-aircraft">No confirmed Geneva arrivals are currently tracked.</p>';
            if (hasArrivals) {
                document.getElementById('arrivalCount').textContent = `${aircraft.length} arrival${aircraft.length === 1 ? '' : 's'}`;
                document.getElementById('aircraftList').innerHTML = aircraft.length ? aircraft.map(card.list).join('')
                    : '<div class="no-aircraft">No confirmed Geneva arrivals are currently tracked.</div>';
            }
        }

        function updateTimeSensitive() {
            if (!snapshot) return;
            displayedSnapshot = projectSnapshot(snapshot, now());
            updateStatus();
            updateFlightHistory();
            if (hasOverview) map.update(displayedSnapshot);
        }

        function displayError(message) {
            const error = `<div class="error">${escapeHtml(message)}</div>`;
            if (hasArrivals) document.getElementById('aircraftList').innerHTML = error;
            if (!snapshot && hasOverview) document.getElementById('nextPlane').innerHTML = error;
            if (!snapshot && hasHistory) document.getElementById('flightHistory').innerHTML = error;
        }

        async function poll() {
            if (isFetching || rateLimitResetTime > now()) return;
            isFetching = true;
            lastRequestAt = now();
            try {
                const response = await fetch(API_ENDPOINT, { cache: 'no-store' });
                if (response.status === 503 || response.status === 429) {
                    const errorData = await response.json().catch(() => ({}));
                    const retryAfterHeader = Number(response.headers?.get('Retry-After'));
                    const retryAfter = errorData.retryAfter || (retryAfterHeader > 0 ? retryAfterHeader : 120);
                    rateLimitResetTime = now() + retryAfter * 1000;
                    displayError(`Data source rate limited. Retrying in ${retryAfter} seconds.`);
                    return;
                }
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                snapshot = await response.json();
                updateTimeSensitive();
                updateArrivals();
            } catch (error) {
                logger.error('Error fetching aircraft data:', error);
                displayError('Unable to load arrival data.');
            } finally {
                isFetching = false;
            }
        }

        function tick() {
            updateTimeSensitive();
            if (now() - lastRequestAt >= FETCH_INTERVAL) return poll();
        }

        function start() {
            if (started) return;
            started = true;
            document.addEventListener('error', card.handlePhotoError, true);
            if (hasOverview) map.init();
            poll();
            schedule(tick, DISPLAY_INTERVAL);
        }

        return { start, poll, tick, updateTimeSensitive, get snapshot() { return snapshot; } };
    }

    return { create, projectSnapshot, FETCH_INTERVAL, DISPLAY_INTERVAL };
})();

if (typeof module !== 'undefined') module.exports = GenevaApp;
if (typeof document !== 'undefined') {
    const app = GenevaApp.create({ document, fetch: (...args) => window.fetch(...args),
        storage: typeof localStorage === 'undefined' ? null : localStorage });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', app.start);
    else app.start();
}
