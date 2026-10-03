// RenderEngine — Skia shim implementation (the sole .cpp in PollyUI).
// Compiled as C++ against Skia's headers; exposes only the extern "C" API in
// skia_c.h. See DESIGN.md §3.

#include "render/skia_c.h"

#include "include/core/SkSurface.h"
#include "include/core/SkBitmap.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkColor.h"
#include "include/core/SkImageInfo.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkRect.h"
#include "include/core/SkRRect.h"
#include "include/core/SkMaskFilter.h"
#include "include/core/SkBlurTypes.h"
#include "include/core/SkColorSpace.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkFontStyle.h"
#include "include/core/SkFontTypes.h"
#include "include/core/SkGraphics.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkStream.h"
#include "include/core/SkData.h"
#include "include/core/SkImage.h"
#include "include/core/SkSamplingOptions.h"
#include "include/effects/SkGradientShader.h"
#include "include/encode/SkPngEncoder.h"

#if defined(__linux__)
#include "include/ports/SkFontMgr_fontconfig.h"
#endif

/* PuSurface struct, shared with the per-GPU-API backends (e.g. skia_metal.mm). */
#include "render/skia_internal.h"

#if defined(_WIN32) || defined(__linux__)
/* Ganesh GL: ANGLE on Windows, a host-owned GLES context on Linux. */
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/ganesh/gl/GrGLDirectContext.h"   /* GrDirectContexts::MakeGL */
#include "include/gpu/ganesh/gl/GrGLBackendSurface.h"  /* GrBackendRenderTargets::MakeGL */
#include "include/gpu/ganesh/SkSurfaceGanesh.h"        /* SkSurfaces::WrapBackendRenderTarget, FlushAndSubmit */
#include "include/gpu/gl/GrGLAssembleInterface.h" /* GrGLMakeAssembledGLESInterface */
#include "include/gpu/gl/GrGLTypes.h"                   /* GrGLFramebufferInfo, GrGLFuncPtr */
#endif

#if defined(_WIN32)
#include <windows.h>   /* WGL + HWND/HDC for the GPU surface */
#endif // _WIN32

#if defined(PU_METAL_BACKEND)
/* Metal surface lifecycle helpers, implemented in src/render/skia_metal.mm.
 * skia_c.cpp stays free of Objective-C; it only forwards to these. */
extern "C" void pu_metal_present(PuSurface *s);
extern "C" void pu_metal_resize (PuSurface *s, int width, int height);
extern "C" void pu_metal_destroy(PuSurface *s);
#endif

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <new>
#include <map>
#include <string>
#include <vector>

#define PU_GL_RGBA8 0x8058
#define PU_GLLOG(msg) std::fprintf(stderr, "[gl] %s\n", msg)

// Platform system font manager. Skia ships no header for these factory
// functions in the prebuilt, so we forward-declare them (matching the C++
// mangling) and let Skia build the native factory from null args.
#if defined(_WIN32)
struct IDWriteFactory;
struct IDWriteFontCollection;
struct IDWriteFontFallback;
extern sk_sp<SkFontMgr> SkFontMgr_New_DirectWrite(IDWriteFactory *,
                                                  IDWriteFontCollection *,
                                                  IDWriteFontFallback *);
#elif defined(__APPLE__)
struct __CTFontCollection;   /* CTFontCollectionRef = const __CTFontCollection * */
extern sk_sp<SkFontMgr> SkFontMgr_New_CoreText(const __CTFontCollection *);
#endif

static sk_sp<SkFontMgr> g_font_mgr;
static bool g_font_tried = false;

// Lazily-resolved system font manager; explicitly released before process exit.
static sk_sp<SkFontMgr> font_mgr() {
    auto &mgr = g_font_mgr;
    if (!g_font_tried) {
        g_font_tried = true;
#if defined(_WIN32)
        mgr = SkFontMgr_New_DirectWrite(nullptr, nullptr, nullptr);
#elif defined(__APPLE__)
        mgr = SkFontMgr_New_CoreText(nullptr);
#elif defined(__linux__)
        FcConfig *config = FcInitLoadConfigAndFonts();
        if (config) mgr = SkFontMgr_New_FontConfig(config);
#else
        mgr = nullptr;
#endif
        if (!mgr || mgr->countFamilies() == 0) {
            std::fprintf(stderr, "[render] No system fonts available; install fonts and configure the platform font manager\n");
            mgr = nullptr;
        }
    }
    return mgr;
}

// Typeface at a given weight/slant, optionally from a named family. "monospace"
// maps to a system mono face; an unknown family falls back to the default UI font.
static sk_sp<SkTypeface> typeface_for(int weight, int italic, const char *family) {
    sk_sp<SkFontMgr> mgr = font_mgr();
    if (!mgr) return nullptr;
    SkFontStyle style(weight > 0 ? weight : SkFontStyle::kNormal_Weight,
                      SkFontStyle::kNormal_Width,
                      italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant);
    if (family && *family) {
        const char *fam = family;
#if !defined(__linux__)
        if (strcmp(family, "monospace") == 0) fam = "Consolas";
        else if (strcmp(family, "serif") == 0) fam = "Georgia";
#endif
        sk_sp<SkTypeface> tf = mgr->matchFamilyStyle(fam, style);
        if (tf) return tf;
    }
    return mgr->legacyMakeTypeface(nullptr, style);
}

static SkFont make_font(float size, int weight, int italic, const char *family) {
    SkFont font(typeface_for(weight, italic, family), size);
    font.setEdging(SkFont::Edging::kAntiAlias);
    font.setSubpixel(true);
    return font;
}

// PuSurface is defined in render/skia_internal.h (shared with the Metal
// backend). Pixel-format note: BGRA8888 + premul matches a Windows 32-bit
// top-down DIB (BI_RGB) for a zero-copy raster blit; on GPU paths Skia owns the
// framebuffer.

#if defined(_WIN32)
/* ---- ANGLE / EGL (dynamically loaded; no import lib needed) ----------------*/

namespace {
struct Egl {
    HMODULE eglLib = nullptr, glesLib = nullptr;
    void *(__stdcall *eglGetProc)(const char *) = nullptr;
    void *(__stdcall *GetPlatformDisplayEXT)(unsigned, void *, const int *) = nullptr;
    void *(__stdcall *GetDisplay)(void *) = nullptr;
    unsigned (__stdcall *Initialize)(void *, int *, int *) = nullptr;
    unsigned (__stdcall *ChooseConfig)(void *, const int *, void **, int, int *) = nullptr;
    void *(__stdcall *CreateWindowSurface)(void *, void *, void *, const int *) = nullptr;
    void *(__stdcall *CreateContext)(void *, void *, void *, const int *) = nullptr;
    unsigned (__stdcall *MakeCurrent)(void *, void *, void *, void *) = nullptr;
    unsigned (__stdcall *SwapBuffers)(void *, void *) = nullptr;
    unsigned (__stdcall *SwapInterval)(void *, int) = nullptr;
    unsigned (__stdcall *BindAPI)(unsigned) = nullptr;
    unsigned (__stdcall *DestroySurface)(void *, void *) = nullptr;
    unsigned (__stdcall *DestroyContext)(void *, void *) = nullptr;
    unsigned (__stdcall *QuerySurface)(void *, void *, int, int *) = nullptr;
    bool loaded = false, ok = false;
};
Egl g_egl;

bool load_egl() {
    if (g_egl.loaded) return g_egl.ok;
    g_egl.loaded = true;
    g_egl.eglLib  = LoadLibraryA("libEGL.dll");
    g_egl.glesLib = LoadLibraryA("libGLESv2.dll");
    if (!g_egl.eglLib || !g_egl.glesLib) return false;
#define PU_LD(field, name) g_egl.field = (decltype(g_egl.field))(void *)::GetProcAddress(g_egl.eglLib, name)
    PU_LD(eglGetProc,            "eglGetProcAddress");
    PU_LD(GetPlatformDisplayEXT, "eglGetPlatformDisplayEXT");
    PU_LD(GetDisplay,            "eglGetDisplay");
    PU_LD(Initialize,            "eglInitialize");
    PU_LD(ChooseConfig,          "eglChooseConfig");
    PU_LD(CreateWindowSurface,   "eglCreateWindowSurface");
    PU_LD(CreateContext,         "eglCreateContext");
    PU_LD(MakeCurrent,           "eglMakeCurrent");
    PU_LD(SwapBuffers,           "eglSwapBuffers");
    PU_LD(SwapInterval,          "eglSwapInterval");
    PU_LD(BindAPI,               "eglBindAPI");
    PU_LD(DestroySurface,        "eglDestroySurface");
    PU_LD(DestroyContext,        "eglDestroyContext");
    PU_LD(QuerySurface,          "eglQuerySurface");
#undef PU_LD
    g_egl.ok = g_egl.eglGetProc && g_egl.GetDisplay && g_egl.Initialize && g_egl.ChooseConfig &&
               g_egl.CreateWindowSurface && g_egl.CreateContext && g_egl.MakeCurrent && g_egl.SwapBuffers;
    return g_egl.ok;
}
} // namespace

extern "C" GrGLFuncPtr pu_egl_get_proc(void *, const char name[]) {
    GrGLFuncPtr p = g_egl.glesLib ? (GrGLFuncPtr)(void *)::GetProcAddress(g_egl.glesLib, name) : nullptr;
    if (!p && g_egl.eglGetProc) p = (GrGLFuncPtr)g_egl.eglGetProc(name);
    return p;
}
#endif // _WIN32

static sk_sp<SkSurface> make_raster(int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    const SkImageInfo info =
        SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kPremul_SkAlphaType);
    return SkSurfaces::Raster(info);
}

/* Wrap the window's default framebuffer (FBO 0) as a Skia GPU surface. */
#if defined(_WIN32) || defined(__linux__)
static void rewrap_gl(PuSurface *s, int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    GrGLFramebufferInfo fbInfo;
    fbInfo.fFBOID = 0;
    fbInfo.fFormat = PU_GL_RGBA8;
    GrBackendRenderTarget target =
        GrBackendRenderTargets::MakeGL(w, h, /*sampleCnt*/ 0, /*stencilBits*/ 8, fbInfo);
    s->surface = SkSurfaces::WrapBackendRenderTarget(
        s->grctx.get(), target, kBottomLeft_GrSurfaceOrigin,
        kRGBA_8888_SkColorType, nullptr, nullptr);
    s->width = w;
    s->height = h;
}
#endif

extern "C" {

int pu_font_system_init(void) {
    return font_mgr() ? 1 : 0;
}

PuSurface *pu_surface_create(int width, int height) {
    PuSurface *s = new (std::nothrow) PuSurface();
    if (!s) return nullptr;
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;
    s->surface = make_raster(width, height);
    if (!s->surface) { delete s; return nullptr; }
    s->width  = width;
    s->height = height;
    return s;
}

int pu_surface_valid(const PuSurface *s) { return s && s->surface ? 1 : 0; }

PuSurface *pu_surface_create_current_gl(PuGlGetProc get_proc, void *user, int width, int height) {
#if defined(__linux__)
    if (!get_proc) { PU_GLLOG("Missing GL procedure resolver"); return nullptr; }
    auto interface = GrGLMakeAssembledGLESInterface(user, get_proc);
    if (!interface || !interface->validate()) {
        PU_GLLOG("Cannot assemble a valid GLES interface"); return nullptr;
    }
    PuSurface *s = new (std::nothrow) PuSurface();
    if (!s) { PU_GLLOG("Cannot allocate GL surface"); return nullptr; }
    s->grctx = GrDirectContexts::MakeGL(interface);
    if (!s->grctx) { PU_GLLOG("Cannot create Skia GLES context"); delete s; return nullptr; }
    s->gl = true;
    s->grctx->setResourceCacheLimit(64 * 1024 * 1024);
    rewrap_gl(s, width, height);
    if (!s->surface) { PU_GLLOG("Cannot wrap GLES framebuffer"); delete s; return nullptr; }
    const auto *renderer = interface->fFunctions.fGetString(0x1F01 /* GL_RENDERER */);
    std::fprintf(stderr, "[render] Skia GLES renderer: %s\n",
                 renderer ? reinterpret_cast<const char *>(renderer) : "(unreported)");
    return s;
#else
    (void)get_proc; (void)user; (void)width; (void)height;
    PU_GLLOG("Borrowed GLES contexts are only enabled on Linux");
    return nullptr;
#endif
}

/* EGL constants (avoid needing the EGL headers). */
#define PU_EGL_NONE                       0x3038
#define PU_EGL_PLATFORM_ANGLE_ANGLE       0x3202
#define PU_EGL_PLATFORM_ANGLE_TYPE_ANGLE  0x3203
#define PU_EGL_PLATFORM_ANGLE_TYPE_D3D11  0x3208
#define PU_EGL_RED_SIZE                   0x3024
#define PU_EGL_GREEN_SIZE                 0x3023
#define PU_EGL_BLUE_SIZE                  0x3022
#define PU_EGL_ALPHA_SIZE                 0x3021
#define PU_EGL_STENCIL_SIZE               0x3026
#define PU_EGL_SURFACE_TYPE               0x3033
#define PU_EGL_WINDOW_BIT                 0x0004
#define PU_EGL_RENDERABLE_TYPE            0x3040
#define PU_EGL_OPENGL_ES2_BIT             0x0004
#define PU_EGL_OPENGL_ES_API              0x30A0
#define PU_EGL_CONTEXT_CLIENT_VERSION     0x3098
#define PU_EGL_HEIGHT                     0x3056
#define PU_EGL_WIDTH                      0x3057

#ifndef PU_METAL_BACKEND
/* Metal stub for the default GL/raster build. The real implementation lives in
 * src/render/skia_metal.mm and is compiled (defining PU_METAL_BACKEND) only on
 * Apple platforms — see docs/PORTING.md §2. */
PuSurface *pu_surface_create_metal(void *ca_metal_layer, int width, int height) {
    (void)ca_metal_layer; (void)width; (void)height;
    PU_GLLOG("Metal backend not built in this target - using raster");
    return nullptr;
}
#endif

#if defined(_WIN32)
PuSurface *pu_surface_create_gpu(void *hwndv, int width, int height) {
    if (!load_egl()) { PU_GLLOG("ANGLE (libEGL/libGLESv2) not available - using raster"); return nullptr; }

    PuSurface *s = new (std::nothrow) PuSurface();
    if (!s) return nullptr;
    s->gl = true;
    s->hwnd = (HWND)hwndv;

    void *disp = nullptr;
    if (g_egl.GetPlatformDisplayEXT) {
        const int dattr[] = { PU_EGL_PLATFORM_ANGLE_TYPE_ANGLE, PU_EGL_PLATFORM_ANGLE_TYPE_D3D11, PU_EGL_NONE };
        disp = g_egl.GetPlatformDisplayEXT(PU_EGL_PLATFORM_ANGLE_ANGLE, (void *)0 /*EGL_DEFAULT_DISPLAY*/, dattr);
    }
    if (!disp) disp = g_egl.GetDisplay((void *)0);
    int maj = 0, min = 0;
    if (!disp || !g_egl.Initialize(disp, &maj, &min)) { PU_GLLOG("eglInitialize failed"); delete s; return nullptr; }
    s->egl_display = disp;
    if (g_egl.BindAPI) g_egl.BindAPI(PU_EGL_OPENGL_ES_API);

    const int cfgAttr[] = {
        PU_EGL_RED_SIZE, 8, PU_EGL_GREEN_SIZE, 8, PU_EGL_BLUE_SIZE, 8, PU_EGL_ALPHA_SIZE, 8,
        PU_EGL_STENCIL_SIZE, 8, PU_EGL_SURFACE_TYPE, PU_EGL_WINDOW_BIT,
        PU_EGL_RENDERABLE_TYPE, PU_EGL_OPENGL_ES2_BIT, PU_EGL_NONE
    };
    void *config = nullptr;
    int nCfg = 0;
    if (!g_egl.ChooseConfig(disp, cfgAttr, &config, 1, &nCfg) || nCfg < 1) {
        PU_GLLOG("eglChooseConfig failed"); delete s; return nullptr;
    }
    s->egl_surface = g_egl.CreateWindowSurface(disp, config, (void *)s->hwnd, nullptr);
    if (!s->egl_surface) { PU_GLLOG("eglCreateWindowSurface failed"); delete s; return nullptr; }

    const int ctxAttr[] = { PU_EGL_CONTEXT_CLIENT_VERSION, 3, PU_EGL_NONE };
    s->egl_context = g_egl.CreateContext(disp, config, nullptr, ctxAttr);
    if (!s->egl_context) { PU_GLLOG("eglCreateContext failed"); delete s; return nullptr; }
    if (!g_egl.MakeCurrent(disp, s->egl_surface, s->egl_surface, s->egl_context)) {
        PU_GLLOG("eglMakeCurrent failed"); delete s; return nullptr;
    }

    /* Swap interval. Default 0 (no vsync wait): we present on-demand, only when
     * the UI changes, so blocking on vblank just adds input->photon latency
     * (DXGI's default 3-frame queue + DWM composition). In a DWM-composited
     * window, interval 0 doesn't tear — DWM still owns the final composite — it
     * just hands the frame over immediately. Override with PU_VSYNC=1. */
    if (g_egl.SwapInterval) {
        const char *v = getenv("PU_VSYNC");
        int interval = (v && v[0]) ? atoi(v) : 0;
        g_egl.SwapInterval(disp, interval);
        std::fprintf(stderr, "[render] swap interval = %d (%s)\n", interval, interval ? "vsync" : "low-latency");
    }

    s->grctx = GrDirectContexts::MakeGL(GrGLMakeAssembledGLESInterface(nullptr, pu_egl_get_proc));
    if (!s->grctx) { PU_GLLOG("GrDirectContexts::MakeGL (GLES) failed"); delete s; return nullptr; }
    /* Cap the GPU resource cache (default budget is large). 64 MB is ample for
     * UI and keeps the resident set down. */
    s->grctx->setResourceCacheLimit(64 * 1024 * 1024);
    rewrap_gl(s, width, height);
    if (!s->surface) { PU_GLLOG("WrapBackendRenderTarget failed"); delete s; return nullptr; }
    std::fprintf(stderr, "[render] GPU backend: ANGLE / D3D11 (EGL %d.%d)\n", maj, min);
    return s;
}
#else // !_WIN32
/* Native-handle creation is Windows-only. Linux uses create_current_gl()
 * with SDL's EGL/GLES context; Apple uses create_metal(). */
PuSurface *pu_surface_create_gpu(void *native_window, int width, int height) {
    (void)native_window; (void)width; (void)height;
    PU_GLLOG("pu_surface_create_gpu: no GL backend on this platform - using raster/metal");
    return nullptr;
}
#endif // _WIN32

int pu_surface_is_gl(const PuSurface *s) { return (s && s->gl) ? 1 : 0; }

void pu_surface_present(PuSurface *s) {
    if (!s || !s->gl) return;
#if defined(PU_METAL_BACKEND)
    if (s->metal) { pu_metal_present(s); return; }
#endif
#if defined(_WIN32) || defined(__linux__)
    if (s->surface) skgpu::ganesh::FlushAndSubmit(s->surface.get());
#endif
#if defined(_WIN32)
    if (g_egl.SwapBuffers) g_egl.SwapBuffers(s->egl_display, s->egl_surface);
#endif
}

void pu_surface_destroy(PuSurface *s) {
    if (!s) return;
#if defined(PU_METAL_BACKEND)
    if (s->metal) { pu_metal_destroy(s); delete s; return; }
#endif
#if defined(_WIN32)
    if (s->gl) {
        s->surface.reset();
        if (s->grctx) { s->grctx->abandonContext(); s->grctx.reset(); }
        if (g_egl.MakeCurrent && s->egl_display) g_egl.MakeCurrent(s->egl_display, nullptr, nullptr, nullptr);
        if (g_egl.DestroyContext && s->egl_context) g_egl.DestroyContext(s->egl_display, s->egl_context);
        if (g_egl.DestroySurface && s->egl_surface) g_egl.DestroySurface(s->egl_display, s->egl_surface);
    }
#endif
#if defined(__linux__)
    if (s->grctx) s->grctx->abandonContext();
#endif
    delete s; // sk_sp releases the surface
}

void pu_surface_resize(PuSurface *s, int width, int height) {
    if (!s) return;
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;
    if (width == s->width && height == s->height && s->surface) return;
    if (s->gl) {
#if defined(PU_METAL_BACKEND)
        if (s->metal) { pu_metal_resize(s, width, height); return; }
#endif
#if defined(_WIN32)
        if (g_egl.MakeCurrent)
            g_egl.MakeCurrent(s->egl_display, s->egl_surface, s->egl_surface, s->egl_context);
        /* Wrap Skia's render target to the window's authoritative client size
         * (passed straight from WM_SIZE). We deliberately do NOT call
         * eglQuerySurface here: ANGLE resizes its D3D11 swapchain lazily, only at
         * the next eglSwapBuffers, so a query during WM_SIZE reports the PREVIOUS
         * frame's size. Wrapping to that stale value guarantees a mismatch every
         * resize frame — horizontal "jelly" when widening, and a black gap at the
         * top when growing taller (the bottom-left GL origin anchors content to
         * the bottom). Using the WM_SIZE size keeps render target == layout ==
         * window; the swapchain catches up on the swap pumped from WM_SIZE. */
        rewrap_gl(s, width, height);
#elif defined(__linux__)
        rewrap_gl(s, width, height);
#endif
        return;
    }
    s->surface = make_raster(width, height);
    s->width  = width;
    s->height = height;
}

void pu_surface_clear(PuSurface *s, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface) return;
    s->surface->getCanvas()->clear(SkColorSetARGB(a, r, g, b));
}

void pu_surface_fill_rect(PuSurface *s, float x, float y, float w, float h,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface) return;
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);
    s->surface->getCanvas()->drawRect(SkRect::MakeXYWH(x, y, w, h), paint);
}

void pu_surface_fill_rrect(PuSurface *s, float x, float y, float w, float h,
                           float radius, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface) return;
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);
    SkRRect rr = SkRRect::MakeRectXY(SkRect::MakeXYWH(x, y, w, h), radius, radius);
    s->surface->getCanvas()->drawRRect(rr, paint);
}

void pu_surface_stroke_rrect(PuSurface *s, float x, float y, float w, float h,
                             float radius, float stroke_w,
                             uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface || stroke_w <= 0) return;
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);
    paint.setStyle(SkPaint::kStroke_Style);
    paint.setStrokeWidth(stroke_w);
    /* Inset by half the stroke so the border sits inside the box. */
    float in = stroke_w * 0.5f;
    SkRRect rr = SkRRect::MakeRectXY(SkRect::MakeXYWH(x + in, y + in, w - stroke_w, h - stroke_w),
                                     radius, radius);
    s->surface->getCanvas()->drawRRect(rr, paint);
}

void pu_surface_shadow(PuSurface *s, float x, float y, float w, float h,
                       float radius, float blur, float dx, float dy,
                       uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface) return;
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);
    if (blur > 0) paint.setMaskFilter(SkMaskFilter::MakeBlur(kNormal_SkBlurStyle, blur * 0.5f));
    SkRRect rr = SkRRect::MakeRectXY(SkRect::MakeXYWH(x + dx, y + dy, w, h), radius, radius);
    s->surface->getCanvas()->drawRRect(rr, paint);
}

void pu_surface_save_layer_alpha(PuSurface *s, float alpha) {
    if (!s || !s->surface) return;
    int a = (int)(alpha * 255.0f + 0.5f);
    if (a < 0) a = 0; if (a > 255) a = 255;
    s->surface->getCanvas()->saveLayerAlpha(nullptr, (U8CPU)a);
}

void pu_surface_restore(PuSurface *s) {
    if (!s || !s->surface) return;
    s->surface->getCanvas()->restore();
}

void pu_surface_save(PuSurface *s) {
    if (!s || !s->surface) return;
    s->surface->getCanvas()->save();
}

void pu_surface_clip_rrect(PuSurface *s, float x, float y, float w, float h, float radius) {
    if (!s || !s->surface) return;
    SkRRect rr = SkRRect::MakeRectXY(SkRect::MakeXYWH(x, y, w, h), radius, radius);
    s->surface->getCanvas()->clipRRect(rr, true);
}

void pu_surface_translate(PuSurface *s, float dx, float dy) {
    if (!s || !s->surface) return;
    s->surface->getCanvas()->translate(dx, dy);
}

void pu_surface_rotate(PuSurface *s, float degrees) {
    if (!s || !s->surface) return;
    s->surface->getCanvas()->rotate(degrees);
}

void pu_surface_scale(PuSurface *s, float sx, float sy) {
    if (!s || !s->surface) return;
    s->surface->getCanvas()->scale(sx, sy);
}

void pu_surface_fill_gradient(PuSurface *s, float x, float y, float w, float h,
                              float radius, int horizontal,
                              uint8_t r0, uint8_t g0, uint8_t b0, uint8_t a0,
                              uint8_t r1, uint8_t g1, uint8_t b1, uint8_t a1) {
    if (!s || !s->surface) return;
    SkPoint pts[2] = { { x, y }, horizontal ? SkPoint{ x + w, y } : SkPoint{ x, y + h } };
    SkColor colors[2] = { SkColorSetARGB(a0, r0, g0, b0), SkColorSetARGB(a1, r1, g1, b1) };
    SkPaint paint;
    paint.setAntiAlias(true);
    paint.setShader(SkGradientShader::MakeLinear(pts, colors, nullptr, 2, SkTileMode::kClamp));
    SkRRect rr = SkRRect::MakeRectXY(SkRect::MakeXYWH(x, y, w, h), radius, radius);
    s->surface->getCanvas()->drawRRect(rr, paint);
}

// Cache of decoded images, keyed by file path.
static std::map<std::string, sk_sp<SkImage>> &image_cache() {
    static std::map<std::string, sk_sp<SkImage>> c;
    return c;
}

int pu_surface_draw_image(PuSurface *s, const char *path, float x, float y,
                          float w, float h, float radius) {
    if (!s || !s->surface || !path) return 0;
    sk_sp<SkImage> img;
    auto &cache = image_cache();
    auto it = cache.find(path);
    if (it != cache.end()) {
        img = it->second;
    } else {
        sk_sp<SkData> data = SkData::MakeFromFileName(path);
        if (data) img = SkImages::DeferredFromEncodedData(data);
        cache[path] = img; // cache even null results to avoid re-hitting the disk
    }
    if (!img) return 0;

    SkCanvas *canvas = s->surface->getCanvas();
    canvas->save();
    if (radius > 0) {
        SkRRect rr = SkRRect::MakeRectXY(SkRect::MakeXYWH(x, y, w, h), radius, radius);
        canvas->clipRRect(rr, true);
    }
    canvas->drawImageRect(img, SkRect::MakeXYWH(x, y, w, h),
                          SkSamplingOptions(SkFilterMode::kLinear));
    canvas->restore();
    return 1;
}

// Break text into display lines (honoring '\n', and word-wrapping to max_width
// when > 0), calling emit(ctx, start, byteLen, lineWidth) for each one.
static void wrap_text(const SkFont &font, const char *utf8, float max_width,
                      void (*emit)(void *, const char *, size_t, float), void *ctx) {
    auto mw = [&](const char *a, const char *b) {
        return font.measureText(a, (size_t)(b - a), SkTextEncoding::kUTF8, nullptr);
    };
    const char *p = utf8 ? utf8 : "";
    for (;;) {
        const char *nl = strchr(p, '\n');
        const char *end = nl ? nl : (p + strlen(p));
        if (max_width <= 0) {
            emit(ctx, p, (size_t)(end - p), mw(p, end));
        } else {
            const char *lineFrom = p, *prevWe = p, *w = p;
            while (w < end) {
                while (w < end && *w == ' ') w++;                 // skip spaces
                const char *ws = w;
                while (w < end && *w != ' ') w++;                 // word [ws, w)
                if (ws == w) break;
                if (mw(lineFrom, w) > max_width && ws != lineFrom) {
                    emit(ctx, lineFrom, (size_t)(prevWe - lineFrom), mw(lineFrom, prevWe));
                    lineFrom = ws;                                // wrap before this word
                }
                prevWe = w;
            }
            emit(ctx, lineFrom, (size_t)(prevWe - lineFrom), mw(lineFrom, prevWe));
        }
        if (!nl) break;
        p = nl + 1;
    }
}

// ---- per-codepoint font fallback -------------------------------------------
// The default UI face lacks some symbols/emoji; for any codepoint it can't
// render we substitute a system font that can (Segoe UI Symbol/Emoji, ...).

static SkUnichar pu_next_cp(const char *&p, const char *end) {
    unsigned char c = (unsigned char)*p++;
    if (c < 0x80) return c;
    int extra; SkUnichar cp;
    if ((c & 0xE0) == 0xC0)      { extra = 1; cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0) { extra = 2; cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0) { extra = 3; cp = c & 0x07; }
    else return 0xFFFD;
    while (extra-- > 0 && p < end) cp = (cp << 6) | ((unsigned char)(*p++) & 0x3F);
    return cp;
}

static std::map<SkUnichar, sk_sp<SkTypeface>> &fallback_cache() {
    static std::map<SkUnichar, sk_sp<SkTypeface>> cache;
    return cache;
}

static SkTypeface *pu_fallback_face(SkUnichar cp) {
    auto &cache = fallback_cache();
    auto it = cache.find(cp);
    if (it != cache.end()) return it->second.get();
    sk_sp<SkTypeface> tf;
    sk_sp<SkFontMgr> mgr = font_mgr();
    if (mgr) tf = sk_sp<SkTypeface>(mgr->matchFamilyStyleCharacter(nullptr, SkFontStyle(), nullptr, 0, cp));
    cache[cp] = tf;
    return tf.get();
}

void pu_render_shutdown(void) {
    image_cache().clear();
    fallback_cache().clear();
    SkGraphics::PurgeAllCaches();
    g_font_mgr.reset();
#if defined(__linux__)
    if (g_font_tried) FcFini();
#endif
    g_font_tried = false;
}

struct PuRun { const char *start; size_t len; SkTypeface *tf; };

// Split [s, s+n) into maximal runs sharing one typeface (base, else fallback).
static void pu_runs(const SkFont &base, const char *s, size_t n, std::vector<PuRun> &out) {
    SkTypeface *baseTf = base.getTypeface();
    const char *end = s + n, *p = s, *runStart = s;
    SkTypeface *cur = baseTf;
    while (p < end) {
        const char *cpStart = p;
        SkUnichar cp = pu_next_cp(p, end);
        SkTypeface *tf = baseTf;
        if (cp > 0x20 && base.unicharToGlyph(cp) == 0) {
            SkTypeface *fb = pu_fallback_face(cp);
            if (fb) tf = fb;
        }
        if (tf != cur) {
            if (cpStart > runStart) out.push_back({ runStart, (size_t)(cpStart - runStart), cur });
            runStart = cpStart; cur = tf;
        }
    }
    if (p > runStart) out.push_back({ runStart, (size_t)(p - runStart), cur });
}

static float pu_measure_runs(const SkFont &base, const char *s, size_t n) {
    if (n == 0) return 0;
    std::vector<PuRun> runs;
    pu_runs(base, s, n, runs);
    float w = 0;
    for (auto &r : runs) {
        SkFont f = base; f.setTypeface(sk_ref_sp(r.tf));
        w += f.measureText(r.start, r.len, SkTextEncoding::kUTF8, nullptr);
    }
    return w;
}

static void pu_draw_runs(SkCanvas *canvas, const SkFont &base, const SkPaint &paint,
                         const char *s, size_t n, float x, float baseline) {
    std::vector<PuRun> runs;
    pu_runs(base, s, n, runs);
    for (auto &r : runs) {
        SkFont f = base; f.setTypeface(sk_ref_sp(r.tf));
        canvas->drawSimpleText(r.start, r.len, SkTextEncoding::kUTF8, x, baseline, f, paint);
        x += f.measureText(r.start, r.len, SkTextEncoding::kUTF8, nullptr);
    }
}

struct WrapMeasure { const SkFont *font; float maxw; int lines; };
static void emit_measure(void *c, const char *s, size_t n, float w) {
    (void)w;
    WrapMeasure *m = (WrapMeasure *)c;
    float lw = pu_measure_runs(*m->font, s, n);
    if (lw > m->maxw) m->maxw = lw;
    m->lines++;
}

struct WrapDraw { SkCanvas *canvas; const SkFont *font; const SkPaint *paint;
                  float x, y, lineH, ascent, alignW; int align; };
static void emit_draw(void *c, const char *s, size_t n, float w) {
    (void)w;
    WrapDraw *d = (WrapDraw *)c;
    if (n > 0) {
        float lw = (d->align != 0) ? pu_measure_runs(*d->font, s, n) : 0.0f;
        float dx = (d->align == 1) ? (d->alignW - lw) * 0.5f : (d->align == 2) ? (d->alignW - lw) : 0.0f;
        pu_draw_runs(d->canvas, *d->font, *d->paint, s, n, d->x + dx, d->y - d->ascent);
    }
    d->y += d->lineH;
}

void pu_text_measure(const char *utf8, float font_size, int weight, int italic,
                     const char *family, float max_width, float *out_w, float *out_h) {
    SkFont font = make_font(font_size, weight, italic, family);
    SkFontMetrics m;
    font.getMetrics(&m);
    float line_h = m.fDescent - m.fAscent; // ascent is negative

    WrapMeasure wm = { &font, 0, 0 };
    wrap_text(font, utf8, max_width, emit_measure, &wm);
    if (out_w) *out_w = wm.maxw;
    if (out_h) *out_h = line_h * (wm.lines < 1 ? 1 : wm.lines);
}

void pu_surface_draw_text(PuSurface *s, const char *utf8, float x, float y,
                          float font_size, int weight, int italic, const char *family,
                          float max_width, int align, float align_width,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface || !utf8 || !*utf8) return;
    SkFont font = make_font(font_size, weight, italic, family);
    SkFontMetrics m;
    font.getMetrics(&m);
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);

    WrapDraw wd = { s->surface->getCanvas(), &font, &paint,
                    x, y, m.fDescent - m.fAscent, m.fAscent, align_width, align };
    wrap_text(font, utf8, max_width, emit_draw, &wd);
}

// Single-line text filled with a horizontal two-color gradient (for GradientText).
void pu_surface_draw_text_gradient(PuSurface *s, const char *utf8, float x, float y,
                                   float font_size, int weight, int italic, const char *family,
                                   uint8_t r0, uint8_t g0, uint8_t b0,
                                   uint8_t r1, uint8_t g1, uint8_t b1) {
    if (!s || !s->surface || !utf8 || !*utf8) return;
    SkFont font = make_font(font_size, weight, italic, family);
    SkFontMetrics m;
    font.getMetrics(&m);
    float w = pu_measure_runs(font, utf8, strlen(utf8));
    SkPoint pts[2] = { { x, y }, { x + w, y } };
    SkColor colors[2] = { SkColorSetARGB(255, r0, g0, b0), SkColorSetARGB(255, r1, g1, b1) };
    SkPaint paint;
    paint.setAntiAlias(true);
    paint.setShader(SkGradientShader::MakeLinear(pts, colors, nullptr, 2, SkTileMode::kClamp));
    pu_draw_runs(s->surface->getCanvas(), font, paint, utf8, strlen(utf8), x, y - m.fAscent);
}

void pu_surface_set_scale(PuSurface *s, float scale) {
    if (!s || !s->surface) return;
    SkCanvas *c = s->surface->getCanvas();
    c->resetMatrix();
    c->scale(scale, scale);
}

void pu_surface_read_pixel(const PuSurface *s, int x, int y, uint8_t *rgba) {
    rgba[0] = rgba[1] = rgba[2] = 0; rgba[3] = 255;
    if (!s || !s->surface) return;
    SkPixmap pm;
    if (!s->surface->peekPixels(&pm)) return;
    if (x < 0 || y < 0 || x >= pm.width() || y >= pm.height()) return;
    SkColor c = pm.getColor(x, y); // unpremultiplied ARGB
    rgba[0] = SkColorGetR(c);
    rgba[1] = SkColorGetG(c);
    rgba[2] = SkColorGetB(c);
    rgba[3] = SkColorGetA(c);
}

int pu_surface_save_png(const PuSurface *s, const char *path) {
    if (!s || !s->surface || !path) return 0;
    SkPixmap pm;
    SkBitmap readback;
    if (!s->surface->peekPixels(&pm)) {
        if (!readback.tryAllocPixels(SkImageInfo::Make(s->width, s->height,
                kRGBA_8888_SkColorType, kPremul_SkAlphaType)) ||
            !s->surface->readPixels(readback.pixmap(), 0, 0)) return 0;
        pm = readback.pixmap();
    }
    SkFILEWStream out(path);
    if (!out.isValid()) return 0;
    return SkPngEncoder::Encode(&out, pm, SkPngEncoder::Options{}) ? 1 : 0;
}

const void *pu_surface_pixels(const PuSurface *s) {
    if (!s || !s->surface) return nullptr;
    SkPixmap pm;
    if (!s->surface->peekPixels(&pm)) return nullptr;
    return pm.addr();
}

int pu_surface_width(const PuSurface *s)  { return s ? s->width  : 0; }
int pu_surface_height(const PuSurface *s) { return s ? s->height : 0; }

int pu_surface_row_bytes(const PuSurface *s) {
    if (!s || !s->surface) return 0;
    SkPixmap pm;
    if (!s->surface->peekPixels(&pm)) return 0;
    return static_cast<int>(pm.rowBytes());
}

} // extern "C"
