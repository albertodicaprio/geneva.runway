const dns = require('dns/promises');

const OPENSKY_AUTH_HOST = 'auth.opensky-network.org';
const OPENSKY_API_HOST = 'opensky-network.org';
const OPENSKY_TOKEN_URL = `https://${OPENSKY_AUTH_HOST}/auth/realms/opensky-network/protocol/openid-connect/token`;
const OPENSKY_STATES_URL = `https://${OPENSKY_API_HOST}/api/states/all`;
const FETCH_TIMEOUT = 10000;

function getOpenSkyCredentialsStatus() {
    return {
        hasClientId: Boolean(process.env.OPENSKY_NETWORK_CLIENT_ID),
        hasClientSecret: Boolean(process.env.OPENSKY_NETWORK_CLIENT_SECRET)
    };
}

function serializeError(error) {
    return {
        name: error.name,
        message: error.message,
        code: error.code || error.cause?.code || null,
        causeName: error.cause?.name || null,
        causeMessage: error.cause?.message || null
    };
}

async function timeStep(name, fn) {
    const startedAt = Date.now();

    try {
        const result = await fn();
        return {
            name,
            ok: true,
            durationMs: Date.now() - startedAt,
            ...result
        };
    } catch (error) {
        return {
            name,
            ok: false,
            durationMs: Date.now() - startedAt,
            error: serializeError(error)
        };
    }
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

function responseSummary(response) {
    return {
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type')
    };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const checks = [];
    const credentials = getOpenSkyCredentialsStatus();

    checks.push(await timeStep('dns.auth', async () => ({
        addresses: await dns.lookup(OPENSKY_AUTH_HOST, { all: true })
    })));

    checks.push(await timeStep('dns.api', async () => ({
        addresses: await dns.lookup(OPENSKY_API_HOST, { all: true })
    })));

    checks.push(await timeStep('fetch.states.anonymous', async () => {
        const response = await fetchWithTimeout(OPENSKY_STATES_URL, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        return responseSummary(response);
    }));

    checks.push(await timeStep('fetch.token', async () => {
        if (!credentials.hasClientId || !credentials.hasClientSecret) {
            return { skipped: true, reason: 'OpenSky client credentials are not configured' };
        }

        const body = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.OPENSKY_NETWORK_CLIENT_ID,
            client_secret: process.env.OPENSKY_NETWORK_CLIENT_SECRET
        });

        const response = await fetchWithTimeout(OPENSKY_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        const summary = responseSummary(response);

        if (!response.ok) {
            return summary;
        }

        const data = await response.json();
        return {
            ...summary,
            hasAccessToken: Boolean(data.access_token),
            expiresIn: data.expires_in || null,
            tokenType: data.token_type || null
        };
    }));

    const ok = checks.every(check => check.ok);

    res.status(ok ? 200 : 502).json({
        ok,
        region: process.env.VERCEL_REGION || null,
        runtime: process.version,
        timeoutMs: FETCH_TIMEOUT,
        credentials,
        checkedAt: new Date().toISOString(),
        checks
    });
};
