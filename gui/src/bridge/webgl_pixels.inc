if (IS("activeTexture")) {
    int unit = I(0) - GL_TEXTURE0;
    if (unit < 0 || unit >= c->max_units)
        ERROR(GL_INVALID_ENUM);
    gl->ActiveTexture(I(0));
    c->active_texture = unit;
    return JS_UNDEFINED;
}
if (IS("bindTexture")) {
    GLenum target = I(0);
    if (target != GL_TEXTURE_2D && target != GL_TEXTURE_CUBE_MAP && target != GL_TEXTURE_3D
        && target != GL_TEXTURE_2D_ARRAY)
        ERROR(GL_INVALID_ENUM);
    auto r = resource(c, a.at(1), PuGlKind::Texture);
    if (!a.null(1) && !r)
        return JS_UNDEFINED;
    if (r && r->target && r->target != target)
        ERROR(GL_INVALID_OPERATION);
    if (r)
        r->target = target;
    gl->BindTexture(target, r ? r->name : 0);
    GLenum bind_error = gl->GetError();
    if (bind_error)
        ERROR(bind_error);
    c->textures[c->active_texture][target] = r;
    return JS_UNDEFINED;
}
if (IS("pixelStorei")) {
    GLenum pname = I(0);
    int value = I(1);
    switch (pname) {
    case GL_PACK_ALIGNMENT:
    case GL_UNPACK_ALIGNMENT:
        if (value != 1 && value != 2 && value != 4 && value != 8)
            ERROR(GL_INVALID_VALUE);
        break;
    case GL_PACK_ROW_LENGTH:
    case GL_PACK_SKIP_ROWS:
    case GL_PACK_SKIP_PIXELS:
    case GL_UNPACK_ROW_LENGTH:
    case GL_UNPACK_SKIP_ROWS:
    case GL_UNPACK_SKIP_PIXELS:
    case GL_UNPACK_IMAGE_HEIGHT:
    case GL_UNPACK_SKIP_IMAGES:
        if (value < 0)
            ERROR(GL_INVALID_VALUE);
        break;
    default:
        ERROR(GL_INVALID_ENUM);
    }
    gl->PixelStorei(pname, value);
    return JS_UNDEFINED;
}
if (IS("texParameteri") || IS("texParameterf") || IS("getTexParameter") || IS("generateMipmap")) {
    GLenum target = I(0);
    if (target != GL_TEXTURE_2D && target != GL_TEXTURE_CUBE_MAP && target != GL_TEXTURE_3D
        && target != GL_TEXTURE_2D_ARRAY)
        ERROR(GL_INVALID_ENUM);
    if (!c->textures[c->active_texture][target])
        ERROR(GL_INVALID_OPERATION);
    if (!IS("generateMipmap")) {
        GLenum pname = I(1);
        bool immutable
            = pname == GL_TEXTURE_IMMUTABLE_FORMAT || pname == GL_TEXTURE_IMMUTABLE_LEVELS;
        if (pname != GL_TEXTURE_MIN_FILTER && pname != GL_TEXTURE_MAG_FILTER
            && pname != GL_TEXTURE_WRAP_S && pname != GL_TEXTURE_WRAP_T
            && pname != GL_TEXTURE_WRAP_R && pname != GL_TEXTURE_MIN_LOD
            && pname != GL_TEXTURE_MAX_LOD && pname != GL_TEXTURE_BASE_LEVEL
            && pname != GL_TEXTURE_MAX_LEVEL && pname != GL_TEXTURE_COMPARE_MODE
            && pname != GL_TEXTURE_COMPARE_FUNC && !(IS("getTexParameter") && immutable))
            ERROR(GL_INVALID_ENUM);
    }
    if (IS("texParameteri"))
        gl->TexParameteri(target, I(1), I(2));
    else if (IS("texParameterf"))
        gl->TexParameterf(target, I(1), N(2));
    else if (IS("generateMipmap")) {
        auto texture = c->textures[c->active_texture][target];
        GLint base = 0, maximum = 0, immutable_levels = 0;
        gl->GetTexParameteriv(target, GL_TEXTURE_BASE_LEVEL, &base);
        gl->GetTexParameteriv(target, GL_TEXTURE_MAX_LEVEL, &maximum);
        if (texture->immutable)
            gl->GetTexParameteriv(target, GL_TEXTURE_IMMUTABLE_LEVELS, &immutable_levels);
        GLenum first = target == GL_TEXTURE_CUBE_MAP ? GL_TEXTURE_CUBE_MAP_POSITIVE_X : target;
        GLenum last = target == GL_TEXTURE_CUBE_MAP ? GL_TEXTURE_CUBE_MAP_NEGATIVE_Z : target;
        auto images = texture->images;
        auto levels = texture->levels;
        uint64_t allocation = texture->bytes;
        bool has_base = true;
        for (GLenum face = first; face <= last; ++face) {
            uint64_t base_key = ((uint64_t)face << 32) | (unsigned)base;
            auto found = images.find(base_key);
            if (found == images.end() || found->second.width <= 0 || found->second.height <= 0
                || found->second.depth <= 0) {
                has_base = false;
                break;
            }
            auto image = found->second;
            StorageFormat info = { };
            unsigned bytes = storage_format(image.internal, &info)
                ? info.bytes
                : transfer_bytes(image.format, image.type);
            if (!bytes) {
                has_base = false;
                break;
            }
            int extent = std::max(
                { image.width, image.height, target == GL_TEXTURE_3D ? image.depth : 1 });
            int end = std::min(maximum, base + (int)std::floor(std::log2(extent)));
            if (texture->immutable)
                end = std::min(end, immutable_levels - 1);
            for (int level = base + 1; level <= end; ++level) {
                image.width = std::max(1, image.width / 2);
                image.height = std::max(1, image.height / 2);
                if (target == GL_TEXTURE_3D)
                    image.depth = std::max(1, image.depth / 2);
                uint64_t key = ((uint64_t)face << 32) | (unsigned)level;
                uint64_t size = (uint64_t)image.width * image.height * image.depth * bytes;
                if (!texture->immutable) {
                    auto old = levels.find(key);
                    allocation = allocation - (old == levels.end() ? 0 : old->second) + size;
                    levels[key] = (size_t)size;
                }
                images[key] = image;
            }
        }
        size_t previous = texture->bytes;
        size_t previous_allocated = c->allocated;
        if (has_base
            && (allocation > PU_IMAGE_BYTE_LIMIT || !reserve(c, texture, (size_t)allocation))) {
            if (allocation > PU_IMAGE_BYTE_LIMIT)
                pu_gpu_error(c, GL_OUT_OF_MEMORY);
            return JS_UNDEFINED;
        }
        gl->GenerateMipmap(target);
        GLenum error = gl->GetError();
        if (error) {
            texture->bytes = previous;
            c->allocated = previous_allocated;
            ERROR(error);
        }
        if (!has_base) {
            pu_gpu_canvas_close(c);
            return JS_ThrowInternalError(ctx, "Generated mipmap base image is not tracked");
        }
        texture->images = std::move(images);
        texture->levels = std::move(levels);
    } else {
        if (I(1) == GL_TEXTURE_MIN_LOD || I(1) == GL_TEXTURE_MAX_LOD) {
            GLfloat value = 0;
            gl->GetTexParameterfv(target, I(1), &value);
            return JS_NewFloat64(ctx, value);
        }
        GLint value = 0;
        gl->GetTexParameteriv(target, I(1), &value);
        return I(1) == GL_TEXTURE_IMMUTABLE_FORMAT ? JS_NewBool(ctx, value)
                                                   : JS_NewInt32(ctx, value);
    }
    return JS_UNDEFINED;
}
if (IS("texImage2D") || IS("texSubImage2D") || IS("texImage3D") || IS("texSubImage3D")
    || IS("texStorage2D") || IS("texStorage3D")) {
    bool storage = IS("texStorage2D") || IS("texStorage3D");
    bool three = IS("texImage3D") || IS("texSubImage3D") || IS("texStorage3D");
    bool sub = IS("texSubImage2D") || IS("texSubImage3D");
    GLenum target = I(0), binding = target;
    if (target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z)
        binding = GL_TEXTURE_CUBE_MAP;
    if (three ? target != GL_TEXTURE_3D && target != GL_TEXTURE_2D_ARRAY
              : binding != GL_TEXTURE_2D && binding != GL_TEXTURE_CUBE_MAP)
        ERROR(GL_INVALID_ENUM);
    if (storage && target != binding)
        ERROR(GL_INVALID_ENUM);
    auto texture = c->textures[c->active_texture][binding];
    if (!texture)
        ERROR(GL_INVALID_OPERATION);
    if (!sub && texture->immutable)
        ERROR(GL_INVALID_OPERATION);
    int level = I(1), width = I(sub ? (three ? 5 : 4) : 3), height = I(sub ? (three ? 6 : 5) : 4),
        depth = three ? I(sub ? 7 : 5) : 1;
    GLenum internal = sub ? 0 : I(2);
    GLenum format = storage ? 0 : I(sub ? (three ? 8 : 6) : (three ? 7 : 6));
    GLenum type = storage ? 0 : I(sub ? (three ? 9 : 7) : (three ? 8 : 7));
    size_t slot = sub ? (three ? 10 : 8) : (three ? 9 : 8);
    if (!storage && !sub && I(three ? 6 : 5) != 0)
        ERROR(GL_INVALID_VALUE);
    if (level < 0 || width < 0 || height < 0 || depth < 0 || level > 31 || width > c->max_texture
        || height > c->max_texture || (binding == GL_TEXTURE_CUBE_MAP && width != height))
        ERROR(GL_INVALID_VALUE);
    if (three) {
        GLint limit = 0;
        gl->GetIntegerv(
            target == GL_TEXTURE_3D ? GL_MAX_3D_TEXTURE_SIZE : GL_MAX_ARRAY_TEXTURE_LAYERS, &limit);
        if (depth > limit || (target == GL_TEXTURE_3D && (width > limit || height > limit)))
            ERROR(GL_INVALID_VALUE);
    }
    // Immutable allocations are zero-filled through a legal corresponding transfer format.
    StorageFormat storage_info = { };
    if (storage) {
        if (!storage_format(internal, &storage_info) || !storage_info.format)
            ERROR(GL_INVALID_ENUM);
        format = storage_info.format;
        type = storage_info.type;
        if (level < 1 || !width || !height || !depth
            || level > 1
                    + (int)std::floor(std::log2(
                        std::max({ width, height, target == GL_TEXTURE_3D ? depth : 1 }))))
            ERROR(GL_INVALID_OPERATION);
    }
    unsigned bpp = transfer_bytes(format, type);
    if (!bpp)
        ERROR(GL_INVALID_ENUM);
    GLint align = 0, row = 0, skip_rows = 0, skip_pixels = 0, image_height = 0, skip_images = 0;
    gl->GetIntegerv(GL_UNPACK_ALIGNMENT, &align);
    gl->GetIntegerv(GL_UNPACK_ROW_LENGTH, &row);
    gl->GetIntegerv(GL_UNPACK_SKIP_ROWS, &skip_rows);
    gl->GetIntegerv(GL_UNPACK_SKIP_PIXELS, &skip_pixels);
    gl->GetIntegerv(GL_UNPACK_IMAGE_HEIGHT, &image_height);
    gl->GetIntegerv(GL_UNPACK_SKIP_IMAGES, &skip_images);
    if (row && row < width)
        ERROR(GL_INVALID_OPERATION);
    uint64_t stride = ((uint64_t)(row ? row : width) * bpp + align - 1) / align * align;
    const auto product = [](uint64_t a, uint64_t b) {
        return a && b > PU_IMAGE_BYTE_LIMIT / a ? (uint64_t)PU_IMAGE_BYTE_LIMIT + 1 : a * b;
    };
    uint64_t length = 0;
    if (!storage && width && height && depth) {
        uint64_t rows = product(stride, (uint64_t)skip_rows + height - 1);
        uint64_t tail = product((uint64_t)skip_pixels + width, bpp);
        uint64_t images = three ? product(stride,
                                      product((uint64_t)(image_height ? image_height : height),
                                          (uint64_t)skip_images + depth - 1))
                                : 0;
        length = rows + tail + images;
    }
    if (length > PU_IMAGE_BYTE_LIMIT)
        ERROR(GL_OUT_OF_MEMORY);
    Bytes bytes(ctx, a.at(slot));
    auto pbo = c->buffers[GL_PIXEL_UNPACK_BUFFER];
    bool pbo_offset = !storage && JS_IsNumber(a.at(slot));
    double offset = pbo_offset ? N(slot) : 0;
    if (pbo_offset) {
        if (!pbo || offset < 0 || std::trunc(offset) != offset || offset > pbo->bytes
            || length > pbo->bytes - offset
            || (size_t)offset
                % (component_size(type) ? component_size(type)
                        : bpp == 2      ? 2
                                        : 4))
            ERROR(GL_INVALID_OPERATION);
    } else if (pbo && !storage)
        ERROR(GL_INVALID_OPERATION);
    if (!storage && !pbo_offset && !a.null(slot) && (!bytes.data || bytes.length < length))
        ERROR(GL_INVALID_OPERATION);
    if (!storage && type == GL_FLOAT_32_UNSIGNED_INT_24_8_REV && !pbo_offset && !a.null(slot))
        ERROR(GL_INVALID_OPERATION);
    if (bytes.data && !transfer_type(bytes.type, type))
        ERROR(GL_INVALID_OPERATION);
    std::vector<uint8_t> zeros;
    const void* data = bytes.data;
    if (pbo_offset)
        data = reinterpret_cast<void*>((uintptr_t)offset);
    else if (!data) {
        zeros.assign((size_t)length, 0);
        data = zeros.data();
    }
    StorageFormat actual = { };
    unsigned storage_bpp = storage_format(internal, &actual) ? actual.bytes : bpp;
    uint64_t allocation64 = (uint64_t)width * height * depth * storage_bpp;
    if (allocation64 > PU_IMAGE_BYTE_LIMIT)
        ERROR(GL_OUT_OF_MEMORY);
    size_t allocation = (size_t)allocation64;
    size_t previous_bytes = texture->bytes;
    if (storage) {
        size_t total = 0;
        int w = width, h = height, d = depth;
        for (int i = 0; i < level; ++i) {
            total += (size_t)w * h * d * storage_bpp * (binding == GL_TEXTURE_CUBE_MAP ? 6 : 1);
            w = std::max(1, w / 2);
            h = std::max(1, h / 2);
            if (target == GL_TEXTURE_3D)
                d = std::max(1, d / 2);
        }
        if (!reserve(c, texture, total))
            return JS_UNDEFINED;
        if (three)
            gl->TexStorage3D(target, level, internal, width, height, depth);
        else
            gl->TexStorage2D(target, level, internal, width, height);
        GLenum error = gl->GetError();
        if (error) {
            texture->bytes = previous_bytes;
            ERROR(error);
        }
        texture->immutable = true;
        // Preserve all client pixel-store state while initializing the owned storage.
        gl->PixelStorei(GL_UNPACK_ALIGNMENT, 1);
        gl->PixelStorei(GL_UNPACK_ROW_LENGTH, 0);
        gl->PixelStorei(GL_UNPACK_SKIP_ROWS, 0);
        gl->PixelStorei(GL_UNPACK_SKIP_PIXELS, 0);
        gl->PixelStorei(GL_UNPACK_IMAGE_HEIGHT, 0);
        gl->PixelStorei(GL_UNPACK_SKIP_IMAGES, 0);
        if (pbo)
            gl->BindBuffer(GL_PIXEL_UNPACK_BUFFER, 0);
        w = width;
        h = height;
        d = depth;
        for (int i = 0; i < level; ++i) {
            zeros.assign((size_t)w * h * d * bpp, 0);
            if (three)
                gl->TexSubImage3D(target, i, 0, 0, 0, w, h, d, format, type, zeros.data());
            else if (target == GL_TEXTURE_CUBE_MAP)
                for (unsigned face = GL_TEXTURE_CUBE_MAP_POSITIVE_X;
                    face <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z; ++face)
                    gl->TexSubImage2D(face, i, 0, 0, w, h, format, type, zeros.data());
            else
                gl->TexSubImage2D(target, i, 0, 0, w, h, format, type, zeros.data());
            if (target == GL_TEXTURE_CUBE_MAP) {
                for (GLenum face = GL_TEXTURE_CUBE_MAP_POSITIVE_X;
                    face <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z; ++face)
                    texture->images[((uint64_t)face << 32) | (unsigned)i]
                        = { w, h, d, internal, format, type };
            } else
                texture->images[((uint64_t)target << 32) | (unsigned)i]
                    = { w, h, d, internal, format, type };
            w = std::max(1, w / 2);
            h = std::max(1, h / 2);
            if (target == GL_TEXTURE_3D)
                d = std::max(1, d / 2);
        }
        gl->PixelStorei(GL_UNPACK_ALIGNMENT, align);
        gl->PixelStorei(GL_UNPACK_ROW_LENGTH, row);
        gl->PixelStorei(GL_UNPACK_SKIP_ROWS, skip_rows);
        gl->PixelStorei(GL_UNPACK_SKIP_PIXELS, skip_pixels);
        gl->PixelStorei(GL_UNPACK_IMAGE_HEIGHT, image_height);
        gl->PixelStorei(GL_UNPACK_SKIP_IMAGES, skip_images);
        if (pbo)
            gl->BindBuffer(GL_PIXEL_UNPACK_BUFFER, pbo->name);
    } else if (!sub) {
        uint64_t key = ((uint64_t)target << 32) | (unsigned)level;
        if (!reserve(c, texture, texture->bytes - texture->levels[key] + allocation))
            return JS_UNDEFINED;
        if (three)
            gl->TexImage3D(target, level, internal, width, height, depth, 0, format, type, data);
        else
            gl->TexImage2D(target, level, internal, width, height, 0, format, type, data);
        GLenum error = gl->GetError();
        if (error) {
            texture->bytes = previous_bytes;
            ERROR(error);
        }
        texture->levels[key] = allocation;
        texture->images[key] = { width, height, depth, internal, format, type };
    } else {
        if (I(2) < 0 || I(3) < 0 || (three && I(4) < 0))
            ERROR(GL_INVALID_VALUE);
        if (three)
            gl->TexSubImage3D(
                target, level, I(2), I(3), I(4), width, height, depth, format, type, data);
        else
            gl->TexSubImage2D(target, level, I(2), I(3), width, height, format, type, data);
    }
    GLenum transfer_error = gl->GetError();
    if (transfer_error) {
        if (storage)
            pu_gpu_canvas_close(c);
        ERROR(transfer_error);
    }
    if (!sub) {
        texture->width = width;
        texture->height = height;
        texture->depth = depth;
        texture->format = internal;
    }
    return JS_UNDEFINED;
}
if (IS("bindFramebuffer")) {
    GLenum target = I(0);
    if (target != GL_FRAMEBUFFER && target != GL_DRAW_FRAMEBUFFER && target != GL_READ_FRAMEBUFFER)
        ERROR(GL_INVALID_ENUM);
    auto r = resource(c, a.at(1), PuGlKind::Framebuffer);
    if (!a.null(1) && !r)
        return JS_UNDEFINED;
    gl->BindFramebuffer(target, r ? r->name : c->framebuffer);
    GLenum bind_error = gl->GetError();
    if (bind_error)
        ERROR(bind_error);
    if (target != GL_READ_FRAMEBUFFER)
        c->draw_framebuffer = r;
    if (target != GL_DRAW_FRAMEBUFFER)
        c->read_framebuffer = r;
    return JS_UNDEFINED;
}
if (IS("checkFramebufferStatus"))
    return JS_NewUint32(ctx, framebuffer_status(c, I(0)));
if (IS("framebufferTexture2D") || IS("framebufferTextureLayer") || IS("framebufferRenderbuffer")) {
    GLenum target = I(0);
    auto fbo = target == GL_READ_FRAMEBUFFER ? c->read_framebuffer : c->draw_framebuffer;
    if (!fbo)
        ERROR(GL_INVALID_OPERATION);
    bool renderbuffer = IS("framebufferRenderbuffer"), layer = IS("framebufferTextureLayer");
    auto r = resource(
        c, a.at(layer ? 2 : 3), renderbuffer ? PuGlKind::Renderbuffer : PuGlKind::Texture);
    if (!a.null(layer ? 2 : 3) && !r)
        return JS_UNDEFINED;
    if (renderbuffer)
        gl->FramebufferRenderbuffer(target, I(1), I(2), r ? r->name : 0);
    else if (layer)
        gl->FramebufferTextureLayer(target, I(1), r ? r->name : 0, I(3), I(4));
    else
        gl->FramebufferTexture2D(target, I(1), I(2), r ? r->name : 0, I(4));
    GLenum error = gl->GetError();
    if (error)
        ERROR(error);
    const auto attach = [&](GLenum attachment) {
        fbo->attachments[attachment] = r;
        if (!renderbuffer) {
            fbo->attachment_targets[attachment] = layer && r ? r->target : I(2);
            fbo->attachment_levels[attachment] = I(layer ? 3 : 4);
            fbo->attachment_layers[attachment] = layer ? I(4) : 0;
        }
    };
    if (I(1) == GL_DEPTH_STENCIL_ATTACHMENT) {
        attach(GL_DEPTH_ATTACHMENT);
        attach(GL_STENCIL_ATTACHMENT);
    } else
        attach(I(1));
    if (r) {
        fbo->width = r->width;
        fbo->height = r->height;
    }
    return JS_UNDEFINED;
}
if (IS("bindRenderbuffer")) {
    if (I(0) != GL_RENDERBUFFER)
        ERROR(GL_INVALID_ENUM);
    auto r = resource(c, a.at(1), PuGlKind::Renderbuffer);
    if (!a.null(1) && !r)
        return JS_UNDEFINED;
    gl->BindRenderbuffer(GL_RENDERBUFFER, r ? r->name : 0);
    GLenum bind_error = gl->GetError();
    if (bind_error)
        ERROR(bind_error);
    c->renderbuffer = r;
    return JS_UNDEFINED;
}
if (IS("renderbufferStorage") || IS("renderbufferStorageMultisample")) {
    auto r = c->renderbuffer;
    if (!r)
        ERROR(GL_INVALID_OPERATION);
    bool multi = IS("renderbufferStorageMultisample");
    GLenum format = I(multi ? 2 : 1);
    int w = I(multi ? 3 : 2), h = I(multi ? 4 : 3), samples = multi ? I(1) : 0;
    if (I(0) != GL_RENDERBUFFER)
        ERROR(GL_INVALID_ENUM);
    if (w < 0 || h < 0 || samples < 0
        || (uint64_t)w * h * std::max(1, samples) * 4 > PU_IMAGE_BYTE_LIMIT)
        ERROR(GL_INVALID_VALUE);
    StorageFormat info = { };
    if (!storage_format(format, &info) || !core_renderable(format))
        ERROR(GL_INVALID_ENUM);
    bool depth = info.depth, stencil = info.stencil;
    uint64_t size = (uint64_t)w * h * std::max(1, samples) * info.bytes;
    if (size > PU_IMAGE_BYTE_LIMIT)
        ERROR(GL_OUT_OF_MEMORY);
    size_t previous_bytes = r->bytes;
    if (!reserve(c, r, (size_t)size))
        return JS_UNDEFINED;
    if (multi)
        gl->RenderbufferStorageMultisample(GL_RENDERBUFFER, samples, format, w, h);
    else
        gl->RenderbufferStorage(GL_RENDERBUFFER, format, w, h);
    GLenum error = gl->GetError();
    if (error) {
        r->bytes = previous_bytes;
        ERROR(error);
    }
    GLint draw, read;
    gl->GetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
    gl->GetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
    GLuint fbo;
    gl->GenFramebuffers(1, &fbo);
    gl->BindFramebuffer(GL_FRAMEBUFFER, fbo);
    GLenum attachment = depth && stencil ? GL_DEPTH_STENCIL_ATTACHMENT
        : depth                          ? GL_DEPTH_ATTACHMENT
        : stencil                        ? GL_STENCIL_ATTACHMENT
                                         : GL_COLOR_ATTACHMENT0;
    gl->FramebufferRenderbuffer(GL_FRAMEBUFFER, attachment, GL_RENDERBUFFER, r->name);
    GLboolean scissor = gl->IsEnabled(GL_SCISSOR_TEST), color_mask[4], depth_mask;
    GLint front_mask, back_mask;
    gl->GetBooleanv(GL_COLOR_WRITEMASK, color_mask);
    gl->GetBooleanv(GL_DEPTH_WRITEMASK, &depth_mask);
    gl->GetIntegerv(GL_STENCIL_WRITEMASK, &front_mask);
    gl->GetIntegerv(GL_STENCIL_BACK_WRITEMASK, &back_mask);
    gl->Disable(GL_SCISSOR_TEST);
    gl->ColorMask(1, 1, 1, 1);
    gl->DepthMask(1);
    gl->StencilMask(~0u);
    GLfloat zero[4] = { };
    GLint zero_stencil = 0;
    if (depth)
        gl->ClearBufferfv(GL_DEPTH, 0, zero);
    if (stencil)
        gl->ClearBufferiv(GL_STENCIL, 0, &zero_stencil);
    GLint signed_zero[4] = { };
    GLuint unsigned_zero[4] = { };
    if (!depth && !stencil) {
        if (info.integer && info.unsign)
            gl->ClearBufferuiv(GL_COLOR, 0, unsigned_zero);
        else if (info.integer)
            gl->ClearBufferiv(GL_COLOR, 0, signed_zero);
        else
            gl->ClearBufferfv(GL_COLOR, 0, zero);
    }
    if (scissor)
        gl->Enable(GL_SCISSOR_TEST);
    gl->ColorMask(color_mask[0], color_mask[1], color_mask[2], color_mask[3]);
    gl->DepthMask(depth_mask);
    gl->StencilMaskSeparate(GL_FRONT, front_mask);
    gl->StencilMaskSeparate(GL_BACK, back_mask);
    gl->BindFramebuffer(GL_DRAW_FRAMEBUFFER, draw);
    gl->BindFramebuffer(GL_READ_FRAMEBUFFER, read);
    gl->DeleteFramebuffers(1, &fbo);
    error = gl->GetError();
    if (error && w && h) {
        pu_gpu_canvas_close(c);
        ERROR(error);
    }
    r->width = w;
    r->height = h;
    r->format = format;
    return JS_UNDEFINED;
}
if (IS("getRenderbufferParameter")) {
    if (!c->renderbuffer)
        ERROR(GL_INVALID_OPERATION);
    if (I(0) != GL_RENDERBUFFER)
        ERROR(GL_INVALID_ENUM);
    GLint value = 0;
    gl->GetRenderbufferParameteriv(I(0), I(1), &value);
    return JS_NewInt32(ctx, value);
}
if (IS("drawBuffers")) {
    Bytes bytes(ctx, a.at(0));
    if (!bytes.data || bytes.type != JS_TYPED_ARRAY_UINT32 || bytes.length % 4)
        ERROR(GL_INVALID_VALUE);
    std::vector<GLenum> values(bytes.length / 4);
    memcpy(values.data(), bytes.data, bytes.length);
    if (!c->draw_framebuffer) {
        if (values.size() != 1 || (values[0] != GL_BACK && values[0] != GL_NONE))
            ERROR(GL_INVALID_OPERATION);
        if (values[0] == GL_BACK)
            values[0] = GL_COLOR_ATTACHMENT0;
    }
    gl->DrawBuffers((GLsizei)values.size(), values.data());
    return JS_UNDEFINED;
}
if (IS("readBuffer")) {
    GLenum buffer = I(0);
    if (!c->read_framebuffer) {
        if (buffer != GL_BACK && buffer != GL_NONE)
            ERROR(GL_INVALID_OPERATION);
        if (buffer == GL_BACK)
            buffer = GL_COLOR_ATTACHMENT0;
    }
    gl->ReadBuffer(buffer);
    return JS_UNDEFINED;
}
if (IS("readPixels")) {
    int x = I(0), y = I(1), w = I(2), h = I(3);
    if (w < 0 || h < 0)
        ERROR(GL_INVALID_VALUE);
    GLenum format = I(4), type = I(5);
    unsigned bpp = transfer_bytes(format, type);
    if (!bpp)
        ERROR(GL_INVALID_ENUM);
    if (framebuffer_status(c, GL_READ_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        ERROR(GL_INVALID_FRAMEBUFFER_OPERATION);
    GLint selected = 0;
    gl->GetIntegerv(GL_READ_BUFFER, &selected);
    if (selected == GL_NONE || (c->read_framebuffer && !c->read_framebuffer->attachments[selected]))
        ERROR(GL_INVALID_OPERATION);
    Bytes bytes(ctx, a.at(6));
    auto pbo = c->buffers[GL_PIXEL_PACK_BUFFER];
    uint8_t* destination = bytes.data;
    size_t destination_length = bytes.length, offset = 0;
    if (JS_IsNumber(a.at(6))) {
        double value = N(6);
        if (!pbo || value < 0 || std::trunc(value) != value || value > pbo->bytes)
            ERROR(GL_INVALID_OPERATION);
        offset = (size_t)value;
        unsigned alignment = component_size(type) ? component_size(type) : bpp == 2 ? 2 : 4;
        if (offset % alignment)
            ERROR(GL_INVALID_OPERATION);
        destination = pbo->data.data() + offset;
        destination_length = pbo->bytes - offset;
    } else if (pbo || !bytes.data || !transfer_type(bytes.type, type))
        ERROR(GL_INVALID_OPERATION);
    GLint align = 0, row = 0, skip_rows = 0, skip_pixels = 0;
    gl->GetIntegerv(GL_PACK_ALIGNMENT, &align);
    gl->GetIntegerv(GL_PACK_ROW_LENGTH, &row);
    gl->GetIntegerv(GL_PACK_SKIP_ROWS, &skip_rows);
    gl->GetIntegerv(GL_PACK_SKIP_PIXELS, &skip_pixels);
    if (row && row < w)
        ERROR(GL_INVALID_OPERATION);
    uint64_t stride = ((uint64_t)(row ? row : w) * bpp + align - 1) / align * align;
    uint64_t rows = (uint64_t)skip_rows + (h ? h - 1 : 0);
    uint64_t tail = ((uint64_t)skip_pixels + w) * bpp;
    if (w && h
        && (tail > destination_length || (stride && rows > (destination_length - tail) / stride)))
        ERROR(GL_INVALID_OPERATION);
    auto framebuffer = framebuffer_size(c);
    int fw = framebuffer.first, fh = framebuffer.second;
    int left = std::max(0, x), bottom = std::max(0, y);
    int right = (int)std::min<int64_t>(fw, (int64_t)x + w),
        top = (int)std::min<int64_t>(fh, (int64_t)y + h);
    int read_width = std::max(0, right - left), read_height = std::max(0, top - bottom);
    uint64_t pixel_length = (uint64_t)read_width * read_height * bpp;
    if (pixel_length > PU_IMAGE_BYTE_LIMIT)
        ERROR(GL_OUT_OF_MEMORY);
    std::vector<uint8_t> pixels((size_t)std::max<uint64_t>(1, pixel_length));
    gl->PixelStorei(GL_PACK_ALIGNMENT, 1);
    gl->PixelStorei(GL_PACK_ROW_LENGTH, 0);
    gl->PixelStorei(GL_PACK_SKIP_ROWS, 0);
    gl->PixelStorei(GL_PACK_SKIP_PIXELS, 0);
    if (pbo)
        gl->BindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    gl->ReadPixels(read_width && read_height ? left : 0, read_width && read_height ? bottom : 0,
        read_width && read_height ? read_width : 0, read_width && read_height ? read_height : 0,
        format, type, pixels.data());
    GLenum error = gl->GetError();
    gl->PixelStorei(GL_PACK_ALIGNMENT, align);
    gl->PixelStorei(GL_PACK_ROW_LENGTH, row);
    gl->PixelStorei(GL_PACK_SKIP_ROWS, skip_rows);
    gl->PixelStorei(GL_PACK_SKIP_PIXELS, skip_pixels);
    if (pbo)
        gl->BindBuffer(GL_PIXEL_PACK_BUFFER, pbo->name);
    if (error)
        ERROR(error);
    if (!w || !h)
        return JS_UNDEFINED;
    for (int line = 0; line < h; ++line) {
        size_t at = ((size_t)skip_rows + line) * (size_t)stride + (size_t)skip_pixels * bpp;
        memset(destination + at, 0, (size_t)w * bpp);
        if (read_width && read_height && (int64_t)y + line >= bottom && (int64_t)y + line < top)
            memcpy(destination + at + (size_t)(left - x) * bpp,
                pixels.data() + ((size_t)line + y - bottom) * read_width * bpp,
                (size_t)read_width * bpp);
        if (pbo)
            gl->BufferSubData(GL_PIXEL_PACK_BUFFER, offset + at, (size_t)w * bpp, destination + at);
    }
    return JS_UNDEFINED;
}
