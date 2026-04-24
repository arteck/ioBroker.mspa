'use strict';

/**
 * Tests for lib/notificationHelper.js
 *
 * Run with: npx mocha test/notificationHelper.test.js
 */

const assert = require('assert');

function freshHelper() {
    const key = require.resolve('../lib/notificationHelper');
    delete require.cache[key];
    return require('../lib/notificationHelper');
}

function makeAdapter({ config = {}, sendToResult = null, sendToThrow = null } = {}) {
    const logs = { debug: [], info: [], warn: [] };
    return {
        config: {
            notify_telegram_enabled:  false,
            notify_telegram_instance: '',
            notify_telegram_users:    '',
            notify_email_enabled:     false,
            notify_email_instance:    '',
            notify_email_recipient:   '',
            notify_email_subject:     '',
            notification_language:    'en',
            ...config,
        },
        log: {
            debug: m => logs.debug.push(m),
            info:  m => logs.info.push(m),
            warn:  m => logs.warn.push(m),
        },
        logs,
        _sentTo: [],
        async sendToAsync(instance, payload) {
            if (sendToThrow) throw new Error(sendToThrow);
            this._sentTo.push({ instance, payload });
            return sendToResult;
        },
    };
}

// ---------------------------------------------------------------------------
describe('notificationHelper', () => {

    describe('init()', () => {
        it('stores adapter reference', () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            helper.init(adapter);
            assert.strictEqual(helper.adapter, adapter);
        });
    });

    describe('cleanup()', () => {
        it('clears adapter reference', () => {
            const helper  = freshHelper();
            helper.init(makeAdapter());
            helper.cleanup();
            assert.strictEqual(helper.adapter, null);
        });
    });

    describe('format()', () => {
        it('replaces {placeholder} tokens', () => {
            const helper = freshHelper();
            helper.init(makeAdapter());
            const msg = helper.format('pvActivated', { surplus: 700 });
            assert.ok(msg.includes('700'), 'should contain surplus value');
            assert.ok(!msg.includes('{surplus}'), 'placeholder should be replaced');
        });

        it('uses German texts when notification_language = "de"', () => {
            const helper  = freshHelper();
            helper.init(makeAdapter({ config: { notification_language: 'de' } }));
            const msg = helper.format('pvActivated', { surplus: 500 });
            assert.ok(msg.includes('Überschuss'), 'should use German text');
        });

        it('falls back to key name when key is unknown', () => {
            const helper = freshHelper();
            helper.init(makeAdapter());
            const msg = helper.format('unknownKey_xyz');
            assert.strictEqual(msg, 'unknownKey_xyz');
        });
    });

    describe('send()', () => {
        it('does nothing when text is empty', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter();
            helper.init(adapter);
            await helper.send('');
            assert.strictEqual(adapter._sentTo.length, 0);
        });

        it('does nothing when adapter is null', async () => {
            const helper = freshHelper();
            // adapter never initialised
            await assert.doesNotReject(() => helper.send('test'));
        });

        // ── Telegram ────────────────────────────────────────────────────────

        it('sends Telegram to all users when users list is empty', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({ config: {
                notify_telegram_enabled:  true,
                notify_telegram_instance: 'telegram.0',
                notify_telegram_users:    '',
            }});
            helper.init(adapter);
            await helper.send('Hello World');
            assert.strictEqual(adapter._sentTo.length, 1);
            assert.strictEqual(adapter._sentTo[0].instance, 'telegram.0');
            assert.strictEqual(adapter._sentTo[0].payload.text, 'Hello World');
            assert.ok(!('user' in adapter._sentTo[0].payload), 'no user filter when list is empty');
        });

        it('sends Telegram to each user individually', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({ config: {
                notify_telegram_enabled:  true,
                notify_telegram_instance: 'telegram.0',
                notify_telegram_users:    'alice, bob',
            }});
            helper.init(adapter);
            await helper.send('Hi');
            assert.strictEqual(adapter._sentTo.length, 2);
            assert.strictEqual(adapter._sentTo[0].payload.user, 'alice');
            assert.strictEqual(adapter._sentTo[1].payload.user, 'bob');
        });

        it('logs a warning when Telegram send throws', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({
                config:       { notify_telegram_enabled: true, notify_telegram_instance: 'telegram.0' },
                sendToThrow:  'Network error',
            });
            helper.init(adapter);
            await helper.send('test');
            assert.ok(adapter.logs.warn.some(m => m.includes('Network error')));
        });

        it('does NOT send Telegram when disabled', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({ config: { notify_telegram_enabled: false, notify_telegram_instance: 'telegram.0' } });
            helper.init(adapter);
            await helper.send('test');
            assert.strictEqual(adapter._sentTo.length, 0);
        });

        // ── E-Mail ───────────────────────────────────────────────────────────

        it('sends both Telegram and E-Mail when both are enabled', async () => {
            const helper  = freshHelper();
            const adapter = makeAdapter({ config: {
                notify_telegram_enabled:  true,
                notify_telegram_instance: 'telegram.0',
                notify_email_enabled:     true,
                notify_email_instance:    'email.0',
                notify_email_recipient:   'x@x.com',
            }});
            helper.init(adapter);
            await helper.send('dual');
            // Only Telegram is sent – email removed
            assert.strictEqual(adapter._sentTo.length, 1);
        });
    });
});
