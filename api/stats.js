const { getFlightHistory } = require('../lib/aircraft-service');
const { summarizeFlights } = require('../lib/stats');

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const params = new URL(req.url, 'http://localhost').searchParams;
    const days = params.get('days') || '7';
    const offset = params.get('offset') || '0';
    if (!['1', '7', '30'].includes(days)) return res.status(400).json({ error: 'days must be 1, 7, or 30' });
    if (!['0', '1'].includes(offset) || (offset === '1' && days !== '1'))
        return res.status(400).json({ error: 'offset must be 0, or 1 when days is 1' });
    const flights = await getFlightHistory(Number(days), Number(offset));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(summarizeFlights(flights, Number(days)));
};
