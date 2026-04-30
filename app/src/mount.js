import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import picomatch from 'picomatch'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { mkdir, readdir, readFile, writeFile, stat, rm, chmod } from 'fs/promises'
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

// ── Download helper ───────────────────────────────────────────────────────────

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

// ── .d2riveignore ─────────────────────────────────────────────────────────────

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
