file(MAKE_DIRECTORY "${DEST}")
get_filename_component(name "${EXE}" NAME)
file(COPY_FILE "${EXE}" "${DEST}/${name}" ONLY_IF_DIFFERENT)
execute_process(COMMAND "${DEST}/${name}" "${FIXTURE}" RESULT_VARIABLE result
    OUTPUT_VARIABLE output ERROR_VARIABLE error TIMEOUT 30)
message("${output}${error}")
if(NOT result EQUAL 0)
    message(FATAL_ERROR "Missing-provider real runtime regression failed: ${result}")
endif()
