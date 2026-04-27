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
 * Automatically resets the day-start snapshot at midnight.
 *
 * @param {object} adapter
 * @returns {number}
 */
function getTodayHours(adapter) {
    const today = adapter.todayStr();
    if (adapter._uvcDayStartDate !== today) {
        adapter._uvcDayStartHours = adapter._uvcHoursUsed;
        adapter._uvcDayStartDate  = today;
        adapter.log.debug(`UVC: new day detected – day-start snapshot: ${adapter._uvcDayStartHours.toFixed(2)} h`);
    }
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
    if (!minH || minH <= 0) {
        adapter.log.debug('UVC daily ensure: disabled (uvc_daily_min_h = 0)');
        return;
    }
    const ensureTime = cfg.uvc_daily_ensure_time || '10:00';
    if (adapter.config.more_log_enabled) {
        adapter.log.info(`UVC daily ensure: active – minimum ${minH} h/day, starts checking from ${ensureTime}`);
    }

    // Run immediately, then align to next full minute
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
 * Starts / stops the ensure run as needed.
 *
 * @param {object} adapter
 */
async function checkDailyMinimum(adapter) {
    const cfg  = adapter.config;
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
    const today = adapter.todayStr();
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

    // Season disabled → UVC ensure only needed during active bathing season
    if (!adapter._seasonEnabled) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('UVC daily ensure: season disabled – stopping ensure run');
            }
            await stopEnsure(adapter);
        }
        return;
    }

    // Frost protection active → defer (filter already running for frost)
    if (adapter._winterFrostActive) {
        adapter.log.debug('UVC daily ensure: frost protection active – deferring UVC ensure until frost cycle ends');
        return;
    }

    const ensureTime = cfg.uvc_daily_ensure_time || '10:00';
    const now        = new Date();
    const [hh, mm]   = ensureTime.split(':').map(Number);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const ensureMin  = (hh || 0) * 60 + (mm || 0);

    const todayH = getTodayHours(adapter);

    // Date change – stop any active ensure-run at midnight
    if (adapter._uvcEnsureActive && adapter._uvcEnsureDate && adapter._uvcEnsureDate !== today) {
        if (adapter.config.more_log_enabled) {
            adapter.log.info('UVC daily ensure: new day detected – stopping previous session');
        }
        await stopEnsure(adapter);
    }

    adapter.log.debug(`UVC daily ensure: today=${todayH.toFixed(2)} h, min=${minH} h, ensureFrom=${ensureTime}, nowMin=${nowMinutes}, ensureMin=${ensureMin}, active=${adapter._uvcEnsureActive}, winterFrost=${adapter._winterFrostActive}`);

    if (todayH >= minH) {
        if (adapter._uvcEnsureActive) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info(`UVC daily ensure: daily minimum reached (${todayH.toFixed(2)} h ≥ ${minH} h) – stopping`);
            }
            await stopEnsure(adapter);
        }
        return;
    }

    // Defer while any time window is still active
    const anyWindowActive = adapter._timeWindowActive.some(v => v);
    if (anyWindowActive) {
        adapter.log.debug('UVC daily ensure: time window still active – deferring until last window ends');
        return;
    }

    // Calculate latest end time of all active windows scheduled for today
    const windows = adapter.config.timeWindows;
    const day     = now.getDay();
    const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];
    let lastWinEnd = -1;

    if (Array.isArray(windows)) {
        for (const w of windows) {
            if (!w.active || !w[dayKeys[day]]) {
 continue; 
}
            const [endH, endM] = (w.end || '00:00').split(':').map(Number);
            const endMin = (endH || 0) * 60 + (endM || 0);
            if (endMin > lastWinEnd) {
 lastWinEnd = endMin; 
}
        }
    }

    const ensureTimeReached = nowMinutes >= ensureMin;
    const lastWindowPassed  = lastWinEnd >= 0 && nowMinutes >= lastWinEnd;

    if (!ensureTimeReached && !lastWindowPassed) {
        if (lastWinEnd >= 0) {
            const endHH = Math.floor(lastWinEnd / 60).toString().padStart(2, '0');
            const endMM = (lastWinEnd % 60).toString().padStart(2, '0');
            adapter.log.debug(`UVC daily ensure: waiting – ensureTime ${ensureTime} not reached and last window ends at ${endHH}:${endMM}`);
        } else {
            adapter.log.debug(`UVC daily ensure: too early (${ensureTime} not reached yet) – waiting`);
        }
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
                await adapter.setFeature('filter', true);
                adapter._uvcEnsureFilterStart = true;
                adapter.log.debug('UVC daily ensure: filter started');
            } else {
                adapter._uvcEnsureFilterStart = false;
                adapter.log.debug('UVC daily ensure: filter already running');
            }
            const uvcState = await adapter.getStateAsync('control.uvc');
            if (!uvcState || !uvcState.val) {
                await adapter.setFeature('uvc', true);
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
        await adapter.setFeature('uvc', false);
        adapter.log.debug('UVC daily ensure: UVC stopped');
        if (adapter._uvcEnsureFilterStart) {
            if (adapter._winterFrostActive) {
                adapter.log.debug('UVC daily ensure: filter kept ON – frost protection is active');
            } else {
                await adapter.setFeature('filter', false);
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
