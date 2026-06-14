'use strict';

/**
 * lib/polling.js
 *
 * Polling and reconnect functions for the MSpa adapter.
 * All functions receive the adapter instance as the first parameter.
 *
 *   schedulePoll(adapter)         – schedules the next poll with adaptive/rapid interval
 *   tryReconnect(adapter)         – attempts API reconnection
 *   doPoll(adapter)               – main polling loop: calls API, processes response
 *   enableRapidPolling(adapter)   – temporarily polls at 1s intervals
 */

const {transformStatus} = require('./utils');
const {CONSTANTS} = require('./constants');

// ---------------------------------------------------------------------------
// schedulePoll
// ---------------------------------------------------------------------------

/**
 * Schedules the next poll with exponential backoff on errors.
 * Always cancels any pending poll timer first to prevent overlapping timers.
 *
 * @param {object} adapter
 */
function schedulePoll(adapter) {
    if (adapter._unloading) {
        return;
    }
    // Always cancel any pending poll before scheduling a new one so two timers
    // can never coexist. Otherwise a timer set by enableRapidPolling() while a
    // poll is in flight would be orphaned here → two concurrent doPoll() runs.
    if (adapter._pollTimer) {
        clearTimeout(adapter._pollTimer);
        adapter._pollTimer = null;
    }
    const isRapid = Date.now() < adapter._rapidUntil;
    const interval = isRapid ? CONSTANTS.RAPID_POLL_INTERVAL_MS : adapter._pollInterval;
    adapter._pollTimer = setTimeout(() => doPoll(adapter), interval);
}

// ---------------------------------------------------------------------------
// tryReconnect
// ---------------------------------------------------------------------------

/**
 * Attempts API reconnection by re-initialising the API client.
 *
 * @param {object} adapter
 * @returns {Promise<boolean>} true if reconnected successfully
 */
async function tryReconnect(adapter) {
    try {
        adapter._authStore.token = null;
        await adapter._api.init();
        // Device info ist statisch und wurde bereits beim ersten Poll geschrieben.
        adapter.setState('info.connection', true, true);
        return true;
    } catch (err) {
        adapter.log.error(`MSpa reconnect failed: ${err.message}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// doPoll
// ---------------------------------------------------------------------------

/**
 * Main polling loop: calls the MSpa API, processes the response,
 * and delegates to feature sub-modules.
 *
 * @param {object} adapter
 */
async function doPoll(adapter) {
    if (adapter._unloading) {
        return;
    }
    // Re-entrancy guard: never run two polls concurrently. A trigger that arrives
    // while a poll is in flight (e.g. a rapid-poll timer firing during a slow API
    // call) is dropped – the in-flight poll reschedules itself when it finishes.
    if (adapter._polling) {
        adapter.log.debug('doPoll: a poll is already in progress – skipping overlapping trigger');
        return;
    }
    adapter._polling = true;
    try {
        try {
            let raw;
            if (adapter._api._lastStatus) {
                raw = adapter._api._lastStatus;
                adapter._api._lastStatus = null;
            } else {
                raw = await adapter._api.getHotTubStatus();
            }

            // DEBUG: einmalig rohe API-Daten loggen (nur beim ersten Poll)
            if (!adapter._rawApiLogged) {
                adapter._rawApiLogged = true;
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`MSpa RAW API response (${adapter._api.model}): ${JSON.stringify(raw)}`);
                }
                // Create model-specific status states based on what the API actually reports
                await adapter.createDynamicStates(raw);
            }

            const data = transformStatus(raw);
            adapter._lastData = data;

            await adapter.publishStatus(data);
            await adapter.checkFrostProtection(data);
            await adapter.checkPowerCycle(data);
            // Adaptive polling: rapid mode during active heating cycle
            if (data.heat_state === 2 && data.heater === 'on') {
                adapter._rapidUntil = Date.now() + CONSTANTS.RAPID_POLL_DURATION_MS;
            }
            adapter.setState('info.connection', true, true);
            adapter.setState('info.lastUpdate', Date.now(), true);
            adapter._consecutiveErrors = 0;

            // Startup check: after first successful poll, verify device state
            // against active time windows and shut down orphaned features.
            if (!adapter._firstPollDone) {
                adapter._firstPollDone = true;
                // Statische Geräteinfos (Modell, Seriennummer, FW-Versionen, …)
                // werden EINMALIG beim ersten erfolgreichen Poll geschrieben.
                try {
                    await adapter.updateDeviceInfo();
                } catch (e) {
                    adapter.log.warn(`updateDeviceInfo failed: ${e.message}`);
                }
                await adapter.checkStartupDeviceState(data);
            }

        } catch (err) {
            adapter._consecutiveErrors++;
            adapter.log.error(`MSpa poll error (${adapter._consecutiveErrors}): ${err.message}`);
            adapter.setState('info.connection', false, true);

            if (adapter._consecutiveErrors <= adapter._maxReconnectTries) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`MSpa attempting reconnect (try ${adapter._consecutiveErrors}/${adapter._maxReconnectTries})…`);
                }
                const reconnected = await tryReconnect(adapter);
                if (reconnected) {
                    if (adapter.config.more_log_enabled) {
                        adapter.log.info('MSpa reconnect successful – retrying poll immediately');
                    }
                    schedulePoll(adapter);
                    return;
                }
            } else {
                adapter.log.warn(`MSpa reconnect limit reached (${adapter._maxReconnectTries}), waiting for next regular poll interval`);
                adapter._consecutiveErrors = 0;
            }
        }

        schedulePoll(adapter);
    } finally {
        adapter._polling = false;
    }
}

// ---------------------------------------------------------------------------
// enableRapidPolling
// ---------------------------------------------------------------------------

/**
 * Temporarily polls at 1s intervals (used for UVC confirmation and temp setting).
 * Sets _rapidUntil to 15 s from now so the next schedulePoll() picks a 1 s interval.
 *
 * @param {object} adapter
 */
function enableRapidPolling(adapter) {
    adapter._rapidUntil = Date.now() + CONSTANTS.RAPID_POLL_DURATION_MS;
    if (adapter._unloading) {
        return;
    }
    // Cancel the currently scheduled poll and reschedule immediately (1 s)
    // so the ACK arrives quickly instead of waiting up to 60 s.
    if (adapter._pollTimer) {
        clearTimeout(adapter._pollTimer);
        adapter._pollTimer = null;
    }
    // If a poll is currently in flight it will reschedule itself on completion
    // (using _rapidUntil, so still rapid). Avoid stacking a second timer that
    // would fire mid-poll and be dropped by the re-entrancy guard anyway.
    if (adapter._polling) {
        return;
    }
    adapter._pollTimer = setTimeout(() => doPoll(adapter), CONSTANTS.RAPID_POLL_INTERVAL_MS);
}

module.exports = {
    schedulePoll,
    tryReconnect,
    doPoll,
    enableRapidPolling,
};
