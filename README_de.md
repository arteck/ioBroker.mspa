<img src="admin/mspa.png" width="200" />

# ioBroker.mspa


## Funktionen

### Gerätesteuerung
- 🌡️ Wassertemperatur & Zieltemperatur lesen/setzen (20–40 °C, 0,5 °C Schritte)
- 🔥 Heizung, Filter, Massage, Jet, Ozon und UVC ein-/ausschalten
- 📊 Automatische Berechnung der Heiz- & Kühlrate (°C/h, gleitender Durchschnitt)
- ⚡ Stromausfallserkennung mit optionaler Zustandswiederherstellung
- 🌍 3 Serverregionen: Europa (ROW), USA, China
- 🔒 Rate-Limiter (max. 2,5 Anfragen/Sekunde)
- 🚀 Schnellabfrage nach Befehlen (1-Sekunden-Intervall für 15 s)

### Zeitfenstersteuerung
- ⏰ Bis zu 3 konfigurierbare Zeitfenster (Wochentagsauswahl, Start-/Endzeit)
- 🔥 Pro Fenster: Heizung (mit Zieltemperatur), Filterpumpe und UVC steuerbar
- 🔗 UVC nur aktiv, wenn die Filterpumpe läuft
- 💧 Konfigurierbare Pumpen-Nachlaufzeit nach Fensterende (Pumpe läuft noch N Minuten weiter)

### PV-Überschusssteuerung
- ☀️ Automatische Aktivierung, wenn PV-Überschuss den konfigurierten Schwellwert (W) überschreitet
- 🌥️ Konfigurierbare Wolkenschutzverzögerung vor der Deaktivierung (Minuten)
- 📉 Hysterese verhindert schnelles Ein-/Ausschalten
- 🔋 Unabhängig von der Zeitfenstersteuerung – kombinierbar
- ⚡ **MSpa-Leistungseingang (W):** Smart-Plug-Datenpunkt anschließen, um die aktuelle Leistungsaufnahme des MSpa bereitzustellen. Dieser Wert wird automatisch vom Hausverbrauch abgezogen, damit die Eigenlast des MSpa den berechneten PV-Überschuss nicht reduziert – verhindert Schwingungen beim Einschalten
- `computed.pv_deactivate_remaining` – zeigt die verbleibenden Minuten der Wolkenschutzverzögerung in Echtzeit
- **Stufenweise Deaktivierung** – wenn der Überschuss wegfällt, wird schrittweise abgeschaltet:
  1. **Heizung AUS** (sofort) – wenn die Firmware die Zieltemperatur bereits erreicht hat (heat_state=4), wird der API-Aufruf übersprungen
  2. **UVC AUS** (nach konfigurierbarer Verzögerung) – aber erst, wenn die tägliche UVC-Mindestlaufzeit erreicht ist; sonst läuft UVC weiter bis das Minimum erfüllt ist
  3. **Filter AUS** (nach weiterer Verzögerung) – aber nur, wenn die Firmware nicht aktiv heizt (heat_state 2/3); verhindert das Stoppen der Pumpe während die Heizung noch zirkuliert
- Erholt sich der PV-Überschuss **während** der stufenweisen Deaktivierung → alle Timer werden abgebrochen und zuvor ausgeschaltete Geräte wieder aktiviert
- Erreicht die Firmware die Zieltemperatur während PV aktiv ist → stufenweise Deaktivierung von UVC/Filter wird automatisch ausgelöst (Heizung bereits inaktiv)

### Saisonsteuerung
- 📅 Saisonfenster (TT.MM – TT.MM) in den Adaptereinstellungen definieren
- Saison kann **zur Laufzeit** über `control.season_enabled` umgeschaltet werden (z. B. aus VIS) – übersteht Adapterneustarts
- Außerhalb der Saison: Abfrage läuft weiter, alle Automatisierungen sind pausiert

### Wintermodus (Frostschutz)
- ❄️ Schützt den Whirlpool vor dem Einfrieren im Freien im Winter
- Aktiviert Heizung + Filter automatisch, wenn die Wassertemperatur auf den konfigurierten **Frostschutz-Schwellwert (°C)** fällt oder darunter geht
- Deaktiviert sich wieder, wenn die Temperatur **3 °C über** den Schwellwert steigt (Hysterese)
- Ein-/Ausschalten über `control.winter_mode` (z. B. aus VIS) – übersteht Adapterneustarts
- Frostschutz-Schwellwert in den Adaptereinstellungen konfiguriert (Admin → Zeitsteuerung-Tab)
- Sendet eine Telegram-Benachrichtigung, wenn der Frostschutz aktiviert oder deaktiviert wird

### Manuelle Übersteuerung
- 🔧 Pausiert **alle Automatisierungen** (Zeitfenster, PV-Überschuss, Frostschutz) mit einem einzigen Schalter
- `control.manual_override = true` setzen zum Pausieren – der Adapter sendet keine Befehle mehr an das Gerät
- **Optionale Auto-Fortsetzung:** `control.manual_override_duration` (Minuten) vor dem Aktivieren setzen – der Adapter setzt nach der konfigurierten Zeit automatisch fort. `0` = unbegrenzt (manuelles Zurücksetzen erforderlich)
- Wenn die Übersteuerung wieder deaktiviert wird, werden alle Automatisierungen **sofort neu bewertet** mit den aktuellen Gerätedaten
- `control.manual_override` wird beim Adapterstart immer auf `false` **zurückgesetzt**
- **App-Änderungserkennung:** Ändert die MSpa-App Heizung, Filter, UVC oder Zieltemperatur während der Adapter aktiv ist, wird die manuelle Übersteuerung automatisch für eine konfigurierbare Dauer (Minuten) gesetzt. 0 = Erkennung deaktiviert
- Typischer Anwendungsfall: Gerät vorübergehend über die MSpa-App steuern, ohne dass der Adapter eingreift

### Verbrauchserfassung
- 📈 Tägliche kWh-Erfassung über externen Energiezähler-Datenpunkt (z. B. Smart Plug)
- Wenn ein **MSpa-Leistungs-Datenpunkt (W)** konfiguriert ist, wird die Eigenlast des MSpa automatisch vom Hausverbrauch abgezogen – für eine genaue PV-Überschussberechnung und zur Vermeidung von Schwingungen
- Automatischer Reset um Mitternacht
- Unabhängig von Saison- und Zeitfenstersteuerung

### UVC-Lampen-Lebensdauer
- 🔦 Einbaudatum und Nennlebensdauer (Betriebsstunden) konfigurierbar
- **Echte Betriebsstunden** werden gezählt – nur während UVC tatsächlich eingeschaltet ist
- Kumulierte Stunden werden adapterneustartübergreifend gespeichert
- `status.uvc_hours_used` – kumulierte UVC-Betriebsstunden (persistent)
- `status.uvc_today_hours` – UVC-Betriebsstunden heute (Reset um Mitternacht)
- `status.uvc_hours_remaining` – verbleibende Betriebsstunden bis zur Nennlebensdauer
- **Tägliche Mindestlaufzeit:** Der Adapter stellt sicher, dass die UVC-Lampe mindestens eine konfigurierbare Anzahl Stunden pro Tag läuft. Sowohl die PV-Stufenabschaltung als auch die tägliche Sicherstellungsfunktion berücksichtigen diesen Wert
- **Tägliche Sicherstellungs-Startzeit:** Ab einer konfigurierbaren Uhrzeit garantiert der Adapter, dass das tägliche UVC-Minimum erreicht wurde. Die Filterpumpe wird bei Bedarf automatisch mitgestartet
- Geschätztes Ablaufdatum wird aus dem durchschnittlichen Tagesverbrauch berechnet (verbleibende Stunden ÷ Ø h/Tag)
- Warnung 30 Tage vor geschätztem Ablauf und bei erschöpfter Lebensdauer

### Benachrichtigungen (Telegram)
- 📬 Telegram-Benachrichtigungen bei:
  - PV-Überschuss aktiviert / deaktiviert
  - Zeitfenster gestartet / beendet
  - Saison gestartet / beendet
  - UVC-Lampen-Ablaufwarnung
  - ❄️ Frostschutz aktiviert / deaktiviert
  - 🔧 Manuelle Übersteuerung aktiviert / deaktiviert (mit Dauer, falls gesetzt)
- Mehrere Empfänger unterstützt (kommagetrennte Benutzernamen)
- 🌐 **Konfigurierbare Benachrichtigungssprache** (Englisch / Deutsch) – im Benachrichtigungen-Tab wählbar

---

## Datenpunkte

### `status.*`
| Datenpunkt | Beschreibung |
|---|---|
| `status.water_temperature` | Aktuelle Wassertemperatur (°C) |
| `status.target_temperature` | Zieltemperatur (°C) |
| `status.heat_state` | Heizungszustand: 0=aus, 2=Vorheizen, 3=Heizen, 4=Idle (Zieltemperatur von Firmware erreicht) |
| `status.filter_life` | Filterbetriebsstunden (h) – aktueller Nutzungszähler |
| `status.filter_current` | Filterkapazität (h) – gesamte Nennlebensdauer |
| `status.heat_time_switch` | Heiztimer aktiv (Boolean) |
| `status.heat_time` | Heiztimer verbleibend (min) – Countdown bis Auto-Aus |
| `status.safety_lock` | Sicherheitsverriegelung aktiv |
| `status.uvc_expiry_date` | Geschätztes UVC-Lampen-Ablaufdatum (basierend auf durchschn. Tagesverbrauch) |
| `status.uvc_hours_used` | Kumulierte UVC-Betriebsstunden (persistent über Neustarts) |
| `status.uvc_today_hours` | UVC-Betriebsstunden heute (Reset um Mitternacht) |
| `status.uvc_hours_remaining` | Verbleibende UVC-Betriebsstunden bis zur Nennlebensdauer |
| `status.time_windows_json` | Konfigurierte Zeitfenster als JSON |

### `computed.*`
| Datenpunkt | Beschreibung |
|---|---|
| `computed.heat_rate_per_hour` | Gemessene Heizrate (°C/h) |
| `computed.cool_rate_per_hour` | Gemessene Kühlrate (°C/h) |
| `computed.pv_deactivate_remaining` | Verbleibende Minuten der PV-Wolkenschutzverzögerung |

### `control.*`
| Datenpunkt | Schreibbar | Beschreibung |
|---|---|---|
| `control.heater` | ✅ | Heizung ein-/ausschalten |
| `control.filter` | ✅ | Filter ein-/ausschalten |
| `control.bubble` | ✅ | Massage ein-/ausschalten |
| `control.jet` | ✅ | Jet ein-/ausschalten |
| `control.ozone` | ✅ | Ozon ein-/ausschalten |
| `control.uvc` | ✅ | UVC ein-/ausschalten |
| `control.target_temperature` | ✅ | Zieltemperatur setzen (20–40 °C) |
| `control.bubble_level` | ✅ | Massagestufe (0–3) |
| `control.winter_mode` | ✅ | Frostschutz aktivieren/deaktivieren (persistent) |
| `control.season_enabled` | ✅ | Saisonsteuerung aktivieren/deaktivieren (persistent) |
| `control.manual_override` | ✅ | Alle Automatisierungen pausieren (Zeitfenster, PV, Frostschutz). Wird beim Adapterstart auf `false` zurückgesetzt |
| `control.manual_override_duration` | ✅ | Auto-Fortsetzung nach N Minuten (0 = unbegrenzt). Vor dem Aktivieren von `manual_override` setzen |

### `consumption.*`
| Datenpunkt | Beschreibung |
|---|---|
| `consumption.day_kwh` | Heute verbrauchte Energie (kWh) – Reset um Mitternacht |
| `consumption.last_total_kwh` | Rohzählerwert zu Beginn des heutigen Tages |
| `consumption.day_start_date` | Datum (JJJJ-MM-TT), an dem der Tages-Basiswert zuletzt gesetzt wurde (zur Erkennung versäumter Mitternachts-Resets) |

---
