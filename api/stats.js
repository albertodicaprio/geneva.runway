const { getFlightHistory, getFlightHistoryRange, getFlightHistoryDates } = require('../lib/aircraft-service');
const { genevaDate, validDate } = require('../lib/flight-history');
const { summarizeFlights } = require('../lib/stats');

module.exports = async (req, res) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const params = new URL(req.url, 'http://localhost').searchParams;
    const filters = Object.fromEntries(['landing', 'general', 'takeoffs']
        .map(view => [view, params.get(`${view}Filter`) || '']));
    res.setHeader('Cache-Control', 'no-store');
    if (params.get('available') === '1') {
        return res.status(200).json({ today: genevaDate(Date.now()), dates: await getFlightHistoryDates() });
    }
    if (params.has('from') || params.has('to')) {
        const from = params.get('from');
        const to = params.get('to');
        const today = genevaDate(Date.now());
        if (!validDate(from) || !validDate(to) || from > to || to > today)
            return res.status(400).json({ error: 'Invalid date range' });
        const available = await getFlightHistoryDates();
        if (!available.includes(from) || !available.includes(to))
            return res.status(400).json({ error: 'Range endpoints must have recorded data' });
        const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
        const flights = await getFlightHistoryRange(from, to);
        return res.status(200).json({ from, to, ...summarizeFlights(flights, days, filters) });
    }
    const days = params.get('days') || '7';
    const offset = params.get('offset') || '0';
    if (!['1', '7', '30'].includes(days)) return res.status(400).json({ error: 'days must be 1, 7, or 30' });
    if (!['0', '1'].includes(offset) || (offset === '1' && days !== '1'))
        return res.status(400).json({ error: 'offset must be 0, or 1 when days is 1' });
    const flights = await getFlightHistory(Number(days), Number(offset));
    return res.status(200).json(summarizeFlights(flights, Number(days), filters));
};
