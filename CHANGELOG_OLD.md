<img src="admin/mspa.png" width="200" />

# ioBroker.mspa

## Changelog
### 0.1.5 (2026-04-18)
* (arteck) icon update

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
## 0.3.4 (2026-05-05)
* (arteck) fix manual override

## 0.3.3 (2026-04-28)
* (arteck) fix heatrate
* (arteck) fix uvc stop

[Older changelogs can be found there](CHANGELOG_OLD.md)

## 0.3.2 (2026-04-27)
* (arteck) `computed.pv_active` – fixed: only `true` when a PV time window is currently open (day + time check); was previously activated outside configured windows
* (arteck) Time window ALL-OFF: `action_filter=false` + `action_heating=false` now actively shuts down heater, UVC and filter when the window starts
* (arteck) `status.uvc_hours_remaining` – now updated every poll while UVC is ON (previously only on UVC-OFF)
* (arteck) `status.uvc_hours_used` – now writable for manual correction after data loss or lamp replacement
* (arteck) `status.time_windows_json` – now writable; changes saved back to adapter config, schedulers restart immediately without adapter restart
* (arteck) `heat_rate_per_hour` / `cool_rate_per_hour` – fixed: `heat_state=2` was treated as inactive, rate was never computed; added `heater=on` fallback
* (arteck) `computed.pv_active` – new state showing whether PV surplus control is currently active
* (arteck) Startup restore: all persisted states now read via `getStateAsync()` – fixes silent reset of `season_enabled`, `winter_mode`, `uvc_ensure_skip_today` etc. on every adapter restart

## 0.3.1 (2026-04-26)
* (arteck) heater ON now auto-starts filter pump if not already running (device requirement)
* (arteck) UVC ON now auto-starts filter pump if not already running (device requirement)
* (arteck) target_temperature: added range validation (20–42 °C), invalid values rejected with log warning
* (arteck) target_temperature: uses `_adapterCommanded.heater` + live API data as fallback so temperature is sent directly when heater was just switched ON
* (arteck) enableRapidPolling: running 60-second poll timer cancelled immediately, ACK arrives within ~2 s

## 0.3.0 (2026-04-26)
* (arteck) removed deprecated setStateAsync

## 0.2.20 (2026-04-26)
* (arteck) removed `mspa.0.status.uvc_expiry_date`
* (arteck) `status.heat_target_temp_reached` new format `hh:mm`
* (arteck) fix set temp after enough PV

## 0.2.19 (2026-04-26)
* (arteck) typo fix

## 0.2.18 (2026-04-26)
* (arteck) added `status.heat_target_temp_reached` – ETA (hh:mm) until target temperature is reached

---

## 0.2.17 (2026-04-25)
* (arteck) log information can be customized (more or less information)

## 0.2.16 (2026-04-24)
* (arteck) add manuall filter counter and reset button

## 0.2.15 (2026-04-24)
* (arteck) create only model states

## 0.2.14 (2026-04-23)
* (arteck) fix consumption

## 0.2.7 (2026-04-19)
* (arteck) fix manual override

## 0.2.6 (2026-04-19)
* (arteck) skip uv lamp daily duration 
* (arteck) add language selector for telegramm message

## 0.2.5 (2026-04-19)
* (arteck) fix uvc_expiry_date

## 0.2.4 (2026-04-19)
* (arteck) add cloud delay, heater delay uvc delay
* (arteck) add min duration uv-lamp 
* (arteck) winter modus refactoring
* (arteck) add manual_override modus
* (arteck) add app value change automatic detection 
* (arteck) fix consumption

## 0.2.3 (2026-04-18)
* (arteck) fix languages del BOM

## 0.2.8 (2026-04-20)
* (arteck) new logic for UVC lamp – minimum daily runtime, daily ensure start time
* (arteck) new logic for heater on and set temperature
* (arteck) fix PV logic
* (arteck) add MSpa current power consumption (smart plug) for accurate PV surplus / oscillation prevention
* (arteck) app change detection – auto manual override when MSpa app changes device state
* (arteck) notification language selector (English / Deutsch)

## 0.2.7 (2026-04-19)
* (arteck) fix manual override

---

## 0.2.6 (2026-04-19)
* (arteck) skip uvc lamp daily duration
* (arteck) add language selector for telegram messages

## 0.2.5 (2026-04-19)
* (arteck) fix uvc_expiry_date

## 0.2.4 (2026-04-19)
* (arteck) add cloud delay, heater delay, uvc delay
* (arteck) add min duration uvc-lamp
* (arteck) winter mode refactoring
* (arteck) add manual_override mode
* (arteck) add app value change automatic detection
* (arteck) fix consumption

## 0.2.3 (2026-04-18)
* (arteck) fix languages – remove BOM

## 0.2.2 (2026-04-18)
* (arteck) fix languages

## 0.2.1 (2026-04-18)
* (arteck) fix season_enabled 
* (arteck) add manual override an manual_override_duration

## 0.2.0 (2026-04-18)
* (arteck) BREAKING CHANGES 
* 
* plz delete and install again
* 
* (arteck) new structure timecontrol
* (arteck) new dp pv_deactivate_remaining
* (arteck) fix filter
* (arteck) fix heat_time 
* (arteck) add winter mode

## 0.1.6 (2026-04-18)
* (arteck) Dependencies have been updated and icon is new

## 0.1.5 (2026-04-18)
* (arteck) icon update

## 0.0.1 (2026-04-16)
* (arteck) first release
