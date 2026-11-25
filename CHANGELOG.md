# 更新日志

## 1.0.0 — 2026-11-25

首个公开版本。

### 桌面会话
- Xvfb 无头虚拟屏（RANDR 扩展，运行期可改分辨率）
- openbox 全窗口最大化规则 + tint2 任务栏（最小化可恢复）
- fcitx5 中文输入（dbus 会话 + 输入法环境变量）
- x11vnc 仅监听回环，websockify 提供 noVNC 静态页与 WebSocket
- 全部由 systemd 托管：`wbdesktop.service` / `wbclip.service`

### 剪贴板桥
- UTF-8 文本双向同步（绕开 RFB 的 Latin-1 限制）
- 图片双向粘贴（本机截图 → 远端，远端图片 → 本机）
- 内容签名去重，避免双向回环覆盖
- 页面尺寸上报 → `xrandr` 跟随窗口，消灭黑边
- 已知问题修正：`autocutsel` 抢剪贴板所有权、`xclip -i` fork 导致写操作超时

### 客户端
- Electron 外壳：无地址栏、Basic Auth 预注入（含 `wss://`）
- 系统托盘：点 ✕ 收进托盘、托盘唤回、托盘退出
- 修复 noVNC 的 `beforeunload` 导致窗口关不掉
- 修复二次启动无法唤回已隐藏窗口
- Windows NSIS 中文安装向导；macOS 一键打包脚本（Apple Silicon）

### 文档
- README（初衷 / 意义 / 效果 / 流程 / 对比 / 免责）
- 架构、部署、剪贴板原理、客户端打包、与虚拟机对比、安全、FAQ
- 架构图与通道图（SVG）
