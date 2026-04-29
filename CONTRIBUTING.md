# Contributing to d2rive

Thanks for your interest in improving d2rive! This guide covers how to set up a development environment, run tests, and submit changes.

## Prerequisites

- **Node.js** 18 or later
- **Git**
- A FUSE implementation for your platform:
  - **macOS**: [macFUSE](https://osxfuse.github.io/) 4.x or later
  - **Linux**: `libfuse2`
    - Ubuntu/Debian: `sudo apt-get install libfuse2`
    - Fedora/RHEL: `sudo dnf install fuse-libs`
    - Arch: `sudo pacman -S fuse2`
    - You may also need to add your user to the `fuse` group: `sudo usermod -aG fuse $USER`

## Setup

```sh
git clone https://github.com/Doheon/d2rive.git
cd d2rive
npm install
```

`npm install` triggers `scripts/patch-fuse.sh`, which:
- On **macOS arm64**: replaces the bundled `libosxfuse` with the system macFUSE library and rebuilds `fuse-native`.
- On **Linux**: verifies that `libfuse2` is installed; no patching is required.
- On other platforms: skips quietly.

To use the `d2rive` command globally during development:

```sh
npm link
```

## Running tests

```sh
npm test
```

Tests use Node's built-in `node:test` runner and `node:assert` — no extra test dependencies. Tests live in `test/index.test.js` and cover pure helpers (`fmtBytes`, `makeIgnoreMatcher`), the named-drives store (`saveDrive` / `listDrives` / `removeDrive` / `resolveKey`), and the cache inspection helper (`cacheInfo`). Drive-store tests use the `D2RIVE_DRIVES_FILE` environment variable to point at a temporary file so they don't touch `~/.d2rive/drives.json`.

## Project structure

- `bin/d2rive.js` — CLI entry point. Parses subcommands (`share`, `mount`, `pull`, …) and dispatches to `src/`.
- `src/mount.js` — Hyperdrive setup, FUSE handlers, share/sync logic, ignore matching, cache helpers, byte formatting.
- `src/drives.js` — Named-drive registry persisted to `~/.d2rive/drives.json` (overridable via `D2RIVE_DRIVES_FILE`).
- `scripts/patch-fuse.sh` — Post-install platform setup for FUSE.
- `test/` — Node `node:test` suite.

## Submitting a pull request

1. Fork the repo and create a topic branch from `main`:
   ```sh
   git checkout -b fix/short-description
   ```
2. Make your change in the smallest viable diff. Match the existing code style (ESM imports, no semicolons-only-when-needed style as already used).
3. Add or update tests in `test/index.test.js` when changing behavior.
4. Run `npm test` and make sure everything passes.
5. Push your branch and open a PR. In the description, please include:
   - **What** the change does
   - **Why** it's needed (linked issue if applicable)
   - **How** you tested it (platforms, manual repro steps if relevant)

For larger changes, please open an issue first to discuss the approach.

## Platform support

| Platform | Status |
| --- | --- |
| macOS (arm64 + x86_64) | Supported |
| Linux (x86_64 + aarch64) | Supported (libfuse2) |
| Windows | Help wanted — needs [WinFsp](https://winfsp.dev) integration |

If you'd like to tackle Windows support, please open an issue so we can coordinate.

## Known limitations

- **Client mounts are read-only.** A drive is owned by whoever created it; only that peer can write. Other peers can mount and read but not modify the drive.
- **Drive keys change on each `d2rive share` restart** unless the same `~/.d2rive/<key>/` corestore directory is reused. Plan your sharing flow accordingly, or save a friendly name with `d2rive save`.
- **macOS-only FUSE volume naming.** The mounted volume name (`displayFolder` / `name`) is taken from the mountpoint basename and behaves best on macOS; Linux may render it differently in file managers.
- **No incremental download in FUSE `read`.** Each read fetches the whole file via `drive.get(path)`; large files are buffered in memory.
- **Watcher reliability depends on the OS.** `fs.watch(folderPath, { recursive: true })` uses native FS events, which can miss rapid changes on some filesystems.
