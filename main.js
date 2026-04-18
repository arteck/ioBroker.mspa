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

        this._heatTracker  = new RateTracker({ min: 0.05, max: 3.0 });
        this._coolTracker  = new RateTracker({ min: 0.01, max: 3.0 });

        // PV surplus control
        this._pvPower                  = null;
        this._pvHouse                  = null;
        this._pvActive                 = false;
        this._pvDeactivateTimer        = null;  // debounce timer for deactivation
        this._pvDeactivateCountdown    = 0;     // remaining minutes for deactivation delay
        this._pvDeactivateCountdownInt = null;  // 1-min interval for countdown

        // Winter mode (frost protection)
        this._winterModeActive  = false;  // runtime override (from control state)
        this._winterFrostActive = false;  // true while frost protection heating is running
        this._seasonEnabled     = false;  // controlled exclusively via control.season_enabled state

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
        await this.initPvControl();
        this.initTimeControl();
        await this.publishTimeWindowsJson();
        consumptionHelper.init(this);
        notificationHelper.init(this);
        this.computeUvcExpiry();
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
        for (const t of this._pumpFollowUpTimers) {
            if (t) {
 clearTimeout(t); 
}
        }
        consumptionHelper.cleanup();
        notificationHelper.cleanup();
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
                    await notificationHelper.send(`🌡️ *MSpa:* Season ended – time window ${i + 1} deactivated.`);
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
                await notificationHelper.send(`⏰ *MSpa:* Time window ${i + 1} started (${start}–${end}).`);
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
                            await this._api.setTemperatureSetting(w.target_temp);
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
                await notificationHelper.send(`⏹️ *MSpa:* Time window ${i + 1} ended (${start}–${end}).`);
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
    // UVC lamp expiry calculation
    // -------------------------------------------------------------------------
    async computeUvcExpiry() {
        const cfg = this.config;
        const raw = (cfg.uvc_install_date || '').trim();
        if (!raw) {
            this.log.debug('UVC: no installation date configured – skipping expiry calculation');
            this.setStateAsync('status.uvc_expiry_date', { val: '', ack: true });
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

        const hours = cfg.uvc_operating_hours || 8000;
        const expiryDate = new Date(installDate.getTime() + hours * 3600 * 1000);

        const pad = (n) => String(n).padStart(2, '0');
        const expiryStr = `${pad(expiryDate.getDate())}.${pad(expiryDate.getMonth() + 1)}.${expiryDate.getFullYear()}`;

        const today     = new Date();
        today.setHours(0, 0, 0, 0);
        expiryDate.setHours(0, 0, 0, 0);
        const daysLeft  = Math.ceil((expiryDate - today) / (1000 * 3600 * 24));

        if (daysLeft < 0) {
            this.log.warn(`UVC: lamp expired on ${expiryStr} (${Math.abs(daysLeft)} days ago) – please replace!`);
            await notificationHelper.send(`⚠️ *MSpa:* UVC lamp expired on ${expiryStr} (${Math.abs(daysLeft)} days ago) – please replace!`);
        } else if (daysLeft <= 30) {
            this.log.warn(`UVC: lamp expires on ${expiryStr} (in ${daysLeft} days) – replacement recommended soon`);
            await notificationHelper.send(`⚠️ *MSpa:* UVC lamp expires on ${expiryStr} (in ${daysLeft} days) – replacement recommended.`);
        } else {
            this.log.info(`UVC: lamp expiry date = ${expiryStr} (${daysLeft} days remaining, based on ${hours} h lifetime)`);
        }

        this.setStateAsync('status.uvc_expiry_date', { val: expiryStr, ack: true });
    }

    /**
     * Returns true if today is within the configured season window (DD.MM – DD.MM).
     * If season_enabled is false, always returns true (no season restriction).
     * Supports seasons spanning the year boundary (e.g. 01.10 – 31.03).
     */
    isInSeason() {
        const cfg = this.config;
        if (!this._seasonEnabled) {
return true;
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
            this.log.debug('PV: outside season – skipping surplus evaluation (polling continues)');
            if (this._pvDeactivateTimer) {
                clearTimeout(this._pvDeactivateTimer);
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; 
}
                this._pvDeactivateCountdown = 0;
                await this.setStateAsync('computed.pv_deactivate_remaining', 0, true);
            }
            if (this._pvActive) {
                this._pvActive = false;
                this.log.info('PV: season ended – deactivating PV surplus control');
                const pvWindows = Array.isArray(cfg.timeWindows)
                    ? cfg.timeWindows.filter(w => w.active && w.pv_steu)
                    : [];
                for (const w of pvWindows) {
                    try {
                        if (w.action_heating) {
                            await this.setFeature('heater', false);
                            if (!w.action_filter) {
                                this.log.debug('PV: filter OFF (was started for heating only)');
                                await this.setFeature('filter', false);
                            }
                        }
                        if (w.action_filter) {
                            await this.setFeature('filter', false);
                            if (w.action_uvc) {
                                await this.setFeature('uvc', false);
                            }
                        }
                    } catch (err) {
                        this.log.error(`PV: season-deactivation FAILED – ${err.message}`);
                    }
                }
                this.enableRapidPolling();
            }
            return;
        }
        // --------------------------------------------------------------------

        if (this._pvPower === null || this._pvHouse === null) {
            this.log.debug(`PV: evaluation skipped – pvPower=${this._pvPower}, pvHouse=${this._pvHouse} (waiting for both values)`);
            return;
        }

        const surplus    = this._pvPower - this._pvHouse;
        const threshold  = cfg.pv_threshold_w  || 500;
        const hysteresis = Math.min(cfg.pv_hysteresis_w || 100, threshold);
        const offAt      = threshold - hysteresis;

        this.log.debug(`PV: surplus=${surplus} W | pvPower=${this._pvPower} W | pvHouse=${this._pvHouse} W | threshold=${threshold} W | hysteresis=${hysteresis} W | offAt=${offAt} W | pvActive=${this._pvActive}`);

        const shouldActivate   = surplus >= threshold;
        const shouldDeactivate = surplus < offAt;

        // collect all time window rows that have pv_steu enabled
        const pvWindows = Array.isArray(cfg.timeWindows)
            ? cfg.timeWindows.filter(w => w.active && w.pv_steu)
            : [];

        if (pvWindows.length === 0) {
            this.log.debug('PV: no time window rows with PV column enabled – nothing to do');
            return;
        }

        // --- Activation: immediate, cancel any pending deactivation timer ---
        if (!this._pvActive && shouldActivate) {
            if (this._pvDeactivateTimer) {
                clearTimeout(this._pvDeactivateTimer);
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; 
}
                this._pvDeactivateCountdown = 0;
                await this.setStateAsync('computed.pv_deactivate_remaining', 0, true);
                this.log.info(`PV: surplus recovered (${surplus} W ≥ ${threshold} W) – deactivation timer cancelled`);
            }
            this._pvActive = true;
            this.log.info(`PV: surplus DETECTED (${surplus} W ≥ ${threshold} W) – activating ${pvWindows.length} PV window(s)`);
            await notificationHelper.send(`☀️ *MSpa:* PV surplus detected (${surplus} W) – activating.`);
            for (const w of pvWindows) {
                try {
                    if (w.action_heating) {
                        // heater requires filter pump – start it first even if action_filter is off
                        if (!w.action_filter) {
                            this.log.debug('PV: filter ON (required for heating)');
                            await this.setFeature('filter', true);
                        }
                        this.log.debug('PV: switching heater ON');
                        await this.setFeature('heater', true);
                        if (w.target_temp) {
                            this.log.debug(`PV: setting target temperature to ${w.target_temp}°C`);
                            await this._api.setTemperatureSetting(w.target_temp);
                        }
                    }
                    if (w.action_filter) {
                        this.log.debug('PV: switching filter ON');
                        await this.setFeature('filter', true);
                        if (w.action_uvc) {
                            this.log.debug('PV: switching UVC ON (together with filter)');
                            await this.setFeature('uvc', true);
                        }
                    }
                } catch (err) {
                    this._pvActive = false;
                    this.log.error(`PV: activation FAILED – ${err.message}`);
                    this.log.debug(`PV: activation error stack: ${err.stack}`);
                    break;
                }
            }
            if (this._pvActive) {
                this.enableRapidPolling();
            }

        // --- Surplus recovered while timer is running: cancel timer ----------
        } else if (this._pvActive && !shouldDeactivate && this._pvDeactivateTimer) {
            clearTimeout(this._pvDeactivateTimer);
            this._pvDeactivateTimer = null;
            if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; 
}
            this._pvDeactivateCountdown = 0;
            await this.setStateAsync('computed.pv_deactivate_remaining', 0, true);
            this.log.info(`PV: surplus recovered (${surplus} W ≥ ${offAt} W) – deactivation timer cancelled, staying active`);

        // --- Surplus gone: start debounce timer (don't switch off immediately)
        } else if (this._pvActive && shouldDeactivate && !this._pvDeactivateTimer) {
            const delayMin = cfg.pv_deactivate_delay_min ?? 5;
            const debounceMs = delayMin * 60 * 1000;
            this.log.info(`PV: surplus BELOW threshold (${surplus} W < ${offAt} W) – waiting ${delayMin} min before deactivating (cloud protection)`);
            // start countdown
            this._pvDeactivateCountdown = delayMin;
            await this.setStateAsync('computed.pv_deactivate_remaining', this._pvDeactivateCountdown, true);
            if (this._pvDeactivateCountdownInt) {
clearInterval(this._pvDeactivateCountdownInt);
}
            this._pvDeactivateCountdownInt = setInterval(async () => {
                this._pvDeactivateCountdown = Math.max(0, this._pvDeactivateCountdown - 1);
                await this.setStateAsync('computed.pv_deactivate_remaining', this._pvDeactivateCountdown, true);
            }, 60 * 1000);
            this._pvDeactivateTimer = setTimeout(async () => {
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) {
 clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; 
}
                this._pvDeactivateCountdown = 0;
                await this.setStateAsync('computed.pv_deactivate_remaining', 0, true);
                this._pvActive = false;
                this.log.info(`PV: deactivation delay elapsed – switching off ${pvWindows.length} PV window(s)`);
                await notificationHelper.send(`🌥️ *MSpa:* PV surplus gone – deactivating.`);
                for (const w of pvWindows) {
                    try {
                        if (w.action_heating) {
                            this.log.debug('PV: switching heater OFF');
                            await this.setFeature('heater', false);
                            if (!w.action_filter) {
                                this.log.debug('PV: filter OFF (was started for heating only)');
                                await this.setFeature('filter', false);
                            }
                        }
                        if (w.action_filter) {
                            this.log.debug('PV: switching filter OFF');
                            await this.setFeature('filter', false);
                            if (w.action_uvc) {
                                this.log.debug('PV: switching UVC OFF (together with filter)');
                                await this.setFeature('uvc', false);
                            }
                        }
                    } catch (err) {
                        this._pvActive = true; // rollback
                        this.log.error(`PV: deactivation FAILED – ${err.message}`);
                        this.log.debug(`PV: deactivation error stack: ${err.stack}`);
                        break;
                    }
                }
                if (!this._pvActive) {
                    this.enableRapidPolling();
                }
            }, debounceMs);

        } else {
            this.log.debug(`PV: no action (pvActive=${this._pvActive}, shouldActivate=${shouldActivate}, shouldDeactivate=${shouldDeactivate}, timerPending=${!!this._pvDeactivateTimer})`);
        }
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
            'consumption.day_kwh':        { name: 'Daily consumption (kWh)',    unit: 'kWh' },
            'consumption.last_total_kwh': { name: 'Raw meter value at day start (kWh)', unit: 'kWh' },
        };
        for (const [id, def] of Object.entries(consumptionStates)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name: def.name, type: 'number', role: 'value.power.consumption', unit: def.unit, read: true, write: false, def: 0 },
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
            await this.safeCmd(() => this._api.setTemperatureSetting(this._savedState.target_temperature), 'temperature');
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
            await notificationHelper.send(`❄️ *MSpa:* Frost protection active – water ${temp}°C ≤ ${threshold}°C, activating heater + filter.`);
            await this.setFeature('filter', true);
            await this.setFeature('heater', true);
            this.enableRapidPolling();
        } else if (this._winterFrostActive && temp >= threshold + hysteresis) {
            this._winterFrostActive = false;
            this.log.info(`Winter mode: temp ${temp}°C ≥ ${threshold + hysteresis}°C – switching heater + filter OFF`);
            await notificationHelper.send(`🌡️ *MSpa:* Frost protection deactivated – water ${temp}°C ≥ ${threshold + hysteresis}°C.`);
            await this.setFeature('heater', false);
            await this.setFeature('filter', false);
            this.enableRapidPolling();
        }
    }

    async setFeature(feature, boolVal) {
        const state = boolVal ? 1 : 0;
        switch (feature) {
            case 'heater': return this._api.setHeaterState(state);
            case 'filter': return this._api.setFilterState(state);
            case 'bubble': return this._api.setBubbleState(state, this._lastData.bubble_level || 1);
            case 'jet':    return this._api.setJetState(state);
            case 'ozone':  return this._api.setOzoneState(state);
            case 'uvc':    return this._api.setUvcState(state);
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
                await this._api.setTemperatureSetting(state.val);
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
