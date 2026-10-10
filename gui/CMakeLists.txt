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
