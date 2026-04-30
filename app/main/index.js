'use strict'
const { app, ipcMain, dialog, shell, Tray, BrowserWindow, nativeImage, screen } = require('electron')
const { spawn, execSync } = require('child_process')
const path = require('path')
const mounts = require('./mounts')

const BIN = path.resolve(__dirname, '../../bin/d2rive.js')

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

function makeCleanup(child) {
  return () => new Promise(res => {
    child.kill('SIGTERM')
    const timer = setTimeout(() => { child.kill('SIGKILL'); res() }, 3000)
    child.once('exit', () => { clearTimeout(timer); res() })
  })
}

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
        mounts.addMount({ mountpoint: localFolder, key, type: 'watch', status: 'connected',
          cleanup: makeCleanupByPid(pid) })
      } else if (cmd === 'share') {
        const folderPath = parts[cmdIdx + 2]
        if (!folderPath) continue
        if (mounts.getAllMounts().find(m => m.mountpoint === folderPath)) continue
        mounts.addMount({ mountpoint: folderPath, key: '', type: 'share', status: 'connected',
          cleanup: makeCleanupByPid(pid) })
      }
    }
  } catch {}
}

let drivesLib
async function loadLibs() {
  drivesLib = await import(path.resolve(__dirname, '../../src/drives.js'))
}

function spawnD2rive(args, { onLine, onExit } = {}) {
  const child = spawn(NODE, [BIN, ...args], { env: { ...process.env } })

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

let tray, win
let dialogOpen = false

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
  await loadLibs()
  if (app.dock) app.dock.hide()
  createTray()
  createWindow()
  discoverMounts()

  app.on('before-quit', async (e) => {
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

  ipcMain.handle('drive:share-folder', async (_, { folderPath }) => {
    return new Promise((resolve) => {
      let done = false
      const child = spawnD2rive(['share', folderPath], {
        onLine(line) {
          if (done) {
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
              cleanup: makeCleanup(child)
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

  ipcMain.handle('drive:watch', async (_, { keyHex, localFolder }) => {
    return new Promise((resolve) => {
      let done = false
      const child = spawnD2rive(['watch', keyHex, localFolder], {
        onLine(line) {
          if (done) {
            if (line.includes('Lost connection')) mounts.setStatus(localFolder, 'disconnected')
            else if (line.includes('Reconnected')) mounts.setStatus(localFolder, 'connected')
            return
          }
          if (line.includes('Running...')) {
            done = true
            mounts.addMount({
              mountpoint: localFolder, key: keyHex, type: 'watch', status: 'connected',
              cleanup: makeCleanup(child)
            })
            resolve({ ok: true })
          }
          if (line.toLowerCase().includes('error')) { done = true; resolve({ error: line }) }
        },
        onExit(code) {
          if (!done) { done = true; resolve({ error: `Process exited (code ${code})` }) }
          else mounts.setStatus(localFolder, 'disconnected')
        }
      })
      setTimeout(() => {
        if (!done) {
          done = true
          mounts.addMount({
            mountpoint: localFolder, key: keyHex, type: 'watch', status: 'connecting',
            cleanup: makeCleanup(child)
          })
          resolve({ ok: true })
        }
      }, 20000)
    })
  })

  ipcMain.handle('drive:stop', async (_, { mountpoint }) => {
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

  ipcMain.handle('app:get-auto-start', () => app.getLoginItemSettings().openAtLogin)

  ipcMain.handle('app:set-auto-start', (_, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return { ok: true }
  })

  ipcMain.handle('app:quit', async () => { await mounts.cleanupAll(); app.exit(0) })
}
