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
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkFontStyle.h"
#include "include/core/SkFontTypes.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkStream.h"
#include "include/encode/SkPngEncoder.h"

#include <cstdlib>
#include <cstring>
#include <new>

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
};

static sk_sp<SkSurface> make_raster(int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    const SkImageInfo info =
        SkImageInfo::Make(w, h, kBGRA_8888_SkColorType, kPremul_SkAlphaType);
    return SkSurfaces::Raster(info);
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

void pu_surface_destroy(PuSurface *s) {
    delete s; // sk_sp releases the surface
}

void pu_surface_resize(PuSurface *s, int width, int height) {
    if (!s) return;
    if (width  < 1) width  = 1;
    if (height < 1) height = 1;
    if (width == s->width && height == s->height && s->surface) return;
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
