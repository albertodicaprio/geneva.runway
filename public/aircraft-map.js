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
            const [firstControl, secondControl] = curveControls(points, index);
            const next = points[index + 1];
            path += ` C ${coordinate(firstControl.x)} ${coordinate(firstControl.y)} ${coordinate(secondControl.x)} ${coordinate(secondControl.y)} ${coordinate(next.x)} ${coordinate(next.y)}`;
        }

        return path;
    }

    function curveControls(points, index) {
        const previous = points[index - 1] || points[index];
        const current = points[index];
        const next = points[index + 1];
        const following = points[index + 2] || next;
        return [
            { x: current.x + (next.x - previous.x) / 6, y: current.y + (next.y - previous.y) / 6 },
            { x: next.x - (following.x - current.x) / 6, y: next.y - (following.y - current.y) / 6 }
        ];
    }

    function pathPoints(aircraft, includeEstimatedPosition) {
        const points = (aircraft.track?.points || [])
            .map(point => ({ ...mapCoordinates(point.latitude, point.longitude), timestamp: point.timestamp }))
            .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
            .filter((point, index, valid) => index === 0 || point.x !== valid[index - 1].x || point.y !== valid[index - 1].y);
        if (includeEstimatedPosition) {
            const position = mapCoordinates(aircraft.latitude, aircraft.longitude);
            const last = points.at(-1);
            if (position && (!last || last.x !== position.x || last.y !== position.y))
                points.push({ ...position, timestamp: last?.timestamp });
        }
        return points;
    }

    function trailTimeAt(aircraft, x, y, includeEstimatedPosition = true) {
        const points = pathPoints(aircraft, includeEstimatedPosition);
        if (points.length < 2) return null;
        let nearest = { distance: Infinity, time: null };
        for (let index = 0; index < points.length - 1; index += 1) {
            const start = points[index], end = points[index + 1];
            if (!Number.isFinite(start.timestamp) || !Number.isFinite(end.timestamp)) continue;
            const [first, second] = curveControls(points, index);
            const position = t => {
                const u = 1 - t;
                return { x: u ** 3 * start.x + 3 * u ** 2 * t * first.x + 3 * u * t ** 2 * second.x + t ** 3 * end.x,
                    y: u ** 3 * start.y + 3 * u ** 2 * t * first.y + 3 * u * t ** 2 * second.y + t ** 3 * end.y };
            };
            let previous = position(0);
            for (let step = 1; step <= 16; step += 1) {
                const next = position(step / 16);
                const dx = next.x - previous.x, dy = next.y - previous.y;
                const fraction = Math.max(0, Math.min(1, ((x - previous.x) * dx + (y - previous.y) * dy) / (dx * dx + dy * dy || 1)));
                const distance = (x - previous.x - fraction * dx) ** 2 + (y - previous.y - fraction * dy) ** 2;
                if (distance < nearest.distance) nearest = { distance, time: Math.round(start.timestamp +
                    (end.timestamp - start.timestamp) * ((step - 1 + fraction) / 16)) };
                previous = next;
            }
        }
        return nearest.time;
    }

    function mapPath(aircraft, includeEstimatedPosition = true, layer = 'arrivals', selectedAircraftId = null) {
        // Archived snapshots can repeat a coordinate; drawing those as separate curves creates loops at turns.
        const points = pathPoints(aircraft, includeEstimatedPosition);
        if (points.length < 2 || !aircraft.track?.color) return '';
        const path = smoothMapPath(points);
        const selectedClass = selectedAircraftId != null && selectedAircraftId === aircraft.icao24 ? ' map-selected-path' : '';
        const label = `${aircraft.callsign || aircraft.icao24 || 'Unknown aircraft'} trail. Click to go to this time; press Enter for aircraft details`;
        return `<g class="map-trail" role="button" tabindex="0" data-aircraft-id="${escapeHtml(aircraft.icao24)}" data-map-target="trail" aria-controls="mapAircraftDetails" aria-expanded="${selectedAircraftId === aircraft.icao24}" aria-label="${escapeHtml(label)}">
            <path class="map-flight-path${layer === 'arrivals' ? '' : ` map-${layer}-path`}${selectedClass}" d="${path}" stroke="${escapeHtml(aircraft.track.color)}" aria-hidden="true"></path>
            <path class="map-trail-target" d="${path}" aria-hidden="true"></path>
        </g>`;
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
        let selectedTarget = 'marker';
        let snapshot = null;
        let history = null;
        let initialized = false;
        let onTrailTime = null;
        const current = () => history || snapshot;

        function traffic() {
            const all = Array.isArray(current()?.generalTraffic)
                ? current().generalTraffic.filter(aircraft => aircraft.historicalActive !== false) : [];
            return {
                general: layers.general ? all.filter(aircraft => !isGenevaDeparture(aircraft)) : [],
                departures: layers.departures ? all.filter(isGenevaDeparture) : []
            };
        }
        function visibleAircraft() {
            const { general, departures } = traffic();
            return [...(layers.arrivals && Array.isArray(current()?.aircraft) ? current().aircraft : []), ...general, ...departures]
                .filter(aircraft => aircraft.historicalActive !== false)
                .filter(aircraft => mapPosition(aircraft.latitude, aircraft.longitude));
        }
        function retainedTracks() {
            return layers.arrivals && Array.isArray(current()?.recentTracks)
                ? current().recentTracks.filter(track => Number.isFinite(track.expiresAt) && track.expiresAt > now() / 1000) : [];
        }
        function selectableAircraft() {
            const { general, departures } = traffic();
            return [...(layers.arrivals ? current()?.aircraft || [] : []), ...general, ...departures, ...retainedTracks()];
        }
        function focusAircraft(id, target = 'marker') {
            const markers = document.getElementById('mapMarkers');
            const paths = document.getElementById('mapPaths');
            const containers = target === 'trail' ? [paths, markers] : [markers, paths];
            containers.flatMap(container => [...container.querySelectorAll('[data-aircraft-id]')])
                .find(item => item.dataset.aircraftId === id)?.focus({ preventScroll: true });
        }
        function details() {
            const panel = document.getElementById('mapAircraftDetails');
            const aircraft = selectableAircraft().find(item => item.icao24 === selectedAircraftId);
            panel.hidden = !aircraft;
            if (aircraft) card.selected(aircraft, document);
            else selectedAircraftId = null;
        }
        function update(nextSnapshot = snapshot) {
            const liveChanged = nextSnapshot !== snapshot;
            snapshot = nextSnapshot;
            if (history && liveChanged) return;
            const data = current();
            const focusedId = document.activeElement?.dataset?.aircraftId;
            const focusedTarget = document.activeElement?.dataset?.mapTarget;
            details();
            const { general, departures } = traffic();
            const arrivals = layers.arrivals && Array.isArray(data?.aircraft) ? data.aircraft : [];
            const recentTracks = retainedTracks();
            const includeLivePosition = !data?.historical;
            const paths = document.getElementById('mapPaths');
            const markers = document.getElementById('mapMarkers');
            paths.innerHTML = [
                ...general.map(item => mapPath(item, includeLivePosition, 'general', selectedAircraftId)),
                ...departures.map(item => mapPath(item, includeLivePosition, 'departure', selectedAircraftId)),
                ...recentTracks.map(item => mapPath(item, false, 'arrivals', selectedAircraftId)),
                ...arrivals.map(item => mapPath(item, includeLivePosition, 'arrivals', selectedAircraftId))
            ].filter(Boolean).join('');
            const markup = [
                ...general.filter(item => item.historicalActive !== false).map(item => mapMarker(item, selectedAircraftId, 'general')),
                ...departures.filter(item => item.historicalActive !== false).map(item => mapMarker(item, selectedAircraftId, 'departure')),
                ...arrivals.filter(item => item.historicalActive !== false).map(item => mapMarker(item, selectedAircraftId))
            ].filter(Boolean).join('');
            const empty = !layers.arrivals && !layers.general && !layers.departures
                ? 'Select a traffic layer to show aircraft.' : 'No aircraft in the selected layers are within this map area.';
            markers.innerHTML = markup || (paths.innerHTML ? '' : `<text class="map-empty" x="874" y="874" text-anchor="middle">${empty}</text>`);
            if (focusedId) focusAircraft(focusedId, focusedTarget);
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
            const paths = document.getElementById('mapPaths');
            const select = event => {
                const marker = event.target.closest('[data-aircraft-id]');
                if (!marker) return;
                if (event.type === 'click' && marker.dataset.mapTarget === 'trail' && onTrailTime) {
                    const svg = marker.ownerSVGElement;
                    const matrix = svg?.getScreenCTM();
                    if (matrix && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
                        const point = svg.createSVGPoint();
                        point.x = event.clientX;
                        point.y = event.clientY;
                        const local = point.matrixTransform(matrix.inverse());
                        const item = selectableAircraft().find(aircraft => aircraft.icao24 === marker.dataset.aircraftId);
                        const at = item && trailTimeAt(item, local.x, local.y, !current()?.historical &&
                            !retainedTracks().includes(item));
                        if (at !== null && at !== undefined && onTrailTime(at)) return;
                    }
                }
                selectedTarget = marker.dataset.mapTarget || 'marker';
                selectedAircraftId = selectedAircraftId === marker.dataset.aircraftId ? null : marker.dataset.aircraftId;
                update();
            };
            for (const container of [markers, paths]) {
                container.addEventListener('click', select);
                container.addEventListener('keydown', event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(event); }
                });
            }
            const close = () => {
                const id = selectedAircraftId;
                selectedAircraftId = null;
                update();
                focusAircraft(id, selectedTarget);
            };
            document.getElementById('closeMapDetails').addEventListener('click', close);
            document.getElementById('mapSection').addEventListener('keydown', event => {
                if (event.key === 'Escape' && selectedAircraftId) close();
            });
        }
        function beginHistory() {
            // Freeze the displayed snapshot while the requested time is loading.
            if (!history) history = snapshot || { historical: true, aircraft: [], generalTraffic: [] };
        }
        function setHistory(value) {
            history = value;
            selectedAircraftId = null;
            update();
        }
        return { init, update, beginHistory, setHistory, setLayer, visibleAircraft,
            setTrailTimeHandler(handler) { onTrailTime = handler; }, get selectedAircraftId() { return selectedAircraftId; } };
    }
    return { create, mapPosition, mapPath, mapMarker, isGenevaDeparture, trailTimeAt };
})();

if (typeof module !== 'undefined') module.exports = AircraftMap;
