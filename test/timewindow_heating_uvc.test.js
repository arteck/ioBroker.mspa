'use strict';

/**
 * test/timewindow_heating_uvc.test.js
 *
 * Prüft das Ein- und Ausschalt-Verhalten von Heizung und UVC nach Zeitfenster.
 * Spiegelt den aktuellen Stand nach allen Bug-Fixes (action_uvc-Fix, _filterStartedForUvc).
 *
 * Szenarien:
 *   START
 *     1.  Heizungs-Fenster startet: filter ON → heater ON (korrekte Reihenfolge)
 *     2.  Heizungs-Fenster mit action_filter=false: filter ON (Prerequisite) + heater ON
 *     3.  UVC-Fenster mit action_filter=true: filter ON + UVC ON
 *     4.  UVC-Only-Fenster (action_filter=false, action_uvc=true): filter ON als Prerequisite + UVC ON
 *     5.  Heizung+UVC+Filter: alle drei starten in richtiger Reihenfolge
 *     6.  target_temp wird 10 s verzögert gesendet
 *
 *   ENDE (deactivateWindow)
 *     7.  Heizungs-Fenster endet: heater OFF, filter OFF
 *     8.  Heizungs-Fenster (action_filter=false) endet: heater OFF, filter OFF (heating-prerequisite)
 *     9.  Filter+UVC endet, UVC-Min erfüllt: UVC OFF, filter OFF
 *     10. Filter+UVC endet, UVC-Min NICHT erfüllt: UVC bleibt ON, filter bleibt ON (ensure übernimmt)
 *     11. UVC-Only endet, UVC-Min erfüllt: UVC OFF, filter OFF (_filterStartedForUvc)
 *     12. UVC-Only endet, UVC-Min NICHT erfüllt: UVC bleibt ON, filter bleibt ON
 *     13. Heizung+UVC+Filter endet (alle): heater OFF, UVC OFF, filter OFF
 *     14. Heizung endet – anderes Fenster braucht Heizer → heater bleibt ON
 *     15. UVC endet – anderes Fenster braucht UVC → UVC bleibt ON
 *     16. Fenster endet – anderes Fenster braucht Filter → filter bleibt ON
 *     17. Follow-up: filter OFF nach Delay bei Heizungs-Fenster
 *     18. Follow-up: filter OFF nach Delay bei UVC-Only-Fenster
 *     19. pv_steu-Fenster endet: evaluatePvSurplus wird aufgerufen, kein direktes setFeature
 *     20. _filterStartedForUvc wird nach Fenster-Ende auf false zurückgesetzt
 *
 * Run: npx mocha test/timewindow_heating_uvc.test.js
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Adapter-Mock – portiert aus aktuellem main.js Stand (nach allen Bug-Fixes)
// ---------------------------------------------------------------------------
function createAdapter(overrides = {}) {
    const adapter = {
        _manualOverride: false,
        _unloading: false,
        _pvActive: false,
        _pvStageTimer: null,
        _timeWindowActive: [],
        _pumpFollowUpTimers: [],
        _pumpStartedForHeating: false,
        _filterStartedForUvc: [],       // NEU: per-window Flag
        _seasonEnabled: true,
        _pvSurplusEvaluated: false,
        _uvcEnsureActive: false,        // UVC Daily Ensure
        _uvcEnsureFilterStart: false,
        _pvManagedFeatures: { filter: false, heater: false, uvc: false },
        _winterFrostActive: false,
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
        strayTimerFns: [],
        async setFeature(f, v) { this.setFeatureCalls.push({ f, v }); },
        isInSeason()    { return true; },
        isInTimeWindow() { return true; },
        getUvcTodayHours() { return 3; },  // Standard: UVC-Min erfüllt (3h >= 2h)
        enableRapidPolling() {},
        // setStray: synchron ausführen (Tests brauchen keine echten Delays)
        setStray(fn) { this.strayTimerFns.push(fn); /* nicht sofort – Test ruft explizit auf */ },
        evaluatePvSurplus() {
            this._pvSurplusEvaluated = true;
            return Promise.resolve();
        },
        sendTargetTempDirect: async () => {},
        ...overrides,
    };

    // ── Aktuelle deactivateWindow Logik (Filter immer verwaltet, PV nur Heizung) ──
    adapter.deactivateWindow = async function (w, i) {
        const pvHandlesHeater = w.pv_steu && (this._pvActive || this._pvStageTimer !== null);
        if (pvHandlesHeater) {
            if (this.config.more_log_enabled) {
                this.log.info(`Time control [${i + 1}]: window END – pv_steu, PV handles heater, window handles filter`);
            }
            this._timeWindowActive[i] = false;
            this.evaluatePvSurplus().catch(() => {});
            // Fall through to handle filter
        }

        const windows = this.config.timeWindows;
        const otherNeedsFilter = Array.isArray(windows) && windows.some((win, j) =>
            j !== i && this._timeWindowActive[j] && win.active &&
            (win.action_filter || win.action_heating || win.action_uvc)
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

        const followUpMin  = Number(this.config.pump_follow_up) || 0;
        const uvcMinH      = this.config.uvc_daily_min_h ?? 2;
        const todayH       = this.getUvcTodayHours();
        const uvcMinMet    = todayH >= uvcMinH;

        try {
            // Heater: nur wenn PV es nicht steuert
            if (!pvHandlesHeater && w.action_heating && !otherNeedsHeater) {
                await this.setFeature('heater', false);
            }

            // UVC
            if (w.action_uvc && !otherNeedsUvc) {
                if (uvcMinMet) {
                    await this.setFeature('uvc', false);
                } else {
                    if (!pvHandlesHeater) this._timeWindowActive[i] = false;
                    this._filterStartedForUvc[i] = false;
                    this.enableRapidPolling();
                    return;
                }
            }

            // Filter: Overlap prüfen
            if (otherNeedsFilter) {
                if (!pvHandlesHeater) this._timeWindowActive[i] = false;
                this._filterStartedForUvc[i] = false;
                this.enableRapidPolling();
                return;
            }

            // Filter IMMER stoppen (außer ALL-OFF)
            const isAllOffWindow = !w.action_filter && !w.action_heating && !w.action_uvc;
            const needsFilterStop = !isAllOffWindow;

            const stopPumpNow = !followUpMin || followUpMin <= 0;

            if (stopPumpNow) {
                if (needsFilterStop) {
                    await this.setFeature('filter', false);
                    this._filterStartedForUvc[i] = false;
                }
            } else {
                if (needsFilterStop) {
                    this._pumpFollowUpTimers[i] = setTimeout(() => {
                        if (this._unloading) return;
                        this._pumpFollowUpTimers[i] = null;
                        const stillNeededByWindow = Array.isArray(this.config.timeWindows) &&
                            this.config.timeWindows.some((win, j) =>
                                j !== i && this._timeWindowActive[j] && win.active &&
                                (win.action_filter || win.action_heating || win.action_uvc)
                            );
                        const stillNeededByEnsure = this._uvcEnsureActive && this._uvcEnsureFilterStart;
                        const stillNeededByFrost  = this._winterFrostActive;
                        const stillNeeded = stillNeededByWindow || stillNeededByEnsure || stillNeededByFrost;
                        if (stillNeeded) return;
                        this.setFeature('filter', false)
                            .then(() => {
                                this._filterStartedForUvc[i] = false;
                                this.enableRapidPolling();
                            })
                            .catch(() => {});
                    }, Math.round(followUpMin * 60 * 1000));
                }
            }

            if (!pvHandlesHeater) this._timeWindowActive[i] = false;
            this.enableRapidPolling();
        } catch (err) {
            this.log.error(`deactivation FAILED: ${err.message}`);
        }
    };

    // ── Aktuelle checkTimeWindows Logik (Filter immer an, PV nur Heizung) ─────
    adapter.checkTimeWindows = async function () {
        const windows = this.config.timeWindows;
        if (!Array.isArray(windows)) return;
        if (this._manualOverride) return;
        if (!this.isInSeason()) return;

        while (this._timeWindowActive.length < windows.length) this._timeWindowActive.push(false);
        while (this._filterStartedForUvc.length < windows.length) this._filterStartedForUvc.push(false);

        const dayKeys = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'];
        const day = new Date().getDay();

        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (!w.active) {
                if (this._timeWindowActive[i]) await this.deactivateWindow(w, i);
                continue;
            }

            const start = w.start || '00:00';
            const end   = w.end   || '00:00';
            const dayOn = w[dayKeys[day]] !== false;
            const inWin = dayOn && this.isInTimeWindow(start, end);
            const wasIn = this._timeWindowActive[i];

            if (inWin && !wasIn) {
                try {
                    if (!w.action_filter && !w.action_heating && !w.action_uvc) {
                        // ALL-OFF
                        await this.setFeature('heater', false).catch(() => {});
                        await this.setFeature('uvc',    false).catch(() => {});
                        await this.setFeature('filter', false).catch(() => {});
                    } else {
                        // Filter IMMER an
                        await this.setFeature('filter', true);
                        if (w.pv_steu) {
                            // PV entscheidet über Heizung
                            this.evaluatePvSurplus().catch(() => {});
                        } else if (w.action_heating) {
                            await this.setFeature('heater', true);
                            if (w.target_temp) {
                                this.setStray(() => {
                                    this.sendTargetTempDirect(w.target_temp).catch(() => {});
                                }, 10_000);
                            }
                        }
                        if (w.action_uvc) {
                            // UVC sofort mit Filter
                            await this.setFeature('uvc', true);
                        }
                    }
                    this._timeWindowActive[i] = true;
                } catch (err) {
                    this.log.error(`activation FAILED: ${err.message}`);
                }
            } else if (!inWin && wasIn) {
                await this.deactivateWindow(w, i);
            }
        }
    };

    return adapter;
}

// Hilfsfunktion: Fenster für heute erstellen
function makeWindow(overrides = {}) {
    return {
        active: true,
        start: '10:00',
        end:   '18:00',
        action_filter:  false,
        action_heating: false,
        action_uvc:     false,
        pv_steu:        false,
        target_temp:    null,
        ...overrides,
    };
}

// ============================================================================
// START-VERHALTEN
// ============================================================================

describe('START 1: Heizungs-Fenster (action_filter=true, action_heating=true)', () => {
    it('startet filter ZUERST, dann heater', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [false];

        await adapter.checkTimeWindows();

        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster muss aktiv sein');

        const filterOnIdx  = adapter.setFeatureCalls.findIndex(c => c.f === 'filter' && c.v === true);
        const heaterOnIdx  = adapter.setFeatureCalls.findIndex(c => c.f === 'heater' && c.v === true);
        assert.ok(filterOnIdx >= 0,  'filter muss gestartet werden');
        assert.ok(heaterOnIdx >= 0,  'heater muss gestartet werden');
        assert.ok(filterOnIdx < heaterOnIdx,
            `filter(${filterOnIdx}) muss VOR heater(${heaterOnIdx}) gestartet werden`);
    });

    it('UVC wird NICHT gestartet wenn action_uvc=false', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true, action_uvc: false }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        const uvcOn = adapter.setFeatureCalls.filter(c => c.f === 'uvc' && c.v === true);
        assert.strictEqual(uvcOn.length, 0, 'UVC darf nicht gestartet werden');
    });
});

describe('START 2: Heizungs-Fenster ohne Filter (action_filter=false, action_heating=true)', () => {
    it('startet filter (immer) und heater', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_heating: true }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        assert.strictEqual(adapter._timeWindowActive[0], true);
        const filterOn = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        const heaterOn = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === true);
        assert.strictEqual(filterOn.length, 1,  'filter muss gestartet werden (immer bei aktivem Fenster)');
        assert.strictEqual(heaterOn.length, 1,  'heater muss gestartet werden');
        // _pumpStartedForHeating ist nicht mehr relevant – Filter immer gestartet
    });
});

describe('START 3: Filter+UVC Fenster (action_filter=true, action_uvc=true)', () => {
    it('startet filter UND UVC', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        const filterOn = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        const uvcOn    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === true);
        assert.strictEqual(filterOn.length, 1, 'filter muss gestartet werden');
        assert.strictEqual(uvcOn.length,    1, 'UVC muss gestartet werden');
        assert.strictEqual(adapter._filterStartedForUvc[0], false,
            '_filterStartedForUvc muss false sein wenn action_filter=true');
    });
});

describe('START 4: UVC-Only-Fenster (action_filter=false, action_uvc=true)', () => {
    it('startet filter (immer) und UVC sofort', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_uvc: true }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        assert.strictEqual(adapter._timeWindowActive[0], true, 'Fenster aktiv');
        const filterOn = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === true);
        const uvcOn    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === true);
        assert.strictEqual(filterOn.length, 1, 'filter muss gestartet werden (immer bei aktivem Fenster)');
        assert.strictEqual(uvcOn.length,    1, 'UVC muss sofort gestartet werden (action_uvc=true)');
        // _filterStartedForUvc wird nicht mehr benötigt – Filter immer durch Zeitfenster verwaltet
    });

    it('startet heater NICHT obwohl filter gestartet wurde', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_uvc: true }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        const heaterOn = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === true);
        assert.strictEqual(heaterOn.length, 0, 'heater darf nicht gestartet werden');
    });
});

describe('START 5: Kombiniertes Fenster (action_filter=true, action_heating=true, action_uvc=true)', () => {
    it('startet filter → heater → UVC in korrekter Reihenfolge', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true, action_uvc: true }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        const filterOnIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'filter' && c.v === true);
        const heaterOnIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'heater' && c.v === true);
        const uvcOnIdx    = adapter.setFeatureCalls.findIndex(c => c.f === 'uvc'    && c.v === true);

        assert.ok(filterOnIdx >= 0, 'filter muss gestartet werden');
        assert.ok(heaterOnIdx >= 0, 'heater muss gestartet werden');
        assert.ok(uvcOnIdx    >= 0, 'UVC muss gestartet werden');
        assert.ok(filterOnIdx < heaterOnIdx, 'filter vor heater');
        assert.strictEqual(adapter._filterStartedForUvc[0], false,
            '_filterStartedForUvc muss false sein wenn action_filter=true');
    });
});

describe('START 6: target_temp wird verzögert via setStray gesendet', () => {
    it('sendTargetTempDirect wird als setStray-Callback registriert', async () => {
        const adapter = createAdapter();
        let tempSent = null;
        adapter.sendTargetTempDirect = async (temp) => { tempSent = temp; };

        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true, target_temp: 38 }),
        ];
        adapter._timeWindowActive = [false];
        await adapter.checkTimeWindows();

        assert.ok(adapter.strayTimerFns.length > 0,
            'mindestens ein setStray-Callback muss registriert sein');

        // Callback manuell ausführen (simuliert setTimeout-Ablauf)
        for (const fn of adapter.strayTimerFns) fn();
        assert.strictEqual(tempSent, 38, 'target_temp 38°C muss gesendet werden');
    });
});

// ============================================================================
// ENDE-VERHALTEN (deactivateWindow)
// ============================================================================

describe('ENDE 7: Heizungs-Fenster endet (action_filter=true, action_heating=true)', () => {
    it('heater OFF und filter OFF', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [true];
        adapter.isInTimeWindow = () => false;
        await adapter.checkTimeWindows();

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 1, 'heater muss abgeschaltet werden');
        assert.strictEqual(filterOff.length, 1, 'filter muss abgeschaltet werden');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });

    it('heater wird VOR filter abgeschaltet', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [true];
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const heaterOffIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'heater' && c.v === false);
        const filterOffIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'filter' && c.v === false);
        assert.ok(heaterOffIdx < filterOffIdx,
            `heater(${heaterOffIdx}) muss VOR filter(${filterOffIdx}) abgeschaltet werden`);
    });
});

describe('ENDE 8: Heizungs-Fenster (action_filter=false) endet – Heating-Only', () => {
    it('heater OFF und filter OFF', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_heating: true }),
        ];
        adapter._timeWindowActive = [true];
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 1, 'heater muss abgeschaltet werden');
        assert.strictEqual(filterOff.length, 1, 'filter muss abgeschaltet werden (immer durch Zeitfenster verwaltet)');
    });
});

describe('ENDE 9: Filter+UVC Fenster endet, UVC-Min erfüllt', () => {
    it('UVC OFF und filter OFF (UVC-Min=2h, heute=3h → erfüllt)', async () => {
        const adapter = createAdapter(); // getUvcTodayHours() = 3 ≥ 2
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),
        ];
        adapter._timeWindowActive = [true];
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(uvcOff.length,    1, 'UVC muss abgeschaltet werden');
        assert.strictEqual(filterOff.length, 1, 'filter muss abgeschaltet werden');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });
});

describe('ENDE 10: Filter+UVC Fenster endet, UVC-Min NICHT erfüllt', () => {
    it('UVC und filter bleiben ON – ensure übernimmt (_timeWindowActive=false)', async () => {
        const adapter = createAdapter();
        adapter.getUvcTodayHours = () => 0.5; // 0.5h < 2h → nicht erfüllt
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),
        ];
        adapter._timeWindowActive = [true];
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(uvcOff.length,    0, 'UVC darf NICHT abgeschaltet werden – Min nicht erreicht');
        assert.strictEqual(filterOff.length, 0, 'filter darf NICHT abgeschaltet werden – UVC läuft noch');
        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive muss false sein – ensure übernimmt');
        assert.strictEqual(adapter._filterStartedForUvc[0], false,
            '_filterStartedForUvc muss false sein – Ownership geht an ensure');
    });
});

describe('ENDE 11: UVC-Only-Fenster endet, UVC-Min erfüllt', () => {
    it('UVC OFF und filter OFF', async () => {
        const adapter = createAdapter(); // getUvcTodayHours() = 3 ≥ 2
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_uvc: true }),
        ];
        adapter._timeWindowActive   = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(uvcOff.length,    1, 'UVC muss abgeschaltet werden');
        assert.strictEqual(filterOff.length, 1, 'filter muss abgeschaltet werden (Zeitfenster verwaltet immer Filter)');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });
});

describe('ENDE 12: UVC-Only-Fenster endet, UVC-Min NICHT erfüllt', () => {
    it('UVC bleibt ON, filter bleibt ON – ensure übernimmt', async () => {
        const adapter = createAdapter();
        adapter.getUvcTodayHours = () => 0.5;
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_uvc: true }),
        ];
        adapter._timeWindowActive   = [true];
        adapter._filterStartedForUvc[0] = true;

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(uvcOff.length,    0, 'UVC muss an bleiben');
        assert.strictEqual(filterOff.length, 0, 'filter muss an bleiben');
        assert.strictEqual(adapter._timeWindowActive[0], false);
    });
});

describe('ENDE 13: Kombiniertes Fenster (filter+heating+uvc) endet vollständig', () => {
    it('heater OFF, UVC OFF, filter OFF – alle drei Befehle', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true, action_uvc: true }),
        ];
        adapter._timeWindowActive = [true];
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 1, 'heater OFF');
        assert.strictEqual(uvcOff.length,    1, 'UVC OFF');
        assert.strictEqual(filterOff.length, 1, 'filter OFF');

        // Reihenfolge: heater → uvc → filter
        const hIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'heater' && c.v === false);
        const uIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'uvc'    && c.v === false);
        const fIdx = adapter.setFeatureCalls.findIndex(c => c.f === 'filter' && c.v === false);
        assert.ok(hIdx < fIdx,  `heater(${hIdx}) vor filter(${fIdx})`);
        assert.ok(uIdx < fIdx,  `uvc(${uIdx}) vor filter(${fIdx})`);
    });
});

describe('ENDE 14: Heizung endet – anderes Fenster braucht Heizer → heater bleibt ON', () => {
    it('heater bleibt ON, filter bleibt ON', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }), // i=0: endet
            makeWindow({ action_filter: true, action_heating: true }), // i=1: läuft noch
        ];
        adapter._timeWindowActive = [true, true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(heaterOff.length, 0, 'heater darf nicht aus – Fenster 2 braucht ihn');
        assert.strictEqual(filterOff.length, 0, 'filter darf nicht aus – Fenster 2 braucht ihn');
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 inaktiv');
        assert.strictEqual(adapter._timeWindowActive[1], true,  'Fenster 2 aktiv');
    });
});

describe('ENDE 15: UVC endet – anderes Fenster braucht UVC → UVC bleibt ON', () => {
    it('UVC bleibt ON, filter bleibt ON', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }), // i=0: endet
            makeWindow({ action_filter: true, action_uvc: true }), // i=1: läuft noch
        ];
        adapter._timeWindowActive = [true, true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff    = adapter.setFeatureCalls.filter(c => c.f === 'uvc'    && c.v === false);
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(uvcOff.length,    0, 'UVC bleibt ON');
        assert.strictEqual(filterOff.length, 0, 'filter bleibt ON');
    });
});

describe('ENDE 16: Fenster endet – anderes Fenster braucht Filter → filter bleibt ON', () => {
    it('filter bleibt ON, aber _timeWindowActive[0]=false', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true }), // i=0: endet
            makeWindow({ action_filter: true }), // i=1: läuft noch
        ];
        adapter._timeWindowActive = [true, true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOff.length, 0, 'filter bleibt ON');
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Fenster 1 inaktiv');
        assert.strictEqual(adapter._timeWindowActive[1], true,  'Fenster 2 aktiv');
    });
});

describe('ENDE 17: Follow-up Filter-OFF nach Delay (Heizungs-Fenster)', () => {
    it('filter wird nach follow-up-Delay abgeschaltet', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001; // ~60ms
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),
        ];
        adapter._timeWindowActive = [true];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
            assert.strictEqual(heaterOff.length, 1, 'heater sofort OFF');

            const filterOffImmediate = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
            assert.strictEqual(filterOffImmediate.length, 0, 'filter noch NICHT OFF (follow-up läuft)');

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 1, 'filter muss nach follow-up OFF sein');
                done();
            }, 200);
        }).catch(done);
    });

    it('follow-up bricht ab wenn zwischenzeitlich anderes Fenster aktiv wird', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true }),
            makeWindow({ action_filter: true }),
        ];
        adapter._timeWindowActive = [true, false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            // Fenster 2 wird WÄHREND follow-up aktiv
            adapter._timeWindowActive[1] = true;

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 0,
                    'filter darf NICHT abgeschaltet werden – Fenster 2 wurde inzwischen aktiv');
                done();
            }, 200);
        }).catch(done);
    });
});

describe('ENDE 18: Follow-up Filter-OFF nach Delay (UVC-Only-Fenster)', () => {
    it('filter wird nach follow-up abgeschaltet wenn UVC-Only-Fenster endet', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [
            makeWindow({ action_filter: false, action_uvc: true }),
        ];
        adapter._timeWindowActive   = [true];
        adapter._filterStartedForUvc[0] = true;

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            const uvcOff = adapter.setFeatureCalls.filter(c => c.f === 'uvc' && c.v === false);
            assert.strictEqual(uvcOff.length, 1, 'UVC sofort OFF');

            const filterOffImmediate = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
            assert.strictEqual(filterOffImmediate.length, 0, 'filter noch NICHT OFF');

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 1,
                    'filter muss nach follow-up OFF sein (UVC-Prerequisite)');
                assert.strictEqual(adapter._filterStartedForUvc[0], false);
                done();
            }, 200);
        }).catch(done);
    });
});

describe('ENDE 19: pv_steu-Fenster endet → PV schaltet Heizung ab, Zeitfenster Filter', () => {
    it('evaluatePvSurplus aufgerufen, filter OFF, _timeWindowActive=false', async () => {
        const adapter = createAdapter();
        adapter._pvActive = true;
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_heating: true, pv_steu: true }),
        ];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        // Kurz warten damit evaluatePvSurplus-Promise feuert
        await new Promise(r => setTimeout(r, 20));

        assert.strictEqual(adapter._pvSurplusEvaluated, true,
            'evaluatePvSurplus muss aufgerufen werden (PV schaltet Heizung ab)');
        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive muss false sein');
        // Filter wird vom Zeitfenster abgeschaltet
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOff.length, 1,
            'filter muss abgeschaltet werden – vom Zeitfenster verwaltet');
        // Heizung wird NICHT direkt abgeschaltet – PV übernimmt
        const heaterOff = adapter.setFeatureCalls.filter(c => c.f === 'heater' && c.v === false);
        assert.strictEqual(heaterOff.length, 0,
            'heater darf NICHT direkt abgeschaltet werden – PV übernimmt');
    });

    it('kein evaluatePvSurplus wenn _pvActive=false (PV läuft nicht)', async () => {
        const adapter = createAdapter();
        adapter._pvActive = false;
        adapter._pvStageTimer = null;
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, pv_steu: true }),
        ];
        adapter._timeWindowActive = [true];

        // Bei pv_steu=false, pvActive=false: normaler Abschaltpfad
        // pv_steu=true aber _pvActive=false → deactivateWindow führt normalen Abschluss durch
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._pvSurplusEvaluated, false,
            'evaluatePvSurplus darf NICHT aufgerufen werden wenn PV nicht aktiv');
        // normaler Abschluss: filter OFF
        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOff.length, 1, 'normaler filter-OFF wenn PV nicht aktiv');
    });
});

describe('ENDE 20: _filterStartedForUvc Reset in allen Exit-Pfaden', () => {
    it('reset bei normalem Ende (UVC-Min erfüllt)', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [makeWindow({ action_filter: false, action_uvc: true })];
        adapter._timeWindowActive = [true];
        adapter._filterStartedForUvc[0] = true;

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);
        assert.strictEqual(adapter._filterStartedForUvc[0], false, 'reset bei normalem Ende');
    });

    it('reset bei Early-Return (otherNeedsFilter)', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [
            makeWindow({ action_filter: true, action_uvc: true }),
            makeWindow({ action_filter: true }), // hält filter
        ];
        adapter._timeWindowActive = [true, true];
        adapter._filterStartedForUvc[0] = true;

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);
        assert.strictEqual(adapter._filterStartedForUvc[0], false,
            'reset auch bei Early-Return durch Overlap');
    });

    it('reset bei UVC-Min-nicht-erfüllt Early-Return', async () => {
        const adapter = createAdapter();
        adapter.getUvcTodayHours = () => 0;
        adapter.config.timeWindows = [makeWindow({ action_filter: false, action_uvc: true })];
        adapter._timeWindowActive = [true];
        adapter._filterStartedForUvc[0] = true;

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);
        assert.strictEqual(adapter._filterStartedForUvc[0], false,
            'reset wenn ensure Ownership übernimmt');
    });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('EDGE: Fenster startet und endet im selben checkTimeWindows-Durchlauf nicht möglich', () => {
    it('inWin=true und wasIn=false → startet; inWin=false und wasIn=true → endet; nie beides', async () => {
        const adapter = createAdapter();
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];

        // Durchlauf 1: Start
        adapter._timeWindowActive = [false];
        adapter.isInTimeWindow = () => true;
        await adapter.checkTimeWindows();
        assert.strictEqual(adapter._timeWindowActive[0], true, 'nach Durchlauf 1: aktiv');

        // Durchlauf 2: Ende
        adapter.setFeatureCalls = [];
        adapter.isInTimeWindow = () => false;
        await adapter.checkTimeWindows();
        assert.strictEqual(adapter._timeWindowActive[0], false, 'nach Durchlauf 2: inaktiv');

        const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
        assert.strictEqual(filterOff.length, 1, 'filter muss beim Ende abgeschaltet werden');
    });
});

describe('EDGE: UVC-Min-Grenzwert exakt erfüllt (todayH === uvcMinH)', () => {
    it('UVC wird abgeschaltet wenn todayH === uvcMinH (Grenzwert)', async () => {
        const adapter = createAdapter();
        adapter.getUvcTodayHours = () => 2;        // exakt gleich
        adapter.config.uvc_daily_min_h = 2;
        adapter.config.timeWindows = [makeWindow({ action_filter: true, action_uvc: true })];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff = adapter.setFeatureCalls.filter(c => c.f === 'uvc' && c.v === false);
        assert.strictEqual(uvcOff.length, 1,
            'UVC muss abgeschaltet werden bei todayH === uvcMinH (≥ nicht >)');
    });

    it('UVC bleibt ON wenn todayH < uvcMinH um 0.01h', async () => {
        const adapter = createAdapter();
        adapter.getUvcTodayHours = () => 1.99;
        adapter.config.uvc_daily_min_h = 2;
        adapter.config.timeWindows = [makeWindow({ action_filter: true, action_uvc: true })];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        const uvcOff = adapter.setFeatureCalls.filter(c => c.f === 'uvc' && c.v === false);
        assert.strictEqual(uvcOff.length, 0, 'UVC bleibt ON bei 1.99h < 2h');
    });
});

describe('EDGE: _unloading – follow-up Timer feuert nicht nach Adapter-Stop', () => {
    it('filter bleibt an wenn _unloading=true beim Timer-Feuer', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            adapter._unloading = true;
            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 0,
                    'filter darf nach _unloading nicht abgeschaltet werden');
                done();
            }, 200);
        }).catch(done);
    });
});

// ---------------------------------------------------------------------------
// FOLLOW-UP + UVC ENSURE INTERAKTION
// ---------------------------------------------------------------------------
describe('FOLLOW-UP: Filter-OFF wird blockiert wenn UVC Daily Ensure aktiv ist', () => {
    it('follow-up schaltet Filter NICHT ab wenn _uvcEnsureActive=true und _uvcEnsureFilterStart=true', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001; // ~60 ms
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            // Ensure übernimmt während follow-up läuft
            adapter._uvcEnsureActive      = true;
            adapter._uvcEnsureFilterStart = true;

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 0,
                    'filter darf NICHT abgeschaltet werden – Ensure hat Ownership');
                done();
            }, 200);
        }).catch(done);
    });

    it('follow-up schaltet Filter AB wenn _uvcEnsureActive=true aber _uvcEnsureFilterStart=false', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            // Ensure läuft, aber hat Filter NICHT selbst gestartet (Filter gehört uns)
            adapter._uvcEnsureActive      = true;
            adapter._uvcEnsureFilterStart = false;

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 1,
                    'filter MUSS abgeschaltet werden – Ensure hat kein Filter-Ownership');
                done();
            }, 200);
        }).catch(done);
    });

    it('follow-up schaltet Filter AB wenn _pvActive=true (PV verwaltet Filter nicht mehr)', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            // PV verwaltet nur noch Heizung, nicht Filter → Filter darf abgeschaltet werden
            adapter._pvActive = true;
            adapter._pvManagedFeatures.filter = false; // PV verwaltet Filter nicht mehr

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 1,
                    'filter MUSS abgeschaltet werden – PV verwaltet Filter nicht mehr');
                done();
            }, 200);
        }).catch(done);
    });

    it('follow-up schaltet Filter NICHT ab wenn _winterFrostActive=true', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            adapter._winterFrostActive = true;

            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 0,
                    'filter darf NICHT abgeschaltet werden – Frost-Schutz aktiv');
                done();
            }, 200);
        }).catch(done);
    });

    it('follow-up schaltet Filter AB wenn keine Automation mehr aktiv ist', (done) => {
        const adapter = createAdapter();
        adapter.config.pump_follow_up = 0.001;
        adapter.config.timeWindows = [makeWindow({ action_filter: true })];
        adapter._timeWindowActive = [false];
        // alle Automationen inaktiv
        adapter._uvcEnsureActive   = false;
        adapter._pvActive          = false;
        adapter._winterFrostActive = false;

        adapter.deactivateWindow(adapter.config.timeWindows[0], 0).then(() => {
            setTimeout(() => {
                const filterOff = adapter.setFeatureCalls.filter(c => c.f === 'filter' && c.v === false);
                assert.strictEqual(filterOff.length, 1,
                    'filter MUSS abgeschaltet werden – keine Automation aktiv');
                done();
            }, 200);
        }).catch(done);
    });
});


