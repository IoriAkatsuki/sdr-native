#!/usr/bin/env gjs
// Explicit one-shot temporary apply; shares the extension's safety policy.
// SPDX-License-Identifier: GPL-2.0-or-later
const {Gio, GLib} = imports.gi;
const System = imports.system;

if (ARGV.length > 1 || (ARGV.length === 1 && ARGV[0] !== '--off')) {
    printerr('Usage: gjs -m apply-once.js [--off]');
    System.exit(2);
}

async function main() {
    // Keep existing `gjs apply-once.js` callers while sharing the ES module backend.
    const moduleUri = Gio.File.new_for_path(System.programPath).get_parent()
        .get_child('displayConfig.js').get_uri();
    const {DisplayConfigController} = await import(moduleUri);
    let state;
    const controller = new DisplayConfigController(actual => state = actual);
    try {
        if (ARGV[0] === '--off')
            await controller.setEnabled(false);
        else
            await controller.start();
        print(`SDR native: ${state.nativeCount}/${state.eligibleCount}; ` +
            `HDR preserved: ${state.hdrCount}; EDID blocked: ${state.blockedCount}`);
    } finally {
        controller.stop();
    }
}

let exitCode = 0;
const loop = new GLib.MainLoop(null, false);
main().catch(error => {
    printerr(`force-sdr-native: ${error.message}`);
    exitCode = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(exitCode);
