#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include "window-previews.h"
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

static char *read_shader(const char *path)
{
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    char *text = calloc(32769, 1);
    if (!text) { fclose(file); return NULL; }
    size_t bytes = fread(text, 1, 32768, file);
    bool valid = bytes > 0 && bytes < 32768 && !ferror(file);
    fclose(file);
    if (!valid) { free(text); return NULL; }
    return text;
}
static GLuint compile(GLenum type, const char *path)
{
    char *text = read_shader(path);
    if (!text) return 0;
    GLuint shader = glCreateShader(type);
    const GLchar *source = text;
    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    free(text);
    GLint valid;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &valid);
    if (!valid) {
        char log[4096];
        glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "Actual effects shader compile failed: %s\n", log);
        glDeleteShader(shader); return 0;
    }
    return shader;
}
static void draw(GLuint program, int width, int height, float radius, float sigma)
{
    const GLfloat projection[] = {2, 0, -1, 0, 2, -1, 0, 0, 1};
    const GLfloat vertices[] = {0, 0, 1, 0, 0, 1, 1, 1};
    glUniformMatrix3fv(glGetUniformLocation(program, "proj"), 1, GL_FALSE, projection);
    glUniform2f(glGetUniformLocation(program, "size"), width, height);
    glUniform1f(glGetUniformLocation(program, "corner_radius"), radius);
    glUniform1f(glGetUniformLocation(program, "shadow"), sigma);
    glUniform4f(glGetUniformLocation(program, "shadow_box"), 17, 17, width - 34, height - 34);
    glUniform4f(glGetUniformLocation(program, "shadow_original_box"), 14, 10, width - 34, height - 34);
    GLint position = glGetAttribLocation(program, "pos");
    glVertexAttribPointer((GLuint)position, 2, GL_FLOAT, GL_FALSE, 0, vertices);
    glEnableVertexAttribArray((GLuint)position);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glDisableVertexAttribArray((GLuint)position);
}
static float distance_to_round(float x, float y, float width, float height, float radius)
{
    float qx = fabsf(x - width / 2) - width / 2 + radius;
    float qy = fabsf(y - height / 2) - height / 2 + radius;
    return hypotf(fmaxf(qx, 0), fmaxf(qy, 0)) + fminf(fmaxf(qx, qy), 0) - radius;
}
static bool pixels(GLuint program, int width)
{
    const int height = 128;
    size_t bytes = (size_t)width * height * 4;
    unsigned char *reference = malloc(bytes), *actual = malloc(bytes);
    GLuint texture, framebuffer;
    bool passed = reference && actual;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
    passed = passed && glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    if (!passed) goto done;
    glViewport(0, 0, width, height);
    glDisable(GL_DITHER);
    glClearColor(0.8f, 0.1f, 0.2f, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_BLEND); glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    glUniform4f(glGetUniformLocation(program, "color"), 0, 0.25f, 0, 0.5f);
    draw(program, width, height, 0, 0);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, reference);
    glBlendFunc(GL_ZERO, GL_SRC_ALPHA);
    glUniform4f(glGetUniformLocation(program, "color"), 1, 1, 1, 1);
    draw(program, width, height, 24, 0);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, actual);
    for (int y = 0; y < height && passed; y++) for (int x = 0; x < width && passed; x++) {
        float distance = distance_to_round(x + 0.5f, y + 0.5f, width, height, 24);
        float coverage = fminf(fmaxf(0.5f - distance, 0), 1);
        size_t offset = ((size_t)y * width + x) * 4;
        for (int channel = 0; channel < 4; channel++)
            if (abs(actual[offset + channel] - (int)roundf(reference[offset + channel] * coverage)) > 2)
                passed = false;
    }
    if (!passed) { fprintf(stderr, "GLES highp one-coverage oracle failed at width %d\n", width); goto done; }
    glDisable(GL_BLEND);
    glUniform4f(glGetUniformLocation(program, "color"), 0, 0, 0, 0.5f);
    draw(program, width, height, 24, 4);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, actual);
    for (int y = 0; y < height && passed; y++) for (int x = 0; x < width && passed; x++) {
        float d = distance_to_round(x + 0.5f - 17, y + 0.5f - 17, width - 34, height - 34, 24);
        float interior = distance_to_round(x + 0.5f - 14, y + 0.5f - 10, width - 34, height - 34, 24);
        float alpha = 0.5f * erfcf(d / (1.41421356237f * 4)) *
            (1 - fminf(fmaxf(0.5f - interior, 0), 1)) * 0.5f;
        size_t offset = ((size_t)y * width + x) * 4;
        if (actual[offset] || actual[offset + 1] || actual[offset + 2] ||
            abs(actual[offset + 3] - (int)roundf(alpha * 255)) > 2) passed = false;
    }
    if (!passed) fprintf(stderr, "GLES external shadow oracle failed at width %d\n", width);
    passed = passed && glGetError() == GL_NO_ERROR;
done:
    glDeleteFramebuffers(1, &framebuffer); glDeleteTextures(1, &texture);
    free(reference); free(actual);
    if (passed) printf("PASS: software GLES actual pinned shaders one-coverage overlap and external shadow width=%d\n", width);
    return passed;
}

static bool cube_pixels(const char *vertex_path, const char *fragment_path)
{
    const int width = 320, height = 180;
    const unsigned char colors[6][4] = {
        {255, 0, 0, 255}, {0, 255, 0, 255}, {0, 0, 255, 255},
        {255, 255, 0, 255}, {0, 255, 255, 255}, {255, 0, 255, 255},
    };
    const unsigned expected_sides[] = {1, 3, 2, 6, 4, 12, 8, 9, 1};
    const GLfloat texture_coordinates[] = {0, 0, 1, 0, 0, 1, 1, 1};
    unsigned char actual[320 * 180 * 4];
    GLuint vertex = compile(GL_VERTEX_SHADER, vertex_path), fragment = compile(GL_FRAGMENT_SHADER, fragment_path);
    GLuint program = glCreateProgram(), textures[7] = {0}, framebuffer = 0, depth_buffer = 0;
    glAttachShader(program, vertex); glAttachShader(program, fragment); glLinkProgram(program);
    GLint linked; glGetProgramiv(program, GL_LINK_STATUS, &linked);
    bool passed = vertex && fragment && linked;
    if (!passed) goto done;
    glGenTextures(7, textures);
    for (unsigned face = 0; face < 7; face++) {
        glBindTexture(GL_TEXTURE_2D, textures[face]);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, face < 6 ? 1 : width, face < 6 ? 1 : height,
            0, GL_RGBA, GL_UNSIGNED_BYTE, face < 6 ? colors[face] : NULL);
    }
    glGenFramebuffers(1, &framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, textures[6], 0);
    glGenRenderbuffers(1, &depth_buffer); glBindRenderbuffer(GL_RENDERBUFFER, depth_buffer);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT16, width, height);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depth_buffer);
    passed = glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
    if (!passed) goto done;
    glViewport(0, 0, width, height); glUseProgram(program);
    glDisable(GL_BLEND); glDisable(GL_CULL_FACE); glDisable(GL_DITHER);
    glEnable(GL_DEPTH_TEST); glDepthFunc(GL_LESS); glDepthMask(GL_TRUE);
    glUniform1i(glGetUniformLocation(program, "tex"), 0);
    glUniform1f(glGetUniformLocation(program, "opacity"), 1);
    glUniform4f(glGetUniformLocation(program, "background"), 0, 0, 0, 1);
    GLint position = glGetAttribLocation(program, "position");
    GLint texture_coordinate = glGetAttribLocation(program, "texcoord");
    glEnableVertexAttribArray((GLuint)position); glEnableVertexAttribArray((GLuint)texture_coordinate);
    glVertexAttribPointer((GLuint)texture_coordinate, 2, GL_FLOAT, GL_FALSE, 0, texture_coordinates);
    for (unsigned step = 0; step < 9 && passed; step++) {
        float vertices[6][16];
        for (unsigned face = 0; face < 6; face++)
            passed = passed && pu_workspace_cube_project_quad(face, (float)step / 2, width, height, vertices[face]);
        for (unsigned reverse = 0; reverse < 2 && passed; reverse++) {
            glClearColor(0, 0, 0, 1); glClearDepthf(1);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            for (unsigned index = 0; index < 6; index++) {
                unsigned face = reverse ? 5 - index : index;
                float positions[16];
                for (unsigned value = 0; value < 16; value++)
                    positions[value] = value % 4 == 1 ? -vertices[face][value] : vertices[face][value];
                glBindTexture(GL_TEXTURE_2D, textures[face]);
                glVertexAttribPointer((GLuint)position, 4, GL_FLOAT, GL_FALSE, 0, positions);
                glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
            }
            glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, actual);
            unsigned visible = 0, samples = 0;
            for (int y = 2; y < height && passed; y += 3) for (int x = 2; x < width && passed; x += 3) {
                float nearest = 2, second = 2;
                unsigned picked = 6;
                for (unsigned face = 0; face < 6; face++) {
                    float depth;
                    if (!pu_window_preview_hit_quad(vertices[face], 1, 1,
                        (x + 0.5) / width, (y + 0.5) / height, &depth)) continue;
                    if (depth < nearest) { second = nearest; nearest = depth; picked = face; }
                    else if (depth < second) second = depth;
                }
                if (picked < 6 && second - nearest < 0.0001f) continue;
                size_t offset = ((size_t)(height - 1 - y) * width + x) * 4;
                for (unsigned channel = 0; channel < 3; channel++) {
                    int expected = picked < 6 ? colors[picked][channel] : 0;
                    if (abs(actual[offset + channel] - expected) > 1) passed = false;
                }
                if (picked < 6) { samples++; if (picked < 4) visible |= 1u << picked; }
            }
            if (samples < 100 || visible != expected_sides[step]) passed = false;
            if (!passed) fprintf(stderr, "Workspace cube GLES depth/pixel oracle failed: turn=%g reverse=%u mask=%u samples=%u\n",
                (double)step / 2, reverse, visible, samples);
        }
    }
    passed = passed && glGetError() == GL_NO_ERROR;
    glDisableVertexAttribArray((GLuint)position); glDisableVertexAttribArray((GLuint)texture_coordinate);
done:
    glDisable(GL_DEPTH_TEST);
    glDeleteRenderbuffers(1, &depth_buffer); glDeleteFramebuffers(1, &framebuffer);
    glDeleteTextures(7, textures); glDeleteProgram(program); glDeleteShader(vertex); glDeleteShader(fragment);
    if (passed) puts("PASS: software GLES pinned projective shaders render all four cube sides and closed caps with order-independent depth/picking");
    return passed;
}

int main(int argc, char **argv)
{
    if (argc != 5) return 2;
    PFNEGLGETPLATFORMDISPLAYEXTPROC platform =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    EGLDisplay display = platform ? platform(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL) : EGL_NO_DISPLAY;
    EGLint major, minor;
    if (display == EGL_NO_DISPLAY || !eglInitialize(display, &major, &minor)) {
        puts("UNQUALIFIED: no existing surfaceless EGL implementation"); return 77;
    }
    EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count;
    EGLint context_options[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLint surface_options[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
    if (!eglBindAPI(EGL_OPENGL_ES_API) || !eglChooseConfig(display, attributes, &config, 1, &count) || count != 1)
        return 77;
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_options);
    EGLSurface surface = eglCreatePbufferSurface(display, config, surface_options);
    if (context == EGL_NO_CONTEXT || surface == EGL_NO_SURFACE || !eglMakeCurrent(display, surface, surface, context))
        return 77;
    GLint range[2], precision, max_size;
    glGetShaderPrecisionFormat(GL_FRAGMENT_SHADER, GL_HIGH_FLOAT, range, &precision);
    printf("Software GLES renderer=%s fragment-highp=%d range=%d,%d\n",
        glGetString(GL_RENDERER), precision, range[0], range[1]);
    if (precision < 23 || range[0] < 16 || range[1] < 16) return 77;
    GLuint vertex = compile(GL_VERTEX_SHADER, argv[1]), fragment = compile(GL_FRAGMENT_SHADER, argv[2]);
    GLuint program = glCreateProgram();
    glAttachShader(program, vertex); glAttachShader(program, fragment); glLinkProgram(program);
    GLint linked; glGetProgramiv(program, GL_LINK_STATUS, &linked);
    bool passed = vertex && fragment && linked;
    glUseProgram(program);
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &max_size);
    for (int width = 2048; width <= 8192 && width <= max_size && passed; width *= 2)
        passed = pixels(program, width);
    if (max_size < 4096) passed = false;
    if (passed) passed = cube_pixels(argv[3], argv[4]);
    glDeleteProgram(program); glDeleteShader(vertex); glDeleteShader(fragment);
    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(display, surface); eglDestroyContext(display, context); eglTerminate(display);
    return passed ? 0 : 1;
}
