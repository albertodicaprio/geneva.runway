const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const flush = () => new Promise(resolve => setImmediate(resolve));
function browser({ configured = true, connected = false } = {}) {
    const nodes = {};
    for (const id of ['accountMenu', 'telegramStatus', 'telegramAccount', 'telegramConnect', 'telegramDisconnect',
        'telegramTest', 'telegramLinkPanel', 'telegramLink', 'telegramQr', 'telegramExpiry', 'telegramMessage', 'predictedRunwayAlerts', 'busyArrivalAlerts', 'busyArrivalThreshold', 'busyArrivalThresholdSave', 'holdingArrivalAlerts', 'goAroundAlerts']) {
        nodes[id] = { hidden: true, disabled: false, textContent: '', handlers: {},
            addEventListener(name, fn) { this.handlers[name] = fn; },
            removeAttribute(name) { delete this[name]; }, focus() { document.activeElement = this; } };
    }
    nodes.accountMenu.open = true;
    const document = { documentElement: { dataset: { userId: 'alice' } }, getElementById: id => nodes[id] };
    const events = {};
    const window = { addEventListener(name, fn) { events[name] = fn; }, setInterval(fn) { events.interval = fn; } };
    const requests = [];
    const connection = { name: '<Alice>', username: 'alice', blocked: false };
    let state = { enabled: configured, connection: connected ? connection : null, expiresAt: null, alerts: { predictedRunwayChanges: false } };
    let error;
    let intercept;
    const now = Date.now();
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/telegram.js'), 'utf8'), {
        document, window, Date, encodeURIComponent, fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (intercept) return intercept(url, options);
            if (url === '/api/auth/session') return { ok: true, json: async () => ({ user: { id: document.documentElement.dataset.userId }, csrfToken: 'csrf' }) };
            if (options.method === 'POST') {
                if (error) return { ok: false, status: error.status, json: async () => ({ error: error.message }) };
                if (url.endsWith('/connect')) {
                    state.expiresAt = now + 600_000;
                    return { ok: true, json: async () => ({ url: 'https://t.me/GenevaTestBot?start=secret', expiresAt: state.expiresAt }) };
                }
                if (url.endsWith('/alerts')) {
                    state.alerts = { ...state.alerts, ...JSON.parse(options.body) };
                    return { ok: true, json: async () => ({ alerts: state.alerts }) };
                }
                if (url.endsWith('/disconnect')) state = { ...state, connection: null, expiresAt: null, alerts: { predictedRunwayChanges: false } };
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: true, json: async () => state };
        }
    });
    return { nodes, document, events, requests, connection, state: value => { state = value; },
        error: value => { error = value; }, intercept: fn => { intercept = fn; },
        async open() { await nodes.accountMenu.handlers.toggle(); await flush(); } };
}

test('Telegram menu offers linking by button and QR, then automatically shows the connected account', async () => {
    const b = browser();
    await b.open();
    assert.equal(b.nodes.telegramStatus.textContent, 'Not connected');
    assert.equal(b.nodes.telegramTest.hidden, true);
    assert.equal(b.nodes.telegramConnect.disabled, false);
    await b.nodes.telegramConnect.handlers.click();
    assert.equal(b.nodes.telegramLinkPanel.hidden, false);
    assert.equal(b.nodes.telegramQr.src, '/api/account/telegram/qr');
    assert.match(b.nodes.telegramLink.href, /start=secret/);
    assert.match(b.nodes.telegramStatus.textContent, /Waiting/);
    const connect = b.requests.find(item => item.url.endsWith('/connect'));
    assert.equal(connect.options.headers['X-CSRF-Token'], 'csrf');
    b.state({ enabled: true, connection: b.connection, expiresAt: null });
    b.events.interval();
    await flush();
    assert.equal(b.nodes.telegramStatus.textContent, 'Connected');
    assert.equal(b.nodes.telegramAccount.textContent, '<Alice> (@alice)');
    assert.equal(b.nodes.telegramTest.hidden, false);
    assert.equal(b.nodes.telegramConnect.hidden, true);
    assert.equal(b.nodes.telegramLinkPanel.hidden, true);
    assert.equal(b.nodes.telegramQr.src, undefined);
    assert.equal(b.nodes.telegramLink.href, undefined);
});

test('test messages, visible delivery errors and disconnect work from the app', async () => {
    const b = browser({ connected: true });
    await b.open();
    await b.nodes.telegramTest.handlers.click();
    assert.match(b.nodes.telegramMessage.textContent, /Test message sent/);
    b.error({ status: 429, message: 'Please wait 10 seconds.' });
    await b.nodes.telegramTest.handlers.click();
    assert.match(b.nodes.telegramMessage.textContent, /wait 10 seconds/);
    b.error(null);
    await b.nodes.telegramDisconnect.handlers.click();
    assert.equal(b.nodes.telegramTest.hidden, true);
    assert.equal(b.nodes.telegramConnect.hidden, false);
    assert.equal(b.document.activeElement, b.nodes.telegramConnect);
    assert.match(b.nodes.telegramMessage.textContent, /disconnected/);
});

test('expired or conflicting links clear the QR and explain how to reconnect', async () => {
    const b = browser();
    await b.open();
    await b.nodes.telegramConnect.handlers.click();
    b.state({ enabled: true, connection: null, expiresAt: null });
    b.events.interval();
    await flush();
    assert.equal(b.nodes.telegramLinkPanel.hidden, true);
    assert.match(b.nodes.telegramMessage.textContent, /expired/);
    await b.nodes.telegramConnect.handlers.click();
    b.state({ enabled: true, connection: null, expiresAt: 1, linkError: 'Already connected elsewhere.' });
    b.events.interval();
    await flush();
    assert.equal(b.nodes.telegramQr.src, undefined);
    assert.match(b.nodes.telegramMessage.textContent, /elsewhere/);
});

test('logout clears private linking UI and a late request cannot restore it', async () => {
    const b = browser();
    await b.open();
    await b.nodes.telegramConnect.handlers.click();
    let finish;
    b.intercept(() => new Promise(resolve => { finish = resolve; }));
    b.events.interval();
    await flush();
    b.document.documentElement.dataset.userId = '';
    b.events.authchange();
    assert.equal(b.nodes.telegramQr.src, undefined);
    assert.equal(b.nodes.telegramLink.href, undefined);
    finish({ ok: true, json: async () => ({ enabled: true, connection: b.connection }) });
    await flush();
    assert.equal(b.nodes.telegramAccount.textContent, '');
    assert.equal(b.nodes.telegramTest.hidden, true);
});

test('closed menus do not poll and disabled integration keeps Connect unavailable', async () => {
    const b = browser({ configured: false });
    await b.open();
    assert.equal(b.nodes.telegramConnect.disabled, true);
    assert.match(b.nodes.telegramStatus.textContent, /not configured/);
    b.nodes.accountMenu.open = false;
    const count = b.requests.length;
    b.events.interval();
    await flush();
    assert.equal(b.requests.length, count);
});

test('blocked delivery keeps the account visible while disabling the test action', async () => {
    const b = browser();
    b.state({ enabled: true, connection: { name: 'Alice', username: null, blocked: true } });
    await b.open();
    assert.equal(b.nodes.telegramAccount.textContent, 'Alice');
    assert.equal(b.nodes.telegramTest.disabled, true);
    assert.equal(b.nodes.telegramDisconnect.hidden, false);
    assert.match(b.nodes.telegramStatus.textContent, /delivery unavailable/);
});

test('runway toggle starts off, saves with CSRF, reflects other devices and resets on disconnect', async () => {
    const b = browser({ connected: true });
    await b.open();
    const toggle = b.nodes.predictedRunwayAlerts;
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, false);
    toggle.checked = true;
    await toggle.handlers.change();
    assert.equal(toggle.checked, true);
    const save = b.requests.find(request => request.url.endsWith('/alerts'));
    assert.equal(save.options.method, 'POST');
    assert.equal(save.options.headers['X-CSRF-Token'], 'csrf');
    assert.deepEqual(JSON.parse(save.options.body), { predictedRunwayChanges: true });
    assert.match(b.nodes.telegramMessage.textContent, /baseline/);
    b.state({ enabled: true, connection: b.connection, alerts: { predictedRunwayChanges: false } });
    b.events.interval(); await flush();
    assert.equal(toggle.checked, false);
    await b.nodes.telegramDisconnect.handlers.click();
    assert.equal(toggle.checked, false);
    assert.equal(toggle.disabled, true);
});

test('failed preference saves restore the saved toggle and logout clears it', async () => {
    const b = browser({ connected: true });
    await b.open();
    b.error({ status: 503, message: 'Could not save alert preferences.' });
    b.nodes.predictedRunwayAlerts.checked = true;
    await b.nodes.predictedRunwayAlerts.handlers.change();
    assert.equal(b.nodes.predictedRunwayAlerts.checked, false);
    assert.match(b.nodes.telegramMessage.textContent, /Could not save/);
    b.state({ enabled: true, connection: b.connection, alerts: { predictedRunwayChanges: true } });
    b.events.interval(); await flush();
    assert.equal(b.nodes.predictedRunwayAlerts.checked, true);
    b.document.documentElement.dataset.userId = '';
    b.events.authchange();
    assert.equal(b.nodes.predictedRunwayAlerts.checked, false);
    assert.equal(b.nodes.predictedRunwayAlerts.disabled, true);
});

test('busy arrival controls preserve runway preferences, sync, validate thresholds and restore failed saves', async () => {
    const b = browser({ connected: true });
    b.state({ enabled: true, connection: b.connection, alerts: { predictedRunwayChanges: true, busyArrivals: false, busyArrivalThreshold: 10 } });
    await b.open();
    assert.equal(b.nodes.busyArrivalAlerts.checked, false);
    assert.equal(b.nodes.busyArrivalAlerts.disabled, false);
    assert.equal(b.nodes.busyArrivalThreshold.disabled, true);
    b.nodes.busyArrivalAlerts.checked = true;
    await b.nodes.busyArrivalAlerts.handlers.change();
    const save = b.requests.filter(item => item.url.endsWith('/alerts')).at(-1);
    assert.deepEqual(JSON.parse(save.options.body), { busyArrivals: true });
    assert.equal(save.options.headers['X-CSRF-Token'], 'csrf');
    b.state({ enabled: true, connection: b.connection, alerts: { predictedRunwayChanges: true, busyArrivals: true, busyArrivalThreshold: 12 } });
    await b.open();
    assert.equal(b.nodes.predictedRunwayAlerts.checked, true);
    assert.equal(b.nodes.busyArrivalThreshold.value, 12);
    assert.equal(b.nodes.busyArrivalThreshold.disabled, false);
    b.nodes.busyArrivalThreshold.value = '0';
    b.nodes.busyArrivalThreshold.handlers.input();
    assert.equal(b.nodes.busyArrivalThreshold.value, '0');
    assert.equal(b.nodes.busyArrivalThresholdSave.disabled, true);
    b.nodes.busyArrivalThreshold.value = '15';
    b.nodes.busyArrivalThreshold.handlers.input();
    await b.nodes.busyArrivalThresholdSave.handlers.click();
    assert.deepEqual(JSON.parse(b.requests.filter(item => item.url.endsWith('/alerts')).at(-1).options.body), { busyArrivalThreshold: 15 });
    b.state({ enabled: true, connection: b.connection, alerts: { predictedRunwayChanges: true, busyArrivals: true, busyArrivalThreshold: 15 } });
    await b.open();
    b.error({ status: 503, message: 'Could not save' });
    b.nodes.busyArrivalAlerts.checked = false;
    await b.nodes.busyArrivalAlerts.handlers.change();
    assert.equal(b.nodes.busyArrivalAlerts.checked, true);
    assert.match(b.nodes.telegramMessage.textContent, /Could not save/);
    assert.equal(b.nodes.busyArrivalThreshold.disabled, false);
    b.error(null);
    b.nodes.busyArrivalAlerts.checked = false;
    await b.nodes.busyArrivalAlerts.handlers.change();
    assert.equal(b.nodes.busyArrivalThreshold.disabled, true);
    b.document.documentElement.dataset.userId = '';
    b.events.authchange();
    assert.equal(b.nodes.busyArrivalAlerts.checked, false);
    assert.equal(b.nodes.busyArrivalAlerts.disabled, true);
    assert.equal(b.nodes.busyArrivalThreshold.value, 10);
});

test('polling preserves an unfinished threshold edit without saving it', async () => {
    const b = browser({ connected: true });
    b.state({ enabled: true, connection: b.connection, alerts: { busyArrivals: true, busyArrivalThreshold: 10 } });
    await b.open();
    b.nodes.busyArrivalThreshold.value = '25';
    b.nodes.busyArrivalThreshold.handlers.input?.();
    b.events.interval(); await flush();
    assert.equal(String(b.nodes.busyArrivalThreshold.value), '25');
    assert.equal(b.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('threshold drafts survive polls and validation errors, save explicitly, and remain editable after failure', async () => {
    const b = browser({ connected: true });
    b.state({ enabled: true, connection: b.connection, alerts: { busyArrivals: true, busyArrivalThreshold: 10 } });
    await b.open();
    const input = b.nodes.busyArrivalThreshold;
    const save = b.nodes.busyArrivalThresholdSave;
    assert.equal(save.disabled, true);
    input.value = '';
    input.handlers.input();
    b.events.interval(); await flush();
    assert.equal(input.value, '');
    assert.equal(save.disabled, true);
    input.value = '25'; input.handlers.input();
    assert.equal(save.disabled, false);
    assert.equal(b.nodes.telegramMessage.textContent, '');
    b.events.focus(); await flush();
    assert.equal(input.value, '25');
    assert.equal(b.requests.filter(request => request.options.method === 'POST').length, 0);
    b.error({ status: 503, message: 'Disk unavailable' });
    await save.handlers.click();
    assert.equal(input.value, '25');
    assert.equal(save.disabled, false);
    assert.equal(b.nodes.telegramMessage.textContent, 'Disk unavailable');
    b.error(null);
    let prevented = false;
    await input.handlers.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(String(input.value), '25');
    assert.equal(save.disabled, true);
    assert.equal(b.nodes.telegramMessage.textContent, '');
    assert.equal(b.nodes.busyArrivalThresholdSave.textContent, 'Save');
    b.state({ enabled: true, connection: b.connection, alerts: { busyArrivals: true, busyArrivalThreshold: 30 } });
    b.events.interval(); await flush();
    assert.equal(input.value, 30); // Clean fields still sync with other devices.
});

test('a threshold save during an in-flight poll is not discarded or overwritten by the older response', async () => {
    const b = browser({ connected: true });
    b.state({ enabled: true, connection: b.connection, alerts: { busyArrivals: true, busyArrivalThreshold: 10 } });
    await b.open();
    b.nodes.busyArrivalThreshold.value = '25'; b.nodes.busyArrivalThreshold.handlers.input();
    let finishPoll; let finishSave;
    b.intercept((url, options) => new Promise(resolve => {
        if (options.method === 'POST') finishSave = resolve;
        else finishPoll = resolve;
    }));
    b.events.interval(); await flush();
    const saving = b.nodes.busyArrivalThresholdSave.handlers.click();
    assert.equal(b.nodes.busyArrivalThresholdSave.textContent, 'Saving…');
    assert.equal(b.nodes.busyArrivalThreshold.disabled, true);
    assert.equal(b.nodes.busyArrivalThresholdSave.disabled, true);
    finishSave({ ok: true, json: async () => ({ alerts: { busyArrivals: true, busyArrivalThreshold: 25 } }) });
    await saving;
    finishPoll({ ok: true, json: async () => ({ enabled: true, connection: b.connection,
        alerts: { busyArrivals: true, busyArrivalThreshold: 10 } }) });
    await flush();
    assert.equal(b.nodes.busyArrivalThreshold.value, 25);
    assert.equal(b.nodes.telegramMessage.textContent, '');
    assert.equal(b.nodes.busyArrivalThresholdSave.textContent, 'Save');
    assert.equal(b.nodes.busyArrivalThresholdSave.disabled, true);
    b.intercept(null);
    b.document.documentElement.dataset.userId = '';
    b.events.authchange();
    assert.equal(b.nodes.busyArrivalThreshold.value, 10);
    assert.equal(b.nodes.telegramMessage.textContent, '');
});

test('holding alerts default off, save independently, roll back failures and synchronize across accounts', async () => {
    const b = browser({ connected: true });
    await b.open();
    assert.equal(b.nodes.holdingArrivalAlerts.checked, false);
    assert.equal(b.nodes.holdingArrivalAlerts.disabled, false);
    b.nodes.holdingArrivalAlerts.checked = true;
    await b.nodes.holdingArrivalAlerts.handlers.change();
    assert.deepEqual(JSON.parse(b.requests.filter(item => item.url.endsWith('/alerts')).at(-1).options.body), { holdingArrivals: true });
    assert.equal(b.nodes.holdingArrivalAlerts.checked, true);
    assert.equal(b.nodes.busyArrivalAlerts.checked, false);
    b.error({ status: 503, message: 'Could not save.' });
    b.nodes.holdingArrivalAlerts.checked = false;
    await b.nodes.holdingArrivalAlerts.handlers.change();
    assert.equal(b.nodes.holdingArrivalAlerts.checked, true);
    assert.match(b.nodes.telegramMessage.textContent, /Could not save/);
    b.error(null);
    b.state({ enabled: true, connection: b.connection, alerts: { holdingArrivals: false } });
    await b.open();
    assert.equal(b.nodes.holdingArrivalAlerts.checked, false);
    b.document.documentElement.dataset.userId = 'bob';
    b.state({ enabled: true, connection: null });
    await b.events.authchange(); await flush();
    assert.equal(b.nodes.holdingArrivalAlerts.checked, false);
    assert.equal(b.nodes.holdingArrivalAlerts.disabled, true);
});

test('all pages include the holding opt-in and accessible explanation', () => {
    for (const name of ['index', 'arrivals', 'weather', 'stats']) {
        const html = fs.readFileSync(path.join(__dirname, `../public/${name}.html`), 'utf8');
        assert.match(html, /id="holdingArrivalAlerts"[^>]*aria-describedby="holdingArrivalAlertHelp"/);
        assert.match(html, /id="holdingArrivalAlertHelp" role="tooltip"/);
    }
});

test('go-around alerts default off, save independently, restore failed saves and reset on logout', async () => {
    const b = browser({ connected: true });
    b.state({ enabled: true, connection: b.connection, alerts: { holdingArrivals: true, busyArrivals: true, predictedRunwayChanges: true } });
    await b.open();
    assert.equal(b.nodes.goAroundAlerts.checked, false);
    assert.equal(b.nodes.goAroundAlerts.disabled, false);
    b.nodes.goAroundAlerts.checked = true;
    await b.nodes.goAroundAlerts.handlers.change();
    assert.deepEqual(JSON.parse(b.requests.filter(item => item.url.endsWith('/alerts')).at(-1).options.body), { goArounds: true });
    assert.equal(b.nodes.goAroundAlerts.checked, true);
    assert.equal(b.nodes.holdingArrivalAlerts.checked, true);
    assert.equal(b.nodes.busyArrivalAlerts.checked, true);
    assert.equal(b.nodes.predictedRunwayAlerts.checked, true);
    b.error({ status: 503, message: 'Could not save.' });
    b.nodes.goAroundAlerts.checked = false;
    await b.nodes.goAroundAlerts.handlers.change();
    assert.equal(b.nodes.goAroundAlerts.checked, true);
    assert.match(b.nodes.telegramMessage.textContent, /Could not save/);
    b.error(null);
    b.state({ enabled: true, connection: b.connection, alerts: { goArounds: false } });
    await b.open(); assert.equal(b.nodes.goAroundAlerts.checked, false);
    b.document.documentElement.dataset.userId = '';
    await b.events.authchange(); await flush();
    assert.equal(b.nodes.goAroundAlerts.checked, false);
    assert.equal(b.nodes.goAroundAlerts.disabled, true);
});

test('all pages include the go-around opt-in and accessible explanation as a separate alert row', () => {
    for (const name of ['index', 'arrivals', 'weather', 'stats']) {
        const html = fs.readFileSync(path.join(__dirname, `../public/${name}.html`), 'utf8');
        assert.match(html, /id="goAroundAlerts"[^>]*aria-describedby="goAroundAlertHelp"/);
        assert.match(html, /id="goAroundAlertHelp" role="tooltip"/);
        assert.match(html, /confirm holding\.<\/p>\s*<\/div>\s*<\/div>\s*<div class="telegram-alert-row/);
    }
});
