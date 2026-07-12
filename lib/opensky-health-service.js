const dns = require('dns/promises');
const net = require('net');
const tls = require('tls');

const OPENSKY_AUTH_HOST = 'auth.opensky-network.org';
const OPENSKY_API_HOST = 'opensky-network.org';
const CONTROL_URL = 'https://example.com/';
const EGRESS_IP_URL = 'https://api.ipify.org?format=json';
const OPENSKY_TOKEN_URL = `https://${OPENSKY_AUTH_HOST}/auth/realms/opensky-network/protocol/openid-connect/token`;
const OPENSKY_STATES_URL = `https://${OPENSKY_API_HOST}/api/states/all`;
const FETCH_TIMEOUT = 10000;
const SOCKET_TIMEOUT = 5000;

function credentialsStatus() { return { hasClientId: Boolean(process.env.OPENSKY_NETWORK_CLIENT_ID), hasClientSecret: Boolean(process.env.OPENSKY_NETWORK_CLIENT_SECRET) }; }
function serializeError(error) { return { name: error.name, message: error.message, code: error.code || error.cause?.code || null, causeName: error.cause?.name || null, causeMessage: error.cause?.message || null }; }
async function timeStep(name, fn) {
    const startedAt = Date.now();
    try { return { name, ok: true, durationMs: Date.now() - startedAt, ...await fn() }; }
    catch (error) { return { name, ok: false, durationMs: Date.now() - startedAt, error: serializeError(error) }; }
}
async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeoutId); }
}
function connectTcp(host, port = 443) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port }); socket.setTimeout(SOCKET_TIMEOUT);
        socket.once('connect', () => { const remoteAddress = socket.remoteAddress; socket.destroy(); resolve({ remoteAddress, remotePort: port }); });
        socket.once('timeout', () => { socket.destroy(); reject(new Error(`TCP connect timed out after ${SOCKET_TIMEOUT}ms`)); });
        socket.once('error', reject);
    });
}
function connectTls(host, port = 443) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }); socket.setTimeout(SOCKET_TIMEOUT);
        socket.once('secureConnect', () => { const certificate = socket.getPeerCertificate(); const summary = { authorized: socket.authorized, authorizationError: socket.authorizationError || null, remoteAddress: socket.remoteAddress, remotePort: port, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name || null, certificateSubject: certificate?.subject?.CN || null, certificateIssuer: certificate?.issuer?.CN || null }; socket.destroy(); resolve(summary); });
        socket.once('timeout', () => { socket.destroy(); reject(new Error(`TLS connect timed out after ${SOCKET_TIMEOUT}ms`)); });
        socket.once('error', reject);
    });
}
function responseSummary(response) { return { status: response.status, statusText: response.statusText, contentType: response.headers.get('content-type') }; }

async function getOpenSkyHealth() {
    const checks = [];
    const credentials = credentialsStatus();
    checks.push(await timeStep('dns.auth', async () => ({ addresses: await dns.lookup(OPENSKY_AUTH_HOST, { all: true }) })));
    checks.push(await timeStep('dns.api', async () => ({ addresses: await dns.lookup(OPENSKY_API_HOST, { all: true }) })));
    checks.push(await timeStep('tcp.auth', async () => connectTcp(OPENSKY_AUTH_HOST)));
    checks.push(await timeStep('tcp.api', async () => connectTcp(OPENSKY_API_HOST)));
    checks.push(await timeStep('tls.auth', async () => connectTls(OPENSKY_AUTH_HOST)));
    checks.push(await timeStep('tls.api', async () => connectTls(OPENSKY_API_HOST)));
    checks.push(await timeStep('fetch.control', async () => responseSummary(await fetchWithTimeout(CONTROL_URL, { method: 'GET', headers: { Accept: 'text/html' } }))));
    checks.push(await timeStep('fetch.egressIp', async () => { const fetchResponse = await fetchWithTimeout(EGRESS_IP_URL, { method: 'GET', headers: { Accept: 'application/json' } }); const summary = responseSummary(fetchResponse); return fetchResponse.ok ? { ...summary, ip: (await fetchResponse.json()).ip || null } : summary; }));
    checks.push(await timeStep('fetch.states.anonymous', async () => responseSummary(await fetchWithTimeout(OPENSKY_STATES_URL, { method: 'GET', headers: { Accept: 'application/json' } }))));
    checks.push(await timeStep('fetch.token', async () => {
        if (!credentials.hasClientId || !credentials.hasClientSecret) return { skipped: true, reason: 'OpenSky client credentials are not configured' };
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.OPENSKY_NETWORK_CLIENT_ID, client_secret: process.env.OPENSKY_NETWORK_CLIENT_SECRET });
        const fetchResponse = await fetchWithTimeout(OPENSKY_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        const summary = responseSummary(fetchResponse);
        if (!fetchResponse.ok) return summary;
        const data = await fetchResponse.json();
        return { ...summary, hasAccessToken: Boolean(data.access_token), expiresIn: data.expires_in || null, tokenType: data.token_type || null };
    }));
    const ok = checks.every(check => check.ok);
    return { status: ok ? 200 : 502, body: { ok, region: process.env.VERCEL_REGION || null, runtime: process.version, timeoutMs: FETCH_TIMEOUT, credentials, checkedAt: new Date().toISOString(), checks } };
}

module.exports = { getOpenSkyHealth };
