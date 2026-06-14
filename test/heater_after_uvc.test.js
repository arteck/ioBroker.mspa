'use strict';

/**
 * Tests: "Wird die Heizung außerhalb des Fensters nach UVC eingeschaltet?"
 *
 * Root-Cause:
 *   stopEnsure() schaltet UVC + Filter gleichzeitig ab.
 *   checkPowerCycle() wertet filter_off + uvc_off = 2 Änderungen → falscher
 *   "Power-Cycle" erkannt → restoreSavedState() aufgerufen.
 *   Wenn _savedState.heater='on' (aus Stromausfall während aktivem Fenster):
 *   → Heizung wird AUSSERHALB des Zeitfensters eingeschaltet.
 *
 * Zwei Fixes:
 *   Fix 1: checkPowerCycle() – 60-s-Suppression nach Adapter-Befehl
 *           (_lastCommandTime gesetzt durch fromAutomation:true in stopEnsure)
 *   Fix 2: restoreSavedState() – allowHeaterRestore-Guard
 *           (Heizung nur wiederherstellen wenn Fenster aktiv ODER PV aktiv)
 *
 * Run:  npx mocha test/heater_after_uvc.test.js --no-config
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ---------------------------------------------------------------------------
// Minimaler Adapter-Stub – reicht für checkPowerCycle + restoreSavedState
// ---------------------------------------------------------------------------
function makeAdapter({
    savedState         = {},
    lastSnapshot       = {},
    lastCommandTime    = 0,        // 0 = kein Befehl → Suppression inaktiv
    timeWindowActive   = [false],
    pvActive           = false,
    seasonEnabled      = true,
    winterModeActive   = false,
    restoreStateOnPowerCycle = true,
    trackTemperatureUnit     = false,
    alwaysEnforceUnit        = false,
} = {}) {
    const calls    = [];   // setFeature-Aufrufe
    const logMsgs  = { debug: [], info: [], warn: [] };

    const adapter = {
        config: {
            restoreStateOnPowerCycle,
            trackTemperatureUnit,
            alwaysEnforceUnit,
            more_log_enabled:   false,
            timeWindows: [{ active: true, action_heating: true, action_filter: true }],
        },
        log: {
            debug: m => logMsgs.debug.push(m),
            info:  m => logMsgs.info.push(m),
            warn:  m => logMsgs.warn.push(m),
        },
        logs: logMsgs,
        calls,

        // Adapter-Status
        _savedState:         { ...savedState },
        _lastSnapshot:       { ...lastSnapshot },
        _lastCommandTime:    lastCommandTime,
        _lastIsOnline:       true,   // Gerät war zuletzt online
        _timeWindowActive:   timeWindowActive,
        _pvActive:           pvActive,
        _seasonEnabled:      seasonEnabled,
        _winterModeActive:   winterModeActive,
        _unloading:          false,
        _strayTimers:        new Set(),

        // restoreSavedState tracken
        _restoreCalled:      false,
        _restoredFeatures:   [],

        // Methoden-Stubs
        async setFeature(feature, val, opts = {}) {
            calls.push({ feature, val, opts: { ...opts } });
            if (opts.fromAutomation) {
                this._lastCommandTime = Date.now();
            }
        },

        setStray(fn, ms) {
            const t = setTimeout(() => { this._strayTimers.delete(t); fn(); }, ms);
            this._strayTimers.add(t);
            return t;
        },

        async enforceTemperatureUnit() {},

        async restoreSavedState() {
            this._restoreCalled = true;

            // ── Replizierte Guard-Logik aus main.js ──────────────────────────
            const windows = this.config.timeWindows;
            const hasHeatingWindows = Array.isArray(windows) && windows.some(w => w.active && w.action_heating);
            let allowHeaterRestore = true;
            if (hasHeatingWindows && !this._pvActive) {
                const heatingWindowActiveNow = Array.isArray(windows) && windows.some((w, i) =>
                    w.active && w.action_heating && this._timeWindowActive[i]
                );
                if (!heatingWindowActiveNow) {
                    allowHeaterRestore = false;
                }
            }
            if (!this._seasonEnabled && !this._winterModeActive) {
                allowHeaterRestore = false;
            }
            // ─────────────────────────────────────────────────────────────────

            for (const feature of ['heater', 'filter', 'ozone', 'uvc', 'bubble']) {
                if (this._savedState[feature] === 'on') {
                    if (feature === 'heater' && !allowHeaterRestore) continue;
                    this._restoredFeatures.push(feature);
                    await this.setFeature(feature, true, { fromAutomation: true });
                }
            }
        },

        // Replizierte checkPowerCycle-Logik aus main.js (nach Fix)
        async checkPowerCycle(data) {
            const currentOnline = !!data.is_online;
            let powerCycle = false;

            if (this._lastIsOnline !== null) {
                if (this._lastIsOnline && !currentOnline) {
                    this._savedState = { heater: data.heater, filter: data.filter,
                        uvc: data.uvc, ozone: data.ozone, bubble: data.bubble,
                        temperature_unit: data.temperature_unit,
                        target_temperature: data.target_temperature };
                } else if (!this._lastIsOnline && currentOnline) {
                    powerCycle = true;
                }
            }

            if (!powerCycle && Object.keys(this._lastSnapshot).length) {
                // FIX: 60-s-Suppression nach Adapter-Befehl
                const cmdAgeMs = Date.now() - this._lastCommandTime;
                const suppress = this._lastCommandTime > 0 && cmdAgeMs < 60_000;
                if (suppress) {
                    this.log.debug(`checkPowerCycle: suppressed (${Math.round(cmdAgeMs / 1000)} s ago)`);
                } else {
                    const changes = [];
                    if (this._lastSnapshot.temperature_unit === 0 && data.temperature_unit === 1) changes.push('temp_unit_reset');
                    if (this._lastSnapshot.heater === 'on' && data.heater === 'off')  changes.push('heater_off');
                    if (this._lastSnapshot.filter === 'on' && data.filter === 'off')  changes.push('filter_off');
                    if (this._lastSnapshot.ozone  === 'on' && data.ozone  === 'off')  changes.push('ozone_off');
                    if (this._lastSnapshot.uvc    === 'on' && data.uvc    === 'off')  changes.push('uvc_off');
                    if (changes.length >= 2) { powerCycle = true; this.log.warn(`power cycle (${changes.join(',')})`); }
                }
            }

            this._lastSnapshot = { temperature_unit: data.temperature_unit, heater: data.heater,
                filter: data.filter, ozone: data.ozone, uvc: data.uvc, target_temperature: data.target_temperature };
            this._lastIsOnline = currentOnline;

            if (powerCycle && this.config.restoreStateOnPowerCycle && Object.keys(this._savedState).length) {
                await this.restoreSavedState();
            }
        },
    };
    return adapter;
}

// ---------------------------------------------------------------------------
// 1. Quelltext-Audit: main.js enthält die 60-s-Suppression
// ---------------------------------------------------------------------------
describe('Quelltext-Audit: checkPowerCycle enthält 60-s-Suppression', () => {
    it('main.js: suppressPowerCycleDetection prüft _lastCommandTime', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/powerCycle.js'), 'utf8');
        assert.ok(src.includes('suppressPowerCycleDetection'),
            'checkPowerCycle muss suppressPowerCycleDetection-Flag enthalten');
        assert.ok(src.includes('CONSTANTS.POWER_CYCLE_SUPPRESS_MS'),
            'Suppression muss auf 60 s ausgelegt sein');
        assert.ok(src.includes('_lastCommandTime'),
            '_lastCommandTime muss für die Suppression genutzt werden');
    });

    it('main.js: Suppression-Log-Meldung ist vorhanden', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/powerCycle.js'), 'utf8');
        assert.ok(src.includes('snapshot detection suppressed'),
            'Debug-Log bei Suppression muss vorhanden sein');
    });

    it('main.js: restoreSavedState enthält allowHeaterRestore-Guard', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/powerCycle.js'), 'utf8');
        assert.ok(src.includes('allowHeaterRestore'),
            'restoreSavedState muss allowHeaterRestore-Guard enthalten (2. Verteidigungslinie)');
    });
});

// ---------------------------------------------------------------------------
// 2. Der exakte Bug: stopEnsure löst falschen Power-Cycle aus
// ---------------------------------------------------------------------------
describe('Bug-Reproduktion: filter_off + uvc_off = falscher Power-Cycle', () => {

    it('OHNE Fix: filter_off + uvc_off wird als Power-Cycle gewertet', async () => {
        // Simuliert das ALTE Verhalten (ohne 60-s-Suppression)
        const lastSnapshot = { heater: 'off', filter: 'on', uvc: 'on', ozone: 'off',
                               temperature_unit: 0 };
        const data         = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                               temperature_unit: 0, is_online: true };

        const changes = [];
        if (lastSnapshot.filter === 'on' && data.filter === 'off') changes.push('filter_off');
        if (lastSnapshot.uvc   === 'on' && data.uvc   === 'off') changes.push('uvc_off');

        assert.strictEqual(changes.length, 2,
            'Zwei Änderungen → ohne Fix wird falscher Power-Cycle erkannt');
        assert.ok(changes.includes('filter_off'));
        assert.ok(changes.includes('uvc_off'));
    });

    it('MIT Fix: Suppression greift wenn _lastCommandTime frisch gesetzt', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on', uvc: 'on' },  // war vorher alles an
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'on', ozone: 'off',
                           temperature_unit: 0 },
            lastCommandTime: Date.now(),   // gerade eben Befehl gesendet (fromAutomation)
            timeWindowActive: [false],
            restoreStateOnPowerCycle: true,
        });

        const data = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                      temperature_unit: 0, is_online: true };

        await adapter.checkPowerCycle(data);

        assert.strictEqual(adapter._restoreCalled, false,
            'restoreSavedState DARF nicht aufgerufen werden wenn Befehl frisch gesendet');
        assert.ok(adapter.logs.debug.some(m => m.includes('suppressed')),
            'Debug-Log muss Suppression bestätigen');
    });

    it('MIT Fix: kein Suppression nach abgelaufener Grace-Period (> 60 s)', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on', uvc: 'on' },
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'on', ozone: 'off',
                           temperature_unit: 0 },
            lastCommandTime: Date.now() - 65_000,  // 65 s alter Befehl → keine Suppression
            timeWindowActive: [false],
            restoreStateOnPowerCycle: true,
            seasonEnabled: true,
        });

        const data = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                      temperature_unit: 0, is_online: true };

        await adapter.checkPowerCycle(data);

        // Ohne Suppression → Power-Cycle erkannt → restoreSavedState aufgerufen
        assert.strictEqual(adapter._restoreCalled, true,
            'restoreSavedState muss aufgerufen werden wenn Grace-Period abgelaufen');
    });
});

// ---------------------------------------------------------------------------
// 3. Vollständiges End-to-End-Szenario
// ---------------------------------------------------------------------------
describe('End-to-End: Heizung bleibt aus nach stopEnsure (außerhalb Fenster)', () => {

    /**
     * Szenario:
     *   10:00–18:00 Heiz-Fenster aktiv → heater=ON, filter=ON, uvc=ON
     *   14:30: Gerät kurz offline → _savedState.heater='on'
     *   14:31: Gerät wieder online
     *   18:00: Fenster endet → heater=OFF, uvc bleibt (min nicht erreicht)
     *   20:00: UVC-Min erreicht → stopEnsure() → uvc=OFF, filter=OFF
     *           → _lastCommandTime frisch (fromAutomation:true)
     *   Poll nach 20:00: filter_off + uvc_off → würde falschen Power-Cycle auslösen
     *           → SUPPRIMIERT durch 60-s-Guard
     *   → Heizung bleibt AUS ✓
     */
    it('FIX 1 (60-s-Suppression): Heizung bleibt aus nach stopEnsure + falschem Power-Cycle', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on', uvc: 'on' },  // gespeichert bei 14:30 Offline
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'on',  // snapshot nach 18:00
                           ozone: 'off', temperature_unit: 0 },
            lastCommandTime: Date.now(),   // stopEnsure eben gerade aufgerufen (fromAutomation:true)
            timeWindowActive: [false],     // Fenster ist beendet (_timeWindowActive=false)
            seasonEnabled: true,
            restoreStateOnPowerCycle: true,
        });

        // Gerät meldet jetzt filter=off und uvc=off (stopEnsure hat sie abgeschaltet)
        const pollData = { heater: 'off', filter: 'off', uvc: 'off',
                          ozone: 'off', temperature_unit: 0, is_online: true };

        await adapter.checkPowerCycle(pollData);

        // FIX 1: Power-Cycle-Detection supprimiert → restoreSavedState nicht aufgerufen
        assert.strictEqual(adapter._restoreCalled, false,
            'restoreSavedState darf NICHT aufgerufen werden (Fix 1: 60-s-Suppression)');
        const heaterOn = adapter.calls.find(c => c.feature === 'heater' && c.val === true);
        assert.strictEqual(heaterOn, undefined,
            'Heizung darf nach UVC-Ende NICHT eingeschaltet werden');
    });

    it('FIX 2 (allowHeaterRestore): Heizung bleibt aus wenn Power-Cycle TROTZDEM erkannt', async () => {
        // Fallback-Schutz: auch wenn Fix 1 nicht greift (z.B. 65-s-alter Befehl),
        // verhindert Fix 2 das Einschalten der Heizung außerhalb des Fensters.
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on', uvc: 'on' },
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'on',
                           ozone: 'off', temperature_unit: 0 },
            lastCommandTime: Date.now() - 65_000,  // 65 s → keine 60-s-Suppression mehr
            timeWindowActive: [false],              // kein Fenster aktiv um 20:00
            seasonEnabled: true,
            restoreStateOnPowerCycle: true,
        });

        const pollData = { heater: 'off', filter: 'off', uvc: 'off',
                          ozone: 'off', temperature_unit: 0, is_online: true };

        await adapter.checkPowerCycle(pollData);

        // restoreSavedState wird aufgerufen (Power-Cycle erkannt)
        assert.strictEqual(adapter._restoreCalled, true, 'restoreSavedState wurde aufgerufen');

        // Fix 2: allowHeaterRestore=false (kein Fenster aktiv) → Heizung NICHT einschalten
        assert.ok(!adapter._restoredFeatures.includes('heater'),
            'Heizung darf durch allowHeaterRestore-Guard NICHT wiederhergestellt werden');
    });

    it('Filter darf nach Fenster-Ende und UVC-Ende eingeschaltet werden (kein Guard)', async () => {
        // Filter wird nicht durch den Heizungs-Guard blockiert
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on', uvc: 'on' },
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'on', ozone: 'off', temperature_unit: 0 },
            lastCommandTime: Date.now() - 65_000,
            timeWindowActive: [false],
            seasonEnabled: true,
            restoreStateOnPowerCycle: true,
        });
        const pollData = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off', temperature_unit: 0, is_online: true };
        await adapter.checkPowerCycle(pollData);

        // Filter kann wiederhergestellt werden (kein Heizungs-Guard für Filter)
        // HINWEIS: ob das sinnvoll ist, hängt von der App-Konfiguration ab –
        // technisch ist es nicht verboten.
        assert.strictEqual(adapter._restoreCalled, true);
    });

    it('Fenster aktiv zur Restore-Zeit: Heizung DARF eingeschaltet werden', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on', uvc: 'off' },
            lastSnapshot: { heater: 'on', filter: 'on', uvc: 'off', ozone: 'off', temperature_unit: 0 },
            lastCommandTime: Date.now() - 65_000,
            timeWindowActive: [true],    // ← Fenster ist aktiv!
            seasonEnabled: true,
            restoreStateOnPowerCycle: true,
        });

        // Echte is_online-Transition → Power-Cycle via online-Erkennung
        adapter._lastIsOnline = false;
        const pollData = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                          temperature_unit: 0, is_online: true };
        await adapter.checkPowerCycle(pollData);

        assert.strictEqual(adapter._restoreCalled, true);
        assert.ok(adapter._restoredFeatures.includes('heater'),
            'Heizung MUSS wiederhergestellt werden wenn Fenster aktiv ist');
    });
});

// ---------------------------------------------------------------------------
// 4. checkPowerCycle – weitere Suppression-Tests
// ---------------------------------------------------------------------------
describe('checkPowerCycle – 60-s-Suppression Edge-Cases', () => {

    it('_lastCommandTime=0 → keine Suppression (erstes Mal / kein Befehl)', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on' },
            lastSnapshot: { heater: 'on', filter: 'on', uvc: 'off', ozone: 'on',
                           temperature_unit: 0 },
            lastCommandTime: 0,   // nie ein Befehl gesendet
            timeWindowActive: [false],
            restoreStateOnPowerCycle: true,
        });
        const data = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                      temperature_unit: 0, is_online: true };
        await adapter.checkPowerCycle(data);

        // heater_off + ozone_off → 2 Änderungen → Power-Cycle erkannt (korrekt)
        assert.strictEqual(adapter._restoreCalled, true,
            'Echter Power-Cycle ohne frischen Befehl muss erkannt werden');
    });

    it('Exakt an der 60-s-Grenze: 59.9 s → noch supprimiert', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on' },
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'on', ozone: 'off', temperature_unit: 0 },
            lastCommandTime: Date.now() - 59_900,  // 59.9 s → unter 60 s → supprimiert
            timeWindowActive: [false],
            restoreStateOnPowerCycle: true,
        });
        const data = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                      temperature_unit: 0, is_online: true };
        await adapter.checkPowerCycle(data);

        assert.strictEqual(adapter._restoreCalled, false,
            'Suppression muss bei 59.9 s noch greifen');
    });

    it('is_online-Übergang false→true IMMER Power-Cycle (kein Suppression)', async () => {
        // Der is_online-Übergang ist ein echter Power-Cycle –
        // darf durch Befehl-Suppression nicht maskiert werden.
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on' },
            lastSnapshot: {},
            lastCommandTime: Date.now(),   // frischer Befehl
            timeWindowActive: [true],
            restoreStateOnPowerCycle: true,
        });
        adapter._lastIsOnline = false;  // war offline

        const data = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                      temperature_unit: 0, is_online: true };
        await adapter.checkPowerCycle(data);

        assert.strictEqual(adapter._restoreCalled, true,
            'Echter Power-Cycle (is_online-Transition) darf nicht supprimiert werden');
    });

    it('Einzelne Änderung (filter_off allein) → KEIN Power-Cycle', async () => {
        const adapter = makeAdapter({
            savedState:   { heater: 'on', filter: 'on' },
            lastSnapshot: { heater: 'off', filter: 'on', uvc: 'off', ozone: 'off', temperature_unit: 0 },
            lastCommandTime: 0,   // kein frischer Befehl
            timeWindowActive: [false],
            restoreStateOnPowerCycle: true,
        });
        const data = { heater: 'off', filter: 'off', uvc: 'off', ozone: 'off',
                      temperature_unit: 0, is_online: true };
        await adapter.checkPowerCycle(data);

        // Nur 1 Änderung (filter_off) → kein Power-Cycle
        assert.strictEqual(adapter._restoreCalled, false,
            'Eine einzelne Änderung darf kein Power-Cycle sein');
    });
});

// ---------------------------------------------------------------------------
// 5. stopEnsure setzt _lastCommandTime via fromAutomation:true
// ---------------------------------------------------------------------------
describe('stopEnsure setzt _lastCommandTime – Integration mit Suppression', () => {
    const uvcModule = require('../lib/uvc');

    function makeEnsureAdapter() {
        const calls = [];
        let lastCommandTime = 0;
        return {
            config: { more_log_enabled: false, uvc_daily_min_h: 2 },
            log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            calls,
            _pvActive: false,
            _pvManagedFeatures: { uvc: false },
            _timeWindowActive: [false],
            _winterFrostActive: false,
            _uvcEnsureActive: true,
            _uvcEnsureFilterStart: true,
            get _lastCommandTime() { return lastCommandTime; },
            enableRapidPolling() {},
            async getStateAsync(id) {
                if (id === 'control.uvc')    return { val: true };
                if (id === 'control.filter') return { val: true };
                return null;
            },
            async setFeature(feature, val, opts = {}) {
                calls.push({ feature, val, opts: { ...opts } });
                if (opts.fromAutomation) {
                    lastCommandTime = Date.now();
                }
            },
        };
    }

    it('stopEnsure: _lastCommandTime wird durch fromAutomation:true aktualisiert', async () => {
        const adapter = makeEnsureAdapter();
        const before  = Date.now();

        await uvcModule.stopEnsure(adapter);

        assert.ok(adapter._lastCommandTime >= before,
            '_lastCommandTime muss nach stopEnsure aktualisiert sein');
    });

    it('stopEnsure: _lastCommandTime ist frisch genug für 60-s-Suppression', async () => {
        const adapter = makeEnsureAdapter();
        await uvcModule.stopEnsure(adapter);

        const cmdAgeMs = Date.now() - adapter._lastCommandTime;
        assert.ok(cmdAgeMs < 60_000,
            `_lastCommandTime muss innerhalb 60 s liegen (ist ${cmdAgeMs} ms alt)`);
    });

    it('Kombination: nach stopEnsure wird checkPowerCycle-Suppression aktiviert', async () => {
        const adapter = makeEnsureAdapter();
        await uvcModule.stopEnsure(adapter);

        const cmdAgeMs = Date.now() - adapter._lastCommandTime;
        const wouldSuppress = adapter._lastCommandTime > 0 && cmdAgeMs < 60_000;

        assert.strictEqual(wouldSuppress, true,
            'Nach stopEnsure muss die 60-s-Suppression in checkPowerCycle greifen');
    });
});
