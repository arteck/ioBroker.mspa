'use strict';

/**
 * Regression tests for manual_override behaviour:
 *
 *  1. Setting the target temperature via the adapter (ioBroker state) must
 *     NEVER flip control.manual_override to true, even while an automation
 *     (season/winter/PV) is active.
 *  2. A brief internet/API outage while sending a command must NOT leave
 *     stale "commanded" markers that would falsely trigger manual_override
 *     on the next successful poll ("idiot-proof" against short connectivity
 *     drops).
 *  3. control.bubble (and bubble_level) changes on the device are never
 *     monitored by the app-change detector and therefore can never trigger
 *     manual_override.
 *
 * These tests exercise the REAL production code (lib/commands.js +
 * lib/states.js publishStatus + lib/manualOverride.js), not re-implemented
 * logic, so they catch real regressions.
 */

const assert = require('assert');
const { RateTracker } = require('../lib/utils');
const commands = require('../lib/commands');
const states = require('../lib/states');
const manualOverride = require('../lib/manualOverride');

function makeAdapter(overrides = {}) {
    const stateStore = {};
    const a = {
        namespace: 'mspa.0',
        config: {
            more_log_enabled: false,
            app_change_override_min: 30,
            notify_telegram_enabled: false,
        },
        log: { info() {}, warn() {}, error() {}, debug() {} },
        _api: {
            model: 'test',
            _lastCommandConfirmed: true,
            async setTemperatureSetting(temp) {
                this._lastSetTemp = temp;
                return { temperature_setting: temp };
            },
            async setHeaterState() { return {}; },
            async setFilterState() { return {}; },
            async setBubbleState() { return {}; },
            async setJetState() { return {}; },
            async setOzoneState() { return {}; },
            async setUvcState() { return {}; },
            async getHotTubStatus() { return {}; },
        },
        _adapterCommanded: {
            heater: null, filter: null, bubble: null, jet: null, ozone: null, uvc: null, target_temperature: null,
        },
        _lastCommandTime: 0,
        _manualOverride: false,
        _manualOverrideTimer: null,
        _seasonEnabled: true,      // automation active → app-change detector is armed
        _winterModeActive: false,
        _winterFrostActive: false,
        _pvActive: false,
        _pvStageTimer: null,
        _pvDeactivateTimer: null,
        _pvManagedFeatures: { heater: false, filter: false, uvc: false },
        _timeWindowActive: [],
        _pendingTargetTemp: null,
        _pendingTempTimer: null,
        _uvcOnSince: null,
        _uvcHoursUsed: 0,
        _filterOnSince: null,
        _filterHoursUsed: 0,
        _lastHeatRate: 0,
        _dynamicStateIds: new Set(),
        _heatTracker: new RateTracker({ min: 0.05, max: 3.5, minSampleMinutes: 5 }),
        _coolTracker: new RateTracker({ min: 0.05, max: 3.5, minSampleMinutes: 5 }),
        _lastData: {},
        _unloading: false,
        setStray(fn, ms) { return setTimeout(fn, ms); },
        async sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
        accumulateUvcHours() { return this._uvcHoursUsed; },
        getUvcTodayHours() { return 0; },
        accumulateFilterHours() { return this._filterHoursUsed; },
        async computeUvcExpiry() {},
        async setStatusCheck() {},
        async pvStagedDeactivate() {},
        async pvCancelAllDeactivationTimers() {},
        async evaluatePvSurplus() {},
        async checkTimeWindows() {},
        async checkFrostProtection() {},
        setState(id, val, ack) {
            stateStore[id] = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
        },
        async setStateAsync(id, val) { this.setState(id, val); },
        async setStateChangedAsync(id, val) { this.setState(id, val); },
        async getStateAsync(id) {
            return id in stateStore ? { val: stateStore[id] } : null;
        },
        states: stateStore,
        ...overrides,
    };
    // Bind real production functions the same way main.js does
    a.setTargetTemp = (temp) => commands.setTargetTemp(a, temp);
    a.sendTargetTempDirect = (temp, opts) => commands.sendTargetTempDirect(a, temp, opts);
    a.setFeature = (feature, val, opts) => commands.setFeature(a, feature, val, opts);
    a._scheduleCommandedReset = (feature, val, delayMs) => commands._scheduleCommandedReset(a, feature, val, delayMs);
    a.setManualOverride = (enable, duration) => manualOverride.setManualOverride(a, enable, duration);
    return a;
}

describe('manual_override – adapter-set temperature must not count as manual intervention', () => {

    it('1) setTargetTemp() via adapter (heater already ON) does NOT trigger manual_override, even with automation active', async () => {
        const a = makeAdapter();
        a.states['control.heater'] = true; // heater already on

        // User sets temperature via ioBroker admin/state (fromUser=true internally)
        await a.setTargetTemp(38);
        assert.strictEqual(a._adapterCommanded.target_temperature, 38);
        assert.ok(a._lastCommandTime > 0, 'command time must be recorded');

        // Poll immediately confirms the exact same value the adapter requested
        await states.publishStatus(a, {
            heater: 'on', filter: 'off', bubble: 'off', jet: 'off', ozone: 'off', uvc: 'off',
            target_temperature: 38, water_temperature: 30, heat_state: 2,
        });

        assert.strictEqual(a._manualOverride, false, 'manual_override must stay false after an adapter-initiated temperature change');
    });

    it('2) setTargetTemp() then poll AFTER the 30s grace period still confirms same temp → still no manual_override', async () => {
        const a = makeAdapter();
        a.states['control.heater'] = true;
        await a.setTargetTemp(36);

        // Simulate time passing beyond the command grace period
        a._lastCommandTime = Date.now() - 31_000;

        await states.publishStatus(a, {
            heater: 'on', filter: 'off', bubble: 'off', jet: 'off', ozone: 'off', uvc: 'off',
            target_temperature: 36, water_temperature: 28, heat_state: 2,
        });

        assert.strictEqual(a._manualOverride, false, 'device confirming the adapter-requested temp must never be treated as an app change');
    });

    it('3) Brief internet outage while sending temperature clears the commanded marker so no false override happens afterwards', async () => {
        const a = makeAdapter();
        a.states['control.heater'] = true;
        a._api.setTemperatureSetting = async () => { throw new Error('ETIMEDOUT – network unreachable'); };

        await assert.rejects(() => a.setTargetTemp(40));
        assert.strictEqual(a._adapterCommanded.target_temperature, null, 'commanded marker must be cleared on send failure');

        // Grace period already elapsed, automation active, device still reports the OLD value
        a._lastCommandTime = Date.now() - 31_000;
        await states.publishStatus(a, {
            heater: 'on', filter: 'off', bubble: 'off', jet: 'off', ozone: 'off', uvc: 'off',
            target_temperature: 30, water_temperature: 28, heat_state: 2,
        });

        assert.strictEqual(a._manualOverride, false, 'a failed/lost command must never cause a false manual_override');
    });

    it('4) An actual APP change (device value differs from what the adapter commanded) DOES trigger manual_override', async () => {
        const a = makeAdapter();
        a.states['control.heater'] = true;
        await a.setTargetTemp(38);
        a._lastCommandTime = Date.now() - 31_000; // outside grace period

        // Device now reports a temperature nobody in the adapter requested (real app change)
        await states.publishStatus(a, {
            heater: 'on', filter: 'off', bubble: 'off', jet: 'off', ozone: 'off', uvc: 'off',
            target_temperature: 41, water_temperature: 28, heat_state: 2,
        });

        assert.strictEqual(a._manualOverride, true, 'a genuine app-side change must still activate manual_override');
        clearTimeout(a._manualOverrideTimer);
    });

    it('5) control.bubble changes on the device are never monitored and never trigger manual_override', async () => {
        const a = makeAdapter();
        // Adapter never touched bubble → _adapterCommanded.bubble stays null,
        // simulating the app switching bubble on directly on the device.
        a._lastCommandTime = 0; // long outside grace period

        await states.publishStatus(a, {
            heater: 'off', filter: 'off', bubble: 'on', jet: 'off', ozone: 'off', uvc: 'off',
            target_temperature: 36, water_temperature: 28, heat_state: 0,
        });

        assert.strictEqual(a._manualOverride, false, 'bubble must be excluded from app-change detection entirely');
    });

    it('6) setFeature(heater, true, {fromUser:true}) via adapter does not trigger manual_override on confirmation', async () => {
        const a = makeAdapter();
        await a.setFeature('heater', true, { fromUser: true });
        assert.strictEqual(a._adapterCommanded.heater, true);

        await states.publishStatus(a, {
            heater: 'on', filter: 'on', bubble: 'off', jet: 'off', ozone: 'off', uvc: 'off',
            target_temperature: 36, water_temperature: 28, heat_state: 2,
        });

        assert.strictEqual(a._manualOverride, false);
    });
});
