#!/bin/sh
# =============================================================================
# 一键安装 / 分步安装
#
#   sudo bash scripts/install.sh --deps-only
#   sudo bash scripts/install.sh --app ./WorkBuddy.deb --user "$USER"
#   sudo bash scripts/install.sh --clip
#   sudo bash scripts/install.sh --web /usr/share/novnc
#
# 只做这几件事：装依赖、解包、写 unit、起服务。
# 不修改系统已有配置，不删除任何用户数据。
# =============================================================================
set -eu

APP_DIR="${APP_DIR:-/opt/wbapp}"
RUN_USER="${RUN_USER:-}"
DEB_PATH=""
NOVNC_DIR="${NOVNC_DIR:-/usr/share/novnc}"
ACTION=""

log() { printf '\033[32m[wb]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[wb]\033[0m %s\n' "$*" >&2; exit 1; }
need_root() { [ "$(id -u)" = "0" ] || die "请用 sudo 运行"; }

usage() {
  sed -n '3,12p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --deps-only) ACTION="deps" ;;
    --app|--deb) ACTION="app"; shift; DEB_PATH="$1" ;;
    --clip) ACTION="clip" ;;
    --web) shift; NOVNC_DIR="$1"; ACTION="web" ;;
    --user) shift; RUN_USER="$1" ;;
    --dir) shift; APP_DIR="$1" ;;
    -h|--help) usage ;;
    *) die "未知参数: $1" ;;
  esac
  shift
done

[ -n "$ACTION" ] || usage

# ---------------------------------------------------------------------------
install_deps() {
  need_root
  log "安装系统依赖"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    xvfb x11vnc openbox tint2 fcitx5 fcitx5-chinese-addons \
    fonts-noto-cjk fonts-wqy-zenhei locales dbus-x11 \
    xclip xdotool python3 nginx openssl
  if ! locale -a 2>/dev/null | grep -qi 'zh_CN.utf8'; then
    sed -i 's/^# *zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true
    locale-gen zh_CN.UTF-8 || true
  fi
  log "依赖安装完成"
}

install_app() {
  need_root
  [ -n "$DEB_PATH" ] || die "缺少 --app <deb 路径>"
  [ -f "$DEB_PATH" ] || die "找不到安装包: $DEB_PATH"
  [ -n "$RUN_USER" ] || RUN_USER="${SUDO_USER:-}"
  [ -n "$RUN_USER" ] || die "缺少 --user <运行用户>"

  log "解包 $DEB_PATH → $APP_DIR"
  mkdir -p "$APP_DIR"
  dpkg-deb -x "$DEB_PATH" "$APP_DIR"

  BIN="$(find "$APP_DIR/opt" -maxdepth 3 -type f -perm -u+x 2>/dev/null \
        | grep -viE '\.(so|png|json|pak|dat|ico|svg)$' | head -1 || true)"
  [ -n "$BIN" ] || die "没能自动定位主程序，请手动查看 $APP_DIR/opt"

  log "主程序: $BIN"
  install -m 755 "$(dirname "$0")/start-wb.sh" "$APP_DIR/start-wb.sh"
  sed -i "s|^APP_BIN=.*|APP_BIN=\"\${APP_BIN:-$BIN}\"|" "$APP_DIR/start-wb.sh"

  install -d -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$APP_DIR/uploads"

  UNIT_SRC="$(dirname "$0")/systemd/wbdesktop.service"
  sed -e "s|__USER__|$RUN_USER|g" \
      -e "s|__HOME__|$(getent passwd "$RUN_USER" | cut -d: -f6)|g" \
      -e "s|__APPDIR__|$APP_DIR|g" \
      "$UNIT_SRC" > /etc/systemd/system/wbdesktop.service
  systemctl daemon-reload
  systemctl enable --now wbdesktop
  sleep 2
  systemctl --no-pager --lines=0 status wbdesktop || true
  log "桌面会话已启动。验证: DISPLAY=:98 xrandr"
}

install_clip() {
  need_root
  [ -n "$RUN_USER" ] || RUN_USER="${SUDO_USER:-}"
  [ -n "$RUN_USER" ] || die "缺少 --user <运行用户>"

  install -m 755 "$(dirname "$0")/clipbridge.py" "$APP_DIR/clipbridge.py"
  sed -e "s|__USER__|$RUN_USER|g" \
      -e "s|__APPDIR__|$APP_DIR|g" \
      "$(dirname "$0")/systemd/wbclip.service" > /etc/systemd/system/wbclip.service
  systemctl daemon-reload
  systemctl enable --now wbclip
  sleep 1
  if curl -fsS --noproxy '*' http://127.0.0.1:8137/health >/dev/null 2>&1; then
    log "剪贴板桥就绪: http://127.0.0.1:8137/health"
  else
    die "剪贴板桥没起来，查看: journalctl -u wbclip -n 50"
  fi
}

install_web() {
  need_root
  [ -d "$NOVNC_DIR" ] || die "noVNC 目录不存在: $NOVNC_DIR（Debian/Ubuntu 可 apt install novnc）"
  python3 "$(dirname "$0")/patch-novnc.py" "$NOVNC_DIR"
  log "提示：改了页面后浏览器要硬刷新（Ctrl+F5）"
}

case "$ACTION" in
  deps) install_deps ;;
  app)  install_app ;;
  clip) install_clip ;;
  web)  install_web ;;
esac
