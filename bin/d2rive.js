#!/usr/bin/env node
import {
  shareFolder, watchDrive, pullFile, driveInfo,
  cacheInfo, cacheClear, fmtBytes, syncFromDrive
} from '../src/mount.js'
import { createSync, joinSync } from '../src/sync.js'
import { saveDrive, removeDrive, listDrives, resolveKey } from '../src/drives.js'


if (process.platform === 'win32') {
  console.error('Windows is not yet supported.')
  console.error('Contributions welcome — see CONTRIBUTING.md')
  process.exit(1)
}

const [,, cmd, ...args] = process.argv

const commands = {
  async share() {
    const writable = args.includes('--write')
    const cleanArgs = args.filter(a => a !== '--write')
    const [folderPath] = cleanArgs
    if (!folderPath) usage()
    const { cleanup } = await shareFolder(folderPath, { writable })
    onExit(cleanup)
  },

  async watch() {
    const clean = args.includes('--clean')
    const cleanArgs = args.filter(a => a !== '--clean')
    const [keyOrName, localFolder] = cleanArgs
    if (!keyOrName || !localFolder) usage()
    const key = await resolveKey(keyOrName)
    const { cleanup } = await watchDrive(key, localFolder, { clean })
    onExit(cleanup)
  },

  async pull() {
    const [keyOrName, remotePath, localPath] = args
    if (!keyOrName || !remotePath || !localPath) usage()
    const key = await resolveKey(keyOrName)
    await pullFile(key, remotePath, localPath)
  },

  async info() {
    const [keyOrName] = args
    if (!keyOrName) usage()
    const key = await resolveKey(keyOrName)
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
    const [sub, keyOrName] = args
    if (!sub || sub === 'info') {
      const key = keyOrName ? await resolveKey(keyOrName) : undefined
      const list = await cacheInfo(key)
      if (!list.length) { console.log('No cache found'); return }
      let total = 0
      for (const { key, size, dir, lastAccessDays } of list) {
        const age = lastAccessDays === null ? 'never' : `${lastAccessDays}d ago`
        console.log(`${fmtBytes(size).padStart(9)}  ${age.padStart(8)}  ${key.slice(0, 20)}...  ${dir}`)
        total += size
      }
      console.log(`Total: ${fmtBytes(total)}`)
      const stale = list.filter(e => e.lastAccessDays !== null && e.lastAccessDays > 30)
      if (stale.length) console.log(`\n⚠  ${stale.length} drive(s) not accessed in 30+ days — run: d2rive cache clear`)
    } else if (sub === 'clear') {
      const key = keyOrName ? await resolveKey(keyOrName) : undefined
      await cacheClear(key)
      console.log(key ? `Cleared cache for ${key.slice(0, 20)}...` : 'Cleared all caches')
    } else {
      usage()
    }
  },

  async sync() {
    const [keyOrName, localPath] = args
    if (!keyOrName || !localPath) usage()
    const key = await resolveKey(keyOrName)
    await syncFromDrive(key, localPath)
  },

  async save() {
    const [name, key] = args
    if (!name || !key) usage()
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      console.error('Invalid key: must be a 64-character hex string')
      process.exit(1)
    }
    await saveDrive(name, key)
    console.log(`Saved "${name}" → ${key.slice(0, 20)}...`)
  },

  async saved() {
    const drives = await listDrives()
    if (!drives.length) { console.log('No saved drives'); return }
    for (const { name, key, folder } of drives) {
      const folderStr = folder ? `  ${folder}` : ''
      console.log(`  ${name.padEnd(20)} ${key.slice(0, 20)}...${folderStr}`)
    }
  },

  async forget() {
    const [name] = args
    if (!name) usage()
    await removeDrive(name)
    console.log(`Forgot "${name}"`)
  },

  async 'sync-create'() {
    const [folderPath] = args
    if (!folderPath) usage()
    const { cleanup } = await createSync(folderPath)
    onExit(cleanup)
  },

  async 'sync-join'() {
    const cleanArgs = args.filter(a => a !== '--clean')
    const [keyOrName, localFolder] = cleanArgs
    if (!keyOrName || !localFolder) usage()
    const key = await resolveKey(keyOrName)
    const { cleanup } = await joinSync(key, localFolder)
    onExit(cleanup)
  }
}

const handler = commands[cmd]
if (!handler) usage()

handler().catch(err => { console.error(err.message); process.exit(1) })

function onExit(cleanup) {
  console.log('Running... Press Ctrl+C to stop.')
  const exit = () => cleanup().then(() => process.exit(0)).catch(() => process.exit(1))
  process.once('SIGINT', exit)
  process.once('SIGTERM', exit)
}

function usage() {
  console.error(`Usage:
  d2rive share <folder>                    Share a local folder (syncs + watches for changes)
  d2rive watch <key|name> <localFolder>    Watch a remote drive, syncing files locally

  d2rive sync-create <folder>              Bidirectional sync: create a sync session
  d2rive sync-join <key|name> <folder>     Bidirectional sync: join an existing sync session

  d2rive pull <key|name> <remote> <local>  Download a single file from a drive
  d2rive info <key|name>                   List files and sizes in a drive
  d2rive sync <key|name> <localFolder>     One-time download of all files from a drive

  d2rive save <name> <key>                 Save a drive key with a friendly name
  d2rive saved                             List saved drives
  d2rive forget <name>                     Remove a saved drive name

  d2rive cache info [key]                  Show local cache size
  d2rive cache clear [key]                 Delete cache (all or by key)

  Place a .d2riveignore file in the shared folder to exclude files/dirs.`)
  process.exit(1)
}
