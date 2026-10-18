#ifndef POLLYUI_NATIVE_WINDOW_H
#define POLLYUI_NATIVE_WINDOW_H
#include "quickjs.h"
#include "pollyui/window.h"

/* Native service adapters only; validates current realm and live ownership. */
PuWindow *pu_gui_window_from_value(JSContext *ctx, JSValueConst value);
#endif
