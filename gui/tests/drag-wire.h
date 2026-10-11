#ifndef PU_TEST_DRAG_WIRE_H
#define PU_TEST_DRAG_WIRE_H
#include <stdint.h>
enum DragCommand {
    DRAG_QUERY, DRAG_START, DRAG_CANCEL, DRAG_CLOSE, DRAG_QUIT,
    DRAG_WRITE_CLIP, DRAG_READ_CLIP, DRAG_HOLD_READ, DRAG_HOLD_FINISH,
    DRAG_FINISH, DRAG_REFUSE, DRAG_GC, DRAG_DETACH, DRAG_EXPECT_SIZE, DRAG_ABORT_READ
};
struct DragRequest { int command, mode; };
struct DragReceipt {
    int down, up, copied, cancelled, error, received, clipboard, heartbeat;
    int invalid, held, pending, bytes, closed;
};
int pu_test_drag_receiver(int fd);
#endif
