'use strict';

const crypto = require('crypto');
const axios  = require('axios');

// ---------------------------------------------------------------------------
// Constants – mirrored from const.py
// ---------------------------------------------------------------------------
const APP_ID     = 'e1c8e068f9ca11eba4dc0242ac120002';
const APP_SECRET = '87025c9ecd18906d27225fe79cb68349';

const API_ENDPOINTS = {
    ROW: 'https://api.iot.the-mspa.com',
    US:  'https://api.usiot.the-mspa.com',
    CH:  'https://api.mspa.mxchip.com.cn',
};

const DEMO_EMAIL = 'demo@mspa.test';

// ---------------------------------------------------------------------------
// Demo fixtures
// ---------------------------------------------------------------------------
const DEMO_DEVICES = [
    {
        device_id:      'demo_device_frame_001',
        device_alias:   'DemoSpa Frame',
        product_series: 'FRAME',
        product_model:  'F-TU062W',
        software_version: '106',
        wifi_version:   '141',
        mcu_version:    'mcu-3A1',
        product_id:     'DEMO01',
        url:            '',
        is_online:      true,
        is_connect:     true,
        sn:             'DEMO-FRAME-001',
    },
];

let _demoStatus = {
    water_temperature:   78,
    temperature_setting: 82,
    heater_state:        1,
    filter_state:        1,
    bubble_state:        0,
    jet_state:           0,
    ozone_state:         1,
    uvc_state:           1,
    bubble_level:        1,
    fault:               '',
    temperature_unit:    0,
    auto_inflate:        0,
    filter_current:      42,
    safety_lock:         0,
    heat_time_switch:    0,
    heat_state:          3,
    heat_time:           120,
    filter_life:         720,
    is_online:           true,
    ConnectType:         'online',
    wifivertion:         '141',
};

// ---------------------------------------------------------------------------
// Throttle – max ~2.5 req/s (same as Python implementation)
// ---------------------------------------------------------------------------
/**
 *
 */
class MSpaThrottle {
    /**
     *
     */
    constructor() {
        this.MIN_INTERVAL = 400; // ms
        this._lastTime    = 0;
        this._queue       = Promise.resolve();
    }

    /** Returns a promise that resolves when it is safe to fire the next request. */
    acquire() {
        this._queue = this._queue.then(() => {
            const now  = Date.now();
            const wait = this.MIN_INTERVAL - (now - this._lastTime);
            if (wait > 0) {
                return new Promise(resolve => setTimeout(resolve, wait));
            }
        }).then(() => {
            this._lastTime = Date.now();
        });
        return this._queue;
    }
}

// ---------------------------------------------------------------------------
// MSpa API Client
// ---------------------------------------------------------------------------
/**
 *
 */
class MSpaApiClient {
    /**
     * @param {object} opts
     * @param {string} opts.email
     * @param {string} opts.password  – MD5-hashed password
     * @param {string} [opts.region]  – ROW | US | CH
     * @param {string} [opts.deviceId]
     * @param {object} [opts.authStore]  – shared auth state { token, throttle }
     * @param {Function} opts.log      – logging function (level, msg)
     */
    constructor({ email, password, region = 'ROW', deviceId = null, authStore, log }) {
        this.email      = email;
        this.password   = password;
        this.region     = API_ENDPOINTS[region] ? region : 'ROW';
        this._deviceId  = deviceId;
        this._log       = log || (() => {});
        this._authStore = authStore || { token: null, throttle: new MSpaThrottle() };

        // Device attributes populated by init()
        this.deviceId       = null;
        this.productId      = null;
        this.series         = null;
        this.model          = null;
        this.softwareVersion = null;
        this.wifiVersion    = null;
        this.mcuVersion     = null;
        this.productPicUrl  = null;
        this.serialNumber   = null;
        this.macAddress     = null;
        this.deviceAlias    = null;

        this._lastStatus           = null;  // one-shot cache after a command
        this._lastCommandConfirmed = false; // true = device confirmed last command
    }

    /**
     *
     */
    get baseUrl() {
        return API_ENDPOINTS[this.region] || API_ENDPOINTS.ROW;
    }

    /**
     *
     */
    get isDemo() {
        return this.email === DEMO_EMAIL;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    /**
     *
     * @param length
     */
    static _generateNonce(length = 32) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result  = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     *
     * @param str
     */
    static _md5(str) {
        return crypto.createHash('md5').update(str).digest('hex');
    }

    /**
     *
     * @param nonce
     * @param ts
     */
    _buildSignature(nonce, ts) {
        const raw = `${APP_ID},${APP_SECRET},${nonce},${ts}`;
        return MSpaApiClient._md5(raw).toUpperCase();
    }

    /**
     *
     * @param authToken
     */
    _buildHeaders(authToken) {
        const nonce = MSpaApiClient._generateNonce();
        const ts    = String(Math.floor(Date.now() / 1000));
        const sign  = this._buildSignature(nonce, ts);
        return {
            push_type:        'Android',
            authorization:    authToken ? `token ${authToken}` : 'token',
            appid:            APP_ID,
            nonce,
            ts,
            lan_code:         'de',
            sign,
            'content-type':   'application/json; charset=UTF-8',
            'accept-encoding':'gzip',
            'user-agent':     'okhttp/4.9.0',
        };
    }

    /**
     *
     */
    _obfuscateEmail() {
        if (!this.email) {
return '***';
}
        const [local, domain] = this.email.split('@');
        return local ? `${local.slice(0, 3)}***@${domain}` : '***';
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------
    /**
     *
     */
    async init() {
        if (this.isDemo) {
            const device         = DEMO_DEVICES.find(d => d.device_id === this._deviceId) || DEMO_DEVICES[0];
            this.deviceId        = device.device_id;
            this.productId       = device.product_id;
            this.series          = device.product_series;
            this.model           = device.product_model;
            this.softwareVersion = device.software_version;
            this.wifiVersion     = device.wifi_version;
            this.mcuVersion      = device.mcu_version;
            this.productPicUrl   = device.url;
            this.deviceAlias     = device.device_alias;
            this.serialNumber    = device.sn;
            this._log('info', `DEMO MODE: initialised demo device '${this.deviceAlias}'`);
            return;
        }

        const deviceList = await this.getDeviceList();
        if (!deviceList || !Array.isArray(deviceList.list) || deviceList.list.length === 0) {
            throw new Error('MSpa init failed: no devices returned from API');
        }

        const devices = deviceList.list;
        let device    = this._deviceId
            ? (devices.find(d => d.device_id === this._deviceId) || devices[0])
            : devices[0];

        this.deviceId        = device.device_id;
        this.productId       = device.product_id;
        this.series          = device.product_series;
        this.model           = device.product_model;
        this.softwareVersion = device.software_version;
        this.wifiVersion     = device.wifi_version;
        this.mcuVersion      = device.mcu_version;
        this.productPicUrl   = device.url;
        this.deviceAlias     = device.device_alias;
        this.serialNumber    = device.sn;
        this.macAddress      = device.mac || null;

        this._log('info', `MSpa API initialised – device: ${this.deviceAlias} (${this.deviceId})`);
    }

    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------
    /**
     *
     */
    async authenticate() {
        // Serialize authentication so parallel callers don't all trigger login
        if (this._authStore._authPromise) {
            return this._authStore._authPromise;
        }

        this._authStore._authPromise = this._doAuthenticate().finally(() => {
            this._authStore._authPromise = null;
        });
        return this._authStore._authPromise;
    }

    /**
     *
     */
    async _doAuthenticate() {
        const headers = this._buildHeaders(null);
        const payload = {
            account:         this.email,
            app_id:          APP_ID,
            password:        this.password,
            brand:           '',
            registration_id: '',
            push_type:       'android',
            lan_code:        'EN',
            country:         '',
        };
        const url = `${this.baseUrl}/api/enduser/get_token/`;

        await this._authStore.throttle.acquire();
        this._log('info', `MSpa authenticating to ${url} as ${this._obfuscateEmail()}`);

        const response = await axios.post(url, payload, { headers, timeout: 30000 });
        const token    = response.data?.data?.token;

        if (!token) {
            const code = response.data?.code;
            const msg  = response.data?.message || '';
            throw new Error(`MSpa auth failed (code=${code}): ${msg}`);
        }

        this._authStore.token = token;
        this._log('info', `MSpa token received (len=${token.length})`);
        return token;
    }

    // -------------------------------------------------------------------------
    // Device list
    // -------------------------------------------------------------------------
    /**
     *
     * @param retry
     */
    async getDeviceList(retry = false) {
        const token   = this._authStore.token || (await this.authenticate());
        const headers = this._buildHeaders(token);
        const url     = `${this.baseUrl}/api/enduser/devices/`;

        await this._authStore.throttle.acquire();
        this._log('debug', `GET device list (retry=${retry})`);

        const response = await axios.get(url, { headers, timeout: 30000 });
        const json     = response.data;
        const code     = json?.code;
        const data     = json?.data || {};

        if (code === 11000 && !retry) {
            // Rate-limited – wait and retry
            await new Promise(r => setTimeout(r, 2000));
            return this.getDeviceList(true);
        }

        if (!data.list && !retry) {
            await this.authenticate();
            return this.getDeviceList(true);
        }

        return data;
    }

    // -------------------------------------------------------------------------
    // Status
    // -------------------------------------------------------------------------
    /**
     *
     * @param retry
     */
    async getHotTubStatus(retry = false) {
        if (this.isDemo) {
            const status = Object.assign({}, _demoStatus);
            return status;
        }

        const token   = this._authStore.token || (await this.authenticate());
        const headers = this._buildHeaders(token);
        const payload = { device_id: this.deviceId, product_id: this.productId };
        const url     = `${this.baseUrl}/api/device/thing_shadow/`;

        await this._authStore.throttle.acquire();
        const response = await axios.post(url, payload, { headers, timeout: 30000 });
        const json     = response.data;

        if (!json?.data && !retry) {
            await this.authenticate();
            return this.getHotTubStatus(true);
        }

        this._log('debug', `MSpa status: ${JSON.stringify(json.data)}`);
        return json.data;
    }

    // -------------------------------------------------------------------------
    // Commands
    // -------------------------------------------------------------------------
    /**
     *
     * @param desiredDict
     * @param retry
     */
    async sendDeviceCommand(desiredDict, retry = false) {
        if (this.isDemo) {
            this._log('info', `DEMO: ignoring command ${JSON.stringify(desiredDict)}`);
            Object.assign(_demoStatus, desiredDict);
            return { message: 'SUCCESS' };
        }

        // Serialize write commands to avoid racing (same as Python api_lock)
        if (this._authStore._cmdPromise) {
            await this._authStore._cmdPromise;
        }

        this._authStore._cmdPromise = this._sendCommandLocked(desiredDict, retry).finally(() => {
            this._authStore._cmdPromise = null;
        });
        return this._authStore._cmdPromise;
    }

    /**
     *
     * @param desiredDict
     * @param retry
     */
    async _sendCommandLocked(desiredDict, retry = false) {
        const token   = this._authStore.token || (await this.authenticate());
        const headers = this._buildHeaders(token);
        const payload = {
            device_id:  this.deviceId,
            product_id: this.productId,
            desired:    JSON.stringify({ state: { desired: desiredDict } }),
        };
        const url = `${this.baseUrl}/api/device/command`;

        await this._authStore.throttle.acquire();
        const response = await axios.post(url, payload, { headers, timeout: 30000 });
        const json     = response.data;

        if (json?.message !== 'SUCCESS' && !retry) {
            await this.authenticate();
            return this._sendCommandLocked(desiredDict, true);
        }

        // Poll up to 5× to confirm the state change
        this._lastCommandConfirmed = false;
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const status = await this.getHotTubStatus();
            const confirmed = Object.entries(desiredDict).every(([k, v]) => status[k] === v);
            if (confirmed) {
                this._lastStatus           = status;
                this._lastCommandConfirmed = true;
                break;
            }
        }
        if (!this._lastCommandConfirmed) {
            this._log('warn', `MSpa command not confirmed after 5 retries: ${JSON.stringify(desiredDict)}`);
        }

        return json;
    }

    // -------------------------------------------------------------------------
    // Convenience command methods
    // -------------------------------------------------------------------------
    setHeaterState(state)              { return this.sendDeviceCommand({ heater_state: state }); }
    setBubbleState(state, level)       { return this.sendDeviceCommand({ bubble_state: state, bubble_level: level }); }
    setBubbleLevel(level)              { return this.sendDeviceCommand({ bubble_level: level }); }
    setJetState(state)                 { return this.sendDeviceCommand({ jet_state: state }); }
    setFilterState(state)              { return this.sendDeviceCommand({ filter_state: state }); }
    setOzoneState(state)               { return this.sendDeviceCommand({ ozone_state: state }); }
    setUvcState(state)                 { return this.sendDeviceCommand({ uvc_state: state }); }
    setTemperatureSetting(tempCelsius) { return this.sendDeviceCommand({ temperature_setting: Math.round(tempCelsius * 2) }); }
    setTemperatureUnit(unit)           { return this.sendDeviceCommand({ temperature_unit: unit }); }
}

module.exports = { MSpaApiClient, MSpaThrottle };
