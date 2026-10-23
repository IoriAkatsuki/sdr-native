'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return {promise, resolve, reject};
}

const readyState = {
    ready: true,
    busy: false,
    checked: false,
    eligibleCount: 2,
    nativeCount: 0,
    hdrCount: 0,
    blockedCount: 0,
    error: null,
};

async function loadExtension() {
    const indicators = [];
    const controllers = [];
    const errors = [];

    class Actor {
        constructor(params = {}) {
            this.signals = new Map();
            this.destroyCalls = 0;
            Object.assign(this, params);
        }

        connect(signal, callback) {
            this.signals.set(signal, callback);
            return this.signals.size;
        }

        destroy() {
            this.destroyCalls++;
            this.signals.clear();
        }
    }

    class QuickToggle extends Actor {
        constructor(params) {
            super({checked: false, reactive: true, can_focus: true, ...params});
        }

        click() {
            if (!this.reactive)
                return;
            if (this.toggleMode)
                this.checked = !this.checked;
            this.signals.get('clicked')?.(this);
        }
    }

    class SystemIndicator extends Actor {
        constructor() {
            super();
            this.quickSettingsItems = [];
            this.panelIcons = [];
        }

        _addIndicator() {
            const icon = new Actor();
            this.panelIcons.push(icon);
            return icon;
        }
    }

    class DisplayConfigController {
        constructor(onState) {
            this.onState = onState;
            this.startResult = deferred();
            this.startCalls = 0;
            this.stopCalls = 0;
            this.requests = [];
            controllers.push(this);
        }

        start() {
            this.startCalls++;
            return this.startResult.promise;
        }

        setEnabled(enabled) {
            const result = deferred();
            this.requests.push({enabled, ...result});
            return result.promise;
        }

        stop() {
            this.stopCalls++;
            this.onState({...readyState, checked: true, nativeCount: 2});
        }

        publish(state) {
            this.onState({...readyState, ...state});
        }
    }

    const context = vm.createContext({console: {error: (...args) => errors.push(args)}});
    const dependencies = {
        'resource:///org/gnome/shell/extensions/extension.js': {Extension: class {}},
        'resource:///org/gnome/shell/ui/quickSettings.js': {QuickToggle, SystemIndicator},
        'resource:///org/gnome/shell/ui/main.js': {
            panel: {statusArea: {quickSettings: {
                addExternalIndicator: indicator => indicators.push(indicator),
            }}},
        },
        './displayConfig.js': {DisplayConfigController},
    };
    const module = new vm.SourceTextModule(
        readFileSync(join(__dirname, '..', 'extension.js'), 'utf8'), {context});
    await module.link(specifier => {
        const exports = dependencies[specifier];
        assert.ok(exports, `unexpected extension dependency: ${specifier}`);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports))
                this.setExport(name, value);
        }, {context});
    });
    await module.evaluate();
    return {extension: new module.namespace.default(), indicators, controllers, errors, Actor};
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('enable immediately exposes one native tile while controller startup is pending', async () => {
    const {extension, indicators, controllers} = await loadExtension();
    assert.equal(extension.enable(), undefined);
    assert.equal(indicators.length, 1, 'Quick Settings must contain the extension tile');
    assert.equal(controllers.length, 1);
    assert.equal(controllers[0].startCalls, 1);
    const [tile] = indicators[0].quickSettingsItems;
    assert.equal(tile.title, 'SDR Native');
    assert.equal(tile.toggleMode, false, 'Shell must not optimistically toggle checked');
    assert.equal(tile.reactive, false);
    assert.equal(tile.can_focus, false);
    assert.match(tile.subtitle, /读取|加载/);
    assert.equal(indicators[0].panelIcons.length, 0, 'no extra top-panel icon');
    tile.click();
    assert.equal(controllers[0].requests.length, 0);
    extension.disable();
});

test('clicks request the inverse actual state and wait for readback without duplicate requests', async () => {
    const {extension, indicators, controllers} = await loadExtension();
    extension.enable();
    assert.equal(indicators.length, 1);
    const [tile] = indicators[0].quickSettingsItems;
    const controller = controllers[0];
    controller.publish({});
    tile.click();
    tile.click();
    assert.equal(controller.requests.length, 1);
    assert.equal(controller.requests[0].enabled, true);
    assert.equal(tile.checked, false, 'request submission is not success');
    assert.equal(tile.reactive, false);
    controller.requests[0].resolve();
    await settle();
    assert.equal(tile.checked, false, 'promise resolution is not actual-state readback');
    controller.publish({checked: true, nativeCount: 2});
    assert.equal(tile.checked, true);
    tile.click();
    assert.equal(controller.requests[1].enabled, false);
    assert.equal(tile.checked, true);
    controller.publish({checked: true, nativeCount: 2, error: '拒绝更改'});
    controller.requests[1].reject(new Error('拒绝更改'));
    await settle();
    assert.equal(tile.checked, true, 'failed OFF must preserve actual ON');
    assert.match(tile.subtitle, /失败|错误/);
    assert.match(tile.subtitle, /拒绝更改/);
    assert.equal(tile.reactive, true, 'a failed operation can be retried');
    extension.disable();
});

test('partial, HDR, bad EDID, unavailable and busy states remain visible and safe', async () => {
    const {extension, indicators, controllers} = await loadExtension();
    extension.enable();
    assert.equal(indicators.length, 1);
    const [tile] = indicators[0].quickSettingsItems;
    const controller = controllers[0];
    controller.publish({checked: true, nativeCount: 1, hdrCount: 1, blockedCount: 1});
    assert.match(tile.subtitle, /部分/);
    assert.match(tile.subtitle, /1\/2/);
    assert.match(tile.subtitle, /HDR/);
    assert.match(tile.subtitle, /EDID/);
    assert.equal(tile.reactive, true);
    for (const state of [
        {ready: false},
        {busy: true},
    ]) {
        controller.publish(state);
        assert.equal(tile.reactive, false);
        assert.equal(tile.can_focus, false);
        tile.click();
    }
    controller.publish({eligibleCount: 0, hdrCount: 1, blockedCount: 1});
    assert.match(tile.subtitle, /EDID.*保护/);
    assert.doesNotMatch(tile.subtitle, /HDR/, 'the blocking reason must fit before other details');
    assert.equal(tile.reactive, false);
    tile.click();
    controller.publish({eligibleCount: 0, hdrCount: 1});
    assert.match(tile.subtitle, /HDR.*保持不变/);
    assert.equal(tile.reactive, false);
    tile.click();
    controller.publish({eligibleCount: 0});
    assert.match(tile.subtitle, /无兼容.*SDR/);
    assert.equal(tile.reactive, false);
    tile.click();
    assert.equal(controller.requests.length, 0);
    extension.disable();
});

test('disable destroys every tile and ignores old callbacks across fast re-enable', async () => {
    const {extension, indicators, controllers, errors, Actor} = await loadExtension();
    extension.enable();
    assert.equal(indicators.length, 1);
    const oldIndicator = indicators[0];
    const oldTile = oldIndicator.quickSettingsItems[0];
    const extraTile = new Actor();
    oldIndicator.quickSettingsItems.push(extraTile);
    const oldController = controllers[0];
    oldController.publish({});
    oldTile.click();
    extension.disable();
    assert.equal(oldController.stopCalls, 1);
    assert.equal(oldTile.destroyCalls, 1);
    assert.equal(extraTile.destroyCalls, 1);
    assert.equal(oldIndicator.destroyCalls, 1);
    assert.equal(oldTile.checked, false, 'stop callbacks must be ignored before destruction');
    extension.disable();
    assert.equal(oldController.stopCalls, 1);
    extension.enable();
    assert.equal(controllers.length, 2, 'a stopped controller must never be reused');
    const newTile = indicators[1].quickSettingsItems[0];
    controllers[1].publish({});
    const subtitle = newTile.subtitle;
    oldController.publish({checked: true, nativeCount: 2, error: '过期错误'});
    oldController.startResult.reject(new Error('old startup cancelled'));
    oldController.requests[0].reject(new Error('old apply cancelled'));
    await settle();
    assert.equal(newTile.checked, false);
    assert.equal(newTile.subtitle, subtitle);
    assert.equal(newTile.reactive, true);
    assert.equal(errors.length, 0, 'stale failures must not be reported as current failures');
    extension.disable();
    assert.equal(newTile.destroyCalls, 1);
    assert.equal(controllers[1].stopCalls, 1);
});

test('startup errors are handled and shown rather than leaving an active loading tile', async () => {
    const {extension, indicators, controllers, errors} = await loadExtension();
    extension.enable();
    assert.equal(indicators.length, 1);
    const [tile] = indicators[0].quickSettingsItems;
    controllers[0].publish({ready: false, eligibleCount: 0, error: '显示服务不可用'});
    controllers[0].startResult.reject(new Error('显示服务不可用'));
    await settle();
    assert.match(tile.subtitle, /显示服务不可用/);
    assert.equal(tile.reactive, false);
    assert.equal(errors.length, 1);
    extension.disable();
});
