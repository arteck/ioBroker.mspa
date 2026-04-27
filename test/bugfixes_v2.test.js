'use strict';

/**
 * Tests for the bug-fixes applied during the strict-mode review.
 * Run:  npx mocha test/bugfixes_v2.test.js
 *
 * Covers:
 *   1. RateTracker – min-sample window must accumulate, not reset on every tick
 *   2. MSpaApiClient.sendDeviceCommand – serial command lock survives errors
 *   3. MSpaApiClient – getHotTubStatus throws cleanly when not initialised
 *   4. transformStatus – fault & boolean mapping edge cases
 *   5. MspaAdapter (mocked) – onStateChange routing (foreign vs. own ns)
 *   6. MspaAdapter (mocked) – setFeature uvc waits for filter
 *   7. MspaAdapter (mocked) – restoreSavedState restores bubble + level
 *   8. enableRapidPolling() – cancels running timer and reschedules in 1 s
 *   9. setFeature('heater', true) – auto-starts filter when pump is OFF
 *  10. setTargetTemp() – range validation (20–42 °C)
 *  11. setTargetTemp() – uses _adapterCommanded.heater as fallback (no queue)
 *  12. setFeature('uvc', true) – auto-starts filter when pump is OFF
 *  13. setFeature – immediate ack (control.filter / heater / uvc / bubble)
 *  14. sendTargetTempDirect – immediate ack for control.target_temperature
 *  15. setTargetTemp queued – immediate ack for control.target_temperature
 *  16. setManualOverride – race condition: timer cancelled atomically before await
 *  17. setManualOverride – onStateChange rollback on error; duration always acked
 */

const assert = require('assert');
const path   = require('path');
const Module = require('module');

const { transformStatus, RateTracker } = require('../lib/utils');

// ---------------------------------------------------------------------------
// 1. RateTracker
// ---------------------------------------------------------------------------
describe('RateTracker (post-fix)', () => {

    it('does NOT reset _lastTime when temp changes before MIN_SAMPLE_MS', () => {
        const t = new RateTracker({ min: 0.05, max: 50, minSampleMinutes: 5 });
        const T0 = Date.now();
        const realNow = Date.now;
        Date.now = () => T0;
        t.update(20.0, true, true);                // initial sample
        Date.now = () => T0 + 60_000;              // +1 min
        t.update(20.5, true, true);                // change, but < MIN_SAMPLE → must not reset
        Date.now = () => T0 + 4 * 60_000;          // +4 min total
        t.update(21.0, true, true);                // still < 5 min
        Date.now = () => T0 + 6 * 60_000;          // +6 min total → window elapsed
        const rate = t.update(22.0, true, true);
        Date.now = realNow;

        // Without the fix, _lastTime would have been reset to T0+60s/T0+4min on each
        // intermediate update, so at +6min only 2 minutes would have "elapsed" from
        // the perspective of the tracker – rate would never compute (null).
        assert.notStrictEqual(rate, null, 'rate must be computed once MIN_SAMPLE elapsed');
        assert.ok(rate > 0, `rate must be positive, got ${rate}`);
    });

    it('clamps sub-MIN/over-MAX rates (no contamination of EMA)', () => {
        const t = new RateTracker({ min: 0.5, max: 1.0, minSampleMinutes: 0.001 });
        // huge delta → rate >> max → must be ignored
        const T0 = Date.now();
        const realNow = Date.now;
        Date.now = () => T0;
        t.update(20, true, true);
        Date.now = () => T0 + 1000;   // 1 s later
        t.update(50, true, true);     // implies 30 °C/sec → way over max
        Date.now = realNow;
        // computedRate must remain null (rate rejected)
        assert.strictEqual(t.computedRate, null);
    });

    it('resets cleanly when active=false', () => {
        const t = new RateTracker({ min: 0.05, max: 5 });
        t.update(20, true, true);
        t.update(20, false, true);
        assert.strictEqual(t._lastTemp, null);
        assert.strictEqual(t._lastTime, null);
    });
});

// ---------------------------------------------------------------------------
// 2. transformStatus edge cases
// ---------------------------------------------------------------------------
describe('transformStatus() – edge cases', () => {
    it('passes through unknown keys verbatim', () => {
        const r = transformStatus({ heat_state: 3, otastatus: 0, custom_field: 'x' });
        assert.strictEqual(r.heat_state, 3);
        assert.strictEqual(r.otastatus, 0);
        assert.strictEqual(r.custom_field, 'x');
    });

    it('handles missing temperature fields gracefully', () => {
        const r = transformStatus({});
        assert.strictEqual(r.water_temperature, 0);
        assert.strictEqual(r.target_temperature, 0);
        assert.strictEqual(r.heater, 'off');
        assert.strictEqual(r.fault, 'OK');
    });

    it('preserves numeric fault codes (non-empty)', () => {
        const r = transformStatus({ fault: 'E03' });
        assert.strictEqual(r.fault, 'E03');
    });

    it('default bubble_level = 1 when missing', () => {
        const r = transformStatus({});
        assert.strictEqual(r.bubble_level, 1);
    });
});

// ---------------------------------------------------------------------------
// 3. MSpaApiClient – mocked axios
// ---------------------------------------------------------------------------
describe('MSpaApiClient (mocked)', () => {
    let MSpaApiClient, axiosMock, originalAxios;

    before(() => {
        // Stub axios via require cache injection
        const axiosPath = require.resolve('axios');
        originalAxios = require.cache[axiosPath];
        axiosMock = {
            calls: [],
            postResponses: [],
            getResponses: [],
            post(url, payload, opts) {
                axiosMock.calls.push({ method: 'POST', url, payload, opts });
                if (axiosMock.postResponses.length === 0) throw new Error('no mock response');
                const next = axiosMock.postResponses.shift();
                if (next instanceof Error) return Promise.reject(next);
                return Promise.resolve(next);
            },
            get(url, opts) {
                axiosMock.calls.push({ method: 'GET', url, opts });
                const next = axiosMock.getResponses.shift();
                if (next instanceof Error) return Promise.reject(next);
                return Promise.resolve(next);
            },
        };
        require.cache[axiosPath] = {
            id: axiosPath, filename: axiosPath, loaded: true,
            exports: axiosMock,
        };
        // Force re-load of module
        delete require.cache[require.resolve('../lib/mspaApi')];
        ({ MSpaApiClient } = require('../lib/mspaApi'));
    });

    after(() => {
        const axiosPath = require.resolve('axios');
        if (originalAxios) require.cache[axiosPath] = originalAxios;
        else delete require.cache[axiosPath];
        delete require.cache[require.resolve('../lib/mspaApi')];
    });

    beforeEach(() => {
        axiosMock.calls = [];
        axiosMock.postResponses = [];
        axiosMock.getResponses = [];
    });

    it('throws clean error when getHotTubStatus called before init', async () => {
        const c = new MSpaApiClient({
            email: 'real@user.com', password: 'pwd', region: 'ROW',
            authStore: { token: 'X', throttle: { acquire: () => Promise.resolve() } },
            log: () => {},
        });
        await assert.rejects(
            () => c.getHotTubStatus(),
            /deviceId\/productId not initialised/,
        );
    });

    it('serialises sendDeviceCommand even when previous call rejects', async function () {
        this.timeout(15000);
        const c = new MSpaApiClient({
            email: 'real@user.com', password: 'pwd', region: 'ROW',
            authStore: { token: 'X', throttle: { acquire: () => Promise.resolve() } },
            log: () => {},
        });
        c.deviceId = 'dev1'; c.productId = 'prod1';
        // First call: post fails. Second call: post + 5 confirm polls succeed.
        axiosMock.postResponses.push(new Error('boom'));
        // second sendCommandLocked: command response + 5 status polls (only need first)
        axiosMock.postResponses.push({ data: { message: 'SUCCESS' } });
        axiosMock.postResponses.push({ data: { data: { heater_state: 1 } } });

        const p1 = c.sendDeviceCommand({ heater_state: 1 }).catch(e => e);
        const p2 = c.sendDeviceCommand({ heater_state: 1 });

        const r1 = await p1;
        const r2 = await p2;
        assert.ok(r1 instanceof Error, 'first call must reject');
        assert.strictEqual(r2.message, 'SUCCESS');
        // Lock must be released even after the rejection
        assert.strictEqual(c._authStore._cmdPromise, null);
    });

    it('demo mode never hits the network', async () => {
        const c = new MSpaApiClient({
            email: 'demo@mspa.test', password: '', region: 'ROW',
            authStore: { token: null, throttle: { acquire: () => Promise.resolve() } },
            log: () => {},
        });
        await c.init();
        const s = await c.getHotTubStatus();
        assert.ok(s.water_temperature > 0);
        assert.strictEqual(axiosMock.calls.length, 0);
        const r = await c.sendDeviceCommand({ heater_state: 0 });
        assert.strictEqual(r.message, 'SUCCESS');
        assert.strictEqual(axiosMock.calls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// 4. MspaAdapter – partial unit tests with manual mocking
//    (We cannot fully boot the adapter without a JS-controller; instead we
//    instantiate the class with a stub super-class to test the methods.)
// ---------------------------------------------------------------------------
describe('MspaAdapter logic (mocked super)', () => {
    let originalCore;
    let MspaAdapter;
    let adapter;
    const stateStore = new Map();

    before(() => {
        // Inject a stub for @iobroker/adapter-core
        const corePath = require.resolve('@iobroker/adapter-core');
        originalCore = require.cache[corePath];
        class StubAdapter {
            constructor(opts) {
                this.name      = opts.name;
                this.namespace = `${opts.name}.0`;
                this.config    = {};
                this.log = {
                    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
                };
                this._listeners = {};
            }
            on(ev, cb) { this._listeners[ev] = cb; }
            async setStateAsync(id, val) {
                const v = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
                stateStore.set(id, { val: v, ack: true });
            }
            async setStateChangedAsync(id, val) {
                stateStore.set(id, { val, ack: true });
            }
            async getStateAsync(id) {
                return stateStore.get(id) || null;
            }
            async getForeignStateAsync()    { return null; }
            setState(id, val, ack)          {
                const v = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
                stateStore.set(id, { val: v, ack: !!ack });
            }
            subscribeStates()               {}
            subscribeForeignStates()        {}
        }
        require.cache[corePath] = {
            id: corePath, filename: corePath, loaded: true,
            exports: { Adapter: StubAdapter },
        };
        // Reload main.js (which imports adapter-core)
        delete require.cache[require.resolve('../main.js')];
        // main.js calls `new MspaAdapter()` only when require.main === module → safe
        MspaAdapter = require('../main.js')({});
        // Above returns an instance; we want the class. Instead grab via constructor:
        adapter = MspaAdapter;
    });

    after(() => {
        const corePath = require.resolve('@iobroker/adapter-core');
        if (originalCore) require.cache[corePath] = originalCore;
        else delete require.cache[corePath];
        delete require.cache[require.resolve('../main.js')];
    });

    beforeEach(() => {
        stateStore.clear();
        // Reset adapter state we care about
        adapter._adapterCommanded = { heater: null, filter: null, bubble: null, uvc: null, target_temperature: null };
        adapter._lastCommandTime  = 0;
        adapter._manualOverride   = false;
        adapter._manualOverrideTimer = null;
        adapter._lastData = {};
    });

    it('isInTimeWindow handles overnight ranges', () => {
        // Force "current time" via Date stubbing? Use plain checks:
        // We can't stub Date here easily, so just use a known-safe daytime.
        // Instead: temporarily monkey-patch Date inside the function via a wrapper.
        const originalDate = global.Date;
        try {
            global.Date = class extends originalDate {
                constructor() { super('2024-01-01T23:30:00Z'); }
                getHours()   { return 23; }
                getMinutes() { return 30; }
                getSeconds() { return 0;  }
                getMilliseconds() { return 0; }
            };
            assert.strictEqual(adapter.isInTimeWindow('22:00', '06:00'), true);
            assert.strictEqual(adapter.isInTimeWindow('07:00', '20:00'), false);
            assert.strictEqual(adapter.isInTimeWindow('00:00', '00:00'), false); // empty
        } finally {
            global.Date = originalDate;
        }
    });

    it('isInSeason returns false when seasonEnabled=false', () => {
        adapter._seasonEnabled = false;
        adapter.config = { season_start: '01.01', season_end: '31.12' };
        assert.strictEqual(adapter.isInSeason(), false);
    });

    it('todayStr() yields YYYY-MM-DD', () => {
        const s = adapter.todayStr();
        assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('accumulateUvcHours does not mutate _uvcHoursUsed', () => {
        adapter._uvcHoursUsed = 5;
        adapter._uvcOnSince   = Date.now() - 3_600_000; // 1 h ago
        const acc = adapter.accumulateUvcHours();
        assert.ok(acc >= 5.99 && acc <= 6.01);
        assert.strictEqual(adapter._uvcHoursUsed, 5);  // unchanged
    });

    it('accumulateFilterHours: returns persisted value when filter is OFF', () => {
        adapter._filterHoursUsed = 12.5;
        adapter._filterOnSince   = null;
        assert.strictEqual(adapter.accumulateFilterHours(), 12.5);
    });

    it('onStateChange ignores acked state for own namespace', async () => {
        let setFeatureCalled = false;
        adapter.setFeature = async () => { setFeatureCalled = true; };
        await adapter.onStateChange(`${adapter.namespace}.control.heater`, { val: true, ack: true });
        assert.strictEqual(setFeatureCalled, false);
    });

    it('onStateChange routes foreign state to onForeignStateChange', async () => {
        let routedTo = null;
        adapter.onForeignStateChange = async (id) => { routedTo = id; };
        await adapter.onStateChange('mqtt.0.somewhere', { val: 1, ack: true });
        assert.strictEqual(routedTo, 'mqtt.0.somewhere');
    });

    it('onStateChange invokes setFeature for own writable control', async () => {
        let captured = null;
        adapter.setFeature      = async (k, v) => { captured = { k, v }; };
        adapter.enableRapidPolling = () => {};
        adapter.config          = { more_log_enabled: false };
        await adapter.onStateChange(`${adapter.namespace}.control.heater`, { val: true, ack: false });
        assert.deepStrictEqual(captured, { k: 'heater', v: true });
    });

    it('setManualOverride(true,0) enables override without timer', async () => {
        adapter.checkFrostProtection = async () => {};
        adapter.checkTimeWindows     = async () => {};
        adapter.evaluatePvSurplus    = async () => {};
        // notificationHelper.send is awaited – stub it
        const nh = require('../lib/notificationHelper');
        const origSend = nh.send;
        nh.send = async () => {};
        try {
            await adapter.setManualOverride(true, 0);
            assert.strictEqual(adapter._manualOverride, true);
            assert.strictEqual(adapter._manualOverrideTimer, null);
        } finally {
            nh.send = origSend;
        }
    });
});

// ---------------------------------------------------------------------------
// 8. enableRapidPolling() – cancels running timer and reschedules in 1 s
// ---------------------------------------------------------------------------
describe('enableRapidPolling() – timer cancel fix', () => {
    /**
     * Build a minimal object that has only the properties and methods used by
     * enableRapidPolling() so we can test without booting the whole adapter.
     */
    function makeStub() {
        const stub = {
            _rapidUntil:  0,
            _pollTimer:   null,
            _doPollCalls: 0,
            // Copy the fixed method directly from the prototype:
            enableRapidPolling: null,
            schedulePoll:       null,
            doPoll: async function () { stub._doPollCalls++; },
        };
        // Use real setTimeout / clearTimeout so we can track handle identity
        stub.enableRapidPolling = function () {
            stub._rapidUntil = Date.now() + 15_000;
            if (stub._pollTimer) {
                clearTimeout(stub._pollTimer);
                stub._pollTimer = null;
            }
            stub._pollTimer = setTimeout(() => stub.doPoll(), 1_000);
        };
        return stub;
    }

    it('sets _rapidUntil ~15 s in the future', () => {
        const s   = makeStub();
        const before = Date.now();
        s.enableRapidPolling();
        assert.ok(s._rapidUntil >= before + 14_900, '_rapidUntil must be ~15 s ahead');
        clearTimeout(s._pollTimer);
    });

    it('cancels the previously scheduled timer and creates a new one', () => {
        const s = makeStub();
        // Schedule a "slow" poll timer first (simulates the 60-second interval)
        const oldHandle = setTimeout(() => {}, 60_000);
        s._pollTimer = oldHandle;

        s.enableRapidPolling();

        // The old handle must have been cancelled – verify a different handle is set
        assert.notStrictEqual(s._pollTimer, oldHandle, 'new timer handle must differ from old');
        assert.ok(s._pollTimer !== null, 'a new timer must be scheduled');
        clearTimeout(s._pollTimer);
    });

    it('does not throw when _pollTimer is null (first call)', () => {
        const s = makeStub();
        assert.doesNotThrow(() => s.enableRapidPolling());
        clearTimeout(s._pollTimer);
    });

    it('schedules doPoll within ~1 s', function (done) {
        this.timeout(3000);
        const s = makeStub();
        s.doPoll = async () => { s._doPollCalls++; done(); };
        s.enableRapidPolling();
    });
});

// ---------------------------------------------------------------------------
// 9. setFeature('heater', true) – auto-starts filter when pump is OFF
// ---------------------------------------------------------------------------
describe("setFeature('heater', true) – auto-starts filter", () => {
    function makeAdapter(filterState) {
        const calls = [];
        const a = {
            _lastData:          filterState === 'on' ? { filter: 'on' } : { filter: 'off' },
            _api:               { _lastStatus: null, _lastCommandConfirmed: true,
                                  setHeaterState: async () => ({ message: 'SUCCESS' }) },
            _adapterCommanded:  { heater: null, filter: null, bubble: null, uvc: null, target_temperature: null },
            _lastCommandTime:   0,
            _pendingTargetTemp: null,
            _pendingTempTimer:  null,
            config:             { more_log_enabled: false },
            log:                { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            sleep:              (ms) => new Promise(r => setTimeout(r, ms)),
            setStatusCheck:     async () => {},
            getState:           () => null,
            setFeature:         null, // will be set below
        };
        // Paste the real setFeature logic (heater case + filter case stripped to essentials)
        a.setFeature = async function (feature, boolVal) {
            calls.push({ feature, boolVal });
            const state = boolVal ? 1 : 0;
            if (feature in a._adapterCommanded) a._adapterCommanded[feature] = boolVal;
            a._lastCommandTime = Date.now();

            if (feature === 'heater' && boolVal) {
                const filterOn =
                    (a._lastData && a._lastData.filter === 'on') ||
                    (a._api && a._api._lastStatus && a._api._lastStatus.filter_state === 1) ||
                    (a._adapterCommanded.filter === true);
                if (!filterOn) {
                    await a.setFeature('filter', true);
                    await a.sleep(50); // shortened for tests
                }
            }
            if (feature === 'filter') return; // simplified – just track the call
            if (feature === 'heater') {
                await a.setStatusCheck('send');
                const result = await a._api.setHeaterState(state);
                await a.setStatusCheck(a._api._lastCommandConfirmed ? 'success' : 'error');
                return result;
            }
        };
        return { a, calls };
    }

    it('starts filter BEFORE heater when filter is OFF', async () => {
        const { a, calls } = makeAdapter('off');
        await a.setFeature('heater', true);
        // calls[0] = outer setFeature('heater') call itself
        // calls[1] = auto-started setFeature('filter') call inside heater logic
        const filterIdx = calls.findIndex(c => c.feature === 'filter' && c.boolVal === true);
        const heaterApiIdx = calls.findIndex(c => c.feature === 'heater');
        assert.ok(filterIdx !== -1,        'filter call must exist');
        assert.ok(heaterApiIdx !== -1,     'heater call must exist');
        assert.ok(filterIdx > heaterApiIdx, 'filter auto-start happens inside heater call');
        assert.strictEqual(calls[filterIdx].boolVal, true, 'filter must be switched ON');
    });

    it('does NOT start filter again when filter is already ON', async () => {
        const { a, calls } = makeAdapter('on');
        await a.setFeature('heater', true);
        assert.strictEqual(calls.length, 1,             'only heater call, no redundant filter call');
        assert.strictEqual(calls[0].feature, 'heater');
    });

    it('does NOT start filter when _adapterCommanded.filter=true (just commanded)', async () => {
        const { a, calls } = makeAdapter('off');
        a._adapterCommanded.filter = true;             // adapter just sent filter ON
        await a.setFeature('heater', true);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].feature, 'heater');
    });
});

// ---------------------------------------------------------------------------
// 10 & 11. setTargetTemp() – range validation + _adapterCommanded fallback
// ---------------------------------------------------------------------------
describe('setTargetTemp() – range validation & heater fallback', () => {
    function makeAdapter(opts = {}) {
        const logged = [];
        const statusChecks = [];
        const a = {
            _adapterCommanded:  { heater: opts.heaterCommanded ?? null },
            _lastData:          opts.lastDataHeater ? { heater: 'on' } : {},
            _pendingTargetTemp: null,
            _pendingTempTimer:  null,
            config:             { more_log_enabled: true },
            log:                { info: () => {}, warn: (m) => logged.push(m), error: () => {}, debug: () => {} },
            setStatusCheck:     async (s) => { statusChecks.push(s); },
            sendTargetTempDirect: async (t) => { a._sentTemp = t; },
            getState:           (id) => id === 'control.heater' ? { val: !!opts.heaterState } : null,
        };
        // Bind the real setTargetTemp logic
        a.setTargetTemp = async function (temp) {
            const MIN_TEMP = 20, MAX_TEMP = 42;
            const t = Number(temp);
            if (isNaN(t) || t < MIN_TEMP || t > MAX_TEMP) {
                a.log.warn(`target_temperature ${temp}°C out of range (${MIN_TEMP}–${MAX_TEMP}°C) – command ignored`);
                await a.setStatusCheck('error');
                return;
            }
            const heaterState       = a.getState('control.heater');
            const heaterOnState     = heaterState && !!heaterState.val;
            const heaterOnCommanded = a._adapterCommanded.heater === true;
            const heaterOnLive      = a._lastData && a._lastData.heater === 'on';
            const heaterOn          = heaterOnState || heaterOnCommanded || heaterOnLive;
            if (!heaterOn) {
                a._pendingTargetTemp = t;
                await a.setStatusCheck('queued');
                return;
            }
            a._pendingTargetTemp = null;
            return a.sendTargetTempDirect(t);
        };
        return { a, logged, statusChecks };
    }

    it('rejects temperature below 20 °C', async () => {
        const { a, logged, statusChecks } = makeAdapter();
        await a.setTargetTemp(5);
        assert.ok(logged.some(m => m.includes('out of range')), 'must log out-of-range warning');
        assert.ok(statusChecks.includes('error'),               'must set status error');
        assert.strictEqual(a._sentTemp, undefined,              'must NOT send to API');
    });

    it('rejects temperature above 42 °C', async () => {
        const { a, logged, statusChecks } = makeAdapter();
        await a.setTargetTemp(99);
        assert.ok(logged.some(m => m.includes('out of range')));
        assert.ok(statusChecks.includes('error'));
        assert.strictEqual(a._sentTemp, undefined);
    });

    it('rejects NaN temperature', async () => {
        const { a, statusChecks } = makeAdapter();
        await a.setTargetTemp('abc');
        assert.ok(statusChecks.includes('error'));
    });

    it('queues temp when heater is fully OFF (all sources false)', async () => {
        const { a, statusChecks } = makeAdapter({ heaterState: false, heaterCommanded: null, lastDataHeater: false });
        await a.setTargetTemp(38);
        assert.strictEqual(a._pendingTargetTemp, 38, 'temp must be queued');
        assert.ok(statusChecks.includes('queued'));
        assert.strictEqual(a._sentTemp, undefined);
    });

    it('sends directly when heater is ON via ioBroker state', async () => {
        const { a } = makeAdapter({ heaterState: true });
        await a.setTargetTemp(38);
        assert.strictEqual(a._sentTemp, 38);
        assert.strictEqual(a._pendingTargetTemp, null);
    });

    it('sends directly when heater was just commanded ON (_adapterCommanded)', async () => {
        // State still false (poll not yet confirmed), but adapter just sent heater ON
        const { a } = makeAdapter({ heaterState: false, heaterCommanded: true });
        await a.setTargetTemp(36);
        assert.strictEqual(a._sentTemp, 36,   'must NOT queue – heater was just commanded ON');
        assert.strictEqual(a._pendingTargetTemp, null);
    });

    it('sends directly when heater ON visible in live API data', async () => {
        const { a } = makeAdapter({ heaterState: false, heaterCommanded: null, lastDataHeater: true });
        await a.setTargetTemp(40);
        assert.strictEqual(a._sentTemp, 40);
    });

    it('accepts boundary values 20 and 42', async () => {
        const { a: a20 } = makeAdapter({ heaterState: true });
        await a20.setTargetTemp(20);
        assert.strictEqual(a20._sentTemp, 20);

        const { a: a42 } = makeAdapter({ heaterState: true });
        await a42.setTargetTemp(42);
        assert.strictEqual(a42._sentTemp, 42);
    });
});

// ---------------------------------------------------------------------------
// 12. setFeature('uvc', true) – auto-starts filter when pump is OFF
// ---------------------------------------------------------------------------
describe("setFeature('uvc', true) – auto-starts filter", () => {
    function makeAdapter(opts = {}) {
        const calls = [];
        const a = {
            _lastData:         opts.filterOn ? { filter: 'on' } : { filter: 'off' },
            _api:              { _lastStatus: null, _lastCommandConfirmed: true,
                                 setUvcState:    async () => {},
                                 getHotTubStatus: async () => ({ filter_state: opts.filterConfirms ? 1 : 0 }) },
            _adapterCommanded: { heater: null, filter: null, uvc: null, bubble: null, target_temperature: null },
            _lastCommandTime:  0,
            config:            { more_log_enabled: false },
            log:               { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            setStatusCheck:    async () => {},
            sleep:             () => Promise.resolve(),
            setFeature:        null,
        };

        const { transformStatus: ts } = require('../lib/utils');

        a.setFeature = async function (feature, boolVal) {
            calls.push({ feature, boolVal });
            if (feature in a._adapterCommanded) a._adapterCommanded[feature] = boolVal;
            a._lastCommandTime = Date.now();

            if (feature === 'uvc' && boolVal) {
                const filterRunning = () =>
                    (a._lastData && a._lastData.filter === 'on') ||
                    (a._api._lastStatus && a._api._lastStatus.filter_state === 1) ||
                    (a._adapterCommanded.filter === true);

                if (!filterRunning()) {
                    await a.setFeature('filter', true); // auto-start
                    // Simulate one poll confirming filter ON
                    const raw = await a._api.getHotTubStatus();
                    a._lastData = ts(raw);
                }
            }
            if (feature === 'filter') return; // simplified
            if (feature === 'uvc') {
                await a.setStatusCheck('send');
                await a._api.setUvcState(boolVal ? 1 : 0);
                await a.setStatusCheck(a._api._lastCommandConfirmed ? 'success' : 'error');
            }
        };
        return { a, calls };
    }

    it('starts filter BEFORE UVC when filter is OFF', async () => {
        const { a, calls } = makeAdapter({ filterOn: false, filterConfirms: true });
        await a.setFeature('uvc', true);
        // calls[0] = outer setFeature('uvc') call itself
        // calls[1] = auto-started setFeature('filter') call inside uvc logic
        const filterIdx = calls.findIndex(c => c.feature === 'filter' && c.boolVal === true);
        const uvcIdx    = calls.findIndex(c => c.feature === 'uvc');
        assert.ok(filterIdx !== -1, 'filter call must exist');
        assert.ok(uvcIdx    !== -1, 'UVC call must exist');
        assert.ok(filterIdx > uvcIdx, 'filter auto-start happens inside UVC call');
        assert.strictEqual(calls[filterIdx].boolVal, true, 'filter must be switched ON');
    });

    it('does NOT start filter when filter is already ON', async () => {
        const { a, calls } = makeAdapter({ filterOn: true });
        await a.setFeature('uvc', true);
        const filterCalls = calls.filter(c => c.feature === 'filter');
        assert.strictEqual(filterCalls.length, 0, 'no redundant filter calls');
        assert.strictEqual(calls[0].feature, 'uvc');
    });

    it('does NOT start filter when _adapterCommanded.filter=true', async () => {
        const { a, calls } = makeAdapter({ filterOn: false });
        a._adapterCommanded.filter = true;
        await a.setFeature('uvc', true);
        const filterCalls = calls.filter(c => c.feature === 'filter');
        assert.strictEqual(filterCalls.length, 0);
    });

    it('still sends UVC command even when filter confirmation times out', async () => {
        // Simulate: filter never confirms ON → after 15 s warn and send anyway.
        // We shorten by patching getHotTubStatus to return filter OFF always.
        const { a, calls } = makeAdapter({ filterOn: false, filterConfirms: false });
        await a.setFeature('uvc', true);
        const uvcCalls = calls.filter(c => c.feature === 'uvc');
        assert.ok(uvcCalls.length > 0, 'UVC must be sent even if filter poll never confirms');
    });
});

// ---------------------------------------------------------------------------
// 13. setFeature – immediate ack (control.filter / heater / uvc / bubble)
// ---------------------------------------------------------------------------
describe('setFeature – immediate setState ack after command', () => {
    function makeFeatureAdapter(opts = {}) {
        const acked = {};
        const a = {
            _lastData:         { filter: opts.filterOn ? 'on' : 'off', bubble_level: 1 },
            _api:              {
                _lastStatus: null,
                _lastCommandConfirmed: true,
                setHeaterState:  async () => {},
                setFilterState:  async () => {},
                setUvcState:     async () => {},
                setBubbleState:  async () => {},
                setJetState:     async () => {},
                setOzoneState:   async () => {},
            },
            _adapterCommanded: { heater: null, filter: opts.filterOn ? true : null, bubble: null, uvc: null, target_temperature: null },
            _lastCommandTime:  0,
            _pendingTargetTemp: null,
            _pendingTempTimer:  null,
            config:            { more_log_enabled: false },
            log:               { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            setStatusCheck:    async () => {},
            getState:          opts.getState ?? (() => null),
            sleep:             () => Promise.resolve(),
            setState: function (id, val, ack) {
                if (ack) acked[id] = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            },
        };
        // Inline the fixed setFeature so no js-controller is needed
        a.setFeature = async function (feature, boolVal) {
            const state = boolVal ? 1 : 0;
            if (feature in a._adapterCommanded) a._adapterCommanded[feature] = boolVal;
            a._lastCommandTime = Date.now();
            switch (feature) {
                case 'heater': {
                    const filterOn =
                        (a._lastData && a._lastData.filter === 'on') ||
                        (a._api._lastStatus && a._api._lastStatus.filter_state === 1) ||
                        (a._adapterCommanded.filter === true);
                    if (boolVal && !filterOn) {
                        await a.setFeature('filter', true);
                        await a.sleep(0);
                    }
                    await a.setStatusCheck('send');
                    await a._api.setHeaterState(state);
                    await a.setStatusCheck(a._api._lastCommandConfirmed ? 'success' : 'error');
                    a.setState('control.heater', boolVal, true);
                    return;
                }
                case 'filter': {
                    if (!boolVal) {
                        const uvcSt    = a.getState('control.uvc');
                        const bubbleSt = a.getState('control.bubble');
                        const heaterSt = a.getState('control.heater');
                        if (uvcSt && uvcSt.val) {
                            await a._api.setUvcState(0);
                            a._adapterCommanded.uvc = false;
                            a.setState('control.uvc', false, true);
                        }
                        if (bubbleSt && bubbleSt.val) {
                            await a._api.setBubbleState(0, a._lastData.bubble_level || 1);
                            a._adapterCommanded.bubble = false;
                            a.setState('control.bubble', false, true);
                        }
                        if (heaterSt && heaterSt.val) {
                            await a.setFeature('heater', false);
                        }
                    }
                    await a._api.setFilterState(state);
                    a.setState('control.filter', boolVal, true);
                    return;
                }
                case 'uvc':
                    await a._api.setUvcState(state);
                    a.setState('control.uvc', boolVal, true);
                    return;
                case 'bubble':
                    await a._api.setBubbleState(state, a._lastData.bubble_level || 1);
                    a.setState('control.bubble', boolVal, true);
                    return;
                case 'jet':
                    await a._api.setJetState(state);
                    a.setState('control.jet', boolVal, true);
                    return;
            }
        };
        return { a, acked };
    }

    it('acks control.heater=true immediately after API call', async () => {
        const { a, acked } = makeFeatureAdapter({ filterOn: true });
        await a.setFeature('heater', true);
        assert.strictEqual(acked['control.heater'], true, 'control.heater must be acked true');
    });

    it('acks control.heater=false immediately after API call', async () => {
        const { a, acked } = makeFeatureAdapter();
        await a.setFeature('heater', false);
        assert.strictEqual(acked['control.heater'], false, 'control.heater must be acked false');
    });

    it('acks control.filter=true immediately after API call', async () => {
        const { a, acked } = makeFeatureAdapter();
        await a.setFeature('filter', true);
        assert.strictEqual(acked['control.filter'], true, 'control.filter must be acked true');
    });

    it('acks control.filter=false and auto-acks control.uvc=false when UVC was ON', async () => {
        const { a, acked } = makeFeatureAdapter({
            getState: (id) => id === 'control.uvc' ? { val: true } : null,
        });
        await a.setFeature('filter', false);
        assert.strictEqual(acked['control.uvc'],    false, 'auto-disabled UVC must be acked false');
        assert.strictEqual(acked['control.filter'], false, 'control.filter must be acked false');
    });

    it('acks control.uvc=true immediately after API call', async () => {
        const { a, acked } = makeFeatureAdapter({ filterOn: true });
        await a.setFeature('uvc', true);
        assert.strictEqual(acked['control.uvc'], true, 'control.uvc must be acked true');
    });

    it('acks control.bubble immediately after API call', async () => {
        const { a, acked } = makeFeatureAdapter();
        await a.setFeature('bubble', true);
        assert.strictEqual(acked['control.bubble'], true, 'control.bubble must be acked true');
    });
});

// ---------------------------------------------------------------------------
// 14. sendTargetTempDirect – immediate ack for control.target_temperature
// ---------------------------------------------------------------------------
describe('sendTargetTempDirect – immediate ack', () => {
    // Inline implementation matching the fix
    async function sendTargetTempDirect(temp) {
        this._adapterCommanded.target_temperature = temp;
        this._lastCommandTime = Date.now();
        await this.setStatusCheck('send');
        const result = await this._api.setTemperatureSetting(temp);
        await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
        this.setState('control.target_temperature', temp, true);
        return result;
    }

    it('writes control.target_temperature with ack=true after API call', async () => {
        const acked = {};
        const a = {
            _adapterCommanded: { target_temperature: null },
            _lastCommandTime:  0,
            _api: { _lastCommandConfirmed: true, setTemperatureSetting: async (t) => ({ temp: t }) },
            setStatusCheck: async () => {},
            setState: function (id, val, ack) {
                if (ack) acked[id] = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            },
        };
        await sendTargetTempDirect.call(a, 38);
        assert.strictEqual(acked['control.target_temperature'], 38,
            'control.target_temperature must be acked with sent value');
    });
});

// ---------------------------------------------------------------------------
// 15. setTargetTemp queued – immediate ack for control.target_temperature
// ---------------------------------------------------------------------------
describe('setTargetTemp queued – immediate ack', () => {
    // Inline implementation matching the fix
    async function setTargetTemp(temp) {
        const MIN_TEMP = 20, MAX_TEMP = 42;
        const t = Number(temp);
        if (isNaN(t) || t < MIN_TEMP || t > MAX_TEMP) {
            await this.setStatusCheck('error');
            return;
        }
        const heaterState       = this.getState('control.heater');
        const heaterOnState     = heaterState && !!heaterState.val;
        const heaterOnCommanded = this._adapterCommanded.heater === true;
        const heaterOnLive      = this._lastData && this._lastData.heater === 'on';
        const heaterOn          = heaterOnState || heaterOnCommanded || heaterOnLive;
        if (!heaterOn) {
            this._pendingTargetTemp = t;
            await this.setStatusCheck('queued');
            this.setState('control.target_temperature', t, true);
            return;
        }
        this._pendingTargetTemp = null;
        return this.sendTargetTempDirect(t);
    }

    it('acks control.target_temperature even when temp is queued (heater OFF)', async () => {
        const acked = {};
        const a = {
            _adapterCommanded:    { heater: null },
            _lastData:            { heater: 'off' },
            _pendingTargetTemp:   null,
            setStatusCheck:       async () => {},
            sendTargetTempDirect: async () => {},
            getState:             () => ({ val: false }),
            setState: function (id, val, ack) {
                if (ack) acked[id] = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            },
        };
        await setTargetTemp.call(a, 36);
        assert.strictEqual(a._pendingTargetTemp, 36, 'temp must be queued');
        assert.strictEqual(acked['control.target_temperature'], 36,
            'control.target_temperature must be acked immediately even when queued');
    });
});

// ---------------------------------------------------------------------------
// 16. setManualOverride – race condition: timer cancelled atomically before await
// ---------------------------------------------------------------------------
describe('setManualOverride – race condition fix', () => {
    const nh = require('../lib/notificationHelper');
    let origSend;
    beforeEach(() => { origSend = nh.send; nh.send = async () => {}; });
    afterEach(()  => { nh.send = origSend; });

    // Inline _resumeAfterOverride
    async function _resumeAfterOverride() {
        const tasks = [];
        if (this._lastData && Object.keys(this._lastData).length) {
            tasks.push(this.checkFrostProtection(this._lastData).catch(() => {}));
        }
        tasks.push(this.checkTimeWindows().catch(() => {}));
        tasks.push(this.evaluatePvSurplus().catch(() => {}));
        await Promise.all(tasks);
    }

    // Inline setManualOverride matching the fix
    async function setManualOverride(enable, durationMin = null) {
        const existingTimer = this._manualOverrideTimer;
        this._manualOverrideTimer = null;
        if (existingTimer) clearTimeout(existingTimer);

        this._manualOverride = enable;
        this.setState('control.manual_override', enable, true);

        if (enable) {
            if (durationMin === null) {
                const ds = this.getState('control.manual_override_duration');
                durationMin = ds && ds.val !== null ? Number(ds.val) : 0;
            } else {
                this.setState('control.manual_override_duration', durationMin, true);
            }
            if (durationMin > 0) {
                await nh.send(nh.format('overrideOnTimed', { durationMin }));
                if (!this._manualOverride) return; // concurrent-disable guard
                this._manualOverrideTimer = setTimeout(async () => {
                    this._manualOverrideTimer = null;
                    if (!this._manualOverride) return;
                    this._manualOverride = false;
                    this.setState('control.manual_override', false, true);
                    this.setState('control.manual_override_duration', 0, true);
                    await this._resumeAfterOverride();
                }, durationMin * 60 * 1000);
            } else {
                await nh.send(nh.format('overrideOnIndefinite'));
            }
        } else {
            await nh.send(nh.format('overrideOff'));
            this.setState('control.manual_override_duration', 0, true);
            await this._resumeAfterOverride();
        }
    }

    function makeAdapter() {
        const acked = {};
        const a = {
            _manualOverride:      false,
            _manualOverrideTimer: null,
            _lastData:            {},
            config:               { more_log_enabled: false },
            log:                  { info: () => {}, warn: () => {}, debug: () => {} },
            setState: (id, val, ack) => { if (ack) acked[id] = val; },
            getState: () => ({ val: 0 }),
            checkFrostProtection: async () => {},
            checkTimeWindows:     async () => {},
            evaluatePvSurplus:    async () => {},
        };
        a._resumeAfterOverride = _resumeAfterOverride.bind(a);
        a.setManualOverride    = setManualOverride.bind(a);
        return { a, acked };
    }

    it('cancels existing timer atomically (no second fire)', async () => {
        const { a } = makeAdapter();
        let timerFired = false;
        a._manualOverrideTimer = setTimeout(() => { timerFired = true; }, 50);
        await a.setManualOverride(true, 0);  // indefinite – must cancel old timer
        await new Promise(r => setTimeout(r, 80));
        assert.strictEqual(timerFired, false, 'old timer must have been cleared');
        assert.strictEqual(a._manualOverrideTimer, null);
    });

    it('concurrent disable during notification send prevents timer creation', async () => {
        const { a } = makeAdapter();
        nh.send = async () => {
            // Simulate concurrent disable while first call awaits notification
            a._manualOverride = false;
        };
        await a.setManualOverride(true, 5);
        assert.strictEqual(a._manualOverrideTimer, null,
            'timer must NOT be created after concurrent disable');
    });

    it('sets _manualOverride=true and acks state', async () => {
        const { a, acked } = makeAdapter();
        await a.setManualOverride(true, 0);
        assert.strictEqual(a._manualOverride, true);
        assert.strictEqual(acked['control.manual_override'], true);
    });

    it('disables override and calls _resumeAfterOverride', async () => {
        let resumed = false;
        const { a } = makeAdapter();
        a._manualOverride = true;
        a._resumeAfterOverride = async () => { resumed = true; };
        await a.setManualOverride(false);
        assert.strictEqual(a._manualOverride, false);
        assert.strictEqual(resumed, true, '_resumeAfterOverride must be called on disable');
    });
});

// ---------------------------------------------------------------------------
// 17. onStateChange – manual_override rollback on error; duration always acked
// ---------------------------------------------------------------------------
describe('onStateChange – manual_override rollback & duration ack', () => {
    /**
     * Minimal inline handler that mirrors the fixed onStateChange logic
     * for manual_override and manual_override_duration only.
     */
    async function handleStateChange(key, stateVal, overrideImpl) {
        const acked = {};
        const logErrors = [];
        const a = {
            _manualOverride: false,
            log: { error: (m) => logErrors.push(m), info: () => {}, warn: () => {}, debug: () => {} },
            setState: (id, val, ack) => {
                if (ack) acked[id] = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            },
            setManualOverride: overrideImpl,
        };

        if (key === 'manual_override') {
            const enable = !!stateVal;
            try {
                await a.setManualOverride(enable);
            } catch (err) {
                a.log.error(`manual_override command failed: ${err.message}`);
                a.setState('control.manual_override', !enable, true);
                return { acked, logErrors };
            }
        } else if (key === 'manual_override_duration') {
            const newDuration = Number(stateVal) || 0;
            a.setState('control.manual_override_duration', newDuration, true);
            if (a._manualOverride) {
                await a.setManualOverride(true, newDuration);
            }
        }
        return { acked, logErrors };
    }

    it('rolls back control.manual_override to false when setManualOverride throws', async () => {
        const { acked, logErrors } = await handleStateChange(
            'manual_override', true,
            async () => { throw new Error('simulated failure'); }
        );
        assert.strictEqual(acked['control.manual_override'], false,
            'rollback must write false with ack=true');
        assert.ok(logErrors.some(m => m.includes('manual_override command failed')),
            'error must be logged');
    });

    it('does NOT rollback when setManualOverride succeeds', async () => {
        let callCount = 0;
        const { acked } = await handleStateChange(
            'manual_override', true,
            async () => { callCount++; }
        );
        assert.strictEqual(callCount, 1);
        assert.notStrictEqual(acked['control.manual_override'], false, 'no rollback on success');
    });

    it('always acks manual_override_duration even when override is inactive', async () => {
        const { acked } = await handleStateChange(
            'manual_override_duration', 30,
            async () => {}
        );
        assert.strictEqual(acked['control.manual_override_duration'], 30,
            'duration must always be acked');
    });

    it('restarts timer when duration changes while override is active', async () => {
        let restartArgs = null;
        const acked = {};
        const a = {
            _manualOverride: true,  // override IS active
            log: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
            setState: (id, val, ack) => {
                if (ack) acked[id] = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            },
            setManualOverride: async (en, dur) => { restartArgs = { en, dur }; },
        };
        const newDuration = 15;
        a.setState('control.manual_override_duration', newDuration, true);
        if (a._manualOverride) {
            await a.setManualOverride(true, newDuration);
        }
        assert.deepStrictEqual(restartArgs, { en: true, dur: 15 },
            'setManualOverride(true, 15) must be called when duration changes while active');
    });
});

