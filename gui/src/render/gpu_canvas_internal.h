#ifndef POLLYUI_GPU_CANVAS_INTERNAL_H
#define POLLYUI_GPU_CANVAS_INTERNAL_H
#include "render/gpu_canvas.h"
#include "render/gpu_device.h"
#ifdef PU_WEBGL2
#include <array>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

enum class PuGlKind {
    Buffer,
    Texture,
    Framebuffer,
    Renderbuffer,
    VertexArray,
    Shader,
    Program,
    Uniform,
    Sampler,
    Query,
    TransformFeedback,
    Sync
};
struct PuGlImage {
    int width = 0, height = 0, depth = 1;
    GLenum internal = 0, format = 0, type = 0;
};
struct PuGlResource {
    PuGlKind kind;
    GLuint name = 0;
    unsigned generation = 0;
    bool deleted = false;
    GLenum target = 0;
    size_t bytes = 0;
    std::vector<uint8_t> data;
    std::string source, validation;
    GLuint program = 0;
    unsigned link_generation = 0;
    int width = 0, height = 0, depth = 1;
    GLenum format = 0;
    bool immutable = false;
    std::unordered_map<uint64_t, size_t> levels;
    std::vector<std::shared_ptr<PuGlResource>> shaders;
    std::unordered_map<GLenum, std::shared_ptr<PuGlResource>> attachments;
    std::unordered_map<GLenum, GLenum> attachment_targets;
    std::unordered_map<GLenum, GLint> attachment_levels;
    std::unordered_map<GLenum, GLint> attachment_layers;
    std::unordered_map<uint64_t, PuGlImage> images;
    GLsync sync = nullptr;
};
struct PuGlAttribute {
    std::shared_ptr<PuGlResource> buffer;
    unsigned size = 4, stride = 0, offset = 0, divisor = 0, component = 4;
    bool packed = false;
    bool enabled = false;
};
struct PuGlVao {
    std::vector<PuGlAttribute> attributes;
    std::shared_ptr<PuGlResource> element;
};
struct PuGlRange {
    std::shared_ptr<PuGlResource> buffer;
    size_t offset = 0, size = 0;
    bool whole = false;
};
struct PuGlFeedback {
    std::unordered_map<unsigned, PuGlRange> bindings;
    size_t vertices = 0;
    bool active = false, paused = false;
    GLenum mode = GL_POINTS;
    std::shared_ptr<PuGlResource> program;
};
struct PuGpuCanvas {
    unsigned refs = 1, generation = 1;
    uint64_t revision = 1;
    uint64_t presented = 0;
    PuGpuDevice device;
    bool lost = true, closed = false;
    bool alpha = true, depth = true, stencil = false, premultiplied = true;
    bool preserve = false;
    GLenum storage_format = GL_RGBA8;
    int width = 0, height = 0;
    GLuint framebuffer = 0, color = 0, depth_stencil = 0;
    GLenum errors[6] = { };
    unsigned error_count = 0;
    bool command_error = false;
    GLint max_attributes = 0, max_texture = 0, max_units = 0;
    std::vector<GLenum> attribute_types;
    size_t allocated = 0;
    std::unordered_map<GLenum, std::shared_ptr<PuGlResource>> buffers;
    std::unordered_map<GLuint, PuGlVao> vaos;
    std::unordered_map<GLuint, unsigned> links;
    GLuint vao = 0, program = 0;
    std::shared_ptr<PuGlResource> current_program;
    unsigned active_texture = 0;
    std::vector<std::unordered_map<GLenum, std::shared_ptr<PuGlResource>>> textures;
    std::shared_ptr<PuGlResource> draw_framebuffer, read_framebuffer, renderbuffer;
    std::vector<std::weak_ptr<PuGlResource>> resources;
    std::unordered_map<unsigned, PuGlRange> uniform_buffers;
    std::unordered_map<GLuint, PuGlFeedback> feedbacks;
    GLuint feedback = 0;
    bool feedback_active = false, feedback_paused = false;
    GLenum feedback_mode = GL_POINTS;
    std::unordered_map<GLenum, std::shared_ptr<PuGlResource>> queries;
};
void pu_gpu_error(PuGpuCanvas* canvas, GLenum error);
void pu_gpu_delete(PuGpuCanvas* canvas, const std::shared_ptr<PuGlResource>& resource);
bool pu_gpu_restore(PuGpuCanvas* canvas);
#endif
#endif
