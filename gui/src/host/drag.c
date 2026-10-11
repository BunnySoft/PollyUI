#include "host/drag_internal.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char error[192];
int pu_drag_fail(const char *message)
{
    snprintf(error, sizeof(error), "%s", message);
    fprintf(stderr, "[drag] %s\n", error);
    return 0;
}
const char *pu_drag_error(void)
{
    return error;
}
PuDragOwner *pu_drag_owner_new(PuWindow *window)
{
    PuDragOwner *owner = calloc(1, sizeof(*owner));
    if (!owner)
    {
        pu_drag_fail("Cannot allocate native drag owner");
        return NULL;
    }
    owner->references = 1;
    owner->open = 1;
    owner->window = window;
    return owner;
}
void pu_drag_owner_unref(PuDragOwner *owner)
{
    if (owner && !--owner->references)
        free(owner);
}
void pu_drag_input_ref(PuDragInput *input)
{
    if (input)
        input->references++;
}
void pu_drag_input_unref(PuDragInput *input)
{
    if (input && !--input->references)
    {
        pu_drag_owner_unref(input->owner);
        free(input);
    }
}
void pu_drag_invalidate(PuDragOwner *owner)
{
    if (owner && owner->input)
    {
        owner->input->valid = 0;
        pu_drag_input_unref(owner->input);
        owner->input = NULL;
    }
}
void pu_drag_owner_close(PuDragOwner *owner)
{
    if (!owner)
        return;
    owner->open = 0;
    owner->window = NULL;
    owner->native = NULL;
    pu_drag_invalidate(owner);
}
PuDragInput *pu_drag_input_new(PuDragOwner *owner, void *seat, uint32_t serial)
{
    pu_drag_invalidate(owner);
    PuDragInput *input = calloc(1, sizeof(*input));
    if (!input)
    {
        pu_drag_fail("Cannot allocate native input credential");
        return NULL;
    }
    owner->references++;
    input->references = 1;
    input->owner = owner;
    input->seat = seat;
    input->serial = serial;
    input->valid = 1;
    owner->input = input;
    return input;
}
static int utf8(const unsigned char *s, size_t size)
{
    for (size_t i = 0; i < size;)
    {
        unsigned c = s[i++], n, min;
        if (!c)
            return 0;
        if (c < 0x80)
            continue;
        if (c >= 0xc2 && c <= 0xdf)
        {
            n = 1;
            min = 0x80;
            c &= 31;
        }
        else if (c >= 0xe0 && c <= 0xef)
        {
            n = 2;
            min = 0x800;
            c &= 15;
        }
        else if (c >= 0xf0 && c <= 0xf4)
        {
            n = 3;
            min = 0x10000;
            c &= 7;
        }
        else
            return 0;
        if (n > size - i)
            return 0;
        while (n--)
        {
            unsigned b = s[i++];
            if ((b & 0xc0) != 0x80)
                return 0;
            c = (c << 6) | (b & 63);
        }
        if (c < min || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff))
            return 0;
    }
    return 1;
}
static void free_session(PuDragSession *session)
{
    for (size_t i = 0; i < session->count; i++)
    {
        free((void *)session->items[i].type);
        free((void *)session->items[i].data);
    }
    free(session->items);
    pu_drag_owner_unref(session->owner);
    free(session);
}
PuDragSession *pu_drag_copy(
    PuDragOwner *owner, PuDragInput *input, const PuDragItem *items, size_t count, PuDragFn callback, void *user)
{
    if (!owner || !owner->open || !input || input->owner != owner || !input->valid || input->used
        || input != owner->input)
    {
        pu_drag_fail("Drag requires this window's unused, current native held press");
        return NULL;
    }
    if (!items || !count || count > SIZE_MAX / sizeof(*items))
    {
        pu_drag_fail("Drag requires a nonempty MIME item array");
        return NULL;
    }
    PuDragSession *session = calloc(1, sizeof(*session));
    if (!session)
    {
        pu_drag_fail("Cannot allocate drag session");
        return NULL;
    }
    session->items = calloc(count, sizeof(*items));
    if (!session->items)
    {
        free(session);
        pu_drag_fail("Cannot allocate drag items");
        return NULL;
    }
    session->owner = owner;
    owner->references++;
    session->references = 2;
    session->callback = callback;
    session->user = user;
    for (size_t i = 0; i < count; i++)
    {
        if (!items[i].type || (!items[i].data && items[i].size) || items[i].size == SIZE_MAX)
            goto invalid;
        size_t length = strlen(items[i].type);
        /* Wayland messages have a 16-bit byte length; this is wire safety, not
         * a payload/business quota. Payload bytes travel over file descriptors. */
        if (!length || length > 65500 || !strchr(items[i].type, '/'))
            goto invalid;
        for (size_t j = 0; j < length; j++)
            if ((unsigned char)items[i].type[j] < 33 || (unsigned char)items[i].type[j] > 126)
                goto invalid;
        for (size_t j = 0; j < i; j++)
            if (!strcmp(items[i].type, items[j].type))
                goto invalid;
        if (!strncmp(items[i].type, "text/plain", 10) && (!items[i].type[10] || items[i].type[10] == ';')
            && !utf8(items[i].data, items[i].size))
            goto invalid;
        char *type = malloc(length + 1);
        unsigned char *bytes = malloc(items[i].size + 1);
        if (!type || !bytes)
        {
            free(type);
            free(bytes);
            free_session(session);
            pu_drag_fail("Cannot copy native drag payload");
            return NULL;
        }
        memcpy(type, items[i].type, length + 1);
        if (items[i].size)
            memcpy(bytes, items[i].data, items[i].size);
        bytes[items[i].size] = 0;
        session->items[session->count++] = (PuDragItem) { type, bytes, items[i].size };
    }
    return session;
invalid:
    free_session(session);
    pu_drag_fail("Invalid, duplicate MIME item or invalid UTF-8/NUL text");
    return NULL;
}
void pu_drag_finish(PuDragSession *session, PuDragStatus status, const char *reason)
{
    if (session->status != PU_DRAG_PENDING)
        return;
    session->status = status;
    if (reason)
        snprintf(session->reason, sizeof(session->reason), "%s", reason);
    if (status == PU_DRAG_ERROR)
        fprintf(stderr, "[drag] %s\n", session->reason);
}
void pu_drag_set_callback(PuDragSession *session, PuDragFn callback, void *user)
{
    if (session)
    {
        session->callback = callback;
        session->user = user;
    }
}
void pu_drag_cancel(PuDragSession *session)
{
    /* Native worker state is protected by the backend; cancellation is queued
     * through the UI-side session flag, consumed only at a pump boundary. */
    if (session && session->status == PU_DRAG_PENDING)
        session->cancel_requested = 1;
}
void pu_drag_release(PuDragSession *session)
{
    if (!session)
        return;
    pu_drag_cancel(session);
    if (!--session->references)
        free_session(session);
}
void pu_drag_deliver(PuDragSession *session)
{
    PuDragFn callback = session->callback;
    session->callback = NULL;
    PuDragResult result = { session->status, *session->reason ? session->reason : NULL };
    if (callback)
        callback(&result, session->user);
    if (!--session->references)
        free_session(session);
}
