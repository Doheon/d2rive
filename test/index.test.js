import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fmtBytes, makeIgnoreMatcher, cacheInfo } from '../src/mount.js'

// ── fmtBytes ──────────────────────────────────────────────────────────────────

test('fmtBytes formats bytes under 1 KB', () => {
  assert.equal(fmtBytes(0), '0 B')
  assert.equal(fmtBytes(1), '1 B')
  assert.equal(fmtBytes(1023), '1023 B')
})

test('fmtBytes formats KB threshold', () => {
  assert.equal(fmtBytes(1024), '1.0 KB')
  assert.equal(fmtBytes(1536), '1.5 KB')
  assert.equal(fmtBytes(1024 * 1024 - 1), `${((1024 * 1024 - 1) / 1024).toFixed(1)} KB`)
})

test('fmtBytes formats MB threshold', () => {
  assert.equal(fmtBytes(1024 * 1024), '1.0 MB')
  assert.equal(fmtBytes(1024 * 1024 * 5.5), '5.5 MB')
})

test('fmtBytes formats GB threshold', () => {
  assert.equal(fmtBytes(1024 ** 3), '1.00 GB')
  assert.equal(fmtBytes(1024 ** 3 * 2.5), '2.50 GB')
})

// ── makeIgnoreMatcher ─────────────────────────────────────────────────────────

test('makeIgnoreMatcher returns false for empty patterns', () => {
  const m = makeIgnoreMatcher([])
  assert.equal(m('/anything'), false)
  assert.equal(m('/node_modules/foo'), false)
})

test('makeIgnoreMatcher matches bare names and contents', () => {
  const m = makeIgnoreMatcher(['node_modules', '.git'])
  // Bare directory entry
  assert.equal(m('/node_modules'), true)
  assert.equal(m('node_modules'), true)
  // Files inside
  assert.equal(m('/node_modules/foo/index.js'), true)
  assert.equal(m('/.git/HEAD'), true)
  // Unrelated
  assert.equal(m('/src/index.js'), false)
})

test('makeIgnoreMatcher handles glob patterns', () => {
  const m = makeIgnoreMatcher(['*.log', 'dist/**'])
  assert.equal(m('/foo.log'), true)
  assert.equal(m('foo.log'), true)
  assert.equal(m('/dist/index.js'), true)
  assert.equal(m('/src/index.js'), false)
  assert.equal(m('/foo.txt'), false)
})

test('makeIgnoreMatcher strips leading slashes', () => {
  const m = makeIgnoreMatcher(['build'])
  assert.equal(m('/build'), true)
  assert.equal(m('build'), true)
  assert.equal(m('/build/output.js'), true)
})

// ── drives.js (saveDrive / listDrives / removeDrive / resolveKey) ─────────────

const VALID_KEY = 'a'.repeat(64)
const ALT_KEY = 'b'.repeat(64)

async function withDrivesFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'd2rive-test-'))
  const file = join(dir, 'drives.json')
  const prev = process.env.D2RIVE_DRIVES_FILE
  process.env.D2RIVE_DRIVES_FILE = file
  try {
    // Re-import drives.js so the env var is picked up. drivesPath() reads env
    // on every call, so a single import is enough — but we use a fresh import
    // anyway to ensure module-level state cannot leak across tests.
    const mod = await import(`../src/drives.js?cache=${Date.now()}-${Math.random()}`)
    await fn(mod, file)
  } finally {
    if (prev === undefined) delete process.env.D2RIVE_DRIVES_FILE
    else process.env.D2RIVE_DRIVES_FILE = prev
    await rm(dir, { recursive: true, force: true })
  }
}

test('resolveKey passes through valid 64-char hex', async () => {
  await withDrivesFile(async ({ resolveKey }) => {
    const out = await resolveKey(VALID_KEY)
    assert.equal(out, VALID_KEY)
    const upper = VALID_KEY.toUpperCase()
    const out2 = await resolveKey(upper)
    assert.equal(out2, upper)
  })
})

test('resolveKey looks up saved name', async () => {
  await withDrivesFile(async ({ saveDrive, resolveKey }) => {
    await saveDrive('myserver', VALID_KEY)
    const out = await resolveKey('myserver')
    assert.equal(out, VALID_KEY)
  })
})

test('resolveKey throws on unknown name', async () => {
  await withDrivesFile(async ({ resolveKey }) => {
    await assert.rejects(
      () => resolveKey('does-not-exist'),
      /Unknown drive name: "does-not-exist"/
    )
  })
})

test('saveDrive / listDrives / removeDrive roundtrip', async () => {
  await withDrivesFile(async ({ saveDrive, listDrives, removeDrive }) => {
    // Initially empty
    assert.deepEqual(await listDrives(), {})

    // Save two drives
    await saveDrive('alpha', VALID_KEY)
    await saveDrive('beta', ALT_KEY)
    const after = await listDrives()
    assert.equal(after.alpha, VALID_KEY)
    assert.equal(after.beta, ALT_KEY)

    // Overwrite
    await saveDrive('alpha', ALT_KEY)
    assert.equal((await listDrives()).alpha, ALT_KEY)

    // Remove
    await removeDrive('alpha')
    const remaining = await listDrives()
    assert.equal(remaining.alpha, undefined)
    assert.equal(remaining.beta, ALT_KEY)
  })
})

// ── cacheInfo ─────────────────────────────────────────────────────────────────

test('cacheInfo reads .lastaccess from a temp dir', async () => {
  // cacheInfo reads from ~/.d2rive — override HOME for the test scope.
  const tmpHome = await mkdtemp(join(tmpdir(), 'd2rive-home-'))
  const prevHome = process.env.HOME
  process.env.HOME = tmpHome
  try {
    const fakeKey = 'c'.repeat(64)
    const cacheDir = join(tmpHome, '.d2rive', fakeKey)
    await mkdir(cacheDir, { recursive: true })
    const ts = Date.now() - 86400000 * 3 // 3 days ago
    await writeFile(join(cacheDir, '.lastaccess'), ts.toString())
    await writeFile(join(cacheDir, 'data.bin'), Buffer.alloc(2048))

    // Re-import so homedir() is re-evaluated.
    const { cacheInfo: ci } = await import(`../src/mount.js?cache=${Date.now()}-${Math.random()}`)
    const list = await ci()
    const entry = list.find(e => e.key === fakeKey)
    assert.ok(entry, 'expected cache entry to exist')
    assert.equal(entry.lastAccessDays, 3)
    assert.ok(entry.size >= 2048, `expected size >= 2048, got ${entry.size}`)
    assert.equal(entry.dir, cacheDir)
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    await rm(tmpHome, { recursive: true, force: true })
  }
})
