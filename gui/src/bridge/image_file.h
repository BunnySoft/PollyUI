#ifndef POLLYUI_IMAGE_FILE_H
#define POLLYUI_IMAGE_FILE_H
#include <stddef.h>
#include <stdint.h>
/* Files use the same process permissions as ScriptEngine resources.
 * Reject special files before any potentially blocking read. No network URLs. */
char *pu_image_absolute_path(const char *path);
int pu_image_read_file(const char *path, uint8_t **bytes, size_t *length);
#endif
