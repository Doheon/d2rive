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
    return `
      <div class="mount-row">
        <div class="mount-dot ${dotClass}"></div>
        <span class="mount-path" title="${m.mountpoint}">${label}</span>
        <span class="mount-type-badge">${badge}</span>
        <button class="btn-danger" onclick="onUnmount('${m.mountpoint.replace(/'/g, "\\'")}')">Unmount</button>
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
      <span class="saved-name">${d.name}</span>
      <button class="btn-small" onclick="onMountSaved('${d.key}')">Mount</button>
      <button class="btn-danger" onclick="onForget('${d.name}')">Remove</button>
    </div>`).join('')
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function onShareFolder() {
  const result = await api.pickFolder()
  if (result.cancelled) return
  const r = await api.shareFolder(result.path)
  if (r.error) { alert('Error: ' + r.error); return }
  state.pendingShareKey = r.key
  document.getElementById('share-key-text').textContent = r.key
  document.getElementById('share-card').classList.remove('hidden')
  await refresh()
}

document.getElementById('btn-copy-key').addEventListener('click', () => {
  navigator.clipboard.writeText(state.pendingShareKey || '').then(() => {
    const btn = document.getElementById('btn-copy-key')
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
})

function onUnmount(mountpoint) {
  api.unmount(mountpoint).then(() => refresh())
}

// ── Mount panel ───────────────────────────────────────────────────────────────

document.getElementById('btn-mount').addEventListener('click', () => {
  document.getElementById('mount-panel').classList.remove('hidden')
  document.getElementById('mount-status-msg').textContent = ''
  document.getElementById('key-input').focus()
})

document.getElementById('btn-cancel-mount').addEventListener('click', () => {
  document.getElementById('mount-panel').classList.add('hidden')
  document.getElementById('key-input').value = ''
  state.mountSelectedPath = null
  document.getElementById('mount-path-label').textContent = 'No folder selected'
  document.getElementById('btn-connect').disabled = true
})

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  state.mountSelectedPath = result.path
  const label = result.path.replace(/^\/Users\/[^/]+/, '~')
  document.getElementById('mount-path-label').textContent = label
  updateConnectBtn()
})

document.getElementById('key-input').addEventListener('input', updateConnectBtn)

function updateConnectBtn() {
  const key = document.getElementById('key-input').value.trim()
  const valid = /^[0-9a-f]{64}$/i.test(key) && !!state.mountSelectedPath
  document.getElementById('btn-connect').disabled = !valid
}

document.getElementById('btn-connect').addEventListener('click', async () => {
  const key = document.getElementById('key-input').value.trim()
  const mountpoint = state.mountSelectedPath
  if (!key || !mountpoint) return

  document.getElementById('btn-connect').disabled = true
  document.getElementById('mount-status-msg').textContent = 'Connecting…'

  const r = await api.mountDrive(key, mountpoint)
  if (r.error) {
    document.getElementById('mount-status-msg').textContent = 'Error: ' + r.error
    document.getElementById('btn-connect').disabled = false
    return
  }
  document.getElementById('btn-cancel-mount').click()
  await refresh()
})

// ── Saved drives ──────────────────────────────────────────────────────────────

async function onMountSaved(key) {
  const result = await api.pickFolder()
  if (result.cancelled) return
  const r = await api.mountDrive(key, result.path)
  if (r.error) { alert('Error: ' + r.error); return }
  await refresh()
}

async function onForget(name) {
  if (!confirm(`Remove saved drive "${name}"?`)) return
  await api.forgetDrive(name)
  await refresh()
}

// ── Push event handlers ───────────────────────────────────────────────────────

api.onMountStatus(({ mountpoint, status }) => {
  if (status === 'removed') { refresh(); return }
  const m = state.activeMounts.find(m => m.mountpoint === mountpoint)
  if (m) { m.status = status; renderMounts() }
  else refresh()
})

api.onLog(({ text }) => {
  // Optionally could show a log panel; for now just consume
})

// ── Quit ──────────────────────────────────────────────────────────────────────

document.getElementById('btn-quit').addEventListener('click', () => api.quit())
document.getElementById('btn-share').addEventListener('click', onShareFolder)

// ── Init ──────────────────────────────────────────────────────────────────────

refresh()
