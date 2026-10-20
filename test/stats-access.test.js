const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStatsHandler } = require('../api/stats');

function fixture(now, dates) {
    let user = null;
    const reads = [];
    const handler = createStatsHandler({ clock: () => Date.parse(now), getUser: () => user,
        availableDates: async () => dates,
        readRange: async (...range) => { reads.push(range); return []; },
        readDays: async (...range) => { reads.push(range); return []; } });
    return { reads, signIn: () => { user = { id: 'alice' }; }, signOut: () => { user = null; },
        async request(query = '') {
            const response = { headers: {}, statusCode: 200,
                setHeader(name, value) { this.headers[name] = value; },
                status(code) { this.statusCode = code; return this; },
                json(body) { this.body = body; } };
            await handler({ method: 'GET', url: `/api/stats${query}` }, response);
            return response;
        } };
}

test('guest cutoff follows Geneva calendar days across DST and year boundaries', async () => {
    for (const [now, today, cutoff, old] of [
        ['2026-10-25T23:30:00Z', '2026-10-26', '2026-10-24', '2026-10-23'],
        ['2026-03-29T22:30:00Z', '2026-03-30', '2026-03-28', '2026-03-27'],
        ['2026-12-31T23:30:00Z', '2027-01-01', '2026-12-30', '2026-12-29']
    ]) {
        const f = fixture(now, [old, cutoff, today]);
        const available = await f.request('?available=1');
        assert.deepEqual(available.body, { today, dates: [cutoff, today], historyLimited: true });
        assert.equal(available.headers['Cache-Control'], 'no-store');
        assert.equal((await f.request(`?from=${cutoff}&to=${today}`)).statusCode, 200);
        assert.equal((await f.request(`?from=${old}&to=${today}`)).statusCode, 403);
        assert.equal((await f.request(`?from=${old}&to=${old}`)).statusCode, 403);
        assert.deepEqual(f.reads, [[cutoff, today]]);
    }
});

test('signed-in users retain full archive access; signing out restores all API limits', async () => {
    const dates = ['2026-08-01', '2026-10-18', '2026-10-20'];
    const f = fixture('2026-10-20T12:00:00Z', dates);
    assert.equal((await f.request()).body.days, 3);
    assert.equal((await f.request('?days=1&offset=1')).statusCode, 200);
    for (const days of [7, 30]) assert.equal((await f.request(`?days=${days}`)).statusCode, 403);
    assert.equal((await f.request('?days=3&offset=1')).statusCode, 400);
    f.signIn();
    assert.deepEqual((await f.request('?available=1')).body.dates, dates);
    assert.equal((await f.request('?available=1')).body.historyLimited, false);
    assert.equal((await f.request('?from=2026-08-01&to=2026-10-20')).statusCode, 200);
    assert.equal((await f.request()).body.days, 7);
    assert.equal((await f.request('?days=30')).body.days, 30);
    f.signOut();
    assert.equal((await f.request('?from=2026-08-01&to=2026-10-20')).statusCode, 403);
    assert.equal((await f.request('?days=30')).statusCode, 403);
});
