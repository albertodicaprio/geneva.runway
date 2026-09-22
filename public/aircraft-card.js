/* Shared presentation for featured, list, and selected aircraft cards. */
const AircraftCard = (() => {
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
    }

    function safeImageUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' || url.protocol === 'http:' ? escapeHtml(url.href) : null;
        } catch { return null; }
    }

    function airport(airport, full = false) {
        if (!airport) return full ? 'Unknown airport' : 'Origin unavailable';
        const code = airport.iata_code || airport.icao_code;
        if (full) return airport.name ? `${airport.name}${code ? ` (${code})` : ''}` : code || 'Unknown airport';
        return [code || '—', airport.municipality || airport.name].filter(Boolean).join(' · ');
    }

    function altitude(value) { return Number.isFinite(value) ? `${Math.round(value).toLocaleString()} m` : '—'; }
    function speed(value) { return Number.isFinite(value) ? `${Math.round(value * 3.6)} km/h` : '—'; }
    function descent(value) { return Number.isFinite(value) ? `${Math.round(value * 60).toLocaleString()} m/min` : '—'; }
    function distance(value) { return Number.isFinite(value) ? `${value.toFixed(1)} km` : '—'; }
    function eta(aircraft) {
        if (!Number.isFinite(aircraft.distanceKm) || !Number.isFinite(aircraft.velocity) || aircraft.velocity <= 0) return '—';
        return `~${Math.max(1, Math.round(aircraft.distanceKm * 1000 / aircraft.velocity / 60))} min`;
    }
    function bearing(value) { return Number.isFinite(value) ? `${((Math.round(value) % 360) + 360) % 360}°` : '—'; }
    function identity(aircraft) {
        const details = aircraft.aircraftDetails || {};
        return [details.type, details.icao_type, details.registration].filter(Boolean).join(' · ') || 'Aircraft details unavailable';
    }
    function approach(aircraft) {
        return aircraft.approachDirection === 'unknown' ? 'Approach unknown' : `Likely runway ${aircraft.approachDirection}`;
    }
    function photoFrame(aircraft, frameClass, imageClass) {
        const url = safeImageUrl(aircraft.aircraftDetails?.url_photo_thumbnail);
        return url ? `<div class="${frameClass}"><img class="${imageClass}" src="${url}" alt="" loading="lazy"></div>` : '';
    }
    function metrics(items, className = '') {
        return `<div class="metrics${className ? ` ${className}` : ''}">${items.map(([label, value]) =>
            `<div><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>`;
    }
    function title(aircraft, featured) {
        const name = escapeHtml(aircraft.callsign || aircraft.icao24 || 'Unknown aircraft');
        return `<div class="arrival-title-row"><div>${featured ? `<p class="callsign">${name}</p>` : `<h3>${name}</h3>`}
            <p class="airline">${escapeHtml(aircraft.route?.airline?.name || 'Airline unavailable')}</p></div>
            <span class="approach-badge ${escapeHtml(aircraft.approachConfidence)}">${escapeHtml(approach(aircraft))}</span></div>`;
    }
    function arrivalBody(aircraft, featured) {
        return `${title(aircraft, featured)}<p class="route">${escapeHtml(airport(aircraft.route?.origin))} <span>→</span> GVA</p>
            <p class="aircraft-model">${escapeHtml(identity(aircraft))}</p>${metrics(featured
                ? [['Altitude', altitude(aircraft.altitude)], ['Distance', distance(aircraft.distanceKm)], ['Descent', descent(aircraft.verticalRate)], ['Rough ETA', eta(aircraft)]]
                : [['Altitude', altitude(aircraft.altitude)], ['Distance', distance(aircraft.distanceKm)], ['Speed', speed(aircraft.velocity)], ['Descent', descent(aircraft.verticalRate)]], featured ? 'hero-metrics' : '')}`;
    }
    function featured(aircraft) {
        return `${photoFrame(aircraft, 'next-photo-wrap', 'next-photo')}<div class="next-copy">${arrivalBody(aircraft, true)}</div>`;
    }
    function list(aircraft) {
        return `<article class="arrival-card">${photoFrame(aircraft, 'card-photo-wrap', 'aircraft-photo')}
            <div class="arrival-card-main">${arrivalBody(aircraft, false)}</div></article>`;
    }
    function selected(aircraft, document) {
        const photo = document.getElementById('mapDetailsPhoto');
        const url = safeImageUrl(aircraft.aircraftDetails?.url_photo_thumbnail) || '';
        if (photo.dataset.photoUrl !== url) {
            photo.dataset.photoUrl = url;
            photo.innerHTML = url ? `<img src="${url}" alt="Selected aircraft" loading="lazy">` : '<p>Photo unavailable</p>';
        }
        const values = {
            mapDetailsHeading: aircraft.callsign || aircraft.icao24 || 'Unknown aircraft',
            mapDetailsAirline: aircraft.route?.airline?.name || 'Airline unavailable',
            mapDetailsModel: aircraft.aircraftDetails?.type || aircraft.aircraftDetails?.icao_type || 'Unknown model',
            mapDetailsOrigin: airport(aircraft.route?.origin, true),
            mapDetailsDestination: airport(aircraft.route?.destination, true),
            mapDetailsSpeed: speed(aircraft.velocity), mapDetailsAltitude: altitude(aircraft.altitude),
            mapDetailsBearing: bearing(aircraft.heading)
        };
        for (const [id, value] of Object.entries(values)) document.getElementById(id).textContent = value;
    }
    function handlePhotoError(event) {
        if (event.target.tagName !== 'IMG') return;
        const frame = event.target.closest('.next-photo-wrap, .card-photo-wrap');
        if (frame) frame.innerHTML = '<p class="photo-unavailable">Photo unavailable</p>';
    }
    return { escapeHtml, safeImageUrl, altitude, speed, featured, list, selected, handlePhotoError };
})();

if (typeof module !== 'undefined') module.exports = AircraftCard;
