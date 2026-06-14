'use strict';

/**
 * lib/stateRestore.js
 *
 * Persisted state restoration for the MSpa adapter.
 * Reads control/status states from the ioBroker DB on startup and restores
 * the corresponding in-memory variables.
 *
 *   restorePersistedStates(adapter)  – restores all persisted states
 */

const {todayStr} = require('./utils');
const {CONSTANTS} = require('./constants');

/**
 * Reads all persisted control states from the ioBroker DB and restores the
 * corresponding in-memory variables.
 *
 * MUST use getStateAsync() – NOT getState() – because the in-memory cache is
 * not yet populated at adapter start (subscribeStates() fills it asynchronously).
 *
 * Why in-memory variables and not direct state reads everywhere?
 * ──────────────────────────────────────────────────────────────
 *  1. _manualOverride: used as an *atomic guard* inside setManualOverride()
 *     between two awaits.  A getStateAsync() there would NOT be atomic and
 *     would re-introduce the race condition we just fixed.
 *  2. _seasonEnabled / _winterModeActive: read by the synchronous isInSeason()
 *     and checkFrostProtection() helpers that are called from the 60-s poll
 *     loop.  Making them async would cascade to >20 call sites.
 *  3. _winterFrostActive: hysteresis flag set *and* checked within the same
 *     synchronous checkFrostProtection() evaluation.  A state round-trip would
 *     break the hysteresis logic.
 *
 * The single startup read via getStateAsync() is therefore the correct pattern:
 *  – one async DB read on start, then synchronous in-memory access at runtime.
 *  – every write goes to both the in-memory variable AND the state (ack:true).
 *
 * @param {object} adapter  – adapter instance
 */
async function restorePersistedStates(adapter) {
    // ── season / winter mode ─────────────────────────────────────────────
    const wmState = await adapter.getStateAsync('control.winter_mode');
    const seState = await adapter.getStateAsync('control.season_enabled');
    adapter._winterModeActive = wmState && wmState.val !== null ? !!wmState.val : false;
    adapter._seasonEnabled = seState && seState.val !== null ? !!seState.val : false;
    adapter.setState('control.winter_mode', adapter._winterModeActive, true);
    adapter.setState('control.season_enabled', adapter._seasonEnabled, true);

    // ── manual override – always reset to false on restart ───────────────
    adapter._manualOverride = false;
    adapter.setState('control.manual_override', false, true);
    adapter.setState('control.manual_override_duration', 0, true);

    // ── counters that reset on restart ───────────────────────────────────
    adapter.setState('computed.pv_deactivate_remaining', 0, true);

    // ── UVC daily ensure skip – only valid if date matches today ─────────
    const skipState = await adapter.getStateAsync('control.uvc_ensure_skip_today');
    const skipDateSt = await adapter.getStateAsync('control.uvc_ensure_skip_date');
    const persistedSkip = skipState && skipState.val === true;
    const persistedDate = skipDateSt && typeof skipDateSt.val === 'string' ? skipDateSt.val : '';
    const today = todayStr();
    if (persistedSkip && persistedDate === today) {
        adapter._uvcEnsureSkipToday = true;
        adapter._uvcEnsureSkipDate = today;
        if (adapter.config.more_log_enabled) {
            adapter.log.info('UVC daily ensure: skip flag restored – ensure paused for today');
        }
    } else {
        if (persistedSkip && adapter.config.more_log_enabled) {
            adapter.log.info(`UVC daily ensure: skip flag from ${persistedDate || 'unknown date'} is outdated (today=${today}) – resetting`);
        }
        adapter._uvcEnsureSkipToday = false;
        adapter._uvcEnsureSkipDate = '';
    }
    adapter.setState('control.uvc_ensure_skip_today', adapter._uvcEnsureSkipToday, true);
    adapter.setState('control.uvc_ensure_skip_date', adapter._uvcEnsureSkipDate, true);

    // ── filter runtime ────────────────────────────────────────────────────
    const filterRunningState = await adapter.getStateAsync('control.filter_running');
    adapter._filterHoursUsed = (filterRunningState && typeof filterRunningState.val === 'number') ? filterRunningState.val : 0;
    const filterCtrlState = await adapter.getStateAsync('control.filter');
    if (filterCtrlState && filterCtrlState.val) {
        const lastUpd = await adapter.getStateAsync('info.lastUpdate');
        const lu = lastUpd && typeof lastUpd.val === 'number' ? lastUpd.val : 0;
        const maxBack = CONSTANTS.FILTER_RESTORE_MAX_AGE_MS; // 6 h plausibility cutoff
        adapter._filterOnSince = (lu > 0 && (Date.now() - lu) <= maxBack) ? lu : Date.now();
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`Filter runtime: filter was ON at startup – tracking from now (accumulated: ${adapter._filterHoursUsed.toFixed(2)} h)`);
        }
    }

    // ── UVC operating hours ───────────────────────────────────────────────
    const uvcHoursState = await adapter.getStateAsync('status.uvc_hours_used');
    adapter._uvcHoursUsed = (uvcHoursState && typeof uvcHoursState.val === 'number') ? uvcHoursState.val : 0;

    // Restore today's hours from persisted uvc_today_hours so a restart does not reset to 0.
    // Check the state's timestamp – if it was written today, subtract its value from the total.
    const uvcTodayState = await adapter.getStateAsync('status.uvc_today_hours');
    const tsToday = uvcTodayState && uvcTodayState.ts ? new Date(uvcTodayState.ts).toISOString().slice(0, 10) : '';
    if (tsToday === today && uvcTodayState && typeof uvcTodayState.val === 'number' && uvcTodayState.val > 0) {
        adapter._uvcDayStartHours = Math.max(0, adapter._uvcHoursUsed - uvcTodayState.val);
        adapter._uvcDayStartDate = today;
        adapter.log.debug(`UVC: restored uvc_today_hours from last run: ${uvcTodayState.val.toFixed(2)} h (baseline: ${adapter._uvcDayStartHours.toFixed(2)} h)`);
    } else {
        adapter._uvcDayStartHours = adapter._uvcHoursUsed;
        adapter._uvcDayStartDate = today;
        adapter.log.debug(`UVC: new day or no prior data – uvc_today_hours starts at 0`);
    }
    const uvcCtrlState = await adapter.getStateAsync('control.uvc');
    if (uvcCtrlState && uvcCtrlState.val) {
        // UVC was ON at shutdown → start tracking from now (conservative)
        adapter._uvcOnSince = Date.now();
    }
}

module.exports = {restorePersistedStates};
