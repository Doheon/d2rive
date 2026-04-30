import { homedir } from 'os'
import { dirname, join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

const drivesPath = () => process.env.D2RIVE_DRIVES_FILE || join(homedir(), '.d2rive', 'drives.json')

async function readDrives() {
  try {
    const raw = await readFile(drivesPath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeDrives(data) {
  const p = drivesPath()
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(data, null, 2))
}

export async function saveDrive(name, keyHex, folder = null) {
  const drives = await readDrives()
  drives[name] = folder ? { key: keyHex, folder } : keyHex
  await writeDrives(drives)
}

export async function removeDrive(name) {
  const drives = await readDrives()
  delete drives[name]
  await writeDrives(drives)
}

export async function listDrives() {
  const drives = await readDrives()
  return Object.entries(drives).map(([name, val]) => ({
    name,
    key: typeof val === 'string' ? val : val.key,
    folder: typeof val === 'string' ? null : (val.folder || null)
  }))
}

export async function resolveKey(nameOrKey) {
  if (/^(?:sync:)?[0-9a-f]{64}$/i.test(nameOrKey)) return nameOrKey
  const drives = await readDrives()
  const entry = drives[nameOrKey]
  if (!entry) throw new Error(`Unknown drive name: "${nameOrKey}"`)
  return typeof entry === 'string' ? entry : entry.key
}
