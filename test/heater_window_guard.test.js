'use strict';

/**
 * Tests: Ist sichergestellt dass die Heizung NUR im Zeitfenster aktiv ist?
 *
 * Geprüfte Szenarien:
 *   A. Normale checkTimeWindows-Aktivierung (nur in-window)
 *   B. Normale checkTimeWindows-Deaktivierung (bei Fenster-Ende)
 *   C. deactivateWindow – Heizung ZUERST aus, dann UVC-Early-Return
 *   D. Saison-Guard: außerhalb der Saison kein Heizungs-Einschalten
 *   E. Manual-Override-Guard: während Override kein Einschalten
 *   F. _resumeAfterOverride – Heizung nur einschalten wenn Fenster aktiv
 *   G. restoreSavedState [Bug-Fix]: Heizung nicht außerhalb des Fensters wiederherstellen
 *   H. Power-Cycle: heater bleibt aus wenn kein Fenster aktiv und Season disabled
 *   I. checkStartupDeviceState: Heizung beim Start abschalten wenn kein Fenster aktiv
 *   J. Overlap-Guard: Heizung bleibt an wenn anderes Fenster sie noch benötigt
 *
 * Run:  npx mocha test/heater_window_guard.test.js --no-config
 */

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

// ---------------------------------------------------------------------------
// Inlinierte Logik-Funktionen (1:1 aus main.js, ohne adapter-core zu booten)
// ---------------------------------------------------------------------------

/** isInTimeWindow aus main.js */
function isInTimeWindow(start, end, now) {
    const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = toMin(start), e = toMin(end);
    if (s === e) return false;
    if (s < e)  return cur >= s && cur < e;
    return cur >= s || cur < e;
}

/** isInSeason aus main.js */
function isInSeason(startDDMM, endDDMM, today, seasonEnabled) {
    if (!seasonEnabled) return false;
    const parse = str => { const p = (str||'').split('.'); return { day: parseInt(p[0])||1, month: parseInt(p[1])||1 }; };
    const s = parse(startDDMM), e = parse(endDDMM);
    const cur  = today.getMonth()+1, day = today.getDate();
    const toN = d => d.month*100+d.day;
    const c = cur*100+day, sN = toN(s), eN = toN(e);
    return sN <= eN ? (c >= sN && c <= eN) : (c >= sN || c <= eN);
}

/**
 * Simuliert checkTimeWindows für ein einzelnes Fenster.
 * Gibt zurück: 'activate' | 'deactivate' | 'skip-pv' | 'none' | 'season-blocked'
 */
function simulateCheckTimeWindow(w, {
    now, wasIn, seasonEnabled, seasonStart, seasonEnd, manualOverride
}) {
    if (manualOverride) return 'none';
    if (!isInSeason(seasonStart, seasonEnd, now, seasonEnabled)) return 'season-blocked';
    if (!w.active) return 'none';
    const dayKeys = ['day_sun','day_mon','day_tue','day_wed','day_thu','day_fri','day_sat'];
    const dayOn = !!w[dayKeys[now.getDay()]];
    const inWin = dayOn && isInTimeWindow(w.start, w.end, now);
    if (inWin && !wasIn) return w.pv_steu ? 'skip-pv' : 'activate';
    if (!inWin && wasIn) return 'deactivate';
    return 'none';
}

/**
 * Simuliert deactivateWindow: gibt zurück was abgeschaltet wird.
 */
function simulateDeactivateWindow(w, { otherNeedsHeater = false, otherNeedsUvc = false, uvcMinMet = true } = {}) {
    const actions = [];
    if (w.action_heating && !otherNeedsHeater) actions.push('heater-off');
    if (w.action_uvc && !otherNeedsUvc) {
        if (uvcMinMet) actions.push('uvc-off');
        else { return { actions, earlyReturn: true }; }  // heater already off
    }
    if (w.action_filter || w.action_heating) actions.push('filter-off');
    return { actions, earlyReturn: false };
}

/**
 * Simuliert die restoreSavedState-Guard-Logik aus main.js.
 */
function simulateRestoreGuard({
    savedState, windows, timeWindowActive, pvActive, seasonEnabled, winterModeActive
}) {
    const hasHeatingWindows = Array.isArray(windows) && windows.some(w => w.active && w.action_heating);

    let allowHeaterRestore = true;
    if (hasHeatingWindows && !pvActive) {
        const heatingWindowActiveNow = Array.isArray(windows) && windows.some((w, i) =>
            w.active && w.action_heating && timeWindowActive[i]
        );
        if (!heatingWindowActiveNow) {
            allowHeaterRestore = false;
        }
    }
    if (!seasonEnabled && !winterModeActive) {
        allowHeaterRestore = false;
    }

    const restored = [];
    for (const feature of ['heater', 'filter', 'ozone', 'uvc', 'bubble']) {
        if (savedState[feature] === 'on') {
            if (feature === 'heater' && !allowHeaterRestore) continue;
            restored.push(feature);
        }
    }
    return { restored, allowHeaterRestore };
}

// ---------------------------------------------------------------------------
// A. Normale Aktivierung – nur in-window
// ---------------------------------------------------------------------------
describe('A. checkTimeWindows – Heizung nur in-window einschalten', () => {
    const W = { active: true, start: '10:00', end: '18:00', action_heating: true, action_filter: true,
                day_mon: true, day_tue: true, day_wed: true, day_thu: true, day_fri: true,
                day_sat: true, day_sun: true };
    const season = { start: '01.01', end: '31.12', enabled: true };

    it('Mitte des Fensters (14:00) → aktivieren', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: season.enabled, seasonStart: season.start, seasonEnd: season.end,
        });
        assert.strictEqual(r, 'activate');
    });

    it('Außerhalb des Fensters (09:00) → kein Einschalten', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T09:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: season.enabled, seasonStart: season.start, seasonEnd: season.end,
        });
        assert.strictEqual(r, 'none');
    });

    it('Genau an der Fenster-Grenze Ende (18:00 = exklusiv) → kein Einschalten', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T18:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: season.enabled, seasonStart: season.start, seasonEnd: season.end,
        });
        assert.strictEqual(r, 'none');
    });
});

// ---------------------------------------------------------------------------
// B. Deaktivierung beim Fenster-Ende
// ---------------------------------------------------------------------------
describe('B. checkTimeWindows – Heizung bei Fenster-Ende abschalten', () => {
    const W = { active: true, start: '10:00', end: '18:00', action_heating: true, action_filter: true,
                day_mon: true, day_tue: true, day_wed: true, day_thu: true, day_fri: true,
                day_sat: true, day_sun: true };
    const season = { start: '01.01', end: '31.12', enabled: true };

    it('Nach Fenster-Ende (19:00, wasIn=true) → deactivate', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T19:00:00'), wasIn: true, manualOverride: false,
            seasonEnabled: season.enabled, seasonStart: season.start, seasonEnd: season.end,
        });
        assert.strictEqual(r, 'deactivate');
    });

    it('Fenster läuft noch (15:00, wasIn=true) → kein deactivate', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T15:00:00'), wasIn: true, manualOverride: false,
            seasonEnabled: season.enabled, seasonStart: season.start, seasonEnd: season.end,
        });
        assert.strictEqual(r, 'none');
    });
});

// ---------------------------------------------------------------------------
// C. deactivateWindow – Heizung ZUERST aus vor UVC-Early-Return
// ---------------------------------------------------------------------------
describe('C. deactivateWindow – Reihenfolge: heater zuerst, dann UVC-Early-Return', () => {
    it('UVC-Minimum nicht erreicht: heater wird VOR dem Early-Return abgeschaltet', () => {
        const { actions, earlyReturn } = simulateDeactivateWindow(
            { action_heating: true, action_filter: true, action_uvc: true },
            { uvcMinMet: false }
        );
        assert.strictEqual(earlyReturn, true,   'Early-Return muss stattfinden');
        assert.ok(actions.includes('heater-off'), 'Heizung muss VOR Early-Return aus sein');
        assert.ok(!actions.includes('uvc-off'),   'UVC bleibt wegen Minimum an');
    });

    it('UVC-Minimum erreicht: heater + UVC + filter werden abgeschaltet', () => {
        const { actions, earlyReturn } = simulateDeactivateWindow(
            { action_heating: true, action_filter: true, action_uvc: true },
            { uvcMinMet: true }
        );
        assert.strictEqual(earlyReturn, false);
        assert.ok(actions.includes('heater-off'), 'heater OFF');
        assert.ok(actions.includes('uvc-off'),    'uvc OFF');
        assert.ok(actions.includes('filter-off'), 'filter OFF');
    });

    it('Fenster ohne UVC: heater + filter abschalten', () => {
        const { actions } = simulateDeactivateWindow(
            { action_heating: true, action_filter: true, action_uvc: false }
        );
        assert.ok(actions.includes('heater-off'), 'heater OFF');
        assert.ok(!actions.includes('uvc-off'),   'kein UVC-Off ohne action_uvc');
        assert.ok(actions.includes('filter-off'), 'filter OFF');
    });
});

// ---------------------------------------------------------------------------
// D. Saison-Guard
// ---------------------------------------------------------------------------
describe('D. Saison-Guard – keine Aktivierung außerhalb der Saison', () => {
    const W = { active: true, start: '10:00', end: '18:00', action_heating: true, action_filter: true,
                day_mon: true, day_tue: true, day_wed: true, day_thu: true, day_fri: true,
                day_sat: true, day_sun: true };

    it('Saison deaktiviert → season-blocked', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: false, seasonStart: '01.05', seasonEnd: '30.09',
        });
        assert.strictEqual(r, 'season-blocked');
    });

    it('Außerhalb Saisons-Datumsbereich → season-blocked', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-10-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.05', seasonEnd: '30.09',
        });
        assert.strictEqual(r, 'season-blocked');
    });

    it('Innerhalb der Saison → activate', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.05', seasonEnd: '30.09',
        });
        assert.strictEqual(r, 'activate');
    });
});

// ---------------------------------------------------------------------------
// E. Manual-Override-Guard
// ---------------------------------------------------------------------------
describe('E. Manual-Override-Guard', () => {
    const W = { active: true, start: '10:00', end: '18:00', action_heating: true, action_filter: true,
                day_mon: true, day_tue: true, day_wed: true, day_thu: true, day_fri: true,
                day_sat: true, day_sun: true };

    it('manualOverride=true → kein Einschalten', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: true,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'none');
    });

    it('manualOverride=false → normales Einschalten', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'activate');
    });
});

// ---------------------------------------------------------------------------
// F. _resumeAfterOverride – Heizung nur einschalten wenn Fenster aktiv
// ---------------------------------------------------------------------------
describe('F. _resumeAfterOverride – Heizung korrekt nach Override', () => {
    const W = { active: true, start: '10:00', end: '18:00', action_heating: true, action_filter: true,
                day_mon: true, day_tue: true, day_wed: true, day_thu: true, day_fri: true,
                day_sat: true, day_sun: true };

    it('Override endet während Fenster aktiv (wasIn=false, inWin=true) → Heizung wird eingeschaltet', () => {
        // Während Override lief, startete das Fenster → _timeWindowActive[i]=false
        // Nach Override: checkTimeWindows sieht inWin=true, wasIn=false → activate
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'activate', 'Fenster ist aktiv → Einschalten korrekt');
    });

    it('Override endet nach Fenster-Ende (wasIn=false, inWin=false) → kein Einschalten', () => {
        // Fenster lief während des Overrides, endete auch während Override
        // → _timeWindowActive[i] blieb false während des Overrides
        // → Nach Override: inWin=false, wasIn=false → keine Aktion
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T19:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'none', 'Fenster ist schon abgelaufen → kein Einschalten');
    });

    it('Override endet, Fenster war aktiv (wasIn=true, inWin=false) → deactivate', () => {
        // Fenster war aktiv als Override gesetzt wurde (_timeWindowActive blieb true)
        // Fenster endete während Override → After Override: inWin=false, wasIn=true → deactivate
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T19:00:00'), wasIn: true, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'deactivate', 'Fenster endete während Override → deactivate');
    });
});

// ---------------------------------------------------------------------------
// G. restoreSavedState – Heizung NICHT außerhalb des Zeitfensters wiederherstellen
// ---------------------------------------------------------------------------
describe('G. restoreSavedState – Heizungs-Guard [Bug-Fix]', () => {

    const savedOn = { heater: 'on', filter: 'on', uvc: 'off', ozone: 'off', bubble: 'off' };

    it('kein Heizfenster aktiv → Heizung wird NICHT wiederhergestellt', () => {
        const windows = [{ active: true, action_heating: true, action_filter: true }];
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows,
            timeWindowActive: [false],   // kein Fenster gerade aktiv
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(!restored.includes('heater'),
            'Heizung darf NICHT wiederhergestellt werden wenn kein Fenster aktiv');
    });

    it('Heizfenster ist aktiv → Heizung WIRD wiederhergestellt', () => {
        const windows = [{ active: true, action_heating: true, action_filter: true }];
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows,
            timeWindowActive: [true],    // Fenster läuft gerade
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(restored.includes('heater'),
            'Heizung MUSS wiederhergestellt werden wenn Fenster aktiv ist');
    });

    it('PV aktiv → Heizung WIRD wiederhergestellt (PV übernimmt Kontrolle)', () => {
        const windows = [{ active: true, action_heating: true, action_filter: true }];
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows,
            timeWindowActive: [false],
            pvActive: true,              // PV ist aktiv
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(restored.includes('heater'),
            'Heizung MUSS bei aktivem PV wiederhergestellt werden');
    });

    it('Saison deaktiviert und kein Winter → Heizung NICHT wiederherstellen', () => {
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows: [],
            timeWindowActive: [],
            pvActive: false,
            seasonEnabled: false,
            winterModeActive: false,
        });
        assert.ok(!restored.includes('heater'),
            'Heizung darf bei deaktivierter Saison nicht wiederhergestellt werden');
    });

    it('Saison deaktiviert ABER Winter-Mode → Heizung DARF wiederhergestellt werden', () => {
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows: [],
            timeWindowActive: [],
            pvActive: false,
            seasonEnabled: false,
            winterModeActive: true,      // Frost-Schutz aktiv
        });
        assert.ok(restored.includes('heater'),
            'Frost-Schutz-Modus: Heizung darf wiederhergestellt werden');
    });

    it('Keine Heizfenster konfiguriert → Heizung WIRD immer wiederhergestellt (user-only Modus)', () => {
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows: [{ active: true, action_filter: true, action_heating: false }], // kein Heizfenster
            timeWindowActive: [false],
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        // hasHeatingWindows=false → Guard greift nicht
        assert.ok(restored.includes('heater'),
            'Ohne Heizfenster-Config: Heizung immer wiederherstellen (Nutzer verwaltet manuell)');
    });

    it('Filter wird immer wiederhergestellt (unabhängig vom Heizungs-Guard)', () => {
        const windows = [{ active: true, action_heating: true, action_filter: true }];
        const { restored } = simulateRestoreGuard({
            savedState: savedOn,
            windows,
            timeWindowActive: [false],   // kein Fenster aktiv – Heizung gesperrt
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(!restored.includes('heater'), 'Heizung gesperrt');
        assert.ok(restored.includes('filter'),  'Filter wird dennoch wiederhergestellt');
    });

    it('Szenario: Stromausfall 14:30 (Fenster 10-18), Neustart 19:00 → Heizung BLEIBT aus', () => {
        const windows = [{ active: true, action_heating: true, action_filter: true,
            start: '10:00', end: '18:00' }];
        // Bei 19:00 ist das Fenster abgelaufen → _timeWindowActive[0]=false
        const { restored } = simulateRestoreGuard({
            savedState: { heater: 'on', filter: 'on' },
            windows,
            timeWindowActive: [false],   // isInTimeWindow('10:00','18:00') = false um 19:00
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(!restored.includes('heater'), 'Heizung MUSS nach Fenster-Ende gesperrt bleiben');
        assert.ok(restored.includes('filter'),  'Filter darf wiederhergestellt werden');
    });

    it('Szenario: Stromausfall 14:30 (Fenster 10-18), Neustart 15:00 → Heizung WIRD wiederhergestellt', () => {
        const windows = [{ active: true, action_heating: true, action_filter: true,
            start: '10:00', end: '18:00' }];
        // Bei 15:00 ist das Fenster noch aktiv → _timeWindowActive[0]=true
        const { restored } = simulateRestoreGuard({
            savedState: { heater: 'on', filter: 'on' },
            windows,
            timeWindowActive: [true],    // Fenster läuft
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(restored.includes('heater'), 'Heizung MUSS innerhalb des Fensters wiederhergestellt werden');
    });
});

// ---------------------------------------------------------------------------
// H. Power-Cycle + Season Guard
// ---------------------------------------------------------------------------
describe('H. restoreSavedState – Saison-Guard verhindert Heizungs-Einschalten', () => {
    it('Saison aus: Heizung bleibt aus nach Power-Cycle', () => {
        const { restored } = simulateRestoreGuard({
            savedState: { heater: 'on', filter: 'on' },
            windows: [],
            timeWindowActive: [],
            pvActive: false,
            seasonEnabled: false,
            winterModeActive: false,
        });
        assert.ok(!restored.includes('heater'));
    });

    it('Saison an, Fenster aktiv: Heizung einschalten nach Power-Cycle', () => {
        const { restored } = simulateRestoreGuard({
            savedState: { heater: 'on', filter: 'on' },
            windows: [{ active: true, action_heating: true }],
            timeWindowActive: [true],
            pvActive: false,
            seasonEnabled: true,
            winterModeActive: false,
        });
        assert.ok(restored.includes('heater'));
    });
});

// ---------------------------------------------------------------------------
// I. checkStartupDeviceState – Quelltext-Prüfung
// ---------------------------------------------------------------------------
describe('I. checkStartupDeviceState – Quelltext-Audit', () => {
    it('main.js: checkStartupDeviceState schaltet Heizung aus wenn kein Fenster aktiv', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/startupCheck.js'), 'utf8');
        assert.ok(
            src.includes('heaterOn && anyWindowManagesHeater'),
            'checkStartupDeviceState muss Heizung abschalten wenn kein Fenster aktiv'
        );
        assert.ok(
            src.includes("setFeature(adapter, 'heater', false, {fromAutomation: true})"),
            'Heizungs-Abschalten muss fromAutomation:true haben'
        );
    });

    it('main.js: restoreSavedState enthält allowHeaterRestore-Guard', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/powerCycle.js'), 'utf8');
        assert.ok(
            src.includes('allowHeaterRestore'),
            'restoreSavedState muss allowHeaterRestore-Guard enthalten'
        );
        assert.ok(
            src.includes('heatingWindowActiveNow'),
            'Guard muss prüfen ob ein Heizfenster gerade aktiv ist'
        );
    });

    it('main.js: restoreSavedState ruft checkTimeWindows zur Reconciliation auf', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/powerCycle.js'), 'utf8');
        // Suche nach checkTimeWindows im restoreSavedState-Kontext
        const restoreIdx = src.indexOf('async function restoreSavedState');
        assert.ok(restoreIdx !== -1, 'restoreSavedState-Funktion muss in lib/powerCycle.js existieren');
        const restoreBlock = src.slice(restoreIdx, restoreIdx + 2500);
        assert.ok(
            restoreBlock.includes('checkTimeWindows()'),
            'restoreSavedState muss checkTimeWindows() zur Reconciliation aufrufen'
        );
    });
});

// ---------------------------------------------------------------------------
// J. Overlap-Guard – Heizung bleibt an wenn anderes Fenster sie braucht
// ---------------------------------------------------------------------------
describe('J. Overlap-Guard – Heizung bleibt an wenn anderes Fenster überlappend aktiv', () => {
    it('anderes Fenster braucht Heizung → kein heater-off', () => {
        const { actions } = simulateDeactivateWindow(
            { action_heating: true, action_filter: true, action_uvc: false },
            { otherNeedsHeater: true, uvcMinMet: true }
        );
        assert.ok(!actions.includes('heater-off'),
            'Heizung darf NICHT abgeschaltet werden wenn anderes Fenster sie braucht');
    });

    it('kein anderes Fenster → Heizung wird abgeschaltet', () => {
        const { actions } = simulateDeactivateWindow(
            { action_heating: true, action_filter: true, action_uvc: false },
            { otherNeedsHeater: false, uvcMinMet: true }
        );
        assert.ok(actions.includes('heater-off'),
            'Heizung muss abgeschaltet werden wenn kein anderes Fenster sie braucht');
    });
});

// ---------------------------------------------------------------------------
// K. Overnight-Fenster
// ---------------------------------------------------------------------------
describe('K. Overnight-Fenster 22:00–06:00', () => {
    const W = { active: true, start: '22:00', end: '06:00', action_heating: true, action_filter: true,
                day_mon: true, day_tue: true, day_wed: true, day_thu: true, day_fri: true,
                day_sat: true, day_sun: true };

    it('23:30 → activate', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T23:30:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'activate');
    });

    it('03:00 → keine erneute Aktivierung (wasIn=true)', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-16T03:00:00'), wasIn: true, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'none');
    });

    it('07:00 → deactivate', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-16T07:00:00'), wasIn: true, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'deactivate');
    });

    it('14:00 → kein Einschalten (tagsüber außerhalb)', () => {
        const r = simulateCheckTimeWindow(W, {
            now: new Date('2024-07-15T14:00:00'), wasIn: false, manualOverride: false,
            seasonEnabled: true, seasonStart: '01.01', seasonEnd: '31.12',
        });
        assert.strictEqual(r, 'none');
    });
});
