#include "render/gpu_device.h"
#ifdef PU_WEBGL2
#include <cstdio>
#include <cstring>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace
{
struct Egl {
#define EGL_PROC(name) decltype(&egl##name) name = nullptr;
    EGL_PROC(GetDisplay)
    EGL_PROC(Initialize)
    EGL_PROC(BindAPI)
    EGL_PROC(QueryAPI)
    EGL_PROC(ChooseConfig)
    EGL_PROC(CreatePbufferSurface)
    EGL_PROC(CreateContext)
    EGL_PROC(MakeCurrent)
    EGL_PROC(GetCurrentContext)
    EGL_PROC(GetCurrentDisplay)
    EGL_PROC(GetCurrentSurface)
    EGL_PROC(DestroyContext)
    EGL_PROC(DestroySurface)
    EGL_PROC(GetError)
    EGL_PROC(GetProcAddress)
    EGL_PROC(QueryString)
#undef EGL_PROC
    PFNEGLGETPLATFORMDISPLAYEXTPROC GetPlatformDisplayEXT = nullptr;
} egl;
PuGles gl;
bool loaded, attempted;
#ifdef _WIN32
HMODULE egl_library, gles_library;
void* symbol(HMODULE library, const char* name)
{
    return reinterpret_cast<void*>(GetProcAddress(library, name));
}
#else
void *egl_library, *gles_library;
void* symbol(void* library, const char* name) { return dlsym(library, name); }
#endif
bool load()
{
    if (attempted)
        return loaded;
    attempted = true;
#ifdef _WIN32
    // Restrict development ANGLE DLLs to the application's directory, not PATH/CWD.
    egl_library = LoadLibraryExW(
        L"libEGL.dll", nullptr, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    gles_library = LoadLibraryExW(L"libGLESv2.dll", nullptr,
        LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
#else
    egl_library = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
    gles_library = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
#endif
    if (!egl_library || !gles_library) {
        std::fprintf(stderr, "[webgl2] EGL/GLES libraries unavailable\n");
        return false;
    }
#define EGL_PROC(name)                                                                             \
    egl.name = reinterpret_cast<decltype(egl.name)>(symbol(egl_library, "egl" #name));             \
    if (!egl.name) {                                                                               \
        std::fprintf(stderr, "[webgl2] missing egl" #name "\n");                                   \
        return false;                                                                              \
    }
    EGL_PROC(GetDisplay)
    EGL_PROC(Initialize)
    EGL_PROC(BindAPI) EGL_PROC(QueryAPI) EGL_PROC(ChooseConfig) EGL_PROC(CreatePbufferSurface)
        EGL_PROC(CreateContext) EGL_PROC(MakeCurrent) EGL_PROC(GetCurrentContext)
            EGL_PROC(GetCurrentDisplay) EGL_PROC(GetCurrentSurface) EGL_PROC(DestroyContext)
                EGL_PROC(DestroySurface) EGL_PROC(GetError) EGL_PROC(GetProcAddress) EGL_PROC(
                    QueryString)
#undef EGL_PROC
                    egl.GetPlatformDisplayEXT = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(
        egl.GetProcAddress("eglGetPlatformDisplayEXT"));
#define PU_GL(name)                                                                                \
    gl.name = reinterpret_cast<decltype(gl.name)>(symbol(gles_library, "gl" #name));               \
    if (!gl.name)                                                                                  \
        gl.name = reinterpret_cast<decltype(gl.name)>(egl.GetProcAddress("gl" #name));             \
    if (!gl.name) {                                                                                \
        std::fprintf(stderr, "[webgl2] missing ES3 gl" #name "\n");                                \
        return false;                                                                              \
    }
#include "render/gles_api.inc"
#undef PU_GL
    loaded = true;
    return true;
}
}
PuGles* pu_gles() { return &gl; }
void* pu_gpu_proc(const char* name)
{
    void* proc = symbol(gles_library, name);
    return proc ? proc : reinterpret_cast<void*>(egl.GetProcAddress(name));
}
bool pu_gpu_device_is_current(const PuGpuDevice* d)
{
    return egl.GetCurrentContext() == d->context && egl.GetCurrentDisplay() == d->display
        && egl.GetCurrentSurface(EGL_DRAW) == d->surface
        && egl.GetCurrentSurface(EGL_READ) == d->surface;
}

PuGpuCurrent::PuGpuCurrent(PuGpuDevice* d)
    : device(d)
{
    display = egl.GetCurrentDisplay();
    context = egl.GetCurrentContext();
    draw = egl.GetCurrentSurface(EGL_DRAW);
    read = egl.GetCurrentSurface(EGL_READ);
    api = egl.QueryAPI();
    if (device->thread != std::this_thread::get_id()) {
        std::fprintf(stderr, "[webgl2] rejected foreign-thread context access\n");
        return;
    }
    current = egl.BindAPI(EGL_OPENGL_ES_API)
        && egl.MakeCurrent(device->display, device->surface, device->surface, device->context);
    touched = true;
    if (!current)
        std::fprintf(stderr, "[webgl2] eglMakeCurrent failed: 0x%x\n", egl.GetError());
}
PuGpuCurrent::~PuGpuCurrent()
{
    if (!touched)
        return;
    bool released
        = egl.MakeCurrent(device->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    bool rebound = egl.BindAPI(api);
    bool restored = display == EGL_NO_DISPLAY || egl.MakeCurrent(display, draw, read, context);
    if (!released || !rebound || !restored) {
        std::fprintf(
            stderr, "[webgl2] FAILED to restore owning UI EGL context: 0x%x\n", egl.GetError());
        device->failed = true;
    }
}
bool pu_gpu_device_open(PuGpuDevice* d)
{
    if (!load())
        return false;
    d->thread = std::this_thread::get_id();
    d->failed = false;
    EGLenum old_api = egl.QueryAPI();
    if (egl.GetPlatformDisplayEXT) {
#ifdef _WIN32
        const EGLint attributes[] = { 0x3203 /* EGL_PLATFORM_ANGLE_TYPE_ANGLE */,
            0x3208 /* EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE */, EGL_NONE };
        d->display = egl.GetPlatformDisplayEXT(
            0x3202 /* EGL_PLATFORM_ANGLE_ANGLE */, EGL_DEFAULT_DISPLAY, attributes);
#else
        d->display = egl.GetPlatformDisplayEXT(
            0x31DD /* EGL_PLATFORM_SURFACELESS_MESA */, EGL_DEFAULT_DISPLAY, nullptr);
#endif
    }
    if (d->display == EGL_NO_DISPLAY)
        d->display = egl.GetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint major, minor, count;
    EGLConfig config;
    const EGLint attributes[]
        = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT_KHR,
              EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
    const EGLint pbuffer[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
    std::vector<EGLint> context = { EGL_CONTEXT_CLIENT_VERSION, 3 };
    bool ok = d->display != EGL_NO_DISPLAY && egl.Initialize(d->display, &major, &minor)
        && egl.BindAPI(EGL_OPENGL_ES_API)
        && egl.ChooseConfig(d->display, attributes, &config, 1, &count) && count;
    if (ok) {
        const char* extensions = egl.QueryString(d->display, EGL_EXTENSIONS);
        if (extensions && strstr(extensions, "EGL_ANGLE_create_context_webgl_compatibility")) {
            context.insert(
                context.end(), { 0x33AC /* EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE */, EGL_TRUE });
            std::fprintf(stderr, "[webgl2] ANGLE WebGL compatibility validation enabled\n");
        }
        if (extensions && strstr(extensions, "EGL_ANGLE_create_context_extensions_enabled"))
            context.insert(context.end(), { 0x345F /* EGL_EXTENSIONS_ENABLED_ANGLE */, EGL_FALSE });
        if (extensions && strstr(extensions, "EGL_ANGLE_robust_resource_initialization")) {
            context.insert(
                context.end(), { 0x3453 /* EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE */, EGL_TRUE });
            std::fprintf(stderr, "[webgl2] ANGLE robust resource initialization enabled\n");
        }
        if (extensions && strstr(extensions, "EGL_EXT_create_context_robustness")) {
            context.insert(
                context.end(), { 0x30BF /* EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT */, EGL_TRUE });
            std::fprintf(stderr, "[webgl2] EGL robust access requested\n");
        }
        context.push_back(EGL_NONE);
        d->surface = egl.CreatePbufferSurface(d->display, config, pbuffer);
        d->context = egl.CreateContext(d->display, config, EGL_NO_CONTEXT, context.data());
        ok = d->surface != EGL_NO_SURFACE && d->context != EGL_NO_CONTEXT;
    }
    if (!egl.BindAPI(old_api)) {
        std::fprintf(stderr, "[webgl2] failed to restore EGL client API\n");
        ok = false;
    }
    if (!ok) {
        std::fprintf(
            stderr, "[webgl2] ES3 offscreen context unavailable: EGL error 0x%x\n", egl.GetError());
        pu_gpu_device_close(d);
        return false;
    }
    {
        PuGpuCurrent current(d);
        if (!current.ok()) {
            pu_gpu_device_close(d);
            return false;
        }
        GLint version = 0;
        gl.GetIntegerv(GL_MAJOR_VERSION, &version);
        if (version < 3) {
            std::fprintf(stderr, "[webgl2] context is not ES3\n");
            return false;
        }
        std::fprintf(stderr, "[webgl2] EGL %d.%d; vendor=%s; renderer=%s; version=%s\n", major,
            minor, gl.GetString(GL_VENDOR), gl.GetString(GL_RENDERER), gl.GetString(GL_VERSION));
    }
    return true;
}
void pu_gpu_device_close(PuGpuDevice* d)
{
    if (d->context != EGL_NO_CONTEXT)
        egl.DestroyContext(d->display, d->context);
    if (d->surface != EGL_NO_SURFACE)
        egl.DestroySurface(d->display, d->surface);
    d->context = EGL_NO_CONTEXT;
    d->surface = EGL_NO_SURFACE;
    // EGLDisplay is process-shared (including SDL/Skia). Never terminate their display.
}
#endif
