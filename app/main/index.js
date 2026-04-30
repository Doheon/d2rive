'use strict'
const { app, ipcMain, dialog, shell } = require('electron')
const { menubar } = require('menubar')
const path = require('path')
const logger = require('./logger')
const mounts = require('./mounts')

// Patch console BEFORE any d2rive code loads
logger.install()

let mountLib, drivesLib

async function loadLibs() {
  mountLib  = await import(path.resolve(__dirname, '../../src/mount.js'))
  drivesLib = await import(path.resolve(__dirname, '../../src/drives.js'))
}

app.whenReady().then(async () => {
  await loadLibs()

  const { nativeImage } = require('electron')
  const iconPath = path.join(__dirname, '../assets/trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)

  const mb = menubar({
    index: `file://${path.join(__dirname, '../renderer/index.html')}`,
    icon,
    browserWindow: {
      width: 400,
      height: 520,
      webPreferences: {
        preload: path.join(__dirname, '../renderer/preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      },
      resizable: false,
      skipTaskbar: true
    },
    preloadWindow: true,
    showDockIcon: false
  })

  mb.on('ready', () => {
    logger.setWindow(mb.window)
    mounts.setWindow(mb.window)
    registerIPC(mb)
  })

  // Clean up on quit
  app.on('before-quit', async (e) => {
    e.preventDefault()
    await mounts.cleanupAll()
    app.exit(0)
  })
})

app.on('window-all-closed', (e) => e.preventDefault())

function registerIPC(mb) {
  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mb.window, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return { cancelled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('drive:share-folder', async (_, { folderPath }) => {
    try {
      const { key, cleanup } = await mountLib.shareFolder(folderPath)
      mounts.addMount({ mountpoint: folderPath, key, type: 'share', status: 'connected', cleanup })
      return { key }
    } catch (err) { return { error: err.message } }
  })

  ipcMain.handle('drive:mount', async (_, { keyHex, mountpoint }) => {
    try {
      const { cleanup } = await mountLib.connectAndMount(keyHex, mountpoint)
      mounts.addMount({ mountpoint, key: keyHex, type: 'mount', status: 'connected', cleanup })
      return { ok: true }
    } catch (err) { return { error: err.message } }
  })

  ipcMain.handle('drive:unmount', async (_, { mountpoint }) => {
    try { await mounts.removeMount(mountpoint); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('drive:list-mounts', async () => mounts.getAllMounts())

  ipcMain.handle('drive:list-saved', async () => {
    const drives = await drivesLib.listDrives()
    return Object.entries(drives).map(([name, key]) => ({ name, key }))
  })

  ipcMain.handle('drive:save', async (_, { name, key }) => {
    try { await drivesLib.saveDrive(name, key); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('drive:forget', async (_, { name }) => {
    try { await drivesLib.removeDrive(name); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('app:open-in-finder', async (_, { path: p }) => {
    shell.showItemInFolder(p)
  })

  ipcMain.handle('app:quit', async () => {
    await mounts.cleanupAll()
    app.exit(0)
  })
}
