cmake_minimum_required(VERSION 3.25)

# C for the engine; CXX only for the Skia shim, skia_c.cpp (DESIGN.md §3).
project(PollyUI LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CMAKE_CXX_STANDARD 17)            # Skia requires C++17
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(PU_BUILD_DESKTOP "Build the experimental Linux Wayland compositor" OFF)
if (PU_BUILD_DESKTOP)
    include(CTest)
    add_subdirectory(desktop)
endif()

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

# --- Skia (aseprite/skia m124; native source build on Linux) -----------------
if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(SKIA_ROOT_DEFAULT "${CMAKE_SOURCE_DIR}/third_party/skia-linux")
else()
    set(SKIA_ROOT_DEFAULT "${CMAKE_SOURCE_DIR}/third_party/skia")
endif()
set(SKIA_ROOT "${SKIA_ROOT_DEFAULT}" CACHE PATH "Skia headers/source root matching SKIA_LIB_DIR")
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
        set(SKIA_LIB_DIR ${SKIA_ROOT}/out/Release-linux)
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
    src/core/app_paths.c
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

# POSIX threads for the concurrency layer (core/thread.c) on macOS/Linux.
if (NOT WIN32)
    find_package(Threads REQUIRED)
    target_link_libraries(pollyui PRIVATE Threads::Threads)
endif()

# Linux builds use the native font/codec libraries selected by skia-linux.gn.
if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SKIA_SYSTEM REQUIRED IMPORTED_TARGET
        fontconfig freetype2 libpng libjpeg libwebp libwebpdemux libwebpmux zlib)
    target_link_libraries(pollyui PRIVATE PkgConfig::SKIA_SYSTEM)
    pkg_check_modules(CURL REQUIRED IMPORTED_TARGET libcurl>=7.85)
    target_link_libraries(pollyui PRIVATE PkgConfig::CURL)
    # Match the official Release Skia ABI even when the host is a Debug build.
    target_compile_definitions(pollyui PRIVATE _POSIX_C_SOURCE=200809L SK_R32_SHIFT=16 SK_RELEASE)
    option(PU_LAYER_SHELL "Support custom Wayland layer surfaces in the SDL host" ON)
    if (PU_LAYER_SHELL AND PU_HOST STREQUAL "sdl")
        pkg_check_modules(WAYLAND_UI REQUIRED IMPORTED_TARGET wayland-client)
        pkg_check_modules(LAYER_PROTOCOLS REQUIRED wlr-protocols wayland-protocols)
        pkg_get_variable(WLR_UI_PROTOCOLS wlr-protocols pkgdatadir)
        pkg_get_variable(WAYLAND_UI_PROTOCOLS wayland-protocols pkgdatadir)
        find_program(UI_WAYLAND_SCANNER wayland-scanner REQUIRED)
        set(UI_PROTOCOL_DIR "${CMAKE_CURRENT_BINARY_DIR}/ui-protocols")
        file(MAKE_DIRECTORY "${UI_PROTOCOL_DIR}")
        set(UI_LAYER_XML "${WLR_UI_PROTOCOLS}/unstable/wlr-layer-shell-unstable-v1.xml")
        set(UI_XDG_XML "${WAYLAND_UI_PROTOCOLS}/stable/xdg-shell/xdg-shell.xml")
        add_custom_command(
            OUTPUT "${UI_PROTOCOL_DIR}/layer-shell-client.h" "${UI_PROTOCOL_DIR}/layer-shell.c"
                   "${UI_PROTOCOL_DIR}/xdg-shell.c"
            COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_LAYER_XML}" "${UI_PROTOCOL_DIR}/layer-shell-client.h"
            COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_LAYER_XML}" "${UI_PROTOCOL_DIR}/layer-shell.c"
            COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_XDG_XML}" "${UI_PROTOCOL_DIR}/xdg-shell.c"
            DEPENDS "${UI_LAYER_XML}" "${UI_XDG_XML}" VERBATIM)
        target_sources(pollyui PRIVATE src/host/sdl/layer_shell.c
            "${UI_PROTOCOL_DIR}/layer-shell-client.h" "${UI_PROTOCOL_DIR}/layer-shell.c"
            "${UI_PROTOCOL_DIR}/xdg-shell.c")
        target_include_directories(pollyui PRIVATE "${UI_PROTOCOL_DIR}")
        target_compile_definitions(pollyui PRIVATE PU_LAYER_SHELL)
        target_link_libraries(pollyui PRIVATE PkgConfig::WAYLAND_UI)
    endif()
endif()

# macOS native title-bar helper (transparent titlebar + native traffic lights).
# Always built on Apple (the SDL host calls into it); Cocoa is linked below.
if (APPLE)
    target_sources(pollyui PRIVATE src/host/sdl/macos_titlebar.mm)
    set_source_files_properties(src/host/sdl/macos_titlebar.mm
        PROPERTIES COMPILE_OPTIONS "-fno-objc-arc")
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
        if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
            message(FATAL_ERROR "No native Linux Skia archives in ${SKIA_LIB_DIR}. "
                "Run desktop/tools/build-skia-linux.sh with an absolute source directory, "
                "then set SKIA_ROOT and SKIA_LIB_DIR to that build.")
        else()
            message(FATAL_ERROR "No Skia archives (*.a) in ${SKIA_LIB_DIR}. "
                "Run tools/fetch_skia.sh or set -DSKIA_LIB_DIR=...")
        endif()
    endif()
    if (APPLE)
        target_link_libraries(pollyui PRIVATE ${SKIA_ARCHIVES})
        # System frameworks Skia depends on (codecs, fonts, GL backend) + the
        # system zlib: Skia's bundled zlib is Cr_z_-prefixed, but freetype/libpng
        # call the standard inflate/deflate, which /usr/lib/libz provides.
        target_link_libraries(pollyui PRIVATE
            "-framework CoreFoundation" "-framework CoreGraphics" "-framework CoreText"
            "-framework CoreServices" "-framework ImageIO" "-framework Cocoa"
            "-framework OpenGL" z)
    else()
        # GNU ld needs an explicit group for mutually-referencing static libs.
        target_link_libraries(pollyui PRIVATE
            -Wl,--start-group ${SKIA_ARCHIVES} -Wl,--end-group z)
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
        user32 gdi32 opengl32 ole32 oleaut32 advapi32 dwrite dbghelp winhttp shcore)
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

if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_BUILD_DESKTOP AND BUILD_TESTING)
    add_test(NAME desktop-session
        COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/session.sh"
            "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
            $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
            "${CMAKE_SOURCE_DIR}/desktop/tests/session-client.mjs")
    set_tests_properties(desktop-session PROPERTIES TIMEOUT 25 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    function(pu_host_fixture target source)
        add_executable(${target} ${source} src/host/sdl/window_sdl.c src/render/skia_c.cpp)
        target_include_directories(${target} PRIVATE src "${SKIA_ROOT}")
        target_compile_definitions(${target} PRIVATE _POSIX_C_SOURCE=200809L SK_R32_SHIFT=16 SK_RELEASE)
        target_link_libraries(${target} PRIVATE SDL3::SDL3 PkgConfig::SKIA_SYSTEM
            -Wl,--start-group ${SKIA_ARCHIVES} -Wl,--end-group Threads::Threads)
    endfunction()
    pu_host_fixture(pollyui-input-test tests/sdl-input.c)
    pu_host_fixture(pollyui-multi-test tests/multi-window-native.c)
    add_test(NAME sdl-input-adapter COMMAND pollyui-input-test)
    add_test(NAME sdl-multi-window COMMAND pollyui-multi-test)
    set_tests_properties(sdl-input-adapter sdl-multi-window PROPERTIES TIMEOUT 15
        ENVIRONMENT "SDL_VIDEODRIVER=dummy;SDL_RENDER_DRIVER=software;PU_RENDERER=raster")
    if (PU_LAYER_SHELL)
        add_executable(pollyui-layer-client-test desktop/tests/runtime-client.c)
        target_link_libraries(pollyui-layer-client-test PRIVATE pollywm-core)
        target_compile_options(pollyui-layer-client-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
        foreach(renderer IN ITEMS raster gl)
            add_test(NAME desktop-runtime-${renderer}
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                    $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                    "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.mjs")
            set_tests_properties(desktop-runtime-${renderer} PROPERTIES TIMEOUT 35
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
            add_test(NAME desktop-layer-${renderer}
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-layer.sh"
                    $<TARGET_FILE:pollyui> $<TARGET_FILE:pollywm>)
            set_tests_properties(desktop-layer-${renderer} PROPERTIES TIMEOUT 35
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
        endforeach()
    endif()
endif()
