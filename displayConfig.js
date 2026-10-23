// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DISPLAY_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';
const DEFAULT = 0;
const HDR = 1;
const SDR_NATIVE = 2;
const TEMPORARY = 1;
const DEBOUNCE_MS = 900;
const CHROM_EPS = 1e-4;

function unpackProps(properties) {
    return Object.fromEntries(Object.entries(properties ?? {}).map(([key, value]) =>
        [key, value instanceof GLib.Variant ? value.deep_unpack() : value]));
}

export class DisplayConfigController {
    constructor(onState) {
        this._onState = onState;
        this._proxy = null;
        this._signalId = 0;
        this._debounceId = 0;
        this._cancellable = new Gio.Cancellable();
        this._stopped = false;
        this._enabled = true;
        this._startPromise = null;
        this._running = null;
        this._dirty = false;
        this._initialQueryFailed = false;
        this._edidCache = new Map();
        this._state = {
            ready: false, busy: false, checked: false,
            eligibleCount: 0, nativeCount: 0, hdrCount: 0, blockedCount: 0,
            error: null,
        };
    }

    start() {
        if (this._stopped)
            return Promise.resolve();
        if (!this._startPromise) {
            this._publish({busy: true, error: null});
            this._startPromise = this._start();
        }
        return this._startPromise;
    }

    async _start() {
        try {
            const started = GLib.get_monotonic_time();
            const proxy = await new Promise((resolve, reject) => {
                Gio.DBusProxy.new_for_bus(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
                        Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                    null, DISPLAY_NAME, DISPLAY_PATH, DISPLAY_NAME,
                    this._cancellable,
                    (_source, result) => {
                        try {
                            resolve(Gio.DBusProxy.new_for_bus_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            if (this._stopped)
                return;
            console.debug(`[force-sdr-native] proxy ready in ${this._elapsed(started)}ms`);
            this._proxy = proxy;
            this._signalId = proxy.connect('g-signal', (_proxy, _sender, name) => {
                if (name !== 'MonitorsChanged' || this._stopped)
                    return;
                this._edidCache.clear();
                this._dirty = true;
                if (this._running)
                    return;
                this._schedule();
            });
            await this._request();
        } catch (error) {
            if (this._stopped)
                return;
            this._publish({busy: false, error: error.message});
            throw error;
        }
    }

    setEnabled(enabled) {
        if (this._stopped)
            return Promise.resolve();
        if (typeof enabled !== 'boolean')
            return Promise.reject(new TypeError('enabled must be a boolean'));
        this._enabled = enabled;
        return this._proxy ? this._request() : this.start();
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        this._clearDebounce();
        if (this._signalId) {
            this._proxy.disconnect(this._signalId);
            this._signalId = 0;
        }
        this._cancellable.cancel();
        this._proxy = null;
        this._onState = null;
        this._dirty = false;
        this._edidCache.clear();
    }

    _publish(changes) {
        if (this._stopped)
            return;
        Object.assign(this._state, changes);
        this._onState?.({...this._state});
    }

    _clearDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }

    _elapsed(started) {
        return Math.round((GLib.get_monotonic_time() - started) / 1000);
    }

    _schedule(allowRecovery = true) {
        if (this._stopped)
            return;
        this._clearDebounce();
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this._request(allowRecovery).catch(error => {
                console.error(`[force-sdr-native] reconcile failed: ${error.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _request(allowRecovery = true) {
        if (this._stopped)
            return Promise.resolve();
        this._dirty = true;
        this._clearDebounce();
        if (!this._running) {
            this._publish({busy: true, error: null});
            this._running = this._drain(allowRecovery);
        }
        return this._running;
    }

    async _drain(allowRecovery) {
        try {
            while (this._dirty && !this._stopped) {
                this._dirty = false;
                await this._reconcile();
            }
        } catch (error) {
            if (this._stopped)
                return;
            this._publish({error: error.message});
            // Consume a pending external change once, without retrying failed applies.
            if (allowRecovery && this._dirty && this._initialQueryFailed)
                this._schedule(false);
            throw error;
        } finally {
            this._running = null;
            this._publish({busy: false});
        }
    }

    _call(method, parameters = null) {
        return new Promise((resolve, reject) => {
            this._proxy.call(method, parameters, Gio.DBusCallFlags.NO_AUTO_START,
                -1, this._cancellable, (proxy, result) => {
                    try {
                        resolve(proxy.call_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }

    async _readState() {
        const started = GLib.get_monotonic_time();
        const variant = await this._call('GetCurrentState');
        if (this._stopped)
            return null;
        const [serial, rawMonitors, logicalMonitors, rawProperties] = variant.deep_unpack();
        const active = new Set(logicalMonitors.flatMap(logical =>
            logical[5].map(spec => spec[0])));
        const monitors = new Map(await Promise.all(rawMonitors.map(async ([spec, modes, raw]) => {
            const properties = unpackProps(raw);
            const connector = spec[0];
            const currentMode = modes.find(mode => unpackProps(mode[6])['is-current'] === true)?.[0];
            const colorMode = properties['color-mode'];
            const supported = properties['supported-color-modes'];
            const supportsNative = Array.isArray(supported) && supported.includes(SDR_NATIVE);
            const isActive = active.has(connector) && Boolean(currentMode) &&
                properties['is-for-lease'] !== true;
            const isSdr = colorMode === DEFAULT || colorMode === SDR_NATIVE;
            let usable = true;
            if (isActive && isSdr && (supportsNative || colorMode === SDR_NATIVE)) {
                if (!this._edidCache.has(connector))
                    this._edidCache.set(connector, this._hasUsableChromaticity(connector));
                usable = await this._edidCache.get(connector);
            }
            return [connector, {
                spec, connector, currentMode, colorMode, supportsNative,
                active: isActive, usable,
                eligible: isActive && isSdr && supportsNative && usable,
                properties,
            }];
        })));
        if (this._stopped)
            return null;
        console.debug(`[force-sdr-native] state and EDID read in ${this._elapsed(started)}ms`);
        return {serial, monitors, logicalMonitors, properties: unpackProps(rawProperties)};
    }

    _publishActual(snapshot) {
        const monitors = [...snapshot.monitors.values()];
        const eligible = monitors.filter(monitor => monitor.eligible);
        const nativeCount = eligible.filter(monitor => monitor.colorMode === SDR_NATIVE).length;
        this._publish({
            ready: true,
            checked: eligible.length > 0 && nativeCount === eligible.length,
            eligibleCount: eligible.length,
            nativeCount,
            hdrCount: monitors.filter(monitor => monitor.active && monitor.colorMode === HDR).length,
            blockedCount: monitors.filter(monitor => monitor.active && !monitor.usable).length,
        });
    }

    _buildApplyConfig(snapshot) {
        const targets = [];
        const logicalMonitors = snapshot.logicalMonitors.map(logical => {
            const [x, y, scale, transform, primary, specs] = logical;
            const assigned = specs.map(([connector]) => {
                const monitor = snapshot.monitors.get(connector);
                if (!monitor?.currentMode)
                    throw new Error(`Incomplete current mode for ${connector}; refusing partial layout`);
                let colorMode = monitor.colorMode;
                if (monitor.active && (colorMode === DEFAULT || colorMode === SDR_NATIVE)) {
                    if (colorMode === SDR_NATIVE && (!monitor.usable || !this._enabled))
                        colorMode = DEFAULT;
                    else if (this._enabled && monitor.eligible)
                        colorMode = SDR_NATIVE;
                }
                if (colorMode !== monitor.colorMode)
                    targets.push({connector, currentMode: monitor.currentMode, colorMode});
                const options = {};
                if (typeof colorMode === 'number')
                    options['color-mode'] = new GLib.Variant('u', colorMode);
                if (typeof monitor.properties['rgb-range'] === 'number')
                    options['rgb-range'] = new GLib.Variant('u', monitor.properties['rgb-range']);
                if (typeof monitor.properties['is-underscanning'] === 'boolean')
                    options.underscanning = new GLib.Variant('b', monitor.properties['is-underscanning']);
                return [connector, monitor.currentMode, options];
            });
            return [x, y, scale, transform, primary, assigned];
        });
        if (!targets.length)
            return null;
        const properties = {};
        if (snapshot.properties['supports-changing-layout-mode'] === true &&
            typeof snapshot.properties['layout-mode'] === 'number')
            properties['layout-mode'] = new GLib.Variant('u', snapshot.properties['layout-mode']);
        const leased = [...snapshot.monitors.values()]
            .filter(monitor => monitor.properties['is-for-lease'] === true)
            .map(monitor => monitor.spec);
        if (leased.length)
            properties['monitors-for-lease'] = new GLib.Variant('a(ssss)', leased);
        return {serial: snapshot.serial, logicalMonitors, properties, targets};
    }

    async _reconcile() {
        this._initialQueryFailed = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            let snapshot;
            try {
                snapshot = await this._readState();
            } catch (error) {
                this._initialQueryFailed = attempt === 0;
                this._publish({ready: false});
                throw error;
            }
            if (this._stopped)
                return;
            this._publishActual(snapshot);
            const config = this._buildApplyConfig(snapshot);
            if (!config)
                return;
            const started = GLib.get_monotonic_time();
            try {
                await this._call('ApplyMonitorsConfig', new GLib.Variant(
                    '(uua(iiduba(ssa{sv}))a{sv})',
                    [config.serial, TEMPORARY, config.logicalMonitors, config.properties]));
            } catch (error) {
                if (this._stopped)
                    return;
                if (attempt === 0 && /stale|invalid serial|serial.*(?:out.of.date|mismatch)/i.test(error.message))
                    continue;
                throw error;
            }
            if (this._stopped)
                return;
            console.log(`[force-sdr-native] temporary ApplyMonitorsConfig reply in ${this._elapsed(started)}ms: ` +
                config.targets.map(target => `${target.connector}->${target.colorMode}`).join(', '));
            let actual;
            try {
                actual = await this._readState();
            } catch (error) {
                this._publish({ready: false});
                throw error;
            }
            if (this._stopped)
                return;
            this._publishActual(actual);
            const unapplied = config.targets.filter(target => {
                const monitor = actual.monitors.get(target.connector);
                return monitor?.active && monitor.currentMode === target.currentMode &&
                    monitor.colorMode !== target.colorMode;
            });
            if (unapplied.length)
                throw new Error(`Display readback did not confirm color mode: ${unapplied.map(t => t.connector).join(', ')}`);
            return;
        }
    }

    _loadContents(file) {
        return new Promise((resolve, reject) => {
            file.load_contents_async(this._cancellable, (source, result) => {
                try {
                    const [, bytes] = source.load_contents_finish(result);
                    resolve(bytes);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    async _readEdidChromaticity(connector) {
        let enumerator;
        try {
            const directory = Gio.File.new_for_path('/sys/class/drm');
            enumerator = await new Promise((resolve, reject) => {
                directory.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT, this._cancellable, (file, result) => {
                        try {
                            resolve(file.enumerate_children_finish(result));
                        } catch (error) {
                            reject(error);
                        }
                    });
            });
            const candidates = new Set([
                connector,
                connector.replace(/^HDMI-/, 'HDMI-A-'),
                connector.replace(/-(\d+)$/, '-A-$1'),
            ]);
            while (!this._stopped) {
                const files = await new Promise((resolve, reject) => {
                    enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, this._cancellable,
                        (source, result) => {
                            try {
                                resolve(source.next_files_finish(result));
                            } catch (error) {
                                reject(error);
                            }
                        });
                });
                if (!files.length)
                    break;
                for (const info of files) {
                    const name = info.get_name();
                    if (!candidates.has(name.replace(/^card\d+-/, '')))
                        continue;
                    try {
                        const node = directory.get_child(name);
                        const status = await this._loadContents(node.get_child('status'));
                        if (new TextDecoder().decode(status).trim() !== 'connected')
                            continue;
                        const bytes = await this._loadContents(node.get_child('edid'));
                        if (bytes.length < 0x23)
                            continue;
                        const coordinate = (high, low, shift) =>
                            ((bytes[high] << 2) | ((bytes[low] >> shift) & 3)) / 1024;
                        return {
                            rx: coordinate(0x1B, 0x19, 6), ry: coordinate(0x1C, 0x19, 4),
                            gx: coordinate(0x1D, 0x19, 2), gy: coordinate(0x1E, 0x19, 0),
                            bx: coordinate(0x1F, 0x1A, 6), by: coordinate(0x20, 0x1A, 4),
                            wx: coordinate(0x21, 0x1A, 2), wy: coordinate(0x22, 0x1A, 0),
                        };
                    } catch (error) {
                        if (this._stopped)
                            throw error;
                    }
                }
            }
        } catch (error) {
            if (this._stopped)
                throw error;
        } finally {
            if (enumerator) {
                await new Promise(resolve => {
                    enumerator.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                        try {
                            source.close_finish(result);
                        } catch (_error) {
                            // A close failure cannot make unknown EDID trustworthy.
                        }
                        resolve();
                    });
                });
            }
        }
        return null;
    }

    async _hasUsableChromaticity(connector) {
        const c = await this._readEdidChromaticity(connector);
        if (!c)
            return true; // Unknown EDID: retain v1's allow-and-let-Mutter-decide policy.
        const area = Math.abs(c.rx * (c.gy - c.by) + c.gx * (c.by - c.ry) +
            c.bx * (c.ry - c.gy)) / 2;
        return area > CHROM_EPS;
    }
}
