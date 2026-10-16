#include "../shared/decoration-layout.h"
#include "../shared/decoration-frame.h"
#include "decoration-layout-fixtures.h"
#include <assert.h>
#include <stdio.h>

int main(void)
{
    assert(PU_DECORATION_LAYOUT_COUNT == 6);
    assert(!strcmp(pu_decoration_layouts[PU_DECORATION_DEFAULT_LAYOUT].id, "modern"));
    for (unsigned i = 0; i < PU_DECORATION_LAYOUT_COUNT; i++) {
        const struct PuDecorationLayout *layout = &pu_decoration_layouts[i].layout;
        uint32_t words[PU_APPEARANCE_WORDS] = {PU_APPEARANCE_SCHEMA, layout->left_controls};
        unsigned index = 2;
#define ENCODE(type, field, token, minimum, maximum, scale) words[index++] = layout->field;
        PU_APPEARANCE_METRICS(ENCODE)
#undef ENCODE
        struct PuDecorationLayout decoded;
        assert(pu_appearance_decode(&decoded, words));
        assert(!memcmp(layout, &decoded, sizeof(decoded)));
        for (int width = 1; width <= 480; width++) {
            struct PuChromeBox text;
            pu_decoration_layout_text(layout, width, &text);
            assert(text.x >= 0 && text.x <= width && text.width >= 0 && text.x + text.width <= width);
            for (int command = 0; command < 3; command++) {
                struct PuChromeBox box;
                if (!pu_decoration_layout_button(layout, width, command, &box)) continue;
                assert(box.x >= 0 && box.x + box.width <= width);
                assert(box.y >= layout->border_width && box.y + box.height <= layout->title_height);
                assert(!text.width || (layout->left_controls ? text.x >= box.x + box.width :
                    text.x + text.width <= box.x));
            }
        }
        words[0] = 5; assert(!pu_appearance_decode(&decoded, words)); words[0] = PU_APPEARANCE_SCHEMA;
        words[1] = 2; assert(!pu_appearance_decode(&decoded, words)); words[1] = layout->left_controls;
        words[2] = 9; assert(!pu_appearance_decode(&decoded, words));
    }
    uint32_t meta[PU_FRAME_META_WORDS] = {1, 1, 2, 0, 460, 300, 0, 1, 4, 23};
    meta[PU_FRAME_SCALE] = pu_frame_scale_word(1);
    struct PuFrameStrip strips[PU_FRAME_STRIPS]; uint32_t length;
    assert(pu_frame_strips(meta, strips, &length));
    assert(strips[0].width == 468 && strips[0].height == 23);
    assert(strips[1].width == 4 && strips[1].height == 300);
    assert(strips[3].width == 468 && strips[3].height == 4);
    uint32_t words[PU_FRAME_HEADER_WORDS] = {PU_FRAME_MAGIC, PU_FRAME_VERSION, length};
    memcpy(words + 3, meta, sizeof(meta));
    for (unsigned i = 0; i < PU_FRAME_STRIPS; i++)
        memcpy(words + 3 + PU_FRAME_META_WORDS + i * 4, &strips[i], sizeof(strips[i]));
    assert(pu_frame_validate(words, length, meta, strips));
    words[3 + PU_FRAME_REVISION]++; assert(!pu_frame_validate(words, length, meta, strips));
    words[3 + PU_FRAME_REVISION]--;
    words[PU_FRAME_HEADER_WORDS - 1]++; assert(!pu_frame_validate(words, length, meta, strips));
    meta[PU_FRAME_SCALE] = pu_frame_scale_word(NAN); assert(!pu_frame_strips(meta, strips, &length));
    meta[PU_FRAME_SCALE] = pu_frame_scale_word(8); meta[PU_FRAME_CLIENT_WIDTH] = 32700;
    assert(!pu_frame_strips(meta, strips, &length));
    meta[PU_FRAME_SCALE] = pu_frame_scale_word(1.25f); meta[PU_FRAME_CLIENT_WIDTH] = 460;
    assert(pu_frame_strips(meta, strips, &length) && strips[0].width == 585 && strips[0].height == 29);
    meta[PU_FRAME_BORDER] = 0;
    assert(pu_frame_strips(meta, strips, &length) && strips[1].width == 0 && strips[3].height == 0);
    puts("PASS: geometry-only layout, narrow text/button bounds, exact strip codec and stale/budget/scale rejection");
    return 0;
}
