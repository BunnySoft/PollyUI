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
pkg_check_modules(DECORATION_FONTS REQUIRED IMPORTED_TARGET fontconfig freetype2)
pkg_check_modules(WAYLAND_PROTOCOLS REQUIRED wayland-protocols)
pkg_get_variable(WAYLAND_PROTOCOLS_DIR wayland-protocols pkgdatadir)
pkg_check_modules(WLR_PROTOCOLS REQUIRED wlr-protocols)
pkg_get_variable(WLR_PROTOCOLS_DIR wlr-protocols pkgdatadir)
find_program(WAYLAND_SCANNER wayland-scanner REQUIRED)

set(XDG_SHELL_XML "${WAYLAND_PROTOCOLS_DIR}/stable/xdg-shell/xdg-shell.xml")
set(LAYER_SHELL_XML "${WLR_PROTOCOLS_DIR}/unstable/wlr-layer-shell-unstable-v1.xml")
set(PROTOCOL_DIR "${CMAKE_CURRENT_BINARY_DIR}/protocols")
file(MAKE_DIRECTORY "${PROTOCOL_DIR}")
set(WORKSPACE_XML "${WAYLAND_PROTOCOLS_DIR}/staging/ext-workspace/ext-workspace-v1.xml")
set(WORKSPACE_TOPLEVEL_XML "${CMAKE_CURRENT_SOURCE_DIR}/protocols/polly-workspace-toplevel-v1.xml")
if (NOT EXISTS "${WORKSPACE_XML}")
    message(FATAL_ERROR "wayland-protocols must provide staging/ext-workspace/ext-workspace-v1.xml")
endif()
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/ext-workspace-server.h" "${PROTOCOL_DIR}/ext-workspace.c"
        "${PROTOCOL_DIR}/polly-workspace-toplevel-server.h" "${PROTOCOL_DIR}/polly-workspace-toplevel.c"
        "${PROTOCOL_DIR}/workspace-foreign.c"
    COMMAND "${WAYLAND_SCANNER}" server-header "${WORKSPACE_XML}" "${PROTOCOL_DIR}/ext-workspace-server.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${WORKSPACE_XML}" "${PROTOCOL_DIR}/ext-workspace.c"
    COMMAND "${WAYLAND_SCANNER}" server-header "${WORKSPACE_TOPLEVEL_XML}" "${PROTOCOL_DIR}/polly-workspace-toplevel-server.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${WORKSPACE_TOPLEVEL_XML}" "${PROTOCOL_DIR}/polly-workspace-toplevel.c"
    COMMAND "${WAYLAND_SCANNER}" private-code "${WLR_PROTOCOLS_DIR}/unstable/wlr-foreign-toplevel-management-unstable-v1.xml" "${PROTOCOL_DIR}/workspace-foreign.c"
    DEPENDS "${WORKSPACE_XML}" "${WORKSPACE_TOPLEVEL_XML}"
        "${WLR_PROTOCOLS_DIR}/unstable/wlr-foreign-toplevel-management-unstable-v1.xml" VERBATIM)
set(APPEARANCE_XML "${CMAKE_CURRENT_SOURCE_DIR}/protocols/polly-appearance-v1.xml")
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/polly-appearance-server.h" "${PROTOCOL_DIR}/polly-appearance.c"
    COMMAND "${WAYLAND_SCANNER}" server-header "${APPEARANCE_XML}" "${PROTOCOL_DIR}/polly-appearance-server.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${APPEARANCE_XML}" "${PROTOCOL_DIR}/polly-appearance.c"
    DEPENDS "${APPEARANCE_XML}" VERBATIM)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/xdg-shell-protocol.h"
    COMMAND "${WAYLAND_SCANNER}" server-header "${XDG_SHELL_XML}"
            "${PROTOCOL_DIR}/xdg-shell-protocol.h"
    DEPENDS "${XDG_SHELL_XML}" VERBATIM)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/wlr-layer-shell-unstable-v1-protocol.h"
    COMMAND "${WAYLAND_SCANNER}" server-header "${LAYER_SHELL_XML}"
            "${PROTOCOL_DIR}/wlr-layer-shell-unstable-v1-protocol.h"
    DEPENDS "${LAYER_SHELL_XML}" VERBATIM)

add_library(pollywm-core STATIC
    compositor/server.c
    compositor/decoration.c
    compositor/workspace.c
    compositor/shell_process.c
    "${PROTOCOL_DIR}/polly-appearance-server.h" "${PROTOCOL_DIR}/polly-appearance.c"
    "${PROTOCOL_DIR}/ext-workspace-server.h" "${PROTOCOL_DIR}/ext-workspace.c"
    "${PROTOCOL_DIR}/polly-workspace-toplevel-server.h" "${PROTOCOL_DIR}/polly-workspace-toplevel.c"
    "${PROTOCOL_DIR}/workspace-foreign.c"
    "${PROTOCOL_DIR}/wlr-layer-shell-unstable-v1-protocol.h"
    "${PROTOCOL_DIR}/xdg-shell-protocol.h")
target_include_directories(pollywm-core PUBLIC compositor "${PROTOCOL_DIR}")
target_compile_definitions(pollywm-core PUBLIC WLR_USE_UNSTABLE _POSIX_C_SOURCE=200809L)
target_compile_options(pollywm-core PRIVATE -Wall -Wextra -Wpedantic -Werror)
target_link_libraries(pollywm-core PUBLIC
    PkgConfig::WLROOTS PkgConfig::WAYLAND_SERVER PkgConfig::XKBCOMMON PkgConfig::DECORATION_FONTS m)
set_target_properties(pollywm-core PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)

add_executable(pollywm compositor/main.c)
target_link_libraries(pollywm PRIVATE pollywm-core)
target_compile_options(pollywm PRIVATE -Wall -Wextra -Wpedantic -Werror)
set_target_properties(pollywm PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
install(TARGETS pollywm RUNTIME DESTINATION bin)

if (BUILD_TESTING)
    add_subdirectory(tests)
endif()
