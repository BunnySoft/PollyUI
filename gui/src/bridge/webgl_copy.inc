if (IS("getFragDataLocation")) {
    auto r = resource(c, a.at(0), PuGlKind::Program);
    if (!r)
        return JS_NewInt32(ctx, -1);
    if (!JS_IsString(a.at(1)))
        return JS_ThrowTypeError(ctx, "Invalid fragment output name");
    const char* name = JS_ToCString(ctx, a.at(1));
    if (!name)
        return JS_EXCEPTION;
    GLint location = gl->GetFragDataLocation(r->name, name);
    JS_FreeCString(ctx, name);
    return JS_NewInt32(ctx, location);
}
if (IS("drawRangeElements")) {
    int mode = I(0), count = I(3);
    GLuint start = I(1), end = I(2);
    double offset = N(5);
    if (mode < GL_POINTS || mode > GL_TRIANGLE_FAN)
        ERROR(GL_INVALID_ENUM);
    if (end < start || count < 0 || offset < 0 || offset > PU_IMAGE_BYTE_LIMIT
        || std::trunc(offset) != offset)
        ERROR(GL_INVALID_VALUE);
    if (!draw_bounds(c, 0, count, 1, true, I(4), (size_t)offset, 0))
        return JS_UNDEFINED;
    auto element = c->vaos[c->vao].element;
    unsigned size = component_size(I(4));
    uint32_t restart = size == 4 ? UINT32_MAX : size == 2 ? UINT16_MAX : UINT8_MAX;
    for (int i = 0; i < count; ++i) {
        uint32_t index = 0;
        memcpy(&index, element->data.data() + (size_t)offset + (size_t)i * size, size);
        if (index != restart && (index < start || index > end))
            ERROR(GL_INVALID_OPERATION);
    }
    gl->DrawRangeElements(
        mode, start, end, count, I(4), reinterpret_cast<void*>((uintptr_t)offset));
    GLenum error = gl->GetError();
    if (error)
        ERROR(error);
    if (!c->draw_framebuffer)
        ++c->revision;
    return JS_UNDEFINED;
}
if (IS("copyTexImage2D") || IS("copyTexSubImage2D") || IS("copyTexSubImage3D")) {
    bool image = IS("copyTexImage2D"), three = IS("copyTexSubImage3D");
    GLenum target = I(0), binding = target;
    if (target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z)
        binding = GL_TEXTURE_CUBE_MAP;
    if (three ? target != GL_TEXTURE_3D && target != GL_TEXTURE_2D_ARRAY
              : binding != GL_TEXTURE_2D && binding != GL_TEXTURE_CUBE_MAP)
        ERROR(GL_INVALID_ENUM);
    auto r = c->textures[c->active_texture][binding];
    if (!r || (image && r->immutable))
        ERROR(GL_INVALID_OPERATION);
    int level = I(1), x = I(image ? 3 : three ? 5 : 4), y = I(image ? 4 : three ? 6 : 5);
    int width = I(image ? 5 : three ? 7 : 6), height = I(image ? 6 : three ? 8 : 7);
    if (width < 0 || height < 0 || level < 0 || level > 31 || width > c->max_texture
        || height > c->max_texture || (image && I(7)))
        ERROR(GL_INVALID_VALUE);
    if (framebuffer_status(c, GL_READ_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        ERROR(GL_INVALID_FRAMEBUFFER_OPERATION);
    if (c->read_framebuffer)
        for (const auto& attachment : c->read_framebuffer->attachments)
            if (attachment.second == r)
                ERROR(GL_INVALID_OPERATION);
    uint64_t key = ((uint64_t)target << 32) | (unsigned)level;
    GLenum internal = image ? I(2) : r->images[key].internal;
    StorageFormat info = { };
    if (!storage_format(internal, &info)) {
        if (internal != GL_RGBA && internal != GL_RGB && internal != GL_ALPHA
            && internal != GL_LUMINANCE && internal != GL_LUMINANCE_ALPHA)
            ERROR(GL_INVALID_ENUM);
        info = { internal, GL_UNSIGNED_BYTE, transfer_bytes(internal, GL_UNSIGNED_BYTE), false,
            false, false, false };
    }
    if (info.depth || info.stencil || compressed_block(internal))
        ERROR(GL_INVALID_OPERATION);
    uint64_t size = (uint64_t)width * height * info.bytes;
    if (size > PU_IMAGE_BYTE_LIMIT)
        ERROR(GL_OUT_OF_MEMORY);
    size_t previous = r->bytes;
    if (image && !reserve(c, r, r->bytes - r->levels[key] + (size_t)size))
        return JS_UNDEFINED;
    if (image)
        gl->CopyTexImage2D(target, level, internal, x, y, width, height, 0);
    else if (three)
        gl->CopyTexSubImage3D(target, level, I(2), I(3), I(4), x, y, width, height);
    else
        gl->CopyTexSubImage2D(target, level, I(2), I(3), x, y, width, height);
    GLenum error = gl->GetError();
    if (error) {
        r->bytes = previous;
        ERROR(error);
    }
    auto framebuffer = framebuffer_size(c);
    int fw = framebuffer.first, fh = framebuffer.second;
    // GLES leaves out-of-framebuffer source pixels undefined. WebGL must not expose them.
    if (x < 0 || y < 0 || (int64_t)x + width > fw || (int64_t)y + height > fh) {
        GLint unpack_buffer, store[6];
        const GLenum stores[] = { GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS,
            GL_UNPACK_SKIP_PIXELS, GL_UNPACK_IMAGE_HEIGHT, GL_UNPACK_SKIP_IMAGES };
        gl->GetIntegerv(GL_PIXEL_UNPACK_BUFFER_BINDING, &unpack_buffer);
        for (int i = 0; i < 6; ++i) {
            gl->GetIntegerv(stores[i], store + i);
            gl->PixelStorei(stores[i], i == 0 ? 1 : 0);
        }
        gl->BindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
        std::vector<uint8_t> zero((size_t)width * height * info.bytes, 0);
        int left = (int)std::min<int64_t>(width, std::max<int64_t>(0, -(int64_t)x));
        int bottom = (int)std::min<int64_t>(height, std::max<int64_t>(0, -(int64_t)y));
        int right = (int)std::min<int64_t>(width, (int64_t)fw - x);
        int top = (int)std::min<int64_t>(height, (int64_t)fh - y);
        left = std::min(width, left);
        bottom = std::min(height, bottom);
        right = std::max(left, right);
        top = std::max(bottom, top);
        const auto erase = [&](int ox, int oy, int w, int h) {
            if (w <= 0 || h <= 0)
                return;
            int dx = (image ? 0 : I(2)) + ox, dy = (image ? 0 : I(3)) + oy;
            if (three)
                gl->TexSubImage3D(
                    target, level, dx, dy, I(4), w, h, 1, info.format, info.type, zero.data());
            else
                gl->TexSubImage2D(target, level, dx, dy, w, h, info.format, info.type, zero.data());
        };
        erase(0, 0, width, bottom);
        erase(0, top, width, height - top);
        erase(0, bottom, left, top - bottom);
        erase(right, bottom, width - right, top - bottom);
        for (int i = 0; i < 6; ++i)
            gl->PixelStorei(stores[i], store[i]);
        gl->BindBuffer(GL_PIXEL_UNPACK_BUFFER, unpack_buffer);
        error = gl->GetError();
        if (error) {
            pu_gpu_canvas_close(c);
            ERROR(error);
        }
    }
    if (image) {
        r->levels[key] = (size_t)size;
        r->width = width;
        r->height = height;
        r->depth = 1;
        r->format = internal;
        r->images[key] = { width, height, 1, internal, info.format, info.type };
    }
    return JS_UNDEFINED;
}
if (IS("invalidateFramebuffer") || IS("invalidateSubFramebuffer")) {
    GLenum target = I(0);
    if (target != GL_FRAMEBUFFER && target != GL_READ_FRAMEBUFFER && target != GL_DRAW_FRAMEBUFFER)
        ERROR(GL_INVALID_ENUM);
    Bytes bytes(ctx, a.at(1));
    if (!bytes.data || bytes.type != JS_TYPED_ARRAY_UINT32)
        ERROR(GL_INVALID_VALUE);
    std::vector<GLenum> attachments(bytes.length / 4);
    memcpy(attachments.data(), bytes.data, bytes.length);
    bool has_fbo
        = target == GL_READ_FRAMEBUFFER ? bool(c->read_framebuffer) : bool(c->draw_framebuffer);
    for (auto& attachment : attachments) {
        if (!has_fbo) {
            if (attachment == GL_COLOR)
                attachment = GL_COLOR_ATTACHMENT0;
            else if (attachment == GL_DEPTH)
                attachment = GL_DEPTH_ATTACHMENT;
            else if (attachment == GL_STENCIL)
                attachment = GL_STENCIL_ATTACHMENT;
            else
                ERROR(GL_INVALID_ENUM);
        }
    }
    if (IS("invalidateSubFramebuffer"))
        gl->InvalidateSubFramebuffer(
            target, (GLsizei)attachments.size(), attachments.data(), I(2), I(3), I(4), I(5));
    else
        gl->InvalidateFramebuffer(target, (GLsizei)attachments.size(), attachments.data());
    GLenum error = gl->GetError();
    if (error)
        ERROR(error);
    // Discarded pixels are undefined in GLES. Initialize them before a later JS read or sample.
    if (gl->CheckFramebufferStatus(target) == GL_FRAMEBUFFER_COMPLETE) {
        GLint draw = 0, max_draw = 0, scissor_box[4], front_mask, back_mask;
        GLboolean color_mask[4], depth_mask, scissor = gl->IsEnabled(GL_SCISSOR_TEST);
        gl->GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
        GLuint selected = target == GL_READ_FRAMEBUFFER
            ? (c->read_framebuffer ? c->read_framebuffer->name : c->framebuffer)
            : (c->draw_framebuffer ? c->draw_framebuffer->name : c->framebuffer);
        gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, selected);
        gl->GetIntegerv(GL_MAX_DRAW_BUFFERS, &max_draw);
        if (max_draw <= 0 || max_draw > 256) {
            pu_gpu_canvas_close(c);
            ERROR(GL_INVALID_OPERATION);
        }
        std::vector<GLenum> draw_buffers((size_t)max_draw);
        for (int i = 0; i < max_draw; ++i) {
            GLint value = 0;
            gl->GetIntegerv(GL_DRAW_BUFFER0 + i, &value);
            draw_buffers[i] = value;
        }
        gl->GetIntegerv(GL_SCISSOR_BOX, scissor_box);
        gl->GetBooleanv(GL_COLOR_WRITEMASK, color_mask);
        gl->GetBooleanv(GL_DEPTH_WRITEMASK, &depth_mask);
        gl->GetIntegerv(GL_STENCIL_WRITEMASK, &front_mask);
        gl->GetIntegerv(GL_STENCIL_BACK_WRITEMASK, &back_mask);
        gl->ColorMask(1, 1, 1, 1);
        gl->DepthMask(1);
        gl->StencilMask(~0u);
        if (IS("invalidateSubFramebuffer")) {
            gl->Enable(GL_SCISSOR_TEST);
            gl->Scissor(I(2), I(3), I(4), I(5));
        } else
            gl->Disable(GL_SCISSOR_TEST);
        GLfloat f[4] = { };
        GLint i[4] = { };
        GLuint u[4] = { };
        for (GLenum attachment : attachments) {
            GLint object_type = 0;
            gl->GetFramebufferAttachmentParameteriv(GL_DRAW_FRAMEBUFFER, attachment,
                GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE, &object_type);
            if (object_type == GL_NONE)
                continue;
            if (attachment == GL_DEPTH_ATTACHMENT)
                gl->ClearBufferfv(GL_DEPTH, 0, f);
            else if (attachment == GL_STENCIL_ATTACHMENT)
                gl->ClearBufferiv(GL_STENCIL, 0, i);
            else {
                GLint component = 0;
                gl->GetFramebufferAttachmentParameteriv(GL_DRAW_FRAMEBUFFER, attachment,
                    GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE, &component);
                gl->DrawBuffers(1, &attachment);
                if (component == GL_INT)
                    gl->ClearBufferiv(GL_COLOR, 0, i);
                else if (component == GL_UNSIGNED_INT)
                    gl->ClearBufferuiv(GL_COLOR, 0, u);
                else
                    gl->ClearBufferfv(GL_COLOR, 0, f);
            }
        }
        gl->DrawBuffers(max_draw, draw_buffers.data());
        gl->ColorMask(color_mask[0], color_mask[1], color_mask[2], color_mask[3]);
        gl->DepthMask(depth_mask);
        gl->StencilMaskSeparate(GL_FRONT, front_mask);
        gl->StencilMaskSeparate(GL_BACK, back_mask);
        gl->Scissor(scissor_box[0], scissor_box[1], scissor_box[2], scissor_box[3]);
        if (scissor)
            gl->Enable(GL_SCISSOR_TEST);
        else
            gl->Disable(GL_SCISSOR_TEST);
        gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, draw);
        error = gl->GetError();
        if (error) {
            pu_gpu_canvas_close(c);
            ERROR(error);
        }
        if (!has_fbo)
            ++c->revision;
    }
    return JS_UNDEFINED;
}
