const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFlightHistory, genevaDate } = require('../lib/flight-history');
const { summarizeFlights } = require('../lib/stats');
const GenevaStats = require('../public/stats');

function statsDocument() {
    const ids = ['statsOverview', 'statsCalendar', 'statsCalendarMonth', 'statsPreviousMonth', 'statsNextMonth', 'statsRangeLabel',
        'landingSummary', 'landingCharts', 'generalSummary', 'generalCharts', 'takeoffsSummary', 'takeoffsCharts',
        'landingStats', 'generalStats', 'takeoffsStats', 'hourlyStats', 'hourlyChart', 'showHourlyLandings', 'showHourlyTakeoffs'];
    const elements = Object.fromEntries(ids.map(id => [id, {
        innerHTML: '', textContent: '', disabled: false, checked: true,
        addEventListener(event, callback) { this[`on${event}`] = callback; }
    }]));
    const buttons = Object.fromEntries(['landing', 'general', 'takeoffs', 'hourly'].map(name => [name, {
        dataset: { statsView: name }, setAttribute(_name, value) { this.pressed = value; },
        addEventListener(_event, callback) { this.click = callback; }
    }]));
    const document = { getElementById: id => elements[id], addEventListener(event, callback) { this[`on${event}`] = callback; },
        querySelector: selector => buttons[selector.match(/data-stats-view="(.*?)"/)[1]],
        querySelectorAll: () => Object.values(buttons) };
    return { elements, buttons, document };
}

function statsFetch(summary, requested = []) {
    return async url => {
        requested.push(url);
        return { ok: true, json: async () => url.includes('available=1')
            ? { today: '2026-09-28', dates: ['2026-09-25', '2026-09-27'] } : summary };
    };
}

test('other traffic ranks directional routes and filters registrations', async () => {
    const flight = (origin, destination, registration = 'HB-OTHER') => ({
        category: 'other', registration, origin, destination
    });
    const flights = [
        flight({ iata: 'lhr' }, { iata: 'cdg' }),
        flight({ iata: 'LHR' }, { iata: 'CDG' }),
        flight({ iata: 'CDG' }, { iata: 'LHR' }, 'HB-REVERSE'),
        flight({ icao: 'LSZH' }, { name: 'Small airport' }),
        flight({ iata: 'LHR' }, null),
        { category: 'arrival', origin: { iata: 'LHR' }, destination: { iata: 'CDG' } }
    ];
    const summary = summarizeFlights(flights, 2);
    assert.deepEqual(summary.general.routes, { known: 4, items: [
        { name: 'LHR → CDG', count: 2 },
        { name: 'CDG → LHR', count: 1 },
        { name: 'LSZH → Small airport', count: 1 }
    ] });
    const filtered = summarizeFlights(flights, 2, { general: 'hb-reverse' });
    assert.equal(filtered.general.total, 1);
    assert.deepEqual(filtered.general.routes.items, [{ name: 'CDG → LHR', count: 1 }]);
    const { elements, document } = statsDocument();
    const many = Array.from({ length: 10 }, (_, index) => flight({ iata: `AAA${index}` }, { iata: 'CDG' }));
    const app = GenevaStats.create({ document, fetch: statsFetch(summarizeFlights(many, 2)) });
    await app.start();
    await app.load();
    assert.match(elements.generalCharts.innerHTML, /<h2>Registrations<\/h2>/);
    assert.match(elements.generalCharts.innerHTML, /HB-OTHER/);
    const routes = elements.generalCharts.innerHTML.split('<h2>Busiest routes</h2>')[1].split('</section>')[0];
    assert.equal((routes.match(/<li/g) || []).length, 10);
    assert.equal((routes.match(/data-extra hidden/g) || []).length, 2);
    assert.match(routes, /Show all 10 busiest routes/);
    assert.match(elements.generalSummary.innerHTML, /airport, registration, or aircraft model/);
    assert.deepEqual(summarizeFlights([], 1).general.routes, { known: 0, items: [] });
});

test('text filters select flights across chart fields and recalculate all rankings', () => {
    const flights = [
        { category: 'arrival', airline: 'Swiss', aircraftType: 'A320', model: 'Airbus', registration: 'HB-ONE', origin: { iata: 'LHR', name: 'London Heathrow' } },
        { category: 'arrival', airline: 'Swiss', aircraftType: 'A320', registration: 'HB-TWO', origin: { iata: 'CDG', name: 'Paris' } },
        { category: 'arrival', airline: 'easyJet Europe', model: 'Airbus A320', registration: 'HB-THREE', origin: { iata: 'LHR', name: 'London Heathrow' } },
        { category: 'arrival', airline: 'Swiss', aircraftType: 'B738', origin: { iata: 'CDG', name: 'Paris' } },
        { category: 'arrival' },
        { category: 'departure', airline: 'Swiss', aircraftType: 'B738', destination: { name: 'London Heathrow' } },
        { category: 'other', airline: 'Other', aircraftType: 'A320', destination: { name: 'London Heathrow' } }
    ];
    const filtered = summarizeFlights(flights, 2, { landing: ' a320 ', general: 'london', takeoffs: 'LONDON' });
    assert.equal(filtered.landing.total, 3);
    assert.deepEqual(filtered.landing.airlines.items, [{ name: 'Swiss', count: 2 }, { name: 'easyJet', count: 1 }]);
    assert.deepEqual(filtered.landing.origins.items, [{ name: 'London Heathrow', count: 2 }, { name: 'Paris', count: 1 }]);
    assert.equal(filtered.landing.registrations.known, 3);
    assert.equal(filtered.general.total, 1);
    assert.equal(filtered.takeoffs.total, 1);
    assert.deepEqual(filtered.hourly, summarizeFlights(flights, 2).hourly);
    for (const query of ['HB-ONE', 'lhr', 'London', 'Airbus']) {
        const result = summarizeFlights(flights, 2, { landing: query });
        assert.ok(result.landing.total > 0, query);
        assert.equal(result.takeoffs.total, 1);
    }
    assert.equal(summarizeFlights(flights, 2, { landing: 'swiss' }).landing.total, 3);
    assert.equal(summarizeFlights(flights, 2, { landing: 'missing' }).landing.total, 0);
    assert.equal(summarizeFlights(flights, 2, { landing: '   ' }).landing.total, 5);
});

test('period overview counts distinct identities and airports across all traffic, independently of filters', () => {
    const flights = [
        { category: 'arrival', icao24: 'ABC123', airline: 'easyJet Europe', origin: { iata: 'LHR', icao: 'EGLL', name: 'London Heathrow' }, destination: { iata: 'GVA' } },
        { category: 'departure', icao24: 'abc123', airline: 'easyJet Switzerland', origin: { icao: 'LSGG' }, destination: { iata: 'lhr' } },
        { category: 'other', icao24: 'DEF456', airline: 'Swiss', origin: { name: 'London Heathrow' }, destination: { iata: 'CDG', icao: 'LFPG', name: 'Paris' } },
        { icao24: 'def456', airline: 'SWISS', origin: { name: 'Geneva Airport' }, destination: { icao: 'LFPG' } },
        { category: 'other' }
    ];
    const expected = { total: 5, aircraft: 2, airlines: 2, airports: 2, landings: 1, takeoffs: 1, general: 3 };
    assert.deepEqual(summarizeFlights(flights, 7).overview, expected);
    const filtered = summarizeFlights(flights, 7, { landing: 'missing', general: 'missing', takeoffs: 'missing' });
    assert.deepEqual(filtered.overview, expected);
    assert.equal(filtered.landing.total + filtered.general.total + filtered.takeoffs.total, 0);
    assert.deepEqual(summarizeFlights([], 1).overview,
        { total: 0, aircraft: 0, airlines: 0, airports: 0, landings: 0, takeoffs: 0, general: 0 });
});

test('period overview renders selected dates, stays independent of filters and clears failed totals', async () => {
    const { elements, document } = statsDocument();
    let fail = false;
    const app = GenevaStats.create({ document, logger: { error() {} }, fetch: async url => {
        if (fail) throw new Error('offline');
        const params = new URL(url, 'http://localhost').searchParams;
        return { ok: true, json: async () => params.has('available')
            ? { today: '2026-09-28', dates: ['2026-09-25', '2026-09-27'] }
            : summarizeFlights(Array.from({ length: params.get('from') === '2026-09-25' ? 3 : 1 },
                () => ({ category: 'arrival', icao24: 'ABC123', airline: 'Swiss' })), 1,
            { landing: params.get('landingFilter') }) };
    } });
    await app.start();
    await app.load();
    assert.match(elements.statsOverview.innerHTML, /<strong>1<\/strong><span>Flights seen/);
    elements.statsCalendar.onclick({ target: { closest: () => ({ dataset: { statsDate: '2026-09-25' } }) } });
    await app.load();
    assert.match(elements.statsOverview.innerHTML, /<strong>3<\/strong><span>Flights seen/);
    assert.match(elements.statsOverview.innerHTML, /<strong>1<\/strong><span>Distinct aircraft/);
    assert.match(elements.statsOverview.innerHTML, /3 landings · 0 other traffic · 0 takeoffs/);
    const overview = elements.statsOverview.innerHTML;
    document.oninput({ target: { dataset: { statsFilter: 'landing' }, value: 'missing' } });
    await app.load();
    assert.equal(elements.statsOverview.innerHTML, overview);
    assert.match(elements.landingSummary.innerHTML, /<strong[^>]*>0<\/strong>/);
    fail = true;
    await app.load();
    assert.match(elements.statsOverview.innerHTML, /Unable to load period totals/);
    assert.doesNotMatch(elements.statsOverview.innerHTML, /<strong>3/);
});

test('typing filters automatically refreshes all charts, preserves inputs and clears independently', async () => {
    const { elements, document } = statsDocument();
    const flights = [
        { category: 'arrival', airline: 'Swiss', aircraftType: 'A320', registration: 'HB-ONE' },
        { category: 'arrival', airline: 'Other', aircraftType: 'B738' },
        { category: 'departure', airline: 'Other', destination: { name: 'London' } }
    ];
    let timer;
    const requested = [];
    const app = GenevaStats.create({ document,
        setTimeout(callback) { timer = callback; return 1; }, clearTimeout() { timer = null; },
        fetch: async url => {
            requested.push(url);
            const params = new URL(url, 'http://localhost').searchParams;
            return { ok: true, json: async () => params.has('available')
                ? { today: '2026-09-28', dates: ['2026-09-27'] }
                : summarizeFlights(flights, 1, Object.fromEntries(['landing', 'general', 'takeoffs']
                    .map(view => [view, params.get(`${view}Filter`)]))) };
        }
    });
    await app.start();
    await app.load();
    assert.match(elements.landingSummary.innerHTML, /data-stats-filter="landing"/);
    const input = { dataset: { statsFilter: 'landing' }, value: 'A320' };
    const total = { textContent: '' };
    const summaryHtml = elements.landingSummary.innerHTML;
    elements.landingSummary.querySelector = selector => selector === '[data-stats-filter]' ? input : total;
    const typeChoice = {};
    elements.landingCharts.querySelector = () => typeChoice;
    document.oninput({ target: input });
    await timer();
    assert.equal(total.textContent, 1);
    assert.equal(elements.landingSummary.innerHTML, summaryHtml);
    assert.match(elements.landingCharts.innerHTML, /Swiss/);
    assert.doesNotMatch(elements.landingCharts.innerHTML, /Other/);
    assert.match(elements.landingCharts.innerHTML, /data-model-choice="type" aria-pressed="true"/);
    document.oninput({ target: { dataset: { statsFilter: 'takeoffs' }, value: 'London & <' } });
    await timer();
    assert.match(requested.at(-1), /landingFilter=A320&takeoffsFilter=London\+%26\+%3C/);
    assert.match(elements.takeoffsSummary.innerHTML, /value="London &amp; &lt;"/);
    input.value = '';
    document.oninput({ target: input });
    await timer();
    assert.equal(total.textContent, 2);
    assert.doesNotMatch(requested.at(-1), /landingFilter/);
    assert.match(requested.at(-1), /takeoffsFilter=/);
});

test('a response for an older query cannot overwrite charts while a new filter is pending', async () => {
    const { elements, document } = statsDocument();
    let resolve;
    let defer = false;
    const normalFetch = statsFetch(summarizeFlights([{ category: 'arrival', airline: 'Current' }], 1));
    const app = GenevaStats.create({ document, setTimeout() { return 1; }, clearTimeout() {},
        fetch: url => defer ? new Promise(done => { resolve = done; }) : normalFetch(url) });
    await app.start();
    await app.load();
    defer = true;
    const pending = app.load();
    document.oninput({ target: { dataset: { statsFilter: 'landing' }, value: 'New' } });
    resolve({ ok: true, json: async () => summarizeFlights([{ category: 'arrival', airline: 'Stale' }], 1) });
    await pending;
    assert.match(elements.landingCharts.innerHTML, /Current/);
    assert.doesNotMatch(elements.landingCharts.innerHTML, /Stale/);
});

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
    assert.equal((await history.readDays(1, (first + 60) * 1000)).length, 0);
    assert.equal((await history.readDays(1, (first + 60) * 1000, 1)).length, 1);
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

test('airline charts group easyJet variants under easyJet', () => {
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'easyJet' },
        { category: 'arrival', airline: 'easyJet Europe' },
        { category: 'arrival', airline: 'easyJet Switzerland' },
        { category: 'arrival', airline: 'Other Airline' }
    ], 7);
    assert.deepEqual(summary.landing.airlines, { known: 4, items: [
        { name: 'easyJet', count: 3 }, { name: 'Other Airline', count: 1 }
    ] });
});

test('aircraft models rank descriptive and ICAO types separately', () => {
    const summary = summarizeFlights([
        { category: 'arrival', model: 'Airbus A320', aircraftType: 'A320' },
        { category: 'arrival', model: 'Airbus A320', aircraftType: 'A320' },
        { category: 'arrival', model: null, aircraftType: 'B738' },
        { category: 'arrival', model: 'Boeing 737-800', aircraftType: null }
    ], 7);
    assert.deepEqual(summary.landing.models, { known: 3, items: [
        { name: 'Airbus A320', count: 2 }, { name: 'Boeing 737-800', count: 1 }
    ] });
    assert.deepEqual(summary.landing.icaoTypes, { known: 3, items: [
        { name: 'A320', count: 2, examples: ['Airbus A320'], moreExamples: false },
        { name: 'B738', count: 1, examples: [], moreExamples: false }
    ] });
});

test('ICAO types show at most three common recorded models', () => {
    const summary = summarizeFlights([
        { category: 'arrival', aircraftType: 'A320', model: 'A320 214SL' },
        { category: 'arrival', aircraftType: 'A320', model: 'A320 214' },
        { category: 'arrival', aircraftType: 'A320', model: 'A320 214SL' },
        { category: 'arrival', aircraftType: 'A320', model: 'A320 232' },
        { category: 'arrival', aircraftType: 'A320', model: 'A320 216' },
        { category: 'arrival', aircraftType: 'A320', model: null }
    ], 7);
    assert.deepEqual(summary.landing.icaoTypes, { known: 6, items: [
        { name: 'A320', count: 6, examples: ['A320 214SL', 'A320 214', 'A320 216'], moreExamples: true }
    ] });
});

test('stats return every ranked value so each card can expand past the top eight', () => {
    const flights = Array.from({ length: 10 }, (_, index) => ({ category: 'arrival', airline: `Airline ${index}` }));
    const summary = summarizeFlights(flights, 7);
    assert.equal(summary.landing.airlines.items.length, 10);
    assert.deepEqual(summary.landing.airlines.items.at(-1), { name: 'Airline 9', count: 1 });
});

test('Stats page switches among independent landing, general, and takeoff charts', async () => {
    const { elements, buttons, document } = statsDocument();
    const summary = summarizeFlights([
        { category: 'arrival', airline: 'Landing Air', registration: 'HB-LND', origin: { iata: 'LHR', name: 'Heathrow Airport' }, destination: { iata: 'GVA' } },
        { category: 'other', airline: 'Overflight Air' },
        { category: 'departure', airline: 'Takeoff Air', registration: 'HB-DEP', origin: { iata: 'GVA' }, destination: { iata: 'CDG', name: 'Paris Charles de Gaulle Airport' } }
    ], 7);
    const app = GenevaStats.create({ document, fetch: statsFetch(summary) });
    await app.start();
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
    buttons.takeoffs.click();
    assert.equal(elements.landingStats.hidden, true);
    assert.equal(elements.generalStats.hidden, true);
    assert.equal(elements.takeoffsStats.hidden, false);
    assert.equal(buttons.takeoffs.pressed, 'true');
    assert.equal(buttons.landing.pressed, 'false');
});

test('Stats calendar selects recorded days and inclusive ranges while disabling gaps and future days', async () => {
    const { elements, document } = statsDocument();
    const requested = [];
    const app = GenevaStats.create({ document, fetch: statsFetch(summarizeFlights([], 1), requested) });
    await app.start();
    await app.load();
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2026-09-26"[^>]*disabled/);
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2026-09-29"[^>]*disabled/);
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2026-09-27"[^>]*aria-pressed="true"/);
    elements.statsCalendar.onclick({ target: { closest: () => ({ dataset: { statsDate: '2026-09-25' }, disabled: false }) } });
    await app.load();
    elements.statsCalendar.onclick({ target: { closest: () => ({ dataset: { statsDate: '2026-09-27' }, disabled: false }) } });
    await app.load();
    assert.deepEqual(requested.filter(url => url.includes('from=')), [
        '/api/stats?from=2026-09-27&to=2026-09-27',
        '/api/stats?from=2026-09-27&to=2026-09-27',
        '/api/stats?from=2026-09-25&to=2026-09-25',
        '/api/stats?from=2026-09-25&to=2026-09-25',
        '/api/stats?from=2026-09-25&to=2026-09-27',
        '/api/stats?from=2026-09-25&to=2026-09-27'
    ]);
    assert.match(elements.statsRangeLabel.textContent, /25 Sept 2026 – 27 Sept 2026/);
});

test('two calendar panes select ranges across a year boundary and navigate together without fetching', async () => {
    const { elements, document } = statsDocument();
    const requested = [];
    const app = GenevaStats.create({ document, fetch: async url => {
        requested.push(url);
        return { ok: true, json: async () => url.includes('available=1')
            ? { today: '2027-01-05', dates: ['2026-11-15', '2026-12-30', '2027-01-01', '2027-01-05'] }
            : summarizeFlights([], 1) };
    } });
    await app.start();
    const choose = date => elements.statsCalendar.onclick({ target: {
        closest: () => ({ dataset: { statsDate: date }, disabled: false })
    } });
    assert.equal(elements.statsCalendarMonth.textContent, 'December 2026 – January 2027');
    assert.equal((elements.statsCalendar.innerHTML.match(/class="stats-calendar-pane"/g) || []).length, 2);
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2027-01-06"[^>]*disabled/);
    assert.equal(elements.statsNextMonth.disabled, true);
    choose('2026-12-30');
    assert.match(elements.statsRangeLabel.textContent, /Choose an end day/);
    choose('2027-01-01');
    assert.equal(requested.at(-1), '/api/stats?from=2026-12-30&to=2027-01-01');
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2026-12-30"[^>]*data-range="start"/);
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2026-12-31"[^>]*disabled[^>]*data-range="middle"/);
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2027-01-01"[^>]*data-range="end"/);
    choose('2027-01-01');
    choose('2026-12-30');
    assert.equal(requested.at(-1), '/api/stats?from=2026-12-30&to=2027-01-01');
    const beforeNavigation = requested.length;
    elements.statsPreviousMonth.onclick();
    assert.equal(elements.statsCalendarMonth.textContent, 'November 2026 – December 2026');
    assert.equal(elements.statsPreviousMonth.disabled, true);
    assert.equal(elements.statsNextMonth.disabled, false);
    assert.match(elements.statsCalendar.innerHTML, /data-stats-date="2026-12-30"[^>]*data-range="start"/);
    elements.statsNextMonth.onclick();
    assert.equal(elements.statsCalendarMonth.textContent, 'December 2026 – January 2027');
    assert.equal(requested.length, beforeNavigation);
    choose('2027-01-01');
    choose('2027-01-01');
    assert.equal(requested.at(-1), '/api/stats?from=2027-01-01&to=2027-01-01');
    choose('2027-01-05');
    choose('2027-01-01');
    assert.equal(requested.at(-1), '/api/stats?from=2027-01-01&to=2027-01-05');
    choose('2026-12-30');
    choose('2026-12-30');
    assert.equal(requested.at(-1), '/api/stats?from=2026-12-30&to=2026-12-30');
});

test('Stats calendar explains an empty archive without leaving loading indicators', async () => {
    const { elements, document } = statsDocument();
    const app = GenevaStats.create({ document, fetch: async () => ({ ok: true,
        json: async () => ({ today: '2026-09-28', dates: [] }) }) });
    await app.start();
    assert.equal(elements.statsRangeLabel.textContent, 'No recorded flight days yet.');
    assert.match(elements.statsOverview.innerHTML, /No recorded flights yet/);
    assert.match(elements.landingSummary.innerHTML, /No recorded flights yet/);
    assert.equal(elements.statsPreviousMonth.disabled, true);
    assert.equal(elements.statsNextMonth.disabled, true);
});

test('each chart checkbox reveals and hides only its extra rows', async () => {
    const { elements, document } = statsDocument();
    const flights = Array.from({ length: 10 }, (_, index) => ({ category: 'arrival', airline: `Airline ${index}` }));
    const app = GenevaStats.create({ document, fetch: statsFetch(summarizeFlights(flights, 7)) });
    await app.start();
    await app.load();
    assert.match(elements.landingCharts.innerHTML, /Show all 10 airlines/);
    assert.equal((elements.landingCharts.innerHTML.match(/data-extra hidden/g) || []).length, 2);
    const rows = [{ hidden: true }, { hidden: true }];
    const checkbox = { checked: true, matches: () => true, closest: () => ({ querySelectorAll: () => rows }) };
    // Exercise the delegated listener registered when the page starts.
    document.onchange({ target: checkbox });
    assert.deepEqual(rows.map(row => row.hidden), [false, false]);
    checkbox.checked = false;
    document.onchange({ target: checkbox });
    assert.deepEqual(rows.map(row => row.hidden), [true, true]);
});

test('each aircraft models card defaults to Group and toggles to Detail', async () => {
    const { elements, document } = statsDocument();
    const summary = summarizeFlights([{ category: 'arrival', model: 'Airbus A320', aircraftType: 'A320' }], 7);
    const app = GenevaStats.create({ document, fetch: statsFetch(summary) });
    await app.start();
    await app.load();
    assert.match(elements.landingCharts.innerHTML, /<div class="model-chart-header"><h2>Aircraft models<\/h2>[\s\S]*data-model-choice="icao" aria-pressed="true">Group<\/button>[\s\S]*data-model-choice="type" aria-pressed="false">Detail<\/button>/);
    assert.match(elements.landingCharts.innerHTML, /data-model-mode="icao">[\s\S]*A320 \(Airbus A320\)/);
    assert.match(elements.landingCharts.innerHTML, /data-model-mode="type" hidden>[\s\S]*Airbus A320/);

    const panels = [{ dataset: { modelMode: 'icao' }, hidden: false }, { dataset: { modelMode: 'type' }, hidden: true }];
    const card = { querySelectorAll: selector => selector === '[data-model-mode]' ? panels : buttons };
    const buttons = ['icao', 'type'].map(modelChoice => ({
        dataset: { modelChoice }, closest: () => card,
        setAttribute(_name, value) { this.pressed = value; }
    }));
    document.onclick({ target: { closest: () => buttons[1] } });
    assert.deepEqual(panels.map(panel => panel.hidden), [true, false]);
    assert.deepEqual(buttons.map(button => button.pressed), ['false', 'true']);
    document.onclick({ target: { closest: () => buttons[0] } });
    assert.deepEqual(panels.map(panel => panel.hidden), [false, true]);
});

test('hourly counts use Geneva first sightings, sum days and respect daylight saving time', () => {
    const flight = (category, date) => ({ category, firstSeenAt: Date.parse(date) / 1000 });
    const summary = summarizeFlights([
        flight('arrival', '2026-09-27T21:59:00Z'),
        flight('arrival', '2026-09-28T21:20:00Z'),
        flight('departure', '2026-09-27T22:01:00Z'),
        flight('other', '2026-09-27T21:30:00Z'),
        { category: 'arrival' },
        flight('arrival', '2026-01-12T22:00:00Z'),
        flight('departure', '2026-10-25T00:30:00Z'),
        flight('departure', '2026-10-25T01:30:00Z')
    ], 30);
    assert.equal(summary.hourly.length, 24);
    assert.deepEqual(summary.hourly[23], { hour: 23, landings: 3, takeoffs: 0 });
    assert.deepEqual(summary.hourly[0], { hour: 0, landings: 0, takeoffs: 1 });
    assert.deepEqual(summary.hourly[2], { hour: 2, landings: 0, takeoffs: 2 });
    assert.deepEqual(summary.hourly[1], { hour: 1, landings: 0, takeoffs: 0 });
});

test('hourly text filtering matches the same flight fields as landing and takeoff stats', () => {
    const firstSeenAt = Date.parse('2026-09-27T08:00:00Z') / 1000;
    const flights = [
        { category: 'arrival', firstSeenAt, airline: 'Swiss', registration: 'HB-ONE', model: 'Airbus', aircraftType: 'A320', origin: { iata: 'LHR', name: 'London Heathrow' }, destination: { iata: 'GVA' } },
        { category: 'departure', firstSeenAt, airline: 'Swiss', registration: 'HB-TWO', model: 'Airbus', aircraftType: 'A320', origin: { iata: 'GVA' }, destination: { iata: 'LHR', name: 'London Heathrow' } },
        { category: 'arrival', firstSeenAt, aircraftType: 'B738' },
        { category: 'other', firstSeenAt, aircraftType: 'A320' }
    ];
    for (const query of [' a320 ', 'SWISS', 'Airbus', 'London', 'lhr', 'HB-']) {
        const filtered = summarizeFlights(flights, 1, { hourly: query });
        assert.deepEqual(filtered.hourly[10], { hour: 10, landings: 1, takeoffs: 1 }, query);
        assert.deepEqual(filtered.overview, summarizeFlights(flights, 1).overview);
        assert.equal(filtered.landing.total, 2);
    }
    assert.deepEqual(summarizeFlights(flights, 1, { hourly: 'hb-one' }).hourly[10], { hour: 10, landings: 1, takeoffs: 0 });
    for (const query of ['missing', 'GVA']) {
        assert.equal(summarizeFlights(flights, 1, { hourly: query }).hourly.reduce((sum, hour) => sum + hour.landings + hour.takeoffs, 0), 0);
    }
    assert.deepEqual(summarizeFlights(flights, 1, { hourly: '   ' }).hourly[10], { hour: 10, landings: 2, takeoffs: 1 });
});

test('typing an hourly filter updates counts, keeps checkbox choices and survives tab and date changes', async () => {
    const { elements, buttons, document } = statsDocument();
    const requested = [];
    let timer;
    const flights = [
        { category: 'arrival', aircraftType: 'A320', firstSeenAt: Date.parse('2026-09-27T08:00:00Z') / 1000 },
        { category: 'arrival', aircraftType: 'B738', firstSeenAt: Date.parse('2026-09-27T08:00:00Z') / 1000 },
        { category: 'departure', aircraftType: 'A320', firstSeenAt: Date.parse('2026-09-27T08:00:00Z') / 1000 }
    ];
    const app = GenevaStats.create({ document,
        setTimeout(callback) { timer = callback; return 1; }, clearTimeout() { timer = null; },
        fetch: async url => {
            requested.push(url);
            const params = new URL(url, 'http://localhost').searchParams;
            return { ok: true, json: async () => params.has('available')
                ? { today: '2026-09-28', dates: ['2026-09-25', '2026-09-27'] }
                : summarizeFlights(flights, 1, { hourly: params.get('hourlyFilter'), landing: params.get('landingFilter') }) };
        }
    });
    await app.start();
    await app.load();
    buttons.hourly.click();
    assert.match(elements.hourlyChart.innerHTML, /10:00–10:59<\/th><td>2<\/td><td>1/);
    const input = { dataset: { statsFilter: 'hourly' }, value: 'A320' };
    document.oninput({ target: input });
    await timer();
    assert.match(requested.at(-1), /hourlyFilter=A320/);
    assert.match(elements.hourlyChart.innerHTML, /10:00–10:59<\/th><td>1<\/td><td>1/);
    elements.showHourlyTakeoffs.checked = false;
    elements.showHourlyTakeoffs.onchange();
    buttons.landing.click();
    document.oninput({ target: { dataset: { statsFilter: 'landing' }, value: 'B738' } });
    await timer();
    buttons.hourly.click();
    elements.statsCalendar.onclick({ target: { closest: () => ({ dataset: { statsDate: '2026-09-25' } }) } });
    await app.load();
    assert.match(requested.at(-1), /from=2026-09-25.*landingFilter=B738.*hourlyFilter=A320/);
    assert.doesNotMatch(elements.hourlyChart.innerHTML, /rect class="hourly-takeoff"/);
    assert.match(elements.hourlyChart.innerHTML, /10:00–10:59<\/th><td>1<\/td>/);
    input.value = 'missing';
    document.oninput({ target: input });
    await timer();
    assert.match(elements.hourlyChart.innerHTML, /No recorded flights for the selected traffic types/);
    input.value = '';
    document.oninput({ target: input });
    await timer();
    assert.doesNotMatch(requested.at(-1), /hourlyFilter/);
    assert.match(elements.hourlyChart.innerHTML, /10:00–10:59<\/th><td>2<\/td>/);
});

test('Hourly tab filters both bar series without fetching and keeps choices on reload', async () => {
    const { elements, buttons, document } = statsDocument();
    const requested = [];
    const summary = summarizeFlights([
        { category: 'arrival', firstSeenAt: Date.parse('2026-09-27T08:00:00Z') / 1000 },
        { category: 'departure', firstSeenAt: Date.parse('2026-09-27T08:30:00Z') / 1000 }
    ], 1);
    const app = GenevaStats.create({ document, fetch: statsFetch(summary, requested) });
    await app.start();
    await app.load();
    buttons.hourly.click();
    assert.equal(elements.hourlyStats.hidden, false);
    for (const view of ['landing', 'general', 'takeoffs']) assert.equal(elements[`${view}Stats`].hidden, true);
    assert.equal(buttons.hourly.pressed, 'true');
    assert.match(elements.hourlyChart.innerHTML, /rect class="hourly-landing"/);
    assert.match(elements.hourlyChart.innerHTML, /rect class="hourly-takeoff"/);
    assert.match(elements.hourlyChart.innerHTML, /10:00–10:59<\/th><td>1<\/td><td>1/);
    const requestsBefore = requested.length;
    elements.showHourlyLandings.checked = false;
    elements.showHourlyLandings.onchange();
    assert.doesNotMatch(elements.hourlyChart.innerHTML, /rect class="hourly-landing"/);
    assert.match(elements.hourlyChart.innerHTML, /rect class="hourly-takeoff"/);
    elements.showHourlyTakeoffs.checked = false;
    elements.showHourlyTakeoffs.onchange();
    assert.match(elements.hourlyChart.innerHTML, /Select Landings or Takeoffs/);
    elements.showHourlyLandings.checked = true;
    elements.showHourlyLandings.onchange();
    assert.match(elements.hourlyChart.innerHTML, /rect class="hourly-landing"/);
    assert.doesNotMatch(elements.hourlyChart.innerHTML, /rect class="hourly-takeoff"/);
    assert.equal(requested.length, requestsBefore);
    await app.load();
    assert.doesNotMatch(elements.hourlyChart.innerHTML, /rect class="hourly-takeoff"/);
    buttons.landing.click();
    assert.equal(elements.hourlyStats.hidden, true);
});

test('Hourly chart shows empty and failure states and clears stale data after a failed date request', async () => {
    const { elements, document } = statsDocument();
    let fail = false;
    const fetch = statsFetch(summarizeFlights([], 1));
    const app = GenevaStats.create({ document, logger: { error() {} }, fetch: url => {
        if (fail) throw new Error('offline');
        return fetch(url);
    } });
    await app.start();
    await app.load();
    assert.match(elements.hourlyChart.innerHTML, /No recorded flights for the selected traffic types/);
    fail = true;
    await app.load();
    elements.showHourlyLandings.onchange();
    assert.match(elements.hourlyChart.innerHTML, /Unable to load hourly stats/);
    assert.doesNotMatch(elements.hourlyChart.innerHTML, /<svg/);
});
