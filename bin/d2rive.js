#!/usr/bin/env node
import { createAndMount, connectAndMount, unmount, shareFolder, cacheInfo, cacheClear } from '../src/mount.js'

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

  async cache() {
    const [sub, key] = args
    if (!sub || sub === 'info') {
      const list = await cacheInfo(key)
      if (!list.length) { console.log('No cache found'); return }
      for (const { key, size, dir } of list) {
        console.log(`${key.slice(0, 20)}...  ${fmtBytes(size).padStart(8)}  ${dir}`)
      }
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

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function usage() {
  console.error(`Usage:
  d2rive share <folder>                Share a local folder (prints key)
  d2rive create <mountpoint>           Create a new empty drive and mount it
  d2rive mount <key> <mountpoint>      Mount a remote drive by key
  d2rive unmount <mountpoint>          Unmount

  d2rive cache info [key]              Show cache size
  d2rive cache clear [key]             Delete cache (all or by key)`)
  process.exit(1)
}
