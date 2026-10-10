cmake_minimum_required(VERSION 3.25)

# C for the engine; CXX only for the Skia shim, skia_c.cpp (DESIGN.md §3).
project(PollyUI LANGUAGES C CXX)
include(GNUInstallDirs)
include(CTest)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CMAKE_CXX_STANDARD 17)            # Skia requires C++17
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(PU_BUILD_DESKTOP "Build the experimental Linux Wayland compositor" OFF)
option(PU_BUILD_LAUNCHER "Build the application launcher with SysRT system capabilities" ON)
if (PU_BUILD_DESKTOP)
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

if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    option(PU_DESKTOP_SERVICES "Enable explicit Linux desktop application APIs" ${PU_BUILD_DESKTOP})
endif()
add_subdirectory(shared)
add_subdirectory(gui)
if (PU_BUILD_LAUNCHER)
    add_subdirectory(sysrt)

    add_executable(pollyui
        desktop/launcher/main.c
        desktop/launcher/launcher.c
    )
    target_link_libraries(pollyui PRIVATE pollyui-engine polly-sysrt-qjs polly-sysrt-ffi)
endif()

# --- HostEngine backend (the only per-OS C; see docs/PORTING.md §1) ----------
if (PU_HOST STREQUAL "win32")
    target_sources(pollyui-engine PRIVATE gui/src/host/win32/window.c)
elseif (PU_HOST STREQUAL "sdl")
    target_sources(pollyui-engine PRIVATE gui/src/host/sdl/window_sdl.c)
    target_compile_definitions(pollyui-engine PRIVATE PU_CLIPBOARD_SDL)
    find_package(SDL3 REQUIRED)
    target_link_libraries(pollyui-engine PUBLIC SDL3::SDL3)
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
    target_sources(pollyui-engine PRIVATE gui/src/render/skia_metal.mm)
    target_compile_definitions(pollyui-engine PRIVATE PU_METAL_BACKEND)
    # The .mm uses manual reference counting (see its header comment).
    set_source_files_properties(gui/src/render/skia_metal.mm
        PROPERTIES COMPILE_OPTIONS "-fno-objc-arc")
    target_link_libraries(pollyui-engine PUBLIC
        "-framework Metal" "-framework QuartzCore" "-framework Foundation")
endif()

# POSIX threads for GUI workers and native fixtures on macOS/Linux.
if (NOT WIN32)
    find_package(Threads REQUIRED)
    target_link_libraries(pollyui-engine PUBLIC Threads::Threads)
endif()

# Linux builds use the native font/codec libraries selected by skia-linux.gn.
if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    if (PU_BUILD_LAUNCHER AND PU_DESKTOP_SERVICES)
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(SESSION_DBUS REQUIRED IMPORTED_TARGET dbus-1)
        pkg_check_modules(BUNDLE_ARCHIVE REQUIRED IMPORTED_TARGET libarchive)
        pkg_check_modules(BUNDLE_CRYPTO REQUIRED IMPORTED_TARGET libcrypto)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS desktop/shared/app-bundle.mjs)
        file(READ "${CMAKE_SOURCE_DIR}/desktop/shared/app-bundle.mjs" BUNDLE_SCHEMA HEX)
        string(REGEX REPLACE "(..)" "0x\\1," BUNDLE_SCHEMA "${BUNDLE_SCHEMA}")
        file(WRITE "${CMAKE_BINARY_DIR}/bundle-schema.h"
            "static const unsigned char bundle_schema[] = {${BUNDLE_SCHEMA}0};\n")
        add_library(polly-bundles STATIC desktop/native/bundles.c)
        target_include_directories(polly-bundles PRIVATE "${CMAKE_BINARY_DIR}" PUBLIC "${CMAKE_SOURCE_DIR}" desktop)
        target_link_libraries(polly-bundles PUBLIC qjs PkgConfig::BUNDLE_ARCHIVE PkgConfig::BUNDLE_CRYPTO)
        target_compile_options(polly-bundles PRIVATE -Wall -Wextra -Wpedantic -Werror)
        add_executable(polly-app desktop/native/bundle-main.c)
        target_link_libraries(polly-app PRIVATE polly-bundles)
        install(TARGETS polly-app RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
        target_sources(pollyui PRIVATE desktop/native/applications.c desktop/native/documents.c
            desktop/native/install-targets.c desktop/native/session-bus.c)
        target_include_directories(pollyui PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
        target_link_libraries(pollyui PRIVATE PkgConfig::SESSION_DBUS polly-bundles)
        target_compile_definitions(pollyui PRIVATE PU_DESKTOP_SERVICES)
        target_sources(pollyui PRIVATE desktop/native/greeter-client.c)
        target_include_directories(pollyui PRIVATE desktop/session)
        target_compile_definitions(pollyui PRIVATE PU_GREETER)
        add_executable(pollyui-app-launcher desktop/native/exec.c)
        target_compile_options(pollyui-app-launcher PRIVATE -fno-sanitize=all -Wall -Wextra -Werror)
        target_link_options(pollyui-app-launcher PRIVATE -fno-sanitize=all)
        add_dependencies(pollyui pollyui-app-launcher polly-app)
        install(TARGETS pollyui-app-launcher RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
    endif()

    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SKIA_SYSTEM REQUIRED IMPORTED_TARGET
        fontconfig freetype2 libpng libjpeg libwebp libwebpdemux libwebpmux zlib harfbuzz icu-uc icu-i18n)
    target_compile_definitions(pollyui-engine PUBLIC PU_COMPLEX_TEXT)
    # Match the official Release Skia ABI even when the host is a Debug build.
    target_compile_definitions(pollyui-engine PUBLIC _POSIX_C_SOURCE=200809L SK_R32_SHIFT=16 SK_RELEASE)
    option(PU_LAYER_SHELL "Support custom Wayland layer surfaces in the SDL host" ON)
    if (PU_LAYER_SHELL AND PU_HOST STREQUAL "sdl")
        pkg_check_modules(WAYLAND_UI REQUIRED IMPORTED_TARGET wayland-client)
        pkg_check_modules(LAYER_PROTOCOLS REQUIRED wlr-protocols wayland-protocols)
        pkg_get_variable(WLR_UI_PROTOCOLS wlr-protocols pkgdatadir)
        pkg_get_variable(WAYLAND_UI_PROTOCOLS wayland-protocols pkgdatadir)
        find_program(UI_WAYLAND_SCANNER wayland-scanner REQUIRED)
        set(UI_PROTOCOL_DIR "${CMAKE_CURRENT_BINARY_DIR}/ui-protocols")
        file(MAKE_DIRECTORY "${UI_PROTOCOL_DIR}")
        set(UI_SESSION_STATUS_XML "${CMAKE_SOURCE_DIR}/desktop/protocols/polly-session-status-v1.xml")
        add_custom_command(
            OUTPUT "${UI_PROTOCOL_DIR}/polly-session-status-client.h" "${UI_PROTOCOL_DIR}/polly-session-status.c"
            COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_SESSION_STATUS_XML}" "${UI_PROTOCOL_DIR}/polly-session-status-client.h"
            COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_SESSION_STATUS_XML}" "${UI_PROTOCOL_DIR}/polly-session-status.c"
            DEPENDS "${UI_SESSION_STATUS_XML}" VERBATIM)
        if (PU_BUILD_LAUNCHER)
            target_sources(pollyui PRIVATE "${UI_PROTOCOL_DIR}/polly-session-status-client.h"
                "${UI_PROTOCOL_DIR}/polly-session-status.c")
        endif()
        set(UI_LAYER_XML "${WLR_UI_PROTOCOLS}/unstable/wlr-layer-shell-unstable-v1.xml")
        set(UI_XDG_XML "${WAYLAND_UI_PROTOCOLS}/stable/xdg-shell/xdg-shell.xml")
        add_custom_command(
            OUTPUT "${UI_PROTOCOL_DIR}/layer-shell-client.h" "${UI_PROTOCOL_DIR}/layer-shell.c"
                   "${UI_PROTOCOL_DIR}/xdg-shell.c"
            COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_LAYER_XML}" "${UI_PROTOCOL_DIR}/layer-shell-client.h"
            COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_LAYER_XML}" "${UI_PROTOCOL_DIR}/layer-shell.c"
            COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_XDG_XML}" "${UI_PROTOCOL_DIR}/xdg-shell.c"
            DEPENDS "${UI_LAYER_XML}" "${UI_XDG_XML}" VERBATIM)
        set(PU_HOST_PROTOCOLS "${UI_PROTOCOL_DIR}/layer-shell-client.h"
            "${UI_PROTOCOL_DIR}/layer-shell.c" "${UI_PROTOCOL_DIR}/xdg-shell.c")
        target_sources(pollyui-engine PRIVATE gui/src/host/sdl/layer_shell.c
            "${UI_PROTOCOL_DIR}/layer-shell-client.h" "${UI_PROTOCOL_DIR}/layer-shell.c"
            "${UI_PROTOCOL_DIR}/xdg-shell.c")
        target_include_directories(pollyui-engine PUBLIC "${UI_PROTOCOL_DIR}")
        target_compile_definitions(pollyui-engine PUBLIC PU_LAYER_SHELL)
        target_link_libraries(pollyui-engine PUBLIC PkgConfig::WAYLAND_UI)
        if (PU_BUILD_SESSION_AUTH)
            set(UI_LOCK_XML "${WAYLAND_UI_PROTOCOLS}/staging/ext-session-lock/ext-session-lock-v1.xml")
            add_custom_command(OUTPUT "${UI_PROTOCOL_DIR}/session-lock-client.h" "${UI_PROTOCOL_DIR}/session-lock.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_LOCK_XML}" "${UI_PROTOCOL_DIR}/session-lock-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_LOCK_XML}" "${UI_PROTOCOL_DIR}/session-lock.c"
                DEPENDS "${UI_LOCK_XML}" VERBATIM)
            list(APPEND PU_HOST_PROTOCOLS "${UI_PROTOCOL_DIR}/session-lock-client.h"
                "${UI_PROTOCOL_DIR}/session-lock.c")
            if (PU_BUILD_LAUNCHER)
                target_sources(pollyui PRIVATE desktop/native/lock-client.c)
                target_include_directories(pollyui PRIVATE "${CMAKE_SOURCE_DIR}/desktop/session")
                add_dependencies(pollyui polly-auth-check)
            endif()
            target_sources(pollyui-engine PRIVATE
                "${UI_PROTOCOL_DIR}/session-lock-client.h" "${UI_PROTOCOL_DIR}/session-lock.c")
            target_compile_definitions(pollyui-engine PUBLIC PU_SESSION_LOCK)
        endif()
        if (PU_BUILD_IME_ENGINE)
            pkg_check_modules(IME_KEYS REQUIRED IMPORTED_TARGET xkbcommon)
            set(UI_TEXT_INPUT_XML "${WAYLAND_UI_PROTOCOLS}/unstable/text-input/text-input-unstable-v3.xml")
            add_custom_command(OUTPUT "${UI_PROTOCOL_DIR}/text-input-v3-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_TEXT_INPUT_XML}" "${UI_PROTOCOL_DIR}/text-input-v3-client.h"
                DEPENDS "${UI_TEXT_INPUT_XML}" VERBATIM)
            if (PU_BUILD_LAUNCHER)
                target_sources(pollyui PRIVATE "${UI_PROTOCOL_DIR}/text-input-v3-client.h")
            endif()
            foreach(protocol IN ITEMS input-method-v2 virtual-keyboard-v1)
                if (protocol STREQUAL "input-method-v2")
                    set(xml "${CMAKE_SOURCE_DIR}/desktop/protocols/input-method-unstable-v2.xml")
                else()
                    set(xml "${CMAKE_SOURCE_DIR}/desktop/protocols/virtual-keyboard-unstable-v1.xml")
                endif()
                add_custom_command(OUTPUT "${UI_PROTOCOL_DIR}/${protocol}-client.h" "${UI_PROTOCOL_DIR}/${protocol}.c"
                    COMMAND "${UI_WAYLAND_SCANNER}" client-header "${xml}" "${UI_PROTOCOL_DIR}/${protocol}-client.h"
                    COMMAND "${UI_WAYLAND_SCANNER}" private-code "${xml}" "${UI_PROTOCOL_DIR}/${protocol}.c"
                    DEPENDS "${xml}" VERBATIM)
                list(APPEND PU_HOST_PROTOCOLS "${UI_PROTOCOL_DIR}/${protocol}-client.h"
                    "${UI_PROTOCOL_DIR}/${protocol}.c")
                target_sources(pollyui-engine PRIVATE "${UI_PROTOCOL_DIR}/${protocol}-client.h" "${UI_PROTOCOL_DIR}/${protocol}.c")
            endforeach()
            if (PU_BUILD_LAUNCHER)
                target_sources(pollyui PRIVATE desktop/native/input-method-client.c)
                target_link_libraries(pollyui PRIVATE polly-ime-engine PkgConfig::IME_KEYS)
            endif()
            target_compile_definitions(pollyui-engine PUBLIC PU_INPUT_METHOD)
        endif()
        if (PU_BUILD_LAUNCHER AND PU_DESKTOP_SERVICES)
            pkg_check_modules(PIPEWIRE REQUIRED IMPORTED_TARGET "libpipewire-0.3>=1.4")
            target_link_libraries(pollyui PRIVATE PkgConfig::PIPEWIRE)
            target_sources(pollyui PRIVATE desktop/native/notifications.c desktop/native/tray.c desktop/native/dbus-menu.c
                desktop/native/network.c desktop/native/audio.c desktop/native/power.c)
            if (BUILD_TESTING)
                add_executable(polly-power-test desktop/tests/power-service.c desktop/native/session-bus.c)
                target_include_directories(polly-power-test PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
                target_compile_definitions(polly-power-test PRIVATE _POSIX_C_SOURCE=200809L)
                target_compile_options(polly-power-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
                target_link_libraries(polly-power-test PRIVATE PkgConfig::SESSION_DBUS)
                add_executable(polly-audio-stream-test desktop/tests/audio-stream.c)
                target_link_libraries(polly-audio-stream-test PRIVATE PkgConfig::PIPEWIRE PkgConfig::SESSION_DBUS)
                target_compile_definitions(polly-audio-stream-test PRIVATE _POSIX_C_SOURCE=200809L)
                add_executable(polly-iwd-test desktop/tests/iwd-service.c desktop/native/session-bus.c)
                target_include_directories(polly-iwd-test PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
                target_compile_definitions(polly-iwd-test PRIVATE _POSIX_C_SOURCE=200809L)
                target_compile_options(polly-iwd-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
                target_link_libraries(polly-iwd-test PRIVATE PkgConfig::SESSION_DBUS)
                add_executable(polly-tray-test desktop/tests/tray.c desktop/native/session-bus.c)
                target_include_directories(polly-tray-test PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
                target_compile_definitions(polly-tray-test PRIVATE _POSIX_C_SOURCE=200809L)
                target_compile_options(polly-tray-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
                target_link_libraries(polly-tray-test PRIVATE PkgConfig::SESSION_DBUS)
                add_executable(polly-notification-test desktop/tests/notifications.c desktop/native/session-bus.c)
                target_include_directories(polly-notification-test PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
                target_compile_definitions(polly-notification-test PRIVATE _POSIX_C_SOURCE=200809L)
                target_compile_options(polly-notification-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
                target_link_libraries(polly-notification-test PRIVATE PkgConfig::SESSION_DBUS)
            endif()
            pkg_check_modules(SHORTCUT_KEYS REQUIRED IMPORTED_TARGET xkbcommon)
            target_link_libraries(pollyui PRIVATE PkgConfig::SHORTCUT_KEYS)
            set(UI_OUTPUT_XML "${WLR_UI_PROTOCOLS}/unstable/wlr-output-management-unstable-v1.xml")
            set(UI_OUTPUT_GUARD_XML "${CMAKE_SOURCE_DIR}/desktop/protocols/polly-output-guard-v1.xml")
            add_custom_command(
                OUTPUT "${UI_PROTOCOL_DIR}/output-management-client.h" "${UI_PROTOCOL_DIR}/output-management.c"
                    "${UI_PROTOCOL_DIR}/polly-output-guard-client.h" "${UI_PROTOCOL_DIR}/polly-output-guard.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_OUTPUT_XML}" "${UI_PROTOCOL_DIR}/output-management-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_OUTPUT_XML}" "${UI_PROTOCOL_DIR}/output-management.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_OUTPUT_GUARD_XML}" "${UI_PROTOCOL_DIR}/polly-output-guard-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_OUTPUT_GUARD_XML}" "${UI_PROTOCOL_DIR}/polly-output-guard.c"
                DEPENDS "${UI_OUTPUT_XML}" "${UI_OUTPUT_GUARD_XML}" VERBATIM)
            set(UI_SHORTCUTS_XML "${CMAKE_SOURCE_DIR}/desktop/protocols/polly-shortcuts-v1.xml")
            add_custom_command(
                OUTPUT "${UI_PROTOCOL_DIR}/polly-shortcuts-client.h" "${UI_PROTOCOL_DIR}/polly-shortcuts.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_SHORTCUTS_XML}" "${UI_PROTOCOL_DIR}/polly-shortcuts-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_SHORTCUTS_XML}" "${UI_PROTOCOL_DIR}/polly-shortcuts.c"
                DEPENDS "${UI_SHORTCUTS_XML}" VERBATIM)
            set(UI_APPEARANCE_XML "${CMAKE_SOURCE_DIR}/desktop/protocols/polly-appearance-v1.xml")
            set(UI_WORKSPACE_XML "${WAYLAND_UI_PROTOCOLS}/staging/ext-workspace/ext-workspace-v1.xml")
            set(UI_WORKSPACE_TOPLEVEL_XML "${CMAKE_SOURCE_DIR}/desktop/protocols/polly-workspace-toplevel-v1.xml")
            if (NOT EXISTS "${UI_WORKSPACE_XML}")
                message(FATAL_ERROR "wayland-protocols must provide staging/ext-workspace/ext-workspace-v1.xml")
            endif()
            add_custom_command(
                OUTPUT "${UI_PROTOCOL_DIR}/ext-workspace-client.h" "${UI_PROTOCOL_DIR}/ext-workspace.c"
                    "${UI_PROTOCOL_DIR}/polly-workspace-toplevel-client.h" "${UI_PROTOCOL_DIR}/polly-workspace-toplevel.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_WORKSPACE_XML}" "${UI_PROTOCOL_DIR}/ext-workspace-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_WORKSPACE_XML}" "${UI_PROTOCOL_DIR}/ext-workspace.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_WORKSPACE_TOPLEVEL_XML}" "${UI_PROTOCOL_DIR}/polly-workspace-toplevel-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_WORKSPACE_TOPLEVEL_XML}" "${UI_PROTOCOL_DIR}/polly-workspace-toplevel.c"
                DEPENDS "${UI_WORKSPACE_XML}" "${UI_WORKSPACE_TOPLEVEL_XML}" VERBATIM)
            add_custom_command(
                OUTPUT "${UI_PROTOCOL_DIR}/polly-appearance-client.h" "${UI_PROTOCOL_DIR}/polly-appearance.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_APPEARANCE_XML}" "${UI_PROTOCOL_DIR}/polly-appearance-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_APPEARANCE_XML}" "${UI_PROTOCOL_DIR}/polly-appearance.c"
                DEPENDS "${UI_APPEARANCE_XML}" VERBATIM)
            set(UI_FOREIGN_XML "${WLR_UI_PROTOCOLS}/unstable/wlr-foreign-toplevel-management-unstable-v1.xml")
            add_custom_command(
                OUTPUT "${UI_PROTOCOL_DIR}/foreign-toplevel-client.h" "${UI_PROTOCOL_DIR}/foreign-toplevel.c"
                COMMAND "${UI_WAYLAND_SCANNER}" client-header "${UI_FOREIGN_XML}" "${UI_PROTOCOL_DIR}/foreign-toplevel-client.h"
                COMMAND "${UI_WAYLAND_SCANNER}" private-code "${UI_FOREIGN_XML}" "${UI_PROTOCOL_DIR}/foreign-toplevel.c"
                DEPENDS "${UI_FOREIGN_XML}" VERBATIM)
            target_sources(pollyui PRIVATE desktop/native/windows.c
                desktop/native/output-client.c
                "${UI_PROTOCOL_DIR}/output-management-client.h" "${UI_PROTOCOL_DIR}/output-management.c"
                "${UI_PROTOCOL_DIR}/polly-output-guard-client.h" "${UI_PROTOCOL_DIR}/polly-output-guard.c"
                desktop/native/shortcut-client.c desktop/native/theme-files.c desktop/native/theme-client.c
                desktop/shared/shortcuts.c desktop/shared/appearance-document.c
                "${UI_PROTOCOL_DIR}/polly-shortcuts-client.h" "${UI_PROTOCOL_DIR}/polly-shortcuts.c"
                "${UI_PROTOCOL_DIR}/ext-workspace-client.h" "${UI_PROTOCOL_DIR}/ext-workspace.c"
                "${UI_PROTOCOL_DIR}/polly-workspace-toplevel-client.h" "${UI_PROTOCOL_DIR}/polly-workspace-toplevel.c"
                "${UI_PROTOCOL_DIR}/polly-appearance-client.h" "${UI_PROTOCOL_DIR}/polly-appearance.c"
                "${UI_PROTOCOL_DIR}/foreign-toplevel-client.h" "${UI_PROTOCOL_DIR}/foreign-toplevel.c")
            target_include_directories(pollyui PRIVATE "${CMAKE_SOURCE_DIR}/desktop/compositor")
            target_include_directories(pollyui PRIVATE "${CMAKE_SOURCE_DIR}/desktop/shared")
        endif()
        add_custom_target(pollyui-host-protocols DEPENDS ${PU_HOST_PROTOCOLS})
        add_dependencies(pollyui-engine pollyui-host-protocols)
    endif()
endif()

# macOS native title-bar helper (transparent titlebar + native traffic lights).
# Always built on Apple (the SDL host calls into it); Cocoa is linked below.
if (APPLE)
    target_sources(pollyui-engine PRIVATE gui/src/host/sdl/macos_titlebar.mm)
    set_source_files_properties(gui/src/host/sdl/macos_titlebar.mm
        PROPERTIES COMPILE_OPTIONS "-fno-objc-arc")
endif()

# Only composition-specific internal headers; public GUI/SysRT usage is inherited.
if (PU_BUILD_LAUNCHER)
    target_include_directories(pollyui PRIVATE gui/src desktop/launcher)
endif()

# ScriptEngine + LayoutEngine. yogacore PUBLIC-exports its include dir, so
# layout.c can `#include <yoga/Yoga.h>`.
if (PU_BUILD_LAUNCHER)
    target_link_libraries(pollyui PRIVATE qjs)
endif()

# skia.lib (Windows) is self-contained: it bundles its own zlib (Cr_z_-prefixed),
# libpng, freetype, harfbuzz, icu, etc. The macOS/Linux prebuilt instead ships
# libskia.a alongside separate component archives (libfreetype2.a, libharfbuzz.a,
# libicu.a, ...), so there we link ALL the .a files in SKIA_LIB_DIR, grouped so
# the static linker resolves cross-references regardless of order.
if (WIN32)
    target_link_libraries(pollyui-engine PUBLIC ${SKIA_LIB_DIR}/skia.lib)
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
        target_link_libraries(pollyui-engine PUBLIC ${SKIA_ARCHIVES})
        # System frameworks Skia depends on (codecs, fonts, GL backend) + the
        # system zlib: Skia's bundled zlib is Cr_z_-prefixed, but freetype/libpng
        # call the standard inflate/deflate, which /usr/lib/libz provides.
        target_link_libraries(pollyui-engine PUBLIC
            "-framework CoreFoundation" "-framework CoreGraphics" "-framework CoreText"
            "-framework CoreServices" "-framework ImageIO" "-framework Cocoa"
            "-framework OpenGL" z)
    else()
        # GNU ld needs an explicit group for mutually-referencing static libs.
        target_link_libraries(pollyui-engine PUBLIC
            -Wl,--start-group ${SKIA_ARCHIVES} PkgConfig::SKIA_SYSTEM -Wl,--end-group z)
    endif()
endif()

# Skia's bundled zlib exports Cr_z_-prefixed names, but its bundled libpng calls
# the unprefixed zlib entry points. They are the same functions, so alias the
# unprefixed references onto the Cr_z_ definitions at link time (lld /alternatename).
if (MSVC)
    target_link_options(pollyui-engine INTERFACE
        "/alternatename:inflate=Cr_z_inflate"
        "/alternatename:inflateInit2_=Cr_z_inflateInit2_"
        "/alternatename:inflateEnd=Cr_z_inflateEnd"
        "/alternatename:inflateReset=Cr_z_inflateReset")
endif()

if (WIN32)
    target_compile_definitions(pollyui-engine PUBLIC
        UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
    # System libs: Win32 (host) + Skia's Windows backends (DirectWrite/GDI/GL/COM).
    target_link_libraries(pollyui-engine PUBLIC
        user32 gdi32 opengl32 ole32 oleaut32 advapi32 dwrite shcore)
    if (PU_BUILD_LAUNCHER)
        target_link_libraries(pollyui PRIVATE dbghelp)
    endif()
endif()

# Release/GUI build: no console window (console.log mirrors to the debugger via
# OutputDebugString). Dev builds keep the console so `console.log` hits the
# terminal and `--test` output is capturable.
#   cmake --preset win-clang -DPU_WINDOWED=ON
option(PU_WINDOWED "Build a GUI app with no console window" OFF)
if (WIN32 AND PU_WINDOWED)
    target_compile_definitions(pollyui-engine PRIVATE PU_WINDOWED)
    if (PU_BUILD_LAUNCHER)
        target_compile_definitions(pollyui PRIVATE PU_WINDOWED)
        target_link_options(pollyui PRIVATE /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup)
    endif()
endif()

if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_BUILD_DESKTOP AND PU_BUILD_LAUNCHER AND BUILD_TESTING)
    add_test(NAME linux-complex-text COMMAND pollyui --test "${CMAKE_SOURCE_DIR}/gui/tests/complex-text.mjs")
    set_tests_properties(linux-complex-text PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    add_test(NAME linux-text-dependencies COMMAND node "${CMAKE_SOURCE_DIR}/gui/tests/text-dependencies.mjs" $<TARGET_FILE:pollyui>)
    set_tests_properties(linux-text-dependencies PROPERTIES TIMEOUT 10 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    add_test(NAME script-module-errors COMMAND node "${CMAKE_SOURCE_DIR}/gui/tests/script-errors.mjs" $<TARGET_FILE:pollyui>)
    set_tests_properties(script-module-errors PROPERTIES TIMEOUT 45 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    if (PU_DESKTOP_SERVICES)
        add_executable(polly-session-bus-test desktop/tests/session-bus.c desktop/native/session-bus.c)
        add_test(NAME desktop-files-source COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/apps/files/tests/files.mjs")
        add_test(NAME desktop-file-dialog-source COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/file-dialog.mjs")
        add_test(NAME desktop-file-text-open-source COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/file-text-open.mjs")
        add_test(NAME desktop-functional-launchers COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/functional-launchers.mjs")
        add_test(NAME desktop-greeter-controller COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/greeter-controller.mjs")
        set_tests_properties(desktop-files-source desktop-file-dialog-source desktop-file-text-open-source
            desktop-functional-launchers desktop-greeter-controller
            PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "source")
        add_test(NAME desktop-greeter-setup COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/greeter-setup.py")
        add_test(NAME desktop-greeter-image COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/greeter-image.py")
        set_tests_properties(desktop-greeter-setup desktop-greeter-image PROPERTIES TIMEOUT 30
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "root-container;fixture-coordinator;source")
        add_test(NAME desktop-greeter-ui COMMAND pollyui --test "${CMAKE_SOURCE_DIR}/desktop/tests/greeter-ui.mjs")
        set_tests_properties(desktop-greeter-ui PROPERTIES TIMEOUT 30
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "ordinary-native;synthetic-auth")
        add_executable(polly-greeter-client-fixture desktop/native/greeter-client.c desktop/tests/greeter-native-client.c)
        target_include_directories(polly-greeter-client-fixture PRIVATE desktop/native desktop/session)
        target_include_directories(polly-greeter-client-fixture SYSTEM PRIVATE third_party/quickjs)
        target_link_libraries(polly-greeter-client-fixture PRIVATE qjs Threads::Threads ${CMAKE_DL_LIBS} m)
        target_compile_options(polly-greeter-client-fixture PRIVATE -Wall -Wextra -Werror)
        target_include_directories(polly-session-bus-test PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
        target_compile_definitions(polly-session-bus-test PRIVATE _POSIX_C_SOURCE=200809L)
        target_link_libraries(polly-session-bus-test PRIVATE PkgConfig::SESSION_DBUS)
        target_compile_options(polly-session-bus-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
        add_test(NAME desktop-private-session-bus COMMAND node
            "${CMAKE_SOURCE_DIR}/desktop/tests/session-bus-fixture.mjs" $<TARGET_FILE:pollywm>
            $<TARGET_FILE:pollyui> $<TARGET_FILE:polly-session-bus-test>)
        set_tests_properties(desktop-private-session-bus PROPERTIES TIMEOUT 70 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        if (PU_LAYER_SHELL)
            add_test(NAME desktop-private-audio-session COMMAND node
                "${CMAKE_SOURCE_DIR}/desktop/tests/session-bus-fixture.mjs" $<TARGET_FILE:pollywm>
                $<TARGET_FILE:pollyui> $<TARGET_FILE:polly-session-bus-test> --audio)
            set_tests_properties(desktop-private-audio-session PROPERTIES TIMEOUT 80 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        endif()
        add_test(NAME desktop-decoration-tokens
            COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tools/generate-decoration-themes.mjs" --check)
        if (PU_LAYER_SHELL)
            add_test(NAME desktop-shortcut-persistence
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/shortcut-persistence.sh"
                    "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
                    $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
                    "${CMAKE_SOURCE_DIR}/desktop/tests/shortcut-persistence.mjs")
            set_tests_properties(desktop-shortcut-persistence PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
            add_test(NAME desktop-workspace-persistence
                COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/workspace-persistence.py"
                    "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
                    $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
                    "${CMAKE_SOURCE_DIR}/desktop/tests/workspace-persistence.mjs")
            set_tests_properties(desktop-workspace-persistence PROPERTIES TIMEOUT 110 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        endif()
        add_executable(pollyui-application-process-test desktop/tests/application-process.c)
        add_executable(polly-application-activation-service
            desktop/tests/application-activation-service.c desktop/native/session-bus.c)
        target_include_directories(polly-application-activation-service PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
        target_compile_definitions(polly-application-activation-service PRIVATE _POSIX_C_SOURCE=200809L)
        target_compile_options(polly-application-activation-service PRIVATE -Wall -Wextra -Wpedantic -Werror)
        target_link_libraries(polly-application-activation-service PRIVATE PkgConfig::SESSION_DBUS)
        add_test(NAME desktop-application-activation-unit
            COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/application-activation.mjs")
        set_tests_properties(desktop-application-activation-unit PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-application-activation-native
            COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/application-activation-fixture.mjs"
                $<TARGET_FILE:pollyui> $<TARGET_FILE:polly-application-activation-service>
                "${CMAKE_BINARY_DIR}/activation-evidence")
        set_tests_properties(desktop-application-activation-native PROPERTIES TIMEOUT 120 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_executable(polly-document-association-service
            desktop/tests/document-association-service.c desktop/native/session-bus.c)
        target_include_directories(polly-document-association-service PRIVATE "${CMAKE_SOURCE_DIR}" desktop)
        target_compile_definitions(polly-document-association-service PRIVATE _POSIX_C_SOURCE=200809L)
        target_compile_options(polly-document-association-service PRIVATE -Wall -Wextra -Wpedantic -Werror)
        target_link_libraries(polly-document-association-service PRIVATE PkgConfig::SESSION_DBUS)
        add_executable(polly-document-association-process desktop/tests/document-association-process.c)
        target_compile_definitions(polly-document-association-process PRIVATE _POSIX_C_SOURCE=200809L)
        target_compile_options(polly-document-association-process PRIVATE -Wall -Wextra -Wpedantic -Werror)
        add_test(NAME desktop-document-association-unit
            COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/document-association.mjs")
        set_tests_properties(desktop-document-association-unit PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-document-association-native
            COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/document-association-fixture.mjs"
                $<TARGET_FILE:pollyui> $<TARGET_FILE:polly-document-association-service>
                $<TARGET_FILE:polly-document-association-process> "${CMAKE_BINARY_DIR}/document-evidence")
        set_tests_properties(desktop-document-association-native PROPERTIES TIMEOUT 120 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-application-launch
            COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/application-fixture.mjs"
                $<TARGET_FILE:pollyui> $<TARGET_FILE:pollyui-application-process-test>)
        set_tests_properties(desktop-application-launch PROPERTIES TIMEOUT 35 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-bundle-data
            COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/bundle-data-fixture.mjs" $<TARGET_FILE:pollyui>)
        set_tests_properties(desktop-bundle-data PROPERTIES TIMEOUT 60 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-bundle-manager
            COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/bundle-manager.py"
                $<TARGET_FILE:polly-app> $<TARGET_FILE:pollyui>)
        set_tests_properties(desktop-bundle-manager PROPERTIES TIMEOUT 120 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-release-report COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/release-report.mjs")
        set_tests_properties(desktop-release-report PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-package-archive-validation COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/package-archive-validation.py")
        set_tests_properties(desktop-package-archive-validation PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-installed-image COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/installed-image.py")
        set_tests_properties(desktop-installed-image PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-installed-accounts COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/installed-accounts.py")
        set_tests_properties(desktop-installed-accounts PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-installed-roles COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/installed-roles.py")
        set_tests_properties(desktop-installed-roles PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-storage-layout COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-layout.py")
        set_tests_properties(desktop-storage-layout PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-storage-mappings COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-mappings.py")
        set_tests_properties(desktop-storage-mappings PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-storage-failures COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-failures.py")
        set_tests_properties(desktop-storage-failures PROPERTIES TIMEOUT 30
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "root-container")
        add_test(NAME desktop-storage-image COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-image.py")
        set_tests_properties(desktop-storage-image PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
            LABELS "root-container;fixture-coordinator;source")
        add_test(NAME desktop-storage-homes COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-homes.py")
        set_tests_properties(desktop-storage-homes PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-storage-home-migration COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-home-migration.py")
        set_tests_properties(desktop-storage-home-migration PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-storage-identities COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-identities.py")
        set_tests_properties(desktop-storage-identities PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-storage-account-migration COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/storage-account-migration.py")
        set_tests_properties(desktop-storage-account-migration PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-polly-plan COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/polly-plan.py")
        set_tests_properties(desktop-polly-plan PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-account-profiles COMMAND python3 -B "${CMAKE_SOURCE_DIR}/desktop/tests/account-profiles.py")
        set_tests_properties(desktop-account-profiles PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-system-payload COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/system-payload.py")
        set_tests_properties(desktop-system-payload PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-system-payload-signature COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/system-payload-signature.py")
        set_tests_properties(desktop-system-payload-signature PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-network-state COMMAND python3 -I -B
            "${CMAKE_SOURCE_DIR}/desktop/tests/network-state.py" "${CMAKE_SOURCE_DIR}")
        set_tests_properties(desktop-network-state PROPERTIES TIMEOUT 30
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "root-container")
        add_test(NAME desktop-storage-network-image COMMAND python3 -I -B
            "${CMAKE_SOURCE_DIR}/desktop/tests/storage-network-image.py" "${CMAKE_SOURCE_DIR}")
        set_tests_properties(desktop-storage-network-image PROPERTIES TIMEOUT 30
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "root-container")
        add_test(NAME desktop-install-targets COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/install-targets.py")
        set_tests_properties(desktop-install-targets PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-install-target-ui COMMAND node --test
            "${CMAKE_SOURCE_DIR}/desktop/apps/installer/tests/target.mjs"
            "${CMAKE_SOURCE_DIR}/desktop/apps/installer/tests/host.mjs"
            "${CMAKE_SOURCE_DIR}/desktop/apps/installer/tests/native-provider.mjs")
        set_tests_properties(desktop-install-target-ui PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-menu-host COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/menu-host.mjs")
        set_tests_properties(desktop-menu-host PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-xp-luna-unit COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/xp-luna-unit.mjs")
        set_tests_properties(desktop-xp-luna-unit PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-xp-startup COMMAND node --test "${CMAKE_SOURCE_DIR}/desktop/tests/xp-startup.mjs")
        set_tests_properties(desktop-xp-startup PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-debian-update-report COMMAND node "${CMAKE_SOURCE_DIR}/desktop/tests/debian-update-report.mjs")
        set_tests_properties(desktop-debian-update-report PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-retained-inputs COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/retained-inputs.py")
        set_tests_properties(desktop-retained-inputs PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME desktop-retained-sources COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/retained-sources.py")
        set_tests_properties(desktop-retained-sources PROPERTIES TIMEOUT 20 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        find_program(PU_DPKG_SOURCE_EXECUTABLE dpkg-source)
        if (PU_DPKG_SOURCE_EXECUTABLE)
            add_test(NAME desktop-restored-sources COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/restored-sources.py")
            set_tests_properties(desktop-restored-sources PROPERTIES TIMEOUT 60 SKIP_RETURN_CODE 77 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
            add_test(NAME desktop-local-debian-packages COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/local-debian-packages.py")
            set_tests_properties(desktop-local-debian-packages PROPERTIES TIMEOUT 30 SKIP_RETURN_CODE 77 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        endif()

        if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_BUILD_DESKTOP AND PU_DESKTOP_SERVICES AND BUILD_TESTING)
            add_library(polly-install-readonly-test-adapter OBJECT desktop/native/install-targets.c)
            target_include_directories(polly-install-readonly-test-adapter PRIVATE desktop/native)
            target_include_directories(polly-install-readonly-test-adapter SYSTEM PRIVATE third_party/quickjs)
            target_compile_definitions(polly-install-readonly-test-adapter PRIVATE
                PU_INSTALL_TARGETS_HELPER="/usr/lib/pollyui/install-targets/install/fixture-helper.py"
                clock_gettime=pu_install_fixture_clock_gettime read=pu_install_fixture_read
                waitpid=pu_install_fixture_waitpid)
            target_compile_options(polly-install-readonly-test-adapter PRIVATE -Wall -Wextra -Werror)
            add_executable(polly-install-readonly-transport-test desktop/tests/install-readonly-native.c
                $<TARGET_OBJECTS:polly-install-readonly-test-adapter>)
            target_include_directories(polly-install-readonly-transport-test PRIVATE desktop/native)
            target_include_directories(polly-install-readonly-transport-test SYSTEM PRIVATE third_party/quickjs)
            target_compile_options(polly-install-readonly-transport-test PRIVATE -Wall -Wextra -Werror)
            target_link_libraries(polly-install-readonly-transport-test PRIVATE qjs Threads::Threads ${CMAKE_DL_LIBS} m)
            add_test(NAME desktop-install-readonly-transport
                COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/install-readonly-registered.py"
                    $<TARGET_FILE:polly-install-readonly-transport-test>)
            set_tests_properties(desktop-install-readonly-transport PROPERTIES TIMEOUT 120
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "root-container;private-readonly-fixture")

            get_target_property(PU_READONLY_FIXTURE_SOURCES pollyui SOURCES)
            add_executable(pollyui-readonly-fixture ${PU_READONLY_FIXTURE_SOURCES})
            target_include_directories(pollyui-readonly-fixture PRIVATE $<TARGET_PROPERTY:pollyui,INCLUDE_DIRECTORIES>)
            target_compile_definitions(pollyui-readonly-fixture PRIVATE
                $<TARGET_PROPERTY:pollyui,COMPILE_DEFINITIONS>
                PU_INSTALL_TARGETS_HELPER="/usr/lib/pollyui/install-targets/install/fixture-helper.py")
            target_compile_options(pollyui-readonly-fixture PRIVATE $<TARGET_PROPERTY:pollyui,COMPILE_OPTIONS>)
            target_link_options(pollyui-readonly-fixture PRIVATE $<TARGET_PROPERTY:pollyui,LINK_OPTIONS>)
            target_link_libraries(pollyui-readonly-fixture PRIVATE $<TARGET_PROPERTY:pollyui,LINK_LIBRARIES>)
            add_dependencies(pollyui-readonly-fixture pollyui-app-launcher polly-app)
            add_test(NAME desktop-install-readonly-window
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/install-readonly-window.sh"
                    $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
                    $<TARGET_FILE:pollyui-readonly-fixture> "${CMAKE_BINARY_DIR}/readonly-window-evidence")
            set_tests_properties(desktop-install-readonly-window PROPERTIES TIMEOUT 120
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "ordinary-native;private-readonly-fixture")
        endif()
        add_test(NAME desktop-launcher-shell
            COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/launcher-shell.sh"
                "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
                $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
                "${CMAKE_SOURCE_DIR}/desktop/tests/launcher-shell.mjs")
        set_tests_properties(desktop-launcher-shell PROPERTIES TIMEOUT 30 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    endif()
    add_test(NAME desktop-session
        COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/session.sh"
            "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
            $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
            "${CMAKE_SOURCE_DIR}/desktop/tests/session-client.mjs")
    set_tests_properties(desktop-session PROPERTIES TIMEOUT 25 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    if (PU_BUILD_IME_ENGINE AND EXISTS "/usr/share/rime-data/default.yaml")
        add_test(NAME desktop-ime-session
            COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/session.sh"
                "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
                $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
                "${CMAKE_SOURCE_DIR}/desktop/tests/session-client.mjs" --ime)
        set_tests_properties(desktop-ime-session PROPERTIES TIMEOUT 40 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    endif()
    function(pu_host_fixture target source)
        add_executable(${target} ${source} gui/src/host/sdl/window_sdl.c gui/src/render/skia_c.cpp)
        target_include_directories(${target} PRIVATE gui/src gui/include "${CMAKE_SOURCE_DIR}" "${SKIA_ROOT}")
        target_compile_definitions(${target} PRIVATE _POSIX_C_SOURCE=200809L SK_R32_SHIFT=16 SK_RELEASE)
        target_compile_definitions(${target} PRIVATE PU_COMPLEX_TEXT)
        target_link_libraries(${target} PRIVATE SDL3::SDL3 PkgConfig::SKIA_SYSTEM
            -Wl,--start-group ${SKIA_ARCHIVES} -Wl,--end-group Threads::Threads)
    endfunction()
    pu_host_fixture(pollyui-input-test gui/tests/sdl-input.c)
    pu_host_fixture(pollyui-multi-test gui/tests/multi-window-native.c)
    add_test(NAME sdl-input-adapter COMMAND pollyui-input-test)
    add_test(NAME sdl-multi-window COMMAND pollyui-multi-test)
    add_executable(pollyui-gl-lifecycle-test gui/tests/sdl-gl-lifecycle.c)
    target_link_libraries(pollyui-gl-lifecycle-test PRIVATE SDL3::SDL3)
    target_compile_options(pollyui-gl-lifecycle-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
    add_test(NAME sdl-gl-lifecycle COMMAND pollyui-gl-lifecycle-test)
    set_tests_properties(sdl-gl-lifecycle PROPERTIES TIMEOUT 60 ENVIRONMENT "SDL_VIDEODRIVER=offscreen")
    set_tests_properties(sdl-input-adapter sdl-multi-window PROPERTIES TIMEOUT 15
        ENVIRONMENT "SDL_VIDEODRIVER=dummy;SDL_RENDER_DRIVER=software;PU_RENDERER=raster")
    if (PU_LAYER_SHELL)
        add_executable(pollyui-layer-client-test desktop/tests/runtime-client.c)
        pkg_check_modules(PIXMAN_UI_TEST REQUIRED IMPORTED_TARGET pixman-1)
        target_link_libraries(pollyui-layer-client-test PRIVATE pollywm-core PkgConfig::PIXMAN_UI_TEST)
        target_compile_options(pollyui-layer-client-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
        if (PU_DESKTOP_SERVICES)
            add_test(NAME desktop-files-window
                COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/files-window.py"
                    $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                    --evidence "${CMAKE_BINARY_DIR}/files-window-evidence")
            set_tests_properties(desktop-files-window PROPERTIES TIMEOUT 180
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "ordinary-native;private-files-fixture")
            add_test(NAME desktop-file-dialog-window
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                    $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                    "${CMAKE_SOURCE_DIR}/desktop/tests/file-dialog-window-shell.mjs" file-dialog file-dialog)
            set_tests_properties(desktop-file-dialog-window PROPERTIES TIMEOUT 120
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "ordinary-native;private-files-fixture")
            foreach(mode IN ITEMS ui audio)
                add_test(NAME desktop-settings-${mode}
                    COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/settings-native.py"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        --mode ${mode} --evidence "${CMAKE_BINARY_DIR}/settings-${mode}-evidence")
                set_tests_properties(desktop-settings-${mode} PROPERTIES TIMEOUT 120
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "ordinary-native")
            endforeach()
            add_test(NAME desktop-settings-network
                COMMAND python3 -I -B "${CMAKE_SOURCE_DIR}/desktop/tests/settings-native.py"
                    $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                    --mode network --evidence "${CMAKE_BINARY_DIR}/settings-network-evidence")
            set_tests_properties(desktop-settings-network PROPERTIES TIMEOUT 120
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" LABELS "root-container;fixture-coordinator;synthetic-network")
        endif()
        foreach(renderer IN ITEMS raster gl)
            if (PU_DESKTOP_SERVICES)
                add_test(NAME desktop-power-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh" --iwd
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/power-shell.mjs" power)
                set_tests_properties(desktop-power-shell-${renderer} PROPERTIES TIMEOUT 90
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-bundle-shell-${renderer}
                    COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/bundle-manager.py"
                        $<TARGET_FILE:polly-app> $<TARGET_FILE:pollyui> --graphical)
                set_tests_properties(desktop-bundle-shell-${renderer} PROPERTIES TIMEOUT 120
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-theme-files-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/theme-files-shell.mjs" themes)
                set_tests_properties(desktop-theme-files-${renderer} PROPERTIES TIMEOUT 100
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-audio-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh" --audio
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/audio-shell.mjs" audio)
                set_tests_properties(desktop-audio-shell-${renderer} PROPERTIES TIMEOUT 110
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-audio-persistence-${renderer}
                    COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/audio-persistence.py"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/audio-persistence.mjs")
                set_tests_properties(desktop-audio-persistence-${renderer} PROPERTIES TIMEOUT 180
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-network-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh" --iwd
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/network-shell.mjs" network)
                set_tests_properties(desktop-network-shell-${renderer} PROPERTIES TIMEOUT 100
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-tray-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh" --bus
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/tray-shell.mjs" tray)
                set_tests_properties(desktop-tray-shell-${renderer} PROPERTIES TIMEOUT 90
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-notification-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh" --bus
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/notification-shell.mjs" notifications)
                set_tests_properties(desktop-notification-shell-${renderer} PROPERTIES TIMEOUT 90
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
            endif()
            if (PU_BUILD_IME_ENGINE AND PU_DESKTOP_SERVICES)
                add_test(NAME desktop-ime-shell-${renderer} COMMAND node
                    "${CMAKE_SOURCE_DIR}/desktop/tests/ime-engine-fixture.mjs"
                    $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>)
                set_tests_properties(desktop-ime-shell-${renderer} PROPERTIES TIMEOUT 100
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
            endif()
            if (PU_DESKTOP_SERVICES)
                add_test(NAME desktop-data-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/data-shell.mjs" data)
                set_tests_properties(desktop-data-shell-${renderer} PROPERTIES TIMEOUT 120
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-output-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/output-shell.mjs" outputs)
                set_tests_properties(desktop-output-shell-${renderer} PROPERTIES TIMEOUT 100
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-display-persistence-${renderer}
                    COMMAND python3 "${CMAKE_SOURCE_DIR}/desktop/tests/display-persistence.py"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/display-persistence.mjs")
                set_tests_properties(desktop-display-persistence-${renderer} PROPERTIES TIMEOUT 180
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-switcher-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/switcher-shell.mjs" switcher)
                set_tests_properties(desktop-switcher-shell-${renderer} PROPERTIES TIMEOUT 120
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-workspace-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/workspace-shell.mjs" workspaces)
                set_tests_properties(desktop-workspace-shell-${renderer} PROPERTIES TIMEOUT 100
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
                add_test(NAME desktop-window-shell-${renderer}
                    COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/runtime-client.sh"
                        $<TARGET_FILE:pollyui-layer-client-test> $<TARGET_FILE:pollyui>
                        "${CMAKE_SOURCE_DIR}/desktop/tests/window-shell.mjs" windows)
                set_tests_properties(desktop-window-shell-${renderer} PROPERTIES TIMEOUT 90
                    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
            endif()
            add_test(NAME desktop-shell-${renderer}
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/native-shell.sh"
                    "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
                    $<TARGET_FILE:pollywm> $<TARGET_FILE:pollyui>
                    "${CMAKE_SOURCE_DIR}/desktop/tests/native-shell-client.mjs")
            set_tests_properties(desktop-shell-${renderer} PROPERTIES TIMEOUT 60
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
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

if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_BUILD_DESKTOP AND PU_BUILD_LAUNCHER AND PU_DESKTOP_SERVICES AND PU_LAYER_SHELL)
    include(desktop/install.cmake)
    if (BUILD_TESTING AND PU_BUILD_SESSION_AUTH)
        foreach(renderer IN ITEMS raster gl)
            add_test(NAME desktop-native-lock-${renderer}
                COMMAND sh "${CMAKE_SOURCE_DIR}/desktop/tests/session-lock.sh"
                    $<TARGET_FILE:polly-lock-test> $<TARGET_FILE:polly-lock-test-client>
                    $<TARGET_FILE:pollyui> "${CMAKE_SOURCE_DIR}/desktop/session/lock.mjs")
            set_tests_properties(desktop-native-lock-${renderer} PROPERTIES TIMEOUT 45
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_RENDERER=${renderer}")
        endforeach()
    endif()
endif()
