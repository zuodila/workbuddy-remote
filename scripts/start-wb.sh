#!/bin/sh
# =============================================================================
# WorkBuddy Remote —— 无头桌面会话启动脚本
# 由 systemd 以普通用户身份执行（不要用 root）
# 顺序：Xvfb → openbox → tint2 → fcitx5 → x11vnc → websockify → 应用（前台）
# =============================================================================
set -u

# ----------------------------- 可配置项 --------------------------------------
APP_BIN="${APP_BIN:-/opt/wbapp/opt/WorkBuddy/workbuddy}"   # 应用主程序
DISP="${DISP:-:98}"                     # X 显示号
SCREEN_W="${SCREEN_W:-2560}"            # 帧缓冲上限（客户端窗口不超过它）
SCREEN_H="${SCREEN_H:-1600}"
INIT_W="${INIT_W:-1920}"                # 初始可用分辨率
INIT_H="${INIT_H:-1080}"
VNC_PORT="${VNC_PORT:-5900}"
WEB_PORT="${WEB_PORT:-6080}"
NOVNC_WEB="${NOVNC_WEB:-/opt/wbapp/noVNC}"                 # noVNC 静态目录
WEBSOCKIFY="${WEBSOCKIFY:-/usr/bin/websockify}"
APP_ARGS="${APP_ARGS:---no-sandbox --disable-gpu --lang=zh-CN}"
# ---------------------------------------------------------------------------

DISP_NUM="${DISP#:}"
export DISPLAY="$DISP"
export LANG="${LANG:-zh_CN.UTF-8}"
export LC_ALL="${LC_ALL:-zh_CN.UTF-8}"

# 输入法环境：缺这三行，远程窗口里敲拼音出不了汉字
export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export XMODIFIERS=@im=fcitx
export SDL_IM_MODULE=fcitx

mkdir -p "$HOME" "${XDG_RUNTIME_DIR:-$HOME/.run}" "${XDG_CONFIG_HOME:-$HOME/.config}/fcitx5"
chmod 700 "${XDG_RUNTIME_DIR:-$HOME/.run}" 2>/dev/null || true

# fcitx5 首次生成默认拼音配置（之后保留用户改动）
PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/fcitx5/profile"
if [ ! -f "$PROFILE" ]; then
  cat > "$PROFILE" <<'EOF'
[Groups/0]
Name=默认
Default Layout=us
DefaultIM=pinyin

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=pinyin
Layout=

[GroupOrder]
0=默认
EOF
fi

# 清理上次残留（只清本显示号相关进程，避免误杀）
pkill -f "Xvfb $DISP" 2>/dev/null || true
pkill -f 'fcitx5' 2>/dev/null || true
pkill -f 'tint2' 2>/dev/null || true
pkill -f 'autocutsel' 2>/dev/null || true
sleep 1
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}"

# 1) 虚拟屏：RANDR 扩展是"跟随窗口改分辨率"的前提
Xvfb "$DISP" -screen 0 "${SCREEN_W}x${SCREEN_H}x24" -ac +extension RANDR -nolisten tcp \
  >"$HOME/xvfb.log" 2>&1 &
for _ in $(seq 1 40); do
  [ -S "/tmp/.X11-unix/X${DISP_NUM}" ] && break
  sleep 0.5
done

# 2) 窗口管理器（需要"所有窗口最大化"规则，见 openbox/rc.xml 示例）
openbox --sm-disable >"$HOME/openbox.log" 2>&1 &
sleep 1
xrandr --fb "${INIT_W}x${INIT_H}" >/dev/null 2>&1 || true
sleep 1

# 3) 会话总线（fcitx5 依赖）
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  eval "$(dbus-launch --sh-syntax 2>/dev/null)" || true
fi
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# 4) 中文输入法
fcitx5 -d --replace >"$HOME/fcitx5.log" 2>&1 &
sleep 3

# 5) 任务栏：openbox 不自带，最小化的窗口需要它才能找回
tint2 >"$HOME/tint2.log" 2>&1 &
sleep 2

# 6) VNC：只监听回环，认证交给网关
x11vnc -display "$DISP" -rfbport "$VNC_PORT" -listen 127.0.0.1 \
       -forever -shared -nopw -noxdamage -repeat -quiet \
       >"$HOME/x11vnc.log" 2>&1 &
sleep 1

# 7) RFB ↔ WebSocket，同时托管 noVNC 静态页
"$WEBSOCKIFY" --web="$NOVNC_WEB" "127.0.0.1:${WEB_PORT}" "127.0.0.1:${VNC_PORT}" \
  >"$HOME/websockify.log" 2>&1 &
sleep 1

# 8) 应用本体：前台运行，崩了由 systemd 拉起
echo "[wbdesktop] starting app: $APP_BIN"
exec "$APP_BIN" $APP_ARGS --user-data-dir="$HOME/profile"
