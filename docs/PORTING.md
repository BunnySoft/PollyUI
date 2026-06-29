# PollyUI — Multi-Platform Porting & Deployment

Two deployment tiers, one codebase:

1. **Tier 1 — SDL3 backend**: Windows, Linux, macOS, **iOS**, Android. One host
   implementation; you write zero Java/Objective-C app code.
2. **Tier 2 — bare embedded Linux**: Wayland *or* DRM/KMS, **no Java, no SDL**.
   For appliances/kiosks/IVI that boot straight into a PollyUI binary.

The raw Win32 host stays as an opt-in backend (zero deps, hand-tuned).

---

## 0. The portability boundary

Only **one** of the five engines is platform-specific. Everything below "Host"
is shared C/C++ and **100% of the app/JS is shared**.

| Layer | Shared? | Notes |
|-------|---------|-------|
| App + components (`js/*.mjs`) | ✅ 100% | reconciler, Vue reactivity, CSS, naive.mjs, forms/dialogs… |
| ScriptEngine (QuickJS-ng) | ✅ | pure C |
| LayoutEngine (Yoga) | ✅ | pure C++ |
| Model (DOM-like) | ✅ | pure C |
| RenderEngine (Skia) | ✅ *logic* | only **surface creation** is per-platform (§2) |
| **HostEngine** | ❌ | window + event loop + input + present (§1) — the only new C per platform |

So porting = **one new host file + one surface-creation path per GPU API.**

---

## 1. The HostEngine contract

Every backend implements the exact interface already defined in
`src/host/win32/window.h`. This is the seam:

```c
typedef struct PuWindow PuWindow;
typedef struct PuWindowConfig { const char *title; int width, height; } PuWindowConfig;

/* draw a frame; w/h are LOGICAL px, scale maps to physical px of `surface` */
typedef void (*PuPaintFn)(PuSurface *surface, int width, int height, float scale, void *user);

typedef enum { PU_POINTER_CLICK, PU_POINTER_DOWN, PU_POINTER_UP, PU_POINTER_MOVE } PuPointerType;
typedef int  (*PuPointerFn)(int x, int y, PuPointerType type, void *user); /* >0 => repaint */
typedef int  (*PuKeyFn)(const char *key, int is_down, void *user);        /* >0 => repaint */
typedef int  (*PuWheelFn)(int x, int y, float dy, void *user);            /* >0 => repaint */
typedef int  (*PuAsyncFn)(void *user);  /* pump microtasks/timers/rAF; >0 => repaint */

PuWindow *pu_window_create(const PuWindowConfig *cfg);
void pu_window_set_paint  (PuWindow *, PuPaintFn,  void *user);
void pu_window_set_pointer(PuWindow *, PuPointerFn,void *user);
void pu_window_set_key    (PuWindow *, PuKeyFn,    void *user);
void pu_window_set_wheel  (PuWindow *, PuWheelFn,  void *user);
void pu_window_set_async  (PuWindow *, PuAsyncFn,  void *user);
void pu_window_wake       (PuWindow *);   /* thread-safe: nudge the loop to drain async */
int  pu_window_run        (PuWindow *);   /* run the event loop until quit */
void pu_window_destroy    (PuWindow *);
```

`main.c` is already backend-neutral: it only calls these and provides
`app_paint` / `app_pointer` / `app_key` / `app_wheel` / `app_async`. A new
backend is a drop-in `.c` implementing the same symbols.

### Interface extensions needed for mobile/touch

The current contract is desktop-shaped. Mobile needs three additive extensions
(non-breaking — desktop backends ignore them):

```c
/* touch: map to pointer for single-touch; add ids for multi-touch/gestures */
typedef int (*PuTouchFn)(int id, int x, int y, PuPointerType phase, void *user);

/* OS lifecycle (mobile suspend/resume, surface lost/recreated) */
typedef enum { PU_APP_RESUME, PU_APP_PAUSE, PU_APP_SURFACE_LOST, PU_APP_SURFACE_READY,
               PU_APP_LOW_MEMORY } PuAppEvent;
typedef void (*PuLifecycleFn)(PuAppEvent ev, void *user);

/* text input / IME (also raises the soft keyboard on mobile) */
void pu_window_start_text_input(PuWindow *, float caret_x, float caret_y);
void pu_window_stop_text_input (PuWindow *);
/* committed UTF-8 text arrives via PuKeyFn with is_down=1 and a multi-byte key */
```

`safe-area insets` (notch/home-indicator) are reported by extending
`PuPaintFn`'s contract: the backend passes a content rect; the app treats it as
the body's padding. Simplest: add `PuWindowConfig.on_safe_area` callback.

---

## 2. The Skia surface seam

`skia_c.h` already exposes an **opaque-handle** GPU constructor — it takes
`void *`, not `HWND`:

```c
PuSurface *pu_surface_create(int width, int height);                 /* raster (CPU) */
PuSurface *pu_surface_create_gpu(void *native_window, int w, int h); /* GPU; opaque native handle */
PuSurface *pu_surface_create_metal(void *ca_metal_layer, int w, int h); /* Apple; stub in GL build */
int  pu_surface_is_gl(const PuSurface *);
void pu_surface_present(PuSurface *);
void pu_surface_resize (PuSurface *, int w, int h);
void pu_surface_destroy(PuSurface *);
```

So the surface boundary is portable — each host passes a different native handle.
**Phase 1 done:** `pu_surface_create_gl` was renamed to `pu_surface_create_gpu`
(opaque handle) and a guarded `pu_surface_create_metal` stub added, verified
behavior-neutral on Windows (GPU path intact, 250/250 tests). The Apple Metal
implementation lands in `src/render/skia_metal.mm` (defining `PU_METAL_BACKEND`).

| Platform | Skia backend | Native handle passed | EGL/context source |
|----------|--------------|----------------------|--------------------|
| Windows  | GL (ANGLE→D3D11) *(current)* | `HWND` | ANGLE `libEGL`/`libGLESv2` |
| Linux    | GL (Mesa) or Vulkan | `wl_egl_window*` / `Window` (X11) | Mesa `libEGL` (no ANGLE) |
| macOS    | **Metal** | `CAMetalLayer*` | Ganesh Metal / Graphite |
| iOS      | **Metal** | `CAMetalLayer*` | Ganesh Metal / Graphite |
| Android  | GL (GLES) or Vulkan | `ANativeWindow*` | system EGL |

Concretely, the only *new* render code is one Metal constructor alongside the
existing GL one:

```cpp
// skia_metal.mm  (Apple only)
PuSurface *pu_surface_create_metal(void *caMetalLayer, int w, int h) {
    // GrDirectContexts::MakeMetal(device, queue) ; wrap the next drawable each frame
    // identical Ganesh path afterward — pu_surface_present = commit drawable
}
```

Everything downstream (`pu_surface_fill_rrect`, text, gradients, clip, the whole
`render.c`) is **unchanged** — it draws into an `SkCanvas` regardless of backend.

---

## 3. JS event-loop integration (the crux)

PollyUI has its own JS event loop (microtasks, `setTimeout`, `requestAnimationFrame`)
pumped via `PuAsyncFn` (`app_async` → `pu_script_flush_raf` + `pu_script_pump`).
The only thing that differs per platform is **who owns the outer loop**:

| Model | Platforms | Outer loop | Where you pump |
|-------|-----------|-----------|----------------|
| **You own it** | Win32, SDL desktop, Wayland, DRM | `while(GetMessage)` / `SDL_PollEvent` / `wl_display_dispatch` / page-flip loop | each iteration → `PuAsyncFn` + paint if dirty |
| **OS owns it** | iOS, Android, SDL mobile | OS calls you per frame | `SDL_AppIterate` / `CADisplayLink` / `Choreographer` → `PuAsyncFn` + paint |

The key win: **`SDL_AppIterate` unifies both.** SDL calls it every frame on
*all* platforms (desktop and mobile), so one code path drives the pump
everywhere. This maps 1:1 onto the existing `app_async` design.

```c
/* SDL3 main-callback model — same on desktop AND mobile */
SDL_AppResult SDL_AppIterate(void *appstate) {
    PuApp *app = appstate;
    int worked = app_async(app);          /* pump JS: rAF + microtasks + timers */
    if (worked || app->dirty) {
        app_paint(app->surface, lw, lh, app->scale, app);
        pu_surface_present(app->surface);
    }
    return SDL_APP_CONTINUE;
}
```

---

## 4. Tier 1 — SDL3 backend  (`src/host/sdl/`)

One file, all five targets. SDL3 is the right version (stable callback model,
native Wayland, clean Metal-layer access, App Store-proven on iOS).

```c
// src/host/sdl/window_sdl.c — implements the §1 PuWindow contract via SDL3
#define SDL_MAIN_USE_CALLBACKS
#include <SDL3/SDL.h>
#include "host/win32/window.h"   /* the shared contract (rename header later) */

struct PuWindow { SDL_Window *win; PuSurface *surf; float scale;
                  PuPaintFn paint; PuPointerFn pointer; PuKeyFn key;
                  PuWheelFn wheel; PuAsyncFn async; void *u_paint, *u_ptr, *u_key, *u_wheel, *u_async; };

PuWindow *pu_window_create(const PuWindowConfig *cfg) {
    SDL_Init(SDL_INIT_VIDEO);
    PuWindow *w = calloc(1, sizeof *w);
    Uint32 flags = SDL_WINDOW_HIGH_PIXEL_DENSITY | SDL_WINDOW_RESIZABLE;
#if defined(__APPLE__)
    flags |= SDL_WINDOW_METAL;
#else
    flags |= SDL_WINDOW_OPENGL;
#endif
    w->win = SDL_CreateWindow(cfg->title?cfg->title:"PollyUI", cfg->width, cfg->height, flags);
    w->scale = SDL_GetWindowDisplayScale(w->win);

    int pw, ph; SDL_GetWindowSizeInPixels(w->win, &pw, &ph);
#if defined(__APPLE__)
    SDL_MetalView mv = SDL_Metal_CreateView(w->win);
    w->surf = pu_surface_create_metal(SDL_Metal_GetLayer(mv), pw, ph);   /* CAMetalLayer */
#else
    SDL_GL_CreateContext(w->win);
    w->surf = pu_surface_create_gpu(/*native unused: ctx is current*/ NULL, pw, ph);
#endif
    return w;
}

/* setters store fn+user (identical shape to win32) … */

/* input → the shared callbacks */
SDL_AppResult SDL_AppEvent(void *appstate, SDL_Event *e) {
    PuWindow *w = ((PuApp*)appstate)->win;
    float s = w->scale;
    switch (e->type) {
      case SDL_EVENT_MOUSE_BUTTON_DOWN: w->pointer(e->button.x/s, e->button.y/s, PU_POINTER_DOWN, w->u_ptr); break;
      case SDL_EVENT_MOUSE_BUTTON_UP:   w->pointer(e->button.x/s, e->button.y/s, PU_POINTER_UP,   w->u_ptr);
                                        w->pointer(e->button.x/s, e->button.y/s, PU_POINTER_CLICK,w->u_ptr); break;
      case SDL_EVENT_MOUSE_MOTION:      w->pointer(e->motion.x/s, e->motion.y/s, PU_POINTER_MOVE, w->u_ptr); break;
      case SDL_EVENT_MOUSE_WHEEL:       w->wheel(/*x*/0,/*y*/0, -e->wheel.y*40.0f, w->u_wheel); break;
      case SDL_EVENT_FINGER_DOWN: case SDL_EVENT_FINGER_UP: case SDL_EVENT_FINGER_MOTION:
        /* touch → pointer (single) or PuTouchFn (multi) */ break;
      case SDL_EVENT_KEY_DOWN: w->key(sdl_key_name(e->key.key), 1, w->u_key); break;  /* scancode→DOM name */
      case SDL_EVENT_KEY_UP:   w->key(sdl_key_name(e->key.key), 0, w->u_key); break;
      case SDL_EVENT_TEXT_INPUT: w->key(e->text.text, 1, w->u_key); break;            /* IME/committed UTF-8 */
      case SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED: pu_surface_resize(w->surf, e->window.data1, e->window.data2); break;
      case SDL_EVENT_WILL_ENTER_BACKGROUND: /* PU_APP_PAUSE: stop rAF, flush */ break;
      case SDL_EVENT_DID_ENTER_FOREGROUND:  /* PU_APP_RESUME */ break;
      case SDL_EVENT_QUIT: return SDL_APP_SUCCESS;
    }
    return SDL_APP_CONTINUE;
}
/* SDL_AppInit builds PuApp+window; SDL_AppIterate pumps (see §3); SDL_AppQuit tears down */
```

**Per-platform specifics under SDL3:**

- **Android** — SDL ships `SDLActivity` (Java) + JNI glue that hands you the
  `ANativeWindow`, input, and the soft keyboard (`SDL_StartTextInput` raises it
  via `InputMethodManager`). **You write zero Java.** ART is in the process (the
  OS mandates it; see `docs` discussion) but is invisible to your code. Artifact:
  APK; the only dex is SDL's bootstrap Activity.
- **iOS** — Metal backend; SDL owns the `UIApplication`/`CADisplayLink`, soft
  keyboard, and safe-area. You add `Info.plist` + signing. Artifact: `.ipa`.
- **macOS** — Metal; SDL owns the `NSApplication`. Artifact: `.app`.
- **Windows/Linux** — GL (ANGLE on Win, Mesa on Linux). SDL handles Wayland↔X11
  automatically. Artifacts: `.exe` / ELF.

---

## 5. Tier 2 — bare embedded Linux (no Java, no SDL)

For appliances that own the whole stack. Two sub-profiles.

### 5a. Wayland client (`src/host/wayland/`) — a compositor is present

```c
// connect + bind globals
wl_display *dpy = wl_display_connect(NULL);
// registry → wl_compositor, xdg_wm_base, wl_seat, wl_shm
wl_surface  *surf = wl_compositor_create_surface(comp);
xdg_surface *xs   = xdg_wm_base_get_xdg_surface(wm_base, surf);
xdg_toplevel_set_title(xdg_surface_get_toplevel(xs), cfg->title);

// GPU: wl_egl_window → EGL (Mesa, NOT ANGLE) → Skia GL
struct wl_egl_window *eglwin = wl_egl_window_create(surf, w, h);
PuSurface *s = pu_surface_create_gpu((void*)eglwin, w, h);  // EGL_PLATFORM_WAYLAND_KHR

// loop: wl_display_dispatch(); pump app_async; commit on wl_surface.frame callback (vsync)
// input: wl_pointer/wl_keyboard/wl_touch + xkbcommon for keymaps → §1 callbacks
```

You provide **client-side decorations** (draw your own title bar — trivial with
PollyUI) or negotiate `xdg-decoration` if the compositor supports SSD.

### 5b. DRM/KMS + GBM (`src/host/drm/`) — **no compositor**, direct to display

The true single-app appliance path: boot → your binary owns the screen.

```c
int fd = open("/dev/dri/card0", O_RDWR);          // libdrm
// drmModeGetResources → pick connector + CRTC + mode
struct gbm_device  *gbm = gbm_create_device(fd);
struct gbm_surface *gs  = gbm_surface_create(gbm, mode.hdisplay, mode.vdisplay,
                              GBM_FORMAT_XRGB8888, GBM_BO_USE_SCANOUT|GBM_BO_USE_RENDERING);
// EGL from gbm: eglGetPlatformDisplay(EGL_PLATFORM_GBM_KHR, gbm, …)
PuSurface *s = pu_surface_create_gpu((void*)gs, mode.hdisplay, mode.vdisplay);

// per frame: render → eglSwapBuffers → gbm_surface_lock_front_buffer →
//            drmModeAddFB2 + drmModePageFlip (vsync); release prev bo
// input: libinput + libudev (evdev) + xkbcommon → §1 callbacks
```

Dependencies: `libdrm`, `gbm`, `libEGL`/`libGLESv2` (Mesa), `libinput`,
`libudev`, `xkbcommon`. **No X, no Wayland, no Java, no SDL.** Boots from
Yocto/Buildroot straight into PollyUI. This is the kiosk / IVI / set-top path.

---

## 6. CMake wiring

```cmake
set(PU_HOST "win32" CACHE STRING "win32 | sdl | wayland | drm")
set(PU_GPU  "auto"  CACHE STRING "auto | gl | metal | vulkan | raster")

if(PU_HOST STREQUAL "win32")    target_sources(pollyui PRIVATE src/host/win32/window.c)
elseif(PU_HOST STREQUAL "sdl")  target_sources(pollyui PRIVATE src/host/sdl/window_sdl.c)
                                find_package(SDL3 REQUIRED); target_link_libraries(pollyui SDL3::SDL3)
elseif(PU_HOST STREQUAL "wayland") target_sources(pollyui PRIVATE src/host/wayland/window_wl.c)
                                target_link_libraries(pollyui wayland-client wayland-egl xkbcommon EGL GLESv2)
elseif(PU_HOST STREQUAL "drm")  target_sources(pollyui PRIVATE src/host/drm/window_drm.c)
                                target_link_libraries(pollyui drm gbm EGL GLESv2 input udev xkbcommon)
endif()

if(APPLE)  target_sources(pollyui PRIVATE src/render/skia_metal.mm)   # Metal path (PU_METAL_BACKEND)
                                                                     # skia_c.cpp's metal stub is then excluded
endif()
# src/render/skia_c.cpp (GL/ANGLE/raster + metal stub) builds on every target
```

---

## 7. Build & packaging matrix

| Target | PU_HOST | PU_GPU | Toolchain | Artifact |
|--------|---------|--------|-----------|----------|
| Windows | `win32` *(or `sdl`)* | gl (ANGLE) | clang-cl / MSVC | `.exe` |
| Linux desktop | `sdl` | gl (Mesa) | clang/gcc | ELF |
| macOS | `sdl` | metal | clang + Xcode SDK | `.app` |
| iOS | `sdl` | metal | Xcode + iOS SDK | `.ipa` |
| Android | `sdl` | gl (GLES) | NDK + SDL Java shell | `.apk` |
| Appliance (compositor) | `wayland` | gl (Mesa) | Yocto SDK | rootfs binary |
| Appliance (bare) | `drm` | gl (Mesa) | Yocto SDK | rootfs binary |

---

## 8. What you write vs what you get free

- **App + UI**: 100% JS + PollyUI, **shared across every target**. Zero per-platform app code.
- **Per platform you write**: one host `.c` (or *reuse SDL's for 5 targets at once*).
- **Per GPU API you write**: one surface constructor (`_gpu` GL exists; add `_metal`).
- **Java/ObjC/Swift**: **none** on the SDL path (SDL owns the shells); **none** on bare Linux (there is no Java).

---

## 9. Honest gaps & decisions

| Gap | Status / mitigation |
|-----|---------------------|
| **Accessibility** (screen readers) | None today. Per-platform (UIA/AT-SPI/UIKit a11y). Real work; the Skia-direct (Flutter) trade-off. |
| **IME depth** | SDL gives basic candidate/commit + soft keyboard; raw native is richer. Fine for Latin; verify for CJK. |
| **QuickJS = interpreter (no JIT)** | Fine for UI logic (hot path is native Skia). Engine is swappable → Hermes for compute-heavy mobile. |
| **Prebuilt Skia lacks Metal** | The pinned aseprite/skia m124 macOS prebuilt ships the GL backend, not Metal. The default macOS build therefore renders via the CPU raster fallback; GPU Metal (`-DPU_METAL=ON`) needs a Skia built with `skia_use_metal=true`. |
| **Touch / gestures** | Needs the §1 `PuTouchFn` extension for multi-touch; single-touch maps to pointer today. |
| **HiDPI / fractional scaling** | SDL + Wayland handle it; the existing `scale` plumbing already supports it. |
| **Packaging / signing / stores** | Per platform (`.ipa` signing, Play upload, notarization). Out of engine scope. |

---

## 10. Recommended sequencing

1. ✅ **Refactor the surface seam** (`create_gl`→`create_gpu`, stub `create_metal`).
   *Done — behavior-neutral, GPU path intact, 250/250 tests pass on Windows.*
2. **SDL3 desktop backend** (`src/host/sdl/`) → validate Win/Linux/macOS with one
   host. macOS forces the **Metal** path, exercising the new render code.
   *Scaffolded:* `src/host/sdl/window_sdl.c` (PuWindow contract via SDL3, classic
   poll loop so `main.c` is unchanged) + `src/render/skia_metal.mm` (Ganesh Metal
   surface) + CMake `PU_HOST`/APPLE wiring + the `mac-sdl-metal` preset. Not yet
   compiled/run on macOS hardware (needs a Metal-enabled Skia + SDL3).
3. **iOS + Android via the same SDL3 backend** (Metal already done; add the
   §1 touch/lifecycle/text-input extensions + APK/ipa packaging).
4. **Embedded Linux** (`wayland` first, then `drm`) for appliances — no Java, no SDL.

Throughout, the raw **`win32`** backend stays selectable for a zero-dependency
Windows build. The HostEngine interface never changes shape — every backend is a
drop-in implementation of §1.
