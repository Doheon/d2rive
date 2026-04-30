import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Localdrive from 'localdrive'
import picomatch from 'picomatch'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { mkdir, readdir, readFile, writeFile, stat, rm, chmod } from 'fs/promises'
import { watch as fsWatch } from 'fs'
import b4a from 'b4a'

// ── Drive setup ───────────────────────────────────────────────────────────────

async function setupDrive(key) {
  const keyHex = key ? b4a.toString(key, 'hex') : `new-${Date.now()}`
  const dir = join(homedir(), '.d2rive', keyHex)

  let store, drive
  try {
    store = new Corestore(dir)
    drive = new Hyperdrive(store, key)
    await drive.ready()
  } catch (err) {
    throw new Error(`Failed to open drive store at ${dir}: ${err.message}`)
  }

  if (key) {
    writeFile(join(dir, '.lastaccess'), Date.now().toString()).catch(() => {})
  }

  const swarm = new Hyperswarm()
  let wasDisconnected = false
  swarm.on('connection', conn => {
    if (wasDisconnected) {
      console.log('\nReconnected to peer.')
      wasDisconnected = false
    }
    store.replicate(conn)
    conn.on('close', () => {
      if (swarm.connections.size === 0) {
        wasDisconnected = true
        console.log('\nLost connection to all peers. Reconnecting...')
      }
    })
  })

  return { drive, store, swarm }
}

async function connectToPeers(drive, swarm) {
  swarm.join(drive.discoveryKey)
  process.stdout.write('Connecting to peers...')
  let connected = false
  await Promise.race([
    new Promise(res => swarm.once('connection', () => { connected = true; setTimeout(res, 400) })),
    new Promise(res => setTimeout(res, 10000))
  ])
  if (!connected) console.log('\nWarning: No peers found within 10s — drive may be offline or key may be wrong.')
  try { await drive.update() } catch {}
  if (connected) console.log(' ready')
}

// ── Public commands ───────────────────────────────────────────────────────────

export async function shareFolder(folderPath, { writable = false } = {}) {
  const { drive, store, swarm } = await setupDrive()
  const local = new Localdrive(folderPath)
  const ignore = await loadIgnore(folderPath)

  await drive.put('/.d2rive-config', Buffer.from(JSON.stringify({ writable })))

  swarm.join(drive.discoveryKey, { server: true, client: false })

  const key = b4a.toString(drive.key, 'hex')
  console.log(`Drive key: ${key}`)
  console.log(`Others can watch with: d2rive watch ${key} <localFolder>`)

  const count = await syncToDrive(local, drive, ignore)
  console.log(`Synced: +${count.add} changed:${count.change} -${count.remove}`)
  console.log(`Watching ${folderPath} for changes... (${writable ? 'writable' : 'read-only'})`)

  watchLocal(folderPath, local, drive, ignore)

  return {
    key,
    cleanup: async () => {
      await swarm.destroy()
      await drive.close()
      await store.close()
    }
  }
}

export async function watchDrive(keyHex, localFolder, { clean = false } = {}) {
  const key = b4a.from(keyHex, 'hex')
  const { drive, store, swarm } = await setupDrive(key)
  await connectToPeers(drive, swarm)

  // Exit if the server stays unreachable for 2 minutes (sharer stopped)
  let disconnectTimer = null
  swarm.on('connection', conn => {
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null }
    conn.on('close', () => {
      if (swarm.connections.size === 0)
        disconnectTimer = setTimeout(() => process.exit(0), 30000)
    })
  })

  const configBuf = await drive.get('/.d2rive-config').catch(() => null)
  const config = configBuf ? JSON.parse(configBuf.toString()) : {}
  const writable = config.writable ?? false

  await mkdir(localFolder, { recursive: true })

  console.log(`Initial sync... (${writable ? 'writable' : 'read-only'})`)
  const driveFiles = await downloadAll(drive, localFolder, { writable })
  if (clean) await cleanLocalFolder(localFolder, driveFiles)

  if (writable) {
    console.log('Writable mode: local files are editable.')
  }

  let version = drive.version
  console.log(`Watching for remote changes...`)

  const watcher = drive.watch('/')
  ;(async () => {
    for await (const _ of watcher) {
      try {
        const counts = { add: 0, change: 0, remove: 0 }
        for await (const diff of drive.diff(version, '/')) {
          const filePath = diff.left?.key || diff.right?.key
          if (!filePath || filePath.endsWith('/.keep') || filePath === '/.d2rive-config') continue
          if (!diff.right) {
            const dest = join(localFolder, filePath)
            if (!writable) await chmod(dest, 0o644).catch(() => {})
            await rm(dest, { force: true }).catch(() => {})
            counts.remove++
          } else {
            const data = await drive.get(filePath)
            if (data) {
              const dest = join(localFolder, filePath)
              await mkdir(dirname(dest), { recursive: true })
              await chmod(dest, 0o644).catch(() => {})
              await writeFile(dest, data)
              if (!writable) await chmod(dest, 0o444)
              diff.left ? counts.change++ : counts.add++
            }
          }
        }
        version = drive.version
        const parts = []
        if (counts.add) parts.push(`+${counts.add}`)
        if (counts.change) parts.push(`~${counts.change}`)
        if (counts.remove) parts.push(`-${counts.remove}`)
        if (parts.length) console.log(`\nSynced: ${parts.join(' ')}`)
      } catch (err) { console.error(err.message) }
    }
  })()

  return {
    cleanup: async () => {
      watcher.destroy()
      await swarm.destroy()
      await drive.close()
      await store.close()
    }
  }
}

export async function pullFile(keyHex, remotePath, localPath) {
  const key = b4a.from(keyHex, 'hex')
  const { drive, store, swarm } = await setupDrive(key)

  await connectToPeers(drive, swarm)

  const data = await drive.get(remotePath)
  if (!data) throw new Error(`Not found in drive: ${remotePath}`)

  await mkdir(dirname(localPath), { recursive: true })
  await writeFile(localPath, data)
  console.log(`Downloaded ${remotePath} → ${localPath} (${fmtBytes(data.byteLength)})`)

  await swarm.destroy()
  await drive.close()
  await store.close()
}

export async function driveInfo(keyHex) {
  const key = b4a.from(keyHex, 'hex')
  const { drive, store, swarm } = await setupDrive(key)

  await connectToPeers(drive, swarm)

  const files = []
  for await (const entry of drive.list('/')) {
    if (entry.key.endsWith('/.keep')) continue
    files.push({ path: entry.key, size: entry.value?.blob?.byteLength ?? 0 })
  }

  await swarm.destroy()
  await drive.close()
  await store.close()

  return files
}

export async function syncFromDrive(keyHex, localPath) {
  const key = b4a.from(keyHex, 'hex')
  const { drive, store, swarm } = await setupDrive(key)
  await connectToPeers(drive, swarm)
  await mkdir(localPath, { recursive: true })
  await downloadAll(drive, localPath)
  await swarm.destroy()
  await drive.close()
  await store.close()
}

// ── Cache management ──────────────────────────────────────────────────────────

export async function cacheInfo(keyHex) {
  const base = join(homedir(), '.d2rive')
  const entries = keyHex
    ? [{ name: keyHex, isDirectory: () => true }]
    : await readdir(base, { withFileTypes: true }).catch(() => [])

  const results = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(base, e.name)
    const size = await dirSize(dir)
    const ts = await readFile(join(dir, '.lastaccess'), 'utf8').catch(() => null)
    const lastAccessDays = ts ? Math.floor((Date.now() - Number(ts)) / 86400000) : null
    results.push({ key: e.name, size, dir, lastAccessDays })
  }
  return results
}

export async function cacheClear(keyHex) {
  const target = keyHex
    ? join(homedir(), '.d2rive', keyHex)
    : join(homedir(), '.d2rive')
  await rm(target, { recursive: true, force: true })
}

// ── Share internals ───────────────────────────────────────────────────────────

async function syncToDrive(local, drive, ignore) {
  const count = { add: 0, change: 0, remove: 0 }

  const entries = []
  for await (const entry of local.list('/')) {
    if (!ignore(entry.key)) entries.push(entry)
  }

  const total = entries.length
  let done = 0

  for (const entry of entries) {
    const buf = (await local.get(entry.key)) ?? Buffer.alloc(0)
    const localSize = buf.byteLength
    const driveEntry = await drive.entry(entry.key)
    const driveSize = driveEntry?.value?.blob?.byteLength ?? -1

    if (driveSize !== localSize) {
      await drive.put(entry.key, buf)
      driveSize === -1 ? count.add++ : count.change++
    }

    done++
    process.stdout.write(`\r  [${done}/${total}] ${entry.key.slice(0, 50)}`)
  }

  if (total > 0) process.stdout.write('\r\x1b[K')

  const localKeys = new Set(entries.map(e => e.key))
  for await (const entry of drive.list('/')) {
    if (!localKeys.has(entry.key) && entry.key !== '/.d2rive-config') {
      await drive.del(entry.key)
      count.remove++
    }
  }

  return count
}

async function downloadAll(drive, localPath, { writable = false } = {}) {
  const files = []
  for await (const entry of drive.list('/')) {
    if (entry.key.endsWith('/.keep')) continue
    files.push(entry.key)
  }

  const total = files.length
  let done = 0, bytes = 0
  for (const filePath of files) {
    if (filePath === '/.d2rive-config') { done++; continue }
    const data = await drive.get(filePath)
    if (data) {
      const dest = join(localPath, filePath)
      await mkdir(dirname(dest), { recursive: true })
      await chmod(dest, 0o644).catch(() => {})
      await writeFile(dest, data)
      if (!writable) await chmod(dest, 0o444)
      bytes += data.byteLength
    }
    done++
    process.stdout.write(`\r  [${done}/${total}] ${filePath.slice(0, 50)}`)
  }
  if (total > 0) process.stdout.write('\r\x1b[K')
  const realTotal = files.filter(f => f !== '/.d2rive-config').length
  if (realTotal === 0) console.log('Drive is empty or no files visible yet.')
  else console.log(`Synced ${realTotal} files (${fmtBytes(bytes)}) → ${localPath}`)

  return new Set(files.filter(f => f !== '/.d2rive-config'))
}

async function cleanLocalFolder(baseDir, driveFiles) {
  async function clean(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        await clean(abs)
        const left = await readdir(abs).catch(() => [])
        if (!left.length) await rm(abs, { recursive: true, force: true }).catch(() => {})
      } else {
        const rel = abs.slice(baseDir.length).replace(/\\/g, '/')
        if (!driveFiles.has(rel)) {
          await chmod(abs, 0o644).catch(() => {})
          await rm(abs, { force: true }).catch(() => {})
        }
      }
    }
  }
  await clean(baseDir)
}

function watchLocal(folderPath, local, drive, ignore) {
  const debounce = new Map()
  fsWatch(folderPath, { recursive: true }, (_, filename) => {
    if (!filename) return
    const key = '/' + filename.replace(/\\/g, '/')
    if (ignore(key)) return
    clearTimeout(debounce.get(key))
    debounce.set(key, setTimeout(async () => {
      debounce.delete(key)
      try {
        await stat(join(folderPath, filename))
        const buf = (await local.get(key)) ?? Buffer.alloc(0)
        await drive.put(key, buf)
        console.log(`  synced ${key}`)
      } catch {
        await drive.del(key).catch(() => {})
        console.log(`  removed ${key}`)
      }
    }, 100))
  })
}

// ── .d2riveignore ─────────────────────────────────────────────────────────────

async function loadIgnore(folderPath) {
  try {
    const raw = await readFile(join(folderPath, '.d2riveignore'), 'utf8')
    const patterns = raw.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
    return makeIgnoreMatcher(patterns)
  } catch {
    return () => false
  }
}

export function makeIgnoreMatcher(patterns) {
  if (!patterns.length) return () => false

  const expanded = patterns.flatMap(p => {
    if (!p.includes('/') && !p.includes('*')) return [p, `${p}/**`]
    return [p]
  })

  const isMatch = picomatch(expanded, { dot: true })
  return (key) => isMatch(key.startsWith('/') ? key.slice(1) : key)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function dirSize(dir) {
  let total = 0
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) total += await dirSize(p)
      else total += (await stat(p)).size
    }
  } catch {}
  return total
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
