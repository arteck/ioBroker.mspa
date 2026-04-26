'use strict';

/*
 * ioBroker MSpa Adapter  
 *
 */

const utils  = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const { MSpaApiClient, MSpaThrottle } = require('./lib/mspaApi');
const { transformStatus, RateTracker } = require('./lib/utils');
const stateMgr           = require('./lib/states');
const pvController       = require('./lib/pv');
const uvcController      = require('./lib/uvc');
const consumptionHelper  = require('./lib/consumptionHelper');
const notificationHelper = require('./lib/notificationHelper');

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------
class MspaAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'mspa' });

        this._api          = null;
        this._authStore    = { token: null, throttle: new MSpaThrottle() };
        this._pollTimer    = null;
        this._pollInterval = 60_000;  // ms
        this._rapidUntil   = 0;
        this._lastData     = {};
        this._savedState   = {};
        this._lastSnapshot = {};
        this._lastIsOnline = null;
        this._consecutiveErrors = 0;
        this._maxReconnectTries = 3;

        // What the adapter last commanded to the device (heater/filter/uvc/target_temp).
        // Used to detect external changes made via the MSpa app.
        // null means "unknown / not yet set by adapter" – no comparison for that feature.
        this._adapterCommanded = {
            heater:             null,
            filter:             null,
            bubble:             null,
            uvc:                null,
            target_temperature: null,
        };

        // Timestamp of the last command sent by the adapter.
        // App-change detection is suppressed for 30 s after any adapter command
        // to avoid false positives while the device is still catching up.
        this._lastCommandTime = 0;

        this._heatTracker  = new RateTracker({ min: 0.05, max: 3.0 });
        this._coolTracker  = new RateTracker({ min: 0.01, max: 3.0 });
        this._lastHeatRate = 0; // last positive heating rate (°C/h) for ETA calculation

        // PV surplus control
        this._pvPower                  = null;
        this._pvHouse                  = null;
        this._pvMspa                   = null;   // MSpa current power (W) from smart plug – used to correct house consumption
        this._pvActive                 = false;
        this._pvDeactivateTimer        = null;  // debounce timer for deactivation
        this._pvDeactivateCountdown    = 0;     // remaining minutes for deactivation delay
        this._pvDeactivateCountdownInt = null;  // 1-min interval for countdown
        this._pvStageTimer             = null;  // timer between staged-deactivation steps
        // Tracks which features PV currently has switched ON
        // (heater/filter/uvc may differ from window config if staging is in progress)
        this._pvManagedFeatures        = { heater: false, filter: false, uvc: false };

        // Manual override – pauses ALL automations (time windows, PV, frost protection)
        this._manualOverride      = false;  // true = all automations paused
        this._manualOverrideTimer = null;   // auto-reset timer (optional duration)

        // Winter mode (frost protection)
        this._winterModeActive  = false;  // runtime override (from control state)
        this._winterFrostActive = false;  // true while frost protection heating is running
        this._seasonEnabled     = false;  // controlled exclusively via control.season_enabled state

        // Filter pump runtime tracking
        this._filterOnSince   = null;  // Date.now() when filter turned ON, null when OFF
        this._filterHoursUsed = 0;     // accumulated runtime hours since last reset (persisted)

        // UVC lamp runtime tracking
        this._uvcOnSince            = null;   // Date.now() when UVC turned ON, null when OFF
        this._uvcHoursUsed          = 0;      // accumulated operating hours (persisted)
        this._uvcDayStartHours      = 0;      // _uvcHoursUsed snapshot at start of today
        this._uvcDayStartDate       = '';     // "YYYY-MM-DD" of the day _uvcDayStartHours was set
        // UVC daily minimum ensure
        this._uvcEnsureActive       = false;  // true while adapter is running UVC to fill daily minimum
        this._uvcEnsureFilterStart  = false;  // true if the ensure-run also started the filter pump
        this._uvcEnsureTimer        = null;   // 1-min interval for daily ensure check
        this._uvcEnsureDate         = '';     // date string of current ensure-run (for midnight reset)
        this._uvcEnsureSkipToday    = false;  // true = user skipped ensure for today (resets at midnight)
        this._uvcEnsureSkipDate     = '';     // date when skip was set (for midnight auto-reset)

        // Pending target temperature: stored when heater is not yet running;
        // sent 10 s after the heater is switched on (API only accepts temp while heating)
        this._pendingTargetTemp     = null;   // desired temperature waiting for heater ON
        this._pendingTempTimer      = null;   // setTimeout handle for 10 s delay

        // Time window control
        this._timeTimer             = null;
        this._timeWindowActive      = [false, false, false]; // state per window (1-3)
        this._pumpStartedForHeating = false; // pump was started solely because of heating (action_filter=false)
        this._pumpFollowUpTimers    = [];    // follow-up timers per window index

        this._firstPollDone         = false; // true after first successful poll (used for startup device-state check)

        // Tracks which apiField-based states have been created for this specific device model.
        // States NOT in this set are not published in publishStatus() to avoid setting
        // non-existent ioBroker objects with zero-padded values.
        this._dynamicStateIds       = new Set();

        // Tracks all "fire-and-forget" setTimeout handles so onUnload can clear
        // them and prevent late callbacks on a destroyed adapter.
        this._strayTimers           = new Set();

        this.on('ready',        this.onReady.bind(this));
        this.on('stateChange',  this.onStateChange.bind(this));
        this.on('unload',       this.onUnload.bind(this));
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async onReady() {
        this.log.info('MSpa adapter starting…');

        await this.createStates();

        const cfg      = this.config;
        const email    = cfg.email;
        const password = cfg.password
            ? crypto.createHash('md5').update(cfg.password).digest('hex')
            : '';
        const region   = cfg.region || 'ROW';

        this._pollInterval = Math.max(10, (cfg.pollInterval || 60)) * 1000;

        this._api = new MSpaApiClient({
            email,
            password,
            region,
            authStore: this._authStore,
            log: (level, msg) => this.log[level] ? this.log[level](msg) : this.log.info(msg),
        });

        try {
            await this._api.init();
            // Device info (static) wird einmalig beim ersten erfolgreichen Poll geschrieben.
            this.setState('info.connection', true, true);

            this.log.info(`MSpa connected – device: ${this._api.deviceAlias}`);

        } catch (err) {
            this.setState('info.connection', false, true);
            if (err.message && err.message.includes('no devices returned from API')) {
                this.log.error('MSpa init failed: No devices found in your MSpa account. Please check your e-mail address, password and region in the adapter settings.');
                // Auth/Account-Fehler: KEIN Retry – sonst loggen wir alle 30 s denselben Fehler
                return;
            }
            // FIX: Bei Netz-/API-Fehlern alle 30 s erneut versuchen, bis ein onUnload kommt
            this.log.error(`MSpa init failed: ${err.message} – retry in 30 s`);
            this._initRetryTimer = this.setStray(() => {
                this.onReady().catch(e => this.log.error(`MSpa init retry failed: ${e.message}`));
            }, 30_000);
            return;
        }

        this.subscribeStates('control.*');

        // restore runtime overrides from persisted control states (both controlled exclusively via control state)
        const wmState = this.getState('control.winter_mode');
        const seState = this.getState('control.season_enabled');
        this._winterModeActive = wmState && wmState.val !== null ? !!wmState.val : false;
        this._seasonEnabled    = seState && seState.val !== null ? !!seState.val : false;
        this.setState('control.winter_mode',    this._winterModeActive, true);
        this.setState('control.season_enabled', this._seasonEnabled,    true);
        // manual_override always resets to false on adapter restart
        this._manualOverride = false;
        this.setState('control.manual_override',         false, true);
        this.setState('control.manual_override_duration', 0,    true);
        // pv_deactivate_remaining always resets to 0 on adapter restart (no running timer)
        this.setState('computed.pv_deactivate_remaining', 0, true);
        // uvc_ensure_skip_today: restore from state – only valid if the skip date matches today
        {
            const skipState    = this.getState('control.uvc_ensure_skip_today');
            const skipDateSt   = this.getState('control.uvc_ensure_skip_date');
            const persistedSkip = skipState && skipState.val === true;
            const persistedDate = skipDateSt && typeof skipDateSt.val === 'string' ? skipDateSt.val : '';
            const today         = this.todayStr();

            if (persistedSkip && persistedDate === today) {
                this._uvcEnsureSkipToday = true;
                this._uvcEnsureSkipDate  = today;
                if (this.config.more_log_enabled) {
                    this.log.info('UVC daily ensure: skip flag restored – ensure paused for today');
                }
            } else {
                if (persistedSkip) {
                    if (this.config.more_log_enabled) {
                        this.log.info(`UVC daily ensure: skip flag from ${persistedDate || 'unknown date'} is outdated (today=${today}) – resetting`);
                    }
                }
                this._uvcEnsureSkipToday = false;
                this._uvcEnsureSkipDate  = '';
            }
            this.setState('control.uvc_ensure_skip_today', this._uvcEnsureSkipToday, true);
        }
        await this.initPvControl();
        this.initTimeControl();
        await this.publishTimeWindowsJson();
        await consumptionHelper.init(this);
        notificationHelper.init(this);

        // Filter runtime: restore persisted value; if filter was ON when adapter
        // stopped, use the timestamp of the last successful poll (`info.lastUpdate`)
        // as a conservative session start so we don't lose the runtime gap between
        // the unload-write and the restart.
        const filterRunningState = this.getState('control.filter_running');
        this._filterHoursUsed = (filterRunningState && typeof filterRunningState.val === 'number') ? filterRunningState.val : 0;
        const filterCtrlState = this.getState('control.filter');
        if (filterCtrlState && filterCtrlState.val) {
            const lastUpd = this.getState('info.lastUpdate');
            const lu      = lastUpd && typeof lastUpd.val === 'number' ? lastUpd.val : 0;
            // Plausibilitäts-Cutoff: maximal 6 h zurück, sonst Date.now() (konservativ)
            const maxBack = 6 * 3600 * 1000;
            this._filterOnSince = (lu > 0 && (Date.now() - lu) <= maxBack) ? lu : Date.now();
            if (this.config.more_log_enabled) {
                this.log.info(`Filter runtime: filter was ON at startup – tracking from now (accumulated: ${this._filterHoursUsed.toFixed(2)} h)`);
            }
        }

        // UVC hours: restore persisted value; if UVC was ON when adapter stopped, we
        // cannot know how long it ran ? we just start tracking from now.
        const uvcHoursState = this.getState('status.uvc_hours_used');
        this._uvcHoursUsed  = (uvcHoursState && typeof uvcHoursState.val === 'number') ? uvcHoursState.val : 0;
        // Snapshot for today's hours tracking (lazy: _getUvcTodayHours() re-snapshots on date change)
        this._uvcDayStartHours = this._uvcHoursUsed;
        this._uvcDayStartDate  = this.todayStr();
        // check current UVC state from last known control state
        const uvcCtrlState = this.getState('control.uvc');
        if (uvcCtrlState && uvcCtrlState.val) {
            // UVC is currently ON ? start tracking from now (conservative: don't guess past runtime)
            this._uvcOnSince = Date.now();
        }

        this.computeUvcExpiry().catch(e => this.log.error(`computeUvcExpiry: ${e.message}`));
        this.initUvcDailyEnsure();
        this.doPoll();
    }

    /**
     * Wrapper for fire-and-forget setTimeout that registers the handle in
     * `_strayTimers` so onUnload can clear it. Use everywhere where the timer
     * handle is not stored in a dedicated property.
     *
     * @param {Function} fn  callback
     * @param {number}   ms  delay in milliseconds
     * @returns {NodeJS.Timeout}
     */
    setStray(fn, ms) {
        const t = setTimeout(() => {
            this._strayTimers.delete(t);
            try {
 fn(); 
} catch (e) {
 this.log.error(`stray timer cb: ${e.message}`); 
}
        }, ms);
        this._strayTimers.add(t);
        return t;
    }

    async onUnload(callback) {
        if (this._pollTimer)                {
 clearTimeout(this._pollTimer); 
}
        if (this._timeTimer)                {
 clearInterval(this._timeTimer); 
}
        if (this._pvDeactivateTimer)        {
 clearTimeout(this._pvDeactivateTimer); 
}
        if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); 
}
        if (this._pvStageTimer)             {
 clearTimeout(this._pvStageTimer); 
}
        if (this._uvcEnsureTimer)           {
 clearInterval(this._uvcEnsureTimer); 
}
        if (this._pendingTempTimer)         {
 clearTimeout(this._pendingTempTimer); 
}
        if (this._manualOverrideTimer)      {
 clearTimeout(this._manualOverrideTimer); 
}
        for (const t of this._pumpFollowUpTimers) {
            if (t) {
 clearTimeout(t); 
}
        }
        // Clear any stray fire-and-forget timers registered via _setStray()
        for (const t of this._strayTimers) {
 clearTimeout(t); 
}
        this._strayTimers.clear();
        consumptionHelper.cleanup();
        notificationHelper.cleanup();
        // Persist accumulated filter runtime hours (including any currently-running session)
        try {
            const finalFilterH = this.accumulateFilterHours();
            this.setState('control.filter_running', { val: Math.round(finalFilterH * 100) / 100, ack: true });
        } catch (_) { /* ignore on unload */ }
        // Persist accumulated UVC hours (including any currently-running session)
        try {
            const finalHours = this.accumulateUvcHours();
            this.setState('status.uvc_hours_used', { val: Math.round(finalHours * 100) / 100, ack: true });
        } catch (_) { /* ignore on unload */ }
        callback();
    }

    // -------------------------------------------------------------------------
    // Publish configured time windows as JSON datapoint
    // -------------------------------------------------------------------------
    async publishTimeWindowsJson() {
        const windows = this.config.timeWindows;
        const json    = JSON.stringify(Array.isArray(windows) ? windows : [], null, 2);
        this.log.debug(`Time windows JSON: ${json}`);
        this.setState('status.time_windows_json', { val: json, ack: true });
    }

    // -------------------------------------------------------------------------
    // Time Window Control
    // -------------------------------------------------------------------------
    initTimeControl() {
        const windows = this.config.timeWindows;
        if (!Array.isArray(windows) || windows.length === 0 || !windows.some(w => w.active)) {
            this.log.debug('Time control: no active time windows configured – skipping');
            return;
        }
        const cfg = this.config;
        if (this._seasonEnabled) {
            if (this.config.more_log_enabled) {
                this.log.info(`Time control: season control active (${cfg.season_start} – ${cfg.season_end}), today inSeason=${this.isInSeason()}`);
            }
        }
        // init tracking array to match current window count
        this._timeWindowActive = windows.map(() => false);
        if (this.config.more_log_enabled) {
            this.log.info(`Time control: starting scheduler for ${windows.filter(w => w.active).length} active window(s) (checks every 60 s)`);
        }

        // run immediately, then every 60 s aligned to next full minute
        this.checkTimeWindows().catch(e => this.log.error(`checkTimeWindows: ${e.message}`));
        const now     = new Date();
        const msToMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
        this.setStray(() => {
            this.checkTimeWindows().catch(e => this.log.error(`checkTimeWindows: ${e.message}`));
            this._timeTimer = setInterval(
                () => this.checkTimeWindows().catch(e => this.log.error(`checkTimeWindows: ${e.message}`)),
                60_000,
            );
        }, msToMin);
    }

    async checkTimeWindows() {
        const windows = this.config.timeWindows;
        if (!Array.isArray(windows)) {
            return;
        }

        // --- Manual override guard -----------------------------------------
        if (this._manualOverride) {
            this.log.debug('Time control: manual override active – skipping time window control');
            return;
        }
        // --- Season guard ---------------------------------------------------
        if (!this.isInSeason()) {
            this.log.debug('Time control: outside season – skipping time window control (polling continues)');
            // deactivate any windows that were still active
            for (let i = 0; i < windows.length; i++) {
                if (this._timeWindowActive[i]) {
                    this._timeWindowActive[i] = false;
                    if (this.config.more_log_enabled) {
                        this.log.info(`Time control [${i + 1}]: season ended – deactivating window`);
                    }
                    await this.deactivateWindow(windows[i], i);
                    await notificationHelper.send(notificationHelper.format('timeWindowSeasonEnded', { window: i + 1 }));
                }
            }
            return;
        }
        // --------------------------------------------------------------------

        const now     = new Date();
        const day     = now.getDay(); // 0=Sun … 6=Sat
        const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];

        // ensure tracking array is large enough
        while (this._timeWindowActive.length < windows.length) {
            this._timeWindowActive.push(false);
        }

        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (!w.active) {
                // if it was active before, deactivate cleanly
                if (this._timeWindowActive[i]) {
                    this._timeWindowActive[i] = false;
                    await this.deactivateWindow(w, i);
                }
                continue;
            }

            const start  = w.start || '00:00';
            const end    = w.end   || '00:00';
            const dayOn  = !!w[dayKeys[day]];
            const inWin  = dayOn && this.isInTimeWindow(start, end);
            const wasIn  = this._timeWindowActive[i];

            this.log.debug(`Time control [${i + 1}]: inWindow=${inWin}, wasActive=${wasIn}, day=${dayKeys[day]}, ${start}–${end}`);

            if (inWin && !wasIn) {
                this._timeWindowActive[i] = true;
                if (this.config.more_log_enabled) {
                    this.log.info(`Time control [${i + 1}]: window START (${start}–${end}) – activating`);
                }
                await notificationHelper.send(notificationHelper.format('timeWindowStarted', { window: i + 1, start, end }));
                try {
                    if (w.action_heating) {
                        // heater requires filter pump – start it first even if action_filter is off
                        if (!w.action_filter) {
                            this.log.debug(`Time control [${i + 1}]: filter ON (required for heating)`);
                            await this.setFeature('filter', true);
                            this._pumpStartedForHeating = true;
                        }
                        this.log.debug(`Time control [${i + 1}]: heater ON`);
                        await this.setFeature('heater', true);
                        if (w.target_temp) {
                            this.log.debug(`Time control [${i + 1}]: target temperature ? ${w.target_temp}°C – sending in 10 s`);
                            this.setStray(() => {
                                this.sendTargetTempDirect(w.target_temp).catch(e =>
                                    this.log.error(`Time control [${i + 1}]: target temperature send FAILED – ${e.message}`)
                                );
                            }, 10_000);
                        }
                    }
                    if (w.action_filter) {
                        this.log.debug(`Time control [${i + 1}]: filter ON`);
                        await this.setFeature('filter', true);
                        if (w.action_uvc) {
                            this.log.debug(`Time control [${i + 1}]: UVC ON`);
                            await this.setFeature('uvc', true);
                        }
                    }
                    this.enableRapidPolling();
                } catch (err) {
                    this._timeWindowActive[i] = false; // rollback – retry next minute
                    this.log.error(`Time control [${i + 1}]: activation FAILED – ${err.message}`);
                    this.log.debug(`Time control [${i + 1}]: ${err.stack}`);
                }

            } else if (!inWin && wasIn) {
                this._timeWindowActive[i] = false;
                if (this.config.more_log_enabled) {
                    this.log.info(`Time control [${i + 1}]: window END (${start}–${end}) – deactivating`);
                }
                await notificationHelper.send(notificationHelper.format('timeWindowEnded', { window: i + 1, start, end }));
                await this.deactivateWindow(w, i);
            }
        }
    }

    async deactivateWindow(w, i) {
        // Cancel any existing follow-up timer for this window
        if (this._pumpFollowUpTimers[i]) {
            clearTimeout(this._pumpFollowUpTimers[i]);
            this._pumpFollowUpTimers[i] = null;
        }

        const followUpMin = Number(this.config.pump_follow_up) || 0;
        const cfg         = this.config;
        const uvcMinH     = cfg.uvc_daily_min_h ?? 2;
        const todayH      = this.getUvcTodayHours();
        const uvcMinMet   = todayH >= uvcMinH;

        try {
            // Always turn off heater immediately
            if (w.action_heating) {
                this.log.debug(`Time control [${i + 1}]: heater OFF`);
                await this.setFeature('heater', false);
            }

            // UVC off – but only if daily minimum is already reached.
            // If not met, the daily ensure scheduler will keep UVC (and filter) running
            // until the minimum is fulfilled. No need to stop and restart.
            if (w.action_filter && w.action_uvc) {
                if (uvcMinMet) {
                    this.log.debug(`Time control [${i + 1}]: UVC OFF (daily minimum met: ${todayH.toFixed(2)} h = ${uvcMinH} h)`);
                    await this.setFeature('uvc', false);
                } else {
                    if (this.config.more_log_enabled) {
                        this.log.info(`Time control [${i + 1}]: UVC kept ON – daily minimum not yet met (${todayH.toFixed(2)} h of ${uvcMinH} h), daily ensure will take over`);
                    }
                    // Filter must also stay ON for UVC – skip filter shutdown below
                    this.enableRapidPolling();
                    return;
                }
            }

            // Filter pump: immediate or delayed?
            const stopPumpNow = !followUpMin || followUpMin <= 0;

            if (stopPumpNow) {
                // No follow-up – stop filter immediately
                if (w.action_filter) {
                    this.log.debug(`Time control [${i + 1}]: filter OFF`);
                    await this.setFeature('filter', false);
                }
                if (w.action_heating && !w.action_filter) {
                    this.log.debug(`Time control [${i + 1}]: filter OFF (was started for heating only)`);
                    await this.setFeature('filter', false);
                    this._pumpStartedForHeating = false;
                }
            } else {
                // Follow-up active – pump keeps running for followUpMin minutes
                if (this.config.more_log_enabled) {
                    this.log.info(`Time control [${i + 1}]: filter pump FOLLOW-UP for ${followUpMin} min`);
                }
                this._pumpFollowUpTimers[i] = setTimeout(async () => {
                    this._pumpFollowUpTimers[i] = null;
                    try {
                        if (this.config.more_log_enabled) {
                            this.log.info(`Time control [${i + 1}]: follow-up time elapsed – filter OFF`);
                        }
                        await this.setFeature('filter', false);
                        this._pumpStartedForHeating = false;
                        this.enableRapidPolling();
                    } catch (err) {
                        this.log.error(`Time control [${i + 1}]: follow-up filter OFF FAILED – ${err.message}`);
                    }
                }, followUpMin * 60 * 1000);
            }

            this.enableRapidPolling();
        } catch (err) {
            this._timeWindowActive[i] = true; // rollback – retry next minute
            this.log.error(`Time control [${i + 1}]: deactivation FAILED – ${err.message}`);
            this.log.debug(`Time control [${i + 1}]: ${err.stack}`);
        }
    }

    // -------------------------------------------------------------------------
    // Startup device-state check
    // -------------------------------------------------------------------------
    /**
     * Called once after the very first successful poll.
     * Checks whether the adapter was (re-)started while the device is still
     * running features that were controlled by a time window – but the time
     * window is no longer active right now.
     *
     * Scenario:  Adapter was stopped during an active window (11:00–18:00).
     * It restarts at 20:00 ? no window is active, but filter/UVC/
     * heater may still be ON on the device.
     *
     * Rule: Only shut down features that at least ONE configured (active) time
     * window would have managed.  Features not touched by any window are left
     * alone (manual operation by the user).
     *
     * @param data
     */
    async checkStartupDeviceState(data) {
        // Skip if manual override or PV is active – those automations take over
        if (this._manualOverride || this._pvActive) {
            this.log.debug('Startup check: skipped (manual override or PV active)');
            return;
        }

        const windows = this.config.timeWindows;
        if (!Array.isArray(windows) || !windows.some(w => w.active)) {
            this.log.debug('Startup check: no active time windows – skipping');
            return;
        }

        // Determine which features any active window would manage
        let anyWindowManagesHeater = false;
        let anyWindowManagesFilter = false;
        let anyWindowManagesUvc    = false;

        for (const w of windows) {
            if (!w.active)                       {
 continue; 
}
            if (w.action_heating)                {
 anyWindowManagesHeater = true; 
}
            if (w.action_filter)                 {
 anyWindowManagesFilter = true; 
}
            if (w.action_filter && w.action_uvc) {
 anyWindowManagesUvc    = true; 
}
        }

        // Check if any of those features is currently ON on the device
        const heaterOn = !!data.heater;
        const filterOn = !!data.filter;
        const uvcOn    = !!data.uvc;

        if (!heaterOn && !filterOn && !uvcOn) {
            this.log.debug('Startup check: device is idle – nothing to do');
            return;
        }

        // Is any time window active right now?
        const anyWindowActiveNow = this._timeWindowActive.some(v => v);
        if (anyWindowActiveNow) {
            this.log.debug('Startup check: a time window is currently active – leaving device state as-is');
            return;
        }

        if (this.config.more_log_enabled) {
            this.log.info('Startup check: device appears to be running but no time window is active – checking for orphaned features');
        }

        try {
            if (heaterOn && anyWindowManagesHeater) {
                if (this.config.more_log_enabled) {
                    this.log.info('Startup check: heater ON but no active window ? switching OFF');
                }
                await this.setFeature('heater', false);
            }
            // UVC before filter (filter may need to stay for UVC daily ensure)
            if (uvcOn && anyWindowManagesUvc) {
                const todayH  = this.getUvcTodayHours();
                const uvcMinH = this.config.uvc_daily_min_h ?? 2;
                if (todayH >= uvcMinH) {
                    if (this.config.more_log_enabled) {
                        this.log.info(`Startup check: UVC ON but no active window (daily min met: ${todayH.toFixed(2)} h) ? switching OFF`);
                    }
                    await this.setFeature('uvc', false);
                } else {
                    if (this.config.more_log_enabled) {
                        this.log.info(`Startup check: UVC ON, daily min not yet met (${todayH.toFixed(2)} h of ${uvcMinH} h) – keeping ON for daily ensure`);
                    }
                    // Filter must stay ON for UVC – skip filter shutdown
                    return;
                }
            }
            if (filterOn && anyWindowManagesFilter) {
                if (this.config.more_log_enabled) {
                    this.log.info('Startup check: filter ON but no active window ? switching OFF');
                }
                await this.setFeature('filter', false);
            }
            this.enableRapidPolling();
        } catch (err) {
            this.log.error(`Startup check: error while shutting down orphaned features – ${err.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Filter pump runtime – helper
    // -------------------------------------------------------------------------
    /**
     * Returns total accumulated filter runtime hours including the currently running
     * session (if filter is ON right now). Does NOT mutate this._filterHoursUsed.
     */
    accumulateFilterHours() {
        let total = this._filterHoursUsed || 0;
        if (this._filterOnSince !== null) {
            total += (Date.now() - this._filterOnSince) / (1000 * 3600);
        }
        return total;
    }


    /**
     * Returns true if today is within the configured season window (DD.MM – DD.MM).
     * If season_enabled is false, always returns false – all automatic controls
     * (time windows, PV surplus) are blocked. Only winter mode (frost protection)
     * is allowed when season_enabled = false and winter_mode = true.
     * Supports seasons spanning the year boundary (e.g. 01.10 – 31.03).
     */
    isInSeason() {
        const cfg = this.config;
        if (!this._seasonEnabled) {
            this.log.debug('Season check: season_enabled=false ? automatic controls blocked (only winter mode allowed)');
            return false;
        }

        const parseDate = (ddmm) => {
            const parts = (ddmm || '').split('.');
            return { day: parseInt(parts[0], 10) || 1, month: parseInt(parts[1], 10) || 1 };
        };

        const now   = new Date();
        const today = now.getDate();
        const month = now.getMonth() + 1; // 1-based

        const start = parseDate(cfg.season_start || '01.01');
        const end   = parseDate(cfg.season_end   || '31.12');

        // convert to a simple comparable number MMDD
        const toNum  = (d) => d.month * 100 + d.day;
        const cur    = month * 100 + today;
        const s      = toNum(start);
        const e      = toNum(end);

        let inSeason;
        if (s <= e) {
            // normal range (e.g. 01.05 – 30.09)
            inSeason = cur >= s && cur <= e;
        } else {
            // year-spanning range (e.g. 01.10 – 31.03)
            inSeason = cur >= s || cur <= e;
        }

        this.log.debug(`Season check: today=${today}.${month} (${cur}), season=${cfg.season_start}–${cfg.season_end} (${s}–${e}), inSeason=${inSeason}`);
        return inSeason;
    }

    /**
     * Returns true if current local time is within [start, end) (HH:MM strings).
     * Supports overnight windows e.g. "22:00"–"06:00".
     *
     * @param start
     * @param end
     */
    isInTimeWindow(start, end) {
        const now   = new Date();
        const toMin = (hhmm) => {
            const [h, m] = hhmm.split(':').map(Number);
            return h * 60 + m;
        };
        const cur = now.getHours() * 60 + now.getMinutes();
        const s   = toMin(start);
        const e   = toMin(end);
        if (s === e) {
 return false; 
}  // empty window
        if (s < e)   {
 return cur >= s && cur < e; 
}
        return cur >= s || cur < e;     // overnight
    }

    // -------------------------------------------------------------------------
    // PV Surplus Control  ?  lib/pv.js
    // -------------------------------------------------------------------------
    async initPvControl()                                        {
 return pvController.init(this); 
}
    async onForeignStateChange(id, state)                        {
 return pvController.onForeignStateChange(this, id, state); 
}
    async evaluatePvSurplus()                                    {
 return pvController.evaluateSurplus(this); 
}
    async pvCancelAllDeactivationTimers()                        {
 return pvController.cancelAllDeactivationTimers(this); 
}
    async pvReactivate(pvWindows, surplus)                       {
 return pvController.reactivate(this, pvWindows, surplus); 
}
    async pvStagedDeactivate(pvWindows, immediate = false)       {
 return pvController.stagedDeactivate(this, pvWindows, immediate); 
}

    // -------------------------------------------------------------------------
    // UVC  ?  lib/uvc.js
    // -------------------------------------------------------------------------
    accumulateUvcHours()       {
 return uvcController.accumulateHours(this); 
}
    getUvcTodayHours()         {
 return uvcController.getTodayHours(this); 
}
    async computeUvcExpiry()   {
 return uvcController.computeExpiry(this); 
}
    initUvcDailyEnsure()       {
 return uvcController.initDailyEnsure(this); 
}
    async checkUvcDailyMinimum() {
 return uvcController.checkDailyMinimum(this); 
}
    async stopUvcEnsure()      {
 return uvcController.stopEnsure(this); 
}

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // -------------------------------------------------------------------------
    // State management
    // -------------------------------------------------------------------------
    async createStates() {
        return stateMgr.createStates(this);
    }

    /**
     * Creates status states that have an apiField mapping – but only for fields
     * that the device actually reports in its first raw API response.
     * Called once after the first successful poll.
     *
     * @param {object} raw  – raw API payload from getHotTubStatus()
     */
    async createDynamicStates(raw) {
        return stateMgr.createDynamicStates(this, raw);
    }

    async updateDeviceInfo() {
        return stateMgr.updateDeviceInfo(this);
    }

    // -------------------------------------------------------------------------
    // Polling
    // -------------------------------------------------------------------------
    schedulePoll() {
        const isRapid  = Date.now() < this._rapidUntil;
        const interval = isRapid ? 1000 : this._pollInterval;
        this._pollTimer = setTimeout(() => this.doPoll(), interval);
    }

    async tryReconnect() {
        try {
            this._authStore.token = null;
            await this._api.init();
            // Device info ist statisch und wurde bereits beim ersten Poll geschrieben.
            this.setState('info.connection', true, true);
            return true;
        } catch (err) {
            this.log.error(`MSpa reconnect failed: ${err.message}`);
            return false;
        }
    }

    async doPoll() {
        try {
            let raw;
            if (this._api._lastStatus) {
                raw = this._api._lastStatus;
                this._api._lastStatus = null;
            } else {
                raw = await this._api.getHotTubStatus();
            }

            // DEBUG: einmalig rohe API-Daten loggen (nur beim ersten Poll)
            if (!this._rawApiLogged) {
                this._rawApiLogged = true;
                if (this.config.more_log_enabled) {
                    this.log.info(`MSpa RAW API response (${this._api.model}): ${JSON.stringify(raw)}`);
                }
                // Create model-specific status states based on what the API actually reports
                await this.createDynamicStates(raw);
            }

            const data     = transformStatus(raw);
            this._lastData = data;

            await this.publishStatus(data);
            await this.checkFrostProtection(data);
            await this.checkPowerCycle(data);
            await this.checkAdaptivePolling(data);
            this.setState('info.connection', true, true);
            this.setState('info.lastUpdate', Date.now(), true);
            this._consecutiveErrors = 0;

            // Startup check: after first successful poll, verify device state
            // against active time windows and shut down orphaned features.
            if (!this._firstPollDone) {
                this._firstPollDone = true;
                // Statische Geräteinfos (Modell, Seriennummer, FW-Versionen, …)
                // werden EINMALIG beim ersten erfolgreichen Poll geschrieben.
                try {
                    await this.updateDeviceInfo();
                } catch (e) {
                    this.log.warn(`updateDeviceInfo failed: ${e.message}`);
                }
                await this.checkStartupDeviceState(data);
            }

        } catch (err) {
            this._consecutiveErrors++;
            this.log.error(`MSpa poll error (${this._consecutiveErrors}): ${err.message}`);
            this.setState('info.connection', false, true);

            if (this._consecutiveErrors <= this._maxReconnectTries) {
                if (this.config.more_log_enabled) {
                    this.log.info(`MSpa attempting reconnect (try ${this._consecutiveErrors}/${this._maxReconnectTries})…`);
                }
                const reconnected = await this.tryReconnect();
                if (reconnected) {
                    if (this.config.more_log_enabled) {
                        this.log.info('MSpa reconnect successful – retrying poll immediately');
                    }
                    this.schedulePoll();
                    return;
                }
            } else {
                this.log.warn(`MSpa reconnect limit reached (${this._maxReconnectTries}), waiting for next regular poll interval`);
                this._consecutiveErrors = 0;
            }
        }

        this.schedulePoll();
    }

    async publishStatus(data) {
        return stateMgr.publishStatus(this, data);
    }

    // -------------------------------------------------------------------------
    // Adaptive polling
    // -------------------------------------------------------------------------
    async checkAdaptivePolling(data) {
        if (data.heat_state === 2 && data.heater === 'on') {
            this._rapidUntil = Date.now() + 15_000;
        }
    }

    enableRapidPolling() {
        this._rapidUntil = Date.now() + 15_000;
        // Cancel the currently scheduled poll and reschedule immediately (1 s)
        // so the ACK arrives quickly instead of waiting up to 60 s.
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
        this._pollTimer = setTimeout(() => this.doPoll(), 1_000);
    }

    // -------------------------------------------------------------------------
    // Power cycle detection + state restore
    // -------------------------------------------------------------------------
    async checkPowerCycle(data) {
        const currentOnline = !!data.is_online;
        let   powerCycle    = false;

        if (this._lastIsOnline !== null) {
            if (this._lastIsOnline && !currentOnline) {
                if (this.config.more_log_enabled) {
                    this.log.info('MSpa power OFF detected – saving state');
                }
                this._savedState = {
                    heater:             data.heater,
                    target_temperature: data.target_temperature,
                    filter:             data.filter,
                    temperature_unit:   data.temperature_unit,
                    ozone:              data.ozone,
                    uvc:                data.uvc,
                    bubble:             data.bubble,
                    bubble_level:       data.bubble_level,
                };
            } else if (!this._lastIsOnline && currentOnline) {
                powerCycle = true;
                if (this.config.more_log_enabled) {
                    this.log.info('MSpa power ON detected (is_online transition)');
                }
            }
        }

        if (!powerCycle && Object.keys(this._lastSnapshot).length) {
            const changes = [];
            if (this._lastSnapshot.temperature_unit === 0 && data.temperature_unit === 1) {
                changes.push('temp_unit_reset');
            }
            if (this._lastSnapshot.heater === 'on' && data.heater === 'off') {
                changes.push('heater_off');
            }
            if (this._lastSnapshot.filter === 'on' && data.filter === 'off') {
                changes.push('filter_off');
            }
            if (this._lastSnapshot.ozone  === 'on' && data.ozone  === 'off') {
                changes.push('ozone_off');
            }
            if (this._lastSnapshot.uvc    === 'on' && data.uvc    === 'off') {
                changes.push('uvc_off');
            }
            if (changes.length >= 2) {
                powerCycle = true;
                this.log.warn(`MSpa possible power cycle (${changes.join(', ')})`);
            }
        }

        this._lastSnapshot = {
            temperature_unit:   data.temperature_unit,
            heater:             data.heater,
            filter:             data.filter,
            ozone:              data.ozone,
            uvc:                data.uvc,
            target_temperature: data.target_temperature,
        };
        this._lastIsOnline = currentOnline;

        if (powerCycle) {
            const cfg = this.config;
            if (cfg.trackTemperatureUnit) {
                await this.enforceTemperatureUnit(data);
            }
            if (cfg.restoreStateOnPowerCycle && Object.keys(this._savedState).length) {
                await this.restoreSavedState();
            }
        }

        if (this.config.alwaysEnforceUnit && !powerCycle) {
            await this.enforceTemperatureUnit(data);
        }
    }

    async enforceTemperatureUnit(data) {
        const desired = 0; // °C
        if ((data.temperature_unit || 0) !== desired) {
            if (this.config.more_log_enabled) {
                this.log.info('MSpa enforcing temperature unit ? Celsius');
            }
            await this._api.setTemperatureUnit(desired);
        }
    }

    async restoreSavedState() {
        if (this.config.more_log_enabled) {
            this.log.info('MSpa restoring state after power cycle…');
        }
        await this.sleep(2000);

        if (this._savedState.target_temperature) {
            await this.safeCmd(() => this.setTargetTemp(this._savedState.target_temperature), 'temperature');
        }
        for (const feature of ['heater', 'filter', 'ozone', 'uvc', 'bubble']) {
            if (this._savedState[feature] === 'on') {
                await this.safeCmd(() => this.setFeature(feature, true), feature);
                await this.sleep(500);
            }
        }
        if (this._savedState.bubble === 'on' && this._savedState.bubble_level) {
            await this.safeCmd(
                () => this._api.setBubbleLevel(this._savedState.bubble_level),
                'bubble_level',
            );
        }
    }

    async safeCmd(fn, label) {
        try {
            await fn();
        } catch (err) {
            this.log.error(`MSpa restore ${label} failed: ${err.message}`);
        }
    }

    sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // -------------------------------------------------------------------------
    // Control – feature state helper
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Winter mode – frost protection
    // -------------------------------------------------------------------------
    async checkFrostProtection(data) {
        if (this._manualOverride) {
            this.log.debug('Winter mode: manual override active – skipping frost protection');
            return;
        }
        const cfg         = this.config;
        const winterMode  = this._winterModeActive;
        if (!winterMode) {
            // if frost was active but winter mode got disabled ? switch off
            if (this._winterFrostActive) {
                this._winterFrostActive = false;
                if (this.config.more_log_enabled) {
                    this.log.info('Winter mode: disabled – switching heater + filter OFF');
                }
                await this.setFeature('heater', false);
                await this.setFeature('filter', false);
            }
            return;
        }

        const threshold = cfg.winter_frost_temp ?? 5;
        const hysteresis = 3;
        const temp = data.water_temperature;
        if (temp === undefined || temp === null) {
 return; 
}

        if (!this._winterFrostActive && temp <= threshold) {
            this._winterFrostActive = true;
            if (this.config.more_log_enabled) {
                this.log.info(`Winter mode: temp ${temp}°C = ${threshold}°C – switching heater + filter ON`);
            }
            await notificationHelper.send(notificationHelper.format('frostActive', { temp, threshold }));
            await this.setFeature('filter', true);
            await this.setFeature('heater', true);
            this.enableRapidPolling();
        } else if (this._winterFrostActive && temp >= threshold + hysteresis) {
            this._winterFrostActive = false;
            if (this.config.more_log_enabled) {
                this.log.info(`Winter mode: temp ${temp}°C = ${threshold + hysteresis}°C – switching heater + filter OFF`);
            }
            await notificationHelper.send(notificationHelper.format('frostDeactivated', { temp, hysteresis: threshold + hysteresis }));
            await this.setFeature('heater', false);
            await this.setFeature('filter', false);
            this.enableRapidPolling();
            // Frost cycle ended ? immediately re-evaluate UVC daily minimum
            // (was deferred while frost was active)
            this.checkUvcDailyMinimum().catch(e => this.log.error(`UVC daily ensure trigger after frost: ${e.message}`));
        }
    }

    // -------------------------------------------------------------------------
    // Command status helper
    // -------------------------------------------------------------------------
    async setStatusCheck(status) {
        return stateMgr.setStatusCheck(this, status);
    }

    async setFeature(feature, boolVal) {
        const state = boolVal ? 1 : 0;
        if (feature in this._adapterCommanded) {
            this._adapterCommanded[feature] = boolVal;
        }
        // Mark command time – app-change detection will be suppressed for 30 s
        this._lastCommandTime = Date.now();

        // UVC can only be switched on when the filter pump is already running.
        // Auto-start filter if needed, then wait up to 15 s for the device to confirm it.
        if (feature === 'uvc' && boolVal) {
            const filterRunning = () =>
                (this._lastData && this._lastData.filter === 'on') ||
                (this._api && this._api._lastStatus && this._api._lastStatus.filter_state === 1) ||
                (this._adapterCommanded.filter === true);

            if (!filterRunning()) {
                if (this.config.more_log_enabled) {
                    this.log.info('UVC ON – filter not running, auto-starting filter pump first');
                }
                await this.setFeature('filter', true);
                // Poll up to 15 s until filter is confirmed ON by the device
                const start = Date.now();
                let ok = false;
                while (Date.now() - start < 15_000) {
                    await new Promise(r => setTimeout(r, 1_000));
                    if (filterRunning()) {
 ok = true; break; 
}
                    try {
                        const raw = await this._api.getHotTubStatus();
                        this._lastData = transformStatus(raw);
                    } catch (e) {
                        this.log.debug(`UVC pre-check poll failed: ${e.message}`);
                    }
                }
                if (!ok) {
                    this.log.warn('UVC ON: filter still not confirmed after 15 s – sending UVC command anyway');
                }
            }
        }

        switch (feature) {
            case 'heater': {
                if (boolVal) {
                    // The heater requires the filter pump to be running.
                    // Auto-start it if not already ON (live API data takes priority).
                    const filterOn =
                        (this._lastData && this._lastData.filter === 'on') ||
                        (this._api && this._api._lastStatus && this._api._lastStatus.filter_state === 1) ||
                        (this._adapterCommanded.filter === true);
                    if (!filterOn) {
                        if (this.config.more_log_enabled) {
                            this.log.info('heater ON – auto-starting filter pump first (required by device)');
                        }
                        await this.setFeature('filter', true);
                        await this.sleep(1_500); // give the pump time to spin up
                    }
                }
                await this.setStatusCheck('send');
                const result = await this._api.setHeaterState(state);
                await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
                if (boolVal && this._pendingTargetTemp !== null) {
                    // Heater just switched ON ? send pending target temperature after 10 s
                    if (this._pendingTempTimer) {
                        clearTimeout(this._pendingTempTimer);
                        this._pendingTempTimer = null;
                    }
                    const pendingTemp = this._pendingTargetTemp;
                    // Sofort entwerten – konkurrierende Aufrufer (z. B. setTargetTemp)
                    // dürfen den Wert nicht erneut abgreifen.
                    this._pendingTargetTemp = null;
                    this._pendingTempTimer = setTimeout(async () => {
                        this._pendingTempTimer = null;
                        if (this.config.more_log_enabled) {
                            this.log.info(`target_temperature: sending pending value ${pendingTemp}°C (10 s after heater ON)`);
                        }
                        try {
                            await this.sendTargetTempDirect(pendingTemp);
                        } catch (err) {
                            this.log.error(`target_temperature: delayed send FAILED – ${err.message}`);
                        }
                    }, 10_000);
                } else if (!boolVal) {
                    // Heater switched OFF ? cancel any pending temperature command
                    if (this._pendingTempTimer) {
                        clearTimeout(this._pendingTempTimer);
                        this._pendingTempTimer = null;
                    }
                }
                return result;
            }
            case 'filter': {
                if (!boolVal) {
                    // The API rejects a filter-OFF command while UVC is still running.
                    // ? Explicitly switch off UVC (and bubble) first, then filter.
                    const uvcState    = this.getState('control.uvc');
                    const bubbleState = this.getState('control.bubble');
                    const heaterState = this.getState('control.heater');

                    if (uvcState && uvcState.val) {
                        if (this.config.more_log_enabled) {
                            this.log.info('filter OFF – auto-disabling UVC first (API requirement)');
                        }
                        await this.setStatusCheck('send');
                        await this._api.setUvcState(0);
                        await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
                        this._adapterCommanded.uvc = false;
                        await this.sleep(500);
                    }
                    if (bubbleState && bubbleState.val) {
                        if (this.config.more_log_enabled) {
                            this.log.info('filter OFF – auto-disabling bubble first (API requirement)');
                        }
                        await this.setStatusCheck('send');
                        await this._api.setBubbleState(0, this._lastData.bubble_level || 1);
                        await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
                        this._adapterCommanded.bubble = false;
                        await this.sleep(500);
                    }
                    if (heaterState && heaterState.val) {
                        if (this.config.more_log_enabled) {
                            this.log.info('filter OFF – auto-disabling heater first');
                        }
                        await this.setFeature('heater', false);
                        await this.sleep(500);
                    }
                }
                await this.setStatusCheck('send');
                await this._api.setFilterState(state);
                await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
                return;
            }
            case 'bubble': await this.setStatusCheck('send'); await this._api.setBubbleState(state, this._lastData.bubble_level || 1); await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error'); return;
            case 'jet':    await this.setStatusCheck('send'); await this._api.setJetState(state);                                        await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error'); return;
            case 'ozone':  await this.setStatusCheck('send'); await this._api.setOzoneState(state);                                      await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error'); return;
            case 'uvc':    await this.setStatusCheck('send'); await this._api.setUvcState(state);                                        await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error'); return;
        }
    }

    async setTargetTemp(temp) {
        // Validate range (MSpa: 20–42 °C)
        const MIN_TEMP = 20;
        const MAX_TEMP = 42;
        const t = Number(temp);
        if (isNaN(t) || t < MIN_TEMP || t > MAX_TEMP) {
            this.log.warn(`target_temperature ${temp}°C out of range (${MIN_TEMP}–${MAX_TEMP}°C) – command ignored`);
            await this.setStatusCheck('error');
            return;
        }

        // If heater is not currently on (user command via state), store as pending.
        // Automations that just called setFeature('heater', true) use _scheduleTargetTempAfterHeaterOn().
        // Use live API data + _adapterCommanded as fallback so we don't queue unnecessarily
        // when the heater was just switched ON but the poll hasn't confirmed it yet.
        const heaterState = this.getState('control.heater');
        const heaterOnState     = heaterState && !!heaterState.val;
        const heaterOnCommanded = this._adapterCommanded.heater === true;
        const heaterOnLive      = this._lastData && this._lastData.heater === 'on';
        const heaterOn = heaterOnState || heaterOnCommanded || heaterOnLive;

        if (!heaterOn) {
            this._pendingTargetTemp = t;
            if (this.config.more_log_enabled) {
                this.log.info(`target_temperature ${t}°C queued – will be sent 10 s after heater is switched ON`);
            }
            await this.setStatusCheck('queued');
            return;
        }
        this._pendingTargetTemp = null;
        return this.sendTargetTempDirect(t);
    }

    /**
     * Sends the target temperature directly to the API (no heater-state check).
     * Use this in automations that have just called setFeature('heater', true).
     *
     * @param temp
     */
    async sendTargetTempDirect(temp) {
        this._adapterCommanded.target_temperature = temp;
        this._lastCommandTime = Date.now();
        await this.setStatusCheck('send');
        const result = await this._api.setTemperatureSetting(temp);
        await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
        return result;
    }

    // -------------------------------------------------------------------------
    // Manual override – pausiert alle Automationen (Zeitfenster, PV, Frostschutz)
    // -------------------------------------------------------------------------
    async setManualOverride(enable, durationMin = null) {
        // cancel any existing auto-reset timer
        if (this._manualOverrideTimer) {
            clearTimeout(this._manualOverrideTimer);
            this._manualOverrideTimer = null;
        }

        this._manualOverride = enable;
        this.setState('control.manual_override', enable, true);

        if (enable) {
            // read duration from state if not explicitly passed
            if (durationMin === null) {
                const ds = this.getState('control.manual_override_duration');
                durationMin = ds && ds.val !== null ? Number(ds.val) : 0;
            } else {
                this.setState('control.manual_override_duration', durationMin, true);
            }

            if (durationMin > 0) {
                if (this.config.more_log_enabled) {
                    this.log.info(`Manual override: ENABLED for ${durationMin} min – all automations paused`);
                }
                await notificationHelper.send(notificationHelper.format('overrideOnTimed', { durationMin }));
                this._manualOverrideTimer = setTimeout(async () => {
                    this._manualOverrideTimer = null;
                    if (this.config.more_log_enabled) {
                        this.log.info('Manual override: duration elapsed – automations RESUMED');
                    }
                    await notificationHelper.send(notificationHelper.format('overrideEnded'));
                    this._manualOverride = false;
                    this.setState('control.manual_override', false, true);
                    this.setState('control.manual_override_duration', 0, true);
                    // Re-evaluate all automations now that override is lifted
                    if (this._lastData && Object.keys(this._lastData).length) {
                        await this.checkFrostProtection(this._lastData);
                    }
                    await this.checkTimeWindows();
                    await this.evaluatePvSurplus();
                }, durationMin * 60 * 1000);
            } else {
                if (this.config.more_log_enabled) {
                    this.log.info('Manual override: ENABLED indefinitely – all automations paused (set to false to resume)');
                }
                await notificationHelper.send(notificationHelper.format('overrideOnIndefinite'));
            }
        } else {
            if (this.config.more_log_enabled) {
                this.log.info('Manual override: DISABLED – all automations RESUMED');
            }
            await notificationHelper.send(notificationHelper.format('overrideOff'));
            this.setState('control.manual_override_duration', 0, true);
            // immediately re-evaluate automations with latest data
            if (this._lastData && Object.keys(this._lastData).length) {
                await this.checkFrostProtection(this._lastData);
            }
            await this.checkTimeWindows();
            await this.evaluatePvSurplus();
        }
    }

    // -------------------------------------------------------------------------
    // State change handler (writable controls)
    // -------------------------------------------------------------------------
    async onStateChange(id, state) {
        if (!state) {
            return;
        }

        // -- Foreign states (PV, house, MSpa power, energy meter) ---------
        // Sie werden über subscribeForeignStates() abonniert und kommen mit ack=true.
        // Eigene States dieses Adapters beginnen mit `${this.namespace}.` (z. B. mspa.0.).
        if (!id.startsWith(`${this.namespace}.`)) {
            try {
                await this.onForeignStateChange(id, state);
            } catch (e) {
                this.log.error(`onForeignStateChange(${id}) failed: ${e.message}`);
            }
            return;
        }

        // Eigene Control-States: nur unbestätigte Schreibvorgänge verarbeiten
        if (state.ack) {
            return;
        }

        const key = id.split('.').pop();

        try {
            if (['heater', 'filter', 'bubble', 'jet', 'ozone', 'uvc'].includes(key)) {
                if (this.config.more_log_enabled) {
                    this.log.info(`MSpa command: ${key} ? ${state.val}`);
                }
                await this.setFeature(key, !!state.val);
                this.enableRapidPolling();
            } else if (key === 'target_temperature') {
                if (this.config.more_log_enabled) {
                    this.log.info(`MSpa command: set temperature ? ${state.val}°C`);
                }
                await this.setTargetTemp(state.val);
                this.enableRapidPolling();
            } else if (key === 'bubble_level') {
                if (this.config.more_log_enabled) {
                    this.log.info(`MSpa command: bubble level ? ${state.val}`);
                }
                await this.setStatusCheck('send');
                await this._api.setBubbleLevel(state.val);
                await this.setStatusCheck(this._api._lastCommandConfirmed ? 'success' : 'error');
                this.enableRapidPolling();
            } else if (key === 'winter_mode') {
                this._winterModeActive = !!state.val;
                if (this.config.more_log_enabled) {
                    this.log.info(`Winter mode: ${this._winterModeActive ? 'ENABLED' : 'DISABLED'} via control state`);
                }
                this.setState('control.winter_mode', this._winterModeActive, true);
                if (this._lastData) {
 await this.checkFrostProtection(this._lastData); 
}
            } else if (key === 'season_enabled') {
                this._seasonEnabled = !!state.val;
                if (this.config.more_log_enabled) {
                    this.log.info(`Season control: ${this._seasonEnabled ? 'ENABLED' : 'DISABLED'} via control state`);
                }
                this.setState('control.season_enabled', this._seasonEnabled, true);

            } else if (key === 'manual_override') {
                const enable = !!state.val;
                await this.setManualOverride(enable);

            } else if (key === 'uvc_ensure_skip_today') {
                const skip = !!state.val;
                this._uvcEnsureSkipToday = skip;
                this._uvcEnsureSkipDate  = skip ? this.todayStr() : '';
                this.setState('control.uvc_ensure_skip_today', skip, true);
                this.setState('control.uvc_ensure_skip_date',  this._uvcEnsureSkipDate, true);
                if (skip) {
                    if (this.config.more_log_enabled) {
                        this.log.info('UVC daily ensure: skip requested by user – pausing for today');
                    }
                    await notificationHelper.send(notificationHelper.format('uvcEnsureSkipped'));
                    // stop immediately if ensure is currently running
                    if (this._uvcEnsureActive) {
                        await this.stopUvcEnsure();
                    } else {
                        // ensure was not active, but UVC may still be ON (e.g. started by time window
                        // or manually) – if so, turn it off as an explicit manual abort
                        const uvcState = this.getState('control.uvc');
                        if (uvcState && uvcState.val) {
                            if (this.config.more_log_enabled) {
                                this.log.info('UVC daily ensure: UVC is ON – switching OFF (manual abort via skip)');
                            }
                            await this.setFeature('uvc', false);
                            this.enableRapidPolling();
                        }
                    }
                } else {
                    if (this.config.more_log_enabled) {
                        this.log.info('UVC daily ensure: skip cancelled – ensure active again');
                    }
                    // trigger immediate re-check so ensure starts without waiting up to 60s
                    this.checkUvcDailyMinimum().catch(e => this.log.error(`UVC ensure re-check: ${e.message}`));
                }

            } else if (key === 'manual_override_duration') {
                // duration change only relevant while override is active ? restart timer
                if (this._manualOverride) {
                    await this.setManualOverride(true, Number(state.val) || 0);
                } else {
                    this.setState('control.manual_override_duration', Number(state.val) || 0, true);
                }

            } else if (key === 'filter_reset') {
                if (state.val) {
                    // Flush any currently running session into _filterHoursUsed first,
                    // then reset to 0 and start a fresh session from now if filter is still ON.
                    const wasRunning = this._filterOnSince !== null;
                    this._filterHoursUsed = 0;
                    this._filterOnSince   = wasRunning ? Date.now() : null;
                    this.setState('control.filter_running', { val: 0, ack: true });
                    // Reset button ? always write false back (it's a momentary trigger)
                    this.setState('control.filter_reset', { val: false, ack: true });
                    if (this.config.more_log_enabled) {
                        this.log.info(`Filter runtime counter reset to 0 (filter was ${wasRunning ? 'running – new session started' : 'off'})`);
                    }
                }
            }
        } catch (err) {
            this.log.error(`MSpa command failed (${key}): ${err.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (require.main !== module) {
    module.exports = options => new MspaAdapter(options);
} else {
    new MspaAdapter();
}
