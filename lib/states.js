'use strict';

/**
 * lib/states.js
 *
 * State / Object management for the MSpa adapter.
 * Extracted from main.js to keep the adapter class focused on lifecycle
 * and control logic.
 *
 * All functions take the adapter instance as the first parameter.
 *
 *   createStates(adapter)               – static channels + STATE_DEFS objects
 *   createDynamicStates(adapter, raw)   – model-specific apiField-mapped states
 *   updateDeviceInfo(adapter)           – writes static device.* values once
 *   setStatusCheck(adapter, status)     – writes info.statusCheck
 */

const { STATE_DEFS } = require('./constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Build an ioBroker `common` object from a STATE_DEFS entry.
 *
 * @param {string} id
 * @param {object} def
 * @returns {object}
 */
function buildCommon(id, def) {
    const common = {
        id:    id,
        name:  def.name,
        role:  def.role,
        type:  def.type,
        read:  def.read,
        write: def.write,
        def:   def.def !== undefined ? def.def : (def.type === 'boolean' ? false : (def.min ?? 0)),
    };
    if (def.unit   !== undefined) { common.unit   = def.unit;   }
    if (def.min    !== undefined) { common.min    = def.min;    }
    if (def.max    !== undefined) { common.max    = def.max;    }
    if (def.states !== undefined) { common.states = def.states; }
    return common;
}

/**
 * Create the state if missing, then merge `common` into the existing object.
 *
 * @param {object} adapter
 * @param {string} id
 * @param {object} common
 */
async function ensureState(adapter, id, common) {
    await adapter.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
    const existing = await adapter.getObjectAsync(id);
    if (existing) {
        existing.common = { ...existing.common, ...common };
        await adapter.setObjectAsync(id, existing);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates all static channels and all STATE_DEFS entries that are NOT
 * apiField-mapped. Also removes obsolete legacy objects.
 *
 * @param {object} adapter
 */
async function createStates(adapter) {
    // ── Obsolete Objekte entfernen ────────────────────────────────────
    const obsolete = [
        'device.deviceUuid',
        'status.uvc_expiry_date',
        'status.heat_target_temp_reached', // type changed from number → string
    ];
    for (const id of obsolete) {
        try { await adapter.delObjectAsync(id); } catch (_) { /* did not exist */ }
    }

    // ── Channels ──────────────────────────────────────────────────────
    const channels = ['info', 'status', 'computed', 'device', 'control', 'consumption'];
    for (const channel of channels) {
        await adapter.setObjectNotExistsAsync(channel, {
            type: 'channel',
            common: { name: channel },
            native: {},
        });
    }

    // ── Consumption states ────────────────────────────────────────────
    const consumptionStates = {
        'consumption.day_kwh':        { name: 'Daily consumption (kWh)',            unit: 'kWh', type: 'number' },
        'consumption.last_total_kwh': { name: 'Raw meter value at day start (kWh)', unit: 'kWh', type: 'number' },
    };
    for (const [id, def] of Object.entries(consumptionStates)) {
        await adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name:  def.name,
                type:  def.type || 'number',
                role:  def.type === 'string' ? 'text' : 'value.power.consumption',
                unit:  def.unit,
                read:  true,
                write: false,
                def:   def.type === 'string' ? '' : 0,
            },
            native: {},
        });
    }

    // ── Manuell verwaltete Objekte (nicht in STATE_DEFS) ──────────────
    await adapter.setObjectNotExistsAsync('status.time_windows_json', {
        type: 'state',
        common: { name: 'Configured time windows (JSON)', type: 'string', role: 'json', read: true, write: false, def: '[]' },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('computed.pv_deactivate_remaining', {
        type: 'state',
        common: { name: 'PV deactivate delay remaining (min)', type: 'number', role: 'value', unit: 'min', read: true, write: false, def: 0 },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('info.statusCheck', {
        type: 'state',
        common: { name: 'Last command status', type: 'string', role: 'text', read: true, write: false, def: '' },
        native: {},
    });

    await adapter.setObjectNotExistsAsync('control.uvc_ensure_skip_date', {
        type: 'state',
        common: { name: 'Date when uvc_ensure_skip_today was set (YYYY-MM-DD)', type: 'string', role: 'text', read: true, write: false, def: '' },
        native: {},
    });

    // ── STATE_DEFS (ohne apiField – die kommen erst nach erstem Poll) ─
    for (const [id, def] of Object.entries(STATE_DEFS)) {
        if (def.apiField !== undefined) continue;
        await ensureState(adapter, id, buildCommon(id, def));
    }
}

/**
 * Creates status states that have an apiField mapping – but only for fields
 * that the device actually reports in its first raw API response.
 * Called once after the first successful poll.
 *
 * @param {object} adapter
 * @param {object} raw  – raw API payload from getHotTubStatus()
 */
async function createDynamicStates(adapter, raw) {
    const apiKeys = new Set(Object.keys(raw || {}));
    let created = 0;
    for (const [id, def] of Object.entries(STATE_DEFS)) {
        if (def.apiField === undefined) continue;
        if (!apiKeys.has(def.apiField)) {
            adapter.log.debug(`createDynamicStates: skipping ${id} – field '${def.apiField}' not in API response`);
            continue;
        }
        await ensureState(adapter, id, buildCommon(id, def));
        adapter._dynamicStateIds.add(id);
        created++;
    }
    if (adapter.config.more_log_enabled) {
        adapter.log.info(`createDynamicStates: ${created} model-specific states created/updated for ${adapter._api.model}`);
    }
}

/**
 * Writes the static `device.*` info datapoints from the API client.
 * Should be called once after the first successful poll – the values are
 * static and never change at runtime.
 *
 * @param {object} adapter
 */
async function updateDeviceInfo(adapter) {
    const api = adapter._api;
    const fields = [
        ['device.model',           api.model],
        ['device.series',          api.series],
        ['device.softwareVersion', api.softwareVersion],
        ['device.wifiVersion',     api.wifiVersion],
        ['device.mcuVersion',      api.mcuVersion],
        ['device.serialNumber',    api.serialNumber],
        ['device.alias',           api.deviceAlias],
        ['device.macAddress',      api.macAddress],
        ['device.productId',       api.productId],
        ['device.productTubPk',    api.productTubPk],
        ['device.serviceRegion',   api.serviceRegion],
        ['device.activateIp',      api.activateIp],
        ['device.bindingTime',     api.bindingTime],
        ['device.activateTime',    api.activateTime],
    ];
    for (const [id, val] of fields) {
        await adapter.setStateAsync(id, val || '', true);
    }
    if (api.bindingRole      !== null && api.bindingRole      !== undefined) {
        await adapter.setStateAsync('device.bindingRole',      api.bindingRole,            true);
    }
    if (api.isCloudActivated !== null && api.isCloudActivated !== undefined) {
        await adapter.setStateAsync('device.isCloudActivated', api.isCloudActivated === 1, true);
    }
    if (api.productPicUrl) {
        await adapter.setStateAsync('device.pictureUrl',       api.productPicUrl,          true);
    }
}

/**
 * Writes the latest command status to `info.statusCheck`.
 *
 * @param {object} adapter
 * @param {string} status   e.g. 'send' | 'success' | 'error' | 'queued'
 */
async function setStatusCheck(adapter, status) {
    await adapter.setStateAsync('info.statusCheck', { val: status, ack: true });
}

module.exports = {
    createStates,
    createDynamicStates,
    updateDeviceInfo,
    setStatusCheck,
    // Helpers (exported for testability)
    buildCommon,
    ensureState,
};
