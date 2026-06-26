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

#include <cstdlib>
#include <new>

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
