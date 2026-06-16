'use strict';

/**
 * lib/pv.js
 *
 * PV surplus control logic for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   init(adapter)                                  – subscribe states, read initial values
 *   onForeignStateChange(adapter, id, state)       – handle PV / house / MSpa power updates
 *   evaluateSurplus(adapter)                       – activation / deactivation decision
 *   cancelAllDeactivationTimers(adapter)           – clear debounce + stage timers
 *   reactivate(adapter, pvWindows, surplus)        – re-activate features after surplus recovery
 *   stagedDeactivate(adapter, pvWindows, immediate)– staged heater → UVC → filter shutdown
 */

const notificationHelper = require('./notificationHelper');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sets _pvActive and persists the value to computed.pv_active in one call.
 * Use this everywhere instead of direct `adapter._pvActive = value` assignments
 * so the state always reflects the in-memory flag.
 *
 * @param {object}  adapter
 * @param {boolean} value
 */
function setPvActive(adapter, value) {
    adapter._pvActive = value;
    adapter.setState('computed.pv_active', value, true);
}

/**
 * Returns true when there is at least one active time-window row with PV enabled.
 *
 * @param {object} adapter
 */
function hasPvWindows(adapter) {
    const cfg = adapter.config;
    return Array.isArray(cfg.timeWindows) && cfg.timeWindows.some(w => w.active && w.pv_steu);
}

/**
 * Returns the effective target temperature for PV heater activation.
 *
 * Priority:
 *   1. Current value of state `control.target_temperature` (manually set by user)
 *   2. `w.target_temp` from the time-window config (fallback)
 *   3. null → no temperature command will be sent
 *
 * This ensures that if the user raised the target from 25 °C to 30 °C manually,
 * PV will restore 30 °C when it re-activates the heater – not the stale 25 °C
 * that is stored in the time-window configuration.
 *
 * @param {object} adapter
 * @param {object} w  – time window config row
 * @returns {Promise<number|null>}
 */
async function getEffectiveTargetTemp(adapter, w) {
    try {
        const st = await adapter.getStateAsync('control.target_temperature');
        if (st && st.val != null && Number(st.val) > 0) {
            const current = Number(st.val);
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`PV: using current target temperature ${current}°C (user-set) instead of window config ${w.target_temp ?? '—'}°C`);
            }
            return current;
        }
    } catch (_) { /* ignore – fall through to window config */
    }
    // fallback: window config value
    return (w.target_temp != null && w.target_temp !== 0) ? w.target_temp : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to foreign PV states and read initial values.
 *
 * @param {object} adapter
 */
async function init(adapter) {
    const cfg = adapter.config;
    if (!hasPvWindows(adapter)) {
        adapter.log.debug('PV: no active time window rows with PV enabled – skipping init');
        return;
    }
    if (adapter._seasonEnabled && adapter.config.more_log_enabled) {
        adapter.log.info(`PV: season control active (${cfg.season_start} – ${cfg.season_end}), today inSeason=${adapter.isInSeason()}`);
    }
    if (adapter.config.more_log_enabled) {
        adapter.log.info(`PV: initialising surplus control (threshold=${cfg.pv_threshold_w ?? 500} W, hysteresis=${cfg.pv_hysteresis_w ?? 100} W, heating=${!!cfg.pv_action_heating}, filter=${!!cfg.pv_action_filter}, targetTemp=${cfg.pv_target_temp ?? '—'}°C)`);
    }

    if (cfg.pv_power_generated_id) {
        adapter.subscribeForeignStates(cfg.pv_power_generated_id);
        const s = await adapter.getForeignStateAsync(cfg.pv_power_generated_id);
        if (s && s.val !== null) {
            adapter._pvPower = s.val;
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`PV: initial PV generation = ${adapter._pvPower} W  (id: ${cfg.pv_power_generated_id})`);
            }
        } else {
            adapter.log.warn(`PV: generation state not available yet (id: ${cfg.pv_power_generated_id})`);
        }
    } else {
        adapter.log.warn('PV: no Object-ID configured for PV generation – surplus control will not work');
    }

    if (cfg.pv_power_house_id) {
        adapter.subscribeForeignStates(cfg.pv_power_house_id);
        const s = await adapter.getForeignStateAsync(cfg.pv_power_house_id);
        if (s && s.val !== null) {
            adapter._pvHouse = s.val;
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`PV: initial house consumption = ${adapter._pvHouse} W  (id: ${cfg.pv_power_house_id})`);
            }
        } else {
            adapter.log.warn(`PV: house consumption state not available yet (id: ${cfg.pv_power_house_id})`);
        }
    } else {
        adapter.log.warn('PV: no Object-ID configured for house consumption – surplus control will not work');
    }

    if (cfg.consumption_enabled && cfg.external_power_w_id) {
        adapter.subscribeForeignStates(cfg.external_power_w_id);
        const s = await adapter.getForeignStateAsync(cfg.external_power_w_id);
        if (s && s.val !== null) {
            adapter._pvMspa = Number(s.val) || 0;
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`PV: initial MSpa power = ${adapter._pvMspa} W  (id: ${cfg.external_power_w_id})`);
            }
        } else {
            adapter._pvMspa = 0;
            adapter.log.warn(`PV: MSpa power state not available yet (id: ${cfg.external_power_w_id})`);
        }
        if (adapter.config.more_log_enabled) {
            adapter.log.info('PV: surplus mode: PV − (house − MSpa) – MSpa self-consumption excluded from house load, no oscillation');
        }
    } else if (adapter.config.more_log_enabled) {
        adapter.log.info('PV: surplus mode: PV generation only (no house correction) – threshold = minimum PV generation to activate');
    }

    adapter.log.debug(`PV: init done – pvPower=${adapter._pvPower}, pvHouse=${adapter._pvHouse}, pvMspa=${adapter._pvMspa}, pvActive=${adapter._pvActive}`);

    // Restore _pvActive from persisted state – if PV was active when adapter stopped,
    // the first evaluateSurplus call will immediately re-evaluate and act correctly.
    const pvActiveState = await adapter.getStateAsync('computed.pv_active');
    if (pvActiveState && pvActiveState.val === true) {
        adapter._pvActive = true; // direct – setState not needed, already persisted
        adapter.log.debug('PV: restored _pvActive=true from persisted state');
    }
}

/**
 * Handle foreign state changes for PV generation, house consumption and MSpa power.
 *
 * @param {object} adapter
 * @param {string} id
 * @param {object} state
 */
async function onForeignStateChange(adapter, id, state) {
    if (!state) {
        adapter.log.debug(`PV.onForeignStateChange – state is null for id=${id}`);
        return;
    }
    if (state.ack === false) {
        adapter.log.debug(`PV.onForeignStateChange – ignoring unacked state change for id=${id}`);
        return;
    }


    if (!hasPvWindows(adapter)) {
        return;
    }

    const cfg = adapter.config;
    if (id === cfg.pv_power_generated_id) {
        const prev = adapter._pvPower;
        adapter._pvPower = state.val;
        adapter.log.debug(`PV: generation updated ${prev} → ${adapter._pvPower} W`);
    } else if (id === cfg.pv_power_house_id) {
        const prev = adapter._pvHouse;
        adapter._pvHouse = state.val;
        adapter.log.debug(`PV: house consumption updated ${prev} → ${adapter._pvHouse} W`);
    } else if (cfg.consumption_enabled && id === cfg.external_power_w_id) {
        const prev = adapter._pvMspa;
        adapter._pvMspa = Number(state.val) || 0;
        adapter.log.debug(`PV: MSpa power updated ${prev} → ${adapter._pvMspa} W`);
    } else {
        return; // not a PV id – consumption already handled above
    }
    await evaluateSurplus(adapter);
}

/**
 * Core activation / deactivation decision based on current surplus.
 *
 * @param {object} adapter
 */
async function evaluateSurplus(adapter) {
    const cfg = adapter.config;

    if (adapter._manualOverride) {
        adapter.log.debug('PV: manual override active – skipping surplus evaluation');
        return;
    }

    // Don't evaluate PV surplus when the device is offline – stale data would
    // trigger false activation notifications every poll cycle.
    if (!adapter._lastData || adapter._lastData.is_online === false) {
        adapter.log.debug('PV: device offline, skipping surplus evaluation');
        return;
    }

    if (!adapter.isInSeason()) {
        adapter.log.debug('PV: outside season – skipping surplus evaluation');
        await cancelAllDeactivationTimers(adapter);
        if (adapter._pvActive) {
            setPvActive(adapter, false);
            if (adapter.config.more_log_enabled) {
                adapter.log.info('PV: season ended – staged deactivation');
            }
            const pvWindows = _pvWindows(adapter);
            await stagedDeactivate(adapter, pvWindows, true /* immediate */);
        }
        return;
    }

    // ── Surplus calculation ────────────────────────────────────────────────
    let surplus;
    let surplusMode;
    if (cfg.consumption_enabled && cfg.external_power_w_id && adapter._pvPower !== null && adapter._pvHouse !== null) {
        const mspaLoad = adapter._pvMspa !== null ? adapter._pvMspa : 0;
        surplus = adapter._pvPower - (adapter._pvHouse - mspaLoad);
        surplusMode = `PV(${adapter._pvPower})−(house(${adapter._pvHouse})−mspa(${mspaLoad}))`;
    } else if (adapter._pvPower !== null) {
        surplus = adapter._pvPower;
        surplusMode = `PV-only(${adapter._pvPower})`;
    } else {
        adapter.log.debug(`PV: evaluation skipped – pvPower=${adapter._pvPower}, pvHouse=${adapter._pvHouse}, pvMspa=${adapter._pvMspa}`);
        return;
    }

    const threshold = cfg.pv_threshold_w || CONSTANTS.PV_THRESHOLD_DEFAULT_W;
    const hysteresis = Math.min(cfg.pv_hysteresis_w || CONSTANTS.PV_HYSTERESIS_DEFAULT_W, threshold);
    const offAt = threshold - hysteresis;

    adapter.log.debug(`PV: surplus=${surplus} W [${surplusMode}] | threshold=${threshold} W | offAt=${offAt} W | pvActive=${adapter._pvActive} | managed=${JSON.stringify(adapter._pvManagedFeatures)}`);

    const shouldActivate = surplus >= threshold;
    const shouldDeactivate = surplus < offAt;

    const pvWindows = _pvWindows(adapter);
    if (pvWindows.length === 0) {
        // No PV window active right now (outside configured time / day).
        // If PV was running, deactivate immediately so pv_active reflects reality.
        if (adapter._pvActive) {
            adapter.log.info('PV: time window ended – deactivating (pv_active → false)');
            await cancelAllDeactivationTimers(adapter);
            setPvActive(adapter, false);
            const allWindows = _pvWindowsAll(adapter);
            await stagedDeactivate(adapter, allWindows, true /* immediate */);
        } else {
            adapter.log.debug('PV: no PV-enabled time window currently active – nothing to do');
        }
        return;
    }

    // ── Activation ──────────────────────────────────────────────────────────
    if (shouldActivate && (!adapter._pvActive || adapter._pvStageTimer !== null)) {
        const wasStaging = adapter._pvStageTimer !== null;
        await cancelAllDeactivationTimers(adapter);

        if (!wasStaging && !adapter._pvActive) {
            setPvActive(adapter, true);
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`PV: surplus DETECTED (${surplus} W ≥ ${threshold} W) – activating heater`);
            }
            await notificationHelper.send(notificationHelper.format('pvActivated', {surplus}));
            for (const w of pvWindows) {
                try {
                    if (w.action_heating) {
                        // Filter läuft bereits (vom Zeitfenster gestartet) – nur Heizung an
                        await adapter.setFeature('heater', true, {fromAutomation: true});
                        adapter._pvManagedFeatures.heater = true;
                        const tempToSet = await getEffectiveTargetTemp(adapter, w);
                        if (tempToSet != null) {
                            adapter.setStray(() => {
                                adapter.sendTargetTempDirect(tempToSet, {fromAutomation: true}).catch(e => adapter.log.error(`PV: target temperature send FAILED – ${e.message}`));
                            }, CONSTANTS.PENDING_TEMP_DELAY_MS);
                        }
                    }
                    // Filter und UVC werden vom Zeitfenster verwaltet – kein PV-Eingriff
                } catch (err) {
                    setPvActive(adapter, false);
                    adapter.log.error(`PV: activation FAILED – ${err.message}`);
                    break;
                }
            }
            if (adapter._pvActive) {
                adapter.enableRapidPolling();
            }

        } else if (wasStaging) {
            await reactivate(adapter, pvWindows, surplus);
        }

        // ── Surplus recovered while debounce runs ──────────────────────────────
    } else if (adapter._pvActive && !shouldDeactivate && adapter._pvDeactivateTimer && !adapter._pvStageTimer) {
        await cancelAllDeactivationTimers(adapter);
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`PV: surplus recovered (${surplus} W ≥ ${offAt} W) – deactivation cancelled`);
        }

        // ── Surplus gone: start debounce ─────────────────────────────────────
    } else if (adapter._pvActive && shouldDeactivate && !adapter._pvDeactivateTimer && !adapter._pvStageTimer) {
        const delayMin = cfg.pv_deactivate_delay_min ?? 5;
        const debounceMs = delayMin * CONSTANTS.MS_PER_MINUTE;
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`PV: surplus below threshold (${surplus} W < ${offAt} W) – waiting ${delayMin} min (cloud cover protection)`);
        }

        adapter._pvDeactivateCountdown = delayMin;
        adapter.setState('computed.pv_deactivate_remaining', delayMin, true);

        if (delayMin > 0) {
            if (adapter._pvDeactivateCountdownInt) {
                clearInterval(adapter._pvDeactivateCountdownInt);
            }
            const startedAt = Date.now();
            adapter._pvDeactivateCountdownInt = setInterval(async () => {
                const elapsedMin = Math.floor((Date.now() - startedAt) / CONSTANTS.MS_PER_MINUTE);
                const remaining = Math.max(0, delayMin - elapsedMin);
                adapter._pvDeactivateCountdown = remaining;
                adapter.setState('computed.pv_deactivate_remaining', remaining, true);
            }, CONSTANTS.MS_PER_MINUTE);
        }

        adapter._pvDeactivateTimer = setTimeout(async () => {
            adapter._pvDeactivateTimer = null;
            if (adapter._pvDeactivateCountdownInt) {
                clearInterval(adapter._pvDeactivateCountdownInt);
                adapter._pvDeactivateCountdownInt = null;
            }
            adapter._pvDeactivateCountdown = 0;
            adapter.setState('computed.pv_deactivate_remaining', 0, true);
            if (adapter.config.more_log_enabled) {
                adapter.log.info('PV: debounce elapsed – starting staged deactivation');
            }

            await notificationHelper.send(notificationHelper.format('pvDeactivated'));

            setPvActive(adapter, false);
            await stagedDeactivate(adapter, pvWindows, false);
        }, debounceMs);

    } else {
        adapter.log.debug(`PV: no action (pvActive=${adapter._pvActive}, shouldActivate=${shouldActivate}, shouldDeactivate=${shouldDeactivate}, debounce=${!!adapter._pvDeactivateTimer}, staging=${!!adapter._pvStageTimer})`);
    }
}

/**
 * Cancel debounce timer, countdown interval and stage timer.
 * Resets pv_deactivate_remaining to 0.
 *
 * @param {object} adapter
 */
async function cancelAllDeactivationTimers(adapter) {
    if (adapter._pvDeactivateTimer) {
        clearTimeout(adapter._pvDeactivateTimer);
        adapter._pvDeactivateTimer = null;
    }
    if (adapter._pvDeactivateCountdownInt) {
        clearInterval(adapter._pvDeactivateCountdownInt);
        adapter._pvDeactivateCountdownInt = null;
    }
    if (adapter._pvStageTimer) {
        clearTimeout(adapter._pvStageTimer);
        adapter._pvStageTimer = null;
    }
    adapter._pvDeactivateCountdown = 0;
    adapter.setState('computed.pv_deactivate_remaining', 0, true);
}

/**
 * Re-activate features that were turned off during staged deactivation when
 * surplus returns before the staging is complete.
 *
 * @param {object} adapter
 * @param {Array}  pvWindows
 * @param {number} surplus
 */
async function reactivate(adapter, pvWindows, surplus) {
    if (adapter.config.more_log_enabled) {
        adapter.log.info(`PV: surplus recovered during staging (${surplus} W) – re-activating heater`);
    }
    for (const w of pvWindows) {
        try {
            if (w.action_heating && !adapter._pvManagedFeatures.heater) {
                // Filter läuft bereits vom Zeitfenster – nur Heizung reaktivieren
                await adapter.setFeature('heater', true, {fromAutomation: true});
                adapter._pvManagedFeatures.heater = true;
                const tempToSet = await getEffectiveTargetTemp(adapter, w);
                if (tempToSet != null) {
                    adapter.setStray(() => {
                        adapter.sendTargetTempDirect(tempToSet, {fromAutomation: true}).catch(e => adapter.log.error(`PV: target temperature send FAILED – ${e.message}`));
                    }, CONSTANTS.PENDING_TEMP_DELAY_MS);
                }
            }
            // Filter und UVC werden vom Zeitfenster verwaltet
        } catch (err) {
            adapter.log.error(`PV: re-activation FAILED – ${err.message}`);
        }
    }
    adapter.enableRapidPolling();
}

/**
 * Staged deactivation: heater → UVC → filter.
 *
 * Stage 1 (instant)       : heater OFF
 * Stage 2 (after delay)   : UVC OFF (only when daily minimum hours are met)
 * Stage 3 (after delay)   : filter OFF (only when firmware is no longer heating)
 *
 * immediate=true skips inter-stage delays (season-end / manual shutdown).
 *
 * @param {object}  adapter
 * @param {Array}   pvWindows
 * @param {boolean} immediate
 */
async function stagedDeactivate(adapter, pvWindows, immediate = false) {
    // PV verwaltet nur die Heizung. Filter und UVC werden vom Zeitfenster gesteuert.
    // Daher: nur Heizung sofort abschalten, dann checkTimeWindows aufrufen.

    const heatState = () => (adapter._lastData && adapter._lastData.heat_state) || 0;

    // ── Heater OFF (sofort) ───────────────────────────────────────────────────
    if (adapter._pvManagedFeatures.heater) {
        if (heatState() === 4) {
            // Zieltemperatur erreicht → Firmware heizt ohnehin nicht mehr, kein API-Call nötig.
            if (adapter.config.more_log_enabled) {
                adapter.log.info('PV staged shutdown: heater already idle (target temp reached) – skipping API call');
            }
            adapter._pvManagedFeatures.heater = false;
        } else {
            try {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`PV staged shutdown: heater OFF (heat_state=${heatState()})`);
                }
                await adapter.setFeature('heater', false, {fromAutomation: true});
                // Flag NUR löschen wenn das Gerät das Heizung-AUS bestätigt hat
                // (setFeature wirft bei fromAutomation:true, falls nicht bestätigt).
                adapter._pvManagedFeatures.heater = false;
            } catch (err) {
                // Heizung-AUS wurde NICHT bestätigt. _pvManagedFeatures.heater bleibt true
                // und ein begrenzter Retry wird geplant – sonst liefe die Heizung außerhalb
                // des Überschuss-Fensters unbeaufsichtigt weiter (das Filter-AUS des
                // Zeitfensters ist nur ein indirektes Sicherheitsnetz).
                adapter.log.error(`PV staged shutdown: heater OFF FAILED – ${err.message} – scheduling retry`);
                scheduleHeaterOffRetry(adapter);
            }
        }
        adapter.enableRapidPolling();
    }

    adapter._pvStageTimer = null;
    if (adapter.config.more_log_enabled) {
        adapter.log.info('PV staged shutdown: complete – filter/UVC managed by time window');
    }

    // Zeitfenster-Logik aufrufen: entscheidet über Filter-Nachlauf etc.
    adapter.checkTimeWindows().catch(e => adapter.log.error(`PV staged shutdown: checkTimeWindows re-eval failed – ${e.message}`));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Bounded retry for a PV heater-OFF command that the device did not confirm.
 *
 * Runs independently of evaluateSurplus() because that function only acts while
 * _pvActive is true – but after a staged deactivation _pvActive is already false,
 * so a failed heater-OFF would otherwise never be retried. Each attempt re-checks
 * whether the heater is still ON and PV has not become active again before sending.
 *
 * @param {object} adapter
 * @param {number} [attempt]  current attempt number (1-based)
 */
function scheduleHeaterOffRetry(adapter, attempt = 1) {
    const MAX_ATTEMPTS = CONSTANTS.PV_HEATER_OFF_MAX_RETRIES;
    const RETRY_MS = CONSTANTS.PV_HEATER_OFF_RETRY_INTERVAL_MS;
    if (attempt > MAX_ATTEMPTS) {
        adapter.log.warn(`PV staged shutdown: heater OFF still not confirmed after ${MAX_ATTEMPTS} attempts – giving up (time-window filter-OFF remains as fallback)`);
        return;
    }
    adapter.setStray(() => {
        // Nothing to do anymore: another path already cleared ownership.
        if (!adapter._pvManagedFeatures.heater) {
            return;
        }
        // Device already reports heater OFF → command was applied late, just clear the flag.
        if (adapter._lastData && adapter._lastData.heater !== 'on') {
            adapter._pvManagedFeatures.heater = false;
            adapter.log.debug('PV staged shutdown: heater confirmed OFF on retry check – no action needed');
            return;
        }
        // Surplus returned and PV is active again → evaluateSurplus owns the heater now.
        if (adapter._pvActive) {
            adapter.log.debug('PV staged shutdown: PV active again – cancelling heater OFF retry');
            return;
        }
        adapter.setFeature('heater', false, {fromAutomation: true})
            .then(() => {
                adapter._pvManagedFeatures.heater = false;
                adapter.enableRapidPolling();
                adapter.log.info(`PV staged shutdown: heater OFF confirmed on retry (attempt ${attempt}/${MAX_ATTEMPTS})`);
            })
            .catch(err => {
                adapter.log.error(`PV staged shutdown: heater OFF retry ${attempt}/${MAX_ATTEMPTS} FAILED – ${err.message}`);
                scheduleHeaterOffRetry(adapter, attempt + 1);
            });
    }, RETRY_MS);
}

function _pvWindows(adapter) {
    const now = new Date();
    const dayKey = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'][now.getDay()];
    return (adapter.config.timeWindows || []).filter(w => w.active && w.pv_steu && w[dayKey] !== false &&                           // Tag muss aktiv sein
        adapter.isInTimeWindow(w.start, w.end)          // Uhrzeit muss im Fenster liegen
    );
}

/**
 * All configured PV windows regardless of current time – used for deactivation.
 *
 * @param adapter
 */
function _pvWindowsAll(adapter) {
    return (adapter.config.timeWindows || []).filter(w => w.active && w.pv_steu);
}

module.exports = {
    init, onForeignStateChange, evaluateSurplus, cancelAllDeactivationTimers, reactivate, stagedDeactivate,
};
