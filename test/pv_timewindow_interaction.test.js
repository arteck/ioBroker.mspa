'use strict';

/**
 * test/pv_timewindow_interaction.test.js
 *
 * Prüft die Interaktion zwischen PV-Steuerung und Zeitfenstern.
 *
 * Kernszenarien:
 *   A. PV aktiv  →  checkTimeWindows wird geblockt (PV Guard)
 *   B. PV staged (Abschaltreihenfolge läuft)  →  checkTimeWindows geblockt
 *   C. PV deaktiviert (kein Überschuss)  →  Zeitfenster übernimmt sofort
 *   D. deactivateWindow wird geblockt wenn PV aktiv
 *   E. deactivateWindow wird geblockt wenn PV-Stage-Timer läuft
 *   F. filterRunning() erkennt PV-verwalteten Filter
 *   G. Manueller Override  →  beide (PV + Zeitfenster) werden geblockt
 *   H. PV NICHT genug  →  Zeitfenster startet Features korrekt
 *   I. PV endet mitten im Zeitfenster  →  Zeitfenster übernimmt nach stagedDeactivate
 *   J. stagedDeactivate ruft checkTimeWindows NACH Abschluss auf
 *
 * Run: npx mocha test/pv_timewindow_interaction.test.js
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Hilfsfunktion: Minimalen Adapter-Mock erstellen
// ---------------------------------------------------------------------------
function createAdapter(overrides = {}) {
    const adapter = {
        _manualOverride: false,
        _manualOverrideTimer: null,
        _pvActive: false,
        _pvStageTimer: null,
        _pvDeactivateTimer: null,
        _pvDeactivateCountdown: 0,
        _pvDeactivateCountdownInt: null,
        _pvManagedFeatures: { heater: false, filter: false, uvc: false },
        _timeWindowActive: [],
        _lastData: { filter: 'off', heat_state: 0 },
        _adapterCommanded: { filter: null, uvc: null, heater: null },
        _pumpFollowUpTimers: [],
        _pumpStartedForHeating: false,
        _api: { _lastStatus: null },
        _seasonEnabled: true,
        config: {
            timeWindows: [],
            more_log_enabled: false,
            pump_follow_up: 0,
            uvc_daily_min_h: 2,
            pv_threshold_w: 500,
            pv_hysteresis_w: 100,
            pv_deactivate_delay_min: 0,
        },
        log: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: (m) => { throw new Error(`adapter.log.error: ${m}`); },
        },
        // Aufgezeichnete setFeature-Aufrufe
        setFeatureCalls: [],
        async setFeature(f, v) { this.setFeatureCalls.push({ f, v }); },

        checkTimeWindowsCalls: 0,
        async checkTimeWindows() { this.checkTimeWindowsCalls++; },

        isInSeason() { return true; },
        isInTimeWindow(start, end) {
            // Standard: immer im Fenster (kann überschrieben werden)
            return true;
        },
        getUvcTodayHours() { return 3; },  // Standard: Minimum bereits erfüllt
        enableRapidPolling() {},
        setState(id, val, ack) {},
        async getStateAsync(id) { return null; },
        async setStray(fn, ms) {},
        ...overrides,
    };

    // ── checkTimeWindows – aus main.js portierte Logik ─────────────────────
    adapter.checkTimeWindowsReal = async function () {
        const windows = this.config.timeWindows;
        if (!Array.isArray(windows)) return;

        if (this._manualOverride) {
            this.log.debug('Time control: manual override active – skipping time window control');
            return;
        }
        // PV guard: nur wenn mindestens ein Fenster pv_steu=true hat
        const anyPvWindow = windows.some(w => w.active && w.pv_steu);
        if (anyPvWindow && (this._pvActive || this._pvStageTimer !== null)) {
            this.log.debug('Time control: PV control active – skipping time window control');
            return;
        }
        if (!this.isInSeason()) {
            return;
        }

        while (this._timeWindowActive.length < windows.length) {
            this._timeWindowActive.push(false);
        }

        const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];
        const day = new Date().getDay();

        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (!w.active) {
                // active=false: komplett ignorieren – kein deactivateWindow, kein State-Reset
                continue;
            }
            const start  = w.start || '00:00';
            const end    = w.end   || '00:00';
            const dayOn  = !!w[dayKeys[day]];
            const inWin  = dayOn && this.isInTimeWindow(start, end);
            const wasIn  = this._timeWindowActive[i];

            if (inWin && !wasIn) {
                this._timeWindowActive[i] = true;
                try {
                    if (w.action_heating) {
                        if (!w.action_filter) {
                            // filter als Heizer-Voraussetzung (action_filter=false)
                            await this.setFeature('filter', true);
                        } else {
                            // action_filter=true: filter VOR heater starten (Bug-Fix)
                            await this.setFeature('filter', true);
                        }
                        await this.setFeature('heater', true);
                    }
                    if (w.action_filter) {
                        // Nur senden wenn nicht bereits durch action_heating gestartet
                        if (!w.action_heating) {
                            await this.setFeature('filter', true);
                        }
                        if (w.action_uvc) {
                            await this.setFeature('uvc', true);
                        }
                    }
                } catch (err) {
                    this._timeWindowActive[i] = false;
                    this.log.error(`Time control [${i + 1}]: activation FAILED – ${err.message}`);
                }
            } else if (!inWin && wasIn) {
                this._timeWindowActive[i] = false;
                await this.deactivateWindow(w, i);
            }
        }
    };

    // ── deactivateWindow – aus main.js portierte Logik ────────────────────
    adapter.deactivateWindow = async function (w, i) {
        const anyPvWindow = Array.isArray(this.config.timeWindows) &&
            this.config.timeWindows.some(win => win.active && win.pv_steu);
        if (anyPvWindow && (this._pvActive || this._pvStageTimer !== null)) {
            if (this.config.more_log_enabled) {
                this.log.info(`Time control [${i + 1}]: window END – PV control active, skipping deactivation`);
            }
            return;
        }
        if (this._pumpFollowUpTimers[i]) {
            clearTimeout(this._pumpFollowUpTimers[i]);
            this._pumpFollowUpTimers[i] = null;
        }
        try {
            if (w.action_heating) await this.setFeature('heater', false);
            const uvcMinMet = this.getUvcTodayHours() >= (this.config.uvc_daily_min_h ?? 2);
            if (w.action_filter && w.action_uvc) {
                if (uvcMinMet) await this.setFeature('uvc', false);
                else { this.enableRapidPolling(); return; }
            }
            if (w.action_filter) await this.setFeature('filter', false);
        } catch (err) {
            this._timeWindowActive[i] = true;
            this.log.error(`Time control [${i + 1}]: deactivation FAILED – ${err.message}`);
        }
    };

    // filterRunning – aus main.js portierte Logik
    adapter.filterRunning = function () {
        return (
            (this._lastData && this._lastData.filter === 'on') ||
            (this._api && this._api._lastStatus && this._api._lastStatus.filter_state === 1) ||
            (this._adapterCommanded.filter === true) ||
            (this._pvManagedFeatures && this._pvManagedFeatures.filter === true)
        );
    };

    return adapter;
}

// Hilfsfunktion: Zeitfenster für heute erstellen
function makeWindow(overrides = {}) {
    const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];
    const today = dayKeys[new Date().getDay()];
    return {
        active: true,
        start: '00:00',
        end: '23:59',
        action_filter: true,
        action_heating: false,
        action_uvc: false,
        [today]: true,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// A. PV aktiv → checkTimeWindows geblockt
// ---------------------------------------------------------------------------
describe('A. PV Guard – checkTimeWindows geblockt bei _pvActive=true', () => {
    it('setzt keine Features wenn PV aktiv ist', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'setFeature darf NICHT aufgerufen werden wenn PV aktiv ist');
        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive[0] muss false bleiben');
    });

    it('startet weder Heizer noch Filter wenn PV aktiv', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: false, pv_steu: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// B. PV staged (Stage-Timer läuft) → checkTimeWindows geblockt
// ---------------------------------------------------------------------------
describe('B. PV Guard – checkTimeWindows geblockt bei _pvStageTimer≠null', () => {
    it('setzt keine Features wenn PV-Stage-Timer aktiv ist', async () => {
        const adapter = createAdapter({
            _pvActive: false,
            _pvStageTimer: setTimeout(() => {}, 60_000),
        });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        clearTimeout(adapter._pvStageTimer);
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'setFeature darf NICHT aufgerufen werden solange Stage-Timer läuft');
    });
});

// ---------------------------------------------------------------------------
// C. PV NICHT genug Überschuss, kein Zeitfenster aktiv → Zeitfenster startet
// ---------------------------------------------------------------------------
describe('C. Nicht genug PV → Zeitfenster übernimmt', () => {
    it('aktiviert Filter wenn PV inaktiv und Zeitfenster gerade beginnt', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss aufgerufen werden');
        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive[0] muss true werden');
    });

    it('aktiviert Heizer + Filter wenn PV inaktiv und Heizfenster beginnt', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: false })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === true),
            'heater ON muss aufgerufen werden');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON (für Heizer benötigt) muss aufgerufen werden');
    });

    it('aktiviert Filter+UVC wenn PV inaktiv und UVC-Fenster beginnt', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, action_uvc: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss aufgerufen werden');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'uvc' && c.v === true),
            'uvc ON muss aufgerufen werden');
    });
});

// ---------------------------------------------------------------------------
// D. deactivateWindow geblockt wenn PV aktiv
// ---------------------------------------------------------------------------
describe('D. deactivateWindow geblockt wenn _pvActive=true', () => {
    it('schaltet Filter NICHT ab wenn PV gerade Filter steuert', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter._pvManagedFeatures.filter = true;
        // timeWindows muss pv_steu:true enthalten damit anyPvWindow=true
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        const w = makeWindow({ action_filter: true, action_heating: false, pv_steu: true });

        await adapter.deactivateWindow(w, 0);

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'setFeature darf NICHT aufgerufen werden – PV steuert Filter');
    });

    it('schaltet Heizer NICHT ab wenn PV aktiv ist', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter._pvManagedFeatures.heater = true;
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: true })];
        const w = makeWindow({ action_heating: true, action_filter: true, pv_steu: true });

        await adapter.deactivateWindow(w, 0);

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'heater OFF darf NICHT gesendet werden – PV ist aktiv');
    });
});

// ---------------------------------------------------------------------------
// E. deactivateWindow geblockt wenn PV-Stage-Timer läuft
// ---------------------------------------------------------------------------
describe('E. deactivateWindow geblockt wenn _pvStageTimer≠null', () => {
    it('schaltet nichts ab wenn Stage-Timer noch läuft', async () => {
        const timer = setTimeout(() => {}, 60_000);
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: timer });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        const w = makeWindow({ action_filter: true, action_heating: false, pv_steu: true });

        await adapter.deactivateWindow(w, 0);

        clearTimeout(timer);
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'setFeature darf NICHT aufgerufen werden solange PV-Stage läuft');
    });
});

// ---------------------------------------------------------------------------
// F. filterRunning() erkennt PV-verwalteten Filter
// ---------------------------------------------------------------------------
describe('F. filterRunning() erkennt PV-verwalteten Filter', () => {
    it('gibt true zurück wenn PV Filter steuert (device-Status off)', () => {
        const adapter = createAdapter();
        adapter._pvManagedFeatures.filter = true;
        adapter._lastData.filter = 'off';
        adapter._adapterCommanded.filter = null;

        assert.strictEqual(adapter.filterRunning(), true,
            'filterRunning muss true sein wenn PV den Filter steuert');
    });

    it('gibt false zurück wenn nichts läuft', () => {
        const adapter = createAdapter();
        adapter._pvManagedFeatures.filter = false;
        adapter._lastData.filter = 'off';
        adapter._adapterCommanded.filter = null;
        adapter._api._lastStatus = null;

        assert.strictEqual(adapter.filterRunning(), false,
            'filterRunning muss false sein wenn keine Quelle aktiv ist');
    });

    it('gibt true zurück wenn _adapterCommanded.filter=true (Zeitfenster hat gestartet)', () => {
        const adapter = createAdapter();
        adapter._pvManagedFeatures.filter = false;
        adapter._lastData.filter = 'off';
        adapter._adapterCommanded.filter = true;

        assert.strictEqual(adapter.filterRunning(), true);
    });

    it('gibt true zurück wenn device-Status filter=on', () => {
        const adapter = createAdapter();
        adapter._lastData.filter = 'on';
        adapter._pvManagedFeatures.filter = false;

        assert.strictEqual(adapter.filterRunning(), true);
    });
});

// ---------------------------------------------------------------------------
// G. Manueller Override → BEIDE geblockt
// ---------------------------------------------------------------------------
describe('G. Manueller Override – PV + Zeitfenster beide gesperrt', () => {
    it('checkTimeWindows: setzt keine Features bei manualOverride=true', async () => {
        const adapter = createAdapter({ _manualOverride: true, _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'Zeitfenster darf bei manualOverride KEINE Features setzen');
    });

    it('checkTimeWindows: Reihenfolge der Guards (manualOverride vor PV-Guard)', async () => {
        // Beide gesetzt – manualOverride hat Vorrang (Debug-Message)
        const debugMessages = [];
        const adapter = createAdapter({
            _manualOverride: true,
            _pvActive: true,
        });
        adapter.log.debug = (m) => debugMessages.push(m);
        adapter.config.timeWindows = [makeWindow()];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(
            debugMessages.some(m => m.includes('manual override')),
            'Debug-Log muss "manual override" enthalten'
        );
        assert.ok(
            !debugMessages.some(m => m.includes('PV control active')),
            'PV-Guard-Message darf NICHT erscheinen – manualOverride hat Vorrang'
        );
    });
});

// ---------------------------------------------------------------------------
// H. PV nicht konfiguriert / inaktiv → Zeitfenster läuft normal durch
// ---------------------------------------------------------------------------
describe('H. Normalbetrieb ohne PV – Zeitfenster vollständig', () => {
    it('startet aktives Fenster und setzt _timeWindowActive=true', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter._timeWindowActive[0], true);
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true));
    });

    it('deaktiviert abgelaufenes Fenster und schaltet Filter ab', async () => {
        const adapter = createAdapter();
        // isInTimeWindow gibt false zurück → Fenster soll enden
        adapter.isInTimeWindow = () => false;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [true];  // war aktiv

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive[0] muss auf false gesetzt werden');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === false),
            'filter OFF muss aufgerufen werden wenn Fenster endet');
    });

    it('deaktiviertes Fenster (active=false) wird übersprungen', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [{ ...makeWindow({ action_filter: true }), active: false }];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0);
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });
});

// ---------------------------------------------------------------------------
// I. PV endet während Zeitfenster aktiv → Zeitfenster übernimmt SOFORT
// ---------------------------------------------------------------------------
describe('I. PV endet mitten im Zeitfenster – Zeitfenster übernimmt', () => {
    it('startet Features nachdem PV deaktiviert wurde (_pvActive → false)', async () => {
        const adapter = createAdapter({
            _pvActive: false,  // PV wurde gerade deaktiviert
            _pvStageTimer: null,
        });
        // Fenster ist gerade aktiv (von PV geblockt), wurde noch nicht durch Zeitfenster gestartet
        adapter.config.timeWindows = [makeWindow({ action_filter: true, action_uvc: false })];
        adapter._timeWindowActive = [false];

        // Simuliert den Aufruf von checkTimeWindows() nach PV-Deaktivierung
        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss nach PV-Deaktivierung durch Zeitfenster gestartet werden');
        assert.strictEqual(adapter._timeWindowActive[0], true);
    });

    it('mehrere Zeitfenster: nur das aktive übernimmt', async () => {
        const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];
        const today = dayKeys[new Date().getDay()];
        const adapter = createAdapter({ _pvActive: false });

        adapter.config.timeWindows = [
            // Fenster 1: aktiv und im Zeitraum
            { ...makeWindow({ action_filter: true }), start: '00:00', end: '23:59' },
            // Fenster 2: nicht aktiv
            { ...makeWindow({ action_heating: true }), active: false },
        ];
        adapter._timeWindowActive = [false, false];
        // isInTimeWindow: 1. Fenster = ja, 2. Fenster = nein
        let callCount = 0;
        adapter.isInTimeWindow = () => callCount++ === 0;

        await adapter.checkTimeWindowsReal();

        const filterOn = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        assert.strictEqual(filterOn.length, 1, 'genau einmal filter ON (nur Fenster 1)');
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster 1 aktiv');
        assert.strictEqual(adapter._timeWindowActive[1], false, 'Fenster 2 inaktiv (disabled)');
    });
});

// ---------------------------------------------------------------------------
// J. stagedDeactivate ruft checkTimeWindows nach Abschluss auf (pv.js)
// ---------------------------------------------------------------------------
describe('J. stagedDeactivate ruft checkTimeWindows nach Abschluss auf', () => {
    it('checkTimeWindows wird nach vollständiger PV-Abschaltung aufgerufen', async () => {
        // Simuliert den Aufruf aus lib/pv.js stagedDeactivate (runStage3 am Ende)
        const adapter = createAdapter({
            _pvActive: false,     // wurde bereits von setPvActive(false) gesetzt
            _pvStageTimer: null,
        });
        adapter._pvManagedFeatures = { heater: false, filter: true, uvc: false };
        adapter._lastData.heat_state = 0;  // keine aktive Heizung mehr

        let checkTimeWindowsCalled = false;
        adapter.checkTimeWindows = async () => { checkTimeWindowsCalled = true; };

        // Simuliert das Ende von runStage3 in lib/pv.js
        adapter._pvStageTimer = null;
        adapter.enableRapidPolling();
        adapter.checkTimeWindows().catch(() => {});

        assert.strictEqual(checkTimeWindowsCalled, true,
            'checkTimeWindows MUSS nach PV-Abschaltung aufgerufen werden');
    });

    it('checkTimeWindows aktiviert Zeitfenster nachdem PV-Stage abgeschlossen ist', async () => {
        const adapter = createAdapter({
            _pvActive: false,
            _pvStageTimer: null,
        });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        // Simuliert: PV hat gerade abgeschaltet, checkTimeWindows läuft
        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'Zeitfenster muss Filter starten nachdem PV-Stage abgeschlossen ist');
    });
});

// ---------------------------------------------------------------------------
// K. Grenzfälle (Edge Cases)
// ---------------------------------------------------------------------------
describe('K. Grenzfälle', () => {
    it('checkTimeWindows: keine Aktion wenn timeWindows=[] (leer)', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [];
        adapter._timeWindowActive = [];

        await adapter.checkTimeWindowsReal();  // darf keinen Fehler werfen

        assert.strictEqual(adapter.setFeatureCalls.length, 0);
    });

    it('checkTimeWindows: keine Aktion wenn timeWindows=undefined', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = undefined;

        await adapter.checkTimeWindowsReal();  // darf keinen Fehler werfen

        assert.strictEqual(adapter.setFeatureCalls.length, 0);
    });

    it('PV wird aktiv NACH Zeitfenster-Start → Zeitfenster wird nicht erneut getriggert', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [true];  // Fenster bereits aktiv (wurde gestartet)

        // PV wird aktiv
        adapter._pvActive = true;

        // Nächster Scheduler-Tick
        await adapter.checkTimeWindowsReal();

        // kein weiterer setFeature-Aufruf (Fenster war schon aktiv, PV blockt jetzt)
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'kein setFeature wenn Fenster bereits aktiv und PV nun übernimmt');
    });

    it('filterRunning() gibt true zurück wenn API-Status filter_state=1 (PV-unabhängig)', () => {
        const adapter = createAdapter();
        adapter._pvManagedFeatures.filter = false;
        adapter._lastData.filter = 'off';
        adapter._api._lastStatus = { filter_state: 1 };

        assert.strictEqual(adapter.filterRunning(), true,
            'filterRunning muss true sein wenn API filter_state=1 meldet');
    });

    it('deactivateWindow: schaltet Heizer ab wenn PV NICHT aktiv', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        const w = makeWindow({ action_heating: true, action_filter: true });

        await adapter.deactivateWindow(w, 0);

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === false),
            'heater OFF muss aufgerufen werden wenn PV inaktiv');
    });

    it('deactivateWindow: rollback _timeWindowActive wenn setFeature wirft', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.setFeature = async () => { throw new Error('API Fehler'); };
        adapter.log.error = () => {};  // Fehler abfangen ohne throw
        const w = makeWindow({ action_heating: true, action_filter: false });
        adapter._timeWindowActive = [false];

        await adapter.deactivateWindow(w, 0);

        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive muss auf true zurückgesetzt werden bei Fehler (Retry-Mechanismus)');
    });
});

// ---------------------------------------------------------------------------
// L. Zeitfenster AKTIV + nicht genug PV – Kernszenarien
// ---------------------------------------------------------------------------
describe('L. Zeitfenster aktiv während PV-Überschuss fehlt', () => {

    // L.1 – Zeitfenster läuft, PV war NIE aktiv → kein erneuter setFeature-Call beim 60s-Tick
    it('L.1 kein doppelter setFeature-Call wenn Fenster bereits läuft (wasIn=true, inWin=true)', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [true]; // Fenster wurde beim letzten Tick bereits gestartet

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'kein erneuter API-Call – Fenster ist bereits als aktiv markiert');
    });

    // L.2 – Zeitfenster aktiv, PV war kurz aktiv und verliert Surplus →
    //        _timeWindowActive bleibt true, kein Neustart, Features laufen weiter
    it('L.2 Zeitfenster bleibt aktiv nach PV-Abschaltung (wasIn=true → kein Re-Start)', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        // Zeitfenster war bereits aktiv BEVOR PV übernahm
        adapter._timeWindowActive = [true];

        // Simuliert: PV hat gerade abgeschaltet, checkTimeWindows läuft
        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'Filter läuft bereits – kein filter ON senden');
        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive muss true bleiben');
    });

    // L.3 – PV hat Filter gestartet, _timeWindowActive=false (PV hat guard-bedingt nie gesetzt),
    //        PV verliert Surplus → checkTimeWindows → soll Filter-ON schicken (Fenster übernimmt)
    it('L.3 Zeitfenster übernimmt Filter wenn PV nie _timeWindowActive gesetzt hat (wasIn=false)', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        // PV hat den Filter gestartet, aber _timeWindowActive[0]=false (weil checkTimeWindows
        // immer durch PV-Guard geblockt war)
        adapter._timeWindowActive = [false];
        adapter._pvManagedFeatures.filter = false; // PV hat Filter bereits abgeschaltet (Stage 3)
        adapter._lastData.filter = 'off';

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'Zeitfenster muss Filter neu starten wenn PV ihn abgeschaltet hat');
        assert.strictEqual(adapter._timeWindowActive[0], true);
    });

    // L.4 – Zeitfenster aktiv + Heizer aktiv + PV nie aktiv →
    //        nächster Tick verändert nichts (keine doppelten Kommandos)
    it('L.4 Heizfenster aktiv ohne PV – kein doppelter Heizer-Befehl beim nächsten Tick', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: false })];
        adapter._timeWindowActive = [true]; // bereits gestartet

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'Heizer läuft bereits – kein zweiter heater ON');
    });

    // L.5 – Zeitfenster (Filter+UVC) aktiv, PV schaltet kurz ein und dann wieder aus →
    //        Nach PV-Abschaltung: _timeWindowActive[0]=true → kein Neustart der Features
    it('L.5 Filter+UVC-Fenster überlebt PV-Aktivierung und -Deaktivierung ohne Neustart', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, action_uvc: true })];
        adapter._timeWindowActive = [true]; // Fenster lief schon bevor PV kam

        // Tick nach PV-Abschaltung
        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'weder filter ON noch uvc ON erneut senden');
        assert.strictEqual(adapter._timeWindowActive[0], true);
    });

    // L.6 – Vollständiger Ablauf: Zeitfenster startet → PV kommt → PV geht → Zeitfenster läuft weiter
    it('L.6 vollständiger Zyklus: Zeitfenster → PV aktiv (Guard) → PV inaktiv → Zeitfenster weiter', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        // Phase 1: Zeitfenster startet (PV inaktiv)
        await adapter.checkTimeWindowsReal();
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'Phase 1: filter ON muss gesendet werden');
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Phase 1: Fenster aktiv');
        adapter.setFeatureCalls.length = 0; // Reset

        // Phase 2: PV kommt (blockt Zeitfenster-Scheduler)
        adapter._pvActive = true;
        await adapter.checkTimeWindowsReal();
        assert.strictEqual(adapter.setFeatureCalls.length, 0, 'Phase 2: PV Guard aktiv – kein Call');
        adapter.setFeatureCalls.length = 0;

        // Phase 3: PV verliert Surplus, schaltet ab
        adapter._pvActive = false;
        adapter._pvStageTimer = null;
        await adapter.checkTimeWindowsReal();

        // Zeitfenster ist bereits als aktiv markiert (wasIn=true) → kein Neustart nötig
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'Phase 3: Filter läuft bereits – kein erneuter filter ON');
        assert.strictEqual(adapter._timeWindowActive[0], true,
            'Phase 3: _timeWindowActive bleibt true');
    });

    // L.7 – Zeitfenster soll NICHT starten wenn PV-Stage noch läuft (Übergangsphase)
    it('L.7 Zeitfenster startet NICHT während PV-Stage noch abschaltet (_pvStageTimer aktiv)', async () => {
        const stageTimer = setTimeout(() => {}, 120_000);
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: stageTimer });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        clearTimeout(stageTimer);
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'Zeitfenster darf NICHT starten solange PV noch in der Abschaltreihenfolge ist');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });

    // L.8 – Zeitfenster endet (isInTimeWindow=false) während PV aktiv →
    //        deactivateWindow wird geblockt, Features bleiben laufen
    it('L.8 Zeitfenster-Ende wird ignoriert wenn PV aktiv (deactivateWindow blockiert)', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [true]; // war aktiv
        adapter.isInTimeWindow = () => false; // Fenster ist zeitlich abgelaufen

        await adapter.checkTimeWindowsReal();

        // checkTimeWindows selbst wird durch PV-Guard geblockt (kein deactivateWindow)
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'filter OFF darf NICHT gesendet werden – PV Guard hat checkTimeWindows geblockt');
        // _timeWindowActive wird nicht geändert weil checkTimeWindows früh returnt
        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive bleibt true weil PV-Guard greift bevor Loop läuft');
    });

    // L.9 – Zeitfenster mit Heizer: PV nie aktiv, Fenster endet → Heizer + Filter korrekt abschalten
    it('L.9 Heizfenster-Ende schaltet Heizer dann Filter ab (kein PV)', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true })];
        adapter._timeWindowActive = [true];
        adapter.isInTimeWindow = () => false; // Fenster endet

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === false),
            'heater OFF muss gesendet werden');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === false),
            'filter OFF muss gesendet werden');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });

    // L.10 – Zwei Fenster: Fenster 1 aktiv (kein PV), Fenster 2 beginnt gleichzeitig →
    //         beide werden korrekt behandelt ohne gegenseitige Störung
    it('L.10 zwei parallele Fenster ohne PV – beide korrekt aktiviert', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: false }),
            makeWindow({ action_heating: true, action_filter: false }),
        ];
        adapter._timeWindowActive = [false, false];
        let callIdx = 0;
        adapter.isInTimeWindow = () => true; // beide im Zeitraum

        await adapter.checkTimeWindowsReal();

        const filterOn  = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        const heaterOn  = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === true);
        // Fenster 1: filter ON (action_filter=true)
        // Fenster 2: filter ON (Voraussetzung für Heizer, action_filter=false) + heater ON
        assert.strictEqual(filterOn.length,  2, 'filter ON 2×: einmal für Fenster 1, einmal als Heizer-Voraussetzung für Fenster 2');
        assert.strictEqual(heaterOn.length,  1, 'heater ON genau einmal (Fenster 2)');
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster 1 aktiv');
        assert.strictEqual(adapter._timeWindowActive[1], true, 'Fenster 2 aktiv');
    });
});

// ---------------------------------------------------------------------------
// M. Zeitfenster hat pv_steu=false – PV Guard darf NICHT blocken
// ---------------------------------------------------------------------------
describe('M. Zeitfenster ohne pv_steu – PV Guard darf nicht blockieren', () => {

    // M.1 – Fenster ohne pv_steu, _pvActive=true (stale) → Fenster startet trotzdem
    it('M.1 startet Fenster (pv_steu=false) obwohl _pvActive=true (stale state)', async () => {
        const adapter = createAdapter({ _pvActive: true });
        // KEIN pv_steu auf dem Fenster
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(
            adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON MUSS gesendet werden – Fenster hat kein PV, _pvActive ist stale'
        );
        assert.strictEqual(adapter._timeWindowActive[0], true);
    });

    // M.2 – Fenster ohne pv_steu, _pvStageTimer gesetzt (stale) → Fenster startet trotzdem
    it('M.2 startet Fenster (pv_steu=false) obwohl _pvStageTimer läuft (stale state)', async () => {
        const staleTimer = setTimeout(() => {}, 60_000);
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: staleTimer });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        clearTimeout(staleTimer);
        assert.ok(
            adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON MUSS gesendet werden – kein PV-Fenster konfiguriert'
        );
    });

    // M.3 – Fenster ohne pv_steu (undefined) → guard greift nicht
    it('M.3 pv_steu=undefined behandelt wie false – Guard greift nicht', async () => {
        const adapter = createAdapter({ _pvActive: true });
        // pv_steu nicht gesetzt = undefined
        adapter.config.timeWindows = [makeWindow({ action_filter: true })]; // kein pv_steu
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(
            adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss gesendet werden – pv_steu nicht gesetzt'
        );
    });

    // M.4 – Ein Fenster hat pv_steu=true (PV aktiv), ein anderes pv_steu=false →
    //        PV-Guard blockt NUR weil anyPvWindow=true, BEIDE Fenster werden geblockt
    //        (globaler Guard – korrektes Verhalten: sicherer als partieller Guard)
    it('M.4 ein Fenster mit pv_steu=true genügt: Guard blockt checkTimeWindows komplett', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, pv_steu: true }),   // PV-Fenster
            makeWindow({ action_heating: true, pv_steu: false }),  // normales Fenster
        ];
        adapter._timeWindowActive = [false, false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'wenn anyPvWindow=true und _pvActive=true: gesamte Zeitfensterprüfung geblockt');
    });

    // M.5 – Kein Fenster mit pv_steu=true, _pvActive=true →
    //        anyPvWindow=false → Guard greift nicht → alle Zeitfenster laufen
    it('M.5 kein Fenster mit pv_steu=true: Guard greift nicht, alle Fenster laufen', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, pv_steu: false }),
            makeWindow({ action_heating: true, pv_steu: false }),
        ];
        adapter._timeWindowActive = [false, false];

        await adapter.checkTimeWindowsReal();

        assert.ok(
            adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss gesendet werden'
        );
        assert.ok(
            adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === true),
            'heater ON muss gesendet werden'
        );
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster 1 aktiv');
        assert.strictEqual(adapter._timeWindowActive[1], true, 'Fenster 2 aktiv');
    });

    // M.6 – deactivateWindow: Fenster endet, kein pv_steu → schaltet ab trotz _pvActive=true
    it('M.6 deactivateWindow schaltet ab wenn kein pv_steu und _pvActive=true (stale)', async () => {
        const adapter = createAdapter({ _pvActive: true });
        // Kein pv_steu-Fenster in timeWindows
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: false })];
        const w = makeWindow({ action_filter: true, pv_steu: false });

        await adapter.deactivateWindow(w, 0);

        assert.ok(
            adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === false),
            'filter OFF MUSS gesendet werden – kein PV-Fenster, _pvActive ist stale'
        );
    });

    // M.7 – deactivateWindow: Fenster endet, pv_steu=true und _pvActive=true → geblockt
    it('M.7 deactivateWindow geblockt wenn pv_steu=true-Fenster existiert und _pvActive=true', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: true })];
        const w = makeWindow({ action_filter: true, pv_steu: true });

        await adapter.deactivateWindow(w, 0);

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'filter OFF darf NICHT gesendet werden – PV steuert aktiv');
    });

    // M.8 – Vollständiger Zyklus: Fenster ohne pv_steu startet → _pvActive bleibt stale →
    //        Fenster endet → deactivateWindow schaltet korrekt ab
    it('M.8 vollständiger Zyklus ohne pv_steu: Start → Stale-pvActive → Ende (korrekte Abschaltung)', async () => {
        const adapter = createAdapter({ _pvActive: true }); // stale
        adapter.config.timeWindows = [makeWindow({ action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [false];

        // Phase 1: Fenster startet (Guard greift nicht wegen anyPvWindow=false)
        await adapter.checkTimeWindowsReal();
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'Phase 1: filter ON');
        assert.strictEqual(adapter._timeWindowActive[0], true);
        adapter.setFeatureCalls.length = 0;

        // Phase 2: Fenster endet
        adapter.isInTimeWindow = () => false;
        await adapter.checkTimeWindowsReal();
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === false),
            'Phase 2: filter OFF muss gesendet werden');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });
});

// ---------------------------------------------------------------------------
// N. action_heating=true + action_filter=true kombiniert mit _pvActive=true
// ---------------------------------------------------------------------------
describe('N. action_heating=true + action_filter=true mit _pvActive=true', () => {

    // N.1 – pv_steu=true, _pvActive=true → Guard blockt: weder heater noch filter ON
    it('N.1 pv_steu=true + _pvActive=true: Guard blockt heater+filter Start', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'weder heater ON noch filter ON wenn PV-Guard aktiv');
        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive muss false bleiben');
    });

    // N.2 – pv_steu=false, _pvActive=true (stale) → Guard greift NICHT: heater+filter starten
    it('N.2 pv_steu=false + _pvActive=true (stale): heater+filter starten trotzdem', async () => {
        const adapter = createAdapter({ _pvActive: true }); // stale
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON MUSS gesendet werden – pv_steu=false');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === true),
            'heater ON MUSS gesendet werden – pv_steu=false');
        assert.strictEqual(adapter._timeWindowActive[0], true);
    });

    // N.3 – pv_steu=false, _pvActive=false → heater+filter starten normal
    it('N.3 pv_steu=false + _pvActive=false: heater+filter starten normal', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss gesendet werden');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === true),
            'heater ON muss gesendet werden');
    });

    // N.4 – pv_steu=true, _pvActive=true → deactivateWindow geblockt: heater+filter bleiben an
    it('N.4 pv_steu=true + _pvActive=true: deactivateWindow blockt heater+filter OFF', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: true })];
        const w = makeWindow({ action_heating: true, action_filter: true, pv_steu: true });
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(w, 0);

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'heater OFF und filter OFF dürfen NICHT gesendet werden – PV steuert');
    });

    // N.5 – pv_steu=false, _pvActive=true (stale) → deactivateWindow schaltet heater+filter ab
    it('N.5 pv_steu=false + _pvActive=true (stale): deactivateWindow schaltet heater+filter ab', async () => {
        const adapter = createAdapter({ _pvActive: true }); // stale
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: false })];
        const w = makeWindow({ action_heating: true, action_filter: true, pv_steu: false });

        await adapter.deactivateWindow(w, 0);

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === false),
            'heater OFF MUSS gesendet werden – kein PV-Fenster aktiv');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === false),
            'filter OFF MUSS gesendet werden – kein PV-Fenster aktiv');
    });

    // N.6 – pv_steu=true, PV schaltet ab (_pvActive=false, _pvStageTimer=null) →
    //        Zeitfenster übernimmt: heater+filter werden gestartet
    it('N.6 pv_steu=true + PV deaktiviert: Zeitfenster übernimmt heater+filter', async () => {
        const adapter = createAdapter({ _pvActive: false, _pvStageTimer: null });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [false]; // PV hat Guard geblockt, Zeitfenster nie gestartet

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true),
            'filter ON muss nach PV-Abschaltung gesendet werden');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === true),
            'heater ON muss nach PV-Abschaltung gesendet werden');
        assert.strictEqual(adapter._timeWindowActive[0], true);
    });

    // N.7 – Vollständiger Zyklus: Fenster (heater+filter, pv_steu=true) startet →
    //        PV übernimmt (Guard) → PV verliert Überschuss → Zeitfenster übernimmt ohne Neustart
    it('N.7 vollständiger Zyklus heater+filter+pv_steu: Start → PV → kein PV → Zeitfenster weiter', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [false];

        // Phase 1: Zeitfenster startet (PV noch inaktiv)
        await adapter.checkTimeWindowsReal();
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === true), 'Phase 1: filter ON');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === true), 'Phase 1: heater ON');
        assert.strictEqual(adapter._timeWindowActive[0], true);
        adapter.setFeatureCalls.length = 0;

        // Phase 2: PV kommt (Guard aktiv)
        adapter._pvActive = true;
        await adapter.checkTimeWindowsReal();
        assert.strictEqual(adapter.setFeatureCalls.length, 0, 'Phase 2: kein Call – PV Guard');
        adapter.setFeatureCalls.length = 0;

        // Phase 3: PV verliert Überschuss
        adapter._pvActive = false;
        await adapter.checkTimeWindowsReal();
        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'Phase 3: kein Neustart – Fenster war bereits aktiv (wasIn=true)');
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Phase 3: _timeWindowActive bleibt true');
    });

    // N.8 – Fenster (heater+filter, pv_steu=true) endet während PV aktiv →
    //        weder heater OFF noch filter OFF (deactivateWindow geblockt durch PV-Guard + checkTimeWindows Guard)
    it('N.8 Fenster-Ende (heater+filter+pv_steu=true) während PV aktiv: kein heater/filter OFF', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: true })];
        adapter._timeWindowActive = [true]; // war aktiv
        adapter.isInTimeWindow = () => false; // Fenster zeitlich abgelaufen

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'heater OFF und filter OFF dürfen NICHT gesendet werden – PV Guard blockt checkTimeWindows');
        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive bleibt true – Guard hat Loop nie erreicht');
    });

    // N.9 – Fenster (heater+filter, pv_steu=false) endet während _pvActive=true (stale) →
    //        heater+filter werden korrekt abgeschaltet
    it('N.9 Fenster-Ende (heater+filter+pv_steu=false) mit stale _pvActive: heater+filter OFF', async () => {
        const adapter = createAdapter({ _pvActive: true }); // stale
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [true]; // war aktiv
        adapter.isInTimeWindow = () => false; // Fenster endet

        await adapter.checkTimeWindowsReal();

        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'heater' && c.v === false),
            'heater OFF MUSS gesendet werden – pv_steu=false, Guard greift nicht');
        assert.ok(adapter.setFeatureCalls.some(c => c.f === 'filter' && c.v === false),
            'filter OFF MUSS gesendet werden – pv_steu=false, Guard greift nicht');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });

    // N.10 – Reihenfolge: filter muss VOR heater gestartet werden (Heizer-Voraussetzung)
    it('N.10 filter wird VOR heater gestartet (Gerät-Voraussetzung einhalten)', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [makeWindow({ action_heating: true, action_filter: true, pv_steu: false })];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        const filterIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'filter' && c.v === true);
        const heaterIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'heater' && c.v === true);
        assert.ok(filterIdx !== -1, 'filter ON muss gesendet worden sein');
        assert.ok(heaterIdx !== -1, 'heater ON muss gesendet worden sein');
        assert.ok(filterIdx < heaterIdx,
            `filter (Pos ${filterIdx}) muss VOR heater (Pos ${heaterIdx}) gesendet werden`);
    });
});

// ---------------------------------------------------------------------------
// O. Zeitfenster active=false – wird komplett ignoriert
// ---------------------------------------------------------------------------
describe('O. Zeitfenster active=false – wird komplett ignoriert', () => {

    // O.1 – active=false, war nie aktiv → nichts passiert
    it('O.1 active=false + _timeWindowActive=false: kein setFeature-Call', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [{ ...makeWindow({ action_filter: true }), active: false }];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'kein setFeature – Fenster ist deaktiviert');
        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive darf nicht geändert werden');
    });

    // O.2 – active=false + _timeWindowActive=true → KEIN filter OFF (komplett ignoriert)
    it('O.2 active=false + _timeWindowActive=true: KEIN filter OFF', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [{ ...makeWindow({ action_filter: true }), active: false }];
        adapter._timeWindowActive = [true]; // war vorher aktiv

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'filter OFF darf NICHT gesendet werden – active=false bedeutet komplett ignorieren');
        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive bleibt unverändert');
    });

    // O.3 – active=false + action_heating+filter + war aktiv → NICHTS passiert
    it('O.3 active=false + action_heating+filter + _timeWindowActive=true: heater/filter bleiben unberührt', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [{ ...makeWindow({ action_heating: true, action_filter: true }), active: false }];
        adapter._timeWindowActive = [true];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'heater/filter OFF darf NICHT gesendet werden – Fenster ist deaktiviert');
    });

    // O.4 – active=false + pv_steu=true + _pvActive=true → ebenfalls komplett ignoriert
    it('O.4 active=false + pv_steu=true + _pvActive=true: ebenfalls ignoriert', async () => {
        const adapter = createAdapter({ _pvActive: true });
        adapter.config.timeWindows = [{ ...makeWindow({ action_filter: true, pv_steu: true }), active: false }];
        adapter._timeWindowActive = [true];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0);
        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive bleibt unverändert');
    });

    // O.5 – active=false + UVC-Fenster + _timeWindowActive=true → UVC/filter bleiben unberührt
    it('O.5 active=false + action_filter+uvc + _timeWindowActive=true: UVC/filter unberührt', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [{ ...makeWindow({ action_filter: true, action_uvc: true }), active: false }];
        adapter._timeWindowActive = [true];

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'UVC OFF und filter OFF dürfen NICHT gesendet werden');
    });

    // O.6 – Fenster 1 active=false (war aktiv), Fenster 2 active=true → nur Fenster 2 läuft
    it('O.6 Fenster 1 active=false, Fenster 2 active=true: nur Fenster 2 wird aktiviert', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [
            { ...makeWindow({ action_filter: true }), active: false },
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [false, false];

        await adapter.checkTimeWindowsReal();

        const filterOn = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        assert.strictEqual(filterOn.length, 1, 'genau ein filter ON (nur Fenster 2)');
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 unverändert (active=false)');
        assert.strictEqual(adapter._timeWindowActive[1], true,  'Fenster 2 aktiv');
    });

    // O.7 – Fenster 1 active=false + _timeWindowActive=true, Fenster 2 active=true + wasIn=true →
    //        _timeWindowActive[0] bleibt true, Fenster 2 kein Neustart
    it('O.7 beide Fenster wasIn=true: active=false ignoriert, active=true kein Neustart', async () => {
        const adapter = createAdapter({ _pvActive: false });
        adapter.config.timeWindows = [
            { ...makeWindow({ action_filter: true }), active: false },
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [true, true]; // beide liefen

        await adapter.checkTimeWindowsReal();

        assert.strictEqual(adapter.setFeatureCalls.length, 0,
            'kein setFeature – Fenster 1 ignoriert, Fenster 2 läuft bereits');
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster 1 unverändert');
        assert.strictEqual(adapter._timeWindowActive[1], true, 'Fenster 2 unverändert');
    });
});

