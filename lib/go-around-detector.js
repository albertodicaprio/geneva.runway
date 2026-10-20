// Approximate geometry from OurAirports' LSGG runway record (2026-10-20):
// https://github.com/davidmegginson/ourairports-data/blob/main/runways.csv
// 04 uses the landing threshold displaced 330 m from the southwest runway end.
const RUNWAYS = [
    { direction: '04', latitude: 46.227861, longitude: 6.094011, heading: 46, elevation: 430 },
    { direction: '22', latitude: 46.250401, longitude: 6.12699, heading: 226, elevation: 416 }
];
const FRESH_MS = 120_000;
const TTL = 5 * 60_000;
const finite = Number.isFinite;
const timestamp = value => finite(value) && value >= 0;
const direction = value => value === '04' || value === '22';
function validSample(value) {
    return Boolean(value && timestamp(value.observedAt) && finite(value.latitude) && Math.abs(value.latitude) <= 90 &&
        finite(value.longitude) && Math.abs(value.longitude) <= 180 && finite(value.altitude) &&
        finite(value.heading) && value.heading >= 0 && value.heading < 360 && finite(value.verticalRate) &&
        typeof value.onGround === 'boolean');
}
function geometry(sample, runway) {
    const radians = Math.PI / 180;
    const north = (sample.latitude - runway.latitude) * 111.195;
    const east = (sample.longitude - runway.longitude) * 111.195 * Math.cos(runway.latitude * radians);
    const heading = runway.heading * radians;
    return { distance: Math.hypot(east, north), before: -(east * Math.sin(heading) + north * Math.cos(heading)),
        cross: Math.abs(east * Math.cos(heading) - north * Math.sin(heading)) };
}
function approachGate(sample) {
    if (!validSample(sample) || sample.onGround) return null;
    for (const runway of RUNWAYS) {
        const position = geometry(sample, runway);
        const alignment = Math.abs(((sample.heading - runway.heading + 540) % 360) - 180);
        const height = sample.altitude - runway.elevation;
        if (position.before > 0 && position.distance <= 8 && position.cross <= 1 && alignment <= 25 &&
            height >= -100 && height < 600) return { direction: runway.direction, ...position };
    }
    return null;
}
function validGoAroundAlert(value) {
    return Boolean(value && timestamp(value.lastCheckedAt) && Array.isArray(value.flights) && value.flights.length <= 1000 &&
        new Set(value.flights.map(f => f?.id)).size === value.flights.length && value.flights.every(f =>
            f && typeof f.id === 'string' && f.id.length > 0 && typeof f.callsign === 'string' &&
            timestamp(f.lastSeenAt) && validSample(f.previous) && f.previous.observedAt === f.lastSeenAt &&
            ['idle', 'armed', 'alerted'].includes(f.phase) && typeof f.departed === 'boolean' &&
            (f.runway === null || direction(f.runway)) && (f.lowAltitude === null || finite(f.lowAltitude)) &&
            (f.armedAt === null || timestamp(f.armedAt)) && Number.isInteger(f.climbs) && f.climbs >= 0 && f.climbs <= 2 &&
            (f.climbStartedAt === null || timestamp(f.climbStartedAt)) &&
            (f.phase !== 'armed' || (direction(f.runway) && finite(f.lowAltitude) && timestamp(f.armedAt))) &&
            (f.climbs === 0 || timestamp(f.climbStartedAt)) &&
            (f.pending === null || (f.phase === 'alerted' && direction(f.pending.runway) && timestamp(f.pending.createdAt) &&
                timestamp(f.pending.expiresAt) && f.pending.expiresAt > f.pending.createdAt &&
                timestamp(f.pending.nextAttemptAt) && Number.isInteger(f.pending.attempts) &&
                f.pending.attempts >= 0 && f.pending.attempts <= 3))));
}
function resetAttempt(flight) {
    flight.phase = 'idle'; flight.runway = null; flight.lowAltitude = null; flight.armedAt = null;
    flight.climbs = 0; flight.climbStartedAt = null; flight.pending = null;
}
function advanceGoAroundAlert(previous, snapshot, now) {
    const state = structuredClone(previous || { lastCheckedAt: now, flights: [] });
    const gap = now < state.lastCheckedAt || now - state.lastCheckedAt >= FRESH_MS;
    state.lastCheckedAt = now;
    const fresh = snapshot?.stale === false && timestamp(snapshot.observedAt) && snapshot.observedAt <= now &&
        now - snapshot.observedAt < FRESH_MS && Array.isArray(snapshot.arrivals);
    const live = new Map((fresh ? snapshot.arrivals : []).filter(sample => typeof sample?.id === 'string' && sample.id &&
        typeof sample.callsign === 'string' && validSample(sample) && !sample.onGround &&
        sample.observedAt <= now && now - sample.observedAt < FRESH_MS).map(sample => [sample.id, sample]));
    state.flights = state.flights.filter(f => now >= f.lastSeenAt && now - f.lastSeenAt < 2 * 60 * 60_000 &&
        (live.has(f.id) || f.phase === 'alerted'));
    const byId = new Map(state.flights.map(f => [f.id, f]));
    for (const f of state.flights) if (!live.has(f.id)) f.pending = null;
    for (const sample of live.values()) {
        let f = byId.get(sample.id);
        if (!f) {
            f = { id: sample.id, callsign: sample.callsign, lastSeenAt: sample.observedAt, previous: sample,
                phase: 'idle', runway: null, lowAltitude: null, armedAt: null, climbs: 0,
                climbStartedAt: null, departed: false, pending: null };
            state.flights.push(f);
            continue;
        }
        const old = f.previous;
        const discontinuity = gap || sample.observedAt < f.lastSeenAt || sample.observedAt - f.lastSeenAt >= FRESH_MS;
        if (discontinuity) {
            f.pending = null;
            if (f.phase !== 'alerted') resetAttempt(f);
        }
        if (!discontinuity && sample.observedAt > f.lastSeenAt) {
            const gate = approachGate(sample);
            const oldGate = approachGate(old);
            const descending = gate && oldGate?.direction === gate.direction && sample.verticalRate <= -1 &&
                old.altitude - sample.altitude >= 20 && oldGate.before - gate.before >= 0.1;
            if (f.phase === 'alerted' && !gate) f.departed = true;
            if (descending && (f.phase !== 'alerted' || f.departed)) {
                if (f.phase !== 'armed' || f.runway !== gate.direction) resetAttempt(f);
                f.phase = 'armed'; f.runway = gate.direction;
                f.lowAltitude = Math.min(f.lowAltitude ?? sample.altitude, sample.altitude);
                f.armedAt = sample.observedAt;
                f.climbs = 0; f.climbStartedAt = null; f.departed = false;
            } else if (f.phase === 'armed') {
                const runway = RUNWAYS.find(item => item.direction === f.runway);
                if (sample.observedAt - f.armedAt > 3 * 60_000 || geometry(sample, runway).distance > 12) {
                    resetAttempt(f);
                } else {
                    f.lowAltitude = Math.min(f.lowAltitude, sample.altitude);
                    if (sample.verticalRate >= 2.5 && sample.altitude - old.altitude >= 20) {
                        f.climbStartedAt ??= sample.observedAt;
                        f.climbs = Math.min(2, f.climbs + 1);
                    } else { f.climbs = 0; f.climbStartedAt = null; }
                    if (f.climbs >= 2 && sample.observedAt - f.climbStartedAt >= 15_000 && sample.altitude - f.lowAltitude >= 150) {
                        f.phase = 'alerted'; f.departed = !gate;
                        f.pending = { runway: f.runway, createdAt: now, expiresAt: now + TTL, attempts: 0, nextAttemptAt: now };
                    }
                }
            }
        }
        f.callsign = sample.callsign;
        if (discontinuity || sample.observedAt > f.lastSeenAt) {
            f.previous = sample; f.lastSeenAt = sample.observedAt;
        }
        if (f.pending?.expiresAt <= now || f.pending?.attempts >= 3) f.pending = null;
    }
    state.flights = state.flights.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 1000);
    return state;
}
module.exports = { RUNWAYS, approachGate, advanceGoAroundAlert, validGoAroundAlert };
