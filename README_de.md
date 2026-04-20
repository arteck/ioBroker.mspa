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

---

## Datenpunkte

### `status.*`
| Datenpunkt | Beschreibung |
|---|---|
| `status.water_temperature` | Aktuelle Wassertemperatur (°C) |
| `status.target_temperature` | Am Gerät gesetzte Zieltemperatur (°C) |
| `status.heat_state` | `0`=aus · `2`=Vorheizen · `3`=Heizen · `4`=Idle (Zieltemp. von Firmware erreicht) |
| `status.filter_current` | Filter **verbleibende Stunden** bis zur Reinigung (`0` = jetzt reinigen!) |
| `status.filter_life` | Filter **kumulierte Betriebsstunden** seit letztem Reset |
| `status.heat_time_switch` | Heiztimer aktiv |
| `status.heat_time` | Heiztimer verbleibend (min) |
| `status.heat_rest_time` | Heizungs-Ruhezeit (min) |
| `status.safety_lock` | Sicherheitsverriegelung aktiv |
| `status.temperature_unit` | `0`=°C · `1`=°F |
| `status.auto_inflate` | Automatisches Aufblasen aktiv |
| `status.fault` | Fehlercode der Firmware (`OK` = kein Fehler) |
| `status.warning` | Warnmeldung der Firmware |
| `status.is_online` | Gerät über Cloud erreichbar |
| `status.connect_type` | Verbindungstyp (`online`/`offline`) |
| `status.wifi_version` | WLAN-Modulversion (aus Status-Poll) |
| `status.mcu_version` | MCU-Version (aus Status-Poll) |
| `status.trd_version` | Drittanbieter-/Funk-Firmware-Version |
| `status.serial_number` | Seriennummer (aus Status-Poll) |
| `status.ota_status` | OTA-Firmware-Update-Status |
| `status.reset_cloud_time` | Cloud-Reset-Zeitstempel |
| `status.device_heat_perhour` | Von Firmware gemeldete Heizrate (°C/h) – Vergleich mit `computed.heat_rate_per_hour` |
| `status.uvc_hours_used` | Kumulierte UVC-Betriebsstunden (persistent) |
| `status.uvc_today_hours` | UVC-Betriebsstunden heute (Reset um Mitternacht) |
| `status.uvc_hours_remaining` | Verbleibende UVC-Stunden bis zur Nennlebensdauer |
| `status.uvc_expiry_date` | Geschätztes UVC-Ablaufdatum (TT.MM.JJJJ) |
| `status.time_windows_json` | Konfigurierte Zeitfenster als JSON |

### `computed.*`
| Datenpunkt | Beschreibung |
|---|---|
| `computed.heat_rate_per_hour` | Gemessene Heizrate (°C/h) – EMA-geglättet vom Adapter |
| `computed.cool_rate_per_hour` | Gemessene Kühlrate (°C/h) – EMA-geglättet vom Adapter |
| `computed.pv_deactivate_remaining` | Verbleibende Minuten des PV-Wolkenschutz-Countdowns |

### `info.*`
| Datenpunkt | Beschreibung |
|---|---|
| `info.connection` | Mit MSpa Cloud verbunden |
| `info.lastUpdate` | Zeitstempel des letzten erfolgreichen Datenabrufs |
| `info.statusCheck` | Letzter Befehlsstatus: `''`=idle · `'send'`=gesendet · `'queued'`=Temp. wartend (Heizung war aus) · `'success'`=Gerät bestätigt · `'error'`=keine Bestätigung nach 5 × 3 s |

### `control.*`
| Datenpunkt | Schreibbar | Beschreibung |
|---|---|---|
| `control.heater` | ✅ | Heizung ein-/ausschalten |
| `control.filter` | ✅ | Filter ein-/ausschalten. AUS → Heizung vom Adapter abgeschaltet; Massage/UVC/Ozon von Firmware |
| `control.bubble` | ✅ | Massage ein-/ausschalten (sendet `bubble_state` + `bubble_level` zusammen) |
| `control.bubble_level` | ✅ | Massagestufe 0–3 |
| `control.jet` | ✅ | Jet ein-/ausschalten |
| `control.ozone` | ✅ | Ozon ein-/ausschalten |
| `control.uvc` | ✅ | UVC ein-/ausschalten. EIN wartet bis zu 15 s auf Filterpumpe falls noch nicht läuft |
| `control.target_temperature` | ✅ | Zieltemperatur 20–40 °C. Geparkt (`info.statusCheck='queued'`) wenn Heizung AUS – wird 10 s nach Heizung EIN gesendet. Firmware verarbeitet `Ziel ≤ Wasser` über `heat_state=4` |
| `control.winter_mode` | ✅ | Frostschutz ein-/ausschalten (persistent) |
| `control.season_enabled` | ✅ | Saisonsteuerung ein-/ausschalten (persistent) |
| `control.manual_override` | ✅ | Alle Automatisierungen pausieren. Wird beim Neustart auf `false` zurückgesetzt |
| `control.manual_override_duration` | ✅ | Auto-Fortsetzung nach N Minuten (0 = unbegrenzt) |
| `control.uvc_ensure_skip_today` | ✅ | UVC-Tagessicherstellung heute überspringen. Falls UVC AN → wird sofort ausgeschaltet. Automatischer Reset um Mitternacht |

### `device.*`
| Datenpunkt | Beschreibung |
|---|---|
| `device.alias` | Gerätename (Alias) |
| `device.model` | Produktmodell |
| `device.series` | Produktserie |
| `device.softwareVersion` | Firmware-Version |
| `device.wifiVersion` | WLAN-Modulversion |
| `device.mcuVersion` | MCU-Version |
| `device.serialNumber` | Seriennummer |
| `device.macAddress` | MAC-Adresse |
| `device.productId` | Produkt-ID |
| `device.productTubPk` | Produkt-Tub-PK |
| `device.deviceUuid` | Geräte-UUID |
| `device.serviceRegion` | Cloud-Serviceregion (z. B. `eu-central-1`) |
| `device.activateIp` | IP-Adresse bei der Aktivierung |
| `device.bindingTime` | Datum/Uhrzeit der Gerätekopplung |
| `device.activateTime` | Aktivierungszeitstempel |
| `device.bindingRole` | `1` = Eigentümer |
| `device.isCloudActivated` | Cloud-Aktivierungsstatus |
| `device.pictureUrl` | Produktbild-URL (S3) |

### `consumption.*`
| Datenpunkt | Beschreibung |
|---|---|
| `consumption.day_kwh` | Heute verbrauchte Energie (kWh) – Reset um Mitternacht |
| `consumption.last_total_kwh` | Rohzählerwert zu Beginn des heutigen Tages |
| `consumption.day_start_date` | Datum an dem der Tages-Basiswert zuletzt gesetzt wurde |

---
