'use strict';

/**
 * Tests for lib/consumptionHelper.js
 *
 * Run with: npx mocha test/consumptionHelper.test.js
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Helpers – minimal ioBroker adapter mock
// ---------------------------------------------------------------------------
function makeAdapter({ states = {}, foreignStates = {}, logWarn } = {}) {
    const logs = { debug: [], info: [], warn: [], error: [] };
    return {
        config: { consumption_enabled: true, external_energy_total_id: 'meter.0.total_kwh' },
        log: {
            debug: m => logs.debug.push(m),
            info:  m => logs.info.push(m),
            warn:  m => { logs.warn.push(m); if (logWarn) logWarn(m); },
            error: m => logs.error.push(m),
        },
        logs,
        _states: { ...states },
        _sets:   [],
        async getStateAsync(id)         { return this._states[id] ?? null; },
        async getForeignStateAsync(id)  { return foreignStates[id] ?? null; },
        async setStateAsync(id, valOrObj, ack) {
            const val = (valOrObj && typeof valOrObj === 'object') ? valOrObj.val : valOrObj;
            this._states[id] = { val };
            this._sets.push({ id, val });
        },
    };
}

/** Deep-clone the consumptionHelper singleton so tests are isolated */
function freshHelper() {
    // Clear require cache for isolation
    const key = require.resolve('../lib/consumptionHelper');
    delete require.cache[key];
    return require('../lib/consumptionHelper');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('consumptionHelper', () => {

    afterEach(() => {
        // Cleanup any lingering timer from the last test
        try { freshHelper().cleanup(); } catch (_) {}
    });

    // ── init() ──────────────────────────────────────────────────────────────

    describe('init()', () => {
        it('skips init when consumption_enabled = false', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            adapter.config.consumption_enabled = false;
            await helper.init(adapter);
            assert.strictEqual(helper._activeTimer, null, 'no timer should be created');
        });

        it('warns and skips when no energyId configured', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            adapter.config.external_energy_total_id = '';
            await helper.init(adapter);
            assert.ok(adapter.logs.warn.some(m => m.includes('no Object-ID')));
            assert.strictEqual(helper._activeTimer, null);
        });

        it('schedules a timer when properly configured', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            await helper.init(adapter);
            assert.ok(helper._activeTimer !== null, 'timer must be scheduled');
            helper.cleanup();
        });

        it('logs the energyId at info level', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            await helper.init(adapter);
            assert.ok(adapter.logs.info.some(m => m.includes('meter.0.total_kwh')));
            helper.cleanup();
        });
    });

    // ── cleanup() ───────────────────────────────────────────────────────────

    describe('cleanup()', () => {
        it('clears the active timer and sets it to null', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            await helper.init(adapter);
            assert.ok(helper._activeTimer !== null);
            helper.cleanup();
            assert.strictEqual(helper._activeTimer, null);
        });

        it('is safe to call multiple times without errors', () => {
            const helper = freshHelper();
            assert.doesNotThrow(() => {
                helper.cleanup();
                helper.cleanup();
            });
        });
    });

    // ── _scheduleDailyReset() – daily close logic ────────────────────────────

    describe('_scheduleDailyReset() daily close', () => {
        it('calculates day_kwh = rawNow - savedNum and writes both states', async () => {
            const helper = freshHelper();

            // Pre-seed states
            const states       = { 'consumption.last_total_kwh': { val: 100 } };
            const foreignStates = { 'meter.0.total_kwh': { val: 103.5 } };
            const adapter      = makeAdapter({ states, foreignStates });

            // Manually trigger the close logic (bypass setTimeout)
            await helper._runDailyClose(adapter, 'meter.0.total_kwh');

            const dayKwh    = adapter._sets.find(s => s.id === 'consumption.day_kwh');
            const lastTotal = adapter._sets.find(s => s.id === 'consumption.last_total_kwh');

            assert.strictEqual(dayKwh?.val,    3.5,   'day_kwh should be 3.5');
            assert.strictEqual(lastTotal?.val, 103.5, 'last_total_kwh should be updated to rawNow');
        });

        it('writes day_kwh = 0 when no baseline is available (first run)', async () => {
            const helper       = freshHelper();
            const foreignStates = { 'meter.0.total_kwh': { val: 50 } };
            const adapter      = makeAdapter({ states: {}, foreignStates });

            await helper._runDailyClose(adapter, 'meter.0.total_kwh');

            const dayKwh = adapter._sets.find(s => s.id === 'consumption.day_kwh');
            assert.strictEqual(dayKwh?.val, 0, 'no baseline → day_kwh = 0');
        });

        it('skips writing when meter is not readable', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({ states: {}, foreignStates: {} }); // meter returns null

            const warnsBefore = adapter.logs.warn.length;
            await helper._runDailyClose(adapter, 'meter.0.total_kwh');

            assert.strictEqual(adapter._sets.length, 0, 'nothing should be written');
            assert.ok(adapter.logs.warn.length > warnsBefore, 'should log a warning');
        });

        it('rounds day_kwh to 3 decimal places', async () => {
            const helper       = freshHelper();
            const states       = { 'consumption.last_total_kwh': { val: 10.001 } };
            const foreignStates = { 'meter.0.total_kwh': { val: 10.0014999 } };
            const adapter      = makeAdapter({ states, foreignStates });

            await helper._runDailyClose(adapter, 'meter.0.total_kwh');

            const dayKwh = adapter._sets.find(s => s.id === 'consumption.day_kwh');
            // 10.0014999 - 10.001 = 0.0004999 → rounded to 0.001 (3 decimals)
            assert.ok(Number.isFinite(dayKwh?.val), 'day_kwh must be a number');
            assert.strictEqual(String(dayKwh.val).split('.')[1]?.length ?? 0 <= 3, true, 'max 3 decimal places');
        });

        it('handles negative delta (meter replacement) gracefully', async () => {
            const helper       = freshHelper();
            const states       = { 'consumption.last_total_kwh': { val: 9999 } };
            const foreignStates = { 'meter.0.total_kwh': { val: 5 } }; // new meter starts at 5
            const adapter      = makeAdapter({ states, foreignStates });

            await helper._runDailyClose(adapter, 'meter.0.total_kwh');

            const dayKwh = adapter._sets.find(s => s.id === 'consumption.day_kwh');
            // Result will be negative – callers should handle; we just ensure no crash
            assert.ok(Number.isFinite(dayKwh?.val), 'should still write a numeric value');
        });

        it('handles getStateAsync throwing an error gracefully', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({ foreignStates: { 'meter.0.total_kwh': { val: 10 } } });
            adapter.getStateAsync = async () => { throw new Error('DB offline'); };

            // Should not throw – error is caught internally
            await assert.doesNotReject(() => helper._runDailyClose(adapter, 'meter.0.total_kwh'));
            assert.ok(adapter.logs.warn.some(m => m.includes('DB offline')));
        });
    });

    // ── Timer double-scheduling guard ───────────────────────────────────────

    describe('timer guard', () => {
        it('cancels existing timer before scheduling a new one', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            await helper.init(adapter);

            const first = helper._activeTimer;
            helper._scheduleDailyReset();
            const second = helper._activeTimer;

            assert.notStrictEqual(first, second, 'should be a new timer reference');
            helper.cleanup();
        });
    });
});
