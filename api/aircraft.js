const { getAircraftData } = require('../lib/aircraft-service');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const result = await getAircraftData();
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return res.status(result.status).json(result.body);
};
