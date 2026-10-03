#ifndef POLLYWM_TEST_WIRE_H
#define POLLYWM_TEST_WIRE_H

#include <stdint.h>

/* Test-only control channel inherited by an independently running Wayland client.
 * This is not a protocol exposed by pollywm. */
enum TestCommand {
    TEST_QUERY, TEST_MAP, TEST_UNMAP, TEST_REMAP, TEST_DESTROY,
    TEST_MOVE, TEST_RESIZE, TEST_MAXIMIZE, TEST_FULLSCREEN,
    TEST_POPUP, TEST_DESTROY_POPUP, TEST_DESTROY_ROLE, TEST_QUIT,
    TEST_UNMAXIMIZE, TEST_UNFULLSCREEN, TEST_HOLD, TEST_APPLY_FIRST, TEST_RELEASE,
    TEST_SMALL_FULLSCREEN, TEST_CHILD_POPUP, TEST_REPOSITION_POPUP
};

struct TestRequest {
    enum TestCommand command;
    int id;
    uint32_t serial;
    uint32_t edges;
};

struct TestReply {
    int id, focused, width, height;
    int configured, frames, closed, keys, buttons, popups;
    int maximized, fullscreen, max_capability, full_capability;
    int pending, output_count, popup_x, popup_y, popup_w, popup_h, repositioned;
    uint32_t serial;
};

#endif
