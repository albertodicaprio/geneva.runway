const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function browser({ userId = '', stored = {}, blockedStorage = false, savedTheme = '' } = {}) {
    const events = {};
    const nodes = Object.fromEntries(['nightModeToggle', 'signIn', 'signOut', 'accountStatus', 'accountMenu', 'accountToggle', 'accountName', 'profileName', 'profileEmail'].map(id => [id, {
        hidden: true, dataset: {}, handlers: {}, attributes: {}, textContent: '',
        addEventListener(name, fn) { this.handlers[name] = fn; },
        contains(node) { return node === this || node === nodes.accountToggle || node === nodes.nightModeToggle || node === nodes.signOut; },
        focus() { document.activeElement = this; },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        querySelector(selector) { return this[selector] ||= {}; }
    }]));
    const storage = new Map(Object.entries(stored));
    const document = { hidden: false, documentElement: { dataset: { userId, themePreference: savedTheme } },
        getElementById: id => nodes[id], addEventListener(name, fn) { events[`document:${name}`] = fn; } };
    const window = { location: { href: 'https://gva-runway.ahpc.ch/weather.html', pathname: '/weather.html' },
        history: { replaceState() {} },
        localStorage: {
            getItem(key) { if (blockedStorage) throw new Error('blocked'); return storage.get(key) || null; },
            setItem(key, value) { if (blockedStorage) throw new Error('blocked'); storage.set(key, value); }
        },
        addEventListener(name, fn) { (events[name] ||= []).push(fn); },
        dispatchEvent(event) { for (const fn of events[event.type] || []) fn(event); },
        setInterval() {}
    };
    const requests = [];
    let session = { enabled: true, user: userId ? { id: userId, name: 'Spotter' } : null, csrfToken: 'csrf',
        settings: userId ? { theme: savedTheme || null } : null };
    let responder;
    const context = vm.createContext({ window, document, URL, Intl,
        Event: class { constructor(type) { this.type = type; } },
        Date: class extends Date { constructor() { super('2026-10-18T10:00:00Z'); } },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (responder) return responder(url, options);
            if (url === '/api/account/settings') session.settings = { theme: JSON.parse(options.body).theme };
            return { ok: true, status: 200, json: async () => session };
        } });
    function run(file) { vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context); }
    run('theme.js');
    events['document:DOMContentLoaded']();
    return { nodes, document, window, storage, requests, run, events, respond: fn => { responder = fn; }, session: value => {
        session = { ...value, settings: value.settings ?? (value.user ? { theme: null } : null) };
    } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('guests use Auto despite old saved preferences and cannot cycle the theme', () => {
    const b = browser({ stored: { 'geneva-night-mode': 'night', 'geneva-night-mode:user': 'night' } });
    assert.equal(b.document.documentElement.dataset.theme, 'day');
    assert.equal(b.nodes.nightModeToggle.hidden, true);
    b.nodes.nightModeToggle.handlers.click();
    assert.equal(b.document.documentElement.dataset.theme, 'day');
});

test('sign-in unlocks per-account themes and sign-out immediately restores Auto', async () => {
    const b = browser({ stored: { 'geneva-night-mode:user': 'night', 'geneva-night-mode:other': 'day' } });
    b.session({ enabled: true, user: { id: 'user', name: '<Spotter>' }, csrfToken: 'csrf' });
    b.run('auth.js');
    await flush();
    assert.equal(b.nodes.signIn.hidden, true);
    assert.equal(b.nodes.signOut.hidden, false);
    assert.equal(b.nodes.signOut.title, 'Signed in as <Spotter>');
    assert.equal(b.nodes.nightModeToggle.hidden, false);
    assert.equal(b.document.documentElement.dataset.theme, 'night');
    b.nodes.nightModeToggle.handlers.click(); // Night -> Day
    assert.equal(b.storage.get('geneva-night-mode:user'), 'day');
    assert.equal(b.storage.get('geneva-night-mode:other'), 'day');
    await flush();
    await b.nodes.signOut.handlers.click();
    assert.equal(b.requests.at(-1).url, '/auth/logout');
    assert.equal(b.requests.at(-1).options.method, 'POST');
    assert.equal(b.requests.at(-1).options.headers['X-CSRF-Token'], 'csrf');
    assert.equal(b.nodes.signIn.hidden, false);
    assert.equal(b.nodes.signOut.hidden, true);
    assert.equal(b.nodes.nightModeToggle.hidden, true);
    assert.equal(b.nodes.nightModeToggle.dataset.mode, 'auto');
    assert.equal(b.document.documentElement.dataset.theme, 'day');
});

test('expired sessions and cross-tab sign-out restore Auto', async () => {
    const b = browser({ userId: 'user', stored: { 'geneva-night-mode:user': 'night' } });
    assert.equal(b.document.documentElement.dataset.theme, 'night');
    b.run('auth.js');
    await flush();
    b.session({ enabled: true, user: null, csrfToken: null });
    b.window.dispatchEvent({ type: 'storage', key: 'geneva-auth-change' });
    await flush();
    assert.equal(b.document.documentElement.dataset.theme, 'day');
    assert.equal(b.nodes.nightModeToggle.hidden, true);
});

test('blocked storage still lets signed-in users change theme through session refreshes', async () => {
    const b = browser({ userId: 'user', blockedStorage: true });
    b.run('auth.js');
    await flush();
    b.nodes.nightModeToggle.handlers.click(); // Auto -> Night
    assert.equal(b.document.documentElement.dataset.theme, 'night');
    b.window.dispatchEvent({ type: 'focus' });
    await flush();
    assert.equal(b.document.documentElement.dataset.theme, 'night');
});

test('unconfigured sign-in stays public and explains why the button is disabled', async () => {
    const b = browser();
    b.session({ enabled: false, user: null, csrfToken: null });
    b.run('auth.js');
    await flush();
    assert.equal(b.nodes.signIn.hidden, false);
    let prevented = false;
    b.nodes.signIn.handlers.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.match(b.nodes.accountStatus.textContent, /not configured/);
    assert.match(b.nodes.signIn.href, /returnTo=%2Fweather.html/);
});

test('server theme overrides stale browser preferences before page rendering and syncs on focus', async () => {
    const b = browser({ userId: 'user', savedTheme: 'night', stored: { 'geneva-night-mode:user': 'day' } });
    assert.equal(b.document.documentElement.dataset.theme, 'night');
    b.run('auth.js');
    await flush();
    assert.equal(b.nodes.nightModeToggle.disabled, false);
    b.session({ enabled: true, user: { id: 'user', name: 'Spotter' }, csrfToken: 'csrf', settings: { theme: 'day' } });
    b.window.dispatchEvent({ type: 'focus' });
    await flush();
    assert.equal(b.document.documentElement.dataset.theme, 'day');
    assert.equal(b.storage.get('geneva-night-mode:user'), 'day');
});

test('first account visit imports the existing browser theme and later choices save automatically', async () => {
    const b = browser({ userId: 'user', stored: { 'geneva-night-mode:user': 'night' } });
    b.run('auth.js');
    await flush();
    const imported = b.requests.find(request => request.url === '/api/account/settings');
    assert.deepEqual(JSON.parse(imported.options.body), { theme: 'night' });
    assert.equal(imported.options.headers['X-CSRF-Token'], 'csrf');
    b.nodes.nightModeToggle.handlers.click();
    await flush();
    assert.deepEqual(JSON.parse(b.requests.at(-1).options.body), { theme: 'day' });
});

test('rapid theme clicks queue the last choice and save failures are visible', async () => {
    const b = browser({ userId: 'user', savedTheme: 'auto' });
    b.run('auth.js');
    await flush();
    let finish;
    b.respond(() => new Promise(resolve => { finish = resolve; }));
    b.nodes.nightModeToggle.handlers.click(); // Night, save waits.
    b.nodes.nightModeToggle.handlers.click(); // Day, queued.
    b.nodes.nightModeToggle.handlers.click(); // Auto, replaces queued Day.
    b.respond(async () => ({ ok: true, status: 200 }));
    finish({ ok: true, status: 200 });
    await flush();
    const saves = b.requests.filter(request => request.url === '/api/account/settings');
    assert.deepEqual(saves.map(request => JSON.parse(request.options.body).theme), ['night', 'auto']);
    assert.equal(b.document.documentElement.dataset.themePreference, 'auto');
    b.respond(async () => ({ ok: false, status: 503 }));
    b.nodes.nightModeToggle.handlers.click();
    await flush();
    assert.match(b.nodes.accountStatus.textContent, /Could not save/);
    assert.equal(b.nodes.signOut.disabled, false);
});

test('blocked browser storage still restores and saves account themes', async () => {
    const b = browser({ userId: 'user', savedTheme: 'night', blockedStorage: true });
    b.run('auth.js');
    await flush();
    assert.equal(b.document.documentElement.dataset.theme, 'night');
    b.nodes.nightModeToggle.handlers.click();
    await flush();
    assert.equal(b.document.documentElement.dataset.theme, 'day');
    assert.deepEqual(JSON.parse(b.requests.at(-1).options.body), { theme: 'day' });
});

test('temporary session check failures preserve the initial account controls', async () => {
    for (const userId of ['', 'user']) {
        const b = browser({ userId, savedTheme: 'night' });
        b.respond(async () => { throw new Error('offline'); });
        b.run('auth.js');
        await flush();
        assert.equal(b.nodes.signIn.hidden, Boolean(userId));
        assert.equal(b.nodes.signOut.hidden, !userId);
        assert.equal(b.document.documentElement.dataset.userId, userId);
        assert.match(b.nodes.accountStatus.textContent, /Could not check sign-in/);
    }
});

test('account dropdown displays Google profile safely and closes on Escape, outside click and logout', async () => {
    const b = browser();
    b.session({ enabled: true, user: { id: 'user', name: '<Alice>', fullName: '<Alice> Example', email: 'alice@example.com' },
        csrfToken: 'csrf', settings: { theme: 'auto' } });
    b.run('auth.js');
    await flush();
    assert.equal(b.nodes.accountMenu.hidden, false);
    assert.equal(b.nodes.accountName.textContent, '<Alice>');
    assert.equal(b.nodes.profileName.textContent, '<Alice> Example');
    assert.equal(b.nodes.profileEmail.textContent, 'alice@example.com');
    b.nodes.accountMenu.open = true;
    let prevented = false;
    b.events['document:keydown']({ key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(b.nodes.accountMenu.open, false);
    assert.equal(b.document.activeElement, b.nodes.accountToggle);
    b.nodes.accountMenu.open = true;
    b.events['document:click']({ target: b.nodes.nightModeToggle });
    assert.equal(b.nodes.accountMenu.open, true);
    b.events['document:click']({ target: {} });
    assert.equal(b.nodes.accountMenu.open, false);
    b.nodes.accountMenu.open = true;
    b.events['document:focusin']({ target: {} });
    assert.equal(b.nodes.accountMenu.open, false);
    b.nodes.accountMenu.open = true;
    await b.nodes.signOut.handlers.click();
    assert.equal(b.nodes.accountMenu.hidden, true);
    assert.equal(b.nodes.accountMenu.open, false);
    assert.equal(b.nodes.profileEmail.textContent, '—');
    assert.equal(b.document.activeElement, b.nodes.signIn);
});

test('session expiration closes the account dropdown and clears the profile', async () => {
    const b = browser({ userId: 'user', savedTheme: 'night' });
    b.run('auth.js');
    await flush();
    b.nodes.accountMenu.open = true;
    b.session({ enabled: true, user: null, csrfToken: null });
    b.window.dispatchEvent({ type: 'focus' });
    await flush();
    assert.equal(b.nodes.accountMenu.open, false);
    assert.equal(b.nodes.accountMenu.hidden, true);
    assert.equal(b.nodes.accountName.textContent, 'Account');
    assert.equal(b.nodes.profileName.textContent, '—');
});
