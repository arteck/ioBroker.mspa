'use strict';

/**
 * consumptionHelper (MSpa)
 * - Monitors an external kWh meter (objectId from config)
 * - Calculates daily consumption (day_kwh)
 * - Daily cycle: at 23:59 the final day_kwh is written once:
 *     day_kwh = current_meter - last_total_kwh
 *   then last_total_kwh is updated to current_meter as baseline for the next day.
 * - day_kwh is ONLY written at 23:59 – not updated continuously during the day.
 * - last_total_kwh = raw meter value saved at 23:59 of the previous day
 */

const consumptionHelper = {
    adapter:  null,
    energyId: null,
    _timers:  [],

    // -------------------------------------------------------------------------
    async init(adapter) {
        this.adapter  = adapter;
        this.energyId = adapter.config.external_energy_total_id || null;

        if (!adapter.config.consumption_enabled) {
            adapter.log.debug('[consumption] tracking disabled – skipping init');
            return;
        }

        if (!this.energyId) {
            adapter.log.warn('[consumption] consumption_enabled but no Object-ID configured – tracking inactive');
            return;
        }

        adapter.log.info(`[consumption] monitoring external kWh meter: ${this.energyId}`);
        this._scheduleDailyReset();
    },

    // -------------------------------------------------------------------------
    _scheduleDailyReset() {
        this._timers = this._timers.filter(t => t._destroyed === false);

        const now  = new Date();
        const next = new Date(now);
        next.setHours(23, 59, 0, 0);
        if (next <= now) {
next.setDate(next.getDate() + 1);
}

        const ms = next - now;
        const t = setTimeout(async () => {
            const idx = this._timers.indexOf(t);
            if (idx !== -1) {
this._timers.splice(idx, 1);
}

            try {
                // Current meter value
                const s      = await this.adapter.getForeignStateAsync(this.energyId);
                const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : null;

                if (rawNow === null) {
                    this.adapter.log.warn('[consumption] 23:59 – meter not readable, skipping daily close');
                } else {
                    // Baseline from last saved value
                    const savedVal  = (await this.adapter.getStateAsync('consumption.last_total_kwh'))?.val;
                    const savedNum  = Number(savedVal);
                    const hasBase   = savedVal !== null && savedVal !== undefined && Number.isFinite(savedNum) && savedNum >= 0;

                    const dayVal = hasBase
                        ? Math.round((rawNow - savedNum) * 1000) / 1000
                        : 0;

                    this.adapter.log.info(`[consumption] 23:59 daily close – day_kwh: ${dayVal} kWh, new baseline: ${rawNow} kWh`);
                    await this.adapter.setStateAsync('consumption.day_kwh',        { val: dayVal, ack: true });
                    await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                }
            } catch (err) {
                this.adapter.log.warn(`[consumption] daily reset error: ${err.message}`);
            }

            this._scheduleDailyReset();
        }, ms);

        this._timers.push(t);
        this.adapter.log.debug(`[consumption] next 23:59 daily close in ${Math.round(ms / 60000)} min`);
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
