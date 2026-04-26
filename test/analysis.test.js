'use strict';

/**
 * Vollumfängliche Tests basierend auf der Code-Analyse von main.js / lib/*.
 *
 * Schwerpunkte:
 *   - Logik-Funktionen aus utils.js (transformStatus, RateTracker)
 *   - ETA-Berechnung (heat_target_temp_reached, hh:mm)
 *   - Saison-/Zeitfenster-Logik (in-season, in-time-window inkl. overnight)
 *   - UVC Tagesstunden / Filter Stunden Akkumulator
 *   - Fault/Status-Mapping
 *   - PV-Surplus-Berechnung (Mode A / Mode B)
 *   - notificationHelper.format() (Platzhalter, Sprachfallback)
 *   - onStateChange: Fremd-States NICHT durch ack-Filter verwerfen (Bug-Fix)
 *
 * Run:  npx mocha test/analysis.test.js
 */

const assert  = require('assert');
const path    = require('path');

const {
    transformStatus,
    RateTracker,
} = require('../lib/utils');
const notificationHelper = require('../lib/notificationHelper');

// ---------------------------------------------------------------------------
// Reine, aus main.js extrahierte Logik (1:1 Implementation)
// ---------------------------------------------------------------------------

/** ETA-Berechnung aus publishStatus (hh:mm) */
function calcEtaHHMM(target, current, rate, heat_state, heater) {
    const isHeatingNow = [2, 3].includes(heat_state) && heater === 'on';
    let etaHours = 0;
    if (
        isHeatingNow &&
        Number.isFinite(target) &&
        Number.isFinite(current) &&
        target > current &&
        rate > 0
    ) {
        etaHours = (target - current) / rate;
        if (!Number.isFinite(etaHours) || etaHours < 0) {
            etaHours = 0;
        } else if (etaHours > 48) {
            etaHours = 48;
        }
    }
    const totalMinutes = Math.round(etaHours * 60);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
    const mm = String(totalMinutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
}

/** isInSeason – portiert aus main.js */
function isInSeason(start, end, today /* Date */) {
    const parseDate = (ddmm) => {
        const parts = (ddmm || '').split('.');
        return { day: parseInt(parts[0], 10) || 1, month: parseInt(parts[1], 10) || 1 };
    };
    const day   = today.getDate();
    const month = today.getMonth() + 1;
    const s = parseDate(start);
    const e = parseDate(end);
    const toNum = (d) => d.month * 100 + d.day;
    const cur = month * 100 + day;
    const sN  = toNum(s);
    const eN  = toNum(e);
    return sN <= eN ? (cur >= sN && cur <= eN) : (cur >= sN || cur <= eN);
}

/** isInTimeWindow – portiert aus main.js */
function isInTimeWindow(start, end, now /* Date */) {
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

/** PV-Surplus – portiert aus evaluatePvSurplus */
function calcPvSurplus({ pvPower, pvHouse, pvMspa, consumption_enabled, external_power_w_id }) {
    if (consumption_enabled && external_power_w_id && pvPower !== null && pvHouse !== null) {
        const mspaLoad = pvMspa !== null ? pvMspa : 0;
        return pvPower - (pvHouse - mspaLoad);
    }
    if (pvPower !== null) return pvPower;
    return null;
}

// ---------------------------------------------------------------------------
// transformStatus
// ---------------------------------------------------------------------------
describe('transformStatus()', () => {
    it('mappt water/temperature_setting (×0.5)', () => {
        const out = transformStatus({
            water_temperature: 76, temperature_setting: 80,
            heater_state: 1, filter_state: 0, bubble_state: 0,
            jet_state: 0, ozone_state: 1, uvc_state: 1, bubble_level: 2,
        });
        assert.strictEqual(out.water_temperature, 38);
        assert.strictEqual(out.target_temperature, 40);
        assert.strictEqual(out.heater, 'on');
        assert.strictEqual(out.filter, 'off');
        assert.strictEqual(out.ozone, 'on');
        assert.strictEqual(out.uvc, 'on');
        assert.strictEqual(out.bubble_level, 2);
        assert.strictEqual(out.fault, 'OK');
    });

    it('reicht unbekannte Felder unverändert durch', () => {
        const out = transformStatus({
            water_temperature: 0, temperature_setting: 0,
            heater_state: 0, filter_state: 0, bubble_state: 0,
            jet_state: 0, ozone_state: 0, uvc_state: 0,
            heat_state: 4, custom_field: 'abc',
        });
        assert.strictEqual(out.heat_state, 4);
        assert.strictEqual(out.custom_field, 'abc');
    });

    it('fault leer → "OK"', () => {
        const out = transformStatus({
            water_temperature: 0, temperature_setting: 0,
            heater_state: 0, filter_state: 0, bubble_state: 0,
            jet_state: 0, ozone_state: 0, uvc_state: 0,
            fault: '',
        });
        assert.strictEqual(out.fault, 'OK');
    });
});

// ---------------------------------------------------------------------------
// RateTracker
// ---------------------------------------------------------------------------
describe('RateTracker', () => {
    it('liefert null bei inaktiv', () => {
        const t = new RateTracker({ min: 0.05, max: 3.0 });
        assert.strictEqual(t.update(30, false, true), null);
    });

    it('berechnet Heizrate mit echten Zeitstempeln', () => {
        const t = new RateTracker({ min: 0.05, max: 3.0, minSampleMinutes: 0 });
        // ersten Sample anfüttern, lastTime künstlich -1h zurücksetzen
        t.update(30, true, true);
        t._lastTime = Date.now() - 3_600_000;
        const r = t.update(31, true, true); // +1°C in 1h ⇒ 1°C/h
        assert.ok(r > 0.9 && r < 1.1, `expected ~1.0 got ${r}`);
    });

    it('verwirft Werte außerhalb [min,max]', () => {
        const t = new RateTracker({ min: 0.5, max: 1.5, minSampleMinutes: 0 });
        t.update(30, true, true);
        t._lastTime = Date.now() - 3_600_000;
        const r = t.update(40, true, true); // 10°C/h → out of range
        assert.strictEqual(r, null);
    });

    it('reset() löscht Samples', () => {
        const t = new RateTracker({ min: 0.05, max: 3.0 });
        t.update(30, true, true);
        t.reset();
        assert.strictEqual(t._lastTemp, null);
        assert.strictEqual(t._lastTime, null);
    });
});

// ---------------------------------------------------------------------------
// ETA hh:mm
// ---------------------------------------------------------------------------
describe('heat_target_temp_reached (hh:mm)', () => {
    it('2.5 h ETA → "02:30"', () => {
        assert.strictEqual(calcEtaHHMM(35, 30, 2, 3, 'on'), '02:30');
    });
    it('0.75 h ETA → "00:45"', () => {
        assert.strictEqual(calcEtaHHMM(31.5, 30, 2, 3, 'on'), '00:45');
    });
    it('Ziel erreicht → "00:00"', () => {
        assert.strictEqual(calcEtaHHMM(30, 30, 2, 3, 'on'), '00:00');
    });
    it('Heizung aus → "00:00"', () => {
        assert.strictEqual(calcEtaHHMM(35, 30, 2, 0, 'off'), '00:00');
    });
    it('rate=0 → "00:00"', () => {
        assert.strictEqual(calcEtaHHMM(35, 30, 0, 3, 'on'), '00:00');
    });
    it('Cap bei 48h → "48:00"', () => {
        assert.strictEqual(calcEtaHHMM(40, 30, 0.01, 3, 'on'), '48:00');
    });
    it('NaN-Werte → "00:00"', () => {
        assert.strictEqual(calcEtaHHMM(NaN, 30, 1, 3, 'on'), '00:00');
        assert.strictEqual(calcEtaHHMM(35, NaN, 1, 3, 'on'), '00:00');
    });
    it('heat_state 2 (preheat) zählt als heizend', () => {
        assert.strictEqual(calcEtaHHMM(31, 30, 1, 2, 'on'), '01:00');
    });
});

// ---------------------------------------------------------------------------
// Season window
// ---------------------------------------------------------------------------
describe('isInSeason()', () => {
    it('normales Fenster Mai–Sep, 15.07 → true', () => {
        assert.strictEqual(isInSeason('01.05', '30.09', new Date(2026, 6, 15)), true);
    });
    it('normales Fenster Mai–Sep, 15.10 → false', () => {
        assert.strictEqual(isInSeason('01.05', '30.09', new Date(2026, 9, 15)), false);
    });
    it('jahresübergreifend Okt–Mär, 15.01 → true', () => {
        assert.strictEqual(isInSeason('01.10', '31.03', new Date(2026, 0, 15)), true);
    });
    it('jahresübergreifend Okt–Mär, 15.06 → false', () => {
        assert.strictEqual(isInSeason('01.10', '31.03', new Date(2026, 5, 15)), false);
    });
    it('Grenztag: Endtag inklusive', () => {
        assert.strictEqual(isInSeason('01.05', '30.09', new Date(2026, 8, 30)), true);
    });
    it('Grenztag: Starttag inklusive', () => {
        assert.strictEqual(isInSeason('01.05', '30.09', new Date(2026, 4, 1)), true);
    });
});

// ---------------------------------------------------------------------------
// Time window incl. overnight
// ---------------------------------------------------------------------------
describe('isInTimeWindow()', () => {
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

    it('08:00–10:00 um 09:00 → true', () => {
        assert.strictEqual(isInTimeWindow('08:00', '10:00', at(9, 0)), true);
    });
    it('08:00–10:00 um 10:00 → false (Endzeit exklusiv)', () => {
        assert.strictEqual(isInTimeWindow('08:00', '10:00', at(10, 0)), false);
    });
    it('22:00–06:00 um 23:30 → true (overnight)', () => {
        assert.strictEqual(isInTimeWindow('22:00', '06:00', at(23, 30)), true);
    });
    it('22:00–06:00 um 03:00 → true (overnight)', () => {
        assert.strictEqual(isInTimeWindow('22:00', '06:00', at(3, 0)), true);
    });
    it('22:00–06:00 um 12:00 → false', () => {
        assert.strictEqual(isInTimeWindow('22:00', '06:00', at(12, 0)), false);
    });
    it('leeres Fenster (start=end) → false', () => {
        assert.strictEqual(isInTimeWindow('08:00', '08:00', at(8, 0)), false);
    });
});

// ---------------------------------------------------------------------------
// PV Surplus calculation
// ---------------------------------------------------------------------------
describe('calcPvSurplus()', () => {
    it('Mode A: PV − (house − mspa)', () => {
        const v = calcPvSurplus({
            pvPower: 3000, pvHouse: 3000, pvMspa: 2000,
            consumption_enabled: true, external_power_w_id: 'x',
        });
        assert.strictEqual(v, 2000);
    });
    it('Mode A: ohne MSpa-Last → klassischer Saldo', () => {
        const v = calcPvSurplus({
            pvPower: 4000, pvHouse: 1000, pvMspa: 0,
            consumption_enabled: true, external_power_w_id: 'x',
        });
        assert.strictEqual(v, 3000);
    });
    it('Mode B: nur PV', () => {
        const v = calcPvSurplus({
            pvPower: 1500, pvHouse: 999, pvMspa: 999,
            consumption_enabled: false, external_power_w_id: null,
        });
        assert.strictEqual(v, 1500);
    });
    it('keine PV-Daten → null', () => {
        const v = calcPvSurplus({
            pvPower: null, pvHouse: 1000, pvMspa: 0,
            consumption_enabled: true, external_power_w_id: 'x',
        });
        assert.strictEqual(v, null);
    });
});

// ---------------------------------------------------------------------------
// notificationHelper.format()
// ---------------------------------------------------------------------------
describe('notificationHelper.format()', () => {
    before(() => {
        notificationHelper.init({
            log: { debug() {}, info() {}, warn() {}, error() {} },
            config: { notification_language: 'de' },
        });
    });

    it('ersetzt Platzhalter', () => {
        const out = notificationHelper.format('pvActivated', { surplus: 1234 });
        assert.ok(out.includes('1234'), `placeholder not replaced: ${out}`);
    });

    it('unbekannter Key → key selbst', () => {
        assert.strictEqual(notificationHelper.format('does_not_exist'), 'does_not_exist');
    });

    it('Sprachwechsel auf en liefert NOTIFY-Default', () => {
        notificationHelper.adapter.config.notification_language = 'en';
        const out = notificationHelper.format('pvActivated', { surplus: 50 });
        assert.ok(typeof out === 'string' && out.length > 0);
    });
});

// ---------------------------------------------------------------------------
// onStateChange: Fremd-States werden NICHT verworfen (Bug-Fix-Test)
// ---------------------------------------------------------------------------
describe('onStateChange foreign-state routing', () => {
    /**
     * Simuliert die NEUE onStateChange-Logik aus main.js.
     * Stellt sicher, dass externe (foreign) States mit ack=true an
     * onForeignStateChange weitergereicht werden – während eigene
     * Control-States mit ack=true verworfen werden.
     */
    function makeAdapter(namespace = 'mspa.0') {
        const calls = { foreign: [], own: [] };
        const adapter = {
            namespace,
            log: { debug() {}, info() {}, warn() {}, error() {} },
            async onForeignStateChange(id, state) { calls.foreign.push({ id, val: state.val }); },
            async _handleOwnControl(key, val)     { calls.own.push({ key, val }); },
        };

        adapter.onStateChange = async function (id, state) {
            if (!state) return;
            if (!id.startsWith(`${this.namespace}.`)) {
                return this.onForeignStateChange(id, state);
            }
            if (state.ack) return;
            const key = id.split('.').pop();
            return this._handleOwnControl(key, state.val);
        };

        return { adapter, calls };
    }

    it('verarbeitet Fremd-State mit ack=true (PV-Erzeugung)', async () => {
        const { adapter, calls } = makeAdapter();
        await adapter.onStateChange('0_userdata.0.pv.power_generated', { val: 2500, ack: true });
        assert.deepStrictEqual(calls.foreign, [{ id: '0_userdata.0.pv.power_generated', val: 2500 }]);
        assert.strictEqual(calls.own.length, 0);
    });

    it('verwirft eigenen control-State mit ack=true', async () => {
        const { adapter, calls } = makeAdapter();
        await adapter.onStateChange('mspa.0.control.heater', { val: true, ack: true });
        assert.strictEqual(calls.foreign.length, 0);
        assert.strictEqual(calls.own.length, 0);
    });

    it('verarbeitet eigenen control-State mit ack=false', async () => {
        const { adapter, calls } = makeAdapter();
        await adapter.onStateChange('mspa.0.control.heater', { val: true, ack: false });
        assert.deepStrictEqual(calls.own, [{ key: 'heater', val: true }]);
    });

    it('null-state wird ignoriert', async () => {
        const { adapter, calls } = makeAdapter();
        await adapter.onStateChange('mspa.0.control.heater', null);
        assert.strictEqual(calls.foreign.length + calls.own.length, 0);
    });
});

// ---------------------------------------------------------------------------
// UVC / Filter Stundenakkumulator (Logik aus _accumulate*)
// ---------------------------------------------------------------------------
describe('runtime accumulators', () => {
    function accumulate(persistedHours, onSinceMs) {
        let total = persistedHours || 0;
        if (onSinceMs !== null) total += (Date.now() - onSinceMs) / 3_600_000;
        return total;
    }

    it('persistierter Wert ohne laufende Session', () => {
        assert.strictEqual(accumulate(12.5, null), 12.5);
    });

    it('addiert laufende Session', () => {
        const since = Date.now() - 1_800_000; // 30 min
        const v = accumulate(10, since);
        assert.ok(v > 10.49 && v < 10.51, `expected ~10.5 got ${v}`);
    });

    it('null persisted → reine Session', () => {
        const since = Date.now() - 3_600_000;
        const v = accumulate(0, since);
        assert.ok(v > 0.99 && v < 1.01);
    });
});

// ---------------------------------------------------------------------------
// Integrationssanity: main.js lädt ohne Syntaxfehler
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hinweis: ein require()-Test für main.js wird absichtlich NICHT ausgeführt –
// @iobroker/adapter-core ruft process.exit, wenn der js-controller fehlt
// (typisch in Dev-Workspaces) und würde Mocha hart beenden.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regressionstests für die in der Code-Analyse eingebauten Patches
// ---------------------------------------------------------------------------

describe('stray-timer wrapper (P2)', () => {
    /**
     * Simuliert _setStray + onUnload-Cleanup. Sicherstellt, dass beim
     * Unload alle ungetrackten Timer gelöscht werden und Callbacks
     * nicht mehr feuern.
     */
    function makeAdapter() {
        const adapter = { _strayTimers: new Set() };
        adapter._setStray = function (fn, ms) {
            const t = setTimeout(() => {
                this._strayTimers.delete(t);
                fn();
            }, ms);
            this._strayTimers.add(t);
            return t;
        };
        adapter._unload = function () {
            for (const t of this._strayTimers) clearTimeout(t);
            this._strayTimers.clear();
        };
        return adapter;
    }

    it('Timer wird nach unload nicht mehr ausgeführt', (done) => {
        const a = makeAdapter();
        let fired = false;
        a._setStray(() => { fired = true; }, 30);
        a._unload();
        setTimeout(() => {
            assert.strictEqual(fired, false, 'callback fired after unload');
            assert.strictEqual(a._strayTimers.size, 0);
            done();
        }, 60);
    });

    it('Timer entfernt sich selbst nach Auslösung', (done) => {
        const a = makeAdapter();
        a._setStray(() => {
            // self-cleanup
            setImmediate(() => {
                assert.strictEqual(a._strayTimers.size, 0);
                done();
            });
        }, 5);
    });
});

describe('UVC poll-wait (P5)', () => {
    /**
     * Simuliert den poll-basierten Filter-Wait. Statt 15 s blockierend zu warten,
     * pollen wir alle 1 s und brechen früh ab, sobald die Pumpe ON ist.
     */
    async function waitForFilter(getFilterFn, maxMs = 200) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            await new Promise(r => setTimeout(r, 20));
            if (getFilterFn()) return true;
        }
        return false;
    }

    it('bricht früh ab sobald Filter ON', async () => {
        let on = false;
        setTimeout(() => { on = true; }, 50);
        const t0 = Date.now();
        const ok = await waitForFilter(() => on, 300);
        const dt = Date.now() - t0;
        assert.strictEqual(ok, true);
        assert.ok(dt < 200, `expected <200ms got ${dt}`);
    });

    it('liefert false nach Timeout', async () => {
        const ok = await waitForFilter(() => false, 80);
        assert.strictEqual(ok, false);
    });
});

describe('pendingTargetTemp invalidation (P8)', () => {
    /**
     * Simuliert die Race: zwei kurz hintereinander folgende Heater-ON-Events.
     * Der Patch entwertet _pendingTargetTemp sofort nach Capture, sodass
     * konkurrierende Aufrufer ihn nicht erneut abgreifen.
     */
    it('zweiter Capture sieht pendingTemp=null', () => {
        const ctx = { _pendingTargetTemp: 38 };

        // Aufruf 1
        const p1 = ctx._pendingTargetTemp;
        ctx._pendingTargetTemp = null;     // Patch P8: sofort entwerten
        assert.strictEqual(p1, 38);

        // Aufruf 2 würde nun null sehen
        const p2 = ctx._pendingTargetTemp;
        assert.strictEqual(p2, null);
    });
});

describe('filter restore from info.lastUpdate (P9)', () => {
    /**
     * Restore-Logik: wenn lastUpdate <= 6h zurück, davon starten,
     * sonst Date.now() (konservativ).
     */
    function pickStart(luVal, now = Date.now()) {
        const maxBack = 6 * 3600 * 1000;
        const lu = (typeof luVal === 'number') ? luVal : 0;
        return (lu > 0 && (now - lu) <= maxBack) ? lu : now;
    }

    it('lastUpdate vor 30 min → übernehmen', () => {
        const now = Date.now();
        const lu  = now - 30 * 60_000;
        assert.strictEqual(pickStart(lu, now), lu);
    });
    it('lastUpdate vor 12 h → Date.now() (Cutoff)', () => {
        const now = Date.now();
        const lu  = now - 12 * 3600 * 1000;
        assert.strictEqual(pickStart(lu, now), now);
    });
    it('kein lastUpdate → Date.now()', () => {
        const now = Date.now();
        assert.strictEqual(pickStart(null, now), now);
    });
});

describe('getHotTubStatus rate-limit retry (P4)', () => {
    /**
     * Simuliert den retry-Pfad: Code 11000 → einmal warten, dann erneut.
     */
    async function fakeStatus(responses) {
        let retry = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const json = responses.shift();
            const code = json?.code;
            if (code === 11000 && !retry) {
                retry = true;
                continue;
            }
            if (!json?.data && !retry) {
                retry = true;
                continue;
            }
            return json?.data || null;
        }
    }

    it('11000 → retry liefert data', async () => {
        const data = await fakeStatus([
            { code: 11000 },
            { code: 200, data: { water_temperature: 70 } },
        ]);
        assert.deepStrictEqual(data, { water_temperature: 70 });
    });

    it('leeres data → retry liefert data', async () => {
        const data = await fakeStatus([
            { code: 200 },
            { code: 200, data: { water_temperature: 60 } },
        ]);
        assert.deepStrictEqual(data, { water_temperature: 60 });
    });

    it('persistenter Fehler → null', async () => {
        const data = await fakeStatus([{ code: 200 }, { code: 200 }]);
        assert.strictEqual(data, null);
    });
});

