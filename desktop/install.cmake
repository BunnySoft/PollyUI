include(GNUInstallDirs)

file(RELATIVE_PATH PU_DATA_FROM_BIN "${CMAKE_INSTALL_FULL_BINDIR}" "${CMAKE_INSTALL_FULL_DATADIR}/pollyui")
file(RELATIVE_PATH PU_LIB_FROM_BIN "${CMAKE_INSTALL_FULL_BINDIR}" "${CMAKE_INSTALL_FULL_LIBDIR}/pollyui")
set_target_properties(pollyui PROPERTIES INSTALL_RPATH "$ORIGIN/${PU_LIB_FROM_BIN}")
configure_file("${CMAKE_SOURCE_DIR}/desktop/tools/polly-desktop.in"
    "${CMAKE_BINARY_DIR}/polly-desktop" @ONLY NEWLINE_STYLE UNIX)

install(TARGETS pollyui RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
install(PROGRAMS "${CMAKE_BINARY_DIR}/polly-desktop"
    DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
install(FILES "$<TARGET_FILE:SDL3::SDL3>" DESTINATION "${CMAKE_INSTALL_LIBDIR}/pollyui"
    RENAME libSDL3.so.0 COMPONENT PollyDesktop)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/js" DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui"
    COMPONENT PollyDesktop FILES_MATCHING PATTERN "*.js" PATTERN "*.mjs")
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/shell"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.mjs")
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/client"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop" COMPONENT PollyDesktop
    FILES_MATCHING PATTERN "*.mjs")
install(FILES "${CMAKE_SOURCE_DIR}/desktop/shared/app-bundle.mjs"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop/shared" COMPONENT PollyDesktop)
install(DIRECTORY "${CMAKE_SOURCE_DIR}/desktop/themes"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/desktop" COMPONENT PollyDesktop
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
    DESTINATION "${CMAKE_INSTALL_DATADIR}/doc/pollyui" COMPONENT PollyDesktop)

if (BUILD_TESTING)
    add_test(NAME desktop-installed-session COMMAND node
        "${CMAKE_SOURCE_DIR}/desktop/tests/installed-session.mjs" "${CMAKE_BINARY_DIR}"
        "$<$<BOOL:${PU_BUILD_IME_ENGINE}>:--ime>")
    set_tests_properties(desktop-installed-session PROPERTIES TIMEOUT 90)
endif()
