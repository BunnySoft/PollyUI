if(NOT PU_WEBGPU)
    return()
endif()

if(NOT PU_DAWN_ROOT)
    message(FATAL_ERROR "PU_WEBGPU requires PU_DAWN_ROOT; use tools/fetch_dawn.cmake or the pinned macOS source build")
endif()
add_custom_target(pollyui-dawn-distribution-check
    COMMAND "${CMAKE_COMMAND}"
        "-DPU_DAWN_ROOT=${PU_DAWN_ROOT}"
        "-DPU_DAWN_PLATFORM=${PU_DAWN_DISTRIBUTION_PLATFORM}"
        -P "${CMAKE_CURRENT_LIST_DIR}/../../tools/check_dawn_redistribution.cmake"
    VERBATIM)
file(READ "${CMAKE_SOURCE_DIR}/third_party/dawn-manifest.json" PU_DAWN_MANIFEST)
string(JSON PU_DAWN_HEADER_HASH GET "${PU_DAWN_MANIFEST}" header sha256)
file(READ "${PU_DAWN_ROOT}/include/dawn/webgpu.h" PU_DAWN_HEADER_TEXT)
string(REPLACE "\r\n" "\n" PU_DAWN_HEADER_TEXT "${PU_DAWN_HEADER_TEXT}")
string(SHA256 PU_DAWN_ACTUAL_HEADER_HASH "${PU_DAWN_HEADER_TEXT}")
if(NOT PU_DAWN_HEADER_HASH STREQUAL PU_DAWN_ACTUAL_HEADER_HASH)
    message(FATAL_ERROR "Dawn API header differs from the pinned provider ABI")
endif()
find_package(Threads REQUIRED)
find_package(Dawn CONFIG REQUIRED PATHS "${PU_DAWN_ROOT}/lib/cmake/Dawn"
    "${PU_DAWN_ROOT}/lib64/cmake/Dawn" NO_DEFAULT_PATH)
add_library(pollyui-dawn-provider SHARED "${CMAKE_CURRENT_SOURCE_DIR}/src/webgpu/provider.cpp")
set_target_properties(pollyui-dawn-provider PROPERTIES
    LINKER_LANGUAGE CXX
    CXX_STANDARD 20
    OUTPUT_NAME pollyui-dawn-provider
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden
    MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
target_compile_definitions(pollyui-dawn-provider PRIVATE PU_DAWN_HEADER_HASH="${PU_DAWN_HEADER_HASH}")
target_link_libraries(pollyui-dawn-provider PRIVATE dawn::webgpu_dawn)

file(READ "${PU_DAWN_ROOT}/include/dawn/webgpu.h" PU_DAWN_HEADER)
string(REGEX MATCHALL "\\(\\*WGPUProc[A-Za-z0-9_]+\\)" PU_DAWN_PROC_TYPES "${PU_DAWN_HEADER}")
set(PU_DAWN_PROC_LIST "")
foreach(type IN LISTS PU_DAWN_PROC_TYPES)
    string(REGEX REPLACE "\\(\\*WGPUProc([A-Za-z0-9_]+)\\)" "\\1" suffix "${type}")
    string(APPEND PU_DAWN_PROC_LIST "PU_DAWN_PROC(${suffix})\n")
endforeach()
if(NOT PU_DAWN_PROC_LIST)
    message(FATAL_ERROR "Cannot generate typed Dawn procedure table")
endif()
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/dawn-procs.inc" "${PU_DAWN_PROC_LIST}")
add_library(pollyui-dawn-api STATIC "${CMAKE_CURRENT_SOURCE_DIR}/src/webgpu/dawn_api.cpp")
target_include_directories(pollyui-dawn-api PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/src" "${CMAKE_CURRENT_BINARY_DIR}" "${PU_DAWN_ROOT}/include")
target_compile_definitions(pollyui-dawn-api PRIVATE PU_DAWN_HEADER_HASH="${PU_DAWN_HEADER_HASH}")
target_link_libraries(pollyui-dawn-api PUBLIC ${CMAKE_DL_LIBS})
if(WIN32)
    target_link_libraries(pollyui-dawn-api PUBLIC dxgi)
endif()
target_link_libraries(pollyui-engine PRIVATE pollyui-dawn-api)
target_compile_definitions(pollyui-engine PRIVATE PU_WEBGPU)
find_program(PU_WEBGPU_NODE node REQUIRED)
execute_process(COMMAND "${PU_WEBGPU_NODE}" "${CMAKE_SOURCE_DIR}/tools/generate_webgpu_tables.mjs"
    "${PU_DAWN_ROOT}/include/dawn/webgpu.h" "${CMAKE_CURRENT_BINARY_DIR}/webgpu-tables.inc"
    COMMAND_ERROR_IS_FATAL ANY)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/tools/generate_webgpu_tables.mjs" "${CMAKE_CURRENT_SOURCE_DIR}/sdk/webgpu.js")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/sdk/webgpu-enums.json")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/sdk/webgpu.js" PU_WEBGPU_SCRIPT HEX)
string(REGEX REPLACE "(..)" "0x\\1," PU_WEBGPU_SCRIPT "${PU_WEBGPU_SCRIPT}")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/webgpu-script.h"
    "static const unsigned char pu_webgpu_script[] = {${PU_WEBGPU_SCRIPT}0};\n")
add_dependencies(pollyui-engine pollyui-dawn-provider)

if(WIN32)
    foreach(dll IN ITEMS dxcompiler.dll dxil.dll)
        if(NOT EXISTS "${PU_DAWN_ROOT}/runtime/${dll}")
            message(FATAL_ERROR "Missing pinned D3D12 shader compiler: ${PU_DAWN_ROOT}/runtime/${dll}")
        endif()
        add_custom_command(TARGET pollyui-dawn-provider POST_BUILD
            COMMAND "${CMAKE_COMMAND}" -E copy_if_different
                "${PU_DAWN_ROOT}/runtime/${dll}" "$<TARGET_FILE_DIR:pollyui-dawn-provider>/${dll}")
    endforeach()
endif()
install(TARGETS pollyui-dawn-provider
    RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop
    LIBRARY DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
if(WIN32)
    install(FILES
        "${PU_DAWN_ROOT}/runtime/dxcompiler.dll"
        "${PU_DAWN_ROOT}/runtime/dxil.dll"
        DESTINATION "${CMAKE_INSTALL_BINDIR}" COMPONENT PollyDesktop)
endif()
install(DIRECTORY "${PU_DAWN_ROOT}/notices/"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/notices" COMPONENT PollyDesktop)
install(FILES
    "${PU_DAWN_ROOT}/dependency-lock.json"
    "${PU_DAWN_ROOT}/acquisition-receipt.json"
    "${CMAKE_CURRENT_LIST_DIR}/../../third_party/dawn-distribution-ledger.json"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/pollyui/notices" COMPONENT PollyDesktop)

if(BUILD_TESTING)
    add_executable(pollyui-canvas-source-test tests/canvas-source.cpp)
    target_include_directories(pollyui-canvas-source-test PRIVATE src)
    target_link_libraries(pollyui-canvas-source-test PRIVATE pollyui-engine)
    add_test(NAME gui-canvas-source COMMAND pollyui-canvas-source-test)
    set_tests_properties(gui-canvas-source PROPERTIES TIMEOUT 15)
    add_executable(pollyui-webgpu-test tests/webgpu.c)
    target_include_directories(pollyui-webgpu-test PRIVATE src)
    target_link_libraries(pollyui-webgpu-test PRIVATE pollyui-engine)
    add_test(NAME gui-webgpu-compute COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-compute.mjs")
    set_tests_properties(gui-webgpu-compute PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-lifetime COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-lifetime.mjs")
    set_tests_properties(gui-webgpu-lifetime PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-compiler COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-compiler.mjs")
    set_tests_properties(gui-webgpu-compiler PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-texture COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-texture.mjs")
    set_tests_properties(gui-webgpu-texture PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-render COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-render.mjs")
    set_tests_properties(gui-webgpu-render PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-canvas COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-canvas.mjs")
    set_tests_properties(gui-webgpu-canvas PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-canvas-mutation COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-canvas-mutation.mjs")
    set_tests_properties(gui-webgpu-canvas-mutation PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-review COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-review.mjs")
    set_tests_properties(gui-webgpu-review PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-shutdown COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-shutdown.mjs")
    set_tests_properties(gui-webgpu-shutdown PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-frame COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-frame.mjs")
    set_tests_properties(gui-webgpu-frame PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-external COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-external.mjs")
    set_tests_properties(gui-webgpu-external PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-image-transfer COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-image-transfer.mjs")
    set_tests_properties(gui-webgpu-image-transfer PROPERTIES TIMEOUT 45)
    if(PU_WEBGL2)
        add_test(NAME gui-webgpu-coupled-frame COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-coupled-frame.mjs")
        set_tests_properties(gui-webgpu-coupled-frame PROPERTIES TIMEOUT 45)
        if(NOT APPLE)
            set_tests_properties(gui-webgpu-coupled-frame PROPERTIES ENVIRONMENT
                "PU_WEBGPU_DEVICE=software;PU_WEBGL2_DEVICE=software")
        endif()
    endif()
    add_test(NAME gui-webgpu-query COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-query.mjs")
    set_tests_properties(gui-webgpu-query PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-bundle COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-bundle.mjs")
    set_tests_properties(gui-webgpu-bundle PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-immediate COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-immediate.mjs")
    set_tests_properties(gui-webgpu-immediate PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-events COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-events.mjs")
    set_tests_properties(gui-webgpu-events PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-image-formats COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-image-formats.mjs")
    set_tests_properties(gui-webgpu-image-formats PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-color-source COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-color-source.mjs")
    set_tests_properties(gui-webgpu-color-source PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-canvas-hdr COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-canvas-hdr.mjs")
    set_tests_properties(gui-webgpu-canvas-hdr PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-core-shapes COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-core-shapes.mjs")
    set_tests_properties(gui-webgpu-core-shapes PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-core-norm COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-core-norm.mjs")
    set_tests_properties(gui-webgpu-core-norm PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-transient-ordinary COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-core-norm.mjs")
    set_tests_properties(gui-webgpu-transient-ordinary PROPERTIES TIMEOUT 45
        ENVIRONMENT "PU_WEBGPU_TRANSIENT_ALLOCATION=ordinary")
    if(NOT APPLE)
        set_tests_properties(gui-webgpu-transient-ordinary PROPERTIES ENVIRONMENT
            "PU_WEBGPU_TRANSIENT_ALLOCATION=ordinary;PU_WEBGPU_DEVICE=software")
    endif()
    add_test(NAME gui-webgpu-missing-runtime COMMAND "${CMAKE_COMMAND}"
        "-DEXE=$<TARGET_FILE:pollyui-webgpu-test>" "-DDEST=${CMAKE_CURRENT_BINARY_DIR}/missing-provider"
        "-DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-missing-runtime.mjs"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-missing-runtime.cmake")
    set_tests_properties(gui-webgpu-missing-runtime PROPERTIES TIMEOUT 45)
    add_test(NAME gui-webgpu-relocated COMMAND "${CMAKE_COMMAND}"
        "-DEXE=$<TARGET_FILE:pollyui-webgpu-test>" "-DPROVIDER=$<TARGET_FILE:pollyui-dawn-provider>"
        "-DDXC_DIR=${PU_DAWN_ROOT}/runtime" "-DDEST=${CMAKE_CURRENT_BINARY_DIR}/relocated-webgpu"
        "-DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-compute.mjs"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-runtime.cmake")
    set_tests_properties(gui-webgpu-relocated PROPERTIES TIMEOUT 60)
    if(NOT APPLE)
        set_tests_properties(gui-webgpu-relocated PROPERTIES ENVIRONMENT "PU_WEBGPU_DEVICE=software")
    endif()
    foreach(mode IN ITEMS abi header proc)
        set(target "pollyui-webgpu-bad-${mode}-provider")
        add_library(${target} SHARED tests/webgpu-bad-provider.c)
        target_include_directories(${target} PRIVATE src)
        set_target_properties(${target} PROPERTIES OUTPUT_NAME pollyui-dawn-provider
            ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bad-provider-${mode}"
            LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bad-provider-${mode}"
            RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bad-provider-${mode}")
        if(mode STREQUAL "abi")
            target_compile_definitions(${target} PRIVATE PU_TEST_PROVIDER_ABI=3 PU_TEST_PROVIDER_HASH="invalid")
        elseif(mode STREQUAL "header")
            target_compile_definitions(${target} PRIVATE PU_TEST_PROVIDER_ABI=2 PU_TEST_PROVIDER_HASH="invalid")
        else()
            target_compile_definitions(${target} PRIVATE PU_TEST_PROVIDER_ABI=2 PU_TEST_PROVIDER_HASH="${PU_DAWN_HEADER_HASH}")
        endif()
        add_dependencies(pollyui-webgpu-test ${target})
        add_test(NAME gui-webgpu-bad-${mode} COMMAND "${CMAKE_COMMAND}"
            "-DEXE=$<TARGET_FILE:pollyui-webgpu-test>" "-DPROVIDER=$<TARGET_FILE:${target}>"
            "-DDEST=${CMAKE_CURRENT_BINARY_DIR}/isolated-bad-${mode}"
            "-DFIXTURE=${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-missing-runtime.mjs"
            -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-runtime.cmake")
        set_tests_properties(gui-webgpu-bad-${mode} PROPERTIES TIMEOUT 45)
    endforeach()
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/tests/gpu/node_modules/three/build/three.webgpu.js")
        add_test(NAME gui-webgpu-three COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-three.mjs")
        set_tests_properties(gui-webgpu-three PROPERTIES TIMEOUT 90 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        add_test(NAME gui-webgpu-three-scenes COMMAND pollyui-webgpu-test "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-three-scenes.mjs" --frames)
        set_tests_properties(gui-webgpu-three-scenes PROPERTIES TIMEOUT 90 WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}")
        if(NOT APPLE)
            set_tests_properties(gui-webgpu-three gui-webgpu-three-scenes PROPERTIES ENVIRONMENT "PU_WEBGPU_DEVICE=software")
        endif()
        if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND PU_HOST STREQUAL "sdl" AND PU_BUILD_DESKTOP)
            add_test(NAME gui-webgpu-wayland COMMAND sh "${CMAKE_CURRENT_SOURCE_DIR}/tests/canvas-wayland.sh"
                $<TARGET_FILE:pollyui-canvas-wayland-test> $<TARGET_FILE:pollyui-playground>
                "${CMAKE_CURRENT_SOURCE_DIR}/tests/webgpu-window.mjs" gpu)
            set_tests_properties(gui-webgpu-wayland PROPERTIES TIMEOUT 45
                WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}" ENVIRONMENT "PU_WEBGPU_DEVICE=software")
        endif()
    endif()
    if(NOT APPLE)
        set_tests_properties(gui-webgpu-compute gui-webgpu-lifetime gui-webgpu-compiler gui-webgpu-texture gui-webgpu-render gui-webgpu-canvas gui-webgpu-canvas-mutation gui-webgpu-review gui-webgpu-shutdown gui-webgpu-external gui-webgpu-image-transfer gui-webgpu-query gui-webgpu-bundle gui-webgpu-immediate gui-webgpu-events gui-webgpu-image-formats gui-webgpu-color-source gui-webgpu-canvas-hdr gui-webgpu-core-shapes gui-webgpu-core-norm
            PROPERTIES ENVIRONMENT "PU_WEBGPU_DEVICE=software")
    endif()
    set_property(TEST gui-webgpu-core-norm APPEND PROPERTY ENVIRONMENT "PU_WEBGPU_TRANSIENT_ALLOCATION=native" "PU_WEBGPU_TRACE_TRANSIENT=1")
    set_property(TEST gui-webgpu-transient-ordinary APPEND PROPERTY ENVIRONMENT "PU_WEBGPU_TRACE_TRANSIENT=1")
    add_executable(pollyui-webgpu-native-test tests/webgpu-native.cpp)
    target_link_libraries(pollyui-webgpu-native-test PRIVATE pollyui-dawn-api)
    add_dependencies(pollyui-webgpu-native-test pollyui-dawn-provider)
    add_test(NAME gui-webgpu-native-software COMMAND pollyui-webgpu-native-test --software)
    set_tests_properties(gui-webgpu-native-software PROPERTIES TIMEOUT 45 SKIP_RETURN_CODE 77)
    add_test(NAME gui-webgpu-native-hardware COMMAND pollyui-webgpu-native-test --hardware)
    set_tests_properties(gui-webgpu-native-hardware PROPERTIES TIMEOUT 45 SKIP_RETURN_CODE 77)
endif()
