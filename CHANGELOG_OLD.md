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
