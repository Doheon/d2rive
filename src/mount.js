import Hyperdrive from 'hyperdrive'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Fuse from 'fuse-native'
import Localdrive from 'localdrive'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readdir, stat, rm } from 'fs/promises'
import b4a from 'b4a'

async function setupDrive(key) {
  const keyHex = key ? b4a.toString(key, 'hex') : `new-${Date.now()}`
  const dir = join(homedir(), '.d2rive', keyHex)

  const store = new Corestore(dir)
  const drive = new Hyperdrive(store, key)
  await drive.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', conn => store.replicate(conn))

  return { drive, store, swarm }
}

export async function createAndMount(mountpoint) {
  const { drive, store, swarm } = await setupDrive()

  swarm.join(drive.discoveryKey, { server: true, client: false })

  const key = b4a.toString(drive.key, 'hex')
  console.log(`Drive key: ${key}`)
  console.log(`Share this key: d2rive mount ${key} <mountpoint>`)

  const fuse = await doMount(drive, mountpoint)

  return { key, cleanup: makeCleanup(fuse, swarm, drive, store) }
}

export async function connectAndMount(keyHex, mountpoint) {
  const key = b4a.from(keyHex, 'hex')
  const { drive, store, swarm } = await setupDrive(key)

  swarm.join(drive.discoveryKey)

  process.stdout.write('Connecting to peers...')
  await Promise.race([
    new Promise(res => swarm.once('connection', () => setTimeout(res, 400))),
    new Promise(res => setTimeout(res, 10000))
  ])
  try { await drive.update() } catch {}
  console.log(' ready')

  const fuse = await doMount(drive, mountpoint)

  return { cleanup: makeCleanup(fuse, swarm, drive, store) }
}

export async function shareFolder(folderPath) {
  const { drive, store, swarm } = await setupDrive()
  const local = new Localdrive(folderPath)

  // Incremental sync: only changed/new files are copied on subsequent runs
  process.stdout.write('Syncing...')
  const count = await syncToDrive(local, drive)
  console.log(` ${count.add} added, ${count.change} changed, ${count.remove} removed`)

  swarm.join(drive.discoveryKey, { server: true, client: false })

  const key = b4a.toString(drive.key, 'hex')
  console.log(`Drive key: ${key}`)
  console.log(`Others can mount with: d2rive mount ${key} <mountpoint>`)
  console.log(`Watching ${folderPath} for changes...`)

  watchLocal(local, drive)

  return { key, cleanup: makeCleanup(null, swarm, drive, store) }
}

async function syncToDrive(local, drive) {
  const count = { add: 0, change: 0, remove: 0 }
  const localKeys = new Set()

  for await (const entry of local.list('/')) {
    localKeys.add(entry.key)
    const buf = await local.get(entry.key)
    const localSize = buf?.byteLength ?? 0
    const driveEntry = await drive.entry(entry.key)
    const driveSize = driveEntry?.value?.blob?.byteLength ?? -1

    if (driveSize !== localSize) {
      await drive.put(entry.key, buf)
      driveSize === -1 ? count.add++ : count.change++
    }
  }

  for await (const entry of drive.list('/')) {
    if (!localKeys.has(entry.key)) {
      await drive.del(entry.key)
      count.remove++
    }
  }

  return count
}

async function watchLocal(local, drive) {
  try {
    for await (const { type, key } of local.watch()) {
      if (type === 'put') {
        const buf = await local.get(key)
        if (buf) { await drive.put(key, buf); console.log(`  synced ${key}`) }
      } else if (type === 'del') {
        await drive.del(key)
        console.log(`  removed ${key}`)
      }
    }
  } catch {}
}

export function unmount(mountpoint) {
  return new Promise((res, rej) =>
    Fuse.unmount(mountpoint, err => err ? rej(err) : res())
  )
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
    results.push({ key: e.name, size, dir })
  }
  return results
}

export async function cacheClear(keyHex) {
  const target = keyHex
    ? join(homedir(), '.d2rive', keyHex)
    : join(homedir(), '.d2rive')
  await rm(target, { recursive: true, force: true })
}

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

// ── Internal helpers ──────────────────────────────────────────────────────────

function makeCleanup(fuse, swarm, drive, store) {
  return async () => {
    if (fuse) await new Promise((res, rej) => fuse.unmount(e => e ? rej(e) : res()))
    await swarm.destroy()
    await drive.close()
    await store.close()
  }
}

async function doMount(drive, mountpoint) {
  await mkdir(mountpoint, { recursive: true })

  let fdSeq = 0
  const handles = new Map() // fd -> { path, buf: Buffer | null }

  function statObj(isDir, size = 0) {
    const now = new Date()
    return {
      mtime: now, atime: now, ctime: now,
      nlink: isDir ? 2 : 1,
      size: isDir ? 4096 : size,
      mode: isDir ? 0o40755 : 0o100644,
      uid: process.getuid(),
      gid: process.getgid()
    }
  }

  async function getStat(path) {
    if (path === '/') return statObj(true)

    const entry = await drive.entry(path)
    if (entry) return statObj(false, entry.value?.blob?.byteLength ?? 0)

    for await (const _ of drive.list(path)) return statObj(true)

    return null
  }

  const handlers = {
    getattr(path, cb) {
      getStat(path)
        .then(s => s ? cb(0, s) : cb(Fuse.ENOENT))
        .catch(() => cb(Fuse.EIO))
    },

    readdir(path, cb) {
      const prefix = path === '/' ? '/' : path + '/'
      const names = new Set();
      (async () => {
        for await (const { key } of drive.list(path)) {
          const name = key.slice(prefix.length).split('/')[0]
          if (name && name !== '.keep') names.add(name)
        }
        cb(0, [...names])
      })().catch(() => cb(Fuse.EIO))
    },

    open(path, flags, cb) {
      getStat(path)
        .then(s => {
          if (!s) return cb(Fuse.ENOENT)
          const fd = ++fdSeq
          handles.set(fd, { path, buf: null })
          cb(0, fd)
        })
        .catch(() => cb(Fuse.EIO))
    },

    create(path, flags, cb) {
      const fd = ++fdSeq
      handles.set(fd, { path, buf: Buffer.alloc(0) })
      cb(0, fd)
    },

    read(path, fd, buf, len, pos, cb) {
      drive.get(path)
        .then(data => {
          if (!data) return cb(0)
          if (pos >= data.length) return cb(0)
          const slice = data.slice(pos, pos + len)
          slice.copy(buf)
          cb(slice.length)
        })
        .catch(() => cb(Fuse.EIO))
    },

    write(path, fd, buf, len, pos, cb) {
      const handle = handles.get(fd)
      if (!handle) return cb(Fuse.EBADF);
      (async () => {
        if (handle.buf === null) {
          handle.buf = (await drive.get(path)) ?? Buffer.alloc(0)
        }
        const end = pos + len
        if (end > handle.buf.length) {
          const next = Buffer.alloc(end)
          handle.buf.copy(next)
          handle.buf = next
        }
        buf.copy(handle.buf, pos, 0, len)
        cb(len)
      })().catch(() => cb(Fuse.EIO))
    },

    flush(path, fd, cb) {
      const handle = handles.get(fd)
      if (!handle?.buf) return cb(0)
      drive.put(path, handle.buf)
        .then(() => cb(0))
        .catch(() => cb(Fuse.EIO))
    },

    release(path, fd, cb) {
      const handle = handles.get(fd)
      const p = handle?.buf ? drive.put(path, handle.buf) : Promise.resolve()
      p.then(() => { handles.delete(fd); cb(0) })
       .catch(() => { handles.delete(fd); cb(Fuse.EIO) })
    },

    truncate(path, size, cb) {
      drive.get(path)
        .then(data => {
          const buf = Buffer.alloc(size)
          if (data) data.copy(buf, 0, 0, Math.min(size, data.length))
          return drive.put(path, buf)
        })
        .then(() => cb(0))
        .catch(() => cb(Fuse.EIO))
    },

    ftruncate(path, fd, size, cb) {
      const handle = handles.get(fd)
      if (!handle) return cb(Fuse.EBADF);
      (async () => {
        const data = handle.buf ?? (await drive.get(path)) ?? Buffer.alloc(0)
        const buf = Buffer.alloc(size)
        data.copy(buf, 0, 0, Math.min(size, data.length))
        handle.buf = buf
        cb(0)
      })().catch(() => cb(Fuse.EIO))
    },

    unlink(path, cb) {
      drive.del(path).then(() => cb(0)).catch(() => cb(Fuse.EIO))
    },

    mkdir(path, mode, cb) {
      drive.put(path + '/.keep', Buffer.alloc(0))
        .then(() => cb(0))
        .catch(() => cb(Fuse.EIO))
    },

    rmdir(path, cb) {
      ;(async () => {
        for await (const { key } of drive.list(path)) await drive.del(key)
        cb(0)
      })().catch(() => cb(Fuse.EIO))
    },

    rename(src, dest, cb) {
      ;(async () => {
        const data = await drive.get(src)
        if (data !== null) {
          await drive.put(dest, data)
          await drive.del(src)
          return cb(0)
        }
        const srcPrefix = src + '/'
        for await (const { key } of drive.list(src)) {
          const rel = key.slice(srcPrefix.length)
          const buf = await drive.get(key)
          if (buf !== null) await drive.put(dest + '/' + rel, buf)
          await drive.del(key)
        }
        cb(0)
      })().catch(() => cb(Fuse.EIO))
    },

    statfs(path, cb) {
      cb(0, {
        bsize: 1048576, frsize: 1048576,
        blocks: 1048576, bfree: 524288, bavail: 524288,
        files: 1000000, ffree: 900000, favail: 900000,
        fsid: 1000000, flag: 0, namemax: 255
      })
    }
  }

  const fuse = new Fuse(mountpoint, handlers, { force: true, mkdir: true })
  await new Promise((res, rej) => fuse.mount(err => err ? rej(err) : res()))
  console.log(`Mounted at ${mountpoint}`)

  return fuse
}
