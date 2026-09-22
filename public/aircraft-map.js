/* Geneva map rendering, layer preferences, and selection. */
const AircraftMap = (() => {
    const cardModule = typeof AircraftCard !== 'undefined' ? AircraftCard : require('./aircraft-card');
    const { escapeHtml, altitude: formatAltitude } = cardModule;
    const MAP_WIDTH = 1748;
    const MAP_HEIGHT = 1747;
    const MAP_X_SCALE = 1023.9218009042783;
    const MAP_X_OFFSET = -5412.222393087557;
    const MAP_Y_SCALE = -58671.31391937124;
    const MAP_Y_OFFSET = 54495.2374689763;

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

    function mapPath(aircraft, includeEstimatedPosition = true, layer = 'arrivals') {
        const points = (aircraft.track?.points || [])
            .map(point => mapCoordinates(point.latitude, point.longitude))
            .filter(Boolean);
        if (includeEstimatedPosition) {
            const estimatedPosition = mapCoordinates(aircraft.latitude, aircraft.longitude);
            if (estimatedPosition) points.push(estimatedPosition);
        }
        if (points.length < 2 || !aircraft.track?.color) return '';
        const path = smoothMapPath(points);
        return `<path class="map-flight-path${layer === 'arrivals' ? '' : ` map-${layer}-path`}" d="${path}" stroke="${escapeHtml(aircraft.track.color)}"></path>`;
    }

    function mapMarker(aircraft, selectedAircraftId, layer = 'arrivals') {
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
        return `<g class="map-aircraft${headingClass}${layer === 'arrivals' ? '' : ` map-${layer}-aircraft`}" transform="translate(${position.x} ${position.y})" fill="${escapeHtml(aircraft.track?.color || '#a020d0')}" role="button" tabindex="0" data-aircraft-id="${escapeHtml(aircraft.icao24)}" aria-controls="mapAircraftDetails" aria-expanded="${selectedAircraftId === aircraft.icao24}" aria-label="${escapeHtml(label)}. Show aircraft details">
            ${icon}<text class="map-aircraft-label" x="17" y="4">${escapeHtml(callsign)}</text>
        </g>`;
    }


    function isGenevaDeparture(aircraft) {
        const origin = aircraft.route?.origin;
        return origin?.iata_code?.toUpperCase() === 'GVA' || origin?.icao_code?.toUpperCase() === 'LSGG';
    }

    function create({ document, storage, card = cardModule, now = Date.now }) {
        const layers = { arrivals: true, general: false, departures: false };
        let selectedAircraftId = null;
        let snapshot = null;
        let initialized = false;

        function traffic() {
            const all = Array.isArray(snapshot?.generalTraffic) ? snapshot.generalTraffic : [];
            return {
                general: layers.general ? all.filter(aircraft => !isGenevaDeparture(aircraft)) : [],
                departures: layers.departures ? all.filter(isGenevaDeparture) : []
            };
        }
        function visibleAircraft() {
            const { general, departures } = traffic();
            return [...(layers.arrivals && Array.isArray(snapshot?.aircraft) ? snapshot.aircraft : []), ...general, ...departures]
                .filter(aircraft => mapPosition(aircraft.latitude, aircraft.longitude));
        }
        function details() {
            const panel = document.getElementById('mapAircraftDetails');
            const aircraft = visibleAircraft().find(item => item.icao24 === selectedAircraftId);
            panel.hidden = !aircraft;
            if (aircraft) card.selected(aircraft, document);
            else selectedAircraftId = null;
        }
        function update(nextSnapshot = snapshot) {
            snapshot = nextSnapshot;
            const focusedId = document.activeElement?.dataset?.aircraftId;
            details();
            const { general, departures } = traffic();
            const arrivals = layers.arrivals && Array.isArray(snapshot?.aircraft) ? snapshot.aircraft : [];
            const recentTracks = layers.arrivals && Array.isArray(snapshot?.recentTracks)
                ? snapshot.recentTracks.filter(track => Number.isFinite(track.expiresAt) && track.expiresAt > now() / 1000) : [];
            const paths = document.getElementById('mapPaths');
            const markers = document.getElementById('mapMarkers');
            paths.innerHTML = [
                ...general.map(item => mapPath(item, true, 'general')),
                ...departures.map(item => mapPath(item, true, 'departure')),
                ...recentTracks.map(item => mapPath(item, false)),
                ...arrivals.map(item => mapPath(item, true))
            ].filter(Boolean).join('');
            const markup = [
                ...general.map(item => mapMarker(item, selectedAircraftId, 'general')),
                ...departures.map(item => mapMarker(item, selectedAircraftId, 'departure')),
                ...arrivals.map(item => mapMarker(item, selectedAircraftId))
            ].filter(Boolean).join('');
            const empty = !layers.arrivals && !layers.general && !layers.departures
                ? 'Select a traffic layer to show aircraft.' : 'No aircraft in the selected layers are within this map area.';
            markers.innerHTML = markup || `<text class="map-empty" x="874" y="874" text-anchor="middle">${empty}</text>`;
            if (focusedId) [...markers.querySelectorAll('[data-aircraft-id]')]
                .find(marker => marker.dataset.aircraftId === focusedId)?.focus({ preventScroll: true });
        }
        function setLayer(key, enabled) {
            if (!(key in layers)) return;
            layers[key] = Boolean(enabled);
            try { storage?.setItem('geneva-map-layers', JSON.stringify(layers)); } catch { /* Keep this page's choice. */ }
            update();
        }
        function init() {
            if (initialized) return;
            initialized = true;
            try {
                const saved = JSON.parse(storage?.getItem('geneva-map-layers'));
                if (typeof saved?.departures !== 'boolean' && saved?.departuresOnly === true) layers.departures = saved.general === true;
                for (const key of Object.keys(layers)) if (typeof saved?.[key] === 'boolean') layers[key] = saved[key];
                if (saved?.departuresOnly === true && typeof saved?.departures !== 'boolean') layers.general = false;
            } catch { /* Storage may be unavailable. */ }
            for (const [key, id] of [['arrivals', 'showArrivals'], ['general', 'showGeneralTraffic'], ['departures', 'showDepartures']]) {
                const input = document.getElementById(id);
                input.checked = layers[key];
                input.addEventListener('change', () => setLayer(key, input.checked));
            }
            const markers = document.getElementById('mapMarkers');
            const select = event => {
                const marker = event.target.closest('[data-aircraft-id]');
                if (!marker) return;
                selectedAircraftId = selectedAircraftId === marker.dataset.aircraftId ? null : marker.dataset.aircraftId;
                details();
                for (const item of markers.querySelectorAll('[data-aircraft-id]'))
                    item.setAttribute('aria-expanded', String(item.dataset.aircraftId === selectedAircraftId));
            };
            markers.addEventListener('click', select);
            markers.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event); }
            });
            const close = () => {
                const id = selectedAircraftId;
                selectedAircraftId = null;
                update();
                [...markers.querySelectorAll('[data-aircraft-id]')]
                    .find(marker => marker.dataset.aircraftId === id)?.focus({ preventScroll: true });
            };
            document.getElementById('closeMapDetails').addEventListener('click', close);
            document.getElementById('mapSection').addEventListener('keydown', event => {
                if (event.key === 'Escape' && selectedAircraftId) close();
            });
        }
        return { init, update, setLayer, visibleAircraft, get selectedAircraftId() { return selectedAircraftId; } };
    }
    return { create, mapPosition, mapPath, mapMarker, isGenevaDeparture };
})();

if (typeof module !== 'undefined') module.exports = AircraftMap;
