const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUserSettings } = require('../lib/user-settings');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-settings-store-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'settings.json');
    return { filePath, store: createUserSettings({ filePath }) };
}

test('settings persist by email across store instances and preserve other accounts and future fields', async t => {
    const { store, filePath } = await fixture(t);
    assert.deepEqual(await store.get('alice@example.com'), { theme: null });
    await fs.writeFile(filePath, JSON.stringify({
        'alice@example.com': { theme: 'day', notifications: { arrivals: true } },
        'bob@example.com': { theme: 'auto' }
    }));
    await store.setTheme('alice@example.com', 'night');
    const restarted = createUserSettings({ filePath });
    assert.deepEqual(await restarted.get('alice@example.com'), { theme: 'night', notifications: { arrivals: true } });
    assert.deepEqual(await restarted.get('bob@example.com'), { theme: 'auto' });
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test('concurrent theme saves do not lose accounts and the last same-account save wins', async t => {
    const { store, filePath } = await fixture(t);
    await Promise.all(Array.from({ length: 20 }, (_, n) => store.setTheme(`spotter${n}@example.com`, 'night')));
    await Promise.all(['day', 'night', 'auto'].map(theme => store.setTheme('spotter0@example.com', theme)));
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(Object.keys(saved).length, 20);
    assert.equal(saved['spotter0@example.com'].theme, 'auto');
    assert.equal(saved['spotter19@example.com'].theme, 'night');
});

test('failed atomic writes preserve the previous file and later saves can recover', async t => {
    const { store, filePath } = await fixture(t);
    await store.setTheme('alice@example.com', 'day');
    const before = await fs.readFile(filePath, 'utf8');
    let fail = true;
    const failing = createUserSettings({ filePath, storage: { ...fs,
        async rename(...args) { if (fail) throw new Error('disk unavailable'); return fs.rename(...args); }
    } });
    await assert.rejects(failing.setTheme('alice@example.com', 'night'));
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.deepEqual(await fs.readdir(path.dirname(filePath)), ['settings.json']);
    fail = false;
    await failing.setTheme('alice@example.com', 'night');
    assert.equal((await store.get('alice@example.com')).theme, 'night');
});

test('malformed settings are preserved and invalid theme values cannot be written', async t => {
    const { store, filePath } = await fixture(t);
    for (const contents of ['{broken json', '[]', '{"alice@example.com":42}']) {
        await fs.writeFile(filePath, contents);
        await assert.rejects(store.get('alice@example.com'));
        await assert.rejects(store.setTheme('alice@example.com', 'day'));
        assert.equal(await fs.readFile(filePath, 'utf8'), contents);
    }
    await assert.rejects(store.setTheme('alice@example.com', 'invalid'));
});
