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
#include "include/gpu/gl/GrGLTypes.h"                   /* GrGLFramebufferInfo */

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

// Lazily-resolved default system typeface (Windows UI font via DirectWrite).
static sk_sp<SkTypeface> default_typeface() {
    static sk_sp<SkTypeface> tf;
    static bool tried = false;
    if (!tried) {
        tried = true;
        sk_sp<SkFontMgr> mgr = SkFontMgr_New_DirectWrite(nullptr, nullptr, nullptr);
        if (mgr) tf = mgr->legacyMakeTypeface(nullptr, SkFontStyle());
    }
    return tf;
}

// BGRA8888 + premul: byte order in memory is B,G,R,A, which matches a Windows
// 32-bit top-down DIB (BI_RGB) for a zero-copy blit.
struct PuSurface {
    sk_sp<SkSurface> surface;
    int width  = 0;
    int height = 0;

    /* GPU (GL) mode — renders to the window framebuffer. */
    bool  gl = false;
    HWND  hwnd = nullptr;
    HDC   hdc = nullptr;
    HGLRC hglrc = nullptr;
    sk_sp<GrDirectContext> grctx;
};

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

PuSurface *pu_surface_create_gl(void *hwndv, int width, int height) {
    PuSurface *s = new (std::nothrow) PuSurface();
    if (!s) return nullptr;
    s->gl = true;
    s->hwnd = (HWND)hwndv;
    s->hdc = GetDC(s->hwnd);
    if (!s->hdc) { delete s; return nullptr; }

    PIXELFORMATDESCRIPTOR pfd;
    memset(&pfd, 0, sizeof(pfd));
    pfd.nSize = sizeof(pfd);
    pfd.nVersion = 1;
    pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    pfd.iPixelType = PFD_TYPE_RGBA;
    pfd.cColorBits = 32;
    pfd.cAlphaBits = 8;
    pfd.cStencilBits = 8;
    pfd.iLayerType = PFD_MAIN_PLANE;
    int pf = ChoosePixelFormat(s->hdc, &pfd);
    if (!pf || !SetPixelFormat(s->hdc, pf, &pfd)) {
        PU_GLLOG("ChoosePixelFormat/SetPixelFormat failed");
        ReleaseDC(s->hwnd, s->hdc); delete s; return nullptr;
    }
    s->hglrc = wglCreateContext(s->hdc);
    if (!s->hglrc || !wglMakeCurrent(s->hdc, s->hglrc)) {
        PU_GLLOG("wglCreateContext/MakeCurrent failed");
        if (s->hglrc) wglDeleteContext(s->hglrc);
        ReleaseDC(s->hwnd, s->hdc); delete s; return nullptr;
    }
    s->grctx = GrDirectContexts::MakeGL();
    if (!s->grctx) {
        /* No usable GPU GL (e.g. software "GDI Generic" GL 1.1 in a remote/VM
         * session). Report it; the caller falls back to a raster surface. */
        typedef const unsigned char *(__stdcall *GetStr)(unsigned int);
        GetStr glGetString = (GetStr)(void *)GetProcAddress(GetModuleHandleA("opengl32.dll"), "glGetString");
        const char *ver = glGetString ? (const char *)glGetString(0x1F02) : "?";
        const char *ren = glGetString ? (const char *)glGetString(0x1F01) : "?";
        std::fprintf(stderr, "[render] no GPU OpenGL (GL %s, %s) - using raster\n",
                     ver ? ver : "?", ren ? ren : "?");
        wglMakeCurrent(nullptr, nullptr);
        wglDeleteContext(s->hglrc);
        ReleaseDC(s->hwnd, s->hdc); delete s; return nullptr;
    }
    rewrap_gl(s, width, height);
    if (!s->surface) {
        PU_GLLOG("WrapBackendRenderTarget returned null");
        s->grctx.reset();
        wglMakeCurrent(nullptr, nullptr);
        wglDeleteContext(s->hglrc);
        ReleaseDC(s->hwnd, s->hdc); delete s; return nullptr;
    }
    return s;
}

int pu_surface_is_gl(const PuSurface *s) { return (s && s->gl) ? 1 : 0; }

void pu_surface_present(PuSurface *s) {
    if (!s || !s->gl) return;
    if (s->surface) skgpu::ganesh::FlushAndSubmit(s->surface.get());
    SwapBuffers(s->hdc);
}

void pu_surface_destroy(PuSurface *s) {
    if (!s) return;
    if (s->gl) {
        s->surface.reset();
        if (s->grctx) { s->grctx->abandonContext(); s->grctx.reset(); }
        wglMakeCurrent(nullptr, nullptr);
        if (s->hglrc) wglDeleteContext(s->hglrc);
        if (s->hdc && s->hwnd) ReleaseDC(s->hwnd, s->hdc);
    }
    delete s; // sk_sp releases the surface
}

void pu_surface_resize(PuSurface *s, int width, int height) {
    if (!s) return;
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;
    if (width == s->width && height == s->height && s->surface) return;
    if (s->gl) {
        wglMakeCurrent(s->hdc, s->hglrc);
        rewrap_gl(s, width, height); /* default FBO resized with the window */
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

void pu_text_measure(const char *utf8, float font_size, float *out_w, float *out_h) {
    SkFont font(default_typeface(), font_size);
    float w = (utf8 && *utf8)
                  ? font.measureText(utf8, std::strlen(utf8), SkTextEncoding::kUTF8, nullptr)
                  : 0.0f;
    SkFontMetrics m;
    font.getMetrics(&m);
    if (out_w) *out_w = w;
    if (out_h) *out_h = m.fDescent - m.fAscent; // ascent is negative
}

void pu_surface_draw_text(PuSurface *s, const char *utf8, float x, float y,
                          float font_size, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!s || !s->surface || !utf8 || !*utf8) return;
    SkFont font(default_typeface(), font_size);
    font.setEdging(SkFont::Edging::kAntiAlias);
    font.setSubpixel(true);
    SkFontMetrics m;
    font.getMetrics(&m);
    SkPaint paint;
    paint.setColor(SkColorSetARGB(a, r, g, b));
    paint.setAntiAlias(true);
    // (x, y) is the top-left; shift to baseline.
    s->surface->getCanvas()->drawString(utf8, x, y - m.fAscent, font, paint);
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
