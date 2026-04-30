/* global api */
'use strict'

let state = {
  activeMounts: [],
  savedDrives: [],
  pendingShareKey: null,
  mountSelectedPath: null
}

async function refresh() {
  state.activeMounts = await api.listMounts()
  state.savedDrives  = await api.listSaved()
  render()
}

function render() {
  renderMounts()
  renderSaved()
}

function renderMounts() {
  const el = document.getElementById('mounts-list')
  if (!state.activeMounts.length) {
    el.innerHTML = '<div class="empty-hint">No active mounts</div>'
    return
  }
  el.innerHTML = state.activeMounts.map(m => {
    const dotClass = `dot-${m.status}`
    const label = m.mountpoint.replace(/^\/Users\/[^/]+/, '~')
    const badge = m.type === 'share' ? 'sharing' : 'mount'
    const mp = m.mountpoint.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `
      <div class="mount-row">
        <div class="mount-dot ${dotClass}"></div>
        <span class="mount-path" title="${m.mountpoint}">${label}</span>
        <span class="mount-type-badge">${badge}</span>
        <button class="btn-small" onclick="api.openInFinder('${mp}')">Open</button>
        <button class="btn-danger" onclick="onUnmount('${mp}')">Unmount</button>
      </div>`
  }).join('')
}

function renderSaved() {
  const el = document.getElementById('saved-list')
  if (!state.savedDrives.length) {
    el.innerHTML = '<div class="empty-hint">No saved drives</div>'
    return
  }
  el.innerHTML = state.savedDrives.map(d => `
    <div class="saved-row">
      <span class="saved-name" title="${d.key}">${d.name}</span>
      <button class="btn-small" onclick="onMountSaved('${d.key}')">Mount</button>
      <button class="btn-danger" onclick="onForget('${d.name}')">Remove</button>
    </div>`).join('')
}

// ── Share ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-share').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  const btn = document.getElementById('btn-share')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Sharing…'
  const r = await api.shareFolder(result.path)
  btn.disabled = false
  btn.textContent = 'Select Folder to Share…'
  if (r.error) { alert('Share failed: ' + r.error); return }
  state.pendingShareKey = r.key
  document.getElementById('share-key-text').textContent = r.key
  document.getElementById('save-name-input').value = ''
  document.getElementById('share-card').classList.remove('hidden')
  await refresh()
})

document.getElementById('btn-copy-key').addEventListener('click', () => {
  navigator.clipboard.writeText(state.pendingShareKey || '').then(() => {
    const btn = document.getElementById('btn-copy-key')
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
})

document.getElementById('btn-save-shared-key').addEventListener('click', async () => {
  const name = document.getElementById('save-name-input').value.trim()
  if (!name) { document.getElementById('save-name-input').focus(); return }
  const r = await api.saveDrive(name, state.pendingShareKey)
  if (r.error) { alert('Save failed: ' + r.error); return }
  document.getElementById('save-name-input').value = ''
  const btn = document.getElementById('btn-save-shared-key')
  btn.textContent = 'Saved!'
  setTimeout(() => { btn.textContent = 'Save' }, 1500)
  await refresh()
})

// ── Mount ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  state.mountSelectedPath = result.path
  document.getElementById('mount-path-label').textContent = result.path.replace(/^\/Users\/[^/]+/, '~')
  updateConnectBtn()
})

document.getElementById('key-input').addEventListener('input', updateConnectBtn)

function updateConnectBtn() {
  const key = document.getElementById('key-input').value.trim()
  document.getElementById('btn-connect').disabled = !/^[0-9a-f]{64}$/i.test(key) || !state.mountSelectedPath
}

document.getElementById('btn-connect').addEventListener('click', async () => {
  const key = document.getElementById('key-input').value.trim()
  const mountpoint = state.mountSelectedPath
  if (!key || !mountpoint) return

  const btn = document.getElementById('btn-connect')
  const msg = document.getElementById('mount-status-msg')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Connecting…'
  msg.textContent = ''

  const r = await api.mountDrive(key, mountpoint)
  btn.innerHTML = 'Connect'

  if (r.error) {
    msg.textContent = friendlyError(r.error)
    btn.disabled = false
    return
  }

  document.getElementById('key-input').value = ''
  document.getElementById('mount-path-label').textContent = 'No folder selected'
  state.mountSelectedPath = null
  msg.textContent = ''
  await refresh()
})

function friendlyError(err) {
  if (err.includes('ENOENT')) return 'Folder not found — does the mountpoint exist?'
  if (err.includes('EACCES') || err.includes('EPERM')) return 'Permission denied'
  if (err.includes('ENOTCONN') || err.includes('not configured')) return 'Mount point is busy — try a different folder'
  if (err.includes('code 1')) return 'Failed to start — check the key and mountpoint'
  return err
}

// ── Active mounts ─────────────────────────────────────────────────────────────

function onUnmount(mountpoint) {
  api.unmount(mountpoint).then(() => refresh())
}

// ── Saved drives ──────────────────────────────────────────────────────────────

async function onMountSaved(key) {
  const result = await api.pickFolder()
  if (result.cancelled) return
  const r = await api.mountDrive(key, result.path)
  if (r.error) { alert('Mount failed: ' + friendlyError(r.error)); return }
  await refresh()
}

async function onForget(name) {
  if (!confirm(`Remove saved drive "${name}"?`)) return
  await api.forgetDrive(name)
  await refresh()
}

// ── Push events ───────────────────────────────────────────────────────────────

api.onMountStatus(({ mountpoint, status }) => {
  if (status === 'removed') { refresh(); return }
  const m = state.activeMounts.find(m => m.mountpoint === mountpoint)
  if (m) { m.status = status; renderMounts() }
  else refresh()
})

api.onLog(() => {})

// ── Auto-start ────────────────────────────────────────────────────────────────

const autoStartCb = document.getElementById('auto-start-cb')

api.getAutoStart().then(enabled => { autoStartCb.checked = !!enabled })

autoStartCb.addEventListener('change', () => api.setAutoStart(autoStartCb.checked))

// ── Quit ──────────────────────────────────────────────────────────────────────

document.getElementById('btn-quit').addEventListener('click', () => api.quit())

// ── Init ──────────────────────────────────────────────────────────────────────

refresh()
