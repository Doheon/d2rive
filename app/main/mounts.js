'use strict'
const sessions = new Map() // mountpoint → { key, type, status, cleanup }
let _win = null

function setWindow(win) { _win = win }

function notify(mountpoint, status) {
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send('mount:status-changed', { mountpoint, status })
  }
}

function addMount({ mountpoint, key, type, status, cleanup }) {
  sessions.set(mountpoint, { mountpoint, key, type, status, cleanup })
  notify(mountpoint, status)
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
  if (s) { s.status = status; notify(mountpoint, status) }
}

function getAllMounts() {
  return [...sessions.values()].map(({ cleanup, ...rest }) => rest)
}

async function cleanupAll() {
  for (const [mp] of sessions) await removeMount(mp)
}

function getWindow() { return _win }

module.exports = { setWindow, getWindow, addMount, removeMount, setStatus, getAllMounts, cleanupAll }
