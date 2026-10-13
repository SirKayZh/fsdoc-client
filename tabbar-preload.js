'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  onUpdated: (cb) => ipcRenderer.on('tabs-updated', (_e, state) => cb(state)),
  activate: (id) => ipcRenderer.send('tab-activate', id),
  close: (id) => ipcRenderer.send('tab-close', id),
  newTab: () => ipcRenderer.send('tab-new'),
  ready: () => ipcRenderer.send('tabbar-ready'),
  move: (id, toIndex) => ipcRenderer.send('tab-move', id, toIndex),
  contextMenu: (id) => ipcRenderer.send('tab-context', id),
  toggleSplit: () => ipcRenderer.send('split-toggle'),
  splitRatio: (ratio, commit) => ipcRenderer.send('split-ratio', ratio, commit),
});
