import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { homedir } from 'os'
import { join, dirname, relative } from 'path'
import { mkdir, readdir, readFile, writeFile, stat, utimes } from 'fs/promises'
import { watch as fsWatch } from 'fs'

const CHUNK_SIZE = 512 * 1024 // 512 KB per Hypercore block

// ── View / apply ──────────────────────────────────────────────────────────────

function openView(store) {
  return new Hyperbee(store.get('meta'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
}

async function apply(nodes, view, host) {
  for (const node of nodes) {
    try {
      const op = JSON.parse(node.value.toString())
      if (op.type === 'config') {
        await view.put('/.d2rive-config', { writable: op.writable })
        continue
      }
      if (op.type === 'add-writer') {
        // Check config — if writable=false, ignore add-writer requests
        const cfg = await view.get('/.d2rive-config').catch(() => null)
        if (cfg && cfg.value.writable === false) continue
        if (b4a.equals(node.from.key, b4a.from(op.key, 'hex'))) {
          await host.ackWriter(node.from.key)
          await host.addWriter(node.from.key, { indexer: false })
        }
        continue
      }
      if (op.type === 'put') {
        const cur = await view.get(op.path).catch(() => null)
        if (!cur || cur.value.mtime < op.mtime) {
          await view.put(op.path, {
            mtime: op.mtime, size: op.size,
            coreKey: op.coreKey, startSeq: op.startSeq, numChunks: op.numChunks
          })
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

// ── Chunk helpers ─────────────────────────────────────────────────────────────

async function appendChunked(dataCore, data) {
  const chunks = []
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    chunks.push(data.slice(i, i + CHUNK_SIZE))
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0))
  const startSeq = dataCore.length
  for (const chunk of chunks) await dataCore.append(chunk)
  return { startSeq, numChunks: chunks.length }
}

async function readChunked(store, coreKey, startSeq, numChunks) {
  const core = store.get({ key: b4a.from(coreKey, 'hex') })
  await core.ready()
  const parts = []
  for (let i = 0; i < numChunks; i++) {
    const block = await core.get(startSeq + i, { timeout: 30000 })
    parts.push(block)
  }
  return Buffer.concat(parts)
}

// ── File sync helpers ─────────────────────────────────────────────────────────

async function syncViewToLocal(view, store, localFolder, writingFiles, log) {
  for await (const { key: filePath, value } of view.createReadStream()) {
    // Skip internal config entries (no coreKey means not a file)
    if (!value.coreKey) continue
    const localPath = join(localFolder, filePath)
    try {
      const s = await stat(localPath)
      if (s.mtimeMs >= value.mtime - 50) continue
    } catch {}
    writingFiles.add(filePath)
    try {
      const data = await readChunked(store, value.coreKey, value.startSeq, value.numChunks)
      await mkdir(dirname(localPath), { recursive: true })
      await writeFile(localPath, data)
      await utimes(localPath, new Date(value.mtime), new Date(value.mtime))
      log(`  ↓ ${filePath}`)
    } catch {}
    setTimeout(() => writingFiles.delete(filePath), 1000)
  }
}

async function uploadLocalFiles(folderPath, base, dataCore, view, log) {
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
      const { startSeq, numChunks } = await appendChunked(dataCore, data)
      await base.append(JSON.stringify({
        type: 'put', path: relPath,
        mtime: s.mtimeMs, size: s.size,
        coreKey: dataCore.key.toString('hex'), startSeq, numChunks
      }))
      count++
    }
  }
  await scan(folderPath)
  return count
}

function startLocalWatcher(folderPath, base, dataCore, view, writingFiles, log) {
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
        const { startSeq, numChunks } = await appendChunked(dataCore, data)
        await base.append(JSON.stringify({
          type: 'put', path: relPath,
          mtime: s.mtimeMs, size: s.size,
          coreKey: dataCore.key.toString('hex'), startSeq, numChunks
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

export async function createSync(folderPath, { writable = true, onLog, onStatus } = {}) {
  const log = (t) => { console.log(t); if (onLog) onLog(t) }
  const storageDir = join(homedir(), '.d2rive', 'sync-' + Date.now())
  const store = new Corestore(storageDir)
  const dataCore = store.get({ name: 'data' })
  await dataCore.ready()

  const base = new Autobase(store, null, { open: openView, apply, optimistic: true })
  await base.ready()

  // Append config as first block so joiners know the writable policy
  await base.append(JSON.stringify({ type: 'config', writable }))

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

  const count = await uploadLocalFiles(folderPath, base, dataCore, base.view, log)
  log(`Initial sync: ↑${count} file(s)`)

  base.on('update', () => syncViewToLocal(base.view, store, folderPath, writingFiles, log).catch(() => {}))
  const watcher = startLocalWatcher(folderPath, base, dataCore, base.view, writingFiles, log)

  log(`Running... (${writable ? 'writable' : 'read-only'})`)

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
  const dataCore = store.get({ name: 'data' })
  await dataCore.ready()

  const base = new Autobase(store, bootstrapKey, { open: openView, apply, optimistic: true })
  await base.ready()

  const writingFiles = new Set()
  const swarm = new Hyperswarm()
  let wasDisconnected = false
  let disconnectTimer = null

  swarm.on('connection', conn => {
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null }
    if (wasDisconnected) { log('Reconnected.'); wasDisconnected = false }
    base.replicate(conn)
    conn.on('close', () => {
      if (swarm.connections.size === 0) {
        wasDisconnected = true
        log('Lost connection to all peers. Reconnecting...')
        disconnectTimer = setTimeout(() => process.exit(0), 30000)
      }
    })
  })

  swarm.join(base.discoveryKey, { server: true, client: true })
  if (onStatus) onStatus('connecting')

  // Wait for initial peer connection (max 10s), then do initial sync
  await new Promise(resolve => {
    const t = setTimeout(resolve, 10000)
    swarm.once('connection', () => { clearTimeout(t); resolve() })
  })

  try { await base.update({ timeout: 3000 }) } catch {}

  // Read config to determine writable policy
  const cfg = await base.view.get('/.d2rive-config').catch(() => null)
  const isWritable = cfg ? (cfg.value.writable !== false) : true

  await mkdir(localFolder, { recursive: true })

  if (isWritable) {
    // Request writer access and wait for approval (max 20s)
    await base.append(JSON.stringify({
      type: 'add-writer',
      key: base.local.key.toString('hex')
    }), { optimistic: true })

    log('Waiting to become writer...')
    if (!base.writable) {
      await new Promise((resolve) => {
        const t = setTimeout(() => { base.removeAllListeners('writable'); resolve() }, 20000)
        base.once('writable', () => { clearTimeout(t); resolve() })
      })
    }
  }

  if (onStatus) onStatus('connected')

  log('Initial sync...')
  await syncViewToLocal(base.view, store, localFolder, writingFiles, log)

  let watcher = null
  if (base.writable) {
    const count = await uploadLocalFiles(localFolder, base, dataCore, base.view, log)
    log(`Initial sync: ↑${count} file(s)`)
    watcher = startLocalWatcher(localFolder, base, dataCore, base.view, writingFiles, log)
  }

  base.on('update', () => {
    syncViewToLocal(base.view, store, localFolder, writingFiles, log).catch(() => {})
  })

  log(`Running... (${base.writable ? 'writable' : 'read-only'})`)

  return {
    cleanup: async () => {
      if (disconnectTimer) clearTimeout(disconnectTimer)
      if (watcher) try { watcher.close() } catch {}
      try { await swarm.destroy() } catch {}
      try { await base.close() } catch {}
      try { await store.close() } catch {}
    }
  }
}
