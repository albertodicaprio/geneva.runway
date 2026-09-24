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

test('landing, general, and takeoff stats have separate totals, rankings, and coverage', () => {
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'Swiss', origin: { iata: 'LHR', name: 'Heathrow Airport' }, destination: { iata: 'GVA', name: 'Geneva Airport' }, registration: 'HB-ARR', model: 'A320' },
        { category: 'departure', airline: 'Swiss', origin: { iata: 'GVA', name: 'Geneva Airport' }, destination: { iata: 'LHR', name: 'Heathrow Airport' }, registration: 'HB-DEP', model: 'A320' },
        { category: 'other', airline: null, origin: null, destination: null, model: null }
    ], 7);
    assert.equal(summary.landing.total, 1);
    assert.equal(summary.general.total, 1);
    assert.equal(summary.takeoffs.total, 1);
    assert.deepEqual(summary.landing.airlines, { known: 1, items: [{ name: 'Swiss', count: 1 }] });
    assert.deepEqual(summary.general.airlines, { known: 0, items: [] });
    assert.deepEqual(summary.takeoffs.airlines, { known: 1, items: [{ name: 'Swiss', count: 1 }] });
    assert.deepEqual(summary.landing.origins.items, [{ name: 'Heathrow Airport', count: 1 }]);
    assert.deepEqual(summary.takeoffs.origins.items, [{ name: 'Geneva Airport', count: 1 }]);
    assert.deepEqual(summary.landing.registrations.items, [{ name: 'HB-ARR', count: 1 }]);
    assert.deepEqual(summary.takeoffs.registrations.items, [{ name: 'HB-DEP', count: 1 }]);
    assert.equal(summary.general.models.known, 0);
});

test('airport charts group by code and show full names when any flight provides one', () => {
    const summary = summarizeFlights([
        { category: 'arrival', origin: { iata: 'LHR' } },
        { category: 'arrival', origin: { iata: 'LHR', name: 'Heathrow Airport' } },
        { category: 'arrival', origin: { iata: 'CDG' } }
    ], 7);
    assert.deepEqual(summary.landing.origins, { known: 3, items: [
        { name: 'Heathrow Airport', count: 2 }, { name: 'CDG', count: 1 }
    ] });
});

test('airline charts group easyJet variants under easyjet', () => {
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'easyJet' },
        { category: 'arrival', airline: 'easyJet Europe' },
        { category: 'arrival', airline: 'easyJet Switzerland' },
        { category: 'arrival', airline: 'Other Airline' }
    ], 7);
    assert.deepEqual(summary.landing.airlines, { known: 4, items: [
        { name: 'easyjet', count: 3 }, { name: 'Other Airline', count: 1 }
    ] });
});

test('stats return every ranked value so each card can expand past the top eight', () => {
    const flights = Array.from({ length: 10 }, (_, index) => ({ category: 'arrival', airline: `Airline ${index}` }));
    const summary = summarizeFlights(flights, 7);
    assert.equal(summary.landing.airlines.items.length, 10);
    assert.deepEqual(summary.landing.airlines.items.at(-1), { name: 'Airline 9', count: 1 });
});

test('Stats page switches among independent landing, general, and takeoff charts', async () => {
    const elements = Object.fromEntries(['statsDays', 'landingSummary', 'landingCharts', 'generalSummary', 'generalCharts',
        'takeoffsSummary', 'takeoffsCharts', 'landingStats', 'generalStats', 'takeoffsStats']
        .map(id => [id, { value: '7', innerHTML: '', addEventListener() {} }]));
    const buttons = Object.fromEntries(['landing', 'general', 'takeoffs'].map(name => [name, {
        dataset: { statsView: name }, setAttribute(_name, value) { this.pressed = value; },
        addEventListener(_event, callback) { this.click = callback; }
    }]));
    const document = { getElementById: id => elements[id], addEventListener(_event, callback) { this.onChange = callback; },
        querySelector: selector => buttons[selector.match(/data-stats-view="(.*?)"/)[1]],
        querySelectorAll: () => Object.values(buttons) };
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'Landing Air', registration: 'HB-LND', origin: { iata: 'LHR', name: 'Heathrow Airport' }, destination: { iata: 'GVA' } },
        { category: 'other', airline: 'Overflight Air' },
        { category: 'departure', airline: 'Takeoff Air', registration: 'HB-DEP', origin: { iata: 'GVA' }, destination: { iata: 'CDG', name: 'Paris Charles de Gaulle Airport' } }
    ], 7);
    const app = GenevaStats.create({ document, fetch: async () => ({ ok: true, json: async () => summary }) });
    await app.load();
    assert.match(elements.landingCharts.innerHTML, /Landing Air/);
    assert.doesNotMatch(elements.landingCharts.innerHTML, /Overflight Air/);
    assert.match(elements.generalCharts.innerHTML, /Overflight Air/);
    assert.doesNotMatch(elements.generalCharts.innerHTML, /Landing Air/);
    assert.doesNotMatch(elements.generalCharts.innerHTML, /Takeoff Air/);
    assert.match(elements.takeoffsCharts.innerHTML, /Takeoff Air/);
    assert.doesNotMatch(elements.takeoffsCharts.innerHTML, /Overflight Air/);
    assert.match(elements.landingCharts.innerHTML, /Registrations/);
    assert.match(elements.landingCharts.innerHTML, /HB-LND/);
    assert.match(elements.landingCharts.innerHTML, /Heathrow Airport/);
    assert.doesNotMatch(elements.landingCharts.innerHTML, /Destination airports/);
    assert.match(elements.takeoffsCharts.innerHTML, /Registrations/);
    assert.match(elements.takeoffsCharts.innerHTML, /HB-DEP/);
    assert.match(elements.takeoffsCharts.innerHTML, /Paris Charles de Gaulle Airport/);
    assert.doesNotMatch(elements.takeoffsCharts.innerHTML, /Origin airports/);
    assert.match(elements.generalCharts.innerHTML, /Origin airports/);
    assert.match(elements.generalCharts.innerHTML, /Destination airports/);
    assert.match(elements.landingSummary.innerHTML, /Flights seen/);
    app.start();
    buttons.takeoffs.click();
    assert.equal(elements.landingStats.hidden, true);
    assert.equal(elements.generalStats.hidden, true);
    assert.equal(elements.takeoffsStats.hidden, false);
    assert.equal(buttons.takeoffs.pressed, 'true');
    assert.equal(buttons.landing.pressed, 'false');
});

test('each chart checkbox reveals and hides only its extra rows', async () => {
    const elements = Object.fromEntries(['statsDays', 'landingSummary', 'landingCharts', 'generalSummary', 'generalCharts',
        'takeoffsSummary', 'takeoffsCharts'].map(id => [id, { value: '7', innerHTML: '' }]));
    const document = { getElementById: id => elements[id], addEventListener(_event, callback) { this.onChange = callback; },
        querySelectorAll: () => [] };
    const flights = Array.from({ length: 10 }, (_, index) => ({ category: 'arrival', airline: `Airline ${index}` }));
    const app = GenevaStats.create({ document, fetch: async () => ({ ok: true, json: async () => summarizeFlights(flights, 7) }) });
    await app.load();
    assert.match(elements.landingCharts.innerHTML, /Show all 10 airlines/);
    assert.equal((elements.landingCharts.innerHTML.match(/data-extra hidden/g) || []).length, 2);
    const rows = [{ hidden: true }, { hidden: true }];
    const checkbox = { checked: true, matches: () => true, closest: () => ({ querySelectorAll: () => rows }) };
    // Exercise the delegated listener registered when the page starts.
    elements.statsDays.addEventListener = () => {};
    app.start();
    document.onChange({ target: checkbox });
    assert.deepEqual(rows.map(row => row.hidden), [false, false]);
    checkbox.checked = false;
    document.onChange({ target: checkbox });
    assert.deepEqual(rows.map(row => row.hidden), [true, true]);
});
