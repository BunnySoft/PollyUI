# Canvas 2D, GPU Canvas and Image / img

The GUI library installs `HTMLCanvasElement`, `CanvasRenderingContext2D`,
`HTMLImageElement`, `Image`, `Path2D`, `CanvasGradient`, `CanvasPattern`,
`ImageData`, `TextMetrics`, `DOMMatrix`, `DOMPoint`, and `Blob`. No import,
SysRT dependency, HTML parser, separate native window, or GPU context is needed.
This is a defined Canvas 2D compatibility subset, **not a browser or full WPT
implementation**. SVG **path syntax** in `Path2D` does not add SVG image or SVG DOM support.

Windows/Linux additionally provide owned offscreen **WebGL2** contexts through
the same DOM Canvas element. See [the native GPU/API/qualification matrix](WEBGL2.md).
Context selection is exclusive and stable. WebGL1 (`"webgl"` and
`"experimental-webgl"`) remains unavailable; WebGPU is not implemented here.
WebGL backing readback participates in the existing snapshot/drawImage/export
paths without creating another native window.

```js
const canvas = document.createElement("canvas");
canvas.width = 480;
canvas.height = 240;
canvas.style.width = "480";
canvas.style.height = "240";
document.body.appendChild(canvas);

const ctx = canvas.getContext("2d");
ctx.fillStyle = "cornflowerblue";
ctx.beginPath();
ctx.roundRect(20, 20, 160, 100, 12);
ctx.fill();
ctx.font = "20px sans-serif";
ctx.fillStyle = "white";
ctx.fillText("Canvas 2D", 35, 65);

const image = new Image();
image.src = "./photo.jpg";
await image.decode();
ctx.drawImage(image, 220, 20, 120, 100);
const png = canvas.toDataURL("image/png");
canvas.toBlob(blob => { /* blob.arrayBuffer() contains encoded PNG bytes */ });
```

Run the self-contained, animated example from the repository root:

```powershell
.\build\canvas-win\gui\pollyui-playground.exe gui\examples\canvas.mjs
```

On Linux use the GUI-only `pollyui-playground gui/examples/canvas.mjs`.
It combines paths, gradients, text, PNG drawImage, a JPEG DOM img, animation,
and pointer input in the application's ordinary window. Its image resources
are generated in memory, with no external downloads.

## Actual API matrix

| Area | Implemented | Boundaries |
|---|---|---|
| Canvas element | `createElement("canvas")`, standard prototype, width/height properties and attributes, `getContext`, `toDataURL`, `toBlob` | Default backing is 300 x 150. Both dimensions reset pixels, path, clip, transform, saved states, and drawing styles even when assigned the same value. Zero-sized exports are `"data:,"` / `null`. |
| Context acquisition | Stable, exclusive `"2d"` / `"webgl2"` selection; `canvas`; `getContextAttributes`; opaque `alpha:false`; `isContextLost()` | 2D is raster sRGB / RGBA8; attributes report actual alpha, colorSpace, colorType, desynchronized, willReadFrequently. Unsupported color spaces / float16 reject. WebGL2 has a separate actual matrix. `"webgl"`, `"experimental-webgl"`, `"webgpu"`, `"bitmaprenderer"` return `null`. Raster 2D contexts do not experience GPU loss. |
| State and transforms | `save`, `restore`, `reset`, `translate`, `rotate`, `scale`, `transform`, `setTransform`, `resetTransform`, `getTransform` | Affine 2D. Current path is not saved/restored; segments retain their creation transforms. Singular transforms suppress drawing; move/line/curve/rect/ellipse path construction remains defined. `arcTo` while the current transform is non-invertible is not implemented. |
| Rectangles and paths | `clearRect`, `fillRect`, `strokeRect`, `beginPath`, `closePath`, `moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect` | `roundRect` accepts one to four scalar or `{x,y}` radii, flips corners for negative dimensions, and scales oversized radii. Negative arc radii and invalid roundRect radii report standard error names. |
| Path2D and clipping | Empty/copy/SVG-path-string constructors; all path methods; `addPath` with a 2D matrix; `fill`, `stroke`, `clip`, `isPointInPath`, `isPointInStroke` overloads; nonzero/evenodd | Clip is part of saved state. Coordinates for hit queries and pixel reads are backing coordinates, not DOM pointer coordinates. No SVG image/DOM/XML parsing. |
| Lines | `lineWidth`, `lineCap`, `lineJoin`, `miterLimit`, `setLineDash`, `getLineDash`, `lineDashOffset` | Invalid numeric/style assignments leave the prior value. Odd dash arrays are doubled; getter returns a copy. |
| Paint | Hex RGB/RGBA, rgb/rgba, hsl/hsla, all CSS named colors and transparent; fill/stroke styles; linear/radial gradients with sorted multi-stops; image/canvas/bitmap patterns; pattern `setTransform` | No CSS variables, system colors, `currentColor`, CSS Color 4 wide-gamut functions, or conic gradients. CSS named-color data is shared with DOM painting. Pattern sources are retained snapshots. |
| Effects | `globalAlpha`; standard Porter-Duff and artistic `globalCompositeOperation` values; `shadowColor`, `shadowBlur`, shadow offsets | Copy and destination-in affect the full current clip, including outside the drawn shape. Shadows use Skia's blur kernel; exact browser blur-edge parity is not claimed. `filter` is absent. |
| Text | `fillText`, `strokeText`, `measureText`, read-only TextMetrics fields, font, textAlign, textBaseline, direction; maxWidth; Unicode fallback | Reuses the DOM's font discovery/fallback. Linux's existing HarfBuzz/ICU shaping is used, including paragraph direction; other builds retain their existing simple-text shaping limitations. Outlined color-bitmap emoji, variable-font axes, font loading APIs, CSS font shorthand beyond size/family plus optional slant/weight, letterSpacing, wordSpacing, textRendering and fontKerning are not implemented. Hanging/ideographic baseline metrics use font-metric approximations, not script-specific browser baseline tables. |
| Images and pixels | Three standard `drawImage` overloads; img/Image, canvas, and existing owned Bitmap sources; self-copy snapshots; smoothing enable; ImageData RGBA8/create/get/put, negative/outside/dirty rectangles | Reads/put ignore transform, clip and drawing styles. RGBA8 is unpremultiplied at the JS boundary; native pixels are premultiplied. Fractional-alpha roundtrips have 8-bit premultiplication quantization. `imageSmoothingQuality` preserves its standard state value; low/medium/high currently use the same linear sampling. No ImageBitmap API, video, SVG/GIF/WebP images or worker canvases. |
| Export and Blob | In-memory PNG and JPEG `toDataURL` / asynchronous `toBlob`; PNG fallback for unsupported output MIME; JPEG quality; Blob size/type/arrayBuffer/text/slice | JPEG flattens alpha onto black. Blob holds copied bytes, not a filename. Blob streams and object URLs are absent. |
| Geometry objects | DOMMatrix affine 2D values, aliases, identity/is2D, arrays, multiplication, translate/scale/rotate/inverse/point transforms; DOMPoint | Six-component constructor input and 2D-compatible 16-component input; public toFloat32Array/toFloat64Array return standard 16-component column-major 4x4 arrays. matrix() strings remain six-component affine syntax. No 3D matrices, perspective, DOMMatrixReadOnly or DOMPointReadOnly. |
| DOM img | `createElement("img")` and `new Image(width?,height?)`; src/currentSrc, width/height, naturalWidth/Height, complete, decode; load/error listeners and onload/onerror; intrinsic layout and actual DOM painting | The surrounding DOM/CSS remains PollyUI's Yoga-based subset, not full browser DOM/layout. Width/height attributes are presentation hints, overridden by CSS. Natural dimensions do not change with display size. onload/onerror run after registered listeners in the existing bridge; property-handler registration-order parity with browsers is not claimed. |
| Modern APIs | WebGL2 is documented separately; other APIs explicitly outside this stage | OffscreenCanvas, transferControlToOffscreen, workers, WebGL1/WebGPU, full DOM/CSS, browser-origin security, SVG images/DOM, canvas accessibility/hit regions, HDR/wide-gamut/float16, createConicGradient. GPU context-loss events do not imply loss for raster 2D. |

## Image sources, timing, and safety

Image loading supports static PNG/JPEG bytes through these source forms.
Decoded pixels are normalized using the codec's encoded origin, including all
eight JPEG EXIF orientation values; natural dimensions, layout and `drawImage`
use the oriented dimensions and pixels. Absent or unreadable orientation
metadata follows the codec's top-left fallback:

| Source | Behavior |
|---|---|
| Relative local resource | Resolved against the actual application entry script's directory, including relocated module-root entries. URL-style relative names support percent-encoded UTF-8. Literal `getAttribute("src")` is preserved; `src` resolves to a canonical local file URL. |
| Absolute local pathname | Desktop compatibility extension using the process's existing file permissions, not a browser sandbox. `src` becomes a canonical file URL. Use file URLs for names containing URL fragment/query delimiters. |
| `file:///...` / `file://localhost/...` | Percent-decoded UTF-8 local paths; NUL, malformed percent encoding, nonlocal authorities, UNC/device namespaces and Windows remote drives are rejected. Windows reparse-point paths and alternate data streams are rejected instead of following them into potentially remote resources. |
| `data:image/png;base64,...` / `data:image/jpeg;base64,...` | Owned, copied data; the declared MIME does not bypass native PNG/JPEG validation. |
| HTTP(S), other schemes/formats | `error` delivery and `decode()` rejection with `EncodingError`. GUI-only ScriptEngine has no fetch. No SysRT/network dependency or implicit remote access is introduced. |

`src` changes immediately discard old dimensions/pixels and invalidate prior
decode requests. Load/error delivery is scheduled as a ScriptEngine task,
after currently queued promise microtasks. Generation checks prevent stale
requests from delivering old success. `decode()` resolves only for the current,
decoded image and rejects for source changes or errors. This is a task-based
desktop loader, not the browser networking/HTML image-request state machine.
It requires the GUI ScriptEngine event loop; a standalone raw QuickJS bridge
without its scheduler cannot load images or deliver `toBlob`.

File opening, complete decoding, and encoding currently run **synchronously on
the owning UI thread**; only notification/callback delivery is asynchronous.
There is no foreign-thread QuickJS access or borrowed temporary byte pointer.
POSIX readers check regular files, then open nonblocking and revalidate the
descriptor, rejecting FIFO, device, directory and socket sources. Windows
readers reject special path forms/reparse points and require disk file handles.
These checks avoid knowingly waiting on pipes/devices, but regular file access
on mounted network filesystems or slow disks may still delay the UI. This is
not an OS access-control or filesystem-race sandbox.

Safety limits are **16,777,216 decoded/backing pixels per image/canvas** and
**64 MiB of encoded input per image**. Dimensions/length multiplication,
typed-view bounds, complete decoding, and resource ownership are checked
before publication. Limits are image-allocation safeguards, not desktop file
service quotas. Failures do not retain old success or reveal input bytes/URLs.

## DOM integration and lifetime

Canvas backing dimensions are independent of CSS display dimensions and native
window DPI. Rendering scales a snapshot into the node's existing layout box;
it participates in DOM clipping, scrolling, opacity, paint transforms and
events, including the canvas's own rounded media clip. Transform/save state is
independent of the pixel allocation: zero-width/height canvases still construct
paths and answer path queries in their transformed coordinates. Existing
paint-only transform/hit-test behavior is unchanged.
No native window, popup grab, window opacity trick or screenshot is used to
implement canvas. Detached canvases continue to draw/read without a live HWND.

Native backing stores belong to the node; path/gradient/pattern handles have
QuickJS finalizers. Attached nodes root their media state; detached wrappers
trace it and listener callbacks so canvas/context/style/listener cycles are
collectible. Style wrappers retain their owning element; native host references
remain roots until released. Document moves keep context
identity and pixels. Closing a document cancels pending image work still in
its document scope (including detached elements) without cancelling another
document's moved elements. Scope identities are stable integers, not borrowed
native window pointers. Closing the
realm rejects pending decode requests, releases media/cache ownership, and
suppresses late load/toBlob callbacks.

## Validation and packaging

`gui-canvas` exercises API shapes, errors, reset/current-path/clip semantics,
pixel channels/alpha/dirty rectangles, all exposed operation families,
PNG/JPEG export and re-decode, local/Unicode/file/data sources, task order,
source generations, GC/native resource counts, document moves/close and
shutdown. Its regular-file/FIFO/socket resources are created on the native
temporary filesystem. It copies the entry script and resources to a relocated
directory before loading them. Tests assert source pixels and DOM-composed
pixels, rather than sampling an RDP desktop.

With Linux desktop test infrastructure enabled, `gui-canvas-wayland` maps a
real SDL Wayland window into the isolated headless compositor, checks its
300 x 240 physical buffer at 1.5 DPI, verifies clip/scroll/CSS sizing and img
pixels, and injects ordinary pointer input in logical coordinates. This test
dependency is optional; `PU_BUILD_LAUNCHER=OFF`, `PU_BUILD_DESKTOP=OFF` still
builds and tests the GUI independently.

The standard API implementation in `gui/sdk/canvas.js` is embedded by CMake into
the GUI library. New `bridge/media.c`, `bridge/image_file.c`, and the private
`render/canvas_c.cpp` seam are included in the engine target. There is no runtime
lookup of the source tree and no additional package/library download. Windows
and Linux use their existing Skia PNG/JPEG codecs and font setup.
