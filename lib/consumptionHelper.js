'use strict';

/**
 * consumptionHelper (MSpa)
 * - Monitors an external kWh meter (objectId from config)
 * - Calculates daily consumption (day_kwh)
 * - last_total_kwh  = raw meter value at start of today (set at midnight)
 * - day_start_date  = date string "YYYY-MM-DD" when last_total_kwh was recorded
 * - Detects missed midnight resets (adapter was down over midnight) and corrects
 * - Handles meter resets gracefully (treats reset value as new day start)
 * - Persists values across restarts via ioBroker states
 */

const consumptionHelper = {
    adapter:      null,
    energyId:     null,
    _dayStart:    null,   // raw meter value at start of today (in-memory)
    _timers:      [],

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

        adapter.subscribeForeignStates(this.energyId);
        adapter.log.info(`[consumption] monitoring external kWh meter: ${this.energyId}`);

        // Restore day-start baseline – AWAITED to avoid race with first state change
        await this._restoreDayStart();
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
            // _dayStart is always set by _restoreDayStart() before first call.
            // Only null if init() wasn't called (consumption disabled) – guard anyway.
            if (this._dayStart === null) {
                this._dayStart = rawNow;
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                await this.adapter.setStateAsync('consumption.day_start_date',  { val: this._todayStr(), ack: true });
                this.adapter.log.info(`[consumption] late init – day-start baseline: ${rawNow} kWh`);
            }

            // Meter reset detected (source adapter restarted at 0)
            if (rawNow < this._dayStart) {
                this.adapter.log.warn(`[consumption] meter reset (${rawNow} < ${this._dayStart}) – using current value as new day start`);
                this._dayStart = rawNow;
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                await this.adapter.setStateAsync('consumption.day_start_date',  { val: this._todayStr(), ack: true });
            }

            const dayVal = Math.round((rawNow - this._dayStart) * 1000) / 1000;
            await this.adapter.setStateChangedAsync('consumption.day_kwh', dayVal, true);

            this.adapter.log.debug(`[consumption] raw=${rawNow} kWh, dayStart=${this._dayStart} kWh, day=${dayVal} kWh`);
        } catch (err) {
            this.adapter.log.warn(`[consumption] update error: ${err.message}`);
        }
    },

    // -------------------------------------------------------------------------
    async _restoreDayStart() {
        try {
            const savedVal  = (await this.adapter.getStateAsync('consumption.last_total_kwh'))?.val;
            const savedDate = (await this.adapter.getStateAsync('consumption.day_start_date'))?.val || '';
            const savedNum  = Number(savedVal);
            const today     = this._todayStr();

            if (savedVal !== null && savedVal !== undefined && savedNum > 0 && savedDate === today) {
                // Saved value is from today → use as day start
                this._dayStart = savedNum;
                this.adapter.log.debug(`[consumption] day-start restored: ${this._dayStart} kWh (saved today)`);
            } else if (savedVal !== null && savedVal !== undefined && savedNum > 0 && savedDate !== today) {
                // Saved value is from a previous day → adapter was down over midnight
                // We cannot know the exact midnight value → use current meter value as new day start
                // (today's consumption will start from 0 from this point)
                const s = await this.adapter.getForeignStateAsync(this.energyId);
                const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : null;
                if (rawNow !== null) {
                    this._dayStart = rawNow;
                    await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                    await this.adapter.setStateAsync('consumption.day_start_date',  { val: today,  ack: true });
                    await this.adapter.setStateAsync('consumption.day_kwh',         { val: 0,      ack: true });
                    this.adapter.log.warn(`[consumption] missed midnight reset (last save: ${savedDate}) – new day-start: ${rawNow} kWh`);
                } else {
                    // Cannot read meter → stay null, will be set on first state change
                    this.adapter.log.warn('[consumption] missed midnight reset but meter not readable yet – will init on first value');
                }
            } else {
                // First ever start (saved = 0 or null)
                // _dayStart remains null → will be set on first meter value in _update()
                this.adapter.log.debug('[consumption] no previous day-start saved – will init on first meter value');
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
        const ms = next - now;
        const t = setTimeout(async () => {
            try {
                const s      = await this.adapter.getForeignStateAsync(this.energyId);
                const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : this._dayStart;
                this.adapter.log.info(`[consumption] midnight reset – new day-start: ${rawNow} kWh`);
                this._dayStart = rawNow;
                const today = this._todayStr();
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                await this.adapter.setStateAsync('consumption.day_start_date',  { val: today,  ack: true });
                await this.adapter.setStateAsync('consumption.day_kwh',         { val: 0,      ack: true });
            } catch (err) {
                this.adapter.log.warn(`[consumption] daily reset error: ${err.message}`);
            }
            this._scheduleDailyReset();
        }, ms);
        this._timers.push(t);
        this.adapter.log.debug(`[consumption] next midnight reset in ${Math.round(ms / 60000)} min`);
    },

    // -------------------------------------------------------------------------
    /** Returns today's date as "YYYY-MM-DD" string */
    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
