'use strict';

/**
 * Tests für lib/states.js (createStates, createDynamicStates,
 * updateDeviceInfo, setStatusCheck).
 *
 * Es wird ein Mock-Adapter verwendet, der setObjectNotExistsAsync /
 * setObjectAsync / setStateAsync / getObjectAsync / delObjectAsync intern
 * in Maps protokolliert.
 *
 * Run:  npx mocha --no-config test/states.test.js
 */

const assert    = require('assert');
const stateMgr  = require('../lib/states');
const { STATE_DEFS } = require('../lib/constants');

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------
function makeAdapter(opts = {}) {
    const objects = new Map();
    const states  = new Map();
    const deleted = new Set();

    const adapter = {
        config: { more_log_enabled: false, ...opts.config },
        log: {
            debug() {}, info() {}, warn() {}, error() {},
        },
        _api: opts._api || {},
        _dynamicStateIds: new Set(),

        async setObjectNotExistsAsync(id, obj) {
            if (!objects.has(id)) objects.set(id, JSON.parse(JSON.stringify(obj)));
        },
        async setObjectAsync(id, obj) {
            objects.set(id, JSON.parse(JSON.stringify(obj)));
        },
        async getObjectAsync(id) {
            const o = objects.get(id);
            return o ? JSON.parse(JSON.stringify(o)) : null;
        },
        async delObjectAsync(id) {
            if (!objects.has(id)) {
                throw new Error(`object not found: ${id}`);
            }
            objects.delete(id);
            deleted.add(id);
        },
        async setStateAsync(id, val /*, ack */) {
            states.set(id, typeof val === 'object' && val !== null && 'val' in val ? val.val : val);
        },
    };

    return { adapter, objects, states, deleted };
}

// ---------------------------------------------------------------------------
// createStates
// ---------------------------------------------------------------------------
describe('lib/states.js – createStates', () => {
    it('legt alle Channels an', async () => {
        const { adapter, objects } = makeAdapter();
        await stateMgr.createStates(adapter);
        for (const ch of ['info', 'status', 'computed', 'device', 'control', 'consumption']) {
            const o = objects.get(ch);
            assert.ok(o, `channel missing: ${ch}`);
            assert.strictEqual(o.type, 'channel');
        }
    });

    it('legt info.statusCheck und consumption-states an', async () => {
        const { adapter, objects } = makeAdapter();
        await stateMgr.createStates(adapter);
        for (const id of ['info.statusCheck',
                          'status.time_windows_json',
                          'computed.pv_deactivate_remaining',
                          'control.uvc_ensure_skip_date',
                          'consumption.day_kwh',
                          'consumption.last_total_kwh']) {
            assert.ok(objects.get(id), `missing: ${id}`);
        }
    });

    it('legt nur STATE_DEFS-Objekte ohne apiField an', async () => {
        const { adapter, objects } = makeAdapter();
        await stateMgr.createStates(adapter);

        for (const [id, def] of Object.entries(STATE_DEFS)) {
            if (def.apiField !== undefined) {
                assert.strictEqual(objects.has(id), false,
                    `apiField-mapped state should NOT be created here: ${id}`);
            } else {
                assert.ok(objects.has(id), `static STATE_DEFS missing: ${id}`);
            }
        }
    });

    it('löscht obsolete Objekte (deviceUuid, uvc_expiry_date, heat_target_temp_reached)', async () => {
        const { adapter, deleted } = makeAdapter();
        // simulate that they exist
        adapter.delObjectAsync = async function (id) { deleted.add(id); };
        await stateMgr.createStates(adapter);
        assert.ok(deleted.has('device.deviceUuid'));
        assert.ok(deleted.has('status.uvc_expiry_date'));
        assert.ok(deleted.has('status.heat_target_temp_reached'));
    });
});

// ---------------------------------------------------------------------------
// createDynamicStates
// ---------------------------------------------------------------------------
describe('lib/states.js – createDynamicStates', () => {
    it('legt nur States an, deren apiField im rohen Payload vorkommt', async () => {
        const { adapter, objects } = makeAdapter();

        // Auswahl realer apiField-Mappings aus STATE_DEFS
        const mapped = Object.entries(STATE_DEFS).filter(([, d]) => d.apiField !== undefined);
        assert.ok(mapped.length > 0, 'precondition: STATE_DEFS muss apiField-Einträge haben');

        // Nehme die ersten 2 Felder, baue dafür einen "raw"-Payload
        const sample = mapped.slice(0, 2);
        const raw = {};
        for (const [, def] of sample) raw[def.apiField] = 1;

        await stateMgr.createDynamicStates(adapter, raw);

        // Die 2 erwarteten States müssen existieren
        for (const [id] of sample) {
            assert.ok(objects.has(id), `expected dyn state created: ${id}`);
            assert.ok(adapter._dynamicStateIds.has(id), `id missing in tracker set: ${id}`);
        }
        // States deren apiField im raw fehlt: nicht angelegt
        const notInRaw = mapped.find(([, d]) => !(d.apiField in raw));
        if (notInRaw) {
            assert.strictEqual(objects.has(notInRaw[0]), false,
                `unexpected state created for missing apiField: ${notInRaw[0]}`);
        }
    });

    it('leerer raw → keine States, _dynamicStateIds leer', async () => {
        const { adapter, objects } = makeAdapter();
        await stateMgr.createDynamicStates(adapter, {});
        // keine apiField-Felder im raw → keine Erzeugung
        for (const [id, def] of Object.entries(STATE_DEFS)) {
            if (def.apiField !== undefined) {
                assert.strictEqual(objects.has(id), false, `should not exist: ${id}`);
            }
        }
        assert.strictEqual(adapter._dynamicStateIds.size, 0);
    });

    it('null/undefined raw bricht nicht', async () => {
        const { adapter } = makeAdapter();
        await stateMgr.createDynamicStates(adapter, null);
        await stateMgr.createDynamicStates(adapter, undefined);
        assert.strictEqual(adapter._dynamicStateIds.size, 0);
    });
});

// ---------------------------------------------------------------------------
// updateDeviceInfo
// ---------------------------------------------------------------------------
describe('lib/states.js – updateDeviceInfo', () => {
    it('schreibt alle device.* Felder vom API-Client', async () => {
        const api = {
            model: 'F-TU062W', series: 'FRAME',
            softwareVersion: '106', wifiVersion: '141', mcuVersion: 'mcu-3A1',
            serialNumber: 'SN-001', deviceAlias: 'My Spa',
            macAddress: 'AA:BB:CC:DD:EE:FF', productId: 'P1',
            productTubPk: 'tub-pk', serviceRegion: 'EU', activateIp: '1.2.3.4',
            bindingTime: '2024-01-01', activateTime: '2024-01-02',
            bindingRole: 1, isCloudActivated: 1, productPicUrl: 'http://x',
        };
        const { adapter, states } = makeAdapter({ _api: api });
        await stateMgr.updateDeviceInfo(adapter);

        assert.strictEqual(states.get('device.model'), 'F-TU062W');
        assert.strictEqual(states.get('device.series'), 'FRAME');
        assert.strictEqual(states.get('device.alias'), 'My Spa');
        assert.strictEqual(states.get('device.bindingRole'), 1);
        assert.strictEqual(states.get('device.isCloudActivated'), true);
        assert.strictEqual(states.get('device.pictureUrl'), 'http://x');
    });

    it('null-Felder werden mit Leerstring geschrieben (defensiv)', async () => {
        const api = {
            model: null, series: undefined, softwareVersion: '',
            wifiVersion: null, mcuVersion: null, serialNumber: null,
            deviceAlias: null, macAddress: null, productId: null,
            productTubPk: null, serviceRegion: null, activateIp: null,
            bindingTime: null, activateTime: null,
            bindingRole: null, isCloudActivated: null, productPicUrl: '',
        };
        const { adapter, states } = makeAdapter({ _api: api });
        await stateMgr.updateDeviceInfo(adapter);

        assert.strictEqual(states.get('device.model'), '');
        assert.strictEqual(states.get('device.series'), '');
        // bindingRole / isCloudActivated null → nicht geschrieben
        assert.strictEqual(states.has('device.bindingRole'), false);
        assert.strictEqual(states.has('device.isCloudActivated'), false);
        assert.strictEqual(states.has('device.pictureUrl'), false);
    });

    it('isCloudActivated=0 ⇒ false', async () => {
        const { adapter, states } = makeAdapter({ _api: { isCloudActivated: 0 } });
        await stateMgr.updateDeviceInfo(adapter);
        assert.strictEqual(states.get('device.isCloudActivated'), false);
    });
});

// ---------------------------------------------------------------------------
// setStatusCheck
// ---------------------------------------------------------------------------
describe('lib/states.js – setStatusCheck', () => {
    it('schreibt info.statusCheck mit ack', async () => {
        const { adapter, states } = makeAdapter();
        await stateMgr.setStatusCheck(adapter, 'send');
        assert.strictEqual(states.get('info.statusCheck'), 'send');
        await stateMgr.setStatusCheck(adapter, 'success');
        assert.strictEqual(states.get('info.statusCheck'), 'success');
        await stateMgr.setStatusCheck(adapter, 'error');
        assert.strictEqual(states.get('info.statusCheck'), 'error');
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
describe('lib/states.js – buildCommon()', () => {
    it('boolean default = false', () => {
        const c = stateMgr.buildCommon('x', { name: 'X', role: 'indicator', type: 'boolean', read: true, write: false });
        assert.strictEqual(c.def, false);
    });
    it('number default = min ?? 0', () => {
        const a = stateMgr.buildCommon('x', { name: 'X', role: 'value', type: 'number', read: true, write: false, min: 5 });
        assert.strictEqual(a.def, 5);
        const b = stateMgr.buildCommon('x', { name: 'X', role: 'value', type: 'number', read: true, write: false });
        assert.strictEqual(b.def, 0);
    });
    it('explizites def übernimmt', () => {
        const c = stateMgr.buildCommon('x', { name: 'X', role: 'text', type: 'string', read: true, write: false, def: 'abc' });
        assert.strictEqual(c.def, 'abc');
    });
    it('unit/min/max/states werden nur bei Vorhandensein gesetzt', () => {
        const c = stateMgr.buildCommon('x', {
            name: 'X', role: 'value', type: 'number', read: true, write: false,
            unit: 'h', min: 0, max: 100, states: { 0: 'off', 1: 'on' },
        });
        assert.strictEqual(c.unit, 'h');
        assert.strictEqual(c.min, 0);
        assert.strictEqual(c.max, 100);
        assert.deepStrictEqual(c.states, { 0: 'off', 1: 'on' });
    });
});
