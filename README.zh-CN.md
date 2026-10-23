# SDR Native

**在 GNOME 快速设置中，一键控制原生色域 SDR。**

[English / 完整说明](README.md) · [反馈问题](https://github.com/IoriAkatsuki/sdr-native/issues)

插件名称为 **Force SDR Native**。它为快速设置添加 **SDR Native** 开关，
并在登录、显示器热插拔、唤醒以及关闭 HDR 后，自动为兼容的 SDR 输出恢复
Mutter 的 `sdr-native` 模式。已经处于 HDR 的显示器保持不变。

## 适合什么场景？

**GNOME 的 Mutter 已经支持原生色域 SDR（`sdr-native`），但在本插件面向的
GNOME 50/51 环境中，系统自带的显示设置 UI 没有提供对应的独立开关。**
本插件补上这一 UI 入口，让用户可以从快速设置快捷开启或关闭已有功能，
无需手动调用显示配置接口。它不修改 Mutter，也不自行实现新的色彩处理管线。

显示器支持原生色域 SDR，但在 GNOME 设置中关闭 HDR 后回到了 `default`？
本插件可自动恢复原生 SDR，也能从快速设置同时切换所有兼容输出。

原生色域不等于 HDR，也不是 ICC 校色。宽色域屏幕上的未受色彩管理的 sRGB
内容可能显得更鲜艳，不能据此认定颜色更准确。

## 特点

- 异步直接调用 Mutter DisplayConfig，不启动 `gdctl` 子进程。
- 显示真实状态，包括部分开启、切换中、无兼容屏幕及 EDID 保护。
- 不切换正在使用 HDR 的输出，不强行启用不受支持的模式。
- 应用时保留当前模式、VRR、缩放、位置、旋转、主屏、RGB 范围等显示配置。
- 仅临时应用，不改写 `~/.config/monitors.xml`。
- 检测到 EDID RGB 原色退化时保持或回退 `default`；读取不到 EDID 时由 Mutter 校验。

## 兼容性与安装

要求 **GNOME Shell / Mutter 50 或 51、Wayland 会话**，并且 Mutter 为显示器
报告的 `supported-color-modes` 包含 `sdr-native`。版本声明不等于两个版本均已
完成实屏验证；安装插件不会让不兼容的屏幕获得原生 SDR 能力。

安装需 Git 和 `gnome-extensions`。按[英文首页的源码安装命令](README.md#install-from-source)
克隆、打包并安装。更新前备份现有插件，安装后注销并重新登录，再执行：

```bash
gnome-extensions enable force-sdr-native@oasis.github.io
```

启用即开始自动恢复；打开快速设置点击 **SDR Native** 即可切换。
关闭开关会将兼容输出恢复为 `default`，并停止本次插件实例的自动恢复；
下次重新启用或登录时，自动恢复重新开启。当前状态文字为中文。

## 独立工具、测试与卸载

在源码目录、图形会话中运行以下命令会**实际修改显示配置**，不是语法检查：

```bash
gjs -m apply-once.js
gjs -m apply-once.js --off
```

插件运行时先关闭其开关，否则自动恢复可能覆盖独立工具的 `--off` 操作。

测试依赖 GJS、Node.js、`dbus-run-session` 和 `timeout`：

```bash
sh tests/run.sh
```

测试采用隔离 D-Bus 和 UI 替身，不改变当前桌面，也不代替 Shell 渲染或真实屏幕验收。

卸载前先关闭开关以恢复 `default`，然后执行：

```bash
gnome-extensions disable force-sdr-native@oasis.github.io
gnome-extensions uninstall force-sdr-native@oasis.github.io
```

仅禁用插件不会撤销已经应用的色彩模式。更新回滚需重装备份并重新登录。
日志可用 `journalctl -b _COMM=gnome-shell --grep=force-sdr-native` 查看。

## 边界与贡献

不修复 EDID，不保证 HDMI/DP 切换无闪屏，也不提供校色保证。仓库仅发布通用插件
和测试，不包含本机 EDID 固件、修改启动项的 root 脚本或私人诊断记录。

反馈时请提供 Shell/Mutter 版本、会话类型、GPU/显示器型号、复现步骤和相关日志，
公开前移除个人信息及显示器序列号。欢迎带回归测试的小范围 PR。

许可证：**GPL-2.0-or-later**，见 [LICENSE](LICENSE) 和 [COPYING.md](COPYING.md)。
README 结构参考与完整安全说明见[英文首页](README.md#license-and-references)。
