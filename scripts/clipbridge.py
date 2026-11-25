#!/usr/bin/env python3
"""VNC 剪贴板桥：在浏览器与 X 会话之间提供全 UTF-8 的剪贴板 / 图片 / 分辨率通道。

RFB 协议的 ClientCutText / ServerCutText 只支持 ISO-8859-1，中文与图片必然损坏，
所以这里绕开 VNC，用同源 HTTP 直接读写 X 剪贴板。

接口
  GET  /clip/get        -> {"seq":n,"kind":"text|image","text":"...","mime":"image/png","url":"/clip/image/get?seq=n"}
  GET  /clip/image/get  -> 远端剪贴板图片的原始字节
  POST /clip/set        -> body 为 UTF-8 文本，写入 CLIPBOARD 与 PRIMARY
  POST /clip/image      -> body 为图片二进制（X-Mime 指定类型），写入剪贴板并落盘
  GET  /clip/resize     -> ?w=&h= 调整 Xvfb 帧缓冲（跟随客户端窗口）
  GET  /clip/health     -> ok

环境变量
  CLIP_DISPLAY       X 显示号，默认 :98
  CLIP_PORT          监听端口，默认 8137
  CLIP_UPLOAD_DIR    图片落盘目录，默认 ~/.local/share/wbclip/uploads
"""
import hashlib
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DISPLAY = os.environ.get("CLIP_DISPLAY", ":98")
PORT = int(os.environ.get("CLIP_PORT", "8137"))
UP_DIR = os.environ.get(
    "CLIP_UPLOAD_DIR",
    os.path.expanduser("~/.local/share/wbclip/uploads"),
)
ENV = dict(os.environ)
ENV["DISPLAY"] = DISPLAY

XCLIP = "/usr/bin/xclip"
XDOOL = "/usr/bin/xdotool"
IMG_TARGETS = ("image/png", "image/jpeg", "image/jpg", "image/bmp", "image/gif", "image/tiff")

state = {
    "seq": 0,
    "sig": None,
    "kind": "text",
    "text": "",
    "mime": "",
    "img": None,
    "pushed": None,
    "size": None,
}


def run(args, data=None, timeout=8, capture=True):
    """执行外部命令。写剪贴板时必须 capture=False（xclip 会 fork 常驻子进程，
    若父进程等待管道 EOF，会一直卡到超时并误判失败）。"""
    try:
        if capture:
            return subprocess.run(args, input=data, capture_output=True, timeout=timeout, env=ENV)
        return subprocess.run(
            args, input=data, timeout=timeout, env=ENV,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as exc:  # noqa: BLE001
        print("exec failed %s: %s" % (args[:2], exc), flush=True)
        return None


def xclip_targets(sel="clipboard"):
    p = run([XCLIP, "-selection", sel, "-o", "-t", "TARGETS"], timeout=3)
    if p is None or p.returncode != 0:
        return []
    return p.stdout.decode("utf-8", "replace").split()


def xclip_raw(mime, sel="clipboard"):
    p = run([XCLIP, "-selection", sel, "-o", "-t", mime], timeout=8)
    if p is None or p.returncode != 0 or not p.stdout:
        return None
    return p.stdout


def xclip_get_text():
    for target in ("UTF8_STRING", "text/plain;charset=utf-8", "text/plain", "STRING"):
        p = run([XCLIP, "-selection", "clipboard", "-o", "-t", target], timeout=3)
        if p is not None and p.returncode == 0:
            return p.stdout.decode("utf-8", "replace")
    return None


def xclip_set(data, mime="UTF8_STRING", sel="clipboard"):
    p = run([XCLIP, "-selection", sel, "-t", mime, "-i"], data=data, timeout=8, capture=False)
    return bool(p is not None and p.returncode == 0)


def snapshot():
    """读一次远端剪贴板：图片优先，其次文本。返回 (kind, payload, sig)。"""
    targets = xclip_targets()
    mime = next((m for m in IMG_TARGETS if m in targets), None)
    if mime:
        data = xclip_raw(mime)
        if data:
            return "image", (data, mime), "img:%s:%s" % (mime, hashlib.sha1(data).hexdigest())
    text = xclip_get_text()
    if text is not None:
        return "text", text, "txt:" + hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点，写入 journal 即可
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------------------------- GET ----------------------------
    def do_GET(self):
        path = self.path.split("?")[0].replace("/clip/", "/", 1)
        if path == "/health":
            self._send(200, b"ok", "text/plain")
        elif path == "/resize":
            self._handle_resize()
        elif path == "/image/get":
            if state["kind"] == "image" and state["img"]:
                self._send(200, state["img"], state["mime"] or "image/png")
            else:
                self._send(404, b"", "text/plain")
        elif path == "/get":
            self._handle_get()
        else:
            self._send(404, b"{}")

    def _handle_get(self):
        res = snapshot()
        if res:
            kind, payload, sig = res
            if sig != state["sig"] and sig != state["pushed"]:
                state["sig"] = sig
                state["kind"] = kind
                state["seq"] += 1
                if kind == "image":
                    state["img"], state["mime"] = payload
                    state["text"] = ""
                else:
                    state["text"] = payload
                    state["img"], state["mime"] = None, ""
            elif sig == state["sig"] and kind == "image":
                state["img"], state["mime"] = payload
        self._send(200, json.dumps({
            "seq": state["seq"],
            "kind": state["kind"],
            "text": state["text"] if state["kind"] == "text" else "",
            "mime": state["mime"],
            "url": "/clip/image/get?seq=%d" % state["seq"],
        }, ensure_ascii=False))

    def _handle_resize(self):
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)

        def num(key, default):
            try:
                return int(float(q.get(key, [default])[0]))
            except Exception:  # noqa: BLE001
                return default

        w = max(800, min(2560, num("w", 1920)))
        h = max(600, min(1600, num("h", 1080)))
        w -= w % 2
        h -= h % 2
        if state["size"] != (w, h):
            state["size"] = (w, h)
            run(["xrandr", "--fb", "%dx%d" % (w, h)], timeout=8)
        self._send(200, json.dumps({"ok": True, "w": w, "h": h}))

    # ---------------------------- POST ----------------------------
    def do_POST(self):
        path = self.path.split("?")[0].replace("/clip/", "/", 1)
        if path == "/resize":
            self._handle_resize()
            return
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else b""

        if path == "/set":
            text = data.decode("utf-8", "replace")
            ok = xclip_set(data)
            xclip_set(data, sel="primary")
            state.update({
                "pushed": "txt:" + hashlib.sha1(text.encode("utf-8", "replace")).hexdigest(),
                "sig": None, "kind": "text", "text": text, "img": None, "mime": "",
            })
            state["sig"] = state["pushed"]
            self._send(200, json.dumps({"ok": ok}))
            return

        if path == "/image":
            mime = self.headers.get("X-Mime") or "image/png"
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
                   "image/bmp": "bmp"}.get(mime, "png")
            os.makedirs(UP_DIR, exist_ok=True)
            full = os.path.join(UP_DIR, "paste-%s.%s" % (time.strftime("%Y%m%d-%H%M%S"), ext))
            with open(full, "wb") as fh:
                fh.write(data)
            ok = xclip_set(data, mime=mime)
            state.update({
                "pushed": "img:%s:%s" % (mime, hashlib.sha1(data).hexdigest()),
                "sig": None, "kind": "image", "img": data, "mime": mime, "text": "",
            })
            state["sig"] = state["pushed"]
            if "paste=1" in self.path:      # 让远端立刻粘贴（可选）
                time.sleep(0.15)
                run([XDOOL, "key", "--clearmodifiers", "ctrl+v"], timeout=5)
            self._send(200, json.dumps({"ok": ok, "path": full, "size": len(data)}))
            return

        self._send(404, b"{}")


def main():
    os.makedirs(UP_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("clipbridge on 127.0.0.1:%d display=%s" % (PORT, DISPLAY), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
