#!/bin/bash
# Patches fuse-native to use the system macFUSE library on macOS arm64
# On Linux, verifies that libfuse2 is installed.

PLATFORM=$(uname -s)
ARCH=$(uname -m)

if [ "$PLATFORM" = "Linux" ]; then
  FOUND=0
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    FOUND=1
  fi
  for candidate in \
    /usr/lib/x86_64-linux-gnu/libfuse.so.2 \
    /usr/lib/aarch64-linux-gnu/libfuse.so.2 \
    /usr/lib64/libfuse.so.2 \
    /usr/lib/libfuse.so.2 \
    /lib/x86_64-linux-gnu/libfuse.so.2 \
    /lib/aarch64-linux-gnu/libfuse.so.2; do
    if [ -f "$candidate" ]; then
      FOUND=1
      break
    fi
  done

  if [ "$FOUND" -ne 1 ]; then
    echo "patch-fuse: on Linux, install libfuse2 first:"
    echo "  Ubuntu/Debian: sudo apt-get install libfuse2"
    echo "  Fedora/RHEL:   sudo dnf install fuse-libs"
    echo "  Arch:          sudo pacman -S fuse2"
    exit 1
  fi

  echo "patch-fuse: Linux detected, libfuse2 found — no patching needed"
  exit 0
fi

if [ "$PLATFORM" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  echo "patch-fuse: skipping (not macOS arm64)"
  exit 0
fi

SYSTEM_LIB="/usr/local/lib/libfuse.2.dylib"
if [ ! -f "$SYSTEM_LIB" ]; then
  echo "patch-fuse: macFUSE not found at $SYSTEM_LIB — install macFUSE first"
  exit 1
fi

BUNDLE_LIB="node_modules/fuse-shared-library-darwin/osxfuse/libosxfuse.dylib"
if [ ! -f "$BUNDLE_LIB" ]; then
  echo "patch-fuse: $BUNDLE_LIB not found — run npm install first"
  exit 1
fi

# Check if already patched (arm64 slice present)
if lipo -info "$BUNDLE_LIB" 2>/dev/null | grep -q arm64; then
  echo "patch-fuse: already patched, skipping"
  exit 0
fi

echo "patch-fuse: replacing bundled x86_64 libosxfuse with system arm64 libfuse..."

TMP=$(mktemp /tmp/libosxfuse.XXXXXX.dylib)
cp "$SYSTEM_LIB" "$TMP"
install_name_tool -id @loader_path/libosxfuse.dylib "$TMP" 2>/dev/null
codesign -s - -f "$TMP" 2>/dev/null
cp "$TMP" "$BUNDLE_LIB"
rm "$TMP"

echo "patch-fuse: rebuilding fuse-native..."
cd node_modules/fuse-native && npx --yes node-gyp rebuild 2>&1 | tail -3
cd ../..

echo "patch-fuse: done"
