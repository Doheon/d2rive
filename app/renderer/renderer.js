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
    el.innerHTML = '<div class="empty-hint">No active sessions</div>'
    return
  }
  el.innerHTML = state.activeMounts.map(m => {
    const dotClass = `dot-${m.status}`
    const label = m.mountpoint.replace(/^\/Users\/[^/]+/, '~')
    const badge = m.type === 'share' ? 'sharing' : 'watching'
    const mp = m.mountpoint.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const saveBtn = m.type === 'watch' && m.key
      ? `<button class="btn-small" onclick="onSaveMount('${mp}', '${m.key}')">Save</button>`
      : ''
    return `
      <div class="mount-row">
        <div class="mount-dot ${dotClass}"></div>
        <span class="mount-path" title="${m.mountpoint}">${label}</span>
        <span class="mount-type-badge">${badge}</span>
        <button class="btn-small" onclick="api.openInFinder('${mp}')">Open</button>
        ${saveBtn}
        <button class="btn-danger" onclick="onStop('${mp}')">Stop</button>
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
      <button class="btn-small" onclick="onWatchSaved('${d.key}')">Watch</button>
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

// ── Watch ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  state.mountSelectedPath = result.path
  document.getElementById('mount-path-label').textContent = result.path.replace(/^\/Users\/[^/]+/, '~')
  updateWatchBtns()
})

document.getElementById('key-input').addEventListener('input', updateWatchBtns)
document.getElementById('save-name-input').addEventListener('input', updateWatchBtns)

function updateWatchBtns() {
  const key = document.getElementById('key-input').value.trim()
  const name = document.getElementById('save-name-input').value.trim()
  const validKey = /^[0-9a-f]{64}$/i.test(key)
  document.getElementById('btn-connect').disabled = !validKey || !state.mountSelectedPath
  document.getElementById('btn-save-key').disabled = !validKey || !name
}

document.getElementById('btn-connect').addEventListener('click', async () => {
  const key = document.getElementById('key-input').value.trim()
  const name = document.getElementById('save-name-input').value.trim()
  const mountpoint = state.mountSelectedPath
  if (!key || !mountpoint) return

  const btn = document.getElementById('btn-connect')
  const msg = document.getElementById('mount-status-msg')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Watching…'
  msg.textContent = ''

  const writable = document.getElementById('watch-writable-cb').checked
  const r = await api.watchDrive(key, mountpoint, writable)
  btn.innerHTML = 'Watch'

  if (r.error) {
    msg.textContent = friendlyError(r.error)
    btn.disabled = false
    return
  }

  if (name) await api.saveDrive(name, key)

  document.getElementById('key-input').value = ''
  document.getElementById('save-name-input').value = ''
  document.getElementById('mount-path-label').textContent = 'No folder selected'
  state.mountSelectedPath = null
  msg.textContent = ''
  updateWatchBtns()
  await refresh()
})

document.getElementById('btn-save-key').addEventListener('click', async () => {
  const key = document.getElementById('key-input').value.trim()
  const name = document.getElementById('save-name-input').value.trim()
  if (!key || !name) return
  const r = await api.saveDrive(name, key)
  if (r.error) { alert('Save failed: ' + r.error); return }
  document.getElementById('save-name-input').value = ''
  document.getElementById('key-input').value = ''
  state.mountSelectedPath = null
  document.getElementById('mount-path-label').textContent = 'No folder selected'
  updateWatchBtns()
  await refresh()
})

function friendlyError(err) {
  if (err.includes('ENOENT')) return 'Folder not found — please select a valid folder'
  if (err.includes('EACCES') || err.includes('EPERM')) return 'Permission denied'
  if (err.includes('code 1')) return 'Failed to start — check the key and folder'
  return err
}

// ── Active sessions ───────────────────────────────────────────────────────────

function onStop(mountpoint) {
  api.stopWatch(mountpoint).then(() => refresh())
}

async function onSaveMount(mountpoint, key) {
  const name = await showNameDialog(mountpoint.split('/').pop() || '')
  if (!name) return
  const r = await api.saveDrive(name, key)
  if (r.error) { alert('Save failed: ' + r.error); return }
  await refresh()
}

// ── Saved drives ──────────────────────────────────────────────────────────────

async function onWatchSaved(key) {
  const result = await api.pickFolder()
  if (result.cancelled) return
  const r = await api.watchDrive(key, result.path)
  if (r.error) { alert('Watch failed: ' + friendlyError(r.error)); return }
  await refresh()
}

async function onForget(name) {
  if (!confirm(`Remove saved drive "${name}"?`)) return
  await api.forgetDrive(name)
  await refresh()
}

// ── Name dialog ───────────────────────────────────────────────────────────────

function showNameDialog(defaultName) {
  return new Promise(resolve => {
    const overlay = document.getElementById('name-dialog')
    const input = document.getElementById('name-dialog-input')
    input.value = defaultName
    overlay.classList.remove('hidden')
    input.focus()
    input.select()

    const btnOk = document.getElementById('name-dialog-ok')
    const btnCancel = document.getElementById('name-dialog-cancel')

    function finish(val) {
      overlay.classList.add('hidden')
      btnOk.removeEventListener('click', onOk)
      btnCancel.removeEventListener('click', onCancel)
      input.onkeydown = null
      resolve(val)
    }
    function onOk() { finish(input.value.trim() || null) }
    function onCancel() { finish(null) }

    btnOk.addEventListener('click', onOk)
    btnCancel.addEventListener('click', onCancel)
    input.onkeydown = e => {
      if (e.key === 'Enter') onOk()
      if (e.key === 'Escape') onCancel()
    }
  })
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
