const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const { createTelegramPoller } = require('../lib/telegram-poller');
const { createTelegramStore } = require('../lib/telegram-store');
const { createTelegramClient, TelegramError } = require('../lib/telegram-client');

function waiting(signal) {
    return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}
async function until(predicate) {
    for (let i = 0; i < 1000; i++) {
        if (predicate()) return;
        await pause(1);
    }
    throw new Error('Polling test did not reach expected state');
}
async function fixture(t, { request, onUpdate = async () => false, sleep, store: suppliedStore } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-polling-'));
    const filePath = path.join(directory, 'telegram.json');
    const store = suppliedStore || createTelegramStore({ filePath });
    const calls = [];
    const logs = [];
    const client = { request: async (method, payload, options) => {
        calls.push({ method, payload, options });
        if (request) return request(method, payload, options);
        if (method === 'getMe') return { id: 123, is_bot: true, username: 'GenevaTestBot' };
        return waiting(options.signal);
    } };
    const poller = createTelegramPoller({ client, username: 'GenevaTestBot', store, onUpdate,
        logger: { info: value => logs.push(value), warn: value => logs.push(value) },
        ...(sleep ? { sleep } : {}) });
    t.after(async () => { await poller.stop(); await fs.rm(directory, { recursive: true, force: true }); });
    return { poller, store, calls, logs, filePath, client };
}
const identity = { id: 123, is_bot: true, username: 'GenevaTestBot' };

test('one poll runs at a time, uses long-poll timeouts, and shutdown cancels it', async t => {
    const f = await fixture(t);
    const task = f.poller.start();
    assert.equal(f.poller.start(), task);
    await until(() => f.calls.length === 2);
    assert.equal(f.calls[0].method, 'getMe');
    assert.equal(f.calls[1].method, 'getUpdates');
    assert.deepEqual(f.calls[1].payload, { offset: 0, limit: 100, timeout: 30, allowed_updates: ['message'] });
    assert.equal(f.calls[1].options.timeout, 40_000);
    await f.poller.stop();
    await task;
    assert.equal(f.calls[1].options.signal.aborted, true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.logs.some(value => value.includes('failed')), false);
});

test('updates commit in order, duplicates are skipped, cursors survive restart and belong to their bot', async t => {
    let polls = 0;
    const processed = [];
    const f = await fixture(t, { onUpdate: async event => { processed.push(event.update_id); return true; },
        request: async (method, _payload, { signal }) => {
            if (method === 'getMe') return identity;
            if (++polls === 1) return [{ update_id: 4 }, { update_id: 3 }, { update_id: 3 }];
            return waiting(signal);
        } });
    void f.poller.start();
    await until(() => polls === 2);
    assert.deepEqual(processed, [3, 4]);
    assert.equal(f.calls.at(-1).payload.offset, 5);
    assert.deepEqual((await f.store.read()).polling, { botId: '123', nextUpdateId: 5 });
    await f.poller.stop();
    const calls = [];
    const client = { request: async (method, payload, { signal }) => {
        calls.push({ method, payload });
        return method === 'getMe' ? identity : waiting(signal);
    } };
    const restarted = createTelegramPoller({ client, username: 'GenevaTestBot',
        store: createTelegramStore({ filePath: f.filePath }), onUpdate: async () => true, logger: {} });
    t.after(() => restarted.stop());
    void restarted.start();
    await until(() => calls.length === 2);
    assert.equal(calls[1].payload.offset, 5);
    await restarted.stop();
    const differentBot = createTelegramPoller({ client: { request: async (method, payload, { signal }) => {
        calls.push({ method, payload });
        return method === 'getMe' ? { ...identity, id: 456 } : waiting(signal);
    } }, username: 'GenevaTestBot', store: f.store, onUpdate: async () => true, logger: {} });
    t.after(() => differentBot.stop());
    void differentBot.start();
    await until(() => calls.length === 4);
    assert.equal(calls[3].payload.offset, 0);
});

test('processing failures retry the same update before acknowledging later events', async t => {
    const processed = [];
    const delays = [];
    let polls = 0;
    let first = true;
    const f = await fixture(t, { sleep: async ms => { delays.push(ms); },
        onUpdate: async event => {
            processed.push(event.update_id);
            if (first) { first = false; throw new Error('private event payload'); }
            return true;
        }, request: async (method, _payload, { signal }) => {
            if (method === 'getMe') return identity;
            if (++polls <= 2) return [{ update_id: 10 }, { update_id: 11 }];
            return waiting(signal);
        } });
    void f.poller.start();
    await until(() => polls === 3);
    assert.deepEqual(processed, [10, 10, 11]);
    assert.deepEqual(f.calls.filter(call => call.method === 'getUpdates').map(call => call.payload.offset), [0, 0, 12]);
    assert.deepEqual(delays, [1000]);
    assert.doesNotMatch(f.logs.join('\n'), /private event payload/);
});

test('a failed cursor write never acknowledges that event and preserves saved accounts', async t => {
    let saved = { version: 1, accounts: { alice: { chatId: '456' } } };
    let writes = 0;
    let polls = 0;
    const processed = [];
    const store = { read: async () => structuredClone(saved), update: async change => {
        if (++writes === 1) throw new Error('disk unavailable');
        const next = structuredClone(saved);
        change(next.accounts, next);
        saved = next;
    } };
    const f = await fixture(t, { store, sleep: async () => {}, onUpdate: async event => { processed.push(event.update_id); return true; },
        request: async (method, _payload, { signal }) => {
            if (method === 'getMe') return identity;
            if (++polls <= 2) return [{ update_id: 8 }];
            return waiting(signal);
        } });
    void f.poller.start();
    await until(() => polls === 3);
    assert.deepEqual(processed, [8, 8]);
    assert.equal(f.calls.at(-1).payload.offset, 9);
    assert.deepEqual(saved.accounts, { alice: { chatId: '456' } });
    assert.deepEqual(saved.polling, { botId: '123', nextUpdateId: 9 });
});

test('network failures use bounded backoff, honor retry_after and reset after recovery', async t => {
    let polls = 0;
    const delays = [];
    const f = await fixture(t, { sleep: async ms => { delays.push(ms); },
        request: async (method, _payload, { signal }) => {
            if (method === 'getMe') return identity;
            polls++;
            if (polls <= 7) throw new TelegramError('unavailable');
            if (polls === 8) throw new TelegramError(429, 120);
            if (polls === 9) return [];
            if (polls === 10) throw new TelegramError('unavailable');
            return waiting(signal);
        } });
    void f.poller.start();
    await until(() => polls === 11);
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 120000, 1000]);
});

test('shutdown interrupts backoff and an in-progress update finishes before stop returns', async t => {
    const f = await fixture(t, { request: async () => { throw new TelegramError('unavailable'); } });
    void f.poller.start();
    await until(() => f.logs.some(log => log.includes('retrying')));
    await f.poller.stop();
    assert.equal(f.calls.length, 1);
    let finish;
    let processing = false;
    const slow = await fixture(t, { onUpdate: () => {
        processing = true;
        return new Promise(resolve => { finish = resolve; });
    }, request: async method => method === 'getMe' ? identity : [{ update_id: 1 }] });
    void slow.poller.start();
    await until(() => processing);
    let stopped = false;
    const stopping = slow.poller.stop().then(() => { stopped = true; });
    await pause(1);
    assert.equal(stopped, false);
    finish(true);
    await stopping;
    assert.equal((await slow.store.read()).polling.nextUpdateId, 2);
    assert.equal(slow.calls.length, 2);
});

test('invalid credentials, mismatched identity and conflicting receivers stop without retrying', async t => {
    for (const failure of [401, 404, 409, 'identity']) {
        const f = await fixture(t, { request: async () => {
            if (failure === 'identity') return { ...identity, username: 'OtherBot' };
            throw new TelegramError(failure);
        } });
        await f.poller.start();
        assert.equal(f.calls.length, 1);
        assert.match(f.logs.join('\n'), failure === 409 ? /another receiver/ : /check TELEGRAM_BOT_TOKEN/);
    }
});

test('unsolicited updates log bounded metadata only and never render or send a reply', async t => {
    let polls = 0;
    const secret = 'private-link-token-and-message-text';
    const f = await fixture(t, { request: async (method, _payload, { signal }) => {
        if (method === 'getMe') return identity;
        if (++polls === 1) return [
            { update_id: 1, message: { text: `/start ${secret}`, from: { id: 987654, first_name: 'Private Name' } } },
            { update_id: 2, message: { text: secret } },
            { update_id: 3, message: { photo: [{ file_id: secret }] } },
            { update_id: 4, edited_message: { text: secret } }
        ];
        return waiting(signal);
    } });
    void f.poller.start();
    await until(() => polls === 2);
    const events = f.logs.filter(log => log.startsWith('{')).map(log => JSON.parse(log));
    assert.deepEqual(events.map(event => event.kind), ['command', 'message', 'attachment', 'other']);
    assert.equal(events.every(event => event.event === 'telegram_update_ignored'), true);
    assert.doesNotMatch(f.logs.join('\n'), /private-link|Private Name|987654|file_id/);
    assert.equal(f.calls.every(call => ['getMe', 'getUpdates'].includes(call.method)), true);
});

test('malformed update batches never advance the persisted cursor', async t => {
    let polls = 0;
    let handled = 0;
    const f = await fixture(t, { sleep: async () => {}, onUpdate: async () => { handled++; },
        request: async (method, _payload, { signal }) => {
            if (method === 'getMe') return identity;
            if (++polls === 1) return [{ update_id: 1 }, { update_id: 'invalid' }];
            return waiting(signal);
        } });
    void f.poller.start();
    await until(() => polls === 2);
    assert.equal(handled, 0);
    assert.equal((await f.store.read()).polling, undefined);
    assert.equal(f.calls.at(-1).payload.offset, 0);
});

test('poll requests can wait longer than send requests and explicit cancellation aborts the body', async () => {
    let requestSignal;
    const client = createTelegramClient({ token: '123:secret', timeoutMs: 1, fetchImpl: async (_url, { signal }) => {
        requestSignal = signal;
        return { ok: true, json: async () => {
            await pause(15);
            signal.throwIfAborted();
            return { ok: true, result: [] };
        } };
    } });
    assert.deepEqual(await client.request('getUpdates', { timeout: 30 }, { timeout: 40_000 }), []);
    const controller = new AbortController();
    const cancelled = client.request('getUpdates', {}, { timeout: 40_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(requestSignal.aborted, true);
});

test('the local Node server starts polling without public HTTPS and cancels it on SIGTERM', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geneva-polling-server-'));
    const preload = path.join(directory, 'fake-telegram.cjs');
    await fs.writeFile(preload, `
        const originalFetch = globalThis.fetch;
        let polls = 0;
        globalThis.fetch = async (url, options) => {
            if (!String(url).startsWith('https://api.telegram.org/')) return originalFetch(url, options);
            if (String(url).endsWith('/getMe')) return new Response(JSON.stringify({ok:true,
                result:{id:123,is_bot:true,username:'GenevaTestBot'}}));
            if (!String(url).endsWith('/getUpdates')) throw new Error('Unexpected Telegram request');
            if (++polls === 1) return new Response(JSON.stringify({ok:true,result:[
                {update_id:42,message:{text:'private unsolicited content'}}]}));
            console.log('polling-check-waiting:' + JSON.parse(options.body).offset);
            return new Promise((_, reject) => options.signal.addEventListener('abort',
                () => reject(options.signal.reason), {once:true}));
        };
    `);
    const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', TMPDIR: directory,
            APP_ORIGIN: 'http://127.0.0.1:3000', TELEGRAM_BOT_TOKEN: '123:fake_token', TELEGRAM_BOT_USERNAME: 'GenevaTestBot',
            TELEGRAM_CONNECTIONS_FILE: path.join(directory, 'connections.json'),
            GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '', UMAMI_WEBSITE_ID: '',
            OPENSKY_NETWORK_CLIENT_ID: '', OPENSKY_NETWORK_CLIENT_SECRET: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => { child.kill(); await exited; await fs.rm(directory, { recursive: true, force: true }); });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await until(() => output.includes('polling-check-waiting:43'));
    const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)[1];
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.match(output, /telegram_update_ignored/);
    assert.doesNotMatch(output, /private unsolicited content|fake_token/);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'connections.json'), 'utf8')).polling.nextUpdateId, 43);
    child.kill('SIGTERM');
    const deadline = new AbortController();
    try {
        const result = await Promise.race([exited, pause(1500, null, { signal: deadline.signal }).then(() => {
            throw new Error('Shutdown did not cancel the Telegram poll promptly');
        })]);
        assert.deepEqual(result, { code: 0, signal: null });
    } finally { deadline.abort(); }
});
