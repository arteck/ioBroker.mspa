'use strict';

/**
 * lib/stateChangeHandler.js
 *
 * State change handler for writable control states of the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   onStateChange(adapter, id, state)  – handles ALL writable control state changes
 */

const notificationHelper = require('./notificationHelper');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// onStateChange – handles writable control state changes
// ---------------------------------------------------------------------------

/**
 * @param {object} adapter
 * @param {string} id
 * @param {object} state
 */
async function onStateChange(adapter, id, state) {
    if (!state) {
        return;
    }

    // -- Foreign states (PV, house, MSpa power, energy meter) ---------
    // Sie werden über subscribeForeignStates() abonniert und kommen mit ack=true.
    // Eigene States dieses Adapters beginnen mit `${adapter.namespace}.` (z. B. mspa.0.).
    if (!id.startsWith(`${adapter.namespace}.`)) {
        try {
            await adapter.onForeignStateChange(id, state);
        } catch (e) {
            adapter.log.error(`onForeignStateChange(${id}) failed: ${e.message}`);
        }
        return;
    }

    // Eigene Control-States: nur unbestätigte Schreibvorgänge verarbeiten
    if (state.ack) {
        return;
    }

    const key = id.split('.').pop();

    // ── status.time_windows_json – write back to adapter jsonConfig ─────
    if (key === 'time_windows_json') {
        await adapter._applyTimeWindowsJson(state.val);
        return;
    }

    // ── status.uvc_hours_used – manual correction after lamp replacement ──
    if (key === 'uvc_hours_used') {
        const newVal = parseFloat(state.val);
        if (isNaN(newVal) || newVal < 0) {
            adapter.log.warn(`uvc_hours_used: invalid value "${state.val}" – ignoring`);
            adapter.setState('status.uvc_hours_used', Math.round(adapter._uvcHoursUsed * 100) / 100, true);
            return;
        }
        const wasRunning = adapter._uvcOnSince !== null;
        adapter._uvcHoursUsed = newVal;
        adapter._uvcOnSince = wasRunning ? Date.now() : null; // restart session to avoid adding old delta
        const today = adapter.todayStr();
        adapter._uvcDayStartHours = newVal;
        adapter._uvcDayStartDate = today;
        adapter._uvcTodayResetDate = today;
        adapter.setState('status.uvc_hours_used', Math.round(newVal * 100) / 100, true);
        adapter.setState('status.uvc_today_hours', 0, true);
        adapter.computeUvcExpiry().catch(e => adapter.log.error(`computeUvcExpiry after manual reset: ${e.message}`));
        adapter.log.info(`UVC hours manually set to ${newVal.toFixed(2)} h (UVC was ${wasRunning ? 'running – session restarted' : 'off'})`);
        return;
    }

    try {
        if (['heater', 'filter', 'bubble', 'jet', 'ozone', 'uvc'].includes(key)) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`MSpa command: ${key} ? ${state.val}`);
            }
            // fromUser=true: setzt _lastCommandTime für App-Change-Detection-Suppression
            await adapter.setFeature(key, !!state.val, {fromUser: true});
            adapter.enableRapidPolling();
        } else if (key === 'target_temperature') {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`MSpa command: set temperature ? ${state.val}°C`);
            }
            await adapter.setTargetTemp(state.val);
            adapter.enableRapidPolling();
        } else if (key === 'bubble_level') {
            const lvl = Number(state.val);
            if (isNaN(lvl) || lvl < 0 || lvl > 3) {
                adapter.log.warn(`bubble_level ${state.val} out of range (0–3) – command ignored`);
                await adapter.setStatusCheck('error');
                // Ack with previous valid value from state store
                const cur = await adapter.getStateAsync('control.bubble_level');
                adapter.setState('control.bubble_level', (cur && cur.val != null) ? cur.val : 1, true);
                return;
            }
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`MSpa command: bubble level → ${lvl}`);
            }
            await adapter.setStatusCheck('send');
            await adapter._api.setBubbleLevel(lvl);
            await adapter.setStatusCheck(adapter._api._lastCommandConfirmed ? 'success' : 'error');
            // Immediate ack so UI confirms without waiting for next poll
            adapter.setState('control.bubble_level', lvl, true);
            adapter.enableRapidPolling();
        } else if (key === 'winter_mode') {
            adapter._winterModeActive = !!state.val;
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`Winter mode: ${adapter._winterModeActive ? 'ENABLED' : 'DISABLED'} via control state`);
            }
            adapter.setState('control.winter_mode', adapter._winterModeActive, true);
            if (adapter._lastData && Object.keys(adapter._lastData).length) {
                await adapter.checkFrostProtection(adapter._lastData);
            } else if (adapter._winterModeActive) {
                // No poll data yet – trigger immediate poll so frost protection is evaluated
                adapter.log.warn('winter_mode enabled but no poll data yet – triggering immediate poll');
                if (adapter._pollTimer) {
                    clearTimeout(adapter._pollTimer);
                    adapter._pollTimer = null;
                }
                adapter._pollTimer = setTimeout(() => adapter.doPoll(), CONSTANTS.MANUAL_OVERRIDE_POLL_DELAY_MS);
            }
        } else if (key === 'season_enabled') {
            const wasEnabled = adapter._seasonEnabled;
            adapter._seasonEnabled = !!state.val;
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`Season control: ${adapter._seasonEnabled ? 'ENABLED' : 'DISABLED'} via control state`);
            }
            adapter.setState('control.season_enabled', adapter._seasonEnabled, true);

            // Season just started (false → true) → allow first time-window of the day to reset uvc_today_hours
            if (!wasEnabled && adapter._seasonEnabled) {
                adapter._uvcTodayResetDate = ''; // force reset on next window start
                adapter.log.debug('UVC: season enabled – uvc_today_hours will reset on first time-window start today');
            }
            // FIX: sofort Zeitfenster neu auswerten statt bis zum nächsten 60s-Tick zu warten
            adapter.checkTimeWindows().catch(e => adapter.log.error(`checkTimeWindows after season_enabled change: ${e.message}`));

        } else if (key === 'manual_override') {
            const enable = !!state.val;
            try {
                await adapter.setManualOverride(enable);
            } catch (err) {
                adapter.log.error(`manual_override command failed: ${err.message}`);
                // Rollback: write previous value with ack so UI shows correct state
                adapter.setState('control.manual_override', !enable, true);
                return;
            }

        } else if (key === 'uvc_ensure_skip_today') {
            const skip = !!state.val;
            adapter._uvcEnsureSkipToday = skip;
            adapter._uvcEnsureSkipDate = skip ? adapter.todayStr() : '';
            adapter.setState('control.uvc_ensure_skip_today', skip, true);
            adapter.setState('control.uvc_ensure_skip_date', adapter._uvcEnsureSkipDate, true);
            if (skip) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info('UVC daily ensure: skip requested by user – pausing for today');
                }
                await notificationHelper.send(notificationHelper.format('uvcEnsureSkipped'));
                // stop immediately if ensure is currently running – but only if UVC actually runs
                if (adapter._uvcEnsureActive) {
                    try {
                        const uvcState = await adapter.getStateAsync('control.uvc');
                        if (uvcState && uvcState.val) {
                            if (adapter.config.more_log_enabled) {
                                adapter.log.info('UVC daily ensure: skip requested – UVC läuft, wird gestoppt');
                            }
                            await adapter.stopUvcEnsure();
                        } else {
                            if (adapter.config.more_log_enabled) {
                                adapter.log.info('UVC daily ensure: skip requested – UVC bereits aus, kein Befehl gesendet');
                            }
                            adapter._uvcEnsureActive = false;
                        }
                    } catch (e) {
                        adapter.log.warn(`UVC daily ensure: skip-check fehlgeschlagen – ${e.message}`);
                        // Fallback: sicher stoppen
                        await adapter.stopUvcEnsure();
                    }
                } else {
                    // ensure was not active – skip only affects the daily ensure scheduler,
                    // NOT a UVC that runs via time window or manually.
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info('UVC daily ensure: skip set – ensure scheduler paused for today (UVC not affected if running via window/manual)');
                    }
                }
            } else {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info('UVC daily ensure: skip cancelled – ensure active again');
                }
                // trigger immediate re-check so ensure starts without waiting up to 60s
                adapter.checkUvcDailyMinimum().catch(e => adapter.log.error(`UVC ensure re-check: ${e.message}`));
            }

        } else if (key === 'manual_override_duration') {
            const rawDuration = parseFloat(state.val);
            if (isNaN(rawDuration) || rawDuration < 0) {
                adapter.log.warn(`manual_override_duration: invalid value "${state.val}" – resetting to 0`);
                adapter.setState('control.manual_override_duration', 0, true);
                return;
            }
            const newDuration = Math.floor(rawDuration); // nur ganze Minuten
            // Always persist the new value with ack first
            adapter.setState('control.manual_override_duration', newDuration, true);
            // Only restart override timer if override is currently active
            if (adapter._manualOverride) {
                await adapter.setManualOverride(true, newDuration);
            }

        } else if (key === 'filter_reset') {
            if (state.val) {
                // Flush any currently running session into _filterHoursUsed first,
                // then reset to 0 and start a fresh session from now if filter is still ON.
                const wasRunning = adapter._filterOnSince !== null;
                adapter._filterHoursUsed = 0;
                adapter._filterOnSince = wasRunning ? Date.now() : null;
                adapter.setState('control.filter_running', {val: 0, ack: true});
                // Reset button ? always write false back (it's a momentary trigger)
                adapter.setState('control.filter_reset', {val: false, ack: true});
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`Filter runtime counter reset to 0 (filter was ${wasRunning ? 'running – new session started' : 'off'})`);
                }
            }
        }
    } catch (err) {
        adapter.log.error(`MSpa command failed (${key}): ${err.message}`);
    }
}

module.exports = { onStateChange };
