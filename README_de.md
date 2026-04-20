<img src="admin/mspa.png" width="200" />


## ioBroker MSpa Adapter
Steuert MSpa Whirlpools über die MSpa Cloud API.

---

## Funktionen

### Gerätesteuerung
- 🌡️ Wassertemperatur & Zieltemperatur lesen/setzen (20–40 °C, 0,5 °C Schritte)
- 🔥 Heizung, Filter, Massage, Jet, Ozon und UVC ein-/ausschalten
- 📊 Automatische Berechnung der Heiz- & Kühlrate (°C/h, EMA-geglättet) + Firmware-Heizrate (`status.device_heat_perhour`)
- ⚡ Stromausfallserkennung mit optionaler Zustandswiederherstellung
- 🌍 3 Serverregionen: Europa (ROW), USA, China
- 🔒 Rate-Limiter (max. 2,5 Anfragen/Sekunde, serialisierte Befehlswarteschlange)
- 🚀 Schnellabfrage nach Befehlen (1-Sekunden-Intervall für 15 s)
- ✅ **Befehlsbestätigung:** jeder API-Befehl wird bis zu 5× (alle 3 s) gepollt um zu prüfen, ob das Gerät ihn übernommen hat – Ergebnis in `info.statusCheck` sichtbar
- 🔁 **filter=AUS** schaltet automatisch die Heizung ab (Adapter); Massage/UVC/Ozon werden von der Firmware abgeschaltet

### Zeitfenstersteuerung
- ⏰ Bis zu 3 konfigurierbare Zeitfenster (Wochentagsauswahl, Start-/Endzeit)
- 🔥 Pro Fenster: Heizung (mit Zieltemperatur), Filterpumpe und UVC steuerbar
- 🔗 UVC wird verzögert bis die Filterpumpe läuft (bis zu 15 s Wartezeit)
- 💧 Konfigurierbare Pumpen-Nachlaufzeit nach Fensterende
- 🌙 Übernacht-Zeitfenster unterstützt (z. B. 22:00–06:00)

### PV-Überschusssteuerung
- ☀️ Automatische Aktivierung wenn PV-Überschuss den Schwellwert (W) überschreitet
- 🌥️ Konfigurierbare Wolkenschutzverzögerung (`computed.pv_deactivate_remaining` zeigt Countdown in Echtzeit)
- 📉 Hysterese verhindert schnelles Ein-/Ausschalten
- ⚡ **MSpa-Lastkorrektur:** Smart-Plug-Datenpunkt anschließen – die Eigenlast des MSpa wird vom Hausverbrauch abgezogen, um Schwingungen beim Einschalten zu verhindern
- **Stufenweise Deaktivierung** – wenn der Überschuss wegfällt:
  1. **Heizung AUS** (sofort) – übersprungen wenn Firmware bereits im Idle (`heat_state=4`)
  2. **UVC AUS** (nach konfigurierbarer Verzögerung) – wartet bis tägliche UVC-Mindestlaufzeit erreicht ist
  3. **Filter AUS** (nach weiterer Verzögerung) – übersprungen wenn Firmware noch aktiv heizt (`heat_state` 2/3)
- Überschuss erholt sich **während** stufenweiser Abschaltung → alle Timer abgebrochen, Geräte wieder aktiviert
- Firmware erreicht Zieltemperatur während PV aktiv → UVC/Filter-Abschaltung automatisch ausgelöst

### Saisonsteuerung
- 📅 Saisonfenster (TT.MM – TT.MM) in den Adaptereinstellungen definieren
- Saison kann **zur Laufzeit** über `control.season_enabled` umgeschaltet werden – übersteht Adapterneustarts
- Außerhalb der Saison: Abfrage läuft weiter, alle Automatisierungen pausiert (Frostschutz funktioniert weiterhin)

### Wintermodus (Frostschutz)
- ❄️ Aktiviert Heizung + Filter automatisch wenn Wassertemperatur ≤ konfiguriertem Frost-Schwellwert
- Deaktiviert sich wieder wenn Temperatur **3 °C über** den Schwellwert steigt (Hysterese)
- Ein-/Ausschalten über `control.winter_mode` – übersteht Adapterneustarts
- Funktioniert unabhängig von der Saison (schützt auch wenn Saison deaktiviert)
- Telegram-Benachrichtigung bei Aktivierung/Deaktivierung

### Manuelle Übersteuerung
- 🔧 Pausiert **alle Automatisierungen** (Zeitfenster, PV-Überschuss, Frostschutz) mit einem Schalter
- **Optionale Auto-Fortsetzung:** `control.manual_override_duration` (Minuten) setzen – automatische Fortsetzung nach der konfigurierten Zeit. `0` = unbegrenzt
- Alle Automatisierungen werden beim Deaktivieren **sofort neu bewertet**
- Wird beim Adapterstart immer auf `false` **zurückgesetzt**
- **App-Änderungserkennung:** Ändert die MSpa-App Heizung, Filter, UVC oder Zieltemperatur, wird die manuelle Übersteuerung automatisch für eine konfigurierbare Dauer gesetzt. 0 = Erkennung deaktiviert

### Verbrauchserfassung
- 📈 Tägliche kWh-Erfassung über externen Energiezähler-Datenpunkt (z. B. Smart Plug)
- MSpa-Eigenlast wird vom Hausverbrauch abgezogen – genaue PV-Überschussberechnung ohne Schwingungen
- Automatischer Reset um Mitternacht

### UVC-Lampen-Lebensdauer
- 🔦 Einbaudatum und Nennlebensdauer (Betriebsstunden) konfigurierbar
- **Echte Betriebsstunden** gezählt – nur während UVC eingeschaltet ist, persistent über Neustarts
- **Tägliche Mindestlaufzeit:** Adapter stellt sicher, dass UVC mindestens N Stunden/Tag läuft
- **Tägliche Sicherstellung:** Ab konfigurierbarer Uhrzeit werden Filter + UVC automatisch gestartet falls Minimum noch nicht erreicht
- Geschätztes Ablaufdatum aus durchschnittlichem Tagesverbrauch berechnet
- Warnung 30 Tage vor Ablauf und bei erschöpfter Lebensdauer

### Benachrichtigungen (Telegram)
- 📬 PV aktiviert/deaktiviert, Zeitfenster gestartet/beendet, Frostschutz aktiviert/deaktiviert, UVC-Ablauf, manuelle Übersteuerung ein/aus
- Mehrere Empfänger (kommagetrennt)
- 🌐 Sprache wählbar: Englisch / Deutsch

