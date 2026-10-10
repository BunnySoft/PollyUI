include(GNUInstallDirs)

file(RELATIVE_PATH PU_DATA_FROM_BIN "${CMAKE_INSTALL_FULL_BINDIR}" "${CMAKE_INSTALL_FULL_DATADIR}/pollyui")
target_compile_definitions(pollyui PRIVATE PU_DATA_FROM_BIN="${PU_DATA_FROM_BIN}")
file(RELATIVE_PATH PU_LIB_FROM_BIN "${CMAKE_INSTALL_FULL_BINDIR}" "${CMAKE_INSTALL_FULL_LIBDIR}/pollyui")
set_target_properties(pollyui PROPERTIES INSTALL_RPATH "$ORIGIN/${PU_LIB_FROM_BIN}")
configure_file("${CMAKE_SOURCE_DIR}/desktop/tools/polly-desktop.in"
    "${CMAKE_BINARY_DIR}/polly-desktop" @ONLY NEWLINE_STYLE UNIX)
configure_file("${CMAKE_SOURCE_DIR}/desktop/tools/polly-files.in"
    "${CMAKE_BINARY_DIR}/polly-files" @ONLY NEWLINE_STYLE UNIX)
configure_file("${CMAKE_SOURCE_DIR}/desktop/tools/polly-file-text.in"
    "${CMAKE_BINARY_DIR}/polly-file-text" @ONLY NEWLINE_STYLE UNIX)

install(TARGETS pollyui RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
install(PROGRAMS "${CMAKE_BINARY_DIR}/polly-desktop"
    DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
install(PROGRAMS "${CMAKE_BINARY_DIR}/polly-files" "${CMAKE_BINARY_DIR}/polly-file-text"
    DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/release/polly-files.desktop"
    "${CMAKE_SOURCE_DIR}/desktop/release/polly-file-text.desktop"
    "${CMAKE_SOURCE_DIR}/desktop/release/polly-file-text-open.desktop"
    "${CMAKE_SOURCE_DIR}/desktop/release/polly-mimeapps.list"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/applications" COMPONENT PollyDesktop)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/apps/files"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/apps" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.mjs" PATTERN "tests" EXCLUDE)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/examples/file-dialog.mjs"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/examples" COMPONENT PollyDesktop)
install(FILES "$<TARGET_FILE:SDL3::SDL3>" DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui"
    RENAME libSDL3.so.0 COMPONENT PollyDesktop)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/gui/sdk/js"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/gui/sdk"
    COMPONENT PollyDesktop FILES_MATCHING PATTERN "*.js" PATTERN "*.mjs")
install(DIRECTORY "${CMAKE_SOURCE_DIR}/sysrt/sdk" "${CMAKE_SOURCE_DIR}/sysrt/bindings"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/sysrt"
    COMPONENT PollyDesktop FILES_MATCHING PATTERN "*.mjs")
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/shell"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.mjs")
install(FILES "${CMAKE_SOURCE_DIR}/desktop/launcher/services.mjs"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/launcher" COMPONENT PollyDesktop)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/client"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.mjs")
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/apps/installer"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/apps" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.mjs" PATTERN "tests" EXCLUDE)
foreach(PU_INSTALL_TARGETS_GROUP IN ITEMS install storage maintenance)
    install(DIRECTORY DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui/install-targets/${PU_INSTALL_TARGETS_GROUP}"
        DIRECTORY_PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE GROUP_READ GROUP_EXECUTE WORLD_READ WORLD_EXECUTE
        COMPONENT PollyDesktop)
endforeach()
install(FILES "${CMAKE_SOURCE_DIR}/desktop/release/install/readonly-helper.py"
    "${CMAKE_SOURCE_DIR}/desktop/release/install/targets.py"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui/install-targets/install"
    PERMISSIONS OWNER_READ OWNER_WRITE GROUP_READ WORLD_READ COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/release/storage/layout.py"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui/install-targets/storage"
    PERMISSIONS OWNER_READ OWNER_WRITE GROUP_READ WORLD_READ COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/release/maintenance/payload.py"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui/install-targets/maintenance"
    PERMISSIONS OWNER_READ OWNER_WRITE GROUP_READ WORLD_READ COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/shared/app-bundle.mjs"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/shared" COMPONENT PollyDesktop)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/resources/themes"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/resources" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.json")
install(FILES "${CMAKE_SOURCE_DIR}/desktop/input-method/main.mjs"
    "${CMAKE_SOURCE_DIR}/desktop/input-method/view.mjs"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/input-method" COMPONENT PollyDesktop)
if (PU_BUILD_SESSION_AUTH)
    install(FILES "${CMAKE_SOURCE_DIR}/desktop/session/lock.mjs"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/session" COMPONENT PollyDesktop)
    install(PROGRAMS "${CMAKE_SOURCE_DIR}/desktop/tools/run-session-lock.sh"
        DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/tools" COMPONENT PollyDesktop)
endif()
install(FILES "${CMAKE_SOURCE_DIR}/desktop/session/greeter.mjs"
    "${CMAKE_SOURCE_DIR}/desktop/session/greeter-controller.mjs"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/session" COMPONENT PollyDesktop)
install(PROGRAMS "${CMAKE_SOURCE_DIR}/desktop/session/greeter-entry"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/session/greetd-launch.py"
    "${CMAKE_SOURCE_DIR}/desktop/session/setup-broker.py"
    "${CMAKE_SOURCE_DIR}/desktop/session/greetd.conf"
    "${CMAKE_SOURCE_DIR}/desktop/session/greeter-dependencies.json"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui" COMPONENT PollyDesktop)
install(PROGRAMS "${CMAKE_SOURCE_DIR}/desktop/tools/run-session.sh"
    "${CMAKE_SOURCE_DIR}/desktop/tools/run-input-method.sh"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/tools" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/tools/session-bus.sh"
    "${CMAKE_SOURCE_DIR}/desktop/tools/session-audio.sh"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/tools" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/system/pipewire.conf"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/system" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/LICENSE" "${CMAKE_SOURCE_DIR}/desktop/LICENSE.wlroots"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/licenses/pollyui" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/third_party/quickjs/LICENSE"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/licenses/pollyui/quickjs" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/third_party/yoga/LICENSE"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/licenses/pollyui/yoga" COMPONENT PollyDesktop)
install(FILES "${CMAKE_SOURCE_DIR}/desktop/THEMES.md" "${CMAKE_SOURCE_DIR}/desktop/SESSION.md"
    "${CMAKE_SOURCE_DIR}/desktop/APPLICATIONS.md"
    "${CMAKE_SOURCE_DIR}/desktop/FILE-DIALOGS.md"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/doc/pollyui" COMPONENT PollyDesktop)

if (BUILD_TESTING)
    add_test(NAME desktop-installed-session COMMAND node
        "${CMAKE_SOURCE_DIR}/desktop/tests/installed-session.mjs" "${CMAKE_BINARY_DIR}"
        "$<$<BOOL:${PU_BUILD_IME_ENGINE}>:--ime>")
    set_tests_properties(desktop-installed-session PROPERTIES TIMEOUT 90)
endif()
