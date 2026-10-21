const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createPathHistory } = require('../lib/path-history');
const { createPathHistoryHandler } = require('../api/path-history');

function plane(timestamp, extra = {}) {
    return { icao24: 'abc123', callsign: 'SWR123', lastPositionUpdate: timestamp,
        latitude: 46.3, longitude: 6.2, altitude: 1000, heading: 220,
        track: { color: 'purple', points: [] }, ...extra };
}

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
