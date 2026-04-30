'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  pickFolder:     ()                   => ipcRenderer.invoke('dialog:pick-folder'),
  shareFolder:    (folderPath)         => ipcRenderer.invoke('drive:share-folder', { folderPath }),
  watchDrive:     (keyHex, localFolder) => ipcRenderer.invoke('drive:watch', { keyHex, localFolder }),
  stopWatch:      (mountpoint)         => ipcRenderer.invoke('drive:stop', { mountpoint }),
  listMounts:     ()                   => ipcRenderer.invoke('drive:list-mounts'),
  listSaved:      ()                   => ipcRenderer.invoke('drive:list-saved'),
  saveDrive:      (name, key)          => ipcRenderer.invoke('drive:save', { name, key }),
  forgetDrive:    (name)               => ipcRenderer.invoke('drive:forget', { name }),
  openInFinder:   (p)                  => ipcRenderer.invoke('app:open-in-finder', { path: p }),
  getAutoStart:   ()                   => ipcRenderer.invoke('app:get-auto-start'),
  setAutoStart:   (enabled)            => ipcRenderer.invoke('app:set-auto-start', enabled),
  quit:           ()                   => ipcRenderer.invoke('app:quit'),
  onLog:          (cb) => ipcRenderer.on('log:line', (_, d) => cb(d)),
  onMountStatus:  (cb) => ipcRenderer.on('mount:status-changed', (_, d) => cb(d))
})
