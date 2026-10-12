#include "host/win32/composition.h"
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>
#include <dcomp.h>
#include <wrl/client.h>
#include <cstdio>
#include <new>

using Microsoft::WRL::ComPtr;

struct PuWinComposition {
    ComPtr<ID3D11Device> gpu;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDCompositionDevice> device;
    ComPtr<IDCompositionTarget> target;
    ComPtr<IDCompositionVisual> visual;
    ComPtr<IDCompositionSurface> surface;
    int width = 0, height = 0;
};

static bool checked(HRESULT result, const char *operation)
{
    if (SUCCEEDED(result)) return true;
    std::fprintf(stderr, "[host] DirectComposition %s failed: 0x%08lx\n",
        operation, static_cast<unsigned long>(result));
    return false;
}

static bool initialize_device(PuWinComposition *c)
{
    BOOL enabled = FALSE;
    if (!checked(DwmIsCompositionEnabled(&enabled), "availability")) return false;
    if (!enabled) {
        std::fprintf(stderr, "[host] Per-pixel transparency requires desktop composition\n");
        return false;
    }
    const D3D_FEATURE_LEVEL level = D3D_FEATURE_LEVEL_11_0;
    /* Raster rendering stays explicit: WARP uploads Skia pixels, not ANGLE or a
     * claimed hardware-GPU rendering backend. Each HWND owns its device lifetime. */
    if (!checked(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_SINGLETHREADED,
        &level, 1, D3D11_SDK_VERSION, &c->gpu, nullptr, &c->context), "WARP device")) return false;
    ComPtr<IDXGIDevice> dxgi;
    return checked(c->gpu.As(&dxgi), "DXGI device") &&
        checked(DCompositionCreateDevice(dxgi.Get(), IID_PPV_ARGS(&c->device)), "device");
}

extern "C" int pu_win_composition_supported(void)
{
    PuWinComposition probe;
    return initialize_device(&probe) ? 1 : 0;
}

extern "C" PuWinComposition *pu_win_composition_create(void *native)
{
    HWND hwnd = static_cast<HWND>(native);
    DWORD pid = 0;
    if (!hwnd || GetWindowThreadProcessId(hwnd, &pid) != GetCurrentThreadId() || pid != GetCurrentProcessId()) {
        std::fprintf(stderr, "[host] Composition requires a live HWND on this process's UI thread\n");
        return nullptr;
    }
    auto *c = new (std::nothrow) PuWinComposition;
    if (!c) { std::fprintf(stderr, "[host] Cannot allocate composition state\n"); return nullptr; }
    if (!initialize_device(c) ||
        !checked(c->device->CreateTargetForHwnd(hwnd, TRUE, &c->target), "HWND target") ||
        !checked(c->device->CreateVisual(&c->visual), "visual") ||
        !checked(c->target->SetRoot(c->visual.Get()), "root") ||
        !checked(c->device->Commit(), "initial commit")) {
        pu_win_composition_destroy(c);
        return nullptr;
    }
    return c;
}

extern "C" int pu_win_composition_present(PuWinComposition *c, const void *pixels,
    int width, int height, int stride)
{
    if (!c || !pixels || width < 1 || height < 1 ||
        width > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION || height > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION ||
        stride < width * 4) {
        std::fprintf(stderr, "[host] Invalid premultiplied composition frame\n");
        return 0;
    }
    if (!checked(c->gpu->GetDeviceRemovedReason(), "device status")) return 0;
    ComPtr<IDCompositionSurface> next = c->surface;
    bool resized = width != c->width || height != c->height;
    if (resized) {
        next.Reset();
        if (!checked(c->device->CreateSurface(static_cast<UINT>(width), static_cast<UINT>(height),
            DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_ALPHA_MODE_PREMULTIPLIED, &next), "resize surface")) return 0;
    }
    RECT rect = { 0, 0, width, height };
    POINT offset;
    ComPtr<IDXGISurface> drawing;
    if (!checked(next->BeginDraw(&rect, IID_PPV_ARGS(&drawing), &offset), "begin frame")) return 0;
    ComPtr<ID3D11Texture2D> texture;
    if (!checked(drawing.As(&texture), "frame texture")) {
        checked(next->EndDraw(), "cancel frame");
        return 0;
    }
    D3D11_TEXTURE2D_DESC bounds;
    texture->GetDesc(&bounds);
    if (offset.x < 0 || offset.y < 0 || static_cast<unsigned long long>(offset.x) + width > bounds.Width ||
        static_cast<unsigned long long>(offset.y) + height > bounds.Height || bounds.SampleDesc.Count != 1) {
        std::fprintf(stderr, "[host] Invalid composition update rectangle\n");
        checked(next->EndDraw(), "cancel frame");
        return 0;
    }
    D3D11_BOX box = { static_cast<UINT>(offset.x), static_cast<UINT>(offset.y), 0,
        static_cast<UINT>(offset.x + width), static_cast<UINT>(offset.y + height), 1 };
    c->context->UpdateSubresource(texture.Get(), 0, &box, pixels, static_cast<UINT>(stride), 0);
    c->context->Flush();
    bool ended = checked(next->EndDraw(), "end frame");
    if (!ended || !checked(c->gpu->GetDeviceRemovedReason(), "upload status")) return 0;
    if (resized && !checked(c->visual->SetContent(next.Get()), "resize content")) return 0;
    if (!checked(c->device->Commit(), "frame commit")) return 0;
    c->surface = next;
    c->width = width; c->height = height;
    return 1;
}

extern "C" void pu_win_composition_destroy(PuWinComposition *c)
{
    if (!c) return;
    if (c->target && c->device) {
        if (checked(c->target->SetRoot(nullptr), "retire root"))
            checked(c->device->Commit(), "retire commit");
    }
    if (c->context) { c->context->ClearState(); c->context->Flush(); }
    delete c;
}
