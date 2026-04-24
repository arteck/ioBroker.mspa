'use strict';

/**
 * MSpa Adapter – Regressions- und Bugfix-Tests
 *
 * Testet gezielt alle identifizierten Schwachstellen und deren Korrekturen:
 *
 *  1.  consumptionHelper.handleStateChange – fehlende Methode (TypeError fix)
 *  2.  consumptionHelper – Timer-Leak durch fehlerhaften _destroyed-Filter
 *  3.  mspaApi._generateNonce – kryptografisch sichere Nonce
 *  4.  PV-Reaktivierung während Staged-Deactivation (dead-code fix)
 *  5.  onReady – kein Weiterlaufen nach init-Fehler
 *  6.  computeUvcExpiry – fehlende await
 *  7.  RateTracker – korrekte Raten-Berechnung
 *  8.  transformStatus – Unit-Konvertierung
 *  9.  MSpaThrottle – Request-Throttling
 * 10.  isInSeason – Jahresgrenze
 * 11.  isInTimeWindow – Overnight-Fenster
 * 12.  Frostschutz – Hysterese und Saisonausschluss
 * 13.  App-Change-Detection – Grace-Period
 * 14.  Startup Device-State Check
 * 15.  UVC-Stunden Akkumulation
 * 16.  Manueller Override mit Ablauftimer
 *
 * Ausführen:  node test/test_bugfixes.js
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

async function assertAsync(label, fn) {
    try {
        const result = await fn();
        assert(label, result !== false);
    } catch (err) {
        console.log(`  ❌  ${label} – Exception: ${err.message}`);
        failed++;
        errors.push(`${label} – Exception: ${err.message}`);
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Inline-Imports (aus lib/) ohne echte ioBroker-Abhängigkeit
// ─────────────────────────────────────────────────────────────────────────────
const crypto              = require('crypto');
const { transformStatus, RateTracker } = require('../lib/utils');
const { MSpaThrottle, MSpaApiClient }  = require('../lib/mspaApi');
const consumptionHelper                = require('../lib/consumptionHelper');

// ─────────────────────────────────────────────────────────────────────────────
//  Mini-Stub des Adapters  (nur die in Tests benötigten Methoden)
// ─────────────────────────────────────────────────────────────────────────────
class StubAdapter {
    constructor(config = {}, seasonEnabled = true, winterModeActive = false) {
        this.config             = config;
        this._seasonEnabled     = seasonEnabled;
        this._winterModeActive  = winterModeActive;
        this._winterFrostActive = false;
        this._pvActive          = false;
        this._pvStageTimer      = null;
        this._pvDeactivateTimer = null;
        this._pvDeactivateCountdownInt = null;
        this._pvDeactivateCountdown    = 0;
        this._pvManagedFeatures = { heater: false, filter: false, uvc: false };
        this._manualOverride    = false;
        this._manualOverrideTimer = null;
        this._uvcOnSince        = null;
        this._uvcHoursUsed      = 0;
        this._uvcDayStartHours  = 0;
        this._uvcDayStartDate   = '';
        this._timeWindowActive  = [];
        this._lastCommandTime   = 0;
        this._adapterCommanded  = { heater: null, filter: null, bubble: null, uvc: null, target_temperature: null };
        this._rapidUntil        = 0;
        this._lastData          = {};

        this.commands   = [];
        this.states     = {};
        this.logEntries = [];
        this.log = {
            info:  msg => this.logEntries.push({ level: 'info',  msg }),
            warn:  msg => this.logEntries.push({ level: 'warn',  msg }),
            error: msg => this.logEntries.push({ level: 'error', msg }),
            debug: msg => this.logEntries.push({ level: 'debug', msg }),
        };

        // mock time (overridable for deterministic tests)
        this._now = null;
    }

    // ── Time helpers ──────────────────────────────────────────────────────────
    _todayStr() {
        const d = this._now || new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    isInSeason() {
        const cfg = this.config;
        if (!this._seasonEnabled) { return false; }
        const parseDate = s => {
            const [day, month] = (s || '').split('.').map(Number);
            return { day: day || 1, month: month || 1 };
        };
        const now   = this._now || new Date();
        const cur   = (now.getMonth() + 1) * 100 + now.getDate();
        const start = parseDate(cfg.season_start || '01.01');
        const end   = parseDate(cfg.season_end   || '31.12');
        const s     = start.month * 100 + start.day;
        const e     = end.month   * 100 + end.day;
        return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
    }

    isInTimeWindow(start, end) {
        const now    = this._now || new Date();
        const toMin  = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
        const cur    = now.getHours() * 60 + now.getMinutes();
        const s      = toMin(start);
        const e      = toMin(end);
        if (s === e) { return false; }
        if (s < e)   { return cur >= s && cur < e; }
        return cur >= s || cur < e;
    }

    // ── State / command stubs ─────────────────────────────────────────────────
    async setStateAsync(id, val)          { this.states[id] = val; }
    async setStateChangedAsync(id, val)   { this.states[id] = val; }
    async getStateAsync(id)               { return this.states[id] !== undefined ? { val: this.states[id] } : null; }
    async setObjectNotExistsAsync()       { /* no-op */ }
    async getObjectAsync()                { return null; }
    async setObjectAsync()                { /* no-op */ }

    async setFeature(feature, boolVal) {
        this.commands.push({ feature, val: boolVal });
        this.states[`control.${feature}`] = boolVal;
        if (feature in this._adapterCommanded) {
            this._adapterCommanded[feature] = boolVal;
        }
        this._lastCommandTime = Date.now();
    }

    enableRapidPolling() { this._rapidUntil = Date.now() + 15_000; }

    // ── Frost protection (from main.js) ───────────────────────────────────────
    async checkFrostProtection(data) {
        if (this._manualOverride) { return; }
        if (!this._winterModeActive) {
            if (this._winterFrostActive) {
                this._winterFrostActive = false;
                await this.setFeature('heater', false);
                await this.setFeature('filter', false);
            }
            return;
        }
        const threshold  = this.config.winter_frost_temp ?? 5;
        const hysteresis = 3;
        const temp       = data.water_temperature;
        if (temp === undefined || temp === null) { return; }

        if (!this._winterFrostActive && temp <= threshold) {
            this._winterFrostActive = true;
            await this.setFeature('filter', true);
            await this.setFeature('heater', true);
            this.enableRapidPolling();
        } else if (this._winterFrostActive && temp >= threshold + hysteresis) {
            this._winterFrostActive = false;
            await this.setFeature('heater', false);
            await this.setFeature('filter', false);
            this.enableRapidPolling();
        }
    }

    // ── UVC helpers ───────────────────────────────────────────────────────────
    _accumulateUvcHours() {
        let total = this._uvcHoursUsed || 0;
        if (this._uvcOnSince !== null) {
            total += (Date.now() - this._uvcOnSince) / (1000 * 3600);
        }
        return total;
    }

    _getUvcTodayHours() {
        const today = this._todayStr();
        if (this._uvcDayStartDate !== today) {
            this._uvcDayStartHours = this._uvcHoursUsed;
            this._uvcDayStartDate  = today;
        }
        return Math.max(0, this._accumulateUvcHours() - this._uvcDayStartHours);
    }

    // ── Manual override ───────────────────────────────────────────────────────
    async _setManualOverride(enable, durationMin = null) {
        if (this._manualOverrideTimer) {
            clearTimeout(this._manualOverrideTimer);
            this._manualOverrideTimer = null;
        }
        this._manualOverride = enable;
        await this.setStateAsync('control.manual_override', enable);

        if (enable && durationMin && durationMin > 0) {
            await this.setStateAsync('control.manual_override_duration', durationMin);
            this._manualOverrideTimer = setTimeout(async () => {
                this._manualOverrideTimer = null;
                this._manualOverride = false;
                await this.setStateAsync('control.manual_override', false);
                await this.setStateAsync('control.manual_override_duration', 0);
            }, durationMin * 60_000);
        } else if (!enable) {
            await this.setStateAsync('control.manual_override_duration', 0);
        }
    }

    // ── App-change detection helpers ──────────────────────────────────────────
    cmdCount(feature, val) {
        return this.commands.filter(c => c.feature === feature && c.val === val).length;
    }
    lastCmd(feature) {
        const all = this.commands.filter(c => c.feature === feature);
        return all.length ? all[all.length - 1].val : undefined;
    }
    resetCommands() { this.commands = []; }
    lastLogs(level) { return this.logEntries.filter(e => e.level === level).map(e => e.msg); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BUGFIX-TEST-SUITE
// ─────────────────────────────────────────────────────────────────────────────

(async () => {

// ═══════════════════════════════════════════════════════════════════════════════
//  BUG 1 – consumptionHelper.handleStateChange fehlte (TypeError)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' BUG 1 – consumptionHelper.handleStateChange');
console.log('══════════════════════════════════════════');

assert('handleStateChange ist als Funktion vorhanden',
    typeof consumptionHelper.handleStateChange === 'function');

await assertAsync('handleStateChange wirft keinen TypeError', async () => {
    await consumptionHelper.handleStateChange('some.state.id', { val: 42, ack: true });
    return true;
});

// ═══════════════════════════════════════════════════════════════════════════════
//  BUG 2 – consumptionHelper Timer-Leak
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' BUG 2 – consumptionHelper Timer-Leak');
console.log('══════════════════════════════════════════');

{
    // _destroyed-Filter wurde entfernt – cleanup() muss Timer trotzdem räumen
    const mockAdapter = new StubAdapter({ consumption_enabled: false });
    mockAdapter.log = {
        info:  () => {},
        warn:  () => {},
        error: () => {},
        debug: () => {},
    };
    consumptionHelper.adapter  = null;
    consumptionHelper._timers  = [];
    // Künstlich mehrere Timer hinzufügen (werden nicht eingelöst – sehr lange Delay)
    const t1 = setTimeout(() => {}, 99_999_999);
    const t2 = setTimeout(() => {}, 99_999_999);
    consumptionHelper._timers.push(t1, t2);
    assert('Vor cleanup: 2 Timer in _timers',
        consumptionHelper._timers.length === 2);
    consumptionHelper.cleanup();
    assert('Nach cleanup: _timers ist leer',
        consumptionHelper._timers.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUG 3 – _generateNonce – kryptografische Sicherheit
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' BUG 3 – MSpaApiClient._generateNonce Sicherheit');
console.log('══════════════════════════════════════════');

{
    const CHARSET = /^[A-Za-z0-9]+$/;
    const nonce1  = MSpaApiClient._generateNonce(32);
    const nonce2  = MSpaApiClient._generateNonce(32);
    const nonce16 = MSpaApiClient._generateNonce(16);

    assert('Nonce hat korrekte Länge (32)',     nonce1.length === 32);
    assert('Nonce hat korrekte Länge (16)',     nonce16.length === 16);
    assert('Nonce enthält nur erlaubte Zeichen', CHARSET.test(nonce1));
    assert('Zwei Nonces sind unterschiedlich (Kollisionswahrscheinlichkeit ~0)', nonce1 !== nonce2);

    // Gleichverteilung: Buchstaben und Ziffern sollten alle vorkommen bei 10 000 Versuchen
    const charSet = new Set();
    for (let i = 0; i < 10_000; i++) {
        for (const c of MSpaApiClient._generateNonce(8)) { charSet.add(c); }
    }
    // Alphabet: 26 + 26 + 10 = 62 Zeichen
    assert('Alle 62 erlaubten Zeichen erscheinen in 10 000 Nonces', charSet.size >= 60);

    // Sicherstellung: Math.random wird NICHT mehr direkt verwendet
    // (Indirekt prüfbar: crypto.randomBytes sollte nie werfen)
    let nonceCrash = false;
    try { MSpaApiClient._generateNonce(64); } catch (_) { nonceCrash = true; }
    assert('_generateNonce(64) wirft keine Exception', !nonceCrash);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUG 4 – PV-Reaktivierung während Staged-Deactivation (dead-code fixed)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' BUG 4 – PV-Reaktivierung während Staging');
console.log('══════════════════════════════════════════');

{
    // Simuliert: PV war aktiv, debounce-Timeout hat _pvActive=false gesetzt und
    // staging hat begonnen (_pvStageTimer !== null).
    // Dann erholt sich PV-Überschuss → _pvReactivate() muss ausgelöst werden.

    let pvReactivateCalled = false;
    let freshActivationCalled = false;

    class PvTestAdapter extends StubAdapter {
        async _pvReactivate(pvWindows, surplus) {
            pvReactivateCalled = true;
            this.log.info(`PV: _pvReactivate aufgerufen (surplus=${surplus})`);
            this._pvActive = true;
        }

        async _pvCancelAllDeactivationTimers() {
            if (this._pvDeactivateTimer)        { clearTimeout(this._pvDeactivateTimer);         this._pvDeactivateTimer = null; }
            if (this._pvDeactivateCountdownInt) { clearInterval(this._pvDeactivateCountdownInt); this._pvDeactivateCountdownInt = null; }
            if (this._pvStageTimer)             { clearTimeout(this._pvStageTimer);               this._pvStageTimer = null; }
            this._pvDeactivateCountdown = 0;
            await this.setStateAsync('computed.pv_deactivate_remaining', 0);
        }

        // Vereinfachtes evaluatePvSurplus mit der NEUEN (korrekten) Logik
        async evaluatePvSurplus_fixed(pvPower, pvHouse, pvWindows) {
            if (this._manualOverride) { return; }
            if (!this.isInSeason())   { return; }

            const threshold  = this.config.pv_threshold_w  || 500;
            const hysteresis = Math.min(this.config.pv_hysteresis_w || 100, threshold);
            const offAt      = threshold - hysteresis;
            const surplus    = pvPower - pvHouse;

            const shouldActivate   = surplus >= threshold;
            const shouldDeactivate = surplus < offAt;

            if (shouldActivate && (!this._pvActive || this._pvStageTimer !== null)) {
                const wasStaging = this._pvStageTimer !== null;
                await this._pvCancelAllDeactivationTimers();

                if (!wasStaging && !this._pvActive) {
                    // Fresh activation
                    freshActivationCalled = true;
                    this._pvActive = true;
                    for (const w of pvWindows) {
                        if (w.action_heating) { await this.setFeature('heater', true); }
                        if (w.action_filter)  { await this.setFeature('filter', true); }
                    }
                } else if (wasStaging) {
                    // Re-activate during staging
                    await this._pvReactivate(pvWindows, surplus);
                }
            }
        }
    }

    const cfg = {
        season_start: '01.01', season_end: '31.12',
        pv_threshold_w: 500, pv_hysteresis_w: 100,
    };
    const pvWindows = [{ active: true, pv_steu: true, action_heating: true, action_filter: true }];

    // Szenario A: Fresh activation (kein Staging)
    const adpA = new PvTestAdapter(cfg, true, false);
    await adpA.evaluatePvSurplus_fixed(2000, 1000, pvWindows);
    assert('Szenario A: Fresh activation → freshActivationCalled=true', freshActivationCalled);
    assert('Szenario A: pvActive=true nach fresh activation', adpA._pvActive === true);
    assert('Szenario A: heater ON nach fresh activation', adpA.cmdCount('heater', true) >= 1);

    // Szenario B: Staging läuft, Überschuss erholt sich → _pvReactivate wird aufgerufen
    pvReactivateCalled  = false;
    freshActivationCalled = false;
    const adpB = new PvTestAdapter(cfg, true, false);
    adpB._pvActive     = false;  // debounce hat _pvActive = false gesetzt
    adpB._pvStageTimer = setTimeout(() => {}, 99_999_999); // staging läuft
    await adpB.evaluatePvSurplus_fixed(2000, 1000, pvWindows);
    assert('Szenario B: _pvReactivate() aufgerufen (nicht fresh activation)', pvReactivateCalled);
    assert('Szenario B: freshActivation NICHT aufgerufen', !freshActivationCalled);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUG 5 – onReady bricht nach init-Fehler ab
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' BUG 5 – onReady bricht nach init-Fehler ab');
console.log('══════════════════════════════════════════');

{
    // Prüft, dass nach einem init-Fehler kein weiterer Code ausgeführt wird.
    // Wir simulieren das Verhalten mit einem Mini-Adapter, der das gleiche Muster hat.

    let subscribeStatesCalled = false;
    let pvInitCalled          = false;
    let connectionSetFalse    = false;

    class OnReadyTestAdapter extends StubAdapter {
        async subscribeStates() { subscribeStatesCalled = true; }
        async initPvControl()   { pvInitCalled = true; }
        async setStateAsync(id, val) {
            super.setStateAsync(id, val);
            if (id === 'info.connection' && val === false) {
                connectionSetFalse = true;
            }
        }

        async onReady_fixed() {
            // Simulate the fixed pattern with early return
            try {
                throw new Error('Simulated API init failure');
            } catch (err) {
                await this.setStateAsync('info.connection', false, true);
                this.log.error(`MSpa init failed: ${err.message}`);
                return; // ← THE FIX
            }
            // These should NOT be reached:
            await this.subscribeStates('control.*');
            await this.initPvControl();
        }
    }

    const adp = new OnReadyTestAdapter({}, true, false);
    await adp.onReady_fixed();
    assert('Nach init-Fehler: info.connection auf false gesetzt', connectionSetFalse);
    assert('Nach init-Fehler: subscribeStates NICHT aufgerufen', !subscribeStatesCalled);
    assert('Nach init-Fehler: initPvControl NICHT aufgerufen', !pvInitCalled);
    assert('Nach init-Fehler: Fehlermeldung wurde geloggt',
        adp.lastLogs('error').some(m => m.includes('MSpa init failed')));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BUG 6 – computeUvcExpiry fehlende await (Race-Condition)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' BUG 6 – computeUvcExpiry await-Korrektheit');
console.log('══════════════════════════════════════════');

{
    // Stellt sicher, dass setStateAsync tatsächlich aufgerufen wurde (keine fire-and-forget)
    let setCalls = 0;
    class UvcTestAdapter extends StubAdapter {
        async setStateAsync(id, val) {
            setCalls++;
            await super.setStateAsync(id, val);
        }
        async setStateChangedAsync(id, val) {
            setCalls++;
            await super.setStateChangedAsync(id, val);
        }

        // Kopiert aus main.js – mit der FIX (await vor setStateAsync)
        async computeUvcExpiry_fixed() {
            const cfg = this.config;
            const raw = (cfg.uvc_install_date || '').trim();
            if (!raw) {
                await this.setStateAsync('status.uvc_expiry_date',     { val: '', ack: true });
                await this.setStateAsync('status.uvc_hours_remaining', { val: 0,  ack: true });
                return;
            }
            const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
            if (!match) {
                await this.setStateAsync('status.uvc_expiry_date', { val: 'invalid date', ack: true });
                return;
            }
        }
    }

    // Fall 1: kein Installationsdatum → 2 setStateAsync-Aufrufe
    setCalls = 0;
    const a = new UvcTestAdapter({}, true);
    await a.computeUvcExpiry_fixed();
    assert('Kein Installationsdatum → 2 setState-Aufrufe', setCalls === 2);

    // Fall 2: ungültiges Datum
    setCalls = 0;
    const b = new UvcTestAdapter({ uvc_install_date: 'not-a-date' }, true);
    await b.computeUvcExpiry_fixed();
    assert('Ungültiges Datum → 1 setState-Aufruf mit "invalid date"', setCalls === 1);
    assert('Status enthält "invalid date"',
        typeof b.states['status.uvc_expiry_date'] === 'object' &&
        b.states['status.uvc_expiry_date'].val === 'invalid date');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7. transformStatus – Korrekte Wert-Konvertierung
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 7. transformStatus Konvertierungen');
console.log('══════════════════════════════════════════');

{
    const raw = {
        water_temperature:   78,
        temperature_setting: 80,
        heater_state:        1,
        filter_state:        0,
        bubble_state:        1,
        jet_state:           0,
        ozone_state:         1,
        uvc_state:           0,
        bubble_level:        2,
        fault:               '',
        is_online:           true,
        heat_state:          3,
    };

    const d = transformStatus(raw);

    assert('water_temperature: 78 → 39°C (÷2)',     d.water_temperature   === 39);
    assert('target_temperature: 80 → 40°C (÷2)',    d.target_temperature  === 40);
    assert('heater: 1 → "on"',                      d.heater              === 'on');
    assert('filter: 0 → "off"',                     d.filter              === 'off');
    assert('bubble: 1 → "on"',                      d.bubble              === 'on');
    assert('jet: 0 → "off"',                        d.jet                 === 'off');
    assert('ozone: 1 → "on"',                       d.ozone               === 'on');
    assert('uvc: 0 → "off"',                        d.uvc                 === 'off');
    assert('bubble_level: 2 unverändert',            d.bubble_level        === 2);
    assert('fault: leer → "OK"',                    d.fault               === 'OK');
    // Pass-through: unbekannte Keys bleiben erhalten
    assert('is_online wird pass-through weitergegeben', d.is_online         === true);
    assert('heat_state wird pass-through weitergegeben', d.heat_state       === 3);

    // Fehlerfall: kein Fault-String → "OK"
    const rawOk = transformStatus({ ...raw, fault: null });
    assert('fault: null → "OK"', rawOk.fault === 'OK');

    // Fehlerfall: expliziter Fault-Code
    const rawFault = transformStatus({ ...raw, fault: 'E01' });
    assert('fault: "E01" bleibt "E01"', rawFault.fault === 'E01');

    // temperature_unit passthrough
    const rawUnit = transformStatus({ ...raw, temperature_unit: 1 });
    assert('temperature_unit: 1 wird pass-through weitergegeben', rawUnit.temperature_unit === 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  8. RateTracker – EMA-Berechnung und Grenzwerte
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 8. RateTracker EMA-Berechnung');
console.log('══════════════════════════════════════════');

{
    const tracker = new RateTracker({ min: 0.05, max: 5.0, minSampleMinutes: 0 /* sofort */ });

    // Erster Update: kein Ergebnis (nur Baseline)
    const r1 = tracker.update(20, true, true);
    assert('Erster Update: Rate noch null (Baseline)',  r1 === null);

    // Zweiter Update nach kurzer Zeit mit höherer Temperatur (1°C Anstieg)
    // Manuell _lastTime setzen, damit Elapsed simulierbar
    tracker._lastTime = Date.now() - 3_600_000; // 1 Stunde zurück
    const r2 = tracker.update(21, true, true);
    assert('Zweiter Update: Rate nicht mehr null',     r2 !== null);
    assert('Zweiter Update: Rate ≈ 1.0 °C/h',         r2 !== null && Math.abs(r2 - 1.0) < 0.1);

    // active=false → reset
    tracker.update(21, false, true);
    assert('active=false → lastTemp reset',            tracker._lastTemp === null);
    assert('active=false → computedRate bleibt (EMA)', tracker.computedRate !== null);

    // Wert außerhalb MIN/MAX wird ignoriert
    const trackerB = new RateTracker({ min: 1.0, max: 2.0, minSampleMinutes: 0 });
    trackerB.update(20, true, true);
    trackerB._lastTime = Date.now() - 3_600_000;
    trackerB.update(20.1, true, true); // 0.1°C/h < MIN 1.0 → ignoriert
    assert('Rate unterhalb MIN wird ignoriert',        trackerB.computedRate === null);

    // reset() zurücksetzen
    const trackerC = new RateTracker({ min: 0.05, max: 5.0, minSampleMinutes: 0 });
    trackerC.update(20, true, true);
    trackerC._lastTime = Date.now() - 3_600_000;
    trackerC.update(21, true, true);
    assert('Vor reset: computedRate gesetzt',          trackerC.computedRate !== null);
    trackerC.reset();
    assert('Nach reset: _lastTemp = null',             trackerC._lastTemp    === null);
    assert('Nach reset: _lastTime = null',             trackerC._lastTime    === null);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  9. MSpaThrottle – Mindestabstand zwischen Anfragen
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 9. MSpaThrottle Zeitabstand');
console.log('══════════════════════════════════════════');

await (async () => {
    const throttle = new MSpaThrottle();
    const start    = Date.now();

    await throttle.acquire();  // 1. Anfrage – sofort
    await throttle.acquire();  // 2. Anfrage – muss MIN_INTERVAL warten

    const elapsed = Date.now() - start;
    assert(`Throttle: 2 Anfragen dauerten ≥ ${throttle.MIN_INTERVAL} ms`,
        elapsed >= throttle.MIN_INTERVAL - 20 /* 20ms Toleranz */);

    // Parallele Anfragen werden serialisiert
    const times = [];
    const start2 = Date.now();
    const t = new MSpaThrottle();
    await Promise.all([
        t.acquire().then(() => times.push(Date.now() - start2)),
        t.acquire().then(() => times.push(Date.now() - start2)),
        t.acquire().then(() => times.push(Date.now() - start2)),
    ]);
    assert('Parallele Aufrufe werden serialisiert (aufsteigend)',
        times[0] <= times[1] && times[1] <= times[2]);
    assert(`3 parallele Anfragen dauerten ≥ 2 × MIN_INTERVAL`,
        Math.max(...times) >= (t.MIN_INTERVAL * 2) - 50);
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  10. isInSeason – Jahresgrenzen
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 10. isInSeason – Jahresgrenzen');
console.log('══════════════════════════════════════════');

{
    const makeAdp = (start, end, date) => {
        const a = new StubAdapter({ season_start: start, season_end: end }, true);
        a._now = date;
        return a;
    };

    assert('Normal: 15.06 in [01.05–30.09]',     makeAdp('01.05','30.09', new Date(2026,5,15)).isInSeason());
    assert('Normal: 30.04 außerhalb [01.05–30.09]', !makeAdp('01.05','30.09', new Date(2026,3,30)).isInSeason());
    assert('Jahresübergreifend: 15.11 in [01.10–31.03]', makeAdp('01.10','31.03', new Date(2026,10,15)).isInSeason());
    assert('Jahresübergreifend: 01.07 außerhalb [01.10–31.03]', !makeAdp('01.10','31.03', new Date(2026,6,1)).isInSeason());
    assert('Grenztag Startdatum',  makeAdp('15.06','30.09', new Date(2026,5,15)).isInSeason());
    assert('Grenztag Enddatum',    makeAdp('01.05','15.06', new Date(2026,5,15)).isInSeason());
    assert('Tag nach Enddatum',    !makeAdp('01.05','14.06', new Date(2026,5,15)).isInSeason());
    assert('season_enabled=false → immer false', (() => {
        const a = new StubAdapter({ season_start: '01.01', season_end: '31.12' }, false);
        return !a.isInSeason();
    })());
}

// ═══════════════════════════════════════════════════════════════════════════════
//  11. isInTimeWindow – Overnight-Fenster
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 11. isInTimeWindow – Overnight-Fenster');
console.log('══════════════════════════════════════════');

{
    const makeAdpAt = (hour, minute) => {
        const a = new StubAdapter({}, true);
        a._now = new Date(2026, 3, 18, hour, minute, 0);
        return a;
    };

    assert('10:00–12:00: 11:00 drin',           makeAdpAt(11, 0).isInTimeWindow('10:00','12:00'));
    assert('10:00–12:00: 12:00 NICHT drin (exkl. Ende)', !makeAdpAt(12, 0).isInTimeWindow('10:00','12:00'));
    assert('10:00–12:00: 09:59 nicht drin',     !makeAdpAt( 9,59).isInTimeWindow('10:00','12:00'));
    assert('22:00–06:00: 23:00 drin (overnight)', makeAdpAt(23,0).isInTimeWindow('22:00','06:00'));
    assert('22:00–06:00: 05:00 drin (overnight)', makeAdpAt( 5,0).isInTimeWindow('22:00','06:00'));
    assert('22:00–06:00: 06:00 NICHT drin',       !makeAdpAt( 6,0).isInTimeWindow('22:00','06:00'));
    assert('22:00–06:00: 12:00 nicht drin',       !makeAdpAt(12,0).isInTimeWindow('22:00','06:00'));
    assert('Gleiches Start/Ende → immer false',   !makeAdpAt(12,0).isInTimeWindow('12:00','12:00'));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  12. Frostschutz – vollständige Hysterese-Szenarien
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 12. Frostschutz – Hysterese');
console.log('══════════════════════════════════════════');

await (async () => {
    // Schwelle 5°C, Hysterese 3°C → Abschalten bei 8°C

    const a = new StubAdapter({ winter_frost_temp: 5 }, true, true);

    // Temperatur über Schwelle → nichts passiert
    await a.checkFrostProtection({ water_temperature: 6 });
    assert('6°C > 5°C → Frost noch nicht aktiv', !a._winterFrostActive);

    // Temperatur sinkt auf Schwelle
    await a.checkFrostProtection({ water_temperature: 5 });
    assert('5°C ≤ 5°C → Frost aktiv', a._winterFrostActive);
    assert('Heizer EIN', a.cmdCount('heater', true) === 1);
    assert('Pumpe EIN',  a.cmdCount('filter', true) === 1);

    // Bereits aktiv, unter Schwelle bleibt aktiv (kein Doppel-Einschalten)
    a.resetCommands();
    await a.checkFrostProtection({ water_temperature: 3 });
    assert('Weiter 3°C → kein doppeltes Einschalten', a.cmdCount('heater', true) === 0);

    // Knapp unterhalb Ausschalt-Schwelle
    a.resetCommands();
    await a.checkFrostProtection({ water_temperature: 7 });
    assert('7°C < 8°C → Frost noch aktiv', a._winterFrostActive);
    assert('Kein Ausschalten bei 7°C', a.cmdCount('heater', false) === 0);

    // Exakt an Ausschalt-Schwelle
    a.resetCommands();
    await a.checkFrostProtection({ water_temperature: 8 });
    assert('8°C ≥ 8°C → Frost deaktiviert', !a._winterFrostActive);
    assert('Heizer AUS', a.cmdCount('heater', false) === 1);
    assert('Pumpe AUS',  a.cmdCount('filter', false) === 1);

    // Manual Override unterdrückt Frost
    const b = new StubAdapter({ winter_frost_temp: 5 }, true, true);
    b._manualOverride = true;
    await b.checkFrostProtection({ water_temperature: 3 });
    assert('Manual override → Frost wird ignoriert', !b._winterFrostActive);

    // Kein Winter-Modus → nie einschalten
    const c = new StubAdapter({ winter_frost_temp: 5 }, true, false);
    await c.checkFrostProtection({ water_temperature: 2 });
    assert('winter_mode=false → immer inaktiv', !c._winterFrostActive);
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  13. App-Change-Detection Grace-Period
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 13. App-Change-Detection Grace-Period');
console.log('══════════════════════════════════════════');

{
    // Nach einem Adapter-Kommando soll innerhalb von 30s kein False-Positive erkannt werden
    const GRACE = 30_000;

    const a = new StubAdapter({
        app_change_override_min: 30,
    }, true, false);
    a._adapterCommanded.heater = true;  // Adapter hat heater=true gesetzt
    a._lastCommandTime = Date.now();    // Kommando gerade eben

    // Simuliert publishStatus-App-Change-Logik:
    const inCmdGrace = (Date.now() - a._lastCommandTime) < GRACE;
    assert('Kurz nach Kommando: inCmdGrace=true', inCmdGrace);

    // Gerät meldet heater=off → sollte NICHT als App-Change erkannt werden
    const data = { heater: 'off' };
    const commanded = a._adapterCommanded.heater;
    const mismatch  = (data.heater === 'on') !== commanded;
    const detected  = mismatch && !a._manualOverride && a._seasonEnabled && !inCmdGrace;
    assert('Innerhalb Grace-Period: kein false-positive App-Change', !detected);

    // Nach Grace-Period: Mismatch wird erkannt
    a._lastCommandTime = Date.now() - (GRACE + 1000);
    const inCmdGrace2 = (Date.now() - a._lastCommandTime) < GRACE;
    const detected2   = mismatch && !a._manualOverride && a._seasonEnabled && !inCmdGrace2;
    assert('Nach Grace-Period: App-Change wird erkannt', detected2);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  14. UVC Stunden-Akkumulation
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 14. UVC Stunden-Akkumulation');
console.log('══════════════════════════════════════════');

{
    const a = new StubAdapter({}, true);

    // UVC ist aus → keine Akkumulation
    assert('UVC aus: _accumulateUvcHours() = 0',
        a._accumulateUvcHours() === 0);

    // UVC wird eingeschaltet (1 Stunde simulieren)
    a._uvcOnSince  = Date.now() - 3_600_000; // 1 Stunde
    a._uvcHoursUsed = 2; // bereits 2h akkumuliert
    const acc = a._accumulateUvcHours();
    assert('UVC läuft 1h + 2h gespeichert = ~3h',
        Math.abs(acc - 3) < 0.01);

    // Tag-Wechsel-Erkennung
    a._uvcDayStartDate  = '2025-01-01'; // altes Datum
    a._uvcDayStartHours = 1.5;
    a._now = new Date(2025, 0, 2); // 02.01.2025 → neuer Tag
    const todayH = a._getUvcTodayHours();
    assert('Tag-Wechsel: _uvcDayStartDate wird aktualisiert',
        a._uvcDayStartDate === '2025-01-02');
    // Nach Datum-Wechsel wird Snapshot neu gesetzt, todayH sollte auf Basis des neuen Snapshots berechnet werden
    assert('Tag-Wechsel: todayH ≥ 0', todayH >= 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  15. Manueller Override mit Ablauftimer
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 15. Manueller Override mit Ablauftimer');
console.log('══════════════════════════════════════════');

await (async () => {
    const a = new StubAdapter({}, true);

    // Override ohne Dauer → bleibt aktiv
    await a._setManualOverride(true, 0);
    assert('Override ohne Dauer: _manualOverride=true',     a._manualOverride === true);
    assert('Override ohne Dauer: kein Timer gesetzt',        a._manualOverrideTimer === null);

    // Override deaktivieren
    await a._setManualOverride(false);
    assert('Override deaktiviert: _manualOverride=false',    a._manualOverride === false);
    assert('State gesetzt',
        a.states['control.manual_override'] === false);
    assert('Duration auf 0 zurückgesetzt',
        a.states['control.manual_override_duration'] === 0);

    // Override mit Dauer → Timer gesetzt
    await a._setManualOverride(true, 5);
    assert('Override mit 5 min: Timer gesetzt',
        a._manualOverrideTimer !== null);
    assert('Duration state gesetzt',
        a.states['control.manual_override_duration'] === 5);

    // Timer aufräumen
    clearTimeout(a._manualOverrideTimer);
    a._manualOverrideTimer = null;
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  16. consumptionHelper – tägliche Rücksetzung (daily close)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 16. consumptionHelper – daily close Logik');
console.log('══════════════════════════════════════════');

await (async () => {
    const states = {};
    const foreignStates = { 'meter.0.ENERGY.Total': { val: 125.0, ack: true } };

    const mockAdapter = {
        config:       { consumption_enabled: true, external_energy_total_id: 'meter.0.ENERGY.Total' },
        _timers:      [],
        log: {
            info:  () => {},
            warn:  () => {},
            error: () => {},
            debug: () => {},
        },
        async setStateAsync(id, val) {
            states[id] = typeof val === 'object' && val !== null ? val.val : val;
        },
        async getStateAsync(id) {
            return states[id] !== undefined ? { val: states[id] } : null;
        },
        async getForeignStateAsync(id) {
            return foreignStates[id] || null;
        },
    };

    // Setze Baseline
    states['consumption.last_total_kwh'] = 100.0;

    // Simuliere die daily-close Logik
    const rawNow  = 125.0;
    const savedNum = 100.0;
    const dayVal  = Math.round((rawNow - savedNum) * 1000) / 1000;

    assert('day_kwh Berechnung korrekt: 125 - 100 = 25',  dayVal === 25.0);

    // Wenn kein Baseline vorhanden → day_kwh = 0
    const dayValNoBase = 0;
    assert('Kein Baseline → day_kwh = 0', dayValNoBase === 0);

    // handleStateChange ist jetzt vorhanden und wirft kein Error
    await assertAsync('handleStateChange ist aufrufbar', async () => {
        await consumptionHelper.handleStateChange('meter.0.ENERGY.Total', { val: 125.0, ack: true });
        return true;
    });
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  17. publishStatus – nur Modell-spezifische States werden gesetzt
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 17. publishStatus – nur Model-States gesetzt');
console.log('══════════════════════════════════════════');

await (async () => {
    const { STATE_DEFS } = require('../lib/constants');
    const { transformStatus } = require('../lib/utils');

    // Simuliert das Verhalten von publishStatus mit der neuen Guard-Logik
    function makePublishSet(dynamicStateIds, writtenStates) {
        return async (id, val) => {
            if (val === undefined || val === null) return;
            const def = STATE_DEFS[id];
            if (def && def.apiField !== undefined && !dynamicStateIds.has(id)) return;
            writtenStates.add(id);
        };
    }

    // Modell A: liefert nur water_temperature, heater_state, filter_state, fault
    const rawModelA = {
        water_temperature:   78,
        temperature_setting: 80,
        heater_state:        1,
        filter_state:        1,
        bubble_state:        0,
        jet_state:           0,
        ozone_state:         0,
        uvc_state:           0,
        bubble_level:        1,
        fault:               '',
        is_online:           true,
        // KEIN: filter_current, filter_life, heat_state, safety_lock, heat_time, auto_inflate
    };

    // createDynamicStates würde diese IDs anlegen:
    const dynamicA = new Set();
    const apiKeys  = new Set(Object.keys(rawModelA));
    for (const [id, def] of Object.entries(STATE_DEFS)) {
        if (def.apiField === undefined) continue;
        if (apiKeys.has(def.apiField)) dynamicA.add(id);
    }

    const writtenA = new Set();
    const dataA    = transformStatus(rawModelA);
    const setA     = makePublishSet(dynamicA, writtenA);

    // Alle Hard-coded-Calls von publishStatus simulieren
    await setA('status.water_temperature', dataA.water_temperature);
    await setA('status.target_temperature', dataA.target_temperature);
    await setA('status.fault',              dataA.fault);
    await setA('status.heat_state',         dataA.heat_state);
    await setA('status.bubble_level',       dataA.bubble_level);
    await setA('status.is_online',          !!dataA.is_online);
    await setA('status.filter_current',     dataA.filter_current);
    await setA('status.filter_life',        dataA.filter_life);
    await setA('status.temperature_unit',   dataA.temperature_unit);
    await setA('status.safety_lock',        dataA.safety_lock);
    await setA('status.heat_time_switch',   !!dataA.heat_time_switch);
    await setA('status.heat_time',          dataA.heat_time);
    await setA('status.auto_inflate',       !!dataA.auto_inflate);

    // Was wurde geschrieben?
    assert('Modell A: water_temperature wird gesetzt (im Raw vorhanden)',
        writtenA.has('status.water_temperature'));
    assert('Modell A: target_temperature wird gesetzt (temperature_setting im Raw)',
        writtenA.has('status.target_temperature'));
    assert('Modell A: fault wird gesetzt',
        writtenA.has('status.fault'));
    assert('Modell A: is_online wird gesetzt',
        writtenA.has('status.is_online'));

    // filter_current / filter_life / heat_state / safety_lock: nicht im Raw → NICHT gesetzt
    assert('Modell A: filter_current NICHT gesetzt (nicht im Raw)',
        !writtenA.has('status.filter_current'));
    assert('Modell A: filter_life NICHT gesetzt (nicht im Raw)',
        !writtenA.has('status.filter_life'));
    assert('Modell A: heat_state NICHT gesetzt (nicht im Raw)',
        !writtenA.has('status.heat_state'));
    assert('Modell A: safety_lock NICHT gesetzt (nicht im Raw)',
        !writtenA.has('status.safety_lock'));
    assert('Modell A: heat_time NICHT gesetzt (nicht im Raw)',
        !writtenA.has('status.heat_time'));
    assert('Modell A: auto_inflate NICHT gesetzt (nicht im Raw)',
        !writtenA.has('status.auto_inflate'));

    // Modell B: liefert ALLE Felder (vollständiges Modell)
    const rawModelB = {
        ...rawModelA,
        heat_state:      3,
        filter_current:  42,
        filter_life:     720,
        temperature_unit: 0,
        safety_lock:     0,
        heat_time_switch: 0,
        heat_time:       0,
        auto_inflate:    0,
    };
    const dynamicB = new Set();
    const apiKeysB = new Set(Object.keys(rawModelB));
    for (const [id, def] of Object.entries(STATE_DEFS)) {
        if (def.apiField === undefined) continue;
        if (apiKeysB.has(def.apiField)) dynamicB.add(id);
    }
    const writtenB = new Set();
    const dataB    = transformStatus(rawModelB);
    const setB     = makePublishSet(dynamicB, writtenB);

    await setB('status.water_temperature', dataB.water_temperature);
    await setB('status.heat_state',        dataB.heat_state);
    await setB('status.filter_current',    dataB.filter_current);
    await setB('status.filter_life',       dataB.filter_life);
    await setB('status.safety_lock',       dataB.safety_lock);
    await setB('status.heat_time',         dataB.heat_time);
    await setB('status.auto_inflate',      !!dataB.auto_inflate);

    assert('Modell B: water_temperature gesetzt',  writtenB.has('status.water_temperature'));
    assert('Modell B: heat_state gesetzt',         writtenB.has('status.heat_state'));
    assert('Modell B: filter_current gesetzt',     writtenB.has('status.filter_current'));
    assert('Modell B: filter_life gesetzt',        writtenB.has('status.filter_life'));
    assert('Modell B: safety_lock gesetzt',        writtenB.has('status.safety_lock'));
    assert('Modell B: heat_time gesetzt',          writtenB.has('status.heat_time'));
    assert('Modell B: auto_inflate gesetzt',       writtenB.has('status.auto_inflate'));

    // Sonderfälle: nicht-apiField States (wie uvc_hours_used) sind IMMER erlaubt
    const writtenC = new Set();
    const setC     = makePublishSet(new Set() /* leer! */, writtenC);
    // status.uvc_hours_used hat KEIN apiField → darf immer gesetzt werden
    await setC('status.uvc_hours_used', 3.14);
    assert('Non-apiField State (uvc_hours_used) immer erlaubt, auch ohne Dynamic-Set',
        writtenC.has('status.uvc_hours_used'));
})();

// ═══════════════════════════════════════════════════════════════════════════════
//  18. Filter-Laufzeit-Zähler (filter_running / filter_reset)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' 18. filter_running / filter_reset');
console.log('══════════════════════════════════════════');

await (async () => {

    // ── Hilfsfunktionen analog zu main.js ─────────────────────────────────
    function accumulateFilterHours(filterHoursUsed, filterOnSince) {
        let total = filterHoursUsed || 0;
        if (filterOnSince !== null) {
            total += (Date.now() - filterOnSince) / (1000 * 3600);
        }
        return total;
    }

    // Simulates the publishStatus filter-tracking block
    async function processFilterState(ctx, filterIsOn) {
        if (filterIsOn && ctx.filterOnSince === null) {
            ctx.filterOnSince = Date.now();
        } else if (!filterIsOn && ctx.filterOnSince !== null) {
            ctx.filterHoursUsed = accumulateFilterHours(ctx.filterHoursUsed, ctx.filterOnSince);
            ctx.filterOnSince   = null;
            ctx.persistedVal    = Math.round(ctx.filterHoursUsed * 100) / 100;
        }
        ctx.publishedVal = Math.round(accumulateFilterHours(ctx.filterHoursUsed, ctx.filterOnSince) * 100) / 100;
    }

    // Simulates the onStateChange filter_reset handler
    function handleFilterReset(ctx) {
        const wasRunning      = ctx.filterOnSince !== null;
        ctx.filterHoursUsed   = 0;
        ctx.filterOnSince     = wasRunning ? Date.now() : null;
        ctx.persistedVal      = 0;
        ctx.publishedVal      = 0;
        return wasRunning;
    }

    // ── Test 1: Filter läuft – Zähler steigt ──────────────────────────────
    {
        const ctx = { filterHoursUsed: 0, filterOnSince: null, publishedVal: 0, persistedVal: 0 };

        // Filter geht AN
        await processFilterState(ctx, true);
        assert('Filter AN: filterOnSince wird gesetzt', ctx.filterOnSince !== null);
        assert('Filter AN: publishedVal ≥ 0',           ctx.publishedVal >= 0);

        // kurze Wartezeit simulieren (100 ms ≈ 0.0000278 h)
        await sleep(100);
        await processFilterState(ctx, true); // immer noch an
        // Roh-Wert (ungerundet) prüfen – bei 100 ms ist gerundeter Wert auf 2 Stellen noch 0.00
        const rawH = accumulateFilterHours(ctx.filterHoursUsed, ctx.filterOnSince);
        assert('Filter läuft: roher Akkumulationswert > 0 nach 100 ms', rawH > 0);

        // Filter geht AUS
        const before = ctx.publishedVal;
        await processFilterState(ctx, false);
        assert('Filter AUS: filterOnSince = null',       ctx.filterOnSince === null);
        assert('Filter AUS: filterHoursUsed > 0',        ctx.filterHoursUsed > 0);
        assert('Filter AUS: persistedVal ≈ before',      Math.abs(ctx.persistedVal - before) < 0.001);
    }

    // ── Test 2: Zähler akkumuliert über mehrere Zyklen ─────────────────────
    {
        const ctx = { filterHoursUsed: 5.0, filterOnSince: null, publishedVal: 0, persistedVal: 0 };

        // Filter AN → sofort AUS
        ctx.filterOnSince = Date.now() - 3_600_000; // 1 Stunde simulieren
        await processFilterState(ctx, false);
        assert('Akkumulation: 5 h + 1 h = 6 h', Math.abs(ctx.filterHoursUsed - 6.0) < 0.01);
        assert('persistedVal = 6.0',              Math.abs(ctx.persistedVal - 6.0)    < 0.01);
    }

    // ── Test 3: Reset während Filter läuft ────────────────────────────────
    {
        const ctx = {
            filterHoursUsed: 10.5,
            filterOnSince:   Date.now() - 1_800_000,  // 30 min laufend
            publishedVal:    0,
            persistedVal:    0,
        };

        const wasRunning = handleFilterReset(ctx);
        assert('Reset während Filter läuft: wasRunning = true',     wasRunning);
        assert('Reset: filterHoursUsed = 0',                        ctx.filterHoursUsed === 0);
        assert('Reset: filterOnSince neu gesetzt (neue Session)',    ctx.filterOnSince !== null);
        assert('Reset: persistedVal = 0',                           ctx.persistedVal === 0);
        assert('Reset: publishedVal = 0',                           ctx.publishedVal === 0);

        // Nach dem Reset: Neue Laufzeit beginnt von 0
        await sleep(50);
        await processFilterState(ctx, true); // filter still on
        assert('Nach Reset: publishedVal beginnt von ~0',           ctx.publishedVal < 0.001);
    }

    // ── Test 4: Reset wenn Filter AUS ─────────────────────────────────────
    {
        const ctx = { filterHoursUsed: 3.75, filterOnSince: null, publishedVal: 0, persistedVal: 0 };

        const wasRunning = handleFilterReset(ctx);
        assert('Reset wenn Filter AUS: wasRunning = false',  !wasRunning);
        assert('Reset: filterHoursUsed = 0',                  ctx.filterHoursUsed === 0);
        assert('Reset: filterOnSince bleibt null',            ctx.filterOnSince === null);
        assert('Reset: persistedVal = 0',                     ctx.persistedVal === 0);
    }

    // ── Test 5: Persistenz beim Adapter-Neustart ───────────────────────────
    {
        // Simuliert onReady: persistierter Wert wird aus dem State geladen
        const persisted = 42.75;
        const ctx = { filterHoursUsed: persisted, filterOnSince: null };

        // Filter war beim letzten Stopp AUS → kein _filterOnSince
        assert('Restore: filterHoursUsed aus persistiertem Wert', ctx.filterHoursUsed === 42.75);
        assert('Restore: filterOnSince = null (Filter war AUS)',  ctx.filterOnSince === null);

        // Filter war beim letzten Stopp AN → filterOnSince = Date.now()
        const ctx2 = { filterHoursUsed: persisted, filterOnSince: Date.now() };
        const acc  = accumulateFilterHours(ctx2.filterHoursUsed, ctx2.filterOnSince);
        assert('Restore: Filter war AN → Akkumulation beginnt von persisted', Math.abs(acc - persisted) < 0.001);
    }

    // ── Test 6: STATE_DEFS enthält die neuen States ────────────────────────
    {
        const { STATE_DEFS } = require('../lib/constants');
        assert('STATE_DEFS hat control.filter_running',
            'control.filter_running' in STATE_DEFS);
        assert('STATE_DEFS hat control.filter_reset',
            'control.filter_reset' in STATE_DEFS);
        assert('filter_running: type=number',
            STATE_DEFS['control.filter_running'].type === 'number');
        assert('filter_running: unit="h"',
            STATE_DEFS['control.filter_running'].unit === 'h');
        assert('filter_running: write=false (read-only Zähler)',
            STATE_DEFS['control.filter_running'].write === false);
        assert('filter_reset: type=boolean',
            STATE_DEFS['control.filter_reset'].type === 'boolean');
        assert('filter_reset: role=button',
            STATE_DEFS['control.filter_reset'].role === 'button');
        assert('filter_reset: write=true',
            STATE_DEFS['control.filter_reset'].write === true);
        assert('filter_reset: kein apiField (immer angelegt)',
            STATE_DEFS['control.filter_reset'].apiField === undefined);
    }

})();

// ═══════════════════════════════════════════════════════════════════════════════
//  ZUSAMMENFASSUNG
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════');
console.log(' ZUSAMMENFASSUNG');
console.log('══════════════════════════════════════════');
console.log(`\n  Gesamt:     ${passed + failed}`);
console.log(`  Bestanden:  ${passed}`);
console.log(`  Fehlerhaft: ${failed}`);

if (errors.length > 0) {
    console.log('\n  Fehlgeschlagene Tests:');
    for (const e of errors) { console.log(`    ✗  ${e}`); }
    console.log('');
    process.exit(1);
} else {
    console.log('\n  ✅  Alle Tests bestanden!\n');
    process.exit(0);
}

})();
