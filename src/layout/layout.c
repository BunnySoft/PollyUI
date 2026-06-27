#include "layout/layout.h"

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
    if (strcmp(v, "center") == 0)     return YGAlignCenter;
    if (strcmp(v, "flex-start") == 0) return YGAlignFlexStart;
    if (strcmp(v, "flex-end") == 0)   return YGAlignFlexEnd;
    return YGAlignStretch;
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

    if ((v = pu_style_get(s, "padding"))  && parse_number(v, &f)) YGNodeStyleSetPadding(y, YGEdgeAll, f);
    if ((v = pu_style_get(s, "margin"))   && parse_number(v, &f)) YGNodeStyleSetMargin(y, YGEdgeAll, f);
    if ((v = pu_style_get(s, "flexGrow")) && parse_number(v, &f)) YGNodeStyleSetFlexGrow(y, f);
}

/* ---- build / read back -----------------------------------------------------*/

static YGNodeRef build_tree(PuNode *n)
{
    YGNodeRef y = YGNodeNew();
    n->yoga = y;
    if (n->type == PU_NODE_ELEMENT) apply_style(y, &n->style);

    size_t i = 0;
    for (PuNode *c = n->first_child; c; c = c->next_sibling) {
        if (c->type == PU_NODE_TEXT) continue; /* text laid out in M4 */
        YGNodeInsertChild(y, build_tree(c), i++);
    }
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

    for (PuNode *c = n->first_child; c; c = c->next_sibling) {
        if (c->type == PU_NODE_TEXT) continue;
        read_layout(c, x, t);
    }
}

static void clear_yoga(PuNode *n)
{
    n->yoga = NULL;
    for (PuNode *c = n->first_child; c; c = c->next_sibling) clear_yoga(c);
}

void pu_layout_calculate(PuNode *root, float width, float height)
{
    if (!root) return;

    YGNodeRef y = build_tree(root);
    /* Root always fills the viewport. */
    YGNodeStyleSetWidth(y, width);
    YGNodeStyleSetHeight(y, height);

    YGNodeCalculateLayout(y, width, height, YGDirectionLTR);
    read_layout(root, 0.0f, 0.0f);

    YGNodeFreeRecursive(y);
    clear_yoga(root);
}
