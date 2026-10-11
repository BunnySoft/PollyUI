if (NOT DEFINED SOURCE_ROOT OR NOT DEFINED OUTPUT_FILE)
    message(FATAL_ERROR "Runtime build identity requires source and output paths")
endif()

file(READ "${SOURCE_ROOT}/desktop/VERSION" PU_RUNTIME_VERSION)
string(STRIP "${PU_RUNTIME_VERSION}" PU_RUNTIME_VERSION)
if (NOT PU_RUNTIME_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+(-[A-Za-z0-9.+-]+)?$")
    message(FATAL_ERROR "Invalid runtime version in desktop/VERSION")
endif()

set(PU_RUNTIME_REVISION "unknown")
set(PU_RUNTIME_SOURCE_DIRTY -1)
if (GIT_EXECUTABLE AND EXISTS "${GIT_EXECUTABLE}")
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -c "safe.directory=${SOURCE_ROOT}"
            -C "${SOURCE_ROOT}" rev-parse HEAD
        RESULT_VARIABLE revision_status
        OUTPUT_VARIABLE revision
        ERROR_QUIET OUTPUT_STRIP_TRAILING_WHITESPACE)
    string(LENGTH "${revision}" revision_length)
    if (revision_status EQUAL 0 AND revision_length EQUAL 40 AND revision MATCHES "^[0-9a-f]+$")
        set(PU_RUNTIME_REVISION "${revision}")
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" -c "safe.directory=${SOURCE_ROOT}"
                -C "${SOURCE_ROOT}" status --porcelain --untracked-files=normal
            RESULT_VARIABLE dirty_status
            OUTPUT_VARIABLE changes
            ERROR_QUIET OUTPUT_STRIP_TRAILING_WHITESPACE)
        if (dirty_status EQUAL 0)
            if (changes STREQUAL "")
                set(PU_RUNTIME_SOURCE_DIRTY 0)
            else()
                set(PU_RUNTIME_SOURCE_DIRTY 1)
            endif()
        endif()
    endif()
endif()
if (PU_RUNTIME_REVISION STREQUAL "unknown" OR PU_RUNTIME_SOURCE_DIRTY EQUAL -1)
    message(STATUS "Runtime Git identity is unavailable; application metadata will report unknown")
endif()

get_filename_component(output_directory "${OUTPUT_FILE}" DIRECTORY)
file(MAKE_DIRECTORY "${output_directory}")
configure_file("${SOURCE_ROOT}/desktop/launcher/build-info.h.in" "${OUTPUT_FILE}" @ONLY)
