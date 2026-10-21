const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/map-history');
function fixture() {
    const elements = Object.fromEntries(['mapHistoryTime', 'mapHistoryStatus', 'mapHistoryLive', 'mapHistoryEarliest',
        'mapMode', 'mapPositionNote'].map(id => [id, { handlers: {},
        addEventListener(event, handler) { this.handlers[event] = handler; }, setAttribute(key, value) { this[key] = value; } }]));
    const requests = [], maps = [], timers = new Map();
    let timer = 0;
    const timeline = create({ document: { getElementById: id => elements[id] }, now: () => 100000000,
        map: { setHistory: value => maps.push(value) },
        fetch: (url) => new Promise(resolve => requests.push({ url, resolve })),
        defer: callback => { timers.set(++timer, callback); return timer; }, cancel: id => timers.delete(id) });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    async function resolve(index, data, ok = true) {
        requests[index].resolve({ ok, json: async () => data });
        await flush();
    }
    async function select(at) {
        elements.mapHistoryTime.value = at;
        elements.mapHistoryTime.handlers.input();
        for (const [id, callback] of timers) { timers.delete(id); void callback(); }
        await flush();
    }
    return { elements, requests, maps, timeline, resolve, select };
}

test('timeline loads history on demand, remains independent of live polling, and ignores late responses after Back to live', async () => {
    const f = fixture();
    f.timeline.init();
    assert.equal(f.requests[0].url, '/api/path-history');
    await f.resolve(0, { availableFrom: 90000 });
    f.timeline.tick();
    assert.equal(f.elements.mapHistoryTime.disabled, false);
    assert.equal(f.elements.mapHistoryTime.min, 90000);
    await f.select(95000);
    assert.equal(f.requests[1].url, '/api/path-history?at=95000');
    assert.equal(f.elements.mapMode.textContent, 'HISTORY');
    const snapshot = { historical: true, aircraft: [{ callsign: 'PAST' }] };
    await f.resolve(1, snapshot);
    assert.equal(f.maps.at(-1), snapshot);
    assert.match(f.elements.mapHistoryStatus.textContent, /Geneva/);
    await f.select(96000);
    f.elements.mapHistoryLive.handlers.click();
    assert.equal(f.maps.at(-1), null);
    await f.resolve(2, { aircraft: [{ callsign: 'LATE' }] });
    assert.equal(f.maps.at(-1), null);
    assert.equal(f.elements.mapMode.textContent, 'LIVE POSITION');
    assert.equal(f.elements.mapHistoryTime.value, 100000);
    f.timeline.tick();
    assert.equal(f.requests.length, 3);
});

test('timeline discards out-of-order selections and explains unavailable history', async () => {
    const f = fixture();
    f.timeline.init();
    await f.resolve(0, { availableFrom: null });
    assert.equal(f.elements.mapHistoryTime.disabled, true);
    assert.match(f.elements.mapHistoryStatus.textContent, /Waiting/);
    await f.select(95000);
    await f.select(96000);
    const latest = { historical: true, aircraft: [] };
    await f.resolve(2, latest);
    await f.resolve(1, { historical: true, aircraft: [{ callsign: 'OLDER' }] });
    assert.equal(f.maps.at(-1), latest);
    await f.select(97000);
    await f.resolve(3, {}, false);
    assert.match(f.elements.mapHistoryStatus.textContent, /Unable to load/);
    assert.equal(f.maps.at(-1).historical, true);
});

test('single arrow presses change time by a minute and return to live at the end', async () => {
    const f = fixture();
    f.timeline.init();
    await f.resolve(0, { availableFrom: 90000 });
    f.timeline.tick();
    const slider = f.elements.mapHistoryTime;
    const press = key => slider.handlers.keydown({ key, preventDefault() {} });
    press('ArrowLeft');
    assert.equal(Number(slider.value), 99940);
    assert.equal(f.elements.mapMode.textContent, 'HISTORY');
    assert.match(slider['aria-valuetext'], /Geneva time/);
    // Flush the debounced request without changing the chosen value.
    await f.select(slider.value);
    assert.equal(f.requests.at(-1).url, '/api/path-history?at=99940');
    press('ArrowRight');
    assert.equal(Number(slider.value), 100000);
    assert.equal(f.elements.mapMode.textContent, 'LIVE POSITION');
    await f.select(90010);
    press('ArrowLeft');
    assert.equal(Number(slider.value), 90000);
});
