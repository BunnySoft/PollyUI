#ifndef POLLYUI_MODEL_NODE_H
#define POLLYUI_MODEL_NODE_H

/* Model — the retained DOM-like node tree (DESIGN.md §4).
 *
 * A single `PuNode` tagged by `PuNodeType` (document / element / text), with
 * intrusive parent/child/sibling links. Lifetime is reference-counted (§6):
 * a node is kept alive while it is attached to a parent OR a bridge wrapper
 * (JS object / style object) references it. The tree owns its children.
 *
 * Style is stored as a simple string property map for now; M3 parses typed
 * values out of it for Yoga + paint. */

#include "quickjs.h"   /* JSValue: nodes cache their bridge wrappers (weak) */

#include <stdbool.h>

typedef enum PuNodeType {
    PU_NODE_DOCUMENT,
    PU_NODE_ELEMENT,
    PU_NODE_TEXT
} PuNodeType;

typedef struct PuStyleProp {
    char *name;
    char *value;
} PuStyleProp;

typedef struct PuStyle {
    PuStyleProp *props;
    int          count;
    int          cap;
} PuStyle;

/* An event listener: an event type + a JS callback (strong ref, owned). */
typedef struct PuListener {
    char   *type;
    JSValue func;
} PuListener;

typedef struct PuNode PuNode;
struct PuNode {
    PuNodeType type;
    int        ref;          /* lifetime refcount (§6) */

    PuNode *parent;
    PuNode *first_child;
    PuNode *last_child;
    PuNode *prev_sibling;
    PuNode *next_sibling;
    int     child_count;

    char   *tag;             /* element tag name (owned); NULL otherwise */
    char   *text;            /* text content (owned) for text nodes */
    PuStyle style;           /* element style */

    /* Computed layout (absolute, in pixels) — written by the LayoutEngine,
     * read by the RenderEngine. */
    float layout_x, layout_y, layout_w, layout_h;
    void *yoga;              /* transient YGNodeRef during a layout pass */

    /* Event listeners (DESIGN.md §6). */
    PuListener *listeners;
    int         listener_count;
    int         listener_cap;

    /* Bridge wrappers — weak handles managed by bridge.c. */
    JSValue js_wrapper;  bool has_wrapper;
    JSValue js_style;    bool has_style;
};

/* The runtime used to release listener callbacks when a node is freed.
 * Set once by the bridge at install time. */
void pu_node_set_runtime(JSRuntime *rt);

/* --- lifetime --- */
PuNode *pu_node_new(PuNodeType type);
void    pu_node_ref(PuNode *n);
void    pu_node_unref(PuNode *n);          /* frees the node (and its tree) at 0 */

/* --- tree mutation (parent must be non-NULL) --- */
void    pu_node_append(PuNode *parent, PuNode *child);
void    pu_node_remove(PuNode *parent, PuNode *child);
/* Insert child before `ref_node` (a child of parent); if ref_node is NULL, append. */
void    pu_node_insert_before(PuNode *parent, PuNode *child, PuNode *ref_node);

/* --- content --- */
void        pu_node_set_text(PuNode *n, const char *text);
void        pu_style_set(PuStyle *s, const char *name, const char *value);
const char *pu_style_get(const PuStyle *s, const char *name);

/* --- events --- */
/* Add a listener; takes ownership of `func` (caller must have duped it). */
void    pu_node_add_listener(PuNode *n, const char *type, JSValue func);
/* Remove the first listener matching (type, func). */
void    pu_node_remove_listener(PuNode *n, const char *type, JSValueConst func);
/* Topmost element whose computed box contains (x, y), or NULL. */
PuNode *pu_node_hit_test(PuNode *root, float x, float y);

/* --- debug --- */
void    pu_node_dump(const PuNode *n, int depth);

#endif /* POLLYUI_MODEL_NODE_H */
