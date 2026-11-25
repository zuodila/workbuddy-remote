# 剪贴板桥：为什么必须自己写

## 问题现场

远程桌面里复制一段中文，粘到本机变成 `å...` 或一串问号；本地复制中文粘过去全是 `?`；远程复制一张图片，粘出来是一个叫 `PNG` 的坏图标。

## 根因：RFB 的剪贴板通道只认 Latin-1

VNC 协议（RFB）里传递剪贴板的只有两条消息：

- `ServerCutText`：服务端 → 客户端（远端复制，本地粘贴）
- `ClientCutText`：客户端 → 服务端（本地复制，远端粘贴）

两者都是**按 ISO-8859-1 编码的字节流**。于是：

1. **远端 → 本机**：x11vnc 把 UTF-8 字节原样塞进 `ServerCutText`，浏览器按 Latin-1 解码 UTF-8 → `ä¸­æ–‡` 这类乱码。
2. **本机 → 远端**：浏览器按 Latin-1 编码，超出 0x7F 的字符直接变 `?`，x11vnc 收到就是一堆问号。
3. **图片**：协议里没有图片通道。某些实现会把图片"降级"成文件名或 MIME 字符串传过去——这就是那个坏掉的 `PNG` 图标。

实测确认（不是猜的）：向 x11vnc 发 15 字节的 UTF-8 中文，X 剪贴板里得到 17 个 `?`。**改前端编码救不了写入方向**，只能绕开这条通道。

## 方案：同源 HTTP 剪贴板桥

```
浏览器页面  ──GET  /clip/get──────────▶  clipbridge ──xclip -o──▶ X CLIPBOARD (:98)
           ◀──{seq,kind,text,mime}─────┘
           ──POST /clip/set（UTF-8）────▶  clipbridge ──xclip -i──▶ X CLIPBOARD / PRIMARY
           ──POST /clip/image（原始字节）─▶  clipbridge ──xclip -t image/png -i──▶
           ──GET  /clip/resize?w=&h─────▶  clipbridge ──xrandr --fb──▶ Xvfb
```

因为它和页面**同源**（nginx 把 `/clip/` 反代到 `127.0.0.1:8137`），所以直接复用你已经输入过的 Basic Auth，不需要第二套口令，也没有 CORS 问题。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/clip/get` | 返回 `{seq, kind, text, mime, url}`；`seq` 变化表示远端剪贴板有新内容 |
| GET | `/clip/image/get?seq=N` | 返回远端剪贴板里的图片原始字节，`Content-Type` 为真实 MIME |
| POST | `/clip/set` | body 为 UTF-8 文本，同时写 `CLIPBOARD` 与 `PRIMARY` |
| POST | `/clip/image` | body 为图片二进制，`X-Mime` 头指定类型；写入 X 剪贴板并落盘 |
| GET | `/clip/resize?w=1600&h=1000` | 调整 Xvfb 帧缓冲（跟随客户端窗口） |
| GET | `/clip/health` | `ok` |

### 关键设计

**1. 先判类型，再决定怎么发。**

```python
targets = xclip_targets()                       # xclip -o -t TARGETS
mime = next((m for m in IMG_TARGETS if m in targets), None)
if mime:                                        # 图片优先
    data = xclip_raw(mime)
    return "image", (data, mime), "img:%s:%s" % (mime, sha1(data))
text = xclip_get_text()
return "text", text, "txt:" + sha1(text)
```

如果只按 `UTF8_STRING` 读，图片会被当成"二进制文本"发出去——就是那个 `PNG` 乱码的由来。**图片绝不能走文本通道。**

**2. 用内容签名做去重，避免双向回环。**

`seq` 只在内容签名变化且不等于"刚由浏览器推上去的签名"时才自增。否则会出现：本机写入 → 远端读到 → 当作新内容回传 → 本机再写入……无限循环，还会覆盖用户刚复制的东西。

**3. 图片写回本机要兜底。**

```js
navigator.clipboard.write([new ClipboardItem({'image/png': png})])
  .catch(() => legacyCopy(png));   // 选中临时 <img> + execCommand('copy')
```

`clipboard.write` 在页面失去焦点时会抛错（比如用户复制完就切到微信），所以保留 `execCommand` 兜底。图片统一转 PNG，因为 `ClipboardItem` 只接受 `image/png`。

## 踩过的坑

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| `autocutsel` 抢所有权 | 图片粘贴偶尔失效，剪贴板被反复改写 | 不要同时跑，直接从启动脚本里去掉 |
| `xclip -i` 会 fork 常驻子进程 | 用 `subprocess.run(capture_output=True)` 会 **8 秒超时**并误判失败 | 写操作必须重定向到 `DEVNULL`、不要捕获输出 |
| 只改 noVNC 前端编码 | 远端 → 本机"看起来"好了，本机 → 远端仍然全是 `?` | 写入方向必须绕开 RFB，前端改不了 |
| 页面缓存 | 改了脚本但行为没变 | 硬刷新（Ctrl+F5）；静态资源加版本号 |
| 图片判断过宽 | 某些应用复制文字时也带 `image/*` 目标 | 只在确有图片目标且能取到字节时才判为图片 |
| 轮询间隔 | 1s 太慢会感觉卡；太快浪费请求 | 1s 是体感与开销的平衡点，可按需调整 |

## 自测

```bash
# 文本：写入并回读
curl -s -X POST --data-binary "中文ABC" http://127.0.0.1:8137/clip/set
DISPLAY=:98 xclip -selection clipboard -o

# 图片：模拟远端复制图片
convert -size 320x160 xc:lightgreen /tmp/t.png
DISPLAY=:98 xclip -selection clipboard -t image/png -i /tmp/t.png
curl -s http://127.0.0.1:8137/clip/get          # kind 应为 image
curl -s http://127.0.0.1:8137/clip/image/get -o /tmp/got.png
md5sum /tmp/t.png /tmp/got.png                   # 应一致
```

## 兼容性说明

- 浏览器端用到 `navigator.clipboard.read/write`，需要 **HTTPS**（或 localhost）与用户授权；旧浏览器会退化，只支持文本方向。
- 服务端依赖 `xclip`、`xdotool`、`xrandr`，Debian 系一条 `apt install` 即可。
- 图片大小没有硬限制，但会落盘到 `uploads/`，建议定期清理（见 `scripts/clipbridge.py` 里的 `CLIP_UPLOAD_DIR`）。
