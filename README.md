# SDR Native

**Keep native-gamut SDR one click away in GNOME Quick Settings.**

[![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)
![GNOME Shell: 50 / 51](https://img.shields.io/badge/GNOME_Shell-50%20%2F%2051-4a86cf)

[中文说明](README.zh-CN.md) · [Report an issue](https://github.com/IoriAkatsuki/sdr-native/issues)

SDR Native (extension name: **Force SDR Native**) adds an **SDR Native** toggle
and automatically restores Mutter's `sdr-native` color mode on eligible SDR
displays after login, hotplug, wake, or switching HDR off in GNOME Settings.
Displays already running HDR are left alone.

## Why use it?

**Mutter already supports native-gamut SDR (`sdr-native`), but GNOME's built-in
display settings UI does not expose a dedicated switch for it in the targeted
GNOME 50/51 setup.** This extension fills that UI gap with a convenient Quick
Settings toggle. It uses the compositor's existing functionality; it does not
patch Mutter or implement a new color-processing pipeline.

If your display supports native-gamut SDR but GNOME Settings returns it to
`default` after disabling HDR, this extension restores `sdr-native` without
turning HDR back on. You can also switch all eligible outputs together from
Quick Settings instead of manually reapplying display configuration.

Native gamut is **not** HDR, an ICC calibration, or a promise of more accurate
colors. Unmanaged sRGB content may look more saturated on wide-gamut displays.

## Features and safeguards

- Asynchronous Mutter DisplayConfig calls; no `gdctl` subprocesses.
- Actual-state feedback, including partial activation, busy and unavailable states.
- Leaves HDR and unsupported outputs untouched.
- Preserves mode IDs, VRR, scale, position, rotation, primary output, RGB range,
  underscanning, layout mode, and leased connectors when applying changes.
- Uses temporary configuration only; does not rewrite `~/.config/monitors.xml`.
- Rejects detected collapsed EDID primaries instead of forcing an invalid RGB
  transform. Unreadable EDID is left to Mutter's validation, not treated as safe.
- Turning the tile off returns eligible native SDR outputs to `default` and
  stops automatic restoration until the next extension enable/login.

## Requirements

- GNOME Shell / Mutter **50 or 51**, in a **Wayland** session.
- A display whose Mutter `supported-color-modes` includes `sdr-native`.
- For installation: Git and `gnome-extensions` (GNOME Shell tooling).

The metadata declares versions 50/51; that is not physical-display validation
on both releases. Unsupported displays do not gain native SDR support by
installing this extension. Current tile status messages are in Chinese.

## Install from source

```bash
git clone https://github.com/IoriAkatsuki/sdr-native.git
cd sdr-native
gnome-extensions pack . \
  --extra-source=displayConfig.js \
  --extra-source=apply-once.js \
  --extra-source=README.md \
  --extra-source=README.zh-CN.md \
  --extra-source=LICENSE \
  --extra-source=COPYING.md \
  --out-dir=.
gnome-extensions install --force ./force-sdr-native@oasis.github.io.shell-extension.zip
```

**Back up any existing installation before updating. Log out and back in** to
load the installed JavaScript, then enable it:

```bash
gnome-extensions enable force-sdr-native@oasis.github.io
```

Open Quick Settings and click **SDR Native**. Enabling the extension starts
automatic restoration immediately. Disable/enable alone may retain cached
JavaScript; use a new login session after updates.

This repository is a source distribution, not a GNOME Extensions store listing.
The UUID remains unchanged for compatibility with existing installations.

## Optional one-shot tool

From the checkout, with GJS installed, in your graphical session:

```bash
gjs -m apply-once.js        # Apply native SDR once
gjs -m apply-once.js --off  # Return eligible native SDR outputs to default
```

These commands **change display configuration**; they are not syntax checks.
If the extension is running with restoration enabled, turn its tile off before
using `--off`, otherwise it may restore native SDR again.

## Troubleshooting and removal

```bash
journalctl -b _COMM=gnome-shell --grep=force-sdr-native
gnome-extensions info force-sdr-native@oasis.github.io
```

- **No compatible SDR output:** check the session, Mutter support, and whether
  the display is currently in HDR. HDR outputs are intentionally skipped.
- **EDID protection:** the extension cannot repair panel firmware or EDID.
- **Display blinks:** a color-mode reconfiguration may blink on HDMI/DP; no
  flicker-free guarantee is made.
- **Update has no effect:** log out and back in to reload JavaScript.

To remove it, first turn the tile **off** if you want to restore `default`, then:

```bash
gnome-extensions disable force-sdr-native@oasis.github.io
gnome-extensions uninstall force-sdr-native@oasis.github.io
```

Disabling alone does **not** undo a color mode already applied. To roll back an
update, reinstall your backed-up extension and log out and back in.

## Development and tests

Runtime code is plain JavaScript using GNOME's GJS; no npm packages or build step.
Test prerequisites: GJS, Node.js, `dbus-run-session`, and `timeout`.

```bash
sh tests/run.sh
```

The backend tests use a synthetic DisplayConfig service on a private D-Bus
session; UI tests use doubles. CLI tests check argument handling and a missing
service. None apply changes to your live compositor. These tests do not replace
rendered Shell checks or real monitor/colorimeter validation.

- `extension.js`: Quick Settings UI and lifecycle.
- `displayConfig.js`: asynchronous display controller and EDID safeguards.
- `apply-once.js`: standalone entry point sharing the same controller.
- `tests/`: isolated backend, UI, and CLI regression tests.

When reporting issues, include Shell/Mutter versions, session type, display/GPU
models, reproduction steps and relevant logs. Remove personal information and
display serial numbers before posting. Small, focused pull requests with a
regression test are welcome.

## Scope

This repository deliberately excludes machine-specific EDID binaries, root-level
boot/firmware modification scripts, and private diagnostic records. Installing
the extension does not install EDID overrides or modify kernel parameters.

## License and references

[GPL-2.0-or-later](LICENSE). See [COPYING.md](COPYING.md) for the licensing notice.

README organization was informed by
[Caffeine](https://github.com/eonpatapon/gnome-shell-extension-caffeine):
short purpose statement, compatibility, source installation, usage, and issue
reporting. This does not imply affiliation or endorsement.
