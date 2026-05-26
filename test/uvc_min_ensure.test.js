'use strict';

/**
 * Tests: "Ist sichergestellt dass UVC am Tag min. 2h läuft – ab letztem
 *          Zeitfenster wenn das Minimum noch nicht erreicht wurde?"
 *
 * Bug:
 *   deactivateWindow() → early-return (UVC-Min nicht erreicht):
 *     _timeWindowActive[i] = false   → kein Besitzer mehr
 *     UVC + Filter laufen auf Hardware weiter
 *
 *   checkDailyMinimum():
 *     if (nowMinutes < ensureMin) → return  ← zu früh
 *     _uvcEnsureActive = false              ← kein Besitzer
 *     → wenn Minimum zwischen Fenster-Ende und ensureTime erreicht wird:
 *       todayH >= minH → _uvcEnsureActive=false → kein stopEnsure()
 *       → UVC + Filter laufen EWIG weiter
 *
 * Fix in checkDailyMinimum():
 *   VOR der ensureTime-Prüfung: wenn UVC herrenlos läuft →
 *   sofort Ownership übernehmen (_uvcEnsureActive=true).
 *   Dann greift die todayH>=minH-Prüfung korrekt.
 *
 * Run:  npx mocha test/uvc_min_ensure.test.js --no-config
 */


const assert    = require('assert');
const path      = require('path');
const fs        = require('fs');
const uvcModule = require('../lib/uvc');

// ---------------------------------------------------------------------------
// Adapter-Stub
// ---------------------------------------------------------------------------
function makeAdapter({
    uvcOn              = true,
    filterOn           = true,
    uvcHoursUsed       = 0,
    uvcDayStartH       = 0,
    uvcOnSince         = null,       // null = UVC hardware läuft schon (gezählt in uvcHoursUsed)
    ensureTime         = '10:00',
    minH               = 2,
    nowHour            = 9,          // aktuelle Uhrzeit (für nowMinutes)
    nowMin             = 5,
    manualOverride     = false,
    seasonEnabled      = true,
    winterModeActive   = false,
    winterFrostActive  = false,
    pvActive           = false,
    pvManagedUvc       = false,
    timeWindowActive   = [false],
    uvcEnsureActive    = false,
    uvcEnsureFilterStart = false,
    uvcTodayResetDate  = '',
    pvStageTimer       = null,
} = {}) {
    const stateStore = {
        'control.uvc':    { val: uvcOn },
        'control.filter': { val: filterOn },
    };
    const calls   = [];
    const logMsgs = { debug: [], info: [], warn: [], error: [] };
    let lastCommandTime = 0;

    // Feste „jetzt"-Zeit damit Tests reproduzierbar sind
    const fakeNow = new Date(2024, 6, 15, nowHour, nowMin, 0);

    return {
        config: {
            more_log_enabled:         false,
            uvc_daily_min_h:          minH,
            uvc_daily_ensure_time:    ensureTime,
            timeWindows:              [],
        },
        log: {
            debug: m => logMsgs.debug.push(m),
            info:  m => logMsgs.info.push(m),
            warn:  m => logMsgs.warn.push(m),
            error: m => logMsgs.error.push(m),
        },
        logs: logMsgs,
        calls,

        _uvcHoursUsed:       uvcHoursUsed,
        _uvcDayStartHours:   uvcDayStartH,
        _uvcDayStartDate:    '2024-07-15',
        _uvcTodayResetDate:  '2024-07-15',  // prevent daily reset from overwriting uvcDayStartH
        _uvcOnSince:         uvcOnSince,
        _uvcEnsureActive:    uvcEnsureActive,
        _uvcEnsureFilterStart: uvcEnsureFilterStart,
        _uvcEnsureDate:      '',
        _uvcEnsureSkipToday: false,
        _uvcEnsureSkipDate:  '',
        _manualOverride:     manualOverride,
        _seasonEnabled:      seasonEnabled,
        _winterModeActive:   winterModeActive,
        _winterFrostActive:  winterFrostActive,
        _pvActive:           pvActive,
        _pvManagedFeatures:  { uvc: pvManagedUvc, filter: false },
        _pvStageTimer:       pvStageTimer,
        _timeWindowActive:   timeWindowActive,
        get _lastCommandTime() { return lastCommandTime; },

        todayStr() { return '2024-07-15'; },

        // Ersetzt Date.now in accumulateHours implizit über _uvcOnSince=null
        async getStateAsync(id) { return stateStore[id] || null; },
        setState() {},
        async setStateChangedAsync() {},

        enableRapidPolling() {},

        async setFeature(feature, val, opts = {}) {
            calls.push({ feature, val, opts: { ...opts } });
            stateStore[`control.${feature}`] = { val };
            if (opts.fromAutomation) lastCommandTime = Date.now();
        },

        // Überschreibe checkDailyMinimum mit fixierter Zeit
        _fakeNow: fakeNow,
        _getNow() { return fakeNow; },
    };
}

// Führt checkDailyMinimum direkt aus (adapter._getNow liefert die fixierte Zeit)
async function runCheck(adapter) {
    await uvcModule.checkDailyMinimum(adapter);
}

// ---------------------------------------------------------------------------
// 1. Quelltext-Audit
// ---------------------------------------------------------------------------
describe('Quelltext-Audit: uvc.js enthält Herrenlos-Ownership-Logik', () => {
    it('checkDailyMinimum enthält "Herrenlose UVC" Ownership-Block', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/uvc.js'), 'utf8');
        assert.ok(src.includes('Herrenlose UVC'),
            'checkDailyMinimum muss den Herrenlos-Ownership-Block enthalten');
        assert.ok(src.includes('taking ownership of running UVC'),
            'Log-Meldung für Ownership-Übernahme muss vorhanden sein');
    });

    it('Ownership-Übernahme erfolgt VOR der ensureTime-Prüfung', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/uvc.js'), 'utf8');
        const ownershipIdx = src.indexOf('taking ownership of running UVC');
        const ensureTimeIdx = src.indexOf('too early (${ensureTime} not reached yet)');
        assert.ok(ownershipIdx > 0 && ensureTimeIdx > 0,
            'Beide Blöcke müssen vorhanden sein');
        assert.ok(ownershipIdx < ensureTimeIdx,
            'Ownership-Block muss VOR der ensureTime-Prüfung stehen');
    });

    it('Ownership-Übernahme erfolgt VOR der todayH>=minH-Prüfung', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../lib/uvc.js'), 'utf8');
        const ownershipIdx = src.indexOf('taking ownership of running UVC');
        const minReachedIdx = src.indexOf('daily minimum reached');
        assert.ok(ownershipIdx < minReachedIdx,
            'Ownership-Block muss VOR der Minimum-Prüfung stehen');
    });
});

// ---------------------------------------------------------------------------
// 2. Bug-Reproduktion: UVC läuft herrenlos, Minimum erreicht vor ensureTime
// ---------------------------------------------------------------------------
describe('Bug: UVC läuft herrenlos – Minimum erreicht vor ensureTime', () => {

    it('OHNE Fix: todayH>=minH aber _uvcEnsureActive=false → kein Stop', () => {
        // Simuliert das ALTE Verhalten
        const _uvcEnsureActive = false;
        const todayH = 2.5;  // Minimum (2h) überschritten
        const minH   = 2;

        let stopCalled = false;
        if (todayH >= minH) {
            if (_uvcEnsureActive) stopCalled = true;
            // Ohne Fix: return ohne Stop
        }
        assert.strictEqual(stopCalled, false,
            'OHNE Fix: stopEnsure wird nicht aufgerufen obwohl Minimum erreicht');
    });

    it('MIT Fix: Ownership-Übernahme → stopEnsure stoppt UVC', async () => {
        // UVC läuft (2.5h), Minimum=2h, _uvcEnsureActive=false (herrenlos)
        // ensureTime=10:00, aktuelle Zeit=09:05 (vor ensureTime!)
        const adapter = makeAdapter({
            uvcOn:         true,
            filterOn:      true,
            uvcHoursUsed:  2.5,   // bereits > 2h Minimum
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       9,
            nowMin:        5,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        const uvcOff = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        assert.ok(uvcOff, 'UVC muss abgeschaltet werden wenn Minimum erreicht (auch vor ensureTime)');
        assert.strictEqual(uvcOff.opts.fromAutomation, true);
    });

    it('MIT Fix: Filter wird ebenfalls gestoppt wenn Ensure ihn besitzt', async () => {
        const adapter = makeAdapter({
            uvcOn:         true,
            filterOn:      true,
            uvcHoursUsed:  2.5,
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       9,
            nowMin:        5,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        const filterOff = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.ok(filterOff, 'Filter muss ebenfalls gestoppt werden');
        assert.strictEqual(filterOff.opts.fromAutomation, true);
    });
});

// ---------------------------------------------------------------------------
// 3. Normalfall: Fenster endet, Minimum nicht erreicht, ensureTime noch nicht
// ---------------------------------------------------------------------------
describe('Normalfall: Fenster-Ende, Minimum nicht erreicht, vor ensureTime', () => {

    it('UVC läuft weiter (Ownership übernommen), ensureTime noch nicht erreicht', async () => {
        // 08:00 Uhr, Fenster endete, 1h UVC heute, Minimum=2h, ensureTime=10:00
        const adapter = makeAdapter({
            uvcOn:         true,
            filterOn:      true,
            uvcHoursUsed:  1.0,   // 1h < 2h Minimum
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       8,
            nowMin:        5,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        // Kein Abschalten – Minimum noch nicht erreicht
        const uvcOff = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        assert.strictEqual(uvcOff, undefined,
            'UVC darf NICHT abgeschaltet werden wenn Minimum noch nicht erreicht');
        // Aber Ownership muss übernommen sein
        assert.strictEqual(adapter._uvcEnsureActive, true,
            '_uvcEnsureActive muss true sein (Ownership übernommen)');
        assert.strictEqual(adapter._uvcEnsureFilterStart, true,
            '_uvcEnsureFilterStart muss true sein (Filter-Ownership übernommen)');
    });

    it('Nächste Minute: Minimum erreicht → UVC + Filter werden gestoppt', async () => {
        // Simuliert den nächsten checkDailyMinimum()-Aufruf nachdem inzwischen genug UVC-Zeit aufgelaufen ist
        const adapter = makeAdapter({
            uvcOn:         true,
            filterOn:      true,
            uvcHoursUsed:  2.1,   // jetzt > 2h Minimum
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       8,
            nowMin:        6,
            timeWindowActive: [false],
            uvcEnsureActive: true,    // Ownership wurde in vorherigem Schritt übernommen
            uvcEnsureFilterStart: true,
        });

        await runCheck(adapter);

        const uvcOff    = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        const filterOff = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.ok(uvcOff,    'UVC muss gestoppt werden wenn Minimum erreicht');
        assert.ok(filterOff, 'Filter muss gestoppt werden wenn Ensure ihn besitzt');
    });
});

// ---------------------------------------------------------------------------
// 4. Normalfall: ensureTime schon vorbei, Minimum noch nicht erreicht →
//    Ensure startet von selbst
// ---------------------------------------------------------------------------
describe('Normalfall: ensureTime erreicht, Minimum noch nicht erreicht → Ensure startet', () => {

    it('ensureTime=10:00, jetzt=11:00, 1h UVC heute → Ensure startet', async () => {
        const adapter = makeAdapter({
            uvcOn:         false,   // UVC war aus (kein herrenloser Betrieb)
            filterOn:      false,
            uvcHoursUsed:  1.0,
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       11,
            nowMin:        0,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        const filterOn = adapter.calls.find(c => c.feature === 'filter' && c.val === true);
        const uvcOn    = adapter.calls.find(c => c.feature === 'uvc'    && c.val === true);
        assert.ok(filterOn, 'Filter muss eingeschaltet werden');
        assert.ok(uvcOn,    'UVC muss eingeschaltet werden');
        assert.strictEqual(adapter._uvcEnsureActive, true);
    });

    it('ensureTime=10:00, jetzt=09:00, kein herrenloser UVC → keine Aktion', async () => {
        const adapter = makeAdapter({
            uvcOn:         false,
            filterOn:      false,
            uvcHoursUsed:  0,
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       9,
            nowMin:        0,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        assert.strictEqual(adapter.calls.length, 0,
            'Kein Befehl wenn UVC aus und ensureTime noch nicht erreicht');
        assert.strictEqual(adapter._uvcEnsureActive, false,
            'Keine Ownership wenn UVC nicht läuft');
    });
});

// ---------------------------------------------------------------------------
// 5. Ownership-Übernahme NICHT wenn PV oder Zeitfenster UVC besitzen
// ---------------------------------------------------------------------------
describe('Ownership-Übernahme nur wenn wirklich herrenlos', () => {

    it('PV besitzt UVC → kein Ensure-Takeover', async () => {
        const adapter = makeAdapter({
            uvcOn:         true,
            filterOn:      true,
            uvcHoursUsed:  0.5,
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       8,
            nowMin:        0,
            pvActive:      true,
            pvManagedUvc:  true,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        assert.strictEqual(adapter._uvcEnsureActive, false,
            'Ensure darf NICHT Ownership übernehmen wenn PV UVC besitzt');
    });

    it('Zeitfenster aktiv → kein Ensure-Takeover', async () => {
        const adapter = makeAdapter({
            uvcOn:         true,
            filterOn:      true,
            uvcHoursUsed:  0.5,
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       8,
            nowMin:        0,
            timeWindowActive: [true],   // Fenster noch aktiv!
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        assert.strictEqual(adapter._uvcEnsureActive, false,
            'Ensure darf NICHT Ownership übernehmen wenn Zeitfenster aktiv');
    });

    it('UVC aus → kein Takeover (UVC war nie herrenlos)', async () => {
        const adapter = makeAdapter({
            uvcOn:         false,   // UVC läuft nicht
            filterOn:      false,
            uvcHoursUsed:  0.5,
            uvcDayStartH:  0,
            ensureTime:    '10:00',
            nowHour:       8,
            nowMin:        0,
            timeWindowActive: [false],
            uvcEnsureActive: false,
        });

        await runCheck(adapter);

        assert.strictEqual(adapter._uvcEnsureActive, false,
            'Kein Takeover wenn UVC nicht läuft');
    });
});

// ---------------------------------------------------------------------------
// 6. Filter-Ownership: Frost schützt Filter auch bei Takeover
// ---------------------------------------------------------------------------
describe('Filter-Ownership bei Herrenlos-Takeover', () => {

    it('Frost aktiv → Filter-Ownership NICHT übernehmen (Frost steuert Filter)', async () => {
        const adapter = makeAdapter({
            uvcOn:            true,
            filterOn:         true,
            uvcHoursUsed:     2.5,   // Minimum überschritten
            uvcDayStartH:     0,
            ensureTime:       '10:00',
            nowHour:          9,
            nowMin:           5,
            timeWindowActive: [false],
            uvcEnsureActive:  false,
            winterFrostActive: true,  // Frost aktiv!
        });

        await runCheck(adapter);

        // UVC kann gestoppt werden, aber Filter bleibt wegen Frost
        const filterOff = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.strictEqual(filterOff, undefined,
            'Filter darf bei aktivem Frost NICHT gestoppt werden');
    });

    it('Kein Frost: Filter-Ownership wird korrekt übernommen', async () => {
        const adapter = makeAdapter({
            uvcOn:            true,
            filterOn:         true,
            uvcHoursUsed:     0.5,
            uvcDayStartH:     0,
            ensureTime:       '10:00',
            nowHour:          8,
            nowMin:           0,
            timeWindowActive: [false],
            uvcEnsureActive:  false,
            winterFrostActive: false,
        });

        await runCheck(adapter);

        assert.strictEqual(adapter._uvcEnsureFilterStart, true,
            'Filter-Ownership muss übernommen werden wenn kein Frost');
    });
});

// ---------------------------------------------------------------------------
// 7. Vollständiges End-to-End Zeitstrahl-Szenario
// ---------------------------------------------------------------------------
describe('End-to-End Zeitstrahl: Fenster 08-09, ensureTime=10:00, min=2h', () => {

    /**
     * 08:00 Fenster startet, UVC ein → 1h läuft
     * 09:00 Fenster endet, UVC-Min(2h) nicht erreicht → early return
     *         _timeWindowActive[0]=false, UVC läuft, filter läuft
     * 09:01 checkDailyMinimum():
     *         Ownership-Übernahme (herrenlos), _uvcEnsureActive=true
     *         todayH=1h < 2h → kein Stop, zu früh (vor 10:00)
     * 09:59 todayH=1.98h < 2h → noch kein Stop
     * 10:02 todayH=2.03h >= 2h → stopEnsure() → UVC+Filter OFF ✓
     */

    it('09:01 – Ownership-Übernahme, kein Stop (1h < 2h)', async () => {
        const adapter = makeAdapter({
            uvcOn: true, filterOn: true,
            uvcHoursUsed: 1.0, uvcDayStartH: 0,
            ensureTime: '10:00', nowHour: 9, nowMin: 1,
            timeWindowActive: [false], uvcEnsureActive: false,
        });
        await runCheck(adapter);
        assert.strictEqual(adapter._uvcEnsureActive, true,  'Ownership übernommen');
        assert.strictEqual(adapter.calls.find(c => c.feature === 'uvc' && c.val === false), undefined, 'Kein Stop bei 1h');
    });

    it('09:59 – Ownership vorhanden, 1.98h < 2h → kein Stop', async () => {
        const adapter = makeAdapter({
            uvcOn: true, filterOn: true,
            uvcHoursUsed: 1.98, uvcDayStartH: 0,
            ensureTime: '10:00', nowHour: 9, nowMin: 59,
            timeWindowActive: [false], uvcEnsureActive: true,
            uvcEnsureFilterStart: true,
        });
        await runCheck(adapter);
        assert.strictEqual(adapter.calls.find(c => c.feature === 'uvc' && c.val === false), undefined, 'Noch kein Stop bei 1.98h');
    });

    it('10:02 – 2.03h >= 2h → UVC + Filter werden gestoppt', async () => {
        const adapter = makeAdapter({
            uvcOn: true, filterOn: true,
            uvcHoursUsed: 2.03, uvcDayStartH: 0,
            ensureTime: '10:00', nowHour: 10, nowMin: 2,
            timeWindowActive: [false], uvcEnsureActive: true,
            uvcEnsureFilterStart: true,
        });
        await runCheck(adapter);
        const uvcOff    = adapter.calls.find(c => c.feature === 'uvc'    && c.val === false);
        const filterOff = adapter.calls.find(c => c.feature === 'filter' && c.val === false);
        assert.ok(uvcOff,    'UVC muss gestoppt werden');
        assert.ok(filterOff, 'Filter muss gestoppt werden');
        assert.strictEqual(adapter._uvcEnsureActive, false, 'Ensure ist beendet');
    });

    it('Hard-Stop 22:00 – UVC wird gestoppt unabhängig von Minimum', async () => {
        const adapter = makeAdapter({
            uvcOn: true, filterOn: true,
            uvcHoursUsed: 1.0, uvcDayStartH: 0,
            ensureTime: '10:00', nowHour: 22, nowMin: 0,
            timeWindowActive: [false], uvcEnsureActive: true,
            uvcEnsureFilterStart: true,
        });
        await runCheck(adapter);
        const uvcOff = adapter.calls.find(c => c.feature === 'uvc' && c.val === false);
        assert.ok(uvcOff, 'Hard-Stop 22:00 muss UVC abschalten');
    });
});
