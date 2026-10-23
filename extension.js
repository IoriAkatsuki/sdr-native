/* Force SDR Native — native Quick Settings UI.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {DisplayConfigController} from './displayConfig.js';

export default class ForceSdrNativeExtension extends Extension {
    enable() {
        this._pending = false;
        this._indicator = new SystemIndicator();
        this._toggle = new QuickToggle({
            title: 'SDR Native',
            iconName: 'video-display-symbolic',
            toggleMode: false,
        });
        this._indicator.quickSettingsItems.push(this._toggle);
        this._sync({
            ready: false,
            busy: false,
            checked: false,
            eligibleCount: 0,
            nativeCount: 0,
            hdrCount: 0,
            blockedCount: 0,
            error: null,
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        let controller;
        controller = new DisplayConfigController(state => {
            if (controller && this._controller === controller)
                this._sync(state);
        });
        this._controller = controller;
        this._toggle.connect('clicked', () => this._requestToggle(controller));
        controller.start().catch(error => {
            if (this._controller === controller)
                console.error(`[force-sdr-native] startup failed: ${error}`);
        });
    }

    disable() {
        const controller = this._controller;
        this._controller = null;
        controller?.stop();
        this._indicator?.quickSettingsItems.forEach(item => item.destroy());
        this._indicator?.destroy();
        this._indicator = null;
        this._toggle = null;
        this._state = null;
        this._pending = false;
    }

    async _requestToggle(controller) {
        if (this._controller !== controller || this._pending ||
            !this._state.ready || this._state.busy || this._state.eligibleCount === 0)
            return;

        this._pending = true;
        this._sync(this._state);
        try {
            await controller.setEnabled(!this._state.checked);
        } catch (error) {
            if (this._controller === controller)
                console.error(`[force-sdr-native] toggle failed: ${error}`);
        } finally {
            if (this._controller === controller) {
                this._pending = false;
                this._sync(this._state);
            }
        }
    }

    _sync(state) {
        this._state = state;
        const available = state.ready && !state.busy && !this._pending &&
            state.eligibleCount > 0;
        this._toggle.checked = state.checked;
        this._toggle.reactive = available;
        this._toggle.can_focus = available;

        if (state.error) {
            this._toggle.subtitle = `失败：${state.error}`;
            return;
        }
        if (!state.ready) {
            this._toggle.subtitle = '正在读取显示状态…';
            return;
        }
        if (state.eligibleCount === 0) {
            if (state.blockedCount > 0)
                this._toggle.subtitle = 'EDID 异常，已保护';
            else if (state.hdrCount > 0)
                this._toggle.subtitle = 'HDR 模式，保持不变';
            else
                this._toggle.subtitle = '无兼容 SDR 屏幕';
            return;
        }

        let status;
        if (state.busy || this._pending)
            status = '正在切换…';
        else if (state.nativeCount > 0 && state.nativeCount < state.eligibleCount)
            status = `部分 ${state.nativeCount}/${state.eligibleCount}`;
        else
            status = state.checked ? '已开启' : '已关闭';

        const details = [status];
        if (state.hdrCount > 0)
            details.push(`HDR ${state.hdrCount}`);
        if (state.blockedCount > 0)
            details.push(`EDID ${state.blockedCount}`);
        this._toggle.subtitle = details.join(' · ');
    }
}
