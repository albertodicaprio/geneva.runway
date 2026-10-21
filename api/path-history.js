const { getPathHistory } = require('../lib/aircraft-service');

function createPathHistoryHandler({ read = getPathHistory, clock = Date.now } = {}) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const text = new URL(req.url, 'http://localhost').searchParams.get('at');
        const at = text === null ? null : Number(text);
        const now = Math.floor(clock() / 1000);
        if (text !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(at) || at < now - 86400 || at > now))
            return res.status(400).json({ error: 'at must be a Unix timestamp within the last 24 hours' });
        return res.status(200).json(await read(at));
    };
}

module.exports = createPathHistoryHandler();
module.exports.createPathHistoryHandler = createPathHistoryHandler;
