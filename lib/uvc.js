'use strict';

/**
 * lib/uvc.js
 *
 * UVC lamp operating hours tracking and daily-minimum ensure logic
 * for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   accumulateHours(adapter)       – total hours including current session (read-only)
 *   getTodayHours(adapter)         – hours accumulated today (resets at midnight)
 *   computeExpiry(adapter)         – write uvc_hours_remaining state
 *   initDailyEnsure(adapter)       – start 1-min scheduler for daily minimum
 *   checkDailyMinimum(adapter)     – check and start/stop ensure run
 *   stopEnsure(adapter)            – stop ensure run, turn off UVC (and filter)
 */

const notificationHelper = require('./notificationHelper');

// Reset uvc_today_hours once per day at this hour (0–23).
// UVC does not run at night → counter is reset at 01:00 so the daily counter
// starts fresh for the new day.  The ensure-run is designed to finish before
// 22:00 (UVC_DAILY_STOP_HOUR) so no UVC session overlaps with the reset.
const UVC_DAILY_RESET_HOUR = 1;

// Hard stop for the ensure run: UVC must be OFF before this hour.
// Prevents the ensure run from running at night before the nightly reset.
const UVC_DAILY_STOP_HOUR = 22;

// ---------------------------------------------------------------------------
// Hours tracking
// ---------------------------------------------------------------------------

/**
 * Returns total accumulated UVC hours INCLUDING the currently running session.
 * Does NOT mutate adapter state.
 *
 * @param {object} adapter
 * @returns {number}
 */
function accumulateHours(adapter) {
    let total = adapter._uvcHoursUsed || 0;
    if (adapter._uvcOnSince !== null) {
        total += (Date.now() - adapter._uvcOnSince) / (1000 * 3600);
    }
    return total;
}

/**
 * Returns UVC hours accumulated today.
 * The daily counter is reset at 23:00 by checkDailyMinimum().
 *
 * @param {object} adapter
 * @returns {number}
 */
function getTodayHours(adapter) {
    return Math.max(0, accumulateHours(adapter) - adapter._uvcDayStartHours);
}

// ---------------------------------------------------------------------------
// Expiry calculation
// ---------------------------------------------------------------------------

/**
 * Calculates and writes the remaining UVC lamp operating hours.
 *
 * Config used:
 *   uvc_install_date     (DD.MM.YYYY) – date the lamp was installed / last reset
 *   uvc_operating_hours  (number)     – rated lifetime in operating hours (default 8 000)
 *
 * @param {object} adapter
 */
async function computeExpiry(adapter) {
    const cfg = adapter.config;
    const raw = (cfg.uvc_install_date || '').trim();
    if (!raw) {
        adapter.log.debug('UVC: no installation date configured – skipping remaining-hours calculation');
        adapter.setState('status.uvc_hours_remaining', { val: 0, ack: true });
        return;
    }

    const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) {
        adapter.log.warn(`UVC: invalid installation date format "${raw}" – expected DD.MM.YYYY`);
        return;
    }

    const [, dd, mm, yyyy] = match;
    // Validate the date (installDate used only for plausibility check – not in the calculation)
    const installDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (isNaN(installDate.getTime())) {
        adapter.log.warn(`UVC: installation date "${raw}" could not be parsed`);
        return;
    }
    // Note: remainHours is based on adapter-tracked hours (_uvcHoursUsed), not
    // calendar time since installDate.  Reset _uvcHoursUsed to 0 when replacing the lamp.

    const ratedHours  = cfg.uvc_operating_hours || 8000;
    const usedHours   = accumulateHours(adapter);
    const remainHours = Math.max(0, ratedHours - usedHours);

    await adapter.setStateChangedAsync('status.uvc_hours_remaining', Math.round(remainHours * 100) / 100, true);

    if (remainHours <= 0) {
        adapter.log.warn(`UVC: lamp lifetime exhausted! ${usedHours.toFixed(0)} h used of ${ratedHours} h rated – please replace!`);
        await notificationHelper.send(notificationHelper.format('uvcExpired', { usedHours: usedHours.toFixed(0) }));
    } else if (adapter.config.more_log_enabled) {
        adapter.log.info(`UVC: ${usedHours.toFixed(1)} h used, ${remainHours.toFixed(0)} h remaining of ${ratedHours} h rated`);
    }
}

// ---------------------------------------------------------------------------
// Daily minimum ensure
// ---------------------------------------------------------------------------

/**
 * Starts a 1-minute interval that ensures the UVC lamp runs for at least
 * uvc_daily_min_h hours per calendar day.
 *
 * Runs independently of PV surplus, time windows and season.
 * Manual override pauses the ensure-run.
 *
 * @param {object} adapter
 */
function initDailyEnsure(adapter) {
    const cfg  = adapter.config;
    const minH = cfg.uvc_daily_min_h ?? 2;
    const ensureTime = cfg.uvc_daily_ensure_time || '10:00';

    if (!minH || minH <= 0) {
        adapter.log.debug(`UVC daily ensure: disabled (uvc_daily_min_h = 0) – timer still runs for ${String(UVC_DAILY_RESET_HOUR).padStart(2,'0')}:00 daily reset`);
    } else if (adapter.config.more_log_enabled) {
        adapter.log.info(`UVC daily ensure: active – minimum ${minH} h/day, starts checking from ${ensureTime}`);
    }

    // Always start the 1-min timer – needed for the 23:00 daily reset even when ensure is disabled
    checkDailyMinimum(adapter).catch(e => adapter.log.error(`checkUvcDailyMinimum: ${e.message}`));
    const now     = new Date();
    const msToMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    adapter.setStray(() => {
        checkDailyMinimum(adapter).catch(e => adapter.log.error(`checkUvcDailyMinimum: ${e.message}`));
        adapter._uvcEnsureTimer = setInterval(
            () => checkDailyMinimum(adapter).catch(e => adapter.log.error(`checkUvcDailyMinimum: ${e.message}`)),
            60_000,
        );
    }, msToMin);
}

/**
 * Called every minute by the ensure scheduler.
 * Resets uvc_today_hours at 23:00, then starts / stops the ensure run as needed.
 *
 * @param {object} adapter
 */
async function checkDailyMinimum(adapter) {
    const cfg  = adapter.config;
    const now  = adapter._getNow ? adapter._getNow() : new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const today = adapter.todayStr();

    // ── daily reset at UVC_DAILY_RESET_HOUR – once per day ──────────────────
    if (now.getHours() >= UVC_DAILY_RESET_HOUR && adapter._uvcTodayResetDate !== today) {
        adapter._uvcTodayResetDate = today;
        adapter._uvcDayStartHours  = accumulateHours(adapter);
        adapter._uvcDayStartDate   = today;
        adapter.setState('status.uvc_today_hours', { val: 0, ack: true });
        adapter.log.debug(`UVC: daily reset at ${String(UVC_DAILY_RESET_HOUR).padStart(2,'0')}:00 – uvc_today_hours reset to 0 (baseline: ${adapter._uvcDayStartHours.toFixed(2)} h)`);
    }

    // ── hard stop at UVC_DAILY_STOP_HOUR – ensure run must end before nightly reset ──
    if (now.getHours() >= UVC_DAILY_STOP_HOUR) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`UVC daily ensure: hard stop at ${String(UVC_DAILY_STOP_HOUR).padStart(2,'0')}:00 – stopping ensure run before nightly reset`);
            }
            await stopEnsure(adapter);
        }
        return;
    }

    const minH = cfg.uvc_daily_min_h ?? 2;
    if (!minH || minH <= 0) {
        return;
    }

    // Manual override pauses all automations including this
    if (adapter._manualOverride) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC daily ensure: paused by manual override');
            }
            await stopEnsure(adapter);
        }
        return;
    }

    // Date change detection: reset skip flag at midnight
    if (adapter._uvcEnsureSkipToday) {
        const skipDate = adapter._uvcEnsureSkipDate || adapter._uvcEnsureDate;
        if (!skipDate || skipDate !== today) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC daily ensure: new day – skip flag reset');
            }
            adapter._uvcEnsureSkipToday = false;
            adapter._uvcEnsureSkipDate  = '';
            adapter.setState('control.uvc_ensure_skip_today', false, true);
            adapter.setState('control.uvc_ensure_skip_date',  '',    true);
        }
    }

    if (adapter._uvcEnsureSkipToday) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC daily ensure: skipped by user request – stopping');
            }
            await stopEnsure(adapter);
        }
        return;
    }

    // Season disabled → UVC ensure only active during bathing season
    if (!adapter._seasonEnabled) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC daily ensure: season disabled – stopping ensure run');
            }
            await stopEnsure(adapter);
        }
        return;
    }

    // Winter mode active → UVC ensure disabled (pool is in frost-protection mode, not in use)
    if (adapter._winterModeActive) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC daily ensure: winter mode active – stopping ensure run');
            }
            await stopEnsure(adapter);
        }
        adapter.log.debug('UVC daily ensure: winter mode active – ensure disabled');
        return;
    }

    // Frost protection actively heating → defer until frost cycle ends
    if (adapter._winterFrostActive) {
        adapter.log.debug('UVC daily ensure: frost protection active – deferring until frost cycle ends');
        return;
    }

    const ensureTime = cfg.uvc_daily_ensure_time || '10:00';
    const [hh, mm]   = ensureTime.split(':').map(Number);
    const ensureMin  = (hh || 0) * 60 + (mm || 0);

    const todayH = getTodayHours(adapter);

    // Date change – stop any active ensure-run that started on a previous day
    if (adapter._uvcEnsureActive && adapter._uvcEnsureDate && adapter._uvcEnsureDate !== today) {
        if (adapter.config.more_log_enabled) {
            adapter.log.info('UVC daily ensure: new day detected – stopping previous session');
        }
        await stopEnsure(adapter);
    }

    adapter.log.debug(`UVC daily ensure: today=${todayH.toFixed(2)} h, min=${minH} h, ensureFrom=${ensureTime}, nowMin=${nowMinutes}, ensureMin=${ensureMin}, active=${adapter._uvcEnsureActive}, winterFrost=${adapter._winterFrostActive}`);

    // ── Herrenlose UVC: Ownership übernehmen ────────────────────────────────
    // After a time-window early-return (UVC min not yet met, _timeWindowActive[i]=false)
    // UVC and filter keep running on hardware but no automation owns them.
    // If we don't take ownership here, nobody will stop them when the minimum
    // is later reached (especially before ensureTime is reached).
    if (!adapter._uvcEnsureActive) {
        try {
            const uvcRunning = await adapter.getStateAsync('control.uvc');
            if (uvcRunning && uvcRunning.val) {
                const ownedByOther =
                    (adapter._pvActive && adapter._pvManagedFeatures && adapter._pvManagedFeatures.uvc) ||
                    adapter._timeWindowActive.some(v => v);
                if (!ownedByOther) {
                    adapter._uvcEnsureActive = true;
                    adapter._uvcEnsureDate   = today;
                    const filterRunning = await adapter.getStateAsync('control.filter');
                    if (filterRunning && filterRunning.val) {
                        const filterOwnedByOther =
                            adapter._pvActive ||
                            adapter._timeWindowActive.some(v => v) ||
                            adapter._winterFrostActive;
                        adapter._uvcEnsureFilterStart = !filterOwnedByOther;
                    } else {
                        adapter._uvcEnsureFilterStart = false;
                    }
                    adapter.log.debug('UVC daily ensure: taking ownership of running UVC (leftover from time window early-return)');
                }
            }
        } catch (e) {
            adapter.log.warn(`UVC daily ensure: ownership-check failed – ${e.message}`);
        }
    }
    // ────────────────────────────────────────────────────────────────────────

    if (todayH >= minH) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`UVC daily ensure: daily minimum reached (${todayH.toFixed(2)} h ≥ ${minH} h) – stopping`);
            }
            await stopEnsure(adapter);
        }
        return;
    }

    // UVC ensure runs INDEPENDENTLY of PV surplus and time windows.
    // It only waits for ensureTime (configured start time, e.g. 10:00).
    // If UVC is already running (via window/PV/manual), setFeature('uvc', true)
    // below is a no-op (UVC already on) – hours continue accumulating normally.
    if (nowMinutes < ensureMin) {
        adapter.log.debug(`UVC daily ensure: too early (${ensureTime} not reached yet) – waiting`);
        return;
    }

    // Start ensure run
    if (!adapter._uvcEnsureActive) {
        const remaining = (minH - todayH).toFixed(2);
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`UVC daily ensure: starting (${todayH.toFixed(2)} h today, need ${minH} h, ${remaining} h remaining)`);
        }
        await notificationHelper.send(notificationHelper.format('uvcEnsureStarted', { remaining }));
        adapter._uvcEnsureActive = true;
        adapter._uvcEnsureDate   = today;
        try {
            const filterState = await adapter.getStateAsync('control.filter');
            if (!filterState || !filterState.val) {
                await adapter.setFeature('filter', true, { fromAutomation: true });
                adapter._uvcEnsureFilterStart = true;
                adapter.log.debug('UVC daily ensure: filter started');
            } else {
                // Filter is already running – check if any other automation still owns it.
                // If not (e.g. time window just handed off UVC to ensure), ensure takes ownership
                // so it can stop the filter when the ensure run completes.
                const filterOwnedByOther =
                    adapter._timeWindowActive.some(v => v) ||
                    adapter._pvActive ||
                    adapter._pvStageTimer !== null ||
                    adapter._winterFrostActive;
                adapter._uvcEnsureFilterStart = !filterOwnedByOther;
                if (adapter._uvcEnsureFilterStart) {
                    adapter.log.debug('UVC daily ensure: filter already running – taking ownership (will stop after ensure)');
                } else {
                    adapter.log.debug('UVC daily ensure: filter already running and owned by another automation – not taking ownership');
                }
            }
            const uvcState = await adapter.getStateAsync('control.uvc');
            if (!uvcState || !uvcState.val) {
                await adapter.setFeature('uvc', true, { fromAutomation: true });
                adapter.log.debug('UVC daily ensure: UVC started');
            }
            adapter.enableRapidPolling();
        } catch (err) {
            adapter._uvcEnsureActive      = false;
            adapter._uvcEnsureFilterStart = false;
            adapter.log.error(`UVC daily ensure: start FAILED – ${err.message}`);
        }
    }
}

/**
 * Stop the current ensure run: turns off UVC and (if started by ensure) the filter pump.
 *
 * @param {object} adapter
 */
async function stopEnsure(adapter) {
    adapter._uvcEnsureActive = false;
    try {
        // Do NOT switch off UVC if another automation currently owns it.
        // PV or an active time window may have turned on UVC independently –
        // ensure only manages what IT started.
        const uvcOwnedByOther =
            (adapter._pvActive && adapter._pvManagedFeatures && adapter._pvManagedFeatures.uvc) ||
            (adapter._timeWindowActive.some(v => v) &&
                Array.isArray(adapter.config.timeWindows) &&
                adapter.config.timeWindows.some((w, j) =>
                    adapter._timeWindowActive[j] && w.active && w.action_uvc
                )
            );

        if (uvcOwnedByOther) {
            adapter.log.debug('UVC daily ensure: minimum reached – UVC kept ON (owned by PV/time-window)');
        } else {
            await adapter.setFeature('uvc', false, { fromAutomation: true });
            adapter.log.debug('UVC daily ensure: UVC stopped');
        }

        if (adapter._uvcEnsureFilterStart) {
            if (adapter._winterFrostActive) {
                adapter.log.debug('UVC daily ensure: filter kept ON – frost protection is active');
            } else if (uvcOwnedByOther) {
                adapter.log.debug('UVC daily ensure: filter kept ON – UVC still running via other automation');
            } else {
                await adapter.setFeature('filter', false, { fromAutomation: true });
                adapter.log.debug('UVC daily ensure: filter stopped (was started by ensure)');
            }
            adapter._uvcEnsureFilterStart = false;
        }
        adapter.enableRapidPolling();
    } catch (err) {
        adapter.log.error(`UVC daily ensure: stop FAILED – ${err.message}`);
    }
}

module.exports = {
    accumulateHours,
    getTodayHours,
    computeExpiry,
    initDailyEnsure,
    checkDailyMinimum,
    stopEnsure,
};
