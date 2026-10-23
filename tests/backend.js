import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function equal(actual, expected, message) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function until(predicate, message, timeout = 3500) {
    const end = GLib.get_monotonic_time() + timeout * 1000;
    while (!predicate()) {
        assert(GLib.get_monotonic_time() < end, `Timed out: ${message}`);
        await sleep(10);
    }
}

async function rejects(promise, message) {
    let error;
    try {
        await promise;
    } catch (caught) {
        error = caught;
    }
    assert(error, message);
    return error;
}

const BUS = 'org.gnome.Mutter.DisplayConfig';
const PATH = '/org/gnome/Mutter/DisplayConfig';
const STATE_TYPE = '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})';
const XML = `<node><interface name="${BUS}">
    <method name="GetCurrentState">
        <arg direction="out" type="u"/>
        <arg direction="out" type="a((ssss)a(siiddada{sv})a{sv})"/>
        <arg direction="out" type="a(iiduba(ssss)a{sv})"/>
        <arg direction="out" type="a{sv}"/>
    </method>
    <method name="ApplyMonitorsConfig">
        <arg direction="in" type="u"/><arg direction="in" type="u"/>
        <arg direction="in" type="a(iiduba(ssa{sv}))"/>
        <arg direction="in" type="a{sv}"/>
    </method>
    <property name="UnusedProbe" type="s" access="read"/>
    <signal name="MonitorsChanged"/>
</interface></node>`;
const variant = (type, value) => new GLib.Variant(type, value);
const GOOD_EDID = {rx: 0.64, ry: 0.33, gx: 0.30, gy: 0.60, bx: 0.15, by: 0.06};
const BAD_EDID = {rx: 0.31, ry: 0.33, gx: 0.31, gy: 0.33, bx: 0.31, by: 0.33};
const FLAT_EDID = {rx: 0.1, ry: 0.1, gx: 0.2, gy: 0.2, bx: 0.3, by: 0.3};

function monitor(connector, color = 0, overrides = {}) {
    return {
        connector, color, supported: [0, 2], rgb: 2, underscan: false,
        mode: '2560x1440@165.000-vrr', active: true, leased: false,
        ...overrides,
    };
}

function spec(monitor) {
    return [monitor.connector, 'VENDOR', `Display-${monitor.connector}`, `SERIAL-${monitor.connector}`];
}

// Only the external compositor is fake: the wire uses real GVariant, GDBus and signals.
class DisplayService {
    constructor(connection) {
        this.connection = connection;
        this.exported = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this.exported.export(connection, PATH);
        this.reset();
    }

    reset(monitors = [monitor('DP-1')]) {
        for (const release of this.held ?? [])
            release();
        this.monitors = monitors;
        this.serial = 10;
        this.queries = 0;
        this.applies = [];
        this.propertyReads = 0;
        this.activeApplies = 0;
        this.maxActiveApplies = 0;
        this.holdGet = false;
        this.holdApply = false;
        this.held = [];
        this.getDelay = 0;
        this.failGet = 0;
        this.applyErrors = [];
        this.ignore = new Set();
        this.afterApply = null;
    }

    get UnusedProbe() {
        this.propertyReads++;
        return 'must not be loaded by the controller';
    }

    snapshot() {
        const monitors = this.monitors.map(m => [
            spec(m),
            [[m.mode, 2560, 1440, 165.0, 1.25, [1.0, 1.25, 2.0], {
                'is-current': variant('b', m.active),
                'is-preferred': variant('b', true),
            }]],
            {
                'color-mode': variant('u', m.color),
                'supported-color-modes': variant('au', m.supported),
                'rgb-range': variant('u', m.rgb),
                'is-underscanning': variant('b', m.underscan),
                'is-for-lease': variant('b', m.leased),
                'is-builtin': variant('b', m.connector.startsWith('eDP')),
                'display-name': variant('s', m.connector),
            },
        ]);
        const logical = this.monitors.filter(m => m.active && !m.leased).map((m, i) => [
            i * 2048, i % 2 ? 120 : 0, 1.25, i % 4, i === 0, [spec(m)], {},
        ]);
        return variant(STATE_TYPE, [this.serial, monitors, logical, {
            'supports-changing-layout-mode': variant('b', true),
            'layout-mode': variant('u', 2),
        }]);
    }

    async GetCurrentStateAsync(_params, invocation) {
        this.queries++;
        const reply = this.snapshot();
        const failure = this.queries === this.failGet;
        const finish = () => {
            if (failure)
                invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', 'fixture readback failure');
            else
                invocation.return_value(reply);
        };
        if (this.holdGet) {
            this.holdGet = false;
            this.held.push(finish);
        } else {
            if (this.getDelay)
                await sleep(this.getDelay);
            finish();
        }
    }

    ApplyMonitorsConfigAsync(params, invocation) {
        this.applies.push(params);
        this.activeApplies++;
        this.maxActiveApplies = Math.max(this.maxActiveApplies, this.activeApplies);
        const finish = () => {
            this.activeApplies--;
            const error = this.applyErrors.shift();
            if (error) {
                if (error.stale)
                    this.serial++;
                invocation.return_dbus_error(error.name, error.message);
                return;
            }
            if (params[0] !== this.serial) {
                invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied',
                    'The requested configuration is based on stale information');
                return;
            }
            for (const logical of params[2]) {
                for (const [connector, , options] of logical[5]) {
                    const m = this.monitors.find(item => item.connector === connector);
                    if (m && !this.ignore.has(connector) && options['color-mode'])
                        m.color = options['color-mode'].deep_unpack();
                }
            }
            this.serial++;
            this.afterApply?.();
            invocation.return_value(variant('()', []));
            this.changed();
        };
        if (this.holdApply) {
            this.holdApply = false;
            this.held.push(finish);
        } else {
            finish();
        }
    }

    release() {
        assert(this.held.length > 0, 'Expected a held D-Bus invocation');
        this.held.shift()();
    }

    changed() {
        this.exported.emit_signal('MonitorsChanged', variant('()', []));
    }
}

async function main() {
    assert(GLib.getenv('FORCE_SDR_TEST_BUS') === 'private',
        'Run tests/run.sh; the suite must not use the user session bus');
    assert(Gio.File.new_for_path('displayConfig.js').query_exists(null),
        'v3 requires a Shell-independent displayConfig.js controller');
    const {DisplayConfigController} = await import('../displayConfig.js');
    assert(typeof DisplayConfigController === 'function',
        'displayConfig.js must export DisplayConfigController');

    const connection = await new Promise((resolve, reject) => {
        Gio.bus_get(Gio.BusType.SESSION, null, (_source, result) => {
            try {
                resolve(Gio.bus_get_finish(result));
            } catch (error) {
                reject(error);
            }
        });
    });
    const service = new DisplayService(connection);
    let owner;
    await new Promise((resolve, reject) => {
        owner = Gio.bus_own_name_on_connection(connection, BUS, Gio.BusNameOwnerFlags.NONE,
            resolve, () => reject(new Error('Could not own fake DisplayConfig service')));
    });
    let controllers = [];
    function controller(edids = {}) {
        const states = [];
        const edidReads = new Map();
        const instance = new DisplayConfigController(state => states.push({...state}));
        instance._readEdidChromaticity = async connector => {
            edidReads.set(connector, (edidReads.get(connector) ?? 0) + 1);
            return Object.hasOwn(edids, connector) ? edids[connector] : GOOD_EDID;
        };
        controllers.push(instance);
        return {instance, states, edidReads, last: () => states.at(-1)};
    }
    const stale = () => ({
        name: 'org.freedesktop.DBus.Error.AccessDenied',
        message: 'The requested configuration is based on stale information',
        stale: true,
    });
    const tests = [
        ['asynchronous startup keeps heartbeat alive, skips GetAll, restores and reads back', async () => {
            service.getDelay = 60;
            const c = controller();
            let beats = 0;
            const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
                beats++;
                return GLib.SOURCE_CONTINUE;
            });
            try {
                await c.instance.start();
            } finally {
                GLib.source_remove(heartbeat);
            }
            assert(beats >= 8, 'D-Bus initialization/query blocked the main loop');
            equal(service.propertyReads, 0, 'Unused proxy properties must not call GetAll');
            equal(service.applies.length, 1, 'Startup restoration must apply once');
            equal(service.applies[0][1], 1, 'Only TEMPORARY configuration is permitted');
            assert(service.queries >= 2, 'Startup must read back actual compositor state');
            assert(c.last().ready && !c.last().busy && c.last().checked, 'Final state must reflect native SDR');
        }],
        ['mixed displays retain HDR, unknown modes, full layout, VRR, RGB, underscan and leases', async () => {
            service.reset([
                monitor('DP-1', 0, {underscan: true}), monitor('HDMI-1', 2),
                monitor('eDP-1', 1), monitor('DP-2', 0, {supported: [0]}),
                monitor('DP-3', 2), monitor('DP-4'), monitor('DP-5'),
                monitor('DP-6', 9, {supported: [0, 2, 9]}),
                monitor('DP-9', 2, {active: false, leased: true}),
            ]);
            const c = controller({'eDP-1': BAD_EDID, 'DP-3': BAD_EDID, 'DP-4': FLAT_EDID, 'DP-5': null});
            await c.instance.start();
            equal(service.monitors.map(m => m.color), [2, 2, 1, 0, 0, 0, 2, 9, 2],
                'Only eligible SDR/default or bad-native outputs may change');
            equal([c.last().eligibleCount, c.last().nativeCount, c.last().hdrCount, c.last().blockedCount],
                [3, 3, 1, 2], 'Published monitor counts');
            assert(c.last().checked, 'All eligible monitors are native');
            const [, method, logical, properties] = service.applies[0];
            equal(method, 1, 'Mixed layout must remain temporary');
            equal(logical.map(l => l.slice(0, 5)), [
                [0, 0, 1.25, 0, true], [2048, 120, 1.25, 1, false],
                [4096, 0, 1.25, 2, false], [6144, 120, 1.25, 3, false],
                [8192, 0, 1.25, 0, false], [10240, 120, 1.25, 1, false],
                [12288, 0, 1.25, 2, false], [14336, 120, 1.25, 3, false],
            ], 'Geometry, scale, transform and primary must survive');
            const assignments = logical.flatMap(l => l[5]);
            for (const [connector, mode, options] of assignments) {
                equal(mode, '2560x1440@165.000-vrr', `${connector}: retain complete mode ID`);
                equal(options['rgb-range'].deep_unpack(), 2, `${connector}: retain RGB range`);
                equal(options.underscanning.deep_unpack(), connector === 'DP-1', `${connector}: retain underscan`);
                assert(options['color-mode'] instanceof GLib.Variant, `${connector}: color mode must be typed`);
            }
            equal(properties['layout-mode'].get_type_string(), 'u', 'Layout mode keeps Variant type');
            equal(properties['layout-mode'].deep_unpack(), 2, 'Layout mode preserved');
            equal(properties['monitors-for-lease'].get_type_string(), 'a(ssss)', 'Lease property type');
            equal(properties['monitors-for-lease'].deep_unpack(),
                [['DP-9', 'VENDOR', 'Display-DP-9', 'SERIAL-DP-9']], 'Lease keeps complete monitor identity');
            assert(!assignments.some(a => a[0] === 'DP-9'), 'Leased output must not be assigned to desktop');
            await c.instance.setEnabled(false);
            assert(!c.last().checked && !c.last().busy, 'OFF publishes read-back default');
            equal(service.monitors.map(m => m.color), [0, 0, 1, 0, 0, 0, 0, 9, 2], 'OFF never disables HDR/lease/unknown mode');
            const applyCount = service.applies.length;
            service.changed();
            await sleep(1100);
            equal(service.applies.length, applyCount, 'OFF must not automatically restore SDR native');
        }],
        ['successful method reply with unapplied target reports partial actual state, not success', async () => {
            service.reset([monitor('DP-1', 2), monitor('DP-2', 2)]);
            const c = controller();
            await c.instance.start();
            await c.instance.setEnabled(false);
            service.ignore.add('DP-2');
            await rejects(c.instance.setEnabled(true), 'Readback mismatch must reject');
            equal([c.last().eligibleCount, c.last().nativeCount, c.last().checked], [2, 1, false],
                'Partial state comes from the real readback, not the requested target');
            assert(c.last().error, 'Unapplied target must expose error');
            const attempts = service.applies.length;
            await sleep(1100);
            equal(service.applies.length, attempts, 'Own signal cannot cause unbounded mismatch retries');
        }],
        ['ordinary apply failure rejects and reports error without optimistic state or retry', async () => {
            service.reset([monitor('DP-1', 2)]);
            const c = controller();
            await c.instance.start();
            service.applyErrors.push({name: 'org.freedesktop.DBus.Error.Failed', message: 'fixture apply denied'});
            await rejects(c.instance.setEnabled(false), 'Apply failure must reject');
            assert(c.last().checked && c.last().error && !c.last().busy, 'Failed OFF keeps actual native state');
            equal(service.applies.length, 1, 'Non-stale errors must not retry');
        }],
        ['readback failure rejects and cannot publish requested mode as actual success', async () => {
            service.reset([monitor('DP-1', 2)]);
            const c = controller();
            await c.instance.start();
            await c.instance.setEnabled(false);
            service.failGet = service.queries + 2;
            await rejects(c.instance.setEnabled(true), 'Readback failure must reject');
            assert(!c.last().checked && c.last().error && !c.last().busy,
                'Failed readback must keep last confirmed default state');
            const queries = service.queries;
            await sleep(1100);
            equal(service.queries, queries, 'Readback failure must not replay its own apply signal');
        }],
        ['MonitorsChanged during an in-flight query is coalesced, not lost', async () => {
            service.reset([monitor('DP-1', 2)]);
            service.holdGet = true;
            const c = controller();
            const starting = c.instance.start();
            await until(() => service.held.length === 1, 'initial query reaches fake service');
            service.monitors.push(monitor('DP-2'));
            service.serial++;
            service.changed();
            await sleep(20);
            service.release();
            await starting;
            await until(() => c.last().eligibleCount === 2 && c.last().nativeCount === 2 && !c.last().busy,
                'queued hotplug is reconciled');
            equal(service.applies.length, 1, 'New SDR monitor must be restored exactly once');
            equal(service.maxActiveApplies, 1, 'Reconciliations may not apply concurrently');
        }],
        ['a queued monitor change recovers once after an initial query failure without hiding rejection', async () => {
            service.holdGet = true;
            service.failGet = 1;
            const c = controller();
            const starting = c.instance.start();
            await until(() => service.held.length === 1, 'initial failing query');
            service.monitors.push(monitor('DP-2'));
            service.serial++;
            service.changed();
            await sleep(20);
            service.release();
            await rejects(starting, 'Original initial-query failure must still reject');
            await until(() => c.last().ready && !c.last().busy && c.last().nativeCount === 2,
                'queued change recovers after query failure');
            equal(c.last().eligibleCount, 2, 'Recovery uses fresh hotplug state');
            assert(!c.last().error, 'Successful recovery clears the original error');
            equal(service.applies.length, 1, 'Recovery applies the fresh layout once');
        }],
        ['a failed recovery stops after one retry even if another signal arrives during that recovery', async () => {
            service.holdGet = true;
            service.failGet = 1;
            const c = controller();
            const starting = c.instance.start();
            await until(() => service.held.length === 1, 'first failing query');
            service.failGet = 2;
            service.holdGet = true;
            service.changed();
            await sleep(20);
            service.release();
            await rejects(starting, 'Original query must reject before bounded recovery');
            await until(() => service.queries === 2 && service.held.length === 1, 'one recovery query');
            service.changed();
            await sleep(20);
            service.release();
            await sleep(1150);
            equal(service.queries, 2, 'Failure during recovery may not schedule an endless signal retry');
            equal(service.applies.length, 0, 'Failed queries must never submit a configuration');
            assert(!c.last().ready && !c.last().busy && c.last().error,
                'Exhausted recovery exposes the real unavailable state');
        }],
        ['a monitor added before an apply reply is reconciled instead of dropping its signal', async () => {
            service.afterApply = () => {
                service.afterApply = null;
                service.monitors.push(monitor('DP-2'));
                service.serial++;
                service.changed();
            };
            const c = controller();
            await c.instance.start();
            await until(() => c.last().nativeCount === 2 && !c.last().busy, 'apply-time hotplug restoration');
            equal(service.applies.length, 2, 'The new default monitor requires a second configuration');
            equal(service.maxActiveApplies, 1, 'Hotplug must not overlap applies');
        }],
        ['overlapping OFF and ON requests serialize and settle on the last requested policy', async () => {
            service.reset([monitor('DP-1', 2)]);
            const c = controller();
            await c.instance.start();
            service.holdApply = true;
            const off = c.instance.setEnabled(false);
            assert(c.last().busy, 'setEnabled must publish busy synchronously');
            await until(() => service.held.length === 1, 'pending OFF apply');
            const on = c.instance.setEnabled(true);
            equal(service.applies.length, 1, 'ON must not submit a concurrent apply');
            service.release();
            await Promise.all([off, on]);
            equal(service.applies.length, 2, 'Latest policy must be applied after pending OFF');
            equal(service.maxActiveApplies, 1, 'Only one ApplyMonitorsConfig may be in flight');
            assert(c.last().checked && !c.last().busy, 'Last request ON must win with readback');
        }],
        ['EDID results are cached until MonitorsChanged invalidates the connector result', async () => {
            service.reset([monitor('DP-1', 2)]);
            const edids = {'DP-1': GOOD_EDID};
            const c = controller(edids);
            await c.instance.start();
            await c.instance.setEnabled(true);
            equal(c.edidReads.get('DP-1'), 1, 'Unchanged snapshot must reuse the EDID read');
            edids['DP-1'] = BAD_EDID;
            service.changed();
            await until(() => c.last().blockedCount === 1 && !c.last().busy && service.monitors[0].color === 0,
                'changed EDID falls back to default');
            assert(c.edidReads.get('DP-1') >= 2, 'Signal must invalidate cached EDID');
            assert(!c.last().checked && c.last().eligibleCount === 0, 'Bad EDID cannot remain eligible');
        }],
        ['stale serial retries once with a fresh query and current serial', async () => {
            service.applyErrors.push(stale());
            const c = controller();
            await c.instance.start();
            equal(service.applies.length, 2, 'One stale serial permits one retry');
            equal(service.applies.map(a => a[0]), [10, 11], 'Retry must not reuse a stale snapshot');
            assert(c.last().checked && !c.last().error, 'Successful retry publishes actual native state');
        }],
        ['persistent stale errors stop at two attempts and surface failure', async () => {
            service.reset([monitor('DP-1', 2)]);
            const c = controller();
            await c.instance.start();
            service.applyErrors.push(stale(), stale(), stale());
            await rejects(c.instance.setEnabled(false), 'Repeated stale serial must reject');
            await sleep(1100);
            equal(service.applies.length, 2, 'Stale retry must be bounded');
            assert(c.last().error && !c.last().busy, 'Exhausted retry exposes settled error');
        }],
        ['stop during proxy initialization prevents work and is irreversible', async () => {
            const c = controller();
            const starting = c.instance.start();
            c.instance.stop();
            const count = c.states.length;
            await starting;
            await c.instance.start();
            await c.instance.setEnabled(true);
            await sleep(40);
            equal(c.states.length, count, 'Stopped controller must not publish late state');
            equal(service.queries, 0, 'Stop during init must prevent initial query and restart');
            equal(service.applies.length, 0, 'Stopped controller must not apply');
        }],
        ['stop during query cancels the continuation without reporting cancellation as an error', async () => {
            service.holdGet = true;
            const c = controller();
            const starting = c.instance.start();
            await until(() => service.held.length === 1, 'held query');
            c.instance.stop();
            const count = c.states.length;
            service.release();
            await starting;
            service.changed();
            await sleep(40);
            equal(c.states.length, count, 'Query completion after stop must be ignored');
            equal(service.applies.length, 0, 'Query completion after stop must not apply');
        }],
        ['stop during asynchronous EDID read prevents later application and publication', async () => {
            const c = controller();
            let release;
            c.instance._readEdidChromaticity = () => new Promise(resolve => {
                release = resolve;
            });
            const starting = c.instance.start();
            await until(() => release, 'pending EDID read');
            c.instance.stop();
            const count = c.states.length;
            release(GOOD_EDID);
            await starting;
            equal(service.applies.length, 0, 'Stopped EDID continuation may not apply');
            equal(c.states.length, count, 'Stopped EDID continuation may not publish');
        }],
        ['stop during apply permits no readback, followup timer or late publication', async () => {
            service.holdApply = true;
            const c = controller();
            const starting = c.instance.start();
            await until(() => service.held.length === 1 && service.applies.length === 1, 'held apply');
            c.instance.stop();
            const count = c.states.length;
            const queries = service.queries;
            service.release();
            await starting;
            await sleep(1100);
            equal(c.states.length, count, 'Apply completion after stop must not publish');
            equal(service.queries, queries, 'Apply completion after stop must not read back');
            equal(service.applies.length, 1, 'Stop must remove pending reconciliation timers');
        }],
        ['a rapidly replaced instance is unaffected by the old delayed query callback', async () => {
            service.holdGet = true;
            const old = controller();
            const oldStart = old.instance.start();
            await until(() => service.held.length === 1, 'old instance query');
            old.instance.stop();
            const count = old.states.length;
            const current = controller();
            await current.instance.start();
            service.release();
            await oldStart;
            await sleep(40);
            equal(old.states.length, count, 'Old instance cannot publish into replacement UI');
            assert(current.last().checked && !current.last().error, 'Replacement instance remains valid');
            equal(service.applies.length, 1, 'Only current instance may apply');
        }],
    ];

    let failures = 0;
    try {
        for (const [name, run] of tests) {
            service.reset();
            try {
                await run();
                print(`PASS ${name}`);
            } catch (error) {
                failures++;
                printerr(`FAIL ${name}\n${error}\n${error.stack ?? ''}`);
            } finally {
                for (const instance of controllers)
                    instance.stop();
                controllers = [];
                while (service.held.length)
                    service.release();
                await sleep(30);
            }
        }
    } finally {
        Gio.bus_unown_name(owner);
        service.exported.unexport();
    }
    print(`Backend: ${tests.length - failures}/${tests.length} passed`);
    assert(failures === 0, `${failures} backend tests failed`);
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
main().catch(error => {
    printerr(String(error));
    printerr(error.stack ?? error);
    exitCode = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(exitCode);
