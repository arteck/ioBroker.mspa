'use strict';

/**
 * lib/powerCycle.js
 *
 * Power-cycle detection and state restoration for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   checkPowerCycle(adapter, data)         – detects power OFF/ON via is_online and snapshot comparison
 *   enforceTemperatureUnit(adapter, data)  – enforces °C unit via API
 *   restoreSavedState(adapter)             – restores saved device state after power cycle
 *   safeCmd(adapter, fn, label)            – try/catch wrapper for restore commands
 */

// ---------------------------------------------------------------------------
// Power cycle detection + state restore
// ---------------------------------------------------------------------------

const {CONSTANTS} = require('./constants');

/**
 * @param {object} adapter
 * @param {object} data
 */
async function checkPowerCycle(adapter, data) {
    const currentOnline = !!data.is_online;
    let powerCycle = false;

    if (adapter._lastIsOnline !== null) {
        if (adapter._lastIsOnline && !currentOnline) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('MSpa power OFF detected – saving state');
            }
            adapter._savedState = {
                heater: data.heater,
                target_temperature: data.target_temperature,
                filter: data.filter,
                temperature_unit: data.temperature_unit,
                ozone: data.ozone,
                uvc: data.uvc,
                bubble: data.bubble,
                bubble_level: data.bubble_level,
            };
        } else if (!adapter._lastIsOnline && currentOnline) {
            powerCycle = true;
            if (adapter.config.more_log_enabled) {
                adapter.log.info('MSpa power ON detected (is_online transition)');
            }
        }
    }

    if (!powerCycle && Object.keys(adapter._lastSnapshot).length) {
        // Suppress power-cycle detection for 60 s after the adapter sent any command.
        // Two features going off simultaneously (e.g. UVC + filter after stopEnsure)
        // would otherwise be misinterpreted as a power cycle.
        const cmdAgeMs = Date.now() - adapter._lastCommandTime;
        const suppressPowerCycleDetection = adapter._lastCommandTime > 0 && cmdAgeMs < CONSTANTS.POWER_CYCLE_SUPPRESS_MS;
        if (suppressPowerCycleDetection) {
            adapter.log.debug(`checkPowerCycle: snapshot detection suppressed (last command ${Math.round(cmdAgeMs / 1000)} s ago)`);
        } else {
            const changes = [];
            if (adapter._lastSnapshot.temperature_unit === 0 && data.temperature_unit === 1) {
                changes.push('temp_unit_reset');
            }
            if (adapter._lastSnapshot.heater === 'on' && data.heater === 'off') {
                changes.push('heater_off');
            }
            if (adapter._lastSnapshot.filter === 'on' && data.filter === 'off') {
                changes.push('filter_off');
            }
            if (adapter._lastSnapshot.ozone === 'on' && data.ozone === 'off') {
                changes.push('ozone_off');
            }
            if (adapter._lastSnapshot.uvc === 'on' && data.uvc === 'off') {
                changes.push('uvc_off');
            }
            if (changes.length >= 2) {
                powerCycle = true;
                adapter.log.warn(`MSpa possible power cycle (${changes.join(', ')})`);
            }
        }
    }

    adapter._lastSnapshot = {
        temperature_unit: data.temperature_unit,
        heater: data.heater,
        filter: data.filter,
        ozone: data.ozone,
        uvc: data.uvc,
        target_temperature: data.target_temperature,
    };
    adapter._lastIsOnline = currentOnline;

    if (powerCycle) {
        const cfg = adapter.config;
        if (cfg.trackTemperatureUnit) {
            await enforceTemperatureUnit(adapter, data);
        }
        if (cfg.restoreStateOnPowerCycle && Object.keys(adapter._savedState).length) {
            await restoreSavedState(adapter);
        }
    }

    if (adapter.config.alwaysEnforceUnit && !powerCycle) {
        await enforceTemperatureUnit(adapter, data);
    }
}

/**
 * @param {object} adapter
 * @param {object} data
 */
async function enforceTemperatureUnit(adapter, data) {
    const desired = 0; // °C
    if ((data.temperature_unit || 0) !== desired) {
        if (adapter.config.more_log_enabled) {
            adapter.log.info('MSpa enforcing temperature unit ? Celsius');
        }
        await adapter._api.setTemperatureUnit(desired);
    }
}

/**
 * @param {object} adapter
 */
async function restoreSavedState(adapter) {
    if (adapter.config.more_log_enabled) {
        adapter.log.info('MSpa restoring state after power cycle…');
    }
    await adapter.sleep(CONSTANTS.RESTORE_SLEEP_MS);

    // ── Guard: heater must not be restored outside an active automation ──────
    // If time windows or PV are configured, only restore the heater when at
    // least one window with action_heating is CURRENTLY active (in-window AND
    // tracked as active) or PV is currently active with a heating window.
    // Without this guard the heater would be restored e.g. at 19:00 even if
    // the window ended at 18:00 – and checkTimeWindows() would never shut it
    // down because _timeWindowActive[i] is false (new adapter session, wasIn=false).
    let allowHeaterRestore = true;
    const windows = adapter.config.timeWindows;
    const hasHeatingWindows = Array.isArray(windows) && windows.some(w => w.active && w.action_heating);
    if (hasHeatingWindows && !adapter._pvActive) {
        const heatingWindowActiveNow = Array.isArray(windows) && windows.some((w, i) => w.active && w.action_heating && adapter._timeWindowActive[i]);
        if (!heatingWindowActiveNow) {
            allowHeaterRestore = false;
            adapter.log.info('Power cycle restore: heater NOT restored – no heating time window is currently active');
        }
    }
    if (!adapter._seasonEnabled && !adapter._winterModeActive) {
        allowHeaterRestore = false;
        adapter.log.info('Power cycle restore: heater NOT restored – season disabled and winter mode inactive');
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (adapter._savedState.target_temperature && allowHeaterRestore) {
        await safeCmd(adapter, () => adapter.setTargetTemp(adapter._savedState.target_temperature), 'temperature');
    }
    for (const feature of ['heater', 'filter', 'ozone', 'uvc', 'bubble']) {
        if (adapter._savedState[feature] === 'on') {
            if (feature === 'heater' && !allowHeaterRestore) {
                continue;
            }
            await safeCmd(adapter, () => adapter.setFeature(feature, true, {fromAutomation: true}), feature);
            await adapter.sleep(CONSTANTS.PRE_STOP_SLEEP_MS);
        }
    }
    if (adapter._savedState.bubble === 'on' && adapter._savedState.bubble_level) {
        await safeCmd(adapter, () => adapter._api.setBubbleLevel(adapter._savedState.bubble_level), 'bubble_level');
    }

    // After restore: reconcile automation state with actual device state.
    // checkTimeWindows() will shut down features that are now running outside
    // their window (e.g. filter restored while its window has ended).
    adapter.checkTimeWindows().catch(e => adapter.log.error(`restoreSavedState: checkTimeWindows reconcile failed – ${e.message}`));
}

/**
 * @param {object} adapter
 * @param {Function} fn
 * @param {string} label
 */
async function safeCmd(adapter, fn, label) {
    try {
        await fn();
    } catch (err) {
        adapter.log.error(`MSpa restore ${label} failed: ${err.message}`);
    }
}

module.exports = { checkPowerCycle, enforceTemperatureUnit, restoreSavedState, safeCmd };
