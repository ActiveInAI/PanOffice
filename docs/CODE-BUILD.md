# Building Collabora Online (CODE) from source on this machine

Status: **done and verified end-to-end (2026-08-07)** — coolwsd built from
the Gerrit monorepo and proven against our WOPI host (open → render → edit →
PutFile save). This is the reproducible recipe. Everything runs **without
sudo** on the WSL2/Ubuntu 26.04 box; the only outside-network trick is
§3 (dev-www.libreoffice.org is unreachable from the WSL egress but fine
from the Windows side).

Reference: [official build guide](https://www.collaboraoffice.org/post/build-code/)
(its "daily engine assets" shortcut is NOT sufficient for the current
monorepo — `README-gbuild.md` in the repo states the gbuild parts require a
*completely finished engine build*; we build the engine for real).

## 0. Layout

- Monorepo: `~/panspace/online` (Gerrit clone, main @ cbdc7d06; contains
  `engine/` = former Collabora Office core).
- User-space sysroot: `~/.cool-sysroot/{debs,root}` — ~180 Ubuntu debs
  extracted with `dpkg -x` (same pattern as
  `desktop-tauri/tools/linux-sysroot.sh`).

## 1. Build-time environment

```bash
R=~/.cool-sysroot/root
export PATH=$R/usr/bin:~/.venvs/ai/bin:$PATH
export ACLOCAL_PATH=$R/usr/share/aclocal:/usr/share/aclocal
export AUTOMAKE_LIBDIR=$R/usr/share/automake-1.18
export PKG_CONFIG_PATH=$R/usr/lib/x86_64-linux-gnu/pkgconfig:$R/usr/share/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=$R
export CPPFLAGS="-I$R/usr/include -I$R/usr/include/x86_64-linux-gnu"
export LDFLAGS="-L$R/usr/lib/x86_64-linux-gnu"
export LD_LIBRARY_PATH=$R/usr/lib/x86_64-linux-gnu
export PYTHONPATH=$R/usr/lib/python3/dist-packages   # meson
export BISON_PKGDATADIR=$R/usr/share/bison
export M4=$R/usr/bin/m4
```

Debs to `apt download` + `dpkg -x` (closure via `apt-cache depends --recurse`):
autoconf automake libtool libtool-bin m4 libcap-dev libssl-dev libpam0g-dev
libzstd-dev libpng-dev libgif-dev libcppunit-dev libpcre2-dev zlib1g-dev
libpoco-dev gperf uuid-dev libuuid1 bison flex xsltproc meson ninja-build
cpio. `polib` goes into the ai venv (`uv pip install polib`).

Autotools prefix patches inside the sysroot (all one-time): `libtool`,
`libtoolize` (`/usr/share/libtool`, `/usr/share/aclocal`), `aclocal`/
`automake*` (`@INC`, `aclocal-1.18`, unversioned symlinks), autoconf family
(`/usr/share/autoconf` in bins + `Autom4te/*.pm` + `autom4te.cfg`),
`/usr/bin/m4` and `/usr/bin/auto*` cross-references.

## 2. Configure

```bash
# engine (needed for config_host.mk; online's gbuild parts require the
# full engine build later anyway)
cd ~/panspace/online/engine
./autogen.sh --with-distro=CPLinux-LOKit --without-package-format

# online
cd ~/panspace/online
./autogen.sh
./configure --enable-debug --disable-ssl --disable-werror
```

- `--disable-werror`: Ubuntu 26.04's GCC 15 is stricter than upstream CI.
- engine may ask for more tools over iterations (gperf, bison, flex,
  xsltproc, meson, ninja, uuid-dev) — all in the sysroot above.
- Do NOT pass `--with-system-poco` (unknown option; POCO is built
  unconditionally from `engine/external/poco`).

## 3. External tarballs (the only network hurdle)

`make fetch-names` (top of engine/) prints the exact tarball list for the
config (~117 files incl. fonts). `dev-www.libreoffice.org` is **unreachable
from WSL** (TCP timeout; globally up — verified). Route: run the download
from the **Windows side** (PowerShell `Invoke-WebRequest`, WSL2 shares the
file via `/mnt/c`), then verify every file against `download.lst` sha256
and drop into `engine/external/tarballs/`. Noto fonts + opendyslexic come
from GitHub releases (for-code-assets / antijingoist) — reachable from WSL
directly. POCO tarball (`poco-1.15.3-all.tar.bz2`, sha256-pinned in
`download.lst`) comes from the upstream GitHub release.

## 4. Build

```bash
cd ~/panspace/online/engine && make -j$(nproc)     # ~35 min here, exit 0
cd ~/panspace/online && make -j$(nproc) COOL_SYSROOT=$HOME/.cool-sysroot/root \
    LIBS='-lcap -lexpat -lrt -lcrypto -lz'
```

`LIBS=... -lz`: Ubuntu's ld defaults to `--as-needed`, so `-lz` in
`AM_LDFLAGS` gets dropped before the static poco archives need it; it must
sit in `LIBS` (link-line tail).

## 5. Fork-local source patches (MPL-2.0)

All in `~/panspace/online` — kept minimal, marked "PanOffice":

- `gbuild/Module_gbuild.mk`: append `-isystem …/openssl/include` to
  `online_poco_inc` (RepositoryExternal's non-system `use_openssl` never
  adds the -I); add `online_cap_inc`/`online_cap_libs` (sysroot cap
  headers/libs, gated on `COOL_SYSROOT`) folded into `online_poco_inc`.
- `gbuild/Executable_coolforkit-{caps,ns}.mk`: `$(online_cap_libs)` before
  `$(ONLINE.CAP_LIBS)`.
- `gbuild/Executable_coolmount.mk`: add missing `$(online_poco_inc)` to
  its include block (upstream oversight).
- `engine/config_host.mk`: appended
  `gb_LinkTarget_LDFLAGS += -L…/.cool-sysroot/root/usr/lib/x86_64-linux-gnu`.

If engine is re-configured, regenerate with the same flags and redo the
last two items (they are in generated files).

## 6. Run

```bash
cd ~/panspace/online
rm -rf systemplate && ./coolwsd-systemplate-setup systemplate engine/instdir
mkdir -p jails cache
LD_LIBRARY_PATH=$R/usr/lib/x86_64-linux-gnu ./coolwsd \
  --o:sys_template_path=$PWD/systemplate \
  --o:child_root_path=$PWD/jails \
  --o:cache_files.path=$PWD/cache \
  --port=9982 --o:logging.level=trace
```

- userns jails work on this WSL kernel (`unshare -rm true` ✓); no
  `security.capabilities=false` downgrade needed.
- systemplate setup needs `cpio` (sysroot). The `systemplate/lo` mount
  point being empty is correct — instdir is bind-linked at spawn.
- **CSP gotcha**: coolwsd mirrors the request Host into
  `frame-ancestors` of cool.html's CSP. The embedding page and the iframe
  URL must therefore use the SAME host string (we use `127.0.0.1`
  everywhere; mixing `localhost` vs `127.0.0.1` gets the frame blocked).

## 7. Verified WOPI loop (2026-08-07)

wopi-host (`panoffice/server/wopi-host`, port 3210,
`COLLABORA_*_URL=http://127.0.0.1:9982`) + self-built coolwsd on 9982.
Headless chromium (`desktop-tauri/tools/collab-e2e.mjs`,
`collab-save-test.mjs`): opens `…/edit/simple.docx`, Collabora Writer
renders the doc, typed marker `PANOFFICE-E2E-SELFBUILT` round-trips via
WOPI PutFile into `deploy/data/files/simple.docx` (2156 → 5304 bytes,
marker present in `word/document.xml`).

Stop: `kill $(cat /tmp/coolwsd.pid)` and kill the wopi-host node process.
