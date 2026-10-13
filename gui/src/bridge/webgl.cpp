#include "bridge/webgl.h"
#include "render/canvas_c.h"
#include "render/gpu_canvas_internal.h"
#include "webgl-script.h"
extern "C" {
#include "bridge/bridge.h"
#include "bridge/media.h"
#include "layout/layout.h"
}
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <new>
#include <cctype>
#include <sstream>

#ifdef PU_WEBGL2
namespace
{
JSClassID handle_class;
struct Handle {
    PuGpuCanvas* canvas;
    std::shared_ptr<PuGlResource> resource;
};
void finalize(JSRuntime*, JSValueConst value)
{
    auto h = static_cast<Handle*>(JS_GetOpaque(value, handle_class));
    if (!h)
        return;
    if (h->resource)
        pu_gpu_delete(h->canvas, h->resource);
    pu_gpu_canvas_unref(h->canvas);
    delete h;
}
JSValue handle_value(JSContext* ctx, PuGpuCanvas* c, std::shared_ptr<PuGlResource> r = { })
{
    JSValue value = JS_NewObjectClass(ctx, handle_class);
    if (JS_IsException(value))
        return value;
    auto h = new (std::nothrow) Handle { c, std::move(r) };
    if (!h) {
        JS_FreeValue(ctx, value);
        return JS_ThrowOutOfMemory(ctx);
    }
    pu_gpu_canvas_ref(c);
    JS_SetOpaque(value, h);
    return value;
}
struct Arguments {
    JSContext* ctx;
    std::vector<JSValue> values;
    bool valid = true;
    Arguments(JSContext* context, JSValueConst array)
        : ctx(context)
    {
        JSValue length = JS_GetPropertyStr(ctx, array, "length");
        uint32_t count = 0;
        if (JS_ToUint32(ctx, &count, length) < 0 || count > 64)
            valid = false;
        JS_FreeValue(ctx, length);
        if (valid)
            for (uint32_t i = 0; i < count; ++i) {
                values.push_back(JS_GetPropertyUint32(ctx, array, i));
                if (JS_IsException(values.back()))
                    valid = false;
            }
    }
    ~Arguments()
    {
        for (auto value : values)
            JS_FreeValue(ctx, value);
    }
    JSValueConst at(size_t i) const { return i < values.size() ? values[i] : JS_UNDEFINED; }
    double number(size_t i)
    {
        double result = 0;
        if (!JS_IsNumber(at(i)) || JS_ToFloat64(ctx, &result, at(i)) < 0)
            valid = false;
        return result;
    }
    GLint integer(size_t i)
    {
        int32_t result = 0;
        if (!JS_IsNumber(at(i)) || JS_ToInt32(ctx, &result, at(i)) < 0)
            valid = false;
        return result;
    }
    bool null(size_t i) const { return JS_IsNull(at(i)); }
};
struct Bytes {
    JSContext* ctx;
    JSValue buffer = JS_UNDEFINED;
    uint8_t* data = nullptr;
    size_t length = 0, element = 1;
    int type = -1;
    explicit Bytes(JSContext* context, JSValueConst value)
        : ctx(context)
    {
        size_t offset = 0, total = 0;
        type = JS_GetTypedArrayType(value);
        if (JS_IsArrayBuffer(value))
            buffer = JS_DupValue(ctx, value);
        else if (type >= 0)
            buffer = JS_GetTypedArrayBuffer(ctx, value, &offset, &length, &element);
        else
            return;
        if (JS_IsException(buffer))
            return;
        data = JS_GetArrayBuffer(ctx, &total, buffer);
        if (JS_IsArrayBuffer(value))
            length = total;
        if (!data || offset > total || length > total - offset || length > PU_IMAGE_BYTE_LIMIT) {
            data = nullptr;
            return;
        }
        data += offset;
    }
    ~Bytes() { JS_FreeValue(ctx, buffer); }
};
std::shared_ptr<PuGlResource> resource(
    PuGpuCanvas* c, JSValueConst value, PuGlKind kind, bool allow_deleted = false)
{
    if (JS_IsNull(value))
        return { };
    auto h = static_cast<Handle*>(JS_GetOpaque(value, handle_class));
    if (!h || h->canvas != c || !h->resource || h->resource->kind != kind
        || h->resource->generation != c->generation || (!allow_deleted && h->resource->deleted)) {
        pu_gpu_error(c, GL_INVALID_OPERATION);
        return { };
    }
    if (h->resource->deleted && allow_deleted) {
        bool pending = kind == PuGlKind::Program && c->current_program == h->resource;
        if (kind == PuGlKind::Shader)
            for (const auto& entry : c->resources)
                if (auto program = entry.lock(); program && program->kind == PuGlKind::Program
                    && (!program->deleted || c->current_program == program)
                    && std::find(program->shaders.begin(), program->shaders.end(), h->resource)
                        != program->shaders.end())
                    pending = true;
        if (!pending) {
            pu_gpu_error(c, GL_INVALID_OPERATION);
            return { };
        }
    }
    return h->resource;
}
JSValue constants(JSContext* ctx)
{
    JSValue result = JS_NewObject(ctx);
#define PU_ENUM(name) JS_SetPropertyStr(ctx, result, #name, JS_NewUint32(ctx, GL_##name));
#include "bridge/webgl_constants.inc"
#undef PU_ENUM
    return result;
}
JSValue vector(JSContext* ctx, const GLint* values, size_t count)
{
    JSValue result = JS_NewArray(ctx);
    for (size_t i = 0; i < count; ++i)
        JS_SetPropertyUint32(ctx, result, (uint32_t)i, JS_NewInt32(ctx, values[i]));
    return result;
}
JSValue floats(JSContext* ctx, const GLfloat* values, size_t count)
{
    JSValue result = JS_NewArray(ctx);
    for (size_t i = 0; i < count; ++i)
        JS_SetPropertyUint32(ctx, result, (uint32_t)i, JS_NewFloat64(ctx, values[i]));
    return result;
}
bool buffer_target(GLenum target)
{
    return target == GL_ARRAY_BUFFER || target == GL_ELEMENT_ARRAY_BUFFER
        || target == GL_COPY_READ_BUFFER || target == GL_COPY_WRITE_BUFFER
        || target == GL_UNIFORM_BUFFER || target == GL_PIXEL_PACK_BUFFER
        || target == GL_PIXEL_UNPACK_BUFFER || target == GL_TRANSFORM_FEEDBACK_BUFFER;
}
std::shared_ptr<PuGlResource> bound_buffer(PuGpuCanvas* c, GLenum target)
{
    if (!buffer_target(target)) {
        pu_gpu_error(c, GL_INVALID_ENUM);
        return { };
    }
    auto r = target == GL_ELEMENT_ARRAY_BUFFER ? c->vaos[c->vao].element : c->buffers[target];
    if (!r)
        pu_gpu_error(c, GL_INVALID_OPERATION);
    return r;
}
unsigned component_size(GLenum type)
{
    if (type == GL_BYTE || type == GL_UNSIGNED_BYTE)
        return 1;
    if (type == GL_SHORT || type == GL_UNSIGNED_SHORT || type == GL_HALF_FLOAT)
        return 2;
    if (type == GL_INT || type == GL_UNSIGNED_INT || type == GL_FLOAT)
        return 4;
    return 0;
}
#include "bridge/webgl_formats.inc"
std::pair<int, int> framebuffer_size(PuGpuCanvas* c)
{
    if (!c->read_framebuffer)
        return { c->width, c->height };
    auto gl = pu_gles();
    GLint selected = 0;
    gl->GetIntegerv(GL_READ_BUFFER, &selected);
    auto fbo = c->read_framebuffer;
    auto resource = fbo->attachments[selected];
    if (!resource)
        return { 0, 0 };
    if (resource->kind == PuGlKind::Renderbuffer)
        return { resource->width, resource->height };
    uint64_t key = ((uint64_t)fbo->attachment_targets[selected] << 32)
        | (unsigned)fbo->attachment_levels[selected];
    auto image = resource->images[key];
    return { image.width, image.height };
}
GLenum framebuffer_status(PuGpuCanvas* c, GLenum target)
{
    auto gl = pu_gles();
    GLenum status = gl->CheckFramebufferStatus(target);
    if (status != GL_FRAMEBUFFER_COMPLETE)
        return status;
    auto fbo = target == GL_READ_FRAMEBUFFER ? c->read_framebuffer : c->draw_framebuffer;
    if (!fbo)
        return status;
    const auto same_image = [&](GLenum a, GLenum b) {
        auto first = fbo->attachments[a], second = fbo->attachments[b];
        return first && first == second
            && (first->kind == PuGlKind::Renderbuffer
                || (fbo->attachment_targets[a] == fbo->attachment_targets[b]
                    && fbo->attachment_levels[a] == fbo->attachment_levels[b]
                    && fbo->attachment_layers[a] == fbo->attachment_layers[b]));
    };
    if (fbo->attachments[GL_DEPTH_ATTACHMENT] && fbo->attachments[GL_STENCIL_ATTACHMENT]
        && !same_image(GL_DEPTH_ATTACHMENT, GL_STENCIL_ATTACHMENT))
        return GL_FRAMEBUFFER_UNSUPPORTED;
    for (const auto& attachment : fbo->attachments) {
        auto r = attachment.second;
        if (!r)
            continue;
        GLenum format = r->format;
        if (r->kind == PuGlKind::Texture) {
            uint64_t key = ((uint64_t)fbo->attachment_targets[attachment.first] << 32)
                | (unsigned)fbo->attachment_levels[attachment.first];
            format = r->images[key].internal;
        }
        if (!core_renderable(format))
            return GL_FRAMEBUFFER_UNSUPPORTED;
        if (attachment.first >= GL_COLOR_ATTACHMENT0
            && attachment.first < GL_COLOR_ATTACHMENT0 + 16)
            for (const auto& other : fbo->attachments)
                if (other.first > attachment.first && other.first < GL_COLOR_ATTACHMENT0 + 16
                    && same_image(attachment.first, other.first))
                    return GL_FRAMEBUFFER_UNSUPPORTED;
    }
    return status;
}
bool reserve(PuGpuCanvas* c, const std::shared_ptr<PuGlResource>& r, size_t bytes)
{
    size_t allocated = 0;
    for (auto entry = c->resources.begin(); entry != c->resources.end();) {
        if (auto resource = entry->lock()) {
            allocated += resource->bytes;
            ++entry;
        } else
            entry = c->resources.erase(entry);
    }
    if (bytes > PU_IMAGE_BYTE_LIMIT || bytes > 256u * 1024u * 1024u - (allocated - r->bytes)) {
        pu_gpu_error(c, GL_OUT_OF_MEMORY);
        return false;
    }
    c->allocated = allocated - r->bytes + bytes;
    r->bytes = bytes;
    return true;
}
unsigned components(GLenum type)
{
    switch (type) {
    case GL_FLOAT_VEC2:
    case GL_INT_VEC2:
    case GL_UNSIGNED_INT_VEC2:
        return 2;
    case GL_FLOAT_VEC3:
    case GL_INT_VEC3:
    case GL_UNSIGNED_INT_VEC3:
        return 3;
    case GL_FLOAT_VEC4:
    case GL_INT_VEC4:
    case GL_UNSIGNED_INT_VEC4:
    case GL_FLOAT_MAT2:
        return 4;
    case GL_FLOAT_MAT3:
        return 9;
    case GL_FLOAT_MAT4:
        return 16;
    case GL_FLOAT_MAT2x3:
    case GL_FLOAT_MAT3x2:
        return 6;
    case GL_FLOAT_MAT2x4:
    case GL_FLOAT_MAT4x2:
        return 8;
    case GL_FLOAT_MAT3x4:
    case GL_FLOAT_MAT4x3:
        return 12;
    default:
        return 1;
    }
}
std::string validate_source(const std::string& source)
{
    std::string clean;
    clean.reserve(source.size());
    bool line_comment = false, block_comment = false;
    for (size_t i = 0; i < source.size(); ++i) {
        unsigned char ch = (unsigned char)source[i];
        if (line_comment) {
            if (ch == '\n') {
                line_comment = false;
                clean += '\n';
            }
            continue;
        }
        if (block_comment) {
            if (ch == '*' && i + 1 < source.size() && source[i + 1] == '/') {
                block_comment = false;
                ++i;
                clean += ' ';
            } else if (ch == '\n')
                clean += '\n';
            continue;
        }
        if (ch == '/' && i + 1 < source.size() && source[i + 1] == '/') {
            line_comment = true;
            ++i;
            continue;
        }
        if (ch == '/' && i + 1 < source.size() && source[i + 1] == '*') {
            block_comment = true;
            ++i;
            continue;
        }
        clean += (char)ch;
    }
    std::istringstream lines(clean);
    std::string line;
    while (std::getline(lines, line)) {
        size_t at = line.find_first_not_of(" \t\r");
        if (at == std::string::npos || line[at] != '#')
            continue;
        std::istringstream directive(line.substr(at + 1));
        std::string command, version, profile;
        directive >> command;
        if (command == "extension") {
            std::string extension, colon, behavior;
            directive >> extension >> colon >> behavior;
            if (behavior != "disable" && behavior != "warn")
                return "PollyUI: no optional shader-language extension is enabled";
        }
        if (command == "version") {
            directive >> version >> profile;
            if (version != "100" && (version != "300" || profile != "es"))
                return "PollyUI: WebGL2 shaders require GLSL ES 1.00 or 3.00";
        }
    }
    for (size_t i = 0; i < clean.size();) {
        if (std::isalpha((unsigned char)clean[i]) || clean[i] == '_') {
            size_t start = i++;
            while (i < clean.size() && (std::isalnum((unsigned char)clean[i]) || clean[i] == '_'))
                ++i;
            std::string identifier = clean.substr(start, i - start);
            if (identifier.size() > 256)
                return "PollyUI: GLSL token exceeds 256 characters";
            if (identifier.rfind("webgl_", 0) == 0 || identifier.rfind("_webgl_", 0) == 0)
                return "PollyUI: reserved WebGL shader identifier";
        } else
            ++i;
    }
    return { };
}
bool draw_bounds(PuGpuCanvas* c, unsigned first, unsigned count, unsigned instances, bool indexed,
    GLenum index_type, size_t index_offset, uint64_t capture_vertices)
{
    if (!c->program) {
        pu_gpu_error(c, GL_INVALID_OPERATION);
        return false;
    }
    auto gl = pu_gles();
    if (framebuffer_status(c, GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        pu_gpu_error(c, GL_INVALID_FRAMEBUFFER_OPERATION);
        return false;
    }
    auto& vao = c->vaos[c->vao];
    for (const auto& attribute : vao.attributes)
        if (attribute.enabled && !attribute.buffer) {
            pu_gpu_error(c, GL_INVALID_OPERATION);
            return false;
        }
    uint64_t maximum = count ? (uint64_t)first + count - 1 : 0;
    if (indexed) {
        unsigned size = index_type == GL_UNSIGNED_BYTE ? 1
            : index_type == GL_UNSIGNED_SHORT          ? 2
            : index_type == GL_UNSIGNED_INT            ? 4
                                                       : 0;
        if (!size) {
            pu_gpu_error(c, GL_INVALID_ENUM);
            return false;
        }
        auto r = vao.element;
        if (!r || index_offset % size || index_offset > r->data.size()
            || count > (r->data.size() - index_offset) / size) {
            pu_gpu_error(c, GL_INVALID_OPERATION);
            return false;
        }
        maximum = 0;
        for (unsigned i = 0; i < count; ++i) {
            uint32_t index = 0;
            memcpy(&index, r->data.data() + index_offset + (size_t)i * size, size);
            if (index == (size == 4 ? UINT32_MAX : size == 2 ? UINT16_MAX : UINT8_MAX))
                continue;
            maximum = std::max<uint64_t>(maximum, index);
        }
    }
    GLint active = 0;
    gl->GetProgramiv(c->program, GL_ACTIVE_ATTRIBUTES, &active);
    for (GLint i = 0; count && instances && i < active; ++i) {
        char name[1024];
        GLsizei length;
        GLint size;
        GLenum type;
        gl->GetActiveAttrib(c->program, i, sizeof(name), &length, &size, &type, name);
        GLint location = gl->GetAttribLocation(c->program, name);
        if (location < 0)
            continue;
        unsigned columns = type == GL_FLOAT_MAT4                 ? 4
            : type == GL_FLOAT_MAT3                              ? 3
            : type == GL_FLOAT_MAT2                              ? 2
            : type == GL_FLOAT_MAT2x3 || type == GL_FLOAT_MAT2x4 ? 2
            : type == GL_FLOAT_MAT3x2 || type == GL_FLOAT_MAT3x4 ? 3
            : type == GL_FLOAT_MAT4x2 || type == GL_FLOAT_MAT4x3 ? 4
                                                                 : 1;
        for (unsigned column = 0; column < columns * (unsigned)size; ++column) {
            unsigned slot = (unsigned)location + column;
            if (slot >= vao.attributes.size()) {
                pu_gpu_error(c, GL_INVALID_OPERATION);
                return false;
            }
            const auto& a = vao.attributes[slot];
            if (!a.enabled)
                continue;
            uint64_t index = a.divisor ? (instances - 1) / a.divisor : maximum;
            unsigned footprint = a.packed ? 4 : a.size * a.component;
            uint64_t end
                = (uint64_t)a.offset + index * (a.stride ? a.stride : footprint) + footprint;
            if (!a.buffer || end > a.buffer->data.size()) {
                pu_gpu_error(c, GL_INVALID_OPERATION);
                return false;
            }
        }
    }
    GLint blocks = 0;
    gl->GetProgramiv(c->program, GL_ACTIVE_UNIFORM_BLOCKS, &blocks);
    for (GLint block = 0; block < blocks; ++block) {
        GLint binding = 0, required = 0;
        gl->GetActiveUniformBlockiv(c->program, block, GL_UNIFORM_BLOCK_BINDING, &binding);
        gl->GetActiveUniformBlockiv(c->program, block, GL_UNIFORM_BLOCK_DATA_SIZE, &required);
        auto range = c->uniform_buffers[binding];
        if (range.whole && range.buffer)
            range.size = range.buffer->bytes;
        if (!range.buffer || range.size < (size_t)required || range.offset > range.buffer->bytes
            || range.size > range.buffer->bytes - range.offset) {
            pu_gpu_error(c, GL_INVALID_OPERATION);
            return false;
        }
    }
    if (c->feedback_active && !c->feedback_paused) {
        if (indexed) {
            pu_gpu_error(c, GL_INVALID_OPERATION);
            return false;
        }
        GLint varyings = 0, mode = 0, max_name = 0;
        gl->GetProgramiv(c->program, GL_TRANSFORM_FEEDBACK_VARYINGS, &varyings);
        gl->GetProgramiv(c->program, GL_TRANSFORM_FEEDBACK_BUFFER_MODE, &mode);
        gl->GetProgramiv(c->program, GL_TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH, &max_name);
        std::vector<char> name((size_t)std::max(1, max_name));
        std::vector<size_t> strides(mode == GL_INTERLEAVED_ATTRIBS ? 1 : (size_t)varyings);
        for (GLint i = 0; i < varyings; ++i) {
            GLsizei length = 0, size = 0;
            GLenum type = 0;
            gl->GetTransformFeedbackVarying(
                c->program, i, (GLsizei)name.size(), &length, &size, &type, name.data());
            strides[mode == GL_INTERLEAVED_ATTRIBS ? 0 : i] += (size_t)size * components(type) * 4;
        }
        auto& feedback = c->feedbacks[c->feedback];
        uint64_t vertices = (uint64_t)feedback.vertices + capture_vertices;
        for (unsigned i = 0; i < strides.size(); ++i) {
            auto range = feedback.bindings[i];
            if (range.whole && range.buffer)
                range.size = range.buffer->bytes;
            if (!range.buffer || !strides[i] || vertices > range.size / strides[i]
                || range.offset > range.buffer->bytes
                || range.size > range.buffer->bytes - range.offset) {
                pu_gpu_error(c, GL_INVALID_OPERATION);
                return false;
            }
            for (const auto& attribute : vao.attributes)
                if (attribute.enabled && attribute.buffer == range.buffer) {
                    pu_gpu_error(c, GL_INVALID_OPERATION);
                    return false;
                }
            for (const auto& uniform : c->uniform_buffers)
                if (uniform.second.buffer == range.buffer) {
                    pu_gpu_error(c, GL_INVALID_OPERATION);
                    return false;
                }
        }
    }
    if (c->draw_framebuffer) {
        GLint uniforms = 0, maximum = 0;
        gl->GetProgramiv(c->program, GL_ACTIVE_UNIFORMS, &uniforms);
        gl->GetProgramiv(c->program, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maximum);
        std::vector<char> name((size_t)std::max(1, maximum));
        for (GLint i = 0; i < uniforms; ++i) {
            GLsizei length;
            GLint size;
            GLenum type;
            gl->GetActiveUniform(
                c->program, i, (GLsizei)name.size(), &length, &size, &type, name.data());
            GLenum target = type == GL_SAMPLER_2D || type == GL_INT_SAMPLER_2D
                    || type == GL_UNSIGNED_INT_SAMPLER_2D || type == GL_SAMPLER_2D_SHADOW
                ? GL_TEXTURE_2D
                : type == GL_SAMPLER_CUBE || type == GL_SAMPLER_CUBE_SHADOW ? GL_TEXTURE_CUBE_MAP
                : type == GL_SAMPLER_3D                                     ? GL_TEXTURE_3D
                : type == GL_SAMPLER_2D_ARRAY || type == GL_SAMPLER_2D_ARRAY_SHADOW
                ? GL_TEXTURE_2D_ARRAY
                : 0;
            if (!target)
                continue;
            std::string base(name.data(), length);
            size_t bracket = base.find("[0]");
            for (GLint element = 0; element < size; ++element) {
                std::string item = base;
                if (bracket != std::string::npos)
                    item.replace(bracket, 3, "[" + std::to_string(element) + "]");
                GLint unit = 0;
                gl->GetUniformiv(
                    c->program, gl->GetUniformLocation(c->program, item.c_str()), &unit);
                if (unit < 0 || unit >= c->max_units) {
                    pu_gpu_error(c, GL_INVALID_OPERATION);
                    return false;
                }
                auto texture = c->textures[unit][target];
                if (texture)
                    for (const auto& attachment : c->draw_framebuffer->attachments)
                        if (attachment.second == texture) {
                            pu_gpu_error(c, GL_INVALID_OPERATION);
                            return false;
                        }
            }
        }
    }
    return true;
}
JSValue parameter(JSContext* ctx, PuGpuCanvas* c, GLenum name)
{
    auto gl = pu_gles();
    switch (name) {
    case GL_VENDOR:
    case GL_RENDERER:
    case GL_VERSION:
    case GL_SHADING_LANGUAGE_VERSION: {
        auto text = gl->GetString(name);
        return text ? JS_NewString(ctx, reinterpret_cast<const char*>(text)) : JS_NULL;
    }
    case GL_VIEWPORT:
    case GL_SCISSOR_BOX: {
        GLint values[4] = { };
        gl->GetIntegerv(name, values);
        return vector(ctx, values, 4);
    }
    case GL_MAX_VIEWPORT_DIMS: {
        GLint values[2] = { };
        gl->GetIntegerv(name, values);
        return vector(ctx, values, 2);
    }
    case GL_COLOR_CLEAR_VALUE:
    case GL_BLEND_COLOR: {
        GLfloat values[4] = { };
        gl->GetFloatv(name, values);
        return floats(ctx, values, 4);
    }
    case GL_DEPTH_RANGE:
    case GL_ALIASED_POINT_SIZE_RANGE:
    case GL_ALIASED_LINE_WIDTH_RANGE: {
        GLfloat values[2] = { };
        gl->GetFloatv(name, values);
        return floats(ctx, values, 2);
    }
    case GL_COLOR_WRITEMASK: {
        GLboolean values[4] = { };
        gl->GetBooleanv(name, values);
        JSValue result = JS_NewArray(ctx);
        for (uint32_t i = 0; i < 4; ++i)
            JS_SetPropertyUint32(ctx, result, i, JS_NewBool(ctx, values[i]));
        return result;
    }
    case GL_DEPTH_CLEAR_VALUE:
    case GL_LINE_WIDTH:
    case GL_POLYGON_OFFSET_FACTOR:
    case GL_MAX_TEXTURE_LOD_BIAS:
    case GL_POLYGON_OFFSET_UNITS:
    case GL_SAMPLE_COVERAGE_VALUE: {
        GLfloat value = 0;
        gl->GetFloatv(name, &value);
        return JS_NewFloat64(ctx, value);
    }
    case GL_CULL_FACE:
    case GL_BLEND:
    case GL_DITHER:
    case GL_STENCIL_TEST:
    case GL_DEPTH_TEST:
    case GL_SCISSOR_TEST:
    case GL_POLYGON_OFFSET_FILL:
    case GL_SAMPLE_ALPHA_TO_COVERAGE:
    case GL_SAMPLE_COVERAGE:
    case GL_RASTERIZER_DISCARD:
        return JS_NewBool(ctx, gl->IsEnabled(name));
    case GL_DEPTH_WRITEMASK:
    case GL_SAMPLE_COVERAGE_INVERT: {
        GLboolean value = 0;
        gl->GetBooleanv(name, &value);
        return JS_NewBool(ctx, value);
    }
    case GL_TRANSFORM_FEEDBACK_ACTIVE:
        return JS_NewBool(ctx, c->feedback_active);
    case GL_TRANSFORM_FEEDBACK_PAUSED:
        return JS_NewBool(ctx, c->feedback_paused);
    case GL_MAX_ELEMENT_INDEX: {
        GLint64 value = 0;
        gl->GetInteger64v(name, &value);
        return JS_NewFloat64(ctx, (double)value);
    }
    case GL_MAX_SERVER_WAIT_TIMEOUT: {
        GLint64 value = 0;
        gl->GetInteger64v(name, &value);
        return JS_NewFloat64(ctx, (double)(uint64_t)value);
    }
    case GL_COMPRESSED_TEXTURE_FORMATS: {
        // No compressed extension is enabled. GLES3 ETC2/EAC is not WebGL2 core.
        return JS_NewArray(ctx);
    }
    default:
        break;
    }
    // Only scalar enumerants are permitted here: GLES may write arrays for other names.
    switch (name) {
    case GL_MAX_TEXTURE_SIZE:
    case GL_MAX_CUBE_MAP_TEXTURE_SIZE:
    case GL_MAX_3D_TEXTURE_SIZE:
    case GL_MAX_ARRAY_TEXTURE_LAYERS:
    case GL_MAX_VERTEX_ATTRIBS:
    case GL_MAX_TEXTURE_IMAGE_UNITS:
    case GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS:
    case GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS:
    case GL_MAX_VERTEX_UNIFORM_VECTORS:
    case GL_MAX_FRAGMENT_UNIFORM_VECTORS:
    case GL_MAX_VARYING_VECTORS:
    case GL_MAX_RENDERBUFFER_SIZE:
    case GL_MAX_DRAW_BUFFERS:
    case GL_MAX_COLOR_ATTACHMENTS:
    case GL_MAX_SAMPLES:
    case GL_MAX_UNIFORM_BUFFER_BINDINGS:
    case GL_MAX_UNIFORM_BLOCK_SIZE:
    case GL_MAX_VERTEX_UNIFORM_BLOCKS:
    case GL_MAX_FRAGMENT_UNIFORM_BLOCKS:
    case GL_MAX_COMBINED_UNIFORM_BLOCKS:
    case GL_UNIFORM_BUFFER_OFFSET_ALIGNMENT:
    case GL_MAX_VERTEX_UNIFORM_COMPONENTS:
    case GL_MAX_FRAGMENT_UNIFORM_COMPONENTS:
    case GL_MAX_VARYING_COMPONENTS:
    case GL_MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS:
    case GL_MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS:
    case GL_MAX_ELEMENTS_VERTICES:
    case GL_MAX_ELEMENTS_INDICES:
    case GL_MIN_PROGRAM_TEXEL_OFFSET:
    case GL_MAX_PROGRAM_TEXEL_OFFSET:
    case GL_MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS:
    case GL_MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS:
    case GL_MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS:
    case GL_MAX_VERTEX_OUTPUT_COMPONENTS:
    case GL_MAX_FRAGMENT_INPUT_COMPONENTS:
    case GL_FRAGMENT_SHADER_DERIVATIVE_HINT:
    case GL_IMPLEMENTATION_COLOR_READ_FORMAT:
    case GL_IMPLEMENTATION_COLOR_READ_TYPE:
    case GL_ACTIVE_TEXTURE:
    case GL_PACK_ALIGNMENT:
    case GL_UNPACK_ALIGNMENT:
    case GL_PACK_ROW_LENGTH:
    case GL_PACK_SKIP_ROWS:
    case GL_PACK_SKIP_PIXELS:
    case GL_UNPACK_ROW_LENGTH:
    case GL_UNPACK_SKIP_ROWS:
    case GL_UNPACK_SKIP_PIXELS:
    case GL_UNPACK_IMAGE_HEIGHT:
    case GL_UNPACK_SKIP_IMAGES:
    case GL_CULL_FACE_MODE:
    case GL_FRONT_FACE:
    case GL_DEPTH_FUNC:
    case GL_STENCIL_CLEAR_VALUE:
    case GL_STENCIL_FUNC:
    case GL_STENCIL_FAIL:
    case GL_STENCIL_PASS_DEPTH_FAIL:
    case GL_STENCIL_PASS_DEPTH_PASS:
    case GL_STENCIL_REF:
    case GL_STENCIL_VALUE_MASK:
    case GL_STENCIL_WRITEMASK:
    case GL_STENCIL_BACK_FUNC:
    case GL_STENCIL_BACK_FAIL:
    case GL_STENCIL_BACK_PASS_DEPTH_FAIL:
    case GL_STENCIL_BACK_PASS_DEPTH_PASS:
    case GL_STENCIL_BACK_REF:
    case GL_STENCIL_BACK_VALUE_MASK:
    case GL_STENCIL_BACK_WRITEMASK:
    case GL_BLEND_EQUATION_RGB:
    case GL_BLEND_EQUATION_ALPHA:
    case GL_BLEND_DST_RGB:
    case GL_BLEND_SRC_RGB:
    case GL_BLEND_DST_ALPHA:
    case GL_BLEND_SRC_ALPHA:
    case GL_SUBPIXEL_BITS:
    case GL_RED_BITS:
    case GL_GREEN_BITS:
    case GL_BLUE_BITS:
    case GL_ALPHA_BITS:
    case GL_DEPTH_BITS:
    case GL_STENCIL_BITS:
    case GL_SAMPLE_BUFFERS:
    case GL_SAMPLES:
    case GL_READ_BUFFER:
    case GL_GENERATE_MIPMAP_HINT: {
        GLint value = 0;
        gl->GetIntegerv(name, &value);
        if (name == GL_READ_BUFFER && !c->read_framebuffer && value == GL_COLOR_ATTACHMENT0)
            value = GL_BACK;
        return JS_NewInt32(ctx, value);
    }
    default:
        if (name >= GL_DRAW_BUFFER0 && name < GL_DRAW_BUFFER0 + 16) {
            GLint value = 0;
            gl->GetIntegerv(name, &value);
            if (!c->draw_framebuffer && value == GL_COLOR_ATTACHMENT0)
                value = GL_BACK;
            return JS_NewInt32(ctx, value);
        }
        pu_gpu_error(c, GL_INVALID_ENUM);
        return JS_NULL;
    }
}

JSValue dispatch(JSContext* ctx, PuGpuCanvas* c, const char* op, Arguments& a)
{
    auto gl = pu_gles();
#define IS(name) (!strcmp(op, name))
#define N(i) a.number(i)
#define I(i) a.integer(i)
#undef ERROR
#define ERROR(code)                                                                                \
    do {                                                                                           \
        pu_gpu_error(c, code);                                                                     \
        return JS_UNDEFINED;                                                                       \
    } while (0)
    if (IS("getError")) {
        GLenum error = GL_NO_ERROR;
        if (c->error_count) {
            error = c->errors[0];
            for (unsigned i = 1; i < c->error_count; ++i)
                c->errors[i - 1] = c->errors[i];
            --c->error_count;
        } else
            error = gl->GetError();
        return JS_NewUint32(ctx, error);
    }
    if (IS("getParameter"))
        return parameter(ctx, c, I(0));
    if ((IS("texStorage2D") || IS("texStorage3D")) && compressed_block(I(2)))
        ERROR(GL_INVALID_ENUM);
    if (IS("compressedTexImage2D") || IS("compressedTexImage3D") || IS("compressedTexSubImage2D")
        || IS("compressedTexSubImage3D")) {
        // Validate the binding before rejecting formats from an unenabled optional extension.
        GLenum target = I(0), binding = target;
        if (target >= GL_TEXTURE_CUBE_MAP_POSITIVE_X && target <= GL_TEXTURE_CUBE_MAP_NEGATIVE_Z)
            binding = GL_TEXTURE_CUBE_MAP;
        bool three = IS("compressedTexImage3D") || IS("compressedTexSubImage3D");
        if (three ? target != GL_TEXTURE_3D && target != GL_TEXTURE_2D_ARRAY
                  : binding != GL_TEXTURE_2D && binding != GL_TEXTURE_CUBE_MAP)
            ERROR(GL_INVALID_ENUM);
        if (!c->textures[c->active_texture][binding])
            ERROR(GL_INVALID_OPERATION);
        ERROR(GL_INVALID_ENUM);
    }
    if (IS("enable") || IS("disable") || IS("isEnabled")) {
        GLenum cap = I(0);
        if (cap != GL_CULL_FACE && cap != GL_BLEND && cap != GL_DITHER && cap != GL_STENCIL_TEST
            && cap != GL_DEPTH_TEST && cap != GL_SCISSOR_TEST && cap != GL_POLYGON_OFFSET_FILL
            && cap != GL_SAMPLE_ALPHA_TO_COVERAGE && cap != GL_SAMPLE_COVERAGE
            && cap != GL_RASTERIZER_DISCARD)
            ERROR(GL_INVALID_ENUM);
    }
    if (IS("error")) {
        pu_gpu_error(c, I(0));
        return JS_UNDEFINED;
    }
    if (IS("create")) {
        int kind = I(0);
        auto r = std::make_shared<PuGlResource>();
        r->kind = (PuGlKind)kind;
        r->generation = c->generation;
        switch (r->kind) {
        case PuGlKind::Buffer:
            gl->GenBuffers(1, &r->name);
            break;
        case PuGlKind::Texture:
            gl->GenTextures(1, &r->name);
            break;
        case PuGlKind::Framebuffer:
            gl->GenFramebuffers(1, &r->name);
            break;
        case PuGlKind::Renderbuffer:
            gl->GenRenderbuffers(1, &r->name);
            break;
        case PuGlKind::VertexArray:
            gl->GenVertexArrays(1, &r->name);
            c->vaos[r->name].attributes.resize(c->max_attributes);
            break;
        case PuGlKind::Shader:
            if (I(1) != GL_VERTEX_SHADER && I(1) != GL_FRAGMENT_SHADER)
                ERROR(GL_INVALID_ENUM);
            r->name = gl->CreateShader(I(1));
            break;
        case PuGlKind::Program:
            r->name = gl->CreateProgram();
            break;
        case PuGlKind::Sampler:
            gl->GenSamplers(1, &r->name);
            break;
        case PuGlKind::Query:
            gl->GenQueries(1, &r->name);
            break;
        case PuGlKind::TransformFeedback:
            gl->GenTransformFeedbacks(1, &r->name);
            break;
        default:
            return JS_ThrowTypeError(ctx, "Invalid native WebGL resource kind");
        }
        if (!r->name)
            return JS_NULL;
        c->resources.push_back(r);
        return handle_value(ctx, c, r);
    }
    if (IS("delete")) {
        auto h = static_cast<Handle*>(JS_GetOpaque(a.at(1), handle_class));
        if (!a.null(1)
            && (!h || h->canvas != c || !h->resource || h->resource->kind != (PuGlKind)I(0)))
            ERROR(GL_INVALID_OPERATION);
        if (h && h->resource)
            pu_gpu_delete(c, h->resource);
        return JS_UNDEFINED;
    }
    if (IS("is")) {
        auto h = static_cast<Handle*>(JS_GetOpaque(a.at(1), handle_class));
        return JS_NewBool(ctx,
            h && h->canvas == c && h->resource && h->resource->kind == (PuGlKind)I(0)
                && !h->resource->deleted && h->resource->generation == c->generation);
    }
    if (IS("bindBuffer")) {
        GLenum target = I(0);
        if (!buffer_target(target))
            ERROR(GL_INVALID_ENUM);
        auto r = resource(c, a.at(1), PuGlKind::Buffer);
        if (!a.null(1) && !r)
            return JS_UNDEFINED;
        if (r && r->target
            && ((r->target == GL_ELEMENT_ARRAY_BUFFER) != (target == GL_ELEMENT_ARRAY_BUFFER))
            && target != GL_COPY_READ_BUFFER && target != GL_COPY_WRITE_BUFFER)
            ERROR(GL_INVALID_OPERATION);
        gl->BindBuffer(target, r ? r->name : 0);
        GLenum bind_error = gl->GetError();
        if (bind_error)
            ERROR(bind_error);
        if (r && !r->target)
            r->target = target;
        if (target == GL_ELEMENT_ARRAY_BUFFER)
            c->vaos[c->vao].element = r;
        else
            c->buffers[target] = r;
        return JS_UNDEFINED;
    }
    if (IS("bufferData") || IS("bufferSubData")) {
        GLenum target = I(0);
        auto r = bound_buffer(c, target);
        if (!r)
            return JS_UNDEFINED;
        if (IS("bufferData")) {
            GLenum usage = I(2);
            if (usage != GL_STATIC_DRAW && usage != GL_DYNAMIC_DRAW && usage != GL_STREAM_DRAW
                && usage != GL_STATIC_READ && usage != GL_DYNAMIC_READ && usage != GL_STREAM_READ
                && usage != GL_STATIC_COPY && usage != GL_DYNAMIC_COPY && usage != GL_STREAM_COPY)
                ERROR(GL_INVALID_ENUM);
            size_t length;
            Bytes bytes(ctx, a.at(1));
            if (JS_IsNumber(a.at(1))) {
                double size = N(1);
                if (size < 0 || size > PU_IMAGE_BYTE_LIMIT || std::trunc(size) != size)
                    ERROR(GL_INVALID_VALUE);
                length = (size_t)size;
            } else {
                if (!bytes.data)
                    ERROR(GL_INVALID_VALUE);
                length = bytes.length;
            }
            size_t old_bytes = r->bytes;
            if (!reserve(c, r, length))
                return JS_UNDEFINED;
            std::vector<uint8_t> next(length, 0);
            if (bytes.data && length)
                memcpy(next.data(), bytes.data, length);
            gl->BufferData(target, length, length ? next.data() : nullptr, usage);
            GLenum error = gl->GetError();
            if (error) {
                r->bytes = old_bytes;
                ERROR(error);
            }
            r->data = std::move(next);
        } else {
            double offset = N(1);
            Bytes bytes(ctx, a.at(2));
            if (offset < 0 || std::trunc(offset) != offset || !bytes.data || offset > r->data.size()
                || bytes.length > r->data.size() - (size_t)offset)
                ERROR(GL_INVALID_VALUE);
            std::vector<uint8_t> owned(bytes.length);
            if (bytes.length)
                memcpy(owned.data(), bytes.data, bytes.length);
            gl->BufferSubData(target, (GLintptr)offset, bytes.length, owned.data());
            GLenum error = gl->GetError();
            if (error)
                ERROR(error);
            if (bytes.length)
                memcpy(r->data.data() + (size_t)offset, owned.data(), bytes.length);
        }
        return JS_UNDEFINED;
    }
    if (IS("getBufferParameter")) {
        if (!bound_buffer(c, I(0)))
            return JS_NULL;
        if (I(1) != GL_BUFFER_SIZE && I(1) != GL_BUFFER_USAGE)
            ERROR(GL_INVALID_ENUM);
        GLint value = 0;
        gl->GetBufferParameteriv(I(0), I(1), &value);
        return JS_NewInt32(ctx, value);
    }
    if (IS("getBufferSubData")) {
        auto r = bound_buffer(c, I(0));
        if (!r)
            return JS_UNDEFINED;
        Bytes bytes(ctx, a.at(2));
        double offset = N(1);
        if (!bytes.data || offset < 0 || std::trunc(offset) != offset || offset > r->data.size()
            || bytes.length > r->data.size() - (size_t)offset)
            ERROR(GL_INVALID_VALUE);
        if (bytes.length) {
            const void* mapped
                = gl->MapBufferRange(I(0), (GLintptr)offset, bytes.length, GL_MAP_READ_BIT);
            if (!mapped)
                ERROR(GL_INVALID_OPERATION);
            memcpy(bytes.data, mapped, bytes.length);
            memcpy(r->data.data() + (size_t)offset, mapped, bytes.length);
            if (!gl->UnmapBuffer(I(0)))
                ERROR(GL_INVALID_OPERATION);
        }
        return JS_UNDEFINED;
    }
    if (IS("copyBufferSubData")) {
        auto read = bound_buffer(c, I(0)), write = bound_buffer(c, I(1));
        if (!read || !write)
            return JS_UNDEFINED;
        double ro = N(2), wo = N(3), size = N(4);
        if (ro < 0 || wo < 0 || size < 0 || ro > read->data.size() || wo > write->data.size()
            || size > read->data.size() - ro || size > write->data.size() - wo
            || std::trunc(ro) != ro || std::trunc(wo) != wo || std::trunc(size) != size)
            ERROR(GL_INVALID_VALUE);
        if (read == write && ro < wo + size && wo < ro + size)
            ERROR(GL_INVALID_VALUE);
        gl->CopyBufferSubData(I(0), I(1), (GLintptr)ro, (GLintptr)wo, (GLsizeiptr)size);
        GLenum error = gl->GetError();
        if (error)
            ERROR(error);
        if (size) {
            const void* mapped
                = gl->MapBufferRange(I(1), (GLintptr)wo, (GLsizeiptr)size, GL_MAP_READ_BIT);
            if (!mapped)
                ERROR(GL_INVALID_OPERATION);
            memcpy(write->data.data() + (size_t)wo, mapped, (size_t)size);
            if (!gl->UnmapBuffer(I(1)))
                ERROR(GL_INVALID_OPERATION);
        }
        return JS_UNDEFINED;
    }
    if (IS("bindVertexArray")) {
        auto r = resource(c, a.at(0), PuGlKind::VertexArray);
        if (!a.null(0) && !r)
            return JS_UNDEFINED;
        GLuint selected = r ? r->name : 0;
        gl->BindVertexArray(selected);
        GLenum bind_error = gl->GetError();
        if (bind_error)
            ERROR(bind_error);
        c->vao = selected;
        return JS_UNDEFINED;
    }
    if (IS("enableVertexAttribArray") || IS("disableVertexAttribArray") || IS("vertexAttribDivisor")
        || IS("vertexAttribPointer") || IS("vertexAttribIPointer")) {
        int index = I(0);
        if (index < 0 || index >= c->max_attributes)
            ERROR(GL_INVALID_VALUE);
        auto& v = c->vaos[c->vao].attributes[index];
        if (IS("enableVertexAttribArray")) {
            gl->EnableVertexAttribArray(index);
            GLenum attribute_error = gl->GetError();
            if (attribute_error)
                ERROR(attribute_error);
            v.enabled = true;
        } else if (IS("disableVertexAttribArray")) {
            gl->DisableVertexAttribArray(index);
            GLenum attribute_error = gl->GetError();
            if (attribute_error)
                ERROR(attribute_error);
            v.enabled = false;
        } else if (IS("vertexAttribDivisor")) {
            if (N(1) < 0)
                ERROR(GL_INVALID_VALUE);
            gl->VertexAttribDivisor(index, I(1));
            GLenum attribute_error = gl->GetError();
            if (attribute_error)
                ERROR(attribute_error);
            v.divisor = I(1);
        } else {
            bool integral = IS("vertexAttribIPointer");
            int size = I(1), type = I(2), stride = I(integral ? 3 : 4);
            double offset = N(integral ? 4 : 5);
            bool packed = type == GL_INT_2_10_10_10_REV || type == GL_UNSIGNED_INT_2_10_10_10_REV;
            unsigned component = packed ? 4 : component_size(type);
            if (packed && (integral || size != 4))
                ERROR(GL_INVALID_OPERATION);
            if (!component || (integral && (type == GL_FLOAT || type == GL_HALF_FLOAT)))
                ERROR(GL_INVALID_ENUM);
            if (size < 1 || size > 4 || stride < 0 || stride > 255 || offset < 0
                || offset > UINT32_MAX || std::trunc(offset) != offset || (size_t)offset % component
                || stride % component)
                ERROR(GL_INVALID_VALUE);
            auto buffer = c->buffers[GL_ARRAY_BUFFER];
            if (!buffer)
                ERROR(GL_INVALID_OPERATION);
            if (integral)
                gl->VertexAttribIPointer(
                    index, size, type, stride, reinterpret_cast<void*>((uintptr_t)offset));
            else
                gl->VertexAttribPointer(index, size, type, I(3) != 0, stride,
                    reinterpret_cast<void*>((uintptr_t)offset));
            GLenum attribute_error = gl->GetError();
            if (attribute_error)
                ERROR(attribute_error);
            v.buffer = buffer;
            v.size = size;
            v.stride = stride;
            v.offset = (unsigned)offset;
            v.component = component;
            v.packed = packed;
        }
        return JS_UNDEFINED;
    }
    if (IS("shaderSource") || IS("compileShader") || IS("getShaderParameter")
        || IS("getShaderInfoLog") || IS("getShaderSource")) {
        auto r = resource(c, a.at(0), PuGlKind::Shader, true);
        if (!r)
            return JS_NULL;
        if (IS("shaderSource")) {
            if (!JS_IsString(a.at(1)))
                return JS_ThrowTypeError(ctx, "Invalid shader source");
            size_t length;
            const char* text = JS_ToCStringLen(ctx, &length, a.at(1));
            if (!text)
                return JS_EXCEPTION;
            if (length > 1024 * 1024) {
                JS_FreeCString(ctx, text);
                ERROR(GL_INVALID_VALUE);
            }
            r->source.assign(text, length);
            const GLint source_length = (GLint)length;
            gl->ShaderSource(r->name, 1, &text, &source_length);
            JS_FreeCString(ctx, text);
        } else if (IS("compileShader")) {
            r->validation.clear();
            r->validation = validate_source(r->source);
            // Run the real backend compiler even when the compatibility validator rejects the
            // source.
            gl->CompileShader(r->name);
        } else if (IS("getShaderSource"))
            return JS_NewStringLen(ctx, r->source.data(), r->source.size());
        else if (IS("getShaderParameter")) {
            GLenum pname = I(1);
            if (pname != GL_SHADER_TYPE && pname != GL_COMPILE_STATUS && pname != GL_DELETE_STATUS)
                ERROR(GL_INVALID_ENUM);
            GLint value = 0;
            gl->GetShaderiv(r->name, pname, &value);
            if (pname == GL_COMPILE_STATUS && !r->validation.empty())
                value = 0;
            return pname == GL_SHADER_TYPE ? JS_NewInt32(ctx, value) : JS_NewBool(ctx, value);
        } else {
            GLint length = 0;
            gl->GetShaderiv(r->name, GL_INFO_LOG_LENGTH, &length);
            std::string text((size_t)std::max(1, length), '\0');
            gl->GetShaderInfoLog(r->name, (GLsizei)text.size(), nullptr, text.data());
            if (!r->validation.empty())
                text = r->validation + "\n" + text.c_str();
            return JS_NewString(ctx, text.c_str());
        }
        return JS_UNDEFINED;
    }
    if (IS("getShaderPrecisionFormat")) {
        GLint range[2] = { }, precision = 0;
        gl->GetShaderPrecisionFormat(I(0), I(1), range, &precision);
        JSValue result = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, result, "rangeMin", JS_NewInt32(ctx, range[0]));
        JS_SetPropertyStr(ctx, result, "rangeMax", JS_NewInt32(ctx, range[1]));
        JS_SetPropertyStr(ctx, result, "precision", JS_NewInt32(ctx, precision));
        return result;
    }
    if (IS("attachShader") || IS("detachShader") || IS("linkProgram") || IS("validateProgram")
        || IS("useProgram") || IS("getProgramParameter") || IS("getProgramInfoLog")
        || IS("bindAttribLocation") || IS("getAttribLocation") || IS("getUniformLocation")
        || IS("getActiveAttrib") || IS("getActiveUniform")) {
        auto r = resource(c, a.at(0), PuGlKind::Program, true);
        if (IS("useProgram") && a.null(0)) {
            gl->UseProgram(0);
            GLenum error = gl->GetError();
            if (error)
                ERROR(error);
            c->program = 0;
            c->current_program.reset();
            return JS_UNDEFINED;
        }
        if (!r)
            return JS_NULL;
        if (IS("attachShader") || IS("detachShader")) {
            auto shader = resource(c, a.at(1), PuGlKind::Shader, true);
            if (!shader)
                return JS_UNDEFINED;
            if (IS("attachShader")) {
                gl->AttachShader(r->name, shader->name);
                GLenum error = gl->GetError();
                if (error)
                    ERROR(error);
                r->shaders.push_back(shader);
            } else {
                gl->DetachShader(r->name, shader->name);
                GLenum error = gl->GetError();
                if (error)
                    ERROR(error);
                r->shaders.erase(
                    std::remove(r->shaders.begin(), r->shaders.end(), shader), r->shaders.end());
            }
        } else if (IS("linkProgram")) {
            ++c->links[r->name];
            r->validation.clear();
            for (const auto& shader : r->shaders)
                if (!shader->validation.empty())
                    r->validation = shader->validation;
            gl->LinkProgram(r->name);
        } else if (IS("validateProgram"))
            gl->ValidateProgram(r->name);
        else if (IS("useProgram")) {
            if (r->deleted)
                ERROR(GL_INVALID_OPERATION);
            GLint linked = 0;
            gl->GetProgramiv(r->name, GL_LINK_STATUS, &linked);
            if (!linked || !r->validation.empty())
                ERROR(GL_INVALID_OPERATION);
            gl->UseProgram(r->name);
            GLenum error = gl->GetError();
            if (error)
                ERROR(error);
            c->program = r->name;
            c->current_program = r;
        } else if (IS("getProgramParameter")) {
            GLenum pname = I(1);
            if (pname != GL_LINK_STATUS && pname != GL_VALIDATE_STATUS && pname != GL_DELETE_STATUS
                && pname != GL_ATTACHED_SHADERS && pname != GL_ACTIVE_UNIFORMS
                && pname != GL_ACTIVE_ATTRIBUTES && pname != GL_ACTIVE_UNIFORM_BLOCKS
                && pname != GL_TRANSFORM_FEEDBACK_VARYINGS
                && pname != GL_TRANSFORM_FEEDBACK_BUFFER_MODE)
                ERROR(GL_INVALID_ENUM);
            GLint value = 0;
            gl->GetProgramiv(r->name, pname, &value);
            if (pname == GL_LINK_STATUS && !r->validation.empty())
                value = 0;
            return pname == GL_LINK_STATUS || pname == GL_VALIDATE_STATUS
                    || pname == GL_DELETE_STATUS
                ? JS_NewBool(ctx, value)
                : JS_NewInt32(ctx, value);
        } else if (IS("getProgramInfoLog")) {
            GLint length = 0;
            gl->GetProgramiv(r->name, GL_INFO_LOG_LENGTH, &length);
            std::string text((size_t)std::max(1, length), '\0');
            gl->GetProgramInfoLog(r->name, (GLsizei)text.size(), nullptr, text.data());
            if (!r->validation.empty())
                text = r->validation + "\n" + text.c_str();
            return JS_NewString(ctx, text.c_str());
        } else if (IS("getActiveAttrib") || IS("getActiveUniform")) {
            GLint maximum = 0;
            gl->GetProgramiv(r->name,
                IS("getActiveAttrib") ? GL_ACTIVE_ATTRIBUTE_MAX_LENGTH
                                      : GL_ACTIVE_UNIFORM_MAX_LENGTH,
                &maximum);
            std::vector<char> name((size_t)std::max(1, maximum));
            GLsizei length = 0;
            GLint size = 0;
            GLenum type = 0;
            if (IS("getActiveAttrib"))
                gl->GetActiveAttrib(
                    r->name, I(1), (GLsizei)name.size(), &length, &size, &type, name.data());
            else
                gl->GetActiveUniform(
                    r->name, I(1), (GLsizei)name.size(), &length, &size, &type, name.data());
            if (!length)
                return JS_NULL;
            JSValue result = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, result, "name", JS_NewStringLen(ctx, name.data(), length));
            JS_SetPropertyStr(ctx, result, "size", JS_NewInt32(ctx, size));
            JS_SetPropertyStr(ctx, result, "type", JS_NewUint32(ctx, type));
            return result;
        } else {
            size_t slot = IS("bindAttribLocation") ? 2 : 1;
            if (!JS_IsString(a.at(slot)))
                return JS_ThrowTypeError(ctx, "Expected shader variable name");
            const char* name = JS_ToCString(ctx, a.at(slot));
            if (!name)
                return JS_EXCEPTION;
            size_t name_length = strlen(name);
            bool valid_name = name_length <= 256;
            for (size_t i = 0; i < name_length; ++i)
                if ((unsigned char)name[i] >= 128)
                    valid_name = false;
            if (!valid_name) {
                JS_FreeCString(ctx, name);
                ERROR(GL_INVALID_VALUE);
            }
            GLint location = -1;
            if (IS("bindAttribLocation"))
                gl->BindAttribLocation(r->name, I(1), name);
            else if (IS("getAttribLocation"))
                location = gl->GetAttribLocation(r->name, name);
            else
                location = gl->GetUniformLocation(r->name, name);
            JS_FreeCString(ctx, name);
            if (IS("getAttribLocation"))
                return JS_NewInt32(ctx, location);
            if (IS("getUniformLocation")) {
                if (location < 0)
                    return JS_NULL;
                auto uniform = std::make_shared<PuGlResource>();
                uniform->kind = PuGlKind::Uniform;
                uniform->name = location;
                uniform->generation = c->generation;
                uniform->program = r->name;
                uniform->link_generation = c->links[r->name];
                return handle_value(ctx, c, uniform);
            }
        }
        if (IS("attachShader")) {
            auto shader = resource(c, a.at(1), PuGlKind::Shader, true);
            if (shader)
                shader->program = r->name;
        }
        return JS_UNDEFINED;
    }
    if (!strncmp(op, "uniform", 7) && strcmp(op, "uniformBlockBinding")) {
        if (a.null(0))
            return JS_UNDEFINED;
        auto r = resource(c, a.at(0), PuGlKind::Uniform);
        if (!r)
            return JS_UNDEFINED;
        if (r->program != c->program || r->link_generation != c->links[r->program])
            ERROR(GL_INVALID_OPERATION);
#define SCALAR(name, count, member, convert)                                                       \
    if (IS(name)) {                                                                                \
        gl->member(r->name, convert(1) count);                                                     \
        return JS_UNDEFINED;                                                                       \
    }
        if (IS("uniform1f")) {
            gl->Uniform1f(r->name, N(1));
            return JS_UNDEFINED;
        }
        if (IS("uniform2f")) {
            gl->Uniform2f(r->name, N(1), N(2));
            return JS_UNDEFINED;
        }
        if (IS("uniform3f")) {
            gl->Uniform3f(r->name, N(1), N(2), N(3));
            return JS_UNDEFINED;
        }
        if (IS("uniform4f")) {
            gl->Uniform4f(r->name, N(1), N(2), N(3), N(4));
            return JS_UNDEFINED;
        }
        if (IS("uniform1i")) {
            gl->Uniform1i(r->name, I(1));
            return JS_UNDEFINED;
        }
        if (IS("uniform2i")) {
            gl->Uniform2i(r->name, I(1), I(2));
            return JS_UNDEFINED;
        }
        if (IS("uniform3i")) {
            gl->Uniform3i(r->name, I(1), I(2), I(3));
            return JS_UNDEFINED;
        }
        if (IS("uniform4i")) {
            gl->Uniform4i(r->name, I(1), I(2), I(3), I(4));
            return JS_UNDEFINED;
        }
        if (IS("uniform1ui")) {
            gl->Uniform1ui(r->name, I(1));
            return JS_UNDEFINED;
        }
        if (IS("uniform2ui")) {
            gl->Uniform2ui(r->name, I(1), I(2));
            return JS_UNDEFINED;
        }
        if (IS("uniform3ui")) {
            gl->Uniform3ui(r->name, I(1), I(2), I(3));
            return JS_UNDEFINED;
        }
        if (IS("uniform4ui")) {
            gl->Uniform4ui(r->name, I(1), I(2), I(3), I(4));
            return JS_UNDEFINED;
        }
        bool matrix = !strncmp(op, "uniformMatrix", 13);
        Bytes bytes(ctx, a.at(matrix ? 2 : 1));
        if (!bytes.data || bytes.length % 4)
            ERROR(GL_INVALID_VALUE);
        if (matrix && I(1))
            ERROR(GL_INVALID_VALUE);
#define ARRAY(label, width, member, scalar_type, array_type)                                       \
    if (IS(label)) {                                                                               \
        if (bytes.type != array_type || bytes.length % (4 * width))                                \
            ERROR(GL_INVALID_OPERATION);                                                           \
        gl->member(r->name, (GLsizei)(bytes.length / (4 * width)),                                 \
            reinterpret_cast<const scalar_type*>(bytes.data));                                     \
        return JS_UNDEFINED;                                                                       \
    }
        ARRAY("uniform1fv", 1, Uniform1fv, GLfloat, JS_TYPED_ARRAY_FLOAT32)
        ARRAY("uniform2fv", 2, Uniform2fv, GLfloat, JS_TYPED_ARRAY_FLOAT32)
        ARRAY("uniform3fv", 3, Uniform3fv, GLfloat, JS_TYPED_ARRAY_FLOAT32)
        ARRAY("uniform4fv", 4, Uniform4fv, GLfloat, JS_TYPED_ARRAY_FLOAT32)
        ARRAY("uniform1iv", 1, Uniform1iv, GLint, JS_TYPED_ARRAY_INT32)
        ARRAY("uniform2iv", 2, Uniform2iv, GLint, JS_TYPED_ARRAY_INT32)
        ARRAY("uniform3iv", 3, Uniform3iv, GLint, JS_TYPED_ARRAY_INT32)
        ARRAY("uniform4iv", 4, Uniform4iv, GLint, JS_TYPED_ARRAY_INT32)
        ARRAY("uniform1uiv", 1, Uniform1uiv, GLuint, JS_TYPED_ARRAY_UINT32)
        ARRAY("uniform2uiv", 2, Uniform2uiv, GLuint, JS_TYPED_ARRAY_UINT32)
        ARRAY("uniform3uiv", 3, Uniform3uiv, GLuint, JS_TYPED_ARRAY_UINT32)
        ARRAY("uniform4uiv", 4, Uniform4uiv, GLuint, JS_TYPED_ARRAY_UINT32)
#undef ARRAY
#define MATRIX(label, width, member)                                                               \
    if (IS(label)) {                                                                               \
        if (bytes.type != JS_TYPED_ARRAY_FLOAT32 || bytes.length % (4 * width))                    \
            ERROR(GL_INVALID_OPERATION);                                                           \
        gl->member(r->name, (GLsizei)(bytes.length / (4 * width)), GL_FALSE,                       \
            reinterpret_cast<const GLfloat*>(bytes.data));                                         \
        return JS_UNDEFINED;                                                                       \
    }
        MATRIX("uniformMatrix2fv", 4, UniformMatrix2fv)
        MATRIX("uniformMatrix3fv", 9, UniformMatrix3fv)
        MATRIX("uniformMatrix4fv", 16, UniformMatrix4fv)
        MATRIX("uniformMatrix2x3fv", 6, UniformMatrix2x3fv)
        MATRIX("uniformMatrix3x2fv", 6, UniformMatrix3x2fv)
        MATRIX("uniformMatrix2x4fv", 8, UniformMatrix2x4fv)
        MATRIX("uniformMatrix4x2fv", 8, UniformMatrix4x2fv)
        MATRIX("uniformMatrix3x4fv", 12, UniformMatrix3x4fv)
        MATRIX("uniformMatrix4x3fv", 12, UniformMatrix4x3fv)
#undef MATRIX
    }
    if (IS("drawArrays") || IS("drawElements") || IS("drawArraysInstanced")
        || IS("drawElementsInstanced")) {
        bool indexed = IS("drawElements") || IS("drawElementsInstanced");
        int count = I(indexed ? 1 : 2), first = indexed ? 0 : I(1);
        int instances = IS("drawArraysInstanced") ? I(3) : IS("drawElementsInstanced") ? I(4) : 1;
        if (I(0) < GL_POINTS || I(0) > GL_TRIANGLE_FAN)
            ERROR(GL_INVALID_ENUM);
        if (first < 0 || count < 0 || instances < 0
            || (indexed
                && (!std::isfinite(N(3)) || N(3) < 0 || N(3) > PU_IMAGE_BYTE_LIMIT
                    || std::trunc(N(3)) != N(3))))
            ERROR(GL_INVALID_VALUE);
        uint64_t capture_count = count;
        if (c->feedback_active && !c->feedback_paused) {
            GLenum mode = I(0);
            GLenum primitive = mode == GL_POINTS ? GL_POINTS
                : mode <= GL_LINE_STRIP          ? GL_LINES
                                                 : GL_TRIANGLES;
            if (primitive != c->feedback_mode)
                ERROR(GL_INVALID_OPERATION);
            if (mode == GL_LINES)
                capture_count = count / 2 * 2;
            else if (mode == GL_TRIANGLES)
                capture_count = count / 3 * 3;
            else if (mode == GL_LINE_STRIP)
                capture_count = count > 1 ? (uint64_t)(count - 1) * 2 : 0;
            else if (mode == GL_LINE_LOOP)
                capture_count = count > 1 ? (uint64_t)count * 2 : 0;
            else if (mode == GL_TRIANGLE_STRIP || mode == GL_TRIANGLE_FAN)
                capture_count = count > 2 ? (uint64_t)(count - 2) * 3 : 0;
        }
        if (!draw_bounds(c, first, count, instances, indexed, indexed ? I(2) : 0,
                indexed ? (size_t)N(3) : 0, capture_count * instances))
            return JS_UNDEFINED;
        if (indexed) {
            const void* offset = reinterpret_cast<void*>((uintptr_t)N(3));
            if (IS("drawElementsInstanced"))
                gl->DrawElementsInstanced(I(0), count, I(2), offset, instances);
            else
                gl->DrawElements(I(0), count, I(2), offset);
        } else if (IS("drawArraysInstanced"))
            gl->DrawArraysInstanced(I(0), first, count, instances);
        else
            gl->DrawArrays(I(0), first, count);
        GLenum error = gl->GetError();
        if (error)
            ERROR(error);
        if (c->feedback_active && !c->feedback_paused)
            c->feedbacks[c->feedback].vertices += (size_t)(capture_count * instances);
        if (!c->draw_framebuffer)
            ++c->revision;
        return JS_UNDEFINED;
    }
    // Further operation families are in the included dispatch body, under the same context guard.
#include "bridge/webgl_pixels.inc"
#include "bridge/webgl_advanced.inc"
#include "bridge/webgl_copy.inc"
#define CALL0(name, member)                                                                        \
    if (IS(name)) {                                                                                \
        gl->member();                                                                              \
        return JS_UNDEFINED;                                                                       \
    }
#define CALL1(name, member, t)                                                                     \
    if (IS(name)) {                                                                                \
        gl->member(t(0));                                                                          \
        return JS_UNDEFINED;                                                                       \
    }
#define CALL2(name, member, t)                                                                     \
    if (IS(name)) {                                                                                \
        gl->member(t(0), t(1));                                                                    \
        return JS_UNDEFINED;                                                                       \
    }
#define CALL3(name, member, t)                                                                     \
    if (IS(name)) {                                                                                \
        gl->member(t(0), t(1), t(2));                                                              \
        return JS_UNDEFINED;                                                                       \
    }
#define CALL4(name, member, t)                                                                     \
    if (IS(name)) {                                                                                \
        gl->member(t(0), t(1), t(2), t(3));                                                        \
        return JS_UNDEFINED;                                                                       \
    }
    CALL0("flush", Flush)
    CALL0("finish", Finish)
    CALL1("enable", Enable, I)
    CALL1("disable", Disable, I) CALL1("cullFace", CullFace, I) CALL1(
        "frontFace", FrontFace, I) CALL1("depthFunc", DepthFunc, I) CALL1("depthMask", DepthMask, I)
        CALL1("clearDepth", ClearDepthf, N) CALL1("clearStencil", ClearStencil, I) CALL1(
            "stencilMask", StencilMask, I) CALL1("lineWidth", LineWidth, N) CALL2("blendFunc",
            BlendFunc, I) CALL1("blendEquation", BlendEquation, I) CALL2("blendEquationSeparate",
            BlendEquationSeparate, I) CALL4("blendFuncSeparate", BlendFuncSeparate, I)
            CALL4("blendColor", BlendColor, N) CALL4("clearColor", ClearColor, N)
                CALL4("colorMask", ColorMask, I) CALL2("depthRange", DepthRangef, N)
                    CALL2("polygonOffset", PolygonOffset, N) CALL2("hint", Hint, I)
                        CALL3("stencilFunc", StencilFunc, I) CALL3("stencilOp", StencilOp, I)
                            CALL4("stencilFuncSeparate", StencilFuncSeparate, I)
                                CALL4("stencilOpSeparate", StencilOpSeparate, I)
                                    CALL2("stencilMaskSeparate", StencilMaskSeparate, I)
                                        CALL4("scissor", Scissor, I)
                                            CALL4("viewport", Viewport, I) if (IS("sampleCoverage"))
    {
        gl->SampleCoverage(N(0), I(1));
        return JS_UNDEFINED;
    }
    if (IS("isEnabled"))
        return JS_NewBool(ctx, gl->IsEnabled(I(0)));
    if (IS("clear")) {
        if (I(0) & ~(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT))
            ERROR(GL_INVALID_VALUE);
        if (framebuffer_status(c, GL_DRAW_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
            ERROR(GL_INVALID_FRAMEBUFFER_OPERATION);
        gl->Clear(I(0));
        if (!c->draw_framebuffer)
            ++c->revision;
        return JS_UNDEFINED;
    }
    return JS_ThrowTypeError(ctx, "WebGL2 operation is not implemented: %s", op);
#undef CALL0
#undef CALL1
#undef CALL2
#undef CALL3
#undef CALL4
#undef SCALAR
#undef ERROR
#undef N
#undef I
#undef IS
}
JSValue native_impl(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv)
{
    if (argc != 3 || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "Invalid native WebGL operation");
    const char* op = JS_ToCString(ctx, argv[1]);
    if (!op)
        return JS_EXCEPTION;
    std::string operation(op);
    JS_FreeCString(ctx, op);
    Arguments a(ctx, argv[2]);
    if (!a.valid)
        return JS_ThrowTypeError(ctx, "Invalid native WebGL argument array");
    if (operation == "constants")
        return constants(ctx);
    if (operation == "open") {
        PuNode* node = pu_bridge_node(argv[0]);
        if (!node || !node->tag || strcmp(node->tag, "canvas")
            || !JS_GetRuntimeOpaque(JS_GetRuntime(ctx)))
            return JS_ThrowTypeError(ctx, "Canvas scope is closed");
        if (!node->canvas)
            node->canvas = pu_canvas_create(300, 150);
        if (!node->canvas)
            return JS_ThrowOutOfMemory(ctx);
        auto c = pu_canvas_acquire_gpu(
            node->canvas, a.integer(0), a.integer(1), a.integer(2), a.integer(3), a.integer(4));
        return c ? handle_value(ctx, c) : JS_NULL;
    }
    if (operation == "storage") {
        PuNode* node = pu_bridge_node(argv[0]);
        auto c = node && node->canvas ? pu_canvas_gpu(node->canvas) : nullptr;
        if (!c || c->closed)
            return JS_ThrowTypeError(ctx, "Canvas GPU scope is closed");
        if (c->lost)
            return JS_UNDEFINED;
        GLenum format = (GLenum)a.integer(0);
        uint32_t width = (uint32_t)a.integer(1), height = (uint32_t)a.integer(2);
        if (!c->alpha) {
            pu_gpu_error(c, GL_INVALID_OPERATION);
            return JS_UNDEFINED;
        }
        if (format != GL_RGBA8 && format != GL_SRGB8_ALPHA8) {
            pu_gpu_error(c, GL_INVALID_ENUM);
            return JS_UNDEFINED;
        }
        if (width > (uint32_t)c->max_texture || height > (uint32_t)c->max_texture
            || (height && width > PU_CANVAS_PIXEL_LIMIT / height)) {
            pu_gpu_error(c, GL_INVALID_VALUE);
            return JS_UNDEFINED;
        }
        GLenum previous = c->storage_format;
        c->storage_format = format;
        if (!pu_canvas_resize(node->canvas, (int)width, (int)height)) {
            c->storage_format = previous;
            pu_gpu_error(c, GL_OUT_OF_MEMORY);
            return JS_UNDEFINED;
        }
        pu_layout_mark_dirty();
        pu_node_mark_paint_dirty(node);
        return JS_UNDEFINED;
    }
    auto h = static_cast<Handle*>(JS_GetOpaque(argv[0], handle_class));
    if (!h || h->resource)
        return JS_ThrowTypeError(ctx, "Invalid WebGL context receiver");
    auto c = h->canvas;
    if (operation == "format")
        return JS_NewUint32(ctx, c->storage_format);
    if (operation == "lost") {
        if (c->device.failed && !c->lost)
            pu_gpu_canvas_close(c);
        return JS_NewBool(ctx, c->lost);
    }
    if (operation == "lose" || operation == "close") {
        if (operation == "close")
            c->closed = true;
        pu_gpu_canvas_close(c);
        return JS_UNDEFINED;
    }
    if (operation == "restore")
        return JS_NewBool(ctx, c->lost && pu_gpu_restore(c));
    if (c->closed || !JS_GetRuntimeOpaque(JS_GetRuntime(ctx)))
        return JS_ThrowTypeError(ctx, "WebGL scope is closed");
    if (c->lost) {
        if (operation == "getError")
            return JS_NewInt32(ctx, 0);
        return JS_NULL;
    }
    // Snapshot argument references before switching EGL; no JS callbacks run inside the GL scope.
    PuGpuCurrent current(&c->device);
    if (!current.ok()) {
        pu_gpu_canvas_close(c);
        return JS_NULL;
    }
    c->command_error = false;
    JSValue result = dispatch(ctx, c, operation.c_str(), a);
    GLenum gl_error = pu_gles()->GetError();
    if (gl_error)
        pu_gpu_error(c, gl_error);
    if (!gl_error && !c->command_error
        && (operation == "vertexAttrib1f" || operation == "vertexAttrib2f"
            || operation == "vertexAttrib3f" || operation == "vertexAttrib4f"
            || operation == "vertexAttribI4i" || operation == "vertexAttribI4ui")) {
        unsigned index = (unsigned)a.integer(0);
        if (index < c->attribute_types.size())
            c->attribute_types[index] = operation == "vertexAttribI4i" ? GL_INT
                : operation == "vertexAttribI4ui"                      ? GL_UNSIGNED_INT
                                                                       : GL_FLOAT;
    }
    bool driver_lost = gl_error == 0x0507 /* GL_CONTEXT_LOST */
        || (operation == "getError" && JS_IsNumber(result) && a.valid && [&]() {
               uint32_t error = 0;
               JS_ToUint32(ctx, &error, result);
               return error == 0x0507;
           }());
    if (driver_lost)
        pu_gpu_canvas_close(c);
    if (gl_error && operation.rfind("get", 0) == 0 && operation != "getError"
        && !JS_IsException(result)) {
        JS_FreeValue(ctx, result);
        result = JS_NULL;
    }
    if ((operation.rfind("bind", 0) == 0 || operation == "useProgram"
            || operation == "activeTexture" || operation == "vertexAttribPointer"
            || operation == "vertexAttribIPointer" || operation.rfind("framebuffer", 0) == 0
            || operation == "attachShader" || operation == "detachShader"
            || operation == "beginQuery" || operation == "endQuery" || operation == "delete")
        && !JS_IsException(result)) {
        JS_FreeValue(ctx, result);
        result = c->command_error ? JS_UNDEFINED : JS_TRUE;
    }
    if (!a.valid) {
        JS_FreeValue(ctx, result);
        return JS_ThrowTypeError(ctx, "Invalid normalized WebGL argument");
    }
    if (JS_HasException(ctx) && !JS_IsException(result)) {
        JS_FreeValue(ctx, result);
        return JS_EXCEPTION;
    }
    return result;
}
JSValue native(JSContext* ctx, JSValueConst self, int argc, JSValueConst* argv)
{
    try {
        return native_impl(ctx, self, argc, argv);
    } catch (const std::bad_alloc&) {
        return JS_ThrowOutOfMemory(ctx);
    }
}
}
#else
static JSValue native(JSContext*, JSValueConst, int, JSValueConst*) { return JS_NULL; }
#endif
JSValue pu_webgl_factory(JSContext* ctx)
{
#ifdef PU_WEBGL2
    JSRuntime* rt = JS_GetRuntime(ctx);
    if (!handle_class)
        JS_NewClassID(rt, &handle_class);
    JSClassDef definition = { };
    definition.class_name = "WebGLNativeHandle";
    definition.finalizer = finalize;
    if (JS_NewClass(rt, handle_class, &definition) < 0)
        return JS_EXCEPTION;
#endif
    JSValue installer = JS_Eval(ctx, reinterpret_cast<const char*>(pu_webgl_script),
        sizeof(pu_webgl_script) - 1, "polly:webgl2", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(installer))
        return installer;
    JSValue args[] = { JS_NewCFunction(ctx, native, "webgl", 3),
        JS_Eval(ctx, reinterpret_cast<const char*>(pu_webgl_interface),
            sizeof(pu_webgl_interface) - 1, "polly:webgl-interface", JS_EVAL_TYPE_GLOBAL) };
    JSValue result
        = JS_IsException(args[1]) ? JS_EXCEPTION : JS_Call(ctx, installer, JS_UNDEFINED, 2, args);
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
    JS_FreeValue(ctx, installer);
    return result;
}
