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

## mspa adapter for ioBroker
Controls MSpa hot tubs via the MSpa Cloud API

## Features

### Device Control
- 🌡️ Read/set water temperature & target temperature (20–40 °C, 0.5 °C steps)
- 🔥 Turn heating, filter, bubble, jet, ozone and UVC on/off
- 📊 Automatic heating & cooling rate calculation (°C/h, moving average)
- ⚡ Power failure detection with optional state restoration
- 🌍 3 server regions: Europe (ROW), USA, China
- 🔒 Rate limiter (max. 2.5 requests/second)
- 🚀 Rapid polling after commands (1-second interval for 15 s)

### Time Window Control
- ⏰ Up to 3 configurable time windows (weekday selection, start/end time)
- 🔥 Per-window control of heating (with target temperature), filter pump and UVC
- 🔗 UVC only active when filter pump is running
- 💧 Configurable pump follow-up time after window ends (pump keeps running N minutes)

### PV Surplus Control
- ☀️ Automatic activation when PV surplus exceeds configurable threshold (W)
- 🌥️ Configurable cloud-protection delay before deactivation (minutes)
- 📉 Hysteresis to prevent rapid on/off switching
- 🔋 Independent of time window control – can be combined
- ⚡ **MSpa current power input (W):** Connect a smart plug datapoint to provide the MSpa's live power draw. This value is automatically subtracted from house consumption so that the MSpa's own load does not reduce the calculated PV surplus – preventing oscillation when the device turns on
- `computed.pv_deactivate_remaining` – shows remaining minutes of the cloud-protection delay in real time
- **Staged deactivation** – when surplus drops away, the system shuts down in steps:
  1. **Heater OFF** (immediately) – if firmware already reached target temperature (heat_state=4), the API call is skipped
  2. **UVC OFF** (after configurable delay) – but only when the daily UVC minimum runtime is reached; otherwise UVC keeps running until the minimum is met
  3. **Filter OFF** (after another delay) – but only if the firmware is not actively heating (heat_state 2/3); prevents stopping the pump while the heater is still circulating
- If PV surplus recovers **during** staged deactivation → all timers are cancelled and previously turned-off devices are re-activated
- When firmware reaches target temperature while PV is active → staged deactivation of UVC/filter is triggered automatically (heater already idle)

### Season Control
- 📅 Define a season window (DD.MM – DD.MM) in the adapter settings
- Season can be **toggled at runtime** via `control.season_enabled` (e.g. from VIS) – survives adapter restarts
- Outside the season: polling continues, all automation is paused

### Winter Mode (Frost Protection)
- ❄️ Protects the hot tub from freezing when left outdoors in winter
- Activates heater + filter automatically when water temperature falls to or below the configured **frost threshold (°C)**
- Deactivates again when temperature rises **3 °C above** the threshold (hysteresis)
- Enabled/disabled via `control.winter_mode` (e.g. from VIS) – survives adapter restarts
- Frost threshold configured in the adapter settings (Admin → Time Control tab)
- Sends a Telegram notification when frost protection activates or deactivates

### Manual Override
- 🔧 Pauses **all automations** (time windows, PV surplus, frost protection) with a single switch
- Set `control.manual_override = true` to pause – the adapter will no longer send any commands to the device
- **Optional auto-resume:** set `control.manual_override_duration` (minutes) before enabling – the adapter resumes automatically after the configured time. `0` = indefinite (manual reset required)
- When override is disabled again, all automations are **immediately re-evaluated** with the latest device data
- `control.manual_override` is always **reset to `false`** on adapter restart
- **App change detection:** if the MSpa app changes heater, filter, UVC or target temperature while the adapter is active, manual override is automatically set for a configurable duration (minutes). Set to 0 to disable auto-detection
- Typical use case: control the device via the MSpa app temporarily without the adapter interfering

### Consumption Tracking
- 📈 Daily kWh tracking via external energy meter datapoint (e.g. smart plug)
- When a **MSpa current power (W)** datapoint is configured, the MSpa's own load is automatically subtracted from house consumption for accurate PV surplus calculation and oscillation prevention
- Resets automatically at midnight
- Independent of season and time window control

### UVC Lamp Lifetime
- 🔦 Configure installation date and rated lifetime (operating hours)
- **Real operating hours** are counted – only while UVC is actually switched ON
- Accumulated hours are persisted across adapter restarts
- `status.uvc_hours_used` – total accumulated UVC operating hours
- `status.uvc_today_hours` – UVC operating hours for today (resets at midnight)
- `status.uvc_hours_remaining` – remaining hours until rated lifetime is reached
- **Minimum daily runtime:** the adapter ensures the UVC lamp runs at least a configurable number of hours per day. Both PV staged shutdown and the daily ensure function respect this value
- **Daily ensure start time:** from a configurable time of day, the adapter guarantees the daily UVC minimum has been reached. The filter pump is started automatically if needed
- Estimated expiry date is calculated from average daily usage (remaining hours ÷ avg h/day)
- Warns 30 days before estimated expiry and when lifetime is exhausted

### Notifications (Telegram)
- 📬 Send notifications via Telegram on:
  - PV surplus activated / deactivated
  - Time window started / ended
  - Season started / ended
  - UVC lamp expiry warning
  - ❄️ Frost protection activated / deactivates
  - 🔧 Manual override enabled / disabled (with duration if set)
- Supports multiple recipients (comma-separated usernames)
- 🌐 **Configurable notification language** (English / Deutsch) – selectable in the Notifications tab

---

## Datapoints see Wiki

### `status.*`
| Datapoint | Description |
|---|---|
| `status.water_temperature` | Current water temperature (°C) |
| `status.target_temperature` | Target temperature set on the device (°C) |
| `status.heat_state` | Heater state: `0`=off, `1`=preoff, `2`=preheat, `3`=heating, `4`=idle (target reached) |
| `status.filter_current` | Filter **remaining hours** until cleaning is needed (`0` = filter must be cleaned) |
| `status.filter_life` | Filter **total accumulated running hours** since last reset |
| `status.heat_time_switch` | Heat timer active (boolean) |
| `status.heat_time` | Heat timer remaining (min) |
| `status.heat_rest_time` | Heat rest time (min) |
| `status.safety_lock` | Safety lock active |
| `status.temperature_unit` | Temperature unit: `0`=°C, `1`=°F |
| `status.auto_inflate` | Auto inflate active |
| `status.connect_type` | Connection type reported by device (`online`/`offline`) |
| `status.wifi_version` | WiFi module version (from status poll) |
| `status.mcu_version` | MCU version (from status poll) |
| `status.trd_version` | Third-party / firmware version |
| `status.serial_number` | Serial number (from status poll) |
| `status.ota_status` | OTA firmware update status |
| `status.reset_cloud_time` | Reset cloud time counter |
| `status.device_heat_perhour` | Heating rate reported by firmware (°C/h) – compare with `computed.heat_rate_per_hour` |
| `status.warning` | Warning message from firmware |
| `status.fault` | Fault message from firmware (`OK` when no fault) |
| `status.is_online` | Device reachable via cloud |
| `status.uvc_expiry_date` | Estimated UVC lamp expiry date (DD.MM.YYYY) |
| `status.uvc_hours_used` | Accumulated UVC operating hours (persisted across restarts) |
| `status.uvc_today_hours` | UVC operating hours today (resets at midnight) |
| `status.uvc_hours_remaining` | Remaining UVC operating hours until rated lifetime is reached |

### `computed.*`
| Datapoint | Description |
|---|---|
| `computed.heat_rate_per_hour` | Observed heating rate (°C/h) – EMA smoothed |
| `computed.cool_rate_per_hour` | Observed cooling rate (°C/h) – EMA smoothed |
| `computed.pv_deactivate_remaining` | Remaining minutes of PV cloud-protection delay |

### `info.*`
| Datapoint | Description |
|---|---|
| `info.connection` | Connected to MSpa cloud |
| `info.lastUpdate` | Timestamp of last successful data fetch |
| `info.statusCheck` | Last API command status: `''`=idle, `'send'`=command sent, `'queued'`=temperature queued (heater was off), `'success'`=device confirmed, `'error'`=no confirmation after 5 retries |

### `control.*`
| Datapoint | Writable | Description |
|---|---|---|
| `control.heater` | ✅ | Turn heater on/off. When turned off while filter is running: filter keeps running |
| `control.filter` | ✅ | Turn filter on/off. Turning OFF automatically turns OFF heater if it was running. Bubble and UVC are handled by the firmware |
| `control.bubble` | ✅ | Turn bubble on/off |
| `control.bubble_level` | ✅ | Bubble intensity (0–3) |
| `control.jet` | ✅ | Turn jet on/off |
| `control.ozone` | ✅ | Turn ozone on/off |
| `control.uvc` | ✅ | Turn UVC on/off |
| `control.target_temperature` | ✅ | Set target temperature (20–40 °C). If heater is OFF, value is queued and sent 10 s after heater is switched ON (`info.statusCheck` = `'queued'`). Firmware handles `target ≤ water` gracefully via `heat_state=4` |
| `control.bubble_level` | ✅ | Bubble level (0–3) |
| `control.winter_mode` | ✅ | Enable/disable frost protection (persisted across restarts) |
| `control.season_enabled` | ✅ | Enable/disable season control (persisted across restarts) |
| `control.manual_override` | ✅ | Pause all automations. Resets to `false` on adapter restart |
| `control.manual_override_duration` | ✅ | Auto-resume after N minutes (0 = indefinite) |
| `control.uvc_ensure_skip_today` | ✅ | Skip UVC daily ensure for today. If UVC is currently ON it will be switched OFF immediately. Resets automatically at midnight |

### `consumption.*`
| Datapoint | Description |
|---|---|
| `consumption.day_kwh` | Energy consumed today (kWh) – resets at midnight |
| `consumption.last_total_kwh` | Raw meter value at start of today |
| `consumption.day_start_date` | Date when the daily baseline was last set |

---

## Changelog
### 0.2.12 (2026-04-20)
* (arteck) add all missing raw API datapoints: `ota_status`, `mcu_version`, `trd_version`, `serial_number`, `heat_rest_time`, `reset_cloud_time`, `device_heat_perhour`, `warning`, `auto_inflate`, `connect_type`, `wifi_version`
* (arteck) fix `filter_current` / `filter_life` descriptions (remaining hours vs. accumulated hours)
* (arteck) fix `filter=false` auto-disable: heater is stopped by adapter, bubble/UVC handled by firmware
* (arteck) fix deadlock when `filter=false` triggered heater auto-disable via API lock
* (arteck) add `info.statusCheck` datapoint: `send` / `success` / `error` / `queued` for every API command
* (arteck) `uvc_ensure_skip_today=true` now also turns UVC OFF if it is currently ON (even if ensure was not the one that started it)
* (arteck) fix formatting throughout main.js and mspaApi.js

### 0.2.11 (2026-04-20)
* (arteck) add info.statusCheck 
* (arteck) fix filter off
* (arteck) api update

### 0.2.10 (2026-04-20)
* (arteck) fix uvc_ensure_skip_today

### 0.2.9 (2026-04-20)
* (arteck) typo

### 0.2.8 (2026-04-20)
* (arteck) new logic for uvc lamp – minimum daily runtime, daily ensure start time
* (arteck) new logic for heater on and set temperature
* (arteck) fix pv logic
* (arteck) add MSpa current power consumption in watts from an external source (smart plug) for accurate PV surplus calculation and oscillation prevention
* (arteck) app change detection – auto manual override when MSpa app changes device state
* (arteck) notification language selector (English / Deutsch)

### 0.2.7 (2026-04-19)
* (arteck) fix manual override

## License

MIT License

Copyright (c) 2026 Arthur Rupp <arteck@outlook.com>,

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
