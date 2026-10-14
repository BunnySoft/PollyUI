foreach(argument IN ITEMS PU_DAWN_MANIFEST PU_DAWN_DEST PU_DAWN_PLATFORM)
    if(NOT DEFINED ${argument})
        message(FATAL_ERROR "Dawn acquisition receipt: missing ${argument}")
    endif()
endforeach()

file(READ "${PU_DAWN_MANIFEST}" receipt_manifest)
string(JSON receipt_repository GET "${receipt_manifest}" repository)
string(JSON receipt_tag GET "${receipt_manifest}" tag)
string(JSON receipt_commit GET "${receipt_manifest}" commit)
string(JSON receipt_archive GET "${receipt_manifest}" archives "${PU_DAWN_PLATFORM}" file)
string(JSON receipt_archive_digest GET "${receipt_manifest}" archives "${PU_DAWN_PLATFORM}" sha256)
string(JSON receipt_library GET "${receipt_manifest}" archives "${PU_DAWN_PLATFORM}" library)
string(JSON receipt_library_digest GET "${receipt_manifest}" archives "${PU_DAWN_PLATFORM}" librarySha256)
string(JSON receipt_header_digest GET "${receipt_manifest}" header sha256)
string(JSON receipt_notice_complete GET "${receipt_manifest}" noticeCoverage complete)
string(JSON receipt_redistribution_status GET "${receipt_manifest}" redistributionStatus)
string(JSON receipt_deployment_status GET "${receipt_manifest}" redistributionReview platforms "${PU_DAWN_PLATFORM}" deploymentDecision)
string(JSON receipt_rights_status GET "${receipt_manifest}" redistributionReview platforms "${PU_DAWN_PLATFORM}" rightsConfirmation)

if(receipt_notice_complete)
    set(receipt_notice_complete_json true)
else()
    set(receipt_notice_complete_json false)
endif()

file(WRITE "${PU_DAWN_DEST}/acquisition-receipt.json"
    "{\n"
    "  \"repository\": \"${receipt_repository}\",\n"
    "  \"tag\": \"${receipt_tag}\",\n"
    "  \"commit\": \"${receipt_commit}\",\n"
    "  \"platform\": \"${PU_DAWN_PLATFORM}\",\n"
    "  \"archive\": \"${receipt_archive}\",\n"
    "  \"archiveSha256\": \"${receipt_archive_digest}\",\n"
    "  \"library\": \"${receipt_library}\",\n"
    "  \"librarySha256\": \"${receipt_library_digest}\",\n"
    "  \"headerSha256LfNormalized\": \"${receipt_header_digest}\",\n"
    "  \"noticeCoverageComplete\": ${receipt_notice_complete_json},\n"
    "  \"redistributionStatus\": \"${receipt_redistribution_status}\",\n"
    "  \"deploymentDecisionStatus\": \"${receipt_deployment_status}\",\n"
    "  \"rightsConfirmationStatus\": \"${receipt_rights_status}\"\n"
    "}\n")
