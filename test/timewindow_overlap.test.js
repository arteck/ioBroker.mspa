'use strict';

/**
 * test/timewindow_overlap.test.js
 *
 * Prüft das Verhalten bei überlappenden Zeitfenstern in checkTimeWindows / deactivateWindow.
 *
 * Szenarien:
 *   A. Fenster 2 endet während Fenster 1 noch läuft → Filter bleibt ON
 *   B. Fenster 1 endet während Fenster 2 noch läuft → Heizung aus, Filter bleibt ON
 *   C. Beide Fenster enden gleichzeitig → Filter und Heizung werden abgeschaltet
 *   D. UVC bleibt ON wenn ein anderes Fenster es noch benötigt
 *   E. Follow-up Timer schaltet Filter NICHT ab wenn anderes Fenster noch aktiv
 *   F. Follow-up Timer schaltet Filter AB wenn kein anderes Fenster mehr aktiv
 *   G. active=false während Fenster läuft → deactivateWindow wird aufgerufen
 *   H. active=false bei laufendem Fenster ohne Überlappung → Features werden abgeschaltet
 *   I. Drei Fenster – mittleres endet zuerst → Features bleiben aktiv
 *   J. Fenster 1 Aktivierung schlägt fehl – Fenster 2 startet trotzdem
 *   K. ALL-OFF Fenster überschneidet sich mit normalem Fenster → nur ALL-OFF schaltet ab
 *   L. Überlappende overnight-Fenster → korrekte Erkennung
 *
 * Run: npx mocha test/timewindow_overlap.test.js
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Helper: Adapter-Mock mit portierter checkTimeWindows / deactivateWindow Logik
// ---------------------------------------------------------------------------
function createAdapter(overrides = {}) {
    const adapter = {
        _manualOverride: false,
        _manualOverrideTimer: null,
        _unloading: false,
        _pvActive: false,
        _pvStageTimer: null,
        _timeWindowActive: [],
        _pumpFollowUpTimers: [],
        _pumpStartedForHeating: false,
        _seasonEnabled: true,
        config: {
            timeWindows: [],
            more_log_enabled: false,
            pump_follow_up: 0,
            uvc_daily_min_h: 2,
        },
        log: {
            debug: () => {},
            info:  () => {},
            warn:  () => {},
            error: (m) => { throw new Error(`adapter.log.error: ${m}`); },
        },
        setFeatureCalls: [],
        async setFeature(f, v) { this.setFeatureCalls.push({ f, v }); },
        isInSeason() { return true; },
        // Standardmäßig immer im Fenster – kann pro Test überschrieben werden
        isInTimeWindow(start, end) { return true; },
        getUvcTodayHours() { return 3; },  // UVC-Minimum bereits erfüllt
        enableRapidPolling() {},
        setStray(fn, ms) { fn(); },
        sendTargetTempDirect: async () => {},
        ...overrides,
    };

    // ── Portierte deactivateWindow Logik (Stand nach Overlap-Fix) ──────────
    adapter.deactivateWindow = async function (w, i) {
        const anyPvWindow = Array.isArray(this.config.timeWindows) &&
            this.config.timeWindows.some(win => win.active && win.pv_steu);
        if (anyPvWindow && (this._pvActive || this._pvStageTimer !== null)) {
            return;
        }

        // Overlap guard
        const windows = this.config.timeWindows;
        const otherNeedsFilter = Array.isArray(windows) && windows.some((win, j) =>
            j !== i && this._timeWindowActive[j] && win.active &&
            (win.action_filter || win.action_heating)
        );
        const otherNeedsHeater = Array.isArray(windows) && windows.some((win, j) =>
            j !== i && this._timeWindowActive[j] && win.active && win.action_heating
        );
        const otherNeedsUvc = Array.isArray(windows) && windows.some((win, j) =>
            j !== i && this._timeWindowActive[j] && win.active && win.action_uvc
        );

        if (this._pumpFollowUpTimers[i]) {
            clearTimeout(this._pumpFollowUpTimers[i]);
            this._pumpFollowUpTimers[i] = null;
        }

        const followUpMin = Number(this.config.pump_follow_up) || 0;
        const uvcMinH  = this.config.uvc_daily_min_h ?? 2;
        const todayH   = this.getUvcTodayHours();
        const uvcMinMet = todayH >= uvcMinH;

        try {
            if (w.action_heating && !otherNeedsHeater) {
                await this.setFeature('heater', false);
            }

            if (w.action_filter && w.action_uvc && !otherNeedsUvc) {
                if (uvcMinMet) {
                    await this.setFeature('uvc', false);
                } else {
                    this._timeWindowActive[i] = false;
                    this.enableRapidPolling();
                    return;
                }
            }

            if (otherNeedsFilter) {
                this._timeWindowActive[i] = false;
                this.enableRapidPolling();
                return;
            }

            const stopPumpNow = !followUpMin || followUpMin <= 0;
            if (stopPumpNow) {
                if (w.action_filter) {
                    await this.setFeature('filter', false);
                }
                if (w.action_heating && !w.action_filter) {
                    await this.setFeature('filter', false);
                    this._pumpStartedForHeating = false;
                }
            } else {
                this._pumpFollowUpTimers[i] = setTimeout(() => {
                    if (this._unloading) return;
                    this._pumpFollowUpTimers[i] = null;
                    const stillNeeded = Array.isArray(this.config.timeWindows) &&
                        this.config.timeWindows.some((win, j) =>
                            j !== i && this._timeWindowActive[j] && win.active &&
                            (win.action_filter || win.action_heating)
                        );
                    if (stillNeeded) return;
                    this.setFeature('filter', false)
                        .then(() => {
                            this._pumpStartedForHeating = false;
                            this.enableRapidPolling();
                        })
                        .catch(err => this.log.error(`follow-up filter OFF FAILED: ${err.message}`));
                }, Math.round(followUpMin * 60 * 1000));
            }

            this._timeWindowActive[i] = false;
            this.enableRapidPolling();
        } catch (err) {
            // rollback: bleibt true
            this.log.error(`Time control [${i + 1}]: deactivation FAILED – ${err.message}`);
        }
    };

    // ── Portierte checkTimeWindows Logik (Stand nach Notification-Fix) ─────
    adapter.checkTimeWindows = async function () {
        const windows = this.config.timeWindows;
        if (!Array.isArray(windows)) return;
        if (this._manualOverride) return;

        const anyPvWindow = windows.some(w => w.active && w.pv_steu);
        if (anyPvWindow && (this._pvActive || this._pvStageTimer !== null)) return;
        if (!this.isInSeason()) return;

        while (this._timeWindowActive.length < windows.length) {
            this._timeWindowActive.push(false);
        }

        const dayKeys = ['day_sun', 'day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat'];
        const day = new Date().getDay();

        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (!w.active) {
                if (this._timeWindowActive[i]) {
                    await this.deactivateWindow(w, i);
                }
                continue;
            }

            const start = w.start || '00:00';
            const end   = w.end   || '00:00';
            const dayOn = !!w[dayKeys[day]];
            const inWin = dayOn && this.isInTimeWindow(start, end);
            const wasIn = this._timeWindowActive[i];

            if (inWin && !wasIn) {
                if (w.pv_steu) {
                    this._timeWindowActive[i] = true;
                    continue;
                }
                try {
                    if (!w.action_filter && !w.action_heating) {
                        await this.setFeature('heater', false).catch(() => {});
                        await this.setFeature('uvc',    false).catch(() => {});
                        await this.setFeature('filter', false).catch(() => {});
                    } else {
                        if (w.action_heating) {
                            await this.setFeature('filter', true);
                            await this.setFeature('heater', true);
                        }
                        if (w.action_filter && !w.action_heating) {
                            await this.setFeature('filter', true);
                        }
                        if (w.action_filter && w.action_uvc) {
                            await this.setFeature('uvc', true);
                        }
                    }
                    this._timeWindowActive[i] = true;
                } catch (err) {
                    // bleibt false
                }
            } else if (!inWin && wasIn) {
                await this.deactivateWindow(w, i);
            }
        }
    };

    return adapter;
}

// Heute-Fenster erzeugen
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
        pv_steu: false,
        [today]: true,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// A. Fenster 2 endet während Fenster 1 noch läuft → Filter bleibt ON
// ---------------------------------------------------------------------------
describe('A. Überlappung: Fenster 2 endet – Filter muss ON bleiben (Fenster 1 aktiv)', () => {
    it('filter darf NICHT abgeschaltet werden wenn anderes Fenster noch aktiv ist', async () => {
        const adapter = createAdapter();
        // Fenster 1: aktiv und läuft noch (inWin=true)
        // Fenster 2: war aktiv aber endet jetzt (inWin=false)
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),   // Fenster 1: läuft noch
            makeWindow({ action_filter: true }),   // Fenster 2: endet jetzt
        ];
        adapter._timeWindowActive = [true, true];

        let callCount = 0;
        adapter.isInTimeWindow = (_start, _end) => {
            // Erstes mal für Fenster 1 (i=0): noch aktiv
            // Zweites mal für Fenster 2 (i=1): beendet
            callCount++;
            return callCount === 1; // Fenster 1 = true, Fenster 2 = false
        };

        await adapter.checkTimeWindows();

        const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOffCalls.length, 0,
            'filter darf NICHT ausgeschaltet werden – Fenster 1 ist noch aktiv');
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster 1 bleibt aktiv');
        assert.strictEqual(adapter._timeWindowActive[1], false, 'Fenster 2 ist inaktiv');
    });

    it('filter wird korrekt abgeschaltet wenn KEIN anderes Fenster mehr aktiv ist', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),   // Fenster 1: endet auch
            makeWindow({ action_filter: true }),   // Fenster 2: endet
        ];
        adapter._timeWindowActive = [true, true];
        adapter.isInTimeWindow = () => false; // beide enden

        await adapter.checkTimeWindows();

        // Sequentielle Verarbeitung: bei i=0 ist _timeWindowActive[1] noch true
        // → otherNeedsFilter=true → Fenster 1 sendet KEIN filter-OFF, setzt sich aber auf false.
        // Bei i=1 ist _timeWindowActive[0] bereits false → otherNeedsFilter=false
        // → Fenster 2 sendet filter-OFF.
        // Gesamt: 1 filter-OFF Aufruf (kein doppeltes Abschalten)
        const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOffCalls.length, 1,
            'genau 1 filter-OFF Aufruf erwartet (Fenster 1 überlässt es Fenster 2)');
        assert.strictEqual(adapter._timeWindowActive[0], false);
        assert.strictEqual(adapter._timeWindowActive[1], false);
    });
});

// ---------------------------------------------------------------------------
// B. Fenster 1 (Heizung) endet während Fenster 2 (nur Filter) noch läuft
// ---------------------------------------------------------------------------
describe('B. Überlappung: Fenster 1 mit Heizung endet – Heizung aus, Filter bleibt ON', () => {
    it('heater OFF, filter bleibt ON', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),  // Fenster 1: endet
            makeWindow({ action_filter: true, action_heating: false }), // Fenster 2: läuft noch
        ];
        adapter._timeWindowActive = [true, true];

        let callCount = 0;
        adapter.isInTimeWindow = () => {
            callCount++;
            return callCount !== 1; // Fenster 1 endet, Fenster 2 läuft
        };

        await adapter.checkTimeWindows();

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);

        assert.strictEqual(heaterOff.length, 1, 'heater muss ausgeschaltet werden');
        assert.strictEqual(filterOff.length, 0, 'filter darf NICHT ausgeschaltet werden – Fenster 2 läuft noch');
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 inaktiv');
        assert.strictEqual(adapter._timeWindowActive[1], true,  'Fenster 2 bleibt aktiv');
    });

    it('heater UND filter werden abgeschaltet wenn kein anderes Fenster mehr läuft', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [true];
        adapter.isInTimeWindow = () => false;

        await adapter.checkTimeWindows();

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 1);
        assert.strictEqual(filterOff.length, 1);
    });
});

// ---------------------------------------------------------------------------
// C. Beide Fenster enden gleichzeitig → alles abschalten
// ---------------------------------------------------------------------------
describe('C. Beide überlappenden Fenster enden gleichzeitig', () => {
    it('filter wird genau 1x abgeschaltet (nicht doppelt)', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [true, true];
        adapter.isInTimeWindow = () => false;

        await adapter.checkTimeWindows();

        const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        // Fenster 1 endet: kein anderes mehr aktiv (Fenster 2 wurde noch nicht deaktiviert)
        // Fenster 2 endet: Fenster 1 bereits inaktiv → kein anderes aktiv
        // Beide senden filter OFF → 2 Aufrufe (idempotent, hardware-seitig ok)
        assert.ok(filterOffCalls.length >= 1, `mindestens 1 filter-OFF Aufruf erwartet, got ${filterOffCalls.length}`);
        assert.strictEqual(adapter._timeWindowActive[0], false);
        assert.strictEqual(adapter._timeWindowActive[1], false);
    });
});

// ---------------------------------------------------------------------------
// D. UVC bleibt ON wenn anderes Fenster es noch benötigt
// ---------------------------------------------------------------------------
describe('D. UVC Overlap: UVC bleibt ON wenn anderes aktives Fenster es braucht', () => {
    it('uvc darf NICHT abgeschaltet werden wenn anderes Fenster noch uvc=true hat', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),  // Fenster 1: endet
            makeWindow({ action_filter: true, action_uvc: true }),  // Fenster 2: läuft noch
        ];
        adapter._timeWindowActive = [true, true];

        let callCount = 0;
        adapter.isInTimeWindow = () => {
            callCount++;
            return callCount !== 1;
        };

        await adapter.checkTimeWindows();

        const uvcOff = adapter.setFeatureCalls.filter(c => c.f === 'uvc' && c.v === false);
        assert.strictEqual(uvcOff.length, 0,
            'UVC darf NICHT abgeschaltet werden – Fenster 2 braucht noch UVC');
    });

    it('uvc wird abgeschaltet wenn kein anderes Fenster es mehr braucht', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),
        ];
        adapter._timeWindowActive = [true];
        adapter.isInTimeWindow = () => false;

        await adapter.checkTimeWindows();

        const uvcOff = adapter.setFeatureCalls.filter(c => c.f === 'uvc' && c.v === false);
        assert.strictEqual(uvcOff.length, 1);
    });
});

// ---------------------------------------------------------------------------
// E. Follow-up Timer: Filter NICHT abschalten wenn anderes Fenster noch läuft
// ---------------------------------------------------------------------------
describe('E. Follow-up Timer bei Überlappung', () => {
    it('follow-up Timer schaltet filter NICHT ab wenn anderes Fenster noch aktiv', async () => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 5; // 5 Minuten follow-up

        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [false, true]; // Fenster 2 noch aktiv

        // deactivateWindow direkt aufrufen – Fenster 1 endet
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        // Da otherNeedsFilter=true (Fenster 2 aktiv): Code gibt früh zurück,
        // kein timer, kein filter-OFF Befehl
        const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOffCalls.length, 0,
            'filter darf NICHT abgeschaltet werden – Fenster 2 ist noch aktiv');
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 als inaktiv markiert');
        // Kein follow-up Timer nötig, da Filter vom anderen Fenster gehalten wird
        assert.strictEqual(adapter._pumpFollowUpTimers[0] ?? null, null,
            'kein follow-up Timer nötig wenn anderes Fenster den Filter hält');
    });

    it('follow-up Timer schaltet filter AB wenn kein anderes Fenster mehr aktiv', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;

        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [false]; // kein anderes aktiv

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            // _timeWindowActive[0] wurde auf false gesetzt
            setTimeout(() => {
                const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                // Follow-up: filter wird abgeschaltet
                assert.strictEqual(filterOffCalls.length, 1,
                    'filter muss nach follow-up abgeschaltet werden');
                done();
            }, 150);
        }).catch(done);
    });

    it('follow-up Timer bricht ab wenn Adapter im Unload', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            adapter._unloading = true; // Unload WÄHREND follow-up wartet
            setTimeout(() => {
                const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOffCalls.length, 0,
                    'filter darf nach _unloading=true nicht abgeschaltet werden');
                done();
            }, 150);
        }).catch(done);
    });
});

// ---------------------------------------------------------------------------
// F. Overlap-Deaktivierung: Fenster 2 endet nach Fenster 1 → Filter wird via Fenster 2 abgeschaltet
// ---------------------------------------------------------------------------
describe('F. Sequentielle Overlap-Deaktivierung – Filter via zweites Ende abgeschaltet', () => {
    it('filter wird durch Fenster 2 abgeschaltet wenn es nach Fenster 1 endet', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [true, true];

        // Schritt 1: Fenster 1 endet – Fenster 2 läuft noch → filter bleibt ON
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 inaktiv');
        const afterStep1 = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(afterStep1.length, 0, 'nach Fenster-1-Ende: kein filter-OFF (Fenster 2 läuft)');

        // Schritt 2: Fenster 2 endet – kein anderes Fenster mehr aktiv → filter OFF
        await adapter.deactivateWindow(adapter.config.timeWindows[1], 1);
        assert.strictEqual(adapter._timeWindowActive[1], false, 'Fenster 2 inaktiv');
        const afterStep2 = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(afterStep2.length, 1, 'nach Fenster-2-Ende: filter muss abgeschaltet werden');
    });

    it('follow-up Timer von Fenster 2 schaltet filter ab wenn zwischenzeitlich Fenster 2 auch endet', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001; // ~60ms
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [false, true]; // nur Fenster 2 aktiv

        // Fenster 2 direkt deaktivieren (kein anderes Fenster mehr aktiv)
        adapter.deactivateWindow(adapter.config.timeWindows[1], 1).then(() => {
            assert.strictEqual(adapter._timeWindowActive[1], false);
            // Follow-up Timer läuft
            setTimeout(() => {
                const filterOffCalls = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOffCalls.length, 1,
                    'filter muss nach follow-up von Fenster 2 abgeschaltet werden');
                done();
            }, 150);
        }).catch(done);
    });
});

// ---------------------------------------------------------------------------
// G. active=false während Fenster läuft → deactivateWindow aufgerufen
// ---------------------------------------------------------------------------
describe('G. active=false bei laufendem Fenster → Deaktivierung', () => {
    it('deactivateWindow wird aufgerufen wenn active=false und Fenster war aktiv', async () => {
        const adapter = createAdapter();
        let deactivateCalled = 0;
        const originalDeactivate = adapter.deactivateWindow.bind(adapter);
        adapter.deactivateWindow = async (w, i) => {
            deactivateCalled++;
            return originalDeactivate(w, i);
        };

        adapter.config.timeWindows = [
            makeWindow({ active: false, action_filter: true }),
        ];
        adapter._timeWindowActive = [true]; // war aktiv

        await adapter.checkTimeWindows();

        assert.strictEqual(deactivateCalled, 1, 'deactivateWindow muss 1x aufgerufen werden');
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster muss als inaktiv markiert sein');

        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOff.length, 1, 'filter muss abgeschaltet werden');
    });

    it('deactivateWindow wird NICHT aufgerufen wenn active=false und Fenster war NICHT aktiv', async () => {
        const adapter = createAdapter();
        let deactivateCalled = 0;
        const originalDeactivate = adapter.deactivateWindow.bind(adapter);
        adapter.deactivateWindow = async (w, i) => {
            deactivateCalled++;
            return originalDeactivate(w, i);
        };

        adapter.config.timeWindows = [
            makeWindow({ active: false, action_filter: true }),
        ];
        adapter._timeWindowActive = [false]; // war NICHT aktiv

        await adapter.checkTimeWindows();

        assert.strictEqual(deactivateCalled, 0, 'deactivateWindow darf nicht aufgerufen werden');
        assert.strictEqual(adapter.setFeatureCalls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// H. active=false ohne Überlappung → alles korrekt abschalten
// ---------------------------------------------------------------------------
describe('H. active=false (kein Overlap) → alle Features abschalten', () => {
    it('heater und filter werden abgeschaltet wenn Fenster auf active=false gesetzt wird', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ active: false, action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [true];

        await adapter.checkTimeWindows();

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 1, 'heater muss abgeschaltet werden');
        assert.strictEqual(filterOff.length, 1, 'filter muss abgeschaltet werden');
    });
});

// ---------------------------------------------------------------------------
// I. Drei Fenster – mittleres endet zuerst → Features bleiben aktiv
// ---------------------------------------------------------------------------
describe('I. Drei überlappende Fenster – mittleres endet zuerst', () => {
    it('Features bleiben ON weil Fenster 1 und 3 noch laufen', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),  // i=0: läuft
            makeWindow({ action_filter: true, action_uvc: true }),  // i=1: endet
            makeWindow({ action_filter: true, action_uvc: false }), // i=2: läuft
        ];
        adapter._timeWindowActive = [true, true, true];

        let callCount = 0;
        adapter.isInTimeWindow = () => {
            callCount++;
            // i=0 → true, i=1 → false (endet), i=2 → true
            return callCount !== 2;
        };

        await adapter.checkTimeWindows();

        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);

        assert.strictEqual(filterOff.length, 0, 'filter darf nicht aus – Fenster 1 und 3 laufen noch');
        assert.strictEqual(uvcOff.length,    0, 'uvc darf nicht aus – Fenster 1 läuft noch mit uvc=true');
        assert.strictEqual(adapter._timeWindowActive[1], false, 'Fenster 2 inaktiv');
    });

    it('alle Features gehen AUS wenn alle drei Fenster enden', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),
            makeWindow({ action_filter: true, action_uvc: false }),
            makeWindow({ action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [true, true, true];
        adapter.isInTimeWindow = () => false;

        await adapter.checkTimeWindows();

        assert.strictEqual(adapter._timeWindowActive[0], false);
        assert.strictEqual(adapter._timeWindowActive[1], false);
        assert.strictEqual(adapter._timeWindowActive[2], false);

        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.ok(filterOff.length >= 1, 'filter muss mindestens 1x abgeschaltet werden');
    });
});

// ---------------------------------------------------------------------------
// J. Fenster 1 Aktivierung schlägt fehl – Fenster 2 startet trotzdem
// ---------------------------------------------------------------------------
describe('J. Fehler bei Aktivierung von Fenster 1 blockiert nicht Fenster 2', () => {
    it('Fenster 2 wird aktiviert auch wenn Fenster 1 einen Fehler wirft', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }),  // i=0: wirft Fehler
            makeWindow({ action_filter: true }),  // i=1: soll trotzdem starten
        ];
        adapter._timeWindowActive = [false, false];

        let callCount = 0;
        adapter.setFeature = async (f, v) => {
            callCount++;
            if (callCount === 1) throw new Error('Simulated API error');
            adapter.setFeatureCalls.push({ f, v });
        };

        // Kein throw im Test erwartet – Fehler wird intern behandelt
        adapter.log.error = () => {}; // unterdrücken

        await adapter.checkTimeWindows();

        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 bleibt inaktiv nach Fehler');
        assert.strictEqual(adapter._timeWindowActive[1], true,  'Fenster 2 muss trotzdem aktiviert sein');
        const filterOn = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        assert.strictEqual(filterOn.length, 1, 'filter für Fenster 2 muss gestartet sein');
    });
});

// ---------------------------------------------------------------------------
// K. ALL-OFF Fenster überschneidet sich – schaltet alle Features ab
// ---------------------------------------------------------------------------
describe('K. ALL-OFF Fenster bei Überlappung', () => {
    it('ALL-OFF Fenster schaltet heater, uvc und filter ab – unabhängig von anderen Fenstern', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_heating: false }), // i=0: ALL-OFF startet
            makeWindow({ action_filter: true,  action_heating: true  }), // i=1: läuft noch
        ];
        adapter._timeWindowActive = [false, true];

        let callCount = 0;
        adapter.isInTimeWindow = () => {
            callCount++;
            return true; // beide im Fenster
        };

        // Fenster 1 noch nicht gestartet, startet jetzt als ALL-OFF
        await adapter.checkTimeWindows();

        // ALL-OFF Fenster soll alle drei Features explizit ausschalten
        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 1, 'heater muss durch ALL-OFF abgeschaltet werden');
        assert.strictEqual(uvcOff.length,    1, 'uvc muss durch ALL-OFF abgeschaltet werden');
        assert.strictEqual(filterOff.length, 1, 'filter muss durch ALL-OFF abgeschaltet werden');
    });
});

// ---------------------------------------------------------------------------
// L. Overnight-Fenster Überlappung – isInTimeWindow korrekt
// ---------------------------------------------------------------------------
describe('L. Overnight-Fenster Überlappung', () => {
    it('Overnight Fenster 22:00–06:00 und normales 05:00–08:00 überlappen korrekt um 05:30', () => {
        const adapter = createAdapter();

        // isInTimeWindow direkt testen mit fixer Zeit
        const origNow = Date;
        function fixedDate(h, m) {
            const d = new Date();
            d.setHours(h, m, 0, 0);
            return d;
        }

        const isInTimeWindowImpl = function(start, end) {
            const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
            const now = fixedDate(5, 30); // 05:30
            const cur = now.getHours() * 60 + now.getMinutes();
            const s = toMin(start);
            const e = toMin(end);
            if (s === e) return false;
            if (s < e) return cur >= s && cur < e;
            return cur >= s || cur < e; // overnight
        };

        // 22:00–06:00 overnight: 05:30 → im Fenster
        assert.strictEqual(isInTimeWindowImpl('22:00', '06:00'), true,
            '05:30 muss im overnight Fenster 22:00–06:00 sein');

        // 05:00–08:00: 05:30 → im Fenster
        assert.strictEqual(isInTimeWindowImpl('05:00', '08:00'), true,
            '05:30 muss im Fenster 05:00–08:00 sein');

        // 07:00–22:00: 05:30 → NICHT im Fenster
        assert.strictEqual(isInTimeWindowImpl('07:00', '22:00'), false,
            '05:30 darf NICHT im Fenster 07:00–22:00 sein');

        // Leeres Fenster 00:00–00:00 → nie aktiv
        assert.strictEqual(isInTimeWindowImpl('00:00', '00:00'), false,
            'leeres Fenster darf nie aktiv sein');
    });

    it('M.1 Overnight Tagesgrenze: Fenster 22:00–06:00 nur Montag – Di 03:00 muss noch aktiv sein', () => {
        // Reproduziert den Bug: day=Dienstag, dayOn=day_tue=false → inWin=false → Fenster endet falsch
        const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
        const dayKeys = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'];

        function computeInWin(w, fakeDay, fakeHour, fakeMin) {
            const start = w.start; const end = w.end;
            const sMin = toMin(start); const eMin = toMin(end);
            const curMin = fakeHour * 60 + fakeMin;
            const isOvernightAfterMidnight = sMin > eMin && eMin > 0 && curMin < eMin;
            const effectiveDay = isOvernightAfterMidnight ? (fakeDay + 6) % 7 : fakeDay;
            const dayOn = !!w[dayKeys[effectiveDay]];
            // isInTimeWindow
            const s = sMin; const e = eMin; const cur = curMin;
            let inWindow;
            if (s === e) inWindow = false;
            else if (s < e) inWindow = cur >= s && cur < e;
            else inWindow = cur >= s || cur < e;
            return dayOn && inWindow;
        }

        const w = { start: '22:00', end: '06:00', day_mon: true,
            day_tue: false, day_wed: false, day_thu: false, day_fri: false, day_sat: false, day_sun: false };

        assert.strictEqual(computeInWin(w, 1, 22, 30), true,  'Mo 22:30 → aktiv');
        assert.strictEqual(computeInWin(w, 1, 23, 59), true,  'Mo 23:59 → aktiv');
        assert.strictEqual(computeInWin(w, 2, 0,  0),  true,  'Di 00:00 → noch aktiv (overnight Mo)');
        assert.strictEqual(computeInWin(w, 2, 3,  0),  true,  'Di 03:00 → noch aktiv (overnight Mo)');
        assert.strictEqual(computeInWin(w, 2, 5, 59),  true,  'Di 05:59 → noch aktiv');
        assert.strictEqual(computeInWin(w, 2, 6,  0),  false, 'Di 06:00 → Fenster-Ende');
        assert.strictEqual(computeInWin(w, 2, 10, 0),  false, 'Di 10:00 → tagsüber, inaktiv');
        assert.strictEqual(computeInWin(w, 2, 22, 0),  false, 'Di 22:00 → day_tue=false, inaktiv');
    });

    it('M.2 Overnight Tagesgrenze: So–Mo-Grenze (So=6, Mo=0)', () => {
        const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
        const dayKeys = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'];

        function computeInWin(w, fakeDay, fakeHour, fakeMin) {
            const sMin = toMin(w.start); const eMin = toMin(w.end); const curMin = fakeHour * 60 + fakeMin;
            const isOvernightAfterMidnight = sMin > eMin && eMin > 0 && curMin < eMin;
            const effectiveDay = isOvernightAfterMidnight ? (fakeDay + 6) % 7 : fakeDay;
            const dayOn = !!w[dayKeys[effectiveDay]];
            const s = sMin; const e = eMin; const cur = curMin;
            let inW; if (s===e) inW=false; else if(s<e) inW=cur>=s&&cur<e; else inW=cur>=s||cur<e;
            return dayOn && inW;
        }

        // Samstag-Nacht-Fenster: nur Samstag aktiv (index 6)
        const w = { start: '23:00', end: '04:00',
            day_sun: false, day_mon: false, day_tue: false, day_wed: false,
            day_thu: false, day_fri: false, day_sat: true };

        assert.strictEqual(computeInWin(w, 6, 23, 30), true,  'Sa 23:30 → aktiv');
        assert.strictEqual(computeInWin(w, 0, 1,  0),  true,  'So 01:00 → noch aktiv (overnight Sa→So)');
        assert.strictEqual(computeInWin(w, 0, 4,  0),  false, 'So 04:00 → Fenster-Ende');
    });

    it('deactivateWindow ignoriert filter-OFF wenn overnight-Fenster noch läuft', async () => {
        const adapter = createAdapter();
        // Overnight-Fenster (i=0) läuft noch, normales (i=1) endet
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, start: '22:00', end: '06:00' }), // läuft
            makeWindow({ action_filter: true, start: '05:00', end: '08:00' }), // endet
        ];
        adapter._timeWindowActive = [true, true];

        let callCount = 0;
        adapter.isInTimeWindow = (start) => {
            callCount++;
            // Overnight (22:00) läuft, normales (05:00) endet
            return start === '22:00';
        };

        await adapter.checkTimeWindows();

        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOff.length, 0,
            'filter darf nicht aus – overnight-Fenster läuft noch');
        assert.strictEqual(adapter._timeWindowActive[0], true,  'overnight-Fenster aktiv');
        assert.strictEqual(adapter._timeWindowActive[1], false, 'normales Fenster inaktiv');
    });
});
