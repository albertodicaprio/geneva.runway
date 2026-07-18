const { getAircraftData } = require('../lib/aircraft-service');

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const result = await getAircraftData();
    for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
    return res.status(result.status).json(result.body);
};
