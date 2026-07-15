const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

loadLocalEnv();

const aircraftHandler = require('./api/aircraft');
const { ApiRateLimiter, getClientIp } = require('./lib/api-rate-limiter');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const apiRateLimiter = new ApiRateLimiter();

const CONTENT_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function parseEnvValue(value) {
    const trimmed = value.trim();
    const quote = trimmed[0];

    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
        return trimmed.slice(1, -1);
    }

    return trimmed;
}

function loadLocalEnv() {
    const envPath = path.join(__dirname, '.env');

    if (!fsSync.existsSync(envPath)) {
        return;
    }

    const contents = fsSync.readFileSync(envPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = trimmed.slice(0, separatorIndex).trim();
        const value = parseEnvValue(trimmed.slice(separatorIndex + 1));

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function createApiResponseAdapter(res) {
    return {
        setHeader(name, value) {
            res.setHeader(name, value);
        },
        status(statusCode) {
            res.statusCode = statusCode;
            return this;
        },
        json(body) {
            if (!res.hasHeader('Content-Type')) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            res.end(JSON.stringify(body));
        },
        end(body) {
            res.end(body);
        }
    };
}

async function handleApi(handler, req, res) {
    try {
        await handler(req, createApiResponseAdapter(res));
    } catch (error) {
        console.error('Unhandled API error:', error);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
}

function getStaticFilePath(urlPathname) {
    const pathname = urlPathname === '/' ? '/index.html' : urlPathname;
    const decodedPath = decodeURIComponent(pathname);
    const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
        return null;
    }

    return filePath;
}

async function serveStatic(req, res, urlPathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end('Method not allowed');
        return;
    }

    const filePath = getStaticFilePath(urlPathname);
    if (!filePath) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
    }

    try {
        const contents = await fs.readFile(filePath);
        const contentType = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';

        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        res.end(contents);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') {
            res.statusCode = 404;
            res.end('Not found');
            return;
        }

        console.error('Static file error:', error);
        res.statusCode = 500;
        res.end('Internal server error');
    }
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/aircraft') {
        const permit = apiRateLimiter.acquire(getClientIp(req));
        if (!permit.allowed) {
            res.statusCode = permit.status;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (permit.retryAfterSeconds) res.setHeader('Retry-After', String(permit.retryAfterSeconds));
            res.end(JSON.stringify({ error: permit.status === 429 ? 'Too many requests' : 'Service temporarily busy' }));
            return;
        }
        res.once('finish', permit.release);
        res.once('close', permit.release);
        handleApi(aircraftHandler, req, res);
        return;
    }

    serveStatic(req, res, url.pathname);
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
setInterval(() => apiRateLimiter.prune(), 60_000).unref();

server.listen(PORT, HOST, () => {
    console.log(`Geneva Runway app listening on http://${HOST}:${PORT}`);
});
