/* global api */
'use strict'

const VALID_KEY = /^(?:sync:)?[0-9a-f]{64}$/i

let state = {
  activeMounts: [],
  savedDrives: [],
  pendingShareKey: null,
  mountSelectedPath: null,
  mountPathIsDefault: true,
  mountNeedsClean: false
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
  el.innerHTML = ''
  if (!state.activeMounts.length) {
    const hint = document.createElement('div')
    hint.className = 'empty-hint'
    hint.textContent = 'No active sessions'
    el.appendChild(hint)
    return
  }
  for (const m of state.activeMounts) {
    const row = document.createElement('div')
    row.className = 'mount-row'

    const dot = document.createElement('div')
    dot.className = `mount-dot dot-${m.status}`

    const pathSpan = document.createElement('span')
    pathSpan.className = 'mount-path'
    pathSpan.title = m.mountpoint
    pathSpan.textContent = m.mountpoint.replace(/^\/Users\/[^/]+/, '~')

    const badge = m.type === 'share'
      ? (m.writable ? 'sharing · writable' : 'sharing · read-only')
      : m.type === 'sync' ? 'syncing' : 'watching'
    const badgeSpan = document.createElement('span')
    badgeSpan.className = 'mount-type-badge'
    badgeSpan.textContent = badge

    const openBtn = document.createElement('button')
    openBtn.className = 'btn-small'
    openBtn.textContent = 'Open'
    openBtn.addEventListener('click', () => api.openInFinder(m.mountpoint))

    const stopBtn = document.createElement('button')
    stopBtn.className = 'btn-danger'
    stopBtn.textContent = 'Stop'
    stopBtn.addEventListener('click', () => onStop(m.mountpoint))

    row.append(dot, pathSpan, badgeSpan, openBtn, stopBtn)
    el.appendChild(row)
  }
}

function renderSaved() {
  const el = document.getElementById('saved-list')
  el.innerHTML = ''
  if (!state.savedDrives.length) {
    const hint = document.createElement('div')
    hint.className = 'empty-hint'
    hint.textContent = 'No saved drives'
    el.appendChild(hint)
    return
  }
  for (const d of state.savedDrives) {
    const row = document.createElement('div')
    row.className = 'saved-row'

    const info = document.createElement('div')
    info.className = 'saved-info'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'saved-name'
    nameSpan.title = d.key
    nameSpan.textContent = d.name
    info.appendChild(nameSpan)

    if (d.folder) {
      const folderSpan = document.createElement('span')
      folderSpan.className = 'saved-folder'
      folderSpan.textContent = d.folder.replace(/^\/Users\/[^/]+/, '~')
      info.appendChild(folderSpan)
    }

    const watchBtn = document.createElement('button')
    watchBtn.className = 'btn-small'
    watchBtn.textContent = 'Watch'
    watchBtn.addEventListener('click', () => onWatchSaved(watchBtn, d.key, d.folder || ''))

    const removeBtn = document.createElement('button')
    removeBtn.className = 'btn-danger'
    removeBtn.textContent = 'Remove'
    removeBtn.addEventListener('click', () => onForget(d.name))

    row.append(info, watchBtn, removeBtn)
    el.appendChild(row)
  }
}

// ── Share ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-share').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  const btn = document.getElementById('btn-share')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Sharing…'
  const writable = document.getElementById('share-writable-cb').checked
  const r = await api.shareFolder(result.path, writable)
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

document.getElementById('key-input').addEventListener('input', async () => {
  const key = document.getElementById('key-input').value.trim()
  // Reset warning when key changes
  state.mountNeedsClean = false
  document.getElementById('mount-warning').classList.add('hidden')
  document.getElementById('btn-connect').textContent = 'Watch'

  if (VALID_KEY.test(key) && state.mountPathIsDefault) {
    const p = await api.getDefaultFolder(key)
    state.mountSelectedPath = p
    document.getElementById('mount-path-label').textContent = p.replace(/^\/Users\/[^/]+/, '~')
  } else if (!VALID_KEY.test(key) && state.mountPathIsDefault) {
    state.mountSelectedPath = null
    document.getElementById('mount-path-label').textContent = 'Enter key to set default folder'
  }
  updateWatchBtns()
})

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  state.mountSelectedPath = result.path
  state.mountPathIsDefault = false
  // Reset warning when folder changes
  state.mountNeedsClean = false
  document.getElementById('mount-warning').classList.add('hidden')
  document.getElementById('btn-connect').textContent = 'Watch'
  document.getElementById('mount-path-label').textContent = result.path.replace(/^\/Users\/[^/]+/, '~')
  updateWatchBtns()
})

function updateWatchBtns() {
  const key = document.getElementById('key-input').value.trim()
  document.getElementById('btn-connect').disabled = !VALID_KEY.test(key) || !state.mountSelectedPath
}

document.getElementById('btn-connect').addEventListener('click', async () => {
  const key = document.getElementById('key-input').value.trim()
  const mountpoint = state.mountSelectedPath
  if (!key || !mountpoint) return

  const btn = document.getElementById('btn-connect')
  const msg = document.getElementById('mount-status-msg')

  // First click: check if folder has existing files
  if (!state.mountNeedsClean) {
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span>Checking…'
    const info = await api.folderInfo(mountpoint)
    if (info.hasFiles) {
      state.mountNeedsClean = true
      btn.disabled = false
      btn.textContent = 'Watch (overwrite)'
      const w = document.getElementById('mount-warning')
      w.textContent = `⚠ ${info.count} existing file(s) will be deleted. Click again to confirm.`
      w.classList.remove('hidden')
      return
    }
    btn.disabled = false
    btn.textContent = 'Watch'
  }

  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span>Watching…'
  msg.textContent = ''

  const r = await api.watchDrive(key, mountpoint, state.mountNeedsClean)
  btn.innerHTML = 'Watch'

  if (r.error) {
    msg.textContent = friendlyError(r.error)
    btn.disabled = false
    state.mountNeedsClean = false
    document.getElementById('mount-warning').classList.add('hidden')
    return
  }

  // Reset inputs
  document.getElementById('key-input').value = ''
  document.getElementById('mount-path-label').textContent = 'Enter key to set default folder'
  state.mountSelectedPath = null
  state.mountPathIsDefault = true
  state.mountNeedsClean = false
  document.getElementById('mount-warning').classList.add('hidden')
  btn.textContent = 'Watch'
  msg.textContent = ''
  updateWatchBtns()
  await refresh()
})


function friendlyError(err) {
  if (err.includes('ENOENT')) return 'Folder not found — please select a valid folder'
  if (err.includes('EACCES') || err.includes('EPERM')) return 'Permission denied'
  if (err.includes('LOCK') || err.includes('already in use')) return 'Drive already open — stop the existing session first'
  if (err.includes('code 1')) return 'Failed to start — check the key and folder'
  return err
}

// ── Active sessions ───────────────────────────────────────────────────────────

function onStop(mountpoint) {
  api.stopWatch(mountpoint).then(() => refresh())
}

// ── Saved drives ──────────────────────────────────────────────────────────────

async function onWatchSaved(btn, key, folder) {
  let mountFolder = folder || null

  if (!mountFolder) {
    const result = await api.pickFolder()
    if (result.cancelled) return
    mountFolder = result.path
  }

  const info = await api.folderInfo(mountFolder)
  let clean = false
  if (info.hasFiles) {
    if (!confirm(`${info.count} existing file(s) in this folder will be deleted. Continue?`)) return
    clean = true
  }

  btn.disabled = true
  btn.innerHTML = '<span class="spinner" style="border-color:rgba(0,0,0,0.2);border-top-color:#333;"></span>'
  const r = await api.watchDrive(key, mountFolder, clean)
  btn.disabled = false
  btn.textContent = 'Watch'
  if (r.error) { alert('Watch failed: ' + friendlyError(r.error)); return }
  await refresh()
}

async function onForget(name) {
  if (!confirm(`Remove saved drive "${name}"?`)) return
  await api.forgetDrive(name)
  await refresh()
}

// ── Add saved drive ───────────────────────────────────────────────────────────

let savedAddFolder = null
let savedAddFolderIsDefault = true

function resetSavedAddCard() {
  savedAddFolder = null
  savedAddFolderIsDefault = true
  document.getElementById('saved-add-name').value = ''
  document.getElementById('saved-add-key').value = ''
  document.getElementById('saved-add-folder-label').textContent = 'No folder (will ask when watching)'
  document.getElementById('saved-add-card').classList.add('hidden')
}

document.getElementById('btn-saved-add').addEventListener('click', () => {
  document.getElementById('saved-add-card').classList.remove('hidden')
  document.getElementById('saved-add-name').focus()
})

document.getElementById('saved-add-key').addEventListener('input', async () => {
  const key = document.getElementById('saved-add-key').value.trim()
  if (VALID_KEY.test(key) && savedAddFolderIsDefault) {
    const p = await api.getDefaultFolder(key)
    savedAddFolder = p
    document.getElementById('saved-add-folder-label').textContent = p.replace(/^\/Users\/[^/]+/, '~')
  } else if (!VALID_KEY.test(key) && savedAddFolderIsDefault) {
    savedAddFolder = null
    document.getElementById('saved-add-folder-label').textContent = 'No folder (will ask when watching)'
  }
})

document.getElementById('btn-saved-add-folder').addEventListener('click', async () => {
  const result = await api.pickFolder()
  if (result.cancelled) return
  savedAddFolder = result.path
  savedAddFolderIsDefault = false
  document.getElementById('saved-add-folder-label').textContent = result.path.replace(/^\/Users\/[^/]+/, '~')
})

document.getElementById('btn-saved-add-cancel').addEventListener('click', resetSavedAddCard)

document.getElementById('btn-saved-add-save').addEventListener('click', async () => {
  const name = document.getElementById('saved-add-name').value.trim()
  const key  = document.getElementById('saved-add-key').value.trim()
  if (!name || !VALID_KEY.test(key)) return
  const r = await api.saveDrive(name, key, savedAddFolder)
  if (r.error) { alert('Save failed: ' + r.error); return }
  resetSavedAddCard()
  await refresh()
})

// ── Push events ───────────────────────────────────────────────────────────────

api.onMountStatus(({ mountpoint, status }) => {
  if (status === 'removed') { refresh(); return }
  const m = state.activeMounts.find(m => m.mountpoint === mountpoint)
  if (m) { m.status = status; renderMounts() }
  else refresh()
})

// ── Auto-start ────────────────────────────────────────────────────────────────

const autoStartCb = document.getElementById('auto-start-cb')

api.getAutoStart().then(enabled => { autoStartCb.checked = !!enabled })

autoStartCb.addEventListener('change', () => api.setAutoStart(autoStartCb.checked))

// ── Quit ──────────────────────────────────────────────────────────────────────

document.getElementById('btn-quit').addEventListener('click', () => api.quit())

// ── Init ──────────────────────────────────────────────────────────────────────

refresh()
