'use strict';

/**
 * lib/startupCheck.js
 *
 * Startup device state check for the MSpa adapter.
 * Called after the first poll to verify no device features are running
 * unexpectedly without an active time window.
 *
 *   checkStartupDeviceState(adapter, data)  – checks and corrects orphaned features
 */

const commands = require('./commands');
const uvcController = require('./uvc');
const polling = require('./polling');
const timeControl = require('./timeControl');

/**
 * After the first successful poll, check whether any device features
 * (heater, filter, UVC) are running unexpectedly. If a feature is ON
 * but no time window is currently active and the window would manage
 * that feature, shut it down.
 *
 * Handles UVC daily-minimum guard: if UVC hasn't run enough today,
 * it is kept ON even though no window is active.
 *
 * @param {object} adapter  – adapter instance
 * @param {object} data     – transformed poll data
 */
async function checkStartupDeviceState(adapter, data) {
    // Skip if manual override or PV is active – those automations take over
    if (adapter._manualOverride || adapter._pvActive) {
        // PV wurde nach Neustart aus computed.pv_active wiederhergestellt, aber
        // _pvManagedFeatures überlebt keinen Neustart (Konstruktor setzt alles false).
        // Ohne Rekonstruktion würde stagedDeactivate() den Heizungs-AUS-Block
        // überspringen (Guard: _pvManagedFeatures.heater) → Heizung liefe weiter,
        // obwohl der Überschuss weg ist. Daher hier die Ownership wiederherstellen,
        // sobald der erste Poll den realen Heizungszustand liefert.
        if (adapter._pvActive && !adapter._pvManagedFeatures.heater && data && data.heater) {
            adapter._pvManagedFeatures.heater = true;
            adapter.log.debug('Startup check: restored _pvManagedFeatures.heater=true (PV active + device reports heater ON after restart)');
        }
        adapter.log.debug('Startup check: skipped (manual override or PV active)');
        return;
    }

    const windows = adapter.config.timeWindows;
    if (!Array.isArray(windows) || !windows.some(w => w.active)) {
        adapter.log.debug('Startup check: no active time windows – skipping');
        return;
    }

    // Determine which features any active window would manage
    let anyWindowManagesHeater = false;
    let anyWindowManagesFilter = false;
    let anyWindowManagesUvc = false;

    for (const w of windows) {
        if (!w.active) {
            continue;
        }
        if (w.action_heating) {
            anyWindowManagesHeater = true;
        }
        if (w.action_filter) {
            anyWindowManagesFilter = true;
        }
        if (w.action_uvc) {
            anyWindowManagesUvc = true;
        }
    }

    // Check if any of those features is currently ON on the device
    const heaterOn = !!data.heater;
    const filterOn = !!data.filter;
    const uvcOn = !!data.uvc;

    if (!heaterOn && !filterOn && !uvcOn) {
        adapter.log.debug('Startup check: device is idle – nothing to do');
        return;
    }

    // Filter wird IMMER von einem Zeitfenster verwaltet (nicht nur wenn action_filter=true).
    // anyWindowManagesFilter korrigieren: jedes aktive Fenster das IRGENDEINE Aktion hat verwaltet den Filter.
    const anyWindowManagesFilterReal = Array.isArray(windows) && windows.some(w => w.active && (w.action_filter || w.action_heating || w.action_uvc));
    if (anyWindowManagesFilterReal) {
        anyWindowManagesFilter = true;
    }

    // Is any time window active right now?
    // FIX Race Condition: _timeWindowActive[i] wird erst am Ende von checkTimeWindows() gesetzt.
    // Falls der erste Poll schneller zurückkommt als checkTimeWindows() die API-Befehle abarbeitet,
    // würde anyWindowActiveNow=false sein obwohl ein Fenster gerade startet.
    // Daher zusätzlich prüfen ob ein Fenster zeitlich gerade aktiv sein SOLLTE.
    const anyWindowActiveNow = adapter._timeWindowActive.some(v => v);
    const anyWindowShouldBeActive = Array.isArray(windows) && windows.some(w => {
        if (!w.active) {
            return false;
        }
        const now = new Date();
        const day = now.getDay();
        const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];
        const toMin = (hhmm) => {
            const [h, m] = hhmm.split(':').map(Number); return h * 60 + m;
        };
        const sMin = toMin(w.start || '00:00');
        const eMin = toMin(w.end || '00:00');
        const curMin = now.getHours() * 60 + now.getMinutes();
        const isOvernightAfterMidnight = sMin > eMin && eMin > 0 && curMin < eMin;
        const effectiveDay = isOvernightAfterMidnight ? (day + 6) % 7 : day;
        return !!w[dayKeys[effectiveDay]] && timeControl.isInTimeWindow(adapter, w.start || '00:00', w.end || '00:00');
    });
    if (anyWindowActiveNow || anyWindowShouldBeActive) {
        adapter.log.debug(`Startup check: a time window is currently active (tracked=${anyWindowActiveNow}, shouldBeActive=${anyWindowShouldBeActive}) – leaving device state as-is`);
        return;
    }

    if (adapter.config.more_log_enabled) {
        adapter.log.info('Startup check: device appears to be running but no time window is active – checking for orphaned features');
    }

    try {
        if (heaterOn && anyWindowManagesHeater) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('Startup check: heater ON but no active window ? switching OFF');
            }
            await commands.setFeature(adapter, 'heater', false, {fromAutomation: true});
        }
        // UVC before filter (filter may need to stay for UVC daily ensure)
        if (uvcOn && anyWindowManagesUvc) {
            const todayH = uvcController.getTodayHours(adapter);
            const uvcMinH = adapter.config.uvc_daily_min_h ?? 2;
            if (todayH >= uvcMinH) {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info('Startup check: UVC ON but no active window ? switching OFF');
                }
                await commands.setFeature(adapter, 'uvc', false, {fromAutomation: true});
            } else {
                if (adapter.config.more_log_enabled) {
                    adapter.log.info(`Startup check: UVC ON, daily min not yet met (${todayH.toFixed(2)} h of ${uvcMinH} h) – keeping ON for daily ensure`);
                }
                // Filter must stay ON for UVC – skip filter shutdown
                return;
            }
        }
        if (filterOn && anyWindowManagesFilter) {
            if (adapter.config.more_log_enabled) {
                adapter.log.info('Startup check: filter ON but no active window ? switching OFF');
            }
            await commands.setFeature(adapter, 'filter', false, {fromAutomation: true});
        }
        polling.enableRapidPolling(adapter);
    } catch (err) {
        adapter.log.error(`Startup check: error while shutting down orphaned features – ${err.message}`);
    }
}

module.exports = {checkStartupDeviceState};
