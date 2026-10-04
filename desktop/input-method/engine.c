#include "engine.h"
#include <rime_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct PuImeEngine {
    RimeApi *api;
    RimeSessionId session;
    uint64_t revision;
    size_t candidates;
    bool deployment_failed;
    char *shared, *user;
    char error[256];
};
static bool live;

static bool fail(struct PuImeEngine *engine, const char *message)
{
    snprintf(engine->error, sizeof(engine->error), "%s", message);
    return false;
}
const char *pu_ime_error(const struct PuImeEngine *engine) { return engine->error; }

static void notification(void *data, RimeSessionId session, const char *type, const char *value)
{
    (void)session;
    struct PuImeEngine *engine = data;
    if (!strcmp(type, "deploy") && !strcmp(value, "failure")) engine->deployment_failed = true;
}

void pu_ime_close(struct PuImeEngine *engine)
{
    if (!engine) return;
    engine->api->join_maintenance_thread();
    if (engine->session) engine->api->destroy_session(engine->session);
    engine->api->set_notification_handler(NULL, NULL);
    engine->api->finalize();
    free(engine->shared); free(engine->user); free(engine);
    live = false;
}

struct PuImeEngine *pu_ime_open(const char *shared, const char *user, const char *schema,
    char *error, size_t error_size)
{
    struct stat info;
    const char *problem = NULL;
    if (live) problem = "Only one IME engine may run in a process";
    else if (!shared || shared[0] != '/' || stat(shared, &info) || !S_ISDIR(info.st_mode))
        problem = "IME shared data must be an absolute directory";
    else if (!user || user[0] != '/' || lstat(user, &info) || !S_ISDIR(info.st_mode) ||
        info.st_uid != getuid() || (info.st_mode & 0777) != 0700)
        problem = "IME user data must be an owned directory with mode 0700";
    else if (!schema || !*schema || strlen(schema) > 127 ||
        strspn(schema, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != strlen(schema))
        problem = "Invalid IME schema identifier";
    if (problem) { snprintf(error, error_size, "%s", problem); return NULL; }
    struct PuImeEngine *engine = calloc(1, sizeof(*engine));
    if (!engine) { snprintf(error, error_size, "Cannot allocate IME engine"); return NULL; }
    engine->shared = strdup(shared); engine->user = strdup(user);
    if (!engine->shared || !engine->user) {
        free(engine->shared); free(engine->user); free(engine);
        snprintf(error, error_size, "Cannot copy IME data paths"); return NULL;
    }
    engine->api = rime_get_api();
    if (!engine->api || !RIME_API_AVAILABLE(engine->api, select_candidate_on_current_page)) {
        free(engine->shared); free(engine->user); free(engine);
        snprintf(error, error_size, "librime lacks the required candidate API"); return NULL;
    }
    RIME_STRUCT(RimeTraits, traits);
    traits.shared_data_dir = engine->shared; traits.user_data_dir = engine->user;
    traits.distribution_name = "PollyIME"; traits.distribution_code_name = "polly";
    traits.distribution_version = "0.1"; traits.app_name = "rime.polly";
    traits.min_log_level = 3; traits.log_dir = "";
    const char *modules[] = { "default", NULL };
    traits.modules = modules;
    engine->api->setup(&traits);
    engine->api->set_notification_handler(notification, engine);
    engine->api->initialize(&traits);
    live = true;
    engine->api->start_maintenance(false);
    engine->api->join_maintenance_thread();
    bool configured = false;
    RimeSchemaList schemas = {0};
    if (!engine->deployment_failed && engine->api->get_schema_list(&schemas)) {
        for (size_t i = 0; i < schemas.size; i++)
            if (schemas.list[i].schema_id && !strcmp(schemas.list[i].schema_id, schema)) configured = true;
        engine->api->free_schema_list(&schemas);
    }
    if (configured) engine->session = engine->api->create_session();
    if (!configured || !engine->session || !engine->api->select_schema(engine->session, schema)) {
        snprintf(error, error_size, "Cannot deploy or select IME schema %s", schema);
        pu_ime_close(engine); return NULL;
    }
    engine->api->set_option(engine->session, "ascii_mode", false);
    return engine;
}

static bool copy_text(struct PuImeEngine *engine, char *out, size_t capacity, const char *text)
{
    size_t length = text ? strlen(text) : 0;
    if (length >= capacity) return fail(engine, "IME output exceeds supported text limits");
    if (length) memcpy(out, text, length);
    out[length] = 0;
    return true;
}
static bool text_offset(const char *text, int offset)
{
    return offset >= 0 && (size_t)offset <= strlen(text) &&
        (((unsigned char)text[offset] & 0xc0) != 0x80);
}
static bool snapshot(struct PuImeEngine *engine, struct PuImeSnapshot *out)
{
    memset(out, 0, sizeof(*out));
    RIME_STRUCT(RimeContext, context);
    if (!engine->api->get_context(engine->session, &context))
        return fail(engine, "Cannot read IME context");
    bool valid = copy_text(engine, out->preedit, sizeof(out->preedit), context.composition.preedit);
    if (valid && (!text_offset(out->preedit, context.composition.cursor_pos) ||
        !text_offset(out->preedit, context.composition.sel_start) ||
        !text_offset(out->preedit, context.composition.sel_end) ||
        context.composition.sel_start > context.composition.sel_end))
        valid = fail(engine, "IME returned invalid preedit offsets");
    if (valid && (context.menu.num_candidates < 0 || context.menu.num_candidates > PU_IME_CANDIDATES ||
        (context.menu.num_candidates && (!context.menu.candidates || context.menu.highlighted_candidate_index < 0 ||
        context.menu.highlighted_candidate_index >= context.menu.num_candidates))))
        valid = fail(engine, "IME returned an unsupported candidate page");
    if (valid) {
        out->cursor = (size_t)context.composition.cursor_pos;
        out->selection_start = (size_t)context.composition.sel_start;
        out->selection_end = (size_t)context.composition.sel_end;
        out->count = (size_t)context.menu.num_candidates;
        out->selected = out->count ? (size_t)context.menu.highlighted_candidate_index : 0;
        out->last_page = context.menu.is_last_page;
        for (size_t i = 0; valid && i < out->count; i++)
            valid = copy_text(engine, out->candidates[i], sizeof(out->candidates[i]), context.menu.candidates[i].text) &&
                copy_text(engine, out->comments[i], sizeof(out->comments[i]), context.menu.candidates[i].comment);
    }
    engine->api->free_context(&context);
    if (!valid) return false;
    RIME_STRUCT(RimeStatus, status);
    if (!engine->api->get_status(engine->session, &status)) return fail(engine, "Cannot read IME status");
    out->ascii = status.is_ascii_mode;
    engine->api->free_status(&status);
    RIME_STRUCT(RimeCommit, commit);
    if (engine->api->get_commit(engine->session, &commit)) {
        valid = copy_text(engine, out->commit, sizeof(out->commit), commit.text);
        engine->api->free_commit(&commit);
        if (!valid) return false;
    }
    out->revision = engine->revision;
    engine->candidates = out->count;
    engine->error[0] = 0;
    return true;
}

int pu_ime_key(struct PuImeEngine *engine, uint32_t keysym, unsigned modifiers,
    bool release, struct PuImeSnapshot *out)
{
    if (keysym > 0x1fffffffu || (modifiers & ~31u)) {
        fail(engine, "Invalid IME key or modifier mask"); return -1;
    }
    engine->revision++; engine->candidates = 0;
    int mask = (modifiers & PU_IME_SHIFT ? 1 : 0) | (modifiers & PU_IME_CAPS ? 2 : 0) |
        (modifiers & PU_IME_CTRL ? 4 : 0) | (modifiers & PU_IME_ALT ? 8 : 0) |
        (modifiers & PU_IME_SUPER ? 64 : 0) | (release ? 1 << 30 : 0);
    int handled = engine->api->process_key(engine->session, (int)keysym, mask);
    return snapshot(engine, out) ? !!handled : -1;
}
bool pu_ime_choose(struct PuImeEngine *engine, uint64_t revision, size_t index, struct PuImeSnapshot *out)
{
    if (revision != engine->revision || index >= engine->candidates)
        return fail(engine, "Stale or invalid IME candidate");
    engine->revision++; engine->candidates = 0;
    if (!engine->api->select_candidate_on_current_page(engine->session, index))
        return fail(engine, "Cannot select IME candidate");
    return snapshot(engine, out);
}
bool pu_ime_reset(struct PuImeEngine *engine, struct PuImeSnapshot *out)
{
    engine->revision++; engine->candidates = 0;
    engine->api->clear_composition(engine->session);
    return snapshot(engine, out);
}
bool pu_ime_set_ascii(struct PuImeEngine *engine, bool ascii, struct PuImeSnapshot *out)
{
    engine->revision++; engine->candidates = 0;
    engine->api->clear_composition(engine->session);
    engine->api->set_option(engine->session, "ascii_mode", ascii);
    return snapshot(engine, out);
}
