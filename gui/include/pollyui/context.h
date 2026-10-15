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
    /* Windowless host: wait returns 0 on wake, 1 on shutdown, -1 on error.
     * wake may be called by producers; remove it only after they are joined. */
    int (*wait)(int timeout_ms, void *user);
    void (*wake)(void *user);
} PuGuiHooks;

typedef struct PuGuiConfig {
    const char *script;
    /* Optional initialization module, completed before the app entry. */
    const char *prelude;
    /* Shared module directory; application-local modules remain the fallback. */
    const char *module_root;
    const PuGuiHooks *hooks;
    void *user;
    int keep_alive;
    int redact_errors;
} PuGuiConfig;

/* UI-thread execution; one active context per process. Config/hooks are borrowed
 * until return, and host callbacks must not enter another GUI context. */
int pu_gui_run(const PuGuiConfig *config);
int pu_gui_test(const PuGuiConfig *config);
/* Production execution without SDL, Window APIs or a test host. Requires
 * wait/wake hooks; the root Document is unowned and has defaultView == null. */
int pu_gui_service(const PuGuiConfig *config);
int pu_gui_demo(void);
void pu_gui_shutdown(void);

#endif
