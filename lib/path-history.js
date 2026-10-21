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
            const arrivals = new Set([...(snapshot.aircraft || []), ...(snapshot.recentTracks || [])]
                .map(item => item.icao24));
            const byIdentity = new Map();
            for (const session of sessions) {
                if (!byIdentity.has(session.identity)) byIdentity.set(session.identity, []);
                byIdentity.get(session.identity).push(session);
            }
            const incoming = new Map([...(snapshot.recentTracks || []), ...(snapshot.generalTraffic || []),
                ...(snapshot.aircraft || [])].map(aircraft => [aircraft.icao24, aircraft]));
            for (const aircraft of incoming.values()) {
                if (!aircraft.icao24 || aircraft.onGround) continue;
                const identity = `${aircraft.icao24.toLowerCase()}:${String(aircraft.callsign || '').trim().toUpperCase()}`;
                const previous = byIdentity.get(identity) || [];
                const category = arrivals.has(aircraft.icao24) ? 'arrival' : 'other';
                const color = aircraft.track?.color || '#00bfff';
                // The live cache can predate the archive, including aircraft already gone.
                // Import its recorded coordinates without inventing past flight measurements.
                const observations = new Map((aircraft.track?.points || [])
                    .filter(point => [point.timestamp, point.latitude, point.longitude].every(Number.isFinite)
                        && point.timestamp >= now - RETENTION_SECONDS && point.timestamp <= now)
                    .map(point => [point.timestamp, { timestamp: point.timestamp, latitude: point.latitude,
                        longitude: point.longitude, altitude: null, heading: null, velocity: null,
                        verticalRate: null, category, color, imported: true }]));
                const timestamp = aircraft.lastPositionUpdate;
                if ([timestamp, aircraft.latitude, aircraft.longitude].every(Number.isFinite)
                    && timestamp <= now && now - timestamp < GAP_SECONDS) {
                    observations.set(timestamp, { timestamp, latitude: aircraft.latitude, longitude: aircraft.longitude,
                        altitude: aircraft.altitude, heading: aircraft.heading, velocity: aircraft.velocity,
                        verticalRate: aircraft.verticalRate, category, color });
                }
                if (!observations.size) continue;
                // Prefer the archive's actual observations over sparse cached trail points.
                for (const session of previous) for (const point of session.points) {
                    const candidate = observations.get(point.timestamp);
                    if (!candidate || candidate.imported || !point.imported) observations.set(point.timestamp, point);
                }
                const { track, ...details } = aircraft;
                const rebuilt = [];
                let session;
                for (const point of [...observations.values()].sort((a, b) => a.timestamp - b.timestamp)) {
                    if (!session || point.timestamp - session.points.at(-1).timestamp >= GAP_SECONDS) {
                        session = { identity, id: `${identity}:${point.timestamp}`, details, points: [] };
                        rebuilt.push(session);
                    }
                    session.points.push(point);
                }
                byIdentity.set(identity, rebuilt);
            }
            sessions = [...byIdentity.values()].flat();
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
