'use strict';

/**
 * ioBroker state definitions for the MSpa adapter.
 * Each key is the state id (relative to the adapter instance root).
 */
const STATE_DEFS = {
    // ── Read-only sensors ──────────────────────────────────────────────────
    'info.connection':          { role: 'indicator.connected',  type: 'boolean', read: true,  write: false, name: 'Connected to MSpa cloud' },
    'info.lastUpdate':          { role: 'date',                 type: 'number',  read: true,  write: false, name: 'Timestamp of last successful data fetch' },
    'status.water_temperature': { role: 'value.temperature',    type: 'number',  read: true,  write: false, name: 'Water temperature (°C)',    unit: '°C' },
    'status.target_temperature':{ role: 'value.temperature',    type: 'number',  read: true,  write: false, name: 'Target temperature (°C)',   unit: '°C' },
    'status.fault':             { role: 'text',                 type: 'string',  read: true,  write: false, name: 'Fault status' },
    'status.heat_state':        { role: 'value',                type: 'number',  read: true,  write: false, name: 'Heat state (0=off,2=preheat,3=heating,4=idle)' },
    'status.bubble_level':      { role: 'value',                type: 'number',  read: true,  write: false, name: 'Bubble level' },
    'status.is_online':         { role: 'indicator.reachable',  type: 'boolean', read: true,  write: false, name: 'Device online' },
    'status.filter_current':    { role: 'value',                type: 'number',  read: true,  write: false, name: 'Filter current (h)' },
    'status.filter_life':       { role: 'value',                type: 'number',  read: true,  write: false, name: 'Filter life remaining (h)' },
    'status.temperature_unit':  { role: 'value',                type: 'number',  read: true,  write: false, name: 'Temperature unit (0=°C, 1=°F)' },
    'status.safety_lock':       { role: 'value',                type: 'number',  read: true,  write: false, name: 'Safety lock' },
    'status.heat_time':         { role: 'value',                type: 'number',  read: true,  write: false, name: 'Heat time (min)' },

    // ── Computed rates ─────────────────────────────────────────────────────
    'computed.heat_rate_per_hour': { role: 'value', type: 'number', read: true, write: false, name: 'Observed heating rate (°C/h)', unit: '°C/h' },
    'computed.cool_rate_per_hour': { role: 'value', type: 'number', read: true, write: false, name: 'Observed cooling rate (°C/h)', unit: '°C/h' },

    // ── Device info ────────────────────────────────────────────────────────
    'device.model':          { role: 'info.name',      type: 'string', read: true, write: false, name: 'Device model' },
    'device.series':         { role: 'info.name',      type: 'string', read: true, write: false, name: 'Product series' },
    'device.softwareVersion':{ role: 'info.firmware',  type: 'string', read: true, write: false, name: 'Firmware version' },
    'device.wifiVersion':    { role: 'info.version',   type: 'string', read: true, write: false, name: 'WiFi module version' },
    'device.mcuVersion':     { role: 'info.version',   type: 'string', read: true, write: false, name: 'MCU version' },
    'device.serialNumber':   { role: 'info.serial',    type: 'string', read: true, write: false, name: 'Serial number' },
    'device.alias':          { role: 'info.name',      type: 'string', read: true, write: false, name: 'Device alias' },

    // ── Writable controls ──────────────────────────────────────────────────
    'control.heater':        { role: 'switch',               type: 'boolean', read: true, write: true, name: 'Heater on/off' },
    'control.filter':        { role: 'switch',               type: 'boolean', read: true, write: true, name: 'Filter on/off' },
    'control.bubble':        { role: 'switch',               type: 'boolean', read: true, write: true, name: 'Bubble on/off' },
    'control.jet':           { role: 'switch',               type: 'boolean', read: true, write: true, name: 'Jet on/off' },
    'control.ozone':         { role: 'switch',               type: 'boolean', read: true, write: true, name: 'Ozone on/off' },
    'control.uvc':           { role: 'switch',               type: 'boolean', read: true, write: true, name: 'UVC on/off' },
    'control.target_temperature': {
        role: 'level.temperature', type: 'number', read: true, write: true,
        name: 'Set target temperature (°C)', unit: '°C', min: 20, max: 40,
    },
    'control.bubble_level':  { role: 'level', type: 'number', read: true, write: true, name: 'Bubble level (1-3)', min: 1, max: 3 },
};

module.exports = { STATE_DEFS };
