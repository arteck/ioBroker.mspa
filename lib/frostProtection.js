'use strict';

/**
 * lib/frostProtection.js
 *
 * Frost protection (winter mode) functions for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   checkFrostProtection(adapter, data)  – evaluates winter mode thresholds and controls heater/filter
 */

const notificationHelper = require('./notificationHelper');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// checkFrostProtection
// ---------------------------------------------------------------------------

/**
 * Evaluates frost protection based on water temperature and winter mode state.
 * Turns heater + filter ON when temp drops below threshold, OFF when temp rises
 * above threshold + hysteresis.
 *
 * @param {object} adapter
 * @param {object} data  – polled status data (must contain water_temperature)
 */
async function checkFrostProtection(adapter, data) {
    if (adapter._manualOverride) {
        adapter.log.debug('Winter mode: manual override active – skipping frost protection');
        return;
    }
    const cfg = adapter.config;
    const winterMode = adapter._winterModeActive;
    if (!winterMode) {
        // if frost was active but winter mode got disabled – switch off
        if (adapter._winterFrostActive) {
            adapter._winterFrostActive = false;
            if (adapter.config.more_log_enabled) {
                adapter.log.info('Winter mode: disabled – switching heater + filter OFF');
            }
            await adapter.setFeature('heater', false, {fromAutomation: true});
            await adapter.setFeature('filter', false, {fromAutomation: true});
        }
        return;
    }

    const threshold = cfg.winter_frost_temp ?? CONSTANTS.FROST_THRESHOLD_C;
    const hysteresis = CONSTANTS.FROST_HYSTERESIS_C;
    const temp = data.water_temperature;
    if (temp === undefined || temp === null) {
        return;
    }

    if (!adapter._winterFrostActive && temp <= threshold) {
        adapter._winterFrostActive = true;
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`Winter mode: temp ${temp}°C <= ${threshold}°C – switching heater + filter ON`);
        }
        await notificationHelper.send(notificationHelper.format('frostActive', {temp, threshold}));
        await adapter.setFeature('filter', true, {fromAutomation: true});
        await adapter.setFeature('heater', true, {fromAutomation: true});
        adapter.enableRapidPolling();
    } else if (adapter._winterFrostActive && temp >= threshold + hysteresis) {
        adapter._winterFrostActive = false;
        if (adapter.config.more_log_enabled) {
            adapter.log.info(`Winter mode: temp ${temp}°C >= ${threshold + hysteresis}°C – switching heater + filter OFF`);
        }
        await notificationHelper.send(notificationHelper.format('frostDeactivated', {
            temp, hysteresis: threshold + hysteresis
        }));
        await adapter.setFeature('heater', false, {fromAutomation: true});
        await adapter.setFeature('filter', false, {fromAutomation: true});
        adapter.enableRapidPolling();
        // Frost cycle ended – immediately re-evaluate UVC daily minimum
        // (was deferred while frost was active)
        adapter.checkUvcDailyMinimum().catch(e => adapter.log.error(`UVC daily ensure trigger after frost: ${e.message}`));
    }
}

module.exports = {checkFrostProtection};
