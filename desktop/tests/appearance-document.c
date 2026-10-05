#define _GNU_SOURCE
#include "appearance-document.h"
#include "appearance-config.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

#define CHECK(value) do { if (!(value)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #value); return 1; } } while (0)

int main(void)
{
    char bytes[PU_APPEARANCE_DOCUMENT_LIMIT];
    memset(bytes, 'x', sizeof(bytes));
    int fd = pu_appearance_document_create(bytes, sizeof(bytes));
    CHECK(fd >= 0 && pu_appearance_document_valid(fd, sizeof(bytes)));
    CHECK(!pu_appearance_document_valid(fd, sizeof(bytes) - 1));
    CHECK(!pu_appearance_document_valid(fd, sizeof(bytes) + 1));
    CHECK(pwrite(fd, "y", 1, 0) < 0 && errno == EPERM);
    CHECK(ftruncate(fd, sizeof(bytes) - 1) < 0 && errno == EPERM);
    CHECK(ftruncate(fd, sizeof(bytes) + 1) < 0 && errno == EPERM);
    char *copy = pu_appearance_document_read(fd, sizeof(bytes));
    CHECK(copy && !memcmp(copy, bytes, sizeof(bytes)) && !copy[sizeof(bytes)]);
    free(copy); close(fd);
    CHECK(pu_appearance_document_create(bytes, sizeof(bytes) + 1) < 0);
    CHECK(pu_appearance_document_create(bytes, 0) < 0);
    fd = memfd_create("unsealed-theme-test", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    CHECK(fd >= 0 && write(fd, "x", 1) == 1);
    CHECK(!pu_appearance_document_valid(fd, 1));
    close(fd);
    int pipes[2];
    CHECK(pipe(pipes) == 0);
    CHECK(!pu_appearance_document_valid(pipes[0], 1));
    close(pipes[0]); close(pipes[1]);
    bytes[0] = 0;
    CHECK(pu_appearance_document_create(bytes, sizeof(bytes)) < 0);
    puts("PASS: large immutable appearance descriptors, size validation and nonblocking rejection");
    return 0;
}
