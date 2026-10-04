#include "engine.h"
#include <stdio.h>
#include <string.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "FAIL line %d: %s (%s)\n", __LINE__, #value, engine ? pu_ime_error(engine) : error); \
    pu_ime_close(engine); return 1; } } while (0)

int main(int argc, char **argv)
{
    if (argc != 3 && argc != 4) return 2;
    char error[256];
    if (argc == 4) {
        struct PuImeEngine *engine = pu_ime_open(argv[1], argv[2], argv[3], error, sizeof(error));
        CHECK(engine);
        struct PuImeSnapshot state;
        const char *keys = "nihao";
        for (size_t i = 0; keys[i]; i++) CHECK(pu_ime_key(engine, (unsigned char)keys[i], 0, false, &state) == 1);
        size_t index = 0;
        while (index < state.count && strcmp(state.candidates[index], "\xe4\xbd\xa0\xe5\xa5\xbd")) index++;
        CHECK(index < state.count && pu_ime_choose(engine, state.revision, index, &state));
        CHECK(!strcmp(state.commit, "\xe4\xbd\xa0\xe5\xa5\xbd"));
        pu_ime_close(engine);
        puts("PASS: installed Rime schema commits Chinese");
        return 0;
    }
    struct PuImeEngine *engine = pu_ime_open(argv[1], argv[1], "polly_test", error, sizeof(error));
    CHECK(!engine && strstr(error, "0700"));
    engine = pu_ime_open(argv[1], argv[2], "../invalid", error, sizeof(error));
    CHECK(!engine && strstr(error, "schema"));
    engine = pu_ime_open(argv[1], argv[2], "polly_test", error, sizeof(error));
    CHECK(engine);
    CHECK(!pu_ime_open(argv[1], argv[2], "polly_test", error, sizeof(error)) && strstr(error, "one IME"));
    struct PuImeSnapshot state;
    CHECK(pu_ime_reset(engine, &state) && !state.preedit[0] && !state.count);
    const char *keys = "nihao";
    for (size_t i = 0; keys[i]; i++) CHECK(pu_ime_key(engine, (unsigned char)keys[i], 0, false, &state) == 1);
    CHECK(state.count == 2 && !strcmp(state.candidates[0], "\xe4\xbd\xa0\xe5\xa5\xbd"));
    CHECK(state.preedit[0] && state.cursor <= strlen(state.preedit) && !state.commit[0]);
    CHECK(!pu_ime_choose(engine, state.revision - 1, 0, &state));
    CHECK(strstr(pu_ime_error(engine), "Stale"));
    CHECK(!pu_ime_choose(engine, state.revision, 20, &state));
    CHECK(pu_ime_choose(engine, state.revision, 0, &state));
    CHECK(!strcmp(state.commit, "\xe4\xbd\xa0\xe5\xa5\xbd") && !state.preedit[0] && !state.count);
    CHECK(pu_ime_key(engine, 'n', 0, false, &state) == 1);
    CHECK(pu_ime_reset(engine, &state) && !state.preedit[0] && !state.commit[0]);
    CHECK(pu_ime_set_ascii(engine, true, &state) && state.ascii);
    CHECK(pu_ime_key(engine, 'a', 0, false, &state) == 0 && !state.commit[0]);
    CHECK(pu_ime_key(engine, 'a', 0, true, &state) == 0);
    CHECK(pu_ime_key(engine, UINT32_MAX, 0, false, &state) == -1);
    CHECK(pu_ime_key(engine, 'a', 32, false, &state) == -1);
    CHECK(pu_ime_set_ascii(engine, false, &state) && !state.ascii);
    CHECK(pu_ime_key(engine, 'n', 0, false, &state) == 1);
    CHECK(pu_ime_key(engine, 'i', 0, false, &state) == 1 && state.count);
    CHECK(pu_ime_key(engine, 0xff1b, 0, false, &state) == 1 && !state.preedit[0]);
    pu_ime_close(engine);
    engine = pu_ime_open(argv[1], argv[2], "missing_schema", error, sizeof(error));
    CHECK(!engine && strstr(error, "schema"));
    engine = pu_ime_open(argv[1], argv[2], "polly_test", error, sizeof(error));
    CHECK(engine && pu_ime_reset(engine, &state) && !state.preedit[0]);
    pu_ime_close(engine);
    puts("PASS: independent Rime engine composition, candidates, stale selection, reset and ASCII passthrough");
    return 0;
}
