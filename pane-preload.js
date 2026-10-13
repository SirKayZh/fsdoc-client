'use strict';

// 注入到每个飞书标签页：用户在页面里按下鼠标时，通知主进程"这个窗格被聚焦了"。
// 分屏时据此切换"聚焦窗格"（标签栏高亮、Cmd+W / 新开标签都以它为准）。
// 不依赖 Electron 的 webContents 'focus' 事件——实测它在 WebContentsView 之间切换时不可靠。
//
// 注意：只监听"用户的鼠标按下"，不要监听 window 'focus'：
// 页面加载 / 程序调用 focus() 时 focus 也会触发，会在启动恢复分屏时把聚焦窗格误改成先加载完的那个。
const { ipcRenderer } = require('electron');

function notify(e) {
  if (e && e.isTrusted === false) return; // 忽略页面脚本合成的事件，只认真实用户输入
  ipcRenderer.send('pane-focus');
}

// 捕获阶段，避免被页面自己的 stopPropagation 吞掉
window.addEventListener('mousedown', notify, true);
window.addEventListener('pointerdown', notify, true);
