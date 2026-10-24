'use strict';

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, clipboard, session } = require('electron');
const fs = require('fs');
const path = require('path');
const updater = require('./updater');

// ============ 配置区 ============

// 启动页（可用环境变量 FSDOC_URL 覆盖，如他人分享的文档直链）
const START_URL = process.env.FSDOC_URL || 'https://feishu.cn/docs/';

// 允许在应用内打开的域名后缀白名单（飞书系 + 常见第三方扫码登录）
const ALLOWED_HOSTS = [
  'feishu.cn',      // 飞书国内主域（含 docs / passport / accounts / *.feishu.cn）
  'feishu.com',
  'larksuite.com',  // 飞书国际旧域
  'larkoffice.com', // 飞书国际新域
  'open.weixin.qq.com',   // 微信扫码登录
  'work.weixin.qq.com',   // 企业微信扫码登录
];

// 伪装成 Chrome，避免飞书识别出 Electron/嵌入式浏览器而降级或跳转
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 顶部 tab 栏高度（px）
const TABBAR_HEIGHT = 40;

// tab 列表持久化文件（重启恢复上次打开的文档）
const STATE_FILE = path.join(app.getPath('userData'), 'tabs-state.json');

// ============ 工具函数 ============

function isAllowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some(
    (allowed) => h === allowed || h.endsWith('.' + allowed)
  );
}

// 子框架（iframe）导航：飞书文档会内嵌第三方内容，所以允许任意 http(s) 域名；
// 但绝不允许自定义协议（feishu:// 等）唤起外部 App。
function isSafeSubframeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return ['http:', 'https:', 'about:', 'blob:', 'data:'].includes(u.protocol);
}

// ============ Tab 管理 ============

let win = null;
let tabs = []; // [{ id, view, title, favicon, url }]，数组顺序 = tab 栏显示顺序
let activeId = null; // 当前焦点 tab（分屏时 = 当前聚焦的那个窗格）
let nextId = 1;

// 分屏状态：null = 单屏；否则两个窗格各显示一个 tab。
// 不变量：分屏时 activeId 一定是 left / right 之一。
let split = null; // { left: id, right: id, ratio: 0.5 }
const SPLIT_GAP = 6;       // 两个窗格之间的分隔条宽度（px）
const SPLIT_MIN = 0.2;     // 分隔条可拖动范围
const SPLIT_MAX = 0.8;

function activeTab() {
  return tabs.find((t) => t.id === activeId) || null;
}

function inSplit(id) {
  return !!split && (id === split.left || id === split.right);
}

function updateTabbar() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('tabs-updated', {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title || '加载中…',
      favicon: t.favicon || null,
    })),
    activeId,
    split: split ? { left: split.left, right: split.right, ratio: split.ratio, gap: SPLIT_GAP } : null,
  });
  const at = activeTab();
  win.setTitle(at && at.title ? at.title : '飞书文档');
}

// 计算每个 tab 的显示区域：单屏 = 活动 tab 铺满；分屏 = 左右两窗格；其余 tab 隐藏（不渲染，省资源）
function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const top = TABBAR_HEIGHT;
  const ch = h - top;

  const shown = new Map();
  if (split) {
    const avail = w - SPLIT_GAP;
    const lw = Math.round(avail * split.ratio);
    shown.set(split.left, { x: 0, y: top, width: lw, height: ch });
    shown.set(split.right, { x: lw + SPLIT_GAP, y: top, width: avail - lw, height: ch });
  } else if (activeId !== null) {
    shown.set(activeId, { x: 0, y: top, width: w, height: ch });
  }

  for (const t of tabs) {
    const b = shown.get(t.id);
    if (b) {
      t.view.setBounds(b);
      t.view.setVisible(true);
    } else {
      t.view.setVisible(false);
    }
  }
}

// 激活 tab。分屏时：点到窗格内的 tab = 切换焦点；点到窗格外的 tab = 替换当前聚焦的窗格
function setActive(id, focus = true) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (split && !inSplit(id)) {
    if (activeId === split.right) split.right = id;
    else split.left = id;
  }
  activeId = id;
  layout();
  if (focus) t.view.webContents.focus();
  updateTabbar();
  saveState();
}

// ---- 分屏 ----

// 让 id 对应的 tab 与当前 tab 分屏。已在分屏时：替换"没聚焦的那个窗格"，并聚焦新 tab
function splitWith(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  if (split) {
    if (!inSplit(id)) {
      if (activeId === split.left) split.right = id;
      else split.left = id;
    }
  } else {
    if (activeId === null || id === activeId) return;
    split = { left: activeId, right: id, ratio: 0.5 };
  }
  activeId = id;
  layout();
  t.view.webContents.focus();
  updateTabbar();
  saveState();
}

function exitSplit() {
  if (!split) return;
  split = null;
  layout();
  const t = activeTab();
  if (t) t.view.webContents.focus();
  updateTabbar();
  saveState();
}

// 分屏开关：已分屏 → 退出；未分屏 → 与"下一个 tab"分屏，只有一个 tab 时新开一个首页 tab 来分
function toggleSplit() {
  if (split) return exitSplit();
  if (activeId === null) return;
  if (tabs.length > 1) {
    const idx = tabs.findIndex((t) => t.id === activeId);
    const other = tabs[(idx + 1) % tabs.length];
    splitWith(other.id);
  } else {
    const newId = addTab(START_URL, { activate: false });
    splitWith(newId);
  }
}

function setSplitRatio(ratio, commit) {
  if (!split) return;
  split.ratio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(ratio) || 0.5));
  layout();
  if (commit) {
    updateTabbar();
    saveState();
  }
}

// ---- 标签页拖动排序 ----

// toIndex = 拖完之后该 tab 在数组里的最终下标
function moveTab(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const [t] = tabs.splice(from, 1);
  const to = Math.max(0, Math.min(Number(toIndex) | 0, tabs.length));
  tabs.splice(to, 0, t);
  updateTabbar();
  saveState();
}

function addTab(url, { activate = true, opener = null } = {}) {
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'pane-preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 原生右键菜单（WebContentsView 默认没有）：链接 → 新标签页打开
  view.webContents.on('context-menu', (_e, params) => {
    const wc = view.webContents;
    const items = [];

    if (params.linkURL && isAllowedUrl(params.linkURL)) {
      items.push(
        { label: '在新标签页中打开', click: () => addTab(params.linkURL, { activate: true, opener: wc }) },
        { label: '在后台标签页中打开', click: () => addTab(params.linkURL, { activate: false }) },
        {
          label: '在分屏窗格中打开',
          click: () => splitWith(addTab(params.linkURL, { activate: false })),
        },
        { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }

    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
        { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
        { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
        { role: 'selectAll', label: '全选' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: '复制' });
    } else {
      items.push(
        { label: '后退', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: '前进', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: '刷新', click: () => wc.reload() },
      );
    }

    // 去掉末尾多余的分隔线
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  view.webContents.on('page-title-updated', (_e, title) => {
    const t = tabs.find((x) => x.id === id);
    if (t) { t.title = title; updateTabbar(); }
  });
  view.webContents.on('page-favicon-updated', (_e, icons) => {
    const t = tabs.find((x) => x.id === id);
    if (t && icons && icons.length) { t.favicon = icons[icons.length - 1]; updateTabbar(); }
  });

  // 页内跳转（含飞书 SPA 的 pushState）后保存 URL，崩溃/强杀后也能恢复到最近的位置
  view.webContents.on('did-navigate', scheduleSave);
  view.webContents.on('did-navigate-in-page', scheduleSave);

  // 渲染进程崩溃/被杀：自动重新加载，避免窗格永远空白（10 秒内最多自动恢复 3 次，防止死循环）
  let crashTimes = [];  // quitting 见文件底部：退出过程中不再自动恢复
  view.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || quitting) return;
    const now = Date.now();
    crashTimes = crashTimes.filter((x) => now - x < 10000);
    crashTimes.push(now);
    if (crashTimes.length > 3) return;
    setTimeout(() => {
      const wc = view.webContents;
      if (!wc.isDestroyed()) wc.reload();
    }, 300);
  });

  tabs.push({ id, view, title: '', favicon: null, url });
  win.contentView.addChildView(view);
  view.webContents.loadURL(url);

  if (activate) {
    // 分屏时，若新 tab 是从某个窗格里点出来的，就在"那个窗格"里替换显示，而不是替换另一个窗格
    if (split && opener) {
      const from = tabs.find((x) => x.view.webContents === opener);
      if (from && inSplit(from.id)) activeId = from.id;
    }
    setActive(id);
  } else {
    layout();
    updateTabbar();
    saveState();
  }
  return id;
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const t = tabs[idx];
  tabs.splice(idx, 1);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();

  // 关掉的是分屏里的 tab → 退出分屏，留下另一个窗格的 tab
  let refocus = false;
  if (split && inSplit(id)) {
    const other = id === split.left ? split.right : split.left;
    split = null;
    activeId = other; // 不变量：留下的那个窗格成为聚焦 tab
    refocus = true;   // 被关的窗格带着键盘焦点走了，要把焦点交给留下的窗格
  }

  if (tabs.length === 0) {
    // 关到最后一个 tab：开新 tab 回首页，窗口不退出（浏览器习惯）
    addTab(START_URL);
  } else if (activeId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    setActive(next.id);
  } else {
    layout();
    updateTabbar();
    if (refocus) {
      const a = activeTab();
      if (a) a.view.webContents.focus();
    }
  }
  saveState();
}

function closeOtherTabs(keepId) {
  for (const t of tabs.slice()) {
    if (t.id !== keepId) closeTab(t.id);
  }
  if (tabs.some((t) => t.id === keepId)) setActive(keepId);
}

// ============ Tab 状态持久化 ============

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 800);
}

function saveState() {
  clearTimeout(saveTimer);
  try {
    // 页面尚未加载完时 getURL() 返回空，退回 tab 初始 url；非白名单 url 不存
    const entries = tabs
      .map((t) => ({ id: t.id, url: t.view.webContents.getURL() || t.url }))
      .filter((e) => e.url && isAllowedUrl(e.url));

    const idxOf = (id) => entries.findIndex((e) => e.id === id);
    const state = {
      tabs: entries.map((e) => ({ url: e.url })),
      activeIndex: Math.max(0, idxOf(activeId)),
    };
    // 分屏用"过滤后的下标"保存，避免被丢弃的 tab 让下标错位
    if (split && idxOf(split.left) !== -1 && idxOf(split.right) !== -1) {
      state.split = { left: idxOf(split.left), right: idxOf(split.right), ratio: split.ratio };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // 忽略持久化失败
  }
}

function restoreTabs() {
  let restored = false;
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const urls = ((s && s.tabs) || []).map((t) => t.url).filter(isAllowedUrl);
    if (urls.length) {
      const active = Math.min(s.activeIndex | 0, urls.length - 1);
      const ids = urls.map((u, i) => addTab(u, { activate: i === active }));

      const sp = s.split;
      if (sp && ids[sp.left] !== undefined && ids[sp.right] !== undefined && sp.left !== sp.right) {
        split = {
          left: ids[sp.left],
          right: ids[sp.right],
          ratio: Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number(sp.ratio) || 0.5)),
        };
        // 保持不变量：聚焦的 tab 必须是两个窗格之一
        activeId = inSplit(ids[active]) ? ids[active] : split.right;
        layout();
        updateTabbar();
      }
      restored = true;
    }
  } catch {
    // 无状态文件或损坏，走默认
  }
  if (!restored) addTab(START_URL);
}

// ============ 窗口 ============

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    // 原生标题栏：窗口可拖动、红绿灯原生位置、标题跟随文档名
    show: false,
    backgroundColor: '#f2f3f5',
    title: '飞书文档',
    webPreferences: {
      preload: path.join(__dirname, 'tabbar-preload.js'),
      contextIsolation: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('resize', layout);
  // 窗口关闭时（webContents 尚未销毁）保存 tab 列表，before-quit 时已销毁会失败
  win.on('close', saveState);
  win.loadFile('tabbar.html');
  win.webContents.once('did-finish-load', restoreTabs);
}

// ============ 导航与回退 ============

function goBack() {
  const t = activeTab();
  if (t) t.view.webContents.navigationHistory.goBack();
}

function goForward() {
  const t = activeTab();
  if (t) t.view.webContents.navigationHistory.goForward();
}

// 缩放 / 刷新必须作用在"当前文档"上（菜单角色默认作用于 tab 栏页面）
function withActive(fn) {
  const t = activeTab();
  if (t && !t.view.webContents.isDestroyed()) fn(t.view.webContents);
}
function zoomBy(delta) {
  withActive((wc) => {
    wc.setZoomLevel(Math.max(-3, Math.min(5, wc.getZoomLevel() + delta)));
  });
}

function buildMenu() {
  const template = [
    // 自定义应用菜单（替代 role:appMenu）：加"检查更新"，并保留关于/服务/隐藏/退出
    ...(process.platform === 'darwin' ? [{
      label: '飞书文档',
      submenu: [
        { label: '关于飞书文档', role: 'about' },
        { label: '检查更新…', click: () => updater.checkForUpdates({ manual: true }) },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏飞书文档' },
        { role: 'hideothers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出飞书文档' },
      ],
    }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: '后退', accelerator: 'CmdOrCtrl+[', click: goBack },
        { label: '前进', accelerator: 'CmdOrCtrl+]', click: goForward },
        { type: 'separator' },
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => withActive((wc) => wc.reload()) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => withActive((wc) => wc.setZoomLevel(0)) },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => zoomBy(0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: () => addTab(START_URL) },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => { if (activeId !== null) closeTab(activeId); } },
        { type: 'separator' },
        { label: '分屏查看 / 退出分屏', accelerator: 'CmdOrCtrl+Alt+\\', click: toggleSplit },
        { type: 'separator' },
        { role: 'minimize', label: '最小化' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============ 应用生命周期 ============

app.userAgentFallback = USER_AGENT;
app.setName('飞书文档');
// 「关于」面板内容（菜单里 role:about 弹出）
app.setAboutPanelOptions({
  applicationName: '飞书文档',
  applicationVersion: `v${app.getVersion()}`,
  version: app.getVersion(),
  credits: 'fsdoc-client · github.com/SirKayZh/fsdoc-client',
});

app.on('web-contents-created', (_event, contents) => {
  // 拦截 window.open / target=_blank / Cmd+点击 / 右键"在新标签页打开"：
  //   - 白名单链接 -> 新 tab（Cmd/中键后台打开），绝不弹独立窗口、不落系统浏览器
  //   - 其他（含 feishu:// 唤起客户端）-> 直接吞掉
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isAllowedUrl(url)) {
      const background = disposition === 'background-tab';
      // opener：分屏时让新文档在"发起点击的那个窗格"里替换显示
      addTab(url, { activate: !background, opener: contents });
    }
    return { action: 'deny' };
  });

  // 拦截页内导航：
  //   - 白名单 https 链接 -> 放行（飞书 SPA 路由不受影响）
  //   - feishu:// 等自定义协议 -> 阻止，防止唤起飞书主客户端
  //   - 非白名单域名 -> 阻止，不跳系统浏览器
  //   - 主框架：必须白名单；子框架(iframe)：放行 http(s)，但拦自定义协议
  //   - will-navigate 管不到 iframe，也管不到服务端 302 重定向，所以用 will-frame-navigate + will-redirect
  const guard = (event) => {
    const ok = event.isMainFrame ? isAllowedUrl(event.url) : isSafeSubframeUrl(event.url);
    if (!ok) event.preventDefault();
  };
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
});

// 文档里 window.open 打开的链接若其实是附件下载，会留下一个空白 tab：下载结束后自动关掉它
function installDownloadGuard() {
  session.defaultSession.on('will-download', (_e, item, wc) => {
    const t = tabs.find((x) => x.view.webContents === wc);
    if (!t || wc.getURL()) return; // 只处理"从没加载出任何页面"的空白 tab
    item.once('done', () => {
      const cur = tabs.find((x) => x.id === t.id);
      if (cur && !cur.view.webContents.isDestroyed() && !cur.view.webContents.getURL()) closeTab(cur.id);
    });
  });
}

// tab 栏 IPC
ipcMain.on('tabbar-ready', updateTabbar);
ipcMain.on('tab-activate', (_e, id) => setActive(id));
ipcMain.on('tab-close', (_e, id) => closeTab(id));
ipcMain.on('tab-new', () => addTab(START_URL));
// 分屏时用户点了某个窗格 → 切换聚焦窗格（该页面已经拿到键盘焦点，这里只同步状态，不再 focus()）
ipcMain.on('pane-focus', (e) => {
  const t = tabs.find((x) => x.view.webContents === e.sender);
  if (!t || !inSplit(t.id) || activeId === t.id) return;
  activeId = t.id;
  updateTabbar();
  saveState();
});
ipcMain.on('tab-move', (_e, id, toIndex) => moveTab(id, toIndex));
ipcMain.on('split-toggle', toggleSplit);
ipcMain.on('split-ratio', (_e, ratio, commit) => setSplitRatio(ratio, !!commit));

// tab 上右键：原生菜单
ipcMain.on('tab-context', (_e, id) => {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  const url = t.view.webContents.getURL() || t.url;
  const items = [];

  if (split) {
    items.push({ label: '退出分屏', click: exitSplit });
    if (!inSplit(id)) {
      items.push({ label: '替换聚焦窗格显示此标签页', click: () => setActive(id) });
    }
  } else if (id !== activeId) {
    items.push({ label: '与当前标签页分屏查看', click: () => splitWith(id) });
  } else {
    items.push({ label: '分屏查看（与下一个标签页）', click: toggleSplit });
  }
  items.push(
    { type: 'separator' },
    { label: '复制链接地址', click: () => clipboard.writeText(url) },
    { label: '刷新', click: () => t.view.webContents.reload() },
    { type: 'separator' },
    { label: '关闭标签页', click: () => closeTab(id) },
    { label: '关闭其他标签页', enabled: tabs.length > 1, click: () => closeOtherTabs(id) },
  );
  Menu.buildFromTemplate(items).popup({ window: win });
});

// 单实例：同一份数据目录只允许一个进程，否则两个实例会互相覆盖 tabs-state.json
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    installDownloadGuard(); // session 必须在 ready 之后才能取到
    buildMenu();
    createWindow();
    updater.init(); // 自动更新：清备份 + 启动静默检查 + 每 6 小时复查
  });
}

app.on('activate', () => {
  if (win && !win.isDestroyed()) {
    win.focus();
  } else {
    createWindow();
  }
});

let quitting = false;
app.on('before-quit', () => { quitting = true; saveState(); });
app.on('window-all-closed', () => app.quit());
