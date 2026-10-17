pkg_check_modules(WAYLAND_CLIENT REQUIRED IMPORTED_TARGET wayland-client)
add_executable(pollywm-private-process-test private-process.c)
target_link_libraries(pollywm-private-process-test PRIVATE pollywm-core)
target_compile_options(pollywm-private-process-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
set_target_properties(pollywm-private-process-test PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
add_test(NAME desktop-private-process COMMAND pollywm-private-process-test)
set_tests_properties(desktop-private-process PROPERTIES TIMEOUT 15
    ENVIRONMENT "WLR_BACKENDS=headless;WLR_RENDERER=pixman")
add_executable(pollywm-window-contract-test window-contract.c)
pkg_check_modules(WINDOW_PIXMAN REQUIRED IMPORTED_TARGET pixman-1)
target_link_libraries(pollywm-window-contract-test PRIVATE pollywm-core PkgConfig::WINDOW_PIXMAN)
add_executable(pollywm-scene-effects-test scene-effects.c)
target_link_libraries(pollywm-scene-effects-test PRIVATE pollywm-core)
target_compile_options(pollywm-scene-effects-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME desktop-scene-effects COMMAND pollywm-scene-effects-test)
set_tests_properties(desktop-scene-effects PROPERTIES TIMEOUT 30)
add_executable(pollywm-shm-allocator-test shm-allocator.c)
target_link_libraries(pollywm-shm-allocator-test PRIVATE PkgConfig::WLROOTS PkgConfig::WAYLAND_SERVER)
target_compile_definitions(pollywm-shm-allocator-test PRIVATE WLR_USE_UNSTABLE _POSIX_C_SOURCE=200809L)
target_compile_options(pollywm-shm-allocator-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
set_target_properties(pollywm-shm-allocator-test PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
add_test(NAME desktop-shm-allocator COMMAND pollywm-shm-allocator-test)
set_tests_properties(desktop-shm-allocator PROPERTIES TIMEOUT 10)
target_compile_options(pollywm-window-contract-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_executable(pollywm-decorator-lifecycle-test decorator-lifecycle.c)
target_link_libraries(pollywm-decorator-lifecycle-test PRIVATE pollywm-core PkgConfig::WINDOW_PIXMAN)
target_compile_options(pollywm-decorator-lifecycle-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
find_program(PACKAGE_NODE_EXECUTABLE node REQUIRED)
add_test(NAME desktop-package-contract COMMAND "${PACKAGE_NODE_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/package-contract.mjs")
set_tests_properties(desktop-package-contract PROPERTIES TIMEOUT 60)
add_test(NAME desktop-live-publication COMMAND "${PACKAGE_NODE_EXECUTABLE}" --test
    "${CMAKE_CURRENT_SOURCE_DIR}/publish-live-iso.mjs")
set_tests_properties(desktop-live-publication PROPERTIES TIMEOUT 30)
find_program(CURSOR_PYTHON_EXECUTABLE python3 REQUIRED)
if (EXISTS "/opt/wlroots-0.19.3.tar.gz")
    pkg_get_variable(PU_WLROOTS_PREFIX wlroots-0.19 prefix)
    add_test(NAME desktop-wlroots-effects-dependency COMMAND "${CURSOR_PYTHON_EXECUTABLE}"
        "${CMAKE_CURRENT_SOURCE_DIR}/wlroots-effects.py" "${PU_WLROOTS_PREFIX}"
        "/opt/wlroots-0.19.3.tar.gz")
    set_tests_properties(desktop-wlroots-effects-dependency PROPERTIES TIMEOUT 30)
    pkg_check_modules(EFFECTS_GLES QUIET IMPORTED_TARGET egl glesv2)
    if (EFFECTS_GLES_FOUND)
        add_executable(pollywm-scene-effects-gles-test scene-effects-gles.c)
        target_link_libraries(pollywm-scene-effects-gles-test PRIVATE PkgConfig::EFFECTS_GLES m)
        target_compile_options(pollywm-scene-effects-gles-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
        add_test(NAME desktop-scene-effects-software-gles COMMAND "${CURSOR_PYTHON_EXECUTABLE}"
            "${CMAKE_CURRENT_SOURCE_DIR}/scene-effects-gles.py"
            $<TARGET_FILE:pollywm-scene-effects-gles-test>)
        set_tests_properties(desktop-scene-effects-software-gles PROPERTIES TIMEOUT 45 SKIP_RETURN_CODE 77)
    endif()
endif()
add_test(NAME desktop-cursor-assets COMMAND "${CURSOR_PYTHON_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../tools/generate-cursors.py")
set_tests_properties(desktop-cursor-assets PROPERTIES TIMEOUT 30)
set(CURSOR_TABLET_XML "${WAYLAND_PROTOCOLS_DIR}/stable/tablet/tablet-v2.xml")
add_custom_command(OUTPUT "${PROTOCOL_DIR}/cursor-shape-client.h" "${PROTOCOL_DIR}/cursor-shape-client.c"
    "${PROTOCOL_DIR}/cursor-tablet.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${CURSOR_SHAPE_XML}" "${PROTOCOL_DIR}/cursor-shape-client.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${CURSOR_SHAPE_XML}" "${PROTOCOL_DIR}/cursor-shape-client.c"
    COMMAND "${WAYLAND_SCANNER}" private-code "${CURSOR_TABLET_XML}" "${PROTOCOL_DIR}/cursor-tablet.c"
    DEPENDS "${CURSOR_SHAPE_XML}" "${CURSOR_TABLET_XML}" VERBATIM)
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
add_executable(polly-decoration-frame-test decoration-frame.c ../shared/decoration-frame.c)
target_include_directories(polly-decoration-frame-test PRIVATE ../shared)
target_compile_options(polly-decoration-frame-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
target_link_libraries(polly-decoration-frame-test PRIVATE m)
add_test(NAME desktop-decoration-frame COMMAND polly-decoration-frame-test)
set_tests_properties(desktop-decoration-frame PROPERTIES TIMEOUT 10)

set(SESSION_LOCK_XML "${WAYLAND_PROTOCOLS_DIR}/staging/ext-session-lock/ext-session-lock-v1.xml")
add_custom_command(OUTPUT "${PROTOCOL_DIR}/session-lock-client.h" "${PROTOCOL_DIR}/session-lock.c"
    COMMAND "${WAYLAND_SCANNER}" client-header "${SESSION_LOCK_XML}" "${PROTOCOL_DIR}/session-lock-client.h"
    COMMAND "${WAYLAND_SCANNER}" private-code "${SESSION_LOCK_XML}" "${PROTOCOL_DIR}/session-lock.c"
    DEPENDS "${SESSION_LOCK_XML}" VERBATIM)
add_executable(polly-lock-test-client session-lock-client.c
    "${PROTOCOL_DIR}/session-lock-client.h" "${PROTOCOL_DIR}/session-lock.c")
add_dependencies(pollywm-decorator-lifecycle-test polly-lock-test-client)
target_include_directories(polly-lock-test-client PRIVATE "${PROTOCOL_DIR}")
target_compile_definitions(polly-lock-test-client PRIVATE _POSIX_C_SOURCE=200809L)
target_link_libraries(polly-lock-test-client PRIVATE PkgConfig::WAYLAND_CLIENT)
target_compile_options(polly-lock-test-client PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_executable(polly-lock-test session-lock.c)
target_link_libraries(polly-lock-test PRIVATE pollywm-core)
target_compile_options(polly-lock-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
add_test(NAME desktop-session-lock COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/session-lock.sh"
    $<TARGET_FILE:polly-lock-test> $<TARGET_FILE:polly-lock-test-client>)
set_tests_properties(desktop-session-lock PROPERTIES TIMEOUT 30 ENVIRONMENT "POLLY_CURSOR_THEME=PollyRabbit")

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
add_custom_command(OUTPUT "${PROTOCOL_DIR}/polly-shortcuts-client.h"
    COMMAND "${WAYLAND_SCANNER}" client-header "${SHORTCUTS_XML}" "${PROTOCOL_DIR}/polly-shortcuts-client.h"
    DEPENDS "${SHORTCUTS_XML}" VERBATIM)
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
add_executable(pollywm-test-client client.c ../shared/appearance-document.c ../shared/decoration-frame.c
    "${PROTOCOL_DIR}/cursor-shape-client.h" "${PROTOCOL_DIR}/cursor-shape-client.c"
    "${PROTOCOL_DIR}/cursor-tablet.c"
    ${IME_TEST_PROTOCOLS}
    "${PROTOCOL_DIR}/ext-workspace-client.h" "${PROTOCOL_DIR}/ext-workspace.c"
    "${PROTOCOL_DIR}/polly-workspace-toplevel-client.h" "${PROTOCOL_DIR}/polly-workspace-toplevel.c"
    "${PROTOCOL_DIR}/xdg-decoration-client.h" "${PROTOCOL_DIR}/xdg-decoration.c"
    "${PROTOCOL_DIR}/polly-appearance-client.h" "${PROTOCOL_DIR}/polly-appearance.c"
    "${PROTOCOL_DIR}/polly-shortcuts-client.h" "${PROTOCOL_DIR}/polly-shortcuts.c"
    "${PROTOCOL_DIR}/foreign-toplevel-client.h" "${PROTOCOL_DIR}/foreign-toplevel.c"
    "${PROTOCOL_DIR}/layer-shell-client-protocol.h" "${PROTOCOL_DIR}/layer-shell-protocol.c"
    "${PROTOCOL_DIR}/xdg-shell-client-protocol.h" "${PROTOCOL_DIR}/xdg-shell-protocol.c")
target_include_directories(pollywm-test-client PRIVATE "${PROTOCOL_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../compositor" "${CMAKE_CURRENT_SOURCE_DIR}/../shared")
target_compile_definitions(pollywm-test-client PRIVATE _POSIX_C_SOURCE=200809L)
target_link_libraries(pollywm-test-client PRIVATE PkgConfig::WAYLAND_CLIENT m)

add_executable(pollywm-integration integration.c)
add_dependencies(pollywm-integration polly-lock-test-client)
target_link_libraries(pollywm-integration PRIVATE pollywm-core)
add_custom_command(OUTPUT "${PROTOCOL_DIR}/polly-session-status-client.h"
    COMMAND "${WAYLAND_SCANNER}" client-header "${SESSION_STATUS_XML}" "${PROTOCOL_DIR}/polly-session-status-client.h"
    DEPENDS "${SESSION_STATUS_XML}" VERBATIM)
add_executable(pollywm-shell-policy shell-policy.c "${PROTOCOL_DIR}/polly-session-status-client.h")
target_link_libraries(pollywm-shell-policy PRIVATE pollywm-core PkgConfig::WAYLAND_CLIENT)
add_executable(pollywm-decorator-policy decorator-policy.c "${PROTOCOL_DIR}/polly-appearance-client.h"
    "${PROTOCOL_DIR}/layer-shell-client-protocol.h" "${PROTOCOL_DIR}/layer-shell-protocol.c"
    "${PROTOCOL_DIR}/xdg-shell-protocol.c")
target_link_libraries(pollywm-decorator-policy PRIVATE pollywm-core PkgConfig::WAYLAND_CLIENT)
foreach(target pollywm-test-client pollywm-integration pollywm-shell-policy pollywm-decorator-policy)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
    set_target_properties(${target} PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES C_EXTENSIONS NO)
endforeach()

add_test(NAME desktop-integration
    COMMAND pollywm-integration $<TARGET_FILE:pollywm-test-client>)
set_tests_properties(desktop-integration PROPERTIES TIMEOUT 40)
add_test(NAME desktop-live-startup
    COMMAND pollywm-integration $<TARGET_FILE:pollywm-test-client> --live-startup)
set_tests_properties(desktop-live-startup PROPERTIES TIMEOUT 15)
add_test(NAME desktop-live-startup-source COMMAND "${CURSOR_PYTHON_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/live-startup.py")
set_tests_properties(desktop-live-startup-source PROPERTIES TIMEOUT 15)
add_test(NAME desktop-cursor-native
    COMMAND pollywm-integration $<TARGET_FILE:pollywm-test-client> --cursor)
set_tests_properties(desktop-cursor-native PROPERTIES TIMEOUT 15 ENVIRONMENT "POLLY_CURSOR_THEME=PollyRabbit")
add_executable(polly-cursor-choice-test cursor-choice.c)
add_test(NAME desktop-cursor-choice COMMAND polly-cursor-choice-test)
set_tests_properties(desktop-cursor-choice PROPERTIES TIMEOUT 10)
add_test(NAME desktop-cursor-resources COMMAND "${CURSOR_PYTHON_EXECUTABLE}"
    "${CMAKE_CURRENT_SOURCE_DIR}/cursor-resources.py" $<TARGET_FILE:pollywm-integration>)
set_tests_properties(desktop-cursor-resources PROPERTIES TIMEOUT 60)
add_test(NAME desktop-shell-policy COMMAND pollywm-shell-policy)
set_tests_properties(desktop-shell-policy PROPERTIES TIMEOUT 20)
add_test(NAME desktop-decorator-policy COMMAND pollywm-decorator-policy)
set_tests_properties(desktop-decorator-policy PROPERTIES TIMEOUT 20)
add_test(NAME desktop-cli COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/cli.sh" $<TARGET_FILE:pollywm>)
set_tests_properties(desktop-cli PROPERTIES TIMEOUT 15)
