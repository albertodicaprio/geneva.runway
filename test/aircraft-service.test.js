const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyApproachDirection, normalizeOpenSkyData } = require('../lib/aircraft-service');

test('classifies approach direction from runway-aligned heading', () => {
    assert.deepEqual(classifyApproachDirection(42).direction, '04');
    assert.deepEqual(classifyApproachDirection(205).direction, '22');
});

test('returns unknown rather than choosing a random runway', () => {
    assert.equal(classifyApproachDirection(null).direction, 'unknown');
    assert.equal(classifyApproachDirection(120).direction, 'unknown');
});

test('keeps only OpenSky positions within 80 km of Geneva', () => {
    const data = normalizeOpenSkyData({ time: 1, states: [
        ['near', ' NEAR ', 'Switzerland', null, 1, 6.1093, 46.2381, 1000, false, 100, 40, -1, null, 1000, null, false, 0, 4],
        ['far', ' FAR ', 'France', null, 1, 8, 48, 1000, false, 100, 40, -1, null, 1000, null, false, 0, 4]
    ] });
    assert.equal(data.maxDistanceKm, 80);
    assert.deepEqual(data.aircraft.map(aircraft => aircraft.icao24), ['near']);
});
