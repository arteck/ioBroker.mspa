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
        const cfg = this.config;
        if (this._manualOverride) { this.log.debug('PV: manual override active – skipping'); return; }
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
            }, durationMin * 60 * 1000);
        }
        if (!enable) {
            await this.setStateAsync('control.manual_override_duration', 0);
            if (this._lastData && Object.keys(this._lastData).length) {
                await this.checkFrostProtection(this._lastData);
            }
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

// ===== 10. Manual Override ==================================================
console.log('\n══════════════════════════════════════════');
console.log(' 10. Manual Override');
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

    // --- Override ON: Frostschutz greift NICHT ---
    const a = new MockAdapter(cfg, true, true);
    a._now = new Date(2026, 3, 18);
    await a._setManualOverride(true);
    await a.checkFrostProtection({ water_temperature: 2 });
    assert('Override ON: Frostschutz trotz 2°C → KEIN heater ON', a.cmdCount('heater', true) === 0);

    // --- Override ON: PV greift NICHT ---
    const b = new MockAdapter(cfg, true, false);
    b._now = new Date(2026, 3, 18);
    await b._setManualOverride(true);
    b._pvPower = 2000; b._pvHouse = 100;
    await b.evaluatePvSurplus();
    assert('Override ON: PV-Überschuss greift NICHT', b._pvActive === false);
    assert('Override ON: kein heater-ON durch PV', b.cmdCount('heater', true) === 0);

    // --- Override OFF: PV wird sofort ausgewertet ---
    const c = new MockAdapter(cfg, true, false);
    c._now = new Date(2026, 3, 18);
    c._pvPower = 2000; c._pvHouse = 100;
    c._manualOverride = true; // war aktiv
    await c._setManualOverride(false); // deaktivieren → evaluatePvSurplus() wird aufgerufen
    assert('Override OFF: PV wird sofort ausgewertet → _pvActive=true', c._pvActive === true);
    assert('Override OFF: heater ON durch PV', c.cmdCount('heater', true) === 1);

    // --- Override OFF: Frostschutz wird sofort ausgewertet ---
    const d = new MockAdapter(cfg, true, true);
    d._now = new Date(2026, 3, 18);
    d._lastData = { water_temperature: 3 };
    d._manualOverride = true;
    await d._setManualOverride(false);
    assert('Override OFF: Frostschutz wird sofort ausgewertet → heater ON', d.cmdCount('heater', true) === 1);

    // --- Override mit Dauer: Timer wird gestartet ---
    const e = new MockAdapter(cfg, true, false);
    await e._setManualOverride(true, 30);
    assert('Override mit Dauer: _manualOverride=true', e._manualOverride === true);
    assert('Override mit Dauer: Timer läuft', e._manualOverrideTimer !== null);

    // --- Override deaktivieren: Timer wird gestoppt ---
    await e._setManualOverride(false);
    assert('Override deaktiviert: Timer gestoppt', e._manualOverrideTimer === null);
    assert('Override deaktiviert: _manualOverride=false', e._manualOverride === false);
})();

// ---------------------------------------------------------------------------
// Zusammenfassung
// ---------------------------------------------------------------------------
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

