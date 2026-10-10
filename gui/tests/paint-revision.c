#include "model/node.h"
#include <stdio.h>

static int failed;
static void check(int value, const char *message)
{
    if (!value) { fprintf(stderr, "FAIL: %s\n", message); failed = 1; }
}

int main(void)
{
    PuNode *first = pu_node_new(PU_NODE_ELEMENT), *second = pu_node_new(PU_NODE_ELEMENT);
    PuNode *child = pu_node_new(PU_NODE_TEXT);
    if (!first || !second || !child) return 1;
    pu_node_ref(first); pu_node_ref(second); pu_node_ref(child);
    pu_node_append(first, child);
    uint64_t a = pu_node_paint_version(first), b = pu_node_paint_version(second);
    pu_node_set_text(child, "updated");
    check(pu_node_paint_version(first) != a && pu_node_paint_version(second) == b,
        "text mutation invalidates only its document");
    a = pu_node_paint_version(first);
    pu_style_set(&second->style, "backgroundColor", "#123456");
    check(pu_node_paint_version(first) == a && pu_node_paint_version(second) != b,
        "style mutation invalidates only its document");
    b = pu_node_paint_version(second);
    pu_style_set(&second->style, "backgroundColor", "#123456");
    check(pu_node_paint_version(second) == b, "identical style writes do not invalidate");
    pu_node_append(second, child);
    check(pu_node_paint_version(first) != a && pu_node_paint_version(second) != b,
        "reparenting invalidates both old and new documents");
    a = pu_node_paint_version(first); b = pu_node_paint_version(second);
    pu_node_mark_paint_dirty(NULL);
    check(pu_node_paint_version(first) != a && pu_node_paint_version(second) != b,
        "shared bitmap resource invalidation reaches all documents");
    pu_node_unref(child); pu_node_unref(first); pu_node_unref(second);
    if (!failed) puts("PASS: independent document revisions preserve tree/style/text and shared resource invalidation");
    return failed;
}
