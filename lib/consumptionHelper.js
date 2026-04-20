'use strict';

/**
 * consumptionHelper (MSpa)
 * - Monitors an external kWh meter (objectId from config)
 * - Calculates daily consumption (day_kwh)
 * - Daily cycle: at 23:59 the final day_kwh is written once (rawNow - last_total_kwh),
 *   last_total_kwh is updated to rawNow as baseline for the next day,
 *   and day_start_date is set to today.
 * - day_kwh is ONLY written at 23:59 – not updated continuously during the day.
 * - last_total_kwh  = raw meter value at start of today (set at 23:59 of previous day)
 * - day_start_date  = date string "YYYY-MM-DD" when last_total_kwh was recorded
 * - Detects missed 23:59 resets (adapter was down over midnight) and corrects
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
    // _update: only tracks the day-start baseline and detects meter resets.
    // day_kwh is NOT written here – it is written exclusively at 23:59.
    async _update(rawNow) {
        try {
            if (this._dayStart === null) {
                this._dayStart = rawNow;
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                await this.adapter.setStateAsync('consumption.day_start_date',  { val: this._todayStr(), ack: true });
                this.adapter.log.info(`[consumption] late init – day-start baseline: ${rawNow} kWh`);
                return;
            }

            // Meter reset detected (source adapter restarted at 0)
            if (rawNow < this._dayStart) {
                this.adapter.log.warn(`[consumption] meter reset (${rawNow} < ${this._dayStart}) – using current value as new day start`);
                this._dayStart = rawNow;
                await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                await this.adapter.setStateAsync('consumption.day_start_date',  { val: this._todayStr(), ack: true });
            }

            // day_kwh is written only at 23:59 by _scheduleDailyReset – no update here.
            this.adapter.log.debug(`[consumption] raw=${rawNow} kWh, dayStart=${this._dayStart} kWh (day_kwh written at 23:59 only)`);
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

            // savedNum >= 0 (not just > 0) – 0 is a valid meter baseline (fresh install)
            const hasSaved  = savedVal !== null && savedVal !== undefined && Number.isFinite(savedNum) && savedNum >= 0;

            if (hasSaved && savedDate === today) {
                // Saved value is from today → use as day start
                this._dayStart = savedNum;
                this.adapter.log.debug(`[consumption] day-start restored: ${this._dayStart} kWh (saved today)`);
            } else if (hasSaved && savedDate !== today) {
                // Saved value is from a previous day → adapter was down over midnight
                const s      = await this.adapter.getForeignStateAsync(this.energyId);
                const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : null;
                if (rawNow !== null) {
                    // Write final day_kwh for the missed day before updating baseline
                    const missedDayVal = Math.round((rawNow - savedNum) * 1000) / 1000;
                    await this.adapter.setStateAsync('consumption.day_kwh',         { val: missedDayVal, ack: true });
                    this._dayStart = rawNow;
                    await this.adapter.setStateAsync('consumption.last_total_kwh', { val: rawNow, ack: true });
                    await this.adapter.setStateAsync('consumption.day_start_date',  { val: today,  ack: true });
                    this.adapter.log.warn(`[consumption] missed 23:59 reset (last save: ${savedDate}) – day_kwh: ${missedDayVal} kWh, new day-start: ${rawNow} kWh`);
                } else {
                    this.adapter.log.warn('[consumption] missed midnight reset but meter not readable yet – will init on first value');
                }
            } else {
                // First ever start (saved = null/undefined/NaN)
                this.adapter.log.debug('[consumption] no previous day-start saved – will init on first meter value');
            }
        } catch (err) {
            this.adapter.log.warn(`[consumption] error restoring day-start: ${err.message}`);
        }
    },

    // -------------------------------------------------------------------------
    _scheduleDailyReset() {
        // Remove any expired timers from list to avoid memory leak
        this._timers = this._timers.filter(t => t._destroyed === false);

        const now  = new Date();
        const next = new Date(now);
        next.setHours(23, 59, 0, 0);
        // If 23:59 is already past today, schedule for tomorrow
        if (next <= now) {
            next.setDate(next.getDate() + 1);
        }
        const ms = next - now;
        const t = setTimeout(async () => {
            // Remove this timer from list
            const idx = this._timers.indexOf(t);
            if (idx !== -1) {
this._timers.splice(idx, 1);
}

            try {
                const s      = await this.adapter.getForeignStateAsync(this.energyId);
                const rawNow = (s && Number.isFinite(Number(s.val))) ? Number(s.val) : this._dayStart;
                const today  = this._todayStr();
                // Final day value = current meter - day-start baseline
                const dayVal = this._dayStart !== null
                    ? Math.round((rawNow - this._dayStart) * 1000) / 1000
                    : 0;
                this.adapter.log.info(`[consumption] 23:59 daily close – day_kwh: ${dayVal} kWh, new day-start: ${rawNow} kWh`);
                await this.adapter.setStateAsync('consumption.day_kwh',         { val: dayVal, ack: true });
                await this.adapter.setStateAsync('consumption.last_total_kwh',  { val: rawNow, ack: true });
                await this.adapter.setStateAsync('consumption.day_start_date',  { val: today,  ack: true });
                this._dayStart = rawNow;
            } catch (err) {
                this.adapter.log.warn(`[consumption] daily reset error: ${err.message}`);
            }
            this._scheduleDailyReset();
        }, ms);
        this._timers.push(t);
        this.adapter.log.debug(`[consumption] next 23:59 daily close in ${Math.round(ms / 60000)} min`);
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
