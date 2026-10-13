# GPU Canvas and WebGL2

`canvas.getContext("webgl2")` uses a real, owned EGL OpenGL ES 3 context and an
offscreen color/depth/stencil framebuffer on Windows and Linux. Canvas remains
an element in the ordinary DOM. There is **no canvas-specific native window,
hidden SDL window, browser engine, or SysRT graphics bridge**.

`"webgl"` and `"experimental-webgl"` are intentionally unavailable, not aliases.
`"webgpu"` is not implemented by this increment. macOS returns `null` for
`"webgl2"`; its UI Metal backend does not provide a WebGL context.

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
| Acquisition | Stable, exclusive 2D/WebGL2 identity; real backend failure returns `null` and schedules `webglcontextcreationerror`; actual context attributes | Single-sample `antialias:false`; default power policy, sRGB. No worker or OffscreenCanvas. `display-p3` explicitly rejects. `failIfMajorPerformanceCaveat` is presently a reported `false` policy rather than hardware selection. |
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

GUI-only builds use `PU_BUILD_LAUNCHER=OFF`; `PU_BUILD_DESKTOP=OFF` remains valid.
`PU_WEBGL2=OFF` disables the backend. Enabled Windows builds need matching
`EGL`/`GLES3` headers (the existing Skia ANGLE headers are sufficient) and the
application-local `libEGL.dll`, `libGLESv2.dll`, `d3dcompiler_47.dll` at runtime.
Linux uses system EGL/GLES3 headers and runtime shared libraries.

The tested Windows DLLs are development copies of an already installed browser
ANGLE candidate, **not an official redistributable vendor package**. Do not
include them in a release based on these tests. They report ANGLE 2.1.27746 /
`355cc61af2aa`, Microsoft Basic Render Driver / D3D11 (software). Linux tests use
the immutable SDK image `4ef0cd4e096e79eedc8310c9cc87897fc5db778a6e68401e2ee7a56a64555cfb`,
UID 1000, private Linux filesystem/Wayland sockets, Mesa 26.1.6 and llvmpipe
(software). No shared SDK rebuild, image tag change, browser installation,
desktop/RDP screenshot or physical-GPU certification is implied.

The optional Three.js fixture installs **0.180.0/r180** from its own manifest:

```powershell
Set-Location gui\tests\gpu
npm ci --ignore-scripts --no-audit --no-fund
Set-Location ..\..\..
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
| `gui-gpu-current` | Owning EGL handles/state restored across multiple canvases, draw/read/resize/close; Linux uses actual borrowed Skia GLES composition/readback |
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
