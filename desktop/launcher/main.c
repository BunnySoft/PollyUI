#include "launcher.h"
#include "pollyui/context.h"

#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#include <dbghelp.h>
/* Print a symbolized stack trace on an unhandled crash (no debugger needed). */
static LONG WINAPI pu_crash_handler(EXCEPTION_POINTERS *ep)
{
    HANDLE proc = GetCurrentProcess();
    SymSetOptions(SYMOPT_LOAD_LINES | SYMOPT_DEFERRED_LOADS | SYMOPT_UNDNAME);
    SymInitialize(proc, NULL, TRUE);
    CONTEXT *ctx = ep->ContextRecord;
    fprintf(stderr, "\n*** CRASH code=0x%08lx at %p (thread %lu) ***\n",
            ep->ExceptionRecord->ExceptionCode,
            ep->ExceptionRecord->ExceptionAddress, GetCurrentThreadId());

    STACKFRAME64 sf;
    memset(&sf, 0, sizeof(sf));
    sf.AddrPC.Offset = ctx->Rip;    sf.AddrPC.Mode = AddrModeFlat;
    sf.AddrFrame.Offset = ctx->Rbp; sf.AddrFrame.Mode = AddrModeFlat;
    sf.AddrStack.Offset = ctx->Rsp; sf.AddrStack.Mode = AddrModeFlat;

    char buf[sizeof(SYMBOL_INFO) + 256];
    SYMBOL_INFO *sym = (SYMBOL_INFO *)buf;
    sym->SizeOfStruct = sizeof(SYMBOL_INFO);
    sym->MaxNameLen = 255;

    for (int i = 0; i < 24; i++) {
        if (!StackWalk64(IMAGE_FILE_MACHINE_AMD64, proc, GetCurrentThread(), &sf, ctx,
                         NULL, SymFunctionTableAccess64, SymGetModuleBase64, NULL))
            break;
        if (!sf.AddrPC.Offset) break;
        DWORD64 disp = 0;
        if (SymFromAddr(proc, sf.AddrPC.Offset, &disp, sym))
            fprintf(stderr, "  #%-2d %s + 0x%llx\n", i, sym->Name, (unsigned long long)disp);
        else
            fprintf(stderr, "  #%-2d 0x%llx\n", i, (unsigned long long)sf.AddrPC.Offset);
    }
    fflush(stderr);
    return EXCEPTION_EXECUTE_HANDLER;
}
#endif

int main(int argc, char **argv)
{
#ifdef _WIN32
    SetUnhandledExceptionFilter(pu_crash_handler);
#endif
    int rc;
    const char *app_id = NULL;
    int desktop_mode = 0;
    int input_method_mode = 0;
    int lock_mode = 0;
    int greeter_mode = 0;
    int no_legacy_storage = 0;
    int index = 1;
    while (index < argc) {
        if (!strcmp(argv[index], "--no-legacy-storage")) {
            no_legacy_storage = 1; index++;
        } else if (!strcmp(argv[index], "--app-id")) {
            if (index + 2 >= argc) { fprintf(stderr, "--app-id requires an ID and an application script\n"); return 2; }
            app_id = argv[index + 1]; index += 2;
        } else if (!strcmp(argv[index], "--greeter")) {
#if defined(PU_GREETER)
            greeter_mode = 1; index++;
#else
            fprintf(stderr, "Graphical greeter APIs are unavailable in this build\n"); return 2;
#endif
        } else if (!strcmp(argv[index], "--session-lock")) {
#if defined(PU_SESSION_LOCK)
            lock_mode = 1; index++;
#else
            fprintf(stderr, "Session-lock service is unavailable in this build\n"); return 2;
#endif
        } else if (!strcmp(argv[index], "--input-method")) {
#if defined(PU_INPUT_METHOD)
            input_method_mode = 1; index++;
#else
            fprintf(stderr, "Input-method APIs are unavailable in this build\n"); return 2;
#endif
        } else if (!strcmp(argv[index], "--desktop")) {
#if defined(PU_DESKTOP_SERVICES)
            desktop_mode = 1; index++;
#else
            fprintf(stderr, "Desktop application APIs are unavailable in this build\n"); return 2;
#endif
        } else break;
    }
    if (index < argc && !strcmp(argv[index], "--help")) {
        puts("Usage: pollyui [--desktop | --input-method | --session-lock | --greeter] [--app-id ID] app.js [arguments...]\n"
             "       pollyui --test test.js\n"
             "--app-id selects a stable Linux XDG storage namespace.\n"
             "--no-legacy-storage omits the legacy localStorage service for applications owning their configuration.\n"
             "--desktop explicitly enables Linux application discovery and direct process launching.\n"
             "--input-method enables the separately authorized input-method service.\n"
             "--session-lock enables the separately authorized lock service.\n"
             "--greeter enables only the dedicated installed greeter authentication service.");
        return 0;
    }
    if (index < argc && !strcmp(argv[index], "--test")) {
        if (app_id || desktop_mode || input_method_mode || lock_mode || greeter_mode || no_legacy_storage || index + 1 >= argc) { fprintf(stderr, "--test requires a script and does not accept service options\n"); return 2; }
        rc = pu_application_test(argv[index + 1]);
    } else if (index < argc && argv[index][0] == '-') {
        fprintf(stderr, "Unknown option: %s\n", argv[index]); return 2;
    } else if (index < argc) {
        if (desktop_mode + input_method_mode + lock_mode + greeter_mode > 1) { fprintf(stderr, "Service modes are mutually exclusive\n"); return 2; }
        if (no_legacy_storage && (input_method_mode || lock_mode || greeter_mode)) {
            fprintf(stderr, "Protected service roles retain their existing storage composition\n"); return 2;
        }
        PuLaunchOptions options = {
            .script = argv[index], .app_id = app_id,
            .argc = argc - index - 1, .argv = argv + index + 1,
            .desktop_mode = desktop_mode, .input_method_mode = input_method_mode,
            .lock_mode = lock_mode, .greeter_mode = greeter_mode,
            .no_legacy_storage = no_legacy_storage,
        };
        rc = pu_application_run(&options);
    }
    else
        if (desktop_mode || input_method_mode || lock_mode || greeter_mode || no_legacy_storage) { fprintf(stderr, "Service options require an application script\n"); return 2; }
        else rc = pu_application_demo();
    pu_gui_shutdown();
    return rc;
}
