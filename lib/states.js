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

const { STATE_DEFS }      = require('./constants');
const notificationHelper  = require('./notificationHelper');

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
        try {
 await adapter.delObjectAsync(id); 
} catch (_) { /* did not exist */ }
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
        if (def.apiField !== undefined) {
continue;
}
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
        if (def.apiField === undefined) {
continue;
}
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
        adapter.setState(id, val || '', true);
    }
    if (api.bindingRole      !== null && api.bindingRole      !== undefined) {
        adapter.setState('device.bindingRole',      api.bindingRole,            true);
    }
    if (api.isCloudActivated !== null && api.isCloudActivated !== undefined) {
        adapter.setState('device.isCloudActivated', api.isCloudActivated === 1, true);
    }
    if (api.productPicUrl) {
        adapter.setState('device.pictureUrl',       api.productPicUrl,          true);
    }
}

/**
 * Writes the latest command status to `info.statusCheck`.
 *
 * @param {object} adapter
 * @param {string} status   e.g. 'send' | 'success' | 'error' | 'queued'
 */
async function setStatusCheck(adapter, status) {
    adapter.setState('info.statusCheck', { val: status, ack: true });
}

/**
 * Publishes the latest device status to all ioBroker states.
 * Handles state writes, app-change detection, PV feature sync,
 * UVC/filter runtime tracking and ETA calculation.
 *
 * @param {object} adapter
 * @param {object} data   – transformed device status from transformStatus()
 */
async function publishStatus(adapter, data) {
    const set = async (id, val) => {
        if (val === undefined || val === null) {
 return; 
}
        const def = STATE_DEFS[id];
        if (def && def.apiField !== undefined && !adapter._dynamicStateIds.has(id)) {
 return; 
}
        await adapter.setStateChangedAsync(id, val, true);
    };

    await set('status.water_temperature',  data.water_temperature);
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
    await set('status.auto_inflate',       !!data.auto_inflate);
    if (data.ConnectType         !== undefined) {
 await set('status.connect_type',        String(data.ConnectType));    
}
    if (data.wifivertion         !== undefined) {
 await set('status.wifi_version',        String(data.wifivertion));    
}
    if (data.otastatus           !== undefined) {
 await set('status.ota_status',          data.otastatus);              
}
    if (data.mcuversion          !== undefined) {
 await set('status.mcu_version',         String(data.mcuversion));     
}
    if (data.trdversion          !== undefined) {
 await set('status.trd_version',         String(data.trdversion));     
}
    if (data.serial_number       !== undefined) {
 await set('status.serial_number',       String(data.serial_number));  
}
    if (data.heat_rest_time      !== undefined) {
 await set('status.heat_rest_time',      data.heat_rest_time);         
}
    if (data.reset_cloud_time    !== undefined) {
 await set('status.reset_cloud_time',    data.reset_cloud_time);       
}
    if (data.device_heat_perhour !== undefined) {
 await set('status.device_heat_perhour', data.device_heat_perhour);    
}
    if (data.warning             !== undefined) {
 await set('status.warning',             data.warning || '');          
}

    const setCtrl = async (id, val) => {
        if (val !== undefined && val !== null) {
            adapter.setState(id, val, true);
        }
    };
    await setCtrl('control.heater', data.heater === 'on');
    await setCtrl('control.filter', data.filter === 'on');
    await setCtrl('control.bubble', data.bubble === 'on');
    await setCtrl('control.jet',    data.jet    === 'on');
    await setCtrl('control.ozone',  data.ozone  === 'on');
    await setCtrl('control.uvc',    data.uvc    === 'on');

    // ── External app-change detection ────────────────────────────────────────
    const cmdGraceMs = 30_000;
    const inCmdGrace = (Date.now() - adapter._lastCommandTime) < cmdGraceMs;
    if (inCmdGrace) {
        adapter.log.debug(`App-change detection: suppressed – adapter command was ${Math.round((Date.now() - adapter._lastCommandTime) / 1000)} s ago (grace ${cmdGraceMs / 1000} s)`);
    }
    if (!adapter._manualOverride && adapter._seasonEnabled && !inCmdGrace) {
        const autoOverrideDuration = adapter.config.app_change_override_min ?? 30;
        const checks = [
            { key: 'heater', deviceVal: data.heater === 'on' },
            { key: 'filter', deviceVal: data.filter === 'on' },
            { key: 'bubble', deviceVal: data.bubble === 'on' },
            { key: 'uvc',    deviceVal: data.uvc    === 'on' },
        ];
        if (data.heater === 'on' && adapter._adapterCommanded.target_temperature !== null) {
            const diff = Math.abs((data.target_temperature || 0) - adapter._adapterCommanded.target_temperature);
            if (diff > 0.5) {
                checks.push({ key: 'target_temperature', deviceVal: data.target_temperature });
            }
        }
        for (const { key, deviceVal } of checks) {
            const commanded = adapter._adapterCommanded[key];
            if (commanded === null) {
 continue; 
}
            const mismatch = deviceVal !== commanded;
            if (mismatch) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`App change detected: ${key} is ${JSON.stringify(deviceVal)} on device but adapter last set it to ${JSON.stringify(commanded)} – activating manual override (${autoOverrideDuration} min)`);
                }
                await notificationHelper.send(notificationHelper.format('appChangeDetected', { key, duration: autoOverrideDuration }));
                adapter._adapterCommanded[key] = deviceVal;
                await adapter.setManualOverride(true, autoOverrideDuration > 0 ? autoOverrideDuration : null);
                break;
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Firmware target-temperature reached (heat_state = 4 = idle) ──────────
    if (adapter._pvActive && !adapter._pvStageTimer && !adapter._pvDeactivateTimer &&
        data.heat_state === 4 && adapter._pvManagedFeatures.heater === false &&
        (adapter._pvManagedFeatures.filter || adapter._pvManagedFeatures.uvc)) {
        const pvWindows = (adapter.config.timeWindows || []).filter(w => w.active && w.pv_steu);
        if (pvWindows.length > 0) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('PV: firmware reached target temperature (heat_state=4) – starting staged shutdown for UVC/filter');
            }
            adapter._pvActive = false;
            await adapter.pvStagedDeactivate(pvWindows, false);
        }
    }

    // ── PV feature sync (firmware may independently turn off heater) ──────────
    if (adapter._pvActive || adapter._pvStageTimer) {
        if (adapter._pvManagedFeatures.heater && data.heater !== 'on') {
            adapter.log.debug(`PV: heater is OFF on device (heat_state=${data.heat_state}) – syncing _pvManagedFeatures.heater`);
            adapter._pvManagedFeatures.heater = false;
        }
        if (adapter._pvManagedFeatures.uvc && data.uvc !== 'on') {
            adapter.log.debug('PV: UVC is OFF on device – syncing _pvManagedFeatures.uvc');
            adapter._pvManagedFeatures.uvc = false;
        }
        if (adapter._pvManagedFeatures.filter && data.filter !== 'on') {
            adapter.log.debug('PV: filter is OFF on device – syncing _pvManagedFeatures.filter');
            adapter._pvManagedFeatures.filter = false;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── UVC operating hours tracking ──────────────────────────────────────────
    const uvcIsOn = data.uvc === 'on';
    if (uvcIsOn && adapter._uvcOnSince === null) {
        adapter._uvcOnSince = Date.now();
        adapter.log.debug('UVC ON – started tracking operating hours');
    } else if (!uvcIsOn && adapter._uvcOnSince !== null) {
        adapter._uvcHoursUsed = adapter.accumulateUvcHours();
        adapter._uvcOnSince   = null;
        adapter.log.debug(`UVC OFF – total hours used: ${adapter._uvcHoursUsed.toFixed(2)} h`);
        adapter.setState('status.uvc_hours_used', { val: Math.round(adapter._uvcHoursUsed * 100) / 100, ack: true });
        await adapter.computeUvcExpiry();
    }
    await adapter.setStateChangedAsync('status.uvc_hours_used',   Math.round(adapter.accumulateUvcHours()    * 100) / 100, true);
    await adapter.setStateChangedAsync('status.uvc_today_hours',  Math.round(adapter.getUvcTodayHours()      * 100) / 100, true);
    // ─────────────────────────────────────────────────────────────────────────

    // ── Filter pump runtime tracking ──────────────────────────────────────────
    const filterIsOn = data.filter === 'on';
    if (filterIsOn && adapter._filterOnSince === null) {
        adapter._filterOnSince = Date.now();
        adapter.log.debug('Filter ON – started tracking runtime hours');
    } else if (!filterIsOn && adapter._filterOnSince !== null) {
        adapter._filterHoursUsed = adapter.accumulateFilterHours();
        adapter._filterOnSince   = null;
        adapter.log.debug(`Filter OFF – total runtime: ${adapter._filterHoursUsed.toFixed(2)} h`);
        adapter.setState('control.filter_running', { val: Math.round(adapter._filterHoursUsed * 100) / 100, ack: true });
    }
    await adapter.setStateChangedAsync('control.filter_running', Math.round(adapter.accumulateFilterHours() * 100) / 100, true);
    // ─────────────────────────────────────────────────────────────────────────

    await setCtrl('control.target_temperature', data.target_temperature);
    await setCtrl('control.bubble_level',       data.bubble_level);

    // ── Heat / cool rate tracking ─────────────────────────────────────────────
    const isHeating = data.heat_state === 3;
    const heatRate  = adapter._heatTracker.update(data.water_temperature, isHeating, true);
    if (heatRate !== null) {
        await set('computed.heat_rate_per_hour', Math.round(heatRate * 100) / 100);
    }
    if (heatRate !== null && heatRate > 0) {
        adapter._lastHeatRate = heatRate;
    }

    const isNotHeating = ![2, 3].includes(data.heat_state);
    const coolRate = adapter._coolTracker.update(data.water_temperature, isNotHeating, false);
    if (coolRate !== null) {
        await set('computed.cool_rate_per_hour', Math.round(coolRate * 100) / 100);
    }

    // ── ETA bis Zieltemperatur (hh:mm) ────────────────────────────────────────
    {
        const target       = Number(data.target_temperature);
        const current      = Number(data.water_temperature);
        const isHeatingNow = [2, 3].includes(data.heat_state) && data.heater === 'on';
        const rate         = Number(adapter._lastHeatRate) || 0;

        let etaHours = 0;
        if (isHeatingNow && Number.isFinite(target) && Number.isFinite(current) && target > current && rate > 0) {
            etaHours = (target - current) / rate;
            if (!Number.isFinite(etaHours) || etaHours < 0) {
 etaHours = 0; 
} else if (etaHours > 48)                          {
 etaHours = 48; 
}
        }

        const totalMinutes = Math.round(etaHours * 60);
        const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
        const mm = String(totalMinutes % 60).padStart(2, '0');
        await adapter.setStateChangedAsync('status.heat_target_temp_reached', `${hh}:${mm}`, true);
    }
    // ─────────────────────────────────────────────────────────────────────────
}

module.exports = {
    createStates,
    createDynamicStates,
    updateDeviceInfo,
    setStatusCheck,
    publishStatus,
    // Helpers (exported for testability)
    buildCommon,
    ensureState,
};
