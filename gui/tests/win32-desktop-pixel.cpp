#include "win32-desktop-pixel.h"
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstdio>
#include <new>
using Microsoft::WRL::ComPtr;
static bool permission_denied;
struct PuTestDesktopCapture {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIOutputDuplication> duplication;
    ComPtr<ID3D11Texture2D> frame, pixel;
    DXGI_OUTPUT_DESC output = {};
    bool acquired = false;
    unsigned pixels_read = 0;
};
static bool check(HRESULT hr, const char *operation, bool capture_permission = false)
{
    if (SUCCEEDED(hr)) return true;
    if (capture_permission && hr == E_ACCESSDENIED) permission_denied = true;
    std::fprintf(stderr, "FAIL desktop duplication %s: %08lx\n", operation, static_cast<unsigned long>(hr));
    return false;
}
extern "C" PuTestDesktopCapture *pu_test_desktop_capture_create(HWND fixture)
{
    auto *c = new (std::nothrow) PuTestDesktopCapture;
    permission_denied = false;
    if (!c) return nullptr;
    ComPtr<IDXGIFactory1> factory;
    if (!check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "factory")) { delete c; return nullptr; }
    HMONITOR monitor = MonitorFromWindow(fixture, MONITOR_DEFAULTTONEAREST);
    bool found = false;
    for (UINT i = 0; !found; i++) {
        ComPtr<IDXGIAdapter1> adapter;
        HRESULT hr = factory->EnumAdapters1(i, &adapter);
        if (hr == DXGI_ERROR_NOT_FOUND) break;
        if (!check(hr, "adapter")) break;
        for (UINT j = 0; !found; j++) {
            ComPtr<IDXGIOutput> output;
            hr = adapter->EnumOutputs(j, &output);
            if (hr == DXGI_ERROR_NOT_FOUND) break;
            if (!check(hr, "output") || !check(output->GetDesc(&c->output), "output geometry")) break;
            if (c->output.Monitor != monitor) continue;
            if (c->output.Rotation != DXGI_MODE_ROTATION_IDENTITY &&
                c->output.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
                std::fprintf(stderr, "FAIL fixture capture requires an unrotated output\n");
                break;
            }
            ComPtr<IDXGIOutput1> output1;
            found = check(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_SINGLETHREADED,
                nullptr, 0, D3D11_SDK_VERSION, &c->device, nullptr, &c->context), "capture device") &&
                check(output.As(&output1), "capture output") &&
                check(output1->DuplicateOutput(c->device.Get(), &c->duplication), "duplicate output", true);
            break;
        }
    }
    if (!found) { std::fprintf(stderr, "FAIL no desktop capture for fixture monitor\n"); delete c; return nullptr; }
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = desc.Height = desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    if (!check(c->device->CreateTexture2D(&desc, nullptr, &c->pixel), "one-pixel staging")) {
        delete c; return nullptr;
    }
    std::printf("NATIVE: desktop duplication output=%ls bounds=%ld,%ld,%ld,%ld CPU-crop=1x1\n",
        c->output.DeviceName, c->output.DesktopCoordinates.left, c->output.DesktopCoordinates.top,
        c->output.DesktopCoordinates.right, c->output.DesktopCoordinates.bottom);
    return c;
}
extern "C" int pu_test_desktop_capture_refresh(PuTestDesktopCapture *c, long long present_after)
{
    if (!c) return 0;
    if (c->acquired) {
        c->frame.Reset();
        if (!check(c->duplication->ReleaseFrame(), "release previous frame")) return 0;
        c->acquired = false;
    }
    DXGI_OUTDUPL_FRAME_INFO info = {};
    ComPtr<IDXGIResource> resource;
    HRESULT acquired = c->duplication->AcquireNextFrame(0, &info, &resource);
    if (acquired == DXGI_ERROR_WAIT_TIMEOUT) return 2;
    if (!check(acquired, "acquire composed frame", true)) return 0;
    c->acquired = true;
    if (!pu_test_desktop_frame_fresh(info.LastPresentTime.QuadPart, info.AccumulatedFrames, present_after)) {
        std::printf("CAPTURE: pending desktop image present-qpc=%lld fence=%lld "
            "mouse-qpc=%lld accumulated=%u (not sampled)\n", info.LastPresentTime.QuadPart,
            present_after, info.LastMouseUpdateTime.QuadPart, info.AccumulatedFrames);
        return 2;
    }
    if (!check(resource.As(&c->frame), "composed texture")) return 0;
    D3D11_TEXTURE2D_DESC desc;
    c->frame->GetDesc(&desc);
    LARGE_INTEGER now, frequency;
    QueryPerformanceCounter(&now); QueryPerformanceFrequency(&frequency);
    std::printf("CAPTURE: present-qpc=%lld fence=%lld mouse-qpc=%lld now-qpc=%lld frequency=%lld "
        "accumulated=%u protected=%d coalesced=%d texture=%ux%u format=%u mips=%u array=%u "
        "samples=%u/%u usage=%u bind=%u cpu=%u misc=%u\n",
        info.LastPresentTime.QuadPart, present_after, info.LastMouseUpdateTime.QuadPart,
        now.QuadPart, frequency.QuadPart,
        info.AccumulatedFrames, info.ProtectedContentMaskedOut, info.RectsCoalesced,
        desc.Width, desc.Height, static_cast<unsigned>(desc.Format), desc.MipLevels, desc.ArraySize,
        desc.SampleDesc.Count, desc.SampleDesc.Quality, static_cast<unsigned>(desc.Usage),
        desc.BindFlags, desc.CPUAccessFlags, desc.MiscFlags);
    if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.SampleDesc.Count != 1 ||
        desc.SampleDesc.Quality != 0 || !desc.MipLevels || !desc.ArraySize) {
        std::fprintf(stderr, "FAIL unexpected desktop texture format or subresource layout\n");
        return 0;
    }
    return check(c->device->GetDeviceRemovedReason(), "capture device status") ? 1 : 0;
}
extern "C" int pu_test_desktop_pixel(PuTestDesktopCapture *c, int x, int y, COLORREF *color)
{
    if (!c || !c->acquired || !c->frame || !color) return 0;
    x -= c->output.DesktopCoordinates.left; y -= c->output.DesktopCoordinates.top;
    D3D11_TEXTURE2D_DESC desc;
    c->frame->GetDesc(&desc);
    if (x < 0 || y < 0 || static_cast<UINT>(x) >= desc.Width || static_cast<UINT>(y) >= desc.Height) return 0;
    D3D11_BOX box = { static_cast<UINT>(x), static_cast<UINT>(y), 0,
        static_cast<UINT>(x + 1), static_cast<UINT>(y + 1), 1 };
    c->context->CopySubresourceRegion(c->pixel.Get(), 0, 0, 0, 0, c->frame.Get(), 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped;
    if (!check(c->context->Map(c->pixel.Get(), 0, D3D11_MAP_READ, 0, &mapped), "read fixture pixel")) return 0;
    if (!mapped.pData || mapped.RowPitch < 4) {
        std::fprintf(stderr, "FAIL invalid one-pixel mapped data layout\n");
        c->context->Unmap(c->pixel.Get(), 0);
        return 0;
    }
    const auto *bgra = static_cast<const unsigned char *>(mapped.pData);
    if (c->pixels_read++ < 8)
        std::printf("CAPTURE: crop=%d,%d 1x1 mapped-pitch=%u BGRA=%02x,%02x,%02x,%02x\n",
            x, y, mapped.RowPitch, bgra[0], bgra[1], bgra[2], bgra[3]);
    *color = RGB(bgra[2], bgra[1], bgra[0]);
    c->context->Unmap(c->pixel.Get(), 0);
    return check(c->device->GetDeviceRemovedReason(), "capture copy status") ? 1 : 0;
}
extern "C" void pu_test_desktop_capture_destroy(PuTestDesktopCapture *c)
{
    if (!c) return;
    if (c->acquired) check(c->duplication->ReleaseFrame(), "retire captured frame");
    delete c;
}
extern "C" int pu_test_desktop_capture_denied(void)
{ return permission_denied ? 1 : 0; }
