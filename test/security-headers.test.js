const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('the aircraft API does not allow cross-origin browser access', async () => {
    const response = await fetch(`${baseUrl}/api/aircraft`, { method: 'OPTIONS' });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('malformed percent-encoded paths return 400 and leave the server healthy', async () => {
    for (const pathname of ['/%ZZ', '/%E0%A4%A']) {
        const response = await fetch(`${baseUrl}${pathname}`);
        assert.equal(response.status, 400);
        assert.equal(await response.text(), 'Bad request');
    }
    assert.equal((await fetch(`${baseUrl}/`)).status, 200);
});
