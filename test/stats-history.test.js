const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFlightHistory, genevaDate } = require('../lib/flight-history');
const { summarizeFlights } = require('../lib/stats');
const GenevaStats = require('../public/stats');

test('daily history deduplicates refreshes, upgrades details, and keeps flights across Geneva midnight', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-history-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const history = createFlightHistory({ directory });
    const first = Date.parse('2026-09-22T21:59:30Z') / 1000;
    const aircraft = { icao24: 'ABC123', callsign: 'SWR123', country: 'Switzerland',
        latitude: 46.2, longitude: 6.1, onGround: false, track: { points: [{ latitude: 46.2 }] } };

    await history.recordSnapshot({ updatedAt: first, aircraft: [], generalTraffic: [aircraft] });
    await history.recordSnapshot({ updatedAt: first + 60, aircraft: [{ ...aircraft,
        route: { airline: { name: 'Swiss' }, origin: { iata_code: 'LHR', name: 'Heathrow' },
            destination: { iata_code: 'GVA', name: 'Geneva' } },
        aircraftDetails: { registration: 'HB-ABC', type: 'Airbus A320' }
    }], generalTraffic: [] });

    assert.equal(genevaDate(first * 1000), '2026-09-22');
    assert.equal(genevaDate((first + 60) * 1000), '2026-09-23');
    const saved = JSON.parse(await fs.readFile(path.join(directory, '2026-09-22.json'), 'utf8'));
    assert.equal(saved.flights.length, 1);
    assert.deepEqual(saved.flights[0], {
        icao24: 'abc123', callsign: 'SWR123', registration: 'HB-ABC', model: 'Airbus A320', aircraftType: null,
        airline: 'Swiss', origin: { iata: 'LHR', icao: null, name: 'Heathrow', country: null },
        destination: { iata: 'GVA', icao: null, name: 'Geneva', country: null },
        country: 'Switzerland', category: 'arrival', firstSeenAt: first, lastSeenAt: first + 60
    });
    assert.equal((await history.readDays(2, (first + 60) * 1000)).length, 1);
    assert.equal(saved.flights[0].track, undefined);
    assert.equal(saved.flights[0].latitude, undefined);

    const restarted = createFlightHistory({ directory });
    await restarted.recordSnapshot({ updatedAt: first + 70, aircraft: [aircraft], generalTraffic: [] });
    assert.equal((await restarted.readDays(2, (first + 70) * 1000)).length, 1);
    await restarted.recordSnapshot({ updatedAt: first + 70 + 3601, aircraft: [aircraft], generalTraffic: [] });
    assert.equal((await restarted.readDays(2, (first + 70 + 3601) * 1000)).length, 2);
});

test('landing and general stats have separate totals, rankings, and coverage', () => {
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'Swiss', origin: { iata: 'LHR' }, destination: { iata: 'GVA' }, model: 'A320' },
        { category: 'departure', airline: 'Swiss', origin: { iata: 'GVA' }, destination: { iata: 'LHR' }, model: 'A320' },
        { category: 'other', airline: null, origin: null, destination: null, model: null }
    ], 7);
    assert.equal(summary.landing.total, 1);
    assert.equal(summary.general.total, 2);
    assert.equal(summary.general.departures, 1);
    assert.equal(summary.general.other, 1);
    assert.deepEqual(summary.landing.airlines, { known: 1, items: [{ name: 'Swiss', count: 1 }] });
    assert.deepEqual(summary.general.airlines, { known: 1, items: [{ name: 'Swiss', count: 1 }] });
    assert.deepEqual(summary.landing.origins.items, [{ name: 'LHR', count: 1 }]);
    assert.deepEqual(summary.general.origins.items, [{ name: 'GVA', count: 1 }]);
    assert.equal(summary.general.models.known, 1);
});

test('Stats page renders independent landing and general charts', async () => {
    const elements = Object.fromEntries(['statsDays', 'landingSummary', 'landingCharts', 'generalSummary', 'generalCharts']
        .map(id => [id, { value: '7', innerHTML: '', addEventListener() {} }]));
    const document = { getElementById: id => elements[id] };
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'Landing Air' },
        { category: 'other', airline: 'Overflight Air' }
    ], 7);
    const app = GenevaStats.create({ document, fetch: async () => ({ ok: true, json: async () => summary }) });
    await app.load();
    assert.match(elements.landingCharts.innerHTML, /Landing Air/);
    assert.doesNotMatch(elements.landingCharts.innerHTML, /Overflight Air/);
    assert.match(elements.generalCharts.innerHTML, /Overflight Air/);
    assert.doesNotMatch(elements.generalCharts.innerHTML, /Landing Air/);
    assert.match(elements.landingSummary.innerHTML, /Flights seen/);
    assert.match(elements.generalSummary.innerHTML, /Other traffic/);
});
