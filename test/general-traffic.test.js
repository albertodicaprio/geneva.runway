const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { addGeneralTraffic, addArrivalTracks, projectAircraftData } = require('../lib/aircraft-service');

const aircraft = (icao24, extra = {}) => ({
    icao24, latitude: 46.3, longitude: 6.2, altitude: 10000,
    onGround: false, heading: 90, velocity: 200, lastPositionUpdate: 4000, ...extra
});

test('general traffic includes high and unidentified airborne traffic without duplicating arrivals or retaining vanished flights', () => {
    const arrival = aircraft('arrival');
    const data = { updatedAt: 4000, aircraft: [arrival, aircraft('general'), aircraft('ground', { onGround: true })] };
    const previous = { generalTraffic: [aircraft('general', { track: { points: [
        { latitude: 46.2, longitude: 6.1, timestamp: 399 },
        { latitude: 46.25, longitude: 6.15, timestamp: 400 }
    ] } }), aircraft('vanished')] };
    const result = addGeneralTraffic({ aircraft: [arrival] }, data, previous);
    assert.deepEqual(result.aircraft, [arrival]);
    assert.deepEqual(result.generalTraffic.map(a => a.icao24), ['general']);
    assert.equal(result.generalTraffic[0].track.color, '#00bfff');
    assert.deepEqual(result.generalTraffic[0].track.points.map(p => p.timestamp), [400, 4000]);
    const restored = JSON.parse(JSON.stringify(result));
    const repeated = addGeneralTraffic({ aircraft: [arrival] }, data, restored);
    assert.equal(repeated.generalTraffic[0].track.points.length, 2);
    const projected = projectAircraftData(restored, 4030000);
    assert.ok(projected.generalTraffic[0].longitude > 6.2);
    assert.equal(restored.generalTraffic[0].longitude, 6.2);
    const promoted = addArrivalTracks({ updatedAt: 4030, aircraft: [aircraft('general')] }, restored);
    assert.deepEqual(promoted.aircraft[0].track.points.map(p => p.timestamp), [4000, 4030]);
    assert.notEqual(promoted.aircraft[0].track.color, '#00bfff');
});

test('map toggles hide paths and markers independently, persist choices and tolerate unavailable storage', () => {
    const elements = Object.fromEntries(['mapPaths', 'mapMarkers', 'showArrivals', 'showGeneralTraffic', 'mapAircraftDetails', 'mapDetailsHeading', 'mapDetailsModel', 'mapDetailsOrigin', 'mapDetailsPhoto', 'mapDetailsDestination'].map(id => [id, {
        addEventListener(event, handler) { this.change = handler; }
    }]));
    let saved;
    const context = vm.createContext({
        document: { readyState: 'loading', addEventListener() {}, getElementById: id => elements[id] },
        localStorage: { getItem: () => saved || null, setItem: (key, value) => { saved = value; } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    const track = { color: 'red', points: [{ latitude: 46.2, longitude: 6.1 }, { latitude: 46.3, longitude: 6.2 }] };
    context.fixture = { aircraft: [aircraft('ARRIVAL', { track })], generalTraffic: [aircraft('GENERAL', { track: { ...track, color: '#00bfff' } })], recentTracks: [{ track, expiresAt: Date.now() / 1000 + 500 }] };
    vm.runInContext('latestData = fixture; aircraftData = fixture.aircraft; initMapLayers(); updateMap();', context);
    assert.match(elements.mapMarkers.innerHTML, /ARRIVAL/);
    assert.doesNotMatch(elements.mapMarkers.innerHTML, /GENERAL/);
    elements.showGeneralTraffic.checked = true;
    elements.showGeneralTraffic.change();
    assert.match(elements.mapMarkers.innerHTML, /GENERAL/);
    assert.match(elements.mapPaths.innerHTML, /map-general-path/);
    elements.showArrivals.checked = false;
    elements.showArrivals.change();
    assert.doesNotMatch(elements.mapMarkers.innerHTML, /ARRIVAL/);
    assert.doesNotMatch(elements.mapPaths.innerHTML, /stroke="red"/);
    assert.deepEqual(JSON.parse(saved), { arrivals: false, general: true });
    vm.runInContext('mapLayers.arrivals = true; mapLayers.general = false; initMapLayers();', context);
    assert.equal(elements.showArrivals.checked, false);
    assert.equal(elements.showGeneralTraffic.checked, true);
    context.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
    vm.runInContext('initMapLayers();', context);
    elements.showGeneralTraffic.checked = false;
    elements.showGeneralTraffic.change();
    assert.equal(elements.mapPaths.innerHTML, '');
    assert.match(elements.mapMarkers.innerHTML, /Select a traffic layer/);
});

test('general routes are cached for overflights and tolerate missing identities and unknown routes', async () => {
    const { enrichGeneralTraffic } = require('../lib/aircraft-service');
    const originalFetch = global.fetch;
    const requested = [];
    global.fetch = async url => {
        requested.push(String(url));
        if (String(url).includes('/aircraft/')) return { ok: true, status: 200, json: async () => ({ response: { aircraft: { type: 'Airbus A320' } } }) };
        const found = String(url).endsWith('/callsign/OVERFLIGHT');
        return { ok: found, status: found ? 200 : 404, json: async () => found
            ? { response: { flightroute: { origin: { iata_code: 'LHR' }, destination: { iata_code: 'GVA' } } } }
            : {} };
    };
    try {
        const data = { updatedAt: 4000, aircraft: [], generalTraffic: [
            aircraft('over01', { callsign: 'OVERFLIGHT' }), aircraft('noid'), aircraft('unknown', { callsign: 'NO_ROUTE' })
        ] };
        const result = await enrichGeneralTraffic(data);
        assert.equal(result.generalTraffic[0].route.origin.iata_code, 'LHR');
        assert.equal(result.generalTraffic[0].route.destination.iata_code, 'GVA');
        assert.equal(result.generalTraffic[1].route, null);
        assert.equal(result.generalTraffic[2].route, null);
        assert.deepEqual(result.aircraft, []);
        await enrichGeneralTraffic(data);
        assert.equal(requested.filter(url => url.includes('/callsign/')).length, 2);
        assert.equal(requested.filter(url => url.includes('/aircraft/')).length, 3);
        assert.equal(result.generalTraffic[0].aircraftDetails.type, 'Airbus A320');
    } finally { global.fetch = originalFetch; }
});

test('map tooltips show route on a second line with escaped airport names and unknown fallbacks', () => {
    const context = vm.createContext({ URL, document: { readyState: 'loading', addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    const plane = aircraft('GENERAL', { route: { origin: { iata_code: 'LHR' }, destination: { icao_code: 'LSGG' } } });
    assert.match(context.mapMarker(plane, true), /<title>GENERAL, [^\n]+\nLHR → LSGG<\/title>/);
    plane.route = { origin: { name: '<Airport>' } };
    assert.match(context.mapMarker(plane, true), /\n&lt;Airport&gt; → Unknown<\/title>/);
    delete plane.route;
    assert.match(context.mapMarker(plane, true), /\nUnknown → Unknown<\/title>/);
});

test('clicking and keyboard-selecting aircraft opens full details and hides them when the layer is disabled', () => {
    const elements = Object.fromEntries(['mapPaths', 'mapMarkers', 'mapAircraftDetails', 'mapDetailsHeading', 'mapDetailsModel', 'mapDetailsOrigin', 'mapDetailsPhoto', 'mapDetailsDestination', 'closeMapDetails', 'mapSection'].map(id => [id, {
        dataset: {}, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; }, querySelectorAll() { return []; }
    }]));
    const context = vm.createContext({ URL, document: { readyState: 'loading', addEventListener() {}, getElementById: id => elements[id] } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    context.fixture = aircraft('general', {
        aircraftDetails: { type: 'Airbus A320', url_photo_thumbnail: 'https://example.com/plane.jpg' },
        route: { origin: { name: 'London Heathrow Airport', iata_code: 'LHR' }, destination: { name: 'Geneva Cointrin International Airport', iata_code: 'GVA' } }
    });
    vm.runInContext('latestData = { generalTraffic: [fixture] }; mapLayers.general = true; initMapDetails();', context);
    const event = { target: { closest: () => ({ dataset: { aircraftId: 'general' } }) } };
    elements.mapMarkers.handlers.click(event);
    assert.equal(elements.mapAircraftDetails.hidden, false);
    assert.equal(elements.mapDetailsModel.textContent, 'Airbus A320');
    assert.match(elements.mapDetailsPhoto.innerHTML, /https:\/\/example.com\/plane.jpg/);
    assert.equal(elements.mapDetailsOrigin.textContent, 'London Heathrow Airport (LHR)');
    assert.equal(elements.mapDetailsDestination.textContent, 'Geneva Cointrin International Airport (GVA)');
    vm.runInContext('updateMap();', context);
    assert.equal(elements.mapAircraftDetails.hidden, false);
    assert.match(elements.mapMarkers.innerHTML, /aria-expanded="true"/);
    elements.mapDetailsPhoto.handlers.error({ target: { tagName: 'IMG' } });
    vm.runInContext('updateMap();', context);
    assert.match(elements.mapDetailsPhoto.innerHTML, /Photo unavailable/);
    elements.mapMarkers.handlers.click(event);
    assert.equal(elements.mapAircraftDetails.hidden, true);
    elements.mapMarkers.handlers.keydown({ ...event, key: 'Enter', preventDefault() {} });
    assert.equal(elements.mapAircraftDetails.hidden, false);
    elements.closeMapDetails.handlers.click();
    assert.equal(elements.mapAircraftDetails.hidden, true);
    elements.mapMarkers.handlers.click(event);
    vm.runInContext('fixture.route = null; fixture.aircraftDetails = null; updateMap();', context);
    assert.equal(elements.mapDetailsModel.textContent, 'Unknown model');
    assert.match(elements.mapDetailsPhoto.innerHTML, /Photo unavailable/);
    assert.equal(elements.mapDetailsOrigin.textContent, 'Unknown airport');
    vm.runInContext('mapLayers.general = false; updateMap();', context);
    assert.equal(elements.mapAircraftDetails.hidden, true);
});
