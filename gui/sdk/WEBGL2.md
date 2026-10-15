# GPU Canvas and WebGL2

`canvas.getContext("webgl2")` uses a real, owned EGL OpenGL ES 3 context and an
offscreen color/depth/stencil framebuffer on qualified Windows/Linux backends. A
separate macOS ANGLE Metal provider is implemented and wired for native builds,
but is **not yet compiled or runtime-qualified in this Windows-only workspace**.
Canvas remains
an element in the ordinary DOM. There is **no canvas-specific native window,
hidden SDL window, browser engine, or SysRT graphics bridge**.

`"webgl"` and `"experimental-webgl"` are intentionally unavailable, not aliases.
`"webgpu"` is not implemented by this increment. macOS WebGL2, when built and
provided with its separate ANGLE runtime, is not supplied by Skia's UI Metal
backend. GPU-off/missing-runtime/unsupported-device acquisition returns `null`
and a real creation error, not a fabricated context.

This is an implemented desktop compatibility layer with native behavioral
qualification, **not complete browser/WebGL conformance or a browser security
sandbox**. The fixed Khronos IDL inventory covers all 225 core method names,
247 overload declarations, 559 constants and six attributes, including the
inherited `WebGLRenderingContextBase` methods. That descriptor result is
separate from the behavior tests and does not mean all valid/invalid combinations
or WPT cases passed. No WebGL1 context is created.

## API and behavior matrix

| Family | Native implementation and qualified behavior | Boundaries |
|---|---|---|
| Acquisition | Stable, exclusive 2D/WebGL2 identity; real backend failure returns `null` and schedules `webglcontextcreationerror` with an owned native reason; actual context attributes | Single-sample `antialias:false`, sRGB. No worker or OffscreenCanvas. `display-p3` explicitly rejects. Strict `failIfMajorPerformanceCaveat:true` accepts native-verified GPU-backed devices and rejects CPU/software/unknown types; this is classification, not a benchmark guarantee. Standard `powerPreference` is preserved and only advertised native hints are submitted, without promising an effective performance change. |
| Backing/composition | Owned FBO, width/height independent of CSS and DPI, same-value resize clears storage but preserves GL state/resources, zero size; existing rounded clip, opacity, scroll, transform, input; genuine snapshots to 2D `drawImage`, PNG/JPEG/Blob export | Initial composition reads GPU pixels back and creates a raster Skia snapshot. **Not zero-copy**; readback and encoding run on the owning UI thread. |
| Presentation | `preserveDrawingBuffer:false` clears the native drawing buffer after actual DOM presentation; retained DOM displays the captured frame until new default-framebuffer drawing; opaque default buffers have actual RGB storage | Presentation boundary is PollyUI's DOM paint operation, not a browser refresh driver. Detached canvases are not presented/discarded. |
| State | Clear, color/depth/stencil masks and comparisons, front/cull face, blend factors/equations/color, scissor/viewport, hints, sample coverage, polygon offset, enabled state and natural query results | Backend numeric limits are real queries. The interface does not expose arbitrary GLES extension enumerants. |
| Buffers and VAOs | Owned brands, typed-array/DataView offsets, size-only zero initialization, subdata/copy/GPU readback, array/element binding classification, vertex/index/instance bounds, integer/packed attributes, VAO-retained bindings | Per-resource 64 MiB and per-context 256 MiB tracked resource budget; native default framebuffer and raster snapshots are separate allocations. No client-memory GLES pointers are passed as draw data. |
| Shaders/programs | Actual GLES compile/link/log/reflection; GLSL ES 1.00 and 3.00; source/version/identifier/token validation, real failures; attached/deleted shader retention; relink invalidates uniform locations | Windows requests ANGLE's actual WebGL-compatibility and robust-initialization layers. Linux Mesa has no equivalent ANGLE translator; shared validation plus the actual compiler is **not claimed to implement every WebGL shader packing, preprocessing or structure-depth rule**. Shader-language extensions are not enabled. |
| Uniforms/UBO | All float/int/uint scalar, vector and array setters, square/non-square matrices, natural getters, typed offsets; block indices/layout/active uniforms, binding/base/range and draw-time size checks | Query/fence visibility observes a later ScriptEngine task. No long blocking fence waits; `MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is zero. |
| Texture storage/transfers | 2D/cube/3D/2D-array, mutable/immutable mip levels, initialized storage, pixel unpack rows/images/skips/alignment, real PBO upload/readback, integer/float/packed transfer types, mipmaps and samplers | Actual `ImageData`, decoded PNG/JPEG Image/img and Canvas sources. No video, VideoFrame, ImageBitmap or OffscreenCanvas source implementation. Loader remains local/data only: no GUI fetch, HTTP/CORS or object URLs. |
| Texture source conversion | Source snapshots, flip-Y, premultiply, sRGB, byte/float/half/packed conversion, cropping and stacked images for 3D uploads | Typed-array/PBO uploads reject flip/premultiply combinations forbidden by WebGL2. Wide-gamut/HDR color conversion is absent. |
| FBO/renderbuffer | True attachments and resource identity, core color/depth/stencil formats, multisample allocation/resolve, draw/read buffers, attachment queries, incomplete/duplicate-image/depth-stencil checks, blit/copy/readback | Optional float-render-target extensions are not enabled; their formats are rejected/unsupported rather than borrowing GLES support implicitly. Readback destination limits and outside-FBO zero pixels are checked. |
| Queries/sync/TF | Real occlusion and transform-feedback queries, nonblocking fences/waits/status, interleaved/separate capture binding and varying APIs, begin/end/pause/resume, actual output-buffer readback and output/input/UBO bounds | Individual fixtures validate representative actual results; not every primitive mode, aliasing case or driver-reset path is certified. |
| Resource loss/lifetime | Per-context brand and generation, delete/bound/attachment retention, GC cycles, document moves, close/VM shutdown, cancellation of late exports, actual EGL destruction/recreation and loss/restoration events | `WEBGL_lose_context` deliberately destroys the native context. Successful recreation needs `preventDefault` on the loss event; old-generation names cannot be rebound. Driver loss is handled when observed at a native call/snapshot, not through a background GPU monitor. |
| Core interface/errors | Generated WebIDL minimum arity/function lengths, native wrong-context errors, wrong-kind TypeErrors, all normative lost-context default-return families, real `getError` queue | All core methods have real implementations or standard error behavior. There is no stub-success implementation. This is not exhaustive overload/invalid-input certification. |
| Optional extensions | `WEBGL_lose_context` | No compressed extension is advertised. An empty `COMPRESSED_TEXTURE_FORMATS` is correct before optional extension enablement; ETC2/EAC is GLES3 core but **not default WebGL2 core**. Both software-qualified platforms reject those unenabled formats. No successful compressed rendering qualification is claimed. |

`drawingBufferStorage` supports RGBA8 and SRGB8_ALPHA8, updates real backing
dimensions atomically, and preserves context state. Float drawing-buffer formats
require optional extensions not exposed here. Attribute values describe actual
selected behavior; requesting antialias does not cause a fictitious MSAA buffer.

Context resources are node-owned plus explicitly retained native handles.
Public JS objects retain native handles through traced JS graphs; attached DOM
nodes root media state and detached cycles are collectible. Platform EGL/device
types are private to the C++ implementation; the shared Canvas/DOM C seam does
not expose platform headers. No `eglTerminate` is used on a display shared with
SDL/Skia. Every operation switches to its private context, then releases it and
restores the prior display, context, draw/read surfaces and client API.

## Qualification and dependency provenance

### macOS standalone ANGLE Metal: native execution pending

The separate source pin is ANGLE
`25b559464cb10c557e10aad1e75d1b85ddfef271`; its official received source archive
SHA256 is `5b13a45eaa921dea76f34cea47dec4f1044ba790baa42569e0e2ee5addbb47dd`.
`third_party/angle-metal-manifest.json` also pins depot_tools, the exact DEPS and
license bytes, GN build policy and minimum platform facts. These hashes verify
received official commit-addressed archives, not published standalone binary
release checksums. **No actual macOS compilation, Metal framebuffer pixel,
Three or physical-GPU PASS is claimed yet.**

`tools/build_webgl_angle_macos.py` builds only standalone `libEGL`/`libGLESv2`
with the Metal backend; GL/CGL, Vulkan, SwiftShader, null and WGPU backends are
disabled. It uses a private checkout and DEPS-pinned tools/clang, records actual
dependency revisions, and preserves complete original licenses and header
notices. There is no browser download/install/execution, global SDK/driver
change, or silent source-revision fallback. The existing m124 Skia raster UI
does not need a Metal rebuild.

The selected source's build defaults require macOS SDK **15 or newer**, an
existing compatible Xcode with working `metal`/`metallib`, and deployment target
**13.0**. Xcode 26+ may require the user's already-installed MetalToolchain
component; the script reports missing tools instead of installing it or
accepting Xcode licenses. Its native Metal availability requires
`MTLGPUFamilyMac2`; older Metal-capable models can still be rejected by ANGLE.
Apple Silicon macOS 15.0 with non-ASCII executable paths has an upstream
availability restriction in this exact pin. No workaround silently swaps
providers.

Native acquisition asks for `EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE`. Advertised
`EGL_EXT_device_query`/`EGL_ANGLE_device_metal` supplies ANGLE's actual MTLDevice.
The private Objective-C++ helper uses the official Metal protocol, GPU family,
registry ID (decimal string in diagnostic JSON), low-power/removable/headless/
unified-memory properties. A valid Metal GPU is **GPU-backed, physical status
unproven**; Metal APIs alone do not rule out virtualization. Strict caveat
requests are handled from that native evidence, never renderer substrings.
Standard power hints are submitted only when the matching EGL extension is
advertised **and** the containing app's actual Info.plist has
`NSSupportsAutomaticGraphicsSwitching=true`. CLI tests without that setting
preserve the request but report `powerHintSubmitted=false`.

CLI libraries live beside the executable in `polly-angle/`; `.app` libraries
live in `Contents/Frameworks/PollyANGLE/`. The loader uses executable-derived
absolute paths, `RTLD_FIRST`, and canonical entry-point module checks; it
rejects DYLD search/injection overrides and never searches CWD. The staged
dylibs have application-relative dependency paths and recorded original/
staged hashes plus ad-hoc signatures. Product signing/notarization is separate.
No new canvas native window is created. Owned EGL contexts restore prior
display/context/draw/read/client API even when the UI owns no EGL context.
The Mac-specific isolation fixture also executes an independent native Metal
queue blit before and after GPU readback/resize/loss/close, rather than assuming
absence of global Metal state.

On a real macOS build host with existing SDL3/Skia/Node prerequisites:

```bash
python3 tools/build_webgl_angle_macos.py
cmake -S . -B build/mac-webgl -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DPU_BUILD_LAUNCHER=OFF \
  -DPU_BUILD_DESKTOP=OFF -DPU_HOST=sdl -DPU_WEBGL2=ON \
  -DSKIA_ROOT="$SKIA_ROOT" -DSKIA_LIB_DIR="$SKIA_LIB_DIR"
cmake --build build/mac-webgl
# Restore the optional pinned Three dependency only if missing:
if [ ! -f gui/tests/gpu/node_modules/three/build/three.module.js ]; then
  (cd gui/tests/gpu && npm ci --ignore-scripts --no-audit --no-fund)
fi
bash tools/test_webgl_macos.sh "$PWD/build/mac-webgl" "$PWD/build/mac-webgl-proof"
```

The verifier validates dylib/license receipts and captures real source/object/
embedded-script and native-binary hashes. It runs the same core, nonzero-base/
all-target mutable/immutable mip, texture/pixel, resource/GC/document/loss,
unmodified r180 Three, owning EGL and native Metal queue fixtures, plus Canvas2D.
Only an actual empty native Metal inventory can produce exit 77; ABI/runtime/
configuration/driver/render failures are errors, not SKIP. With no Metal GPU,
positive core/Three cases are explicitly NOT RUN, and no-GPU/2D still runs.
Use `PU_WEBGL2=OFF` for an independent 2D-only build needing no ANGLE headers,
ObjC++ helper or Metal provider. Existing raster-only CI is not a qualification
of this new provider.
Darwin defaults `PU_WEBGL2` to **OFF** while native qualification is pending,
preserving existing raster builds and CI without an ANGLE bootstrap. The
explicit `-DPU_WEBGL2=ON` command above selects the new provider and its
dependencies; Windows/Linux retain their existing ON default. `PU_METAL`
continues to control only the separate Skia UI renderer.

### Windows and Linux qualified stages

GUI-only builds use `PU_BUILD_LAUNCHER=OFF`; `PU_BUILD_DESKTOP=OFF` remains valid.
`PU_WEBGL2=OFF` disables the backend. Enabled Windows builds need matching
`EGL`/`GLES3` headers (the existing Skia ANGLE headers are sufficient) and the
application-local `libEGL.dll`, `libGLESv2.dll`, `d3dcompiler_47.dll` at runtime.
Enabled Windows builds additionally require maintained Vulkan headers; restore
the headers-only pin with `tools/fetch_vulkan_headers.ps1`. The verified Khronos
Vulkan-Headers commit is `b379292b2ab6df5771ba9870d53cf8b2c9295daf`
(v1.3.290). Its manifest records the received official archive SHA256 and
Apache-2.0 OR MIT licenses. No Vulkan SDK/driver is installed; no Vulkan types
cross the Canvas/DOM C seam. `PU_WEBGL2=OFF` needs none of these headers.

Windows defaults to **ANGLE Vulkan hardware** using normal installed-driver
discovery and the native Vulkan loader. No environment setting is required for
ordinary hardware use. ANGLE's advertised EGL device/Vulkan extension supplies
its actual instance, physical device and instance-proc ABI; official
`VkPhysicalDeviceProperties` identifies integrated/discrete/GPU-backed virtual
devices versus CPU/unknown. Renderer strings are not hardware proof.
Virtual devices are labeled GPU-backed, not physically qualified.

Hardware/runtime/configuration failure returns `null` plus creation error,
without silent software or D3D substitution. Hardware policy rejects Vulkan
driver-file/filter environment overrides instead of letting a private ICD
replace normal installed-driver discovery. Explicit process-local
`PU_WEBGL2_DEVICE=software` selects **SwiftShader CPU**, requiring
`vk_swiftshader.dll` and the original relative `vk_swiftshader_icd.json` as well
as the loader. Software qualification is not hardware qualification.
The selected policy remains pinned through context loss/restoration; a shader
or FBO error never causes a provider swap. Neither mode implements JS WebGPU.
Linux uses system EGL/GLES3 headers and runtime shared libraries.

The fixed Windows native bundle is the official Electron **v41.10.7** archive,
SHA256 `43f2f823a263ee7d3ac71282e26c417c9e4417bbefdfa97ede3fde15daf5a46d`,
with matching release-asset digest and independently verified published
SHASUMS256 file. Its ANGLE reports 2.1.27094 / `830fc642200f`; the selected
software renderer reports Vulkan 1.3.0 / SwiftShader Device (Subzero), verified
native CPU type 4, vendor `0x1ae0`, device `0xc0de`.
`tests/gpu/ANGLE-RUNTIME.json` records every extracted native library, ICD and
full license hash. `tools/fetch_webgl_angle.ps1` verifies and stages only those
files; it **does not install or run Electron/a browser**, change a shared SDK,
or set global Vulkan environment/registry settings. Keep the full original
`LICENSE` and `LICENSES.chromium.html` with the libraries. This is an official
Electron bundle containing ANGLE/SwiftShader, **not a standalone official
ANGLE vendor package**; release/legal/platform qualification is separate.

The earlier installed-browser ANGLE 355cc / D3D11 candidate and diagnostic
Electron 37/41 D3D11 candidates returned black generated mip pixels for a
valid nonzero base level in actual ordinary/compatible, mutable/immutable GLES
tests. They are **not qualified WebGL2 backends** and are not silently retried
as fallbacks. Electron 44.7.0 had no standalone EGL/GLES DLLs. Those diagnostic
results and original f905 receipts remain separate from the final Vulkan
qualification. The UI's existing raster/D3D presentation path is unchanged;
tests verify restoring its owning D3D EGL context across private Vulkan context
draws/readback/resize/destruction, including display-scoped handle collisions.

Linux tests use
the immutable SDK image `4ef0cd4e096e79eedc8310c9cc87897fc5db778a6e68401e2ee7a56a64555cfb`,
UID 1000, private Linux filesystem/Wayland sockets, Mesa 26.1.6 and llvmpipe
(software). No shared SDK rebuild, image tag change, browser installation,
desktop/RDP screenshot or physical-GPU certification is implied.

The current Windows execution environment exposes Hyper-V/remote display
adapters but no compatible normal Vulkan GPU driver. Hardware acquisition is
honestly unavailable here; **physical positive qualification remains pending**.
This does not imply Windows or the host machine cannot provide hardware.
For a physical Windows GPU, use the same frozen native/device, mip/pixel,
current-context, lifetime and unmodified Three fixtures:

```powershell
.\tools\test_webgl_hardware.ps1 -Build .\build\gpu-hardware-win -Evidence .\build\hardware-proof
```

Exit 77 means no eligible native hardware environment, or only a GPU-backed
virtual device without physical qualification. Missing libraries, invalid
policy/driver overrides, ABI/query failures and rendering errors fail, not SKIP.
The verifier records actual native IDs/type/API/power hints and runs positive
fixtures directly under hardware policy, never under CTest's software setting.
Existing positive Windows CTests intentionally select explicit software for a
deterministic functional baseline.

The optional Three.js fixture installs **0.180.0/r180** from its own manifest:

```powershell
Set-Location gui\tests\gpu
npm ci --ignore-scripts --no-audit --no-fund
Set-Location ..\..\..
.\tools\fetch_webgl_angle.ps1 -Dest .\build\gpu-win\gui
.\tools\fetch_vulkan_headers.ps1
cmake --build build\gpu-win --target pollyui-gpu-test pollyui-gpu-current-test pollyui-canvas-test
ctest --test-dir build\gpu-win -R "^gui-(gpu.*|canvas)$" --output-on-failure
```

The package lock pins the received tarball's SHA512, with registry SHA1,
SHA256, provenance and original-module hashes in `tests/gpu/dependency-receipt.json`.
The original MIT license is preserved in `tests/gpu/THREE-LICENSE.txt`.
`WebGLRenderer`, `three.module.js` and `three.core.js` are unmodified. The GUI
binary embeds PollyUI's Canvas/WebGL bindings, not Three.js. Only required HTML
namespace/dimensions, `self`, and real AbortController/AbortSignal state/events
were added; this does not create a browser networking environment.

After installing that optional dependency, run the local checkerboard cube
example with the GUI-only playground from the repository root:

```powershell
.\build\gpu-win\gui\pollyui-playground.exe gui\examples\three.mjs
```

The example uses the same unmodified renderer and real CanvasTexture path.
Clicking the canvas rotates the mesh; the ordinary ScriptEngine rAF loop
animates it. The mapped fixture separately checks native input and framebuffer
pixels rather than treating an example window as conformance evidence.

The fixtures are:

| Fixture | Assertions |
|---|---|
| `gui-gpu-api` | Pinned Khronos descriptors/constants, all method minimum arities, all normative context-loss return families; **not positive rendering proof** |
| `gui-gpu`, native `gpu.c` | Exact GPU clear/read/snapshot/export; GC/bound resources/style/listener cycles; moved and closed documents; no late export callback; exact DOM vs 2D composition at 1x/1.5x, own rounded clip/ancestor clip/scroll/transform/opacity, frame discard, VM shutdown |
| `gui-gpu-core` | Actual shader failures, vertex/byte/pack bounds, VAO/FBO initialization, TF values 3/4/5 to 7/9/11, UBO color, query/fence/task visibility, resize/state, destroyed/restored EGL context, old-generation rejection |
| `gui-gpu-transfer` | Actual PBO pack/unpack byte offsets, integer texture/FBO/read/clear, DOM byte/float/half/packed uploads, optional compressed-format rejection, atomic drawing-buffer storage |
| `gui-gpu-state`, `gui-gpu-uniform` | State driver queries, samplers, all scalar/vector/array/matrix uniform families with actual shader values, indexed/instanced draws, copies/outside-zero, MSAA resolve, 3D/array layers, invalidation, deletion |
| `gui-gpu-review` | Independently reproduced cached-getter index/enum failures, query-shadow atomicity/shared occlusion slot, color-space brands, actual-provider strict caveat, actual generated 2D/cube/3D/array and nonzero-base/immutable mip pixels, preserved storage on exact budget rejection |
| `gui-gpu-device-policy`, native device/system inventory verifiers (Windows) | Actual hardware outcome/native error ownership, explicit CPU policy, strict refusal after real classification, immutable restore policy, invalid configuration, normal discovery with/without private software files; physical positives SKIP when genuinely unavailable |
| `gui-gpu-current` | Owning EGL handles/state restored across multiple canvases, draw/read/resize/close; Linux uses actual borrowed Skia GLES composition/readback |
| `pollyui-gpu-mipmap-native-test` (manual diagnostic) | Direct GLES/no JS/no shadow comparison of selected backend vs Windows D3D11 ordinary/compatible mutable/immutable nonzero-base mip pixels; output deliberately makes no PASS/conformance claim |
| `gui-gpu-three` | Unmodified r180 indexed BoxGeometry/material scene, actual DataTexture/CanvasTexture/decoded image, resize, native context loss/restoration/recreated scene, disposal |
| `gui-gpu-wayland` | Real mapped 300x240 physical SDL window at 1.5 DPI, unmodified Three renderer shader, native logical pointer redraw, backing independent of DPI, rounded clip/scroll/transform/opacity equal to 2D |
| Existing `gui-canvas`, `gui-canvas-wayland` | Inherited 2D/image regression |

`tests/gpu/api.mjs` and `sdk/webgl-interface.js` are generated from the licensed
Khronos IDL at `714857a28445e8f5d8d6ae1c78498578009534d8`; input URLs, SHA256s
and license are included. `tests/gpu/report-coverage.mjs` produces a per-method
call/fixture inventory from actual CTest logs. It expressly distinguishes
descriptor checks and exercised calls from comprehensive behavioral coverage.
Keep failed earlier diagnostics separate from the final compiled-source,
embedded-script and binary receipts. Full WPT, all third-party loaders,
physical hardware, macOS, Windows exact desktop alpha and WebGPU are not certified
by these fixtures.
