import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, dirname, relative } from 'path'
import { mkdir, readdir, readFile, writeFile, rename, stat, utimes, rm } from 'fs/promises'
import { watch as fsWatch } from 'fs'
import picomatch from 'picomatch'

const CHUNK_SIZE = 512 * 1024

// ── Ignore helpers ────────────────────────────────────────────────────────────

const ALWAYS_IGNORE = new Set(['.git', '.d2riveignore'])

async function loadIgnorePatterns(folderPath) {
  try {
    const raw = await readFile(join(folderPath, '.d2riveignore'), 'utf-8')
    return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

function makeIsIgnored(patterns = []) {
  const names = new Set([...ALWAYS_IGNORE, ...patterns.filter(p => !/[*?/]/.test(p))])
  const globs = patterns.filter(p => /[*?/]/.test(p))
  const matchGlob = globs.length ? picomatch(globs, { dot: true }) : () => false
  return (relPath) => {
    const parts = relPath.replace(/^\//, '').split('/')
    if (parts.some(p => names.has(p))) return true
    return matchGlob(relPath.replace(/^\//, ''))
  }
}

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
  for (let i = 0; i < data.length; i += CHUNK_SIZE) chunks.push(data.slice(i, i + CHUNK_SIZE))
  if (chunks.length === 0) chunks.push(Buffer.alloc(0))
  // Append all chunks in a single atomic call so startSeq is correct even under
  // concurrent uploads — Hypercore serializes internally, and length is read
  // after the append so it reflects the actual positions written.
  await dataCore.append(chunks)
  const startSeq = dataCore.length - chunks.length
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

async function syncViewToLocal(view, store, localFolder, writingFiles, log, isIgnored) {
  for await (const { key: filePath, value } of view.createReadStream()) {
    if (!value.coreKey) continue
    if (isIgnored && isIgnored(filePath)) continue
    const localPath = join(localFolder, filePath)
    try {
      const s = await stat(localPath)
      if (s.mtimeMs >= value.mtime - 50) continue
    } catch {}
    writingFiles.add(filePath)
    try {
      const data = await readChunked(store, value.coreKey, value.startSeq, value.numChunks)
      await mkdir(dirname(localPath), { recursive: true })
      // Atomic write: write to tmp then rename to avoid partial reads
      const tmpPath = localPath + '.d2rive-tmp'
      await writeFile(tmpPath, data)
      await utimes(tmpPath, new Date(value.mtime), new Date(value.mtime))
      await rename(tmpPath, localPath)
      log(`  ↓ ${filePath}`)
    } catch (err) {
      // Clean up tmp file on failure
      try { await rm(localPath + '.d2rive-tmp', { force: true }) } catch {}
    }
    setTimeout(() => writingFiles.delete(filePath), 1000)
  }
}

async function uploadLocalFiles(folderPath, base, dataCore, view, log, isIgnored) {
  let count = 0
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = join(dir, e.name)
      const relPath = '/' + relative(folderPath, abs).replace(/\\/g, '/')
      if (isIgnored && isIgnored(relPath)) continue
      if (e.isDirectory()) { await scan(abs); continue }
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

function startLocalWatcher(folderPath, base, dataCore, view, writingFiles, log, isIgnored) {
  const debounce = new Map()
  // Serialize all uploads to prevent concurrent appendChunked on the same dataCore
  let uploadTail = Promise.resolve()
  const enqueue = (fn) => { uploadTail = uploadTail.then(fn).catch(() => {}) }

  const watcher = fsWatch(folderPath, { recursive: true }, (_, filename) => {
    if (!filename) return
    const relPath = '/' + filename.replace(/\\/g, '/')
    if (writingFiles.has(relPath)) return
    if (isIgnored && isIgnored(relPath)) return
    clearTimeout(debounce.get(relPath))
    debounce.set(relPath, setTimeout(() => {
      debounce.delete(relPath)
      enqueue(async () => {
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
      })
    }, 200))
  })
  return watcher
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createSync(folderPath, { writable = true, onLog, onStatus } = {}) {
  const log = (t) => { console.log(t); if (onLog) onLog(t) }
  const folderHash = createHash('sha256').update(folderPath).digest('hex').slice(0, 16)
  const storageDir = join(homedir(), '.d2rive', 'share-' + folderHash)
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

  const isIgnored = makeIsIgnored(await loadIgnorePatterns(folderPath))
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

  const count = await uploadLocalFiles(folderPath, base, dataCore, base.view, log, isIgnored)
  log(`Initial sync: ↑${count} file(s)`)

  // Serialized sync: only one syncViewToLocal runs at a time
  let syncing = false; let needsSync = false
  const runSync = async () => {
    if (syncing) { needsSync = true; return }
    syncing = true
    do { needsSync = false; await syncViewToLocal(base.view, store, folderPath, writingFiles, log, isIgnored).catch(() => {}) } while (needsSync)
    syncing = false
  }
  base.on('update', () => runSync())
  const watcher = startLocalWatcher(folderPath, base, dataCore, base.view, writingFiles, log, isIgnored)

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

export async function joinSync(keyHex, localFolder, { onLog, onStatus, onDisconnect, clean = false } = {}) {
  const log = (t) => { console.log(t); if (onLog) onLog(t) }
  const bootstrapKey = b4a.from(keyHex, 'hex')
  const storageDir = join(homedir(), '.d2rive', 'watch-' + keyHex.slice(0, 16))
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
        disconnectTimer = setTimeout(() => {
          if (typeof onDisconnect === 'function') onDisconnect()
        }, 30000)
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

  if (clean) {
    await rm(localFolder, { recursive: true, force: true })
  }
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

  const isIgnored = makeIsIgnored(await loadIgnorePatterns(localFolder))

  log('Initial sync...')
  await syncViewToLocal(base.view, store, localFolder, writingFiles, log, isIgnored)

  let watcher = null
  if (base.writable) {
    const count = await uploadLocalFiles(localFolder, base, dataCore, base.view, log, isIgnored)
    log(`Initial sync: ↑${count} file(s)`)
    watcher = startLocalWatcher(localFolder, base, dataCore, base.view, writingFiles, log, isIgnored)
  }

  let syncing = false; let needsSync = false
  const runSync = async () => {
    if (syncing) { needsSync = true; return }
    syncing = true
    do { needsSync = false; await syncViewToLocal(base.view, store, localFolder, writingFiles, log, isIgnored).catch(() => {}) } while (needsSync)
    syncing = false
  }
  base.on('update', () => runSync())

  log(`Running... (${base.writable ? 'writable' : 'read-only'})`)

  return {
    writable: base.writable,
    cleanup: async () => {
      if (disconnectTimer) clearTimeout(disconnectTimer)
      if (watcher) try { watcher.close() } catch {}
      try { await swarm.destroy() } catch {}
      try { await base.close() } catch {}
      try { await store.close() } catch {}
    }
  }
}
