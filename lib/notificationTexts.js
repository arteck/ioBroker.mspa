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
    timeWindowSeasonEnded:  '🌡️ *MSpa:* Season ended – time window {window} deactivated.',
    timeWindowStarted:      '⏰ *MSpa:* Time window {window} started ({start}–{end}).',
    timeWindowEnded:        '⏹️ *MSpa:* Time window {window} ended ({start}–{end}).',

    // ── PV surplus control ───────────────────────────────────────────────────
    pvActivated:            '☀️ *MSpa:* PV surplus ({surplus} W) – activating.',
    pvDeactivated:          '🌥️ *MSpa:* PV surplus gone – staged deactivation.',

    // ── UVC lamp ─────────────────────────────────────────────────────────────
    uvcExpired:             '⚠️ *MSpa:* UVC lamp lifetime exhausted ({usedHours} h used) – please replace!',
    uvcExpirySoon:          '⚠️ *MSpa:* UVC lamp expires ~{expiry} (in ~{daysLeft} days) – replacement recommended.',
    uvcEnsureStarted:       '💡 *MSpa:* UVC daily minimum ensure started – {remaining} h remaining.',
    uvcEnsureSkipped:       '🔕 *MSpa:* UVC daily ensure skipped for today.',

    // ── Frost protection ─────────────────────────────────────────────────────
    frostActive:            '❄️ *MSpa:* Frost protection active – water {temp}°C ≤ {threshold}°C, activating heater + filter.',
    frostDeactivated:       '🌡️ *MSpa:* Frost protection deactivated – water {temp}°C ≥ {hysteresis}°C.',

    // ── Manual override ──────────────────────────────────────────────────────
    overrideOnTimed:        '🔧 *MSpa:* Manual override active for {durationMin} min – all automations paused.',
    overrideOnIndefinite:   '🔧 *MSpa:* Manual override active (indefinitely) – all automations paused.',
    overrideEnded:          '▶️ *MSpa:* Manual override ended – automations resumed.',
    overrideOff:            '▶️ *MSpa:* Manual override deactivated – automations resumed.',

    // ── App change detection ─────────────────────────────────────────────────
    appChangeDetected:      '📱 *MSpa:* App change detected ({key}) – manual override activated for {duration} min.',
};

const NOTIFY_DE = {
    // ── Zeitfenster-Steuerung ────────────────────────────────────────────────
    timeWindowSeasonEnded:  '🌡️ *MSpa:* Saison beendet – Zeitfenster {window} deaktiviert.',
    timeWindowStarted:      '⏰ *MSpa:* Zeitfenster {window} gestartet ({start}–{end}).',
    timeWindowEnded:        '⏹️ *MSpa:* Zeitfenster {window} beendet ({start}–{end}).',

    // ── PV-Überschuss-Steuerung ──────────────────────────────────────────────
    pvActivated:            '☀️ *MSpa:* PV-Überschuss ({surplus} W) – Aktivierung.',
    pvDeactivated:          '🌥️ *MSpa:* PV-Überschuss weg – stufenweise Deaktivierung.',

    // ── UV-C-Lampe ───────────────────────────────────────────────────────────
    uvcExpired:             '⚠️ *MSpa:* UV-C-Lampe Lebensdauer erschöpft ({usedHours} Std. genutzt) – bitte ersetzen!',
    uvcExpirySoon:          '⚠️ *MSpa:* UV-C-Lampe läuft ab ~{expiry} (in ~{daysLeft} Tagen) – Austausch empfohlen.',
    uvcEnsureStarted:       '💡 *MSpa:* UV-C Tagesmindestlaufzeit gestartet – noch {remaining} Std. verbleibend.',
    uvcEnsureSkipped:       '🔕 *MSpa:* UV-C Tagesmindestlaufzeit heute bereits erfüllt – übersprungen.',

    // ── Frostschutz ──────────────────────────────────────────────────────────
    frostActive:            '❄️ *MSpa:* Frostschutz aktiv – Wasser {temp}°C ≤ {threshold}°C, Heizung + Filter eingeschaltet.',
    frostDeactivated:       '🌡️ *MSpa:* Frostschutz deaktiviert – Wasser {temp}°C ≥ {hysteresis}°C.',

    // ── Manueller Override ───────────────────────────────────────────────────
    overrideOnTimed:        '🔧 *MSpa:* Manueller Override aktiv für {durationMin} Min. – alle Automationen pausiert.',
    overrideOnIndefinite:   '🔧 *MSpa:* Manueller Override aktiv (unbegrenzt) – alle Automationen pausiert.',
    overrideEnded:          '▶️ *MSpa:* Manueller Override beendet – Automationen fortgesetzt.',
    overrideOff:            '▶️ *MSpa:* Manueller Override deaktiviert – Automationen fortgesetzt.',

    // ── App-Änderungserkennung ───────────────────────────────────────────────
    appChangeDetected:      '📱 *MSpa:* App-Änderung erkannt ({key}) – manueller Override für {duration} Min. aktiviert.',
};

module.exports = { NOTIFY, NOTIFY_DE };
