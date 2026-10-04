'use strict';

const assert = require('assert');
const {setFeature} = require('../lib/commands');

function makeAdapter(interlockState) {
    let heaterCommands = 0;
    const adapter = {
        config: {
            more_log_enabled: false,
            pv_state_start_temporary: 'system.test.heater_block',
        },
        _adapterCommanded: {heater: null, filter: null},
        _lastData: {filter: 'on'},
        _api: {
            _lastCommandConfirmed: true,
            setHeaterState: async () => {
                heaterCommands++;
                return {message: 'SUCCESS'};
            },
        },
        _pendingTargetTemp: null,
        _pendingTempTimer: null,
        getForeignStateAsync: async () => Array.isArray(interlockState) ? interlockState.shift() : interlockState,
        setStatusCheck: async () => {},
        setState: () => {},
        setStray: () => {},
        log: {debug: () => {}, info: () => {}, warn: () => {}},
    };
    return {adapter, getHeaterCommands: () => heaterCommands};
}

describe('temporary heater start interlock', () => {
    it('blocks automatic heater starts when the configured state is false', async () => {
        const {adapter, getHeaterCommands} = makeAdapter({val: false});

        await setFeature(adapter, 'heater', true, {fromAutomation: true});

        assert.strictEqual(getHeaterCommands(), 0);
    });

    it('allows automatic heater starts when the configured state is unavailable', async () => {
        const {adapter, getHeaterCommands} = makeAdapter(null);

        await setFeature(adapter, 'heater', true, {fromAutomation: true});

        assert.strictEqual(getHeaterCommands(), 1);
    });

    it('allows automatic heater starts when reading the configured state fails', async () => {
        const {adapter, getHeaterCommands} = makeAdapter(null);
        adapter.getForeignStateAsync = async () => {
            throw new Error('state database unavailable');
        };

        await setFeature(adapter, 'heater', true, {fromAutomation: true});

        assert.strictEqual(getHeaterCommands(), 1);
    });

    it('allows automatic heater starts when the configured state is true', async () => {
        const {adapter, getHeaterCommands} = makeAdapter({val: true});

        await setFeature(adapter, 'heater', true, {fromAutomation: true});

        assert.strictEqual(getHeaterCommands(), 1);
    });

    it('allows a manual heater start when the configured state is false', async () => {
        const {adapter, getHeaterCommands} = makeAdapter({val: false});

        await setFeature(adapter, 'heater', true, {fromUser: true});

        assert.strictEqual(getHeaterCommands(), 1);
    });

    it('rechecks the interlock immediately before sending an automatic heater command', async () => {
        const {adapter, getHeaterCommands} = makeAdapter([{val: true}, {val: false}]);

        await setFeature(adapter, 'heater', true, {fromAutomation: true});

        assert.strictEqual(getHeaterCommands(), 0);
    });
});
