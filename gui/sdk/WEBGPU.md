# Native WebGPU implementation status

This is an **opt-in implementation checkpoint**, not complete WebGPU or
Three.js scene coverage. `PU_WEBGPU` defaults to `OFF`. Native textures,
render pipelines, canvas presentation and unmodified Three.js r180
WebGPURenderer scenes are exercised on Windows D3D12 and Linux Vulkan.
The remaining core semantics, scene coverage and platform qualifications
are still being implemented. Do not count the qualified cases as complete
WebGPU support or physical hardware qualification.

The GUI engine uses QuickJS and a native Dawn provider, not a browser,
Chromium/Electron, WebGL fallback, native window canvas or SysRT graphics API.
Dawn is pinned to `v20261009.190412`, source
`c943ea32b614ff53e4fe410fc8f4968b6b8fe46d`; the vendor archive and DXC hashes
are in `third_party/dawn-manifest.json`.

## Acquisition and build

Run CMake's script with `PU_DAWN_PLATFORM` set to `windows-x86_64`,
`linux-x86_64`, `macos-arm64` or `macos-x86_64`, and private absolute paths for
`PU_DAWN_CACHE` and `PU_DAWN_DEST`:

```powershell
cmake -DPU_DAWN_PLATFORM=windows-x86_64 -DPU_DAWN_DEST=C:\private\dawn `
  -P tools\fetch_dawn.cmake
```

Configure the existing GUI-only build with `PU_BUILD_LAUNCHER=OFF`,
`PU_WEBGPU=ON` and `PU_DAWN_ROOT` pointing to that destination. Existing
Skia/host prerequisites still apply. The provider and Windows DXC DLLs are
staged beside the executables in the GUI build directory. Dependency
acquisition is explicit; configuration never downloads libraries.

On Windows the official Dawn library's dynamic CRT stays in the `/MD`
provider DLL, while the GUI and Skia retain `/MT`. The host uses a complete
typed C procedure table, checks the provider ABI and checksum-pinned API
header fingerprint, and releases Dawn allocations only through Dawn's
native release/free-member procedures. WARP selection uses the official
`dawn::native::d3d::RequestAdapterOptionsLUID` in the `/MD` provider; the host
passes only scalar LUID parts across that boundary. The fingerprint normalizes CRLF to LF
because the verified Windows and Linux archives otherwise contain identical
headers with different line endings. No linker CRT suppression is used.

## Implemented and exercised paths

The current fixtures exercise native adapter/device/queue creation, native
features and limits, buffer creation, typed-array view-relative `writeBuffer`,
WGSL shader compilation and diagnostics, synchronous and asynchronous compute
pipelines with override constants, bind groups, command encoding/submission,
compute dispatch, buffer copies, asynchronous mapping/queue completion, real
error scopes and real destroyed-device loss. Render cases cover actual
indexed/depth/textured rendering and exact texture readback pixels.
Additional cases exercise native render bundles and indirect draws, occlusion
and timestamp queries, clear/resolve commands, WGSL language feature discovery
and immediate-address-space compute with view-relative immediate data.

The pinned standard `TRANSIENT_ATTACHMENT` usage (0x20) is an optimization hint,
not an optional public feature. When the actual adapter supports Dawn's private
`TransientAttachments`, device creation enables it privately. Otherwise the
implementation allocates an ordinary native render attachment while preserving
the public transient usage. Both paths enforce the same texture/view restrictions,
clear/discard requirements and prohibition on transient resolve destinations.
Invalid textures/views are native error resources and invalid passes poison the
native encoder; an error notification alone is not considered validation.
Canvas configuration rejects this usage synchronously with `TypeError`.
`PU_WEBGPU_TRANSIENT_ALLOCATION=ordinary` deliberately forgoes the native
optimization for qualification or diagnostics; the default (`native`) uses it
when supported. This changes actual device feature enablement/allocation, never
adapter capabilities or the public feature list. `gui-webgpu-core-norm` and
`gui-webgpu-transient-ordinary` exercise the same real resolve-green pixels and
invalid-resource/command-buffer cases under both allocation policies.
`PU_WEBGPU_TRACE_TRANSIENT=1` additionally records the actual native device's
private-feature enablement and each valid transient texture's native/logical
usage; the two qualification lanes enable this diagnostic explicitly.

The HTML canvas uses one independent, owned source slot with copied C ABI
operations. Resize stages the raster allocation before committing source
dimensions. Failed attachment retains caller ownership; successful attachment
releases its source once. Native readback supplies top-left unpremultiplied
sRGB RGBA8 to the existing Skia compositor, snapshots and exports. There is no
native child/hidden canvas window or desktop screenshot. Internal Dawn copy
usage is kept separate from the public canvas texture usage. Readback is
synchronous CPU composition, not zero-copy. Retained display revisions and
current-texture generations are separate.
`getConfiguration()` returns captured IDL-converted enum strings and usage flags,
with fresh view-format and tone-mapping copies. Conversion caches requested
dictionary fields with their original getter receiver, does not enumerate unknown
members, and does not retain mutable string-conversion input objects. A conversion
failure, including forbidden transient usage, preserves the prior configuration.
RGBA16F and Display-P3 sources additionally retain an unclamped, unpremultiplied
linear-sRGB RGBA16F image before converting separately to the existing sRGB8
raster display. GPU image copies consume that original high-precision snapshot;
they do not up-convert an already clipped byte snapshot. The optional source
`read_f16` callback extends the copied opaque C ops without platform types.
Row reads have exact `width*4` or `width*8` byte lengths and preserve native
snapshot ownership throughout synchronous upload. Snapshot buffers are capped
at 64 MiB; high-precision cached backings are consequently capped at 8 Mi pixels.
Terminal canvas-map buffers are released immediately rather than retained
until VM shutdown; pending callback userdata survives until completion/cancellation.
Only commands or direct writes targeting the current canvas texture generation
invalidate its snapshot and DOM paint. Empty submissions, unrelated compute
and other canvases on the same device preserve the completed display frame.
Every source callback is guarded against reentrant slot replacement; a
callback that closes the canvas stops subsequent reads. Canvas mutation
validation is completed natively before publishing, with captured errors
reinserted before the call returns to preserve application scope ordering.

Provider loading is lazy. A configured `PU_WEBGPU=ON` GUI with its provider
missing still supports Canvas2D; actual WebGPU acquisition rejects with the
native loading error. Enum inputs use exact pinned specification spellings.
Finite `[EnforceRange]` fractions truncate before checked conversion.
Same-brand cross-device resources reach native GPU validation/error scopes,
while wrong resource brands remain TypeErrors.

Resource handles are opaque and device-branded. JavaScript integers are
checked before native unsigned conversion. Native callbacks copy results to
owned records; promises and error events execute only in the GUI script pump.
Pending native operations keep the script loop alive, without making a
device's permanently pending `lost` promise an idle-loop producer.

Mapped ranges are **JS-owned CPU copies**, not zero-copy pointers into
driver-owned memory. Writable ranges are copied into the actual native map
at `unmap`; read-only ranges come from the actual native mapped buffer.
Overlapping or misaligned ranges fail. Unmap, buffer/device destruction and
loss detach mapped ArrayBuffers and their aliases. This deliberately avoids
native loss invalidating memory behind a live JavaScript TypedArray.

## Qualification is not hardware availability

The native backend is D3D12 on Windows, Vulkan on Linux and Metal on macOS.
`PU_WEBGPU_DEVICE=software` explicitly requests a qualification adapter; the
default does not hard-code WARP or silently switch to WebGL. On Windows
explicit software selection uses the DXGI WARP LUID and verifies DXGI flags.
The explicit CPU qualification policy is distinct from the standard
`forceFallbackAdapter` preference: Dawn's fallback filter can reject native
llvmpipe despite reporting it as CPU. CPU qualification verifies the actual
returned adapter instead; it never accepts a hardware adapter as software.
On Metal the JS fixtures use the default native adapter, while an unavailable
CPU qualification adapter is reported separately.
Synthetic/remote Microsoft adapters can be reported by Dawn as IntegratedGPU
and are not physical hardware qualification.

`gui-webgpu-native-hardware` exits 77 for a CPU/synthetic/remote adapter.
A skipped hardware fixture is not a passing physical GPU result. The current
macOS archive pins are acquisition inputs only: architecture, native build,
Metal runtime and physical GPU qualification remain separate gates. The pinned
arm64 and x86_64 packages have been inspected as 656 actual Mach-O members each;
defined native WebGPU C API symbols and imported Metal framework link metadata
are present. This is not a native Mac compilation, Metal execution or physical
GPU result.

## Redistribution gate

The official release archives omit full bundled dependency notices.
Acquisition stages Dawn's original license and Windows DXC's original
licenses, plus nine checksum-pinned original notices for Abseil, SPIRV
tools/headers, Vulkan headers/utilities, RenderDoc's API header and the
EGL/OpenGL/DirectX header inputs. Abseil's upstream license is byte-identical
to the pinned Chromium mirror. Vulkan's attribution summaries reference the
Apache-2.0 text included with the collected Abseil/SPIRV-Tools licenses; they
are not themselves full license texts. This is a conservative common input set,
not a claim that every listed header is compiled on every platform.

**Third-party notice collection is not complete**: per-platform compiled,
header/generated-source and nested attribution closure, along with applicable
compiler/SDK/runtime redistribution terms, still require review. The
manifest explicitly keeps redistribution blocked; do not package or
redistribute this checkpoint as a completed native dependency bundle.

## Owned VideoFrame subset

`VideoFrame` currently owns copied RGBA/BGRA BufferSource pixels with coded,
visible and display dimensions, timestamp/duration, explicit plane layout,
crop, copyTo, clone and close. It is not a full WebCodecs implementation:
there is no HTMLVideoElement, video decoder, browser networking or animation
desktop application. This checkpoint tests actual ownership, crop, stride,
view offsets and closed-state errors. Real Dawn external-texture bindings and
WGSL `texture_external` sampling are exercised, not a disguised ordinary
2D texture. A private branded source capability supplies owned snapshots to
Canvas2D, WebGL2 and WebGPU external-image copies. RGBA/BGRA, visible crop,
display-size scaling, clone/close, forged-source rejection and native readback
are covered. WebGL's existing unpack flip and premultiply settings apply to
that same snapshot. PNG decoding and Canvas/Image transfers are also exercised.
Native external-image copies validate actual render-attachment/copy-destination
usage and color-format capabilities, and exercise 17 unorm, float and packed
destination formats on the qualification adapter. Conversion uses Skia color
parameters and Dawn's native copy shader. Source P3 gamut, linear/BT.709
transfer, limited-range RGB, partial alpha and destination P3 are exercised,
including negative and greater-than-one float output. Canonical VideoColorSpace
metadata feeds the owned source instead of silently being treated as sRGB.
Plane/crop/allocation validation is shared by copyTo and allocationSize;
CPU frame close remains idempotent even after native GPU shutdown.

The broader original Three case covers indexed geometry, DataTexture,
CanvasTexture, locally decoded PNG Image, the existing owned PNG Bitmap,
genuine VideoFrameTexture external bindings, native RAF-driven directional PBR
lighting, original TSL compute, backing/target resize, actual device loss and
new-device renderer recovery, and asset disposal before renderer disposal.
There is no `createImageBitmap`, video decoder or browser facade added for this
case. A mapped Wayland fixture additionally checks real 300x240 client pixels at
1.5 DPI, logical pointer coordinates, rounded clipping, ancestor scroll,
translation and opacity using the existing compositor test contract. Shadow
scenes, further image metadata qualification, native Mac/Metal and physical GPU
qualification remain pending; this is not full browser or WPT conformance.

GPUDevice is a genuine privately initialized EventTarget. Native uncaptured
errors use branded GPUUncapturedErrorEvent/GPUError payloads and device loss
returns branded GPUDeviceLostInfo. User dispatch is untrusted; native dispatch
is private. The minimal independent Event surface supports cancellation,
capture/once/passive/signal/removal and reentrant-dispatch protection. It does
not replace the existing DOM node event implementation or claim a full browser DOM.

The script environment exposes its real global `self`, its native animation
callbacks and a native monotonic `performance.now()` subset. Unhandled
promise rejections are reported at microtask checkpoints rather than silently
leaving a renderer initialization promise pending.

## Coverage accounting

The fixed `gpuweb/gpuweb` input is commit
`25a5dc4537074c9b3844dd95891f5cfd193f4407`. Its current mechanical inventory
counts 36 concrete GPU interfaces (including `WGSLLanguageFeatures`) and
57 dictionary declarations. Six mixins are folded into the interfaces that
include them, not counted as additional concrete interfaces. Navigator/worker
environment interfaces and constant namespaces are not interface denominators.
The 211 prototype checks include inherited members and repeated overload names;
they are **not 211 independently qualified behaviors**.

Behavior qualification is separate and bounded to actual fixture assertions:

| Family | Actual outcome and evidence |
| --- | --- |
| Acquisition, limits and brands | Native features/limits, required-limit rejection and receiver checks: `webgpu-compute.mjs`, `webgpu-review.mjs`, `webgpu-core-norm.mjs` |
| Buffers and mapping | Native compute/map roundtrips, alias detachment and live-resource shutdown: `webgpu-compute.mjs`, `webgpu-lifetime.mjs`, `webgpu-shutdown.mjs` |
| Descriptor and overload conversion | Original getter receiver, single iterator lookup, species-free typed offsets yielding 17, sparse layouts, direct texture sample 255, and 2/3/4/5-argument buffer copies: `webgpu-core-shapes.mjs` |
| WGSL and pipelines | Native diagnostics and sync/async pipeline success/failure: `webgpu-compiler.mjs`, `webgpu-compute.mjs`, `webgpu-render.mjs` |
| Textures and image transfers | Exact readback pixels, 17 destination formats, native external textures and color transforms: `webgpu-texture.mjs`, `webgpu-image-formats.mjs`, `webgpu-external.mjs`, `webgpu-color-source.mjs` |
| Render commands and queries | Indexed/depth/textured pixels, render bundles/indirect draws, native occlusion/timestamps and immediate compute: `webgpu-render.mjs`, `webgpu-bundle.mjs`, `webgpu-query.mjs`, `webgpu-immediate.mjs` |
| Standard transient hint | Native and ordinary allocation, green MSAA resolve, actual error resources/command buffers and usage/load/store constraints: `webgpu-core-norm.mjs` under both allocation policies |
| Canvas lifecycle/configuration | Actual dirty revisions, retained frames, independent scope ordering, canonical configuration, true F16 retention and resource bounds: `webgpu-canvas-mutation.mjs`, `webgpu-core-shapes.mjs`, `webgpu-canvas-hdr.mjs`, `canvas-source.cpp` |
| Events and loss | Native trusted errors, user untrusted dispatch, brands and loss/shutdown ordering: `webgpu-events.mjs`, `webgpu-review.mjs`, `webgpu-shutdown.mjs` |
| Original Three and native UI | Unmodified renderer textures/PBR/TSL/resize/loss recovery and real mapped 1.5-DPI pixels/input: `webgpu-three-scenes.mjs`, `webgpu-window.mjs` |
| Runtime packaging and disabled mode | Executable-relative relocation, distinct ABI/header/proc failures, real 2D preservation and both-backends-OFF builds: `webgpu-runtime.cmake`, `webgpu-missing-runtime.mjs`, `gpu-unavailable.mjs`, `canvas.mjs` |

These are family-level evidence links, not a claim that every overload,
dictionary combination, optional feature or validation branch has independent
coverage. Optional features are enabled only when actually supported. Native
Mac builds/Metal execution, physical GPUs, full vendor notices and broader
browser/Three scene coverage remain unqualified; mechanical presence does not
close any of those gates.
