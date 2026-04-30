'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const { homedir } = require('os')
const path = require('path')

contextBridge.exposeInMainWorld('api', {
  pickFolder:        ()                         => ipcRenderer.invoke('dialog:pick-folder'),
  shareFolder:       (folderPath, writable)      => ipcRenderer.invoke('drive:share-folder', { folderPath, writable }),
  watchDrive:        (keyHex, localFolder, clean) => ipcRenderer.invoke('drive:watch', { keyHex, localFolder, clean }),
  stopWatch:         (mountpoint)               => ipcRenderer.invoke('drive:stop', { mountpoint }),
  listMounts:        ()                         => ipcRenderer.invoke('drive:list-mounts'),
  listSaved:         ()                         => ipcRenderer.invoke('drive:list-saved'),
  saveDrive:         (name, key, folder)        => ipcRenderer.invoke('drive:save', { name, key, folder }),
  forgetDrive:       (name)                     => ipcRenderer.invoke('drive:forget', { name }),
  folderInfo:        (p)                        => ipcRenderer.invoke('app:folder-info', { path: p }),
  getDefaultFolder:  (keyHex)                   => path.join(homedir(), 'd2rive', keyHex.slice(0, 8)),
  openInFinder:      (p)                        => ipcRenderer.invoke('app:open-in-finder', { path: p }),
  getAutoStart:      ()                         => ipcRenderer.invoke('app:get-auto-start'),
  setAutoStart:      (enabled)                  => ipcRenderer.invoke('app:set-auto-start', enabled),
  quit:              ()                         => ipcRenderer.invoke('app:quit'),
  onLog:             (cb) => ipcRenderer.on('log:line', (_, d) => cb(d)),
  onMountStatus:     (cb) => ipcRenderer.on('mount:status-changed', (_, d) => cb(d))
})
