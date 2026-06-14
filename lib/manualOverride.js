'use strict';

/**
 * lib/manualOverride.js
 *
 * Manual override functions for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   setManualOverride(adapter, enable, durationMin)  – toggles manual override mode
 *   _resumeAfterOverride(adapter)                     – re-evaluates automations after override ends
 */

const notificationHelper = require('./notificationHelper');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// setManualOverride
// ---------------------------------------------------------------------------

/**
 * Toggles manual override mode.
 * When enabled: saves current auto state, disables PV and time control, sets timer
 * for duration (or indefinite if 0).
 * When disabled: clears timers, calls _resumeAfterOverride.
 *
 * @param {object}      adapter
 * @param {boolean}     enable
 * @param {number|null} [durationMin]
 */
async function setManualOverride(adapter, enable, durationMin = null) {
    // Atomic cancel BEFORE any await – prevents two concurrent calls from both starting a timer
    const existingTimer = adapter._manualOverrideTimer;
    adapter._manualOverrideTimer = null;
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    adapter._manualOverride = enable;
    adapter.setState('control.manual_override', enable, true);

    if (enable) {
        // PV may currently be active – cancel all deactivation timers and
        // mark PV inactive so no stale _pvActive=true remains while automations are paused.
        // _resumeAfterOverride() will re-evaluate surplus when override ends.
        if (adapter._pvActive || adapter._pvDeactivateTimer || adapter._pvStageTimer) {
            await adapter.pvCancelAllDeactivationTimers();
            if (adapter._pvActive) {
                adapter._pvActive = false;
                adapter.setState('computed.pv_active', false, true);
                adapter.log.debug('Manual override: PV deactivated (will re-evaluate on override end)');
            }
        }
        // read duration from state if not explicitly passed
        if (durationMin === null) {
            // FIX: getStateAsync statt getState – funktioniert auch beim Adapter-Start
            const ds = await adapter.getStateAsync('control.manual_override_duration');
            durationMin = ds && ds.val !== null ? Number(ds.val) : 0;
        } else {
            adapter.setState('control.manual_override_duration', durationMin, true);
        }

        if (durationMin > 0) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`Manual override: ENABLED for ${durationMin} min – all automations paused`);
            }

            // FIX: Timer ZUERST setup (synchron), DANN notification awaiten.
            // So kann ein concurrent disable-Aufruf den Timer noch korrekt canceln.
            const timerId = setTimeout(() => {
                // Guard: adapter is already shutting down
                if (adapter._unloading) {
                    return;
                }
                adapter._manualOverrideTimer = null;
                // Guard: another call may have concurrently disabled override
                if (!adapter._manualOverride) {
                    return;
                }
                if (adapter.config.more_log_enabled) {
                    adapter.log.info('Manual override: duration elapsed – automations RESUMED');
                }
                adapter._manualOverride = false;
                adapter.setState('control.manual_override', false, true);
                adapter.setState('control.manual_override_duration', 0, true);

                if (adapter.config.more_log_enabled) {
                    notificationHelper.send(notificationHelper.format('overrideEnded'))
                        .catch(e => adapter.log.error(`manualOverride auto-disable failed: ${e.message}`));
                }

                _resumeAfterOverride(adapter)
                    .catch(e => adapter.log.error(`manualOverride auto-disable failed: ${e.message}`));
            }, Math.round(durationMin * CONSTANTS.MS_PER_MINUTE));

            adapter._manualOverrideTimer = timerId;

            if (adapter.config.more_log_enabled) {
                await notificationHelper.send(notificationHelper.format('overrideOnTimed', {durationMin}))
                    .catch(e => adapter.log.error(`overrideOnTimed notification: ${e.message}`));
            }

            // Guard: a concurrent call may have already disabled override during the await above
            if (!adapter._manualOverride || adapter._unloading || adapter._manualOverrideTimer !== timerId) {
                adapter.log.debug('Manual override: aborted during notification send – cancelling timer');
                clearTimeout(timerId);
                adapter._manualOverrideTimer = null;
                return;
            }
        } else {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('Manual override: ENABLED indefinitely – all automations paused (set to false to resume)');
            }
            await notificationHelper.send(notificationHelper.format('overrideOnIndefinite'))
                .catch(e => adapter.log.error(`overrideOnIndefinite notification: ${e.message}`));
        }
    } else {
        if (adapter.config.more_log_enabled) {
            adapter.log.info('Manual override: DISABLED – all automations RESUMED');
        }
        await notificationHelper.send(notificationHelper.format('overrideOff'))
            .catch(e => adapter.log.error(`overrideOff notification: ${e.message}`));
        adapter.setState('control.manual_override_duration', 0, true);
        // immediately re-evaluate automations with latest data
        await _resumeAfterOverride(adapter);
    }
}

// ---------------------------------------------------------------------------
// _resumeAfterOverride
// ---------------------------------------------------------------------------

/**
 * Re-evaluates all automations after manual override ends.
 * Each task runs independently so one failure does not block the others.
 *
 * @param {object} adapter
 */
async function _resumeAfterOverride(adapter) {
    // Guard: adapter is shutting down – do not start new automations
    if (adapter._unloading) {
        adapter.log.debug('_resumeAfterOverride: adapter unloading – skipped');
        return;
    }
    const tasks = [];
    if (adapter._lastData && Object.keys(adapter._lastData).length) {
        tasks.push(adapter.checkFrostProtection(adapter._lastData).catch(e => adapter.log.error(`resumeAfterOverride/checkFrostProtection: ${e.message}`)));
    } else if (adapter._winterModeActive) {
        // No poll data yet but winter mode is active – trigger immediate poll
        adapter.log.warn('resumeAfterOverride: no poll data yet but winter mode active – triggering immediate poll');
        if (adapter._pollTimer) {
            clearTimeout(adapter._pollTimer);
            adapter._pollTimer = null;
        }
        adapter._pollTimer = setTimeout(() => adapter.doPoll(), CONSTANTS.MANUAL_OVERRIDE_POLL_DELAY_MS);
    }
    tasks.push(adapter.checkTimeWindows().catch(e => adapter.log.error(`resumeAfterOverride/checkTimeWindows: ${e.message}`)));
    tasks.push(adapter.evaluatePvSurplus().catch(e => adapter.log.error(`resumeAfterOverride/evaluatePvSurplus: ${e.message}`)));
    await Promise.all(tasks);
}

module.exports = {setManualOverride, _resumeAfterOverride};
