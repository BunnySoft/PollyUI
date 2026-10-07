pkg_check_modules(WAYLAND_CLIENT REQUIRED IMPORTED_TARGET wayland-client)
foreach(protocol IN ITEMS text-input-v3 input-method-v2 virtual-keyboard-v1)
    if (protocol STREQUAL "text-input-v3")
        set(xml "${TEXT_INPUT_XML}")
    elseif (protocol STREQUAL "input-method-v2")
        set(xml "${INPUT_METHOD_XML}")
    else()
        set(xml "${VIRTUAL_KEYBOARD_XML}")
    endif()
    add_custom_command(OUTPUT "${PROTOCOL_DIR}/${protocol}-client.h" "${PROTOCOL_DIR}/${protocol}.c"
        COMMAND "${WAYLAND_SCANNER}" client-header "${xml}" "${PROTOCOL_DIR}/${protocol}-client.h"
        COMMAND "${WAYLAND_SCANNER}" private-code "${xml}" "${PROTOCOL_DIR}/${protocol}.c"
        DEPENDS "${xml}" VERBATIM)
    list(APPEND IME_TEST_PROTOCOLS "${PROTOCOL_DIR}/${protocol}-client.h" "${PROTOCOL_DIR}/${protocol}.c")
endforeach()
if (PU_BUILD_IME_ENGINE)
    find_program(NODE_EXECUTABLE node REQUIRED)
    add_executable(polly-ime-engine-test ime-engine.c)
    target_link_libraries(polly-ime-engine-test PRIVATE polly-ime-engine)
    target_compile_options(polly-ime-engine-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
    add_test(NAME desktop-ime-engine COMMAND "${NODE_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/ime-engine-fixture.mjs" $<TARGET_FILE:polly-ime-engine-test>)
    set_tests_properties(desktop-ime-engine PROPERTIES TIMEOUT 35)
    if (EXISTS "/usr/share/rime-data/default.yaml")
        add_test(NAME desktop-ime-installed COMMAND "${NODE_EXECUTABLE}"
            "${CMAKE_CURRENT_SOURCE_DIR}/ime-installed.mjs" $<TARGET_FILE:polly-ime-engine-test>)
        set_tests_properties(desktop-ime-installed PROPERTIES TIMEOUT 70)
    endif()
endif()
add_executable(polly-appearance-document-test appearance-document.c ../shared/appearance-document.c)
target_include_directories(polly-appearance-document-test PRIVATE ../shared)
target_compile_options(polly-appearance-document-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME desktop-appearance-document COMMAND polly-appearance-document-test)
set_tests_properties(desktop-appearance-document PROPERTIES TIMEOUT 10)

set(SESSION_LOCK_XML "${WAYLAND_PROTOCOLS_DIR}/staging/ext-session-lock/ext-session-lock-v1.xml")
add_custom_command(OUTPUT "${PROTOCOL_DIR}/session-lock-client.h" "${PROTOCOL_DIR}/session-lock.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${SESSION_LOCK_XML}" "${PROTOCOL_DIR}/session-lock-client.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${SESSION_LOCK_XML}" "${PROTOCOL_DIR}/session-lock.c"
    DEPENDS "${SESSION_LOCK_XML}" VERBATIM)
add_executable(polly-lock-test-client session-lock-client.c
    "${PROTOCOL_DIR}/session-lock-client.h" "${PROTOCOL_DIR}/session-lock.c")
target_include_directories(polly-lock-test-client PRIVATE "${PROTOCOL_DIR}")
target_compile_definitions(polly-lock-test-client PRIVATE _POSIX_C_SOURCE=200809L)
target_link_libraries(polly-lock-test-client PRIVATE PkgConfig::WAYLAND_CLIENT)
target_compile_options(polly-lock-test-client PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_executable(polly-lock-test session-lock.c)
target_link_libraries(polly-lock-test PRIVATE pollywm-core)
target_compile_options(polly-lock-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME desktop-session-lock COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/session-lock.sh"
    $<TARGET_FILE:polly-lock-test> $<TARGET_FILE:polly-lock-test-client>)
set_tests_properties(desktop-session-lock PROPERTIES TIMEOUT 30)

add_executable(pollywm-shortcut-policy shortcut-policy.c)
target_link_libraries(pollywm-shortcut-policy PRIVATE pollywm-core)
add_test(NAME desktop-shortcut-policy COMMAND pollywm-shortcut-policy)
set_tests_properties(desktop-shortcut-policy PROPERTIES TIMEOUT 10)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/ext-workspace-client.h" "${PROTOCOL_DIR}/polly-workspace-toplevel-client.h"
    COMMAND "${WAYLAND_SCANNER}" client-header "${WORKSPACE_XML}" "${PROTOCOL_DIR}/ext-workspace-client.h"
    COMMAND "${WAYLAND_SCANNER}" client-header "${WORKSPACE_TOPLEVEL_XML}" "${PROTOCOL_DIR}/polly-workspace-toplevel-client.h"
    DEPENDS "${WORKSPACE_XML}" "${WORKSPACE_TOPLEVEL_XML}" VERBATIM)
set(DECORATION_XML "${WAYLAND_PROTOCOLS_DIR}/unstable/xdg-decoration/xdg-decoration-unstable-v1.xml")
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/xdg-decoration-client.h" "${PROTOCOL_DIR}/xdg-decoration.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${DECORATION_XML}" "${PROTOCOL_DIR}/xdg-decoration-client.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${DECORATION_XML}" "${PROTOCOL_DIR}/xdg-decoration.c"
    DEPENDS "${DECORATION_XML}" VERBATIM)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/polly-appearance-client.h"
    COMMAND "${WAYLAND_SCANNER}" client-header "${APPEARANCE_XML}" "${PROTOCOL_DIR}/polly-appearance-client.h"
    DEPENDS "${APPEARANCE_XML}" VERBATIM)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/xdg-shell-client-protocol.h" "${PROTOCOL_DIR}/xdg-shell-protocol.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${XDG_SHELL_XML}"
            "${PROTOCOL_DIR}/xdg-shell-client-protocol.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${XDG_SHELL_XML}"
            "${PROTOCOL_DIR}/xdg-shell-protocol.c"
    DEPENDS "${XDG_SHELL_XML}" VERBATIM)
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/layer-shell-client-protocol.h" "${PROTOCOL_DIR}/layer-shell-protocol.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${LAYER_SHELL_XML}"
            "${PROTOCOL_DIR}/layer-shell-client-protocol.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${LAYER_SHELL_XML}"
            "${PROTOCOL_DIR}/layer-shell-protocol.c"
    DEPENDS "${LAYER_SHELL_XML}" VERBATIM)
set(FOREIGN_XML "${WLR_PROTOCOLS_DIR}/unstable/wlr-foreign-toplevel-management-unstable-v1.xml")
add_custom_command(
    OUTPUT "${PROTOCOL_DIR}/foreign-toplevel-client.h" "${PROTOCOL_DIR}/foreign-toplevel.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${FOREIGN_XML}" "${PROTOCOL_DIR}/foreign-toplevel-client.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${FOREIGN_XML}" "${PROTOCOL_DIR}/foreign-toplevel.c"
    DEPENDS "${FOREIGN_XML}" VERBATIM)
add_executable(pollywm-test-client client.c
    ${IME_TEST_PROTOCOLS}
    "${PROTOCOL_DIR}/ext-workspace-client.h" "${PROTOCOL_DIR}/ext-workspace.c"
    "${PROTOCOL_DIR}/polly-workspace-toplevel-client.h" "${PROTOCOL_DIR}/polly-workspace-toplevel.c"
    "${PROTOCOL_DIR}/xdg-decoration-client.h" "${PROTOCOL_DIR}/xdg-decoration.c"
    "${PROTOCOL_DIR}/polly-appearance-client.h" "${PROTOCOL_DIR}/polly-appearance.c"
    "${PROTOCOL_DIR}/foreign-toplevel-client.h" "${PROTOCOL_DIR}/foreign-toplevel.c"
    "${PROTOCOL_DIR}/layer-shell-client-protocol.h" "${PROTOCOL_DIR}/layer-shell-protocol.c"
    "${PROTOCOL_DIR}/xdg-shell-client-protocol.h" "${PROTOCOL_DIR}/xdg-shell-protocol.c")
target_include_directories(pollywm-test-client PRIVATE "${PROTOCOL_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../compositor" "${CMAKE_CURRENT_SOURCE_DIR}/../shared")
target_compile_definitions(pollywm-test-client PRIVATE _POSIX_C_SOURCE=200809L)
target_link_libraries(pollywm-test-client PRIVATE PkgConfig::WAYLAND_CLIENT)

add_executable(pollywm-integration integration.c)
target_link_libraries(pollywm-integration PRIVATE pollywm-core)
add_custom_command(OUTPUT "${PROTOCOL_DIR}/polly-session-status-client.h"
    COMMAND "${WAYLAND_SCANNER}" client-header "${SESSION_STATUS_XML}" "${PROTOCOL_DIR}/polly-session-status-client.h"
    DEPENDS "${SESSION_STATUS_XML}" VERBATIM)
add_executable(pollywm-shell-policy shell-policy.c "${PROTOCOL_DIR}/polly-session-status-client.h")
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
