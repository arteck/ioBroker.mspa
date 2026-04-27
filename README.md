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

## MSpa Adapter for ioBroker

Controls MSpa hot tubs via the MSpa Cloud API.  
Supports heating, filter, UVC, bubble and jet control with full automation via time windows, PV surplus and frost protection.

---

## Features

### Device Control
- 🌡️ Read/set water temperature & target temperature (**20–42 °C**, 0.5 °C steps) – values outside this range are rejected with a log warning
- 🔘 Turn **heater, filter, bubble, jet, ozone and UVC** on/off
- 🔗 **Auto-dependency management:**
  - Switching **heater ON** → automatically starts the filter pump first (device requirement)
  - Switching **UVC ON** → automatically starts the filter pump first (device requirement)
  - Switching **filter OFF** → automatically stops heater, UVC and bubble first (API requirement)
- 📊 Automatic **heating & cooling rate** calculation (°C/h, moving EMA average)  
  → requires `heat_state = 2 or 3` or `heater = on`, and a minimum 3-minute measurement window
- ⏱️ **ETA** as `hh:mm` until target temperature is reached (`status.heat_target_temp_reached`)  
  → calculated from `computed.heat_rate_per_hour` and the target/water temperature delta; capped at 48 h, `00:00` when not heating
- ⚡ Power failure detection with optional state restoration
- 🌍 3 server regions: **Europe (ROW)**, **USA**, **China**
- 🔒 Rate limiter (max. 2.5 requests/second)
- 🚀 Rapid polling after commands (1-second interval for 15 s) – running poll timer is cancelled immediately so ACK arrives within ~2 s

---

### Time Window Control
- ⏰ Unlimited configurable time windows (weekday selection, start/end time, overnight ranges supported)
- 📋 Per-window control of **heating** (with target temperature), **filter pump** and **UVC**
- 🔗 UVC only active when filter pump is running
- 🕐 Configurable **pump follow-up time** after window ends (pump keeps running N minutes)
- **ALL-OFF window:** set `action_filter = false` AND `action_heating = false` → the adapter **actively shuts down** heater, UVC and filter when the window starts  
  → use this to force everything off at a specific time (e.g. 22:00–06:00)
- PV windows are only activated when the **current time and weekday** match the configured window

---

### PV Surplus Control
- ☀️ Automatic activation when PV surplus exceeds configurable threshold (W)
- 🌥️ Configurable **cloud-protection delay** before deactivation (minutes)
- 📉 Hysteresis to prevent rapid on/off switching
- 📋 Independent of time window control – can be combined
- `computed.pv_active` – `true` only when a PV-enabled time window is **currently open** (correct day + time) AND surplus is above threshold  
  → automatically set to `false` when the time window ends or at night (no manual reset needed)
- `computed.pv_deactivate_remaining` – remaining minutes of the cloud-protection delay (live countdown)
- **Staged deactivation** – when surplus drops, the system shuts down in steps:
  1. **Heater OFF** (immediately) – if firmware already reached target temperature (`heat_state=4`), the API call is skipped
  2. **UVC OFF** (after configurable delay) – but only when the daily UVC minimum runtime is reached; otherwise UVC keeps running until the minimum is met
  3. **Filter OFF** (after another delay) – but only if firmware is not actively heating (`heat_state 2/3`)
- If PV surplus **recovers during staged deactivation** → all timers cancelled, previously turned-off devices re-activated

---

### Season Control
- 📅 Define a **season window** (DD.MM – DD.MM) in the adapter settings
- Season can be **toggled at runtime** via `control.season_enabled` (e.g. from VIS) – survives adapter restarts
- Outside the season: polling continues, **all automation is paused** (time windows, PV)
- When `season_enabled = false`: only **frost protection** (winter mode) is still allowed to run

---

### Winter Mode (Frost Protection)
- ❄️ Protects the hot tub from freezing when left outdoors in winter
- Activates heater + filter automatically when water temperature falls to or below the configured **frost threshold (°C)**
- Deactivates again when temperature rises **3 °C above** the threshold (hysteresis)
- Enabled/disabled via `control.winter_mode` (e.g. from VIS) – survives adapter restarts
- Frost threshold configured in the adapter settings (Admin → Time Control tab)
- Sends a Telegram notification when frost protection activates or deactivates
- Runs **independently of `season_enabled`** – frost protection works even when the season is disabled

> **`season_enabled` vs. `winter_mode` – the difference:**
>
> | `season_enabled` | `winter_mode` | Result |
> |---|---|---|
> | `true` | `false` | Time windows + PV active, no frost protection |
> | `true` | `true` | Time windows + PV + frost protection |
> | `false` | `false` | Everything paused |
> | `false` | `true` | **Only frost protection** – all other automations paused |
>
> The two flags are **independent** – `winter_mode` does NOT disable `season_enabled`.

---

### Manual Override
- 🛑 Pauses **all automations** (time windows, PV surplus, frost protection) with a single switch
- Set `control.manual_override = true` to pause – the adapter will no longer send any commands to the device
- **Optional auto-resume:** set `control.manual_override_duration` (minutes) before enabling – the adapter resumes automatically after the configured time (`0` = indefinite)
- When override is disabled, all automations are **immediately re-evaluated** with the latest device data
- `control.manual_override` is always **reset to `false`** on adapter restart
- Typical use case: control the device via the MSpa app temporarily without the adapter interfering

---

### UVC Lamp Lifetime
- 🔦 Configure installation date and rated lifetime (operating hours) in adapter settings
- **Real operating hours** are counted – only while UVC is actually switched ON
- Accumulated hours are persisted across adapter restarts
- `status.uvc_hours_used` – total accumulated UVC operating hours (**writable** – set manually to correct after data loss or lamp replacement)
- `status.uvc_today_hours` – UVC operating hours for today (resets at midnight)
- `status.uvc_hours_remaining` – remaining hours until rated lifetime is reached (updated every poll while UVC is ON)
- Warns when lifetime is exhausted

> **Manual correction of `status.uvc_hours_used`:**  
> If the value shows `0` after data loss:
> 1. Stop the adapter
> 2. Set the correct value in ioBroker Admin (e.g. `120` for 5 days × 24 h continuous run)
> 3. Start the adapter – it reads the persisted value and recalculates `uvc_hours_remaining` immediately

---

### UVC Daily Ensure
- ⏱️ Ensures UVC runs a **minimum number of hours per day** (configurable)
- If the daily minimum is not yet reached, the adapter automatically starts UVC (and the filter pump) at the configured ensure time
- `control.uvc_ensure_skip_today` – skip the daily ensure for today (e.g. when manually cleaning) → automatically resets at midnight

---

### Filter Runtime Tracking
- ⏳ `control.filter_running` – accumulated filter pump operating hours (persisted across restarts)
- `control.filter_reset` – momentary trigger: resets the filter runtime counter to `0` (e.g. after filter cartridge replacement)

---

### Consumption Tracking
- 📈 Daily kWh tracking via external energy meter datapoint
- Resets automatically at midnight
- Independent of season and time window control

---

### Notifications (Telegram)
- 📨 Send notifications via Telegram on:
  - ☀️ PV surplus activated / deactivated
  - ⏰ Time window started / ended
  - 📅 Season started / ended
  - 🔦 UVC lamp expiry warning
  - ❄️ Frost protection activated / deactivated
  - 🛑 Manual override enabled / disabled (with duration if set)
- Supports multiple recipients (comma-separated usernames)

---

## State Reference

### `info.*`
| State | R/W | Type | Description |
|---|---|---|---|
| `info.connection` | R | boolean | Cloud connection active |
| `info.lastUpdate` | R | number | Timestamp of last successful poll |

### `status.*`
| State | R/W | Type | Description |
|---|---|---|---|
| `status.water_temperature` | R | number | Current water temperature (°C) |
| `status.target_temperature` | R | number | Current target temperature (°C) |
| `status.heat_state` | R | number | Firmware heat state: `0`=off, `2`=heating, `3`=heating (alt.), `4`=target reached |
| `status.fault` | R | string | Fault code or `OK` |
| `status.filter_current` | R | number | Filter current (mA) |
| `status.filter_life` | R | number | Filter life remaining (%) |
| `status.uvc_hours_used` | **R/W** | number | Accumulated UVC operating hours – **writable for manual correction** |
| `status.uvc_hours_remaining` | R | number | Remaining UVC lamp lifetime (h) |
| `status.uvc_today_hours` | R | number | UVC operating hours today (h) |
| `status.heat_target_temp_reached` | R | string | ETA until target temperature as `hh:mm` (`00:00` = not heating or already reached) |
| `status.is_online` | R | boolean | Device online in cloud |
| `status.safety_lock` | R | boolean | Safety lock active |
| `status.temperature_unit` | R | string | Temperature unit (`C`/`F`) |
| `status.time_windows_json` | **R/W** | string | All time windows as JSON – **writable**, changes saved to config, schedulers restart immediately |

### `control.*`
| State | R/W | Type | Description |
|---|---|---|---|
| `control.heater` | R/W | boolean | Heater on/off – auto-starts filter if off |
| `control.filter` | R/W | boolean | Filter pump on/off – auto-stops heater/UVC/bubble when turned off |
| `control.bubble` | R/W | boolean | Bubble jets on/off |
| `control.bubble_level` | R/W | number | Bubble intensity `0–3` |
| `control.jet` | R/W | boolean | Jet on/off |
| `control.ozone` | R/W | boolean | Ozone on/off |
| `control.uvc` | R/W | boolean | UVC on/off – auto-starts filter if off |
| `control.target_temperature` | R/W | number | Target temperature `20–42 °C` |
| `control.season_enabled` | R/W | boolean | Enable season control (time windows + PV) – survives restart |
| `control.winter_mode` | R/W | boolean | Enable frost protection (independent of season) – survives restart |
| `control.manual_override` | R/W | boolean | Pause all automations – always reset to `false` on restart |
| `control.manual_override_duration` | R/W | number | Auto-resume after N minutes (`0` = indefinite) |
| `control.uvc_ensure_skip_today` | R/W | boolean | Skip UVC daily ensure for today (resets at midnight) |
| `control.filter_running` | R | number | Accumulated filter runtime (h) |
| `control.filter_reset` | R/W | boolean | Momentary trigger: reset filter runtime counter to `0` |

### `computed.*`
| State | R | Type | Description |
|---|---|---|---|
| `computed.heat_rate_per_hour` | R | number | Observed heating rate (°C/h, EMA) – computed after ≥3 min while heating |
| `computed.cool_rate_per_hour` | R | number | Observed cooling rate (°C/h, EMA) – computed after ≥3 min while not heating |
| `computed.pv_active` | R | boolean | PV surplus control currently active (only `true` within a PV time window at correct day/time) |
| `computed.pv_deactivate_remaining` | R | number | Remaining cloud-protection delay (min) |

---

## Time Window Configuration

| Field | Type | Description |
|---|---|---|
| `active` | boolean | Enable/disable this row |
| `start` | string | Start time `HH:MM` |
| `end` | string | End time `HH:MM` (overnight ranges supported, e.g. `22:00–06:00`) |
| `day_mon` … `day_sun` | boolean | Which weekdays this window is active |
| `pv_steu` | boolean | This window is also used as PV surplus control window |
| `action_filter` | boolean | Switch filter pump ON when window starts |
| `action_heating` | boolean | Switch heater ON when window starts (requires `action_filter = true`) |
| `target_temp` | number | Set target temperature when window starts (°C) |
| `action_uvc` | boolean | Switch UVC ON when window starts (requires `action_filter = true`) |

> **ALL-OFF window pattern:**  
> Set `action_filter = false` AND `action_heating = false` → the adapter actively shuts down heater, UVC and filter when this window starts.  
> All other flags (`action_uvc`, `target_temp`) are ignored in this case.

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

Result: Window 1 runs filter + heater 11:00–18:00. Window 2 forces everything off at 22:00.

---

## Demo Mode

Start the adapter with email `demo@mspa.test` – no real API calls are made, device data is simulated. Useful for testing automations without a real device.

---

## Changelog

### **WORK IN PROGRESS**
* (arteck) `computed.pv_active` – fixed: only `true` when a PV time window is currently open (day + time check); was previously activated outside configured windows
* (arteck) Time window ALL-OFF: `action_filter=false` + `action_heating=false` now actively shuts down heater, UVC and filter when the window starts
* (arteck) `status.uvc_hours_remaining` – now updated every poll while UVC is ON (previously only on UVC-OFF)
* (arteck) `status.uvc_hours_used` – now writable for manual correction after data loss or lamp replacement
* (arteck) `status.time_windows_json` – now writable; changes saved back to adapter config, schedulers restart immediately without adapter restart
* (arteck) `heat_rate_per_hour` / `cool_rate_per_hour` – fixed: `heat_state=2` was treated as inactive, rate was never computed; added `heater=on` fallback
* (arteck) `computed.pv_active` – new state showing whether PV surplus control is currently active
* (arteck) Startup restore: all persisted states now read via `getStateAsync()` – fixes silent reset of `season_enabled`, `winter_mode`, `uvc_ensure_skip_today` etc. on every adapter restart

### 0.3.1 (2026-04-26)
* (arteck) heater ON now auto-starts filter pump if not already running (device requirement)
* (arteck) UVC ON now auto-starts filter pump if not already running (device requirement)
* (arteck) target_temperature: added range validation (20–42 °C), invalid values rejected with log warning
* (arteck) target_temperature: uses `_adapterCommanded.heater` + live API data as fallback so temperature is sent directly when heater was just switched ON
* (arteck) enableRapidPolling: running 60-second poll timer cancelled immediately, ACK arrives within ~2 s

### 0.3.0 (2026-04-26)
* (arteck) removed deprecated setStateAsync

### 0.2.20 (2026-04-26)
* (arteck) removed `mspa.0.status.uvc_expiry_date`
* (arteck) `status.heat_target_temp_reached` new format `hh:mm`
* (arteck) fix set temp after enough PV

### 0.2.19 (2026-04-26)
* (arteck) typo fix

### 0.2.18 (2026-04-26)
* (arteck) added `status.heat_target_temp_reached` – ETA (hh:mm) until target temperature is reached

---

## License

MIT License

Copyright (c) 2026 Arthur Rupp <arteck@outlook.com>

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
