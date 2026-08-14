cmake_minimum_required(VERSION 3.25)

# C for the engine; CXX only for the Skia shim, skia_c.cpp (DESIGN.md §3).
project(PollyUI LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CMAKE_CXX_STANDARD 17)            # Skia requires C++17
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Vendored Yoga uses std::bit_cast internally and therefore needs a C++20
# standard library even though PollyUI's own Skia shim remains C++17.
include(CheckCXXSourceCompiles)
set(PU_SAVED_CXX_STANDARD "${CMAKE_CXX_STANDARD}")
set(CMAKE_CXX_STANDARD 20)
check_cxx_source_compiles(
    "#include <bit>
     #include <cstdint>
     int main() { return (int)std::bit_cast<std::uint32_t>(1.0f); }"
    PU_HAVE_CXX20_BIT_CAST)
set(CMAKE_CXX_STANDARD "${PU_SAVED_CXX_STANDARD}")
if (NOT PU_HAVE_CXX20_BIT_CAST)
    message(FATAL_ERROR
        "PollyUI's vendored Yoga requires a C++20 standard library with "
        "std::bit_cast (use GCC 11+ or a recent Clang/MSVC).")
endif()

# Match the prebuilt Skia (Release, STATIC CRT /MT) so the CRT / iterator-debug
# levels agree across the link. (MSVC/Windows only.)
if (MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

if (MSVC)
    # The pinned Windows Skia archive was built against the VS 2022 STL and
    # references helper symbols that older MSVC runtimes do not export.
    set(PU_SAVED_REQUIRED_LIBRARIES "${CMAKE_REQUIRED_LIBRARIES}")
    list(APPEND CMAKE_REQUIRED_LIBRARIES libcpmt)
    check_cxx_source_compiles(
        "extern \"C\" float __std_max_f(float, float);
         int main(int argc, char **) {
             volatile float input = static_cast<float>(argc);
             auto helper = &__std_max_f;
             return helper(input, 2.0f) == 2.0f ? 0 : 1;
         }"
        PU_HAVE_SKIA_MSVC_RUNTIME)
    set(CMAKE_REQUIRED_LIBRARIES "${PU_SAVED_REQUIRED_LIBRARIES}")
    unset(PU_SAVED_REQUIRED_LIBRARIES)
    if (NOT PU_HAVE_SKIA_MSVC_RUNTIME)
        message(FATAL_ERROR
            "The pinned Windows Skia archive requires the Visual Studio 2022 "
            "or newer C++ runtime. Install the current VS Build Tools C++ "
            "workload and reconfigure from its x64 developer environment.")
    endif()
endif()

# --- Host backend selection (DESIGN.md §2; docs/PORTING.md) ------------------
#   win32 -> raw Win32 host (zero deps)   sdl -> SDL3 (macOS/Linux/Windows)
if (WIN32)
    set(PU_HOST_DEFAULT "win32")
else()
    set(PU_HOST_DEFAULT "sdl")
endif()
set(PU_HOST "${PU_HOST_DEFAULT}" CACHE STRING "Host backend: win32 | sdl")
set_property(CACHE PU_HOST PROPERTY STRINGS win32 sdl)

set(PU_LINUX_GL "AUTO" CACHE STRING
    "Linux SDL Ganesh GL renderer: AUTO, ON (required), or OFF")
set_property(CACHE PU_LINUX_GL PROPERTY STRINGS AUTO ON OFF)
if (NOT PU_LINUX_GL MATCHES "^(AUTO|ON|OFF)$")
    message(FATAL_ERROR "PU_LINUX_GL must be AUTO, ON, or OFF")
endif()

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
    src/host/startup.c
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

# POSIX threads for the concurrency layer (core/thread.c) on macOS/Linux.
if (NOT WIN32)
    find_package(Threads REQUIRED)
    target_link_libraries(pollyui PRIVATE Threads::Threads)
endif()
if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Expose clock_gettime/nanosleep when compiling the C sources in strict C11 mode.
    target_compile_definitions(pollyui PRIVATE _POSIX_C_SOURCE=200809L)
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
        message(FATAL_ERROR "No Skia archives (*.a) in ${SKIA_LIB_DIR}. "
                            "Run tools/fetch_skia.sh or set -DSKIA_LIB_DIR=...")
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

        find_package(Fontconfig REQUIRED)
        target_compile_definitions(pollyui PRIVATE PU_FONTCONFIG_BACKEND)
        target_link_libraries(pollyui PRIVATE Fontconfig::Fontconfig)

        if (NOT EXISTS "${SKIA_LIB_DIR}/libskia.a")
            message(FATAL_ERROR "Expected ${SKIA_LIB_DIR}/libskia.a for Linux")
        endif()
        if (NOT CMAKE_NM)
            message(FATAL_ERROR
                "An nm-compatible symbol inspector is required to verify the "
                "Linux Skia FontConfig and Ganesh features")
        else()
            execute_process(
                COMMAND "${CMAKE_NM}" -C --defined-only
                        "${SKIA_LIB_DIR}/libskia.a"
                RESULT_VARIABLE PU_SKIA_NM_RESULT
                OUTPUT_VARIABLE PU_SKIA_SYMBOLS
                ERROR_VARIABLE PU_SKIA_NM_ERROR)
            if (NOT PU_SKIA_NM_RESULT EQUAL 0)
                message(FATAL_ERROR
                    "Could not inspect ${SKIA_LIB_DIR}/libskia.a for required "
                    "Linux Skia features: ${PU_SKIA_NM_ERROR}")
            else()
                string(FIND "${PU_SKIA_SYMBOLS}" "SkFontMgr_New_FontConfig"
                       PU_FONTCONFIG_SYMBOL)
                if (PU_FONTCONFIG_SYMBOL EQUAL -1)
                    message(FATAL_ERROR
                        "The Linux Skia archive lacks SkFontMgr_New_FontConfig. "
                        "Use the pinned Linux Skia archives from tools/fetch_skia.sh "
                        "or a Skia build with fontconfig enabled.")
                endif()
                string(FIND "${PU_SKIA_SYMBOLS}"
                       "GrGLMakeAssembledGLESInterface"
                       PU_GANESH_GL_SYMBOL)
                if (PU_GANESH_GL_SYMBOL EQUAL -1)
                    set(PU_LINUX_GL_AVAILABLE OFF)
                    set(PU_LINUX_GL_REASON
                        "the selected Skia archives lack Ganesh OpenGL ES")
                else()
                    find_package(OpenGL QUIET COMPONENTS OpenGL GLX)
                    if (TARGET OpenGL::GLX)
                        set(PU_LINUX_GL_AVAILABLE ON)
                    else()
                        set(PU_LINUX_GL_AVAILABLE OFF)
                        set(PU_LINUX_GL_REASON
                            "the OpenGL/GLX development libraries are unavailable")
                    endif()
                endif()
            endif()
        endif()

        if (PU_LINUX_GL STREQUAL "ON" AND NOT PU_LINUX_GL_AVAILABLE)
            message(FATAL_ERROR
                "PU_LINUX_GL=ON was requested, but ${PU_LINUX_GL_REASON}.")
        elseif (NOT PU_LINUX_GL STREQUAL "OFF" AND PU_LINUX_GL_AVAILABLE)
            target_compile_definitions(pollyui PRIVATE PU_SKIA_GL_BACKEND)
            target_link_libraries(pollyui PRIVATE OpenGL::GLX)
            message(STATUS
                "Linux renderer support: Skia Ganesh OpenGL ES + raster fallback")
        elseif (PU_LINUX_GL STREQUAL "OFF")
            message(STATUS
                "Linux renderer support: raster only (PU_LINUX_GL=OFF; "
                "--renderer=gl will fail explicitly)")
        else()
            message(STATUS
                "Linux renderer support: raster only (${PU_LINUX_GL_REASON}; "
                "--renderer=gl will fail explicitly)")
        endif()
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

include(CTest)
if (BUILD_TESTING)
    add_executable(pu_startup_options_tests
        tests/startup_options_test.c
        src/host/startup.c)
    target_include_directories(pu_startup_options_tests PRIVATE src)
    add_test(NAME startup-options COMMAND pu_startup_options_tests)
endif()
