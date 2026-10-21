# SKU / Feature / Component Matrix

[HTML view with merged cells](SKU-MATRIX.html). After editing this source, regenerate
the HTML with `node desktop/tools/render-sku-matrix.mjs` from the repository root.

Updated: 2026-10-20. Current product names: **Mini / Compact / Standard**.
Chinese fonts and input are included from Compact upward. There is no `-zh` suffix
or separate Full tier.

Mini is the former Alpine Micro desktop. Compact is the Debian Chinese
lightweight target, using basic GOP/simpledrm display rather than vendor-specific
editions. Standard carries the full existing driver/firmware selection.
Historical Micro/Thin/full/minimal-zh artifact identities remain unchanged.
Use `bash tools/build.sh --os --help` for the canonical product build entry.

This document records confirmed product boundaries and implementation status;
it is not an executable build configuration.
**Target inclusion, source availability, packaging, service startup, and actual
usability are distinct states.** See [delivery records](SKU-DELIVERY.md) for
image identities and historical artifacts, and [stack and sizes](SKU-SIZES.md)
for size evidence.

## 1. Feature Targets

Legend: **✅ Included · ❌ Excluded · ❔ TBD**.
In this target matrix, ✅ does not mean a validated image. ❔ means undecided,
not implicitly supported.

| Feature | Mini | Compact | Standard |
|---|---|---|---|
| Product role | Smallest Alpine graphical desktop | Lightweight Debian Chinese desktop | General-purpose hardware desktop |
| UI Shell | ✅ | ✅ | ✅ |
| Window decorations and basic application launchers | ✅ | ❔ | ❔ |
| Basic Latin text and keyboard input | ✅ | ✅ | ✅ |
| Chinese fonts | ❌ | ✅ | ✅ |
| Chinese input method | ❌ | ✅ | ✅ |
| Canvas 2D | CPU path retained | Shared implementation retained | Shared implementation retained |
| WebGL2 / 3D | ❌ | ❔ | Existing recipe includes WebGL2; new product qualification pending |
| WebGPU | ❌ | ❔ | ❔ |
| Software 3D runtime | ❌ | ❔ | Existing Mesa/LLVM closure retained; not separately qualified |
| Vendor GPU acceleration | ❌ | ❌ | Driver-specific; requires validation |
| Display drivers | GOP/simpledrm + virtio | Basic GOP/simpledrm path | General-purpose driver set |
| Firmware | Minimum required set | Basic set; inventory TBD | General-purpose firmware set |
| Vendor-specific product editions | ❌ | ❌ | ❌; driver selection is internal, not extra product tiers |

Retaining Canvas 2D does not establish full browser API conformance or
performance qualification. GPU drivers, GPU composition, WebGL2, and WebGPU
are independent capabilities; one does not imply the others.
Mini explicitly excludes Mesa/LLVMpipe, Softpipe, Lavapipe, and other software
3D runtimes.

## 2. Component Selection

| Component | Mini | Compact | Standard |
|---|---|---|---|
| Distribution / libc | Alpine / musl | Debian / glibc | Debian / glibc |
| Init and session | BusyBox / UID 1000 / seatd; no login | New-tier design TBD | systemd / PAM / logind; current full image uses UID 1000 |
| Window manager / Wayland compositor | PollyWM / wlroots | Same implementation | Same implementation |
| Composition renderer | Pixman | Basic CPU/Pixman path | General-purpose graphics path |
| UI execution and layout | QuickJS + Yoga | Same implementation | Same implementation |
| UI rendering | Skia raster-only | Skia; CPU recipe pending | Skia; existing standard-effects4 recipe |
| JS system interface | SysRT / FFI | Same implementation | Same implementation |
| Linux UI Host | SDL3 / Wayland | SDL3 / Wayland | SDL3 / Wayland |
| UI buffer presentation | CPU pixels via Wayland SHM | CPU / SHM target; integration pending | Existing paired graphics path |
| Fonts and text | DejaVu Sans + Mono; Fontconfig / FreeType / HarfBuzz / ICU | Add Chinese fonts; inventory TBD | Chinese support retained; existing broad fonts |
| Input method engine | Not compiled | Reuse Rime path; integration pending | Rime |
| GPU / 3D components | ❌ Mesa / LLVM / WebGL2 / WebGPU | ❔; no vendor acceleration | Existing Mesa/LLVM closure; WebGPU not enabled by this recipe |
| Common CLI commands | Basic BusyBox/Foot set | TBD | Full utility group: files, archives, process/network diagnostics, editors, download/SSH clients, Git |
| Wired Ethernet firmware | Minimum necessary set | Basic set TBD | Common Intel/Realtek/USB Ethernet modules plus Realtek firmware; DHCP/DNS service |
| Wi-Fi drivers and firmware | Not integrated in current image | TBD | Intel/Realtek/Qualcomm Atheros/Broadcom-Cypress/MediaTek open-driver paths and firmware; iwd |
| Audio drivers and hardware configuration | Not integrated in current image | TBD | HDA/Realtek/HDMI/USB, Intel SOF/SST, AMD ACP and Cirrus paths; SOF/Intel/Cirrus firmware, ALSA UCM/topology and existing PipeWire core |

A SKU name does not automatically imply audio, networking, PAM/login,
installation, persistence, or updates. These have implementations in the
existing full system, but their required scope in the new tiers remains to be
defined. The Decorator and minimum application set must also be explicitly
specified, packaged, and started. Mini's existing Alpine recipe integrates the basic application
set below; corresponding choices for the other new tiers are not finalized.
Including a Shell or copying JS resources does not establish their delivery.

The UI Host creates application windows, receives input, and submits rendered
buffers to PollyWM over Wayland. It is not the compositor or a graphics-card
driver. Wayland SHM submits CPU-rendered pixels through shared memory; a GPU
presentation backend is a separate build/runtime choice. Shared Host source
does not imply identical SDK binaries, build options, or delivery readiness.

## 3. Current Mini Delivery Status

The current **65.29 MB** Mini image was rebuilt with explicit Mini identity,
branding, filenames and boot reports. SHA-256:
`92389a08e6833c595b30fca7da2f248e905edef9d1655cc27a55558125faa899`.
Delivery: `D:\temp\PollyOS\mini-92389a08e683\mini.iso`.
The previous 60.87 MB image and its limited physical-machine observation remain
historical evidence, not physical qualification of this new build.
The new `--os mini` entry selects the same Alpine recipe used for this build.
This build used its direct shell entry because the host had no Node.js; no host
packages were installed. The old 65.29 MB Micro ISO, SHA-256
`3e2090a252234ab7cb85d03a4fff295710d875fdcb3c6c9ec8861a2548b03eb2`,
is preserved and has not been relabelled.

| Feature / Component | Current status | Evidence or gap |
|---|---|---|
| PollyWM | Running | Actual DRM/Pixman startup records in QEMU |
| UEFI GOP / simpledrm display | QEMU passed; new physical retest pending | Standard VGA + USB test; only the previous 60.87 MB Micro image has limited P1000 user-reported success |
| Virtio display / keyboard | QEMU passed | Separate boot report for the same ISO |
| UI Shell / wallpaper | Integrated | Startup calls shared `createDesktopShell` |
| Desktop bar | Visible in QEMU; application-menu pointer click exercised | Actual panel dimensions are logged. The old physical missing-bar report still requires a retest; no invented hardware-specific cause or fix |
| Welcome window / text field | Delivered | Actual keyboard and pointer input exercised |
| Input caret blink | Included from main commit `8a064d5a` | Shared 530 ms rAF behavior; visible/hidden phases observed in both ISO profiles; shared pixel/edit/IME regressions passed |
| Decorator / window title bars | Integrated; QEMU ready | Shared windowless renderer; maximize, restore, minimize, switch, and close exercised |
| Files / Settings / Processes | Packaged and registered; QEMU launch/close passed | Home directory listing, owned Settings handshake, and live process rows observed; not exhaustive application qualification |
| Foot terminal | Standalone terminal packaged; QEMU launch, shell input, and exit passed | Separate terminal artwork; Foot Server/Client menu entries hidden; no foot server started |
| Application icons / menu entries | Updated | Processes uses activity-monitor artwork; Foot uses terminal artwork; registered Settings no longer duplicated |
| Canvas 2D | Implementation and CPU path retained | Dedicated qualification and performance checks on this ISO / physical hardware pending |
| Chinese / input method | ❌ Excluded | Build and packaging boundaries agree |
| 3D / WebGL2 / WebGPU | ❌ Excluded | Compiled out; installing a graphics driver alone cannot restore them |
| Login / system services | UID 1000 via seatd; no authenticated login; incomplete services | Ordinary-user desktop preserves Files' refusal of root/setid operations; no PAM/logind, installer, audio core, or network-management service qualification |
| Multiple outputs / hotplug / suspend-resume | Not qualified | Single-display startup success does not cover them |

This image provides the basic interactive desktop and applications, **not a
complete production system**. Closing the welcome window leaves the desktop
running. User observations and automated QEMU evidence are tracked separately;
visible output is not proof of a fully verified physical driver chain.

## 4. Other Tier Delivery Boundaries

| SKU | Delivery status under the new definition |
|---|---|
| Compact | New Debian Chinese Shell + basic-display recipe not integrated; `--os compact --plan` is blocked and `--build` fails before external commands. Historical `thin` and minimal-zh images are not Compact deliveries |
| Standard | New `standard.yaml` selects `standard-effects4` and internal `full` hardware. The Wi-Fi/audio-expanded Full-profile ISO is 865.88 MB and USB image 918.55 MB; their actual identity remains `full`, built through frozen-runtime profile assembly, not the new configured product entry |

The current Full image is at `D:\temp\PollyOS\full-wifi-audio-0f142c34a948\`.
ISO SHA-256: `0f142c34a9488d6f770c52f30184bf6d847e011d83cdd5ac608b3fe3675dce9d`.
It retains Nouveau/GP107/Mesa and wired networking, adds multi-vendor Wi-Fi and
audio firmware plus ALSA UCM/topology, and checks 53 required module paths and
63 command entry points. Its unchanged-condition ISO rerun and first read-only
USB lane passed the UID 1000 desktop, Chinese input, clipboard and workspace
checks. The initial ISO run missed its Chinese commit marker; that failure is
retained, not labelled as fixed or first-pass success.

The USB lane also passed emulated e1000e DHCP, gateway ping and system DNS,
and enumerated ALSA playback/capture devices. It did not play audible sound or
capture a microphone. Ordinary-user ping uses GID-1000 ICMP datagram permission,
not added setuid or raw-socket privileges. Actual Wi-Fi association, physical
audio and hardware compatibility remain unqualified.

Physical P1000 output/acceleration and real Ethernet remain untested. The stock
Debian kernel does not provide Mini's simpledrm fallback. Media/runtime source
revisions, checksums, initial failures and qualification limits are recorded
separately in the [delivery log](SKU-DELIVERY.md); old-image results are not reused.
The previous `full-p1000-a734991cc8fb` image is preserved and does not inherit
the new Wi-Fi/audio firmware/data additions.

Historical filenames, checksums, build entry points, and failure records are
preserved. New configurations must select existing, paired component variants.
Missing implementations or dependencies must block execution explicitly;
renaming, runtime switches, or deleting files do not replace a proper build.
