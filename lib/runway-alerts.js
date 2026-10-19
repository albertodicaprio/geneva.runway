const { renderNotification } = require('./notification-providers');

const HOUR = 60 * 60_000;
const MAX_REPORT_GAP = 75 * 60_000;
const DELIVERY_TTL = 15 * 60_000;
const known = direction => ['04', '22'].includes(direction);
const timestamp = value => Number.isFinite(value) && value >= 0;
const observation = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value);

function validRunwayAlert(value) {
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

// Confirm changes with distinct provider observations, never repeated reads of
// one cached report. Leave the shared weather/runway heuristic unchanged.
function advanceRunwayAlert(previous, forecast, now, reset = false) {
    const current = forecast?.current;
    const direction = current?.runway?.direction;
    const fresh = forecast?.stale === false && Number.isFinite(forecast.updatedAt) &&
        forecast.updatedAt <= now && now - forecast.updatedAt < 30 * 60_000 &&
        typeof current?.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(current.time) && known(direction);
    if (!fresh) return { state: previous ? { ...previous, candidate: null } : null, event: null, direction: null };
    const state = previous || {};
    if (reset || !known(state.baseline) || now - state.reportAt > MAX_REPORT_GAP) {
        return { state: { baseline: direction, observation: current.time, reportAt: forecast.updatedAt,
            candidate: null, lastAlertAt: state.lastAlertAt ?? null }, event: null, direction };
    }
    if (current.time <= state.observation) return { state, event: null, direction };
    const next = { ...state, observation: current.time, reportAt: forecast.updatedAt };
    if (direction === state.baseline) return { state: { ...next, candidate: null }, event: null, direction };
    if (state.candidate !== direction || (state.lastAlertAt !== null && now - state.lastAlertAt < HOUR)) {
        return { state: { ...next, candidate: direction }, event: null, direction };
    }
    return { state: { ...next, baseline: direction, candidate: null, lastAlertAt: now }, direction,
        event: { from: state.baseline, to: direction, observation: current.time,
            windSpeed: current.windSpeed, windDirection: current.windDirection,
            windGusts: current.windGusts, createdAt: now, expiresAt: now + DELIVERY_TTL,
            attempts: 0, nextAttemptAt: now } };
}

function createRunwayAlerts({ store, client, weather, serialize, clock = Date.now, logger = console,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    const seen = new Set();
    let active = false;
    let timer;
    let running;

    async function check(continueWork = () => true) {
        const users = Object.entries((await store.read()).accounts)
            .filter(([, account]) => account.alerts?.predictedRunwayChanges === true && !account.blocked)
            .map(([id]) => id);
        if (!users.length || !continueWork()) return;
        const forecast = await weather.getForecast();
        for (const id of users) {
            if (!continueWork()) return;
            await serialize(async () => {
                const account = (await store.read()).accounts[id];
                if (!continueWork() || !account || account.blocked || account.alerts?.predictedRunwayChanges !== true) return;
                const now = clock();
                const result = advanceRunwayAlert(account.runwayAlert?.state, forecast, now, !seen.has(id));
                let pending = result.event || account.runwayAlert?.pending || null;
                // Restart, stale data, unknown predictions, reversals and expired
                // alerts must not produce a delayed burst of old notifications.
                if (!seen.has(id) || !result.direction || pending?.to !== result.direction ||
                    pending?.expiresAt <= now || pending?.attempts >= 3) pending = null;
                const saved = { state: result.state, pending };
                if (JSON.stringify(account.runwayAlert) !== JSON.stringify(saved)) {
                    await store.update(accounts => { accounts[id].runwayAlert = saved; });
                }
                if (result.direction) seen.add(id);
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
                    await client.sendMessage(account.chatId, renderNotification('predictedRunwayChange', pending));
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
