cmake_minimum_required(VERSION 3.25)

# C now; CXX is added later when the Skia shim (skia_c.cpp) lands (see DESIGN.md §3).
project(PollyUI LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_executable(pollyui
    src/main.c
    src/host/win32/window.c
)

# `src` is the include root, so headers are included as "host/win32/window.h" etc.
target_include_directories(pollyui PRIVATE src)

if (WIN32)
    target_compile_definitions(pollyui PRIVATE
        UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(pollyui PRIVATE user32 gdi32)
endif()
