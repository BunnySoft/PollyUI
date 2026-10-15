#include "../compositor/decoration-paint.h"
#include "../compositor/decoration-themes.h"
#include <assert.h>
#include <stdio.h>

static void encode(const struct PuDecorationTheme *theme, uint32_t *words)
{
    words[0] = pu_appearance_theme_schema(theme);
    words[1] = pu_appearance_flags(theme);
    unsigned index = 2;
#define METRIC(type, field, token, minimum, maximum, scale) words[index++] = (uint32_t)round(theme->field * scale);
    PU_APPEARANCE_METRICS(METRIC)
#undef METRIC
#define COLOR(field) words[index++] = theme->field;
    PU_APPEARANCE_COLORS(COLOR)
#undef COLOR
    words[index++] = theme->control_width;
    words[index] = theme->control_top;
}

int main(int argc, char **argv)
{
    assert(PU_DECORATION_THEME_COUNT == 6);
    assert(!strcmp(pu_decoration_themes[PU_DECORATION_DEFAULT_THEME].id, "modern"));
    for (unsigned i = 0; i < PU_DECORATION_THEME_COUNT; i++) {
        const struct PuDecorationTheme *theme = &pu_decoration_themes[i];
        uint32_t words[PU_APPEARANCE_V3_WORDS] = {0};
        encode(theme, words);
        struct PuDecorationTheme decoded;
        assert(pu_appearance_decode(&decoded, words));
        assert(decoded.control_width == theme->control_width);
        assert(decoded.control_top == theme->control_top);
        assert(decoded.caption_style == theme->caption_style);
        for (int command = 0; command < 3; command++) {
            struct PuChromeBox box;
            assert(pu_chrome_button_box(theme, 480, command, &box));
            assert(box.x >= 0 && box.y >= theme->border_width);
            assert(box.y + box.height <= theme->title_height);
            assert(box.x + box.width <= 480);
            assert(box.width == theme->control_width && box.height == theme->control_size);
        }
        assert(!pu_chrome_button_box(theme, 1, 0, &(struct PuChromeBox){0}));
        if (words[0] == 3) {
            words[PU_APPEARANCE_WORDS] = 97;
            assert(!pu_appearance_decode(&decoded, words));
            encode(theme, words);
            words[PU_APPEARANCE_WORDS + 1] = theme->title_height;
            assert(!pu_appearance_decode(&decoded, words));
        }
    }
    const struct PuDecorationTheme *classic = &pu_decoration_themes[1], *fluent = &pu_decoration_themes[5];
    assert(classic->title_height == 22 && classic->control_width == 16 && classic->control_size == 14);
    struct PuChromeBox close, maximize, minimize;
    assert(pu_chrome_button_box(classic, 480, 0, &close));
    assert(pu_chrome_button_box(classic, 480, 1, &maximize));
    assert(pu_chrome_button_box(classic, 480, 2, &minimize));
    assert(close.x - maximize.x == 18 && maximize.x - minimize.x == 16);
    assert(pu_chrome_pixel(classic, 1.5, 1.5, 480, true) == 0xffffffff);
    assert(pu_chrome_pixel(classic, 478.5, 10.5, 480, true) == 0xff808080);
    assert(pu_chrome_pixel(classic, 20.5, 10.5, 480, true) !=
        pu_chrome_pixel(classic, 400.5, 10.5, 480, true));
    assert(pu_chrome_control(classic, classic->controlFrom, classic->controlTo,
        0.5, 0.5, true, true, false) == 0xffffffff);
    assert(pu_chrome_control(classic, classic->controlFrom, classic->controlTo,
        0.5, 0.5, true, true, true) == 0xff808080);
    assert(fluent->control_width == 46 && fluent->control_size == 32 && fluent->control_top == 1);
    assert(pu_chrome_button(fluent, 0, 0, 0, 10, 10, true, false, false) == fluent->titleFrom);
    assert(pu_chrome_button(fluent, 0, 0, 0, 10, 10, true, true, false) == fluent->closeFrom);
    assert(pu_chrome_button(fluent, 0, 0, 0, 10, 10, true, true, true) == fluent->closeTo);
    if (argc == 2) {
        FILE *output = fopen(argv[1], "wb");
        assert(output);
        /* Actual shared C painter bytes, not a window capture; text is not painted here. */
        fprintf(output, "P6\n480 %u\n255\n", (unsigned)PU_DECORATION_THEME_COUNT * 4 * 48);
        for (unsigned i = 0; i < PU_DECORATION_THEME_COUNT; i++)
            for (int state = 0; state < 4; state++)
                for (int y = 0; y < 48; y++)
                    for (int x = 0; x < 480; x++) {
                        const struct PuDecorationTheme *theme = &pu_decoration_themes[i];
                        uint32_t color = y < theme->title_height ?
                            pu_chrome_pixel(theme, x + 0.5, y + 0.5, 480, state != 1) : 0xffececec;
                        for (int command = 0; command < 3 && y < theme->title_height; command++) {
                            struct PuChromeBox box;
                            if (!pu_chrome_button_box(theme, 480, command, &box) ||
                                x < box.x || x >= box.x + box.width ||
                                y < box.y || y >= box.y + box.height) continue;
                            double rx = x - box.x + 0.5, ry = y - box.y + 0.5;
                            uint32_t from = !command ? theme->closeFrom : command == 1 ?
                                theme->maximizeFrom : theme->minimizeFrom;
                            uint32_t to = !command ? theme->closeTo : command == 1 ?
                                theme->maximizeTo : theme->minimizeTo;
                            color = pu_chrome_button(theme, command, from, to, rx, ry,
                                state != 1, state >= 2, state == 3);
                            if (pu_chrome_glyph(theme, command, rx, ry, state == 2,
                                    state == 3 && theme->caption_style != PU_CAPTION_FLUENT) &&
                                (!theme->glyphs_hover || state >= 2))
                                color = !command && state >= 2 && theme->caption_style == PU_CAPTION_FLUENT ?
                                    0xffffffff : theme->controlText;
                        }
                        unsigned char rgb[] = {(unsigned char)(color >> 16), (unsigned char)(color >> 8), (unsigned char)color};
                        assert(fwrite(rgb, 1, 3, output) == 3);
                    }
        assert(!fclose(output));
    }
    puts("PASS: six captions, native schema 1/2/3, bounds, actual shared hitboxes, Classic bevel and Fluent state pixels");
    return 0;
}
