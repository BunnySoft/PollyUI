cmake_minimum_required(VERSION 3.25)

# C for the engine; CXX only for the Skia shim, skia_c.cpp (DESIGN.md §3).
project(PollyUI LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CMAKE_CXX_STANDARD 17)            # Skia requires C++17
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Match the prebuilt Skia (Release, STATIC CRT /MT) so the CRT / iterator-debug
# levels agree across the link.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# --- Skia (aseprite/skia m124 prebuilt) --------------------------------------
set(SKIA_ROOT    ${CMAKE_SOURCE_DIR}/third_party/skia)
set(SKIA_LIB_DIR ${SKIA_ROOT}/out/Release-x64)

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
    src/host/win32/window.c
    src/render/skia_c.cpp
    src/render/render.c
    src/script/script.c
    src/model/node.c
    src/bridge/bridge.c
    src/layout/layout.c
)

# `src` for our headers (included as "host/...", "render/..."); SKIA_ROOT for
# Skia's root-relative includes (e.g. "include/core/SkSurface.h"); quickjs for
# "quickjs.h".
target_include_directories(pollyui PRIVATE src ${SKIA_ROOT} ${CMAKE_SOURCE_DIR}/third_party/quickjs)

# ScriptEngine + LayoutEngine. yogacore PUBLIC-exports its include dir, so
# layout.c can `#include <yoga/Yoga.h>`.
target_link_libraries(pollyui PRIVATE qjs yogacore)

# skia.lib is self-contained: it bundles its own zlib (Cr_z_-prefixed), libpng,
# freetype, harfbuzz, icu, etc. The sibling component libs are redundant alternate
# builds that reference an UNprefixed zlib and only cause link conflicts, so we
# link skia.lib alone. Add specific siblings only if a real symbol is missing.
set(SKIA_LIBS skia)
foreach(lib ${SKIA_LIBS})
    target_link_libraries(pollyui PRIVATE ${SKIA_LIB_DIR}/${lib}.lib)
endforeach()

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
        UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
    # System libs: Win32 (host) + Skia's Windows backends (DirectWrite/GDI/GL/COM).
    target_link_libraries(pollyui PRIVATE
        user32 gdi32 opengl32 ole32 oleaut32 advapi32 dwrite)
endif()
