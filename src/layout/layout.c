#include "layout/layout.h"
#include "render/skia_c.h"   /* pu_text_measure for the text measure callback */

#include <yoga/Yoga.h>

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/* ---- style value parsing ---------------------------------------------------*/

static bool parse_number(const char *s, float *out)
{
    if (!s || !*s) return false;
    char *end;
    double v = strtod(s, &end);
    while (*end == ' ') end++;
    if (*end == '\0') { *out = (float)v; return true; }
    if (end[0] == 'p' && end[1] == 'x' && end[2] == '\0') { *out = (float)v; return true; }
    return false;
}

static bool parse_percent(const char *s, float *out)
{
    if (!s || !*s) return false;
    char *end;
    double v = strtod(s, &end);
    if (end != s && end[0] == '%' && end[1] == '\0') { *out = (float)v; return true; }
    return false;
}

typedef void (*DimPoints)(YGNodeRef, float);
typedef void (*DimAuto)(YGNodeRef);

static void apply_dim(YGNodeRef y, const char *val,
                      DimPoints set_points, DimPoints set_percent, DimAuto set_auto)
{
    if (!val) return;
    float f;
    if (strcmp(val, "auto") == 0) { if (set_auto) set_auto(y); return; }
    if (parse_percent(val, &f))   { set_percent(y, f); return; }
    if (parse_number(val, &f))    { set_points(y, f); return; }
}

static YGFlexDirection parse_flex_dir(const char *v)
{
    if (v && strcmp(v, "row") == 0)            return YGFlexDirectionRow;
    if (v && strcmp(v, "row-reverse") == 0)    return YGFlexDirectionRowReverse;
    if (v && strcmp(v, "column-reverse") == 0) return YGFlexDirectionColumnReverse;
    return YGFlexDirectionColumn;
}

static YGJustify parse_justify(const char *v)
{
    if (!v) return YGJustifyFlexStart;
    if (strcmp(v, "center") == 0)        return YGJustifyCenter;
    if (strcmp(v, "flex-end") == 0)      return YGJustifyFlexEnd;
    if (strcmp(v, "space-between") == 0) return YGJustifySpaceBetween;
    if (strcmp(v, "space-around") == 0)  return YGJustifySpaceAround;
    if (strcmp(v, "space-evenly") == 0)  return YGJustifySpaceEvenly;
    return YGJustifyFlexStart;
}

static YGAlign parse_align(const char *v)
{
    if (!v) return YGAlignStretch;
    if (strcmp(v, "center") == 0)        return YGAlignCenter;
    if (strcmp(v, "flex-start") == 0)    return YGAlignFlexStart;
    if (strcmp(v, "flex-end") == 0)      return YGAlignFlexEnd;
    if (strcmp(v, "space-between") == 0) return YGAlignSpaceBetween;
    if (strcmp(v, "space-around") == 0)  return YGAlignSpaceAround;
    if (strcmp(v, "auto") == 0)          return YGAlignAuto;
    return YGAlignStretch;
}

/* Apply an inset (top/left/right/bottom) used with position: absolute. */
static void apply_inset(YGNodeRef y, YGEdge edge, const char *val)
{
    if (!val) return;
    float f;
    if (parse_percent(val, &f))    YGNodeStyleSetPositionPercent(y, edge, f);
    else if (parse_number(val, &f)) YGNodeStyleSetPosition(y, edge, f);
}

/* Apply a numeric edge value (padding/margin) for a named style property. */
static void apply_edge(YGNodeRef y, const PuStyle *s, const char *name, YGEdge edge,
                       void (*set)(YGNodeRef, YGEdge, float))
{
    const char *v = pu_style_get(s, name);
    float f;
    if (v && parse_number(v, &f)) set(y, edge, f);
}

static void apply_style(YGNodeRef y, const PuStyle *s)
{
    const char *v;
    float f;

    apply_dim(y, pu_style_get(s, "width"),
              YGNodeStyleSetWidth, YGNodeStyleSetWidthPercent, YGNodeStyleSetWidthAuto);
    apply_dim(y, pu_style_get(s, "height"),
              YGNodeStyleSetHeight, YGNodeStyleSetHeightPercent, YGNodeStyleSetHeightAuto);

    if ((v = pu_style_get(s, "flexDirection")))  YGNodeStyleSetFlexDirection(y, parse_flex_dir(v));
    if ((v = pu_style_get(s, "justifyContent"))) YGNodeStyleSetJustifyContent(y, parse_justify(v));
    if ((v = pu_style_get(s, "alignItems")))     YGNodeStyleSetAlignItems(y, parse_align(v));
    if ((v = pu_style_get(s, "flexWrap"))) {
        if (strcmp(v, "wrap") == 0)              YGNodeStyleSetFlexWrap(y, YGWrapWrap);
        else if (strcmp(v, "wrap-reverse") == 0) YGNodeStyleSetFlexWrap(y, YGWrapWrapReverse);
        else                                     YGNodeStyleSetFlexWrap(y, YGWrapNoWrap);
    }

    if ((v = pu_style_get(s, "padding")) && parse_number(v, &f)) YGNodeStyleSetPadding(y, YGEdgeAll, f);
    apply_edge(y, s, "paddingLeft",   YGEdgeLeft,   YGNodeStyleSetPadding);
    apply_edge(y, s, "paddingRight",  YGEdgeRight,  YGNodeStyleSetPadding);
    apply_edge(y, s, "paddingTop",    YGEdgeTop,    YGNodeStyleSetPadding);
    apply_edge(y, s, "paddingBottom", YGEdgeBottom, YGNodeStyleSetPadding);

    if ((v = pu_style_get(s, "margin")) && parse_number(v, &f)) YGNodeStyleSetMargin(y, YGEdgeAll, f);
    apply_edge(y, s, "marginLeft",   YGEdgeLeft,   YGNodeStyleSetMargin);
    apply_edge(y, s, "marginRight",  YGEdgeRight,  YGNodeStyleSetMargin);
    apply_edge(y, s, "marginTop",    YGEdgeTop,    YGNodeStyleSetMargin);
    apply_edge(y, s, "marginBottom", YGEdgeBottom, YGNodeStyleSetMargin);

    if ((v = pu_style_get(s, "flexGrow"))   && parse_number(v, &f)) YGNodeStyleSetFlexGrow(y, f);
    if ((v = pu_style_get(s, "flexShrink")) && parse_number(v, &f)) YGNodeStyleSetFlexShrink(y, f);
    if ((v = pu_style_get(s, "gap"))        && parse_number(v, &f)) YGNodeStyleSetGap(y, YGGutterAll, f);

    apply_dim(y, pu_style_get(s, "minWidth"),  YGNodeStyleSetMinWidth,  YGNodeStyleSetMinWidthPercent,  NULL);
    apply_dim(y, pu_style_get(s, "maxWidth"),  YGNodeStyleSetMaxWidth,  YGNodeStyleSetMaxWidthPercent,  NULL);
    apply_dim(y, pu_style_get(s, "minHeight"), YGNodeStyleSetMinHeight, YGNodeStyleSetMinHeightPercent, NULL);
    apply_dim(y, pu_style_get(s, "maxHeight"), YGNodeStyleSetMaxHeight, YGNodeStyleSetMaxHeightPercent, NULL);

    if ((v = pu_style_get(s, "flexBasis"))) {
        if (strcmp(v, "auto") == 0)      YGNodeStyleSetFlexBasisAuto(y);
        else if (parse_percent(v, &f))   YGNodeStyleSetFlexBasisPercent(y, f);
        else if (parse_number(v, &f))    YGNodeStyleSetFlexBasis(y, f);
    }
    if ((v = pu_style_get(s, "alignSelf")))    YGNodeStyleSetAlignSelf(y, parse_align(v));
    if ((v = pu_style_get(s, "alignContent"))) YGNodeStyleSetAlignContent(y, parse_align(v));
    if ((v = pu_style_get(s, "display")) && strcmp(v, "none") == 0)
        YGNodeStyleSetDisplay(y, YGDisplayNone);

    /* position: absolute lets elements overlap (placed by insets, out of flow). */
    if ((v = pu_style_get(s, "position"))) {
        if (strcmp(v, "absolute") == 0)      YGNodeStyleSetPositionType(y, YGPositionTypeAbsolute);
        else if (strcmp(v, "relative") == 0) YGNodeStyleSetPositionType(y, YGPositionTypeRelative);
    }
    apply_inset(y, YGEdgeTop,    pu_style_get(s, "top"));
    apply_inset(y, YGEdgeLeft,   pu_style_get(s, "left"));
    apply_inset(y, YGEdgeRight,  pu_style_get(s, "right"));
    apply_inset(y, YGEdgeBottom, pu_style_get(s, "bottom"));
}

/* ---- text measurement ------------------------------------------------------*/

/* Text inherits fontSize from its parent element (default 16px). */
static float text_font_size(const PuNode *n)
{
    const PuNode *p = n->parent;
    if (p) {
        const char *v = pu_style_get(&p->style, "fontSize");
        float f;
        if (v && parse_number(v, &f)) return f;
    }
    return 16.0f;
}

/* Text inherits fontWeight + fontStyle from its parent element. */
static int text_font_weight(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "fontWeight") : NULL;
    if (!v) return 400;
    if (strcmp(v, "bold") == 0) return 700;
    if (strcmp(v, "normal") == 0) return 400;
    int w = atoi(v);
    return w > 0 ? w : 400;
}

static int text_italic(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "fontStyle") : NULL;
    return v && strcmp(v, "italic") == 0;
}

static const char *text_font_family(const PuNode *n)
{
    const PuNode *p = n->parent;
    return p ? pu_style_get(&p->style, "fontFamily") : NULL;
}

/* 0 left, 1 center, 2 right — inherited from the parent's textAlign. */
static int text_align(const PuNode *n)
{
    const PuNode *p = n->parent;
    const char *v = p ? pu_style_get(&p->style, "textAlign") : NULL;
    if (!v) return 0;
    if (strcmp(v, "center") == 0) return 1;
    if (strcmp(v, "right") == 0)  return 2;
    return 0;
}

static YGSize measure_text(YGNodeConstRef node, float width, YGMeasureMode widthMode,
                           float height, YGMeasureMode heightMode)
{
    PuNode *n = (PuNode *)YGNodeGetContext(node);
    /* Wrap to the available width when bounded; remember it so paint reproduces
     * the exact same line breaks. */
    float maxw = (widthMode != YGMeasureModeUndefined) ? width : 0.0f;
    float tw = 0, th = 0;
    if (n) {
        pu_text_measure(n->text, text_font_size(n), text_font_weight(n), text_italic(n), text_font_family(n), maxw, &tw, &th);
        n->text_wrap_width = maxw;
    }

    YGSize size;
    size.width  = tw;
    size.height = th;
    if (widthMode == YGMeasureModeExactly) {
        size.width = width;
    } else if (widthMode == YGMeasureModeAtMost) {
        /* Fill the line box when aligned so center/right have room to work. */
        if (text_align(n) != 0) size.width = width;
        else if (tw > width)    size.width = width;
    }
    if (heightMode == YGMeasureModeExactly) size.height = height;
    return size;
}

/* ---- build / read back -----------------------------------------------------*/

static YGNodeRef build_tree(PuNode *n)
{
    YGNodeRef y = YGNodeNew();
    n->yoga = y;
    YGNodeSetContext(y, n);

    if (n->type == PU_NODE_TEXT) {
        YGNodeSetMeasureFunc(y, measure_text); /* text is a measured leaf */
        return y;
    }

    apply_style(y, &n->style);
    size_t i = 0;
    for (PuNode *c = n->first_child; c; c = c->next_sibling)
        YGNodeInsertChild(y, build_tree(c), i++);
    return y;
}

/* Convert Yoga's parent-relative results into absolute pixel coordinates. */
static void read_layout(PuNode *n, float ox, float oy)
{
    YGNodeRef y = (YGNodeRef)n->yoga;
    if (!y) { n->layout_x = ox; n->layout_y = oy; n->layout_w = n->layout_h = 0; return; }

    float x = ox + YGNodeLayoutGetLeft(y);
    float t = oy + YGNodeLayoutGetTop(y);
    n->layout_x = x;
    n->layout_y = t;
    n->layout_w = YGNodeLayoutGetWidth(y);
    n->layout_h = YGNodeLayoutGetHeight(y);

    for (PuNode *c = n->first_child; c; c = c->next_sibling)
        read_layout(c, x, t);
}

static void clear_yoga(PuNode *n)
{
    n->yoga = NULL;
    for (PuNode *c = n->first_child; c; c = c->next_sibling) clear_yoga(c);
}

/* ---- incremental: skip the layout pass when nothing layout-affecting changed -
 * The DOM mutators (bridge) call pu_layout_mark_dirty() on geometry/structure/
 * text changes; render-only changes (color, opacity, scroll, transform, hover/
 * focus state) leave the cached layout valid, so a hover/scroll/fade repaint
 * skips the whole Yoga rebuild (~4ms -> ~0). */
static int   g_layout_dirty = 1;
static float g_last_w = -1.0f, g_last_h = -1.0f;

void pu_layout_mark_dirty(void) { g_layout_dirty = 1; }

/* 1 if changing `prop` can change layout; 0 for known render-only properties.
 * Conservative: anything unrecognised returns 1 (force a relayout). */
int pu_layout_affects(const char *prop)
{
    if (!prop) return 1;
    if (strncmp(prop, "hover:", 6) == 0 || strncmp(prop, "focus:", 6) == 0) return 0;
    static const char *render_only[] = {
        "backgroundColor", "color", "borderColor", "borderWidth", "borderRadius",
        "borderTopWidth", "borderBottomWidth", "borderLeftWidth", "borderRightWidth",
        "opacity", "gradientFrom", "gradientTo", "gradientDir",
        "textGradientFrom", "textGradientTo", "shadowColor", "shadowBlur", "shadowX",
        "shadowY", "backgroundImage", "selectionColor", "rotate", "scale",
        "scrollTop", "scrollLeft", "cursor", "pointerEvents", "appRegion", NULL,
    };
    for (int i = 0; render_only[i]; i++)
        if (strcmp(prop, render_only[i]) == 0) return 0;
    return 1;
}

void pu_layout_calculate(PuNode *root, float width, float height)
{
    if (!root) return;
    /* Cached: no layout-affecting mutation and the viewport size is unchanged. */
    if (!g_layout_dirty && width == g_last_w && height == g_last_h) return;

    YGNodeRef y = build_tree(root);
    /* Root always fills the viewport. */
    YGNodeStyleSetWidth(y, width);
    YGNodeStyleSetHeight(y, height);

    YGNodeCalculateLayout(y, width, height, YGDirectionLTR);
    read_layout(root, 0.0f, 0.0f);

    YGNodeFreeRecursive(y);
    clear_yoga(root);

    g_layout_dirty = 0;
    g_last_w = width;
    g_last_h = height;
}
