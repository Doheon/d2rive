'use strict'
const { Notification } = require('electron')
const sessions = new Map() // mountpoint → { key, type, status, cleanup }
let _win = null

function setWindow(win) { _win = win }
function getWindow() { return _win }

function sendNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

function notify(mountpoint, status) {
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send('mount:status-changed', { mountpoint, status })
  }
}

function addMount({ mountpoint, key, type, status, writable = false, cleanup }) {
  sessions.set(mountpoint, { mountpoint, key, type, status, writable, cleanup })
  notify(mountpoint, status)
  const label = mountpoint.replace(/^\/Users\/[^/]+/, '~')
  if (status === 'connected') sendNotification('d2rive', `Connected: ${label}`)
}

async function removeMount(mountpoint) {
  const s = sessions.get(mountpoint)
  if (!s) return
  sessions.delete(mountpoint)
  try { await s.cleanup() } catch {}
  notify(mountpoint, 'removed')
}

function setStatus(mountpoint, status) {
  const s = sessions.get(mountpoint)
  if (!s) return
  const prev = s.status
  s.status = status
  notify(mountpoint, status)
  if (prev !== status) {
    const label = mountpoint.replace(/^\/Users\/[^/]+/, '~')
    if (status === 'disconnected') sendNotification('d2rive', `Disconnected: ${label}`)
    if (status === 'connected' && prev === 'disconnected') sendNotification('d2rive', `Reconnected: ${label}`)
  }
}

function getAllMounts() {
  return [...sessions.values()].map(({ cleanup, ...rest }) => rest)
}

async function cleanupAll() {
  for (const [mp] of sessions) await removeMount(mp)
}

module.exports = { setWindow, getWindow, addMount, removeMount, setStatus, getAllMounts, cleanupAll }
