const { getFlightHistory, getFlightHistoryRange, getFlightHistoryDates } = require('../lib/aircraft-service');
const { genevaDate, validDate } = require('../lib/flight-history');
const { summarizeFlights } = require('../lib/stats');

function createStatsHandler({ getUser = () => null, clock = Date.now,
    readDays = getFlightHistory, readRange = getFlightHistoryRange, availableDates = getFlightHistoryDates } = {}) {
    return async (req, res) => {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        const params = new URL(req.url, 'http://localhost').searchParams;
        const filters = Object.fromEntries(['landing', 'general', 'takeoffs', 'hourly']
            .map(view => [view, params.get(`${view}Filter`) || '']));
        res.setHeader('Cache-Control', 'no-store');
        const today = genevaDate(clock());
        const historyLimited = !getUser(req);
        // Subtract calendar days in UTC after resolving the Geneva-local date, so DST
        // changes do not move the cutoff to a different local day.
        const earliestDate = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
        const forbidden = () => res.status(403).json({ error: 'Sign in to view stats older than the last three days.' });
        if (params.get('available') === '1') {
            const dates = (await availableDates()).filter(date => !historyLimited || date >= earliestDate);
            return res.status(200).json({ today, dates, historyLimited });
        }
        if (params.has('from') || params.has('to')) {
            const from = params.get('from');
            const to = params.get('to');
            if (!validDate(from) || !validDate(to) || from > to || to > today)
                return res.status(400).json({ error: 'Invalid date range' });
            if (historyLimited && from < earliestDate) return forbidden();
            const available = await availableDates();
            if (!available.includes(from) || !available.includes(to))
                return res.status(400).json({ error: 'Range endpoints must have recorded data' });
            const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
            const flights = await readRange(from, to);
            return res.status(200).json({ from, to, ...summarizeFlights(flights, days, filters) });
        }
        const days = params.get('days') || (historyLimited ? '3' : '7');
        const offset = params.get('offset') || '0';
        if (!['1', '3', '7', '30'].includes(days)) return res.status(400).json({ error: 'days must be 1, 3, 7, or 30' });
        if (!['0', '1'].includes(offset) || (offset === '1' && days !== '1'))
            return res.status(400).json({ error: 'offset must be 0, or 1 when days is 1' });
        if (historyLimited && Number(days) + Number(offset) > 3) return forbidden();
        const flights = await readDays(Number(days), Number(offset));
        return res.status(200).json(summarizeFlights(flights, Number(days), filters));
    };
}

module.exports = createStatsHandler();
module.exports.createStatsHandler = createStatsHandler;
