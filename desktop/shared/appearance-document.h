#ifndef POLLY_APPEARANCE_DOCUMENT_H
#define POLLY_APPEARANCE_DOCUMENT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

int pu_appearance_document_create(const char *bytes, size_t length);
bool pu_appearance_document_valid(int fd, uint32_t length);
char *pu_appearance_document_read(int fd, uint32_t length);
#endif
