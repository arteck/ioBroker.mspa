'use strict';

// ---------------------------------------------------------------------------
// Shared constants – all magic numbers extracted from the codebase.
// Grouped logically for maintainability.
// ---------------------------------------------------------------------------
const CONSTANTS = {
    // ── Time conversions ────────────────────────────────────────────────
    /** Milliseconds in one second */
    MS_PER_SECOND: 1000,
    /** Milliseconds in one minute (60 000) */
    MS_PER_MINUTE: 60_000,
    /** Milliseconds in one hour (3 600 000) */
    MS_PER_HOUR: 3_600_000,

    // ── API / Throttle ──────────────────────────────────────────────────
    /** Default API request timeout (15 s) */
    API_TIMEOUT_MS: 15_000,
    /** Minimum interval between API requests (400 ms) */
    THROTTLE_MIN_INTERVAL_MS: 400,
    /** Number of status polls to confirm a command was applied */
    COMMAND_CONFIRM_POLLS: 5,
    /** Default max retries for rate-limited API calls */
    API_MAX_RETRIES: 3,
    /** Base delay for exponential backoff on rate-limited calls (2 s) */
    API_RETRY_BASE_DELAY_MS: 2_000,
    /** Demo mode simulated response delay (5 s) */
    DEMO_RESPONSE_DELAY_MS: 5_000,

    // ── Polling ─────────────────────────────────────────────────────────
    /** Default poll interval if not configured (60 s) */
    DEFAULT_POLL_INTERVAL_MS: 60_000,
    /** Minimum configurable poll interval in seconds (10 s) */
    MIN_POLL_INTERVAL_SECONDS: 10,
    /** Interval for rapid polling (1 s) */
    RAPID_POLL_INTERVAL_MS: 1_000,
    /** How long rapid polling stays active (15 s) */
    RAPID_POLL_DURATION_MS: 15_000,
    /** Max consecutive errors before reconnect limit */
    MAX_RECONNECT_TRIES: 3,
    /** Delay before retrying init after failure (30 s) */
    INIT_RETRY_DELAY_MS: 30_000,

    // ── Temperature thresholds ──────────────────────────────────────────
    /** Minimum target temperature (°C) */
    MIN_TARGET_TEMP_C: 20,
    /** Maximum target temperature (°C) */
    MAX_TARGET_TEMP_C: 42,
    /** Default frost protection threshold (°C) */
    FROST_THRESHOLD_C: 5,
    /** Frost protection hysteresis (°C) */
    FROST_HYSTERESIS_C: 3,
    /** Temp difference threshold for app-change detection (°C) */
    TEMP_DIFF_THRESHOLD_C: 0.5,

    // ── Heating / cooling rate tracker ──────────────────────────────────
    /** Minimum valid heating rate (°C/h) */
    HEAT_RATE_MIN: 0.3,
    /** Maximum valid heating rate (°C/h) */
    HEAT_RATE_MAX: 3.5,
    /** Minimum sample window for heating rate (minutes) */
    HEAT_SAMPLE_MINUTES: 20,
    /** Minimum valid cooling rate (°C/h) */
    COOL_RATE_MIN: 0.05,
    /** Maximum valid cooling rate (°C/h) */
    COOL_RATE_MAX: 2.0,
    /** Minimum sample window for cooling rate (minutes) */
    COOL_SAMPLE_MINUTES: 30,
    /** Max age of a rate sample before it is discarded (30 min) */
    MAX_SAMPLE_AGE_MS: 30 * 60_000,

    // ── ETA calculation ─────────────────────────────────────────────────
    /** Maximum ETA hours cap (48 h) */
    MAX_ETA_HOURS: 48,

    // ── Delays (commands / control) ─────────────────────────────────────
    /** Default delay for resetting _adapterCommanded markers (30 s) */
    COMMANDED_RESET_DELAY_MS: 30_000,
    /** Delay before sending pending target temp after heater ON (10 s) */
    PENDING_TEMP_DELAY_MS: 10_000,
    /** Delay to let pump spin up before heater command (1.5 s) */
    PUMP_SPINUP_DELAY_MS: 1_500,
    /** Sleep between pre-stop commands during filter-OFF sequence (500 ms) */
    PRE_STOP_SLEEP_MS: 500,
    /** Grace period for suppressing app-change detection after adapter command (30 s) */
    CMD_GRACE_PERIOD_MS: 30_000,
    /** Default duration for auto-override on app change (30 min) */
    APP_CHANGE_OVERRIDE_MIN_DEFAULT: 30,

    // ── Power cycle detection ───────────────────────────────────────────
    /** Suppress snapshot-based power-cycle detection for 60 s after command */
    POWER_CYCLE_SUPPRESS_MS: 60_000,
    /** Sleep before starting state restoration after power cycle (2 s) */
    RESTORE_SLEEP_MS: 2_000,

    // ── Filter runtime ──────────────────────────────────────────────────
    /** Max age of lastUpdate for filter runtime restoration on startup (6 h) */
    FILTER_RESTORE_MAX_AGE_MS: 6 * 3_600_000,

    // ── UVC ─────────────────────────────────────────────────────────────
    /** Default rated UVC lamp operating hours */
    UVC_RATED_HOURS_DEFAULT: 8_000,
    /** Default daily minimum UVC run hours */
    UVC_DAILY_MIN_H_DEFAULT: 2,
    /** Interval for UVC daily ensure check (60 s) */
    UVC_ENSURE_INTERVAL_MS: 60_000,

    // ── Time window control ─────────────────────────────────────────────
    /** Interval for checking time windows (60 s) */
    TIME_WINDOW_CHECK_INTERVAL_MS: 60_000,

    // ── PV surplus control ──────────────────────────────────────────────
    /** Default PV threshold (W) */
    PV_THRESHOLD_DEFAULT_W: 500,
    /** Default PV hysteresis (W) */
    PV_HYSTERESIS_DEFAULT_W: 100,
    /** Max retries for PV heater-OFF confirmation */
    PV_HEATER_OFF_MAX_RETRIES: 5,
    /** Interval between PV heater-OFF retry attempts (60 s) */
    PV_HEATER_OFF_RETRY_INTERVAL_MS: 60_000,

    // ── Manual override ─────────────────────────────────────────────────
    /** Delay before triggering immediate poll after override ends (500 ms) */
    MANUAL_OVERRIDE_POLL_DELAY_MS: 500,

    // ── UVC ensure stop hour ────────────────────────────────────────────
    /** Hour (0–23) when UVC daily counter resets */
    UVC_DAILY_RESET_HOUR: 1,
    /** Hour (0–23) when UVC ensure run must end before nightly reset */
    UVC_DAILY_STOP_HOUR: 22,
};

/**
 * ioBroker state definitions for the MSpa adapter.
 * Each key is the state id (relative to the adapter instance root).
 * Pattern follows helper.js: common includes id, name, role, type, read, write, def, unit, min, max.
 */
const STATE_DEFS = {
    // ── Read-only sensors ──────────────────────────────────────────────────
    'info.connection': {
        role: 'indicator.connected',
        type: 'boolean',
        read: true,
        write: false,
        def: false,
        name: 'Connected to MSpa cloud'
    },
    'info.lastUpdate': {
        role: 'date',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Timestamp of last successful data fetch'
    },
    // apiField = raw API key; states with apiField are only created after the first poll
    // if the device actually reports that field (model-specific dynamic creation).
    'status.water_temperature': {
        apiField: 'water_temperature',
        role: 'value.temperature',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Water temperature (°C)',
        unit: '°C'
    },
    'status.target_temperature': {
        apiField: 'temperature_setting',
        role: 'value.temperature',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Target temperature (°C)',
        unit: '°C'
    },
    'status.fault': {
        apiField: 'fault',
        role: 'text',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Fault status'
    },
    'status.heat_state': {
        apiField: 'heat_state',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Heat state',
        states: {0: 'off', 1: 'preoff', 2: 'preheat', 3: 'heating', 4: 'idle'}
    },
    'status.bubble_level': {
        apiField: 'bubble_level',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Bubble level'
    },
    'status.is_online': {
        apiField: 'is_online',
        role: 'indicator.reachable',
        type: 'boolean',
        read: true,
        write: false,
        def: false,
        name: 'Device online'
    },
    'status.filter_current': {
        apiField: 'filter_current',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Filter remaining hours until cleaning needed (h)',
        unit: 'h'
    },
    'status.filter_life': {
        apiField: 'filter_life',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Filter total accumulated running hours (h)',
        unit: 'h'
    },
    'status.temperature_unit': {
        apiField: 'temperature_unit',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Temperature unit',
        states: {0: '°C', 1: '°F'}
    },
    'status.safety_lock': {
        apiField: 'safety_lock',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Safety lock'
    },
    'status.heat_time_switch': {
        apiField: 'heat_time_switch',
        role: 'indicator',
        type: 'boolean',
        read: true,
        write: false,
        def: false,
        name: 'Heat timer active'
    },
    'status.heat_time': {
        apiField: 'heat_time',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Heat timer remaining (min)',
        unit: 'min'
    },
    'status.uvc_hours_used': {
        role: 'value',
        type: 'number',
        read: true,
        write: true,
        def: 0,
        name: 'UVC lamp accumulated operating hours (writable – set to correct after lamp replacement or data loss)',
        unit: 'h'
    },
    'status.uvc_hours_remaining': {
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'UVC lamp remaining operating hours',
        unit: 'h'
    },
    'status.uvc_today_hours': {
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'UVC lamp operating hours today',
        unit: 'h'
    },
    'status.auto_inflate': {
        apiField: 'auto_inflate',
        role: 'indicator',
        type: 'boolean',
        read: true,
        write: false,
        def: false,
        name: 'Auto inflate active'
    },
    'status.connect_type': {
        apiField: 'ConnectType',
        role: 'text',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Connection type (online/offline)'
    },
    'status.wifi_version': {
        apiField: 'wifivertion',
        role: 'info.version',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'WiFi module version (from status)'
    },
    'status.ota_status': {
        apiField: 'otastatus',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'OTA update status'
    },
    'status.mcu_version': {
        apiField: 'mcuversion',
        role: 'info.version',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'MCU version (from status)'
    },
    'status.trd_version': {
        apiField: 'trdversion',
        role: 'info.version',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Third-party/firmware version'
    },
    'status.serial_number': {
        apiField: 'serial_number',
        role: 'info.serial',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Serial number (from status)'
    },
    'status.heat_rest_time': {
        apiField: 'heat_rest_time',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Heat rest time (min)',
        unit: 'min'
    },
    'status.reset_cloud_time': {
        apiField: 'reset_cloud_time',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Reset cloud time'
    },
    'status.device_heat_perhour': {
        apiField: 'device_heat_perhour',
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Device heating rate per hour (firmware) (°C/h)',
        unit: '°C/h'
    },
    'status.warning': {
        apiField: 'warning',
        role: 'text',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Warning message'
    },

    'status.heat_target_temp_reached': {
        role: 'text',
        type: 'string',
        read: true,
        write: false,
        def: '00:00',
        name: 'Estimated time until target temperature is reached (hh:mm)'
    },

    // ── Computed rates ─────────────────────────────────────────────────────
    'computed.heat_rate_per_hour': {
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Observed heating rate (°C/h)',
        unit: '°C/h'
    },
    'computed.cool_rate_per_hour': {
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Observed cooling rate (°C/h)',
        unit: '°C/h'
    },
    'computed.pv_active': {
        role: 'indicator',
        type: 'boolean',
        read: true,
        write: false,
        def: false,
        name: 'PV surplus control currently active'
    },
    'computed.pv_deactivate_remaining': {
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'PV deactivate debounce remaining (min)',
        unit: 'min'
    },

    // ── Device info ────────────────────────────────────────────────────────
    'device.model': {role: 'info.name', type: 'string', read: true, write: false, def: '', name: 'Device model'},
    'device.series': {role: 'info.name', type: 'string', read: true, write: false, def: '', name: 'Product series'},
    'device.softwareVersion': {
        role: 'info.firmware',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Firmware version'
    },
    'device.wifiVersion': {
        role: 'info.version',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'WiFi module version'
    },
    'device.mcuVersion': {role: 'info.version', type: 'string', read: true, write: false, def: '', name: 'MCU version'},
    'device.serialNumber': {
        role: 'info.serial',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Serial number'
    },
    'device.alias': {role: 'info.name', type: 'string', read: true, write: false, def: '', name: 'Device alias'},
    'device.macAddress': {role: 'info.mac', type: 'string', read: true, write: false, def: '', name: 'MAC address'},
    'device.productId': {role: 'info.name', type: 'string', read: true, write: false, def: '', name: 'Product ID'},
    'device.productTubPk': {
        role: 'info.name',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Product tub PK'
    },
    'device.serviceRegion': {
        role: 'info.name',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Cloud service region'
    },
    'device.activateIp': {
        role: 'info.ip',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Activation IP address'
    },
    'device.bindingTime': {
        role: 'date',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Device binding time'
    },
    'device.activateTime': {
        role: 'date',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Device activation time'
    },
    'device.bindingRole': {
        role: 'value',
        type: 'number',
        read: true,
        write: false,
        def: 0,
        name: 'Binding role (1=owner)'
    },
    'device.isCloudActivated': {
        role: 'indicator',
        type: 'boolean',
        read: true,
        write: false,
        def: false,
        name: 'Cloud activated'
    },
    'device.pictureUrl': {
        role: 'info.name',
        type: 'string',
        read: true,
        write: false,
        def: '',
        name: 'Product image URL'
    },

    // ── Writable controls ──────────────────────────────────────────────────
    'control.heater': {role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Heater on/off'},
    'control.filter': {role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Filter on/off'},
    'control.bubble': {role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Bubble on/off'},
    'control.jet': {role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Jet on/off'},
    'control.ozone': {role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Ozone on/off'},
    'control.uvc': {role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'UVC on/off'},
    'control.target_temperature': {
        role: 'level.temperature', type: 'number', read: true, write: true, def: 25,
        name: 'Set target temperature (°C)', unit: '°C', min: 0, max: 40,
    },
    'control.bubble_level': {
        role: 'level',
        type: 'number',
        read: true,
        write: true,
        def: 0,
        name: 'Bubble level (0=off, 1-3)',
        min: 0,
        max: 3
    },
    'control.winter_mode': {
        role: 'switch',
        type: 'boolean',
        read: true,
        write: true,
        def: false,
        name: 'Winter mode (frost protection) on/off'
    },
    'control.season_enabled': {
        role: 'switch',
        type: 'boolean',
        read: true,
        write: true,
        def: false,
        name: 'Season control on/off'
    },
    'control.manual_override': {
        role: 'switch',
        type: 'boolean',
        read: true,
        write: true,
        def: false,
        name: 'Manual override – pause all automations'
    },
    'control.manual_override_duration': {
        role: 'level',
        type: 'number',
        read: true,
        write: true,
        def: 0,
        name: 'Manual override duration (min, 0=indefinite)',
        unit: 'min',
        min: 0,
        max: 480
    },
    'control.uvc_ensure_skip_today': {
        role: 'switch',
        type: 'boolean',
        read: true,
        write: true,
        def: false,
        name: 'Skip UVC daily ensure for today (resets at midnight)'
    },

    // ── Filter runtime counter ─────────────────────────────────────────────
    'control.filter_running': {
        role: 'value', type: 'number', read: true, write: false,
        def: 0, unit: 'h',
        name: 'Filter pump accumulated runtime since last reset (h)',
    },
    'control.filter_reset': {
        role: 'button', type: 'boolean', read: false, write: true,
        def: false,
        name: 'Reset filter runtime counter to 0',
    },
};

module.exports = {STATE_DEFS, CONSTANTS};
