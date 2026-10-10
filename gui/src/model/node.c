#include "model/node.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Runtime for releasing listener callbacks at node-free time (JS_FreeValueRT
 * needs only the runtime, not a context). Set by the bridge. */
static JSRuntime *g_rt;
static PuNode *g_nodes;
void pu_node_set_runtime(JSRuntime *rt) { g_rt = rt; }

static char *pu_strdup(const char *s)
{
    if (!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

/* ---- style map -------------------------------------------------------------*/

void pu_style_set(PuStyle *s, const char *name, const char *value)
{
    if (!name) return;
    for (int i = 0; i < s->count; i++) {
        if (strcmp(s->props[i].name, name) == 0) {
            char *nv = pu_strdup(value ? value : "");
            if (!nv) return;
            free(s->props[i].value);
            s->props[i].value = nv;
            return;
        }
    }
    if (s->count == s->cap) {
        int ncap = s->cap ? s->cap * 2 : 4;
        PuStyleProp *np = (PuStyleProp *)realloc(s->props, (size_t)ncap * sizeof(PuStyleProp));
        if (!np) return;
        s->props = np;
        s->cap = ncap;
    }
    s->props[s->count].name  = pu_strdup(name);
    s->props[s->count].value = pu_strdup(value ? value : "");
    if (s->props[s->count].name && s->props[s->count].value) s->count++;
}

const char *pu_style_get(const PuStyle *s, const char *name)
{
    if (!name) return NULL;
    for (int i = 0; i < s->count; i++)
        if (strcmp(s->props[i].name, name) == 0)
            return s->props[i].value;
    return NULL;
}

void pu_style_remove(PuStyle *s, const char *name)
{
    if (!name) return;
    for (int i = 0; i < s->count; i++) {
        if (strcmp(s->props[i].name, name) == 0) {
            free(s->props[i].name);
            free(s->props[i].value);
            memmove(&s->props[i], &s->props[i + 1],
                    (size_t)(s->count - i - 1) * sizeof(PuStyleProp));
            s->count--;
            return;
        }
    }
}

static void pu_style_free(PuStyle *s)
{
    for (int i = 0; i < s->count; i++) {
        free(s->props[i].name);
        free(s->props[i].value);
    }
    free(s->props);
    s->props = NULL;
    s->count = s->cap = 0;
}

/* ---- node lifetime ---------------------------------------------------------*/

PuNode *pu_node_new(PuNodeType type)
{
    PuNode *n = (PuNode *)calloc(1, sizeof(PuNode));
    if (!n) return NULL;
    n->type = type;
    n->ref = 0;
    n->tab_index = -1; /* not focusable by default */
    n->js_wrapper = JS_UNDEFINED;
    n->js_style   = JS_UNDEFINED;
    n->runtime_next = g_nodes;
    if (g_nodes) g_nodes->runtime_prev = n;
    g_nodes = n;
    return n;
}

void pu_node_ref(PuNode *n)
{
    if (n) n->ref++;
}

static void clear_listeners(PuNode *n)
{
    PuListener *listeners = n->listeners;
    int count = n->listener_count;
    n->listeners = NULL;
    n->listener_count = n->listener_cap = 0;
    for (int i = 0; i < count; i++) {
        free(listeners[i].type);
        if (g_rt) JS_FreeValueRT(g_rt, listeners[i].func);
    }
    free(listeners);
}

void pu_node_clear_all_listeners(void)
{
    /* Freeing a callback can finalize wrappers anywhere in the native forest.
     * Hold every node until the sweep finishes so traversal cannot be invalidated. */
    for (PuNode *n = g_nodes; n; n = n->runtime_next) pu_node_ref(n);
    for (PuNode *n = g_nodes; n; n = n->runtime_next) clear_listeners(n);
    PuNode *n = g_nodes;
    while (n) {
        PuNode *next = n->runtime_next;
        pu_node_unref(n);
        n = next;
    }
}

void pu_node_clear_tree_listeners(PuNode *root)
{
    if (!root) return;
    pu_node_ref(root);
    clear_listeners(root);
    for (PuNode *child = root->first_child; child; child = child->next_sibling)
        pu_node_clear_tree_listeners(child);
    pu_node_unref(root);
}

static void pu_node_free(PuNode *n)
{
    if (n->runtime_prev) n->runtime_prev->runtime_next = n->runtime_next;
    else g_nodes = n->runtime_next;
    if (n->runtime_next) n->runtime_next->runtime_prev = n->runtime_prev;
    /* Detach children: each loses its parent (a tree ref). Children that still
     * have a wrapper survive as detached roots; the rest free recursively. */
    PuNode *c = n->first_child;
    while (c) {
        PuNode *next = c->next_sibling;
        c->parent = c->prev_sibling = c->next_sibling = NULL;
        pu_node_unref(c);
        c = next;
    }
    clear_listeners(n);
    free(n->tag);
    free(n->text);
    pu_style_free(&n->style);
    pu_style_free(&n->attrs);
    free(n);
}

void pu_node_unref(PuNode *n)
{
    if (!n) return;
    if (--n->ref <= 0)
        pu_node_free(n);
}

/* ---- tree mutation ---------------------------------------------------------*/

/* Unlink from current parent, adjusting sibling links and child_count.
 * Pointers only — does NOT change the refcount. */
static void pu_unlink(PuNode *child)
{
    PuNode *p = child->parent;
    if (!p) return;
    if (child->prev_sibling) child->prev_sibling->next_sibling = child->next_sibling;
    else                     p->first_child = child->next_sibling;
    if (child->next_sibling) child->next_sibling->prev_sibling = child->prev_sibling;
    else                     p->last_child = child->prev_sibling;
    p->child_count--;
    child->parent = child->prev_sibling = child->next_sibling = NULL;
}

void pu_node_insert_before(PuNode *parent, PuNode *child, PuNode *ref_node)
{
    if (!parent || !child || child == parent) return;
    if (ref_node && ref_node->parent != parent) return;

    bool was_rooted = (child->parent != NULL);
    pu_unlink(child);                 /* leave old position (no ref change yet) */
    if (!was_rooted) pu_node_ref(child); /* newly entering the tree gains a ref */

    child->parent = parent;
    if (ref_node) {
        child->next_sibling = ref_node;
        child->prev_sibling = ref_node->prev_sibling;
        if (ref_node->prev_sibling) ref_node->prev_sibling->next_sibling = child;
        else                        parent->first_child = child;
        ref_node->prev_sibling = child;
    } else {
        child->prev_sibling = parent->last_child;
        child->next_sibling = NULL;
        if (parent->last_child) parent->last_child->next_sibling = child;
        else                    parent->first_child = child;
        parent->last_child = child;
    }
    parent->child_count++;
}

void pu_node_append(PuNode *parent, PuNode *child)
{
    pu_node_insert_before(parent, child, NULL);
}

void pu_node_remove(PuNode *parent, PuNode *child)
{
    if (!parent || !child || child->parent != parent) return;
    pu_unlink(child);
    pu_node_unref(child);   /* lost the tree ref; frees if nothing else holds it */
}

/* ---- content ---------------------------------------------------------------*/

void pu_node_set_text(PuNode *n, const char *text)
{
    char *nt = pu_strdup(text ? text : "");
    if (!nt && text) return;
    free(n->text);
    n->text = nt;
}

/* ---- events ----------------------------------------------------------------*/

void pu_node_add_listener(PuNode *n, const char *type, JSValue func)
{
    if (n->listener_count == n->listener_cap) {
        int ncap = n->listener_cap ? n->listener_cap * 2 : 4;
        PuListener *l = (PuListener *)realloc(n->listeners, (size_t)ncap * sizeof(PuListener));
        if (!l) { if (g_rt) JS_FreeValueRT(g_rt, func); return; }
        n->listeners = l;
        n->listener_cap = ncap;
    }
    n->listeners[n->listener_count].type = pu_strdup(type);
    n->listeners[n->listener_count].func = func; /* takes ownership */
    n->listener_count++;
}

void pu_node_remove_listener(PuNode *n, const char *type, JSValueConst func)
{
    for (int i = 0; i < n->listener_count; i++) {
        if (strcmp(n->listeners[i].type, type) == 0 &&
            JS_VALUE_GET_PTR(n->listeners[i].func) == JS_VALUE_GET_PTR(func)) {
            free(n->listeners[i].type);
            if (g_rt) JS_FreeValueRT(g_rt, n->listeners[i].func);
            memmove(&n->listeners[i], &n->listeners[i + 1],
                    (size_t)(n->listener_count - i - 1) * sizeof(PuListener));
            n->listener_count--;
            return;
        }
    }
}

PuNode *pu_node_hit_test(PuNode *n, float x, float y)
{
    if (!n || n->type != PU_NODE_ELEMENT) return NULL;
    if (x < n->layout_x || y < n->layout_y ||
        x >= n->layout_x + n->layout_w || y >= n->layout_y + n->layout_h)
        return NULL;

    /* Scrolled containers paint children translated by -scroll, so a screen
     * point maps to child space by adding the scroll offset. */
    const char *sl = pu_style_get(&n->style, "scrollLeft");
    const char *st = pu_style_get(&n->style, "scrollTop");
    float cx = x + (sl ? (float)atof(sl) : 0.0f);
    float cy = y + (st ? (float)atof(st) : 0.0f);

    /* Children paint in order, so the last one is topmost — test it first. */
    for (PuNode *c = n->last_child; c; c = c->prev_sibling) {
        PuNode *hit = pu_node_hit_test(c, cx, cy);
        if (hit) return hit;
    }
    /* pointerEvents:none makes the node itself transparent to hit-testing (its
     * children stay hittable), so a point not over any child falls through to
     * whatever is painted beneath — e.g. a full-screen overlay host that hosts
     * only small toasts must not swallow clicks meant for the app below. */
    const char *pe = pu_style_get(&n->style, "pointerEvents");
    if (pe && strcmp(pe, "none") == 0) return NULL;
    return n;
}

/* ---- debug -----------------------------------------------------------------*/

void pu_node_dump(const PuNode *n, int depth)
{
    if (!n) return;
    for (int i = 0; i < depth; i++) fputs("  ", stdout);

    switch (n->type) {
    case PU_NODE_DOCUMENT:
        printf("#document\n");
        break;
    case PU_NODE_ELEMENT:
        printf("<%s>", n->tag ? n->tag : "?");
        if (n->style.count) {
            printf("  style{");
            for (int i = 0; i < n->style.count; i++)
                printf("%s%s:%s", i ? ", " : "", n->style.props[i].name, n->style.props[i].value);
            printf("}");
        }
        printf("  (ref=%d, children=%d)\n", n->ref, n->child_count);
        break;
    case PU_NODE_TEXT:
        printf("#text \"%s\"  (ref=%d)\n", n->text ? n->text : "", n->ref);
        break;
    }
    for (const PuNode *c = n->first_child; c; c = c->next_sibling)
        pu_node_dump(c, depth + 1);
}
