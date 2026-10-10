#ifndef PU_SYSTEMRT_QUICKJS_FILES_H
#define PU_SYSTEMRT_QUICKJS_FILES_H

#include "quickjs.h"
#include "sysrt/providers/linux/files.h"

int pu_files_install(JSContext *ctx, JSValueConst api);

#endif
