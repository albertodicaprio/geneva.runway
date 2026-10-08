const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function startServer(t, websiteId) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geneva-analytics-test-'));
    const server = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1', TMPDIR: directory,
            UMAMI_WEBSITE_ID: websiteId, UMAMI_APP_SECRET: 'private-analytics-secret',
            OPENSKY_NETWORK_CLIENT_ID: '', OPENSKY_NETWORK_CLIENT_SECRET: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => {
        server.kill();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error('Analytics test server did not start')), 5_000);
        server.once('error', error => { clearTimeout(timeout); reject(error); });
        server.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
            if (match) {
                clearTimeout(timeout);
                resolve(`http://127.0.0.1:${match[1]}`);
            }
        });
        server.stderr.resume();
    });
}

test('runtime analytics configuration renders the deployment website ID on all pages', async t => {
    const websiteId = '11111111-2222-4333-8444-555555555555';
    const origin = await startServer(t, websiteId);
    for (const pathname of ['/', '/arrivals.html', '/stats.html', '/weather.html']) {
        const response = await fetch(origin + pathname);
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.equal((html.match(/src="\/script.js"/g) || []).length, 1);
        assert.ok(html.includes(`data-website-id="${websiteId}"`));
        assert.match(html, /<script defer src="\/script.js"/);
        assert.doesNotMatch(html, /private-analytics-secret|UMAMI_TRACKER|data-domains/);
        assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    }
    const asset = await (await fetch(origin + '/theme.js')).text();
    assert.doesNotMatch(asset, /data-website-id/);
});

for (const [label, websiteId] of [
    ['unset', ''],
    ['invalid', '"><script src="https://example.invalid/injected.js"></script>']
]) {
    test(`${label} analytics configuration keeps pages usable without injecting a tracker`, async t => {
        const origin = await startServer(t, websiteId);
        const response = await fetch(origin + '/');
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, /<h1>Geneva Airport plane spotting<\/h1>/);
        assert.doesNotMatch(html, /src="\/script.js"|data-website-id|UMAMI_TRACKER|injected.js/);
        const head = await fetch(origin + '/', { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
    });
}
