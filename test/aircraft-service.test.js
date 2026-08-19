const test = require('node:test');
const assert = require('node:assert/strict');
const {
    addArrivalTracks,
    classifyApproachDirection,
    distanceInKm,
    enrichGvaArrivals,
    normalizeOpenSkyData,
    projectAircraftData
} = require('../lib/aircraft-service');

test('keeps an arrival trail and color for up to one hour, then retains it for two hours after it disappears', () => {
    const previous = {
        aircraft: [{
            icao24: 'tracked',
            track: {
                color: 'hsl(20 65% 32%)',
                colorVersion: 2,
                points: [
                    { latitude: 46.1, longitude: 6.0, timestamp: 99 },
                    { latitude: 46.2, longitude: 6.1, timestamp: 100 }
                ]
            }
        }, {
            icao24: 'landed',
            track: { color: 'hsl(40 65% 32%)', colorVersion: 2, points: [{ latitude: 46.3, longitude: 6.2, timestamp: 100 }] }
        }]
    };

    const result = addArrivalTracks({
        updatedAt: 3_700,
        aircraft: [{ icao24: 'TRACKED', latitude: 46.4, longitude: 6.3 }]
    }, previous);

    assert.equal(result.aircraft.length, 1);
    assert.equal(result.aircraft[0].track.color, 'hsl(20 65% 32%)');
    assert.equal(result.aircraft[0].track.colorVersion, 2);
    assert.deepEqual(result.aircraft[0].track.points, [
        { latitude: 46.2, longitude: 6.1, timestamp: 100 },
        { latitude: 46.4, longitude: 6.3, timestamp: 3_700 }
    ]);
    assert.deepEqual(result.recentTracks, [{
        icao24: 'landed',
        track: { color: 'hsl(40 65% 32%)', colorVersion: 2, points: [{ latitude: 46.3, longitude: 6.2, timestamp: 100 }] },
        expiresAt: 10_900
    }]);
});

test('removes a disappeared arrival trail after its two-hour retention window', () => {
    const result = addArrivalTracks({ updatedAt: 10_901, aircraft: [] }, {
        recentTracks: [{
            icao24: 'landed',
            track: { color: 'hsl(40 65% 32%)', colorVersion: 2, points: [{ latitude: 46.3, longitude: 6.2, timestamp: 100 }] },
            expiresAt: 10_900
        }]
    });

    assert.deepEqual(result.recentTracks, []);
});

test('classifies approach direction from runway-aligned heading', () => {
    assert.equal(classifyApproachDirection(42).direction, '04');
    assert.equal(classifyApproachDirection(205).direction, '22');
});

test('classifies wrapped bearings and confidence at the runway tolerance boundaries', () => {
    assert.equal(classifyApproachDirection(358).direction, '04');
    assert.equal(classifyApproachDirection(56).confidence, 'medium');
    assert.equal(classifyApproachDirection(85).confidence, 'low');
    assert.equal(classifyApproachDirection(86).direction, 'unknown');
});

test('returns unknown rather than choosing a random runway for invalid or off-axis bearings', () => {
    assert.equal(classifyApproachDirection(null).direction, 'unknown');
    assert.equal(classifyApproachDirection(120).direction, 'unknown');
});

test('calculates distance from Geneva using aircraft coordinates', () => {
    assert.equal(distanceInKm(46.2381, 6.1093), 0);
    assert.ok(distanceInKm(46.7381, 6.1093) > 55);
    assert.ok(distanceInKm(46.7381, 6.1093) < 56);
});

test('projects aircraft position, altitude, and distance for up to one minute without changing cached data', () => {
    const cached = {
        updatedAt: 1_000,
        aircraft: [{
            callsign: 'TEST123', latitude: 46.2381, longitude: 6.1093,
            altitude: 1_000, velocity: 100, heading: 90, verticalRate: -2
        }]
    };

    const result = projectAircraftData(cached, 1_100_000);
    const aircraft = result.aircraft[0];

    assert.equal(aircraft.positionEstimated, true);
    assert.equal(aircraft.projectionSeconds, 60);
    assert.equal(aircraft.altitude, 880);
    assert.ok(aircraft.longitude > cached.aircraft[0].longitude);
    assert.ok(aircraft.distanceKm > 5.9 && aircraft.distanceKm < 6.1);
    assert.equal(cached.aircraft[0].altitude, 1_000);
    assert.equal(cached.aircraft[0].longitude, 6.1093);
    assert.deepEqual(result.positionEstimate, { isEstimated: true, estimatedAt: 1_100, maximumSecondsAhead: 60 });
});

test('normalization keeps valid OpenSky positions inside the configured search square, including its corners', () => {
    const diagnostics = {};
    const data = normalizeOpenSkyData({ time: 1, states: [
        ['near', ' NEAR ', 'Switzerland', null, 1, 6.1093, 46.2381, 1000, false, 100, 40, -1, null, 1000, null, false, 0, 4],
        ['corner', ' CORNER ', 'France', null, 1, 7.16, 46.97, 1000, false, 100, 40, -1, null, 1000, null, false, 0, 4],
        ['far', ' FAR ', 'France', null, 1, 8, 48, 1000, false, 100, 40, -1, null, 1000, null, false, 0, 4],
        ['invalid', ' INVALID ', 'France', null, 1, null, 46.2381, 1000, false, 100, 40, -1, null, 1000, null, false, 0, 4]
    ] }, diagnostics);
    assert.deepEqual(data.searchBounds, { lamin: 45.51, lomin: 5.06, lamax: 46.97, lomax: 7.16 });
    assert.deepEqual(data.aircraft.map(aircraft => aircraft.icao24), ['near', 'corner']);
    assert.equal(data.aircraft[0].callsign, 'NEAR');
    assert.deepEqual(diagnostics, {
        stateCount: 4,
        inBoundsAircraftCount: 2,
        outsideBoundsCount: 1,
        invalidPositionCount: 1
    });
});

test('enrichment retains only airborne, identified flights whose route ends at Geneva and sorts them by altitude', async () => {
    const originalFetch = global.fetch;
    const requestedUrls = [];
    global.fetch = async url => {
        requestedUrls.push(String(url));
        const response = body => ({ ok: true, status: 200, json: async () => body });
        if (String(url).includes('/callsign/ARRHIGH')) {
            return response({ response: { flightroute: { callsign: 'ARRHIGH', destination: { iata_code: 'GVA' } } } });
        }
        if (String(url).includes('/callsign/ARRLOW')) {
            return response({ response: { flightroute: { callsign: 'ARRLOW', destination: { iata_code: 'GVA' } } } });
        }
        if (String(url).includes('/callsign/NOTGVA')) {
            return response({ response: { flightroute: { callsign: 'NOTGVA', destination: { iata_code: 'LHR' } } } });
        }
        return response({ response: { aircraft: { registration: 'HB-TEST' } } });
    };

    try {
        const result = await enrichGvaArrivals({
            updatedAt: 1_700_000_000,
            aircraft: [
                { icao24: 'high01', callsign: 'ARRHIGH', altitude: 2000, onGround: false },
                { icao24: 'low001', callsign: 'ARRLOW', altitude: 900, onGround: false },
                { icao24: 'other1', callsign: 'NOTGVA', altitude: 500, onGround: false },
                { icao24: 'ground', callsign: 'GROUND', altitude: 10, onGround: true },
                { icao24: 'nocall', callsign: null, altitude: 10, onGround: false }
            ]
        });

        assert.deepEqual(result.aircraft.map(aircraft => aircraft.callsign), ['ARRLOW', 'ARRHIGH']);
        assert.deepEqual(result.aircraft.map(aircraft => aircraft.aircraftDetails.registration), ['HB-TEST', 'HB-TEST']);
        assert.equal(requestedUrls.some(url => url.includes('/callsign/GROUND')), false);
        assert.equal(requestedUrls.some(url => url.includes('/callsign/NOTGVA')), true);
        assert.equal(requestedUrls.filter(url => url.includes('/aircraft/')).length, 2);
    } finally {
        global.fetch = originalFetch;
    }
});
