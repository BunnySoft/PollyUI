#include "render/canvas_c.h"
#include <cstdio>
#include <cstring>

struct Source {
    PuCanvas* canvas = nullptr;
    int width = 0, height = 0, released = 0, reads = 0, presents = 0;
    bool fail_resize = false, destroy_on_read = false, reenter = false;
    bool reentrant_accepted = false;
    bool other_release_reentry_accepted=false;
    int revision_action=0;
    Source *replacement=nullptr;
    bool destroy_on_release=false;
    uint64_t revision = 1;
};
static int resize(void* userdata, int width, int height)
{
    auto source = static_cast<Source*>(userdata);
    if (source->fail_resize)
        return 0;
    source->width = width;
    source->height = height;
    ++source->revision;
    return 1;
}
static int read(void* userdata, uint8_t* bytes, size_t size)
{
    auto source = static_cast<Source*>(userdata);
    ++source->reads;
    if (source->destroy_on_read)
        pu_canvas_destroy(source->canvas);
    if (size != (size_t)source->width * source->height * 4)
        return 0;
    for (size_t i = 0; i < size; i += 4) {
        bytes[i] = 255;
        bytes[i + 1] = 0;
        bytes[i + 2] = 0;
        bytes[i + 3] = 255;
    }
    return 1;
}
static void present(void *userdata);
static void release(void *userdata);
static uint64_t revision(void* userdata)
{
    auto source=static_cast<Source*>(userdata);
    if(source->revision_action==1)source->reentrant_accepted=pu_canvas_set_gpu_source(source->canvas,nullptr,nullptr)!=0;
    if(source->revision_action==2) {
        PuCanvasGpuSourceOps ops={resize,read,revision,present,release,nullptr};
        source->reentrant_accepted=pu_canvas_set_gpu_source(source->canvas,&ops,source->replacement)!=0;
    }
    if(source->revision_action==3)pu_canvas_destroy(source->canvas);
    return source->revision;
}
static void present(void* userdata) { ++static_cast<Source*>(userdata)->presents; }
static void release(void* userdata)
{
    auto source = static_cast<Source*>(userdata);
    ++source->released;
    if(source->destroy_on_release)pu_canvas_destroy(source->canvas);
    if (source->reenter) {
        source->reentrant_accepted
            = pu_canvas_set_gpu_source(source->canvas, nullptr, nullptr) != 0;
        uint8_t pixel[4];
        auto snapshot=pu_canvas_snapshot(source->canvas);
        source->other_release_reentry_accepted=pu_canvas_read(source->canvas,0,0,1,1,pixel)!=0||
            pu_canvas_resize(source->canvas,1,1)!=0||snapshot!=nullptr;
        pu_canvas_resource_destroy(snapshot);
    }
}
static int failures;
static void check(bool ok, const char* message)
{
    if (!ok) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}
int main()
{
    size_t baseline = pu_canvas_live_backings();
    PuCanvasGpuSourceOps ops = { resize, read, revision, present, release, nullptr };
    PuCanvas* canvas = pu_canvas_create(4, 4);
    Source first;
    first.canvas = canvas;
    check(pu_canvas_set_gpu_source(canvas, &ops, &first), "owned independent source attaches");
    std::memset(&ops, 0, sizeof(ops));
    uint8_t pixel[4];
    check(pu_canvas_read(canvas, 0, 0, 1, 1, pixel) && pixel[0] == 255 && pixel[3] == 255,
        "copied ops and exact RGBA read");
    int reads = first.reads;
    check(pu_canvas_read(canvas, 0, 0, 1, 1, pixel) && first.reads == reads,
        "retained completed revision avoids fake/new read");
    first.fail_resize = true;
    check(!pu_canvas_resize(canvas, 8, 8) && pu_canvas_width(canvas) == 4 && first.width == 4,
        "source/raster/dimensions resize transaction");
    Source rejected;
    rejected.canvas = canvas;
    rejected.fail_resize = true;
    PuCanvasGpuSourceOps valid = { resize, read, revision, present, release, nullptr };
    check(!pu_canvas_set_gpu_source(canvas, &valid, &rejected) && rejected.released == 0
            && first.released == 0,
        "failed attach retains caller ownership and previous source");
    first.fail_resize = false;
    check(pu_canvas_resize(canvas, 8, 8) && first.width == 8, "successful resize commits");
    first.reenter = true;
    check(pu_canvas_set_gpu_source(canvas, nullptr, nullptr) && first.released == 1
            && !first.reentrant_accepted&&!first.other_release_reentry_accepted,
        "per-source single release and reentrant detach safety");
    pu_canvas_destroy(canvas);
    PuCanvas* closing = pu_canvas_create(2, 2);
    Source close;
    close.canvas = closing;
    close.destroy_on_read = true;
    close.reenter=true;
    check(pu_canvas_set_gpu_source(closing, &valid, &close), "closing source attaches");
    check(!pu_canvas_read(closing, 0, 0, 1, 1, pixel) && close.released == 1&&!close.reentrant_accepted&&
        !close.other_release_reentry_accepted,
        "read/close callback keeps canvas alive and releases once");
    check(pu_canvas_live_backings() == baseline, "no backing leak after reentrant close");
    for(int action=1;action<=3;++action) {
        PuCanvas *target=pu_canvas_create(2,2);Source source;source.canvas=target;
        Source replacement;replacement.canvas=target;source.replacement=&replacement;
        check(pu_canvas_set_gpu_source(target,&valid,&source),"revision source attaches");
        source.revision_action=action;
        int result=pu_canvas_read(target,0,0,1,1,pixel);
        if(action==3)check(!result&&source.released==1&&source.reads==0,"revision/destroy stops before read and releases once");
        else {
            check(result&&!source.reentrant_accepted&&replacement.released==0,"revision/detach or replace rejects and retains caller ownership");
            pu_canvas_destroy(target);check(source.released==1,"revision source single release");
        }
        PuCanvas *replacing=pu_canvas_create(2,2);Source previous;previous.canvas=replacing;
        previous.destroy_on_release=true;previous.reenter=true;
        Source caller;caller.canvas=replacing;
        check(pu_canvas_set_gpu_source(replacing,&valid,&previous),"release-close source attaches");
        check(!pu_canvas_set_gpu_source(replacing,&valid,&caller)&&previous.released==1&&caller.released==0&&
            !previous.reentrant_accepted&&!previous.other_release_reentry_accepted,
            "release/close during replacement leaves caller ownership and does not resurrect destructor");
        check(pu_canvas_live_backings()==baseline,"no backing leak or double release after source callback lifecycle");
    }
    if (!failures)
        std::puts("PASS: canvas source ownership, copied ops, transaction, retained revision and "
                  "reentrant close");
    return failures ? 1 : 0;
}
