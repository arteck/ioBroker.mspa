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

const consumptionHelper = require('./consumptionHelper');
const notificationHelper = require('./notificationHelper');

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
 * Also forwards to consumptionHelper for energy tracking.
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

    // Consumption tracking always runs, independent of PV and season
    await consumptionHelper.handleStateChange(id, state);

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

    const threshold = cfg.pv_threshold_w || 500;
    const hysteresis = Math.min(cfg.pv_hysteresis_w || 100, threshold);
    const offAt = threshold - hysteresis;

    adapter.log.debug(`PV: surplus=${surplus} W [${surplusMode}] | threshold=${threshold} W | offAt=${offAt} W | pvActive=${adapter._pvActive} | managed=${JSON.stringify(adapter._pvManagedFeatures)}`);

    const shouldActivate   = surplus >= threshold;
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
                adapter.log.info(`PV: surplus DETECTED (${surplus} W ≥ ${threshold} W) – activating`);
            }
            await notificationHelper.send(notificationHelper.format('pvActivated', {surplus}));
            for (const w of pvWindows) {
                try {
                    if (w.action_heating) {
                        if (!w.action_filter) {
                            await adapter.setFeature('filter', true);
                            adapter._pvManagedFeatures.filter = true;
                        }
                        await adapter.setFeature('heater', true);
                        adapter._pvManagedFeatures.heater = true;
                        const tempToSet = await getEffectiveTargetTemp(adapter, w);
                        if (tempToSet != null) {
                            adapter.setStray(() => {
                                adapter.sendTargetTempDirect(tempToSet).catch(e =>
                                    adapter.log.error(`PV: target temperature send FAILED – ${e.message}`)
                                );
                            }, 10_000);
                        }
                    }
                    if (w.action_filter) {
                        await adapter.setFeature('filter', true);
                        adapter._pvManagedFeatures.filter = true;
                        if (w.action_uvc) {
                            await adapter.setFeature('uvc', true);
                            adapter._pvManagedFeatures.uvc = true;
                        }
                    }
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
        const debounceMs = delayMin * 60_000;
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
                const elapsedMin = Math.floor((Date.now() - startedAt) / 60_000);
                const remaining = Math.max(0, delayMin - elapsedMin);
                adapter._pvDeactivateCountdown = remaining;
                adapter.setState('computed.pv_deactivate_remaining', remaining, true);
            }, 60_000);
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
        adapter.log.info(`PV: surplus recovered during staging (${surplus} W) – re-activating managed features`);
    }
    for (const w of pvWindows) {
        try {
            if (w.action_heating && !adapter._pvManagedFeatures.heater) {
                if (!w.action_filter && !adapter._pvManagedFeatures.filter) {
                    await adapter.setFeature('filter', true);
                    adapter._pvManagedFeatures.filter = true;
                }
                await adapter.setFeature('heater', true);
                adapter._pvManagedFeatures.heater = true;
                const tempToSet = await getEffectiveTargetTemp(adapter, w);
                if (tempToSet != null) {
                    adapter.setStray(() => {
                        adapter.sendTargetTempDirect(tempToSet).catch(e =>
                            adapter.log.error(`PV: target temperature send FAILED – ${e.message}`)
                        );
                    }, 10_000);
                }
            }
            if (w.action_uvc && !adapter._pvManagedFeatures.uvc && adapter._pvManagedFeatures.filter) {
                await adapter.setFeature('uvc', true);
                adapter._pvManagedFeatures.uvc = true;
            }
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
    const cfg = adapter.config;
    const stageDelayMs = immediate ? 0 : (cfg.pv_stage_delay_min ?? 2) * 60_000;
    const uvcMinH = cfg.uvc_daily_min_h ?? 2;

    const heatState = () => (adapter._lastData && adapter._lastData.heat_state) || 0;
    const firmwareActivelyHeating = () => [2, 3].includes(heatState());

    // ── Stage 1: Heater OFF (instant) ────────────────────────────────────────
    if (adapter._pvManagedFeatures.heater) {
        if (heatState() === 4) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('PV staged shutdown [1/3]: heater already idle (target temp reached by firmware) – skipping API call');
            }
        } else {
            try {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`PV staged shutdown [1/3]: heater OFF (heat_state=${heatState()})`);
                }
                await adapter.setFeature('heater', false);
            } catch (err) {
                adapter.log.error(`PV staged shutdown [1/3]: heater OFF FAILED – ${err.message}`);
            }
        }
        adapter._pvManagedFeatures.heater = false;
        adapter.enableRapidPolling();
    }

    // Heating-only filter (action_filter=false, UVC off) → stop immediately unless firmware heating
    const anyFilterUvcManaged = pvWindows.some(w => w.action_filter);
    if (!anyFilterUvcManaged && !adapter._pvManagedFeatures.uvc) {
        if (adapter._pvManagedFeatures.filter) {
            if (firmwareActivelyHeating()) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`PV staged shutdown [1/3]: filter kept ON – firmware actively heating (heat_state=${heatState()}), will re-check`);
                }
                adapter._pvStageTimer = setTimeout(async () => {
                    adapter._pvStageTimer = null;
                    if (firmwareActivelyHeating()) {
                        if (adapter.config.more_log_enabled) {
                            adapter.log.info(`PV staged shutdown: firmware still heating (heat_state=${heatState()}) – filter stays on for now`);
                        }
                    } else {
                        try {
                            await adapter.setFeature('filter', false);
                            adapter._pvManagedFeatures.filter = false;
                        } catch (_) { /* ignore */
                        }
                    }
                    adapter.enableRapidPolling();
                }, stageDelayMs || 120_000);
                return;
            }
            try {
                await adapter.setFeature('filter', false);
                adapter._pvManagedFeatures.filter = false;
            } catch (_) { /* ignore */
            }
            adapter.log.debug('PV staged shutdown: heating-only filter OFF');
        }
        adapter.enableRapidPolling();
        return;
    }

    // ── Stage 2: UVC OFF (after delay, if daily minimum reached) ─────────────
    const runStage2 = async () => {
        if (adapter._pvManagedFeatures.uvc) {
            const todayH = adapter.getUvcTodayHours();
            if (todayH >= uvcMinH || immediate) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`PV staged shutdown [2/3]: UVC OFF (today ${todayH.toFixed(2)} h ≥ min ${uvcMinH} h)`);
                }
                try {
                    await adapter.setFeature('uvc', false);
                    adapter._pvManagedFeatures.uvc = false;
                } catch (err) {
                    adapter.log.error(`PV staged shutdown [2/3]: UVC OFF FAILED – ${err.message}`);
                }
            } else {
                const remaining = (uvcMinH - todayH).toFixed(2);
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`PV staged shutdown [2/3]: UVC kept ON (today ${todayH.toFixed(2)} h, need ${uvcMinH} h, ${remaining} h remaining) – re-checking in ${cfg.pv_stage_delay_min ?? 2} min`);
                }
                adapter._pvStageTimer = setTimeout(runStage2, stageDelayMs || 120_000);
                return; // don't proceed to stage 3 yet
            }
        }

        // ── Stage 3: Filter OFF ──────────────────────────────────────────────
        const runStage3 = async () => {
            if (adapter._pvManagedFeatures.uvc) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info('PV staged shutdown [3/3]: UVC OFF (forced before filter stop)');
                }
                try {
                    await adapter.setFeature('uvc', false);
                    adapter._pvManagedFeatures.uvc = false;
                } catch (err) {
                    adapter.log.error(`PV staged shutdown [3/3]: UVC OFF FAILED – ${err.message}`);
                }
            }
            if (adapter._pvManagedFeatures.filter) {
                if (!immediate && firmwareActivelyHeating()) {
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info(`PV staged shutdown [3/3]: filter kept ON – firmware actively heating (heat_state=${heatState()}), will re-check in ${cfg.pv_stage_delay_min ?? 2} min`);
                    }
                    adapter._pvStageTimer = setTimeout(runStage3, stageDelayMs || 120_000);
                    return;
                }
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`PV staged shutdown [3/3]: filter OFF (heat_state=${heatState()})`);
                }
                try {
                    await adapter.setFeature('filter', false);
                    adapter._pvManagedFeatures.filter = false;
                } catch (err) {
                    adapter.log.error(`PV staged shutdown [3/3]: filter OFF FAILED – ${err.message}`);
                }
            }
            adapter._pvStageTimer = null;
            if (adapter.config.more_log_enabled) {
                adapter.log.info('PV staged shutdown: complete');
            }
            adapter.enableRapidPolling();
        };

        if (immediate || stageDelayMs === 0) {
            await runStage3();
        } else {
            adapter._pvStageTimer = setTimeout(runStage3, stageDelayMs);
        }
    };

    if (immediate || stageDelayMs === 0) {
        await runStage2();
    } else {
        adapter._pvStageTimer = setTimeout(runStage2, stageDelayMs);
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function _pvWindows(adapter) {
    const now    = new Date();
    const dayKey = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'][now.getDay()];
    return (adapter.config.timeWindows || []).filter(w =>
        w.active &&
        w.pv_steu &&
        w[dayKey] !== false &&                           // Tag muss aktiv sein
        adapter.isInTimeWindow(w.start, w.end)          // Uhrzeit muss im Fenster liegen
    );
}

/** All configured PV windows regardless of current time – used for deactivation. */
function _pvWindowsAll(adapter) {
    return (adapter.config.timeWindows || []).filter(w => w.active && w.pv_steu);
}

module.exports = {
    init,
    onForeignStateChange,
    evaluateSurplus,
    cancelAllDeactivationTimers,
    reactivate,
    stagedDeactivate,
};
