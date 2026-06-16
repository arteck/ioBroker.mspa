'use strict';

/**
 * notificationTexts.js – MSpa Adapter
 *
 * All user-visible Telegram / notification messages in one place.
 * Edit the text values to customise messages.
 * Placeholders are replaced via simple string interpolation in notificationHelper.format().
 *
 * Supported placeholders per key (see usage in main.js):
 *   {window}     – time window number (1, 2, 3)
 *   {start}      – time window start  (HH:MM)
 *   {end}        – time window end    (HH:MM)
 *   {surplus}    – current PV surplus in Watts
 *   {temp}       – current water temperature (°C)
 *   {threshold}  – frost protection threshold (°C)
 *   {hysteresis} – frost protection hysteresis upper limit (°C)
 *   {usedHours}  – UVC operating hours used
 *   {remaining}  – UVC hours or time remaining
 *   {expiry}     – estimated UVC expiry date (DD.MM.YYYY)
 *   {daysLeft}   – days until UVC expiry
 *   {durationMin}– manual override duration (minutes)
 *   {key}        – state key that changed (e.g. "heater", "filter")
 *   {duration}   – override duration in minutes
 */
const NOTIFY = {
    // ── Time window control ──────────────────────────────────────────────────
    timeWindowSeasonEnded: '🌡️ *MSpa:* Season ended – time window {window} deactivated.',
    timeWindowStarted: '⏰ *MSpa:* Time window {window} started ({start}–{end}).',
    timeWindowEnded: '⏹️ *MSpa:* Time window {window} ended ({start}–{end}).',

    // ── PV surplus control ───────────────────────────────────────────────────
    pvActivated: '☀️ *MSpa:* PV surplus ({surplus} W) – activating.',
    pvDeactivated: '🌥️ *MSpa:* PV surplus gone – staged deactivation.',

    // ── UVC lamp ─────────────────────────────────────────────────────────────
    uvcExpired: '⚠️ *MSpa:* UVC lamp lifetime exhausted ({usedHours} h used) – please replace!',
    uvcExpirySoon: '⚠️ *MSpa:* UVC lamp expires ~{expiry} (in ~{daysLeft} days) – replacement recommended.',
    uvcEnsureStarted: '💡 *MSpa:* UVC daily minimum ensure started – {remaining} h remaining.',
    uvcEnsureSkipped: '🔕 *MSpa:* UVC daily ensure skipped for today.',

    // ── Frost protection ─────────────────────────────────────────────────────
    frostActive: '❄️ *MSpa:* Frost protection active – water {temp}°C ≤ {threshold}°C, activating heater + filter.',
    frostDeactivated: '🌡️ *MSpa:* Frost protection deactivated – water {temp}°C ≥ {hysteresis}°C.',

    // ── Manual override ──────────────────────────────────────────────────────
    overrideOnTimed: '🔧 *MSpa:* Manual override active for {durationMin} min – all automations paused.',
    overrideOnIndefinite: '🔧 *MSpa:* Manual override active (indefinitely) – all automations paused.',
    overrideEnded: '▶️ *MSpa:* Manual override ended – automations resumed.',
    overrideOff: '▶️ *MSpa:* Manual override deactivated – automations resumed.',

    // ── App change detection ─────────────────────────────────────────────────
    appChangeDetected: '📱 *MSpa:* App change detected ({key}) – manual override activated for {duration} min.',

    // ── Device offline ───────────────────────────────────────────────────────
    deviceOffline: '⚠️ *MSpa:* Device offline – all automation paused',
};

const NOTIFY_DE = {
    // ── Zeitfenster-Steuerung ────────────────────────────────────────────────
    timeWindowSeasonEnded: '🌡️ *MSpa:* Saison beendet – Zeitfenster {window} deaktiviert.',
    timeWindowStarted: '⏰ *MSpa:* Zeitfenster {window} gestartet ({start}–{end}).',
    timeWindowEnded: '⏹️ *MSpa:* Zeitfenster {window} beendet ({start}–{end}).',

    // ── PV-Überschuss-Steuerung ──────────────────────────────────────────────
    pvActivated: '☀️ *MSpa:* PV-Überschuss ({surplus} W) – Aktivierung.',
    pvDeactivated: '🌥️ *MSpa:* PV-Überschuss weg – stufenweise Deaktivierung.',

    // ── UV-C-Lampe ───────────────────────────────────────────────────────────
    uvcExpired: '⚠️ *MSpa:* UV-C-Lampe Lebensdauer erschöpft ({usedHours} Std. genutzt) – bitte ersetzen!',
    uvcExpirySoon: '⚠️ *MSpa:* UV-C-Lampe läuft ab ~{expiry} (in ~{daysLeft} Tagen) – Austausch empfohlen.',
    uvcEnsureStarted: '💡 *MSpa:* UV-C Tagesmindestlaufzeit gestartet – noch {remaining} Std. verbleibend.',
    uvcEnsureSkipped: '🔕 *MSpa:* UV-C Tagesmindestlaufzeit heute bereits erfüllt – übersprungen.',

    // ── Frostschutz ──────────────────────────────────────────────────────────
    frostActive: '❄️ *MSpa:* Frostschutz aktiv – Wasser {temp}°C ≤ {threshold}°C, Heizung + Filter eingeschaltet.',
    frostDeactivated: '🌡️ *MSpa:* Frostschutz deaktiviert – Wasser {temp}°C ≥ {hysteresis}°C.',

    // ── Manueller Override ───────────────────────────────────────────────────
    overrideOnTimed: '🔧 *MSpa:* Manueller Override aktiv für {durationMin} Min. – alle Automationen pausiert.',
    overrideOnIndefinite: '🔧 *MSpa:* Manueller Override aktiv (unbegrenzt) – alle Automationen pausiert.',
    overrideEnded: '▶️ *MSpa:* Manueller Override beendet – Automationen fortgesetzt.',
    overrideOff: '▶️ *MSpa:* Manueller Override deaktiviert – Automationen fortgesetzt.',

    // ── App-Änderungserkennung ───────────────────────────────────────────────
    appChangeDetected: '📱 *MSpa:* App-Änderung erkannt ({key}) – manueller Override für {duration} Min. aktiviert.',

    // ── Gerät offline ─────────────────────────────────────────────────────────
    deviceOffline: '⚠️ *MSpa:* Gerät offline – alle Automatik pausiert',
};

// ---------------------------------------------------------------------------
// MSpa warning / fault code mapping
// ---------------------------------------------------------------------------
/**
 * English warning/fault code texts.
 * A0 = no fault (firmware normal-state code) → empty string.
 * Unknown codes are passed through as-is.
 */
const WARNING_CODES_EN = {
    // ── Normal ────────────────────────────────────────────────────────────────
    A0: '',                                                           // No fault

    // ── Error codes (E) ───────────────────────────────────────────────────────
    E1: 'Water temperature sensor fault (E1)',
    E2: 'Heater over-temperature protection triggered (E2)',
    E3: 'Filter pump fault (E3)',
    E4: 'Ground fault / GFCI protection triggered (E4)',
    E5: 'Main board communication error (E5)',
    E6: 'Water temperature too low – frost protection active (E6)',
    E7: 'Water level too low (E7)',
    E8: 'Over-voltage / under-voltage (E8)',
    E9: 'Temperature sensor short circuit (E9)',
    EA: 'Sensor out of range (EA)',

    // ── Fault codes (F) ───────────────────────────────────────────────────────
    F1: 'Heating element fault (F1)',
    F2: 'Pump motor fault (F2)',
    F3: 'Control board fault (F3)',
    F4: 'Overcurrent protection triggered (F4)',
    F5: 'EEPROM / memory fault (F5)',

    // ── Warning codes (W) ─────────────────────────────────────────────────────
    W1: 'Filter life expired – please replace filter (W1)',
    W2: 'Water quality low – water test recommended (W2)',
    W3: 'UVC lamp approaching end of life (W3)',

    // ── Communication codes (Ec / Er) ─────────────────────────────────────────
    EC: 'Communication error (Ec)',
    ER: 'General error (Er)',
};

/**
 * German warning/fault code texts (used when notification_language === 'de').
 */
const WARNING_CODES_DE = {
    // ── Normal ────────────────────────────────────────────────────────────────
    A0: '',                                                           // Kein Fehler

    // ── Fehlercodes (E) ───────────────────────────────────────────────────────
    E1: 'Wassertemperatursensor-Fehler (E1)',
    E2: 'Heizung Überhitzungsschutz ausgelöst (E2)',
    E3: 'Filterpumpen-Fehler (E3)',
    E4: 'Erdschluss-Schutz ausgelöst (E4)',
    E5: 'Kommunikationsfehler Hauptplatine (E5)',
    E6: 'Wassertemperatur zu niedrig – Frostschutz aktiv (E6)',
    E7: 'Wasserstand zu niedrig (E7)',
    E8: 'Überspannung / Unterspannung (E8)',
    E9: 'Temperatursensor-Kurzschluss (E9)',
    EA: 'Sensor außerhalb des Messbereichs (EA)',

    // ── Fehlercodes (F) ───────────────────────────────────────────────────────
    F1: 'Heizelement-Fehler (F1)',
    F2: 'Pumpenmotor-Fehler (F2)',
    F3: 'Steuerplatinen-Fehler (F3)',
    F4: 'Überstromschutz ausgelöst (F4)',
    F5: 'EEPROM-/Speicherfehler (F5)',

    // ── Warnungen (W) ─────────────────────────────────────────────────────────
    W1: 'Filterlebensdauer abgelaufen – Filter wechseln (W1)',
    W2: 'Wasserqualität niedrig – Wassertest empfohlen (W2)',
    W3: 'UV-C Lampe nähert sich Lebensende (W3)',

    // ── Kommunikationscodes (Ec / Er) ─────────────────────────────────────────
    EC: 'Kommunikationsfehler (Ec)',
    ER: 'Allgemeiner Fehler (Er)',
};

/**
 * Löst einen rohen MSpa Warning-/Fault-Code in einen lesbaren Text auf.
 * Die Sprache wird anhand von adapter.config.notification_language gewählt ('de' → Deutsch, sonst Englisch).
 * A0 (kein Fehler) → leerer String.
 * Unbekannte Codes werden als Rohwert zurückgegeben.
 *
 * @param {string|undefined} raw      – Rohcode der API (z. B. 'E1', 'A0', '')
 * @param {object|undefined} adapter  – ioBroker Adapter-Instanz (für Spracherkennung)
 * @returns {string}
 */
function resolveWarningCode(raw, adapter) {
    if (!raw) {
        return '';
    }
    const upper = String(raw).toUpperCase();
    const lang = (adapter && adapter.config && adapter.config.notification_language) || 'en';
    const map = lang === 'de' ? WARNING_CODES_DE : WARNING_CODES_EN;
    if (Object.prototype.hasOwnProperty.call(map, upper)) {
        return map[upper];
    }
    return raw; // Unbekannter Code – Rohwert beibehalten
}

module.exports = {NOTIFY, NOTIFY_DE, WARNING_CODES_EN, WARNING_CODES_DE, resolveWarningCode};

