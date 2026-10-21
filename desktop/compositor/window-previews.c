#include "window-previews.h"
#include "server.h"
#include "decoration.h"
#include <math.h>
#include <wlr/types/wlr_compositor.h>
#include <wlr/types/wlr_scene.h>
#include <wlr/types/wlr_xdg_shell.h>
#include <wlr/util/log.h>

bool pu_window_preview_project_quad(float ordinal, int width, int height, float vertices[16])
{
    if (!vertices || !isfinite(ordinal) || ordinal < 0 || ordinal > 8 ||
        width < 1 || height < 1 || width > 4096 || height > 768) {
        wlr_log(WLR_ERROR, "Invalid bounded 3D window preview geometry");
        return false;
    }
    const float yaw = -0.42f, pitch = 0.14f;
    const float near = 0.1f, far = 64, focal = 2.144507f;
    const float fit = fminf(1, (float)width / height);
    const float spread = fminf(1.2f, 0.6f * width / height);
    const float corners[4][2] = {{-1, -1}, {1, -1}, {-1, 1}, {1, 1}};
    for (unsigned index = 0; index < 4; index++) {
        float x = corners[index][0] * 1.75f * fit, y = corners[index][1] * 1.09375f * fit;
        float rotated_x = x * cosf(yaw), rotated_z = -x * sinf(yaw);
        float rotated_y = y * cosf(pitch) - rotated_z * sinf(pitch);
        float z = y * sinf(pitch) + rotated_z * cosf(pitch) - 3.4f - ordinal * 0.42f;
        vertices[index * 4] = (rotated_x + (-0.25f + fminf(ordinal, 3) * spread) * fit) * focal * height / width;
        vertices[index * 4 + 1] = (rotated_y + (0.14f - ordinal * 0.32f) * fit) * focal;
        vertices[index * 4 + 2] = (far + near) / (near - far) * z + 2 * far * near / (near - far);
        vertices[index * 4 + 3] = -z;
    }
    return true;
}

bool pu_workspace_cube_project_quad(unsigned face, float quarter_turns,
    int width, int height, float vertices[16])
{
    if (!vertices || face > 5 || !isfinite(quarter_turns) || quarter_turns < -4 || quarter_turns > 4 ||
        width < 1 || height < 1 || width > 32768 || height > 32768) {
        wlr_log(WLR_ERROR, "Invalid bounded workspace cube geometry");
        return false;
    }
    const float pi_half = 1.57079632679f, pitch = -0.20f;
    const float near = 0.05f, far = 32, focal = 2.41421356237f;
    const float aspect = (float)width / height;
    const float half_width = fminf(1, aspect), half_height = half_width / aspect;
    const float horizontal = sqrtf(2) * half_width;
    const float vertical = half_height * cosf(pitch) + horizontal * fabsf(sinf(pitch));
    const float radius = sqrtf(2 * half_width * half_width + half_height * half_height);
    const float distance = radius + 1.15f * focal * fmaxf(vertical, horizontal / aspect);
    const float turns = remainderf(quarter_turns, 4);
    const float angle = ((face < 4 ? (float)face : 0) - turns) * pi_half;
    const float corners[4][2] = {{-1, -1}, {1, -1}, {-1, 1}, {1, 1}};
    for (unsigned index = 0; index < 4; index++) {
        float x = corners[index][0] * half_width;
        float y = face < 4 ? corners[index][1] * half_height : face == 4 ? -half_height : half_height;
        float z = face < 4 ? half_width : corners[index][1] * half_width * (face == 4 ? 1 : -1);
        float rotated_x = x * cosf(angle) + z * sinf(angle);
        float rotated_z = -x * sinf(angle) + z * cosf(angle);
        float rotated_y = y * cosf(pitch) - rotated_z * sinf(pitch);
        float camera_z = y * sinf(pitch) + rotated_z * cosf(pitch) - distance;
        vertices[index * 4] = rotated_x * focal / aspect;
        vertices[index * 4 + 1] = rotated_y * focal;
        vertices[index * 4 + 2] = (far + near) / (near - far) * camera_z +
            2 * far * near / (near - far);
        vertices[index * 4 + 3] = -camera_z;
    }
    return true;
}

bool pu_window_preview_hit_quad(const float vertices[16], int width, int height,
    double x, double y, float *depth)
{
    if (!vertices || !depth || width < 1 || height < 1 || width > 4096 || height > 768 ||
        !isfinite(x) || !isfinite(y)) {
        wlr_log(WLR_ERROR, "Invalid 3D window preview hit-test input");
        return false;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    double points[4][3];
    for (unsigned index = 0; index < 4; index++) {
        double w = vertices[index * 4 + 3];
        if (!isfinite(w) || w < 0.001) {
            wlr_log(WLR_ERROR, "Invalid 3D window preview homogeneous coordinate");
            return false;
        }
        for (unsigned axis = 0; axis < 3; axis++) {
            double value = vertices[index * 4 + axis];
            if (!isfinite(value)) {
                wlr_log(WLR_ERROR, "Invalid 3D window preview vertex");
                return false;
            }
            points[index][axis] = value / w;
        }
    }
    x = 2 * x / width - 1;
    y = 2 * y / height - 1;
    const unsigned triangles[2][3] = {{0, 1, 2}, {2, 1, 3}};
    for (unsigned index = 0; index < 2; index++) {
        const double *a = points[triangles[index][0]], *b = points[triangles[index][1]];
        const double *c = points[triangles[index][2]];
        double divisor = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (fabs(divisor) < 0.0000000001) continue;
        double wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / divisor;
        double wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / divisor;
        double wc = 1 - wa - wb;
        if (wa < -0.000001 || wb < -0.000001 || wc < -0.000001) continue;
        double z = wa * a[2] + wb * b[2] + wc * c[2];
        if (z < -1 || z > 1) continue;
        *depth = (float)z;
        return true;
    }
    return false;
}

static void revision_surface(struct wlr_surface *surface, int x, int y, void *data)
{
    uint64_t *revision = data;
    const uint32_t fields[] = {surface->current.seq, (uint32_t)x, (uint32_t)y,
        (uint32_t)surface->current.width, (uint32_t)surface->current.height};
    for (unsigned index = 0; index < sizeof(fields) / sizeof(fields[0]); index++) {
        *revision ^= fields[index];
        *revision *= UINT64_C(1099511628211);
    }
}

uint64_t pu_window_preview_revision(struct PuDesktopView *view)
{
    uint64_t revision = UINT64_C(14695981039346656037) ^ view->preview_revision ^ view->workspace_window;
    wlr_surface_for_each_surface(view->toplevel->base->surface, revision_surface, &revision);
    return revision;
}

struct wlr_buffer *pu_window_preview_frame(struct PuDesktopView *view,
    struct wlr_scene_output *output, int width, int height)
{
    struct wlr_box box;
    float radius;
    if (!view->mapped || !view->toplevel->base->surface->buffer ||
        !pu_decoration_preview_geometry(view, &box, &radius))
        return NULL;
    return wlr_scene_tree_snapshot(view->effects, output, &box, radius, width, height);
}
