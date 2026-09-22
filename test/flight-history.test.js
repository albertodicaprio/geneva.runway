const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/app');

test('history renders retained details, Geneva times and unknown fields, newest first, and expires without a fetch', async () => {
    const elements = { flightHistory: {}, historyCount: {}, nextPlane: {}, arrivalCount: {}, aircraftList: {},
        lastUpdated: {}, dataStatus: {} };
    let now = Date.parse('2026-01-01T12:00:00Z');
    const timestamp = now / 1000;
    const fixture = {
        recentTracks: [
            { icao24: 'older', expiresAt: timestamp + 60 },
            {
                callsign: '<NEW>', disappearedAt: timestamp - 60, expiresAt: timestamp + 7140,
                aircraftDetails: { type: 'Airbus A320', registration: 'HB-TEST' },
                route: { airline: { name: 'Swiss & Partners' } },
                approachDirection: '22', heading: 219.5
            },
            { callsign: 'EXPIRED', expiresAt: timestamp }
        ]
    };
    const app = create({ document: { getElementById: id => elements[id] },
        fetch: async () => ({ ok: true, json: async () => fixture }), now: () => now,
        map: { update() {} } });
    await app.poll();
    const markup = elements.flightHistory.innerHTML;
    assert.equal(elements.historyCount.textContent, '2 flights');
    assert.ok(markup.indexOf('&lt;NEW&gt;') < markup.indexOf('older'));
    assert.match(markup, /Airbus A320/);
    assert.match(markup, /HB-TEST/);
    assert.match(markup, /<th scope="col">Airline<\/th>/);
    assert.match(markup, /Swiss &amp; Partners/);
    assert.match(markup, /12:59/);
    assert.match(markup, /Likely 22 · 220°/);
    assert.match(markup, /Unknown/);
    assert.match(markup, /<td>—<\/td>/);
    assert.doesNotMatch(markup, /EXPIRED|<NEW>/);
    now += 7140 * 1000;
    app.updateTimeSensitive();
    assert.equal(elements.historyCount.textContent, '0 flights');
    assert.match(elements.flightHistory.innerHTML, /No recent landings/);
});
