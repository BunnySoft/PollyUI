#include "../compositor/cursor.h"
#include <assert.h>
#include <stdio.h>

int main(void)
{
    assert(pu_cursor_classic_theme(NULL));
    assert(pu_cursor_classic_theme(""));
    assert(pu_cursor_classic_theme("classic"));
    assert(!pu_cursor_classic_theme("PollyRabbit"));
    assert(!pu_cursor_classic_theme("/opt/custom-cursor"));
    puts("PASS: unset/empty default to Classic; Rabbit and absolute directory remain explicit choices");
    return 0;
}
