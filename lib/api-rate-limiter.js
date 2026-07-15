const WINDOW_MS = 60_000;

class ApiRateLimiter {
    constructor({ capacity = 10, requestsPerMinute = 30, maxConcurrent = 20, now = () => Date.now() } = {}) {
        this.capacity = capacity;
        this.refillPerMs = requestsPerMinute / WINDOW_MS;
        this.maxConcurrent = maxConcurrent;
        this.now = now;
        this.clients = new Map();
        this.activeRequests = 0;
    }

    acquire(clientId) {
        const now = this.now();
        const existing = this.clients.get(clientId);
        const tokens = existing ? Math.min(this.capacity, existing.tokens + (now - existing.updatedAt) * this.refillPerMs) : this.capacity;
        const client = { tokens, updatedAt: now };
        this.clients.set(clientId, client);

        if (client.tokens < 1) {
            return { allowed: false, status: 429, retryAfterSeconds: Math.max(1, Math.ceil((1 - client.tokens) / this.refillPerMs / 1000)) };
        }
        if (this.activeRequests >= this.maxConcurrent) {
            return { allowed: false, status: 503 };
        }

        client.tokens -= 1;
        this.activeRequests += 1;
        let released = false;
        return {
            allowed: true,
            release: () => {
                if (!released) {
                    released = true;
                    this.activeRequests -= 1;
                }
            }
        };
    }

    prune() {
        const cutoff = this.now() - WINDOW_MS;
        for (const [clientId, client] of this.clients) {
            if (client.updatedAt < cutoff) this.clients.delete(clientId);
        }
    }
}

function getClientIp(req) {
    // The Docker app port is private; Caddy overwrites this header before proxying.
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor) return forwardedFor.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

module.exports = { ApiRateLimiter, getClientIp };
