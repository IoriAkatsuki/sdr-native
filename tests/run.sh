#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Never let the fake DisplayConfig service share the user's session bus.
exec env GIO_USE_VFS=local timeout 90s dbus-run-session -- sh -eu -c '
    export FORCE_SDR_TEST_BUS=private
    gjs -m tests/backend.js
    node --experimental-vm-modules tests/ui.js
    node tests/entrypoint.js
'
