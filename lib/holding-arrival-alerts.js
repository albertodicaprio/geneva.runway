const { renderNotification } = require('./notification-providers');

const MIN_DURATION = 25 * 60_000;
const FRESH_MS = 120_000;
const RETENTION_MS = 2 * 60 * 60_000;
const TTL = 5 * 60_000;
const timestamp = value => Number.isFinite(value) && value >= 0;

function validHoldingAlert(value) {
    return Boolean(value && timestamp(value.lastCheckedAt) && Array.isArray(value.flights) && value.flights.length <= 1000 &&
        new Set(value.flights.map(flight => flight?.id)).size === value.flights.length && value.flights.every(flight =>
            flight && typeof flight.id === 'string' && flight.id.length > 0 && typeof flight.callsign === 'string' &&
            timestamp(flight.firstSeenAt) && timestamp(flight.lastSeenAt) && flight.lastSeenAt >= flight.firstSeenAt &&
            typeof flight.alerted === 'boolean' && (flight.pending === null || (flight.alerted &&
                timestamp(flight.pending.createdAt) && timestamp(flight.pending.expiresAt) &&
                flight.pending.expiresAt > flight.pending.createdAt && timestamp(flight.pending.nextAttemptAt) &&
                Number.isInteger(flight.pending.attempts) && flight.pending.attempts >= 0 && flight.pending.attempts <= 3))));
}

function advanceHoldingAlert(previous, snapshot, now) {
    const state = structuredClone(previous || { lastCheckedAt: now, flights: [] });
    const gap = now < state.lastCheckedAt || now - state.lastCheckedAt >= FRESH_MS;
    state.lastCheckedAt = now;
    const fresh = snapshot?.stale === false && timestamp(snapshot.observedAt) && snapshot.observedAt <= now &&
        now - snapshot.observedAt < FRESH_MS && Array.isArray(snapshot.arrivals);
    const live = new Map((fresh ? snapshot.arrivals : []).filter(flight =>
        typeof flight?.id === 'string' && flight.id && typeof flight.callsign === 'string' &&
        timestamp(flight.observedAt) && flight.observedAt <= now && now - flight.observedAt < FRESH_MS)
        .map(flight => [flight.id, flight]));
    // Retain alerted identities through short disappearances; unsent dwell time
    // must start over when an aircraft disappears or monitoring goes stale.
    state.flights = state.flights.filter(flight => now >= flight.lastSeenAt &&
        now - flight.lastSeenAt < RETENTION_MS && (live.has(flight.id) || flight.alerted));
    const byId = new Map(state.flights.map(flight => [flight.id, flight]));
    for (const flight of state.flights) {
        if (!live.has(flight.id) || gap) flight.pending = null;
    }
    for (const current of live.values()) {
        let flight = byId.get(current.id);
        if (!flight) {
            flight = { id: current.id, callsign: current.callsign, firstSeenAt: current.observedAt,
                lastSeenAt: current.observedAt, alerted: false, pending: null };
            state.flights.push(flight);
        }
        if (gap || current.observedAt < flight.lastSeenAt || current.observedAt - flight.lastSeenAt >= FRESH_MS) {
            flight.firstSeenAt = current.observedAt;
            flight.pending = null;
        }
        flight.lastSeenAt = current.observedAt;
        flight.callsign = current.callsign;
        if (!flight.alerted && flight.lastSeenAt - flight.firstSeenAt > MIN_DURATION) {
            // Consume before delivery: failed/expired sends cannot create a new
            // event every minute. Retries of this event remain bounded.
            flight.alerted = true;
            flight.pending = { createdAt: now, expiresAt: now + TTL, attempts: 0, nextAttemptAt: now };
        }
        if (flight.pending?.expiresAt <= now || flight.pending?.attempts >= 3) flight.pending = null;
    }
    state.flights = state.flights.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 1000);
    return state;
}

function createHoldingArrivalAlerts({ store, client, arrivals, serialize, clock = Date.now, logger = console,
    schedule = setTimeout, cancel = clearTimeout,
    sendNotification = ({ connection, text }) => client.sendMessage(connection.chatId, text) } = {}) {
    let active = false;
    let timer;
    let running;
    async function check(continueWork = () => true) {
        const users = Object.entries((await store.read()).accounts)
            .filter(([, account]) => account.alerts?.holdingArrivals === true && !account.blocked).map(([id]) => id);
        if (!users.length || !continueWork()) return;
        const snapshot = await arrivals();
        for (const id of users) {
            if (!continueWork()) return;
            await serialize(async () => {
                const account = (await store.read()).accounts[id];
                if (!continueWork() || !account || account.blocked || account.alerts?.holdingArrivals !== true) return;
                const now = clock();
                const state = advanceHoldingAlert(account.holdingAlert, snapshot, now);
                await store.update(accounts => { accounts[id].holdingAlert = state; });
                const flight = state.flights.filter(item => item.pending && item.pending.nextAttemptAt <= now)
                    .sort((a, b) => a.pending.createdAt - b.pending.createdAt || a.id.localeCompare(b.id))[0];
                if (!flight || (account.nextSendAt || 0) > now || !continueWork()) return;
                const pending = flight.pending;
                pending.nextAttemptAt = now + 60_000 * 2 ** pending.attempts;
                pending.attempts++;
                await store.update(accounts => {
                    accounts[id].holdingAlert = state;
                    accounts[id].nextSendAt = now + 10_000;
                });
                try {
                    await sendNotification({ accountId: id, connection: account, type: 'holdingArrivals',
                        text: renderNotification('holdingArrivals', flight) });
                    flight.pending = null;
                } catch (error) {
                    if (error.code === 403) {
                        await store.update(accounts => { accounts[id].blocked = true; });
                        for (const item of state.flights) item.pending = null;
                    } else if (error.code === 429) {
                        const retry = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 30;
                        pending.nextAttemptAt = now + retry * 1000;
                        await store.update(accounts => { accounts[id].nextSendAt = now + retry * 1000; });
                    }
                    logger.warn?.('Could not confirm Telegram holding alert delivery; pending attempts are bounded and expire.');
                }
                await store.update(accounts => { accounts[id].holdingAlert = state; });
            });
        }
    }
    function start() {
        if (active) return;
        active = true;
        const tick = () => {
            running = check(() => active).catch(() => {
                logger.warn?.('Could not evaluate Telegram holding alerts; will retry.');
            }).finally(() => {
                if (active) { timer = schedule(tick, 60_000); timer?.unref?.(); }
            });
        };
        tick();
    }
    async function stop() { active = false; cancel(timer); await running; }
    return { check, start, stop };
}
module.exports = { createHoldingArrivalAlerts, advanceHoldingAlert, validHoldingAlert };
