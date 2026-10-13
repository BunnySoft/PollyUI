if (IS("getUniform")) {
    auto program = resource(c, a.at(0), PuGlKind::Program, true);
    auto location = resource(c, a.at(1), PuGlKind::Uniform);
    if (!program || !location)
        return JS_NULL;
    if (location->program != program->name || location->link_generation != c->links[program->name])
        ERROR(GL_INVALID_OPERATION);
    GLint count = 0, maximum = 0;
    gl->GetProgramiv(program->name, GL_ACTIVE_UNIFORMS, &count);
    gl->GetProgramiv(program->name, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maximum);
    std::vector<char> name((size_t)std::max(1, maximum));
    GLenum found = 0;
    for (GLint i = 0; i < count && !found; ++i) {
        GLsizei length;
        GLint size;
        GLenum type;
        gl->GetActiveUniform(
            program->name, i, (GLsizei)name.size(), &length, &size, &type, name.data());
        std::string base(name.data(), length);
        size_t bracket = base.find("[0]");
        for (GLint item = 0; item < size; ++item) {
            std::string element = base;
            if (bracket != std::string::npos)
                element.replace(bracket, 3, "[" + std::to_string(item) + "]");
            if ((GLuint)gl->GetUniformLocation(program->name, element.c_str()) == location->name) {
                found = type;
                break;
            }
        }
    }
    if (!found)
        ERROR(GL_INVALID_OPERATION);
    unsigned length = 1;
    switch (found) {
    case GL_FLOAT_VEC2:
    case GL_INT_VEC2:
    case GL_BOOL_VEC2:
    case GL_UNSIGNED_INT_VEC2:
        length = 2;
        break;
    case GL_FLOAT_VEC3:
    case GL_INT_VEC3:
    case GL_BOOL_VEC3:
    case GL_UNSIGNED_INT_VEC3:
        length = 3;
        break;
    case GL_FLOAT_VEC4:
    case GL_INT_VEC4:
    case GL_BOOL_VEC4:
    case GL_UNSIGNED_INT_VEC4:
    case GL_FLOAT_MAT2:
        length = 4;
        break;
    case GL_FLOAT_MAT3:
        length = 9;
        break;
    case GL_FLOAT_MAT4:
        length = 16;
        break;
    case GL_FLOAT_MAT2x3:
    case GL_FLOAT_MAT3x2:
        length = 6;
        break;
    case GL_FLOAT_MAT2x4:
    case GL_FLOAT_MAT4x2:
        length = 8;
        break;
    case GL_FLOAT_MAT3x4:
    case GL_FLOAT_MAT4x3:
        length = 12;
        break;
    }
    bool floating = found == GL_FLOAT || (found >= GL_FLOAT_VEC2 && found <= GL_FLOAT_VEC4)
        || (found >= GL_FLOAT_MAT2 && found <= GL_FLOAT_MAT4)
        || (found >= GL_FLOAT_MAT2x3 && found <= GL_FLOAT_MAT4x3);
    bool boolean = found == GL_BOOL || (found >= GL_BOOL_VEC2 && found <= GL_BOOL_VEC4);
    bool unsign = found == GL_UNSIGNED_INT
        || (found >= GL_UNSIGNED_INT_VEC2 && found <= GL_UNSIGNED_INT_VEC4);
    GLfloat f[16] = { };
    GLint i[16] = { };
    GLuint u[16] = { };
    if (floating)
        gl->GetUniformfv(program->name, location->name, f);
    else if (unsign)
        gl->GetUniformuiv(program->name, location->name, u);
    else
        gl->GetUniformiv(program->name, location->name, i);
    JSValue values = JS_NewArray(ctx);
    for (unsigned item = 0; item < length; ++item)
        JS_SetPropertyUint32(ctx, values, item,
            floating      ? JS_NewFloat64(ctx, f[item])
                : boolean ? JS_NewBool(ctx, i[item])
                : unsign  ? JS_NewUint32(ctx, u[item])
                          : JS_NewInt32(ctx, i[item]));
    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "values", values);
    JS_SetPropertyStr(ctx, result, "kind",
        JS_NewInt32(ctx,
            floating      ? 0
                : boolean ? 1
                : unsign  ? 2
                          : 3));
    return result;
}
if (IS("getVertexAttrib") || IS("getVertexAttribOffset")) {
    int index = I(0);
    if (index < 0 || index >= c->max_attributes)
        ERROR(GL_INVALID_VALUE);
    GLenum pname = I(1);
    if (IS("getVertexAttribOffset")) {
        if (pname != GL_VERTEX_ATTRIB_ARRAY_POINTER)
            ERROR(GL_INVALID_ENUM);
        return JS_NewUint32(ctx, c->vaos[c->vao].attributes[index].offset);
    }
    if (pname == GL_CURRENT_VERTEX_ATTRIB) {
        GLenum type = c->attribute_types[index];
        GLfloat f[4] = { };
        GLint i[4] = { };
        GLuint u[4] = { };
        if (type == GL_FLOAT)
            gl->GetVertexAttribfv(index, pname, f);
        else if (type == GL_INT)
            gl->GetVertexAttribIiv(index, pname, i);
        else
            gl->GetVertexAttribIuiv(index, pname, u);
        JSValue result = JS_NewObject(ctx), values = JS_NewArray(ctx);
        for (uint32_t n = 0; n < 4; ++n)
            JS_SetPropertyUint32(ctx, values, n,
                type == GL_FLOAT     ? JS_NewFloat64(ctx, f[n])
                    : type == GL_INT ? JS_NewInt32(ctx, i[n])
                                     : JS_NewUint32(ctx, u[n]));
        JS_SetPropertyStr(ctx, result, "values", values);
        JS_SetPropertyStr(ctx, result, "type", JS_NewUint32(ctx, type));
        return result;
    }
    if (pname != GL_VERTEX_ATTRIB_ARRAY_ENABLED && pname != GL_VERTEX_ATTRIB_ARRAY_SIZE
        && pname != GL_VERTEX_ATTRIB_ARRAY_STRIDE && pname != GL_VERTEX_ATTRIB_ARRAY_TYPE
        && pname != GL_VERTEX_ATTRIB_ARRAY_NORMALIZED && pname != GL_VERTEX_ATTRIB_ARRAY_INTEGER
        && pname != GL_VERTEX_ATTRIB_ARRAY_DIVISOR)
        ERROR(GL_INVALID_ENUM);
    GLint value = 0;
    gl->GetVertexAttribiv(index, pname, &value);
    return pname == GL_VERTEX_ATTRIB_ARRAY_ENABLED || pname == GL_VERTEX_ATTRIB_ARRAY_NORMALIZED
            || pname == GL_VERTEX_ATTRIB_ARRAY_INTEGER
        ? JS_NewBool(ctx, value)
        : JS_NewInt32(ctx, value);
}
if (IS("vertexAttrib1f")) {
    gl->VertexAttrib1f(I(0), N(1));
    return JS_UNDEFINED;
}
if (IS("vertexAttrib2f")) {
    gl->VertexAttrib2f(I(0), N(1), N(2));
    return JS_UNDEFINED;
}
if (IS("vertexAttrib3f")) {
    gl->VertexAttrib3f(I(0), N(1), N(2), N(3));
    return JS_UNDEFINED;
}
if (IS("vertexAttrib4f")) {
    gl->VertexAttrib4f(I(0), N(1), N(2), N(3), N(4));
    return JS_UNDEFINED;
}
if (IS("vertexAttribI4i")) {
    gl->VertexAttribI4i(I(0), I(1), I(2), I(3), I(4));
    return JS_UNDEFINED;
}
if (IS("vertexAttribI4ui")) {
    gl->VertexAttribI4ui(I(0), I(1), I(2), I(3), I(4));
    return JS_UNDEFINED;
}
if (IS("bindSampler") || IS("samplerParameteri") || IS("samplerParameterf")
    || IS("getSamplerParameter")) {
    auto r = resource(c, a.at(IS("bindSampler") ? 1 : 0), PuGlKind::Sampler);
    if (!IS("bindSampler")) {
        GLenum pname = I(1);
        if (pname != GL_TEXTURE_MIN_FILTER && pname != GL_TEXTURE_MAG_FILTER
            && pname != GL_TEXTURE_WRAP_S && pname != GL_TEXTURE_WRAP_T
            && pname != GL_TEXTURE_WRAP_R && pname != GL_TEXTURE_MIN_LOD
            && pname != GL_TEXTURE_MAX_LOD && pname != GL_TEXTURE_COMPARE_MODE
            && pname != GL_TEXTURE_COMPARE_FUNC)
            ERROR(GL_INVALID_ENUM);
    }
    if (IS("bindSampler")) {
        if (I(0) < 0 || I(0) >= c->max_units)
            ERROR(GL_INVALID_VALUE);
        if (!a.null(1) && !r)
            return JS_UNDEFINED;
        gl->BindSampler(I(0), r ? r->name : 0);
    } else if (!r)
        return JS_NULL;
    else if (IS("samplerParameteri"))
        gl->SamplerParameteri(r->name, I(1), I(2));
    else if (IS("samplerParameterf"))
        gl->SamplerParameterf(r->name, I(1), N(2));
    else {
        if (I(1) == GL_TEXTURE_MIN_LOD || I(1) == GL_TEXTURE_MAX_LOD) {
            GLfloat value = 0;
            gl->GetSamplerParameterfv(r->name, I(1), &value);
            return JS_NewFloat64(ctx, value);
        }
        GLint value = 0;
        gl->GetSamplerParameteriv(r->name, I(1), &value);
        return JS_NewInt32(ctx, value);
    }
    return JS_UNDEFINED;
}
if (IS("bindBufferBase") || IS("bindBufferRange")) {
    GLenum target = I(0);
    if (target != GL_UNIFORM_BUFFER && target != GL_TRANSFORM_FEEDBACK_BUFFER)
        ERROR(GL_INVALID_ENUM);
    GLint maximum = 0;
    gl->GetIntegerv(target == GL_UNIFORM_BUFFER ? GL_MAX_UNIFORM_BUFFER_BINDINGS
                                                : GL_MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
        &maximum);
    unsigned index = I(1);
    if (index >= (unsigned)maximum)
        ERROR(GL_INVALID_VALUE);
    if (target == GL_TRANSFORM_FEEDBACK_BUFFER && c->feedback_active)
        ERROR(GL_INVALID_OPERATION);
    auto r = resource(c, a.at(2), PuGlKind::Buffer);
    if (!a.null(2) && !r)
        return JS_UNDEFINED;
    if (r && r->target == GL_ELEMENT_ARRAY_BUFFER)
        ERROR(GL_INVALID_OPERATION);
    size_t offset = 0, size = r ? r->bytes : 0;
    if (IS("bindBufferRange")) {
        double input_offset = N(3), input_size = N(4);
        if (input_offset < 0 || input_size <= 0 || std::trunc(input_offset) != input_offset
            || std::trunc(input_size) != input_size || input_offset > PU_IMAGE_BYTE_LIMIT
            || input_size > PU_IMAGE_BYTE_LIMIT)
            ERROR(GL_INVALID_VALUE);
        offset = (size_t)input_offset;
        size = (size_t)input_size;
        if (r && (offset > r->bytes || size > r->bytes - offset))
            ERROR(GL_INVALID_VALUE);
        GLint alignment = 4;
        if (target == GL_UNIFORM_BUFFER)
            gl->GetIntegerv(GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT, &alignment);
        if (offset % alignment || (target == GL_TRANSFORM_FEEDBACK_BUFFER && size % 4))
            ERROR(GL_INVALID_VALUE);
        gl->BindBufferRange(target, index, r ? r->name : 0, offset, size);
    } else
        gl->BindBufferBase(target, index, r ? r->name : 0);
    GLenum bind_error = gl->GetError();
    if (bind_error)
        ERROR(bind_error);
    if (r && !r->target)
        r->target = target;
    c->buffers[target] = r;
    auto& bindings
        = target == GL_UNIFORM_BUFFER ? c->uniform_buffers : c->feedbacks[c->feedback].bindings;
    bindings[index] = { r, offset, size, IS("bindBufferBase") };
    return JS_UNDEFINED;
}
if (IS("getIndexedParameter")) {
    GLenum target = I(0);
    unsigned index = I(1);
    GLint maximum = 0;
    bool uniform = target == GL_UNIFORM_BUFFER_START || target == GL_UNIFORM_BUFFER_SIZE;
    if (!uniform && target != GL_TRANSFORM_FEEDBACK_BUFFER_START
        && target != GL_TRANSFORM_FEEDBACK_BUFFER_SIZE)
        ERROR(GL_INVALID_ENUM);
    gl->GetIntegerv(
        uniform ? GL_MAX_UNIFORM_BUFFER_BINDINGS : GL_MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS,
        &maximum);
    if (index >= (unsigned)maximum)
        ERROR(GL_INVALID_VALUE);
    auto& bindings = uniform ? c->uniform_buffers : c->feedbacks[c->feedback].bindings;
    auto range = bindings[index];
    if (range.whole && range.buffer)
        range.size = range.buffer->bytes;
    return JS_NewFloat64(ctx,
        target == GL_UNIFORM_BUFFER_START || target == GL_TRANSFORM_FEEDBACK_BUFFER_START
            ? (double)range.offset
            : (double)range.size);
}
if (IS("getUniformBlockIndex") || IS("getActiveUniformBlockName")
    || IS("getActiveUniformBlockParameter") || IS("uniformBlockBinding") || IS("getUniformIndices")
    || IS("getActiveUniforms")) {
    auto r = resource(c, a.at(0), PuGlKind::Program);
    if (!r)
        return JS_NULL;
    if (IS("getUniformBlockIndex")) {
        if (!JS_IsString(a.at(1)))
            return JS_ThrowTypeError(ctx, "Invalid block name");
        const char* name = JS_ToCString(ctx, a.at(1));
        if (!name)
            return JS_EXCEPTION;
        GLuint index = gl->GetUniformBlockIndex(r->name, name);
        JS_FreeCString(ctx, name);
        return JS_NewUint32(ctx, index);
    }
    if (IS("uniformBlockBinding")) {
        gl->UniformBlockBinding(r->name, I(1), I(2));
        return JS_UNDEFINED;
    }
    if (IS("getActiveUniformBlockName")) {
        GLint maximum = 0;
        gl->GetProgramiv(r->name, GL_ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH, &maximum);
        std::vector<char> name((size_t)std::max(1, maximum));
        GLsizei length = 0;
        gl->GetActiveUniformBlockName(r->name, I(1), (GLsizei)name.size(), &length, name.data());
        return JS_NewStringLen(ctx, name.data(), length);
    }
    if (IS("getActiveUniformBlockParameter")) {
        GLenum pname = I(2);
        switch (pname) {
        case GL_UNIFORM_BLOCK_BINDING:
        case GL_UNIFORM_BLOCK_DATA_SIZE:
        case GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS:
        case GL_UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER:
        case GL_UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER: {
            GLint value = 0;
            gl->GetActiveUniformBlockiv(r->name, I(1), pname, &value);
            return pname == GL_UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER
                    || pname == GL_UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER
                ? JS_NewBool(ctx, value)
                : JS_NewInt32(ctx, value);
        }
        case GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES: {
            GLint count = 0;
            gl->GetActiveUniformBlockiv(r->name, I(1), GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS, &count);
            std::vector<GLint> indices((size_t)std::max(0, count));
            if (count)
                gl->GetActiveUniformBlockiv(r->name, I(1), pname, indices.data());
            return vector(ctx, indices.data(), indices.size());
        }
        default:
            ERROR(GL_INVALID_ENUM);
        }
    }
    if (IS("getUniformIndices")) {
        JSValue length_value = JS_GetPropertyStr(ctx, a.at(1), "length");
        uint32_t count = 0;
        JS_ToUint32(ctx, &count, length_value);
        JS_FreeValue(ctx, length_value);
        if (count > 4096)
            ERROR(GL_INVALID_VALUE);
        std::vector<std::string> names(count);
        for (uint32_t i = 0; i < count; ++i) {
            JSValue value = JS_GetPropertyUint32(ctx, a.at(1), i);
            if (!JS_IsString(value)) {
                JS_FreeValue(ctx, value);
                return JS_ThrowTypeError(ctx, "Invalid uniform name");
            }
            const char* text = JS_ToCString(ctx, value);
            if (!text) {
                JS_FreeValue(ctx, value);
                return JS_EXCEPTION;
            }
            names[i] = text;
            JS_FreeCString(ctx, text);
            JS_FreeValue(ctx, value);
        }
        std::vector<const char*> pointers(count);
        std::vector<GLuint> indices(count);
        for (uint32_t i = 0; i < count; ++i)
            pointers[i] = names[i].c_str();
        gl->GetUniformIndices(r->name, count, pointers.data(), indices.data());
        JSValue result = JS_NewArray(ctx);
        for (uint32_t i = 0; i < count; ++i)
            JS_SetPropertyUint32(ctx, result, i, JS_NewUint32(ctx, indices[i]));
        return result;
    }
    Bytes indices(ctx, a.at(1));
    if (!indices.data || indices.type != JS_TYPED_ARRAY_UINT32)
        ERROR(GL_INVALID_VALUE);
    GLenum pname = I(2);
    if (pname != GL_UNIFORM_TYPE && pname != GL_UNIFORM_SIZE && pname != GL_UNIFORM_BLOCK_INDEX
        && pname != GL_UNIFORM_OFFSET && pname != GL_UNIFORM_ARRAY_STRIDE
        && pname != GL_UNIFORM_MATRIX_STRIDE && pname != GL_UNIFORM_IS_ROW_MAJOR)
        ERROR(GL_INVALID_ENUM);
    std::vector<GLint> values(indices.length / 4);
    gl->GetActiveUniformsiv(r->name, (GLsizei)values.size(),
        reinterpret_cast<GLuint*>(indices.data), pname, values.data());
    return vector(ctx, values.data(), values.size());
}
if (IS("beginQuery") || IS("endQuery") || IS("getQuery") || IS("getQueryParameter")) {
    if (IS("getQueryParameter")) {
        auto r = resource(c, a.at(0), PuGlKind::Query);
        if (!r)
            return JS_NULL;
        GLenum pname = I(1);
        if (pname != GL_QUERY_RESULT && pname != GL_QUERY_RESULT_AVAILABLE)
            ERROR(GL_INVALID_ENUM);
        if (!r->target || c->queries[r->target] == r)
            ERROR(GL_INVALID_OPERATION);
        if (pname == GL_QUERY_RESULT) {
            GLuint ready = 0;
            gl->GetQueryObjectuiv(r->name, GL_QUERY_RESULT_AVAILABLE, &ready);
            if (!ready)
                ERROR(GL_INVALID_OPERATION);
        }
        GLuint value = 0;
        gl->GetQueryObjectuiv(r->name, pname, &value);
        return pname == GL_QUERY_RESULT_AVAILABLE ? JS_NewBool(ctx, value)
            : r->target == GL_ANY_SAMPLES_PASSED || r->target == GL_ANY_SAMPLES_PASSED_CONSERVATIVE
            ? JS_NewBool(ctx, value)
            : JS_NewUint32(ctx, value);
    }
    GLenum target = I(0);
    if (target != GL_ANY_SAMPLES_PASSED && target != GL_ANY_SAMPLES_PASSED_CONSERVATIVE
        && target != GL_TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN)
        ERROR(GL_INVALID_ENUM);
    if (IS("beginQuery")) {
        auto r = resource(c, a.at(1), PuGlKind::Query);
        if (!r)
            return JS_UNDEFINED;
        if (c->queries[target] || (r->target && r->target != target))
            ERROR(GL_INVALID_OPERATION);
        gl->BeginQuery(target, r->name);
        r->target = target;
        c->queries[target] = r;
    } else if (IS("endQuery")) {
        if (!c->queries[target])
            ERROR(GL_INVALID_OPERATION);
        gl->EndQuery(target);
        c->queries[target].reset();
    } else {
        if (I(1) != GL_CURRENT_QUERY)
            ERROR(GL_INVALID_ENUM);
        return JS_NewUint32(ctx, c->queries[target] ? c->queries[target]->name : 0);
    }
    return JS_UNDEFINED;
}
if (IS("fenceSync")) {
    if (I(0) != GL_SYNC_GPU_COMMANDS_COMPLETE)
        ERROR(GL_INVALID_ENUM);
    if (I(1))
        ERROR(GL_INVALID_VALUE);
    auto r = std::make_shared<PuGlResource>();
    r->kind = PuGlKind::Sync;
    r->generation = c->generation;
    r->sync = gl->FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    return r->sync ? handle_value(ctx, c, r) : JS_NULL;
}
if (IS("clientWaitSync") || IS("waitSync") || IS("getSyncParameter")) {
    auto r = resource(c, a.at(0), PuGlKind::Sync);
    if (!r)
        return JS_NULL;
    if (IS("getSyncParameter")) {
        GLenum pname = I(1);
        if (pname != GL_OBJECT_TYPE && pname != GL_SYNC_STATUS && pname != GL_SYNC_CONDITION
            && pname != GL_SYNC_FLAGS)
            ERROR(GL_INVALID_ENUM);
        GLint value = 0;
        gl->GetSynciv(r->sync, pname, 1, nullptr, &value);
        return JS_NewInt32(ctx, value);
    }
    if (IS("clientWaitSync")) {
        if (I(1) & ~GL_SYNC_FLUSH_COMMANDS_BIT)
            ERROR(GL_INVALID_VALUE);
        // UI-thread waits never block; MAX_CLIENT_WAIT_TIMEOUT_WEBGL is zero.
        if (N(2) != 0)
            ERROR(GL_INVALID_OPERATION);
        return JS_NewUint32(ctx, gl->ClientWaitSync(r->sync, I(1), 0));
    }
    if (I(1) || N(2) != -1)
        ERROR(GL_INVALID_VALUE);
    gl->WaitSync(r->sync, 0, GL_TIMEOUT_IGNORED);
    return JS_UNDEFINED;
}
if (IS("bindTransformFeedback")) {
    if (I(0) != GL_TRANSFORM_FEEDBACK)
        ERROR(GL_INVALID_ENUM);
    if (c->feedback_active && !c->feedback_paused)
        ERROR(GL_INVALID_OPERATION);
    auto r = resource(c, a.at(1), PuGlKind::TransformFeedback);
    if (!a.null(1) && !r)
        return JS_UNDEFINED;
    GLuint selected = r ? r->name : 0;
    gl->BindTransformFeedback(GL_TRANSFORM_FEEDBACK, selected);
    GLenum error = gl->GetError();
    if (error)
        ERROR(error);
    c->feedback = selected;
    auto& feedback = c->feedbacks[selected];
    c->feedback_active = feedback.active;
    c->feedback_paused = feedback.paused;
    c->feedback_mode = feedback.mode;
    return JS_UNDEFINED;
}
if (IS("transformFeedbackVaryings") || IS("getTransformFeedbackVarying")) {
    auto r = resource(c, a.at(0), PuGlKind::Program);
    if (!r)
        return JS_NULL;
    if (IS("getTransformFeedbackVarying")) {
        GLint maximum = 0;
        gl->GetProgramiv(r->name, GL_TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH, &maximum);
        std::vector<char> name((size_t)std::max(1, maximum));
        GLsizei length = 0;
        GLsizei size = 0;
        GLenum type = 0;
        gl->GetTransformFeedbackVarying(
            r->name, I(1), (GLsizei)name.size(), &length, &size, &type, name.data());
        if (!length)
            return JS_NULL;
        JSValue result = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, result, "name", JS_NewStringLen(ctx, name.data(), length));
        JS_SetPropertyStr(ctx, result, "size", JS_NewInt32(ctx, size));
        JS_SetPropertyStr(ctx, result, "type", JS_NewUint32(ctx, type));
        return result;
    }
    JSValue length_value = JS_GetPropertyStr(ctx, a.at(1), "length");
    uint32_t count = 0;
    JS_ToUint32(ctx, &count, length_value);
    JS_FreeValue(ctx, length_value);
    if (count > 4096)
        ERROR(GL_INVALID_VALUE);
    if (I(2) != GL_INTERLEAVED_ATTRIBS && I(2) != GL_SEPARATE_ATTRIBS)
        ERROR(GL_INVALID_ENUM);
    std::vector<std::string> names(count);
    std::vector<const char*> pointers(count);
    for (uint32_t i = 0; i < count; ++i) {
        JSValue value = JS_GetPropertyUint32(ctx, a.at(1), i);
        if (!JS_IsString(value)) {
            JS_FreeValue(ctx, value);
            return JS_ThrowTypeError(ctx, "Invalid varying name");
        }
        const char* text = JS_ToCString(ctx, value);
        if (!text) {
            JS_FreeValue(ctx, value);
            return JS_EXCEPTION;
        }
        names[i] = text;
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, value);
        pointers[i] = names[i].c_str();
    }
    gl->TransformFeedbackVaryings(r->name, count, pointers.data(), I(2));
    return JS_UNDEFINED;
}
if (IS("beginTransformFeedback")) {
    if (c->feedback_active || !c->program)
        ERROR(GL_INVALID_OPERATION);
    GLenum mode = I(0);
    if (mode != GL_POINTS && mode != GL_LINES && mode != GL_TRIANGLES)
        ERROR(GL_INVALID_ENUM);
    GLint varyings = 0;
    gl->GetProgramiv(c->program, GL_TRANSFORM_FEEDBACK_VARYINGS, &varyings);
    if (!varyings)
        ERROR(GL_INVALID_OPERATION);
    gl->BeginTransformFeedback(mode);
    GLenum error = gl->GetError();
    if (error)
        ERROR(error);
    c->feedback_active = true;
    c->feedback_paused = false;
    c->feedback_mode = mode;
    auto& feedback = c->feedbacks[c->feedback];
    feedback.vertices = 0;
    feedback.active = true;
    feedback.paused = false;
    feedback.mode = mode;
    feedback.program = c->current_program;
    return JS_UNDEFINED;
}
if (IS("endTransformFeedback")) {
    if (!c->feedback_active)
        ERROR(GL_INVALID_OPERATION);
    gl->EndTransformFeedback();
    c->feedback_active = c->feedback_paused = false;
    auto& feedback = c->feedbacks[c->feedback];
    feedback.active = feedback.paused = false;
    feedback.program.reset();
    return JS_UNDEFINED;
}
if (IS("pauseTransformFeedback")) {
    if (!c->feedback_active || c->feedback_paused)
        ERROR(GL_INVALID_OPERATION);
    gl->PauseTransformFeedback();
    c->feedback_paused = c->feedbacks[c->feedback].paused = true;
    return JS_UNDEFINED;
}
if (IS("resumeTransformFeedback")) {
    if (!c->feedback_active || !c->feedback_paused)
        ERROR(GL_INVALID_OPERATION);
    if (c->feedbacks[c->feedback].program != c->current_program)
        ERROR(GL_INVALID_OPERATION);
    gl->ResumeTransformFeedback();
    c->feedback_paused = c->feedbacks[c->feedback].paused = false;
    return JS_UNDEFINED;
}
if (IS("blitFramebuffer")) {
    if (framebuffer_status(c, GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE
        || framebuffer_status(c, GL_READ_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        ERROR(GL_INVALID_FRAMEBUFFER_OPERATION);
    gl->BlitFramebuffer(I(0), I(1), I(2), I(3), I(4), I(5), I(6), I(7), I(8), I(9));
    if (!c->draw_framebuffer)
        ++c->revision;
    return JS_UNDEFINED;
}
if (IS("clearBufferfv") || IS("clearBufferiv") || IS("clearBufferuiv")) {
    if (framebuffer_status(c, GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
        ERROR(GL_INVALID_FRAMEBUFFER_OPERATION);
    GLenum buffer = I(0);
    Bytes bytes(ctx, a.at(2));
    size_t count = buffer == GL_COLOR ? 4 : buffer == GL_DEPTH || buffer == GL_STENCIL ? 1 : 0;
    if (!count)
        ERROR(GL_INVALID_ENUM);
    if (!bytes.data || bytes.length < count * 4)
        ERROR(GL_INVALID_VALUE);
    if (IS("clearBufferfv")) {
        if (bytes.type != JS_TYPED_ARRAY_FLOAT32 || (buffer != GL_COLOR && buffer != GL_DEPTH))
            ERROR(GL_INVALID_ENUM);
        gl->ClearBufferfv(buffer, I(1), reinterpret_cast<GLfloat*>(bytes.data));
    } else if (IS("clearBufferiv")) {
        if (bytes.type != JS_TYPED_ARRAY_INT32 || (buffer != GL_COLOR && buffer != GL_STENCIL))
            ERROR(GL_INVALID_ENUM);
        gl->ClearBufferiv(buffer, I(1), reinterpret_cast<GLint*>(bytes.data));
    } else {
        if (bytes.type != JS_TYPED_ARRAY_UINT32 || buffer != GL_COLOR)
            ERROR(GL_INVALID_ENUM);
        gl->ClearBufferuiv(buffer, I(1), reinterpret_cast<GLuint*>(bytes.data));
    }
    if (!c->draw_framebuffer)
        ++c->revision;
    return JS_UNDEFINED;
}
if (IS("clearBufferfi")) {
    gl->ClearBufferfi(I(0), I(1), N(2), I(3));
    if (!c->draw_framebuffer)
        ++c->revision;
    return JS_UNDEFINED;
}
if (IS("getInternalformatParameter")) {
    if (I(0) != GL_RENDERBUFFER || I(2) != GL_SAMPLES)
        ERROR(GL_INVALID_ENUM);
    GLint count = 0;
    gl->GetInternalformativ(I(0), I(1), GL_NUM_SAMPLE_COUNTS, 1, &count);
    std::vector<GLint> values((size_t)std::max(0, count));
    if (count)
        gl->GetInternalformativ(I(0), I(1), GL_SAMPLES, count, values.data());
    return vector(ctx, values.data(), values.size());
}
if (IS("getFramebufferAttachmentParameter")) {
    GLenum target = I(0), attachment = I(1), pname = I(2);
    bool has_fbo
        = target == GL_READ_FRAMEBUFFER ? bool(c->read_framebuffer) : bool(c->draw_framebuffer);
    if (!has_fbo) {
        if (attachment == GL_BACK)
            attachment = GL_COLOR_ATTACHMENT0;
        else if (attachment == GL_DEPTH)
            attachment = GL_DEPTH_ATTACHMENT;
        else if (attachment == GL_STENCIL)
            attachment = GL_STENCIL_ATTACHMENT;
        else
            ERROR(GL_INVALID_OPERATION);
        if (pname == GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE)
            return JS_NewUint32(ctx, GL_FRAMEBUFFER_DEFAULT);
    }
    switch (pname) {
    case GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE:
    case GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:
    case GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:
    case GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER:
    case GL_FRAMEBUFFER_ATTACHMENT_RED_SIZE:
    case GL_FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:
    case GL_FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:
    case GL_FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:
    case GL_FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:
    case GL_FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:
    case GL_FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:
    case GL_FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE: {
        GLint value = 0;
        gl->GetFramebufferAttachmentParameteriv(target, attachment, pname, &value);
        return JS_NewInt32(ctx, value);
    }
    default:
        ERROR(GL_INVALID_ENUM);
    }
}
