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
    if (CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_HOST STREQUAL "sdl")
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
