'use strict';

/**
 * lib/commands.js
 *
 * Command-related functions for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   _scheduleCommandedReset(adapter, feature, val, delayMs)  – schedules a reset of _adapterCommanded markers
 *   setFeature(adapter, feature, boolVal, opts)              – set a feature on/off with smart dependencies
 *   setTargetTemp(adapter, temp)                             – sets target temperature (queues if heater off)
 *   sendTargetTempDirect(adapter, temp, opts)                – direct temp API call without heater-state check
 */

const {transformStatus} = require('./utils');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resets _adapterCommanded[feature] back to null after delayMs.
 * Guard: only resets if value hasn't changed in the meantime.
 *
 * @param {object} adapter
 * @param {string} feature
 * @param {*}      val
 * @param {number} [delayMs=30000]
 */
function _scheduleCommandedReset(adapter, feature, val, delayMs = CONSTANTS.COMMANDED_RESET_DELAY_MS) {
    adapter.setStray(() => {
        if (adapter._unloading) {
            return;
        }
        if (adapter._adapterCommanded[feature] === val) {
            adapter._adapterCommanded[feature] = null;
            adapter.log.debug(`_adapterCommanded.${feature} reset to null after ${delayMs} ms`);
        }
    }, delayMs);
}

/**
 * Returns whether the filter pump is considered running, either from live API data
 * or from adapter-commanded / PV-managed state.
 *
 * @param {object} adapter
 * @returns {boolean}
 */
function _isFilterRunning(adapter) {
    return (adapter._lastData && adapter._lastData.filter === 'on') ||
           (adapter._api && adapter._api._lastStatus && adapter._api._lastStatus.filter_state === 1) ||
           (adapter._adapterCommanded.filter === true) ||
           (adapter._pvManagedFeatures && adapter._pvManagedFeatures.filter === true);
}

/**
 * @param {object}  adapter
 * @param {string}  feature
 * @param {boolean} boolVal
 * @param {{ fromUser?: boolean, fromAutomation?: boolean }} [opts]
 */
async function setFeature(adapter, feature, boolVal, {fromUser = false, fromAutomation = false} = {}) {
    const state = boolVal ? 1 : 0;
    if (feature in adapter._adapterCommanded) {
        adapter._adapterCommanded[feature] = boolVal;
    }
    // Mark command time – app-change detection will be suppressed for 30 s
    // Set for user commands AND automations (PV / time windows / frost) to avoid false-positive app-change detection.
    if (fromUser || fromAutomation) {
        adapter._lastCommandTime = Date.now();
    }

    // UVC can only be switched on when the filter pump is already running.
    // Auto-start filter if needed, then wait up to 15 s for the device to confirm it.
    if (feature === 'uvc' && boolVal) {
        if (!_isFilterRunning(adapter)) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC ON – filter not running, auto-starting filter pump first');
            }
            await adapter.setFeature('filter', true, {fromUser, fromAutomation});
            // Poll up to 15 s until filter is confirmed ON by the device
            const start = Date.now();
            let ok = false;
            while (Date.now() - start < CONSTANTS.RAPID_POLL_DURATION_MS) {
                await new Promise(r => setTimeout(r, CONSTANTS.RAPID_POLL_INTERVAL_MS));
                if (_isFilterRunning(adapter)) {
                    ok = true;
                    break;
                }
                try {
                    const raw = await adapter._api.getHotTubStatus();
                    adapter._lastData = transformStatus(raw);
                } catch (e) {
                    adapter.log.debug(`UVC pre-check poll failed: ${e.message}`);
                }
            }
            if (!ok) {
                adapter.log.warn('UVC ON: filter still not confirmed after 15 s – sending UVC command anyway');
            }
        }
    }

    switch (feature) {
        case 'heater': {
            if (boolVal) {
                // The heater requires the filter pump to be running.
                // Auto-start it if not already ON (live API data takes priority).
                const filterOn = _isFilterRunning(adapter);
                if (!filterOn) {
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info('heater ON – auto-starting filter pump first (required by device)');
                    }
                    await adapter.setFeature('filter', true, {fromUser, fromAutomation});
                    await adapter.sleep(CONSTANTS.PUMP_SPINUP_DELAY_MS); // give the pump time to spin up
                }
            }
            await adapter.setStatusCheck('send');
            let result;
            try {
                result = await adapter._api.setHeaterState(state);
            } catch (err) {
                // FIX: API exception → clear _adapterCommanded, set error status, rethrow
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.heater = null;
                // heater OFF attempted but threw → cancel pending temp timer anyway
                if (!boolVal && adapter._pendingTempTimer) {
                    clearTimeout(adapter._pendingTempTimer);
                    adapter._pendingTempTimer = null;
                }
                throw err;
            }
            if (adapter._api._lastCommandConfirmed) {
                await adapter.setStatusCheck('success');
                _scheduleCommandedReset(adapter, 'heater', boolVal);
                // FIX: only ack the state when the device actually confirmed the command
                adapter.setState('control.heater', boolVal, true);
                if (boolVal && adapter._pendingTargetTemp !== null) {
                    // Heater just switched ON → send pending target temperature after 10 s
                    if (adapter._pendingTempTimer) {
                        clearTimeout(adapter._pendingTempTimer);
                        adapter._pendingTempTimer = null;
                    }
                    const pendingTemp = adapter._pendingTargetTemp;
                    // Sofort entwerten – konkurrierende Aufrufer (z. B. setTargetTemp)
                    // dürfen den Wert nicht erneut abgreifen.
                    adapter._pendingTargetTemp = null;
                    adapter._pendingTempTimer = setTimeout(async () => {
                        adapter._pendingTempTimer = null;
                        if (adapter.config.more_log_enabled) {
                            adapter.log.info(`target_temperature: sending pending value ${pendingTemp}°C (10 s after heater ON)`);
                        }
                        try {
                            await adapter.sendTargetTempDirect(pendingTemp, {fromUser: true});
                        } catch (err) {
                            adapter.log.error(`target_temperature: delayed send FAILED – ${err.message}`);
                        }
                    }, CONSTANTS.PENDING_TEMP_DELAY_MS);
                }
            } else {
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.heater = null;

                if (fromAutomation) {
                    throw new Error(`setFeature('heater', ${boolVal}): not confirmed by device after polling`);
                }

                // FIX: do NOT ack state here – next poll will write the real device value
                adapter.log.warn('heater command not confirmed by device – state will be corrected on next poll');
            }
            // heater OFF: always cancel pending temp timer regardless of success/failure
            if (!boolVal && adapter._pendingTempTimer) {
                clearTimeout(adapter._pendingTempTimer);
                adapter._pendingTempTimer = null;
            }
            return result;
        }
        case 'filter': {
            if (!boolVal) {
                // The API rejects a filter-OFF command while UVC is still running.
                // → Explicitly switch off UVC (and bubble) first, then filter.
                // FIX: each pre-condition wrapped in try/catch so a single failure does NOT
                //      abort the filter-OFF sequence – we log a warning and continue.

                // ioBroker TS-Typen kennen nur die Callback-Variante von getState;
                // die synchrone Variante existiert zur Laufzeit im Adapter-Core.

                const uvcState = await adapter.getStateAsync('control.uvc');
                const bubbleState = await adapter.getStateAsync('control.bubble');
                const heaterState = await adapter.getStateAsync('control.heater');

                if (uvcState && uvcState.val) {
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info('filter OFF – auto-disabling UVC first (API requirement)');
                    }
                    try {
                        await adapter.setStatusCheck('send');
                        await adapter._api.setUvcState(0);
                        adapter._adapterCommanded.uvc = false;
                        if (adapter._api._lastCommandConfirmed) {
                            await adapter.setStatusCheck('success');
                            adapter.setState('control.uvc', false, true);
                        } else {
                            await adapter.setStatusCheck('error');
                            adapter._adapterCommanded.uvc = null;
                            adapter.log.warn('filter OFF: UVC pre-stop not confirmed – continuing with filter OFF anyway');
                        }
                    } catch (e) {
                        await adapter.setStatusCheck('error');
                        adapter._adapterCommanded.uvc = null;
                        adapter.log.warn(`filter OFF: UVC pre-stop failed (${e.message}) – continuing with filter OFF anyway`);
                    }
                    await adapter.sleep(CONSTANTS.PRE_STOP_SLEEP_MS);
                }
                if (bubbleState && bubbleState.val) {
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info('filter OFF – auto-disabling bubble first (API requirement)');
                    }
                    try {
                        await adapter.setStatusCheck('send');
                        await adapter._api.setBubbleState(0, adapter._lastData.bubble_level || 1);
                        adapter._adapterCommanded.bubble = false;
                        if (adapter._api._lastCommandConfirmed) {
                            await adapter.setStatusCheck('success');
                            adapter.setState('control.bubble', false, true);
                        } else {
                            await adapter.setStatusCheck('error');
                            adapter._adapterCommanded.bubble = null;
                            adapter.log.warn('filter OFF: bubble pre-stop not confirmed – continuing with filter OFF anyway');
                        }
                    } catch (e) {
                        await adapter.setStatusCheck('error');
                        adapter._adapterCommanded.bubble = null;
                        adapter.log.warn(`filter OFF: bubble pre-stop failed (${e.message}) – continuing with filter OFF anyway`);
                    }
                    await adapter.sleep(CONSTANTS.PRE_STOP_SLEEP_MS);
                }
                if (heaterState && heaterState.val) {
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info('filter OFF – auto-disabling heater first');
                    }
                    try {
                        await adapter.setFeature('heater', false, {fromUser, fromAutomation});
                    } catch (e) {
                        adapter.log.warn(`filter OFF: heater pre-stop failed (${e.message}) – continuing with filter OFF anyway`);
                    }
                    await adapter.sleep(CONSTANTS.PRE_STOP_SLEEP_MS);
                }
            }
            await adapter.setStatusCheck('send');
            try {
                await adapter._api.setFilterState(state);
            } catch (err) {
                // FIX: API exception → clear _adapterCommanded, set error status, rethrow
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.filter = null;
                throw err;
            }
            if (adapter._api._lastCommandConfirmed) {
                await adapter.setStatusCheck('success');
                _scheduleCommandedReset(adapter, 'filter', boolVal);
                // FIX: only ack when device confirmed
                adapter.setState('control.filter', boolVal, true);
            } else {
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.filter = null;

                if (fromAutomation) {
                    throw new Error(`setFeature('filter', ${boolVal}): not confirmed by device after polling`);
                }

                // FIX: do NOT ack – next poll corrects the state
                adapter.log.warn('filter command not confirmed by device – state will be corrected on next poll');

            }
            return;
        }
        case 'bubble':
            await adapter.setStatusCheck('send');
            try {
                await adapter._api.setBubbleState(state, adapter._lastData.bubble_level || 1);
            } catch (err) {
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.bubble = null;
                throw err;
            }
            if (adapter._api._lastCommandConfirmed) {
                await adapter.setStatusCheck('success');
                _scheduleCommandedReset(adapter, 'bubble', boolVal);
                adapter.setState('control.bubble', boolVal, true);
            } else {
                adapter._adapterCommanded.bubble = null;
                await adapter.setStatusCheck('error');
                adapter.log.warn('bubble command not confirmed by device – state will be corrected on next poll');
            }
            return;
        case 'jet':
            await adapter.setStatusCheck('send');
            try {
                await adapter._api.setJetState(state);
            } catch (err) {
                await adapter.setStatusCheck('error');
                throw err;
            }
            if (adapter._api._lastCommandConfirmed) {
                await adapter.setStatusCheck('success');
                adapter.setState('control.jet', boolVal, true);
            } else {
                await adapter.setStatusCheck('error');
                adapter.log.warn('jet command not confirmed by device – state will be corrected on next poll');
            }
            return;
        case 'ozone':
            await adapter.setStatusCheck('send');
            try {
                await adapter._api.setOzoneState(state);
            } catch (err) {
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.ozone = null;
                throw err;
            }
            if (adapter._api._lastCommandConfirmed) {
                await adapter.setStatusCheck('success');
                adapter.setState('control.ozone', boolVal, true);
            } else {
                adapter._adapterCommanded.ozone = null;
                await adapter.setStatusCheck('error');
                adapter.log.warn('ozone command not confirmed by device – state will be corrected on next poll');
            }
            return;
        case 'uvc':
            await adapter.setStatusCheck('send');
            try {
                await adapter._api.setUvcState(state);
            } catch (err) {
                await adapter.setStatusCheck('error');
                adapter._adapterCommanded.uvc = null;
                throw err;
            }
            if (adapter._api._lastCommandConfirmed) {
                await adapter.setStatusCheck('success');
                _scheduleCommandedReset(adapter, 'uvc', boolVal);
                adapter.setState('control.uvc', boolVal, true);
            } else {
                adapter._adapterCommanded.uvc = null;

                if (fromAutomation) {
                    throw new Error(`setFeature('uvc', ${boolVal}): not confirmed by device after polling`);
                }

                await adapter.setStatusCheck('error');
                adapter.log.warn('uvc command not confirmed by device – state will be corrected on next poll');

            }
            return;
    }
}

/**
 * Sets the target temperature.
 * If the heater is not currently on, the value is queued as pending
 * and will be sent 10 s after the heater is switched ON.
 *
 * @param {object} adapter
 * @param {number} temp
 */
async function setTargetTemp(adapter, temp) {
    // Validate range (MSpa: 20–42 °C)
    const MIN_TEMP = CONSTANTS.MIN_TARGET_TEMP_C;
    const MAX_TEMP = CONSTANTS.MAX_TARGET_TEMP_C;
    const t = Number(temp);
    if (isNaN(t) || t < MIN_TEMP || t > MAX_TEMP) {
        adapter.log.warn(`target_temperature ${temp}°C out of range (${MIN_TEMP}–${MAX_TEMP}°C) – command ignored`);
        await adapter.setStatusCheck('error');
        return;
    }

    // If heater is not currently on (user command via state), store as pending.
    // Automations that just called setFeature('heater', true) use _scheduleTargetTempAfterHeaterOn().
    // Use live API data + _adapterCommanded as fallback so we don't queue unnecessarily
    // when the heater was just switched ON but the poll hasn't confirmed it yet.

    const heaterState = await adapter.getStateAsync('control.heater');
    const heaterOnState = heaterState.val;
    const heaterOnCommanded = adapter._adapterCommanded.heater === true;
    const heaterOnLive = adapter._lastData && adapter._lastData.heater === 'on';
    const heaterOn = heaterOnState || heaterOnCommanded || heaterOnLive;

    if (!heaterOn) {
        adapter._pendingTargetTemp = t;
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`target_temperature ${t}°C queued – will be sent 10 s after heater is switched ON`);
        }
        await adapter.setStatusCheck('queued');
        // Immediate ack so UI shows queued value
        adapter.setState('control.target_temperature', t, true);
        return;
    }
    adapter._pendingTargetTemp = null;
    return sendTargetTempDirect(adapter, t, {fromUser: true});
}

/**
 * Sends the target temperature directly to the API (no heater-state check).
 * Use this in automations that have just called setFeature('heater', true).
 *
 * @param {object}  adapter
 * @param {number}  temp
 * @param {{ fromUser?: boolean, fromAutomation?: boolean }} [opts] - set fromUser=true for direct user commands, fromAutomation=true for automations (both update _lastCommandTime for app-change detection grace period)
 */
async function sendTargetTempDirect(adapter, temp, {fromUser = false, fromAutomation = false} = {}) {
    adapter._adapterCommanded.target_temperature = temp;
    if (fromUser || fromAutomation) {
        adapter._lastCommandTime = Date.now();
    }
    await adapter.setStatusCheck('send');
    let result;
    try {
        result = await adapter._api.setTemperatureSetting(temp);
    } catch (err) {
        // FIX: API exception → set error status, clear commanded marker, rethrow.
        await adapter.setStatusCheck('error');
        adapter._adapterCommanded.target_temperature = null;
        adapter.log.warn(`target_temperature: command could not be sent – ${err.message}`);
        throw err;
    }
    await adapter.setStatusCheck(adapter._api._lastCommandConfirmed ? 'success' : 'error');
    if (!adapter._api._lastCommandConfirmed) {
        // Command was not processed/confirmed by the device – drop the
        // commanded marker so the next poll writes the real device value.
        adapter._adapterCommanded.target_temperature = null;
        adapter.log.warn('target_temperature command not confirmed by device – state will be corrected on next poll');
    } else {
        // Auto-reset target_temperature after 30s so app-change detection works again
        adapter._scheduleCommandedReset?.('target_temperature', temp);
    }
    // Immediate ack so UI confirms value without waiting for next poll
    adapter.setState('control.target_temperature', temp, true);
    return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
    _scheduleCommandedReset,
    setFeature,
    setTargetTemp,
    sendTargetTempDirect,
};
