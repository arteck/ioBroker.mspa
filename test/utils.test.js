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

    // Defaults spiegeln die Production-Werte in main.js wider:
    // Physik: 2200 W / 930 L → ~2,03 °C/h theoretisch, real 1,2–1,8 °C/h
    // heatTracker: min=0.3, max=3.5, minSample=20
    // coolTracker: min=0.05, max=2.0, minSample=30
    function makeTracker({ min = 0.3, max = 3.5, alpha = 0.25, minSample = 20 } = {}) {
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
        t.computedRate = 5.0; // inject a value
        t.reset();
        assert.strictEqual(t.computedRate, null);
        assert.strictEqual(t._lastTemp,    null);
        assert.strictEqual(t._lastTime,    null);
    });

    it('accumulates EMA across valid samples', () => {
        const t = makeTracker({ minSample: 0 });
        t._lastTemp = 20;
        t._lastTime = Date.now() - 3_600_000; // 1 hour ago
        const rate = t.update(22, true, true); // +2°C/h
        assert.ok(rate !== null, 'rate should be computed');
        assert.ok(rate > 0 && rate <= 3.5, `rate ${rate} out of [0,3.5]`);
    });

    it('ignores sample when rate is below MIN_RATE', () => {
        const t = makeTracker({ min: 1.0, minSample: 0 });
        t._lastTemp = 20;
        t._lastTime = Date.now() - 3_600_000; // 1h
        t.update(20.05, true, true); // 0.05°C/h < 1.0 → ignored
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
        const t = makeTracker({ min: 0.05, max: 10, minSample: 0 });
        t._lastTemp = 30;
        t._lastTime = Date.now() - 3_600_000;
        const rate = t.update(28, true, false); // risingExpected=false → cooling
        assert.ok(rate > 0, 'cooling rate should be positive');
    });

    it('returns current computedRate unchanged when temp has not changed', () => {
        const t = makeTracker();
        t._lastTemp    = 30;
        t._lastTime    = Date.now() - 3_600_000;
        t.computedRate = 5.0; // pre-set
        const rate = t.update(30, true, true); // no change in temp
        assert.strictEqual(rate, 5.0, 'should return existing computedRate unchanged');
    });

    // ── Reales MSpa-Szenario (physikalisch berechnet) ─────────────────────────
    it('computes realistic MSpa heat rate (~2 °C/h based on 2200W/930L)', () => {
        // Physik: t = (930 kg · 4186 J/kg·K · 1 K) / 2200 W = 1769 s ≈ 29,5 min/°C
        // → Theoretisches Maximum: 2,03 °C/h
        // Test: 0,5 °C Anstieg in 15 min = 2,0 °C/h → innerhalb [0.3, 3.5]
        const t = makeTracker({ min: 0.3, max: 3.5, minSample: 0 });
        t._lastTemp = 25;
        t._lastTime = Date.now() - 15 * 60_000; // 15 Minuten
        const rate = t.update(25.5, true, true); // +0.5°C in 15 min = 2,0°C/h
        assert.ok(rate !== null, 'rate should not be null for realistic MSpa heating');
        assert.ok(rate >= 1.8 && rate <= 2.2, `rate ${rate} should be ~2.0°C/h (0.5°C/15min)`);
    });

    it('computes heat rate with production 20-min sample window', () => {
        // minSample=20: erster gültiger Wert nach 20 min
        // 0.5°C in 20 min = 1,5°C/h → realistisch mit Verlusten
        const t = makeTracker({ min: 0.3, max: 3.5, minSample: 20 });
        t._lastTemp = 25;
        t._lastTime = Date.now() - 20 * 60_000; // genau 20 Minuten
        const rate = t.update(25.5, true, true); // +0.5°C in 20 min = 1,5°C/h
        assert.ok(rate !== null, 'rate should not be null after 20-min window');
        assert.ok(rate >= 1.3 && rate <= 1.7, `rate ${rate} should be ~1.5°C/h`);
    });

    it('filters out unrealistic heat rate above MAX_RATE (>3.5°C/h physically impossible for 2200W/930L)', () => {
        // Mehr als 3,5°C/h ist physikalisch unmöglich (= >70% über theoretischem Max)
        // → Sensor-Fehler oder Polling-Artefakt
        const t = makeTracker({ min: 0.3, max: 3.5, minSample: 0 });
        t._lastTemp = 25;
        t._lastTime = Date.now() - 60_000; // nur 1 Minute
        const rate = t.update(26, true, true); // 60°C/h → weit über MAX
        assert.strictEqual(t.computedRate, null, 'physically impossible rate must be filtered out');
    });

    it('does NOT reset _lastTime when temp is unchanged (prevents short-window rate spike)', () => {
        // BUG-FIX-Regression: früher wurde _lastTime auf now() gesetzt wenn temp gleich.
        // Dadurch hatte das nächste gültige Sample nur ein 3-min-Fenster statt des echten Zeitraums.
        const t = makeTracker({ minSample: 3 });
        const start = Date.now() - 6 * 60_000; // 6 Minuten her
        t._lastTemp = 28;
        t._lastTime = start;
        // Erster Poll nach 3 min: Temp unverändert
        const savedTime = t._lastTime;
        t.update(28, true, true); // temp gleich
        assert.strictEqual(t._lastTime, savedTime, '_lastTime darf bei gleichbleibender Temp nicht zurückgesetzt werden');
    });

    it('computes correct rate over full elapsed window after temp plateau', () => {
        // Heizung läuft 6 Minuten: erst 3 min Plateau, dann 1°C Anstieg.
        // Rate muss ~10°C/h sein (1°C / 6min), nicht ~20°C/h (1°C / 3min).
        const t = makeTracker({ min: 0.05, max: 15, minSample: 3 });
        const start = Date.now() - 6 * 60_000; // 6 Minuten her
        t._lastTemp = 28;
        t._lastTime = start;
        // Poll nach 3 min: Temp gleich → _lastTime soll NICHT gesetzt werden
        t.update(28, true, true);
        // Poll nach 6 min (start + 6min): Temp nun 29°C
        const rate = t.update(29, true, true);
        // Rate = 1°C / (6/60)h = 10°C/h (EMA erster Wert = raw rate)
        assert.ok(rate !== null, 'rate should be computed');
        assert.ok(rate >= 9 && rate <= 11, `rate ${rate} should be ~10°C/h (1°C over 6 min), not ~20°C/h`);
    });

    it('resets reference after 30-min plateau (sensor-hang safeguard)', () => {
        const t = makeTracker({ minSample: 3 });
        t._lastTemp = 28;
        t._lastTime = Date.now() - 31 * 60_000; // 31 Minuten her
        t.computedRate = 1.5;
        t.update(28, true, true); // temp gleich, aber > 30 min → Reset
        assert.ok(Date.now() - t._lastTime < 5000, '_lastTime should be reset after 30-min plateau');
        assert.strictEqual(t._lastTemp, 28, '_lastTemp should be preserved');
    });
});
