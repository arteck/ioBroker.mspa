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

### Season Control
- 📅 Define a season (DD.MM – DD.MM) – adapter only controls within the season
- Outside the season: polling continues, all automation is paused

### Consumption Tracking
- 📈 Daily kWh tracking via external energy meter datapoint
- Resets automatically at midnight
- Independent of season and time window control

### UVC Lamp Lifetime
- 🔦 Configure installation date and rated lifetime (hours)
- Calculates expiry date, warns 30 days before and after expiry

### Notifications (Telegram)
- 📬 Send notifications via Telegram on:
  - PV surplus activated / deactivated
  - Time window started / ended
  - Season started / ended
  - UVC lamp expiry warning
- Supports multiple recipients (comma-separated usernames)

## Changelog
### 0.1.4 (2026-04-18)
* (arteck) save time lines in DP as array
* (arteck) typo

### 0.1.3 (2026-04-17)
* (arteck) fix i18n

### 0.1.2 (2026-04-17)
* (arteck) fix last_total_kwh

### 0.1.1 (2026-04-17)
* (arteck) typo

### 0.1.0 (2026-04-17)
* (arteck) add PV surplus control with threshold, hysteresis and cloud-protection delay
* (arteck) add time window control (up to 3 windows, weekday selection, heating/filter/UVC per window)
* (arteck) add pump follow-up time after time window ends
* (arteck) UVC only active together with filter pump
* (arteck) add season control (DD.MM – DD.MM)
* (arteck) add UVC lamp lifetime tracker with expiry date and warning
* (arteck) add daily consumption tracking via external kWh meter
* (arteck) add Telegram notifications
* (arteck) i18n for 11 languages (de, en, es, fr, it, nl, pl, pt, ru, uk, zh-cn)

### 0.0.6 (2026-04-16)
* (arteck) refactor

### 0.0.5 (2026-04-16)
* (arteck) fix login error if find no devices

### 0.0.4 (2026-04-16)
* (arteck) create correct the channel

### 0.0.3 (2026-04-16)
* (arteck) typo

### 0.0.2 (2026-04-16)
* (arteck) fix bubble_level

### 0.0.1 (2026-04-16)
* (arteck) first release

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
