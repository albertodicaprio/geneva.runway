const { getAircraftData } = require('../lib/aircraft-service');

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const afterText = new URL(req.url, 'http://localhost').searchParams.get('after');
    const after = afterText === null ? null : Number(afterText);
    if (afterText !== null && (!/^\d+$/.test(afterText) || !Number.isSafeInteger(after)))
        return res.status(400).json({ error: 'after must be a millisecond timestamp' });
    const result = await getAircraftData({ after });
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return res.status(result.status).json(result.body);
};
