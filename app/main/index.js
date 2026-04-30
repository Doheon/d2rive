'use strict'
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err) })
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err) })
const { app, ipcMain, dialog, shell, Tray, BrowserWindow, nativeImage, screen } = require('electron')
const { execSync } = require('child_process')
const path = require('path')
const os = require('os')
const { readdir } = require('fs/promises')
const { pathToFileURL } = require('url')
const mounts = require('./mounts')

function makeCleanupByPid(pid) {
  return () => new Promise(res => {
    try { process.kill(pid, 'SIGTERM') } catch { return res() }
    const timer = setTimeout(() => {
      try { process.kill(pid, 'SIGKILL') } catch {}
      res()
    }, 3000)
    const check = setInterval(() => {
      try { process.kill(pid, 0) } catch {
        clearInterval(check); clearTimeout(timer); res()
      }
    }, 300)
  })
}

function discoverMounts() {
  try {
    const output = execSync('ps aux', { encoding: 'utf8' })
    for (const line of output.split('\n')) {
      if (!line.includes('d2rive.js')) continue
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[1])
      const cmdIdx = parts.findIndex(p => p.endsWith('d2rive.js'))
      if (cmdIdx < 0) continue
      const cmd = parts[cmdIdx + 1]

      if (cmd === 'watch') {
        const key = parts[cmdIdx + 2]
        const localFolder = parts[cmdIdx + 3]
        if (!key || !localFolder || !/^[0-9a-f]{64}$/i.test(key)) continue
        if (mounts.getAllMounts().find(m => m.mountpoint === localFolder)) continue
        mounts.addMount({ mountpoint: localFolder, key, type: 'sync', status: 'connected',
          cleanup: makeCleanupByPid(pid) })
      } else if (cmd === 'share') {
        const rest = parts.slice(cmdIdx + 2)
        const writable = rest.includes('--write')
        const folderPath = rest.find(p => !p.startsWith('-'))
        if (!folderPath) continue
        if (mounts.getAllMounts().find(m => m.mountpoint === folderPath)) continue
        mounts.addMount({ mountpoint: folderPath, key: '', type: writable ? 'sync' : 'share', status: 'connected', writable,
          cleanup: makeCleanupByPid(pid) })
      } else if (cmd === 'sync-create') {
        const rest = parts.slice(cmdIdx + 2)
        const folderPath = rest.find(p => !p.startsWith('-'))
        if (!folderPath) continue
        if (mounts.getAllMounts().find(m => m.mountpoint === folderPath)) continue
        mounts.addMount({ mountpoint: folderPath, key: '', type: 'sync', status: 'connected', writable: true,
          cleanup: makeCleanupByPid(pid) })
      } else if (cmd === 'sync-join') {
        const rest = parts.slice(cmdIdx + 2).filter(p => !p.startsWith('-'))
        const key = rest[0]
        const localFolder = rest[1]
        if (!key || !localFolder || !/^[0-9a-f]{64}$/i.test(key)) continue
        if (mounts.getAllMounts().find(m => m.mountpoint === localFolder)) continue
        mounts.addMount({ mountpoint: localFolder, key, type: 'sync', status: 'connected', writable: true,
          cleanup: makeCleanupByPid(pid) })
      }
    }
  } catch {}
}

let syncLib, drivesLib
async function loadLibs() {
  syncLib = await import(pathToFileURL(path.join(__dirname, '../src/sync.js')).href)
  drivesLib = await import(pathToFileURL(path.join(__dirname, '../src/drives.js')).href)
}

let tray, win
let dialogOpen = false
let quitting = false

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/trayTemplate.png'))
  tray = new Tray(icon)
  tray.setToolTip('d2rive')
  tray.on('click', (_, bounds) => { discoverMounts(); toggleWindow(bounds) })
}

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '../renderer/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.on('blur', () => { if (!dialogOpen) win.hide() })
  mounts.setWindow(win)
}

function getWindowPosition(trayBounds) {
  const [winWidth, winHeight] = win.getSize()

  if (process.platform === 'darwin') {
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2)
    const y = Math.round(trayBounds.y + trayBounds.height + 4)
    return { x, y }
  }

  if (process.platform === 'win32') {
    const d = screen.getPrimaryDisplay()
    return { x: d.bounds.width - winWidth - 8, y: d.bounds.height - winHeight - 50 }
  }

  // Linux
  if (trayBounds && trayBounds.width > 0) {
    return {
      x: Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2),
      y: Math.round(trayBounds.y + trayBounds.height + 4)
    }
  }
  const d = screen.getPrimaryDisplay()
  return { x: d.bounds.width - winWidth - 8, y: 8 }
}

function toggleWindow(trayBounds) {
  if (win.isVisible()) { win.hide(); return }
  const { x, y } = getWindowPosition(trayBounds)
  win.setPosition(x, y)
  win.show()
  win.focus()
}

registerIPC()

app.whenReady().then(async () => {
  try {
    await loadLibs()
  } catch (err) {
    dialog.showErrorBox('d2rive failed to start', err.stack || err.message)
    app.exit(1)
    return
  }
  if (app.dock) app.dock.hide()
  createTray()
  createWindow()
  discoverMounts()

  app.on('before-quit', async (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    await mounts.cleanupAll()
    app.exit(0)
  })
})

app.on('window-all-closed', (e) => e.preventDefault())

function registerIPC() {
  ipcMain.handle('dialog:pick-folder', async () => {
    dialogOpen = true
    const result = await dialog.showOpenDialog(win || null, { properties: ['openDirectory'] })
    dialogOpen = false
    if (win) win.focus()
    if (result.canceled || !result.filePaths.length) return { cancelled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('drive:share-folder', async (_, { folderPath, writable }) => {
    const win = mounts.getWindow()
    const logToRenderer = (text) => {
      if (win && !win.isDestroyed()) win.webContents.send('log:line', { text, level: 'info' })
    }
    try {
      const result = await Promise.race([
        syncLib.createSync(folderPath, {
          writable,
          onLog: logToRenderer,
          onStatus: (status) => mounts.setStatus(folderPath, status)
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for sync key')), 30000))
      ])
      const fullKey = 'sync:' + result.key
      mounts.addMount({
        mountpoint: folderPath,
        key: fullKey,
        type: writable ? 'sync' : 'share',
        status: 'connected',
        writable,
        cleanup: result.cleanup
      })
      return { key: fullKey }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('drive:watch', async (_, { keyHex, localFolder, clean }) => {
    const rawKey = keyHex.startsWith('sync:') ? keyHex.slice(5) : keyHex
    const win = mounts.getWindow()
    const logToRenderer = (text) => {
      if (win && !win.isDestroyed()) win.webContents.send('log:line', { text, level: 'info' })
    }
    try {
      const result = await Promise.race([
        syncLib.joinSync(rawKey, localFolder, {
          onLog: logToRenderer,
          onStatus: (status) => mounts.setStatus(localFolder, status),
          onDisconnect: () => mounts.removeMount(localFolder).catch(() => {}),
          clean
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out connecting')), 60000))
      ])
      mounts.addMount({
        mountpoint: localFolder,
        key: keyHex,
        type: 'sync',
        status: 'connected',
        writable: result.writable,
        cleanup: result.cleanup
      })
      return { ok: true }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('drive:stop', async (_, { mountpoint }) => {
    try { await mounts.removeMount(mountpoint); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('drive:list-mounts', async () => mounts.getAllMounts())

  ipcMain.handle('drive:list-saved', async () => {
    if (!drivesLib) return []
    return drivesLib.listDrives()
  })

  ipcMain.handle('drive:save', async (_, { name, key, folder }) => {
    try { await drivesLib.saveDrive(name, key, folder || null); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('app:folder-info', async (_, { path: p }) => {
    try {
      const entries = await readdir(p, { withFileTypes: true })
      const count = entries.length
      return { exists: true, hasFiles: count > 0, count }
    } catch {
      return { exists: false, hasFiles: false, count: 0 }
    }
  })

  ipcMain.handle('drive:forget', async (_, { name }) => {
    try { await drivesLib.removeDrive(name); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('app:default-folder', (_, keyHex) => {
    const raw = keyHex.startsWith('sync:') ? keyHex.slice(5) : keyHex
    return path.join(os.homedir(), 'd2rive', raw.slice(0, 8))
  })

  ipcMain.handle('app:open-in-finder', async (_, { path: p }) => shell.showItemInFolder(p))

  ipcMain.handle('app:get-auto-start', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('app:set-auto-start', (_, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return { ok: true }
  })

  ipcMain.handle('app:quit', () => app.quit())
}
