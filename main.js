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
        this._rapidUntil   = 0;       // timestamp – rapid poll while Date.now() < this._rapidUntil
        this._lastData     = {};
        this._savedState   = {};
        this._lastSnapshot = {};
        this._lastIsOnline = null;
        this._consecutiveErrors = 0;
        this._maxReconnectTries = 3;

        this._heatTracker  = new RateTracker({ min: 0.05, max: 3.0 });
        this._coolTracker  = new RateTracker({ min: 0.01, max: 3.0 });

        this.on('ready',        this._onReady.bind(this));
        this.on('stateChange',  this._onStateChange.bind(this));
        this.on('unload',       this._onUnload.bind(this));
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async _onReady() {
        this.log.info('MSpa adapter starting…');
        await this._createStates();

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
            await this._updateDeviceInfo();
            await this.setStateAsync('info.connection', true, true);
            this.log.info(`MSpa connected – device: ${this._api.deviceAlias}`);
        } catch (err) {
            this.log.error(`MSpa init failed: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
        }

        this.subscribeStates('control.*');
        // Daten sofort beim Start abholen; _doPoll() plant danach automatisch den nächsten Poll via _schedulePoll()
        this._doPoll();
    }

    _onUnload(callback) {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            }
        callback();
    }

    // -------------------------------------------------------------------------
    // State management
    // -------------------------------------------------------------------------
    async _createStates() {
        for (const [id, def] of Object.entries(STATE_DEFS)) {
            const common = {
                name:  def.name,
                type:  def.type,
                role:  def.role,
                read:  def.read,
                write: def.write,
            };
            if (def.unit  !== undefined) {
                common.unit  = def.unit;
            }
            if (def.min   !== undefined) {
                common.min   = def.min;
            }
            if (def.max   !== undefined) {
                common.max   = def.max;
            }

            await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        }
    }

    async _updateDeviceInfo() {
        const api = this._api;
        await this.setStateAsync('device.model',          api.model           || '', true);
        await this.setStateAsync('device.series',         api.series          || '', true);
        await this.setStateAsync('device.softwareVersion',api.softwareVersion || '', true);
        await this.setStateAsync('device.wifiVersion',    api.wifiVersion     || '', true);
        await this.setStateAsync('device.mcuVersion',     api.mcuVersion      || '', true);
        await this.setStateAsync('device.serialNumber',   api.serialNumber    || '', true);
        await this.setStateAsync('device.alias',          api.deviceAlias     || '', true);
    }

    // -------------------------------------------------------------------------
    // Polling
    // -------------------------------------------------------------------------
    _schedulePoll() {
        const isRapid   = Date.now() < this._rapidUntil;
        const interval  = isRapid ? 1000 : this._pollInterval;
        this._pollTimer = setTimeout(() => this._doPoll(), interval);
    }

    async _tryReconnect() {
        try {
            // Reset auth token so a fresh login is performed
            this._authStore.token = null;
            await this._api.init();
            await this._updateDeviceInfo();
            await this.setStateAsync('info.connection', true, true);
            return true;
        } catch (err) {
            this.log.error(`MSpa reconnect failed: ${err.message}`);
            return false;
        }
    }

    async _doPoll() {
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

            await this._publishStatus(data);
            await this._checkPowerCycle(data);
            await this._checkAdaptivePolling(data);
            await this.setStateAsync('info.connection', true, true);
            await this.setStateAsync('info.lastUpdate', Date.now(), true);
            this._consecutiveErrors = 0;

        } catch (err) {
            this._consecutiveErrors++;
            this.log.error(`MSpa poll error (${this._consecutiveErrors}): ${err.message}`);
            await this.setStateAsync('info.connection', false, true);

            if (this._consecutiveErrors <= this._maxReconnectTries) {
                this.log.info(`MSpa attempting reconnect (try ${this._consecutiveErrors}/${this._maxReconnectTries})…`);
                const reconnected = await this._tryReconnect();
                if (reconnected) {
                    this.log.info('MSpa reconnect successful – retrying poll immediately');
                    this._schedulePoll();
                    return;
                }
            } else {
                this.log.warn(`MSpa reconnect limit reached (${this._maxReconnectTries}), waiting for next regular poll interval`);
                this._consecutiveErrors = 0;
            }
        }

        this._schedulePoll();
    }

    async _publishStatus(data) {
        const set = async (id, val) => {
            if (val !== undefined && val !== null) {
                await this.setStateAsync(id, val, true);
            }
        };

        await set('status.water_temperature',  data.water_temperature);
        await set('status.target_temperature',  data.target_temperature);
        await set('status.fault',               data.fault);
        await set('status.heat_state',          data.heat_state);
        await set('status.bubble_level',        data.bubble_level);
        await set('status.is_online',           !!data.is_online);
        await set('status.filter_current',      data.filter_current);
        await set('status.filter_life',         data.filter_life);
        await set('status.temperature_unit',    data.temperature_unit);
        await set('status.safety_lock',         data.safety_lock);
        await set('status.heat_time',           data.heat_time);

        // Mirror writable controls from current state
        await set('control.heater',             data.heater  === 'on');
        await set('control.filter',             data.filter  === 'on');
        await set('control.bubble',             data.bubble  === 'on');
        await set('control.jet',                data.jet     === 'on');
        await set('control.ozone',              data.ozone   === 'on');
        await set('control.uvc',                data.uvc     === 'on');
        await set('control.target_temperature', data.target_temperature);
        await set('control.bubble_level',       data.bubble_level);

        // Heating rate
        const isHeating = data.heat_state === 3;
        const heatRate  = this._heatTracker.update(data.water_temperature, isHeating, true);
        if (heatRate !== null) {
            await set('computed.heat_rate_per_hour', Math.round(heatRate * 100) / 100);
        }

        // Cooling rate
        const isNotHeating = ![2, 3].includes(data.heat_state);
        const coolRate = this._coolTracker.update(data.water_temperature, isNotHeating, false);
        if (coolRate !== null) {
            await set('computed.cool_rate_per_hour', Math.round(coolRate * 100) / 100);
        }
    }

    // -------------------------------------------------------------------------
    // Adaptive polling (mirrors coordinator._check_adaptive_polling)
    // -------------------------------------------------------------------------
    async _checkAdaptivePolling(data) {
        if (data.heat_state === 2 && data.heater === 'on') {
            // Preheat mode → keep rapid polling alive
            this._rapidUntil = Date.now() + 15_000;
        }
    }

    _enableRapidPolling() {
        this._rapidUntil = Date.now() + 15_000;
    }

    // -------------------------------------------------------------------------
    // Power cycle detection + state restore (mirrors coordinator._check_power_cycle)
    // -------------------------------------------------------------------------
    async _checkPowerCycle(data) {
        const currentOnline    = !!data.is_online;
        let   powerCycle       = false;

        if (this._lastIsOnline !== null) {
            if (this._lastIsOnline && !currentOnline) {
                // Power OFF – save state
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

        // Method 2: multiple simultaneous parameter changes
        if (!powerCycle && Object.keys(this._lastSnapshot).length) {
            const changes = [];
            if (this._lastSnapshot.temperature_unit === 0 && data.temperature_unit === 1) {
                changes.push('temp_unit_reset');
            }
            if (this._lastSnapshot.heater === 'on'  && data.heater  === 'off') {
                changes.push('heater_off');
            }
            if (this._lastSnapshot.filter === 'on'  && data.filter  === 'off') {
                changes.push('filter_off');
            }
            if (this._lastSnapshot.ozone  === 'on'  && data.ozone   === 'off') {
                changes.push('ozone_off');
            }
            if (this._lastSnapshot.uvc    === 'on'  && data.uvc     === 'off') {
            changes.push('uvc_off');
            }
            if (changes.length >= 2) {
                powerCycle = true;
                this.log.warn(`MSpa possible power cycle (${changes.join(', ')})`);
            }
        }

        this._lastSnapshot = {
            temperature_unit: data.temperature_unit,
            heater:           data.heater,
            filter:           data.filter,
            ozone:            data.ozone,
            uvc:              data.uvc,
            target_temperature: data.target_temperature,
        };
        this._lastIsOnline = currentOnline;

        if (powerCycle) {
            const cfg = this.config;
            if (cfg.trackTemperatureUnit) {
                await this._enforceTemperatureUnit(data);
            }
            if (cfg.restoreStateOnPowerCycle && Object.keys(this._savedState).length) {
                await this._restoreSavedState();
            }
        }

        // Always-enforce unit option
        if (this.config.alwaysEnforceUnit && !powerCycle) {
            await this._enforceTemperatureUnit(data);
        }
    }

    async _enforceTemperatureUnit(data) {
        // ioBroker has no built-in unit system like HA, default = Celsius (0)
        const desired  = 0; // °C
        if ((data.temperature_unit || 0) !== desired) {
            this.log.info('MSpa enforcing temperature unit → Celsius');
            await this._api.setTemperatureUnit(desired);
        }
    }

    async _restoreSavedState() {
        this.log.info('MSpa restoring state after power cycle…');
        await this._sleep(2000);

        if (this._savedState.target_temperature) {
            await this._safeCmd(() => this._api.setTemperatureSetting(this._savedState.target_temperature), 'temperature');
        }
        for (const feature of ['heater', 'filter', 'ozone', 'uvc']) {
            if (this._savedState[feature] === 'on') {
                await this._safeCmd(() => this._setFeature(feature, true), feature);
                await this._sleep(500);
            }
        }
    }

    async _safeCmd(fn, label) {
        try {
         await fn();
        } catch (err) {
         this.log.error(`MSpa restore ${label} failed: ${err.message}`);
        }
    }

    _sleep(ms) {
     return new Promise(r => setTimeout(r, ms));
    }

    // -------------------------------------------------------------------------
    // Control – feature state helper
    // -------------------------------------------------------------------------
    async _setFeature(feature, boolVal) {
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
    async _onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        } // ignore ack'd updates and deletions

        const key = id.split('.').pop();  // e.g. "heater" from "mspa.0.control.heater"

        try {
            if (['heater', 'filter', 'bubble', 'jet', 'ozone', 'uvc'].includes(key)) {
                this.log.info(`MSpa command: ${key} → ${state.val}`);
                await this._setFeature(key, !!state.val);
                this._enableRapidPolling();
            } else if (key === 'target_temperature') {
                this.log.info(`MSpa command: set temperature → ${state.val}°C`);
                await this._api.setTemperatureSetting(state.val);
                this._enableRapidPolling();
            } else if (key === 'bubble_level') {
                this.log.info(`MSpa command: bubble level → ${state.val}`);
                await this._api.setBubbleLevel(state.val);
                this._enableRapidPolling();
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
