const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createPathHistory } = require('../lib/path-history');
const { createPathHistoryHandler } = require('../api/path-history');
const { createAircraftService } = require('../lib/aircraft-service');

function plane(timestamp, extra = {}) {
    return { icao24: 'abc123', callsign: 'SWR123', lastPositionUpdate: timestamp,
        latitude: 46.3, longitude: 6.2, altitude: 1000, heading: 220,
        track: { color: 'purple', points: [] }, ...extra };
}

test('history includes cached trails of aircraft that already left before archiving started', async () => {
    const archive = createPathHistory({ clock: () => 100000000 });
    await archive.recordSnapshot({ aircraft: [plane(100000)], recentTracks: [plane(99030, {
        icao24: 'landed', disappearedAt: 99060, expiresAt: 106260,
        track: { color: 'purple', points: [
            { timestamp: 99000, latitude: 46.4, longitude: 6.3 },
            { timestamp: 99030, latitude: 46.3, longitude: 6.2 }
        ] }
    })] });
    const past = await archive.read(99940);
    const landed = past.aircraft.find(item => item.callsign === 'SWR123');
    assert.ok(landed, 'Retained aircraft must remain in the historical two-hour window');
    assert.equal(landed.track.points.length, 2);
    assert.equal(landed.historicalActive, false);
});

test('cached trails fill earlier gaps without replacing archived measurements or duplicating points', async () => {
    let now = 100000;
    const archive = createPathHistory({ clock: () => now * 1000 });
    await archive.recordSnapshot({ aircraft: [plane(now)] });
    now += 30;
    const snapshot = { aircraft: [plane(now, { track: { color: 'purple', points: [
        { timestamp: 99970, latitude: 46.4, longitude: 6.3 },
        { timestamp: 100000, latitude: 0, longitude: 0 },
        { timestamp: now, latitude: 46.3, longitude: 6.2 },
        { timestamp: now + 1, latitude: 46.3, longitude: 6.2 },
        { timestamp: now - 86401, latitude: 46.3, longitude: 6.2 }
    ] } })] };
    await archive.recordSnapshot(snapshot);
    await archive.recordSnapshot(snapshot);
    const past = (await archive.read(100000)).aircraft[0];
    assert.deepEqual(past.track.points.map(point => point.timestamp), [99970, 100000]);
    assert.equal(past.track.points[0].altitude, null);
    assert.equal(past.altitude, 1000);
    assert.equal(past.latitude, 46.3);
    assert.equal((await archive.read(now)).aircraft[0].track.points.length, 3);
    // A later actual observation can supply measurements for an imported point.
    await archive.recordSnapshot({ aircraft: [plane(99970, { track: { color: 'purple', points: [] } })] });
    assert.equal((await archive.read(99970)).aircraft[0].altitude, 1000);
});

test('history restores trails from the disk cache before the first refresh without upstream requests', async () => {
    const service = createAircraftService({ clock: () => 100000000,
        fetch: () => assert.fail('History must not request upstream data'),
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: 100000000,
            arrivals: { aircraft: [], recentTracks: [plane(99030, { track: { color: 'purple', points: [
                { timestamp: 99000, latitude: 46.4, longitude: 6.3 },
                { timestamp: 99030, latitude: 46.3, longitude: 6.2 }
            ] } })] } }) }
    });
    assert.equal((await service.getPathHistory()).availableFrom, 99000);
    const past = await service.getPathHistory(99940);
    assert.equal(past.aircraft.length, 1);
    assert.equal(past.aircraft[0].historicalActive, false);
    assert.equal(past.aircraft[0].track.points.length, 2);
});

test('archive survives restart, deduplicates observations, clips future points and expires after 24 hours', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-paths-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'paths.json');
    let now = 100000;
    const clock = () => now * 1000;
    const archive = createPathHistory({ file, clock });
    await archive.recordSnapshot({ aircraft: [plane(now)], generalTraffic: [plane(now, { icao24: 'other' })] });
    await archive.recordSnapshot({ aircraft: [plane(now)] });
    now += 30;
    await archive.recordSnapshot({ aircraft: [plane(now, { latitude: 46.25, altitude: 800 })] });
    const restored = createPathHistory({ file, clock });
    const past = await restored.read(now - 30);
    assert.equal(past.aircraft.length, 1);
    assert.equal(past.generalTraffic.length, 1);
    assert.equal(past.aircraft[0].track.points.length, 1);
    assert.equal(past.aircraft[0].latitude, 46.3);
    assert.equal(past.aircraft[0].altitude, 1000);
    assert.equal((await restored.read(now)).aircraft[0].track.points.length, 2);
    assert.equal((await restored.read()).aircraft, undefined);
    now += 86401;
    assert.equal((await restored.read()).availableFrom, null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).sessions, []);
});

test('archive splits flight changes and tracking gaps and retains only points in the selected two-hour window', async () => {
    let now = 100000;
    const archive = createPathHistory({ clock: () => now * 1000 });
    await archive.recordSnapshot({ aircraft: [plane(now)] });
    now += 30;
    await archive.recordSnapshot({ aircraft: [plane(now)] });
    now += 120;
    await archive.recordSnapshot({ aircraft: [plane(now)] });
    now += 30;
    await archive.recordSnapshot({ generalTraffic: [plane(now, { callsign: 'NEW123' })] });
    const result = await archive.read(now);
    assert.equal(result.aircraft.length, 2);
    assert.equal(result.aircraft[0].historicalActive, false);
    assert.equal(result.aircraft[1].historicalActive, true);
    assert.notEqual(result.aircraft[0].icao24, result.aircraft[1].icao24);
    assert.equal(result.generalTraffic.length, 1);
    now += 7201;
    assert.equal((await archive.read(now)).aircraft.length, 0);
    assert.equal((await archive.read()).availableFrom, 100000);
});

test('archive skips stale, future, grounded and invalid positions', async () => {
    const archive = createPathHistory({ clock: () => 100000000 });
    await archive.recordSnapshot({ aircraft: [plane(99880), plane(100001),
        plane(100000, { onGround: true }), plane(100000, { latitude: null })] });
    assert.equal((await archive.read()).availableFrom, null);
});

test('path API validates time and method and reads history without fetching live aircraft', async () => {
    const reads = [];
    const handler = createPathHistoryHandler({ clock: () => 100000000, read: async at => { reads.push(at); return { at }; } });
    async function request(query, method = 'GET') {
        const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
            status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        await handler({ url: `/api/path-history${query}`, method }, res);
        return res;
    }
    for (const query of ['?at=', '?at=no', '?at=-1', '?at=1', '?at=100001', '?at=99999.5'])
        assert.equal((await request(query)).code, 400);
    assert.equal((await request('', 'POST')).code, 405);
    assert.equal((await request('')).code, 200);
    const past = await request('?at=99999');
    assert.equal(past.code, 200);
    assert.equal(past.headers['Cache-Control'], 'no-store');
    assert.deepEqual(reads, [null, 99999]);
});

test('imported historical positions use their preceding movement for plane heading without looking ahead', async () => {
    const archive = createPathHistory({ clock: () => 100000000 });
    await archive.recordSnapshot({ aircraft: [plane(100000, { track: { color: 'purple', points: [
        { timestamp: 99000, latitude: 46.3, longitude: 6.1 },
        { timestamp: 99030, latitude: 46.3, longitude: 6.2 },
        { timestamp: 99060, latitude: 46.3, longitude: 6.2 },
        { timestamp: 99090, latitude: 46.4, longitude: 6.2 }
    ] } })] });
    assert.equal((await archive.read(99000)).aircraft[0].heading, null);
    const east = (await archive.read(99030)).aircraft[0];
    assert.ok(Math.abs(east.heading - 90) < 1, 'Imported points must render a plane pointing east');
    assert.equal((await archive.read(99060)).aircraft[0].heading, east.heading);
    assert.equal((await archive.read(99090)).aircraft[0].heading, 0);
    assert.equal((await archive.read(100000)).aircraft.at(-1).heading, 220);
});
