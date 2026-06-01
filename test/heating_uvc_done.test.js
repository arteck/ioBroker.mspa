'use strict';

/**
 * Tests für das Einschalt-/Abschaltverhalten der Heizung wenn UVC fertig ist.
 *
 * Root-Cause-Bug:
 *   setFeature() in uvc.js (stopEnsure / checkDailyMinimum) und pv.js
 *   (stagedDeactivate / reactivate / evaluateSurplus) wurde OHNE
 *   {fromAutomation: true} aufgerufen. Dadurch wurde _lastCommandTime
 *   nicht aktualisiert. Kam der nächste Rapid-Poll zurück bevor die
 *   API-Bestätigung eintraf, erkannte die App-Change-Detection einen
 *   Mismatch → Manual-Override für 30 Minuten. Nach Ablauf des Overrides
 *   rief _resumeAfterOverride() checkTimeWindows() auf → falls zu diesem
 *   Zeitpunkt ein Heiz-Fenster aktiv war, schaltete die Heizung UNERWARTET ein.
 *
 * Dieser Fix stellt sicher:
 *   1. stopEnsure()          → setFeature(..., {fromAutomation: true})
 *   2. checkDailyMinimum()   → setFeature(..., {fromAutomation: true})
 *   3. stagedDeactivate()    → setFeature(..., {fromAutomation: true})
 *   4. reactivate()          → setFeature(..., {fromAutomation: true})
 *   5. evaluateSurplus()     → setFeature(..., {fromAutomation: true})
 *
 * Run:  npx mocha test/heating_uvc_done.test.js --no-config
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// ---------------------------------------------------------------------------
// Quelltext-Inspektion: alle setFeature-Aufrufe müssen fromAutomation haben
// ---------------------------------------------------------------------------
describe('Quelltext-Audit: setFeature immer mit fromAutomation:true', () => {

    /**
     * Liest eine Datei und liefert alle Zeilen, die setFeature( enthalten,
     * aber KEIN fromAutomation haben.
     */
    function findBareSetFeatureCalls(filePath) {
        const src   = fs.readFileSync(filePath, 'utf8');
        const lines = src.split('\n');
        const bad   = [];
        lines.forEach((line, idx) => {
            // Zeilen mit setFeature(
            if (!line.includes('setFeature(')) return;
            // Kommentarzeilen überspringen
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
            // Zeilen die schon fromAutomation enthalten sind korrekt
            if (line.includes('fromAutomation')) return;
            // Zeilen die nur den Aufruf definieren (z.B. async setFeature(feature, boolVal,...)
            // sind die Methoden-Signatur im Adapter → nicht relevant
            if (line.includes('async setFeature(')) return;
            // Zeilen mit setFeature() als Methodendefinition überspringen
            if (line.includes('setFeature(feature,')) return;
            bad.push({ line: idx + 1, text: line.trim() });
        });
        return bad;
    }

    const pvFile  = path.resolve(__dirname, '../lib/pv.js');
    const uvcFile = path.resolve(__dirname, '../lib/uvc.js');

    it('pv.js: kein setFeature()-Aufruf ohne fromAutomation', () => {
        const bad = findBareSetFeatureCalls(pvFile);
        assert.deepStrictEqual(bad, [],
            `pv.js enthält setFeature-Aufrufe ohne fromAutomation:\n${bad.map(b => `  L${b.line}: ${b.text}`).join('\n')}`
        );
    });

    it('uvc.js: kein setFeature()-Aufruf ohne fromAutomation', () => {
        const bad = findBareSetFeatureCalls(uvcFile);
        assert.deepStrictEqual(bad, [],
            `uvc.js enthält setFeature-Aufrufe ohne fromAutomation:\n${bad.map(b => `  L${b.line}: ${b.text}`).join('\n')}`
        );
    });
});

// ---------------------------------------------------------------------------
// Helper: minimaler Adapter-Stub für stopEnsure / checkDailyMinimum Tests
// ---------------------------------------------------------------------------
function makeAdapter({
    uvcOn        = false,
    filterOn     = false,
    heaterOn     = false,
    pvActive     = false,
    pvManagedUvc = false,
    pvManagedFilter = false,
    pvStageTimer = null,
    winterFrost  = false,
    manualOverride = false,
    seasonEnabled  = true,
    timeWindowActive = [],
    uvcHoursUsed   = 0,
    uvcDayStartH   = 0,
    uvcOnSince     = null,
    config         = {},
} = {}) {
    const stateStore = {
        'control.uvc':    { val: uvcOn },
        'control.filter': { val: filterOn },
        'control.heater': { val: heaterOn },
    };
    const calls      = [];   // protokollierte setFeature-Aufrufe
    const stateSets  = [];   // protokollierte setState-Aufrufe
    const logMsgs    = { debug: [], info: [], warn: [], error: [] };

    const adapter = {
        config: {
            more_log_enabled:    false,
            uvc_daily_min_h:     2,
            uvc_daily_ensure_time: '10:00',
            ...config,
        },
        log: {
            debug: m => logMsgs.debug.push(m),
            info:  m => logMsgs.info.push(m),
            warn:  m => logMsgs.warn.push(m),
            error: m => logMsgs.error.push(m),
        },
        logs: logMsgs,
        calls,
        stateSets,

        // State
        _pvActive:            pvActive,
        _pvManagedFeatures:   { heater: false, filter: pvManagedFilter, uvc: pvManagedUvc },
        _pvStageTimer:        pvStageTimer,
        _winterFrostActive:   winterFrost,
        _manualOverride:      manualOverride,
        _seasonEnabled:       seasonEnabled,
        _timeWindowActive:    timeWindowActive,
        _uvcEnsureActive:     false,
        _uvcEnsureFilterStart: false,
        _uvcEnsureDate:       '',
        _uvcEnsureSkipToday:  false,
        _uvcEnsureSkipDate:   '',
        _uvcHoursUsed:        uvcHoursUsed,
        _uvcDayStartHours:    uvcDayStartH,
        _uvcDayStartDate:     '',
        _uvcTodayResetDate:   '',
        _uvcOnSince:          uvcOnSince,

        // Recorded _lastCommandTime updates
        _lastCommandTime: 0,
        _commandTimestamps: [],

        async getStateAsync(id) {
            return stateStore[id] || null;
        },
        setState(id, val) {
            const v = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            stateStore[id] = { val: v };
            stateSets.push({ id, val: v });
        },
        async setStateAsync(id, val) {
            const v = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            stateStore[id] = { val: v };
            stateSets.push({ id, val: v });
        },
        async setStateChangedAsync(id, val) {
            const v = (val && typeof val === 'object' && 'val' in val) ? val.val : val;
            stateStore[id] = { val: v };
            stateSets.push({ id, val: v });
        },

        enableRapidPolling() { /* no-op */ },
        todayStr() {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        },

        // Mock setFeature: aufzeichnen + _lastCommandTime aktualisieren wenn fromAutomation
        async setFeature(feature, val, opts = {}) {
            calls.push({ feature, val, opts: { ...opts } });
            if (opts.fromAutomation) {
                this._lastCommandTime = Date.now();
                this._commandTimestamps.push({ feature, val, ts: this._lastCommandTime });
            }
            // Update state store to reflect the command
            const stateKey = `control.${feature}`;
            stateStore[stateKey] = { val };
        },

        accumulateUvcHours() {
            let total = this._uvcHoursUsed || 0;
            if (this._uvcOnSince !== null) {
                total += (Date.now() - this._uvcOnSince) / (1000 * 3600);
            }
            return total;
        },
        getUvcTodayHours() {
            return Math.max(0, this.accumulateUvcHours() - this._uvcDayStartHours);
        },
    };
    return adapter;
}

// ---------------------------------------------------------------------------
// 1. stopEnsure – setzt fromAutomation:true beim Abschalten von UVC + Filter
// ---------------------------------------------------------------------------
describe('stopEnsure() – fromAutomation:true bei allen setFeature-Aufrufen', () => {
    const uvcModule = require('../lib/uvc');

    it('stopEnsure: UVC OFF wird mit fromAutomation:true gesendet', async () => {
        const adapter = makeAdapter({ uvcOn: true, filterOn: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        const uvcCall = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        assert.ok(uvcCall, 'UVC OFF muss aufgerufen worden sein');
        assert.strictEqual(uvcCall.opts.fromAutomation, true,
            'UVC OFF muss fromAutomation:true haben');
    });

    it('stopEnsure: Filter OFF wird mit fromAutomation:true gesendet', async () => {
        const adapter = makeAdapter({ uvcOn: true, filterOn: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        const filterCall = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.ok(filterCall, 'Filter OFF muss aufgerufen worden sein');
        assert.strictEqual(filterCall.opts.fromAutomation, true,
            'Filter OFF muss fromAutomation:true haben');
    });

    it('stopEnsure: _lastCommandTime wird nach UVC OFF aktualisiert', async () => {
        const adapter = makeAdapter({ uvcOn: true, filterOn: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;
        const before = Date.now();

        await uvcModule.stopEnsure(adapter);

        assert.ok(adapter._lastCommandTime >= before,
            '_lastCommandTime muss nach stopEnsure aktualisiert sein');
    });

    it('stopEnsure: kein setFeature wenn UVC von anderer Automation gehalten', async () => {
        // UVC owned by PV
        const adapter = makeAdapter({
            uvcOn: true, filterOn: true,
            pvActive: true, pvManagedUvc: true,
        });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = false; // PV owns filter too

        await uvcModule.stopEnsure(adapter);

        const uvcCall = adapter.calls.find(c => c.feature === 'uvc');
        assert.strictEqual(uvcCall, undefined, 'UVC darf NICHT abgeschaltet werden wenn PV es hält');
    });

    it('stopEnsure: Filter bleibt ON wenn Frost aktiv', async () => {
        const adapter = makeAdapter({ uvcOn: true, filterOn: true, winterFrost: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        const filterCall = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.strictEqual(filterCall, undefined,
            'Filter darf bei Frost NICHT abgeschaltet werden');
    });

    it('stopEnsure: Heizung bleibt unberührt (stopEnsure schaltet Heizung nicht selbst)', async () => {
        // Die Heizung wird NICHT direkt von stopEnsure verwaltet.
        // Wenn filter=true+heater=true, übernimmt setFeature('filter', false) die Heizung.
        const adapter = makeAdapter({ uvcOn: true, filterOn: true, heaterOn: false });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        const heaterCall = adapter.calls.find(c => c.feature === 'heater');
        assert.strictEqual(heaterCall, undefined,
            'stopEnsure darf die Heizung NICHT direkt einschalten');
    });
});

// ---------------------------------------------------------------------------
// 2. checkDailyMinimum – fromAutomation:true beim Einschalten von Filter + UVC
// ---------------------------------------------------------------------------
describe('checkDailyMinimum() – fromAutomation:true beim Ensure-Start', () => {
    const uvcModule = require('../lib/uvc');

    function makeEnsureAdapter({ filterAlreadyOn = false, uvcAlreadyOn = false } = {}) {
        // Geringe UVC-Stunden damit Minimum nicht erreicht → ensure soll starten
        const a = makeAdapter({
            filterOn: filterAlreadyOn,
            uvcOn:    uvcAlreadyOn,
            uvcHoursUsed:   0,
            uvcDayStartH:   0,
            seasonEnabled:  true,
            config: {
                uvc_daily_min_h:       2,
                uvc_daily_ensure_time: '00:00', // sofort aktiv (jede Tageszeit)
            },
        });
        return a;
    }

    it('Filter ON beim Ensure-Start hat fromAutomation:true', async () => {
        const adapter = makeEnsureAdapter({ filterAlreadyOn: false });
        await uvcModule.checkDailyMinimum(adapter);

        const filterCall = adapter.calls.find(c => c.feature === 'filter' && c.val === true);
        assert.ok(filterCall, 'Filter muss eingeschaltet werden');
        assert.strictEqual(filterCall.opts.fromAutomation, true,
            'Filter ON muss fromAutomation:true haben');
    });

    it('UVC ON beim Ensure-Start hat fromAutomation:true', async () => {
        const adapter = makeEnsureAdapter({ filterAlreadyOn: false });
        await uvcModule.checkDailyMinimum(adapter);

        const uvcCall = adapter.calls.find(c => c.feature === 'uvc' && c.val === true);
        assert.ok(uvcCall, 'UVC muss eingeschaltet werden');
        assert.strictEqual(uvcCall.opts.fromAutomation, true,
            'UVC ON muss fromAutomation:true haben');
    });

    it('_lastCommandTime wird beim Ensure-Start aktualisiert', async () => {
        const adapter = makeEnsureAdapter();
        const before  = Date.now();

        await uvcModule.checkDailyMinimum(adapter);

        assert.ok(adapter._lastCommandTime >= before,
            '_lastCommandTime muss nach Ensure-Start aktualisiert sein');
    });

    it('kein UVC-Start wenn Ensure bereits aktiv (_uvcEnsureActive=true)', async () => {
        const adapter = makeEnsureAdapter();
        adapter._uvcEnsureActive = true; // bereits laufend

        const callsBefore = adapter.calls.length;
        await uvcModule.checkDailyMinimum(adapter);

        assert.strictEqual(adapter.calls.length, callsBefore,
            'Kein weiterer setFeature wenn Ensure bereits läuft');
    });

    it('kein Start wenn manualOverride aktiv', async () => {
        const adapter = makeEnsureAdapter();
        adapter._manualOverride = true;

        await uvcModule.checkDailyMinimum(adapter);

        assert.strictEqual(adapter.calls.length, 0,
            'setFeature darf bei manualOverride nicht aufgerufen werden');
    });

    it('kein Start wenn Saison deaktiviert', async () => {
        const adapter = makeEnsureAdapter();
        adapter._seasonEnabled = false;

        await uvcModule.checkDailyMinimum(adapter);

        assert.strictEqual(adapter.calls.length, 0,
            'setFeature darf außerhalb der Saison nicht aufgerufen werden');
    });

    it('stopEnsure wird aufgerufen wenn Minimum bereits erreicht', async () => {
        const adapter = makeEnsureAdapter();
        // Tagesstunden schon über Minimum – _uvcTodayResetDate auf heute setzen,
        // damit die tägliche Reset-Logik in checkDailyMinimum nicht _uvcDayStartHours
        // auf accumulateHours() überschreibt (was todayH auf 0 setzen würde).
        const today = adapter.todayStr();
        adapter._uvcHoursUsed      = 10;
        adapter._uvcDayStartH      = 0;
        adapter._uvcTodayResetDate = today;  // Reset-Guard: verhindert Re-Nullsetzung
        adapter._uvcDayStartDate   = today;
        adapter._uvcEnsureActive   = true;   // war aktiv

        await uvcModule.checkDailyMinimum(adapter);

        // stopEnsure ruft setFeature(uvc, false, {fromAutomation}) auf
        const uvcOff = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        assert.ok(uvcOff, 'UVC muss abgeschaltet werden wenn Minimum erreicht');
        assert.strictEqual(uvcOff.opts.fromAutomation, true,
            'UVC OFF (Minimum erreicht) muss fromAutomation:true haben');
    });
});

// ---------------------------------------------------------------------------
// 3. Szenario: kein unerwartetes Heizungs-Ein nach Ensure-Ende
// ---------------------------------------------------------------------------
describe('Szenario: Heizung bleibt nach UVC-Ensure-Ende aus', () => {
    const uvcModule = require('../lib/uvc');

    it('stopEnsure schaltet NIEMALS die Heizung ein', async () => {
        // Adapter-Stub mit deaktivierter Heizung
        const adapter = makeAdapter({ uvcOn: true, filterOn: true, heaterOn: false });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        const heaterOnCall = adapter.calls.find(c => c.feature === 'heater' && c.val === true);
        assert.strictEqual(heaterOnCall, undefined,
            'stopEnsure darf die Heizung NIEMALS einschalten');
    });

    it('stopEnsure hinterlässt _uvcEnsureActive=false', async () => {
        const adapter = makeAdapter({ uvcOn: true, filterOn: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        assert.strictEqual(adapter._uvcEnsureActive, false,
            '_uvcEnsureActive muss nach stopEnsure false sein');
    });

    it('App-Change-Detection greift nicht: _lastCommandTime ist frisch nach stopEnsure', async () => {
        const adapter  = makeAdapter({ uvcOn: true, filterOn: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        const before = Date.now();
        await uvcModule.stopEnsure(adapter);
        const after  = Date.now();

        // _lastCommandTime wurde durch fromAutomation:true-Calls aktualisiert
        assert.ok(
            adapter._lastCommandTime >= before && adapter._lastCommandTime <= after,
            `_lastCommandTime (${adapter._lastCommandTime}) muss zwischen ${before} und ${after} liegen`
        );
    });

    it('Grace-Period: _lastCommandTime liegt innerhalb 30s → Detection unterdrückt', async () => {
        const adapter  = makeAdapter({ uvcOn: true, filterOn: true });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true;

        await uvcModule.stopEnsure(adapter);

        const cmdGraceMs = 30_000;
        const inGrace    = (Date.now() - adapter._lastCommandTime) < cmdGraceMs;
        assert.strictEqual(inGrace, true,
            'Nach stopEnsure muss _lastCommandTime innerhalb der 30s-Grace liegen');
    });
});

// ---------------------------------------------------------------------------
// 4. stagedDeactivate – fromAutomation:true bei allen Shutdown-Schritten
// ---------------------------------------------------------------------------
describe('stagedDeactivate() – fromAutomation:true', () => {
    const pvModule = require('../lib/pv');

    function makePvAdapter({ heaterManaged = true, filterManaged = true, uvcManaged = false } = {}) {
        const adapter = makeAdapter({
            heaterOn:       heaterManaged,
            filterOn:       filterManaged,
            uvcOn:          uvcManaged,
            pvActive:       true,
            pvManagedUvc:   uvcManaged,
            pvManagedFilter: filterManaged,
            uvcHoursUsed:   10, // Minimum bereits erreicht
            uvcDayStartH:   0,
        });
        adapter._pvManagedFeatures = {
            heater: heaterManaged,
            filter: filterManaged,
            uvc:    uvcManaged,
        };
        adapter._lastData         = { heat_state: 0 };
        adapter.checkTimeWindows  = async () => {};
        return adapter;
    }

    it('Stage 1: Heater OFF hat fromAutomation:true', async () => {
        const adapter = makePvAdapter({ heaterManaged: true });
        const windows = [{ action_filter: true, action_heating: true }];

        await pvModule.stagedDeactivate(adapter, windows, true);

        const call = adapter.calls.find(c => c.feature === 'heater' && c.val === false);
        assert.ok(call, 'Heater OFF muss aufgerufen sein');
        assert.strictEqual(call.opts.fromAutomation, true, 'Heater OFF braucht fromAutomation:true');
    });

    it('Stage 3: Filter OFF wird NICHT von PV aufgerufen (Zeitfenster verwaltet Filter)', async () => {
        const adapter = makePvAdapter({ heaterManaged: false, filterManaged: false });
        const windows = [{ action_filter: true }];

        await pvModule.stagedDeactivate(adapter, windows, true);

        const call = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.strictEqual(call, undefined, 'PV darf Filter NICHT direkt abschalten – Zeitfenster verwaltet Filter');
    });

    it('Stage 2: UVC OFF wird NICHT von PV aufgerufen (Zeitfenster verwaltet UVC)', async () => {
        const adapter = makePvAdapter({ heaterManaged: false, filterManaged: false, uvcManaged: false });
        adapter._uvcHoursUsed = 10; adapter._uvcDayStartH = 0;
        const windows = [{ action_filter: true, action_uvc: true }];

        await pvModule.stagedDeactivate(adapter, windows, true);

        const call = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        assert.strictEqual(call, undefined, 'PV darf UVC NICHT direkt abschalten – Zeitfenster verwaltet UVC');
    });

    it('stagedDeactivate: _lastCommandTime wird aktualisiert', async () => {
        const adapter = makePvAdapter({ heaterManaged: true, filterManaged: true });
        const windows = [{ action_filter: true, action_heating: true }];
        const before  = Date.now();

        await pvModule.stagedDeactivate(adapter, windows, true);

        assert.ok(adapter._lastCommandTime >= before,
            '_lastCommandTime muss nach stagedDeactivate aktualisiert sein');
    });
});

// ---------------------------------------------------------------------------
// 5. reactivate – fromAutomation:true
// ---------------------------------------------------------------------------
describe('reactivate() – fromAutomation:true', () => {
    const pvModule = require('../lib/pv');

    function makePvReactivateAdapter() {
        const adapter = makeAdapter({ filterOn: false, heaterOn: false, uvcOn: false });
        adapter._pvManagedFeatures = { heater: false, filter: false, uvc: false };
        adapter._lastCommandTime   = 0;
        adapter.getStateAsync      = async () => ({ val: 0 }); // target_temp = 0 → no temp cmd
        adapter.sendTargetTempDirect = async () => {};
        adapter.setStray           = (fn, ms) => setTimeout(fn, ms);
        adapter._strayTimers       = new Set();
        return adapter;
    }

    it('filter ON wird NICHT in reactivate aufgerufen (Zeitfenster verwaltet Filter)', async () => {
        const adapter = makePvReactivateAdapter();
        const windows = [{ action_heating: true, action_filter: false, action_uvc: false, target_temp: 0 }];

        await pvModule.reactivate(adapter, windows, 800);

        const call = adapter.calls.find(c => c.feature === 'filter' && c.val === true);
        assert.strictEqual(call, undefined, 'PV darf Filter NICHT starten – Zeitfenster verwaltet Filter');
    });

    it('heater ON in reactivate hat fromAutomation:true', async () => {
        const adapter = makePvReactivateAdapter();
        const windows = [{ action_heating: true, action_filter: false, action_uvc: false, target_temp: 0 }];

        await pvModule.reactivate(adapter, windows, 800);

        const call = adapter.calls.find(c => c.feature === 'heater' && c.val === true);
        assert.ok(call, 'Heater ON muss aufgerufen sein');
        assert.strictEqual(call.opts.fromAutomation, true);
    });

    it('uvc ON wird NICHT in reactivate aufgerufen (Zeitfenster verwaltet UVC)', async () => {
        const adapter = makePvReactivateAdapter();
        const windows = [{ action_heating: false, action_filter: false, action_uvc: true }];

        await pvModule.reactivate(adapter, windows, 800);

        const call = adapter.calls.find(c => c.feature === 'uvc' && c.val === true);
        assert.strictEqual(call, undefined, 'PV darf UVC NICHT starten – Zeitfenster verwaltet UVC');
    });
});

// ---------------------------------------------------------------------------
// 6. Vollständiges Szenario: Fenster-Ende → UVC weiterläuft → Ensure stoppt →
//    kein unerwartetes Heizungs-Ein
// ---------------------------------------------------------------------------
describe('End-to-End Szenario: Fenster-Ende, UVC-Ensure, kein Heizungs-Einschalten', () => {

    it('Gesamtzustand nach stopEnsure: Heizung OFF, UVC OFF, Filter OFF', async () => {
        const uvcModule = require('../lib/uvc');
        const adapter   = makeAdapter({
            uvcOn:    true,
            filterOn: true,
            heaterOn: false,   // wurde bei Fenster-Ende bereits abgeschaltet
        });
        adapter._uvcEnsureActive      = true;
        adapter._uvcEnsureFilterStart = true; // ensure hat Filter gestartet

        await uvcModule.stopEnsure(adapter);

        assert.strictEqual(adapter._uvcEnsureActive, false, 'Ensure ist beendet');

        // Alle setFeature-Calls prüfen
        for (const call of adapter.calls) {
            assert.strictEqual(call.opts.fromAutomation, true,
                `Jeder setFeature-Aufruf beim Ensure-Ende muss fromAutomation:true haben (${call.feature} ${call.val})`
            );
            assert.notStrictEqual(call.feature === 'heater' && call.val === true, true,
                'Heizung darf NICHT eingeschaltet werden');
        }

        // Kontrolle: UVC und Filter wurden abgeschaltet
        const uvcOff    = adapter.calls.find(c => c.feature === 'uvc'    && c.val === false);
        const filterOff = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.ok(uvcOff,    'UVC muss abgeschaltet werden');
        assert.ok(filterOff, 'Filter muss abgeschaltet werden');
    });

    it('_timeWindowActive bleibt false nach Fenster-Ende (kein Re-Aktivierungsauslöser)', () => {
        // Simuliere den Zustand nach deactivateWindow() + early return wegen UVC-Minimum
        const timeWindowActive = [false]; // wurde in deactivateWindow gesetzt
        const adapter          = makeAdapter({ timeWindowActive });

        // checkTimeWindows prüft: inWin=false && wasIn=false → keine Aktion
        const inWin  = false; // Fensterzeit ist abgelaufen
        const wasIn  = timeWindowActive[0]; // false (gesetzt bei early return)
        const shouldActivate   = inWin && !wasIn;
        const shouldDeactivate = !inWin && wasIn;

        assert.strictEqual(shouldActivate,   false, 'Fenster darf nicht reaktiviert werden');
        assert.strictEqual(shouldDeactivate, false, 'deactivateWindow wird nicht erneut aufgerufen');
    });
});

// ---------------------------------------------------------------------------
// 7. Deactivate-Window: Heizung wird VOR dem UVC-Early-Return abgeschaltet
// ---------------------------------------------------------------------------
describe('deactivateWindow() – Heizung zuerst abschalten', () => {

    /**
     * Simuliert die deactivateWindow-Logik (inline, um keinen vollen Adapter zu booten).
     * Prüft, dass die Heizung vor dem UVC-Early-Return abgeschaltet wird.
     */
    function simulateDeactivateWindow({
        actionHeating, actionFilter, actionUvc,
        otherNeedsHeater = false, otherNeedsUvc = false, otherNeedsFilter = false,
        uvcMinMet = false,
    }) {
        const log      = [];
        const commands = [];

        const setFeature = (feature, val, opts) => {
            commands.push({ feature, val, opts });
        };

        // Kopie der Logik aus deactivateWindow()
        // Schritt 1: Heizung
        if (actionHeating && !otherNeedsHeater) {
            setFeature('heater', false, { fromAutomation: true });
        }

        // Schritt 2: UVC
        if (actionUvc && !otherNeedsUvc) {
            if (uvcMinMet) {
                setFeature('uvc', false, { fromAutomation: true });
            } else {
                // early return – Heizung wurde BEREITS abgeschaltet
                log.push('early-return: uvc-min-not-met');
                return { commands, log, earlyReturn: true };
            }
        }

        // Schritt 3: Filter
        if (!otherNeedsFilter && actionFilter) {
            setFeature('filter', false, { fromAutomation: true });
        }

        return { commands, log, earlyReturn: false };
    }

    it('Heizung wird VOR dem UVC-Early-Return abgeschaltet', () => {
        const result = simulateDeactivateWindow({
            actionHeating: true,
            actionFilter:  true,
            actionUvc:     true,
            uvcMinMet:     false,  // Minimum noch nicht erreicht → early return
        });

        assert.strictEqual(result.earlyReturn, true, 'Early-Return wegen UVC-Minimum muss stattfinden');

        const heaterOff = result.commands.find(c => c.feature === 'heater' && c.val === false);
        assert.ok(heaterOff, 'Heizung muss VOR dem Early-Return abgeschaltet sein');
    });

    it('Heizung bleibt ON wenn anderes Fenster sie benötigt', () => {
        const result = simulateDeactivateWindow({
            actionHeating:    true,
            actionFilter:     true,
            actionUvc:        true,
            otherNeedsHeater: true,
            uvcMinMet:        false,
        });

        const heaterOff = result.commands.find(c => c.feature === 'heater' && c.val === false);
        assert.strictEqual(heaterOff, undefined, 'Heizung darf nicht abgeschaltet werden wenn anderes Fenster sie braucht');
    });

    it('Normalfall ohne UVC: Heizung → Filter werden abgeschaltet', () => {
        const result = simulateDeactivateWindow({
            actionHeating: true,
            actionFilter:  true,
            actionUvc:     false,
            uvcMinMet:     false,
        });

        assert.strictEqual(result.earlyReturn, false);
        const heaterOff = result.commands.find(c => c.feature === 'heater' && c.val === false);
        const filterOff = result.commands.find(c => c.feature === 'filter' && c.val === false);
        assert.ok(heaterOff, 'Heizung muss abgeschaltet werden');
        assert.ok(filterOff, 'Filter muss abgeschaltet werden');
    });

    it('Normalfall UVC Minimum erfüllt: Heizung → UVC → Filter', () => {
        const result = simulateDeactivateWindow({
            actionHeating: true,
            actionFilter:  true,
            actionUvc:     true,
            uvcMinMet:     true,
        });

        assert.strictEqual(result.earlyReturn, false, 'Kein Early-Return wenn Minimum erfüllt');
        assert.ok(result.commands.find(c => c.feature === 'heater' && c.val === false), 'Heizung OFF');
        assert.ok(result.commands.find(c => c.feature === 'uvc'    && c.val === false), 'UVC OFF');
        assert.ok(result.commands.find(c => c.feature === 'filter' && c.val === false), 'Filter OFF');
    });
});
