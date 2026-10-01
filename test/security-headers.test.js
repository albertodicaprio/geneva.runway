const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { genevaDate } = require('../lib/flight-history');

const projectRoot = path.join(__dirname, '..');
let server;
let baseUrl;
let testCacheDir;

before(async () => {
    testCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geneva-runway-test-'));
    server = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        env: { ...process.env, PORT: '0', TMPDIR: testCacheDir,
            OPENSKY_NETWORK_CLIENT_ID: '', OPENSKY_NETWORK_CLIENT_SECRET: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    baseUrl = await new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5_000);

        server.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/http:\/\/[^:]+:(\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(`http://127.0.0.1:${match[1]}`);
            }
        });
        server.once('error', reject);
        server.stderr.on('data', chunk => { output += chunk; });
    });
});

after(() => {
    server?.kill();
    if (testCacheDir) fs.rmSync(testCacheDir, { recursive: true, force: true });
});

test('static responses include restrictive browser security headers', async () => {
    const response = await fetch(`${baseUrl}/`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('all three pages provide direct navigation and arrivals includes history at the bottom', async () => {
    for (const [path, title, sectionIds] of [
        ['/', 'Geneva Airport plane spotting', ['mapSection']],
        ['/arrivals.html', 'Arrivals', ['aircraftList', 'flightHistory']],
        ['/stats.html', 'Stats', ['landingSummary']]
    ]) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, new RegExp(`<h1>${title}</h1>`));
        assert.match(html, /href="\/"/);
        assert.match(html, /href="\/arrivals.html"/);
        assert.doesNotMatch(html, /href="\/history.html"/);
        assert.match(html, /href="\/stats.html"/);
        assert.ok(html.includes(`href="${path}" aria-current="page"`));
        for (const sectionId of sectionIds) assert.ok(html.includes(`id="${sectionId}"`));
        if (path === '/arrivals.html') {
            assert.ok(html.indexOf('id="aircraftList"') < html.indexOf('id="flightHistory"'));
            assert.match(html, /id="historyCount"/);
        }
        for (const otherId of ['mapSection', 'aircraftList', 'flightHistory', 'landingSummary']) {
            if (!sectionIds.includes(otherId)) assert.ok(!html.includes(`id="${otherId}"`));
        }
    }
});

test('the old history URL redirects to recent landings on arrivals', async () => {
    for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`${baseUrl}/history.html`, { method, redirect: 'manual' });
        assert.equal(response.status, 301);
        assert.equal(response.headers.get('location'), '/arrivals.html#historyHeading');
    }
});

test('the stats API serves archive summaries without requiring OpenSky', async () => {
    const response = await fetch(`${baseUrl}/api/stats?days=7`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const summary = await response.json();
    assert.equal(summary.days, 7);
    assert.equal(summary.landing.total, 0);
    assert.equal(summary.general.total, 0);
    assert.equal(summary.takeoffs.total, 0);
    const yesterday = await fetch(`${baseUrl}/api/stats?days=1&offset=1`);
    assert.equal(yesterday.status, 200);
    assert.equal((await yesterday.json()).days, 1);
    assert.equal((await fetch(`${baseUrl}/api/stats?days=7&offset=1`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/stats?days=365`)).status, 400);
});

test('stats availability and date ranges use only recorded Geneva days', async () => {
    const today = genevaDate(Date.now());
    const previous = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86400000).toISOString().slice(0, 10);
    const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 86400000).toISOString().slice(0, 10);
    const missing = new Date(Date.parse(`${today}T00:00:00Z`) - 9 * 86400000).toISOString().slice(0, 10);
    const directory = path.join(testCacheDir, 'flight-history');
    fs.mkdirSync(directory, { recursive: true });
    for (const [date, category] of [[previous, 'arrival'], [recent, 'departure']]) {
        fs.writeFileSync(path.join(directory, `${date}.json`), JSON.stringify({ version: 1, date,
            flights: [{ category, airline: 'Swiss' }] }));
    }
    const availability = await fetch(`${baseUrl}/api/stats?available=1`);
    assert.equal(availability.status, 200);
    assert.deepEqual(await availability.json(), { today, dates: [previous, recent] });
    const range = await fetch(`${baseUrl}/api/stats?from=${previous}&to=${recent}`);
    assert.equal(range.status, 200);
    const summary = await range.json();
    assert.equal(summary.days, 3);
    assert.equal(summary.landing.total, 1);
    assert.equal(summary.takeoffs.total, 1);
    assert.equal((await fetch(`${baseUrl}/api/stats?from=${missing}&to=${recent}`)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/stats?from=2026-02-30&to=${recent}`)).status, 400);
    const future = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    assert.equal((await fetch(`${baseUrl}/api/stats?from=${today}&to=${future}`)).status, 400);
});

test('the aircraft API does not allow cross-origin browser access', async () => {
    const response = await fetch(`${baseUrl}/api/aircraft`, { method: 'OPTIONS' });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${baseUrl}/api/aircraft?after=invalid`)).status, 400);
});

test('malformed percent-encoded paths return 400 and leave the server healthy', async () => {
    for (const pathname of ['/%ZZ', '/%E0%A4%A']) {
        const response = await fetch(`${baseUrl}${pathname}`);
        assert.equal(response.status, 400);
        assert.equal(await response.text(), 'Bad request');
    }
    assert.equal((await fetch(`${baseUrl}/`)).status, 200);
});
