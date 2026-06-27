// RenderEngine — Skia shim implementation (the sole .cpp in PollyUI).
// Compiled as C++ against Skia's headers; exposes only the extern "C" API in
// skia_c.h. See DESIGN.md §3.

#include "render/skia_c.h"

#include "include/core/SkSurface.h"
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
#include "include/core/SkTypeface.h"
#include "include/core/SkStream.h"
#include "include/encode/SkPngEncoder.h"

/* GPU (Ganesh GL) backend. */
#include "include/gpu/GrDirectContext.h"
#include "include/gpu/GrBackendSurface.h"
#include "include/gpu/ganesh/gl/GrGLDirectContext.h"   /* GrDirectContexts::MakeGL */
#include "include/gpu/ganesh/gl/GrGLBackendSurface.h"  /* GrBackendRenderTargets::MakeGL */
#include "include/gpu/ganesh/SkSurfaceGanesh.h"        /* SkSurfaces::WrapBackendRenderTarget, FlushAndSubmit */
#include "include/gpu/gl/GrGLAssembleInterface.h" /* GrGLMakeAssembledGLESInterface */
#include "include/gpu/gl/GrGLTypes.h"                   /* GrGLFramebufferInfo, GrGLFuncPtr */

#include <windows.h>   /* WGL + HWND/HDC for the GPU surface */

#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <new>

#define PU_GL_RGBA8 0x8058
#define PU_GLLOG(msg) std::fprintf(stderr, "[gl] %s\n", msg)

// SkFontMgr_New_DirectWrite is in skia.lib but the package ships no header for
// it; declare it ourselves (default null args -> Skia builds a DWrite factory).
struct IDWriteFactory;
struct IDWriteFontCollection;
struct IDWriteFontFallback;
extern sk_sp<SkFontMgr> SkFontMgr_New_DirectWrite(IDWriteFactory *,
                                                  IDWriteFontCollection *,
                                                  IDWriteFontFallback *);

// Lazily-resolved system font manager (Windows fonts via DirectWrite).
static sk_sp<SkFontMgr> font_mgr() {
    static sk_sp<SkFontMgr> mgr;
    static bool tried = false;
    if (!tried) { tried = true; mgr = SkFontMgr_New_DirectWrite(nullptr, nullptr, nullptr); }
    return mgr;
}

// Default UI typeface at a given weight (e.g. 400 normal, 700 bold) and slant.
static sk_sp<SkTypeface> typeface_for(int weight, int italic) {
    sk_sp<SkFontMgr> mgr = font_mgr();
    if (!mgr) return nullptr;
    SkFontStyle style(weight > 0 ? weight : SkFontStyle::kNormal_Weight,
                      SkFontStyle::kNormal_Width,
                      italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant);
    return mgr->legacyMakeTypeface(nullptr, style);
}

static SkFont make_font(float size, int weight, int italic) {
    SkFont font(typeface_for(weight, italic), size);
    font.setEdging(SkFont::Edging::kAntiAlias);
    font.setSubpixel(true);
    return font;
}

// BGRA8888 + premul: byte order in memory is B,G,R,A, which matches a Windows
// 32-bit top-down DIB (BI_RGB) for a zero-copy blit.
struct PuSurface {
    sk_sp<SkSurface> surface;
    int width  = 0;
    int height = 0;

    /* GPU mode — renders to the window framebuffer via ANGLE/EGL (GLES->D3D11). */
    bool  gl = false;
    HWND  hwnd = nullptr;
    void *egl_display = nullptr;
    void *egl_surface = nullptr;
    void *egl_context = nullptr;
    sk_sp<GrDirectContext> grctx;
};

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
    unsigned (__stdcall *BindAPI)(unsigned) = nullptr;
    unsigned (__stdcall *DestroySurface)(void *, void *) = nullptr;
    unsigned (__stdcall *DestroyContext)(void *, void *) = nullptr;
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
    PU_LD(BindAPI,               "eglBindAPI");
    PU_LD(DestroySurface,        "eglDestroySurface");
    PU_LD(DestroyContext,        "eglDestroyContext");
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

static sk_sp<SkSurface> make_raster(int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    const SkImageInfo info =
        SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kPremul_SkAlphaType);
    return SkSurfaces::Raster(info);
}

/* Wrap the window's default framebuffer (FBO 0) as a Skia GPU surface. */
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

extern "C" {

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

PuSurface *pu_surface_create_gl(void *hwndv, int width, int height) {
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

    s->grctx = GrDirectContexts::MakeGL(GrGLMakeAssembledGLESInterface(nullptr, pu_egl_get_proc));
    if (!s->grctx) { PU_GLLOG("GrDirectContexts::MakeGL (GLES) failed"); delete s; return nullptr; }
    rewrap_gl(s, width, height);
    if (!s->surface) { PU_GLLOG("WrapBackendRenderTarget failed"); delete s; return nullptr; }
    std::fprintf(stderr, "[render] GPU backend: ANGLE / D3D11 (EGL %d.%d)\n", maj, min);
    return s;
}

int pu_surface_is_gl(const PuSurface *s) { return (s && s->gl) ? 1 : 0; }

void pu_surface_present(PuSurface *s) {
    if (!s || !s->gl) return;
    if (s->surface) skgpu::ganesh::FlushAndSubmit(s->surface.get());
    if (g_egl.SwapBuffers) g_egl.SwapBuffers(s->egl_display, s->egl_surface);
}

void pu_surface_destroy(PuSurface *s) {
    if (!s) return;
    if (s->gl) {
        s->surface.reset();
        if (s->grctx) { s->grctx->abandonContext(); s->grctx.reset(); }
        if (g_egl.MakeCurrent && s->egl_display) g_egl.MakeCurrent(s->egl_display, nullptr, nullptr, nullptr);
        if (g_egl.DestroyContext && s->egl_context) g_egl.DestroyContext(s->egl_display, s->egl_context);
        if (g_egl.DestroySurface && s->egl_surface) g_egl.DestroySurface(s->egl_display, s->egl_surface);
    }
    delete s; // sk_sp releases the surface
}

void pu_surface_resize(PuSurface *s, int width, int height) {
    if (!s) return;
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;
    if (width == s->width && height == s->height && s->surface) return;
    if (s->gl) {
        if (g_egl.MakeCurrent)
            g_egl.MakeCurrent(s->egl_display, s->egl_surface, s->egl_surface, s->egl_context);
        rewrap_gl(s, width, height); /* ANGLE window surface resizes with the window */
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

void pu_text_measure(const char *utf8, float font_size, int weight, int italic,
                     float *out_w, float *out_h) {
    SkFont font = make_font(font_size, weight, italic);
    SkFontMetrics m;
    font.getMetrics(&m);
    float line_h = m.fDescent - m.fAscent; // ascent is negative

    float maxw = 0;
    int lines = 0;
    const char *p = utf8 ? utf8 : "";
    for (;;) {                                   // measure each '\n'-separated line
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        if (len > 0) {
            float w = font.measureText(p, len, SkTextEncoding::kUTF8, nullptr);
            if (w > maxw) maxw = w;
        }
        lines++;
        if (!nl) break;
        p = nl + 1;
    }
    if (out_w) *out_w = maxw;
    if (out_h) *out_h = line_h * (lines < 1 ? 1 : lines);
}

void pu_surface_draw_text(PuSurface *s, const char *utf8, float x, float y,
                          float font_size, int weight, int italic,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface || !utf8 || !*utf8) return;
    SkFont font = make_font(font_size, weight, italic);
    SkFontMetrics m;
    font.getMetrics(&m);
    float line_h = m.fDescent - m.fAscent;
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);

    SkCanvas *canvas = s->surface->getCanvas();
    const char *p = utf8;
    float ly = y;
    for (;;) {                                   // draw each line, advancing baseline
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        if (len > 0)
            canvas->drawSimpleText(p, len, SkTextEncoding::kUTF8, x, ly - m.fAscent, font, paint);
        ly += line_h;
        if (!nl) break;
        p = nl + 1;
    }
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
    if (!s->surface->peekPixels(&pm)) return 0;
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
