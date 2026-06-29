cmake_minimum_required(VERSION 3.25)

# C for the engine; CXX only for the Skia shim, skia_c.cpp (DESIGN.md §3).
project(PollyUI LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CMAKE_CXX_STANDARD 17)            # Skia requires C++17
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Match the prebuilt Skia (Release, STATIC CRT /MT) so the CRT / iterator-debug
# levels agree across the link. (MSVC/Windows only.)
if (MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

# --- Host backend selection (DESIGN.md §2; docs/PORTING.md) ------------------
#   win32 -> raw Win32 host (zero deps)   sdl -> SDL3 (macOS/Linux/Windows)
if (WIN32)
    set(PU_HOST_DEFAULT "win32")
else()
    set(PU_HOST_DEFAULT "sdl")
endif()
set(PU_HOST "${PU_HOST_DEFAULT}" CACHE STRING "Host backend: win32 | sdl")

# --- Skia (aseprite/skia m124 prebuilt) --------------------------------------
set(SKIA_ROOT ${CMAKE_SOURCE_DIR}/third_party/skia)
# Per-platform/arch default output dir; override with -DSKIA_LIB_DIR=... (e.g. a
# Metal-enabled Skia you built yourself).
if (NOT DEFINED SKIA_LIB_DIR)
    if (WIN32)
        set(SKIA_LIB_DIR ${SKIA_ROOT}/out/Release-x64)
    elseif (APPLE)
        if (CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
            set(SKIA_LIB_DIR ${SKIA_ROOT}/out/Release-arm64)
        else()
            set(SKIA_LIB_DIR ${SKIA_ROOT}/out/Release-x64)
        endif()
    else()
        set(SKIA_LIB_DIR ${SKIA_ROOT}/out/Release-x64)
    endif()
endif()

# --- QuickJS (quickjs-ng v0.15.1, vendored) ----------------------------------
# Build only the `qjs` library; EXCLUDE_FROM_ALL keeps its CLI/tests out of the
# build (they compile only if referenced, which they aren't).
set(QJS_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(QJS_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
add_subdirectory(third_party/quickjs EXCLUDE_FROM_ALL)

# --- Yoga (facebook/yoga v3.2.1, vendored) -----------------------------------
# Build only the yogacore static lib (the inner dir skips Yoga's tests/fuzz).
add_subdirectory(third_party/yoga/yoga EXCLUDE_FROM_ALL)
if (MSVC)
    # Yoga compiles with /WX; don't let a clang-cl warning fail our build.
    target_compile_options(yogacore PRIVATE /WX-)
endif()

add_executable(pollyui
    src/main.c
    src/render/skia_c.cpp
    src/render/render.c
    src/script/script.c
    src/script/storage.c
    src/model/node.c
    src/bridge/bridge.c
    src/layout/layout.c
    src/core/thread.c
    src/core/dispatch.c
    src/concurrency/async.c
    src/net/fetch.c
)

# --- HostEngine backend (the only per-OS C; see docs/PORTING.md §1) ----------
if (PU_HOST STREQUAL "win32")
    target_sources(pollyui PRIVATE src/host/win32/window.c)
elseif (PU_HOST STREQUAL "sdl")
    target_sources(pollyui PRIVATE src/host/sdl/window_sdl.c)
    find_package(SDL3 REQUIRED)
    target_link_libraries(pollyui PRIVATE SDL3::SDL3)
else()
    message(FATAL_ERROR "Unknown PU_HOST '${PU_HOST}' (expected: win32 | sdl)")
endif()

# --- Apple Metal render backend (docs/PORTING.md §2; OPT-IN) ----------------
# The default aseprite macOS Skia prebuilt has GL but NOT Metal compiled, so the
# Metal backend is off by default — the SDL host then renders via the CPU raster
# fallback, which links cleanly against the prebuilt. To get GPU Metal, build a
# Skia with skia_use_metal=true and configure: -DPU_METAL=ON -DSKIA_LIB_DIR=...
option(PU_METAL "Build the Apple Metal render backend (needs a Metal-enabled Skia)" OFF)
if (APPLE AND PU_METAL)
    target_sources(pollyui PRIVATE src/render/skia_metal.mm)
    target_compile_definitions(pollyui PRIVATE PU_METAL_BACKEND)
    # The .mm uses manual reference counting (see its header comment).
    set_source_files_properties(src/render/skia_metal.mm
        PROPERTIES COMPILE_OPTIONS "-fno-objc-arc")
    target_link_libraries(pollyui PRIVATE
        "-framework Metal" "-framework QuartzCore" "-framework Foundation")
endif()

# `src` for our headers (included as "host/...", "render/..."); SKIA_ROOT for
# Skia's root-relative includes (e.g. "include/core/SkSurface.h"); quickjs for
# "quickjs.h".
target_include_directories(pollyui PRIVATE src ${SKIA_ROOT} ${CMAKE_SOURCE_DIR}/third_party/quickjs)

# ScriptEngine + LayoutEngine. yogacore PUBLIC-exports its include dir, so
# layout.c can `#include <yoga/Yoga.h>`.
target_link_libraries(pollyui PRIVATE qjs yogacore)

# skia.lib (Windows) is self-contained: it bundles its own zlib (Cr_z_-prefixed),
# libpng, freetype, harfbuzz, icu, etc. The macOS/Linux prebuilt instead ships
# libskia.a alongside separate component archives (libfreetype2.a, libharfbuzz.a,
# libicu.a, ...), so there we link ALL the .a files in SKIA_LIB_DIR, grouped so
# the static linker resolves cross-references regardless of order.
if (WIN32)
    target_link_libraries(pollyui PRIVATE ${SKIA_LIB_DIR}/skia.lib)
else()
    file(GLOB SKIA_ARCHIVES "${SKIA_LIB_DIR}/*.a")
    if (NOT SKIA_ARCHIVES)
        message(FATAL_ERROR "No Skia archives (*.a) in ${SKIA_LIB_DIR}. "
                            "Run tools/fetch_skia.sh or set -DSKIA_LIB_DIR=...")
    endif()
    if (APPLE)
        target_link_libraries(pollyui PRIVATE ${SKIA_ARCHIVES})
        # System frameworks Skia depends on (codecs, fonts, GL backend).
        target_link_libraries(pollyui PRIVATE
            "-framework CoreFoundation" "-framework CoreGraphics" "-framework CoreText"
            "-framework CoreServices" "-framework ImageIO" "-framework Cocoa"
            "-framework OpenGL")
    else()
        # GNU ld needs an explicit group for mutually-referencing static libs.
        target_link_libraries(pollyui PRIVATE
            -Wl,--start-group ${SKIA_ARCHIVES} -Wl,--end-group)
    endif()
endif()

# Skia's bundled zlib exports Cr_z_-prefixed names, but its bundled libpng calls
# the unprefixed zlib entry points. They are the same functions, so alias the
# unprefixed references onto the Cr_z_ definitions at link time (lld /alternatename).
if (MSVC)
    target_link_options(pollyui PRIVATE
        "/alternatename:inflate=Cr_z_inflate"
        "/alternatename:inflateInit2_=Cr_z_inflateInit2_"
        "/alternatename:inflateEnd=Cr_z_inflateEnd"
        "/alternatename:inflateReset=Cr_z_inflateReset")
endif()

if (WIN32)
    target_compile_definitions(pollyui PRIVATE
        UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    # System libs: Win32 (host) + Skia's Windows backends (DirectWrite/GDI/GL/COM).
    target_link_libraries(pollyui PRIVATE
        user32 gdi32 opengl32 ole32 oleaut32 advapi32 dwrite dbghelp winhttp)
endif()

# Release/GUI build: no console window (console.log mirrors to the debugger via
# OutputDebugString). Dev builds keep the console so `console.log` hits the
# terminal and `--test` output is capturable.
#   cmake --preset win-clang -DPU_WINDOWED=ON
option(PU_WINDOWED "Build a GUI app with no console window" OFF)
if (WIN32 AND PU_WINDOWED)
    target_compile_definitions(pollyui PRIVATE PU_WINDOWED)
    target_link_options(pollyui PRIVATE /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup)
endif()

