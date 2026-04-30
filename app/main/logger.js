'use strict'
const mounts = require('./mounts')
let _win = null

function setWindow(win) { _win = win }

function forward(text, level) {
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send('log:line', { text: text.replace(/\r?\n$/, ''), level })
  }
  parseStatus(text)
}

function parseStatus(text) {
  const mountedMatch = text.match(/Mounted at (.+)/)
  if (mountedMatch) { mounts.setStatus(mountedMatch[1].trim(), 'connected'); return }
  if (text.includes('Lost connection to all peers')) {
    mounts.getAllMounts().forEach(m => mounts.setStatus(m.mountpoint, 'disconnected'))
  }
  if (text.includes('Reconnected to peer')) {
    mounts.getAllMounts().forEach(m => mounts.setStatus(m.mountpoint, 'connected'))
  }
  if (text.includes('No peers found within')) {
    mounts.getAllMounts().forEach(m => mounts.setStatus(m.mountpoint, 'disconnected'))
  }
}

function install() {
  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origErr = console.error.bind(console)
  const origWrite = process.stdout.write.bind(process.stdout)

  console.log   = (...a) => { const t = a.join(' '); origLog(t);  forward(t, 'info')  }
  console.warn  = (...a) => { const t = a.join(' '); origWarn(t); forward(t, 'warn')  }
  console.error = (...a) => { const t = a.join(' '); origErr(t);  forward(t, 'error') }

  process.stdout.write = (chunk, enc, cb) => {
    const t = typeof chunk === 'string' ? chunk : chunk.toString()
    forward(t, 'info')
    return origWrite(chunk, enc, cb)
  }
}

module.exports = { install, setWindow }
