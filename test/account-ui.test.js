const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function browser({ userId = '', stored = {}, blockedStorage = false } = {}) {
    const events = {};
    const nodes = Object.fromEntries(['nightModeToggle', 'signIn', 'signOut', 'accountStatus'].map(id => [id, {
        hidden: true, dataset: {}, handlers: {}, attributes: {}, textContent: '',
        addEventListener(name, fn) { this.handlers[name] = fn; },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        querySelector(selector) { return this[selector] ||= {}; }
    }]));
    const storage = new Map(Object.entries(stored));
    const document = { hidden: false, documentElement: { dataset: { userId } },
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
    let session = { enabled: true, user: userId ? { id: userId, name: 'Spotter' } : null, csrfToken: 'csrf' };
    const context = vm.createContext({ window, document, URL, Intl,
        Event: class { constructor(type) { this.type = type; } },
        Date: class extends Date { constructor() { super('2026-10-18T10:00:00Z'); } },
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => session };
        } });
    function run(file) { vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context); }
    run('theme.js');
    events['document:DOMContentLoaded']();
    return { nodes, document, window, storage, requests, run, session: value => { session = value; } };
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
