'use strict'
const { app, ipcMain, dialog, shell } = require('electron')
const { menubar } = require('menubar')
const { spawn } = require('child_process')
const path = require('path')
const mounts = require('./mounts')

const BIN = path.resolve(__dirname, '../../bin/d2rive.js')

const { execSync } = require('child_process')
function findNode() {
  const candidates = [
    process.env.NODE_BINARY,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter(Boolean)
  for (const p of candidates) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore' }); return p } catch {}
  }
  return 'node'
}
const NODE = findNode()

// drives.js has no fuse-native dependency — safe to import directly
let drivesLib
async function loadLibs() {
  drivesLib = await import(path.resolve(__dirname, '../../src/drives.js'))
}

function spawnD2rive(args, { onLine, onExit } = {}) {
  const child = spawn(NODE, [BIN, ...args], {
    env: { ...process.env }
  })

  let buf = ''
  child.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      const win = mounts.getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('log:line', { text: line, level: 'info' })
      if (onLine) onLine(line)
    }
  })

  child.stderr.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      const win = mounts.getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('log:line', { text: line, level: 'error' })
    }
  })

  if (onExit) child.on('exit', onExit)
  return child
}

// Register IPC handlers before menubar is created to avoid timing issues
registerIPC()

app.whenReady().then(async () => {
  await loadLibs()

  const { nativeImage } = require('electron')
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/trayTemplate.png'))

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

  mb.on('ready', () => mounts.setWindow(mb.window))

  app.on('before-quit', async (e) => {
    e.preventDefault()
    await mounts.cleanupAll()
    app.exit(0)
  })
})

app.on('window-all-closed', (e) => e.preventDefault())

function registerIPC() {
  ipcMain.handle('dialog:pick-folder', async () => {
    // mb.window may not exist yet — use null to open as sheet-less dialog
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return { cancelled: true }
    return { path: result.filePaths[0] }
  })

  ipcMain.handle('drive:share-folder', async (_, { folderPath }) => {
    return new Promise((resolve) => {
      let done = false
      const child = spawnD2rive(['share', folderPath], {
        onLine(line) {
          if (done) {
            // Post-resolve: watch for status changes
            if (line.includes('Lost connection')) mounts.setStatus(folderPath, 'disconnected')
            else if (line.includes('Reconnected')) mounts.setStatus(folderPath, 'connected')
            return
          }
          const m = line.match(/Drive key:\s+([0-9a-f]{64})/i)
          if (m) {
            done = true
            const key = m[1]
            mounts.addMount({
              mountpoint: folderPath, key, type: 'share', status: 'connected',
              cleanup: () => new Promise(res => { child.kill('SIGTERM'); child.once('exit', res) })
            })
            resolve({ key })
          }
        },
        onExit(code) {
          if (!done) { done = true; resolve({ error: `Process exited (code ${code})` }) }
          else mounts.setStatus(folderPath, 'disconnected')
        }
      })
      setTimeout(() => { if (!done) { done = true; resolve({ error: 'Timed out waiting for drive key' }) } }, 30000)
    })
  })

  ipcMain.handle('drive:mount', async (_, { keyHex, mountpoint }) => {
    return new Promise((resolve) => {
      let done = false
      const child = spawnD2rive(['mount', keyHex, mountpoint], {
        onLine(line) {
          if (done) {
            if (line.includes('Lost connection')) mounts.setStatus(mountpoint, 'disconnected')
            else if (line.includes('Reconnected')) mounts.setStatus(mountpoint, 'connected')
            return
          }
          if (line.includes('Mounted at') || line.includes('Running...')) {
            done = true
            mounts.addMount({
              mountpoint, key: keyHex, type: 'mount', status: 'connected',
              cleanup: () => new Promise(res => { child.kill('SIGTERM'); child.once('exit', res) })
            })
            resolve({ ok: true })
          }
          if (line.toLowerCase().includes('error')) {
            done = true; resolve({ error: line })
          }
        },
        onExit(code) {
          if (!done) { done = true; resolve({ error: `Process exited (code ${code})` }) }
          else mounts.setStatus(mountpoint, 'disconnected')
        }
      })
      // After 20s still no "Mounted at" — treat as connecting
      setTimeout(() => {
        if (!done) {
          done = true
          mounts.addMount({
            mountpoint, key: keyHex, type: 'mount', status: 'connecting',
            cleanup: () => new Promise(res => { child.kill('SIGTERM'); child.once('exit', res) })
          })
          resolve({ ok: true })
        }
      }, 20000)
    })
  })

  ipcMain.handle('drive:unmount', async (_, { mountpoint }) => {
    try { await mounts.removeMount(mountpoint); return { ok: true } }
    catch (err) { return { error: err.message } }
  })

  ipcMain.handle('drive:list-mounts', async () => mounts.getAllMounts())

  ipcMain.handle('drive:list-saved', async () => {
    if (!drivesLib) return []
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

  ipcMain.handle('app:open-in-finder', async (_, { path: p }) => shell.showItemInFolder(p))

  ipcMain.handle('app:quit', async () => { await mounts.cleanupAll(); app.exit(0) })
}
