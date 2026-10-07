#include "../compositor/decoration-paint.h"
#include "../compositor/decoration-themes.h"
#include <assert.h>
#include <stdio.h>

int main(int argc, char **argv)
{
    const struct PuDecorationTheme *xp = &pu_decoration_themes[0];
    assert(pu_appearance_schema(true) == 2 && pu_appearance_schema(false) == 1);
    assert(pu_appearance_schema_rejected(2, true, false, "Unsupported or out-of-range appearance data"));
    assert(pu_appearance_schema_rejected(2, true, false, "Unsupported appearance schema"));
    assert(!pu_appearance_schema_rejected(2, false, false, "Unsupported appearance schema"));
    assert(!pu_appearance_schema_rejected(2, true, true, "Unsupported appearance schema"));
    assert(!pu_appearance_schema_rejected(1, true, false, "Unsupported appearance schema"));
    assert(!pu_appearance_schema_rejected(2, true, false, "Appearance descriptor is not sealed"));
    assert(!pu_appearance_schema_rejected(2, true, false, NULL));
    uint32_t words[PU_APPEARANCE_WORDS] = {1};
    unsigned index = 2;
#define ENCODE_METRIC(type, field, token, minimum, maximum, scale) words[index++] = (uint32_t)round(xp->field * scale);
    PU_APPEARANCE_METRICS(ENCODE_METRIC)
#undef ENCODE_METRIC
#define ENCODE_COLOR(name) words[index++] = xp->name;
    PU_APPEARANCE_COLORS(ENCODE_COLOR)
#undef ENCODE_COLOR
    struct PuDecorationTheme decoded;
    assert(pu_appearance_decode(&decoded, words) && !decoded.luna);
    words[1] = 512;
    assert(!pu_appearance_decode(&decoded, words));
    words[0] = 2;
    assert(pu_appearance_decode(&decoded, words) && decoded.luna);
    words[1] = 1024;
    assert(!pu_appearance_decode(&decoded, words));
    words[1] = 512;
    words[0] = 3;
    assert(!pu_appearance_decode(&decoded, words));
    assert(xp->control_size == 21 && xp->title_height == 30);
    uint32_t normal = pu_chrome_control(xp, xp->closeFrom, xp->closeTo, 8.5, 6.5, true, false, false);
    assert(normal != pu_chrome_control(xp, xp->closeFrom, xp->closeTo, 8.5, 6.5, true, true, false));
    assert(normal != pu_chrome_control(xp, xp->closeFrom, xp->closeTo, 8.5, 6.5, true, true, true));
    assert(normal != pu_chrome_control(xp, xp->closeFrom, xp->closeTo, 8.5, 6.5, false, false, false));
    assert(pu_chrome_glyph(xp, 2, 10.5, 12.5, false, false));
    for (unsigned i = 1; i < PU_DECORATION_THEME_COUNT; i++) {
        const struct PuDecorationTheme *theme = &pu_decoration_themes[i];
        assert(!theme->luna);
        assert(pu_chrome_title(theme, 8.5, true) ==
            pu_chrome_mix(theme->titleFrom, theme->titleTo, 8.5 / theme->title_height));
    }
    if (argc == 1) {
        puts("PASS: native numeric schema 1/2, bounded Luna flags, caption states and unchanged generic gradients");
        return 0;
    }
    (void)argv;
    /* A paint-only strip, not a captured desktop or compositor acceptance. */
    puts("P3\n2 30\n255");
    for (int y = 0; y < 30; y++) {
        uint32_t before = y < 3 ? 0xff1649ad : pu_chrome_mix(0xff4396ff, 0xff1252c9, (y + 0.5) / 32);
        uint32_t after = pu_chrome_title(xp, y + 0.5, true);
        printf("%u %u %u %u %u %u\n", (before >> 16) & 255, (before >> 8) & 255, before & 255,
            (after >> 16) & 255, (after >> 8) & 255, after & 255);
    }
    return 0;
}
