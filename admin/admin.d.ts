// Type declarations for the MSpa adapter configuration.
// This file extends the ioBroker AdapterConfig type with all custom properties
// defined in admin/jsonConfig.json, so TypeScript can check them in main.js.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            // ── Connection ──────────────────────────────────────────────────
            email: string;
            password: string;
            region: 'ROW' | 'US' | 'CH';
            pollInterval: number;
            deviceId?: string;

            // ── Advanced Options ────────────────────────────────────────────
            more_log_enabled: boolean;
            trackTemperatureUnit: boolean;
            alwaysEnforceUnit: boolean;
            restoreStateOnPowerCycle: boolean;
            app_change_override_min: number;

            // ── Season / Time Windows ───────────────────────────────────────
            season_enabled?: boolean;
            season_start: string;   // e.g. "01.05"
            season_end: string;     // e.g. "30.09"

            /** Parsed array of time-window objects (filled at runtime) */
            timeWindows: Array<{
                active: boolean;
                start: string;
                end: string;
                day_sun?: boolean;
                day_mon?: boolean;
                day_tue?: boolean;
                day_wed?: boolean;
                day_thu?: boolean;
                day_fri?: boolean;
                day_sat?: boolean;
                action_filter: boolean;
                action_heating: boolean;
                action_uvc: boolean;
                pv_steu: boolean;
                target_temp?: number | null;
            }>;

            // ── UVC ─────────────────────────────────────────────────────────
            uvc_daily_min_h: number;
            uvc_ensure_start_time?: string;

            // ── Filter / Pump ───────────────────────────────────────────────
            pump_follow_up: number;

            // ── Winter / Frost ──────────────────────────────────────────────
            winter_mode?: boolean;
            winter_frost_temp: number;
            winter_heat_temp?: number;

            // ── PV Surplus ──────────────────────────────────────────────────
            pv_enabled?: boolean;
            pv_threshold?: number;
            pv_power_id?: string;
            pv_house_id?: string;
            pv_mspa_id?: string;
            pv_track_consumption?: boolean;
            pv_stage_delay_min?: number;
            pv_deactivate_delay_min?: number;
            pv_cloud_delay_min?: number;

            // ── Notifications ───────────────────────────────────────────────
            telegram_enabled?: boolean;
            telegram_instance?: string;
            telegram_users?: string;

            // ── Consumption tracking ─────────────────────────────────────────
            consumption_enabled?: boolean;
            consumption_meter_id?: string;
        }
    }
}

export {};
