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
    adapter: null,
    energyId: null,
    _activeTimer: null,

    // -------------------------------------------------------------------------
    async init(adapter) {
        this.adapter = adapter;
        this.energyId = adapter.config.external_energy_total_id || null;

        if (!adapter.config.consumption_enabled) {
            this.adapter.log.debug('[consumption] tracking disabled – skipping init');
            return;
        }

        if (!this.energyId) {
            this.adapter.log.warn('[consumption] consumption_enabled but no Object-ID configured – tracking inactive');
            return;
        }

        adapter.log.info(`[consumption] monitoring external kWh meter: ${this.energyId}`);
        this._scheduleDailyReset();
    },

    // -------------------------------------------------------------------------
    _scheduleDailyReset() {
        // Cancel existing timer before scheduling a new one
        if (this._activeTimer !== null) {
            clearTimeout(this._activeTimer);
            this._activeTimer = null;
        }

        const now = new Date();
        const next = new Date(now);
        next.setHours(23, 59, 0, 0);
        if (next <= now) {
            next.setDate(next.getDate() + 1);
        }

        const ms = next - now;
        this._activeTimer = setTimeout(async () => {
            this._activeTimer = null;
            await this._runDailyClose(this.adapter, this.energyId);
            this._scheduleDailyReset();
        }, ms);

        this.adapter.log.debug(`[consumption] next 23:59 daily close in ${Math.round(ms / 60000)} min`);

    },

    // -------------------------------------------------------------------------
    /** Extracted close logic – can be called directly in tests */
    async _runDailyClose(adapter, energyId) {
        try {
            const s = await adapter.getForeignStateAsync(energyId);
            const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : null;

            if (rawNow === null) {
                adapter.log.warn('[consumption] 23:59 – meter not readable, skipping daily close');
            } else {
                const savedVal = (await adapter.getStateAsync('consumption.last_total_kwh'))?.val;
                const savedNum = Number(savedVal);
                const hasBase = savedVal !== null && savedVal !== undefined && Number.isFinite(savedNum) && savedNum >= 0;

                const rawDayVal = hasBase ? rawNow - savedNum : 0;
                if (rawDayVal < 0) {
                    adapter.log.warn(`[consumption] 23:59 – meter value decreased (was ${savedNum}, now ${rawNow}) – possible meter replacement or rollover; resetting baseline`);
                }
                const dayVal = hasBase
                    ? Math.max(0, Math.round(rawDayVal * 1000) / 1000)
                    : 0;

                adapter.log.info(`[consumption] 23:59 daily close – day_kwh: ${dayVal} kWh, new baseline: ${rawNow} kWh`);
                await adapter.setStateAsync('consumption.day_kwh', {val: dayVal, ack: true});
                await adapter.setStateAsync('consumption.last_total_kwh', {val: rawNow, ack: true});
            }
        } catch (err) {
            adapter.log.warn(`[consumption] daily reset error: ${err.message}`);
        }
    },



    // -------------------------------------------------------------------------
    cleanup() {
        if (this._activeTimer !== null) {
            clearTimeout(this._activeTimer);
            this._activeTimer = null;
        }
    },
};

module.exports = consumptionHelper;
