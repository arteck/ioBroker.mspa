'use strict';

/**
 * Tests for lib/utils.js  (transformStatus + RateTracker)
 *
 * Run with: npx mocha test/utils.test.js
 */

const assert      = require('assert');
const { transformStatus, RateTracker } = require('../lib/utils');

// ---------------------------------------------------------------------------
// transformStatus
// ---------------------------------------------------------------------------
describe('transformStatus()', () => {

    it('converts water_temperature (raw/2)', () => {
        const r = transformStatus({ water_temperature: 78 });
        assert.strictEqual(r.water_temperature, 39);
    });

    it('converts temperature_setting (raw/2)', () => {
        const r = transformStatus({ temperature_setting: 82 });
        assert.strictEqual(r.target_temperature, 41);
    });

    it('converts boolean device states to "on"/"off"', () => {
        const r = transformStatus({ heater_state: 1, filter_state: 0, bubble_state: 1, jet_state: 0, ozone_state: 1, uvc_state: 0 });
        assert.strictEqual(r.heater,  'on');
        assert.strictEqual(r.filter,  'off');
        assert.strictEqual(r.bubble,  'on');
        assert.strictEqual(r.jet,     'off');
        assert.strictEqual(r.ozone,   'on');
        assert.strictEqual(r.uvc,     'off');
    });

    it('sets fault to "OK" when fault is empty string', () => {
        const r = transformStatus({ fault: '' });
        assert.strictEqual(r.fault, 'OK');
    });

    it('passes through fault message as-is', () => {
        const r = transformStatus({ fault: 'E03' });
        assert.strictEqual(r.fault, 'E03');
    });

    it('passes through unknown keys verbatim', () => {
        const r = transformStatus({ custom_field: 42 });
        assert.strictEqual(r.custom_field, 42);
    });

    it('does not override structured keys with pass-through logic', () => {
        const r = transformStatus({ water_temperature: 78, heater_state: 1 });
        // heater_state is structured → should NOT appear as raw pass-through
        assert.strictEqual(r.water_temperature, 39); // transformed
        assert.strictEqual(r.heater, 'on');          // transformed
        assert.strictEqual(r.heater_state, undefined, 'raw heater_state must not appear');
    });

    it('defaults bubble_level to 1 when undefined', () => {
        const r = transformStatus({});
        assert.strictEqual(r.bubble_level, 1);
    });

    it('preserves explicit bubble_level = 0', () => {
        const r = transformStatus({ bubble_level: 0 });
        assert.strictEqual(r.bubble_level, 0);
    });

    it('handles empty raw object without throwing', () => {
        assert.doesNotThrow(() => transformStatus({}));
    });
});

// ---------------------------------------------------------------------------
// RateTracker
// ---------------------------------------------------------------------------
describe('RateTracker', () => {

    function makeTracker({ min = 0.05, max = 3, alpha = 0.25, minSample = 3 } = {}) {
        return new RateTracker({ min, max, emaAlpha: alpha, minSampleMinutes: minSample });
    }

    it('returns null before any sample', () => {
        const t = makeTracker();
        assert.strictEqual(t.computedRate, null);
    });

    it('returns null on the first active sample (no previous reference)', () => {
        const t = makeTracker();
        const r = t.update(30, true, true);
        assert.strictEqual(r, null);
    });

    it('resets lastTemp/lastTime when active=false', () => {
        const t = makeTracker();
        t.update(30, true, true);
        t.update(35, false, true); // inactive
        assert.strictEqual(t._lastTemp, null);
        assert.strictEqual(t._lastTime, null);
    });

    it('also clears computedRate on reset()', () => {
        const t = makeTracker();
        t.computedRate = 1.5; // inject a value
        t.reset();
        assert.strictEqual(t.computedRate, null);
        assert.strictEqual(t._lastTemp,    null);
        assert.strictEqual(t._lastTime,    null);
    });

    it('accumulates EMA across valid samples', () => {
        const t = makeTracker({ minSample: 0 }); // no min interval restriction
        t._lastTemp = 20;
        t._lastTime = Date.now() - 3_600_000; // 1 hour ago
        const rate = t.update(22, true, true); // +2°C/h
        assert.ok(rate !== null, 'rate should be computed');
        assert.ok(rate > 0 && rate <= 3, `rate ${rate} out of [0,3]`);
    });

    it('ignores sample when rate is below MIN_RATE', () => {
        const t = makeTracker({ min: 1.0, minSample: 0 });
        t._lastTemp = 20;
        t._lastTime = Date.now() - 3_600_000; // 1h
        t.update(20.1, true, true); // 0.1°C/h < 1.0 → ignored
        assert.strictEqual(t.computedRate, null, 'below MIN_RATE should not update computedRate');
    });

    it('ignores sample when rate exceeds MAX_RATE', () => {
        const t = makeTracker({ max: 1.0, minSample: 0 });
        t._lastTemp = 20;
        t._lastTime = Date.now() - 3_600_000; // 1h
        t.update(25, true, true); // 5°C/h > 1.0 → ignored
        assert.strictEqual(t.computedRate, null, 'above MAX_RATE should not update computedRate');
    });

    it('cooling tracker: rate is positive for falling temperatures', () => {
        const t = makeTracker({ min: 0.01, minSample: 0 });
        t._lastTemp = 30;
        t._lastTime = Date.now() - 3_600_000;
        const rate = t.update(28, true, false); // risingExpected=false → cooling
        assert.ok(rate > 0, 'cooling rate should be positive');
    });

    it('returns current computedRate unchanged when temp has not changed', () => {
        const t = makeTracker();
        t._lastTemp    = 30;
        t._lastTime    = Date.now() - 3_600_000;
        t.computedRate = 1.5; // pre-set
        const rate = t.update(30, true, true); // no change in temp
        assert.strictEqual(rate, 1.5, 'should return existing computedRate unchanged');
    });
});
