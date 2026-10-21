const fs = require('fs/promises');
const path = require('path');

const RETENTION_SECONDS = 24 * 60 * 60;
const WINDOW_SECONDS = 2 * 60 * 60;
const GAP_SECONDS = 120;

// Independent of the live trail cache and the longer-lived Stats summaries.
function createPathHistory({ file = null, storage = fs, clock = Date.now } = {}) {
    let sessions = null;
    let queue = Promise.resolve();
    function serial(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    async function load() {
        if (sessions) return;
        try {
            const saved = file ? JSON.parse(await storage.readFile(file, 'utf8')) : { version: 1, sessions: [] };
            if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error('Invalid path archive');
            sessions = saved.sessions;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            sessions = [];
        }
    }
    function prune() {
        const cutoff = Math.floor(clock() / 1000) - RETENTION_SECONDS;
        for (const session of sessions) session.points = session.points.filter(point => point.timestamp >= cutoff);
        sessions = sessions.filter(session => session.points.length);
    }
    async function save() {
        if (!file) return;
        await storage.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await storage.writeFile(temporary, JSON.stringify({ version: 1, sessions }));
        await storage.rename(temporary, file);
    }
    function recordSnapshot(snapshot) {
        return serial(async () => {
            await load();
            prune();
            const now = Math.floor(clock() / 1000);
            const arrivals = new Set((snapshot.aircraft || []).map(item => item.icao24));
            const latest = new Map(sessions.map(session => [session.identity, session]));
            for (const aircraft of [...(snapshot.generalTraffic || []), ...(snapshot.aircraft || [])]) {
                const timestamp = aircraft.lastPositionUpdate;
                if (!aircraft.icao24 || aircraft.onGround || ![timestamp, aircraft.latitude, aircraft.longitude].every(Number.isFinite)
                    || timestamp > now || now - timestamp >= GAP_SECONDS) continue;
                const identity = `${aircraft.icao24.toLowerCase()}:${String(aircraft.callsign || '').trim().toUpperCase()}`;
                let session = latest.get(identity);
                if (session && timestamp <= session.points.at(-1).timestamp) continue;
                if (!session || timestamp - session.points.at(-1).timestamp >= GAP_SECONDS) {
                    session = { identity, id: `${identity}:${timestamp}`, points: [] };
                    sessions.push(session);
                    latest.set(identity, session);
                }
                const { track, ...details } = aircraft;
                session.details = details;
                session.points.push({ timestamp, latitude: aircraft.latitude, longitude: aircraft.longitude,
                    altitude: aircraft.altitude, heading: aircraft.heading, velocity: aircraft.velocity,
                    verticalRate: aircraft.verticalRate, category: arrivals.has(aircraft.icao24) ? 'arrival' : 'other',
                    color: track?.color || '#00bfff' });
            }
            await save();
        });
    }
    function read(at = null) {
        return serial(async () => {
            await load();
            const before = sessions.reduce((sum, session) => sum + session.points.length, 0);
            prune();
            if (sessions.reduce((sum, session) => sum + session.points.length, 0) !== before) await save();
            const now = Math.floor(clock() / 1000);
            const availableFrom = sessions.length ? Math.min(...sessions.map(session => session.points[0].timestamp)) : null;
            const result = { availableFrom, availableTo: now, retentionSeconds: RETENTION_SECONDS, windowSeconds: WINDOW_SECONDS };
            if (at === null) return result;
            const aircraft = [], generalTraffic = [];
            for (const session of sessions) {
                const points = session.points.filter(point => point.timestamp >= at - WINDOW_SECONDS && point.timestamp <= at);
                if (!points.length) continue;
                const last = points.at(-1);
                const item = { ...session.details, ...last, icao24: session.id,
                    callsign: session.details.callsign || session.details.icao24,
                    lastPositionUpdate: last.timestamp, lastContact: last.timestamp,
                    historicalActive: at - last.timestamp < GAP_SECONDS,
                    track: { color: last.color, points } };
                (last.category === 'arrival' ? aircraft : generalTraffic).push(item);
            }
            return { ...result, historical: true, updatedAt: at, aircraft, generalTraffic, recentTracks: [] };
        });
    }
    return { recordSnapshot, read };
}

module.exports = { createPathHistory, RETENTION_SECONDS, WINDOW_SECONDS };
