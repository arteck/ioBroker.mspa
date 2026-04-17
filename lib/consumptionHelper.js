'use strict';

/**
 * consumptionHelper (MSpa)
 * - Monitors an external kWh meter (objectId from config)
 * - Calculates daily consumption (day_kwh)
 * - last_total_kwh = raw meter value at start of today (set at midnight)
 * - Handles meter resets gracefully (treats reset value as new day start)
 * - Persists values across restarts via ioBroker states
 */

const consumptionHelper = {
    adapter:      null,
    energyId:     null,
    _dayStart:    null,   // raw meter value at start of today (in-memory)
    _timers:      [],

    // -------------------------------------------------------------------------
    init(adapter) {
        this.adapter  = adapter;
        this.energyId = adapter.config.external_energy_total_id || null;

        if (!adapter.config.consumption_enabled) {
            adapter.log.debug('[consumption] tracking disabled – skipping init');
            return;
        }

        if (this.energyId) {
            adapter.subscribeForeignStates(this.energyId);
            adapter.log.info(`[consumption] monitoring external kWh meter: ${this.energyId}`);
        } else {
            adapter.log.warn('[consumption] consumption_enabled but no Object-ID configured – tracking inactive');
            return;
        }

        this._restoreDayStart();
        this._scheduleDailyReset();
    },

    // -------------------------------------------------------------------------
    async handleStateChange(id, state) {
        if (!state || id !== this.energyId) {
return;
}
        const raw = Number(state.val);
        if (!Number.isFinite(raw)) {
return;
}
        await this._update(raw);
    },

    // -------------------------------------------------------------------------
    async _update(rawNow) {
        try {
            // first value after (re)start: use as day start baseline
            if (this._dayStart === null) {
                const saved = (await this.adapter.getStateAsync('consumption.last_total_kwh'))?.val;
                this._dayStart = (saved !== null && saved !== undefined) ? Number(saved) : rawNow;
                this.adapter.log.debug(`[consumption] day-start baseline initialised: ${this._dayStart} kWh`);
            }

            // meter reset detected (e.g. source adapter restarted at 0)
            if (rawNow < this._dayStart) {
                this.adapter.log.warn(`[consumption] meter reset detected (${rawNow} < ${this._dayStart}) – using current value as new day start`);
                this._dayStart = rawNow;
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
            }

            const dayVal = Number((rawNow - this._dayStart).toFixed(3));
            await this.adapter.setStateAsync('consumption.day_kwh', { val: dayVal, ack: true });

            this.adapter.log.debug(`[consumption] updated – raw=${rawNow} kWh, dayStart=${this._dayStart} kWh, day=${dayVal} kWh`);
        } catch (err) {
            this.adapter.log.warn(`[consumption] update error: ${err.message}`);
        }
    },

    // -------------------------------------------------------------------------
    async _restoreDayStart() {
        try {
            const saved = (await this.adapter.getStateAsync('consumption.last_total_kwh'))?.val;
            if (saved !== null && saved !== undefined) {
                this._dayStart = Number(saved);
                this.adapter.log.debug(`[consumption] day-start restored: ${this._dayStart} kWh`);
            }
        } catch (err) {
            this.adapter.log.warn(`[consumption] error restoring day-start: ${err.message}`);
        }
    },

    // -------------------------------------------------------------------------
    _scheduleDailyReset() {
        const now  = new Date();
        const next = new Date(now);
        next.setHours(24, 0, 0, 0);
        const t = setTimeout(async () => {
            try {
                // fetch current raw meter value to use as new day start
                const s = await this.adapter.getForeignStateAsync(this.energyId);
                const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : this._dayStart;
                this.adapter.log.info(`[consumption] daily reset (midnight) – new day-start: ${rawNow} kWh`);
                this._dayStart = rawNow;
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow,  ack: true });
                await this.adapter.setStateAsync('consumption.day_kwh',        { val: 0,       ack: true });
            } catch (err) {
                this.adapter.log.warn(`[consumption] daily reset error: ${err.message}`);
            }
            this._scheduleDailyReset();
        }, next - now);
        this._timers.push(t);
    },

    // -------------------------------------------------------------------------
    cleanup() {
        for (const t of this._timers) {
clearTimeout(t);
}
        this._timers = [];
    },
};

module.exports = consumptionHelper;
