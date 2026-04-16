'use strict';

/**
 * Transforms the raw MSpa API status payload into normalised ioBroker-friendly values.
 * Mirrors the transformation done in coordinator.py::_async_update_data().
 *
 * @param {object} raw  – raw payload from getHotTubStatus()
 * @returns {object}    – transformed data
 */
function transformStatus(raw) {
    const fault = raw.fault || '';
    const transformed = {
        water_temperature: parseFloat(raw.water_temperature || 0) / 2,
        target_temperature: parseFloat(raw.temperature_setting || 0) / 2,
        heater:       raw.heater_state  ? 'on' : 'off',
        filter:       raw.filter_state  ? 'on' : 'off',
        bubble:       raw.bubble_state  ? 'on' : 'off',
        jet:          raw.jet_state     ? 'on' : 'off',
        ozone:        raw.ozone_state   ? 'on' : 'off',
        uvc:          raw.uvc_state     ? 'on' : 'off',
        bubble_level: raw.bubble_level  !== undefined ? raw.bubble_level : 1,
        fault:        fault || 'OK',
    };

    // Pass through all other keys verbatim
    const structured = new Set([
        'water_temperature', 'temperature_setting',
        'heater_state', 'filter_state', 'bubble_state',
        'jet_state', 'ozone_state', 'uvc_state', 'bubble_level', 'fault',
    ]);
    for (const [k, v] of Object.entries(raw)) {
        if (!structured.has(k)) {
            transformed[k] = v;
        }
    }

    return transformed;
}

/**
 * EMA-based heating/cooling rate tracker.
 * Mirrors the logic in coordinator.py.
 */
class RateTracker {
    /**
     *
     * @param root0
     * @param root0.min
     * @param root0.max
     * @param root0.emaAlpha
     * @param root0.minSampleMinutes
     */
    constructor({ min, max, emaAlpha = 0.25, minSampleMinutes = 3 }) {
        this.MIN_RATE          = min;
        this.MAX_RATE          = max;
        this.EMA_ALPHA         = emaAlpha;
        this.MIN_SAMPLE_MS     = minSampleMinutes * 60 * 1000;
        this._lastTemp         = null;
        this._lastTime         = null;
        this.computedRate      = null;   // °C/h, null until first valid sample
    }

    /**
     * Feed a new temperature sample.
     *
     * @param {number} temp    – current temperature in °C
     * @param {boolean} active – true if the relevant mode is active (heating or cooling)
     * @param {boolean} risingExpected – true for heater tracker, false for cooling
     * @returns {number|null} – updated rate or null
     */
    update(temp, active, risingExpected) {
        if (!active) {
            this._lastTemp = null;
            this._lastTime = null;
            return this.computedRate;
        }

        if (this._lastTemp === null) {
            this._lastTemp = temp;
            this._lastTime = Date.now();
            return this.computedRate;
        }

        if (temp === this._lastTemp) {
            return this.computedRate; // no change, let time accumulate
        }

        const elapsedHours = (Date.now() - this._lastTime) / 3_600_000;
        if (elapsedHours >= this.MIN_SAMPLE_MS / 3_600_000) {
            const delta = temp - this._lastTemp; // positive for heat, negative for cool
            const rate  = risingExpected ? delta / elapsedHours : -delta / elapsedHours;

            if (rate >= this.MIN_RATE && rate <= this.MAX_RATE) {
                if (this.computedRate === null) {
                    this.computedRate = rate;
                } else {
                    this.computedRate = this.EMA_ALPHA * rate + (1 - this.EMA_ALPHA) * this.computedRate;
                }
            }
        }

        this._lastTemp = temp;
        this._lastTime = Date.now();
        return this.computedRate;
    }

    /**
     *
     */
    reset() {
        this._lastTemp  = null;
        this._lastTime  = null;
    }
}

module.exports = { transformStatus, RateTracker };
