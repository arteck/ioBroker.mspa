'use strict';

/**
 * test/deactivate_retry.test.js
 *
 * Testet den Retry-Mechanismus bei nicht bestätigten API-Befehlen während
 * der Fenster-Deaktivierung.
 *
 * Szenario:
 *   Zeitfenster endet → deactivateWindow → setFeature('heater', false) →
 *   API bestätigt NICHT → setFeature wirft → _timeWindowActive bleibt true →
 *   nächster checkTimeWindows-Tick versucht erneut.
 *
 * Run: npx mocha test/deactivate_retry.test.js
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Minimaler Adapter-Mock
// ---------------------------------------------------------------------------
function makeAdapter(overrides = {}) {
    const adapter = {
        _pvActive: false,
        _pvStageTimer: null,
        _timeWindowActive: [true],
        _pumpFollowUpTimers: [null],
        _filterStartedForUvc: [false],
        _uvcEnsureActive: false,
        _uvcEnsureFilterStart: false,
        _winterFrostActive: false,
        setFeatureCalls: [],
        evaluatePvSuerplusCalled: false,
        config: {
            timeWindows: [],
            pump_follow_up: 0,
            uvc_daily_min_h: 2,
            more_log_enabled: false,
        },
        log: {
            debug: () => {
            },
            info: () => {
            },
            warn: () => {
            },
            error: () => {
            },
        },
        enableRapidPolling() {
        },
        getUvcTodayHours() {
            return 3;
        },
        async evaluatePvSurplus() {
            this.evaluatePvSuerplusCalled = true;
        },
        ...overrides,
    };

    // Fehler-simulierendes setFeature (wirft wie main.js bei fromAutomation+unconfirmed)
    adapter.setFeatureThrows = async function (feature, val, opts) {
        this.setFeatureCalls.push({f: feature, v: val});
        throw new Error(`${feature} ${val} not confirmed by device after polling`);
    };

    // Normales setFeature (erfolgreich)
    adapter.setFeatureOk = async function (feature, val) {
        this.setFeatureCalls.push({f: feature, v: val});
    };

    // deactivateWindow – portiert aus main.js (vereinfacht, gleiche Logik)
    adapter.deactivateWindow = async function (w, i) {
        const pvHandlesHeater = w.pv_steu && (this._pvActive || this._pvStageTimer !== null);
        if (pvHandlesHeater) {
            this.evaluatePvSurplus().catch(() => {
            });
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

        const followUpMin = Number(this.config.pump_follow_up) || 0;
        const uvcMinH = this.config.uvc_daily_min_h ?? 2;
        const todayH = this.getUvcTodayHours();
        const uvcMinMet = todayH >= uvcMinH;

        try {
            if (!pvHandlesHeater && w.action_heating && !otherNeedsHeater) {
                await this.setFeature('heater', false, {fromAutomation: true});
            }

            if (w.action_uvc && !otherNeedsUvc) {
                if (uvcMinMet) {
                    await this.setFeature('uvc', false, {fromAutomation: true});
                } else {
                    this._timeWindowActive[i] = false;
                    this._filterStartedForUvc[i] = false;
                    this.enableRapidPolling();
                    return;
                }
            }

            if (otherNeedsFilter) {
                this._timeWindowActive[i] = false;
                this._filterStartedForUvc[i] = false;
                this.enableRapidPolling();
                return;
            }

            const isAllOff = !w.action_filter && !w.action_heating && !w.action_uvc;
            if (!isAllOff) {
                await this.setFeature('filter', false, {fromAutomation: true});
                this._filterStartedForUvc[i] = false;
            }

            this._timeWindowActive[i] = false;
            this.enableRapidPolling();
        } catch (err) {
            // _timeWindowActive[i] bleibt true → Retry nächste Minute
            this.log.error(`deactivation FAILED: ${err.message}`);
        }
    };

    return adapter;
}

function makeWindow(overrides = {}) {
    return {
        active: true,
        start: '10:00',
        end: '18:00',
        action_filter: true,
        action_heating: false,
        action_uvc: false,
        pv_steu: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Retry: heater OFF nicht bestätigt → _timeWindowActive bleibt true', () => {
    it('setFeature("heater", false) wirft → _timeWindowActive[0]=true (Retry nächste Minute)', async () => {
        const adapter = makeAdapter();
        adapter.setFeature = adapter.setFeatureThrows;
        adapter.config.timeWindows = [makeWindow({action_heating: true})];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive muss true bleiben wenn heater OFF nicht bestätigt wurde');
    });

    it('setFeature("heater", false) erfolgreich → _timeWindowActive[0]=false', async () => {
        const adapter = makeAdapter();
        adapter.setFeature = adapter.setFeatureOk;
        adapter.config.timeWindows = [makeWindow({action_heating: true})];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive muss false werden wenn Befehle bestätigt wurden');
    });
});

describe('Retry: filter OFF nicht bestätigt → _timeWindowActive bleibt true', () => {
    it('setFeature("filter", false) wirft → _timeWindowActive[0]=true (Retry)', async () => {
        const adapter = makeAdapter();
        // Heater schlägt auch fehl oder ist nicht vorhanden; nur filter ON/OFF
        adapter.setFeature = async (f, v, opts) => {
            adapter.setFeatureCalls.push({f, v});
            if (f === 'filter' && !v) {
                throw new Error('filter OFF not confirmed by device after polling');
            }
        };
        adapter.config.timeWindows = [makeWindow({action_filter: true})];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive muss true bleiben wenn filter OFF nicht bestätigt wurde');
    });
});

describe('Retry: UVC OFF nicht bestätigt → _timeWindowActive bleibt true', () => {
    it('setFeature("uvc", false) wirft → _timeWindowActive[0]=true (Retry)', async () => {
        const adapter = makeAdapter();
        adapter.setFeature = async (f, v, opts) => {
            adapter.setFeatureCalls.push({f, v});
            if (f === 'uvc' && !v) {
                throw new Error('uvc OFF not confirmed by device after polling');
            }
        };
        adapter.config.timeWindows = [makeWindow({action_uvc: true})];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive muss true bleiben wenn uvc OFF nicht bestätigt wurde');
    });
});

describe('Retry: mehrfach versuchen bis Erfolg', () => {
    it('1. Versuch schlägt fehl, 2. Versuch erfolgreich → _timeWindowActive=false', async () => {
        const adapter = makeAdapter();
        let callCount = 0;
        adapter.setFeature = async (f, v, opts) => {
            adapter.setFeatureCalls.push({f, v});
            callCount++;
            if (callCount === 1) {
                throw new Error('not confirmed (attempt 1)');
            }
            // Zweiter Aufruf erfolgreich
        };
        adapter.config.timeWindows = [makeWindow({action_heating: true})];
        adapter._timeWindowActive = [true];

        // Versuch 1: schlägt fehl
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);
        assert.strictEqual(adapter._timeWindowActive[0], true, 'Nach 1. Versuch: noch true');

        // Versuch 2: erfolgreich (simuliert nächste Minute checkTimeWindows)
        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);
        assert.strictEqual(adapter._timeWindowActive[0], false, 'Nach 2. Versuch: false');
    });
});

describe('Retry: PV-Fenster – filter OFF nicht bestätigt → Retry möglich', () => {
    it('pv_steu=true + filter OFF wirft → _timeWindowActive bleibt true für Retry', async () => {
        const adapter = makeAdapter({_pvActive: true});
        adapter.setFeature = async (f, v, opts) => {
            adapter.setFeatureCalls.push({f, v});
            if (f === 'filter' && !v) {
                throw new Error('filter OFF not confirmed');
            }
        };
        adapter.config.timeWindows = [makeWindow({pv_steu: true})];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._timeWindowActive[0], true,
            '_timeWindowActive muss true bleiben für Retry auch bei pv_steu');
        assert.strictEqual(adapter.evaluatePvSuerplusCalled, true,
            'evaluatePvSurplus muss trotzdem aufgerufen worden sein');
    });

    it('pv_steu=true + filter OFF erfolgreich → _timeWindowActive=false', async () => {
        const adapter = makeAdapter({_pvActive: true});
        adapter.setFeature = adapter.setFeatureOk;
        adapter.config.timeWindows = [makeWindow({pv_steu: true})];
        adapter._timeWindowActive = [true];

        await adapter.deactivateWindow(adapter.config.timeWindows[0], 0);

        assert.strictEqual(adapter._timeWindowActive[0], false,
            '_timeWindowActive muss false werden wenn filter OFF bestätigt');
    });
});
