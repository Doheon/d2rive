import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { homedir } from 'os'
import { join, dirname, relative } from 'path'
import { mkdir, readdir, readFile, writeFile, stat, utimes } from 'fs/promises'
import { watch as fsWatch } from 'fs'

const MAX_SIZE = 4 * 1024 * 1024

// ── View / apply ──────────────────────────────────────────────────────────────

function openView(store) {
  return new Hyperbee(store.get('files'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
}

async function apply(nodes, view, host) {
  for (const node of nodes) {
    try {
      const op = JSON.parse(node.value.toString())
      if (op.type === 'add-writer') {
        // Self-verification: block must be signed by the key being added
        if (b4a.equals(node.from.key, b4a.from(op.key, 'hex'))) {
          await host.ackWriter(node.from.key)
          await host.addWriter(node.from.key, { indexer: false })
        }
        continue
      }
      if (op.type === 'put') {
        const cur = await view.get(op.path).catch(() => null)
        if (!cur || cur.value.mtime < op.mtime) {
          await view.put(op.path, { mtime: op.mtime, data: op.data, size: op.size })
        }
      } else if (op.type === 'del') {
        const cur = await view.get(op.path).catch(() => null)
        if (!cur || cur.value.mtime <= op.mtime) {
          await view.del(op.path)
        }
      }
    } catch {}
  }
}

// ── File sync helpers ─────────────────────────────────────────────────────────

async function syncViewToLocal(view, localFolder, writingFiles, log) {
  for await (const { key: filePath, value } of view.createReadStream()) {
    const localPath = join(localFolder, filePath)
    try {
      const s = await stat(localPath)
      if (s.mtimeMs >= value.mtime - 50) continue
    } catch {}
    writingFiles.add(filePath)
    try {
      await mkdir(dirname(localPath), { recursive: true })
      await writeFile(localPath, Buffer.from(value.data, 'base64'))
      await utimes(localPath, new Date(value.mtime), new Date(value.mtime))
      log(`  ↓ ${filePath}`)
    } catch {}
    setTimeout(() => writingFiles.delete(filePath), 1000)
  }
}

async function uploadLocalFiles(folderPath, base, view, log) {
  let count = 0
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) { await scan(abs); continue }
      const relPath = '/' + relative(folderPath, abs).replace(/\\/g, '/')
      const s = await stat(abs).catch(() => null); if (!s) continue
      const cur = await view.get(relPath).catch(() => null)
      if (cur && Math.abs(cur.value.mtime - s.mtimeMs) < 50) continue
      const data = await readFile(abs).catch(() => null); if (!data) continue
      if (data.length > MAX_SIZE) { log(`Skipping ${relPath}: exceeds 4 MB`); continue }
      await base.append(JSON.stringify({
        type: 'put', path: relPath,
        mtime: s.mtimeMs, size: s.size,
        data: data.toString('base64')
      }))
      count++
    }
  }
  await scan(folderPath)
  return count
}

function startLocalWatcher(folderPath, base, view, writingFiles, log) {
  const debounce = new Map()
  const watcher = fsWatch(folderPath, { recursive: true }, (_, filename) => {
    if (!filename) return
    const relPath = '/' + filename.replace(/\\/g, '/')
    if (writingFiles.has(relPath)) return
    clearTimeout(debounce.get(relPath))
    debounce.set(relPath, setTimeout(async () => {
      debounce.delete(relPath)
      const absPath = join(folderPath, filename)
      try {
        const s = await stat(absPath)
        const cur = await view.get(relPath).catch(() => null)
        if (cur && Math.abs(cur.value.mtime - s.mtimeMs) < 50 && cur.value.size === s.size) return
        const data = await readFile(absPath)
        if (data.length > MAX_SIZE) { log(`Skipping ${relPath}: exceeds 4 MB`); return }
        await base.append(JSON.stringify({
          type: 'put', path: relPath,
          mtime: s.mtimeMs, size: s.size,
          data: data.toString('base64')
        }))
        log(`  ↑ ${relPath}`)
      } catch {
        const cur = await view.get(relPath).catch(() => null)
        if (!cur) return
        await base.append(JSON.stringify({ type: 'del', path: relPath, mtime: Date.now() }))
        log(`  ✕ ${relPath}`)
      }
    }, 200))
  })
  return watcher
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createSync(folderPath, { onLog, onStatus } = {}) {
  const log = (t) => { console.log(t); if (onLog) onLog(t) }
  const storageDir = join(homedir(), '.d2rive', 'sync-' + Date.now())
  const store = new Corestore(storageDir)
  const base = new Autobase(store, null, { open: openView, apply, optimistic: true })
  await base.ready()

  const key = base.key.toString('hex')
  log(`Sync key: ${key}`)
  log(`Others can join with: d2rive sync-join ${key} <folder>`)

  const writingFiles = new Set()
  const swarm = new Hyperswarm()
  let wasDisconnected = false
  swarm.on('connection', conn => {
    if (wasDisconnected) { log('Reconnected.'); wasDisconnected = false }
    base.replicate(conn)
    conn.on('close', () => {
      if (swarm.connections.size === 0) {
        wasDisconnected = true
        log('Lost connection to all peers. Reconnecting...')
      }
    })
  })
  swarm.join(base.discoveryKey, { server: true, client: true })
  if (onStatus) onStatus('connected')

  // Initial upload (local files → base)
  const count = await uploadLocalFiles(folderPath, base, base.view, log)
  log(`Initial sync: ↑${count} file(s)`)

  // Watch view for remote changes
  base.on('update', () => syncViewToLocal(base.view, folderPath, writingFiles, log).catch(() => {}))

  // Watch local FS
  const watcher = startLocalWatcher(folderPath, base, base.view, writingFiles, log)

  log(`Running... (syncing ${folderPath})`)

  return {
    key,
    cleanup: async () => {
      try { watcher.close() } catch {}
      try { await swarm.destroy() } catch {}
      try { await base.close() } catch {}
      try { await store.close() } catch {}
    }
  }
}

export async function joinSync(keyHex, localFolder, { onLog, onStatus } = {}) {
  const log = (t) => { console.log(t); if (onLog) onLog(t) }
  const bootstrapKey = b4a.from(keyHex, 'hex')
  const storageDir = join(homedir(), '.d2rive', 'sync-' + keyHex.slice(0, 8) + '-' + Date.now())
  const store = new Corestore(storageDir)
  const base = new Autobase(store, bootstrapKey, { open: openView, apply, optimistic: true })
  await base.ready()

  // Announce ourselves as writer candidate
  await base.append(JSON.stringify({
    type: 'add-writer',
    key: base.local.key.toString('hex')
  }), { optimistic: true })

  const writingFiles = new Set()
  const swarm = new Hyperswarm()
  let wasDisconnected = false
  swarm.on('connection', conn => {
    if (wasDisconnected) { log('Reconnected.'); wasDisconnected = false }
    base.replicate(conn)
    conn.on('close', () => {
      if (swarm.connections.size === 0) {
        wasDisconnected = true
        log('Lost connection to all peers. Reconnecting...')
      }
    })
  })
  swarm.join(base.discoveryKey, { server: true, client: true })
  if (onStatus) onStatus('connecting')

  log('Waiting to become writer...')
  if (!base.writable) {
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        base.removeAllListeners('writable')
        resolve()
      }, 20000)
      base.once('writable', () => { clearTimeout(t); resolve() })
    })
  }

  if (onStatus) onStatus('connected')
  await mkdir(localFolder, { recursive: true })

  // Download view → local
  log('Initial sync...')
  await syncViewToLocal(base.view, localFolder, writingFiles, log)

  // Upload local → base
  if (base.writable) {
    const count = await uploadLocalFiles(localFolder, base, base.view, log)
    log(`Initial sync: ↑${count} file(s)`)
  }

  // Watch view for remote changes
  base.on('update', () => {
    syncViewToLocal(base.view, localFolder, writingFiles, log).catch(() => {})
  })

  // Watch local FS
  const watcher = startLocalWatcher(localFolder, base, base.view, writingFiles, log)

  log(`Running... (syncing ${localFolder})`)

  return {
    cleanup: async () => {
      try { watcher.close() } catch {}
      try { await swarm.destroy() } catch {}
      try { await base.close() } catch {}
      try { await store.close() } catch {}
    }
  }
}
