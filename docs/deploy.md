# 部署教程

本文以 **Debian 12（含 fnOS）** 为例，Ubuntu 22.04+ 同样适用。全部命令假设你有一个有 sudo 权限的普通用户，下面用 `$USER` 代指。

> 目标形态：**不接显示器、不装桌面环境、不跑虚拟机**，NAS 开机后浏览器即可访问。

---

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| 系统 | Debian 11+ / Ubuntu 20.04+ / fnOS（Debian 12 基座） |
| 架构 | x86_64 或 arm64 |
| 内存 | ≥ 2 GB 空闲（客户端本身约占 300–800 MB） |
| 磁盘 | ≥ 2 GB（应用 + 用户数据） |
| 软件 | 你自己合法获取的 `.deb` 安装包 |
| 网络 | 能装包；如需公网访问，需要一个域名（可选） |

先确认包结构：

```bash
dpkg-deb -I ./WorkBuddy.deb | head -20      # 看版本与依赖
dpkg-deb -c ./WorkBuddy.deb | head -20      # 看安装路径
```

---

## 1. 安装系统依赖

```bash
sudo bash scripts/install.sh --deps-only
```

等价于：

```bash
sudo apt-get update
sudo apt-get install -y \
  xvfb x11vnc openbox tint2 fcitx5 fcitx5-chinese-addons \
  fonts-noto-cjk fonts-wqy-zenhei locales dbus-x11 xclip xdotool \
  python3 imagemagick nginx
sudo locale-gen zh_CN.UTF-8
```

> `imagemagick` 只在排错（截图）时用；`fonts-noto-cjk` 是中文正常显示的前提，缺了会全是方块。

---

## 2. 解包应用

```bash
sudo bash scripts/install.sh --deb ./WorkBuddy.deb --user "$USER"
```

脚本做四件事：

1. `dpkg-deb -x` 解包到 `/opt/wbapp`（**不用 `dpkg -i`**，避免它去装一堆桌面依赖，也方便以后整体替换）；
2. 生成 `/opt/wbapp/start-wb.sh`（把 `$USER`、分辨率、端口写进去）；
3. 安装 `wbdesktop.service` 并 `enable --now`；
4. 打印会话状态与 VNC 端口。

手动等价步骤：

```bash
sudo mkdir -p /opt/wbapp
sudo dpkg-deb -x ./WorkBuddy.deb /opt/wbapp
# 应用主程序通常在 /opt/wbapp/opt/<Product>/<binary>
ls /opt/wbapp/opt

sudo cp scripts/start-wb.sh /opt/wbapp/start-wb.sh
sudo chmod 755 /opt/wbapp/start-wb.sh
# 编辑 start-wb.sh 顶部的 APP_BIN / DISPLAY / 分辨率
```

### start-wb.sh 里的关键变量

```sh
APP_BIN=/opt/wbapp/opt/WorkBuddy/workbuddy   # 指向真实二进制
DISP=:98
SCREEN=2560x1600x24                          # 画布上限，必须 ≥ 常用窗口尺寸
INITIAL=1920x1080                            # 初始可用尺寸
VNC_PORT=5900
WEB_PORT=6080
```

---

## 3. 系统服务

```bash
sudo cp scripts/systemd/wbdesktop.service /etc/systemd/system/
sudo sed -i "s|__USER__|$USER|g; s|__HOME__|/home/$USER|g" /etc/systemd/system/wbdesktop.service
sudo systemctl daemon-reload
sudo systemctl enable --now wbdesktop
systemctl status wbdesktop --no-pager
```

验证：

```bash
DISPLAY=:98 xrandr | grep "Screen 0"        # 应显示当前分辨率
DISPLAY=:98 xdotool search --class . | wc -l # 应有若干窗口
ss -lntp | grep -E '5900|6080'
```

如果应用没起来，看日志：

```bash
journalctl -u wbdesktop -n 80 --no-pager
```

---

## 4. 剪贴板桥

```bash
sudo bash scripts/install.sh --clip --user "$USER"
```

或手动：

```bash
sudo cp scripts/clipbridge.py /opt/wbapp/clipbridge.py
sudo chmod 755 /opt/wbapp/clipbridge.py
sudo cp scripts/systemd/wbclip.service /etc/systemd/system/
sudo sed -i "s|__USER__|$USER|g" /etc/systemd/system/wbclip.service
sudo systemctl daemon-reload
sudo systemctl enable --now wbclip
curl -s http://127.0.0.1:8137/health   # ok
```

自测（把中文写进 X 剪贴板，再读回来）：

```bash
curl -s -X POST --data-binary "中文测试" http://127.0.0.1:8137/clip/set
DISPLAY=:98 xclip -selection clipboard -o
```

---

## 4.5 给 noVNC 页面挂上桥脚本

剪贴板与"无黑边"都靠页面里的 `wbclip.js`，它需要注入到 `vnc.html`：

```bash
# Debian/Ubuntu 的 noVNC 通常在 /usr/share/novnc
sudo apt-get install -y novnc
sudo bash scripts/install.sh --web /usr/share/novnc
```

等价于：

```bash
sudo python3 scripts/patch-novnc.py /usr/share/novnc
```

脚本是幂等的：复制 `wbclip.js` 到 noVNC 目录，并在 `</body>` 前插入一行 `<script src="wbclip.js"></script>`，同时留一份 `.bak-wbclip` 备份。

> 如果你的 noVNC 是自行下载的静态目录，把路径换成它即可；`start-wb.sh` 里的 `NOVNC_WEB` 要指向同一个目录。

---

## 5. 网关

```bash
sudo cp scripts/nginx/workbuddy.conf /etc/nginx/conf.d/
sudo sed -i 's|__SERVER_NAME__|wb.example.com|' /etc/nginx/conf.d/workbuddy.conf
sudo htpasswd -c /etc/nginx/wb.htpasswd "$USER"     # 首次，按提示设口令
sudo nginx -t && sudo systemctl reload nginx
```

要点（配置里已含）：

- `/` 指向 noVNC 静态目录与 websockify（同端口，WebSocket 必须 `proxy_http_version 1.1` + `Upgrade`）
- `/clip/` 反代到 `127.0.0.1:8137`，**与页面同源**，因此复用同一个 Basic Auth
- `proxy_buffering off`，否则 VNC 画面会延迟、卡顿
- 超时放到 3600s，避免空闲断连

### 证书

任选其一：

```bash
# 已有证书
sudo sed -i 's|__CERT__|/etc/ssl/fullchain.pem|; s|__KEY__|/etc/ssl/privkey.pem|' /etc/nginx/conf.d/workbuddy.conf

# 用 acme.sh 申请（示例）
acme.sh --issue -d wb.example.com --standalone
```

> 家庭宽带常封 443/80。可参考"非标端口 + DNS 验证 + 端口转发"的做法，把 HTTPS 放到一个自定义高位端口。

---

## 6. 验收清单

| 检查项 | 命令 / 操作 | 期望 |
| --- | --- | --- |
| 会话在跑 | `systemctl is-active wbdesktop` | `active` |
| 有画面 | 浏览器打开 `/vnc.html` | 看到应用界面 |
| 中文显示 | 界面文字 | 不是方块 |
| 中文输入 | 点输入框，`Ctrl+Space` | 出现候选框 |
| 中文粘贴 | 本机复制中文 → 页面 `Ctrl+V` | 正常中文 |
| 中文复制 | 远端复制 → 本机粘贴 | 正常中文 |
| 图片粘贴 | 本机截图 → 页面 `Ctrl+V` | 出现图片附件 |
| 无黑边 | 拖动窗口大小 | 画面跟随，无黑边 |
| 重启自愈 | `sudo reboot` 后等待 | 页面可访问 |

---

## 7. 升级

```bash
sudo systemctl stop wbdesktop
sudo rm -rf /opt/wbapp/opt /opt/wbapp/usr          # 只删程序，保留 start-wb.sh
sudo dpkg-deb -x ./WorkBuddy-new.deb /opt/wbapp
sudo systemctl start wbdesktop
```

用户数据（会话、登录态、资料库）在 `~/.config`、`~/.local/share` 之类的位置，随用户目录保留。**升级前建议先备份一次**：

```bash
tar czf ~/wb-backup-$(date +%F).tgz ~/.config/<Product> ~/.local/share/<Product>
```

---

## 8. 排错速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `systemctl status` 反复重启 | 应用二进制路径不对 / 缺库 | `journalctl -u wbdesktop -n 100`，手动跑一次二进制看报错 |
| 页面能开但一直"连接中" | WebSocket 没升级 / 端口不通 | 检查 nginx `Upgrade` 头与 `proxy_buffering off` |
| 403 `Host not allowed` | 应用侧 Host 校验（若用自研 Web 服务） | 反代时透传正确 Host，或设置应用的白名单 |
| 中文是方块 | 缺中文字体 | `fc-list :lang=zh` 应为空才需装字体 |
| 输入法无候选 | 无 dbus / `GTK_IM_MODULE` 未设 | 用 `dbus-launch` 启动 fcitx5，导出 `GTK_IM_MODULE=fcitx` |
| 粘贴是 `?` 或乱码 | 走了 RFB 剪贴板 | 确认 `wbclip` 在跑、页面已硬刷新 |
| 截图为黑 | Xvfb 未就绪 | 检查 `DISPLAY=:98 xrandr` |
| 画面卡顿 | 未关 `proxy_buffering` / 带宽不足 | 见上；或降低分辨率 |
