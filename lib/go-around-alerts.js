const { renderNotification } = require('./notification-providers');
const { advanceGoAroundAlert } = require('./go-around-detector');

function createGoAroundAlerts({ store, client, arrivals, serialize, clock = Date.now, logger = console,
    schedule = setTimeout, cancel = clearTimeout, subscribe = () => () => {},
    sendNotification = ({ connection, text }) => client.sendMessage(connection.chatId, text) } = {}) {
    let active = false;
    let timer;
    let running;
    let unsubscribe;
    let again = false;
    async function check(continueWork = () => true) {
        const users = Object.entries((await store.read()).accounts)
            .filter(([, account]) => account.alerts?.goArounds === true && !account.blocked).map(([id]) => id);
        if (!users.length || !continueWork()) return;
        const snapshot = await arrivals();
        for (const id of users) {
            if (!continueWork()) return;
            await serialize(async () => {
                const account = (await store.read()).accounts[id];
                if (!continueWork() || !account || account.blocked || account.alerts?.goArounds !== true) return;
                const now = clock();
                const state = advanceGoAroundAlert(account.goAroundAlert, snapshot, now);
                await store.update(accounts => { accounts[id].goAroundAlert = state; });
                const flight = state.flights.filter(item => item.pending && item.pending.nextAttemptAt <= now)
                    .sort((a, b) => a.pending.createdAt - b.pending.createdAt || a.id.localeCompare(b.id))[0];
                if (!flight || (account.nextSendAt || 0) > now || !continueWork()) return;
                const pending = flight.pending;
                pending.nextAttemptAt = now + 60_000 * 2 ** pending.attempts;
                pending.attempts++;
                await store.update(accounts => {
                    accounts[id].goAroundAlert = state;
                    accounts[id].nextSendAt = now + 10_000;
                });
                try {
                    await sendNotification({ accountId: id, connection: account, type: 'goArounds',
                        text: renderNotification('goArounds', { callsign: flight.callsign, runway: pending.runway }) });
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
                    logger.warn?.('Could not confirm Telegram go-around alert delivery; pending attempts are bounded and expire.');
                }
                await store.update(accounts => { accounts[id].goAroundAlert = state; });
            });
        }
    }
    function tick() {
        if (!active) return;
        if (running) { again = true; return; }
        cancel(timer);
        running = check(() => active).catch(() => {
            logger.warn?.('Could not evaluate Telegram go-around alerts; will retry.');
        }).finally(() => {
            running = null;
            if (!active) return;
            if (again) { again = false; tick(); }
            else { timer = schedule(tick, 30_000); timer?.unref?.(); }
        });
    }
    function start() {
        if (active) return;
        active = true;
        unsubscribe = subscribe(tick);
        tick();
    }
    async function stop() { active = false; unsubscribe?.(); cancel(timer); await running; }
    return { check, start, stop };
}
module.exports = { createGoAroundAlerts };
