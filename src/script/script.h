#ifndef POLLYUI_SCRIPT_SCRIPT_H
#define POLLYUI_SCRIPT_SCRIPT_H

/* ScriptEngine — the QuickJS VM wrapper (DESIGN.md §2).
 *
 * M1 surface: create a VM, register `console` and timers, evaluate a .js file,
 * and run a minimal event loop (promise microtasks + setTimeout) to completion.
 * The DOM bindings (Model bridge) arrive in M2. */

#include "quickjs.h"
#include "core/dispatch.h"

typedef struct PuScript PuScript;

/* Attach the UI dispatcher so the event loop drains async deliveries (worker
 * messages, task callbacks) and stays alive while async work is outstanding. */
void pu_script_set_dispatch(PuScript *s, PuDispatch *d);

/* Non-blocking: run all immediately-runnable work (microtasks, async
 * deliveries, due timers). Returns how many items ran. */
int pu_script_pump(PuScript *s);

/* Create a script VM with console + timers registered. NULL on failure. */
PuScript *pu_script_create(void);

/* The underlying QuickJS context (e.g. to install the DOM bridge). */
JSContext *pu_script_jsctx(PuScript *s);

/* Destroy the VM and free all resources. Safe with NULL. */
void pu_script_destroy(PuScript *s);

/* Evaluate `path` as a global script. Returns 0 on success; on a JS error,
 * prints the message + stack and returns nonzero. */
int pu_script_run_file(PuScript *s, const char *path);

/* Drain the event loop — pending promise jobs and due timers — until idle. */
void pu_script_run_loop(PuScript *s);

#endif /* POLLYUI_SCRIPT_SCRIPT_H */
