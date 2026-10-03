pkg_check_modules(WAYLAND_CLIENT REQUIRED IMPORTED_TARGET wayland-client)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/xdg-shell-client-protocol.h" "${PROTOCOL_DIR}/xdg-shell-protocol.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${XDG_SHELL_XML}"
            "${PROTOCOL_DIR}/xdg-shell-client-protocol.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${XDG_SHELL_XML}"
            "${PROTOCOL_DIR}/xdg-shell-protocol.c"
    DEPENDS "${XDG_SHELL_XML}" VERBATIM)
add_executable(pollywm-test-client client.c
    "${PROTOCOL_DIR}/xdg-shell-client-protocol.h" "${PROTOCOL_DIR}/xdg-shell-protocol.c")
target_include_directories(pollywm-test-client PRIVATE "${PROTOCOL_DIR}")
target_compile_definitions(pollywm-test-client PRIVATE _POSIX_C_SOURCE=200809L)
target_link_libraries(pollywm-test-client PRIVATE PkgConfig::WAYLAND_CLIENT)

add_executable(pollywm-integration integration.c)
target_link_libraries(pollywm-integration PRIVATE pollywm-core)
add_executable(pollywm-shell-policy shell-policy.c)
target_link_libraries(pollywm-shell-policy PRIVATE pollywm-core PkgConfig::WAYLAND_CLIENT)
foreach(target pollywm-test-client pollywm-integration pollywm-shell-policy)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    set_target_properties(${target} PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
endforeach()

add_test(NAME desktop-integration
    COMMAND pollywm-integration $<TARGET_FILE:pollywm-test-client>)
set_tests_properties(desktop-integration PROPERTIES TIMEOUT 40)
add_test(NAME desktop-shell-policy COMMAND pollywm-shell-policy)
set_tests_properties(desktop-shell-policy PROPERTIES TIMEOUT 20)
add_test(NAME desktop-cli COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/cli.sh" $<TARGET_FILE:pollywm>)
set_tests_properties(desktop-cli PROPERTIES TIMEOUT 15)
