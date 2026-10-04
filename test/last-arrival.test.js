const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAircraftService } = require('../lib/aircraft-service');

test('last arrival uses the newest unexpired retained flight without fetching OpenSky', async () => {
    let now = 1000000;
    const records = [
        { callsign: 'Older', approachDirection: '04', disappearedAt: 800, expiresAt: 8000 },
        { callsign: 'Latest', approachDirection: '22', disappearedAt: 950, expiresAt: 8150 },
        { callsign: 'Expired', approachDirection: '04', disappearedAt: 980, expiresAt: 999 },
        { callsign: 'Future', approachDirection: '04', disappearedAt: 1100, expiresAt: 8300 }
    ];
    let reads = 0;
    const service = createAircraftService({ clock: () => now,
        fetch: async () => { assert.fail('A cache read must not request upstream data'); },
        cacheStore: { read: async () => {
            reads++;
            return { version: 6, lastFetchTime: 990000, arrivals: { aircraft: [], recentTracks: records } };
        } }
    });
    const latest = await service.getLastArrival();
    assert.equal(latest.callsign, 'Latest');
    assert.equal(latest.direction, '22');
    assert.equal(latest.estimatedLandingAt, 950000);
    assert.equal(latest.stale, false);
    records[1].approachDirection = 'unknown';
    assert.equal((await service.getLastArrival()).direction, 'unknown');
    records.pop();
    now += 600000;
    assert.equal((await service.getLastArrival()).stale, true);
    now = 8200000;
    assert.equal(await service.getLastArrival(), null);
    assert.equal(reads, 1);
});

test('last arrival supports legacy retention times and an empty cache', async () => {
    const service = createAircraftService({ clock: () => 1000000,
        cacheStore: { read: async () => ({ version: 6, lastFetchTime: 990000,
            arrivals: { recentTracks: [{ icao24: 'abc123', expiresAt: 8100, approachDirection: '04' }] } }) }
    });
    const result = await service.getLastArrival();
    assert.equal(result.estimatedLandingAt, 900000);
    assert.equal(result.callsign, 'abc123');
    const empty = createAircraftService({ cacheStore: { read: async () => { throw Object.assign(new Error('No cache'), { code: 'ENOENT' }); } } });
    assert.equal(await empty.getLastArrival(), null);
});
