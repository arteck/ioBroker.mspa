'use strict';

/*
 * ioBroker MSpa Adapter – main.js
 *
 */

const utils  = require('@iobroker/adapter-core');
const crypto = require('crypto');
const { MSpaApiClient, MSpaThrottle } = require('./lib/mspaApi');
const { transformStatus, RateTracker } = require('./lib/utils');
const { STATE_DEFS }                   = require('./lib/constants');
const consumptionHelper                = require('./lib/consumptionHelper');
const notificationHelper               = require('./lib/notificationHelper');

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
            uvc:                null,
            target_temperature: null,
        };

        this._heatTracker  = new RateTracker({ min: 0.05, max: 3.0 });
        this._coolTracker  = new RateTracker({ min: 0.01, max: 3.0 });

        // PV surplus control
        this._pvPower                  = null;
        this._pvHouse                  = null;
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

        // Time window control
        this._timeTimer             = null;
        this._timeWindowActive      = [false, false, false]; // state per window (1-3)
        this._pumpStartedForHeating = false; // pump was started solely because of heating (action_filter=false)
        this._pumpFollowUpTimers    = [];    // follow-up timers per window index

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
            await this.updateDeviceInfo();
            await this.setStateAsync('info.connection', true, true);
            this.log.info(`MSpa connected – device: ${this._api.deviceAlias}`);
        } catch (err) {
            await this.setStateAsync('info.connection', false, true);
            if (err.message && err.message.includes('no devices returned from API')) {
                this.log.error('MSpa init failed: No devices found in your MSpa account. Please check your e-mail address, password and region in the adapter settings.');
            } else {
                this.log.error(`MSpa init failed: ${err.message}`);
            }
        }

        this.subscribeStates('control.*');

        // restore runtime overrides from persisted control states (both controlled exclusively via control state)
        const wmState = await this.getStateAsync('control.winter_mode');
        const seState = await this.getStateAsync('control.season_enabled');
        this._winterModeActive = wmState && wmState.val !== null ? !!wmState.val : false;
        this._seasonEnabled    = seState && seState.val !== null ? !!seState.val : false;
        await this.setStateAsync('control.winter_mode',    this._winterModeActive, true);
        await this.setStateAsync('control.season_enabled', this._seasonEnabled,    true);
        // manual_override always resets to false on adapter restart
        this._manualOverride = false;
        await this.setStateAsync('control.manual_override',         false, true);
        await this.setStateAsync('control.manual_override_duration', 0,    true);
        // uvc_ensure_skip_today: restore from state (valid only if date matches today)
        const skipState = await this.getStateAsync('control.uvc_ensure_skip_today');
        this._uvcEnsureSkipToday = skipState && skipState.val === true ? true : false;
        if (this._uvcEnsureSkipToday) {
            this.log.info('UVC daily ensure: skip flag restored from previous session – ensure paused for today');
        }
        await this.setStateAsync('control.uvc_ensure_skip_today', this._uvcEnsureSkipToday, true);
        await this.initPvControl();
        this.initTimeControl();
        await this.publishTimeWindowsJson();
        await consumptionHelper.init(this);
        notificationHelper.init(this);

        // UVC hours: restore persisted value; if UVC was ON when adapter stopped, we
        // cannot know how long it ran → we just start tracking from now.
        const uvcHoursState = await this.getStateAsync('status.uvc_hours_used');
        this._uvcHoursUsed  = (uvcHoursState && typeof uvcHoursState.val === 'number') ? uvcHoursState.val : 0;
        // Snapshot for today's hours tracking (lazy: _getUvcTodayHours() re-snapshots on date change)
        this._uvcDayStartHours = this._uvcHoursUsed;
        this._uvcDayStartDate  = this._todayStr();
        // check current UVC state from last known control state
        const uvcCtrlState = await this.getStateAsync('control.uvc');
        if (uvcCtrlState && uvcCtrlState.val) {
            // UVC is currently ON → start tracking from now (conservative: don't guess past runtime)
            this._uvcOnSince = Date.now();
        }

        this.computeUvcExpiry();
        this.initUvcDailyEnsure();
        this.doPoll();
    }

    onUnload(callback) {
        if (this._pollTimer)                 {
 clearTimeout(this._pollTimer); 
}
        if (this._timeTimer)                 {
 clearInterval(this._timeTimer); 
}
        if (this._pvDeactivateTimer)         {
 clearTimeout(this._pvDeactivateTimer); 
}
        if (this._pvDeactivateCountdownInt)  {
 clearInterval(this._pvDeactivateCountdownInt); 
}
        if (this._pvStageTimer)              {
 clearTimeout(this._pvStageTimer); 
}
        if (this._uvcEnsureTimer)            {
 clearInterval(this._uvcEnsureTimer); 
}
        for (const t of this._pumpFollowUpTimers) {
            if (t) {
 clearTimeout(t); 
}
        }
        consumptionHelper.cleanup();
        notificationHelper.cleanup();
        // Persist accumulated UVC hours (including any currently-running session)
        try {
            const finalHours = this._accumulateUvcHours();
            this.setStateAsync('status.uvc_hours_used', { val: Math.round(finalHours * 100) / 100, ack: true });
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
        await this.setStateAsync('status.time_windows_json', { val: json, ack: true });
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
            this.log.info(`Time control: season control active (${cfg.season_start} – ${cfg.season_end}), today inSeason=${this.isInSeason()}`);
        }
        // init tracking array to match current window count
        this._timeWindowActive = windows.map(() => false);
        this.log.info(`Time control: starting scheduler for ${windows.filter(w => w.active).length} active window(s) (checks every 60 s)`);

        // run immediately, then every 60 s aligned to next full minute
        this.checkTimeWindows();
        const now     = new Date();
        const msToMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
        setTimeout(() => {
            this.checkTimeWindows();
            this._timeTimer = setInterval(() => this.checkTimeWindows(), 60_000);
        }, msToMin);
    }

    async checkTimeWindows() {
        const windows = this.config.timeWindows;
        if (!Array.isArray(windows)) {
            return;
        }

        // --- Season guard ---------------------------------------------------
        if (!this.isInSeason()) {
            this.log.debug('Time control: outside season – skipping time window control (polling continues)');
            // deactivate any windows that were still active
            for (let i = 0; i < windows.length; i++) {
                if (this._timeWindowActive[i]) {
                    this._timeWindowActive[i] = false;
                    this.log.info(`Time control [${i + 1}]: season ended – deactivating window`);
                    await this._deactivateWindow(windows[i], i);
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
                    await this._deactivateWindow(w, i);
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
                this.log.info(`Time control [${i + 1}]: window START (${start}–${end}) – activating`);
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
                            this.log.debug(`Time control [${i + 1}]: target temperature → ${w.target_temp}°C`);
                            await this.setTargetTemp(w.target_temp);
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
                this.log.info(`Time control [${i + 1}]: window END (${start}–${end}) – deactivating`);
                await notificationHelper.send(notificationHelper.format('timeWindowEnded', { window: i + 1, start, end }));
                await this._deactivateWindow(w, i);
            }
        }
    }

    async _deactivateWindow(w, i) {
        // Cancel any existing follow-up timer for this window
        if (this._pumpFollowUpTimers[i]) {
            clearTimeout(this._pumpFollowUpTimers[i]);
            this._pumpFollowUpTimers[i] = null;
        }

        const followUpMin = Number(this.config.pump_follow_up) || 0;

        try {
            // Always turn off heater immediately
            if (w.action_heating) {
                this.log.debug(`Time control [${i + 1}]: heater OFF`);
                await this.setFeature('heater', false);
            }

            // UVC off immediately (never needs follow-up)
            if (w.action_filter && w.action_uvc) {
                this.log.debug(`Time control [${i + 1}]: UVC OFF`);
                await this.setFeature('uvc', false);
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
                this.log.info(`Time control [${i + 1}]: filter pump FOLLOW-UP for ${followUpMin} min`);
                this._pumpFollowUpTimers[i] = setTimeout(async () => {
                    this._pumpFollowUpTimers[i] = null;
                    try {
                        this.log.info(`Time control [${i + 1}]: follow-up time elapsed – filter OFF`);
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
    // UVC lamp operating hours – helper
    // -------------------------------------------------------------------------
    /**
     * Returns total accumulated UVC hours including the currently running session
     * (if UVC is ON right now). Does NOT mutate this._uvcHoursUsed.
     */
    _accumulateUvcHours() {
        let total = this._uvcHoursUsed || 0;
        if (this._uvcOnSince !== null) {
            total += (Date.now() - this._uvcOnSince) / (1000 * 3600);
        }
        return total;
    }

    // -------------------------------------------------------------------------
    // UVC lamp expiry calculation
    // -------------------------------------------------------------------------
    /**
     * Calculates the estimated expiry date for the UVC lamp.
     *
     * Logic:
     *  - uvc_install_date  (DD.MM.YYYY): date the lamp was installed / last reset
     *  - uvc_operating_hours (number)  : rated lamp lifetime in operating hours (default 8000 h)
     *
     * The adapter counts real operating hours (only while UVC is switched ON).
     * The remaining hours are projected onto calendar days using the average
     * daily usage observed since the install date.
     *
     * If no install date is set, the function silently skips.
     */
    async computeUvcExpiry() {
        const cfg = this.config;
        const raw = (cfg.uvc_install_date || '').trim();
        if (!raw) {
            this.log.debug('UVC: no installation date configured – skipping expiry calculation');
            this.setStateAsync('status.uvc_expiry_date',      { val: '', ack: true });
            this.setStateAsync('status.uvc_hours_remaining',  { val: 0,  ack: true });
            return;
        }

        const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (!match) {
            this.log.warn(`UVC: invalid installation date format "${raw}" – expected DD.MM.YYYY`);
            this.setStateAsync('status.uvc_expiry_date', { val: 'invalid date', ack: true });
            return;
        }

        const [, dd, mm, yyyy] = match;
        const installDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
        if (isNaN(installDate.getTime())) {
            this.log.warn(`UVC: installation date "${raw}" could not be parsed`);
            this.setStateAsync('status.uvc_expiry_date', { val: 'invalid date', ack: true });
            return;
        }

        // Rated lifetime in operating hours (configurable, default 8 000 h)
        const ratedHours   = cfg.uvc_operating_hours || 8000;

        // Actual operating hours counted since install date
        const usedHours    = this._accumulateUvcHours();
        const remainHours  = Math.max(0, ratedHours - usedHours);

        await this.setStateChangedAsync('status.uvc_hours_remaining', Math.round(remainHours * 100) / 100, true);

        // Estimate expiry date:
        // average daily usage = usedHours / calendarDaysSinceInstall
        // Then: remainDays = remainHours / avgHoursPerDay
        const pad = (n) => String(n).padStart(2, '0');
        const now             = new Date();
        const calendarDays    = Math.max(1, Math.ceil((now - installDate) / (1000 * 3600 * 24)));
        const avgHoursPerDay  = usedHours / calendarDays;  // h/day

        let expiryStr;
        let daysLeft;

        if (avgHoursPerDay <= 0) {
            // No usage recorded yet – show remaining hours, leave expiry date empty
            this.log.debug(`UVC: no operating hours recorded yet – ${ratedHours} h rated lifetime remaining`);
            await this.setStateChangedAsync('status.uvc_expiry_date', '', true);
            await this.setStateChangedAsync('status.uvc_hours_remaining', ratedHours, true);
            return;
        }

        const remainDays  = remainHours / avgHoursPerDay;
        const expiryDate  = new Date(now.getTime() + remainDays * 24 * 3600 * 1000);
        expiryStr         = `${pad(expiryDate.getDate())}.${pad(expiryDate.getMonth() + 1)}.${expiryDate.getFullYear()}`;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expiryDate.setHours(0, 0, 0, 0);
        daysLeft = Math.ceil((expiryDate - today) / (1000 * 3600 * 24));

        if (remainHours <= 0) {
            this.log.warn(`UVC: lamp lifetime exhausted! ${usedHours.toFixed(0)} h used of ${ratedHours} h rated – please replace!`);
            await notificationHelper.send(notificationHelper.format('uvcExpired', { usedHours: usedHours.toFixed(0) }));
            expiryStr = 'replace now';
        } else if (daysLeft <= 30) {
            this.log.warn(`UVC: lamp expires ~${expiryStr} (in ~${daysLeft} days, ${remainHours.toFixed(0)} h remaining) – replacement recommended`);
            await notificationHelper.send(notificationHelper.format('uvcExpirySoon', { expiry: expiryStr, daysLeft }));
        } else {
            this.log.info(`UVC: ${usedHours.toFixed(1)} h used, ${remainHours.toFixed(0)} h remaining, est. expiry ~${expiryStr} (~${daysLeft} days, avg ${avgHoursPerDay.toFixed(2)} h/day)`);
        }

        await this.setStateChangedAsync('status.uvc_expiry_date', expiryStr, true);
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
            this.log.debug('Season check: season_enabled=false → automatic controls blocked (only winter mode allowed)');
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
        const cur   = now.getHours() * 60 + now.getMinutes();
        const s     = toMin(start);
        const e     = toMin(end);
        if (s === e)  {
 return false; 
}   // empty window
        if (s < e)    {
 return cur >= s && cur < e; 
}
        return cur >= s || cur < e;        // overnight
    }

    // -------------------------------------------------------------------------
    // PV Surplus Control
    // -------------------------------------------------------------------------
    async initPvControl() {
        const cfg = this.config;
        const hasPvWindows = Array.isArray(cfg.timeWindows) && cfg.timeWindows.some(w => w.active && w.pv_steu);
        if (!hasPvWindows) {
            this.log.debug('PV: no active time window rows with PV enabled – skipping init');
            return;
        }
        if (this._seasonEnabled) {
            this.log.info(`PV: season control active (${cfg.season_start} – ${cfg.season_end}), today inSeason=${this.isInSeason()}`);
        }
        this.log.info(` initialising surplus control (threshold=${cfg.pv_threshold_w ?? 500} W, hysteresis=${cfg.pv_hysteresis_w ?? 100} W, heating=${!!cfg.pv_action_heating}, filter=${!!cfg.pv_action_filter}, targetTemp=${cfg.pv_target_temp ?? '—'}°C)`);

        if (cfg.pv_power_generated_id) {
            this.subscribeForeignStates(cfg.pv_power_generated_id);
            const s = await this.getForeignStateAsync(cfg.pv_power_generated_id);
            if (s && s.val !== null) {
                this._pvPower = s.val;
                this.log.info(` initial PV generation = ${this._pvPower} W  (id: ${cfg.pv_power_generated_id})`);
            } else {
                this.log.warn(` PV generation state not available yet (id: ${cfg.pv_power_generated_id})`);
            }
        } else {
            this.log.warn( 'no Object-ID configured for PV generation – surplus control will not work');
        }

        if (cfg.pv_power_house_id) {
            this.subscribeForeignStates(cfg.pv_power_house_id);
            const s = await this.getForeignStateAsync(cfg.pv_power_house_id);
            if (s && s.val !== null) {
                this._pvHouse = s.val;
                this.log.info(` initial house consumption = ${this._pvHouse} W  (id: ${cfg.pv_power_house_id})`);
            } else {
                this.log.warn(` house consumption state not available yet (id: ${cfg.pv_power_house_id})`);
            }
        } else {
            this.log.warn( 'no Object-ID configured for house consumption – surplus control will not work');
        }

        this.log.debug(` init done – pvPower=${this._pvPower}, pvHouse=${this._pvHouse}, pvActive=${this._pvActive}`);
    }

    async onForeignStateChange(id, state) {
        if (!state) {
            this.log.debug(`onForeignStateChange – state is null for id=${id}`);
            return;
        }
        if (state.ack === false) {
            this.log.debug(`onForeignStateChange – ignoring unacked state change for id=${id}`);
            return;
        }

        // --- Consumption tracking: always runs, independent of PV and season -
        await consumptionHelper.handleStateChange(id, state);

        // --- PV surplus control ---------------------------------------------
        const cfg = this.config;
        const hasPvWindows = Array.isArray(cfg.timeWindows) && cfg.timeWindows.some(w => w.active && w.pv_steu);
        if (!hasPvWindows) {
            return;
        }

        if (id === cfg.pv_power_generated_id) {
            const prev = this._pvPower;
            this._pvPower = state.val;
            this.log.debug(`PV: generation updated ${prev} → ${this._pvPower} W`);
        } else if (id === cfg.pv_power_house_id) {
            const prev = this._pvHouse;
            this._pvHouse = state.val;
            this.log.debug(`PV: house consumption updated ${prev} → ${this._pvHouse} W`);
        } else {
            return; // not a PV id – consumption already handled above
        }
        await this.evaluatePvSurplus();
    }

    async evaluatePvSurplus() {
        const cfg = this.config;

        // --- Season guard ---------------------------------------------------
        if (!this.isInSeason()) {
            this.log.debug('PV: outside season – skipping surplus evaluation');
            await this._pvCancelAllDeactivationTimers();
            if (this._pvActive) {
                this._pvActive = false;
                this.log.info('PV: season ended – staged deactivation');
                const pvWindows = (cfg.timeWindows || []).filter(w => w.active && w.pv_steu);
                await this._pvStagedDeactivate(pvWindows, true /* immediate */);
            }
            return;
        }

        if (this._pvPower === null || this._pvHouse === null) {
            this.log.debug(`PV: evaluation skipped – pvPower=${this._pvPower}, pvHouse=${this._pvHouse}`);
            return;
        }

        const surplus    = this._pvPower - this._pvHouse;
        const threshold  = cfg.pv_threshold_w  || 500;
        const hysteresis = Math.min(cfg.pv_hysteresis_w || 100, threshold);
        const offAt      = threshold - hysteresis;

        this.log.debug(`PV: surplus=${surplus} W | threshold=${threshold} W | offAt=${offAt} W | pvActive=${this._pvActive} | managed=${JSON.stringify(this._pvManagedFeatures)}`);

        const shouldActivate   = surplus >= threshold;
        const shouldDeactivate = surplus < offAt;

        const pvWindows = (cfg.timeWindows || []).filter(w => w.active && w.pv_steu);
        if (pvWindows.length === 0) {
            this.log.debug('PV: no PV-enabled time window rows – nothing to do');
            return;
        }

        // ── Activation ───────────────────────────────────────────────────────
        if (shouldActivate && (!this._pvActive || this._pvStageTimer !== null)) {
            // Cancel any pending deactivation (debounce or staging)
            await this._pvCancelAllDeactivationTimers();

            if (!this._pvActive) {
                // Fresh activation
                this._pvActive = true;
                this.log.info(`PV: surplus DETECTED (${surplus} W ≥ ${threshold} W) – activating`);
                await notificationHelper.send(notificationHelper.format('pvActivated', { surplus }));
                for (const w of pvWindows) {
                    try {
                        if (w.action_heating) {
                            if (!w.action_filter) {
                                await this.setFeature('filter', true);
                                this._pvManagedFeatures.filter = true;
                            }
                            await this.setFeature('heater', true);
                            this._pvManagedFeatures.heater = true;
                            if (w.target_temp) {
await this.setTargetTemp(w.target_temp);
}
                        }
                        if (w.action_filter) {
                            await this.setFeature('filter', true);
                            this._pvManagedFeatures.filter = true;
                            if (w.action_uvc) {
                                await this.setFeature('uvc', true);
                                this._pvManagedFeatures.uvc = true;
                            }
                        }
                    } catch (err) {
                        this._pvActive = false;
                        this.log.error(`PV: activation FAILED – ${err.message}`);
                        break;
                    }
                }
                if (this._pvActive) {
this.enableRapidPolling();
}
            } else {
                // Surplus recovered while staging was in progress → re-activate what was turned off
                await this._pvReactivate(pvWindows, surplus);
            }

        // ── Surplus recovered while debounce timer runs ───────────────────
        } else if (this._pvActive && !shouldDeactivate && this._pvDeactivateTimer && !this._pvStageTimer) {
            await this._pvCancelAllDeactivationTimers();
            this.log.info(`PV: surplus recovered (${surplus} W ≥ ${offAt} W) – deactivation cancelled`);

        // ── Surplus gone: start debounce before staged deactivation ──────
        } else if (this._pvActive && shouldDeactivate && !this._pvDeactivateTimer && !this._pvStageTimer) {
            const delayMin   = cfg.pv_deactivate_delay_min ?? 5;
            const debounceMs = delayMin * 60_000;
            this.log.info(`PV: surplus below threshold (${surplus} W < ${offAt} W) – waiting ${delayMin} min (cloud cover protection)`);

            this._pvDeactivateCountdown = delayMin;
            await this.setStateAsync('computed.pv_deactivate_remaining', delayMin, true);
            if (this._pvDeactivateCountdownInt) {
clearInterval(this._pvDeactivateCountdownInt);
}
            this._pvDeactivateCountdownInt = setInterval(async () => {
                this._pvDeactivateCountdown = Math.max(0, this._pvDeactivateCountdown - 1);
                await this.setStateAsync('computed.pv_deactivate_remaining', this._pvDeactivateCountdown, true);
            }, 60_000);

            this._pvDeactivateTimer = setTimeout(async () => {
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; 
}
                this._pvDeactivateCountdown = 0;
                await this.setStateAsync('computed.pv_deactivate_remaining', 0, true);

                this.log.info('PV: debounce elapsed – starting staged deactivation');
                await notificationHelper.send(notificationHelper.format('pvDeactivated'));
                this._pvActive = false;
                await this._pvStagedDeactivate(pvWindows, false);
            }, debounceMs);

        } else {
            this.log.debug(`PV: no action (pvActive=${this._pvActive}, shouldActivate=${shouldActivate}, shouldDeactivate=${shouldDeactivate}, debounce=${!!this._pvDeactivateTimer}, staging=${!!this._pvStageTimer})`);
        }
    }

    // -------------------------------------------------------------------------
    // PV: Cancel all deactivation timers (debounce + stage)
    // -------------------------------------------------------------------------
    async _pvCancelAllDeactivationTimers() {
        if (this._pvDeactivateTimer)        {
 clearTimeout(this._pvDeactivateTimer);   this._pvDeactivateTimer = null; 
}
        if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; 
}
        if (this._pvStageTimer)             {
 clearTimeout(this._pvStageTimer);         this._pvStageTimer = null; 
}
        this._pvDeactivateCountdown = 0;
        await this.setStateAsync('computed.pv_deactivate_remaining', 0, true);
    }

    // -------------------------------------------------------------------------
    // PV: Re-activate features that were turned off during staging
    // -------------------------------------------------------------------------
    async _pvReactivate(pvWindows, surplus) {
        this.log.info(`PV: surplus recovered during staging (${surplus} W) – re-activating managed features`);
        for (const w of pvWindows) {
            try {
                if (w.action_heating && !this._pvManagedFeatures.heater) {
                    if (!w.action_filter && !this._pvManagedFeatures.filter) {
                        await this.setFeature('filter', true);
                        this._pvManagedFeatures.filter = true;
                    }
                    await this.setFeature('heater', true);
                    this._pvManagedFeatures.heater = true;
                    if (w.target_temp) {
await this.setTargetTemp(w.target_temp);
}
                }
                if (w.action_uvc && !this._pvManagedFeatures.uvc && this._pvManagedFeatures.filter) {
                    await this.setFeature('uvc', true);
                    this._pvManagedFeatures.uvc = true;
                }
            } catch (err) {
                this.log.error(`PV: re-activation FAILED – ${err.message}`);
            }
        }
        this.enableRapidPolling();
    }

    // -------------------------------------------------------------------------
    // PV: Staged deactivation  heater → UVC → filter
    //
    //  Stage 1 (immediate)  : heater OFF
    //    – if firmware already reached target temp (heat_state=4) the heater
    //      is already idle; we still clear the flag but skip the API call.
    //  Stage 2 (after delay): UVC OFF – but only if daily minimum hours are met.
    //    – if minimum not met yet → keep UVC running, re-check after stageDelay.
    //  Stage 3 (after delay): filter OFF
    //    – UVC is forced off here if still on.
    //    – filter is only stopped if the firmware is NOT actively heating
    //      (heat_state 2/3 means the firmware still needs the pump circulating).
    //
    //  immediate=true skips inter-stage delays (season-end / manual shutdown).
    // -------------------------------------------------------------------------
    async _pvStagedDeactivate(pvWindows, immediate = false) {
        const cfg          = this.config;
        const stageDelayMs = immediate ? 0 : (cfg.pv_stage_delay_min ?? 2) * 60_000;
        const uvcMinH      = cfg.uvc_daily_min_h ?? 2;

        // Helper: get current firmware heat_state from last polled data
        const heatState = () => (this._lastData && this._lastData.heat_state) || 0;
        // heat_state: 0=off, 2=preheat, 3=heating, 4=idle (target reached)
        const firmwareActivelyHeating = () => [2, 3].includes(heatState());

        // ── Stage 1: Heater OFF (instant) ────────────────────────────────────
        if (this._pvManagedFeatures.heater) {
            if (heatState() === 4) {
                // Firmware already reached target temperature and set heater to idle
                // → no API call needed, just clear our tracking flag
                this.log.info('PV staged shutdown [1/3]: heater already idle (target temp reached by firmware) – skipping API call');
            } else {
                try {
                    this.log.info(`PV staged shutdown [1/3]: heater OFF (heat_state=${heatState()})`);
                    await this.setFeature('heater', false);
                } catch (err) {
                    this.log.error(`PV staged shutdown [1/3]: heater OFF FAILED – ${err.message}`);
                }
            }
            this._pvManagedFeatures.heater = false;
            this.enableRapidPolling();
        }

        // If filter was only started for the heater (action_filter=false) and UVC is
        // also off → filter off immediately (unless firmware is still heating)
        const anyFilterUvcManaged = pvWindows.some(w => w.action_filter);
        if (!anyFilterUvcManaged && !this._pvManagedFeatures.uvc) {
            if (this._pvManagedFeatures.filter) {
                if (firmwareActivelyHeating()) {
                    // Firmware still uses the pump → leave it, re-check after stage delay
                    this.log.info(`PV staged shutdown [1/3]: filter kept ON – firmware actively heating (heat_state=${heatState()}), will re-check`);
                    this._pvStageTimer = setTimeout(async () => {
                        this._pvStageTimer = null;
                        if (firmwareActivelyHeating()) {
                            this.log.info(`PV staged shutdown: firmware still heating (heat_state=${heatState()}) – filter stays on for now`);
                        } else {
                            try {
 await this.setFeature('filter', false); this._pvManagedFeatures.filter = false; 
} catch (_) { /* ignore */ }
                            this.log.info('PV staged shutdown: heating-only filter now OFF');
                        }
                        this.enableRapidPolling();
                    }, stageDelayMs || 120_000);
                    return;
                }
                try {
 await this.setFeature('filter', false); this._pvManagedFeatures.filter = false; 
} catch (_) { /* ignore */ }
                this.log.debug('PV staged shutdown: heating-only filter OFF');
            }
            this.enableRapidPolling();
            return;
        }

        // ── Stage 2: UVC OFF (after delay, if daily minimum reached) ─────────
        const runStage2 = async () => {
            if (this._pvManagedFeatures.uvc) {
                const todayH = this._getUvcTodayHours();
                if (todayH >= uvcMinH || immediate) {
                    this.log.info(`PV staged shutdown [2/3]: UVC OFF (today ${todayH.toFixed(2)} h ≥ min ${uvcMinH} h)`);
                    try {
 await this.setFeature('uvc', false); this._pvManagedFeatures.uvc = false; 
} catch (err) {
                        this.log.error(`PV staged shutdown [2/3]: UVC OFF FAILED – ${err.message}`);
                    }
                } else {
                    // Daily minimum not yet met → keep UVC + filter running, retry after delay
                    const remaining = (uvcMinH - todayH).toFixed(2);
                    this.log.info(`PV staged shutdown [2/3]: UVC kept ON (today ${todayH.toFixed(2)} h, need ${uvcMinH} h, ${remaining} h remaining) – re-checking in ${cfg.pv_stage_delay_min ?? 2} min`);
                    this._pvStageTimer = setTimeout(runStage2, stageDelayMs || 120_000);
                    return; // don't proceed to stage 3 yet
                }
            }

            // ── Stage 3: Filter OFF ──────────────────────────────────────────
            const runStage3 = async () => {
                // UVC must be off before filter (hardware dependency)
                if (this._pvManagedFeatures.uvc) {
                    this.log.info('PV staged shutdown [3/3]: UVC OFF (forced before filter stop)');
                    try {
 await this.setFeature('uvc', false); this._pvManagedFeatures.uvc = false; 
} catch (err) {
                        this.log.error(`PV staged shutdown [3/3]: UVC OFF FAILED – ${err.message}`);
                    }
                }
                if (this._pvManagedFeatures.filter) {
                    if (!immediate && firmwareActivelyHeating()) {
                        // Firmware is still heating (e.g. it re-activated itself or preheat) →
                        // don't fight the firmware, leave filter on and retry
                        this.log.info(`PV staged shutdown [3/3]: filter kept ON – firmware actively heating (heat_state=${heatState()}), will re-check in ${cfg.pv_stage_delay_min ?? 2} min`);
                        this._pvStageTimer = setTimeout(runStage3, stageDelayMs || 120_000);
                        return;
                    }
                    this.log.info(`PV staged shutdown [3/3]: filter OFF (heat_state=${heatState()})`);
                    try {
 await this.setFeature('filter', false); this._pvManagedFeatures.filter = false; 
} catch (err) {
                        this.log.error(`PV staged shutdown [3/3]: filter OFF FAILED – ${err.message}`);
                    }
                }
                this._pvStageTimer = null;
                this.log.info('PV staged shutdown: complete');
                this.enableRapidPolling();
            };

            if (immediate || stageDelayMs === 0) {
                await runStage3();
            } else {
                this._pvStageTimer = setTimeout(runStage3, stageDelayMs);
            }
        };

        if (immediate || stageDelayMs === 0) {
            await runStage2();
        } else {
            this._pvStageTimer = setTimeout(runStage2, stageDelayMs);
        }
    }

    // -------------------------------------------------------------------------
    // UVC daily minimum – independent scheduler
    // -------------------------------------------------------------------------
    /**
     * Starts a 1-minute interval that ensures the UVC lamp runs for at least
     * uvc_daily_min_h hours per calendar day.
     *
     * From the configured uvc_daily_ensure_time (HH:MM, default 10:00) onwards,
     * if today's UVC operating hours are below the daily minimum, the adapter
     * automatically turns on filter + UVC until the minimum is reached.
     * This runs independently of PV surplus, time windows and season.
     * Manual override pauses the ensure-run.
     */
    initUvcDailyEnsure() {
        const cfg    = this.config;
        const minH   = cfg.uvc_daily_min_h ?? 2;
        if (!minH || minH <= 0) {
            this.log.debug('UVC daily ensure: disabled (uvc_daily_min_h = 0)');
            return;
        }
        const ensureTime = cfg.uvc_daily_ensure_time || '10:00';
        this.log.info(`UVC daily ensure: active – minimum ${minH} h/day, starts checking from ${ensureTime}`);

        // Run immediately, then align to next full minute
        this.checkUvcDailyMinimum();
        const now     = new Date();
        const msToMin = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
        setTimeout(() => {
            this.checkUvcDailyMinimum();
            this._uvcEnsureTimer = setInterval(() => this.checkUvcDailyMinimum(), 60_000);
        }, msToMin);
    }

    async checkUvcDailyMinimum() {
        const cfg  = this.config;
        const minH = cfg.uvc_daily_min_h ?? 2;
        if (!minH || minH <= 0) {
return;
}

        // Manual override pauses all automations including this
        if (this._manualOverride) {
            if (this._uvcEnsureActive) {
                this.log.info('UVC daily ensure: paused by manual override');
                await this._stopUvcEnsure();
            }
            return;
        }

        // Date change detection early: reset skip flag at midnight
        const today = this._todayStr();
        if (this._uvcEnsureSkipToday) {
            // Compare against _uvcEnsureDate OR _uvcEnsureSkipDate (set when skip was activated)
            const skipDate = this._uvcEnsureSkipDate || this._uvcEnsureDate;
            if (!skipDate || skipDate !== today) {
                this.log.info('UVC daily ensure: new day – skip flag reset');
                this._uvcEnsureSkipToday = false;
                this._uvcEnsureSkipDate  = '';
                await this.setStateAsync('control.uvc_ensure_skip_today', false, true);
            }
        }

        // User requested to skip ensure for today
        if (this._uvcEnsureSkipToday) {
            if (this._uvcEnsureActive) {
                this.log.info('UVC daily ensure: skipped by user request – stopping');
                await this._stopUvcEnsure();
            }
            return;
        }

        // Outside season (season_enabled=false) → no bathing operation → skip UVC ensure.
        // Winter mode alone (season_enabled=false + winter_mode=true) only runs frost
        // protection; no UVC needed.
        // UVC ensure only makes sense when the pool is in active bathing season.
        if (!this._seasonEnabled) {
            if (this._uvcEnsureActive) {
                this.log.info('UVC daily ensure: season disabled – stopping ensure run');
                await this._stopUvcEnsure();
            }
            return;
        }

        // If frost protection is currently heating, the filter is already running for
        // that purpose. We can still track UVC hours but we should NOT start a new
        // ensure-run on top of an active frost-protection cycle to avoid confusion.
        // (UVC will be started/stopped independently once frost cycle ends.)
        if (this._winterFrostActive) {
            this.log.debug('UVC daily ensure: frost protection active – deferring UVC ensure until frost cycle ends');
            return;
        }

        const ensureTime = cfg.uvc_daily_ensure_time || '10:00';
        const now        = new Date();
        const [hh, mm]   = ensureTime.split(':').map(Number);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const ensureMin  = (hh || 0) * 60 + (mm || 0);

        const todayH = this._getUvcTodayHours();

        // Date change detection – stop any active ensure-run at midnight
        if (this._uvcEnsureActive && this._uvcEnsureDate && this._uvcEnsureDate !== today) {
            this.log.info('UVC daily ensure: new day detected – stopping previous session');
            await this._stopUvcEnsure();
        }

        this.log.debug(`UVC daily ensure: today=${todayH.toFixed(2)} h, min=${minH} h, ensureFrom=${ensureTime}, nowMin=${nowMinutes}, ensureMin=${ensureMin}, active=${this._uvcEnsureActive}, winterFrost=${this._winterFrostActive}`);

        if (todayH >= minH) {
            // Daily minimum already reached
            if (this._uvcEnsureActive) {
                this.log.info(`UVC daily ensure: daily minimum reached (${todayH.toFixed(2)} h ≥ ${minH} h) – stopping`);
                await this._stopUvcEnsure();
            }
            return;
        }

        // Not enough hours yet – should we start?
        if (nowMinutes < ensureMin) {
            this.log.debug(`UVC daily ensure: too early (${ensureTime} not reached yet) – waiting`);
            return;
        }

        // Time to ensure the minimum → start if not already running
        if (!this._uvcEnsureActive) {
            const remaining = (minH - todayH).toFixed(2);
            this.log.info(`UVC daily ensure: starting (${todayH.toFixed(2)} h today, need ${minH} h, ${remaining} h remaining)`);
            await notificationHelper.send(notificationHelper.format('uvcEnsureStarted', { remaining }));
            this._uvcEnsureActive = true;
            this._uvcEnsureDate   = today;
            try {
                // Start filter pump if not already running
                const filterState = await this.getStateAsync('control.filter');
                if (!filterState || !filterState.val) {
                    await this.setFeature('filter', true);
                    this._uvcEnsureFilterStart = true;
                    this.log.debug('UVC daily ensure: filter started');
                } else {
                    this._uvcEnsureFilterStart = false;
                    this.log.debug('UVC daily ensure: filter already running');
                }
                // Start UVC if not already on
                const uvcState = await this.getStateAsync('control.uvc');
                if (!uvcState || !uvcState.val) {
                    await this.setFeature('uvc', true);
                    this.log.debug('UVC daily ensure: UVC started');
                }
                this.enableRapidPolling();
            } catch (err) {
                this._uvcEnsureActive      = false;
                this._uvcEnsureFilterStart = false;
                this.log.error(`UVC daily ensure: start FAILED – ${err.message}`);
            }
        }
    }

    async _stopUvcEnsure() {
        this._uvcEnsureActive = false;
        try {
            await this.setFeature('uvc', false);
            this.log.debug('UVC daily ensure: UVC stopped');
            if (this._uvcEnsureFilterStart) {
                // Only stop the filter if frost protection is NOT currently running –
                // the frost protection needs the filter pump for safe operation.
                if (this._winterFrostActive) {
                    this.log.debug('UVC daily ensure: filter kept ON – frost protection is active');
                } else {
                    await this.setFeature('filter', false);
                    this.log.debug('UVC daily ensure: filter stopped (was started by ensure)');
                }
                this._uvcEnsureFilterStart = false;
            }
            this.enableRapidPolling();
        } catch (err) {
            this.log.error(`UVC daily ensure: stop FAILED – ${err.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // UVC: today's operating hours (resets automatically at date change)
    // -------------------------------------------------------------------------
    _getUvcTodayHours() {
        const today = this._todayStr();
        if (this._uvcDayStartDate !== today) {
            // New calendar day → snapshot current total as the new day's baseline
            this._uvcDayStartHours = this._uvcHoursUsed;  // persisted value (current session not yet flushed)
            this._uvcDayStartDate  = today;
            this.log.debug(`UVC: new day detected – day-start snapshot: ${this._uvcDayStartHours.toFixed(2)} h`);
        }
        return Math.max(0, this._accumulateUvcHours() - this._uvcDayStartHours);
    }

    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // -------------------------------------------------------------------------
    // State management
    // -------------------------------------------------------------------------
    async createStates() {
        const channels = ['info', 'status', 'computed', 'device', 'control', 'consumption'];
        for (const channel of channels) {
            await this.setObjectNotExistsAsync(channel, {
                type: 'channel',
                common: { name: channel },
                native: {},
            });
        }

        // consumption states (only created, values are set by consumptionHelper)
        const consumptionStates = {
            'consumption.day_kwh':        { name: 'Daily consumption (kWh)',              unit: 'kWh', type: 'number' },
            'consumption.last_total_kwh': { name: 'Raw meter value at day start (kWh)',   unit: 'kWh', type: 'number' },
            'consumption.day_start_date': { name: 'Date of last day-start baseline (YYYY-MM-DD)', unit: '', type: 'string' },
        };
        for (const [id, def] of Object.entries(consumptionStates)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name: def.name, type: def.type || 'number', role: def.type === 'string' ? 'text' : 'value.power.consumption', unit: def.unit, read: true, write: false, def: def.type === 'string' ? '' : 0 },
                native: {},
            });
        }

        await this.setObjectNotExistsAsync('status.uvc_expiry_date', {
            type: 'state',
            common: { name: 'UVC lamp expiry date', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });

        await this.setObjectNotExistsAsync('status.time_windows_json', {
            type: 'state',
            common: { name: 'Configured time windows (JSON)', type: 'string', role: 'json', read: true, write: false, def: '[]' },
            native: {},
        });

        await this.setObjectNotExistsAsync('computed.pv_deactivate_remaining', {
            type: 'state',
            common: { name: 'PV deactivate delay remaining (min)', type: 'number', role: 'value', unit: 'min', read: true, write: false, def: 0 },
            native: {},
        });

        for (const [id, def] of Object.entries(STATE_DEFS)) {
            const common = {
                id:    id,
                name:  def.name,
                role:  def.role,
                type:  def.type,
                read:  def.read,
                write: def.write,
                def:   def.def !== undefined ? def.def : (def.type === 'boolean' ? false : (def.min ?? 0)),
            };
            if (def.unit   !== undefined) {
 common.unit   = def.unit;   
}
            if (def.min    !== undefined) {
 common.min    = def.min;    
}
            if (def.max    !== undefined) {
 common.max    = def.max;    
}
            if (def.states !== undefined) {
 common.states = def.states; 
}

            await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });

            const existing = await this.getObjectAsync(id);
            if (existing) {
                existing.common = { ...existing.common, ...common };
                await this.setObjectAsync(id, existing);
            }
        }
    }

    async updateDeviceInfo() {
        const api = this._api;
        await this.setStateAsync('device.model',           api.model           || '', true);
        await this.setStateAsync('device.series',          api.series          || '', true);
        await this.setStateAsync('device.softwareVersion', api.softwareVersion || '', true);
        await this.setStateAsync('device.wifiVersion',     api.wifiVersion     || '', true);
        await this.setStateAsync('device.mcuVersion',      api.mcuVersion      || '', true);
        await this.setStateAsync('device.serialNumber',    api.serialNumber    || '', true);
        await this.setStateAsync('device.alias',           api.deviceAlias     || '', true);
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
            await this.updateDeviceInfo();
            await this.setStateAsync('info.connection', true, true);
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

            const data     = transformStatus(raw);
            this._lastData = data;

            await this.publishStatus(data);
            await this.checkFrostProtection(data);
            await this.checkPowerCycle(data);
            await this.checkAdaptivePolling(data);
            await this.setStateAsync('info.connection', true, true);
            await this.setStateAsync('info.lastUpdate', Date.now(), true);
            this._consecutiveErrors = 0;

        } catch (err) {
            this._consecutiveErrors++;
            this.log.error(`MSpa poll error (${this._consecutiveErrors}): ${err.message}`);
            await this.setStateAsync('info.connection', false, true);

            if (this._consecutiveErrors <= this._maxReconnectTries) {
                this.log.info(`MSpa attempting reconnect (try ${this._consecutiveErrors}/${this._maxReconnectTries})…`);
                const reconnected = await this.tryReconnect();
                if (reconnected) {
                    this.log.info('MSpa reconnect successful – retrying poll immediately');
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
        const set = async (id, val) => {
            if (val !== undefined && val !== null) {
                await this.setStateChangedAsync(id, val, true);
            }
        };

        await set('status.water_temperature', data.water_temperature);
        await set('status.target_temperature', data.target_temperature);
        await set('status.fault',              data.fault);
        await set('status.heat_state',         data.heat_state);
        await set('status.bubble_level',       data.bubble_level);
        await set('status.is_online',          !!data.is_online);
        await set('status.filter_current',     data.filter_current);
        await set('status.filter_life',        data.filter_life);
        await set('status.temperature_unit',   data.temperature_unit);
        await set('status.safety_lock',        data.safety_lock);
        await set('status.heat_time_switch',   !!data.heat_time_switch);
        await set('status.heat_time',          data.heat_time);

        const setCtrl = async (id, val) => {
            if (val !== undefined && val !== null) {
                await this.setStateAsync(id, val, true);
            }
        };
        await setCtrl('control.heater',             data.heater  === 'on');
        await setCtrl('control.filter',             data.filter  === 'on');
        await setCtrl('control.bubble',             data.bubble  === 'on');
        await setCtrl('control.jet',                data.jet     === 'on');
        await setCtrl('control.ozone',              data.ozone   === 'on');
        await setCtrl('control.uvc',                data.uvc     === 'on');

        // ── External app-change detection ────────────────────────────────────
        // Compare what the device reports with what the adapter last commanded.
        // If they differ (and we are not in manual override already, and automations
        // are active) → someone used the MSpa app → set manual_override automatically.
        if (!this._manualOverride && this._seasonEnabled) {
            const cfg          = this.config;
            const autoOverrideDuration = cfg.app_change_override_min ?? 30;
            const checks = [
                { key: 'heater', deviceVal: data.heater === 'on' },
                { key: 'filter', deviceVal: data.filter === 'on' },
                { key: 'uvc',    deviceVal: data.uvc    === 'on' },
            ];
            // target_temperature: only flag if heater is on and temp differs by > 0.5°C
            if (data.heater === 'on' && this._adapterCommanded.target_temperature !== null) {
                const diff = Math.abs((data.target_temperature || 0) - this._adapterCommanded.target_temperature);
                if (diff > 0.5) {
                    checks.push({ key: 'target_temperature', deviceVal: data.target_temperature });
                }
            }

            for (const { key, deviceVal } of checks) {
                const commanded = this._adapterCommanded[key];
                if (commanded === null) {
continue;
}  // adapter hasn't commanded this yet
                const mismatch = (key === 'target_temperature')
                    ? deviceVal !== commanded
                    : deviceVal !== commanded;
                if (mismatch) {
                    this.log.info(`App change detected: ${key} is ${JSON.stringify(deviceVal)} on device but adapter last set it to ${JSON.stringify(commanded)} – activating manual override (${autoOverrideDuration} min)`);
                    await notificationHelper.send(notificationHelper.format('appChangeDetected', { key, duration: autoOverrideDuration }));
                    // Update _adapterCommanded to current device state so we don't keep re-triggering
                    this._adapterCommanded[key] = deviceVal;
                    await this._setManualOverride(true, autoOverrideDuration > 0 ? autoOverrideDuration : null);
                    break; // one trigger is enough
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── Firmware target-temperature reached (heat_state = 4 = idle) ──────
        // If PV is controlling the heater and the firmware just completed a heating
        // cycle, we don't need to send heater-OFF ourselves. However we should start
        // the staged shutdown for UVC/filter so they don't run unnecessarily.
        if (this._pvActive && !this._pvStageTimer && !this._pvDeactivateTimer &&
            data.heat_state === 4 && this._pvManagedFeatures.heater === false &&
            (this._pvManagedFeatures.filter || this._pvManagedFeatures.uvc)) {
            const cfg       = this.config;
            const pvWindows = (cfg.timeWindows || []).filter(w => w.active && w.pv_steu);
            if (pvWindows.length > 0) {
                this.log.info(`PV: firmware reached target temperature (heat_state=4) – starting staged shutdown for UVC/filter`);
                // Stage 1 already done by firmware; go directly to stage 2
                this._pvActive = false;
                await this._pvStagedDeactivate(pvWindows, false);
            }
        }
        // ─────────────────────────────────────────────────────────────────────
        // The firmware can independently turn off the heater when the target
        // temperature is reached (heat_state → 4/idle). If we see that a feature
        // we thought we were managing is now OFF on the device, update our tracking
        // so the staged-deactivation logic doesn't fight the firmware.
        if (this._pvActive || this._pvStageTimer) {
            if (this._pvManagedFeatures.heater && data.heater !== 'on') {
                this.log.debug(`PV: heater is OFF on device (heat_state=${data.heat_state}) – syncing _pvManagedFeatures.heater`);
                this._pvManagedFeatures.heater = false;
            }
            if (this._pvManagedFeatures.uvc && data.uvc !== 'on') {
                this.log.debug('PV: UVC is OFF on device – syncing _pvManagedFeatures.uvc');
                this._pvManagedFeatures.uvc = false;
            }
            if (this._pvManagedFeatures.filter && data.filter !== 'on') {
                this.log.debug('PV: filter is OFF on device – syncing _pvManagedFeatures.filter');
                this._pvManagedFeatures.filter = false;
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        // ── UVC operating hours tracking ───────────────────────────────────
        const uvcIsOn = data.uvc === 'on';
        if (uvcIsOn && this._uvcOnSince === null) {
            // UVC just turned ON
            this._uvcOnSince = Date.now();
            this.log.debug('UVC ON – started tracking operating hours');
        } else if (!uvcIsOn && this._uvcOnSince !== null) {
            // UVC just turned OFF → accumulate elapsed hours
            this._uvcHoursUsed = this._accumulateUvcHours();
            this._uvcOnSince   = null;
            this.log.debug(`UVC OFF – total hours used: ${this._uvcHoursUsed.toFixed(2)} h`);
            await this.setStateAsync('status.uvc_hours_used', { val: Math.round(this._uvcHoursUsed * 100) / 100, ack: true });
            await this.computeUvcExpiry();
        }
        // Always publish current accumulated value (including current session)
        await this.setStateChangedAsync('status.uvc_hours_used', Math.round(this._accumulateUvcHours() * 100) / 100, true);
        await this.setStateChangedAsync('status.uvc_today_hours', Math.round(this._getUvcTodayHours() * 100) / 100, true);
        // ──────────────────────────────────────────────────────────────────
        await setCtrl('control.target_temperature', data.target_temperature);
        await setCtrl('control.bubble_level',       data.bubble_level);

        const isHeating = data.heat_state === 3;
        const heatRate  = this._heatTracker.update(data.water_temperature, isHeating, true);
        if (heatRate !== null) {
            await set('computed.heat_rate_per_hour', Math.round(heatRate * 100) / 100);
        }

        const isNotHeating = ![2, 3].includes(data.heat_state);
        const coolRate = this._coolTracker.update(data.water_temperature, isNotHeating, false);
        if (coolRate !== null) {
            await set('computed.cool_rate_per_hour', Math.round(coolRate * 100) / 100);
        }
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
    }

    // -------------------------------------------------------------------------
    // Power cycle detection + state restore
    // -------------------------------------------------------------------------
    async checkPowerCycle(data) {
        const currentOnline = !!data.is_online;
        let   powerCycle    = false;

        if (this._lastIsOnline !== null) {
            if (this._lastIsOnline && !currentOnline) {
                this.log.info('MSpa power OFF detected – saving state');
                this._savedState = {
                    heater:             data.heater,
                    target_temperature: data.target_temperature,
                    filter:             data.filter,
                    temperature_unit:   data.temperature_unit,
                    ozone:              data.ozone,
                    uvc:                data.uvc,
                };
            } else if (!this._lastIsOnline && currentOnline) {
                powerCycle = true;
                this.log.info('MSpa power ON detected (is_online transition)');
            }
        }

        if (!powerCycle && Object.keys(this._lastSnapshot).length) {
            const changes = [];
            if (this._lastSnapshot.temperature_unit === 0 && data.temperature_unit === 1) {
                changes.push('temp_unit_reset');
            }
            if (this._lastSnapshot.heater === 'on ' && data.heater  === 'off') {
                changes.push('heater_off');
            }
            if (this._lastSnapshot.filter === 'on ' && data.filter  === 'off') {
                changes.push('filter_off');
            }
            if (this._lastSnapshot.ozone  === 'on ' && data.ozone   === 'off') {
                changes.push('ozone_off');
            }
            if (this._lastSnapshot.uvc    === 'on ' && data.uvc     === 'off') {
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
            this.log.info('MSpa enforcing temperature unit → Celsius');
            await this._api.setTemperatureUnit(desired);
        }
    }

    async restoreSavedState() {
        this.log.info('MSpa restoring state after power cycle…');
        await this.sleep(2000);

        if (this._savedState.target_temperature) {
            await this.safeCmd(() => this.setTargetTemp(this._savedState.target_temperature), 'temperature');
        }
        for (const feature of ['heater', 'filter', 'ozone', 'uvc']) {
            if (this._savedState[feature] === 'on') {
                await this.safeCmd(() => this.setFeature(feature, true), feature);
                await this.sleep(500);
            }
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
        const cfg         = this.config;
        const winterMode  = this._winterModeActive;
        if (!winterMode) {
            // if frost was active but winter mode got disabled → switch off
            if (this._winterFrostActive) {
                this._winterFrostActive = false;
                this.log.info('Winter mode: disabled – switching heater + filter OFF');
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
            this.log.info(`Winter mode: temp ${temp}°C ≤ ${threshold}°C – switching heater + filter ON`);
            await notificationHelper.send(notificationHelper.format('frostActive', { temp, threshold }));
            await this.setFeature('filter', true);
            await this.setFeature('heater', true);
            this.enableRapidPolling();
        } else if (this._winterFrostActive && temp >= threshold + hysteresis) {
            this._winterFrostActive = false;
            this.log.info(`Winter mode: temp ${temp}°C ≥ ${threshold + hysteresis}°C – switching heater + filter OFF`);
            await notificationHelper.send(notificationHelper.format('frostDeactivated', { temp, hysteresis: threshold + hysteresis }));
            await this.setFeature('heater', false);
            await this.setFeature('filter', false);
            this.enableRapidPolling();
            // Frost cycle ended → immediately re-evaluate UVC daily minimum
            // (was deferred while frost was active)
            this.checkUvcDailyMinimum().catch(e => this.log.error(`UVC daily ensure trigger after frost: ${e.message}`));
        }
    }

    async setFeature(feature, boolVal) {
        const state = boolVal ? 1 : 0;
        if (feature in this._adapterCommanded) {
            this._adapterCommanded[feature] = boolVal;
        }
        switch (feature) {
            case 'heater': return this._api.setHeaterState(state);
            case 'filter': return this._api.setFilterState(state);
            case 'bubble': return this._api.setBubbleState(state, this._lastData.bubble_level || 1);
            case 'jet':    return this._api.setJetState(state);
            case 'ozone':  return this._api.setOzoneState(state);
            case 'uvc':    return this._api.setUvcState(state);
        }
    }

    async setTargetTemp(temp) {
        this._adapterCommanded.target_temperature = temp;
        return this._api.setTemperatureSetting(temp);
    }

    // -------------------------------------------------------------------------
    // Manual override – pausiert alle Automationen (Zeitfenster, PV, Frostschutz)
    // -------------------------------------------------------------------------
    async _setManualOverride(enable, durationMin = null) {
        // cancel any existing auto-reset timer
        if (this._manualOverrideTimer) {
            clearTimeout(this._manualOverrideTimer);
            this._manualOverrideTimer = null;
        }

        this._manualOverride = enable;
        await this.setStateAsync('control.manual_override', enable, true);

        if (enable) {
            // read duration from state if not explicitly passed
            if (durationMin === null) {
                const ds = await this.getStateAsync('control.manual_override_duration');
                durationMin = ds && ds.val !== null ? Number(ds.val) : 0;
            } else {
                await this.setStateAsync('control.manual_override_duration', durationMin, true);
            }

            if (durationMin > 0) {
                this.log.info(`Manual override: ENABLED for ${durationMin} min – all automations paused`);
                await notificationHelper.send(notificationHelper.format('overrideOnTimed', { durationMin }));
                this._manualOverrideTimer = setTimeout(async () => {
                    this._manualOverrideTimer = null;
                    this.log.info('Manual override: duration elapsed – automations RESUMED');
                    await notificationHelper.send(notificationHelper.format('overrideEnded'));
                    this._manualOverride = false;
                    await this.setStateAsync('control.manual_override', false, true);
                    await this.setStateAsync('control.manual_override_duration', 0, true);
                }, durationMin * 60 * 1000);
            } else {
                this.log.info('Manual override: ENABLED indefinitely – all automations paused (set to false to resume)');
                await notificationHelper.send(notificationHelper.format('overrideOnIndefinite'));
            }
        } else {
            this.log.info('Manual override: DISABLED – all automations RESUMED');
            await notificationHelper.send(notificationHelper.format('overrideOff'));
            await this.setStateAsync('control.manual_override_duration', 0, true);
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
        if (!state || state.ack) {
            return;
        }

        const key = id.split('.').pop();

        try {
            if (['heater', 'filter', 'bubble', 'jet', 'ozone', 'uvc'].includes(key)) {
                this.log.info(`MSpa command: ${key} → ${state.val}`);
                await this.setFeature(key, !!state.val);
                this.enableRapidPolling();
            } else if (key === 'target_temperature') {
                this.log.info(`MSpa command: set temperature → ${state.val}°C`);
                await this.setTargetTemp(state.val);
                this.enableRapidPolling();
            } else if (key === 'bubble_level') {
                this.log.info(`MSpa command: bubble level → ${state.val}`);
                await this._api.setBubbleLevel(state.val);
                this.enableRapidPolling();
            } else if (key === 'winter_mode') {
                this._winterModeActive = !!state.val;
                this.log.info(`Winter mode: ${this._winterModeActive ? 'ENABLED' : 'DISABLED'} via control state`);
                await this.setStateAsync('control.winter_mode', this._winterModeActive, true);
                // run frost check immediately with last known data
                if (this._lastData) {
await this.checkFrostProtection(this._lastData);
}
            } else if (key === 'season_enabled') {
                this._seasonEnabled = !!state.val;
                this.log.info(`Season control: ${this._seasonEnabled ? 'ENABLED' : 'DISABLED'} via control state`);
                await this.setStateAsync('control.season_enabled', this._seasonEnabled, true);

            } else if (key === 'manual_override') {
                const enable = !!state.val;
                await this._setManualOverride(enable);

            } else if (key === 'uvc_ensure_skip_today') {
                const skip = !!state.val;
                this._uvcEnsureSkipToday = skip;
                this._uvcEnsureSkipDate  = skip ? this._todayStr() : '';
                await this.setStateAsync('control.uvc_ensure_skip_today', skip, true);
                if (skip) {
                    this.log.info('UVC daily ensure: skip requested by user – pausing for today');
                    await notificationHelper.send(notificationHelper.format('uvcEnsureSkipped'));
                    // stop immediately if currently running
                    if (this._uvcEnsureActive) {
                        await this._stopUvcEnsure();
                    }
                } else {
                    this.log.info('UVC daily ensure: skip cancelled – ensure active again');
                    // trigger immediate re-check so ensure starts without waiting up to 60s
                    this.checkUvcDailyMinimum().catch(e => this.log.error(`UVC ensure re-check: ${e.message}`));
                }

            } else if (key === 'manual_override_duration') {
                // duration change only relevant while override is active → restart timer
                if (this._manualOverride) {
                    await this._setManualOverride(true, Number(state.val) || 0);
                } else {
                    await this.setStateAsync('control.manual_override_duration', Number(state.val) || 0, true);
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
