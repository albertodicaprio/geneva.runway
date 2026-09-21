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
    assert.equal(result.generalTraffic[0].track.color, '#39ff14');
    assert.deepEqual(result.generalTraffic[0].track.points.map(p => p.timestamp), [400, 4000]);
    const restored = JSON.parse(JSON.stringify(result));
    const repeated = addGeneralTraffic({ aircraft: [arrival] }, data, restored);
    assert.equal(repeated.generalTraffic[0].track.points.length, 2);
    const projected = projectAircraftData(restored, 4030000);
    assert.ok(projected.generalTraffic[0].longitude > 6.2);
    assert.equal(restored.generalTraffic[0].longitude, 6.2);
    const promoted = addArrivalTracks({ updatedAt: 4030, aircraft: [aircraft('general')] }, restored);
    assert.deepEqual(promoted.aircraft[0].track.points.map(p => p.timestamp), [4000, 4030]);
    assert.notEqual(promoted.aircraft[0].track.color, '#39ff14');
});

test('map toggles hide paths and markers independently, persist choices and tolerate unavailable storage', () => {
    const elements = Object.fromEntries(['mapPaths', 'mapMarkers', 'showArrivals', 'showGeneralTraffic'].map(id => [id, {
        addEventListener(event, handler) { this.change = handler; }
    }]));
    let saved;
    const context = vm.createContext({
        document: { readyState: 'loading', addEventListener() {}, getElementById: id => elements[id] },
        localStorage: { getItem: () => saved || null, setItem: (key, value) => { saved = value; } }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    const track = { color: 'red', points: [{ latitude: 46.2, longitude: 6.1 }, { latitude: 46.3, longitude: 6.2 }] };
    context.fixture = { aircraft: [aircraft('ARRIVAL', { track })], generalTraffic: [aircraft('GENERAL', { track: { ...track, color: '#39ff14' } })], recentTracks: [{ track, expiresAt: Date.now() / 1000 + 500 }] };
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
