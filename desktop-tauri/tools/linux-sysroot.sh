#!/usr/bin/env bash
# Build a user-space Linux sysroot for compiling the Tauri shell without sudo.
# Ubuntu 26.04. Downloads the webkit2gtk-4.1/gtk3/soup3 dev closure as .debs
# and extracts them under ~/.tauri-sysroot/root. Safe to re-run.
#
# Usage: tools/linux-sysroot.sh            # download + extract
#        source tools/linux-sysroot.env    # then cargo check / cargo build
set -euo pipefail

SYSROOT="${TAURI_SYSROOT:-$HOME/.tauri-sysroot}"
ROOT="$SYSROOT/root"
mkdir -p "$SYSROOT/debs" "$ROOT"

cd "$SYSROOT"
if [ ! -s deps-filtered.txt ]; then
  apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
    --no-breaks --no-replaces --no-enhances --no-pre-depends \
    libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
    | grep -oE '^[a-z0-9][a-z0-9+.-]+' | sort -u \
    | grep -viE 'aspell|hunspell|myspell|^w[a-z]+$|dictionary|wordlist' \
    > deps-filtered.txt
fi

cd "$SYSROOT/debs"
xargs -a ../deps-filtered.txt -n 50 apt download

for deb in *.deb; do dpkg -x "$deb" "$ROOT"; done

# WebKit looks up its helper processes (WebKitWebProcess/…) via a compile-time
# absolute path under /usr, which we cannot create without sudo. Patch the
# string in the sysroot's libwebkit2gtk to an equal-length /tmp symlink that
# resolves into the sysroot. Idempotent; operates on the real versioned .so.
WKLIB=$(ls "$ROOT"/usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0.* 2>/dev/null | head -1)
if [ -n "$WKLIB" ] && ! grep -q '/tmp/.wkgtk/' "$WKLIB"; then
  mkdir -p /tmp/.wkgtk
  ln -sfn "$ROOT/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1" /tmp/.wkgtk/aaaaaaaaaaaaaaaaaaaaaaaaaaaa
  sed -i 's|/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1|/tmp/.wkgtk/aaaaaaaaaaaaaaaaaaaaaaaaaaaa|g' "$WKLIB"
  echo "patched helper path in $WKLIB"
fi

echo "sysroot ready at $ROOT"
