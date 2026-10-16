#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
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
int main(int argc, char **argv)
{
    if (argc != 3) return 2;
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
    glDeleteProgram(program); glDeleteShader(vertex); glDeleteShader(fragment);
    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroySurface(display, surface); eglDestroyContext(display, context); eglTerminate(display);
    return passed ? 0 : 1;
}
