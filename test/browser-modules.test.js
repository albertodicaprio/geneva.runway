const test = require('node:test');
const assert = require('node:assert/strict');
const card = require('../public/aircraft-card');
const { create, mapMarker } = require('../public/aircraft-map');

const aircraft = (icao24, extra = {}) => ({
    icao24, callsign: icao24, latitude: 46.3, longitude: 6.2, altitude: 10000,
    heading: 90, velocity: 200, distanceKm: 20, verticalRate: -2, approachDirection: '22',
    track: { color: '#00bfff', points: [{ latitude: 46.2, longitude: 6.1 }, { latitude: 46.3, longitude: 6.2 }] },
    ...extra
});

function makeDocument() {
    const ids = ['mapPaths', 'mapMarkers', 'showArrivals', 'showGeneralTraffic', 'showDepartures',
        'mapAircraftDetails', 'mapDetailsHeading', 'mapDetailsAirline', 'mapDetailsModel',
        'mapDetailsOrigin', 'mapDetailsPhoto', 'mapDetailsDestination', 'mapDetailsSpeed',
        'mapDetailsAltitude', 'mapDetailsBearing', 'closeMapDetails', 'mapSection'];
    const elements = Object.fromEntries(ids.map(id => [id, {
        dataset: {}, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
        querySelectorAll() { return this.markers || []; }
    }]));
    return { elements, document: { activeElement: null, getElementById: id => elements[id] } };
}

function selectEvent(id, key) {
    return { key, target: { closest: () => ({ dataset: { aircraftId: id } }) }, preventDefault() { this.prevented = true; } };
}

test('featured and list layouts share escaped identity, route, photo, and measurements', () => {
    const plane = aircraft('<GVA>', {
        route: { airline: { name: 'Swiss & Partners' }, origin: { iata_code: 'LHR', name: 'London Heathrow Airport' } },
        aircraftDetails: { type: 'Airbus A320', url_photo_thumbnail: 'https://example.test/plane.jpg' }
    });
    for (const markup of [card.featured(plane), card.list(plane)]) {
        assert.match(markup, /&lt;GVA&gt;/);
        assert.match(markup, /Swiss &amp; Partners/);
        assert.match(markup, /LHR · London Heathrow Airport/);
        assert.match(markup, /Airbus A320/);
        assert.match(markup, /10,000 m/);
        assert.match(markup, /https:\/\/example.test\/plane.jpg/);
        assert.doesNotMatch(markup, /onerror=/);
    }
    assert.match(card.featured(plane), /next-copy|hero-metrics/);
    assert.match(card.list(plane), /arrival-card-main/);
    plane.aircraftDetails.url_photo_thumbnail = 'javascript:alert(1)';
    assert.doesNotMatch(card.list(plane), /<img/);
    const frame = { innerHTML: '<img>' };
    card.handlePhotoError({ target: { tagName: 'IMG', closest: () => frame } });
    assert.match(frame.innerHTML, /Photo unavailable/);
});

test('map layers persist and partition Geneva departures from general traffic', () => {
    const { document, elements } = makeDocument();
    let saved = JSON.stringify({ arrivals: false, general: true, departuresOnly: true });
    const map = create({ document, storage: { getItem: () => saved, setItem: (_, value) => { saved = value; } } });
    map.init();
    assert.equal(elements.showDepartures.checked, true);
    assert.equal(elements.showGeneralTraffic.checked, false);
    map.update({ aircraft: [aircraft('ARRIVAL')], generalTraffic: [
        aircraft('DEPART', { route: { origin: { icao_code: 'lsgg' } } }),
        aircraft('OTHER'), aircraft('UNKNOWN', { route: null })
    ] });
    assert.match(elements.mapMarkers.innerHTML, /DEPART/);
    assert.doesNotMatch(elements.mapMarkers.innerHTML, /OTHER|ARRIVAL/);
    elements.showGeneralTraffic.checked = true;
    elements.showGeneralTraffic.handlers.change();
    assert.match(elements.mapMarkers.innerHTML, /OTHER|UNKNOWN/);
    assert.equal((elements.mapMarkers.innerHTML.match(/data-aircraft-id="DEPART"/g) || []).length, 1);
    assert.deepEqual(JSON.parse(saved), { arrivals: false, general: true, departures: true });
    elements.showDepartures.checked = false;
    elements.showDepartures.handlers.change();
    assert.doesNotMatch(elements.mapMarkers.innerHTML, /DEPART/);
    elements.showGeneralTraffic.checked = false;
    elements.showGeneralTraffic.handlers.change();
    assert.match(elements.mapMarkers.innerHTML, /Select a traffic layer/);
});

test('retained paths expire and layer changes work when storage is unavailable', () => {
    const { document, elements } = makeDocument();
    const map = create({ document, now: () => 100_000, storage: {
        getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }
    } });
    map.init();
    map.update({ recentTracks: [
        aircraft('RECENT', { expiresAt: 101, track: { color: 'red', points: [
            { latitude: 46.2, longitude: 6.1 }, { latitude: 46.3, longitude: 6.2 }
        ] } }),
        aircraft('EXPIRED', { expiresAt: 100, track: { color: 'purple', points: [
            { latitude: 46.2, longitude: 6.1 }, { latitude: 46.3, longitude: 6.2 }
        ] } })
    ] });
    assert.match(elements.mapPaths.innerHTML, /stroke="red"/);
    assert.doesNotMatch(elements.mapPaths.innerHTML, /purple/);
    assert.doesNotMatch(elements.mapPaths.innerHTML, /map-selected-path/);
    map.setLayer('arrivals', false);
    assert.equal(elements.mapPaths.innerHTML, '');
});

test('selection supports click, Enter, Space, Escape, close and selected-card fallbacks', () => {
    const { document, elements } = makeDocument();
    const plane = aircraft('GENERAL', {
        route: { airline: { name: 'Swiss' }, origin: { name: 'London Heathrow Airport', iata_code: 'LHR' }, destination: { name: 'Geneva Cointrin International Airport', iata_code: 'GVA' } },
        aircraftDetails: { type: 'Airbus A320', url_photo_thumbnail: 'https://example.test/plane.jpg' }
    });
    const map = create({ document });
    map.init();
    map.setLayer('general', true);
    map.update({ generalTraffic: [plane] });
    const event = selectEvent('GENERAL');
    elements.mapMarkers.handlers.click(event);
    assert.equal(map.selectedAircraftId, 'GENERAL');
    assert.match(elements.mapPaths.innerHTML, /map-general-path map-selected-path/);
    assert.equal(elements.mapAircraftDetails.hidden, false);
    assert.equal(elements.mapDetailsOrigin.textContent, 'London Heathrow Airport (LHR)');
    assert.equal(elements.mapDetailsDestination.textContent, 'Geneva Cointrin International Airport (GVA)');
    assert.equal(elements.mapDetailsSpeed.textContent, '720 km/h');
    assert.match(elements.mapDetailsPhoto.innerHTML, /plane.jpg/);
    plane.velocity = 0; plane.altitude = 0; plane.heading = 359.9;
    map.update();
    assert.equal(elements.mapDetailsSpeed.textContent, '0 km/h');
    assert.equal(elements.mapDetailsBearing.textContent, '0°');
    assert.match(elements.mapMarkers.innerHTML, /aria-expanded="true"/);
    assert.match(elements.mapPaths.innerHTML, /map-general-path map-selected-path/);
    const keyEvent = selectEvent('GENERAL', 'Enter');
    elements.mapMarkers.handlers.keydown(keyEvent);
    assert.equal(keyEvent.prevented, true);
    assert.equal(map.selectedAircraftId, null);
    assert.doesNotMatch(elements.mapPaths.innerHTML, /map-selected-path/);
    const spaceEvent = selectEvent('GENERAL', ' ');
    elements.mapMarkers.handlers.keydown(spaceEvent);
    assert.equal(map.selectedAircraftId, 'GENERAL');
    assert.match(elements.mapPaths.innerHTML, /map-selected-path/);
    elements.mapSection.handlers.keydown({ key: 'Escape' });
    assert.equal(map.selectedAircraftId, null);
    assert.doesNotMatch(elements.mapPaths.innerHTML, /map-selected-path/);
    elements.mapMarkers.handlers.click(event);
    elements.closeMapDetails.handlers.click();
    assert.equal(elements.mapAircraftDetails.hidden, true);
    assert.doesNotMatch(elements.mapPaths.innerHTML, /map-selected-path/);
    elements.mapMarkers.handlers.click(event);
    plane.route = null; plane.aircraftDetails = null; plane.velocity = null; plane.altitude = null; plane.heading = null;
    map.update();
    assert.equal(elements.mapDetailsOrigin.textContent, 'Unknown airport');
    assert.equal(elements.mapDetailsModel.textContent, 'Unknown model');
    assert.equal(elements.mapDetailsSpeed.textContent, '—');
    assert.match(elements.mapDetailsPhoto.innerHTML, /Photo unavailable/);
    map.setLayer('general', false);
    assert.equal(map.selectedAircraftId, null);
    assert.equal(elements.mapAircraftDetails.hidden, true);
});

test('map redraw restores keyboard focus without moving the viewport', () => {
    const { document, elements } = makeDocument();
    let scrollY = 1600;
    const marker = { dataset: { aircraftId: 'GENERAL' }, focus(options) { if (!options?.preventScroll) scrollY = 800; } };
    elements.mapMarkers.markers = [marker];
    document.activeElement = marker;
    const map = create({ document });
    map.setLayer('general', true);
    map.update({ generalTraffic: [aircraft('GENERAL')] });
    assert.equal(scrollY, 1600);
});

test('map markers keep escaped accessible labels without hover tooltips', () => {
    const markup = mapMarker(aircraft('<GENERAL>'), null, 'general');
    assert.match(markup, /aria-label="&lt;GENERAL&gt;/);
    assert.match(markup, /Show aircraft details/);
    assert.doesNotMatch(markup, /<title| title=/);
});
