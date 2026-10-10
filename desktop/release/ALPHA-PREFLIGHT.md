# New-architecture Alpha packaging preflight

This gate prepares a development runtime bundle, not a booted or accepted Alpha.
Keep `desktop/VERSION` unchanged until the coordinator freezes the integrated
Shell/configuration commit and chooses the next Alpha version. Do not overwrite
historical bundles, evidence directories or shared image tags.

Use an **isolated, disposable Ninja build tree**. `package-linux.mjs` verifies its
source directory/options, reconfigures it, checks the native Linux x86_64/LP64
FileSystem ABI against target headers, and uses `--clean-first` before building
the production targets. Never pass a shared SDK/other session's build directory.
Pinned Skia/SDL/HarfBuzz source caches and the corrected Mesa package cache may
be reused; old PollyUI runtime binaries are not reused.
`POLLY_MESA_CACHE` may explicitly select a private copy of the corrected Mesa
cache (default `/opt/pollyui-local-debs/mesa`); all metadata/package hashes are
still checked. The packager never installs dependencies or elevates privileges.
If the SDK's cache directory is root-only, a private container coordinator may
copy that known directory into `/checks/mesa-cache`, grant UID1000 access only
to the copy, and retain the source SDK image ID and matching original/copy
metadata hashes. Do not change inherited cache permissions or shared tags.

In the offline Debian 13 SDK, with the frozen checkout mounted at `/workspace`
and a private writable `/checks`:

```sh
cmake -S /workspace -B /checks/build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DPU_BUILD_DESKTOP=ON \
  -DPU_BUILD_SESSION_AUTH=ON -DPU_BUILD_IME_ENGINE=ON -DPU_HOST=sdl \
  -DSKIA_ROOT=/opt/pollyui-skia \
  -DSKIA_LIB_DIR=/opt/pollyui-skia/out/Release-linux \
  -DSDL3_DIR=/opt/pollyui-sdl/build-polly -DCMAKE_INSTALL_LIBDIR=lib
cd /workspace
node desktop/tests/package-contract.mjs --packaging-cli
node desktop/tools/package-linux.mjs /checks/build /checks/candidate \
  /opt/pollyui-sdl /opt/pollyui-harfbuzz
node desktop/tests/package-manifest.mjs /checks/candidate
node desktop/tools/release-report.mjs /checks/candidate
node desktop/tests/installed-session.mjs /checks/build --ime
```

For tool/staging tests only, if Git metadata is unavailable in a read-only
worktree export, supply `POLLY_SOURCE_REVISION` and `POLLY_SOURCE_DIRTY=1`.
The receipt marks these as an **external label**, not verified Git provenance.
When Git is available, conflicting revision or false-clean labels fail.
Source byte inventories before/after the clean runtime rebuild, installed
payload hashes and source-resource comparisons are independent of that label.
These local receipts are not signed attestations or proof of SDK reproducibility.
For a formal frozen candidate, use an independently verified clean fixed-commit
checkout with readable Git metadata and run
`node desktop/tests/package-manifest.mjs /checks/candidate --frozen`.
This rejects dirty inputs and every external-label receipt, even a claimed-clean
one. This round's external-label staging bundle cannot qualify as a VM candidate.

The new runtime contract requires the launcher prelude, SysRT SDK/bindings and
generated ABI, JS file/theme resources, and standalone Settings launcher,
desktop entry, client contract and application. It records the entire actual
CMake `PollyDesktop` install inventory, including JSON resources without
hard-coding future configuration module names. Every installed file must survive
packaging with its recorded final bytes. The Debian package uses the existing
`patchelf` step to set private compositor/wlroots RPATHs; inventory hashes are
recorded separately for original CMake-installed files and postprocessed final
bytes. Explicit before/after receipts account for the intentional ELF changes.
SDL/wlroots/libinput loader paths and
hashes must resolve inside the staged payload, not the SDK's `/opt` directories.
Runtime `ldd` library owners (including libffi)
must appear with identical package/version pins in the SPDX SBOM. JS-loaded
`libcrypto.so.3` and `libdbus-1.so.3` are separately loaded/resolved by the SDK
loader, checked for required symbols, hashed, and mapped to their actual package
owners and dependency closures. Do not assume their names match package names
or that they will always occur in the launcher's `ldd` output.
Fixtures/test applications are forbidden in the runtime payload.
`package-manifest.mjs` rejects legacy bundles; the generic release report still
reads historical bundles without treating them as new-runtime candidates.

For standalone Settings, build `pollyui-layer-client-test` in the same private tree
and run the existing `settings-native.py --mode installed` fixture from an
unrelated staged install. This is container/native staging evidence only.

```sh
cmake --build /checks/build --target pollyui-layer-client-test -j2
python3 -I -B desktop/tests/settings-native.py \
  /checks/build/pollyui-layer-client-test /checks/build/pollyui \
  --mode installed --package-root /checks/candidate/rootfs \
  --evidence /checks/settings-installed-evidence
```

**Still required after freeze:** package the final version/commit, build a
uniquely scoped candidate runtime/media (do not invoke the current
`build-live.sh` defaults against historical shared tags), then run one real
UEFI QEMU lane. Extend guest acceptance to exercise the standalone Settings
Appearance/About process and installed JSON configuration/JS file-theme
behavior; the old welcome readiness marker is insufficient. Keep guest disks
read-only, no NIC/host shares/extra writable disks, and retain VM evidence.
Only after that succeeds produce the physical-test ISO. No installer, disk
mutation, physical qualification or source-compliance completion is implied.
