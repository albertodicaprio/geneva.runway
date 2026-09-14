const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('history renders retained details, Geneva times and unknown fields, newest first, and expires without a fetch', () => {
    const elements = { flightHistory: {}, historyCount: {} };
    let now = Date.parse('2026-01-01T12:00:00Z');
    const context = vm.createContext({
        Date: class extends Date { static now() { return now; } },
        document: { readyState: 'loading', addEventListener() {}, getElementById: id => elements[id] }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
    const timestamp = now / 1000;
    context.fixture = {
        recentTracks: [
            { icao24: 'older', expiresAt: timestamp + 60 },
            {
                callsign: '<NEW>', disappearedAt: timestamp - 60, expiresAt: timestamp + 7140,
                aircraftDetails: { type: 'Airbus A320', registration: 'HB-TEST' },
                approachDirection: '22', heading: 219.5
            },
            { callsign: 'EXPIRED', expiresAt: timestamp }
        ]
    };
    vm.runInContext('latestData = fixture; updateFlightHistory();', context);
    const markup = elements.flightHistory.innerHTML;
    assert.equal(elements.historyCount.textContent, '2 flights');
    assert.ok(markup.indexOf('&lt;NEW&gt;') < markup.indexOf('older'));
    assert.match(markup, /Airbus A320/);
    assert.match(markup, /HB-TEST/);
    assert.match(markup, /12:59/);
    assert.match(markup, /Likely 22 · 220°/);
    assert.match(markup, /Unknown/);
    assert.match(markup, /<td>—<\/td>/);
    assert.doesNotMatch(markup, /EXPIRED|<NEW>/);
    now += 7140 * 1000;
    vm.runInContext('updateFlightHistory();', context);
    assert.equal(elements.historyCount.textContent, '0 flights');
    assert.match(elements.flightHistory.innerHTML, /No recent landings/);
});
