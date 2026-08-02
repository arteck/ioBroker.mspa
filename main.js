'use strict';

/*
 * ioBroker MSpa Adapter  
 *
 */

const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const {MSpaApiClient, MSpaThrottle} = require('./lib/mspaApi');
const {RateTracker, setStray, todayStr, sleep} = require('./lib/utils');
const stateMgr = require('./lib/states');
const pvController = require('./lib/pv');
const uvcController = require('./lib/uvc');
const consumptionHelper = require('./lib/consumptionHelper');
const notificationHelper = require('./lib/notificationHelper');
const commands = require('./lib/commands');
const timeControl = require('./lib/timeControl');
const polling = require('./lib/polling');
const stateChangeHandler = require('./lib/stateChangeHandler');
const powerCycle = require('./lib/powerCycle');
const frostProtection = require('./lib/frostProtection');
const manualOverride = require('./lib/manualOverride');
const startupCheck = require('./lib/startupCheck');
const stateRestore = require('./lib/stateRestore');
const {CONSTANTS} = require('./lib/constants');

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------
class MspaAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({...options, name: 'mspa'});

        this._api = null;
        this._authStore = {token: null, throttle: new MSpaThrottle()};
        this._pollTimer = null;
        this._polling = false;  // true while doPoll() is executing (re-entrancy guard)
        this._pollInterval = CONSTANTS.DEFAULT_POLL_INTERVAL_MS;  // ms
        this._rapidUntil = 0;
        this._lastData = {};
        this._savedState = {};
        this._lastSnapshot = {};
        this._lastIsOnline = null;
        this._consecutiveErrors = 0;
        this._failedPollCount = 0;  // count consecutive failed polls; set is_online=false after 5
        this._maxReconnectTries = CONSTANTS.MAX_RECONNECT_TRIES;

        // What the adapter last commanded to the device (heater/filter/uvc/target_temp).
        // Used to detect external changes made via the MSpa app.
        // null means "unknown / not yet set by adapter" – no comparison for that feature.
        this._adapterCommanded = {
            heater: null, filter: null, bubble: null, uvc: null, ozone: null, jet: null, target_temperature: null,
        };

        // Timestamp of the last command sent by the adapter.
        // App-change detection is suppressed for 30 s after any adapter command
        // to avoid false positives while the device is still catching up.
        this._lastCommandTime = 0;

        // Physikalisch berechnete Heizrate für 2200 W Heizung / 930 L Wasser:
        //   t = (930 kg · 4186 J/kg·K · 1 K) / 2200 W = 1769 s ≈ 29,5 min/°C
        //   → theoretisches Maximum: ~2,03 °C/h
        //   Mit realen Verlusten (Isolation, Umgebung): 1,2 – 1,8 °C/h
        //   MAX_RATE = 3,5 °C/h  (+70 % Puffer für Sensor-Toleranz / kurze Heizphasen)
        //   MIN_RATE = 0,3 °C/h  (unterhalb = Rauschen oder Heizung steht still)
        //   minSampleMinutes = 20: bei ~30 min/°C braucht man mind. 15–20 min Fenster
        //   für eine stabile Messung; bei 60s-Polling = 20 Samples
        this._heatTracker = new RateTracker({min: CONSTANTS.HEAT_RATE_MIN, max: CONSTANTS.HEAT_RATE_MAX, minSampleMinutes: CONSTANTS.HEAT_SAMPLE_MINUTES});
        // Abkühlung: ohne Heizung kühlt 930 L Whirlpool i.d.R. 0,3–1,5 °C/h (je nach Außentemp.)
        this._coolTracker = new RateTracker({min: CONSTANTS.COOL_RATE_MIN, max: CONSTANTS.COOL_RATE_MAX, minSampleMinutes: CONSTANTS.COOL_SAMPLE_MINUTES});
        this._lastHeatRate = 0; // last positive heating rate (°C/h) for ETA calculation

        // PV surplus control
        this._pvPower = null;
        this._pvHouse = null;
        this._pvMspa = null;   // MSpa current power (W) from smart plug – used to correct house consumption
        this._pvActive = false;
        this._pvDeactivateTimer = null;  // debounce timer for deactivation
        this._pvDeactivateCountdown = 0;     // remaining minutes for deactivation delay
        this._pvDeactivateCountdownInt = null;  // 1-min interval for countdown
        this._pvStageTimer = null;  // timer between staged-deactivation steps
        // Tracks which features PV currently has switched ON
        // (heater/filter/uvc may differ from window config if staging is in progress)
        this._pvManagedFeatures = {heater: false, filter: false, uvc: false};

        // Manual override – pauses ALL automations (time windows, PV, frost protection)
        this._manualOverride = false;  // true = all automations paused
        this._manualOverrideTimer = null;   // auto-reset timer (optional duration)

        // Winter mode (frost protection)
        this._winterModeActive = false;  // runtime override (from control state)
        this._winterFrostActive = false;  // true while frost protection heating is running
        this._seasonEnabled = false;  // controlled exclusively via control.season_enabled state

        // Filter pump runtime tracking
        this._filterOnSince = null;  // Date.now() when filter turned ON, null when OFF
        this._filterHoursUsed = 0;     // accumulated runtime hours since last reset (persisted)

        // UVC lamp runtime tracking
        this._uvcOnSince = null;   // Date.now() when UVC turned ON, null when OFF
        this._uvcHoursUsed = 0;      // accumulated operating hours (persisted)
        this._uvcDayStartHours = 0;      // _uvcHoursUsed snapshot at start of today
        this._uvcDayStartDate = '';     // "YYYY-MM-DD" of the day _uvcDayStartHours was set
        this._uvcTodayResetDate = '';   // "YYYY-MM-DD" of the last first-window reset (once per day)
        // UVC daily minimum ensure
        this._uvcEnsureActive = false;  // true while adapter is running UVC to fill daily minimum
        this._uvcEnsureFilterStart = false;  // true if the ensure-run also started the filter pump
        this._uvcEnsureTimer = null;   // 1-min interval for daily ensure check
        this._uvcEnsureDate = '';     // date string of current ensure-run (for midnight reset)
        this._uvcEnsureSkipToday = false;  // true = user skipped ensure for today (resets at midnight)
        this._uvcEnsureSkipDate = '';     // date when skip was set (for midnight auto-reset)

        // Pending target temperature: stored when heater is not yet running;
        // sent 10 s after the heater is switched on (API only accepts temp while heating)
        this._pendingTargetTemp = null;   // desired temperature waiting for heater ON
        this._pendingTempTimer = null;   // setTimeout handle for 10 s delay

        // Time window control
        this._timeTimer = null;
        this._timeAlignTimer = null;  // setTimeout handle for minute-alignment before interval starts
        this._timeWindowActive = [false, false, false]; // state per window (1-3)
        this._filterStartedForUvc = [];  // per-window: true if filter was started as UVC prerequisite (action_filter=false, action_uvc=true)
        this._pumpFollowUpTimers = [];    // follow-up timers per window index

        this._firstPollDone = false; // true after first successful poll (used for startup device-state check)
        this._rawApiLogged = false;  // true after the raw API response has been logged once

        // Tracks which apiField-based states have been created for this specific device model.
        // States NOT in this set are not published in publishStatus() to avoid setting
        // non-existent ioBroker objects with zero-padded values.
        this._dynamicStateIds = new Set();

        // Tracks all "fire-and-forget" setTimeout handles so onUnload can clear
        // them and prevent late callbacks on a destroyed adapter.
        this._strayTimers = new Set();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async onReady() {
        this.log.info('MSpa adapter starting…');

        await this.createStates();

        const cfg = this.config;
        const email = cfg.email;
        const password = cfg.password ? crypto.createHash('md5').update(cfg.password).digest('hex') : '';
        const region = cfg.region || 'ROW';

        this._pollInterval = Math.max(CONSTANTS.MIN_POLL_INTERVAL_SECONDS, (cfg.pollInterval || 60)) * CONSTANTS.MS_PER_SECOND;

        this._api = new MSpaApiClient({
            email,
            password,
            region,
            authStore: this._authStore,
            log: (level, msg) => this.log[level] ? this.log[level](msg) : this.log.info(msg)
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
            this.setStray(() => {
                this.onReady().catch(e => this.log.error(`MSpa init retry failed: ${e.message}`));
            }, CONSTANTS.INIT_RETRY_DELAY_MS);
            return;
        }

        this.subscribeStates('control.*');
        this.subscribeStates('status.time_windows_json'); // writable – changes written back to adapter config
        this.subscribeStates('status.uvc_hours_used');   // writable – allows manual correction after lamp replacement

        await this._restorePersistedStates();

        await this.initPvControl();
        this.initTimeControl();
        await this.publishTimeWindowsJson();
        await consumptionHelper.init(this);
        notificationHelper.init(this);


        this.computeUvcExpiry().catch(e => this.log.error(`computeUvcExpiry: ${e.message}`));
        this.initUvcDailyEnsure();
        this.doPoll();
    }

    /**
     * Reads all persisted control states from the ioBroker DB and restores the
     * corresponding in-memory variables.
     *
     * MUST use getStateAsync() – NOT getState() – because the in-memory cache is
     * not yet populated at adapter start (subscribeStates() fills it asynchronously).
     *
     * Why in-memory variables and not direct state reads everywhere?
     * ──────────────────────────────────────────────────────────────
     *  1. _manualOverride: used as an *atomic guard* inside setManualOverride()
     *     between two awaits.  A getStateAsync() there would NOT be atomic and
     *     would re-introduce the race condition we just fixed.
     *  2. _seasonEnabled / _winterModeActive: read by the synchronous isInSeason()
     *     and checkFrostProtection() helpers that are called from the 60-s poll
     *     loop.  Making them async would cascade to >20 call sites.
     *  3. _winterFrostActive: hysteresis flag set *and* checked within the same
     *     synchronous checkFrostProtection() evaluation.  A state round-trip would
     *     break the hysteresis logic.
     *
     * The single startup read via getStateAsync() is therefore the correct pattern:
     *  – one async DB read on start, then synchronous in-memory access at runtime.
     *  – every write goes to both the in-memory variable AND the state (ack:true).
     */
    async _restorePersistedStates() {
        return stateRestore.restorePersistedStates(this);
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
        return setStray(this, fn, ms);
    }

    async onUnload(callback) {
        // Set flag FIRST so any concurrently-running timer callbacks abort immediately
        this._unloading = true;
        try {
            if (this._pollTimer) {
                clearTimeout(this._pollTimer);
            }
            if (this._timeTimer) {
                clearInterval(this._timeTimer);
            }
            if (this._timeAlignTimer) {
                clearTimeout(this._timeAlignTimer);
                this._timeAlignTimer = null;
            }
            if (this._pvDeactivateTimer) {
                clearTimeout(this._pvDeactivateTimer);
            }
            if (this._pvDeactivateCountdownInt) {
                clearInterval(this._pvDeactivateCountdownInt);
            }
            if (this._pvStageTimer) {
                clearTimeout(this._pvStageTimer);
            }
            if (this._uvcEnsureTimer) {
                clearInterval(this._uvcEnsureTimer);
            }
            if (this._pendingTempTimer) {
                clearTimeout(this._pendingTempTimer);
            }
            if (this._manualOverrideTimer) {
                clearTimeout(this._manualOverrideTimer);
                this._manualOverrideTimer = null;
            }
            // Persist manual_override=false so adapter starts clean after restart
            try {
                await this.setStateAsync('control.manual_override', {val: false, ack: true});
                await this.setStateAsync('control.manual_override_duration', {val: 0, ack: true});
                this._manualOverride = false;
            } catch (e) {
                this.log.error(`onUnload: failed to persist manual_override state: ${e.message}`);
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
                this.setState('control.filter_running', {val: Math.round(finalFilterH * 100) / 100, ack: true});
            } catch (_) { /* ignore on unload */
            }
            // Persist accumulated UVC hours (including any currently-running session)
            try {
                const finalHours = this.accumulateUvcHours();
                this.setState('status.uvc_hours_used', {val: Math.round(finalHours * 100) / 100, ack: true});
            } catch (_) { /* ignore on unload */
            }
        } catch (e) {
            this.log.error(`onUnload unexpected error: ${e.message}`);
        } finally {
            callback();
        }
    }

    // -------------------------------------------------------------------------
    // Publish configured time windows as JSON datapoint
    // -------------------------------------------------------------------------
    async publishTimeWindowsJson() {
        return timeControl.publishTimeWindowsJson(this);
    }

    /**
     * Validates the JSON written to status.time_windows_json, persists it to
     * system.adapter.<name>.<instance>.native.timeWindows and re-initialises
     * time-window and PV control so changes take effect immediately without
     * an adapter restart.
     *
     * @param {string} jsonStr – raw JSON string from the state
     */
    async _applyTimeWindowsJson(jsonStr) {
        return timeControl.applyTimeWindowsJson(this, jsonStr);
    }

    // -------------------------------------------------------------------------
    // Time Window Control
    // -------------------------------------------------------------------------
    initTimeControl() {
        return timeControl.initTimeControl(this);
    }

    async checkTimeWindows() {
        return timeControl.checkTimeWindows(this);
    }

    async deactivateWindow(w, i) {
        return timeControl.deactivateWindow(this, w, i);
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
        return startupCheck.checkStartupDeviceState(this, data);
    }

    // -------------------------------------------------------------------------
    // Filter pump runtime – helper
    // -------------------------------------------------------------------------
    /**
     * Returns total accumulated filter runtime hours including the currently running
     * session (if filter is ON right now). Does NOT mutate this._filterHoursUsed.
     */
    accumulateFilterHours() {
        return timeControl.accumulateFilterHours(this);
    }


    /**
     * Returns true if today is within the configured season window (DD.MM – DD.MM).
     * If season_enabled is false, always returns false – all automatic controls
     * (time windows, PV surplus) are blocked. Only winter mode (frost protection)
     * is allowed when season_enabled = false and winter_mode = true.
     * Supports seasons spanning the year boundary (e.g. 01.10 – 31.03).
     */
    isInSeason() {
        return timeControl.isInSeason(this);
    }

    /**
     * Returns true if current local time is within [start, end) (HH:MM strings).
     * Supports overnight windows e.g. "22:00"–"06:00".
     *
     * @param start
     * @param end
     */
    isInTimeWindow(start, end) {
        return timeControl.isInTimeWindow(this, start, end);
    }

    // -------------------------------------------------------------------------
    // PV Surplus Control  ?  lib/pv.js
    // -------------------------------------------------------------------------
    async initPvControl() {
        return pvController.init(this);
    }

    async onForeignStateChange(id, state) {
        return pvController.onForeignStateChange(this, id, state);
    }

    async evaluatePvSurplus() {
        return pvController.evaluateSurplus(this);
    }

    async pvCancelAllDeactivationTimers() {
        return pvController.cancelAllDeactivationTimers(this);
    }


    async pvStagedDeactivate(pvWindows, immediate = false) {
        return pvController.stagedDeactivate(this, pvWindows, immediate);
    }

    // -------------------------------------------------------------------------
    // UVC  ?  lib/uvc.js
    // -------------------------------------------------------------------------
    accumulateUvcHours() {
        return uvcController.accumulateHours(this);
    }

    getUvcTodayHours() {
        return uvcController.getTodayHours(this);
    }

    async computeUvcExpiry() {
        return uvcController.computeExpiry(this);
    }

    initUvcDailyEnsure() {
        return uvcController.initDailyEnsure(this);
    }

    async checkUvcDailyMinimum() {
        return uvcController.checkDailyMinimum(this);
    }

    async stopUvcEnsure() {
        return uvcController.stopEnsure(this);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    todayStr() {
        return todayStr();
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
        polling.schedulePoll(this);
    }

    async tryReconnect() {
        return polling.tryReconnect(this);
    }

    async doPoll() {
        return polling.doPoll(this);
    }

    async publishStatus(data) {
        return stateMgr.publishStatus(this, data);
    }

    // -------------------------------------------------------------------------
    // Adaptive polling + rapid polling
    // -------------------------------------------------------------------------

    enableRapidPolling() {
        polling.enableRapidPolling(this);
    }

    // -------------------------------------------------------------------------
    // Power cycle detection + state restore
    // -------------------------------------------------------------------------
    async checkPowerCycle(data) {
        return powerCycle.checkPowerCycle(this, data);
    }

    async enforceTemperatureUnit(data) {
        return powerCycle.enforceTemperatureUnit(this, data);
    }

    async restoreSavedState() {
        return powerCycle.restoreSavedState(this);
    }

    async safeCmd(fn, label) {
        return powerCycle.safeCmd(this, fn, label);
    }

    sleep(ms) {
        return sleep(this, ms);
    }

    // -------------------------------------------------------------------------
    // Control – feature state helper
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Winter mode – frost protection
    // -------------------------------------------------------------------------
    async checkFrostProtection(data) {
        return frostProtection.checkFrostProtection(this, data);
    }

    // -------------------------------------------------------------------------
    // Command status helper
    // -------------------------------------------------------------------------
    async setStatusCheck(status) {
        return stateMgr.setStatusCheck(this, status);
    }

    /**
     * Resets _adapterCommanded[feature] back to null after delayMs.
     * Delegates to lib/commands.js.
     *
     * @param feature
     * @param val
     * @param delayMs
     */
    _scheduleCommandedReset(feature, val, delayMs = CONSTANTS.COMMANDED_RESET_DELAY_MS) {
        return commands._scheduleCommandedReset(this, feature, val, delayMs);
    }

    /**
     * @param {string} feature
     * @param {boolean} boolVal
     * @param {{ fromUser?: boolean, fromAutomation?: boolean }} [opts]
     */
    async setFeature(feature, boolVal, {fromUser = false, fromAutomation = false} = {}) {
        return commands.setFeature(this, feature, boolVal, {fromUser, fromAutomation});
    }

    async setTargetTemp(temp) {
        return commands.setTargetTemp(this, temp);
    }

    /**
     * Sends the target temperature directly to the API (no heater-state check).
     *
     * @param {number} temp
     * @param {{ fromUser?: boolean, fromAutomation?: boolean }} [opts]
     */
    async sendTargetTempDirect(temp, {fromUser = false, fromAutomation = false} = {}) {
        return commands.sendTargetTempDirect(this, temp, {fromUser, fromAutomation});
    }

    // -------------------------------------------------------------------------
    // Manual override – pausiert alle Automationen (Zeitfenster, PV, Frostschutz)
    // -------------------------------------------------------------------------
    /**
     * @param {boolean} enable
     * @param {number|null} [durationMin]
     */
    async setManualOverride(enable, durationMin = null) {
        return manualOverride.setManualOverride(this, enable, durationMin);
    }

    /**
     * Re-evaluates all automations after manual override ends.
     * Each task runs independently so one failure does not block the others.
     */
    async _resumeAfterOverride() {
        return manualOverride._resumeAfterOverride(this);
    }

    // -------------------------------------------------------------------------
    // State change handler (writable controls)
    // -------------------------------------------------------------------------
    async onStateChange(id, state) {
        return stateChangeHandler.onStateChange(this, id, state);
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
