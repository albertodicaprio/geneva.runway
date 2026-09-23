const { getFlightHistory } = require('../lib/aircraft-service');
const { summarizeFlights } = require('../lib/stats');

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const days = new URL(req.url, 'http://localhost').searchParams.get('days') || '7';
    if (!['1', '7', '30'].includes(days)) return res.status(400).json({ error: 'days must be 1, 7, or 30' });
    const flights = await getFlightHistory(Number(days));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(summarizeFlights(flights, Number(days)));
};
