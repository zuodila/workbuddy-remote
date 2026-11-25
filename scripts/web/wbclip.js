/*!
 * wbclip.js —— 挂到 noVNC 页面上，提供 UTF-8 剪贴板 / 图片 / 分辨率自适应
 *
 * 用法：放到 noVNC 目录下，在 vnc.html 的 </body> 前加一行
 *   <script src="wbclip.js"></script>
 * 或者用 scripts/patch-novnc.py 自动注入。
 *
 * 依赖：同源的 /clip/* 接口（见 scripts/clipbridge.py）
 */
(function () {
  'use strict';

  var POLL_MS = 1000;        // 轮询间隔
  var RESIZE_DEBOUNCE = 800; // 窗口尺寸变化后的上报延迟

  var seenSeq = null;
  var busyDown = false;
  var lastImageUrl = null;
  var resizeTimer = null;
  var lastSize = '';

  /* ----------------------------- 上行（本机 → 远端） ----------------------------- */

  function pushText(text) {
    if (!text) return Promise.resolve();
    return fetch('/clip/set', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: text
    }).catch(function () {});
  }

  function pushImage(blob, type) {
    return blob.arrayBuffer().then(function (buf) {
      return fetch('/clip/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Mime': type },
        body: buf
      });
    }).catch(function () {});
  }

  /* 聚焦时把本机剪贴板同步给远端（文本或图片） */
  function syncToRemote() {
    if (busyDown) return;
    if (!navigator.clipboard || !navigator.clipboard.read) return;
    busyDown = true;
    navigator.clipboard.read().then(function (items) {
      var chain = Promise.resolve();
      items.forEach(function (item) {
        var imgType = null;
        for (var i = 0; i < item.types.length; i++) {
          if (item.types[i].indexOf('image/') === 0) { imgType = item.types[i]; break; }
        }
        if (imgType) {
          chain = chain.then(function () { return item.getType(imgType); })
                       .then(function (b) { return pushImage(b, imgType); });
        } else if (item.types.indexOf('text/plain') >= 0) {
          chain = chain.then(function () { return item.getType('text/plain'); })
                       .then(function (b) { return b.text(); })
                       .then(pushText);
        }
      });
      return chain;
    }).catch(function () {}).then(function () { busyDown = false; });
  }

  /* 粘贴事件里的图片兜底（页面已聚焦，比轮询更可靠） */
  document.addEventListener('paste', function (e) {
    var data = e.clipboardData;
    if (!data) return;
    var items = data.items || [];
    var file = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        file = items[i].getAsFile();
      }
    }
    if (!file) return;
    e.preventDefault();
    file.arrayBuffer().then(function (buf) {
      fetch('/clip/image?paste=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Mime': file.type },
        body: buf
      });
    });
  }, true);

  /* ----------------------------- 下行（远端 → 本机） ----------------------------- */

  /* ClipboardItem 只接受 image/png，其它格式先转一遍 */
  function toPng(blob) {
    return new Promise(function (resolve, reject) {
      if (blob.type === 'image/png') return resolve(blob);
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          canvas.toBlob(function (out) {
            URL.revokeObjectURL(url);
            out ? resolve(out) : reject(new Error('toBlob failed'));
          }, 'image/png');
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
      img.src = url;
    });
  }

  /* 兜底：选中一个离屏 <img> 再 execCommand('copy')，页面失焦时也能带走图片 */
  function legacyCopyImage(blob) {
    var url = URL.createObjectURL(blob);
    var wrap = document.createElement('div');
    wrap.contentEditable = 'true';
    wrap.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0';
    var img = document.createElement('img');
    img.src = url;
    wrap.appendChild(img);
    document.body.appendChild(wrap);
    try {
      var range = document.createRange();
      range.selectNodeContents(wrap);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
    } catch (err) { /* 忽略：浏览器可能禁止 */ }
    setTimeout(function () {
      try { document.body.removeChild(wrap); } catch (err) {}
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function writeImageToLocal(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('no image');
        return res.blob();
      })
      .then(toPng)
      .then(function (png) {
        if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
          return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
            .catch(function () { legacyCopyImage(png); });
        }
        legacyCopyImage(png);
      })
      .catch(function () {});
  }

  function poll() {
    fetch('/clip/get', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || typeof data.seq !== 'number') return;
        if (seenSeq === null) { seenSeq = data.seq; return; }
        if (data.seq <= seenSeq) return;
        seenSeq = data.seq;

        if (data.kind === 'image') {
          /* 关键：图片绝不能当文本写，否则外部应用收到的是一段二进制乱码 */
          var url = data.url || '/clip/image/get';
          if (url !== lastImageUrl) { lastImageUrl = url; }
          writeImageToLocal(url);
        } else if (data.text) {
          navigator.clipboard.writeText(data.text).catch(function () {});
        }
      })
      .catch(function () {});
  }

  /* ------------------------------- 分辨率跟随 ------------------------------- */

  function reportSize() {
    var w = Math.round(window.innerWidth);
    var h = Math.round(window.innerHeight);
    if (w < 600 || h < 400) return;              // 忽略最小化时的异常值
    var key = w + 'x' + h;
    if (key === lastSize) return;
    lastSize = key;
    fetch('/clip/resize?w=' + w + '&h=' + h, { cache: 'no-store' }).catch(function () {});
  }

  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reportSize, RESIZE_DEBOUNCE);
  }

  window.addEventListener('resize', scheduleResize);
  window.addEventListener('focus', function () { syncToRemote(); });

  window.setInterval(poll, POLL_MS);
  setTimeout(reportSize, 1200);
})();
