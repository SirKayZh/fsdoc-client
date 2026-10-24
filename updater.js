'use strict';

// ============ 自动更新（GitHub Releases） ============
//
// 为什么不用 electron-updater：它的 macOS 通道走 Squirrel.Mac，要求新包与旧包
// 拥有相同的开发者签名身份；本应用只有 ad-hoc 签名（无 Apple 开发者账号），
// Squirrel 校验过不去。所以自行实现：
//
//   启动 8 秒后静默检查（+每 6 小时复查） / 菜单「检查更新…」手动触发
//   → 查 GitHub Releases API → 有新版本弹原生对话框
//   → 下载 Release 里的 zip 资产（带进度小窗）
//   → ditto 解压 → xattr 清隔离属性 → 旧 .app 改名备份 → 新 .app 原地顶上
//   → 拉起新进程 → 退出旧进程；下次启动时清理备份
//
// 发布侧约定（build-app.sh 会一并产出）：
//   Release 资产里必须有一个 zip：FeishuDocs-<版本>-<架构>.zip（内含 飞书文档.app）
//   架构命名与 uname -m 一致：arm64 / x86_64

const { app, dialog, shell, net, BrowserWindow } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'SirKayZh/fsdoc-client';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const UA = `fsdoc-client-updater/${app.getVersion()}`;
// process.arch: arm64 / x64 → 资产文件名里的 uname -m 命名
const ARCH_TAG = process.arch === 'x64' ? 'x86_64' : process.arch;

// 跳过版本等持久化状态
const STATE_FILE = path.join(app.getPath('userData'), 'update-state.json');

// 本会话内已提示过的版本，防止 6 小时定时复查反复弹窗
let promptedTag = null;

// ---- 小工具 ----

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch { /* 忽略 */ }
}

// 'v0.5.0' → [0,5,0]；带 prerelease 后缀（v1.0.0-beta.1）的视为正式版号
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function isNewer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// app.getPath('exe') = <bundle>/Contents/MacOS/FeishuDocs → 三层 dirname 回到 .app
function appBundleDir() {
  return path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
}

function execTool(tool, args) {
  return new Promise((resolve, reject) => {
    execFile(tool, args, (err, _out, stderr) => {
      if (err) reject(new Error(`${tool} ${args.join(' ')}: ${stderr || err.message}`));
      else resolve();
    });
  });
}

// ---- 网络 ----

// Electron net：走 Chromium 网络栈（系统代理生效），GitHub API 必须带 UA
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = net.request(url, { redirect: 'follow' });
    req.setHeader('User-Agent', UA);
    req.setHeader('Accept', 'application/vnd.github+json');
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadTo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = net.request(url, { redirect: 'follow' });
    req.setHeader('User-Agent', UA);
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['Content-Length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        out.write(c);
        if (total && onProgress) onProgress(got, total);
      });
      res.on('end', () => out.end(() => resolve(dest)));
      res.on('error', reject);
      out.on('error', reject);
      req.on('abort', () => reject(new Error('下载已中断')));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- 提示 ----

function fmtNotes(body) {
  const t = String(body || '').trim();
  return t.length > 600 ? t.slice(0, 600) + '…' : t;
}

// 弹对话框：有主窗口就挂窗口上；没有就独立弹（showMessageBoxSync(undefined, opts) 会被 Electron 拒）
function msgBox(opts) {
  const w = win();
  return w ? dialog.showMessageBoxSync(w, opts) : dialog.showMessageBoxSync(opts);
}

function notifyUpdate(rel) {
  const tag = rel.tag_name || '';
  const remote = parseVersion(tag);
  const local = parseVersion(app.getVersion());
  const asset = pickAsset(rel);

  const buttons = ['立即更新', '稍后再说', '跳过此版本'];
  const detailParts = [`当前版本 v${local ? local.join('.') : '?'} → 新版本 ${tag}`];
  if (!asset) detailParts.push('\n⚠️ 这个 Release 没有附带 zip 更新包，请到发布页手动下载。');
  if (rel.body) detailParts.push('\n更新内容：\n' + fmtNotes(rel.body));

  const choice = msgBox({
    type: 'info',
    message: `发现新版本 ${tag}`,
    detail: detailParts.join('\n'),
    buttons: asset ? buttons.concat(['查看发布页']) : ['查看发布页'].concat(buttons.slice(0, 2)),
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  // 无 zip 资产时按钮布局不同：0=查看发布页, 1=稍后再说
  if (!asset) {
    if (choice === 0) shell.openExternal(rel.html_url);
    return;
  }
  // 有 zip 时：0=立即更新 1=稍后再说 2=跳过此版本 3=查看发布页
  if (choice === 0) startUpdate(asset, rel);
  else if (choice === 1) { /* 稍后再说 */ }
  else if (choice === 2) writeState({ ...readState(), skip: tag });
  else if (choice === 3) shell.openExternal(rel.html_url);
}

// ---- 下载安装 ----

function pickAsset(rel) {
  const assets = (rel && rel.assets) || [];
  return (
    assets.find((a) => a.name && a.name.endsWith(`-${ARCH_TAG}.zip`)) ||
    assets.find((a) => a.name && a.name.endsWith('.zip')) ||
    null
  );
}

// 进度小窗（简单 HTML，无外部文件依赖）
function progressWindow() {
  const w = new BrowserWindow({
    width: 420,
    height: 150,
    show: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '软件更新',
    backgroundColor: '#f2f3f5',
  });
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f2f3f5;color:#1f2329;padding:20px 24px;user-select:none}
  #t{font-size:13px;color:#41464f;margin-bottom:14px;line-height:1.5}
  .bar{height:8px;border-radius:4px;background:#e2e4ea;overflow:hidden}
  .bar>div{height:100%;width:0;border-radius:4px;background:#3370ff;transition:width .2s}
  #p{font-size:12px;color:#8f959e;margin-top:10px;text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>
  <div id="t">正在下载更新…</div>
  <div class="bar"><div id="b"></div></div>
  <div id="p">0%</div>
<script>
  window.setProgress = (frac, text) => {
    document.getElementById('b').style.width = (frac * 100).toFixed(1) + '%';
    document.getElementById('p').textContent = Math.round(frac * 100) + '%';
    if (text) document.getElementById('t').textContent = text;
  };
  window.setText = (text) => { document.getElementById('t').textContent = text; };
  window.setIndeterminate = () => { document.getElementById('b').style.width = '100%'; document.getElementById('p').textContent = ''; };
</script>
</body></html>`;
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return w;
}

async function startUpdate(asset, rel) {
  // 源码运行（npx electron .）时 bundle 是 node_modules/electron/dist/Electron.app，
  // 原地替换会毁掉开发环境，禁止走自动安装
  if (!app.isPackaged) {
    msgBox({
      type: 'info',
      message: '源码运行模式不支持自动更新',
      detail: '当前是 npm start 的开发实例，请从发布页手动下载更新。',
      buttons: ['查看发布页', '好'],
      defaultId: 0,
      noLink: true,
    }) === 0 && rel.html_url && shell.openExternal(rel.html_url);
    return;
  }

  const tag = rel.tag_name || '';
  const pw = progressWindow();
  const safe = (js) => {
    if (!pw.isDestroyed()) { try { pw.webContents.executeJavaScript(js, true); } catch { /* 窗口已关 */ } }
  };

  const tmpZip = path.join(os.tmpdir(), `fsdoc-update-${Date.now()}.zip`);
  try {
    await downloadTo(asset.browser_download_url, tmpZip, (got, total) => {
      safe(`window.setProgress(${got / total}, '正在下载 ${tag} …')`);
    });
    safe(`window.setIndeterminate(); window.setText('正在安装，完成后将自动重启…')`);

    const bundle = await installFromZip(tmpZip);
    // installFromZip 成功后已拉起新进程；这里只负责收尾退出
    setTimeout(() => app.quit(), 400);
  } catch (e) {
    console.error('[updater] 更新失败：', e);
    if (!pw.isDestroyed()) pw.destroy();
    try { fs.rmSync(tmpZip, { force: true }); } catch { /* 忽略 */ }
    const choice = msgBox({
      type: 'warning',
      message: '更新失败',
      detail: `${e.message}\n\n可以到发布页手动下载最新版本。`,
      buttons: ['查看发布页', '好'],
      defaultId: 0,
      noLink: true,
    });
    if (choice === 0 && rel.html_url) shell.openExternal(rel.html_url);
  } finally {
    try { fs.rmSync(tmpZip, { force: true }); } catch { /* 忽略 */ }
    // 成功路径：窗口随 app.quit() 一起关
  }
}

// 解压 zip → 原地替换 .app → 拉起新进程。返回新 bundle 路径。
async function installFromZip(zipPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsdoc-update-'));
  await execTool('ditto', ['-x', '-k', zipPath, tmp]); // 解出 <tmp>/飞书文档.app

  // 在解压目录里找 .app（名字理论上就是 飞书文档.app，但别硬编码，防改名）
  const newApp = fs.readdirSync(tmp).map((n) => path.join(tmp, n))
    .find((p) => p.endsWith('.app') && fs.statSync(p).isDirectory());
  if (!newApp) throw new Error('更新包里找不到 .app');

  const bundle = appBundleDir();
  const installDir = path.dirname(bundle); // 通常 /Applications

  // 正在从 dmg/只读位置运行时无法原地替换
  try { fs.accessSync(installDir, fs.constants.W_OK); }
  catch {
    throw new Error(`应用所在目录不可写（${installDir}）。请先把「飞书文档」拷贝到「应用程序」后再更新。`);
  }

  // 清掉下载文件可能带的隔离属性，避免 Gatekeeper 拦 ad-hoc 应用
  await execTool('xattr', ['-cr', newApp]);

  const backup = bundle + '.old';
  try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* 忽略 */ }
  fs.renameSync(bundle, backup);
  try {
    // 优先 rename（同卷瞬时）；跨卷退回 ditto 拷贝
    try { fs.renameSync(newApp, bundle); }
    catch { await execTool('ditto', [newApp, bundle]); }
  } catch (e) {
    try { fs.renameSync(backup, bundle); } catch { /* 尽力恢复 */ }
    throw e;
  }

  relaunch(bundle);
  return bundle;
}

// 拉起新版本进程。务必清掉 ELECTRON_RUN_AS_NODE（宿主环境若设置会让新进程退化成纯 Node）
function relaunch(bundle) {
  // bundle/Contents/MacOS 下唯一的可执行文件（build-app.sh 里叫 FeishuDocs，不硬编码防改名）
  const macosDir = path.join(bundle, 'Contents', 'MacOS');
  const exeName = fs.readdirSync(macosDir).filter((n) => !n.startsWith('.') && !n.endsWith('.dylib'))[0];
  const exe = path.join(macosDir, exeName);
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, [], { detached: true, stdio: 'ignore', env }).unref();
}

// ---- 检查入口 ----

async function checkForUpdates({ manual = false } = {}) {
  let rel;
  try {
    rel = await fetchJSON(API_URL);
  } catch (e) {
    console.warn('[updater] 检查更新失败：', e.message);
    if (manual) {
      dialog.showMessageBoxSync({
        type: 'warning',
        message: '检查更新失败',
        detail: `无法访问 GitHub（${e.message}）。\n请检查网络后重试，或到发布页查看。`,
        buttons: ['好'],
        noLink: true,
      });
    }
    return;
  }

  if (!rel || !rel.tag_name) {
    if (manual) {
      msgBox({
        type: 'info',
        message: '暂无可用更新',
        detail: 'GitHub 上还没有发布任何 Release。',
        buttons: ['好'],
        noLink: true,
      });
    }
    return;
  }

  const tag = rel.tag_name;
  const remote = parseVersion(tag);
  const local = parseVersion(app.getVersion());
  if (!remote || !local) {
    console.warn('[updater] 版本号解析失败：', tag, app.getVersion());
    return;
  }

  if (!isNewer(remote, local)) {
    if (manual) {
      msgBox({
        type: 'info',
        message: '已是最新版本',
        detail: `当前 v${local.join('.')}，GitHub 最新 ${tag}。`,
        buttons: ['好'],
        noLink: true,
      });
    }
    return;
  }

  // 有新版本
  if (!manual) {
    const st = readState();
    if (st.skip === tag) return;        // 用户跳过了这个版本
    if (promptedTag === tag) return;    // 本会话已提示过
    promptedTag = tag;
  }
  notifyUpdate(rel);
}

// 对话框 owner：优先挂在主窗口上（跟随置底/最小化），没有窗口就独立弹出
function win() {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
  return w || undefined;
}

// ---- 启动初始化 ----

// 上次升级留下的 <bundle>.old 备份，新进程起来后清掉
function cleanupOldBundles() {
  try {
    const backup = appBundleDir() + '.old';
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } catch (e) {
    console.warn('[updater] 清理旧版本备份失败：', e.message);
  }
}

function init() {
  cleanupOldBundles();
  // 启动 8 秒后静默检查（避开启动高峰）
  setTimeout(() => checkForUpdates({ manual: false }).catch(() => {}), 8000);
  // 每 6 小时复查一次（长开用户也能收到提醒）
  setInterval(() => checkForUpdates({ manual: false }).catch(() => {}), 6 * 60 * 60 * 1000);
}

module.exports = { init, checkForUpdates };
