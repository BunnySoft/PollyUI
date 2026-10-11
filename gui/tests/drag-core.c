#include "host/drag_internal.h"
#include <stdio.h>
#include <string.h>
#define CHECK(x)                                                                                                       \
    do                                                                                                                 \
    {                                                                                                                  \
        if (!(x))                                                                                                      \
        {                                                                                                              \
            fprintf(stderr, "FAIL drag core:%d %s\n", __LINE__, #x);                                                   \
            return 1;                                                                                                  \
        }                                                                                                              \
    } while (0)
int main(void)
{
    PuDragOwner *owner = pu_drag_owner_new(NULL);
    CHECK(owner);
    PuDragInput *input = pu_drag_input_new(owner, NULL, 1);
    CHECK(input);
    pu_drag_input_ref(input);
    unsigned char bytes[] = { 1, 0, 255, 42 };
    PuDragItem items[] = { { "application/x-polly-copy-test", bytes, sizeof(bytes) } };
    PuDragSession *session = pu_drag_copy(owner, input, items, 1, NULL, NULL);
    CHECK(session);
    memset(bytes, 0, sizeof(bytes));
    CHECK(!memcmp(session->items[0].data, (unsigned char[]) { 1, 0, 255, 42 }, 4));
    pu_drag_finish(session, PU_DRAG_COPIED, NULL);
    pu_drag_finish(session, PU_DRAG_CANCELLED, "late");
    CHECK(session->status == PU_DRAG_COPIED);
    pu_drag_deliver(session);
    pu_drag_release(session);
    PuDragItem invalid = { "text/plain", (unsigned char[]) { 0xc0, 0x80 }, 2 };
    CHECK(!pu_drag_copy(owner, input, &invalid, 1, NULL, NULL));
    invalid = (PuDragItem) { "text/plain", "nul\0text", 8 };
    CHECK(!pu_drag_copy(owner, input, &invalid, 1, NULL, NULL));
    pu_drag_owner_close(owner);
    CHECK(!pu_drag_copy(owner, input, items, 1, NULL, NULL));
    pu_drag_input_unref(input);
    pu_drag_owner_unref(owner);
    puts("PASS owned drag payload/UTF-8/late terminal/input lifetime");
    return 0;
}
