#ifndef PU_DESKTOP_DOCUMENTS_H
#define PU_DESKTOP_DOCUMENTS_H

#include "quickjs.h"
#include <stdbool.h>
#include <stddef.h>

int pu_documents_install(JSContext *ctx, JSValue api);
bool pu_document_uri_valid(const char *uri, size_t size);

#endif
