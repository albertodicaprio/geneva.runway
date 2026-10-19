const { renderNotification } = require('./notification-providers');

const RESET_MS = 5 * 60_000;
const TTL = 5 * 60_000;
const timestamp = value => Number.isFinite(value) && value >= 0;
const validThreshold = value => Number.isInteger(value) && value >= 1 && value <= 100;
function validBusyAlert(value) {
    return Boolean(value && typeof value.active === 'boolean' && timestamp(value.lastCheckedAt) &&
        (value.belowSince === null || timestamp(value.belowSince)) &&
        (value.pending === null || (value.active && validThreshold(value.pending.threshold) &&
            Number.isInteger(value.pending.count) && value.pending.count > value.pending.threshold &&
            timestamp(value.pending.createdAt) && timestamp(value.pending.expiresAt) &&
            value.pending.expiresAt > value.pending.createdAt && timestamp(value.pending.nextAttemptAt) &&
            Number.isInteger(value.pending.attempts) && value.pending.attempts >= 0 && value.pending.attempts <= 3)));
}

function advanceBusyAlert(previous, snapshot, threshold, now) {
    const state = structuredClone(previous || { active: false, belowSince: null, pending: null, lastCheckedAt: now });
    if (now < state.lastCheckedAt || now - state.lastCheckedAt >= 120_000) state.belowSince = null;
    state.lastCheckedAt = now;
    const fresh = snapshot?.stale === false && Number.isInteger(snapshot.count) && snapshot.count >= 0 &&
        timestamp(snapshot.observedAt) && snapshot.observedAt <= now && now - snapshot.observedAt < 120_000;
    if (!fresh) {
        state.belowSince = null;
        state.pending = null;
        return state;
    }
    if (snapshot.count > threshold) {
        state.belowSince = null;
        if (!state.active) {
            state.active = true;
            state.pending = { count: snapshot.count, threshold, createdAt: now, expiresAt: now + TTL,
                attempts: 0, nextAttemptAt: now };
        }
    } else {
        state.pending = null;
        state.belowSince ??= now;
        if (now - state.belowSince >= RESET_MS) state.active = false;
    }
    if (state.pending?.expiresAt <= now || state.pending?.attempts >= 3) state.pending = null;
    return state;
}

function createBusyArrivalAlerts({ store, client, arrivals, serialize, clock = Date.now, logger = console,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    let active = false;
    let timer;
    let running;
    async function check(continueWork = () => true) {
        const users = Object.entries((await store.read()).accounts)
            .filter(([, account]) => account.alerts?.busyArrivals === true && !account.blocked).map(([id]) => id);
        if (!users.length || !continueWork()) return;
        const snapshot = await arrivals();
        for (const id of users) {
            if (!continueWork()) return;
            await serialize(async () => {
                const account = (await store.read()).accounts[id];
                if (!continueWork() || !account || account.blocked || account.alerts?.busyArrivals !== true) return;
                const now = clock();
                const threshold = account.alerts.busyArrivalThreshold ?? 10;
                const state = advanceBusyAlert(account.busyAlert, snapshot, threshold, now);
                // Update the count in retries to describe the current busy period.
                if (state.pending) state.pending.count = snapshot.count;
                if (JSON.stringify(state) !== JSON.stringify(account.busyAlert)) {
                    await store.update(accounts => { accounts[id].busyAlert = state; });
                }
                const pending = state.pending;
                if (!pending || pending.nextAttemptAt > now || (account.nextSendAt || 0) > now || !continueWork()) return;
                pending.nextAttemptAt = now + 60_000 * 2 ** pending.attempts;
                pending.attempts++;
                await store.update(accounts => {
                    accounts[id].busyAlert = state;
                    accounts[id].nextSendAt = now + 10_000;
                });
                try {
                    await client.sendMessage(account.chatId, renderNotification('busyArrivals', pending));
                    await store.update(accounts => { accounts[id].busyAlert.pending = null; });
                } catch (error) {
                    if (error.code === 403) {
                        await store.update(accounts => { accounts[id].blocked = true; accounts[id].busyAlert.pending = null; });
                    } else if (error.code === 429) {
                        const retry = Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 ? error.retryAfter : 30;
                        await store.update(accounts => {
                            accounts[id].busyAlert.pending.nextAttemptAt = now + retry * 1000;
                            accounts[id].nextSendAt = now + retry * 1000;
                        });
                    }
                    logger.warn?.('Could not confirm Telegram busy arrival alert delivery; pending attempts are bounded and expire.');
                }
            });
        }
    }
    function start() {
        if (active) return;
        active = true;
        const tick = () => {
            running = check(() => active).catch(() => {
                logger.warn?.('Could not evaluate Telegram busy arrival alerts; will retry.');
            }).finally(() => {
                if (active) { timer = schedule(tick, 60_000); timer?.unref?.(); }
            });
        };
        tick();
    }
    async function stop() { active = false; cancel(timer); await running; }
    return { check, start, stop };
}
module.exports = { createBusyArrivalAlerts, advanceBusyAlert, validBusyAlert, validThreshold };
