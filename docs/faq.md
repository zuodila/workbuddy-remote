# 常见问题

<a name="403"></a>
## 403 / `Host not allowed`

反代后应用收到的是内网 Host，触发了它的域名白名单校验。三种处理：

1. nginx 里透传原始 Host（默认 `proxy_set_header Host $host;` 即可，注意别写成上游地址）；
2. 应用侧把域名加入白名单（多数自研 Web 服务支持环境变量或配置文件）；
3. 确实是自建 Web 服务且有 `CODEBUDDY_DISABLE_HOST_VALIDATION` 这类开关时，按官方文档设置。

> 另外注意：某些接口会校验自定义头（如 `x-codebuddy-request: 1`），`curl` 自测时 403 不一定是网关的问题。

---

<a name="ime"></a>
## 中文输入法没有候选框

按顺序排查：

```bash
# 1. 有没有启动
pgrep -a fcitx5

# 2. 有没有 dbus（fcitx5 依赖会话总线）
echo $DBUS_SESSION_BUS_ADDRESS

# 3. 应用进程里有没有输入法环境变量
tr '\0' '\n' < /proc/$(pgrep -f <应用名> | head -1)/environ | grep -E 'GTK_IM_MODULE|QT_IM_MODULE|XMODIFIERS'
```

启动脚本里必须用 `dbus-launch` 拉起 fcitx5，并导出：

```sh
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export XMODIFIERS=@im=fcitx
```

`~/.config/fcitx5/profile` 里设置默认输入法：

```ini
[Groups/0]
Name=Default
Default Layout=us
DefaultIM=pinyin
```

改完重启会话（`systemctl restart wbdesktop`）生效。

--- 

<a name="letterbox"></a>
## 画面四周有黑边 / 不满屏

原因是"远端分辨率"和"客户端窗口尺寸"不一致。本项目已经做了自适应，若仍有黑边：

1. 确认 `clipbridge` 在跑：`curl http://127.0.0.1:8137/health`；
2. 手动验证接口：

   ```bash
   curl "http://127.0.0.1:8137/clip/resize?w=1600&h=1000"
   DISPLAY=:98 xrandr | grep "Screen 0"
   ```

3. 检查页面是否被缓存（硬刷新）；
4. 检查 Xvfb 画布上限是否够大：`SCREEN=2560x1600x24`，如果客户端窗口超过这个尺寸，`xrandr` 会拒绝放大；
5. 检查 openbox 是否有"全窗口最大化"规则，否则窗口缩回默认尺寸会露出桌面。

---

## 页面打开了，但一直"连接中"

- WebSocket 没升级：nginx 必须有

  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

- `proxy_buffering` 没关：会让画面卡住或延迟；
- websockify 没起来：`ss -lntp | grep 6080`；
- Basic Auth 未带在 WSS 上：浏览器会自动带，但**客户端必须在 `wss://` 上也注入认证头**。

---

## 复制中文变成 `?` 或乱码

这是走了 RFB 的剪贴板通道的典型症状。确认：

```bash
systemctl is-active wbclip
curl -s http://127.0.0.1:8137/clip/get
```

页面里应该能看到脚本请求 `/clip/get`（F12 → Network）。如果看不到，说明页面用的是旧版本（硬刷新）或 `/clip/` 反代没配。

---

## 粘贴图片变成文件名 / 坏图标（`PNG`）

同上是剪贴板桥没生效：图片被当成文本发了。检查 `/clip/get` 返回的 `kind` 是否为 `image`。

也检查是否同时跑了 `autocutsel` —— 它会抢剪贴板所有权，导致图片偶发失效：

```bash
pkill -x autocutsel
```

---

## 点 ✕ 关不掉

Electron 默认会因为页面注册了 `beforeunload` 而拒绝关闭。在 `main.js` 里加：

```js
win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
```

如果还想"关窗即退出"，去掉托盘逻辑里的 `e.preventDefault()` 即可。

---

## 关窗后进程还在 / 找不到窗口

这是设计行为：点 ✕ 收进系统托盘。托盘图标左键单击可唤回，右键菜单可以退出；`Ctrl+Shift+Q` 直接退出。

如果托盘图标被系统折叠了，把 `WorkBuddy 桌面` 拖到任务栏常显区域。

---

## 登录时页面一直转圈

远端应用在等浏览器打开授权页，而宿主没有默认浏览器。装一个浏览器并配置好 `xdg-open`（或应用内改成设备码登录）。登录过程中**不要重启服务**，否则会话作废。

---

## `docker` 里跑 Electron 直接崩（SIGILL / SIGTRAP）

容器环境的指令集与 Chromium 的 `IMMEDIATE_CRASH` 会打架，常见于 `ud2` 指令。**本项目因此不建议把桌面塞进容器**：直接在宿主用 Xvfb 更稳定，也更省资源。若必须容器化，可试 `--security-opt seccomp=unconfined`、关闭 GPU、`--ipc=host`，但不保证。

---

## 远程桌面里打字没反应

- 页面没焦点：先点一下画面；
- 输入法在远端接管了键盘：`Ctrl+Space` 切中英文；
- 客户端与页面被系统快捷键占用（如 `F11`），用页面内的按钮替代。

---

## 想换端口 / 域名

- 端口：改 `start-wb.sh` 里的 `VNC_PORT`/`WEB_PORT`，同步改 nginx `proxy_pass`；
- 域名：改 nginx `server_name` 与证书路径；客户端在"服务器设置"里改地址即可，不用重装。

---

## 备份要备什么

```bash
# 应用本身不用备（可重新解包），备这些：
~/.config/<Product>          # 配置与登录态
~/.local/share/<Product>     # 会话、缓存
/opt/wbapp/uploads           # 剪贴板桥落盘的图片（可选）
```

---

## 升级后登录态丢了

不同版本的用户数据目录可能变化。升级前：

```bash
tar czf ~/wb-backup-$(date +%F).tgz ~/.config/<Product> ~/.local/share/<Product>
```

升级后若失效，恢复上面两个目录再重启服务。
