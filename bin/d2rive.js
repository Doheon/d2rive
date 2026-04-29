#!/usr/bin/env node
import {
  createAndMount, connectAndMount, unmount,
  shareFolder, pullFile, driveInfo,
  cacheInfo, cacheClear, fmtBytes
} from '../src/mount.js'

const [,, cmd, ...args] = process.argv

const commands = {
  async share() {
    const [folderPath] = args
    if (!folderPath) usage()
    const { cleanup } = await shareFolder(folderPath)
    onExit(cleanup)
  },

  async create() {
    const [mountpoint] = args
    if (!mountpoint) usage()
    const { cleanup } = await createAndMount(mountpoint)
    onExit(cleanup)
  },

  async mount() {
    const [key, mountpoint] = args
    if (!key || !mountpoint) usage()
    const { cleanup } = await connectAndMount(key, mountpoint)
    onExit(cleanup)
  },

  async unmount() {
    const [mountpoint] = args
    if (!mountpoint) usage()
    await unmount(mountpoint)
    console.log(`Unmounted ${mountpoint}`)
  },

  async pull() {
    const [key, remotePath, localPath] = args
    if (!key || !remotePath || !localPath) usage()
    await pullFile(key, remotePath, localPath)
  },

  async info() {
    const [key] = args
    if (!key) usage()
    const files = await driveInfo(key)
    if (!files.length) { console.log('Drive is empty'); return }
    let total = 0
    for (const { path, size } of files) {
      console.log(`${fmtBytes(size).padStart(9)}  ${path}`)
      total += size
    }
    console.log(`─────────────────`)
    console.log(`${fmtBytes(total).padStart(9)}  ${files.length} files`)
  },

  async cache() {
    const [sub, key] = args
    if (!sub || sub === 'info') {
      const list = await cacheInfo(key)
      if (!list.length) { console.log('No cache found'); return }
      let total = 0
      for (const { key, size, dir } of list) {
        console.log(`${fmtBytes(size).padStart(9)}  ${key.slice(0, 20)}...  ${dir}`)
        total += size
      }
      console.log(`Total: ${fmtBytes(total)}`)
    } else if (sub === 'clear') {
      await cacheClear(key)
      console.log(key ? `Cleared cache for ${key.slice(0, 20)}...` : 'Cleared all caches')
    } else {
      usage()
    }
  }
}

const handler = commands[cmd]
if (!handler) usage()

handler().catch(err => { console.error(err.message); process.exit(1) })

function onExit(cleanup) {
  console.log('Running... Press Ctrl+C to stop.')
  process.once('SIGINT', () => {
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1))
  })
}

function usage() {
  console.error(`Usage:
  d2rive share <folder>                    Share a local folder (syncs + watches)
  d2rive create <mountpoint>               Create a new empty drive and mount it
  d2rive mount <key> <mountpoint>          Mount a remote drive by key
  d2rive unmount <mountpoint>              Unmount

  d2rive pull <key> <remote> <local>       Download a single file from a drive
  d2rive info <key>                        List files and sizes in a drive

  d2rive cache info [key]                  Show local cache size
  d2rive cache clear [key]                 Delete cache (all or by key)

  Place a .d2riveignore file in the shared folder to exclude files/dirs.`)
  process.exit(1)
}
