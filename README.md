# d2rive

P2P remote folder mounting over [Hyperdrive](https://github.com/holepunchto/hyperdrive). Mount a remote folder as a local filesystem via macFUSE — no servers, no accounts.

## Requirements

**macOS**
- [macFUSE](https://osxfuse.github.io/) 4.x or later

**Linux**
- libfuse2: `sudo apt-get install libfuse2` (Ubuntu/Debian) or `sudo dnf install fuse-libs` (Fedora)
- May require adding your user to the `fuse` group: `sudo usermod -aG fuse $USER`

**Both**
- Node.js 18+

## Install

```sh
git clone https://github.com/Doheon/d2rive.git
cd d2rive
npm install
```

`npm install` automatically patches fuse-native for macOS arm64 (Apple Silicon).

To use the `d2rive` command globally:

```sh
npm link
```

---

## GUI (menubar app)

A macOS menu bar app is available in the `app/` directory:

```sh
cd app
npm install
npm run rebuild
npm start
```

- `npm run rebuild` — rebuilds native addons for Electron (required once after install)
- `npm start` — launches the menu bar app

To run from anywhere after linking:

```sh
cd app
npm link
d2rive-app
```

---

## Usage

### Share a local folder

Share a folder so others can mount it:

```sh
d2rive share <folder>
```

```
$ d2rive share ~/projects/myapp
Synced: +42 changed:0 -0
Drive key: a1b2c3d4...
Others can mount with: d2rive mount a1b2c3d4... <mountpoint>
Watching ~/projects/myapp for changes...
Running... Press Ctrl+C to stop.
```

The folder is watched for changes — edits are synced to connected peers in real time.

---

### Mount a remote drive

```sh
d2rive mount <key> <mountpoint>
```

```sh
d2rive mount a1b2c3d4... ~/mnt
```

The remote folder appears at `~/mnt`. The mount is **read-only** — the drive is owned by the sharer and only they can write to it.

Server-side changes are reflected on the client within ~2 seconds automatically. If the peer goes offline, cached files remain accessible and the client reconnects automatically when the server comes back online.

---

### Create an empty drive

Create a new empty drive and mount it locally:

```sh
d2rive create <mountpoint>
```

```sh
d2rive create ~/mnt
```

Prints a key others can use to mount the same drive.

---

### Unmount

```sh
d2rive unmount <mountpoint>
```

---

### Download a single file

```sh
d2rive pull <key> <remote-path> <local-path>
```

```sh
d2rive pull a1b2c3d4... /README.md ./README.md
```

---

### Download all files

```sh
d2rive sync <key|name> <local-folder>
```

```sh
d2rive sync a1b2c3d4... ./local-copy
```

---

### List files in a drive

```sh
d2rive info <key|name>
```

```
   12.3 KB  /src/index.js
    4.1 KB  /README.md
─────────────────
   16.4 KB  2 files
```

---

## Named drives

Save a long key under a friendly name:

```sh
d2rive save <name> <key>
d2rive saved                  # list all saved drives
d2rive forget <name>          # remove a saved name
```

```sh
d2rive save myserver a1b2c3d4...
d2rive mount myserver ~/mnt
d2rive sync myserver ./backup
```

---

## Cache

Drive data is cached locally at `~/.d2rive/<key>/`.

```sh
d2rive cache info             # show size and last-access age per drive
d2rive cache clear            # delete all caches
d2rive cache clear <key>      # delete cache for a specific drive
```

---

## Ignoring files

Place a `.d2riveignore` file in the shared folder to exclude files or directories:

```
node_modules
.git
*.log
dist
```

Bare names like `node_modules` automatically match both the entry itself and everything inside it.

---

## License

MIT
