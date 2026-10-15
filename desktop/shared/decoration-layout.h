#ifndef POLLY_DECORATION_LAYOUT_H
#define POLLY_DECORATION_LAYOUT_H
#include "appearance-config.h"
struct PuChromeBox { int x, y, width, height; };

static inline bool pu_decoration_layout_button(const struct PuDecorationLayout *layout,
    int width, int command, struct PuChromeBox *box)
{
    if (command < 0 || command > 2) return false;
    int index = !command ? 0 : layout->left_controls ? (command == 2 ? 1 : 2) : command;
    int gap = index ? layout->close_gap + (index - 1) * layout->control_gap : 0;
    int size = layout->control_width;
    if (width < (index + 1) * size + gap + 2 * layout->control_inset) return false;
    *box = (struct PuChromeBox) {
        layout->left_controls ? layout->control_inset + index * size + gap :
            width - layout->control_inset - size - index * size - gap,
        layout->control_top, size, layout->control_height,
    };
    return true;
}

static inline void pu_decoration_layout_text(const struct PuDecorationLayout *layout,
    int width, struct PuChromeBox *box)
{
    int left = layout->text_inset, right = width - layout->text_inset;
    for (int command = 0; command < 3; command++) {
        struct PuChromeBox button;
        if (!pu_decoration_layout_button(layout, width, command, &button)) continue;
        if (layout->left_controls && left < button.x + button.width + layout->text_gap)
            left = button.x + button.width + layout->text_gap;
        if (!layout->left_controls && right > button.x - layout->text_gap)
            right = button.x - layout->text_gap;
    }
    if (left > width) left = width;
    *box = (struct PuChromeBox) {left, layout->border_width, right > left ? right - left : 0,
        layout->title_height - layout->border_width};
}
#endif
