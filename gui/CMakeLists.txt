add_library(pollyui-engine STATIC
    src/context/context.c
    src/render/skia_c.cpp
    src/render/render.c
    src/script/script.c
    src/script/async.c
    src/model/node.c
    src/bridge/bridge.c
    src/host/clipboard.c
    src/layout/layout.c
)
target_include_directories(pollyui-engine PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
    PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src" "${SKIA_ROOT}")
target_link_libraries(pollyui-engine PUBLIC qjs yogacore polly-execution)

add_executable(pollyui-playground examples/playground/main.c)
target_link_libraries(pollyui-playground PRIVATE pollyui-engine)

if (BUILD_TESTING)
    if ((WIN32 AND PU_HOST STREQUAL "win32") OR (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_HOST STREQUAL "sdl"))
        add_executable(pollyui-native-lifetime-test tests/native-window-lifetime.c)
        add_executable(pollyui-close-tree-test tests/window-close-driver.c)
        target_include_directories(pollyui-native-lifetime-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
        target_link_libraries(pollyui-native-lifetime-test PRIVATE pollyui-engine)
        target_link_libraries(pollyui-close-tree-test PRIVATE pollyui-engine)
        if (CMAKE_SYSTEM_NAME STREQUAL "Linux")
            target_compile_definitions(pollyui-native-lifetime-test PRIVATE PU_TEST_SDL)
            target_compile_definitions(pollyui-close-tree-test PRIVATE PU_TEST_SDL)
        else()
            add_test(NAME gui-win32-close-tree COMMAND pollyui-close-tree-test
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/window-close-tree.mjs")
            set_tests_properties(gui-win32-close-tree PROPERTIES TIMEOUT 15 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
            add_test(NAME gui-native-window-lifetime COMMAND pollyui-native-lifetime-test)
            set_tests_properties(gui-native-window-lifetime PROPERTIES TIMEOUT 15)
        endif()
    endif()
    if (WIN32 AND PU_HOST STREQUAL "win32")
        add_executable(pollyui-native-window-test tests/win32-window-contract.c)
        target_link_libraries(pollyui-native-window-test PRIVATE pollyui-engine)
        add_test(NAME gui-win32-window-contract COMMAND pollyui-native-window-test)
        set_tests_properties(gui-win32-window-contract PROPERTIES TIMEOUT 15)
        add_executable(pollyui-native-mouse-test tests/win32-mouse.c)
        target_link_libraries(pollyui-native-mouse-test PRIVATE pollyui-engine)
        add_test(NAME gui-win32-mouse COMMAND pollyui-native-mouse-test)
        set_tests_properties(gui-win32-mouse PROPERTIES TIMEOUT 15)
    endif()
    if (WIN32)
        add_test(NAME gui-window-contract COMMAND pollyui-playground
            "${CMAKE_CURRENT_SOURCE_DIR}/tests/window-contract.mjs" "" standalone)
        set_tests_properties(gui-window-contract PROPERTIES TIMEOUT 15 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    endif()
    if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_BUILD_DESKTOP)
        file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/native-window-evidence")
        add_test(NAME gui-wayland-window-contract COMMAND sh
            "${CMAKE_SOURCE_DIR}/desktop/tests/window-contract.sh"
            $<TARGET_FILE:pollywm-window-contract-test> $<TARGET_FILE:pollyui-playground>
            "${CMAKE_CURRENT_SOURCE_DIR}/tests/window-contract.mjs"
            "${CMAKE_BINARY_DIR}/native-window-evidence/frame" $<TARGET_FILE:pollyui-native-lifetime-test>
            $<TARGET_FILE:pollyui-close-tree-test>)
        set_tests_properties(gui-wayland-window-contract PROPERTIES TIMEOUT 25
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
    endif()
    if (PU_BUILD_LAUNCHER)
        add_test(NAME gui-mouse-capture COMMAND pollyui --test "${CMAKE_CURRENT_SOURCE_DIR}/tests/mouse-capture.mjs")
        set_tests_properties(gui-mouse-capture PROPERTIES TIMEOUT 15 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        foreach(widget IN ITEMS textinput scrollbar)
            add_test(NAME gui-${widget} COMMAND pollyui --test "${CMAKE_CURRENT_SOURCE_DIR}/tests/${widget}.mjs")
            set_tests_properties(gui-${widget} PROPERTIES TIMEOUT 15 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        endforeach()
    endif()
    add_executable(pollyui-mouse-contract-test tests/mouse-contract.c)
    target_include_directories(pollyui-mouse-contract-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(pollyui-mouse-contract-test PRIVATE pollyui-engine)
    add_test(NAME gui-mouse-contract COMMAND pollyui-mouse-contract-test)
    set_tests_properties(gui-mouse-contract PROPERTIES TIMEOUT 15)
    if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_HOST STREQUAL "sdl")
        add_executable(pollyui-input-test tests/sdl-input.c)
        add_executable(pollyui-multi-test tests/multi-window-native.c)
        foreach(target pollyui-input-test pollyui-multi-test)
            target_include_directories(${target} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
            target_link_libraries(${target} PRIVATE pollyui-engine)
        endforeach()
        add_test(NAME sdl-input-adapter COMMAND pollyui-input-test)
        add_test(NAME sdl-multi-window COMMAND pollyui-multi-test)
        set_tests_properties(sdl-input-adapter sdl-multi-window PROPERTIES TIMEOUT 15
            ENVIRONMENT "SDL_VIDEODRIVER=dummy;SDL_RENDER_DRIVER=software;PU_RENDERER=raster")
        add_executable(pollyui-idle-paint-test tests/idle-paint.c)
        target_link_libraries(pollyui-idle-paint-test PRIVATE pollyui-engine)
        target_compile_definitions(pollyui-idle-paint-test PRIVATE _POSIX_C_SOURCE=200809L)
        target_compile_options(pollyui-idle-paint-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
        add_test(NAME gui-idle-paint COMMAND pollyui-idle-paint-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/idle-paint.mjs")
        set_tests_properties(gui-idle-paint PROPERTIES TIMEOUT 15
            ENVIRONMENT "SDL_VIDEODRIVER=dummy;SDL_RENDER_DRIVER=software;PU_RENDERER=raster")
        add_executable(pollyui-paint-revision-test tests/paint-revision.c)
        target_include_directories(pollyui-paint-revision-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
        target_link_libraries(pollyui-paint-revision-test PRIVATE pollyui-engine)
        add_test(NAME gui-paint-revision COMMAND pollyui-paint-revision-test)
        add_executable(pollyui-document-paint-test tests/document-paint.c)
        target_include_directories(pollyui-document-paint-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
        target_link_libraries(pollyui-document-paint-test PRIVATE pollyui-engine)
        target_compile_definitions(pollyui-document-paint-test PRIVATE _POSIX_C_SOURCE=200809L)
        target_compile_options(pollyui-document-paint-test PRIVATE -Wall -Wextra -Wpedantic -Werror)
        target_link_options(pollyui-document-paint-test PRIVATE "-Wl,--wrap=pu_surface_save_png")
        add_test(NAME gui-document-paint COMMAND pollyui-document-paint-test
            "${CMAKE_CURRENT_SOURCE_DIR}/tests/document-paint.mjs")
        set_tests_properties(gui-document-paint PROPERTIES TIMEOUT 15
            ENVIRONMENT "SDL_VIDEODRIVER=dummy;SDL_RENDER_DRIVER=software;PU_RENDERER=raster")
    endif()
    add_executable(pollyui-context-test tests/context-hooks.c)
    target_link_libraries(pollyui-context-test PRIVATE pollyui-engine)
    add_test(NAME gui-context-hooks COMMAND pollyui-context-test
        "${CMAKE_CURRENT_SOURCE_DIR}/tests/context-hooks.mjs"
        "context-prelude.mjs" "${CMAKE_CURRENT_SOURCE_DIR}/tests")
    set_tests_properties(gui-context-hooks PROPERTIES TIMEOUT 30)
    add_executable(pollyui-bitmap-test tests/bitmap-resources.c)
    target_include_directories(pollyui-bitmap-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(pollyui-bitmap-test PRIVATE pollyui-engine)
    add_test(NAME gui-bitmap-resources COMMAND pollyui-bitmap-test)
    set_tests_properties(gui-bitmap-resources PROPERTIES TIMEOUT 30)
endif()
