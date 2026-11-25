# 架构说明

## 分层

```
┌─────────────────────────────────────────────────────────────────────┐
│ 接入层    浏览器（noVNC 页面）          Electron 客户端（Win/macOS）    │
├─────────────────────────────────────────────────────────────────────┤
│ 网关层    Nginx：TLS 终止、Basic Auth、WebSocket 升级、/clip/ 反代      │
├─────────────────────────────────────────────────────────────────────┤
│ 语义层    clipbridge：UTF-8 剪贴板 / 图片 / 分辨率自适应（HTTP）        │
│           websockify + noVNC：RFB → WebSocket → 浏览器               │
├─────────────────────────────────────────────────────────────────────┤
│ 桌面层    Xvfb :98（虚拟屏）+ openbox（窗口管理）+ tint2（任务栏）      │
│           fcitx5（中文输入）+ 应用本体                                 │
├─────────────────────────────────────────────────────────────────────┤
│ 宿主层    Debian 12 / Ubuntu / fnOS，systemd 托管，开机自启            │
└─────────────────────────────────────────────────────────────────────┘
```

### 为什么是 Xvfb 而不是 Xorg

- 宿主是 NAS，没有接显示器，也没有可用 GPU；Xvfb 是纯软件帧缓冲，零硬件依赖。
- Xvfb 支持运行期用 `xrandr --fb WxH` 改分辨率（在不超出初始画布的前提下），这是"无黑边"的基础。
- 代价是没有硬件加速，界面渲染偏 CPU。对一个以文本/网页为主的客户端完全够用。

### 为什么还要窗口管理器

只跑 Xvfb + 应用也能出画面，但：

- 应用窗口不会自动最大化，截图出来四周是 X 根窗口的黑色；
- 没有任务栏，最小化之后无法恢复；
- 没有 `_NET_ACTIVE_WINDOW` 之类的 EWMH 状态，某些应用的行为会异常。

所以用了 **openbox**（极小、稳定）+ **tint2**（任务栏，负责最小化后恢复）+ 一条"所有窗口默认最大化"的规则。

### 为什么剪贴板要独立成一个服务

RFB 协议的剪贴板通道只支持 Latin-1，且 x11vnc 会把非 ASCII 直接替换成 `?`。也就是说**改前端编码解决不了写入方向**。唯一的办法是绕开 RFB，另外开一条通道直接读写 X 剪贴板 —— 这就是 `clipbridge`，它必须和 X 会话在同一个 `DISPLAY` 上，因此作为独立 systemd 用户服务运行，而不是塞进 Node 脚本里。

它同时兼任"分辨率控制器"：客户端把窗口尺寸 POST 过来，它调 `xrandr --fb`。

## 端口与进程

| 端口 | 进程 | 绑定 | 说明 |
| --- | --- | --- | --- |
| 5900+ | x11vnc | 127.0.0.1 | RFB 服务端 |
| 6080 | websockify | 127.0.0.1 | RFB ↔ WebSocket，同时托管 noVNC 静态页 |
| 8137 | clipbridge | 127.0.0.1 | 剪贴板与分辨率 HTTP 接口 |
| 443/28443 | nginx | 0.0.0.0 | 对外唯一入口（TLS + Basic Auth） |

原则：**除网关外全部只绑 127.0.0.1**。VNC 本身没有强认证，绝不能直接暴露。

## 启动顺序

```
systemd
 ├─ wbdesktop.service (User=<你的用户>)
 │   1. Xvfb :98 -screen 0 2560x1600x24
 │   2. xrandr --fb 1920x1080        # 初始可用尺寸
 │   3. openbox                       # 读 ~/.config/openbox/rc.xml（全窗口最大化）
 │   4. tint2                         # 任务栏
 │   5. fcitx5 -d                     # 中文输入（需 dbus-launch）
 │   6. x11vnc -localhost -forever -shared
 │   7. websockify 6080 → 5900 + noVNC 静态目录
 │   8. exec WorkBuddy（应用本体，前台运行，崩了由 systemd 拉起）
 └─ wbclip.service (User=<你的用户>)
     python3 clipbridge.py            # 依赖 DISPLAY=:98
```

`wbclip` 必须在 Xvfb 起来之后才能工作，因此 `After=wbdesktop.service`（或 `Restart=always` 自动重试）。

## 一次交互的数据流

1. 浏览器打开 `https://host/vnc.html?autoconnect=1&resize=scale`
2. 页面通过 WSS 连到 nginx，被转发到 websockify，再转成 RFB 给 x11vnc
3. x11vnc 把 X 画面编码后回传，页面用 canvas 绘制
4. 键盘鼠标事件反向回传，注入 X
5. 页面每 1s 轮询 `GET /clip/get`，发现远端剪贴板变化就写入本机剪贴板
6. 页面在 `focus` / `resize` 时把本机剪贴板、窗口尺寸 `POST` 到 `/clip/set`、`/clip/resize`

## 关键设计取舍

| 取舍 | 选择 | 原因 |
| --- | --- | --- |
| 同源 vs 分端口 | 同源 `/clip/` 反代 | 复用已登录的 Basic Auth，避免 CORS 与第二个口令 |
| 剪贴板协议 | 自建 HTTP 轮询（1s） | 简单、可调试、跨浏览器；不依赖 `navigator.clipboard` 的写入时机 |
| 图片方向 | 二进制 + `ClipboardItem`，失败降级 `execCommand` | 页面无焦点时 `clipboard.write` 会失败，需要兜底 |
| 分辨率 | xrandr 跟随窗口 | 比"缩放画面"清晰，且彻底消灭黑边 |
| 客户端 | Electron 壳 + `<webview>`-free 直连 | 可以直接复用页面逻辑与认证，不需要重写 UI |

## 与"直接 VNC 客户端"的区别

| | 裸 VNC（RealVNC/TigerVNC） | 本项目 |
| --- | --- | --- |
| 端口暴露 | VNC 端口必须可达 | 只暴露 443 |
| 认证 | VNC 口令（弱） | TLS + HTTP Basic（可换 OIDC） |
| 剪贴板 | Latin-1 | UTF-8 + 图片 |
| 分辨率 | 手动设置 | 跟随窗口 |
| 客户端分发 | 每台装 VNC 客户端 | 浏览器 / 可选客户端 |
