'use strict';

/**
 * MSpa Adapter – Logik-Testlauf
 * Testet alle Steuerlogiken ohne echte API / ioBroker-Verbindung.
 *
 * Ausführen: node test_logic.js
 */

let passed = 0;
let failed = 0;
const errors = [];

function assert(label, condition) {
    if (condition) {
        console.log(`  ✅  ${label}`);
        passed++;
    } else {
        console.log(`  ❌  ${label}`);
        failed++;
        errors.push(label);
    }
}

// ---------------------------------------------------------------------------
// Mini-Mock des Adapters: nur die zu testenden Methoden + Hilfsfunktionen
// ---------------------------------------------------------------------------
class MockAdapter {
    constructor(config, seasonEnabled, winterModeActive) {
        this.config             = config;
        this._seasonEnabled     = seasonEnabled;
        this._winterModeActive  = winterModeActive;
        this._winterFrostActive = false;
        this._pvPower           = null;
        this._pvHouse           = null;
        this._pvActive          = false;
        this._pvDeactivateTimer        = null;
        this._pvDeactivateCountdown    = 0;
        this._pvDeactivateCountdownInt = null;
        this._timeWindowActive  = [];
        this._pumpStartedForHeating = false;
        this._pumpFollowUpTimers    = [];
        this._lastData          = {};
        this._rapidUntil        = 0;
        this._manualOverride      = false;
        this._manualOverrideTimer = null;

        // track commands issued
        this.commands   = [];   // [{feature, val}]
        this.logEntries = [];
        this.states     = {};

        this.log = {
            info:  (m) => this.logEntries.push({ level: 'info',  msg: m }),
            warn:  (m) => this.logEntries.push({ level: 'warn',  msg: m }),
            error: (m) => this.logEntries.push({ level: 'error', msg: m }),
            debug: (m) => this.logEntries.push({ level: 'debug', msg: m }),
        };
    }

    // --- Hilfsmethoden (aus main.js übernommen) ----------------------------
    isInSeason() {
        const cfg = this.config;
        if (!this._seasonEnabled) {
            this.log.debug('Season check: season_enabled=false → automatic controls blocked (only winter mode allowed)');
            return false;
        }
        const parseDate = (ddmm) => {
            const parts = (ddmm || '').split('.');
            return { day: parseInt(parts[0], 10) || 1, month: parseInt(parts[1], 10) || 1 };
        };
        const now   = this._now || new Date();
        const today = now.getDate();
        const month = now.getMonth() + 1;
        const start = parseDate(cfg.season_start || '01.01');
        const end   = parseDate(cfg.season_end   || '31.12');
        const toNum = (d) => d.month * 100 + d.day;
        const cur   = month * 100 + today;
        const s     = toNum(start);
        const e     = toNum(end);
        let inSeason;
        if (s <= e) {
            inSeason = cur >= s && cur <= e;
        } else {
            inSeason = cur >= s || cur <= e;
        }
        this.log.debug(`Season check: today=${today}.${month} (${cur}), season=${cfg.season_start}–${cfg.season_end} (${s}–${e}), inSeason=${inSeason}`);
        return inSeason;
    }

    isInTimeWindow(start, end) {
        const now   = this._now || new Date();
        const toMin = (hhmm) => {
            const [h, m] = hhmm.split(':').map(Number);
            return h * 60 + m;
        };
        const cur = now.getHours() * 60 + now.getMinutes();
        const s   = toMin(start);
        const e   = toMin(end);
        if (s === e)  return false;
        if (s < e)    return cur >= s && cur < e;
        return cur >= s || cur < e;
    }

    enableRapidPolling() { this._rapidUntil = Date.now() + 15_000; }

    async setFeature(feature, boolVal) {
        this.commands.push({ feature, val: boolVal });
    }

    async setStateAsync(id, val) { this.states[id] = val; }

    async checkFrostProtection(data) {
        if (this._manualOverride) { this.log.debug('Winter mode: manual override active – skipping'); return; }
        const cfg        = this.config;
        const winterMode = this._winterModeActive;
        if (!winterMode) {
            if (this._winterFrostActive) {
                this._winterFrostActive = false;
                this.log.info('Winter mode: disabled – switching heater + filter OFF');
                await this.setFeature('heater', false);
                await this.setFeature('filter', false);
            }
            return;
        }
        const threshold  = cfg.winter_frost_temp ?? 5;
        const hysteresis = 3;
        const temp = data.water_temperature;
        if (temp === undefined || temp === null) return;
        if (!this._winterFrostActive && temp <= threshold) {
            this._winterFrostActive = true;
            this.log.info(`Winter mode: temp ${temp}°C ≤ ${threshold}°C – switching heater + filter ON`);
            await this.setFeature('filter', true);
            await this.setFeature('heater', true);
            this.enableRapidPolling();
        } else if (this._winterFrostActive && temp >= threshold + hysteresis) {
            this._winterFrostActive = false;
            this.log.info(`Winter mode: temp ${temp}°C ≥ ${threshold + hysteresis}°C – switching heater + filter OFF`);
            await this.setFeature('heater', false);
            await this.setFeature('filter', false);
            this.enableRapidPolling();
        }
    }

    async evaluatePvSurplus() {
        if (this._manualOverride) { this.log.debug('PV: manual override active – skipping'); return; }
        const cfg = this.config;
        if (!this.isInSeason()) {
            this.log.debug('PV: outside season – skipping surplus evaluation');
            if (this._pvDeactivateTimer) {
                clearTimeout(this._pvDeactivateTimer);
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) { clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; }
                this._pvDeactivateCountdown = 0;
                await this.setStateAsync('computed.pv_deactivate_remaining', 0);
            }
            if (this._pvActive) {
                this._pvActive = false;
                this.log.info('PV: season ended – deactivating PV surplus control');
                const pvWindows = Array.isArray(cfg.timeWindows) ? cfg.timeWindows.filter(w => w.active && w.pv_steu) : [];
                for (const w of pvWindows) {
                    if (w.action_heating) {
                        await this.setFeature('heater', false);
                        if (!w.action_filter) await this.setFeature('filter', false);
                    }
                    if (w.action_filter) {
                        await this.setFeature('filter', false);
                        if (w.action_uvc) await this.setFeature('uvc', false);
                    }
                }
                this.enableRapidPolling();
            }
            return;
        }
        if (this._pvPower === null || this._pvHouse === null) return;
        const surplus    = this._pvPower - this._pvHouse;
        const threshold  = cfg.pv_threshold_w  || 500;
        const hysteresis = Math.min(cfg.pv_hysteresis_w || 100, threshold);
        const offAt      = threshold - hysteresis;
        const shouldActivate   = surplus >= threshold;
        const shouldDeactivate = surplus < offAt;
        const pvWindows = Array.isArray(cfg.timeWindows) ? cfg.timeWindows.filter(w => w.active && w.pv_steu) : [];
        if (pvWindows.length === 0) return;

        if (!this._pvActive && shouldActivate) {
            if (this._pvDeactivateTimer) {
                clearTimeout(this._pvDeactivateTimer);
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) { clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; }
                this._pvDeactivateCountdown = 0;
            }
            this._pvActive = true;
            this.log.info(`PV: surplus DETECTED (${surplus} W ≥ ${threshold} W) – activating`);
            for (const w of pvWindows) {
                if (w.action_heating) {
                    if (!w.action_filter) await this.setFeature('filter', true);
                    await this.setFeature('heater', true);
                    if (w.target_temp) await this._api_setTemp(w.target_temp);
                }
                if (w.action_filter) {
                    await this.setFeature('filter', true);
                    if (w.action_uvc) await this.setFeature('uvc', true);
                }
            }
            this.enableRapidPolling();
        } else if (this._pvActive && !shouldDeactivate && this._pvDeactivateTimer) {
            clearTimeout(this._pvDeactivateTimer);
            this._pvDeactivateTimer = null;
            if (this._pvDeactivateCountdownInt) { clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; }
            this._pvDeactivateCountdown = 0;
            await this.setStateAsync('computed.pv_deactivate_remaining', 0);
            this.log.info(`PV: surplus recovered – deactivation timer cancelled`);
        } else if (this._pvActive && shouldDeactivate && !this._pvDeactivateTimer) {
            const delayMin   = cfg.pv_deactivate_delay_min ?? 5;
            const debounceMs = delayMin * 60 * 1000;
            this.log.info(`PV: surplus below threshold – waiting ${delayMin} min before deactivating`);
            this._pvDeactivateCountdown = delayMin;
            await this.setStateAsync('computed.pv_deactivate_remaining', this._pvDeactivateCountdown);
            this._pvDeactivateTimer = setTimeout(async () => {
                this._pvDeactivateTimer = null;
                if (this._pvDeactivateCountdownInt) { clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; }
                this._pvDeactivateCountdown = 0;
                await this.setStateAsync('computed.pv_deactivate_remaining', 0);
                this._pvActive = false;
                this.log.info(`PV: deactivation delay elapsed – switching off`);
                for (const w of pvWindows) {
                    if (w.action_heating) {
                        await this.setFeature('heater', false);
                        if (!w.action_filter) await this.setFeature('filter', false);
                    }
                    if (w.action_filter) {
                        await this.setFeature('filter', false);
                        if (w.action_uvc) await this.setFeature('uvc', false);
                    }
                }
                this.enableRapidPolling();
            }, debounceMs);
        }
    }

    _api_setTemp(t) { this.commands.push({ feature: 'temperature', val: t }); }

    // Simplified stub – only tests the manual-override guard
    async checkTimeWindows() {
        if (this._manualOverride) { this.log.debug('Time control: manual override active – skipping'); this._timeWindowsCalledDuringOverride = true; return; }
        this._timeWindowsCalled = (this._timeWindowsCalled || 0) + 1;
    }

    async _setManualOverride(enable, durationMin = 0) {
        if (this._manualOverrideTimer) { clearTimeout(this._manualOverrideTimer); this._manualOverrideTimer = null; }
        this._manualOverride = enable;
        await this.setStateAsync('control.manual_override', enable);
        if (enable && durationMin > 0) {
            this._manualOverrideTimer = setTimeout(async () => {
                this._manualOverrideTimer = null;
                this._manualOverride = false;
                await this.setStateAsync('control.manual_override', false);
                await this.setStateAsync('control.manual_override_duration', 0);
                // Re-evaluate all automations after timer expires
                if (this._lastData && Object.keys(this._lastData).length) {
                    await this.checkFrostProtection(this._lastData);
                }
                await this.checkTimeWindows();
                await this.evaluatePvSurplus();
            }, durationMin * 60 * 1000);
        }
        if (!enable) {
            await this.setStateAsync('control.manual_override_duration', 0);
            if (this._lastData && Object.keys(this._lastData).length) {
                await this.checkFrostProtection(this._lastData);
            }
            await this.checkTimeWindows();
            await this.evaluatePvSurplus();
        }
    }

    cmdCount(feature, val) {
        return this.commands.filter(c => c.feature === feature && c.val === val).length;
    }
    lastCmd(feature) {
        const all = this.commands.filter(c => c.feature === feature);
        return all.length ? all[all.length - 1].val : undefined;
    }
    resetCommands() { this.commands = []; }
}

// ---------------------------------------------------------------------------
// ██████ TESTS ██████
// ---------------------------------------------------------------------------

(async () => {

// ===== 1. isInSeason() ======================================================
console.log('\n══════════════════════════════════════════');
console.log(' 1. isInSeason()');
console.log('══════════════════════════════════════════');

{
    // season_enabled = false → immer false
    const a = new MockAdapter({ season_start: '01.05', season_end: '30.09' }, false, false);
    assert('season_enabled=false → isInSeason()=false', a.isInSeason() === false);

    // season_enabled = true, Datum innerhalb (18.04 im Frühling)
    const b = new MockAdapter({ season_start: '01.04', season_end: '30.10' }, true, false);
    b._now = new Date(2026, 3, 18); // 18.04.2026
    assert('season_enabled=true, 18.04 in Saison (01.04–30.10) → true', b.isInSeason() === true);

    // season_enabled = true, Datum außerhalb
    const c = new MockAdapter({ season_start: '01.05', season_end: '30.09' }, true, false);
    c._now = new Date(2026, 3, 18); // 18.04 – VOR Saison
    assert('season_enabled=true, 18.04 außerhalb (01.05–30.09) → false', c.isInSeason() === false);

    // Jahresübergreifende Saison (01.10 – 31.03): Mitte Februar → true
    const d = new MockAdapter({ season_start: '01.10', season_end: '31.03' }, true, false);
    d._now = new Date(2026, 1, 15); // 15.02
    assert('Jahresübergreifende Saison 01.10–31.03: 15.02 → true', d.isInSeason() === true);

    // Jahresübergreifende Saison: Juli → false
    const e = new MockAdapter({ season_start: '01.10', season_end: '31.03' }, true, false);
    e._now = new Date(2026, 6, 1); // 01.07
    assert('Jahresübergreifende Saison 01.10–31.03: 01.07 → false', e.isInSeason() === false);

    // Exakt am Startdatum
    const f = new MockAdapter({ season_start: '18.04', season_end: '30.09' }, true, false);
    f._now = new Date(2026, 3, 18); // 18.04 = Startdatum
    assert('Exakt am Startdatum 18.04 → true', f.isInSeason() === true);

    // Exakt am Enddatum
    const g = new MockAdapter({ season_start: '01.04', season_end: '18.04' }, true, false);
    g._now = new Date(2026, 3, 18); // 18.04 = Enddatum
    assert('Exakt am Enddatum 18.04 → true', g.isInSeason() === true);

    // Tag nach Enddatum
    const h = new MockAdapter({ season_start: '01.04', season_end: '17.04' }, true, false);
    h._now = new Date(2026, 3, 18); // 18.04, Ende war 17.04
    assert('Tag nach Enddatum → false', h.isInSeason() === false);
}

// ===== 2. Wintermodus / checkFrostProtection() ==============================
console.log('\n══════════════════════════════════════════');
console.log(' 2. Wintermodus – checkFrostProtection()');
console.log('══════════════════════════════════════════');

await (async () => {
    // winter_mode = false → kein Einschalten
    const a = new MockAdapter({ winter_frost_temp: 5 }, false, false);
    await a.checkFrostProtection({ water_temperature: 3 });
    assert('winter_mode=false: Frost trotz 3°C → KEIN Einschalten', a.cmdCount('heater', true) === 0);

    // winter_mode = true, Temp unter Schwelle → einschalten
    const b = new MockAdapter({ winter_frost_temp: 5 }, false, true);
    await b.checkFrostProtection({ water_temperature: 4 });
    assert('winter_mode=true, 4°C ≤ 5°C → heater ON', b.cmdCount('heater', true) === 1);
    assert('winter_mode=true, 4°C ≤ 5°C → filter ON', b.cmdCount('filter', true) === 1);
    assert('_winterFrostActive=true gesetzt', b._winterFrostActive === true);

    // Hysterese: nach Einschalten bei 4°C, jetzt 7°C (5+2 < 8 = 5+3) → noch nicht aus
    b.resetCommands();
    await b.checkFrostProtection({ water_temperature: 7 });
    assert('Hysterese: 7°C < 8°C (5+3) → KEIN Ausschalten', b.cmdCount('heater', false) === 0);

    // Hysterese überschritten: 8°C → ausschalten
    b.resetCommands();
    await b.checkFrostProtection({ water_temperature: 8 });
    assert('Hysterese: 8°C ≥ 8°C (5+3) → heater OFF', b.cmdCount('heater', false) === 1);
    assert('_winterFrostActive=false zurückgesetzt', b._winterFrostActive === false);

    // winter_mode=false, aber _winterFrostActive war true → sofort ausschalten
    const c = new MockAdapter({ winter_frost_temp: 5 }, false, false);
    c._winterFrostActive = true;
    await c.checkFrostProtection({ water_temperature: 10 });
    assert('winter_mode deaktiviert während Frost aktiv → heater OFF', c.cmdCount('heater', false) === 1);
    assert('_winterFrostActive auf false zurückgesetzt', c._winterFrostActive === false);
})();

// ===== 3. season_enabled=false + winter_mode=true (Kombination) =============
console.log('\n══════════════════════════════════════════');
console.log(' 3. season_enabled=false + winter_mode=true');
console.log('══════════════════════════════════════════');

await (async () => {
    const a = new MockAdapter({ winter_frost_temp: 5 }, false, true);
    await a.checkFrostProtection({ water_temperature: 3 });
    assert('season_enabled=false + winter_mode=true → Frost greift trotzdem', a.cmdCount('heater', true) === 1);

    // PV darf NICHT schalten wenn season=false
    const b = new MockAdapter({
        winter_frost_temp: 5,
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    }, false, true);
    b._pvPower = 2000;
    b._pvHouse = 300;
    await b.evaluatePvSurplus();
    assert('season_enabled=false → PV-Überschuss schaltet NICHT', b._pvActive === false);
    assert('season_enabled=false → kein heater-ON durch PV', b.cmdCount('heater', true) === 0);
})();

// ===== 4. PV-Regelung – Grundfunktionen =====================================
console.log('\n══════════════════════════════════════════');
console.log(' 4. PV-Regelung – Grundfunktionen');
console.log('══════════════════════════════════════════');

await (async () => {
    const cfg = {
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,  // für Tests: kein Delay
        season_start: '01.01',
        season_end: '31.12',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true, action_uvc: false }],
    };

    // --- Aktivierung ---
    const a = new MockAdapter(cfg, true, false);
    a._now = new Date(2026, 3, 18);
    a._pvPower = 1000;
    a._pvHouse = 300;
    await a.evaluatePvSurplus();
    assert('PV: 700 W Überschuss ≥ 500 W → _pvActive=true', a._pvActive === true);
    assert('PV: heater ON', a.cmdCount('heater', true) === 1);
    assert('PV: filter ON', a.cmdCount('filter', true) === 1);

    // --- Kein erneutes Aktivieren wenn bereits aktiv ---
    a.resetCommands();
    a._pvPower = 1200;
    await a.evaluatePvSurplus();
    assert('PV: bereits aktiv, erneut Überschuss → kein Doppel-Befehl', a.cmdCount('heater', true) === 0);

    // --- Deaktivierungstimer wird gestartet wenn Überschuss wegfällt ---
    const b = new MockAdapter({ ...cfg, pv_deactivate_delay_min: 5 }, true, false);
    b._now = new Date(2026, 3, 18);
    b._pvActive = true;
    b._pvPower  = 100;
    b._pvHouse  = 200; // surplus = -100 < offAt=400
    await b.evaluatePvSurplus();
    assert('PV: Überschuss weg → Deaktivierungs-Timer gestartet', b._pvDeactivateTimer !== null);
    assert('PV: _pvActive noch true (timer läuft)', b._pvActive === true);

    // --- Surplus erholt sich, bevor Timer feuert → Timer abbrechen ---
    b._pvPower = 1000; // surplus = 800 W
    await b.evaluatePvSurplus();
    assert('PV: Überschuss erholt → Timer abgebrochen', b._pvDeactivateTimer === null);
    assert('PV: _pvActive weiterhin true', b._pvActive === true);

    // --- Nur filter, kein heating ---
    const c = new MockAdapter({
        ...cfg,
        timeWindows: [{ active: true, pv_steu: true, action_heating: false, action_filter: true, action_uvc: true }],
    }, true, false);
    c._now = new Date(2026, 3, 18);
    c._pvPower = 1000;
    c._pvHouse = 200;
    await c.evaluatePvSurplus();
    assert('PV filter-only: filter ON', c.cmdCount('filter', true) === 1);
    assert('PV filter-only: uvc ON', c.cmdCount('uvc', true) === 1);
    assert('PV filter-only: heater NICHT geschaltet', c.cmdCount('heater', true) === 0);
})();

// ===== 5. PV-Regelung – Saison-Guard ========================================
console.log('\n══════════════════════════════════════════');
console.log(' 5. PV-Regelung – Saison-Guard');
console.log('══════════════════════════════════════════');

await (async () => {
    const cfg = {
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,
        season_start: '01.05',
        season_end: '30.09',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    };

    // PV aktiv, Saison läuft aus (season_enabled=true, aber außerhalb des Datums)
    const a = new MockAdapter(cfg, true, false);
    a._now = new Date(2026, 3, 18); // 18.04 – vor Saison
    a._pvPower  = 1000;
    a._pvHouse  = 200;
    a._pvActive = true; // war aktiv
    await a.evaluatePvSurplus();
    assert('PV: Saison-Ende → _pvActive=false', a._pvActive === false);
    assert('PV: Saison-Ende → heater OFF', a.cmdCount('heater', false) === 1);
    assert('PV: Saison-Ende → filter OFF', a.cmdCount('filter', false) === 1);

    // PV außerhalb Saison → kein Aktivieren
    const b = new MockAdapter(cfg, true, false);
    b._now     = new Date(2026, 3, 18); // 18.04
    b._pvPower = 2000;
    b._pvHouse = 200;
    await b.evaluatePvSurplus();
    assert('PV: außerhalb Saison → kein Aktivieren', b._pvActive === false);
})();

// ===== 6. isInTimeWindow() ==================================================
console.log('\n══════════════════════════════════════════');
console.log(' 6. isInTimeWindow()');
console.log('══════════════════════════════════════════');

{
    const a = new MockAdapter({}, true, false);

    // 10:00 Uhr, Fenster 08:00–12:00
    a._now = new Date(2026, 3, 18, 10, 0);
    assert('10:00 in 08:00–12:00 → true', a.isInTimeWindow('08:00', '12:00') === true);

    // 13:00 Uhr, Fenster 08:00–12:00
    a._now = new Date(2026, 3, 18, 13, 0);
    assert('13:00 in 08:00–12:00 → false', a.isInTimeWindow('08:00', '12:00') === false);

    // Nachtfenster: 22:00–06:00, jetzt 23:00 → true
    a._now = new Date(2026, 3, 18, 23, 0);
    assert('23:00 in 22:00–06:00 (Nacht) → true', a.isInTimeWindow('22:00', '06:00') === true);

    // Nachtfenster: 22:00–06:00, jetzt 05:30 → true
    a._now = new Date(2026, 3, 18, 5, 30);
    assert('05:30 in 22:00–06:00 (Nacht) → true', a.isInTimeWindow('22:00', '06:00') === true);

    // Nachtfenster: 22:00–06:00, jetzt 12:00 → false
    a._now = new Date(2026, 3, 18, 12, 0);
    assert('12:00 in 22:00–06:00 (Nacht) → false', a.isInTimeWindow('22:00', '06:00') === false);

    // Leeres Fenster (start == end)
    assert('leeres Fenster 10:00–10:00 → false', a.isInTimeWindow('10:00', '10:00') === false);

    // Exakt am Startpunkt
    a._now = new Date(2026, 3, 18, 8, 0);
    assert('exakt am Start 08:00 → true', a.isInTimeWindow('08:00', '12:00') === true);

    // Exakt am Endpunkt (exklusiv)
    a._now = new Date(2026, 3, 18, 12, 0);
    assert('exakt am Ende 12:00 (exklusiv) → false', a.isInTimeWindow('08:00', '12:00') === false);
}

// ===== 7. season_enabled Umschalten (onStateChange-Logik) ===================
console.log('\n══════════════════════════════════════════');
console.log(' 7. season_enabled Umschalten');
console.log('══════════════════════════════════════════');

{
    // Simuliert onStateChange key='season_enabled'
    const a = new MockAdapter({ season_start: '01.05', season_end: '30.09' }, false, false);
    a._now = new Date(2026, 5, 1); // 01.06

    assert('Vor Umschalten: season_enabled=false → isInSeason()=false', a.isInSeason() === false);

    // Einschalten
    a._seasonEnabled = true;
    assert('Nach Einschalten: season_enabled=true, 01.06 in 01.05–30.09 → true', a.isInSeason() === true);

    // Ausschalten wieder
    a._seasonEnabled = false;
    assert('Nach Ausschalten: season_enabled=false → isInSeason()=false', a.isInSeason() === false);
}

// ===== 8. PV-Regelung mit season_enabled=true, innerhalb + außerhalb ========
console.log('\n══════════════════════════════════════════');
console.log(' 8. PV + season_enabled=true (Vollautomat)');
console.log('══════════════════════════════════════════');

{
    const cfg = {
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,
        season_start: '01.04',
        season_end: '31.10',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    };

    // Innerhalb Saison (18.04): PV aktiviert
    const a = new MockAdapter(cfg, true, false);
    a._now     = new Date(2026, 3, 18); // 18.04
    a._pvPower = 800;
    a._pvHouse = 100;
    a.evaluatePvSurplus();
    assert('Vollautomat: 18.04 in Saison, 700W Überschuss → PV aktiv', a._pvActive === true);

    // Außerhalb Saison (18.11): PV deaktiviert
    const b = new MockAdapter(cfg, true, false);
    b._now     = new Date(2026, 10, 18); // 18.11
    b._pvPower = 800;
    b._pvHouse = 100;
    b.evaluatePvSurplus();
    assert('Vollautomat: 18.11 außerhalb Saison → PV NICHT aktiv', b._pvActive === false);

    // War aktiv, jetzt Saison-Ende → abschalten
    const c = new MockAdapter(cfg, true, false);
    c._now     = new Date(2026, 10, 18); // 18.11
    c._pvPower = 800;
    c._pvHouse = 100;
    c._pvActive = true;
    c.evaluatePvSurplus();
    assert('Vollautomat: Saison-Ende während PV aktiv → heater OFF', c.cmdCount('heater', false) === 1);
    assert('Vollautomat: Saison-Ende während PV aktiv → _pvActive=false', c._pvActive === false);
}

// ===== 9. Wintermodus + season_enabled=true – Beide parallel ================
console.log('\n══════════════════════════════════════════');
console.log(' 9. Wintermodus + season_enabled=true parallel');
console.log('══════════════════════════════════════════');

{
    const cfg = {
        winter_frost_temp: 5,
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,
        season_start: '01.05',
        season_end: '30.09',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    };

    // Außerhalb Saison (Feb), Wintermodus=true → nur Frost greift
    const a = new MockAdapter(cfg, true, true);
    a._now = new Date(2026, 1, 1); // Feb
    a._pvPower = 2000;
    a._pvHouse = 100;
    await a.checkFrostProtection({ water_temperature: 3 });
    assert('Außerhalb Saison + winter_mode: Frost greift (heater ON)', a.cmdCount('heater', true) === 1);
    a.resetCommands();
    await a.evaluatePvSurplus();
    assert('Außerhalb Saison + winter_mode: PV greift NICHT', a._pvActive === false);
    assert('Außerhalb Saison + winter_mode: kein PV heater-ON', a.cmdCount('heater', true) === 0);
}

// ===== 10. Manual Override – Grundfunktionen ================================
console.log('\n══════════════════════════════════════════');
console.log(' 10. Manual Override – Grundfunktionen');
console.log('══════════════════════════════════════════');

await (async () => {
    const cfg = {
        winter_frost_temp: 5,
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 5,
        season_start: '01.01',
        season_end: '31.12',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    };

    // --- 10.1 setzen: _manualOverride=true, State gesetzt ---
    const a = new MockAdapter(cfg, true, false);
    await a._setManualOverride(true);
    assert('10.1 Override ON: _manualOverride=true', a._manualOverride === true);
    assert('10.1 Override ON: State gesetzt', a.states['control.manual_override'] === true);

    // --- 10.2 deaktivieren: _manualOverride=false, State zurückgesetzt ---
    await a._setManualOverride(false);
    assert('10.2 Override OFF: _manualOverride=false', a._manualOverride === false);
    assert('10.2 Override OFF: State zurückgesetzt', a.states['control.manual_override'] === false);
    assert('10.2 Override OFF: Duration-State auf 0', a.states['control.manual_override_duration'] === 0);

    // --- 10.3 Override ON: Frostschutz greift NICHT ---
    const b = new MockAdapter(cfg, true, true);
    b._now = new Date(2026, 3, 18);
    await b._setManualOverride(true);
    await b.checkFrostProtection({ water_temperature: 2 });
    assert('10.3 Override ON: Frost trotz 2°C → KEIN heater ON', b.cmdCount('heater', true) === 0);
    assert('10.3 Override ON: Frost Log enthält override-Meldung',
        b.logEntries.some(e => e.msg.includes('manual override') && e.msg.toLowerCase().includes('skip')));

    // --- 10.4 Override ON: PV-Überschuss greift NICHT ---
    const c = new MockAdapter(cfg, true, false);
    c._now = new Date(2026, 3, 18);
    await c._setManualOverride(true);
    c._pvPower = 2000; c._pvHouse = 100;
    await c.evaluatePvSurplus();
    assert('10.4 Override ON: PV greift NICHT → _pvActive=false', c._pvActive === false);
    assert('10.4 Override ON: kein heater-ON durch PV', c.cmdCount('heater', true) === 0);
    assert('10.4 Override ON: PV Log enthält override-Meldung',
        c.logEntries.some(e => e.msg.includes('manual override') && e.msg.toLowerCase().includes('skip')));

    // --- 10.5 Override ON: Zeitfenster-Kontrolle greift NICHT ---
    const d = new MockAdapter(cfg, true, false);
    d._now = new Date(2026, 3, 18);
    await d._setManualOverride(true);
    d._timeWindowsCalledDuringOverride = false;
    await d.checkTimeWindows();
    assert('10.5 Override ON: checkTimeWindows wird übersprungen',
        d._timeWindowsCalledDuringOverride === true && (d._timeWindowsCalled || 0) === 0);

    // --- 10.6 Override OFF: PV wird sofort ausgewertet ---
    const e2 = new MockAdapter(cfg, true, false);
    e2._now = new Date(2026, 3, 18);
    e2._pvPower = 2000; e2._pvHouse = 100;
    e2._manualOverride = true;
    await e2._setManualOverride(false);
    assert('10.6 Override OFF: PV sofort ausgewertet → _pvActive=true', e2._pvActive === true);
    assert('10.6 Override OFF: heater ON durch PV', e2.cmdCount('heater', true) === 1);
    assert('10.6 Override OFF: filter ON durch PV', e2.cmdCount('filter', true) === 1);

    // --- 10.7 Override OFF: Frostschutz wird sofort ausgewertet ---
    const f = new MockAdapter(cfg, true, true);
    f._now = new Date(2026, 3, 18);
    f._lastData = { water_temperature: 3 };
    f._manualOverride = true;
    await f._setManualOverride(false);
    assert('10.7 Override OFF: Frostschutz sofort ausgewertet → heater ON', f.cmdCount('heater', true) === 1);
    assert('10.7 Override OFF: _winterFrostActive=true', f._winterFrostActive === true);

    // --- 10.8 Override OFF: checkTimeWindows wird aufgerufen ---
    const g = new MockAdapter(cfg, true, false);
    g._manualOverride = true;
    await g._setManualOverride(false);
    assert('10.8 Override OFF: checkTimeWindows aufgerufen', (g._timeWindowsCalled || 0) >= 1);

    // --- 10.9 Mit Dauer: Timer gestartet, _manualOverride=true ---
    const h = new MockAdapter(cfg, true, false);
    await h._setManualOverride(true, 30);
    assert('10.9 Mit Dauer: _manualOverride=true', h._manualOverride === true);
    assert('10.9 Mit Dauer: Timer läuft', h._manualOverrideTimer !== null);
    clearTimeout(h._manualOverrideTimer); h._manualOverrideTimer = null; // cleanup

    // --- 10.10 Override erneut setzen: bestehender Timer wird gestoppt ---
    const i2 = new MockAdapter(cfg, true, false);
    await i2._setManualOverride(true, 60);
    const firstTimer = i2._manualOverrideTimer;
    assert('10.10 Erster Timer läuft', firstTimer !== null);
    await i2._setManualOverride(true, 10); // neuer kürzerer Timer
    assert('10.10 Neuer Timer ist anderes Objekt (alter gestoppt)', i2._manualOverrideTimer !== firstTimer);
    clearTimeout(i2._manualOverrideTimer); i2._manualOverrideTimer = null;

    // --- 10.11 Override deaktivieren: laufender Timer wird gestoppt ---
    const j = new MockAdapter(cfg, true, false);
    await j._setManualOverride(true, 30);
    assert('10.11 Timer vor Deaktivierung läuft', j._manualOverrideTimer !== null);
    await j._setManualOverride(false);
    assert('10.11 Timer nach Deaktivierung gestoppt', j._manualOverrideTimer === null);
    assert('10.11 _manualOverride=false', j._manualOverride === false);
})();

// ===== 11. Manual Override – Timer-Ablauf & Automationswiederaufnahme =======
console.log('\n══════════════════════════════════════════');
console.log(' 11. Manual Override – Timer-Ablauf');
console.log('══════════════════════════════════════════');

await (async () => {
    const cfg = {
        winter_frost_temp: 5,
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,
        season_start: '01.01',
        season_end: '31.12',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    };

    // --- 11.1 Timer läuft ab: _manualOverride wird auf false zurückgesetzt ---
    await new Promise(resolve => {
        const a = new MockAdapter(cfg, true, false);
        a._now = new Date(2026, 3, 20);
        a._pvPower = 2000; a._pvHouse = 100;
        // Sehr kurze Dauer (10 ms) für den Test
        a._manualOverrideTimer = setTimeout(async () => {
            a._manualOverrideTimer = null;
            a._manualOverride = false;
            await a.setStateAsync('control.manual_override', false);
            await a.setStateAsync('control.manual_override_duration', 0);
            await a.checkTimeWindows();
            await a.evaluatePvSurplus();
            assert('11.1 Timer abgelaufen: _manualOverride=false', a._manualOverride === false);
            assert('11.1 Timer abgelaufen: State false', a.states['control.manual_override'] === false);
            assert('11.1 Timer abgelaufen: PV sofort ausgewertet → _pvActive=true', a._pvActive === true);
            assert('11.1 Timer abgelaufen: checkTimeWindows aufgerufen', (a._timeWindowsCalled || 0) >= 1);
            resolve();
        }, 10);
        a._manualOverride = true;
    });

    // --- 11.2 Timer läuft ab: Frostschutz wird ausgewertet ---
    await new Promise(resolve => {
        const b = new MockAdapter(cfg, true, true);
        b._now = new Date(2026, 3, 20);
        b._lastData = { water_temperature: 2 };
        b._manualOverrideTimer = setTimeout(async () => {
            b._manualOverrideTimer = null;
            b._manualOverride = false;
            await b.setStateAsync('control.manual_override', false);
            if (b._lastData && Object.keys(b._lastData).length) {
                await b.checkFrostProtection(b._lastData);
            }
            await b.checkTimeWindows();
            await b.evaluatePvSurplus();
            assert('11.2 Timer abgelaufen: Frost ausgewertet → heater ON', b.cmdCount('heater', true) === 1);
            assert('11.2 Timer abgelaufen: _winterFrostActive=true', b._winterFrostActive === true);
            resolve();
        }, 10);
        b._manualOverride = true;
    });

    // --- 11.3 Override während PV aktiv: PV läuft weiter (keine erzwungene Abschaltung) ---
    const c = new MockAdapter(cfg, true, false);
    c._now = new Date(2026, 3, 20);
    c._pvActive = true;  // PV war schon aktiv als Override gesetzt wurde
    c._pvPower = 2000; c._pvHouse = 100;
    await c._setManualOverride(true);
    // PV soll sich nicht selbst abschalten durch Override allein
    assert('11.3 Override ON bei aktivem PV: _pvActive bleibt true', c._pvActive === true);
    await c._setManualOverride(false);
    // Nach Deaktivierung: PV-Evaluation → noch aktiv (Überschuss weiterhin da)
    assert('11.3 Override OFF: PV bleibt aktiv (Überschuss noch da)', c._pvActive === true);

    // --- 11.4 Doppelter Override ON ohne Dauer: kein Timer ---
    const d = new MockAdapter(cfg, true, false);
    await d._setManualOverride(true, 0);
    assert('11.4 Override ON ohne Dauer: kein Timer', d._manualOverrideTimer === null);
    assert('11.4 Override ON ohne Dauer: _manualOverride=true', d._manualOverride === true);
    await d._setManualOverride(false);
})();

// ===== 12. Manual Override – Zusammenspiel mit season_enabled ===============
console.log('\n══════════════════════════════════════════');
console.log(' 12. Manual Override + Season');
console.log('══════════════════════════════════════════');

await (async () => {
    const cfg = {
        winter_frost_temp: 5,
        pv_threshold_w: 500,
        pv_hysteresis_w: 100,
        pv_deactivate_delay_min: 0,
        season_start: '01.01',
        season_end: '31.12',
        timeWindows: [{ active: true, pv_steu: true, action_heating: true, action_filter: true }],
    };

    // --- 12.1 Override ON + season_enabled=false: beide blockieren PV ---
    const a = new MockAdapter(cfg, false, false);
    a._now = new Date(2026, 3, 20);
    a._pvPower = 2000; a._pvHouse = 100;
    await a._setManualOverride(true);
    await a.evaluatePvSurplus();
    assert('12.1 Override ON + season=false: PV greift nicht', a._pvActive === false);

    // --- 12.2 Override OFF + season=false: PV greift immer noch nicht ---
    const b = new MockAdapter(cfg, false, false);
    b._now = new Date(2026, 3, 20);
    b._pvPower = 2000; b._pvHouse = 100;
    b._manualOverride = true;
    await b._setManualOverride(false); // Override aufheben, aber season=false
    assert('12.2 Override OFF + season=false: PV greift trotzdem nicht', b._pvActive === false);

    // --- 12.3 Override OFF + season=true: PV greift ---
    const c = new MockAdapter(cfg, true, false);
    c._now = new Date(2026, 3, 20);
    c._pvPower = 2000; c._pvHouse = 100;
    c._manualOverride = true;
    await c._setManualOverride(false);
    assert('12.3 Override OFF + season=true: PV greift → _pvActive=true', c._pvActive === true);
})();


// ===== 13. UVC Stundenzähler – _accumulateUvcHours / _getUvcTodayHours =====
console.log('\n══════════════════════════════════════════');
console.log(' 13. UVC Stundenzähler');
console.log('══════════════════════════════════════════');

{
    // _accumulateUvcHours und _getUvcTodayHours werden direkt auf dem Mock getestet.
    // Der Mock erbt die Methoden nicht aus main.js, daher implementieren wir sie inline.
    const makeUvcAdapter = (usedH = 0, dayStartH = 0, dayStartDate = '2026-04-20') => {
        const a = new MockAdapter({}, true, false);
        a._uvcHoursUsed     = usedH;
        a._uvcOnSince       = null;
        a._uvcDayStartHours = dayStartH;
        a._uvcDayStartDate  = dayStartDate;

        a._accumulateUvcHours = function() {
            let total = this._uvcHoursUsed || 0;
            if (this._uvcOnSince !== null) {
                total += (Date.now() - this._uvcOnSince) / (1000 * 3600);
            }
            return total;
        };
        a._todayStr = function() {
            const d = this._now || new Date();
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        };
        a._getUvcTodayHours = function() {
            const today = this._todayStr();
            if (this._uvcDayStartDate !== today) {
                this._uvcDayStartHours = this._uvcHoursUsed;
                this._uvcDayStartDate  = today;
            }
            return Math.max(0, this._accumulateUvcHours() - this._uvcDayStartHours);
        };
        return a;
    };

    // 13.1 UVC aus – keine laufende Session – korrekte Summe
    {
        const a = makeUvcAdapter(3.5);
        assert('13.1 UVC OFF: _accumulateUvcHours = gespeicherte Stunden', Math.abs(a._accumulateUvcHours() - 3.5) < 0.001);
    }

    // 13.2 UVC läuft seit 1 Stunde
    {
        const a = makeUvcAdapter(1.0);
        a._uvcOnSince = Date.now() - 3600_000; // vor 1 h gestartet
        const total = a._accumulateUvcHours();
        assert('13.2 UVC ON seit 1h: Gesamt ≈ 2.0 h', Math.abs(total - 2.0) < 0.01);
    }

    // 13.3 _getUvcTodayHours – heute 0.5 h gelaufen (dayStartH=3.0, total=3.5)
    {
        const a = makeUvcAdapter(3.5, 3.0, '2026-04-20');
        a._now = new Date(2026, 3, 20, 12, 0);
        assert('13.3 TodayHours = 0.5 h', Math.abs(a._getUvcTodayHours() - 0.5) < 0.001);
    }

    // 13.4 _getUvcTodayHours – Datumswechsel → Snapshot wird zurückgesetzt
    {
        const a = makeUvcAdapter(5.0, 3.0, '2026-04-19'); // gestern gespeichert
        a._now = new Date(2026, 3, 20, 0, 1); // heute
        const todayH = a._getUvcTodayHours();
        assert('13.4 Datumswechsel: DayStartHours auf aktuelle Total gesetzt', a._uvcDayStartHours === 5.0);
        assert('13.4 Datumswechsel: TodayHours = 0', todayH === 0);
        assert('13.4 Datumswechsel: DayStartDate auf heute', a._uvcDayStartDate === '2026-04-20');
    }

    // 13.5 UVC läuft – TodayHours schließt laufende Session ein
    {
        const a = makeUvcAdapter(1.5, 1.0, '2026-04-20');
        a._now = new Date(2026, 3, 20, 12, 0);
        a._uvcOnSince = Date.now() - 1800_000; // 30 min laufend
        const todayH = a._getUvcTodayHours();
        assert('13.5 TodayHours mit laufender Session ≈ 1.0 h', Math.abs(todayH - 1.0) < 0.01);
    }
}

// ===== 14. checkUvcDailyMinimum – Steuerlogik ================================
console.log('\n══════════════════════════════════════════');
console.log(' 14. checkUvcDailyMinimum – Steuerlogik');
console.log('══════════════════════════════════════════');

await (async () => {
    // Hilfsfunktion: baut einen MockAdapter mit checkUvcDailyMinimum-fähiger Logik
    const makeUvcMock = (overrides = {}) => {
        const cfg = {
            uvc_daily_min_h:      2,
            uvc_daily_ensure_time: '10:00',
            timeWindows: [],
            season_start: '01.01',
            season_end:   '31.12',
            ...overrides.cfg,
        };
        const a = new MockAdapter(cfg, overrides.seasonEnabled !== false, false);
        a._now                 = overrides.now || new Date(2026, 3, 20, 12, 0); // 20.04.2026 12:00
        a._uvcHoursUsed        = overrides.uvcHoursUsed  || 0;
        a._uvcOnSince          = overrides.uvcOnSince     || null;
        a._uvcDayStartHours    = overrides.uvcDayStartH   || 0;
        a._uvcDayStartDate     = overrides.uvcDayStartDate || '2026-04-20';
        a._uvcEnsureActive     = overrides.ensureActive   || false;
        a._uvcEnsureFilterStart= overrides.ensureFilterStart || false;
        a._uvcEnsureDate       = overrides.ensureDate     || '';
        a._uvcEnsureSkipToday  = overrides.skipToday      || false;
        a._uvcEnsureSkipDate   = overrides.skipDate       || '';
        a._winterFrostActive   = overrides.winterFrost    || false;
        a._manualOverride      = overrides.manualOverride || false;
        a._timeWindowActive    = overrides.timeWindowActive || [];

        // Methoden aus main.js inline
        a._todayStr = function() {
            const d = this._now || new Date();
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        };
        a._accumulateUvcHours = function() {
            let total = this._uvcHoursUsed || 0;
            if (this._uvcOnSince !== null) {
                total += (Date.now() - this._uvcOnSince) / (1000 * 3600);
            }
            return total;
        };
        a._getUvcTodayHours = function() {
            const today = this._todayStr();
            if (this._uvcDayStartDate !== today) {
                this._uvcDayStartHours = this._uvcHoursUsed;
                this._uvcDayStartDate  = today;
            }
            return Math.max(0, this._accumulateUvcHours() - this._uvcDayStartHours);
        };
        a.getStateAsync = async (id) => {
            const val = a.states[id];
            return val !== undefined ? { val } : null;
        };
        a._stopUvcEnsure = async function() {
            this._uvcEnsureActive = false;
            await this.setFeature('uvc', false);
            if (this._uvcEnsureFilterStart && !this._winterFrostActive) {
                await this.setFeature('filter', false);
            }
            this._uvcEnsureFilterStart = false;
        };
        a.checkUvcDailyMinimum = async function() {
            const minH = this.config.uvc_daily_min_h ?? 2;
            if (!minH || minH <= 0) return;

            if (this._manualOverride) {
                if (this._uvcEnsureActive) await this._stopUvcEnsure();
                return;
            }

            const today = this._todayStr();
            if (this._uvcEnsureSkipToday) {
                const skipDate = this._uvcEnsureSkipDate || this._uvcEnsureDate;
                if (!skipDate || skipDate !== today) {
                    this._uvcEnsureSkipToday = false;
                    this._uvcEnsureSkipDate  = '';
                    await this.setStateAsync('control.uvc_ensure_skip_today', false);
                }
            }
            if (this._uvcEnsureSkipToday) {
                if (this._uvcEnsureActive) await this._stopUvcEnsure();
                return;
            }
            if (!this._seasonEnabled) {
                if (this._uvcEnsureActive) await this._stopUvcEnsure();
                return;
            }
            if (this._winterFrostActive) return;

            const ensureTime = this.config.uvc_daily_ensure_time || '10:00';
            const now        = this._now || new Date();
            const [hh, mm]   = ensureTime.split(':').map(Number);
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const ensureMin  = (hh || 0) * 60 + (mm || 0);
            const todayH     = this._getUvcTodayHours();

            if (this._uvcEnsureActive && this._uvcEnsureDate && this._uvcEnsureDate !== today) {
                await this._stopUvcEnsure();
            }

            if (todayH >= minH) {
                if (this._uvcEnsureActive) await this._stopUvcEnsure();
                return;
            }

            const anyWindowActive = this._timeWindowActive.some(v => v);
            if (anyWindowActive) return;

            const windows  = this.config.timeWindows;
            const day      = now.getDay();
            const dayKeys  = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'];
            let lastWinEnd = -1;
            if (Array.isArray(windows)) {
                for (const w of windows) {
                    if (!w.active || !w[dayKeys[day]]) continue;
                    const [eH, eM] = (w.end || '00:00').split(':').map(Number);
                    const eMin = (eH || 0) * 60 + (eM || 0);
                    if (eMin > lastWinEnd) lastWinEnd = eMin;
                }
            }

            const ensureTimeReached = nowMinutes >= ensureMin;
            const lastWindowPassed  = lastWinEnd >= 0 && nowMinutes >= lastWinEnd;
            if (!ensureTimeReached && !lastWindowPassed) return;

            if (!this._uvcEnsureActive) {
                this._uvcEnsureActive = true;
                this._uvcEnsureDate   = today;
                const filterState = await this.getStateAsync('control.filter');
                if (!filterState || !filterState.val) {
                    await this.setFeature('filter', true);
                    this._uvcEnsureFilterStart = true;
                } else {
                    this._uvcEnsureFilterStart = false;
                }
                const uvcState = await this.getStateAsync('control.uvc');
                if (!uvcState || !uvcState.val) {
                    await this.setFeature('uvc', true);
                }
            }
        };
        return a;
    };

    // --- 14.1 Zu früh: ensureTime noch nicht erreicht, kein Fenster → kein Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 9, 30) }); // 09:30, ensureTime=10:00
        await a.checkUvcDailyMinimum();
        assert('14.1 Zu früh (09:30 < 10:00): kein Start', a._uvcEnsureActive === false);
        assert('14.1 Zu früh: kein UVC-ON', a.cmdCount('uvc', true) === 0);
    }

    // --- 14.2 ensureTime erreicht, Minimum nicht erfüllt → Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 10, 5) }); // 10:05
        await a.checkUvcDailyMinimum();
        assert('14.2 ensureTime erreicht, 0h < 2h → _uvcEnsureActive=true', a._uvcEnsureActive === true);
        assert('14.2 filter ON gestartet', a.cmdCount('filter', true) === 1);
        assert('14.2 UVC ON gestartet', a.cmdCount('uvc', true) === 1);
        assert('14.2 _uvcEnsureFilterStart=true', a._uvcEnsureFilterStart === true);
    }

    // --- 14.3 Filter läuft bereits → filter nicht nochmals starten ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 10, 5) });
        a.states['control.filter'] = true;
        await a.checkUvcDailyMinimum();
        assert('14.3 Filter läuft bereits: kein filter-ON', a.cmdCount('filter', true) === 0);
        assert('14.3 Filter läuft bereits: UVC ON', a.cmdCount('uvc', true) === 1);
        assert('14.3 _uvcEnsureFilterStart=false', a._uvcEnsureFilterStart === false);
    }

    // --- 14.4 UVC läuft bereits → UVC nicht nochmals starten ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 10, 5) });
        a.states['control.uvc'] = true;
        await a.checkUvcDailyMinimum();
        assert('14.4 UVC läuft bereits: nur 1x UVC-ON (nicht doppelt)', a.cmdCount('uvc', true) === 0);
        assert('14.4 filter-ON gestartet', a.cmdCount('filter', true) === 1);
    }

    // --- 14.5 Minimum bereits erreicht → kein Start ---
    {
        const a = makeUvcMock({
            now: new Date(2026, 3, 20, 12, 0),
            uvcHoursUsed: 5.0,
            uvcDayStartH: 3.0, // today = 2.0 h ≥ minH=2
            uvcDayStartDate: '2026-04-20',
        });
        await a.checkUvcDailyMinimum();
        assert('14.5 Minimum bereits erreicht (2h): kein Start', a._uvcEnsureActive === false);
        assert('14.5 Minimum bereits erreicht: kein UVC-ON', a.cmdCount('uvc', true) === 0);
    }

    // --- 14.6 Minimum während Ensure erreicht → Stoppen ---
    {
        const a = makeUvcMock({
            now: new Date(2026, 3, 20, 12, 0),
            uvcHoursUsed: 5.0,
            uvcDayStartH: 3.0,
            uvcDayStartDate: '2026-04-20',
            ensureActive: true,
            ensureFilterStart: true,
            ensureDate: '2026-04-20',
        });
        await a.checkUvcDailyMinimum();
        assert('14.6 Minimum erreicht während Ensure läuft → gestoppt', a._uvcEnsureActive === false);
        assert('14.6 UVC OFF', a.cmdCount('uvc', false) === 1);
        assert('14.6 filter OFF (war von Ensure gestartet)', a.cmdCount('filter', false) === 1);
    }

    // --- 14.7 Manual Override → kein Start, läuft → Stopp ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), manualOverride: true });
        await a.checkUvcDailyMinimum();
        assert('14.7 Manual Override: kein Start', a._uvcEnsureActive === false);
    }
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), manualOverride: true, ensureActive: true, ensureDate: '2026-04-20' });
        await a.checkUvcDailyMinimum();
        assert('14.7 Manual Override während Ensure aktiv → gestoppt', a._uvcEnsureActive === false);
    }

    // --- 14.8 season=false → kein Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), seasonEnabled: false });
        await a.checkUvcDailyMinimum();
        assert('14.8 Season=false: kein Start', a._uvcEnsureActive === false);
    }

    // --- 14.9 Frost aktiv → kein Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), winterFrost: true });
        await a.checkUvcDailyMinimum();
        assert('14.9 Frost aktiv: kein UVC-Ensure-Start', a._uvcEnsureActive === false);
    }

    // --- 14.10 SkipToday → kein Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), skipToday: true, skipDate: '2026-04-20' });
        await a.checkUvcDailyMinimum();
        assert('14.10 SkipToday: kein Start', a._uvcEnsureActive === false);
    }

    // --- 14.11 SkipToday vom Vortag → Reset, dann Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), skipToday: true, skipDate: '2026-04-19' }); // gestern
        await a.checkUvcDailyMinimum();
        assert('14.11 SkipToday vom Vortag → zurückgesetzt', a._uvcEnsureSkipToday === false);
        assert('14.11 SkipToday vom Vortag → Ensure gestartet', a._uvcEnsureActive === true);
    }

    // --- 14.12 Zeitfenster noch aktiv → kein Start ---
    {
        const a = makeUvcMock({ now: new Date(2026, 3, 20, 12, 0), timeWindowActive: [true] });
        await a.checkUvcDailyMinimum();
        assert('14.12 Zeitfenster noch aktiv: kein Ensure-Start', a._uvcEnsureActive === false);
    }

    // --- 14.13 Datumswechsel → laufender Ensure wird gestoppt ---
    {
        const a = makeUvcMock({
            now: new Date(2026, 3, 21, 0, 5), // 21.04 – neuer Tag
            ensureActive: true,
            ensureDate: '2026-04-20',       // war gestern
        });
        await a.checkUvcDailyMinimum();
        assert('14.13 Datumswechsel: Ensure vom Vortag gestoppt', a._uvcEnsureActive === false);
    }
})();

// ===== 15. checkUvcDailyMinimum – Zeitfenster-Interaktion ==================
console.log('\n══════════════════════════════════════════');
console.log(' 15. UVC Ensure – Zeitfenster-Interaktion');
console.log('══════════════════════════════════════════');

await (async () => {
    // Montag = 1 → day_mon
    const mondayMorning   = new Date(2026, 3, 20, 9, 30);  // Mo 09:30
    const mondayAfternoon = new Date(2026, 3, 20, 14, 0);  // Mo 14:00
    const mondayEvening   = new Date(2026, 3, 20, 16, 5);  // Mo 16:05

    const makeWinMock = (now, windowEnd, ensureTime = '10:00', uvcDayH = 0) => {
        const a = new MockAdapter({
            uvc_daily_min_h: 2,
            uvc_daily_ensure_time: ensureTime,
            season_start: '01.01', season_end: '31.12',
            timeWindows: [{
                active: true,
                day_mon: true,
                start: '08:00',
                end: windowEnd,
            }],
        }, true, false);
        a._now = now;
        a._uvcHoursUsed     = uvcDayH;
        a._uvcDayStartHours = 0;
        a._uvcDayStartDate  = '2026-04-20';
        a._uvcEnsureActive  = false;
        a._uvcEnsureDate    = '';
        a._uvcEnsureSkipToday  = false;
        a._timeWindowActive = [false]; // Fenster gerade nicht aktiv
        a._todayStr = function() {
            const d = this._now || new Date();
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        };
        a._accumulateUvcHours = function() { return this._uvcHoursUsed || 0; };
        a._getUvcTodayHours = function() {
            return Math.max(0, this._accumulateUvcHours() - this._uvcDayStartHours);
        };
        a.getStateAsync = async (id) => ({ val: a.states[id] || false });
        a._stopUvcEnsure = async function() {
            this._uvcEnsureActive = false;
            await this.setFeature('uvc', false);
            if (this._uvcEnsureFilterStart && !this._winterFrostActive) {
                await this.setFeature('filter', false);
            }
            this._uvcEnsureFilterStart = false;
        };
        // checkUvcDailyMinimum aus Abschnitt 14 wiederverwenden
        a.checkUvcDailyMinimum = MockAdapter.prototype.checkUvcDailyMinimum || (async function() {});
        return a;
    };

    // Wir bauen die checkUvcDailyMinimum direkt auf dem Prototype (Inline-Kopie)
    async function runCheck(a) {
        const minH = a.config.uvc_daily_min_h ?? 2;
        if (!minH || minH <= 0) return;
        if (a._manualOverride) { if (a._uvcEnsureActive) await a._stopUvcEnsure(); return; }
        const today = a._todayStr();
        if (a._uvcEnsureSkipToday) return;
        if (!a._seasonEnabled) { if (a._uvcEnsureActive) await a._stopUvcEnsure(); return; }
        if (a._winterFrostActive) return;
        const ensureTime = a.config.uvc_daily_ensure_time || '10:00';
        const now = a._now || new Date();
        const [hh, mm] = ensureTime.split(':').map(Number);
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const ensureMin  = (hh || 0) * 60 + (mm || 0);
        const todayH     = a._getUvcTodayHours();
        if (a._uvcEnsureActive && a._uvcEnsureDate && a._uvcEnsureDate !== today) { await a._stopUvcEnsure(); }
        if (todayH >= minH) { if (a._uvcEnsureActive) await a._stopUvcEnsure(); return; }
        const anyWindowActive = a._timeWindowActive.some(v => v);
        if (anyWindowActive) return;
        const windows  = a.config.timeWindows;
        const day      = now.getDay();
        const dayKeys  = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'];
        let lastWinEnd = -1;
        if (Array.isArray(windows)) {
            for (const w of windows) {
                if (!w.active || !w[dayKeys[day]]) continue;
                const [eH, eM] = (w.end || '00:00').split(':').map(Number);
                const eMin = (eH || 0) * 60 + (eM || 0);
                if (eMin > lastWinEnd) lastWinEnd = eMin;
            }
        }
        const ensureTimeReached = nowMinutes >= ensureMin;
        const lastWindowPassed  = lastWinEnd >= 0 && nowMinutes >= lastWinEnd;
        if (!ensureTimeReached && !lastWindowPassed) return;
        if (!a._uvcEnsureActive) {
            a._uvcEnsureActive = true; a._uvcEnsureDate = today;
            const fs = await a.getStateAsync('control.filter');
            if (!fs || !fs.val) { await a.setFeature('filter', true); a._uvcEnsureFilterStart = true; }
            else { a._uvcEnsureFilterStart = false; }
            const us = await a.getStateAsync('control.uvc');
            if (!us || !us.val) { await a.setFeature('uvc', true); }
        }
    }

    // --- 15.1 Fenster endet 16:00 – ensureTime=10:00 – jetzt 14:00 → ensureTime triggers zuerst ---
    {
        const a = makeWinMock(mondayAfternoon, '16:00', '10:00');
        await runCheck(a);
        assert('15.1 ensureTime (10:00) zuerst erreicht vor Fensterende (16:00): Ensure startet', a._uvcEnsureActive === true);
    }

    // --- 15.2 Fenster endet 09:00 – ensureTime=10:00 – jetzt 09:30 → Fenster vorbei, kein Fenster aktiv → Start ---
    {
        const a = makeWinMock(mondayMorning, '09:00', '10:00');
        await runCheck(a);
        // Fenster ist vorbei (kein aktives Fenster mehr), lastWindowPassed=true → OR-Logik → Ensure startet
        assert('15.2 Fenster vorbei (09:00), kein Fenster aktiv, ensureTime noch nicht (10:00) → Ensure startet trotzdem', a._uvcEnsureActive === true);
    }

    // --- 15.3 Fenster endet 09:00 – ensureTime=10:00 – jetzt 10:05 → beide vorbei → Start ---
    {
        const a = makeWinMock(new Date(2026, 3, 20, 10, 5), '09:00', '10:00');
        await runCheck(a);
        assert('15.3 Fenster UND ensureTime vorbei → Ensure startet', a._uvcEnsureActive === true);
    }

    // --- 15.4 Fenster endet 16:00 – ensureTime=18:00 – jetzt 16:05 → Fenster vorbei, startet ---
    {
        const a = makeWinMock(mondayEvening, '16:00', '18:00');
        await runCheck(a);
        assert('15.4 Letztes Fenster beendet (16:00 < 16:05), ensureTime noch nicht (18:00): Ensure startet trotzdem', a._uvcEnsureActive === true);
    }

    // --- 15.5 Fenster noch aktiv (in _timeWindowActive) → kein Start ---
    {
        const a = makeWinMock(mondayAfternoon, '16:00', '10:00');
        a._timeWindowActive = [true];
        await runCheck(a);
        assert('15.5 Zeitfenster noch aktiv → kein Ensure-Start', a._uvcEnsureActive === false);
    }

    // --- 15.6 UVC lief bereits 2h im Zeitfenster → ensureTime erreicht aber Minimum erfüllt → kein Start ---
    {
        const a = makeWinMock(new Date(2026, 3, 20, 11, 0), '16:00', '10:00', 2.0); // 2h bereits
        await runCheck(a);
        assert('15.6 Minimum (2h) bereits durch Zeitfenster erfüllt → kein Ensure', a._uvcEnsureActive === false);
    }
})();

// ===== 16. _stopUvcEnsure – Stopp-Logik ====================================
console.log('\n══════════════════════════════════════════');
console.log(' 16. _stopUvcEnsure – Stopp-Logik');
console.log('══════════════════════════════════════════');

await (async () => {
    const makeStop = (filterStart, winterFrost = false) => {
        const a = new MockAdapter({}, true, false);
        a._uvcEnsureActive      = true;
        a._uvcEnsureFilterStart = filterStart;
        a._winterFrostActive    = winterFrost;
        a._stopUvcEnsure = async function() {
            this._uvcEnsureActive = false;
            await this.setFeature('uvc', false);
            if (this._uvcEnsureFilterStart) {
                if (this._winterFrostActive) {
                    // Filter bleibt AN wegen Frost
                } else {
                    await this.setFeature('filter', false);
                }
                this._uvcEnsureFilterStart = false;
            }
        };
        return a;
    };

    // --- 16.1 Ensure hatte Filter gestartet → filter+UVC OFF ---
    {
        const a = makeStop(true);
        await a._stopUvcEnsure();
        assert('16.1 _uvcEnsureActive=false', a._uvcEnsureActive === false);
        assert('16.1 UVC OFF', a.cmdCount('uvc', false) === 1);
        assert('16.1 Filter OFF (war von Ensure gestartet)', a.cmdCount('filter', false) === 1);
        assert('16.1 _uvcEnsureFilterStart=false', a._uvcEnsureFilterStart === false);
    }

    // --- 16.2 Ensure hatte Filter NICHT gestartet → nur UVC OFF ---
    {
        const a = makeStop(false);
        await a._stopUvcEnsure();
        assert('16.2 UVC OFF', a.cmdCount('uvc', false) === 1);
        assert('16.2 Filter NICHT gestoppt (nicht von Ensure gestartet)', a.cmdCount('filter', false) === 0);
    }

    // --- 16.3 Frost aktiv: Filter bleibt AN obwohl Ensure ihn gestartet hatte ---
    {
        const a = makeStop(true, true);
        await a._stopUvcEnsure();
        assert('16.3 Frost aktiv: UVC OFF', a.cmdCount('uvc', false) === 1);
        assert('16.3 Frost aktiv: Filter bleibt AN', a.cmdCount('filter', false) === 0);
    }
})();


console.log('\n══════════════════════════════════════════');
console.log(` ERGEBNIS: ${passed} bestanden, ${failed} fehlgeschlagen`);
if (errors.length > 0) {
    console.log('\nFehlgeschlagene Tests:');
    for (const e of errors) console.log(`  ❌ ${e}`);
    process.exit(1);
} else {
    console.log('\n🎉 Alle Tests bestanden!');
    process.exit(0);
}

})().catch(err => { console.error('Test-Runner Fehler:', err); process.exit(2); });

