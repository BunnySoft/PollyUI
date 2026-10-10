#ifndef POLLYUI_CONTEXT_H
#define POLLYUI_CONTEXT_H

typedef struct JSContext JSContext;
typedef struct PuDispatch PuDispatch;

typedef struct PuGuiHooks {
    int (*install)(JSContext *ctx, PuDispatch *dispatch, int headless, void *user);
    int (*pump)(void *user);
    /* Stop producers before windows retire; all hooks run before VM destruction. */
    void (*stop)(void *user);
    void (*windows_closed)(void *user);
    void (*dispose)(void *user);
} PuGuiHooks;

typedef struct PuGuiConfig {
    const char *script;
    const PuGuiHooks *hooks;
    void *user;
    int keep_alive;
    int redact_errors;
} PuGuiConfig;

/* UI-thread execution; one active context per process. Config/hooks are borrowed
 * until return, and host callbacks must not enter another GUI context. */
int pu_gui_run(const PuGuiConfig *config);
int pu_gui_test(const PuGuiConfig *config);
int pu_gui_demo(void);
void pu_gui_shutdown(void);

#endif
