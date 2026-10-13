#include "bridge/image_file.h"
#include "render/canvas_c.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#ifdef _WIN32
#include <windows.h>
static wchar_t *wide_path(const char *path)
{
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
    if (!count)
        return NULL;
    wchar_t *wide = malloc((size_t)count * sizeof(*wide));
    if (wide && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, count)) {
        free(wide);
        return NULL;
    }
    return wide;
}
char *pu_image_absolute_path(const char *path)
{
    if (!path || !*path || (path[0] == '\\' && path[1] == '\\') ||
        (path[0] == '/' && path[1] == '/'))
        return NULL;
    wchar_t *input = wide_path(path);
    if (!input)
        return NULL;
    DWORD count = GetFullPathNameW(input, 0, NULL, NULL);
    wchar_t *absolute = count ? malloc((size_t)count * sizeof(*absolute)) : NULL;
    DWORD written = absolute ? GetFullPathNameW(input, count, absolute, NULL) : 0;
    free(input);
    if (!written || written >= count || absolute[0] == '\\') {
        free(absolute);
        return NULL;
    }
    for (const wchar_t *p = absolute + 3; *p; ++p)
        if (*p == L':') {
            free(absolute);
            return NULL;
        }
    for (const wchar_t *part = absolute + 3; *part;) {
        while (*part == L'\\' || *part == L'/')
            ++part;
        const wchar_t *end = part;
        while (*end && *end != L'\\' && *end != L'/')
            ++end;
        const wchar_t *name_end = end;
        while (name_end > part && (name_end[-1] == L' ' || name_end[-1] == L'.'))
            --name_end;
        wchar_t name[5] = {0};
        size_t length = 0;
        for (const wchar_t *p = part; p < name_end && *p != L'.' && length < 5; ++p) {
            if (*p == L':') {
                free(absolute);
                return NULL;
            }
            name[length++] = (*p >= L'a' && *p <= L'z') ? *p - L'a' + L'A' : *p;
        }
        if ((length == 3 && (!wmemcmp(name, L"NUL", 3) || !wmemcmp(name, L"CON", 3) ||
                             !wmemcmp(name, L"PRN", 3) || !wmemcmp(name, L"AUX", 3))) ||
            (length == 4 && (!wmemcmp(name, L"COM", 3) || !wmemcmp(name, L"LPT", 3)) &&
             name[3] >= L'1' && name[3] <= L'9')) {
            free(absolute);
            return NULL;
        }
        size_t at = (size_t)(end - absolute);
        wchar_t saved = absolute[at];
        absolute[at] = 0;
        DWORD attributes = GetFileAttributesW(absolute);
        absolute[at] = saved;
        if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
            free(absolute);
            return NULL;
        }
        part = end;
    }
    wchar_t drive[] = {absolute[0], L':', L'\\', 0};
    if (GetDriveTypeW(drive) == DRIVE_REMOTE) {
        free(absolute);
        return NULL;
    }
    int bytes =
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, absolute, -1, NULL, 0, NULL, NULL);
    char *result = bytes ? malloc((size_t)bytes) : NULL;
    if (result && !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, absolute, -1, result, bytes,
                                       NULL, NULL)) {
        free(result);
        result = NULL;
    }
    free(absolute);
    return result;
}
int pu_image_read_file(const char *path, uint8_t **bytes, size_t *length)
{
    wchar_t *wide = wide_path(path);
    if (!wide)
        return 0;
    HANDLE file =
        CreateFileW(wide, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    free(wide);
    if (file == INVALID_HANDLE_VALUE)
        return 0;
    LARGE_INTEGER size;
    if (GetFileType(file) != FILE_TYPE_DISK || !GetFileSizeEx(file, &size) || size.QuadPart <= 0 ||
        size.QuadPart > PU_IMAGE_BYTE_LIMIT) {
        CloseHandle(file);
        return 0;
    }
    uint8_t *copy = malloc((size_t)size.QuadPart);
    if (!copy) {
        CloseHandle(file);
        return 0;
    }
    DWORD read = 0;
    int ok =
        ReadFile(file, copy, (DWORD)size.QuadPart, &read, NULL) && read == (DWORD)size.QuadPart;
    CloseHandle(file);
    if (!ok) {
        free(copy);
        return 0;
    }
    *bytes = copy;
    *length = (size_t)read;
    return 1;
}
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
char *pu_image_absolute_path(const char *path)
{
    if (!path || !*path || (path[0] == '/' && path[1] == '/'))
        return NULL;
    char cwd[4096];
    if (!getcwd(cwd, sizeof(cwd)))
        return NULL;
    size_t length = strlen(cwd) + strlen(path) + 2;
    char *absolute = malloc(length), *result = malloc(length);
    if (!absolute || !result) {
        free(absolute);
        free(result);
        return NULL;
    }
    snprintf(absolute, length, path[0] == '/' ? "%s%s" : "%s/%s", path[0] == '/' ? "" : cwd, path);
    size_t output = 0;
    for (char *part = absolute; *part;) {
        while (*part == '/')
            ++part;
        char *end = part;
        while (*end && *end != '/')
            ++end;
        size_t size = (size_t)(end - part);
        if (size == 1 && part[0] == '.') {
        } else if (size == 2 && part[0] == '.' && part[1] == '.') {
            while (output && result[output - 1] != '/')
                --output;
            if (output)
                --output;
        } else if (size) {
            result[output++] = '/';
            memcpy(result + output, part, size);
            output += size;
        }
        part = end;
    }
    if (!output)
        result[output++] = '/';
    result[output] = 0;
    free(absolute);
    return result;
}
int pu_image_read_file(const char *path, uint8_t **bytes, size_t *length)
{
    struct stat before;
    if (stat(path, &before) || !S_ISREG(before.st_mode))
        return 0;
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0)
        return 0;
    struct stat info;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
        info.st_size > PU_IMAGE_BYTE_LIMIT) {
        close(fd);
        return 0;
    }
    size_t size = (size_t)info.st_size, offset = 0;
    uint8_t *copy = malloc(size);
    if (!copy) {
        close(fd);
        return 0;
    }
    while (offset < size) {
        ssize_t count = read(fd, copy + offset, size - offset);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0) {
            free(copy);
            close(fd);
            return 0;
        }
        offset += (size_t)count;
    }
    close(fd);
    *bytes = copy;
    *length = size;
    return 1;
}
#endif
