#include "render/canvas_c.h"
#include "include/core/SkCanvas.h"
#include "include/core/SkColorFilter.h"
#include "include/core/SkData.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkImage.h"
#include "include/core/SkPaint.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathEffect.h"
#include "include/core/SkPathUtils.h"
#include "include/core/SkRRect.h"
#include "include/core/SkStream.h"
#include "include/effects/SkDashPathEffect.h"
#include "include/effects/SkGradientShader.h"
#include "include/effects/SkImageFilters.h"
#include "include/encode/SkJpegEncoder.h"
#include "include/encode/SkPngEncoder.h"
#include "include/utils/SkParsePath.h"
#include "render/skia_internal.h"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <new>
#include <string>
#include <vector>

extern sk_sp<SkImage> pu_canvas_cached_image(const char *key);
extern SkFont pu_canvas_font(float size, int weight, int italic, const char *family);
extern bool pu_canvas_text_outline(const SkFont &font, const char *text, size_t length,
                                   SkPath *path, float *advance, int direction);

static size_t live_backings, live_resources;
size_t pu_canvas_live_backings(void) { return live_backings; }
size_t pu_canvas_live_resources(void) { return live_resources; }

struct PuCanvasResource {
    PuCanvasResource() { ++live_resources; }
    ~PuCanvasResource() { --live_resources; }
    enum Kind { Path, Linear, Radial, Pattern, Image } kind = Path;
    SkPath path;
    SkMatrix matrix = SkMatrix::I();
    sk_sp<SkImage> image;
    std::vector<SkColor> colors;
    std::vector<SkScalar> stops;
    double points[6] = {};
    SkTileMode tile_x = SkTileMode::kRepeat, tile_y = SkTileMode::kRepeat;
};
struct PuCanvas {
    PuCanvas() { ++live_backings; }
    ~PuCanvas() { pu_gpu_canvas_unref(gpu); --live_backings; }
    sk_sp<SkSurface> surface;
    PuGpuCanvas *gpu = nullptr;
    uint64_t gpu_revision = 0;
    uint64_t gpu_display_revision = 0;
    sk_sp<SkImage> gpu_display;
    int width = 0, height = 0;
    SkMatrix transform = SkMatrix::I();
    std::vector<SkMatrix> saved_transforms;
    SkPath path;
    SkPaint paint;
    double shadow[7] = {};
    bool smooth = true;
    bool opaque = false;
    double alpha = 1;
};

static SkMatrix matrix(const double *a)
{
    return SkMatrix::MakeAll(a[0], a[2], a[4], a[1], a[3], a[5], 0, 0, 1);
}
static SkColor color(const double *a)
{
    return SkColorSetARGB((unsigned)std::round(a[3]), (unsigned)a[0], (unsigned)a[1],
                          (unsigned)a[2]);
}
static sk_sp<SkShader> shader(PuCanvasResource *r, const SkMatrix &ctm, bool smooth)
{
    if (!r)
        return nullptr;
    SkMatrix test;
    if (!r->matrix.invert(&test))
        return SkShaders::Color(SK_ColorTRANSPARENT);
    if (r->kind == PuCanvasResource::Pattern)
        return r->image->makeShader(
            r->tile_x, r->tile_y,
            SkSamplingOptions(smooth ? SkFilterMode::kLinear : SkFilterMode::kNearest), &r->matrix);
    if (r->colors.empty())
        return SkShaders::Color(SK_ColorTRANSPARENT);
    std::vector<size_t> order(r->stops.size());
    for (size_t i = 0; i < order.size(); ++i)
        order[i] = i;
    std::stable_sort(order.begin(), order.end(),
                     [&](size_t a, size_t b) { return r->stops[a] < r->stops[b]; });
    std::vector<SkColor> colors;
    std::vector<SkScalar> stops;
    for (size_t i : order) {
        colors.push_back(r->colors[i]);
        stops.push_back(r->stops[i]);
    }
    if (colors.size() == 1) {
        colors.push_back(colors[0]);
        stops.push_back(stops[0]);
    }
    auto p = r->points;
    SkMatrix inverse, local = r->matrix;
    if (ctm.invert(&inverse))
        local = SkMatrix::Concat(inverse, local);
    if (r->kind == PuCanvasResource::Linear) {
        if (p[0] == p[2] && p[1] == p[3])
            return SkShaders::Color(SK_ColorTRANSPARENT);
        SkPoint pts[] = {{(float)p[0], (float)p[1]}, {(float)p[2], (float)p[3]}};
        return SkGradientShader::MakeLinear(pts, colors.data(), stops.data(), (int)colors.size(),
                                            SkTileMode::kClamp, 0, &local);
    }
    if (p[0] == p[3] && p[1] == p[4] && p[2] == p[5])
        return SkShaders::Color(SK_ColorTRANSPARENT);
    return SkGradientShader::MakeTwoPointConical(
        {(float)p[0], (float)p[1]}, p[2], {(float)p[3], (float)p[4]}, p[5], colors.data(),
        stops.data(), (int)colors.size(), SkTileMode::kClamp, 0, &local);
}
PuCanvas *pu_canvas_create(int width, int height)
{
    auto c = new (std::nothrow) PuCanvas;
    if (c && !pu_canvas_resize(c, width, height)) {
        delete c;
        return nullptr;
    }
    return c;
}
void pu_canvas_destroy(PuCanvas *c) { delete c; }
int pu_canvas_resize(PuCanvas *c, int w, int h)
{
    if (!c || w < 0 || h < 0 || (h && (size_t)w > PU_CANVAS_PIXEL_LIMIT / (size_t)h))
        return 0;
    sk_sp<SkSurface> next;
    if (w && h) {
        next = SkSurfaces::Raster(SkImageInfo::Make(
            w, h, kN32_SkColorType, c->opaque ? kOpaque_SkAlphaType : kPremul_SkAlphaType));
        if (!next)
            return 0;
        next->getCanvas()->clear(c->opaque ? SK_ColorBLACK : SK_ColorTRANSPARENT);
    }
    if (c->gpu && !pu_gpu_canvas_resize(c->gpu, w, h))
        return 0;
    c->surface = std::move(next);
    c->gpu_revision = 0;
    c->gpu_display_revision = 0;
    c->gpu_display.reset();
    c->width = w;
    c->height = h;
    c->path.reset();
    c->transform = SkMatrix::I();
    c->saved_transforms.clear();
    return 1;
}
int pu_canvas_width(const PuCanvas *c) { return c ? c->width : 300; }
int pu_canvas_height(const PuCanvas *c) { return c ? c->height : 150; }
PuGpuCanvas *pu_canvas_gpu(PuCanvas *c) { return c ? c->gpu : nullptr; }
PuGpuCanvas *pu_canvas_acquire_gpu(PuCanvas *c, int alpha, int depth, int stencil, int premultiplied, int preserve)
{
    if (!c) return nullptr;
    if (!c->gpu) c->gpu = pu_gpu_canvas_create(c->width, c->height, alpha, depth, stencil, premultiplied, preserve);
    return c->gpu;
}
static bool sync_gpu(PuCanvas *c, bool force = false)
{
    if (!c || !c->gpu || (!force && c->gpu_revision == pu_gpu_canvas_revision(c->gpu))) return true;
    if (!c->surface) return true;
    std::vector<uint8_t> pixels((size_t)c->width * c->height * 4);
    if (!pu_gpu_canvas_read(c->gpu, pixels.data(), pixels.size())) {
        std::fprintf(stderr, "[webgl2] cannot snapshot GPU canvas\n");
        return false;
    }
    auto info = SkImageInfo::Make(c->width, c->height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
    c->surface->writePixels(SkPixmap(info, pixels.data(), (size_t)c->width * 4), 0, 0);
    c->gpu_revision = pu_gpu_canvas_revision(c->gpu);
    return true;
}
void pu_canvas_composite(PuSurface *s, PuCanvas *c, float x, float y, float w, float h)
{
    if (!s || !s->surface || !c || !c->surface || w <= 0 || h <= 0) return;
    if (c->gpu && c->gpu_display_revision != pu_gpu_canvas_revision(c->gpu)) {
        if (!sync_gpu(c, true)) return;
        c->gpu_display = c->surface->makeImageSnapshot();
        c->gpu_display_revision = pu_gpu_canvas_revision(c->gpu);
    }
    s->surface->getCanvas()->drawImageRect(c->gpu ? c->gpu_display : c->surface->makeImageSnapshot(),
        SkRect::MakeXYWH(x, y, w, h), SkSamplingOptions(SkFilterMode::kLinear));
    if (c->gpu) pu_gpu_canvas_present(c->gpu);
}
PuCanvasResource *pu_canvas_snapshot(PuCanvas *c)
{
    if (!sync_gpu(c, true)) return nullptr;
    if (!c || !c->surface)
        return nullptr;
    auto r = new (std::nothrow) PuCanvasResource;
    if (r) {
        r->kind = PuCanvasResource::Image;
        r->image = c->surface->makeImageSnapshot();
    }
    return r;
}
PuCanvasResource *pu_canvas_image(const char *key)
{
    auto img = pu_canvas_cached_image(key);
    if (!img)
        return nullptr;
    auto r = new (std::nothrow) PuCanvasResource;
    if (r) {
        r->kind = PuCanvasResource::Image;
        r->image = std::move(img);
    }
    return r;
}
int pu_canvas_resource_read(PuCanvasResource *r, int w, int h, uint8_t *rgba)
{
    if (!r || !r->image || r->image->width() != w || r->image->height() != h) return 0;
    auto info = SkImageInfo::Make(w, h, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
    return r->image->readPixels(nullptr, info, rgba, (size_t)w * 4, 0, 0);
}
void pu_canvas_resource_destroy(PuCanvasResource *r) { delete r; }
PuCanvasResource *pu_canvas_resource(const char *kind, const double *a, size_t n, const char *text,
                                     PuCanvasResource *source)
{
    auto r = new (std::nothrow) PuCanvasResource;
    if (!r)
        return nullptr;
    if (!strcmp(kind, "path")) {
        if (source)
            r->path = source->path;
        else if (text && *text)
            SkParsePath::FromSVGString(text, &r->path);
    } else if (!strcmp(kind, "linear") || !strcmp(kind, "radial")) {
        bool linear = !strcmp(kind, "linear");
        if (n != (linear ? 10u : 12u)) {
            delete r;
            return nullptr;
        }
        r->kind = linear ? PuCanvasResource::Linear : PuCanvasResource::Radial;
        memcpy(r->points, a, (linear ? 4 : 6) * sizeof(double));
        r->matrix = matrix(a + (linear ? 4 : 6));
    } else if (!strcmp(kind, "pattern") && source && source->image) {
        r->kind = PuCanvasResource::Pattern;
        r->image = source->image;
        r->tile_x = !strcmp(text, "repeat-y") || !strcmp(text, "no-repeat") ? SkTileMode::kDecal
                                                                            : SkTileMode::kRepeat;
        r->tile_y = !strcmp(text, "repeat-x") || !strcmp(text, "no-repeat") ? SkTileMode::kDecal
                                                                            : SkTileMode::kRepeat;
    } else {
        delete r;
        return nullptr;
    }
    return r;
}

static bool path_op(SkPath &p, const char *op, const double *a, size_t n)
{
    if (!strcmp(op, "begin")) {
        p.reset();
        return true;
    }
    if (!strcmp(op, "close")) {
        p.close();
        return true;
    }
    if (!strcmp(op, "move") && n == 2) {
        p.moveTo(a[0], a[1]);
        return true;
    }
    if (!strcmp(op, "line") && n == 2) {
        if (p.isEmpty())
            p.moveTo(a[0], a[1]);
        else
            p.lineTo(a[0], a[1]);
        return true;
    }
    if (!strcmp(op, "quad") && n == 4) {
        if (p.isEmpty())
            p.moveTo(a[0], a[1]);
        p.quadTo(a[0], a[1], a[2], a[3]);
        return true;
    }
    if (!strcmp(op, "bezier") && n == 6) {
        if (p.isEmpty())
            p.moveTo(a[0], a[1]);
        p.cubicTo(a[0], a[1], a[2], a[3], a[4], a[5]);
        return true;
    }
    if (!strcmp(op, "rect") && n == 4) {
        p.moveTo(a[0], a[1]);
        p.lineTo(a[0] + a[2], a[1]);
        p.lineTo(a[0] + a[2], a[1] + a[3]);
        p.lineTo(a[0], a[1] + a[3]);
        p.close();
        p.moveTo(a[0], a[1]);
        return true;
    }
    if (!strcmp(op, "roundRect") && n == 13) {
        SkVector radii[4];
        for (int i = 0; i < 4; ++i)
            radii[i].set(a[4 + i * 2], a[5 + i * 2]);
        SkRRect box;
        box.setRectRadii(SkRect::MakeXYWH(a[0], a[1], a[2], a[3]), radii);
        p.addRRect(box, a[12] ? SkPathDirection::kCCW : SkPathDirection::kCW);
        p.moveTo(a[0], a[1]);
        return true;
    }
    if (!strcmp(op, "arcTo") && n == 5) {
        if (p.isEmpty())
            p.moveTo(a[0], a[1]);
        else
            p.arcTo(a[0], a[1], a[2], a[3], a[4]);
        return true;
    }
    if (!strcmp(op, "ellipse") && n == 9) {
        const double tau = 6.2831853071795864769;
        double sweep = a[7] - a[6];
        if (!a[8]) {
            if (sweep >= tau)
                sweep = tau;
            else {
                sweep = fmod(sweep, tau);
                if (sweep < 0)
                    sweep += tau;
            }
        } else {
            if (-sweep >= tau)
                sweep = -tau;
            else {
                sweep = fmod(sweep, tau);
                if (sweep > 0)
                    sweep -= tau;
            }
        }
        SkPath arc;
        arc.addArc(SkRect::MakeLTRB(-a[2], -a[3], a[2], a[3]), a[6] * 180 / 3.141592653589793,
                   sweep * 180 / 3.141592653589793);
        SkMatrix m = SkMatrix::RotateDeg(a[4] * 180 / 3.141592653589793);
        m.postTranslate(a[0], a[1]);
        arc.transform(m);
        if (sweep == 0 || a[2] == 0 || a[3] == 0) {
            double x = a[0] + cos(a[4]) * a[2] * cos(a[6]) - sin(a[4]) * a[3] * sin(a[6]);
            double y = a[1] + sin(a[4]) * a[2] * cos(a[6]) + cos(a[4]) * a[3] * sin(a[6]);
            if (p.isEmpty())
                p.moveTo(x, y);
            else
                p.lineTo(x, y);
        } else
            p.addPath(arc, SkPath::kExtend_AddPathMode);
        return true;
    }
    return false;
}
static void draw(PuCanvas *c, const SkPath &path, bool stroke)
{
    if (path.isEmpty())
        return;
    auto canvas = c->surface->getCanvas();
    SkPaint p = c->paint;
    p.setStyle(stroke ? SkPaint::kStroke_Style : SkPaint::kFill_Style);
    SkPaint layer;
    layer.setBlendMode(p.getBlendMode_or(SkBlendMode::kSrcOver));
    canvas->saveLayer(nullptr, &layer);
    p.setBlendMode(SkBlendMode::kSrcOver);
    if (c->shadow[3] > 0 && (c->shadow[4] || c->shadow[5] || c->shadow[6])) {
        SkPaint shadow = p;
        shadow.setImageFilter(SkImageFilters::DropShadowOnly(c->shadow[5], c->shadow[6],
                                                             c->shadow[4] / 2, c->shadow[4] / 2,
                                                             color(c->shadow), nullptr));
        canvas->drawPath(path, shadow);
    }
    canvas->drawPath(path, p);
    canvas->restore();
}
int pu_canvas_command(PuCanvas *c, PuCanvasResource *target, const char *op, const double *a,
                      size_t n, const char *text, size_t text_length, PuCanvasResource *r,
                      double *out, size_t *out_n)
{
    *out_n = 0;
    try {
        if (target) {
            if (!strcmp(op, "stop") && n == 5 &&
                (target->kind == PuCanvasResource::Linear ||
                 target->kind == PuCanvasResource::Radial)) {
                target->stops.reserve(target->stops.size() + 1);
                target->colors.reserve(target->colors.size() + 1);
                target->stops.push_back(a[0]);
                target->colors.push_back(color(a + 1));
                return 1;
            }
            if (!strcmp(op, "matrix") && n == 6) {
                target->matrix = matrix(a);
                return 1;
            }
            if (!strcmp(op, "add") && r && n == 6) {
                target->path.addPath(r->path, matrix(a));
                return 1;
            }
            return target->kind == PuCanvasResource::Path && path_op(target->path, op, a, n) ? 1
                                                                                             : -1;
        }
        if (!c)
            return -1;
        if (!strcmp(op, "alpha") && n == 1) {
            c->opaque = a[0] == 0;
            return pu_canvas_resize(c, c->width, c->height);
        }
        auto canvas = c->surface ? c->surface->getCanvas() : nullptr;
        if (!strcmp(op, "matrix")) {
            if (n != 6)
                return -1;
            c->transform = matrix(a);
            if (canvas)
                canvas->setMatrix(c->transform);
            return 1;
        }
        if (!strcmp(op, "save")) {
            c->saved_transforms.push_back(c->transform);
            if (canvas)
                canvas->save();
            return 1;
        }
        if (!strcmp(op, "restore")) {
            if (!c->saved_transforms.empty()) {
                c->transform = c->saved_transforms.back();
                c->saved_transforms.pop_back();
                if (canvas)
                    canvas->restore();
            }
            return 1;
        }
        if (!strcmp(op, "configure") && n >= 19) {
            c->paint = SkPaint();
            c->paint.setAntiAlias(true);
            c->paint.setColor(color(a));
            c->alpha = a[4];
            c->paint.setAlphaf(c->paint.getAlphaf() * a[4]);
            c->paint.setStrokeWidth(a[5]);
            c->paint.setStrokeMiter(a[6]);
            c->paint.setStrokeCap((SkPaint::Cap)(int)a[7]);
            c->paint.setStrokeJoin((SkPaint::Join)(int)a[8]);
            c->paint.setBlendMode((SkBlendMode)(int)a[9]);
            c->smooth = a[10] != 0;
            memcpy(c->shadow, a + 11, sizeof(c->shadow));
            if (r) {
                c->paint.setShader(shader(r, c->transform, c->smooth));
                c->paint.setAlphaf(a[4]);
            }
            if (n > 19) {
                std::vector<SkScalar> dash;
                for (size_t i = 19; i < n; ++i)
                    dash.push_back(a[i]);
                c->paint.setPathEffect(
                    SkDashPathEffect::Make(dash.data(), (int)dash.size(), a[18]));
            }
            return 1;
        }
        SkMatrix m = c->transform, inv;
        if (!strcmp(op, "begin")) {
            c->path.reset();
            return 1;
        }
        if (!r && !strcmp(op, "close")) {
            c->path.close();
            return 1;
        }
        if (!r && !strcmp(op, "contains") && n == 3 && !a[2]) {
            SkPath test = c->path;
            test.setFillType(!strcmp(text, "evenodd") ? SkPathFillType::kEvenOdd
                                                      : SkPathFillType::kWinding);
            out[0] = test.contains(a[0], a[1]);
            *out_n = 1;
            return 1;
        }
        SkPath path = r && r->kind == PuCanvasResource::Path ? r->path : c->path;
        bool current = !r && strcmp(op, "measure");
        if (current && !m.invert(&inv)) {
            if (!strcmp(op, "contains")) {
                out[0] = 0;
                *out_n = 1;
                return 1;
            }
            if ((!strcmp(op, "move") || !strcmp(op, "line") || !strcmp(op, "quad") ||
                 !strcmp(op, "bezier")) &&
                n <= 6) {
                double mapped[6];
                for (size_t i = 0; i + 1 < n; i += 2) {
                    SkPoint point = m.mapXY(a[i], a[i + 1]);
                    mapped[i] = point.x();
                    mapped[i + 1] = point.y();
                }
                path_op(c->path, op, mapped, n);
            } else if (!strcmp(op, "rect") || !strcmp(op, "roundRect") || !strcmp(op, "ellipse")) {
                SkPath segment;
                if (path_op(segment, op, a, n)) {
                    segment.transform(m);
                    c->path.addPath(segment, !strcmp(op, "ellipse") ? SkPath::kExtend_AddPathMode
                                                                    : SkPath::kAppend_AddPathMode);
                }
            }
            return 1;
        }
        if (current)
            path.transform(inv);
        if (path_op(path, op, a, n)) {
            path.transform(m);
            c->path = path;
            return 1;
        }
        if (!strcmp(op, "fill") || !strcmp(op, "stroke") || !strcmp(op, "clip") ||
            !strcmp(op, "contains")) {
            path.setFillType(text && !strcmp(text, "evenodd") ? SkPathFillType::kEvenOdd
                                                              : SkPathFillType::kWinding);
            if (!strcmp(op, "contains") && n == 3) {
                if (a[2]) {
                    SkPath outline;
                    SkPaint stroke = c->paint;
                    stroke.setStyle(SkPaint::kStroke_Style);
                    skpathutils::FillPathWithPaint(path, stroke, &outline);
                    path = outline;
                }
                path.transform(m);
                out[0] = path.contains(a[0], a[1]);
                *out_n = 1;
                return 1;
            }
            if (canvas) {
                if (!strcmp(op, "clip"))
                    canvas->clipPath(path, true);
                else
                    draw(c, path, !strcmp(op, "stroke"));
            }
            return 1;
        }
        if ((!strcmp(op, "fillRect") || !strcmp(op, "strokeRect") || !strcmp(op, "clearRect")) &&
            n == 4) {
            if (!canvas)
                return 1;
            SkPath box;
            path_op(box, "rect", a, n);
            if (!strcmp(op, "clearRect")) {
                SkPaint p;
                p.setColor(SK_ColorBLACK);
                p.setBlendMode(c->opaque ? SkBlendMode::kSrc : SkBlendMode::kClear);
                p.setAntiAlias(true);
                canvas->drawPath(box, p);
            } else
                draw(c, box, !strcmp(op, "strokeRect"));
            return 1;
        }
        if (!strcmp(op, "image") && r && r->image && n == 8) {
            if (canvas) {
                SkPaint p = c->paint;
                p.setShader(nullptr);
                p.setAlphaf(c->alpha);
                SkPaint layer;
                layer.setBlendMode(p.getBlendMode_or(SkBlendMode::kSrcOver));
                canvas->saveLayer(nullptr, &layer);
                p.setBlendMode(SkBlendMode::kSrcOver);
                if (c->shadow[3] > 0 && (c->shadow[4] || c->shadow[5] || c->shadow[6])) {
                    SkPaint shadow = p;
                    shadow.setImageFilter(SkImageFilters::DropShadowOnly(
                        c->shadow[5], c->shadow[6], c->shadow[4] / 2, c->shadow[4] / 2,
                        color(c->shadow), nullptr));
                    canvas->drawImageRect(r->image, SkRect::MakeXYWH(a[0], a[1], a[2], a[3]),
                                          SkRect::MakeXYWH(a[4], a[5], a[6], a[7]),
                                          SkSamplingOptions(SkFilterMode::kLinear), &shadow,
                                          SkCanvas::kStrict_SrcRectConstraint);
                }
                canvas->drawImageRect(
                    r->image, SkRect::MakeXYWH(a[0], a[1], a[2], a[3]),
                    SkRect::MakeXYWH(a[4], a[5], a[6], a[7]),
                    SkSamplingOptions(c->smooth ? SkFilterMode::kLinear : SkFilterMode::kNearest),
                    &p, SkCanvas::kStrict_SrcRectConstraint);
                canvas->restore();
            }
            return 1;
        }
        if ((!strcmp(op, "text") || !strcmp(op, "measure")) && n == 10) {
            SkFont font = pu_canvas_font(a[0], (int)a[1], (int)a[2], text);
            /* The string follows the family in a separate NUL-terminated segment. */
            const char *str = text + strlen(text) + 1;
            size_t string_length = text_length - (size_t)(str - text);
            SkPath glyphs;
            float advance;
            if (!pu_canvas_text_outline(font, str, string_length, &glyphs, &advance, (int)a[9]))
                return 0;
            SkRect bounds = glyphs.computeTightBounds();
            SkFontMetrics metrics;
            font.getMetrics(&metrics);
            float baseline = 0;
            if ((int)a[6] == 1)
                baseline = -metrics.fAscent;
            else if ((int)a[6] == 2)
                baseline = -metrics.fAscent * .8f;
            else if ((int)a[6] == 3)
                baseline = -(metrics.fAscent + metrics.fDescent) / 2;
            else if ((int)a[6] == 4)
                baseline = -metrics.fDescent;
            if (!strcmp(op, "measure")) {
                out[0] = advance;
                out[1] = -bounds.left();
                out[2] = bounds.right();
                out[3] = -bounds.top() - baseline;
                out[4] = bounds.bottom() + baseline;
                out[5] = -metrics.fAscent - baseline;
                out[6] = metrics.fDescent + baseline;
                *out_n = 7;
                return 1;
            }
            float x = a[3], y = a[4];
            if ((int)a[5] == 1)
                x -= advance / 2;
            else if ((int)a[5] == 2)
                x -= advance;
            y += baseline;
            if (a[8] > 0 && advance > a[8]) {
                SkMatrix scale = SkMatrix::Scale(a[8] / advance, 1);
                glyphs.transform(scale);
                if ((int)a[5] == 1)
                    x += (advance - a[8]) / 2;
                else if ((int)a[5] == 2)
                    x += advance - a[8];
            }
            glyphs.offset(x, y);
            if (canvas)
                draw(c, glyphs, a[7] != 0);
            return 1;
        }
        return -1;
    } catch (const std::bad_alloc &) {
        return 0;
    }
}
int pu_canvas_read(PuCanvas *c, int x, int y, int w, int h, uint8_t *rgba)
{
    if (!sync_gpu(c, true)) return 0;
    memset(rgba, 0, (size_t)w * h * 4);
    if (!c || !c->surface)
        return 1;
    auto info = SkImageInfo::Make(w, h, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
    if (x >= c->width || y >= c->height || (int64_t)x + w <= 0 || (int64_t)y + h <= 0)
        return 1;
    return c->surface->readPixels(info, rgba, (size_t)w * 4, x, y);
}
int pu_canvas_write(PuCanvas *c, int w, int h, const uint8_t *rgba, int x, int y, int dx, int dy,
                    int dw, int dh)
{
    if (!c || !c->surface)
        return 1;
    int64_t left = std::max<int64_t>(0, dx), top = std::max<int64_t>(0, dy);
    int64_t right = std::min<int64_t>(w, (int64_t)dx + dw),
            bottom = std::min<int64_t>(h, (int64_t)dy + dh);
    if (left >= right || top >= bottom)
        return 1;
    SkPixmap pixmap(SkImageInfo::Make((int)(right - left), (int)(bottom - top),
                                      kRGBA_8888_SkColorType, kUnpremul_SkAlphaType),
                    rgba + (top * w + left) * 4, (size_t)w * 4);
    int64_t dest_x = (int64_t)x + left, dest_y = (int64_t)y + top;
    if (dest_x >= c->width || dest_y >= c->height || dest_x + right - left <= 0 ||
        dest_y + bottom - top <= 0)
        return 1;
    c->surface->writePixels(pixmap, (int)dest_x, (int)dest_y);
    return 1;
}
int pu_canvas_encode(PuCanvas *c, int jpeg, double quality, uint8_t **bytes, size_t *length)
{
    if (!sync_gpu(c, true)) return 0;
    if (!c || !c->surface)
        return 0;
    SkPixmap pixmap;
    if (!c->surface->peekPixels(&pixmap))
        return 0;
    SkDynamicMemoryWStream stream;
    bool ok;
    if (jpeg) {
        SkJpegEncoder::Options opts;
        opts.fQuality = (int)std::round(quality * 100);
        opts.fAlphaOption = SkJpegEncoder::AlphaOption::kBlendOnBlack;
        ok = SkJpegEncoder::Encode(&stream, pixmap, opts);
    } else
        ok = SkPngEncoder::Encode(&stream, pixmap, {});
    if (!ok)
        return 0;
    auto data = stream.detachAsData();
    *length = data->size();
    *bytes = (uint8_t *)malloc(*length);
    if (!*bytes)
        return 0;
    memcpy(*bytes, data->data(), *length);
    return 1;
}
void pu_canvas_bytes_free(uint8_t *bytes) { free(bytes); }
