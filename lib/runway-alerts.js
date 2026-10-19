const { renderNotification } = require('./notification-providers');

const RETENTION = 2 * 60 * 60_000;
const DELIVERY_TTL = 15 * 60_000;
const known = direction => ['04', '22'].includes(direction);
const timestamp = value => Number.isFinite(value) && value >= 0;
const observation = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value);

function validWeatherAlert(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const { state, pending } = value;
    if (state !== null && (!state || !known(state.baseline) || !observation(state.observation) ||
        !timestamp(state.reportAt) || (state.candidate !== null && !known(state.candidate)) ||
        (state.lastAlertAt !== null && !timestamp(state.lastAlertAt)))) return false;
    return pending === null || Boolean(pending && state && known(pending.from) && known(pending.to) &&
        pending.from !== pending.to && pending.to === state.baseline && observation(pending.observation) &&
        timestamp(pending.createdAt) && timestamp(pending.expiresAt) && pending.expiresAt > pending.createdAt &&
        Number.isInteger(pending.attempts) && pending.attempts >= 0 && pending.attempts <= 3 && timestamp(pending.nextAttemptAt));
}

function validRunwayAlert(value) {
    // Keep existing opt-ins readable while resetting old weather-based state.
    if (value?.state?.source !== 'arrivals') return validWeatherAlert(value);
    const { state, pending } = value;
    const flight = item => item && typeof item.id === 'string' && typeof item.icao24 === 'string' &&
        typeof item.callsign === 'string' && timestamp(item.estimatedLandingAt) && known(item.direction);
    return (state.baseline === null || known(state.baseline)) && timestamp(state.lastArrivalAt) &&
        (state.candidate === null || flight(state.candidate)) && Array.isArray(state.processed) &&
        state.processed.length <= 512 && state.processed.every(item => typeof item.id === 'string' && timestamp(item.at)) &&
        (pending === null || Boolean(pending && known(pending.from) && pending.to === state.baseline &&
            pending.from !== pending.to && Array.isArray(pending.confirmedBy) && pending.confirmedBy.length === 2 &&
            pending.confirmedBy.every(flight) && timestamp(pending.createdAt) && timestamp(pending.expiresAt) &&
            Number.isInteger(pending.attempts) && pending.attempts >= 0 && pending.attempts <= 3 && timestamp(pending.nextAttemptAt)));
}

// Process each distinct completed arrival once, in order. Two matching arrivals
// establish a runway; an opposite/unknown arrival breaks the candidate pair.
function advanceRunwayAlert(previous, snapshot, now, reset = false) {
    const initial = reset || previous?.source !== 'arrivals';
    const state = initial ? { source: 'arrivals', baseline: previous?.source === 'arrivals' ? previous.baseline : null,
        candidate: null, lastArrivalAt: 0, processed: [] } : structuredClone(previous);
    if (snapshot?.stale !== false || !Array.isArray(snapshot.arrivals)) {
        state.candidate = null;
        return { state, event: null, direction: null };
    }
    state.processed = state.processed.filter(item => now - item.at < RETENTION);
    const processed = new Set(state.processed.map(item => item.id));
    let event = null;
    const flights = snapshot.arrivals.filter(flight => typeof flight.id === 'string' && typeof flight.icao24 === 'string' &&
        typeof flight.callsign === 'string' && timestamp(flight.estimatedLandingAt) &&
        flight.estimatedLandingAt <= now && now - flight.estimatedLandingAt < RETENTION)
        .sort((a, b) => a.estimatedLandingAt - b.estimatedLandingAt || a.id.localeCompare(b.id));
    for (const flight of flights) {
        if (processed.has(flight.id) || flight.estimatedLandingAt < state.lastArrivalAt) continue;
        processed.add(flight.id);
        state.processed.push({ id: flight.id, at: flight.estimatedLandingAt });
        state.lastArrivalAt = flight.estimatedLandingAt;
        if (!known(flight.direction)) { state.candidate = null; continue; }
        const candidate = state.candidate;
        if (candidate?.direction === flight.direction && candidate.icao24 !== flight.icao24 &&
            now - candidate.estimatedLandingAt < RETENTION) {
            if (!initial && state.baseline && state.baseline !== flight.direction) {
                event = { from: state.baseline, to: flight.direction, confirmedBy: [candidate, flight],
                    createdAt: now, expiresAt: Math.min(now, flight.estimatedLandingAt) + DELIVERY_TTL,
                    attempts: 0, nextAttemptAt: now };
            }
            state.baseline = flight.direction;
        }
        state.candidate = flight;
    }
    state.processed = state.processed.slice(-512);
    return { state, event, direction: state.baseline };
}

function createRunwayAlerts({ store, client, arrivals, serialize, clock = Date.now, logger = console,
    schedule = setTimeout, cancel = clearTimeout,
    sendNotification = ({ connection, text }) => client.sendMessage(connection.chatId, text) } = {}) {
    const seen = new Set();
    let active = false;
    let timer;
    let running;

    async function check(continueWork = () => true) {
        const users = Object.entries((await store.read()).accounts)
            .filter(([, account]) => account.alerts?.predictedRunwayChanges === true && !account.blocked)
            .map(([id]) => id);
        if (!users.length || !continueWork()) return;
        const snapshot = await arrivals();
        for (const id of users) {
            if (!continueWork()) return;
            await serialize(async () => {
                const account = (await store.read()).accounts[id];
                if (!continueWork() || !account || account.blocked || account.alerts?.predictedRunwayChanges !== true) return;
                const now = clock();
                const result = advanceRunwayAlert(account.runwayAlert?.state, snapshot, now, !seen.has(id));
                let pending = result.event || account.runwayAlert?.pending || null;
                // Restart, stale data, confirmed reversals and expired
                // alerts must not produce a delayed burst of old notifications.
                if (!seen.has(id) || !result.direction || pending?.to !== result.direction ||
                    pending?.expiresAt <= now || pending?.attempts >= 3) pending = null;
                const saved = { state: result.state, pending };
                if (JSON.stringify(account.runwayAlert) !== JSON.stringify(saved)) {
                    await store.update(accounts => { accounts[id].runwayAlert = saved; });
                }
                if (snapshot?.stale === false) seen.add(id);
                if (!pending || pending.nextAttemptAt > now || (account.nextSendAt || 0) > now || !continueWork()) return;
                // Persist the attempt before delivery. The bounded retry can
                // duplicate a message if Telegram accepted a timed-out request.
                pending = { ...pending, attempts: pending.attempts + 1,
                    nextAttemptAt: now + 60_000 * 2 ** pending.attempts };
                await store.update(accounts => {
                    accounts[id].runwayAlert.pending = pending;
                    accounts[id].nextSendAt = now + 10_000;
                });
                try {
                    await sendNotification({ accountId: id, connection: account, type: 'arrivalRunwayChange',
                        text: renderNotification('arrivalRunwayChange', pending) });
                    await store.update(accounts => { accounts[id].runwayAlert.pending = null; });
                } catch (error) {
                    if (error.code === 403) {
                        await store.update(accounts => {
                            accounts[id].blocked = true;
                            accounts[id].runwayAlert.pending = null;
                        });
                    } else if (error.code === 429) {
                        const retry = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 30;
                        await store.update(accounts => {
                            accounts[id].runwayAlert.pending.nextAttemptAt = now + retry * 1000;
                            accounts[id].nextSendAt = now + retry * 1000;
                        });
                    }
                    logger.warn?.('Could not confirm Telegram runway alert delivery; pending attempts are bounded and expire.');
                }
            });
        }
    }
    function start() {
        if (active) return;
        active = true;
        const tick = () => {
            running = check(() => active).catch(() => {
                logger.warn?.('Could not evaluate Telegram runway alerts; will retry.');
            }).finally(() => {
                if (active) { timer = schedule(tick, 60_000); timer?.unref?.(); }
            });
        };
        tick();
    }
    async function stop() {
        active = false;
        cancel(timer);
        await running;
    }
    return { check, start, stop };
}

module.exports = { advanceRunwayAlert, createRunwayAlerts, validRunwayAlert };
