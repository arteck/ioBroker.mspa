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
Controls MSpa hot tubs via the MSpa Cloud API.

---

## Features

### Device Control
- 🌡️ Read/set water temperature & target temperature (20–40 °C, 0.5 °C steps)
- 🔥 Turn heating, filter, bubble, jet, ozone and UVC on/off
- 📊 Automatic heating & cooling rate calculation (°C/h, EMA-smoothed) + firmware reported rate (`status.device_heat_perhour`)
- ⚡ Power failure detection with optional state restoration
- 🌍 3 server regions: Europe (ROW), USA, China
- 🔒 Rate limiter (max. 2.5 requests/second, serialised command queue)
- 🚀 Rapid polling after commands (1-second interval for 15 s)
- ✅ **Command confirmation:** every API command is polled up to 5× (every 3 s) to verify the device applied it – result visible in `info.statusCheck`
- 🔁 **filter=OFF** automatically stops the heater (adapter); bubble/UVC/ozone are stopped by the firmware

### Time Window Control
- ⏰ Up to 3 configurable time windows (weekday selection, start/end time)
- 🔥 Per-window control of heating (with target temperature), filter pump and UVC
- 🔗 UVC deferred until filter pump is confirmed running (up to 15 s wait)
- 💧 Configurable pump follow-up time after window ends (pump keeps running N minutes)
- 🌙 Overnight windows supported (e.g. 22:00–06:00)

### PV Surplus Control
- ☀️ Automatic activation when PV surplus exceeds configurable threshold (W)
- 🌥️ Configurable cloud-protection delay before deactivation (`computed.pv_deactivate_remaining` shows countdown in real time)
- 📉 Hysteresis to prevent rapid on/off switching
- ⚡ **MSpa power correction:** connect a smart plug datapoint – the MSpa's own load is subtracted from house consumption to prevent oscillation when the device switches on
- **Staged deactivation** – when surplus drops away, shutdown happens in steps:
  1. **Heater OFF** (immediately) – skipped if firmware already idle (`heat_state=4`)
  2. **UVC OFF** (after configurable delay) – waits until daily UVC minimum runtime is reached
  3. **Filter OFF** (after another delay) – skipped if firmware is still actively heating (`heat_state` 2/3)
- Surplus recovery **during** staged shutdown → all timers cancelled, devices re-activated
- Firmware reaching target temperature while PV active → staged UVC/filter shutdown triggered automatically

### Season Control
- 📅 Define a season window (DD.MM – DD.MM) in the adapter settings
- Season can be **toggled at runtime** via `control.season_enabled` – survives adapter restarts
- Outside the season: polling continues, all automation is paused (frost protection still works)

### Winter Mode (Frost Protection)
- ❄️ Activates heater + filter automatically when water temperature ≤ configured frost threshold
- Deactivates again when temperature rises **3 °C above** the threshold (hysteresis)
- Enabled/disabled via `control.winter_mode` – survives adapter restarts
- Works independently of season (protects even when season is disabled)
- Telegram notification on activation/deactivation

### Manual Override
- 🔧 Pauses **all automations** (time windows, PV surplus, frost protection) with a single switch
- **Optional auto-resume:** set `control.manual_override_duration` (minutes) – resumes automatically. `0` = indefinite
- Automations are **immediately re-evaluated** when override is disabled
- Always **reset to `false`** on adapter restart
- **App change detection:** if the MSpa app changes heater, filter, UVC or target temperature while the adapter is active, manual override is set automatically for a configurable duration. Set to 0 to disable

### Consumption Tracking
- 📈 Daily kWh tracking via external energy meter datapoint (e.g. smart plug)
- MSpa own load subtracted from house consumption for accurate PV surplus (no oscillation)
- Resets automatically at midnight

### UVC Lamp Lifetime
- 🔦 Configure installation date and rated lifetime (h)
- **Real operating hours** counted – only while UVC is actually ON, persisted across restarts
- **Minimum daily runtime:** adapter ensures UVC runs at least N hours/day
- **Daily ensure:** from a configurable time of day, filter + UVC are started automatically if minimum not yet reached
- Estimated expiry date calculated from average daily usage
- Warning 30 days before expiry and on exhaustion

### Notifications (Telegram)
- 📬 PV activated/deactivated, time window started/ended, frost activated/deactivated, UVC expiry, manual override on/off
- Multiple recipients (comma-separated)
- 🌐 Language selectable: English / Deutsch

---



## Changelog
### 0.2.13 (2026-04-20)
* (arteck) typo

### 0.2.12 (2026-04-20)
* (arteck) add all missing raw API status datapoints
* (arteck) fix filter_current / filter_life descriptions (remaining hours vs. accumulated hours)
* (arteck) fix filter auto-disable: heater stopped by adapter, bubble/UVC handled by firmware
* (arteck) fix deadlock when filter false triggered heater auto-disable inside API command lock
* (arteck) add statusCheck send / success / error / queued for every API command
* (arteck) uvc_ensure_skip_today now also turns UVC OFF immediately if it is currently ON

### 0.2.11 (2026-04-20)
* (arteck) add `info.statusCheck`
* (arteck) fix filter off
* (arteck) api update

### 0.2.10 (2026-04-20)
* (arteck) fix uvc_ensure_skip_today

### 0.2.9 (2026-04-20)
* (arteck) typo

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
