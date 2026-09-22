const test = require('node:test');
const assert = require('node:assert/strict');
const { addGeneralTraffic, addArrivalTracks, projectAircraftData } = require('../lib/traffic');
const { createAdsbdb } = require('../lib/adsbdb');

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

test('general routes are cached for overflights and tolerate missing identities and unknown routes', async () => {
    const requested = [];
    const fetchMock = async url => {
        requested.push(String(url));
        if (String(url).includes('/aircraft/')) return { ok: true, status: 200, json: async () => ({ response: { aircraft: { type: 'Airbus A320' } } }) };
        const found = String(url).endsWith('/callsign/OVERFLIGHT');
        return { ok: found, status: found ? 200 : 404, json: async () => found
            ? { response: { flightroute: { origin: { iata_code: 'LHR' }, destination: { iata_code: 'GVA' } } } }
            : {} };
    };
    const data = { updatedAt: 4000, aircraft: [], generalTraffic: [
        aircraft('over01', { callsign: 'OVERFLIGHT' }), aircraft('noid'), aircraft('unknown', { callsign: 'NO_ROUTE' })
    ] };
    const adsbdb = createAdsbdb({ fetch: fetchMock });
    const result = await adsbdb.enrichGeneralTraffic(data);
    assert.equal(result.generalTraffic[0].route.origin.iata_code, 'LHR');
    assert.equal(result.generalTraffic[0].route.destination.iata_code, 'GVA');
    assert.equal(result.generalTraffic[1].route, null);
    assert.equal(result.generalTraffic[2].route, null);
    assert.deepEqual(result.aircraft, []);
    await adsbdb.enrichGeneralTraffic(data);
    assert.equal(requested.filter(url => url.includes('/callsign/')).length, 2);
    assert.equal(requested.filter(url => url.includes('/aircraft/')).length, 3);
    assert.equal(result.generalTraffic[0].aircraftDetails.type, 'Airbus A320');

});
