#include "render/gpu_canvas_internal.h"
#include "render/canvas_c.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <new>
#ifdef PU_WEBGL2
static size_t live_contexts;
size_t pu_gpu_canvas_live_contexts() { return live_contexts; }
void pu_gpu_error(PuGpuCanvas* c, GLenum error)
{
    c->command_error = true;
    if (!error)
        return;
    for (unsigned i = 0; i < c->error_count; ++i)
        if (c->errors[i] == error)
            return;
    if (c->error_count < 6)
        c->errors[c->error_count++] = error;
}
static bool target_resize(PuGpuCanvas* c, int w, int h)
{
    auto gl = pu_gles();
    GLint draw, read, texture, renderbuffer, unpack_buffer, unpack[6];
    gl->GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
    gl->GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
    gl->GetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
    gl->GetIntegerv(GL_RENDERBUFFER_BINDING, &renderbuffer);
    const GLenum stores[] = { GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS,
        GL_UNPACK_SKIP_PIXELS, GL_UNPACK_IMAGE_HEIGHT, GL_UNPACK_SKIP_IMAGES };
    gl->GetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpack_buffer);
    for (int i = 0; i < 6; ++i) {
        gl->GetIntegerv(stores[i], unpack + i);
        gl->PixelStorei(stores[i], i == 0 ? 1 : 0);
    }
    gl->BindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
    bool old_draw = (GLuint)draw == c->framebuffer, old_read = (GLuint)read == c->framebuffer;
    GLuint fbo = 0, color = 0, depth = 0;
    gl->GenFramebuffers(1, &fbo);
    gl->GenTextures(1, &color);
    gl->BindTexture(GL_TEXTURE_2D, color);
    gl->TexImage2D(GL_TEXTURE_2D, 0, c->alpha ? c->storage_format : GL_RGB8, std::max(w, 1),
        std::max(h, 1), 0, c->alpha ? GL_RGBA : GL_RGB, GL_UNSIGNED_BYTE, nullptr);
    gl->TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    gl->TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    gl->BindFramebuffer(GL_FRAMEBUFFER, fbo);
    gl->FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
    if (c->depth || c->stencil) {
        gl->GenRenderbuffers(1, &depth);
        gl->BindRenderbuffer(GL_RENDERBUFFER, depth);
        GLenum format = c->depth && c->stencil ? GL_DEPTH24_STENCIL8
            : c->depth                         ? GL_DEPTH_COMPONENT24
                                               : GL_STENCIL_INDEX8;
        GLenum attachment = c->depth && c->stencil ? GL_DEPTH_STENCIL_ATTACHMENT
            : c->depth                             ? GL_DEPTH_ATTACHMENT
                                                   : GL_STENCIL_ATTACHMENT;
        gl->RenderbufferStorage(GL_RENDERBUFFER, format, std::max(w, 1), std::max(h, 1));
        gl->FramebufferRenderbuffer(GL_FRAMEBUFFER, attachment, GL_RENDERBUFFER, depth);
    }
    bool ok = gl->CheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    GLboolean scissor = gl->IsEnabled(GL_SCISSOR_TEST), mask[4], depth_mask;
    GLint front_mask, back_mask, stencil_clear;
    GLfloat clear[4], depth_clear;
    gl->GetBooleanv(GL_COLOR_WRITEMASK, mask);
    gl->GetBooleanv(GL_DEPTH_WRITEMASK, &depth_mask);
    gl->GetIntegerv(GL_STENCIL_WRITEMASK, &front_mask);
    gl->GetIntegerv(GL_STENCIL_BACK_WRITEMASK, &back_mask);
    gl->GetIntegerv(GL_STENCIL_CLEAR_VALUE, &stencil_clear);
    gl->GetFloatv(GL_COLOR_CLEAR_VALUE, clear);
    gl->GetFloatv(GL_DEPTH_CLEAR_VALUE, &depth_clear);
    gl->Disable(GL_SCISSOR_TEST);
    gl->ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    gl->DepthMask(GL_TRUE);
    gl->StencilMask(~0u);
    gl->ClearColor(0, 0, 0, c->alpha ? 0.f : 1.f);
    gl->ClearDepthf(1);
    gl->ClearStencil(0);
    gl->Clear(GL_COLOR_BUFFER_BIT | (c->depth ? GL_DEPTH_BUFFER_BIT : 0)
        | (c->stencil ? GL_STENCIL_BUFFER_BIT : 0));
    if (scissor)
        gl->Enable(GL_SCISSOR_TEST);
    gl->ColorMask(mask[0], mask[1], mask[2], mask[3]);
    gl->DepthMask(depth_mask);
    gl->StencilMaskSeparate(GL_FRONT, front_mask);
    gl->StencilMaskSeparate(GL_BACK, back_mask);
    gl->ClearColor(clear[0], clear[1], clear[2], clear[3]);
    gl->ClearDepthf(depth_clear);
    gl->ClearStencil(stencil_clear);
    GLenum error = gl->GetError();
    if (error != GL_NO_ERROR) {
        pu_gpu_error(c, error);
        ok = false;
    }
    if (ok) {
        if (c->framebuffer) {
            // Keep the virtual default framebuffer's readBuffer/drawBuffers state across resize.
            gl->BindFramebuffer(GL_FRAMEBUFFER, c->framebuffer);
            gl->FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
            if (c->depth || c->stencil)
                gl->FramebufferRenderbuffer(GL_FRAMEBUFFER,
                    c->depth && c->stencil ? GL_DEPTH_STENCIL_ATTACHMENT
                        : c->depth         ? GL_DEPTH_ATTACHMENT
                                           : GL_STENCIL_ATTACHMENT,
                    GL_RENDERBUFFER, depth);
            gl->DeleteFramebuffers(1, &fbo);
            fbo = c->framebuffer;
            gl->DeleteTextures(1, &c->color);
            gl->DeleteRenderbuffers(1, &c->depth_stencil);
        }
        c->framebuffer = fbo;
        c->color = color;
        c->depth_stencil = depth;
        c->width = w;
        c->height = h;
        ++c->revision;
    } else {
        gl->DeleteFramebuffers(1, &fbo);
        gl->DeleteTextures(1, &color);
        gl->DeleteRenderbuffers(1, &depth);
    }
    gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, old_draw ? c->framebuffer : draw);
    gl->BindFramebuffer(GL_READ_FRAMEBUFFER, old_read ? c->framebuffer : read);
    gl->BindTexture(GL_TEXTURE_2D, texture);
    gl->BindRenderbuffer(GL_RENDERBUFFER, renderbuffer);
    for (int i = 0; i < 6; ++i)
        gl->PixelStorei(stores[i], unpack[i]);
    gl->BindBuffer(GL_PIXEL_UNPACK_BUFFER, unpack_buffer);
    return ok;
}
bool pu_gpu_restore(PuGpuCanvas* c)
{
    if (c->closed || !pu_gpu_device_open(&c->device))
        return false;
    PuGpuCurrent current(&c->device);
    if (!current.ok())
        return false;
    auto gl = pu_gles();
    gl->GetIntegerv(GL_MAX_VERTEX_ATTRIBS, &c->max_attributes);
    gl->GetIntegerv(GL_MAX_TEXTURE_SIZE, &c->max_texture);
    gl->GetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS, &c->max_units);
    c->textures.resize(c->max_units);
    c->vaos[0].attributes.resize(c->max_attributes);
    c->attribute_types.assign(c->max_attributes, GL_FLOAT);
    if (c->width > c->max_texture || c->height > c->max_texture
        || !target_resize(c, c->width, c->height)) {
        pu_gpu_device_close(&c->device);
        return false;
    }
    c->lost = false;
    gl->BindFramebuffer(GL_FRAMEBUFFER, c->framebuffer);
    gl->Enable(GL_PRIMITIVE_RESTART_FIXED_INDEX);
    gl->Viewport(0, 0, c->width, c->height);
    ++live_contexts;
    return true;
}
PuGpuCanvas* pu_gpu_canvas_create(
    int w, int h, int alpha, int depth, int stencil, int premultiplied, int preserve)
{
    auto c = new (std::nothrow) PuGpuCanvas;
    if (!c)
        return nullptr;
    c->width = w;
    c->height = h;
    c->alpha = alpha != 0;
    c->depth = depth != 0;
    c->stencil = stencil != 0;
    c->premultiplied = premultiplied != 0;
    c->preserve = preserve != 0;
    if (!pu_gpu_restore(c)) {
        pu_gpu_device_close(&c->device);
        delete c;
        return nullptr;
    }
    return c;
}
void pu_gpu_canvas_ref(PuGpuCanvas* c)
{
    if (c)
        ++c->refs;
}
void pu_gpu_canvas_close(PuGpuCanvas* c)
{
    if (!c || c->lost)
        return;
    c->lost = true;
    ++c->generation;
    ++c->revision;
    // Destroying the context releases every name, including deleted-but-bound objects.
    pu_gpu_device_close(&c->device);
    c->framebuffer = c->color = c->depth_stencil = 0;
    c->buffers.clear();
    c->vaos.clear();
    c->textures.clear();
    c->links.clear();
    c->resources.clear();
    c->uniform_buffers.clear();
    c->feedbacks.clear();
    c->queries.clear();
    c->feedback = 0;
    c->feedback_active = c->feedback_paused = false;
    c->draw_framebuffer.reset();
    c->read_framebuffer.reset();
    c->renderbuffer.reset();
    c->current_program.reset();
    c->allocated = 0;
    c->vao = c->program = c->active_texture = 0;
    c->error_count = 0;
    --live_contexts;
}
void pu_gpu_canvas_unref(PuGpuCanvas* c)
{
    if (c && !--c->refs) {
        pu_gpu_canvas_close(c);
        delete c;
    }
}
int pu_gpu_canvas_lost(PuGpuCanvas* c) { return !c || c->lost; }
uint64_t pu_gpu_canvas_revision(PuGpuCanvas* c) { return c ? c->revision : 0; }
int pu_gpu_canvas_resize(PuGpuCanvas* c, int w, int h)
{
    if (!c || w < 0 || h < 0 || (h && (size_t)w > PU_CANVAS_PIXEL_LIMIT / (size_t)h))
        return 0;
    if (c->lost) {
        c->width = w;
        c->height = h;
        ++c->revision;
        return 1;
    }
    if (w > c->max_texture || h > c->max_texture)
        return 0;
    PuGpuCurrent current(&c->device);
    return current.ok() && target_resize(c, w, h);
}
int pu_gpu_canvas_read(PuGpuCanvas* c, uint8_t* rgba, size_t length)
{
    if (!c || length != (size_t)c->width * c->height * 4)
        return 0;
    if (!length)
        return 1;
    if (c->lost) {
        memset(rgba, 0, length);
        return 1;
    }
    PuGpuCurrent current(&c->device);
    if (!current.ok())
        return 0;
    auto gl = pu_gles();
    GLint read, pack, alignment, row, skip_rows, skip_pixels, read_buffer;
    gl->GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
    gl->GetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &pack);
    gl->GetIntegerv(GL_PACK_ALIGNMENT, &alignment);
    gl->GetIntegerv(GL_PACK_ROW_LENGTH, &row);
    gl->GetIntegerv(GL_PACK_SKIP_ROWS, &skip_rows);
    gl->GetIntegerv(GL_PACK_SKIP_PIXELS, &skip_pixels);
    gl->BindFramebuffer(GL_READ_FRAMEBUFFER, c->framebuffer);
    gl->GetIntegerv(GL_READ_BUFFER, &read_buffer);
    gl->ReadBuffer(GL_COLOR_ATTACHMENT0);
    gl->BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    gl->PixelStorei(GL_PACK_ALIGNMENT, 1);
    gl->PixelStorei(GL_PACK_ROW_LENGTH, 0);
    gl->PixelStorei(GL_PACK_SKIP_ROWS, 0);
    gl->PixelStorei(GL_PACK_SKIP_PIXELS, 0);
    gl->ReadPixels(0, 0, c->width, c->height, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
    GLenum error = gl->GetError();
    gl->PixelStorei(GL_PACK_ALIGNMENT, alignment);
    gl->PixelStorei(GL_PACK_ROW_LENGTH, row);
    gl->PixelStorei(GL_PACK_SKIP_ROWS, skip_rows);
    gl->PixelStorei(GL_PACK_SKIP_PIXELS, skip_pixels);
    gl->BindBuffer(GL_PIXEL_PACK_BUFFER, pack);
    gl->ReadBuffer(read_buffer);
    gl->BindFramebuffer(GL_READ_FRAMEBUFFER, read);
    if (error) {
        pu_gpu_error(c, error);
        return 0;
    }
    size_t stride = (size_t)c->width * 4;
    for (int y = 0; y < c->height / 2; ++y)
        for (size_t x = 0; x < stride; ++x)
            std::swap(rgba[(size_t)y * stride + x], rgba[(size_t)(c->height - y - 1) * stride + x]);
    for (size_t i = 0; i < length; i += 4) {
        if (!c->alpha)
            rgba[i + 3] = 255;
        else if (c->premultiplied) {
            unsigned a = rgba[i + 3];
            for (int channel = 0; channel < 3; ++channel)
                rgba[i + channel]
                    = a ? (uint8_t)std::min(255u, (rgba[i + channel] * 255u + a / 2) / a) : 0;
        }
    }
    return 1;
}
void pu_gpu_canvas_present(PuGpuCanvas* c)
{
    if (!c || c->lost || c->preserve || c->presented == c->revision)
        return;
    PuGpuCurrent current(&c->device);
    if (!current.ok()) {
        pu_gpu_canvas_close(c);
        return;
    }
    auto gl = pu_gles();
    GLint draw, draw_buffer;
    gl->GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
    gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, c->framebuffer);
    gl->GetIntegerv(GL_DRAW_BUFFER0, &draw_buffer);
    const GLenum color_attachment = GL_COLOR_ATTACHMENT0;
    gl->DrawBuffers(1, &color_attachment);
    GLboolean scissor = gl->IsEnabled(GL_SCISSOR_TEST), mask[4], depth_mask;
    GLint front, back;
    gl->GetBooleanv(GL_COLOR_WRITEMASK, mask);
    gl->GetBooleanv(GL_DEPTH_WRITEMASK, &depth_mask);
    gl->GetIntegerv(GL_STENCIL_WRITEMASK, &front);
    gl->GetIntegerv(GL_STENCIL_BACK_WRITEMASK, &back);
    gl->Disable(GL_SCISSOR_TEST);
    gl->ColorMask(1, 1, 1, 1);
    gl->DepthMask(1);
    gl->StencilMask(~0u);
    GLfloat zero[] = { 0, 0, 0, c->alpha ? 0.f : 1.f }, one = 1;
    GLint stencil = 0;
    gl->ClearBufferfv(GL_COLOR, 0, zero);
    if (c->depth)
        gl->ClearBufferfv(GL_DEPTH, 0, &one);
    if (c->stencil)
        gl->ClearBufferiv(GL_STENCIL, 0, &stencil);
    if (scissor)
        gl->Enable(GL_SCISSOR_TEST);
    gl->ColorMask(mask[0], mask[1], mask[2], mask[3]);
    gl->DepthMask(depth_mask);
    gl->StencilMaskSeparate(GL_FRONT, front);
    gl->StencilMaskSeparate(GL_BACK, back);
    const GLenum saved_draw_buffer = (GLenum)draw_buffer;
    gl->DrawBuffers(1, &saved_draw_buffer);
    gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, draw);
    GLenum error = gl->GetError();
    if (error) {
        pu_gpu_error(c, error);
        pu_gpu_canvas_close(c);
        return;
    }
    c->presented = c->revision;
}
void pu_gpu_delete(PuGpuCanvas* c, const std::shared_ptr<PuGlResource>& r)
{
    if (!r || r->deleted || r->generation != c->generation)
        return;
    if (c->lost) {
        r->deleted = true;
        return;
    }
    if (r->kind == PuGlKind::TransformFeedback && c->feedbacks[r->name].active) {
        pu_gpu_error(c, GL_INVALID_OPERATION);
        return;
    }
    PuGpuCurrent current(&c->device);
    if (!current.ok())
        return;
    auto gl = pu_gles();
    switch (r->kind) {
    case PuGlKind::Buffer:
        gl->DeleteBuffers(1, &r->name);
        break;
    case PuGlKind::Texture:
        gl->DeleteTextures(1, &r->name);
        break;
    case PuGlKind::Framebuffer:
        gl->DeleteFramebuffers(1, &r->name);
        break;
    case PuGlKind::Renderbuffer:
        gl->DeleteRenderbuffers(1, &r->name);
        break;
    case PuGlKind::VertexArray:
        gl->DeleteVertexArrays(1, &r->name);
        break;
    case PuGlKind::Shader:
        gl->DeleteShader(r->name);
        break;
    case PuGlKind::Program:
        gl->DeleteProgram(r->name);
        break;
    case PuGlKind::Sampler:
        gl->DeleteSamplers(1, &r->name);
        break;
    case PuGlKind::Query:
        gl->DeleteQueries(1, &r->name);
        break;
    case PuGlKind::TransformFeedback:
        gl->DeleteTransformFeedbacks(1, &r->name);
        break;
    case PuGlKind::Sync:
        gl->DeleteSync(r->sync);
        break;
    case PuGlKind::Uniform:
        break;
    }
    GLenum error = gl->GetError();
    if (error) {
        pu_gpu_error(c, error);
        return;
    }
    r->deleted = true;
    if (r->kind == PuGlKind::Buffer) {
        for (auto& binding : c->buffers)
            if (binding.second == r)
                binding.second.reset();
        auto& vao = c->vaos[c->vao];
        if (vao.element == r)
            vao.element.reset();
        for (auto& attribute : vao.attributes)
            if (attribute.buffer == r)
                attribute.buffer.reset();
        for (auto& range : c->uniform_buffers)
            if (range.second.buffer == r)
                range.second = { };
        for (auto& range : c->feedbacks[c->feedback].bindings)
            if (range.second.buffer == r)
                range.second = { };
    } else if (r->kind == PuGlKind::Texture) {
        for (auto& unit : c->textures)
            for (auto& binding : unit)
                if (binding.second == r)
                    binding.second.reset();
    } else if (r->kind == PuGlKind::VertexArray) {
        if (c->vao == r->name)
            c->vao = 0;
        c->vaos.erase(r->name);
    } else if (r->kind == PuGlKind::Framebuffer) {
        if (c->draw_framebuffer == r) {
            c->draw_framebuffer.reset();
            gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, c->framebuffer);
        }
        if (c->read_framebuffer == r) {
            c->read_framebuffer.reset();
            gl->BindFramebuffer(GL_READ_FRAMEBUFFER, c->framebuffer);
        }
    } else if (r->kind == PuGlKind::Renderbuffer && c->renderbuffer == r)
        c->renderbuffer.reset();
    if (r->kind == PuGlKind::Texture || r->kind == PuGlKind::Renderbuffer) {
        for (const auto& fbo : { c->draw_framebuffer, c->read_framebuffer })
            if (fbo)
                for (auto& attachment : fbo->attachments)
                    if (attachment.second == r)
                        attachment.second.reset();
    }
    if (r->kind == PuGlKind::Query)
        for (auto& query : c->queries)
            if (query.second == r)
                query.second.reset();
    if (r->kind == PuGlKind::TransformFeedback) {
        if (c->feedback == r->name)
            c->feedback = 0;
        c->feedbacks.erase(r->name);
    }
}
#else
PuGpuCanvas* pu_gpu_canvas_create(int, int, int, int, int, int, int) { return nullptr; }
void pu_gpu_canvas_ref(PuGpuCanvas*) { }
void pu_gpu_canvas_unref(PuGpuCanvas*) { }
void pu_gpu_canvas_close(PuGpuCanvas*) { }
int pu_gpu_canvas_resize(PuGpuCanvas*, int, int) { return 0; }
int pu_gpu_canvas_read(PuGpuCanvas*, uint8_t*, size_t) { return 0; }
void pu_gpu_canvas_present(PuGpuCanvas*) { }
uint64_t pu_gpu_canvas_revision(PuGpuCanvas*) { return 0; }
int pu_gpu_canvas_lost(PuGpuCanvas*) { return 1; }
size_t pu_gpu_canvas_live_contexts() { return 0; }
#endif
