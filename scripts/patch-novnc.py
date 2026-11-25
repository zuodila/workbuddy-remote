#!/usr/bin/env python3
"""把 wbclip.js 注入 noVNC 的 vnc.html（幂等，自动备份）。

用法：
    sudo python3 scripts/patch-novnc.py /usr/share/novnc
    # 或指定页面
    sudo python3 scripts/patch-novnc.py /usr/share/novnc --page vnc.html

它做两件事：
  1. 复制 scripts/web/wbclip.js 到 noVNC 目录（如果源文件存在）
  2. 在 </body> 前插入 <script src="wbclip.js"></script>（只插一次）
"""
import argparse
import io
import os
import re
import shutil
import sys

TAG = '<script src="wbclip.js"></script>'
MARK = "<!-- wbclip -->"


def patch(html_path, script_src):
    if not os.path.isfile(html_path):
        sys.exit("页面不存在: %s" % html_path)

    html = io.open(html_path, encoding="utf-8").read()
    if MARK in html or TAG in html:
        print("已注入过，跳过:", html_path)
        return

    if script_src and os.path.isfile(script_src):
        dst = os.path.join(os.path.dirname(html_path), "wbclip.js")
        shutil.copyfile(script_src, dst)
        os.chmod(dst, 0o644)
        print("已复制脚本:", dst)

    backup = html_path + ".bak-wbclip"
    if not os.path.exists(backup):
        shutil.copy2(html_path, backup)

    if "</body>" not in html:
        sys.exit("找不到 </body>，请手动在页面末尾加载 wbclip.js")

    html = html.replace("</body>", "%s\n%s\n</body>" % (MARK, TAG), 1)
    io.open(html_path, "w", encoding="utf-8").write(html)
    print("已注入:", html_path, "(备份 %s)" % backup)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("novnc_dir", help="noVNC 目录，如 /usr/share/novnc")
    ap.add_argument("--page", default="vnc.html", help="要注入的页面，默认 vnc.html")
    ap.add_argument("--script", default=os.path.join(os.path.dirname(__file__), "web", "wbclip.js"),
                    help="wbclip.js 路径")
    args = ap.parse_args()
    patch(os.path.join(args.novnc_dir, args.page), args.script)


if __name__ == "__main__":
    main()
