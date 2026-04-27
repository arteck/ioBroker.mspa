<img src="admin/mspa.png" width="200" />

# ioBroker.mspa

[![NPM version](https://img.shields.io/npm/v/iobroker.mspa.svg)](https://www.npmjs.com/package/iobroker.mspa)
[![Downloads](https://img.shields.io/npm/dm/iobroker.mspa.svg)](https://www.npmjs.com/package/iobroker.mspa)
![Number of Installations](https://iobroker.live/badges/mspa-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/mspa-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.mspa.png?downloads=true)](https://nodei.co/npm/iobroker.mspa/)

**Tests:**
![Test and Release](https://github.com/arteck/ioBroker.mspa/workflows/Test%20and%20Release/badge.svg)
![CodeQL](https://github.com/arteck/ioBroker.mspa/actions/workflows/codeql.yml/badge.svg?branch=main)

---

## MSpa Adapter für ioBroker

Steuert MSpa Whirlpools über die MSpa Cloud API.  
Unterstützt Heizung, Filter, UVC, Massage und Jet mit vollständiger Automatisierung über Zeitfenster, PV-Überschuss und Frostschutz.

---

## Funktionen

### Gerätesteuerung
- 🌡️ Wassertemperatur & Zieltemperatur lesen/setzen (**20–42 °C**, 0,5 °C Schritte) – Werte außerhalb dieses Bereichs werden mit einer Log-Warnung abgelehnt
- 🔘 **Heizung, Filter, Massage, Jet, Ozon und UVC** ein-/ausschalten
- 🔗 **Automatische Abhängigkeitsverwaltung:**
  - **Heizung EIN** → startet automatisch zuerst die Filterpumpe (Geräteanforderung)
  - **UVC EIN** → startet automatisch zuerst die Filterpumpe (Geräteanforderung)
  - **Filter AUS** → schaltet automatisch Heizung, UVC und Massage zuerst ab (API-Anforderung)
- 📊 Automatische Berechnung der **Heiz- & Kühlrate** (°C/h, gleitender EMA-Durchschnitt)  
  → erfordert `heat_state = 2 oder 3` oder `heater = on` und ein Mindest-Messfenster von 3 Minuten
- ⏱️ **Restzeit** als `hh:mm` bis zur Zieltemperatur (`status.heat_target_temp_reached`)  
  → berechnet aus `computed.heat_rate_per_hour` und der Differenz Ziel-/Wassertemperatur; auf 48 h begrenzt, `00:00` wenn nicht geheizt wird
- ⚡ Stromausfallserkennung mit optionaler Zustandswiederherstellung
- 🌍 3 Serverregionen: **Europa (ROW)**, **USA**, **China**
- 🔒 Rate-Limiter (max. 2,5 Anfragen/Sekunde)
- 🚀 Schnellabfrage nach Befehlen (1-Sekunden-Intervall für 15 s) – laufender Poll-Timer wird sofort abgebrochen, ACK kommt innerhalb ~2 s

---

### Zeitfenstersteuerung
- ⏰ Unbegrenzte konfigurierbare Zeitfenster (Wochentagsauswahl, Start-/Endzeit, Übernacht-Fenster unterstützt)
- 📋 Pro Fenster: **Heizung** (mit Zieltemperatur), **Filterpumpe** und **UVC** steuerbar
- 🔗 UVC nur aktiv wenn Filterpumpe läuft
- 🕐 Konfigurierbare **Pumpen-Nachlaufzeit** nach Fensterende (Pumpe läuft noch N Minuten weiter)
- **Alles-AUS-Fenster:** `action_filter = false` UND `action_heating = false` setzen → der Adapter **schaltet aktiv** Heizung, UVC und Filter ab wenn das Fenster startet  
  → damit lässt sich zu einer bestimmten Uhrzeit alles abschalten (z. B. 22:00–06:00)
- PV-Fenster werden nur aktiviert wenn **aktuelle Uhrzeit und Wochentag** zum konfigurierten Fenster passen

---

### PV-Überschusssteuerung
- ☀️ Automatische Aktivierung wenn PV-Überschuss den konfigurierten Schwellwert (W) überschreitet
- 🌥️ Konfigurierbare **Wolkenschutzverzögerung** vor der Deaktivierung (Minuten)
- 📉 Hysterese verhindert schnelles Ein-/Ausschalten
- 📋 Unabhängig von der Zeitfenstersteuerung – kann kombiniert werden
- `computed.pv_active` – `true` nur wenn ein PV-aktiviertes Zeitfenster **gerade geöffnet** ist (richtiger Tag + Uhrzeit) UND Überschuss über dem Schwellwert liegt  
  → wird automatisch auf `false` gesetzt wenn das Zeitfenster endet oder nachts (kein manuelles Zurücksetzen nötig)
- `computed.pv_deactivate_remaining` – verbleibende Minuten der Wolkenschutzverzögerung (Live-Countdown)
- **Stufenweise Deaktivierung** – wenn der Überschuss wegfällt:
  1. **Heizung AUS** (sofort) – übersprungen wenn Firmware bereits Zieltemperatur erreicht hat (`heat_state=4`)
  2. **UVC AUS** (nach konfigurierbarer Verzögerung) – nur wenn tägliche UVC-Mindestlaufzeit erreicht ist; sonst läuft UVC weiter bis das Minimum erfüllt ist
  3. **Filter AUS** (nach weiterer Verzögerung) – nur wenn Firmware nicht mehr aktiv heizt (`heat_state 2/3`)
- Überschuss erholt sich **während stufenweiser Deaktivierung** → alle Timer abgebrochen, abgeschaltete Geräte wieder aktiviert

---

### Saisonsteuerung
- 📅 **Saisonfenster** (TT.MM – TT.MM) in den Adaptereinstellungen definieren
- Saison kann **zur Laufzeit** über `control.season_enabled` umgeschaltet werden (z. B. aus VIS) – übersteht Adapterneustarts
- Außerhalb der Saison: Abfrage läuft weiter, **alle Automatisierungen pausiert** (Zeitfenster, PV)
- Bei `season_enabled = false`: nur **Frostschutz** (Wintermodus) darf noch laufen

---

### Wintermodus (Frostschutz)
- ❄️ Schützt den Whirlpool vor dem Einfrieren wenn er im Winter draußen steht
- Aktiviert Heizung + Filter automatisch wenn Wassertemperatur auf oder unter den konfigurierten **Frost-Schwellwert (°C)** fällt
- Deaktiviert sich wieder wenn Temperatur **3 °C über** den Schwellwert steigt (Hysterese)
- Ein-/Ausschalten über `control.winter_mode` (z. B. aus VIS) – übersteht Adapterneustarts
- Frost-Schwellwert in den Adaptereinstellungen konfigurieren (Admin → Zeitsteuerung-Tab)
- Telegram-Benachrichtigung bei Aktivierung/Deaktivierung
- Läuft **unabhängig von `season_enabled`** – Frostschutz funktioniert auch wenn die Saison deaktiviert ist

> **`season_enabled` vs. `winter_mode` – der Unterschied:**
>
> | `season_enabled` | `winter_mode` | Ergebnis |
> |---|---|---|
> | `true` | `false` | Zeitfenster + PV aktiv, kein Frostschutz |
> | `true` | `true` | Zeitfenster + PV + Frostschutz |
> | `false` | `false` | Alles pausiert |
> | `false` | `true` | **Nur Frostschutz** – alle anderen Automatisierungen pausiert |
>
> Die beiden Flags sind **unabhängig** – `winter_mode` deaktiviert `season_enabled` NICHT.

---

### Manuelle Übersteuerung
- 🛑 Pausiert **alle Automatisierungen** (Zeitfenster, PV-Überschuss, Frostschutz) mit einem einzigen Schalter
- `control.manual_override = true` setzen zum Pausieren – der Adapter sendet dann keine Befehle mehr an das Gerät
- **Optionale Auto-Fortsetzung:** `control.manual_override_duration` (Minuten) vor dem Aktivieren setzen – der Adapter setzt nach der konfigurierten Zeit automatisch fort (`0` = unbegrenzt)
- Beim Deaktivieren werden alle Automatisierungen **sofort neu bewertet** mit den aktuellen Gerätedaten
- `control.manual_override` wird beim Adapterstart immer auf `false` **zurückgesetzt**
- Typischer Anwendungsfall: Gerät vorübergehend über die MSpa-App steuern ohne dass der Adapter eingreift

---

### UVC-Lampen-Lebensdauer
- 🔦 Einbaudatum und Nennlebensdauer (Betriebsstunden) in den Adaptereinstellungen konfigurieren
- **Echte Betriebsstunden** werden gezählt – nur während UVC tatsächlich eingeschaltet ist
- Angesammelte Stunden werden über Adapterneustarts hinweg gespeichert
- `status.uvc_hours_used` – gesamte angesammelte UVC-Betriebsstunden (**beschreibbar** – manuell setzen zur Korrektur nach Datenverlust oder Lampentausch)
- `status.uvc_today_hours` – UVC-Betriebsstunden heute (wird um Mitternacht zurückgesetzt)
- `status.uvc_hours_remaining` – verbleibende Stunden bis zur Nennlebensdauer (wird bei jedem Poll aktualisiert während UVC läuft)
- Warnung bei erschöpfter Lebensdauer

> **Manuelle Korrektur von `status.uvc_hours_used`:**  
> Wenn der Wert nach Datenverlust `0` zeigt:
> 1. Adapter stoppen
> 2. Korrekten Wert im ioBroker Admin setzen (z. B. `120` für 5 Tage × 24 h Dauerbetrieb)
> 3. Adapter starten – er liest den gespeicherten Wert und berechnet `uvc_hours_remaining` sofort neu

---

### UVC Tägliche Sicherstellung
- ⏱️ Stellt sicher, dass UVC täglich eine **Mindestanzahl von Stunden** läuft (konfigurierbar)
- Wenn das Tagesminimum noch nicht erreicht ist, startet der Adapter automatisch UVC (und die Filterpumpe) zur konfigurierten Sicherstellungszeit
- `control.uvc_ensure_skip_today` – tägliche Sicherstellung für heute überspringen (z. B. beim manuellen Reinigen) → wird automatisch um Mitternacht zurückgesetzt

---

### Filter-Laufzeiterfassung
- ⏳ `control.filter_running` – angesammelte Filterpumpen-Betriebsstunden (wird über Neustarts gespeichert)
- `control.filter_reset` – momentaner Auslöser: setzt den Filter-Laufzeitzähler auf `0` zurück (z. B. nach Filterpatronenwechsel)

---

### Verbrauchserfassung
- 📈 Tägliche kWh-Erfassung über externen Energiezähler-Datenpunkt
- Automatischer Reset um Mitternacht
- Unabhängig von Saison und Zeitfenstersteuerung

---

### Benachrichtigungen (Telegram)
- 📨 Benachrichtigungen via Telegram bei:
  - ☀️ PV-Überschuss aktiviert / deaktiviert
  - ⏰ Zeitfenster gestartet / beendet
  - 📅 Saison gestartet / beendet
  - 🔦 UVC-Lampe Ablaufwarnung
  - ❄️ Frostschutz aktiviert / deaktiviert
  - 🛑 Manuelle Übersteuerung aktiviert / deaktiviert (mit Dauer wenn gesetzt)
- Mehrere Empfänger unterstützt (kommagetrennte Benutzernamen)

---

## States Referenz

### `info.*`
| State | R/W | Typ | Beschreibung |
|---|---|---|---|
| `info.connection` | R | boolean | Cloud-Verbindung aktiv |
| `info.lastUpdate` | R | number | Zeitstempel der letzten erfolgreichen Abfrage |

### `status.*`
| State | R/W | Typ | Beschreibung |
|---|---|---|---|
| `status.water_temperature` | R | number | Aktuelle Wassertemperatur (°C) |
| `status.target_temperature` | R | number | Aktuelle Zieltemperatur (°C) |
| `status.heat_state` | R | number | Firmware-Heizzustand: `0`=aus, `2`=heizt, `3`=heizt (alt.), `4`=Ziel erreicht |
| `status.fault` | R | string | Fehlercode oder `OK` |
| `status.filter_current` | R | number | Filterstrom (mA) |
| `status.filter_life` | R | number | Verbleibende Filterlebensdauer (%) |
| `status.uvc_hours_used` | **R/W** | number | Angesammelte UVC-Betriebsstunden – **beschreibbar zur manuellen Korrektur** |
| `status.uvc_hours_remaining` | R | number | Verbleibende UVC-Lampen-Lebensdauer (h) |
| `status.uvc_today_hours` | R | number | UVC-Betriebsstunden heute (h) |
| `status.heat_target_temp_reached` | R | string | Restzeit bis Zieltemperatur als `hh:mm` (`00:00` = heizt nicht oder bereits erreicht) |
| `status.is_online` | R | boolean | Gerät online in der Cloud |
| `status.safety_lock` | R | boolean | Sicherheitsverriegelung aktiv |
| `status.temperature_unit` | R | string | Temperatureinheit (`C`/`F`) |
| `status.time_windows_json` | **R/W** | string | Alle Zeitfenster als JSON – **beschreibbar**, Änderungen werden in der Adapterkonfiguration gespeichert, Scheduler startet sofort neu |

### `control.*`
| State | R/W | Typ | Beschreibung |
|---|---|---|---|
| `control.heater` | R/W | boolean | Heizung ein/aus – startet Filter automatisch wenn aus |
| `control.filter` | R/W | boolean | Filterpumpe ein/aus – schaltet Heizung/UVC/Massage automatisch ab wenn ausgeschaltet |
| `control.bubble` | R/W | boolean | Massage ein/aus |
| `control.bubble_level` | R/W | number | Massageintensität `0–3` |
| `control.jet` | R/W | boolean | Jet ein/aus |
| `control.ozone` | R/W | boolean | Ozon ein/aus |
| `control.uvc` | R/W | boolean | UVC ein/aus – startet Filter automatisch wenn aus |
| `control.target_temperature` | R/W | number | Zieltemperatur `20–42 °C` |
| `control.season_enabled` | R/W | boolean | Saisonsteuerung aktivieren (Zeitfenster + PV) – übersteht Neustart |
| `control.winter_mode` | R/W | boolean | Frostschutz aktivieren (unabhängig von Saison) – übersteht Neustart |
| `control.manual_override` | R/W | boolean | Alle Automatisierungen pausieren – wird beim Neustart immer auf `false` zurückgesetzt |
| `control.manual_override_duration` | R/W | number | Auto-Fortsetzung nach N Minuten (`0` = unbegrenzt) |
| `control.uvc_ensure_skip_today` | R/W | boolean | Tägliche UVC-Sicherstellung für heute überspringen (wird um Mitternacht zurückgesetzt) |
| `control.filter_running` | R | number | Angesammelte Filter-Laufzeit (h) |
| `control.filter_reset` | R/W | boolean | Momentaner Auslöser: Filter-Laufzeitzähler auf `0` zurücksetzen |

### `computed.*`
| State | R | Typ | Beschreibung |
|---|---|---|---|
| `computed.heat_rate_per_hour` | R | number | Gemessene Heizrate (°C/h, EMA) – berechnet nach ≥3 Min. beim Heizen |
| `computed.cool_rate_per_hour` | R | number | Gemessene Kühlrate (°C/h, EMA) – berechnet nach ≥3 Min. ohne Heizen |
| `computed.pv_active` | R | boolean | PV-Überschusssteuerung gerade aktiv (nur `true` innerhalb eines PV-Zeitfensters mit korrektem Tag/Uhrzeit) |
| `computed.pv_deactivate_remaining` | R | number | Verbleibende Wolkenschutzverzögerung (Min.) |

---

## Zeitfenster-Konfiguration

| Feld | Typ | Beschreibung |
|---|---|---|
| `active` | boolean | Diese Zeile aktivieren/deaktivieren |
| `start` | string | Startzeit `HH:MM` |
| `end` | string | Endzeit `HH:MM` (Übernacht-Fenster unterstützt, z. B. `22:00–06:00`) |
| `day_mon` … `day_sun` | boolean | An welchen Wochentagen dieses Fenster aktiv ist |
| `pv_steu` | boolean | Dieses Fenster wird auch als PV-Überschuss-Steuerfenster verwendet |
| `action_filter` | boolean | Filterpumpe EIN schalten wenn Fenster startet |
| `action_heating` | boolean | Heizung EIN schalten wenn Fenster startet (erfordert `action_filter = true`) |
| `target_temp` | number | Zieltemperatur setzen wenn Fenster startet (°C) |
| `action_uvc` | boolean | UVC EIN schalten wenn Fenster startet (erfordert `action_filter = true`) |

> **Alles-AUS-Fenster Muster:**  
> `action_filter = false` UND `action_heating = false` setzen → der Adapter schaltet Heizung, UVC und Filter aktiv ab wenn dieses Fenster startet.  
> Alle anderen Flags (`action_uvc`, `target_temp`) werden in diesem Fall ignoriert.

```json
[
  {
    "active": true, "start": "11:00", "end": "18:00",
    "day_mon": true, "day_tue": true, "day_wed": true,
    "day_thu": true, "day_fri": true, "day_sat": true, "day_sun": true,
    "pv_steu": true,
    "action_filter": true, "action_heating": true,
    "target_temp": 28, "action_uvc": false
  },
  {
    "active": true, "start": "22:00", "end": "06:00",
    "day_mon": true, "day_tue": true, "day_wed": true,
    "day_thu": true, "day_fri": true, "day_sat": true, "day_sun": true,
    "pv_steu": false,
    "action_filter": false, "action_heating": false,
    "target_temp": 38, "action_uvc": false
  }
]
```

Ergebnis: Fenster 1 läuft Filter + Heizung 11:00–18:00. Fenster 2 schaltet um 22:00 alles ab.

---

## Demo-Modus

Adapter mit E-Mail `demo@mspa.test` starten – es werden keine echten API-Aufrufe gemacht, Gerätedaten werden simuliert. Nützlich zum Testen von Automatisierungen ohne echtes Gerät.

---

## Changelog

### **WORK IN PROGRESS**
* (arteck) `computed.pv_active` – behoben: nur `true` wenn ein PV-Zeitfenster gerade geöffnet ist (Tag + Uhrzeit-Prüfung); war zuvor außerhalb konfigurierter Fenster aktiv
* (arteck) Zeitfenster Alles-AUS: `action_filter=false` + `action_heating=false` schaltet jetzt aktiv Heizung, UVC und Filter ab wenn das Fenster startet
* (arteck) `status.uvc_hours_remaining` – wird jetzt bei jedem Poll aktualisiert während UVC läuft (zuvor nur beim UVC-AUS)
* (arteck) `status.uvc_hours_used` – jetzt beschreibbar zur manuellen Korrektur nach Datenverlust oder Lampentausch
* (arteck) `status.time_windows_json` – jetzt beschreibbar; Änderungen werden in der Adapterkonfiguration gespeichert, Scheduler startet sofort neu ohne Adapterneustart
* (arteck) `heat_rate_per_hour` / `cool_rate_per_hour` – behoben: `heat_state=2` wurde als inaktiv behandelt, Rate wurde nie berechnet; `heater=on` Fallback hinzugefügt
* (arteck) `computed.pv_active` – neuer State zeigt ob PV-Überschusssteuerung gerade aktiv ist
* (arteck) Startup-Wiederherstellung: alle persistierten States werden jetzt über `getStateAsync()` gelesen – behebt stillen Reset von `season_enabled`, `winter_mode`, `uvc_ensure_skip_today` usw. bei jedem Adapterneustart

### 0.3.1 (2026-04-26)
* (arteck) Heizung EIN startet jetzt automatisch die Filterpumpe wenn nicht bereits läuft (Geräteanforderung)
* (arteck) UVC EIN startet jetzt automatisch die Filterpumpe wenn nicht bereits läuft (Geräteanforderung)
* (arteck) Zieltemperatur: Bereichsvalidierung hinzugefügt (20–42 °C), ungültige Werte werden mit Log-Warnung abgelehnt
* (arteck) Zieltemperatur: verwendet `_adapterCommanded.heater` + Live-API-Daten als Fallback, damit Temperatur direkt gesendet wird wenn Heizung gerade eingeschaltet wurde
* (arteck) enableRapidPolling: laufender 60-Sekunden-Poll-Timer wird sofort abgebrochen, ACK kommt innerhalb ~2 s

### 0.3.0 (2026-04-26)
* (arteck) veraltetes setStateAsync entfernt

### 0.2.20 (2026-04-26)
* (arteck) `mspa.0.status.uvc_expiry_date` entfernt
* (arteck) `status.heat_target_temp_reached` neues Format `hh:mm`
* (arteck) Zieltemperatur-Setzen nach ausreichend PV behoben

### 0.2.19 (2026-04-26)
* (arteck) Tippfehler behoben

### 0.2.18 (2026-04-26)
* (arteck) `status.heat_target_temp_reached` hinzugefügt – Restzeit (hh:mm) bis Zieltemperatur erreicht ist

---

## Lizenz

MIT License

Copyright (c) 2026 Arthur Rupp <arteck@outlook.com>

Hiermit wird unentgeltlich jeder Person, die eine Kopie der Software und der zugehörigen Dokumentationen (die „Software") erhält, die Erlaubnis erteilt, die Software uneingeschränkt zu nutzen, inklusive und ohne Ausnahme mit dem Recht, sie zu verwenden, kopieren, ändern, fusionieren, verlegen, verbreiten, unterlizenzieren und/oder zu verkaufen, und Personen, denen diese Software überlassen wird, diese Rechte zu verschaffen, unter den folgenden Bedingungen:

Der obige Urheberrechtsvermerk und dieser Erlaubnisvermerk sind in allen Kopien oder Teilkopien der Software beizulegen.

DIE SOFTWARE WIRD OHNE JEDE AUSDRÜCKLICHE ODER IMPLIZIERTE GARANTIE BEREITGESTELLT, EINSCHLIEßLICH DER GARANTIE ZUR BENUTZUNG FÜR DEN VORGESEHENEN ODER EINEM BESTIMMTEN ZWECK SOWIE JEGLICHER RECHTSVERLETZUNG, JEDOCH NICHT DARAUF BESCHRÄNKT. IN KEINEM FALL SIND DIE AUTOREN ODER COPYRIGHTINHABER FÜR JEGLICHEN SCHADEN ODER SONSTIGE ANSPRÜCHE HAFTBAR ZU MACHEN, OB INFOLGE DER ERFÜLLUNG EINES VERTRAGES, EINES DELIKTES ODER ANDERS IM ZUSAMMENHANG MIT DER SOFTWARE ODER SONSTIGER VERWENDUNG DER SOFTWARE ENTSTANDEN.
