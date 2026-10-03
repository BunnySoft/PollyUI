cmake_minimum_required(VERSION 3.25)

if (CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(PollyDesktop LANGUAGES C)
    include(CTest)
endif()

if (NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "PollyDesktop requires Linux. Use WSL on Windows.")
endif()

find_package(PkgConfig REQUIRED)
# 0.19.3 fixes the SHM buffer destructor used by the Pixman/nested path.
pkg_check_modules(WLROOTS REQUIRED IMPORTED_TARGET "wlroots-0.19>=0.19.3" "wlroots-0.19<0.20")
pkg_check_modules(WAYLAND_SERVER REQUIRED IMPORTED_TARGET wayland-server)
pkg_check_modules(XKBCOMMON REQUIRED IMPORTED_TARGET xkbcommon)
pkg_check_modules(WAYLAND_PROTOCOLS REQUIRED wayland-protocols)
pkg_get_variable(WAYLAND_PROTOCOLS_DIR wayland-protocols pkgdatadir)
find_program(WAYLAND_SCANNER wayland-scanner REQUIRED)

set(XDG_SHELL_XML "${WAYLAND_PROTOCOLS_DIR}/stable/xdg-shell/xdg-shell.xml")
set(PROTOCOL_DIR "${CMAKE_CURRENT_BINARY_DIR}/protocols")
file(MAKE_DIRECTORY "${PROTOCOL_DIR}")
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/xdg-shell-protocol.h"
    COMMAND "${WAYLAND_SCANNER}" server-header "${XDG_SHELL_XML}"
            "${PROTOCOL_DIR}/xdg-shell-protocol.h"
    DEPENDS "${XDG_SHELL_XML}" VERBATIM)

add_library(pollywm-core STATIC
    compositor/server.c
    "${PROTOCOL_DIR}/xdg-shell-protocol.h")
target_include_directories(pollywm-core PUBLIC compositor "${PROTOCOL_DIR}")
target_compile_definitions(pollywm-core PUBLIC WLR_USE_UNSTABLE _POSIX_C_SOURCE=200809L)
target_compile_options(pollywm-core PRIVATE -Wall -Wextra -Wpedantic -Werror)
target_link_libraries(pollywm-core PUBLIC
    PkgConfig::WLROOTS PkgConfig::WAYLAND_SERVER PkgConfig::XKBCOMMON)
set_target_properties(pollywm-core PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)

add_executable(pollywm compositor/main.c)
target_link_libraries(pollywm PRIVATE pollywm-core)
target_compile_options(pollywm PRIVATE -Wall -Wextra -Wpedantic -Werror)
set_target_properties(pollywm PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
install(TARGETS pollywm RUNTIME DESTINATION bin)

if (BUILD_TESTING)
    add_subdirectory(tests)
endif()
