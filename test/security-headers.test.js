const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { spawn } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
let server;
let baseUrl;

before(async () => {
    server = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        env: { ...process.env, PORT: '0' },
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
