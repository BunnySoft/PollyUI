#ifndef POLLY_IME_ENGINE_H
#define POLLY_IME_ENGINE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PU_IME_TEXT_BYTES 4096
#define PU_IME_CANDIDATES 16
#define PU_IME_CANDIDATE_BYTES 1024
struct PuImeEngine;
struct PuImeSnapshot {
    uint64_t revision;
    char preedit[PU_IME_TEXT_BYTES], commit[PU_IME_TEXT_BYTES];
    size_t cursor, selection_start, selection_end;
    size_t count, selected;
    bool ascii, last_page;
    char candidates[PU_IME_CANDIDATES][PU_IME_CANDIDATE_BYTES];
    char comments[PU_IME_CANDIDATES][PU_IME_CANDIDATE_BYTES];
};
enum PuImeModifiers {
    PU_IME_SHIFT = 1, PU_IME_CTRL = 2, PU_IME_ALT = 4, PU_IME_SUPER = 8, PU_IME_CAPS = 16,
};

/* One engine per process, called on its owning thread. User data must be a
 * private owned directory. Snapshot offsets are UTF-8 byte offsets. */
struct PuImeEngine *pu_ime_open(const char *shared, const char *user, const char *schema,
    char *error, size_t error_size);
void pu_ime_close(struct PuImeEngine *engine);
const char *pu_ime_error(const struct PuImeEngine *engine);
/* -1: explicit error; 0: forward key; 1: consumed by the engine. */
int pu_ime_key(struct PuImeEngine *engine, uint32_t keysym, unsigned modifiers,
    bool release, struct PuImeSnapshot *out);
bool pu_ime_choose(struct PuImeEngine *engine, uint64_t revision, size_t index, struct PuImeSnapshot *out);
bool pu_ime_reset(struct PuImeEngine *engine, struct PuImeSnapshot *out);
bool pu_ime_set_ascii(struct PuImeEngine *engine, bool ascii, struct PuImeSnapshot *out);
#endif
