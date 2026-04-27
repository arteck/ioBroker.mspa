'use strict';

/**
 * Transforms the raw MSpa API status payload into normalised ioBroker-friendly values.
 * Includes unit conversions, boolean state mapping, and fault code interpretation.
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
 * Designed to handle noisy temperature readings and variable sampling intervals, providing a smoothed °C/h rate.
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

        const elapsedMs = Date.now() - this._lastTime;

        // FIX: Akkumulieren bis MIN_SAMPLE_MS erreicht ist – nicht jeden Tick zurücksetzen.
        // Vorher wurde _lastTime bei jeder Tempänderung neu gesetzt → bei häufigen
        // Updates (kurze Polling-Intervalle) kam das Fenster nie zum Tragen.
        if (elapsedMs < this.MIN_SAMPLE_MS) {
            return this.computedRate;
        }

        if (temp === this._lastTemp) {
            // Keine Temp-Änderung – _lastTime NICHT zurücksetzen!
            // Würden wir _lastTime hier resetten, wäre das nächste Messfenster
            // nur 3 Min lang, obwohl die Temperatur z.B. erst nach 6+ Min stieg.
            // Das führt zu überhöhten Raten (z.B. 1°C / 3min = 20°C/h) die
            // oberhalb von MAX_RATE liegen und herausgefiltert werden.
            // Stattdessen: warten bis sich temp tatsächlich ändert.
            // Sicherheitsnetz: nach 30 Min ohne Änderung Referenzpunkt verschieben,
            // damit ein Sensor-Hang nicht das erste gültige Sample verfälscht.
            if (elapsedMs > 30 * 60 * 1000) {
                this._lastTemp = temp;
                this._lastTime = Date.now();
            }
            return this.computedRate;
        }

        const elapsedHours = elapsedMs / 3_600_000;
        const delta = temp - this._lastTemp;
        const rate  = risingExpected ? delta / elapsedHours : -delta / elapsedHours;

        if (rate >= this.MIN_RATE && rate <= this.MAX_RATE) {
            if (this.computedRate === null) {
                this.computedRate = rate;
            } else {
                this.computedRate = this.EMA_ALPHA * rate + (1 - this.EMA_ALPHA) * this.computedRate;
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
        this._lastTemp     = null;
        this._lastTime     = null;
        this.computedRate  = null;
    }
}

module.exports = { transformStatus, RateTracker };
