'use strict';

const { NOTIFY, NOTIFY_DE } = require('./notificationTexts');

/**
 * notificationHelper (MSpa)
 * Sends messages via Telegram and/or E-Mail.
 * Modelled after poolcontrol speechHelper.
 *
 * Config keys used:
 *   notify_telegram_enabled   â€“ boolean
 *   notify_telegram_instance  â€“ e.g. "telegram.0"
 *   notify_telegram_users     â€“ comma-separated usernames, empty = all
 *   notify_email_enabled      â€“ boolean
 *   notify_email_instance     â€“ e.g. "email.0"
 *   notify_email_recipient    â€“ recipient address
 *   notify_email_subject      â€“ subject line
 *
 * Events that trigger a notification (set via send()):
 *   - PV surplus activated / deactivated
 *   - Time window started / ended
 *   - Season started / ended
 *   - UVC lamp expiry warning (< 30 days / expired)
 *   - Heater/filter/UVC switched on or off by the adapter
 */

const notificationHelper = {
    adapter: null,

    init(adapter) {
        this.adapter = adapter;
        adapter.log.debug('[notify] notificationHelper initialised');
    },

    /**
     * Returns the correct NOTIFY map based on the configured notification_language.
     *
     * @returns {object}
     */
    texts() {
        const lang = (this.adapter && this.adapter.config && this.adapter.config.notification_language) || 'en';
        return lang === 'de' ? NOTIFY_DE : NOTIFY;
    },

    /**
     * Replace {placeholder} tokens in a NOTIFY template with actual values.
     *
     * @param {string} key   â€“ key from NOTIFY (e.g. 'pvActivated')
     * @param {object} vars  â€“ placeholder values, e.g. { surplus: 700 }
     * @returns {string}
     */
    format(key, vars = {}) {
        const texts = this.texts();
        let text = texts[key] || NOTIFY[key] || key;
        for (const [k, v] of Object.entries(vars)) {
            text = text.replaceAll(`{${k}}`, v);
        }
        return text;
    },

    /**
     * Send a notification text via all configured channels.
     *
     * @param {string} text  Plain text message (Markdown is supported for Telegram).
     */
    async send(text) {
        if (!text) {
            return;
        }
        if (!this.adapter) {
            return; // adapter already unloaded or not yet initialised
        }
        const cfg = this.adapter.config;

        // Telegram
        if (cfg.notify_telegram_enabled && cfg.notify_telegram_instance) {
            const instance = cfg.notify_telegram_instance;
            try {
                const rawUsers = cfg.notify_telegram_users || '';
                const users = rawUsers.split(',').map(u => u.trim()).filter(Boolean);

                if (users.length === 0) {
                    await this.adapter.sendToAsync(instance, { text, parse_mode: 'Markdown' });
                    if (this.adapter.config.more_log_enabled) {
                        this.adapter.log.info(`[notify] Telegram (all users): ${text}`);
                    }
                } else {
                    for (const user of users) {
                        await this.adapter.sendToAsync(instance, { user, text, parse_mode: 'Markdown' });
                        if (this.adapter.config.more_log_enabled) {
                            this.adapter.log.info(`[notify] Telegram â†’ ${user}: ${text}`);
                        }
                    }
                }
            } catch (err) {
                this.adapter.log.warn(`[notify] Telegram send failed (${instance}): ${err.message}`);
            }
        }


    },

    cleanup() {
        this.adapter = null;
    },
};

module.exports = notificationHelper;
