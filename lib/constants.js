'use strict';

/**
 * ioBroker state definitions for the MSpa adapter.
 * Each key is the state id (relative to the adapter instance root).
 * Pattern follows helper.js: common includes id, name, role, type, read, write, def, unit, min, max.
 */
const STATE_DEFS = {
    // ── Read-only sensors ──────────────────────────────────────────────────
    'info.connection':          { role: 'indicator.connected',  type: 'boolean', read: true,  write: false, def: false,  name: 'Connected to MSpa cloud' },
    'info.lastUpdate':          { role: 'date',                 type: 'number',  read: true,  write: false, def: 0,      name: 'Timestamp of last successful data fetch' },
    'status.water_temperature': { role: 'value.temperature',    type: 'number',  read: true,  write: false, def: 0,      name: 'Water temperature (°C)',    unit: '°C' },
    'status.target_temperature':{ role: 'value.temperature',    type: 'number',  read: true,  write: false, def: 0,      name: 'Target temperature (°C)',   unit: '°C' },
    'status.fault':             { role: 'text',                 type: 'string',  read: true,  write: false, def: '',     name: 'Fault status' },
    'status.heat_state':        { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Heat state', states: { 0: 'off', 2: 'preheat', 3: 'heating', 4: 'idle' } },
    'status.bubble_level':      { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Bubble level' },
    'status.is_online':         { role: 'indicator.reachable',  type: 'boolean', read: true,  write: false, def: false,  name: 'Device online' },
    'status.filter_current':    { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Filter capacity (h)' },
    'status.filter_life':       { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Filter running hours (h)' },
    'status.temperature_unit':  { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Temperature unit', states: { 0: '°C', 1: '°F' } },
    'status.safety_lock':       { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Safety lock' },
    'status.heat_time_switch':  { role: 'indicator',            type: 'boolean', read: true,  write: false, def: false,  name: 'Heat timer active' },
    'status.heat_time':         { role: 'value',                type: 'number',  read: true,  write: false, def: 0,      name: 'Heat timer remaining (min)', unit: 'min' },

    // ── Computed rates ─────────────────────────────────────────────────────
    'computed.heat_rate_per_hour': { role: 'value', type: 'number', read: true, write: false, def: 0, name: 'Observed heating rate (°C/h)', unit: '°C/h' },
    'computed.cool_rate_per_hour': { role: 'value', type: 'number', read: true, write: false, def: 0, name: 'Observed cooling rate (°C/h)', unit: '°C/h' },

    // ── Device info ────────────────────────────────────────────────────────
    'device.model':          { role: 'info.name',      type: 'string', read: true, write: false, def: '', name: 'Device model' },
    'device.series':         { role: 'info.name',      type: 'string', read: true, write: false, def: '', name: 'Product series' },
    'device.softwareVersion':{ role: 'info.firmware',  type: 'string', read: true, write: false, def: '', name: 'Firmware version' },
    'device.wifiVersion':    { role: 'info.version',   type: 'string', read: true, write: false, def: '', name: 'WiFi module version' },
    'device.mcuVersion':     { role: 'info.version',   type: 'string', read: true, write: false, def: '', name: 'MCU version' },
    'device.serialNumber':   { role: 'info.serial',    type: 'string', read: true, write: false, def: '', name: 'Serial number' },
    'device.alias':          { role: 'info.name',      type: 'string', read: true, write: false, def: '', name: 'Device alias' },

    // ── Writable controls ──────────────────────────────────────────────────
    'control.heater':        { role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Heater on/off' },
    'control.filter':        { role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Filter on/off' },
    'control.bubble':        { role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Bubble on/off' },
    'control.jet':           { role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Jet on/off' },
    'control.ozone':         { role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'Ozone on/off' },
    'control.uvc':           { role: 'switch', type: 'boolean', read: true, write: true, def: false, name: 'UVC on/off' },
    'control.target_temperature': {
        role: 'level.temperature', type: 'number', read: true, write: true, def: 20,
        name: 'Set target temperature (°C)', unit: '°C', min: 20, max: 40,
    },
    'control.bubble_level':  { role: 'level', type: 'number', read: true, write: true, def: 0, name: 'Bubble level (0=off, 1-3)', min: 0, max: 3 },
};

module.exports = { STATE_DEFS };
