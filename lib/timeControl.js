'use strict';

/**
 * lib/timeControl.js
 *
 * Time window control logic for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   publishTimeWindowsJson(adapter)    – validates/publishes time windows JSON to state
 *   applyTimeWindowsJson(adapter, js)  – applies time windows JSON config
 *   initTimeControl(adapter)           – sets up the interval timer for checking windows
 *   checkTimeWindows(adapter)          – main loop evaluating time windows
 *   deactivateWindow(adapter, w, i)    – handles window deactivation, feature shutdown, overlap
 *   isInTimeWindow(adapter, start, end)– checks if current time is within a window
 *   isInSeason(adapter)                – checks if current date is within configured season
 *   accumulateFilterHours(adapter)     – filter runtime tracking
 */

const notificationHelper = require('./notificationHelper');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// Publish configured time windows as JSON datapoint
// ---------------------------------------------------------------------------

/**
 * @param {object} adapter
 */
async function publishTimeWindowsJson(adapter) {
    const windows = adapter.config.timeWindows;
    const json = JSON.stringify(Array.isArray(windows) ? windows : [], null, 2);
    adapter.log.debug(`Time windows JSON: ${json}`);
    adapter.setState('status.time_windows_json', {val: json, ack: true});
}

// ---------------------------------------------------------------------------
// Apply time windows JSON
// ---------------------------------------------------------------------------

/**
 * Validates the JSON written to status.time_windows_json, persists it to
 * system.adapter.<name>.<instance>.native.timeWindows and re-initialises
 * time-window and PV control so changes take effect immediately without
 * an adapter restart.
 *
 * @param {object} adapter
 * @param {string} jsonStr – raw JSON string from the state
 */
async function applyTimeWindowsJson(adapter, jsonStr) {
    // ── 1. Parse & validate ──────────────────────────────────────────────
    let parsed;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        adapter.log.error(`time_windows_json: invalid JSON – ${e.message}`);
        // Rollback: write back the current valid value
        await publishTimeWindowsJson(adapter);
        return;
    }
    if (!Array.isArray(parsed)) {
        adapter.log.error('time_windows_json: value must be a JSON array – ignoring');
        await publishTimeWindowsJson(adapter);
        return;
    }

    // ── 2. Persist to system.adapter config (native) ─────────────────────
    try {
        const objId = `system.adapter.${adapter.namespace}`;
        const cfgObj = await adapter.getForeignObjectAsync(objId);
        if (!cfgObj) {
            adapter.log.error(`time_windows_json: could not load ${objId} – config not saved`);
            return;
        }
        cfgObj.native.timeWindows = parsed;
        await adapter.setForeignObjectAsync(objId, cfgObj);
        adapter.log.info(`time_windows_json: ${parsed.length} window(s) saved to adapter config`);
    } catch (e) {
        adapter.log.error(`time_windows_json: failed to save adapter config – ${e.message}`);
        return;
    }

    // ── 3. Update runtime config so changes take effect immediately ──────
    adapter.config.timeWindows = parsed;

    // ── 4. Ack the state with the normalised JSON ─────────────────────────
    adapter.setState('status.time_windows_json', {val: JSON.stringify(parsed, null, 2), ack: true});

    // ── 5. Re-initialise schedulers ──────────────────────────────────────
    // Stop existing timers
    if (adapter._timeTimer) {
        clearInterval(adapter._timeTimer);
        adapter._timeTimer = null;
    }
    if (adapter._timeAlignTimer) {
        clearTimeout(adapter._timeAlignTimer);
        adapter._timeAlignTimer = null;
    }
    adapter._timeWindowActive = [];
    // Cancel any running PV deactivation
    await adapter.pvCancelAllDeactivationTimers();
    // Re-init both controllers with the new windows
    initTimeControl(adapter);
    await adapter.initPvControl();
    adapter.log.info('time_windows_json: schedulers restarted with updated time windows');
}

// ---------------------------------------------------------------------------
// Time Window Control
// ---------------------------------------------------------------------------

/**
 * @param {object} adapter
 */
function initTimeControl(adapter) {
    const windows = adapter.config.timeWindows;
    if (!Array.isArray(windows) || windows.length === 0 || !windows.some(w => w.active)) {
        adapter.log.debug('Time control: no active time windows configured – skipping');
        return;
    }
    const cfg = adapter.config;
    if (adapter._seasonEnabled) {
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`Time control: season control active (${cfg.season_start} – ${cfg.season_end}), today inSeason=${isInSeason(adapter)}`);
        }
    }
    // init tracking array to match current window count
    adapter._timeWindowActive = windows.map(() => false);
    if (adapter.config.more_log_enabled) {
        adapter.log.info(`Time control: starting scheduler for ${windows.filter(w => w.active).length} active window(s) (checks every 60 s)`);
    }

    // run immediately, then every 60 s aligned to next full minute
    checkTimeWindows(adapter).catch(e => adapter.log.error(`checkTimeWindows: ${e.message}`));
    const now = new Date();
    const msToMin = (60 - now.getSeconds()) * CONSTANTS.MS_PER_SECOND - now.getMilliseconds();
    if (adapter._timeAlignTimer) {
        clearTimeout(adapter._timeAlignTimer);
    }
    adapter._timeAlignTimer = setTimeout(() => {
        adapter._timeAlignTimer = null;
        // Guard: clear any stale interval that may exist (defensive)
        if (adapter._timeTimer) {
            clearInterval(adapter._timeTimer);
            adapter._timeTimer = null;
        }
        checkTimeWindows(adapter).catch(e => adapter.log.error(`checkTimeWindows: ${e.message}`));
        adapter._timeTimer = setInterval(() => checkTimeWindows(adapter).catch(e => adapter.log.error(`checkTimeWindows: ${e.message}`)), CONSTANTS.TIME_WINDOW_CHECK_INTERVAL_MS);
    }, msToMin);
}

/**
 * @param {object} adapter
 */
async function checkTimeWindows(adapter) {
    const windows = adapter.config.timeWindows;
    if (!Array.isArray(windows)) {
        return;
    }

    // --- Device offline guard -------------------------------------------
    if (adapter._lastData?.is_online === false) {
        if (!adapter._pvOfflineNotified) {
            await notificationHelper.send(notificationHelper.format('deviceOffline'));
            adapter._pvOfflineNotified = true;
            adapter.log.warn('TimeControl: Device offline, all automation paused');
        }
        return;
    }
    // Reset the flag when device comes back online
    if (adapter._pvOfflineNotified) {
        adapter._pvOfflineNotified = false;
        adapter.log.info('TimeControl: Device back online, automation resumed');
    }

    // --- Manual override guard -----------------------------------------
    if (adapter._manualOverride) {
        adapter.log.debug('Time control: manual override active – skipping time window control');
        return;
    }
    // --- PV guard -------------------------------------------------------
    // PV surplus control is handled per window (pv_steu flag).
    // Windows with pv_steu=true: time scheduler marks them active but does NOT
    // send hardware commands – evaluateSurplus() in pv.js activates them when
    // there is enough surplus.
    // Windows with pv_steu=false: always activate/deactivate independently,
    // regardless of whether PV is running or not.
    // --- Season guard ---------------------------------------------------
    if (!isInSeason(adapter)) {
        adapter.log.debug('Time control: outside season – skipping time window control (polling continues)');
        // deactivate any windows that were still active
        for (let i = 0; i < windows.length; i++) {
            if (adapter._timeWindowActive[i]) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`Time control [${i + 1}]: season ended – deactivating window`);
                }
                // Do NOT pre-set _timeWindowActive[i]=false here –
                // deactivateWindow sets it at the end. If it fails (API error),
                // _timeWindowActive[i] stays true so next minute triggers a retry.
                await deactivateWindow(adapter, windows[i], i);
                if (!adapter._timeWindowActive[i]) {
                    // deactivation succeeded
                    await notificationHelper.send(notificationHelper.format('timeWindowSeasonEnded', {window: i + 1}));
                }
            }
        }
        return;
    }
    // --------------------------------------------------------------------

    const now = new Date();
    const day = now.getDay(); // 0=Sun … 6=Sat
    const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];

    // ensure tracking array is large enough
    while (adapter._timeWindowActive.length < windows.length) {
        adapter._timeWindowActive.push(false);
    }

    for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        if (!w.active) {
            // active=false means the window is disabled entirely.
            // If it was running when disabled, deactivate hardware now.
            if (adapter._timeWindowActive[i]) {
                adapter.log.info(`Time control [${i + 1}]: window disabled while active – deactivating`);
                await deactivateWindow(adapter, w, i);
                if (!adapter._timeWindowActive[i]) {
                    await notificationHelper.send(notificationHelper.format('timeWindowEnded', {
                        window: i + 1, start: w.start || '00:00', end: w.end || '00:00'
                    })).catch(e => adapter.log.error(`timeWindowEnded notification: ${e.message}`));
                }
            }
            continue;
        }

        const start = w.start || '00:00';
        const end = w.end || '00:00';

        // Overnight windows (e.g. 22:00–06:00): the "after-midnight" portion
        // belongs to the day the window STARTED (yesterday). So if cur < end
        // we must check yesterday's day flag, not today's.
        const toMin = (hhmm) => {
            const [h, m] = hhmm.split(':').map(Number);
            return h * 60 + m;
        };
        const sMin = toMin(start);
        const eMin = toMin(end);
        const curMin = now.getHours() * 60 + now.getMinutes();
        const isOvernightAfterMidnight = sMin > eMin && eMin > 0 && curMin < eMin;
        const effectiveDay = isOvernightAfterMidnight ? (day + 6) % 7 : day;
        const dayOn = !!w[dayKeys[effectiveDay]];
        const inWin = dayOn && isInTimeWindow(adapter, start, end);
        const wasIn = adapter._timeWindowActive[i];

        adapter.log.debug(`Time control [${i + 1}]: inWindow=${inWin}, wasActive=${wasIn}, day=${dayKeys[day]}, ${start}–${end}`);

        if (inWin && !wasIn) {
            try {
                // ── "All OFF" window: action_filter=false + action_heating=false + action_uvc=false
                // → actively shut down everything that is currently running
                if (!w.action_filter && !w.action_heating && !w.action_uvc) {
                    adapter.log.info(`Time control [${i + 1}]: ALL-OFF window – shutting down heater, UVC, filter`);
                    await adapter.setFeature('heater', false, {fromAutomation: true}).catch(() => {
                    });
                    await adapter.setFeature('uvc', false, {fromAutomation: true}).catch(() => {
                    });
                    await adapter.setFeature('filter', false, {fromAutomation: true}).catch(() => {
                    });
                    adapter.enableRapidPolling();
                } else {
                    // ── Filter startet IMMER wenn ein Zeitfenster öffnet (unabhängig von PV).
                    // PV-Steuerung betrifft nur die Heizung.
                    adapter.log.debug(`Time control [${i + 1}]: filter ON (window start)`);
                    await adapter.setFeature('filter', true, {fromAutomation: true});

                    if (w.pv_steu) {
                        // Heizung wird vom PV-Controller gesteuert – evaluatePvSurplus entscheidet
                        adapter.log.debug(`Time control [${i + 1}]: pv_steu=true – heater managed by PV surplus, triggering evaluation`);
                        adapter.evaluatePvSurplus().catch(e => adapter.log.error(`Time control [${i + 1}]: evaluatePvSurplus on window start failed – ${e.message}`));
                    } else if (w.action_heating) {
                        // Heizung direkt starten (kein PV-Überschuss benötigt)
                        adapter.log.debug(`Time control [${i + 1}]: heater ON`);
                        await adapter.setFeature('heater', true, {fromAutomation: true});
                        if (w.target_temp) {
                            // Prefer current user-set temperature over window config
                            // (consistent with PV getEffectiveTargetTemp logic)
                            adapter.getStateAsync('control.target_temperature').then(st => {
                                const effectiveTemp = (st && st.val != null && Number(st.val) > 0) ? Number(st.val) : w.target_temp;
                                if (adapter.config.more_log_enabled) {
                                    adapter.log.info(`Time control [${i + 1}]: target temperature → ${effectiveTemp}°C${effectiveTemp !== w.target_temp ? ` (user-set, window=${w.target_temp}°C)` : ''} – sending in 10 s`);
                                }
                                adapter.setStray(() => {
                                    adapter.sendTargetTempDirect(effectiveTemp ?? 0, {fromAutomation: true}).catch(e => adapter.log.error(`Time control [${i + 1}]: target temperature send FAILED – ${e.message}`));
                                }, CONSTANTS.PENDING_TEMP_DELAY_MS);
                            }).catch(() => {
                                adapter.setStray(() => {
                                    adapter.sendTargetTempDirect(w.target_temp ?? 0, {fromAutomation: true}).catch(e => adapter.log.error(`Time control [${i + 1}]: target temperature send FAILED – ${e.message}`));
                                }, CONSTANTS.PENDING_TEMP_DELAY_MS);
                            });
                        }
                    }

                    if (w.action_uvc) {
                        // UVC sofort mit Filter starten (action_uvc=true)
                        // action_uvc=false → UVC-Ensure-Logik übernimmt (min. Stunden/Tag ab Startzeit)
                        adapter.log.debug(`Time control [${i + 1}]: UVC ON (with filter, window start)`);
                        await adapter.setFeature('uvc', true, {fromAutomation: true});
                    }
                    adapter.enableRapidPolling();
                }
                // Notification NUR nach erfolgreicher Aktivierung
                adapter._timeWindowActive[i] = true;
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`Time control [${i + 1}]: window START (${start}–${end}) – activating`);
                }
                await notificationHelper.send(notificationHelper.format('timeWindowStarted', {
                    window: i + 1, start, end
                })).catch(e => adapter.log.error(`timeWindowStarted notification: ${e.message}`));
            } catch (err) {
                // _timeWindowActive[i] bleibt false – retry next minute
                adapter.log.error(`Time control [${i + 1}]: activation FAILED – ${err.message}`);
                adapter.log.debug(`Time control [${i + 1}]: ${err.stack}`);
            }

        } else if (!inWin && wasIn) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`Time control [${i + 1}]: window END (${start}–${end}) – deactivating`);
            }
            await deactivateWindow(adapter, w, i);
            // Notification NUR nach erfolgreicher Deaktivierung (deactivateWindow rollt _timeWindowActive[i] im Fehlerfall zurück)
            if (!adapter._timeWindowActive[i]) {
                await notificationHelper.send(notificationHelper.format('timeWindowEnded', {
                    window: i + 1, start, end
                })).catch(e => adapter.log.error(`timeWindowEnded notification: ${e.message}`));
            }
        }
    }
}

/**
 * @param {object} adapter
 * @param {object} w
 * @param {number} i
 */
async function deactivateWindow(adapter, w, i) {
    // PV-Steuerung betrifft nur die Heizung.
    // Wenn pv_steu=true und PV aktiv: PV schaltet Heizung ab (evaluatePvSurplus).
    // Der Filter wird IMMER vom Zeitfenster verwaltet – hier normal abschalten.
    const pvHandlesHeater = w.pv_steu && (adapter._pvActive || adapter._pvStageTimer !== null);
    if (pvHandlesHeater) {
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`Time control [${i + 1}]: window END – pv_steu, PV handles heater – filter managed by time window`);
        }
        // PV erkennt Fenster-Ende über isInTimeWindow() (gibt jetzt false zurück).
        // evaluatePvSurplus aufrufen damit Heizung sofort abgeschaltet wird.
        // _timeWindowActive[i] wird ERST am Ende des try-Blocks auf false gesetzt
        // damit der Retry-Mechanismus (catch → stays true) auch für filter OFF greift.
        adapter.evaluatePvSurplus().catch(e => adapter.log.error(`Time control [${i + 1}]: evaluatePvSurplus after window end failed – ${e.message}`));
        // Fall through to handle filter in the try block below
    }

    // ── Overlap guard ───────────────────────────────────────────────────
    // Before turning off any feature, check whether ANOTHER window that is
    // still active (index != i, _timeWindowActive[j]=true) also uses that
    // feature. If so, do NOT turn it off – it must keep running for that window.
    const windows = adapter.config.timeWindows;
    const otherNeedsFilter = Array.isArray(windows) && windows.some((win, j) => j !== i && adapter._timeWindowActive[j] && win.active && (win.action_filter || win.action_heating || (win.action_uvc && !!adapter._filterStartedForUvc[j])));
    const otherNeedsHeater = Array.isArray(windows) && windows.some((win, j) => j !== i && adapter._timeWindowActive[j] && win.active && win.action_heating);
    const otherNeedsUvc = Array.isArray(windows) && windows.some((win, j) => j !== i && adapter._timeWindowActive[j] && win.active && win.action_uvc);

    if (otherNeedsFilter || otherNeedsHeater || otherNeedsUvc) {
        adapter.log.debug(`Time control [${i + 1}]: window END – overlapping window active (filter=${otherNeedsFilter}, heater=${otherNeedsHeater}, uvc=${otherNeedsUvc}) – individual feature guards apply`);
    }
    // ────────────────────────────────────────────────────────────────────

    // Cancel any existing follow-up timer for this window
    if (adapter._pumpFollowUpTimers[i]) {
        clearTimeout(adapter._pumpFollowUpTimers[i]);
        adapter._pumpFollowUpTimers[i] = null;
    }

    const followUpMin = Number(adapter.config.pump_follow_up) || 0;
    const cfg = adapter.config;
    const uvcMinH = cfg.uvc_daily_min_h ?? 2;
    const todayH = adapter.getUvcTodayHours();
    const uvcMinMet = todayH >= uvcMinH;


    try {
        // Heater OFF: nur wenn PV es nicht steuert UND kein anderes Fenster den Heizer braucht.
        // Zusätzlich: pv_steu=true aber PV inzwischen inaktiv → Heizer wurde durch PV gestartet
        // und muss beim Fenster-Ende durch das Zeitfenster gestoppt werden.
        const windowStartedHeater = w.action_heating || w.pv_steu;
        if (!pvHandlesHeater && windowStartedHeater && !otherNeedsHeater) {
            adapter.log.debug(`Time control [${i + 1}]: heater OFF`);
            await adapter.setFeature('heater', false, {fromAutomation: true});
        } else if (!pvHandlesHeater && windowStartedHeater && otherNeedsHeater) {
            adapter.log.debug(`Time control [${i + 1}]: heater kept ON – required by overlapping window`);
        }

        // UVC off – but only if daily minimum is already reached AND no other window needs it.
        if (w.action_uvc && !otherNeedsUvc) {
            if (uvcMinMet) {
                adapter.log.debug(`Time control [${i + 1}]: UVC OFF (daily minimum met: ${todayH.toFixed(2)} h >= ${uvcMinH} h)`);
                await adapter.setFeature('uvc', false, {fromAutomation: true});
            } else {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`Time control [${i + 1}]: UVC kept ON – daily minimum not yet met (${todayH.toFixed(2)} h of ${uvcMinH} h), daily ensure will take over`);
                }
                // Filter stays ON for UVC – daily ensure takes ownership (checks _timeWindowActive next minute)
                adapter._timeWindowActive[i] = false;
                adapter._filterStartedForUvc[i] = false; // ensure takes over ownership
                adapter.enableRapidPolling();
                return;
            }
        } else if (w.action_uvc && otherNeedsUvc) {
            adapter.log.debug(`Time control [${i + 1}]: UVC kept ON – required by overlapping window`);
        }

        // Filter pump: only stop if no other window needs it
        if (otherNeedsFilter) {
            adapter.log.debug(`Time control [${i + 1}]: filter kept ON – required by overlapping window`);
            adapter._timeWindowActive[i] = false;
            adapter._filterStartedForUvc[i] = false;
            adapter.enableRapidPolling();
            return;
        }

        // Filter wird IMMER von diesem Fenster verwaltet (außer ALL-OFF)
        const isAllOffWindow = !w.action_filter && !w.action_heating && !w.action_uvc;
        const needsFilterStop = !isAllOffWindow;

        // Filter pump: immediate or delayed?
        const stopPumpNow = !followUpMin || followUpMin <= 0;

        if (stopPumpNow) {
            if (needsFilterStop) {
                adapter.log.debug(`Time control [${i + 1}]: filter OFF`);
                await adapter.setFeature('filter', false, {fromAutomation: true});
                adapter._filterStartedForUvc[i] = false;
            }
        } else {
            if (needsFilterStop) {
                // Follow-up active – pump keeps running for followUpMin minutes
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`Time control [${i + 1}]: filter pump FOLLOW-UP for ${followUpMin} min`);
                }
                adapter._pumpFollowUpTimers[i] = setTimeout(() => {
                    if (adapter._unloading) {
                        return;
                    }
                    adapter._pumpFollowUpTimers[i] = null;
                    // Re-check at the time the follow-up fires whether any automation
                    // still needs the filter running.
                    const stillNeededByWindow = Array.isArray(adapter.config.timeWindows) && adapter.config.timeWindows.some((win, j) => j !== i && adapter._timeWindowActive[j] && win.active && (win.action_filter || win.action_heating || win.action_uvc));
                    const stillNeededByEnsure = adapter._uvcEnsureActive && adapter._uvcEnsureFilterStart;
                    const stillNeededByFrost = adapter._winterFrostActive;
                    const stillNeeded = stillNeededByWindow || stillNeededByEnsure || stillNeededByFrost;
                    if (stillNeeded) {
                        adapter.log.debug(`Time control [${i + 1}]: follow-up elapsed but filter still needed (window=${stillNeededByWindow}, ensure=${stillNeededByEnsure}, frost=${stillNeededByFrost}) – skipping filter OFF`);
                        return;
                    }
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info(`Time control [${i + 1}]: follow-up time elapsed – filter OFF`);
                    }
                    adapter.setFeature('filter', false, {fromAutomation: true})
                        .then(() => {
                            adapter._filterStartedForUvc[i] = false;
                            adapter.enableRapidPolling();
                        })
                        .catch(err => adapter.log.error(`Time control [${i + 1}]: follow-up filter OFF FAILED – ${err.message}`));
                }, Math.round(followUpMin * CONSTANTS.MS_PER_MINUTE));
            }
        }

        // Deactivation completed successfully – mark window as inactive
        adapter._timeWindowActive[i] = false;
        adapter.enableRapidPolling();
    } catch (err) {
        // _timeWindowActive[i] remains true – retry next minute
        adapter.log.error(`Time control [${i + 1}]: deactivation FAILED – ${err.message}`);
        adapter.log.debug(`Time control [${i + 1}]: ${err.stack}`);
    }
}

// ---------------------------------------------------------------------------
// Season check
// ---------------------------------------------------------------------------

/**
 * Returns true if today is within the configured season window (DD.MM – DD.MM).
 * If season_enabled is false, always returns false – all automatic controls
 * (time windows, PV surplus) are blocked. Only winter mode (frost protection)
 * is allowed when season_enabled = false and winter_mode = true.
 * Supports seasons spanning the year boundary (e.g. 01.10 – 31.03).
 *
 * @param {object} adapter
 */
function isInSeason(adapter) {
    const cfg = adapter.config;
    if (!adapter._seasonEnabled) {
        adapter.log.debug('Season check: season_enabled=false ? automatic controls blocked (only winter mode allowed)');
        return false;
    }

    const parseDate = (ddmm) => {
        const parts = (ddmm || '').split('.');
        return {day: parseInt(parts[0], 10) || 1, month: parseInt(parts[1], 10) || 1};
    };

    const now = new Date();
    const today = now.getDate();
    const month = now.getMonth() + 1; // 1-based

    const start = parseDate(cfg.season_start || '01.01');
    const end = parseDate(cfg.season_end || '31.12');

    // convert to a simple comparable number MMDD
    const toNum = (d) => d.month * 100 + d.day;
    const cur = month * 100 + today;
    const s = toNum(start);
    const e = toNum(end);

    let inSeason;
    if (s <= e) {
        // normal range (e.g. 01.05 – 30.09)
        inSeason = cur >= s && cur <= e;
    } else {
        // year-spanning range (e.g. 01.10 – 31.03)
        inSeason = cur >= s || cur <= e;
    }

    adapter.log.debug(`Season check: today=${today}.${month} (${cur}), season=${cfg.season_start}–${cfg.season_end} (${s}–${e}), inSeason=${inSeason}`);
    return inSeason;
}

// ---------------------------------------------------------------------------
// Time window check
// ---------------------------------------------------------------------------

/**
 * Returns true if current local time is within [start, end) (HH:MM strings).
 * Supports overnight windows e.g. "22:00"–"06:00".
 *
 * @param {object} adapter (unused, kept for consistent signature)
 * @param {string} start
 * @param {string} end
 */
function isInTimeWindow(adapter, start, end) {
    const now = new Date();
    const toMin = (hhmm) => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
    };
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = toMin(start);
    const e = toMin(end);
    if (s === e) {
        return false;
    }  // empty window
    if (s < e) {
        return cur >= s && cur < e;
    }
    return cur >= s || cur < e;     // overnight
}

// ---------------------------------------------------------------------------
// Filter pump runtime – helper
// ---------------------------------------------------------------------------

/**
 * Returns total accumulated filter runtime hours including the currently running
 * session (if filter is ON right now). Does NOT mutate this._filterHoursUsed.
 *
 * @param {object} adapter
 */
function accumulateFilterHours(adapter) {
    let total = adapter._filterHoursUsed || 0;
    if (adapter._filterOnSince !== null) {
        total += (Date.now() - adapter._filterOnSince) / CONSTANTS.MS_PER_HOUR;
    }
    return total;
}

module.exports = {
    publishTimeWindowsJson,
    applyTimeWindowsJson,
    initTimeControl,
    checkTimeWindows,
    deactivateWindow,
    isInTimeWindow,
    isInSeason,
    accumulateFilterHours,
};
