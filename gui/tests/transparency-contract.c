#include "host/window_contract.h"
#include <stdio.h>

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL transparency contract line %d\n", __LINE__); return 1; } } while (0)
int main(void)
{
    PuWindowConfig c = { .width = 240, .height = 160 };
    CHECK(pu_window_config_valid(&c) && !pu_window_required_capabilities(&c));
    c.transparent = 1;
    CHECK(pu_window_config_valid(&c) && pu_window_required_capabilities(&c) == PU_WINDOW_TRANSPARENT);
    c.parent = (PuWindow *)&c; c.modal = 1;
    CHECK(pu_window_config_valid(&c) && pu_window_required_capabilities(&c) ==
        (PU_WINDOW_TRANSPARENT | PU_WINDOW_OWNED | PU_WINDOW_MODAL));
    c.modal = 0; c.popup = PU_POPUP_MENU;
    CHECK(!pu_window_config_valid(&c));
    c.popup = PU_POPUP_NONE; c.parent = NULL; c.input_popup = 1;
    CHECK(!pu_window_config_valid(&c));
    c.input_popup = 0; c.lock_output = 1;
    CHECK(!pu_window_config_valid(&c));
    c.lock_output = 0;
    PuLayerConfig layer = { .transparent = 1 };
    c.layer = &layer;
    CHECK(!pu_window_config_valid(&c));
    c.transparent = 0;
    CHECK(pu_window_config_valid(&c) && !pu_window_required_capabilities(&c));
    c.layer = NULL; c.transparent = 2;
    CHECK(!pu_window_config_valid(&c));
    c.transparent = -1;
    CHECK(!pu_window_config_valid(&c));
    puts("PASS: strict ordinary alpha contract and separate service/layer roles");
    return 0;
}
