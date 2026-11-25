/**
 * WorkBuddy Remote —— 桌面客户端主进程
 *
 * 它只做四件事：
 *   1. 用一个没有地址栏的窗口加载远端的 noVNC 页面
 *   2. 把 Basic Auth 口令注入到 https/wss 请求头（页面本身不知道口令）
 *   3. 系统托盘 + 关闭策略（点 ✕ 收进托盘，真退出走托盘菜单）
 *   4. 保存服务器 / 账号配置
 */
const { app, BrowserWindow, Menu, session, shell, ipcMain, nativeImage, Tray } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_TITLE = 'WorkBuddy 桌面';
const DEFAULT_SERVER = 'https://wb.example.com';   // 占位符，首次运行请在设置里改
const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = process.platform === 'win32'
  ? path.join(__dirname, 'assets', 'icon.ico')
  : ICON;

let win = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let closeHintShown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/* ------------------------------- 配置 ------------------------------- */

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/** 应用自带的预置配置（私有部署可放一份，切勿提交到公开仓库）
 *  查找顺序：安装目录/resources/default-config.json → 应用包内 default-config.json */
function bundledConfig() {
  const candidates = [
    path.join(process.resourcesPath || __dirname, 'default-config.json'),
    path.join(__dirname, 'default-config.json')
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) { /* 继续找下一个 */ }
  }
  return {};
}

function loadConfig() {
  const base = bundledConfig();
  try {
    const user = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {};
    return Object.assign({}, base, user);
  } catch (e) {
    return base;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function serverBase() {
  return (loadConfig().server || DEFAULT_SERVER).replace(/\/+$/, '');
}

function credentials() {
  const cfg = loadConfig();
  return { user: cfg.user || '', pass: cfg.pass || '' };
}

function pageUrl() {
  return serverBase() + '/vnc.html?autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000';
}

/* ---------------------------- 认证注入 ---------------------------- */

function installAuth() {
  let host = '';
  try {
    host = new URL(serverBase()).hostname;
  } catch (e) {
    return;
  }
  const { user, pass } = credentials();
  if (!user) return;                       // 未配置账号：交给服务器自己弹认证

  const token = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
  // 注意 wss 也要匹配，否则 WebSocket 握手 401，表现为"页面能开但一直连接中"
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://' + host + '/*', 'wss://' + host + '/*'] },
    (details, callback) => {
      details.requestHeaders['Authorization'] = token;
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

/* ---------------------------- 窗口与托盘 ---------------------------- */

function showOffline(reason) {
  if (!win) return;
  win.loadFile(path.join(__dirname, 'pages', 'offline.html'), {
    query: { u: encodeURIComponent(pageUrl()), r: String(reason || '') }
  });
}

function quitApp() {
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

function connectItems() {
  return [
    { label: '重新连接', click: () => { win && win.loadURL(pageUrl()); } },
    { label: '刷新页面（F5）', click: () => { win && win.loadURL(pageUrl()); } },
    { label: '全屏切换（F11）', click: () => { win && win.setFullScreen(!win.isFullScreen()); } },
    { type: 'separator' },
    { label: '服务器设置…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出（Ctrl+Shift+Q）', click: () => quitApp() }
  ];
}

function trayItems() {
  return [
    { label: '打开 ' + APP_TITLE, click: () => showWindow() },
    { label: '重新连接', click: () => { if (win) { win.loadURL(pageUrl()); showWindow(); } } },
    { label: '全屏切换（F11）', click: () => { if (win) { win.setFullScreen(!win.isFullScreen()); showWindow(); } } },
    { label: '服务器设置…', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() }
  ];
}

function createTray() {
  if (tray) return;
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) img = nativeImage.createFromPath(ICON);
  if (process.platform === 'darwin') img = img.resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate(trayItems()));
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow());
}

function buildAppMenu() {
  if (process.platform !== 'darwin') return null;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: '连接', submenu: connectItems() },
    { role: 'windowMenu' }
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    title: APP_TITLE,
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  win.setTitle(APP_TITLE);
  win.on('page-title-updated', (e) => e.preventDefault());
  win.setMenuBarVisibility(false);

  // noVNC 页面注册了 beforeunload，Electron 默认会因此拒绝关闭窗口
  // （表现为点 ✕ 毫无反应、系统关闭消息也无效）。这里忽略页面拦截。
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());

  // 点 ✕ 收进系统托盘（真退出走托盘菜单 / Ctrl+Shift+Q）
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'win32' && tray && !closeHintShown) {
      closeHintShown = true;
      try {
        tray.displayBalloon({
          title: APP_TITLE + '仍在运行',
          content: '窗口已收进系统托盘，右键托盘图标可以退出。'
        });
      } catch (err) { /* 通知被系统禁用时忽略 */ }
    }
  });

  win.loadURL(pageUrl());

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOffline(desc);
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if (k === 'f11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (k === 'f5') {
      win.loadURL(pageUrl());
      event.preventDefault();
    } else if (input.control && input.shift && k === 'q') {
      quitApp();
    }
  });

  win.on('closed', () => { win = null; });
}

function openSettings() {
  if (settingsWin) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 600,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '连接设置',
    icon: ICON,
    parent: win || undefined,
    modal: !!win,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'pages', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'pages', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ------------------------------- IPC ------------------------------- */

ipcMain.handle('get-config', () => ({
  server: serverBase(),
  user: credentials().user,
  pass: credentials().pass
}));

ipcMain.handle('set-config', (e, payload) => {
  const raw = String((payload && payload.server) || '').trim();
  if (!raw) return { ok: false, message: '请填写服务器地址' };

  let server = raw;
  if (!/^https?:\/\//i.test(server)) server = 'https://' + server;
  try {
    // eslint-disable-next-line no-new
    new URL(server);
  } catch (err) {
    return { ok: false, message: '地址格式不正确，应形如 https://example.com:8443' };
  }

  const cfg = loadConfig();
  cfg.server = server.replace(/\/+$/, '');
  cfg.user = String((payload && payload.user) || '').trim();
  cfg.pass = String((payload && payload.pass) || '');
  saveConfig(cfg);

  installAuth();
  if (win) win.loadURL(pageUrl());
  return { ok: true };
});

ipcMain.handle('close-settings', () => {
  if (settingsWin) settingsWin.close();
});

/* ------------------------------ 生命周期 ------------------------------ */

app.on('login', (event, webContents, request, authInfo, callback) => {
  const { user, pass } = credentials();
  if (authInfo && !authInfo.isProxy && user) {
    event.preventDefault();
    callback(user, pass);
  }
});

app.on('web-contents-created', (e, contents) => {
  contents.on('context-menu', () => {
    if (settingsWin && contents === settingsWin.webContents) return;
    if (typeof contents.getType === 'function' && contents.getType() !== 'window') return;
    Menu.buildFromTemplate(connectItems()).popup({
      window: BrowserWindow.fromWebContents(contents) || undefined
    });
  });
});

app.on('second-instance', () => showWindow());

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(ICON);
    if (!img.isEmpty() && app.dock) app.dock.setIcon(img);
  }
  installAuth();
  const m = buildAppMenu();
  if (m) Menu.setApplicationMenu(m);
  else Menu.setApplicationMenu(null);
  createWindow();
  createTray();
});
