#include "bridge/webgpu.h"

#ifndef PU_WEBGPU
JSValue pu_webgpu_factory(JSContext*) { return JS_NULL; }
int pu_webgpu_pump(JSContext*) { return 0; }
int pu_webgpu_pending(JSContext*) { return 0; }
void pu_webgpu_shutdown(JSContext*) { }
size_t pu_webgpu_live_resources(void) { return 0; }
size_t pu_webgpu_live_readbacks(void) { return 0; }
#else
#include "webgpu-script.h"
#include "webgpu/dawn_api.h"
extern "C" {
#include "bridge/bridge.h"
#include "bridge/media.h"
}
#include "include/core/SkColorSpace.h"
#include "include/core/SkPixmap.h"
#include "render/canvas_c.h"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <limits>
#include <map>
#include <mutex>
#include <new>
#include <vector>

namespace {
enum class Kind {
    Adapter,
    Device,
    Queue,
    Buffer,
    Texture,
    TextureView,
    Sampler,
    ExternalTexture,
    RenderPipeline,
    RenderPass,
    CanvasContext,
    QuerySet,
    BundleEncoder,
    Bundle,
    Shader,
    ComputePipeline,
    BindGroupLayout,
    PipelineLayout,
    BindGroup,
    Encoder,
    ComputePass,
    CommandBuffer
};
struct State;
struct Object;
struct CanvasSource;
struct CanvasReadback {
    std::shared_ptr<const PuDawnApi> api;
    WGPUBuffer buffer = nullptr;
    WGPUFuture future = { };
    std::atomic<bool> done { false };
    std::atomic<int> status { 0 };
    ~CanvasReadback()
    {
        if (buffer) {
            api->BufferDestroy(buffer);
            api->BufferRelease(buffer);
        }
    }
};
struct Event {
    bool lost;
    int type;
    std::string message;
};
struct CompilationMessage {
    std::string message;
    WGPUCompilationMessageType type;
    uint64_t line, column, offset, length;
};
struct Device {
    std::mutex mutex;
    std::vector<Event> events;
    Object* object = nullptr; // Used only by the UI thread, never a Dawn callback.
    WGPUDevice native = nullptr;
    bool destroyed = false;
    bool callback_oom = false;
};
enum class JobKind {
    Adapter,
    Device,
    Map,
    Submitted,
    Scope,
    Compilation,
    ComputePipeline,
    RenderPipeline
};
struct Job {
    JobKind kind;
    JSRuntime* runtime = nullptr;
    std::shared_ptr<const PuDawnApi> api;
    std::mutex mutex;
    bool done = false;
    int status = 0, error_type = 0;
    void* native = nullptr;
    std::string message;
    JSValue resolve = JS_UNDEFINED, reject = JS_UNDEFINED, owner = JS_UNDEFINED;
    std::shared_ptr<Device> device;
    std::vector<CompilationMessage> compilation;
    bool callback_oom = false;
    bool require_software = false;
    uint64_t map_offset = 0, map_size = 0;
    bool writable = false;
    ~Job()
    {
        if (native && api) {
            if (kind == JobKind::Adapter)
                api->AdapterRelease(static_cast<WGPUAdapter>(native));
            if (kind == JobKind::Device)
                api->DeviceRelease(static_cast<WGPUDevice>(native));
            if (kind == JobKind::ComputePipeline)
                api->ComputePipelineRelease(static_cast<WGPUComputePipeline>(native));
            if (kind == JobKind::RenderPipeline)
                api->RenderPipelineRelease(static_cast<WGPURenderPipeline>(native));
        }
        if (runtime) {
            JS_FreeValueRT(runtime, resolve);
            JS_FreeValueRT(runtime, reject);
            JS_FreeValueRT(runtime, owner);
        }
    }
};
struct State {
    JSContext* context = nullptr;
    JSRuntime* runtime = nullptr;
    std::shared_ptr<const PuDawnApi> api;
    WGPUInstance instance = nullptr;
    bool closed = false;
    JSValue data_view_getters[3] = { JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    std::vector<std::unique_ptr<Job>> jobs;
    std::vector<std::shared_ptr<Device>> devices;
    std::vector<Object*> objects;
    std::vector<std::weak_ptr<CanvasSource>> canvas_sources;
    std::vector<std::unique_ptr<CanvasReadback>> canvas_readbacks;
    std::vector<std::unique_ptr<Job>> mutation_checks;
    ~State()
    {
        if (runtime)
            for (JSValue getter : data_view_getters)
                JS_FreeValueRT(runtime, getter);
        if (instance)
            api->InstanceRelease(instance);
    }
};
struct Mapped {
    uint64_t offset, size;
    JSValue buffer;
};
struct CanvasWrite {
    std::weak_ptr<CanvasSource> source;
    uint64_t generation;
};
struct Object {
    Kind kind;
    void* native;
    std::shared_ptr<State> state;
    std::shared_ptr<Device> device;
    JSValue owner = JS_UNDEFINED;
    JSValue lost_resolve = JS_UNDEFINED, lost_promise = JS_UNDEFINED;
    JSValue error_handler = JS_UNDEFINED;
    JSValue dependency = JS_UNDEFINED;
    std::vector<Mapped> mapped;
    std::weak_ptr<CanvasSource> canvas_target;
    uint64_t canvas_generation=0;
    std::vector<CanvasWrite> canvas_writes;
    bool has_canvas_mutation=false;
    bool finished = false, submitted = false, destroyed = false;
    uint64_t map_offset = 0, map_size = 0;
    bool writable = false;
    bool transient_attachment=false, transient_emulated=false;
    WGPUTextureUsage public_texture_usage=0;
    WGPUTextureFormat texture_format=WGPUTextureFormat_Undefined;
    WGPUTextureAspect texture_aspect=WGPUTextureAspect_All;
};
static void canvas_context_release(Object* object);
static void record_canvas_write(Object *encoder,Object *texture);
static void publish_canvas_write(Object *texture);
static void publish_canvas_commands(Object *command);
static JSClassID object_class;
static size_t live_resources;
static std::map<JSContext*, std::shared_ptr<State>> states;
static std::string text(WGPUStringView value)
{
    return value.data ? std::string(value.data,
                            value.length == WGPU_STRLEN ? std::strlen(value.data) : value.length)
                      : "";
}
static WGPUStringView view(const std::string& value) { return { value.data(), value.size() }; }
static void release(Object* object)
{
    if (!object->native)
        return;
    const auto& api = *object->state->api;
#define RELEASE(kind, type)                                                                        \
    case Kind::kind:                                                                               \
        api.type##Release(static_cast<WGPU##type>(object->native));                                \
        break
    switch (object->kind) {
        RELEASE(Adapter, Adapter);
        RELEASE(Queue, Queue);
        RELEASE(Buffer, Buffer);
        RELEASE(Texture, Texture);
        RELEASE(TextureView, TextureView);
        RELEASE(Sampler, Sampler);
        RELEASE(ExternalTexture, ExternalTexture);
        RELEASE(QuerySet, QuerySet);
        RELEASE(BundleEncoder, RenderBundleEncoder);
        RELEASE(Bundle, RenderBundle);
        RELEASE(RenderPipeline, RenderPipeline);
        RELEASE(RenderPass, RenderPassEncoder);
    case Kind::CanvasContext:
        canvas_context_release(object);
        break;
        RELEASE(Shader, ShaderModule);
        RELEASE(ComputePipeline, ComputePipeline);
        RELEASE(BindGroupLayout, BindGroupLayout);
        RELEASE(PipelineLayout, PipelineLayout);
        RELEASE(BindGroup, BindGroup);
        RELEASE(Encoder, CommandEncoder);
        RELEASE(ComputePass, ComputePassEncoder);
        RELEASE(CommandBuffer, CommandBuffer);
    case Kind::Device:
        if (!object->device->destroyed) {
            object->device->destroyed = true;
            api.DeviceDestroy(static_cast<WGPUDevice>(object->native));
        }
        object->device->object = nullptr;
        object->device->native = nullptr;
        api.DeviceRelease(static_cast<WGPUDevice>(object->native));
        break;
    }
#undef RELEASE
    object->native = nullptr;
}
static void mark(JSRuntime* runtime, JSValueConst value, JS_MarkFunc* function)
{
    auto object = static_cast<Object*>(JS_GetOpaque(value, object_class));
    if (!object)
        return;
    JS_MarkValue(runtime, object->owner, function);
    JS_MarkValue(runtime, object->lost_resolve, function);
    JS_MarkValue(runtime, object->lost_promise, function);
    JS_MarkValue(runtime, object->error_handler, function);
    JS_MarkValue(runtime, object->dependency, function);
    for (auto& range : object->mapped)
        JS_MarkValue(runtime, range.buffer, function);
}
static void finalizer(JSRuntime* runtime, JSValueConst value)
{
    auto object = static_cast<Object*>(JS_GetOpaque(value, object_class));
    if (!object)
        return;
    // Detach JS-owned mapped ranges before releasing their GPU resource.
    for (auto& range : object->mapped) {
        JS_DetachArrayBuffer(object->state->context, range.buffer);
        JS_FreeValueRT(runtime, range.buffer);
    }
    JS_FreeValueRT(runtime, object->owner);
    JS_FreeValueRT(runtime, object->lost_resolve);
    JS_FreeValueRT(runtime, object->lost_promise);
    JS_FreeValueRT(runtime, object->error_handler);
    JS_FreeValueRT(runtime, object->dependency);
    release(object);
    auto& objects = object->state->objects;
    objects.erase(std::remove(objects.begin(), objects.end(), object), objects.end());
    delete object;
    --live_resources;
}
static Object* get(
    JSContext* context, JSValueConst value, Kind kind, const std::shared_ptr<Device>& device = { })
{
    auto object = static_cast<Object*>(JS_GetOpaque2(context, value, object_class));
    if (!object)
        return nullptr;
    (void)device;
    if (object->kind != kind || object->state->closed) {
        JS_ThrowTypeError(context, "Wrong WebGPU resource brand or closed GUI runtime");
        return nullptr;
    }
    return object;
}
static JSValue object_value(const std::shared_ptr<State>& state, Kind kind, void* native,
    JSValueConst owner, const std::shared_ptr<Device>& device = { })
{
    if (!native)
        return JS_ThrowInternalError(state->context, "Native WebGPU allocation failed");
    Object guarded;
    guarded.kind = kind;
    guarded.native = native;
    guarded.state = state;
    guarded.device = device;
    struct Cleanup {
        Object& object;
        ~Cleanup() { release(&object); }
    } cleanup { guarded };
    state->objects.reserve(state->objects.size() + 1);
    auto object = std::make_unique<Object>();
    object->kind = kind;
    object->native = native;
    object->state = state;
    object->device = device;
    object->owner = JS_DupValue(state->context, owner);
    JSValue value = JS_NewObjectClass(state->context, object_class);
    if (JS_IsException(value)) {
        JS_FreeValue(state->context, object->owner);
        return value;
    }
    if (kind == Kind::Device) {
        JSValue functions[2] = { JS_UNDEFINED, JS_UNDEFINED };
        object->lost_promise = JS_NewPromiseCapability(state->context, functions);
        if (JS_IsException(object->lost_promise)) {
            JS_FreeValue(state->context, object->owner);
            JS_FreeValue(state->context, value);
            return JS_EXCEPTION;
        }
        object->lost_resolve = functions[0];
        JS_FreeValue(state->context, functions[1]);
        device->object = object.get();
    }
    state->objects.push_back(object.get());
    JS_SetOpaque(value, object.release());
    guarded.native = nullptr;
    ++live_resources;
    return value;
}
static void complete(Job* job, int status, void* native, WGPUStringView message)
{
    std::lock_guard<std::mutex> lock(job->mutex);
    job->status = status;
    job->native = native;
    try {
        job->message = text(message);
    } catch (const std::bad_alloc&) {
        job->callback_oom = true;
    }
    job->done = true;
}
static void adapter_callback(WGPURequestAdapterStatus status, WGPUAdapter adapter,
    WGPUStringView message, void* userdata, void*)
{
    complete(static_cast<Job*>(userdata), status, adapter, message);
}
static void device_callback(WGPURequestDeviceStatus status, WGPUDevice device,
    WGPUStringView message, void* userdata, void*)
{
    complete(static_cast<Job*>(userdata), status, device, message);
}
static void map_callback(WGPUMapAsyncStatus status, WGPUStringView message, void* userdata, void*)
{
    complete(static_cast<Job*>(userdata), status, nullptr, message);
}
static void compute_pipeline_callback(WGPUCreatePipelineAsyncStatus status,
    WGPUComputePipeline pipeline, WGPUStringView message, void* userdata, void*)
{
    complete(static_cast<Job*>(userdata), status, pipeline, message);
}
static void render_pipeline_callback(WGPUCreatePipelineAsyncStatus status,
    WGPURenderPipeline pipeline, WGPUStringView message, void* userdata, void*)
{
    complete(static_cast<Job*>(userdata), status, pipeline, message);
}
static void compilation_callback(
    WGPUCompilationInfoRequestStatus status, WGPUCompilationInfo const* info, void* userdata, void*)
{
    auto job = static_cast<Job*>(userdata);
    std::lock_guard<std::mutex> lock(job->mutex);
    job->status = status;
    try {
        if (info)
            for (size_t i = 0; i < info->messageCount; ++i) {
                const auto& message = info->messages[i];
                CompilationMessage copied = { text(message.message), message.type, message.lineNum,
                    message.linePos, message.offset, message.length };
                for (const WGPUChainedStruct* chain = message.nextInChain; chain;
                    chain = chain->next) {
                    if (chain->sType == WGPUSType_DawnCompilationMessageUtf16) {
                        auto utf16
                            = reinterpret_cast<const WGPUDawnCompilationMessageUtf16*>(chain);
                        copied.column = utf16->linePos;
                        copied.offset = utf16->offset;
                        copied.length = utf16->length;
                    }
                }
                job->compilation.push_back(std::move(copied));
            }
    } catch (const std::bad_alloc&) {
        job->callback_oom = true;
    }
    job->done = true;
}
static void submitted_callback(
    WGPUQueueWorkDoneStatus status, WGPUStringView message, void* userdata, void*)
{
    complete(static_cast<Job*>(userdata), status, nullptr, message);
}
static void scope_callback(WGPUPopErrorScopeStatus status, WGPUErrorType type,
    WGPUStringView message, void* userdata, void*)
{
    auto job = static_cast<Job*>(userdata);
    std::lock_guard<std::mutex> lock(job->mutex);
    job->status = status;
    job->error_type = type;
    try {
        job->message = text(message);
    } catch (const std::bad_alloc&) {
        job->callback_oom = true;
    }
    job->done = true;
}
template<typename F>
static bool checked_mutation(Object *object,F operation)
{
    auto state=object->state;
    const auto &api=*state->api;
    auto device=object->device->native;
    auto record=std::make_unique<Job>();
    record->kind=JobKind::Scope;record->api=state->api;
    state->mutation_checks.reserve(state->mutation_checks.size()+1);
    Job *check=record.get();
    state->mutation_checks.push_back(std::move(record));
    api.DevicePushErrorScope(device,WGPUErrorFilter_Validation);
    operation();
    WGPUPopErrorScopeCallbackInfo callback=WGPU_POP_ERROR_SCOPE_CALLBACK_INFO_INIT;
    callback.mode=WGPUCallbackMode_WaitAnyOnly;callback.callback=scope_callback;callback.userdata1=check;
    WGPUFuture future=api.DevicePopErrorScope(device,callback);
    WGPUFutureWaitInfo wait=WGPU_FUTURE_WAIT_INFO_INIT;wait.future=future;
    auto result=api.InstanceWaitAny(state->instance,1,&wait,UINT64_C(10000000000));
    if(result!=WGPUWaitStatus_Success||!check->done||check->status!=WGPUPopErrorScopeStatus_Success) {
        JS_ThrowInternalError(state->context,"Native canvas mutation validation did not complete");
        return false;
    }
    bool valid=check->error_type==WGPUErrorType_NoError;
    if(!valid)api.DeviceInjectError(device,static_cast<WGPUErrorType>(check->error_type),view(check->message));
    state->mutation_checks.erase(std::remove_if(state->mutation_checks.begin(),state->mutation_checks.end(),
        [check](const auto &record){return record.get()==check;}),state->mutation_checks.end());
    return valid;
}
static void lost_callback(
    WGPUDevice const*, WGPUDeviceLostReason reason, WGPUStringView message, void* userdata, void*)
{
    auto device = static_cast<Device*>(userdata);
    std::lock_guard<std::mutex> lock(device->mutex);
    try {
        device->events.push_back({ true, reason, text(message) });
    } catch (const std::bad_alloc&) {
        device->callback_oom = true;
    }
}
static void error_callback(
    WGPUDevice const*, WGPUErrorType type, WGPUStringView message, void* userdata, void*)
{
    auto device = static_cast<Device*>(userdata);
    std::lock_guard<std::mutex> lock(device->mutex);
    try {
        device->events.push_back({ false, type, text(message) });
    } catch (const std::bad_alloc&) {
        device->callback_oom = true;
    }
}
static Job* job_value(const std::shared_ptr<State>& state, JobKind kind, JSValueConst owner,
    const std::shared_ptr<Device>& device, JSValue& promise)
{
    state->jobs.reserve(state->jobs.size() + 1);
    auto job = std::make_unique<Job>();
    job->kind = kind;
    job->runtime = JS_GetRuntime(state->context);
    job->api = state->api;
    job->owner = JS_DupValue(state->context, owner);
    job->device = device;
    JSValue functions[2] = { JS_UNDEFINED, JS_UNDEFINED };
    promise = JS_NewPromiseCapability(state->context, functions);
    if (JS_IsException(promise)) {
        return nullptr;
    }
    job->resolve = functions[0];
    job->reject = functions[1];
    Job* pointer = job.get();
    state->jobs.push_back(std::move(job));
    return pointer;
}
struct Value {
    JSContext* context;
    JSValue value;
    Value(JSContext* c, JSValue v)
        : context(c)
        , value(v)
    {
    }
    ~Value() { JS_FreeValue(context, value); }
    operator JSValueConst() const { return value; }
};
struct Input {
    JSContext* context;
    std::deque<std::string> strings;
    std::vector<JSValue> retained;
    std::vector<std::pair<std::shared_ptr<const PuDawnApi>,WGPUTextureView>> temporary_views;
    std::vector<std::shared_ptr<void>> allocations;
    bool ok = true;
    ~Input()
    {
        for(const auto &view:temporary_views)view.first->TextureViewRelease(view.second);
        for (JSValue value : retained)
            JS_FreeValue(context, value);
    }
    Value field(JSValueConst object, const char* name)
    {
        JSValue value = JS_GetPropertyStr(context, object, name);
        if (JS_IsException(value))
            ok = false;
        return { context, value };
    }
    Value required(JSValueConst object, const char* name)
    {
        JSValue value = JS_GetPropertyStr(context, object, name);
        if (JS_IsUndefined(value)) {
            JS_FreeValue(context, value);
            value = JS_ThrowTypeError(context, "Missing WebGPU %s", name);
        }
        if (JS_IsException(value))
            ok = false;
        return { context, value };
    }
    template <typename T> T* allocate(size_t count, const T& initial)
    {
        auto values = std::make_shared<std::vector<T>>(count, initial);
        allocations.push_back(values);
        return values->data();
    }
    float real(JSValueConst object, const char* name, float fallback = 0)
    {
        auto value = field(object, name);
        if (JS_IsUndefined(value))
            return fallback;
        return float_value(value);
    }
    float float_value(JSValueConst value)
    {
        double number;
        // Round-to-nearest overflow occurs half an ULP above the largest finite float.
        double overflow=std::ldexp(1.0,128)-std::ldexp(1.0,103);
        if (JS_ToFloat64(context, &number, value) || !std::isfinite(number)
            || std::fabs(number) >= overflow) {
            if (!JS_HasException(context))
                JS_ThrowTypeError(context, "Invalid finite WebGPU float");
            ok = false;
            return 0;
        }
        if(std::fabs(number)>std::numeric_limits<float>::max())
            return std::copysign(std::numeric_limits<float>::max(),number);
        return static_cast<float>(number);
    }
    bool boolean(JSValueConst object, const char* name, bool fallback = false)
    {
        auto value = field(object, name);
        return JS_IsUndefined(value) ? fallback : JS_ToBool(context, value);
    }
    uint64_t integer(JSValueConst value)
    {
        if(JS_IsUndefined(value)){
            ok=false;JS_ThrowTypeError(context,"Missing required WebGPU integer");return 0;
        }
        return integer(value,0);
    }
    uint64_t integer(JSValueConst value, uint64_t fallback)
    {
        if (JS_IsUndefined(value))
            return fallback;
        double number = 0;
        if (JS_ToFloat64(context, &number, value) || !std::isfinite(number)) {
            ok = false;
            if (!JS_HasException(context))
                JS_ThrowTypeError(context, "Invalid finite WebGPU integer");
            return 0;
        }
        number = std::trunc(number);
        if (number < 0 || number > 9007199254740991.0) {
            if (!JS_HasException(context))
                JS_ThrowTypeError(context, "WebGPU integer exceeds safe unsigned range");
            ok = false;
            return 0;
        }
        return static_cast<uint64_t>(number);
    }
    uint32_t u32(JSValueConst value)
    {
        uint64_t number = integer(value);
        if (number > UINT32_MAX) {
            JS_ThrowTypeError(context, "WebGPU integer exceeds uint32 range");
            ok = false;
        }
        return static_cast<uint32_t>(number);
    }
    uint32_t u32(JSValueConst value,uint32_t fallback)
    {
        return JS_IsUndefined(value)?fallback:u32(value);
    }
    uint64_t required_number(JSValueConst object,const char *name)
    {
        auto value=required(object,name);return integer(value);
    }
    uint32_t required_number32(JSValueConst object,const char *name)
    {
        auto value=required(object,name);return u32(value);
    }
    int32_t s32(JSValueConst value)
    {
        double number=0;
        if(JS_ToFloat64(context,&number,value)||!std::isfinite(number)){
            ok=false;if(!JS_HasException(context))JS_ThrowTypeError(context,"Invalid finite WebGPU signed integer");return 0;
        }
        number=std::trunc(number);
        if(number<INT32_MIN||number>INT32_MAX){
            ok=false;JS_ThrowTypeError(context,"WebGPU integer exceeds int32 range");return 0;
        }
        return static_cast<int32_t>(number);
    }
    uint64_t number(JSValueConst object, const char* name, uint64_t fallback = 0)
    {
        auto value = field(object, name);
        return integer(value, fallback);
    }
    uint32_t number32(JSValueConst object, const char* name, uint32_t fallback = 0)
    {
        auto value = field(object, name);
        return u32(value, fallback);
    }
    WGPUStringView string(JSValueConst object, const char* name, bool required = false)
    {
        auto value = field(object, name);
        if (JS_IsException(value))
            return { nullptr, 0 };
        if (JS_IsUndefined(value) && required) {
            ok = false;
            JS_ThrowTypeError(context, "Missing WebGPU %s", name);
            return { nullptr, 0 };
        }
        if (JS_IsUndefined(value) && !required)
            return { nullptr, WGPU_STRLEN };
        size_t length = 0;
        const char* pointer = JS_ToCStringLen(context, &length, value);
        if (!pointer) {
            ok = false;
            return { nullptr, 0 };
        }
        strings.emplace_back(pointer, length);
        JS_FreeCString(context, pointer);
        return view(strings.back());
    }
    uint32_t enumeration(JSValueConst value, const char* type, uint32_t fallback = 0)
    {
        if (JS_IsUndefined(value))
            return fallback;
        const char* pointer = JS_ToCString(context, value);
        if (!pointer) {
            ok = false;
            return 0;
        }
        std::string normalized(pointer);
        JS_FreeCString(context, pointer);
#define PU_GPU_ENUM(group, name, native)                                                           \
    if (!std::strcmp(type, #group) && normalized == name)                                          \
        return static_cast<uint32_t>(native);
#include "webgpu-tables.inc"
#undef PU_GPU_ENUM
        ok = false;
        JS_ThrowTypeError(context, "Invalid WebGPU %s value", type);
        return 0;
    }
    template <typename T>
    T enumeration(JSValueConst object, const char* name, const char* type, T fallback)
    {
        auto value = field(object, name);
        return static_cast<T>(enumeration(value, type, static_cast<uint32_t>(fallback)));
    }
    Object* resource(JSValueConst value, Kind kind, const std::shared_ptr<Device>& device)
    {
        Object* object = get(context, value, kind, device);
        if (!object)
            ok = false;
        else {
            retained.reserve(retained.size() + 1);
            retained.push_back(JS_DupValue(context, value));
        }
        return object;
    }
};
static WGPUTextureView texture_view(Input &input,JSValueConst value,const std::shared_ptr<Device> &device,
    Object **target=nullptr)
{
    auto raw=static_cast<Object*>(JS_GetOpaque(value,object_class));
    if(raw&&raw->kind==Kind::Texture) {
        auto texture=input.resource(value,Kind::Texture,device);
        if(!texture)return nullptr;
        if(target)*target=texture;
        input.temporary_views.reserve(input.temporary_views.size()+1);
        auto view=texture->state->api->TextureCreateView(static_cast<WGPUTexture>(texture->native),nullptr);
        if(!view){input.ok=false;JS_ThrowInternalError(input.context,"Cannot create native default texture view");return nullptr;}
        input.temporary_views.emplace_back(texture->state->api,view);
        return view;
    }
    auto view=input.resource(value,Kind::TextureView,device);
    if(target)*target=view;
    return view?static_cast<WGPUTextureView>(view->native):nullptr;
}
struct Bytes {
    JSContext* context;
    JSValue buffer = JS_UNDEFINED;
    uint8_t* data = nullptr;
    size_t length = 0, element = 1;
    Bytes(JSContext* c, JSValueConst value)
        : context(c)
    {
        size_t offset = 0, total = 0;
        if (JS_IsArrayBuffer(value))
            buffer = JS_DupValue(c, value);
        else if (JS_IsDataView(value)) {
            auto state = states.find(c);
            if (state == states.end()) {
                JS_ThrowTypeError(c, "WebGPU runtime is closed");
                return;
            }
            buffer = JS_Call(c, state->second->data_view_getters[0], value, 0, nullptr);
            Value offset_value(
                c, JS_Call(c, state->second->data_view_getters[1], value, 0, nullptr));
            Value length_value(
                c, JS_Call(c, state->second->data_view_getters[2], value, 0, nullptr));
            int64_t byte_offset = 0, byte_length = 0;
            if (JS_IsException(buffer) || JS_ToInt64(c, &byte_offset, offset_value)
                || JS_ToInt64(c, &byte_length, length_value))
                return;
            offset = static_cast<size_t>(byte_offset);
            length = static_cast<size_t>(byte_length);
        } else
            buffer = JS_GetTypedArrayBuffer(c, value, &offset, &length, &element);
        if (JS_IsException(buffer))
            return;
        data = JS_GetArrayBuffer(c, &total, buffer);
        static uint8_t empty = 0;
        if (!data && !total && !JS_HasException(c))
            data = &empty;
        if (JS_IsArrayBuffer(value))
            length = total;
        if (!data || offset > total || length > total - offset) {
            data = nullptr;
            if (!JS_HasException(c))
                JS_ThrowTypeError(c, "Invalid or detached WebGPU BufferSource");
        } else
            data += offset;
        if (!element)
            element = 1;
    }
    ~Bytes() { JS_FreeValue(context, buffer); }
};
#include "bridge/webgpu_render.inc"
static JSValue operation_error(JSContext *,const char *);
#include "bridge/webgpu_bundle.inc"
#include "bridge/webgpu_resources.inc"
static JSValue info(Object* object)
{
    JSContext* context = object->state->context;
    const auto& api = *object->state->api;
    JSValue result = JS_NewObject(context);
    if (object->kind == Kind::Adapter || object->kind == Kind::Device) {
        WGPULimits limits = WGPU_LIMITS_INIT;
        WGPUStatus status = object->kind == Kind::Adapter
            ? api.AdapterGetLimits(static_cast<WGPUAdapter>(object->native), &limits)
            : api.DeviceGetLimits(static_cast<WGPUDevice>(object->native), &limits);
        if (status != WGPUStatus_Success) {
            JS_FreeValue(context, result);
            return JS_ThrowInternalError(context, "Cannot query native WebGPU limits");
        }
        JSValue properties = JS_NewObject(context);
#define PU_GPU_ENUM(group, name, native)
#define PU_GPU_LIMIT(name, type)                                                                   \
    JS_SetPropertyStr(                                                                             \
        context, properties, #name, JS_NewFloat64(context, static_cast<double>(limits.name)));
#include "webgpu-tables.inc"
#undef PU_GPU_LIMIT
#undef PU_GPU_ENUM
        JS_SetPropertyStr(context, result, "limits", properties);
        WGPUSupportedFeatures features = WGPU_SUPPORTED_FEATURES_INIT;
        if (object->kind == Kind::Adapter)
            api.AdapterGetFeatures(static_cast<WGPUAdapter>(object->native), &features);
        else
            api.DeviceGetFeatures(static_cast<WGPUDevice>(object->native), &features);
        JSValue values = JS_NewArray(context);
        uint32_t index = 0;
        for (size_t i = 0; i < features.featureCount; ++i) {
#define PU_GPU_ENUM(group, name, native)                                                           \
    if (!std::strcmp(#group, "FeatureName")                                                        \
        && features.features[i] == static_cast<WGPUFeatureName>(native))                           \
        JS_SetPropertyUint32(context, values, index++, JS_NewString(context, name));
#include "webgpu-tables.inc"
#undef PU_GPU_ENUM
        }
        api.SupportedFeaturesFreeMembers(features);
        JS_SetPropertyStr(context, result, "features", values);
        WGPUAdapter adapter = object->kind == Kind::Adapter
            ? static_cast<WGPUAdapter>(object->native)
            : static_cast<WGPUAdapter>(
                  static_cast<Object*>(JS_GetOpaque(object->owner, object_class))->native);
        WGPUAdapterInfo adapter_info = WGPU_ADAPTER_INFO_INIT;
        if (api.AdapterGetInfo(adapter, &adapter_info) != WGPUStatus_Success) {
            JS_FreeValue(context, result);
            return JS_ThrowInternalError(context, "Cannot query native WebGPU adapter info");
        }
        properties = JS_NewObject(context);
        for (auto pair : { std::make_pair("vendor", adapter_info.vendor),
                 { "architecture", adapter_info.architecture }, { "device", adapter_info.device },
                 { "description", adapter_info.description } })
            JS_SetPropertyStr(
                context, properties, pair.first, JS_NewString(context, text(pair.second).c_str()));
        JS_SetPropertyStr(context, properties, "subgroupMinSize",
            JS_NewUint32(context, adapter_info.subgroupMinSize));
        JS_SetPropertyStr(context, properties, "subgroupMaxSize",
            JS_NewUint32(context, adapter_info.subgroupMaxSize));
        bool software = false;
        std::string error;
        bool classified = pu_dawn_is_software(adapter_info, software, error);
        api.AdapterInfoFreeMembers(adapter_info);
        if (!classified) {
            JS_FreeValue(context, properties);
            JS_FreeValue(context, result);
            return JS_ThrowInternalError(context, "%s", error.c_str());
        }
        JS_SetPropertyStr(context, properties, "isFallbackAdapter", JS_NewBool(context, software));
        JS_SetPropertyStr(context, result, "info", properties);
    } else if (object->kind == Kind::Buffer) {
        auto buffer = static_cast<WGPUBuffer>(object->native);
        JS_SetPropertyStr(context, result, "size",
            JS_NewFloat64(context, static_cast<double>(api.BufferGetSize(buffer))));
        JS_SetPropertyStr(context, result, "usage",
            JS_NewUint32(context, static_cast<uint32_t>(api.BufferGetUsage(buffer))));
        auto map = api.BufferGetMapState(buffer);
        JS_SetPropertyStr(context, result, "mapState",
            JS_NewString(context,
                map == WGPUBufferMapState_Mapped        ? "mapped"
                    : map == WGPUBufferMapState_Pending ? "pending"
                                                        : "unmapped"));
    }
    if (object->kind == Kind::Texture) {
        auto texture = static_cast<WGPUTexture>(object->native);
        for (auto property : { std::make_pair("width", api.TextureGetWidth(texture)),
                 { "height", api.TextureGetHeight(texture) },
                 { "depthOrArrayLayers", api.TextureGetDepthOrArrayLayers(texture) },
                 { "mipLevelCount", api.TextureGetMipLevelCount(texture) },
                 { "sampleCount", api.TextureGetSampleCount(texture) },
                 { "usage", static_cast<uint32_t>(object->transient_emulated?object->public_texture_usage:api.TextureGetUsage(texture)) } })
            JS_SetPropertyStr(
                context, result, property.first, JS_NewUint32(context, property.second));
        const char* format = enum_name("TextureFormat", api.TextureGetFormat(texture));
        const char* dimension = enum_name("TextureDimension", api.TextureGetDimension(texture));
        if (!format || !dimension) {
            JS_FreeValue(context, result);
            return JS_ThrowInternalError(
                context, "Native texture metadata has an unknown format/dimension");
        }
        JS_SetPropertyStr(context, result, "format", JS_NewString(context, format));
        JS_SetPropertyStr(context, result, "dimension", JS_NewString(context, dimension));
        auto binding_dimension=api.DeviceHasFeature(object->device->native,WGPUFeatureName_CoreFeaturesAndLimits)?
            WGPUTextureViewDimension_Undefined:api.TextureGetTextureBindingViewDimension(texture);
        if(binding_dimension!=WGPUTextureViewDimension_Undefined){
            const char *name=enum_name("TextureViewDimension",binding_dimension);
            if(!name){JS_FreeValue(context,result);return JS_ThrowInternalError(context,"Unknown native texture binding view dimension");}
            JS_SetPropertyStr(context,result,"textureBindingViewDimension",JS_NewString(context,name));
        }
    }
    return result;
}
static void detach(Object* object)
{
    for (auto& range : object->mapped) {
        JS_DetachArrayBuffer(object->state->context, range.buffer);
        JS_FreeValue(object->state->context, range.buffer);
    }
    object->mapped.clear();
}
static JSValue dom_error(JSContext* context, const char* message, const char* name)
{
    JSValue global = JS_GetGlobalObject(context);
    JSValue constructor = JS_GetPropertyStr(context, global, "DOMException");
    JS_FreeValue(context, global);
    JSValue arguments[] = { JS_NewString(context, message), JS_NewString(context, name) };
    JSValue error = JS_CallConstructor(context, constructor, 2, arguments);
    JS_FreeValue(context, constructor);
    JS_FreeValue(context, arguments[0]);
    JS_FreeValue(context, arguments[1]);
    return error;
}
static JSValue operation_error(JSContext* context, const char* message)
{
    JSValue error = dom_error(context, message, "OperationError");
    return JS_IsException(error) ? error : JS_Throw(context, error);
}
#include "bridge/webgpu_canvas.inc"
static bool ensure_native(const std::shared_ptr<State>& state)
{
    if (state->instance)
        return true;
    std::string error;
    auto api = pu_dawn_load(error);
    if (!api) {
        JS_ThrowInternalError(state->context, "%s", error.c_str());
        return false;
    }
    WGPUInstanceFeatureName wait = WGPUInstanceFeatureName_TimedWaitAny;
    WGPUInstanceDescriptor descriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    descriptor.requiredFeatureCount = 1;
    descriptor.requiredFeatures = &wait;
    WGPUInstance instance = api->CreateInstance(&descriptor);
    if (!instance) {
        JS_ThrowInternalError(state->context, "Cannot create native WebGPU instance");
        return false;
    }
    state->api = std::move(api);
    state->instance = instance;
    return true;
}
static JSValue native_call(JSContext* context, JSValueConst, int argc, JSValueConst* argv)
{
    if (argc != 3 || !JS_IsString(argv[1]) || !JS_IsArray(argv[2]))
        return JS_ThrowTypeError(context, "Invalid WebGPU native call");
    auto found = states.find(context);
    if (found == states.end() || found->second->closed) {
        auto resource = static_cast<Object*>(JS_GetOpaque(argv[0], object_class));
        const char* operation = JS_ToCString(context, argv[1]);
        bool cleanup = operation && !std::strcmp(operation, "canvasUnconfigure") && resource
            && resource->kind == Kind::CanvasContext;
        bool external_cleanup=operation&&!std::strcmp(operation,"externalExpire")&&resource&&
            resource->kind==Kind::ExternalTexture&&resource->state->context==context;
        JS_FreeCString(context, operation);
        if (cleanup) {
            auto source = *static_cast<std::shared_ptr<CanvasSource>*>(resource->native);
            if (source->attached)
                pu_canvas_set_gpu_source(source->canvas, nullptr, nullptr);
            return JS_UNDEFINED;
        }
        if(external_cleanup) {
            if(resource->native)resource->state->api->ExternalTextureExpire(static_cast<WGPUExternalTexture>(resource->native));
            return JS_UNDEFINED;
        }
        return JS_ThrowTypeError(context, "WebGPU GUI runtime is closed");
    }
    auto state = found->second;
    const char* operation = JS_ToCString(context, argv[1]);
    if (!operation)
        return JS_EXCEPTION;
    std::string op(operation);
    JS_FreeCString(context, operation);
    Input input { context };
    auto argument = [&](uint32_t index) -> Value {
        return { context, JS_GetPropertyUint32(context, argv[2], index) };
    };
    if(op=="languageFeatures") {
        if(!ensure_native(state))return JS_EXCEPTION;
        WGPUSupportedWGSLLanguageFeatures native=WGPU_SUPPORTED_WGSL_LANGUAGE_FEATURES_INIT;
        state->api->InstanceGetWGSLLanguageFeatures(state->instance,&native);
        JSValue result=JS_NewArray(context);uint32_t index=0;
        for(size_t i=0;i<native.featureCount;++i) {
#define PU_GPU_ENUM(group,name,value)
#define PU_GPU_LANG(name,value) if(native.features[i]==value)JS_SetPropertyUint32(context,result,index++,JS_NewString(context,name));
#include "webgpu-tables.inc"
#undef PU_GPU_LANG
#undef PU_GPU_ENUM
        }
        state->api->SupportedWGSLLanguageFeaturesFreeMembers(native);
        return result;
    }
    if (op == "requestAdapter") {
        if (!ensure_native(state))
            return JS_EXCEPTION;
        const auto& api = *state->api;
        auto descriptor = argument(0);
        WGPURequestAdapterOptions options = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
        options.backendType = pu_dawn_backend();
        options.featureLevel
            = input.enumeration(descriptor, "featureLevel", "FeatureLevel", WGPUFeatureLevel_Core);
        options.powerPreference = input.enumeration(
            descriptor, "powerPreference", "PowerPreference", WGPUPowerPreference_Undefined);
        auto fallback = input.field(descriptor, "forceFallbackAdapter");
        bool force_fallback = JS_ToBool(context, fallback);
        options.forceFallbackAdapter = force_fallback;
        bool software = false;
        const char* policy = std::getenv("PU_WEBGPU_DEVICE");
        if (policy && *policy) {
            if (std::strcmp(policy, "software") && std::strcmp(policy, "default"))
                return JS_ThrowTypeError(context, "PU_WEBGPU_DEVICE must be default or software");
            software = software || !std::strcmp(policy, "software");
        }
        PuDawnAdapterLuid luid;
        std::string error;
        bool native_software_selection = software;
#ifdef _WIN32
        native_software_selection = software || force_fallback;
#endif
        if (native_software_selection && !pu_dawn_software_options(options, luid, error))
            return JS_ThrowInternalError(context, "%s", error.c_str());
        if (!input.ok)
            return JS_EXCEPTION;
        JSValue promise;
        Job* job = job_value(state, JobKind::Adapter, JS_UNDEFINED, { }, promise);
        if (!job)
            return promise;
        job->require_software = software;
        WGPURequestAdapterCallbackInfo callback = WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = adapter_callback;
        callback.userdata1 = job;
        api.RequestAdapter(
            state->instance, &options, luid.low, luid.high, luid.selected, &callback);
        return promise;
    }
    const auto& api = *state->api;
    auto object = static_cast<Object*>(JS_GetOpaque2(context, argv[0], object_class));
    if (!object)
        return JS_EXCEPTION;
    if (object->state != state || state->closed)
        return JS_ThrowTypeError(context, "WebGPU runtime mismatch");
    if (op == "info")
        return info(object);
    bool resource_handled;
    JSValue resource_result
        = resource_operation(object, op, input, argv[2], argv[0], resource_handled);
    if (resource_handled)
        return resource_result;
    JSValue render_result = render_operation(object, op, input, argv[2], argv[0], resource_handled);
    if (resource_handled)
        return render_result;
    JSValue bundle_result=bundle_operation(object,op,input,argv[2],argv[0],resource_handled);
    if(resource_handled)return bundle_result;
    JSValue canvas_result = canvas_operation(object, op, input, argv[2], argv[0], resource_handled);
    if (resource_handled)
        return canvas_result;
    auto descriptor = argument(0);
    if (op == "requestDevice") {
        if (object->kind != Kind::Adapter)
            return JS_ThrowTypeError(context, "Expected GPUAdapter");
        WGPUDeviceDescriptor native = WGPU_DEVICE_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        std::vector<WGPUFeatureName> features;
        auto required = input.field(descriptor, "requiredFeatures");
        if (!JS_IsUndefined(required)) {
            auto length = input.field(required, "length");
            uint32_t count = input.u32(length);
            if (count > 1024)
                return JS_ThrowRangeError(context, "Excessive requiredFeatures");
            for (uint32_t i = 0; i < count; ++i) {
                Value value(context, JS_GetPropertyUint32(context, required, i));
                features.push_back(
                    static_cast<WGPUFeatureName>(input.enumeration(value, "FeatureName")));
            }
        }
        native.requiredFeatures = features.data();
        native.requiredFeatureCount = features.size();
        if (api.AdapterHasFeature(
                static_cast<WGPUAdapter>(object->native), WGPUFeatureName_DawnInternalUsages)) {
            features.push_back(WGPUFeatureName_DawnInternalUsages);
            native.requiredFeatures = features.data();
            native.requiredFeatureCount = features.size();
        }
        const char *transient_policy=std::getenv("PU_WEBGPU_TRANSIENT_ALLOCATION");
        bool native_transient=!transient_policy||!std::strcmp(transient_policy,"native");
        if(transient_policy&&std::strcmp(transient_policy,"native")&&std::strcmp(transient_policy,"ordinary"))
            return JS_ThrowTypeError(context,"PU_WEBGPU_TRANSIENT_ALLOCATION must be native or ordinary");
        if(native_transient&&api.AdapterHasFeature(static_cast<WGPUAdapter>(object->native),WGPUFeatureName_TransientAttachments)){
            features.push_back(WGPUFeatureName_TransientAttachments);
            native.requiredFeatures=features.data();native.requiredFeatureCount=features.size();
        }
        WGPULimits limits = WGPU_LIMITS_INIT;
        auto required_limits = input.field(descriptor, "requiredLimits");
        if (!JS_IsUndefined(required_limits)) {
#define PU_GPU_ENUM(group, name, native)
#define PU_GPU_LIMIT(name, type)                                                                   \
    {                                                                                              \
        auto value = input.field(required_limits, #name);                                          \
        if (!JS_IsUndefined(value)) {                                                              \
            uint64_t n = input.integer(value);                                                     \
            if (sizeof(type) == 4 && n > UINT32_MAX) {                                             \
                input.ok = false;                                                                  \
                JS_ThrowTypeError(context, "Limit exceeds uint32");                                \
            }                                                                                      \
            limits.name = static_cast<type>(n);                                                    \
        }                                                                                          \
    }
#include "webgpu-tables.inc"
#undef PU_GPU_LIMIT
#undef PU_GPU_ENUM
            native.requiredLimits = &limits;
        }
        auto queue = input.field(descriptor, "defaultQueue");
        if (!JS_IsUndefined(queue))
            native.defaultQueue.label = input.string(queue, "label");
        if (!input.ok)
            return JS_EXCEPTION;
        auto device = std::make_shared<Device>();
        state->devices.push_back(device);
        native.deviceLostCallbackInfo.mode = WGPUCallbackMode_AllowProcessEvents;
        native.deviceLostCallbackInfo.callback = lost_callback;
        native.deviceLostCallbackInfo.userdata1 = device.get();
        native.uncapturedErrorCallbackInfo.callback = error_callback;
        native.uncapturedErrorCallbackInfo.userdata1 = device.get();
        JSValue promise;
        Job* job = job_value(state, JobKind::Device, argv[0], device, promise);
        if (!job)
            return promise;
        WGPURequestDeviceCallbackInfo callback = WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = device_callback;
        callback.userdata1 = job;
        api.AdapterRequestDevice(static_cast<WGPUAdapter>(object->native), &native, callback);
        return promise;
    }
    if (op == "lost")
        return object->kind == Kind::Device ? JS_DupValue(context, object->lost_promise)
                                            : JS_ThrowTypeError(context, "Expected GPUDevice");
    if (op == "errorHandler") {
        if (object->kind != Kind::Device || !JS_IsFunction(context, descriptor))
            return JS_ThrowTypeError(context, "Expected GPUDevice and error callback");
        JS_FreeValue(context, object->error_handler);
        object->error_handler = JS_DupValue(context, descriptor);
        return JS_UNDEFINED;
    }
    if (op == "setLabel") {
        const char* label = JS_ToCString(context, descriptor);
        if (!label)
            return JS_EXCEPTION;
        WGPUStringView string = { label, WGPU_STRLEN };
#define LABEL(kind, type)                                                                          \
    case Kind::kind:                                                                               \
        api.type##SetLabel(static_cast<WGPU##type>(object->native), string);                       \
        break
        switch (object->kind) {
            LABEL(Device, Device);
            LABEL(Queue, Queue);
            LABEL(Buffer, Buffer);
            LABEL(Texture, Texture);
            LABEL(TextureView, TextureView);
            LABEL(Sampler, Sampler);
            LABEL(ExternalTexture, ExternalTexture);
            LABEL(QuerySet, QuerySet);
            LABEL(BundleEncoder, RenderBundleEncoder);
            LABEL(Bundle, RenderBundle);
            LABEL(RenderPipeline, RenderPipeline);
            LABEL(RenderPass, RenderPassEncoder);
        case Kind::CanvasContext:
            break;
            LABEL(Shader, ShaderModule);
            LABEL(ComputePipeline, ComputePipeline);
            LABEL(BindGroupLayout, BindGroupLayout);
            LABEL(PipelineLayout, PipelineLayout);
            LABEL(BindGroup, BindGroup);
            LABEL(Encoder, CommandEncoder);
            LABEL(ComputePass, ComputePassEncoder);
            LABEL(CommandBuffer, CommandBuffer);
        case Kind::Adapter:
            break;
        }
#undef LABEL
        JS_FreeCString(context, label);
        return JS_UNDEFINED;
    }
    if (op == "destroy") {
        if (object->kind == Kind::Device) {
            for (auto resource : state->objects)
                if (resource->device == object->device)
                    detach(resource);
            if (!object->device->destroyed)
                api.DeviceDestroy(static_cast<WGPUDevice>(object->native));
            object->device->destroyed = true;
        } else if (object->kind == Kind::Buffer) {
            detach(object);
            api.BufferDestroy(static_cast<WGPUBuffer>(object->native));
        } else if (object->kind == Kind::Texture) {
            api.TextureDestroy(static_cast<WGPUTexture>(object->native));
        } else if(object->kind==Kind::QuerySet) {
            api.QuerySetDestroy(static_cast<WGPUQuerySet>(object->native));
        } else
            return JS_ThrowTypeError(context, "Resource has no destroy operation");
        object->destroyed = true;
        return JS_UNDEFINED;
    }
    if (object->kind == Kind::Device) {
        auto device = static_cast<WGPUDevice>(object->native);
        if (op == "queue")
            return object_value(
                state, Kind::Queue, api.DeviceGetQueue(device), argv[0], object->device);
        if (op == "createBuffer") {
            WGPUBufferDescriptor native = WGPU_BUFFER_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            auto size = input.required(descriptor, "size");
            auto usage = input.required(descriptor, "usage");
            native.size = input.integer(size);
            native.usage = input.u32(usage);
            auto mapped = input.field(descriptor, "mappedAtCreation");
            native.mappedAtCreation = JS_ToBool(context, mapped);
            if (!input.ok)
                return JS_EXCEPTION;
            JSValue value = object_value(state, Kind::Buffer,
                api.DeviceCreateBuffer(device, &native), argv[0], object->device);
            if (!JS_IsException(value) && native.mappedAtCreation) {
                auto buffer = static_cast<Object*>(JS_GetOpaque(value, object_class));
                buffer->map_size = native.size;
                buffer->writable = true;
            }
            return value;
        }
        if (op == "createShaderModule") {
            WGPUShaderSourceWGSL source = WGPU_SHADER_SOURCE_WGSL_INIT;
            source.code = input.string(descriptor, "code", true);
            WGPUShaderModuleDescriptor native = WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            native.nextInChain = &source.chain;
            if (!input.ok)
                return JS_EXCEPTION;
            JSValue value = object_value(state, Kind::Shader,
                api.DeviceCreateShaderModule(device, &native), argv[0], object->device);
            return value;
        }
        if (op == "createComputePipeline" || op == "createComputePipelineAsync") {
            WGPUComputePipelineDescriptor native = WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            auto layout_value = input.field(descriptor, "layout");
            if (!JS_IsString(layout_value)) {
                auto layout = input.resource(layout_value, Kind::PipelineLayout, object->device);
                if (!layout)
                    return JS_EXCEPTION;
                native.layout = static_cast<WGPUPipelineLayout>(layout->native);
            } else {
                const char* layout = JS_ToCString(context, layout_value);
                if (!layout)
                    return JS_EXCEPTION;
                bool automatic = !std::strcmp(layout, "auto");
                JS_FreeCString(context, layout);
                if (!automatic)
                    return JS_ThrowTypeError(context, "Expected layout auto or GPUPipelineLayout");
            }
            auto compute = input.field(descriptor, "compute");
            auto module_value = input.field(compute, "module");
            auto module = input.resource(module_value, Kind::Shader, object->device);
            if (!module)
                return JS_EXCEPTION;
            native.compute.module = static_cast<WGPUShaderModule>(module->native);
            native.compute.entryPoint = input.string(compute, "entryPoint");
            std::vector<WGPUConstantEntry> constants;
            auto constants_value = input.field(compute, "constants");
            if (!JS_IsUndefined(constants_value)) {
                JSPropertyEnum* properties = nullptr;
                uint32_t count = 0;
                if (JS_GetOwnPropertyNames(context, &properties, &count, constants_value,
                        JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY))
                    return JS_EXCEPTION;
                if (count > 1024) {
                    for (uint32_t i = 0; i < count; ++i)
                        JS_FreeAtom(context, properties[i].atom);
                    js_free(context, properties);
                    return JS_ThrowRangeError(context, "Excessive shader constants");
                }
                for (uint32_t i = 0; i < count; ++i) {
                    const char* name = JS_AtomToCString(context, properties[i].atom);
                    if (name) {
                        input.strings.emplace_back(name);
                        JS_FreeCString(context, name);
                        Value value(
                            context, JS_GetProperty(context, constants_value, properties[i].atom));
                        WGPUConstantEntry entry = WGPU_CONSTANT_ENTRY_INIT;
                        entry.key = view(input.strings.back());
                        if (JS_ToFloat64(context, &entry.value, value)
                            || !std::isfinite(entry.value)) {
                            input.ok = false;
                            if (!JS_HasException(context))
                                JS_ThrowTypeError(context, "Shader constant must be finite");
                        }
                        constants.push_back(entry);
                    } else
                        input.ok = false;
                    JS_FreeAtom(context, properties[i].atom);
                }
                js_free(context, properties);
            }
            native.compute.constants = constants.data();
            native.compute.constantCount = constants.size();
            if (!input.ok)
                return JS_EXCEPTION;
            if (op == "createComputePipelineAsync") {
                JSValue promise;
                Job* job
                    = job_value(state, JobKind::ComputePipeline, argv[0], object->device, promise);
                if (!job)
                    return promise;
                WGPUCreateComputePipelineAsyncCallbackInfo callback
                    = WGPU_CREATE_COMPUTE_PIPELINE_ASYNC_CALLBACK_INFO_INIT;
                callback.mode = WGPUCallbackMode_AllowProcessEvents;
                callback.callback = compute_pipeline_callback;
                callback.userdata1 = job;
                api.DeviceCreateComputePipelineAsync(device, &native, callback);
                return promise;
            }
            return object_value(state, Kind::ComputePipeline,
                api.DeviceCreateComputePipeline(device, &native), argv[0], object->device);
        }
        if (op == "createBindGroup") {
            WGPUBindGroupDescriptor native = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            auto layout_value = input.field(descriptor, "layout");
            auto layout = input.resource(layout_value, Kind::BindGroupLayout, object->device);
            if (!layout)
                return JS_EXCEPTION;
            native.layout = static_cast<WGPUBindGroupLayout>(layout->native);
            auto entries_value = input.field(descriptor, "entries");
            auto length = input.field(entries_value, "length");
            uint32_t count = input.u32(length);
            if (count > 10000)
                return JS_ThrowRangeError(context, "Excessive bind group entries");
            std::vector<WGPUBindGroupEntry> entries;
            for (uint32_t i = 0; i < count; ++i) {
                Value entry_value(context, JS_GetPropertyUint32(context, entries_value, i));
                WGPUBindGroupEntry entry = WGPU_BIND_GROUP_ENTRY_INIT;
                entry.binding = input.required_number32(entry_value, "binding");
                auto resource_value = input.required(entry_value, "resource");
                auto direct = static_cast<Object*>(JS_GetOpaque(resource_value, object_class));
                if(direct && direct->kind==Kind::ExternalTexture) {
                    auto resource=input.resource(resource_value,Kind::ExternalTexture,object->device);
                    if(!resource)return JS_EXCEPTION;
                    auto external=input.allocate(1,WGPU_EXTERNAL_TEXTURE_BINDING_ENTRY_INIT);
                    external->externalTexture=static_cast<WGPUExternalTexture>(resource->native);
                    entry.nextInChain=&external->chain;
                    entries.push_back(entry);continue;
                }
                if (direct
                    && (direct->kind == Kind::Texture || direct->kind == Kind::TextureView || direct->kind == Kind::Sampler
                        || direct->kind == Kind::Buffer)) {
                    auto resource = input.resource(resource_value, direct->kind, object->device);
                    if (!resource)
                        return JS_EXCEPTION;
                    if (direct->kind == Kind::TextureView||direct->kind==Kind::Texture)
                        entry.textureView = texture_view(input,resource_value,object->device);
                    else if (direct->kind == Kind::Sampler)
                        entry.sampler = static_cast<WGPUSampler>(resource->native);
                    else
                        entry.buffer = static_cast<WGPUBuffer>(resource->native);
                    entries.push_back(entry);
                    continue;
                }
                auto buffer_value = input.field(resource_value, "buffer");
                auto buffer = input.resource(buffer_value, Kind::Buffer, object->device);
                if (!buffer)
                    return JS_EXCEPTION;
                entry.buffer = static_cast<WGPUBuffer>(buffer->native);
                entry.offset = input.number(resource_value, "offset");
                entry.size = input.number(resource_value, "size", WGPU_WHOLE_SIZE);
                entries.push_back(entry);
            }
            native.entries = entries.data();
            native.entryCount = entries.size();
            if (!input.ok)
                return JS_EXCEPTION;
            return object_value(state, Kind::BindGroup, api.DeviceCreateBindGroup(device, &native),
                argv[0], object->device);
        }
        if (op == "createCommandEncoder") {
            WGPUCommandEncoderDescriptor native = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            if (!input.ok)
                return JS_EXCEPTION;
            return object_value(state, Kind::Encoder,
                api.DeviceCreateCommandEncoder(device, &native), argv[0], object->device);
        }
        if (op == "pushErrorScope") {
            auto filter
                = static_cast<WGPUErrorFilter>(input.enumeration(descriptor, "ErrorFilter"));
            if (!input.ok)
                return JS_EXCEPTION;
            api.DevicePushErrorScope(device, filter);
            return JS_UNDEFINED;
        }
        if (op == "popErrorScope") {
            JSValue promise;
            Job* job = job_value(state, JobKind::Scope, argv[0], object->device, promise);
            if (!job)
                return promise;
            WGPUPopErrorScopeCallbackInfo callback = WGPU_POP_ERROR_SCOPE_CALLBACK_INFO_INIT;
            callback.mode = WGPUCallbackMode_AllowProcessEvents;
            callback.callback = scope_callback;
            callback.userdata1 = job;
            api.DevicePopErrorScope(device, callback);
            return promise;
        }
    }
    if (object->kind == Kind::Buffer) {
        auto buffer = static_cast<WGPUBuffer>(object->native);
        uint64_t size = api.BufferGetSize(buffer);
        if (op == "unmap") {
            if (object->writable && api.BufferGetMapState(buffer) == WGPUBufferMapState_Mapped
                && !object->device->destroyed) {
                for (auto& range : object->mapped) {
                    size_t length = 0;
                    const uint8_t* bytes = JS_GetArrayBuffer(context, &length, range.buffer);
                    void* native = api.BufferGetMappedRange(
                        buffer, range.offset, static_cast<size_t>(range.size));
                    if (!bytes || length != range.size || !native)
                        return JS_ThrowInternalError(
                            context, "Cannot commit mapped WebGPU range before unmap");
                    std::memcpy(native, bytes, length);
                }
            }
            detach(object);
            api.BufferUnmap(buffer);
            return JS_UNDEFINED;
        }
        if (op == "mapAsync") {
            auto offset_value = argument(1), size_value = argument(2);
            uint64_t offset = input.integer(offset_value);
            uint64_t count = input.integer(size_value, offset <= size ? size - offset : 0);
            auto mode = static_cast<WGPUMapMode>(input.u32(descriptor));
            if (!input.ok)
                return JS_EXCEPTION;
            JSValue promise;
            Job* job = job_value(state, JobKind::Map, argv[0], object->device, promise);
            if (!job)
                return promise;
            job->map_offset = offset;
            job->map_size = count;
            job->writable = mode == WGPUMapMode_Write;
            WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            callback.mode = WGPUCallbackMode_AllowProcessEvents;
            callback.callback = map_callback;
            callback.userdata1 = job;
            api.BufferMapAsync(buffer, mode, offset, count, callback);
            return promise;
        }
        if (op == "getMappedRange") {
            auto size_value = argument(1);
            uint64_t offset = input.integer(descriptor);
            uint64_t count = input.integer(size_value, offset <= size ? size - offset : 0);
            if (!input.ok)
                return JS_EXCEPTION;
            if (offset % 8 || count % 4 || offset < object->map_offset
                || offset - object->map_offset > object->map_size
                || count > object->map_size - (offset - object->map_offset))
                return operation_error(
                    context, "Mapped range is outside the mapped buffer or misaligned");
            for (auto& range : object->mapped)
                if (count && range.size && offset < range.offset + range.size
                    && range.offset < offset + count)
                    return operation_error(context, "Mapped ranges must not overlap");
            void* pointer = object->writable
                ? api.BufferGetMappedRange(buffer, offset, static_cast<size_t>(count))
                : const_cast<void*>(
                      api.BufferGetConstMappedRange(buffer, offset, static_cast<size_t>(count)));
            if (!pointer)
                return operation_error(context, "Buffer is not mapped");
            // JS owns these bytes so native loss cannot invalidate memory behind a live TypedArray.
            // Writable ranges are committed to the real native mapping by unmap().
            object->mapped.reserve(object->mapped.size() + 1);
            JSValue result = JS_NewArrayBufferCopy(
                context, static_cast<uint8_t*>(pointer), static_cast<size_t>(count));
            if (!JS_IsException(result))
                object->mapped.push_back({ offset, count, JS_DupValue(context, result) });
            return result;
        }
    }
    if (object->kind == Kind::ComputePipeline && op == "getBindGroupLayout") {
        uint32_t index = input.u32(descriptor);
        if (!input.ok)
            return JS_EXCEPTION;
        return object_value(state, Kind::BindGroupLayout,
            api.ComputePipelineGetBindGroupLayout(
                static_cast<WGPUComputePipeline>(object->native), index),
            object->owner, object->device);
    }
    if (object->kind == Kind::Encoder) {
        auto encoder = static_cast<WGPUCommandEncoder>(object->native);
        if (op == "beginComputePass") {
            WGPUComputePassDescriptor native = WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            auto timestamps=input.field(descriptor,"timestampWrites");
            native.timestampWrites=timestamp_writes(input,timestamps,object->device);
            if (!input.ok)
                return JS_EXCEPTION;
            return object_value(state, Kind::ComputePass,
                api.CommandEncoderBeginComputePass(encoder, &native), argv[0], object->device);
        }
        if (op == "copyBufferToBuffer") {
            auto offset_value = argument(1), destination_value = argument(2);
            auto destination_offset_value = argument(3), size_value = argument(4);
            auto source = input.resource(descriptor, Kind::Buffer, object->device);
            auto destination = input.resource(destination_value, Kind::Buffer, object->device);
            uint64_t source_offset = input.integer(offset_value);
            uint64_t destination_offset = input.integer(destination_offset_value);
            if (!input.ok)
                return JS_EXCEPTION;
            uint64_t source_size=api.BufferGetSize(static_cast<WGPUBuffer>(source->native));
            uint64_t size=JS_IsUndefined(size_value)?(source_offset<=source_size?source_size-source_offset:0):
                input.integer(size_value);
            if(!input.ok)return JS_EXCEPTION;
            api.CommandEncoderCopyBufferToBuffer(encoder, static_cast<WGPUBuffer>(source->native),
                source_offset, static_cast<WGPUBuffer>(destination->native), destination_offset,
                size);
            return JS_UNDEFINED;
        }
        if (op == "finish") {
            WGPUCommandBufferDescriptor native = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
            native.label = input.string(descriptor, "label");
            if (!input.ok)
                return JS_EXCEPTION;
            object->finished = true;
            JSValue value=object_value(state, Kind::CommandBuffer,
                api.CommandEncoderFinish(encoder, &native), object->owner, object->device);
            if(!JS_IsException(value))
                static_cast<Object*>(JS_GetOpaque(value,object_class))->canvas_writes=object->canvas_writes;
            return value;
        }
    }
    if (object->kind == Kind::ComputePass) {
        auto pass = static_cast<WGPUComputePassEncoder>(object->native);
        if (op == "setPipeline") {
            auto pipeline = input.resource(descriptor, Kind::ComputePipeline, object->device);
            if (!pipeline)
                return JS_EXCEPTION;
            api.ComputePassEncoderSetPipeline(
                pass, static_cast<WGPUComputePipeline>(pipeline->native));
            return JS_UNDEFINED;
        }
        if (op == "setBindGroup") {
            auto group_value = argument(1), offsets_value = argument(2);
            uint32_t index = input.u32(descriptor);
            auto group = JS_IsNull(group_value)
                ? nullptr
                : input.resource(group_value, Kind::BindGroup, object->device);
            auto length = input.field(offsets_value, "length");
            uint32_t count = input.u32(length);
            if (count > 10000)
                return JS_ThrowRangeError(context, "Excessive dynamic offsets");
            std::vector<uint32_t> offsets;
            for (uint32_t i = 0; i < count; ++i) {
                Value value(context, JS_GetPropertyUint32(context, offsets_value, i));
                offsets.push_back(input.u32(value));
            }
            if (!input.ok)
                return JS_EXCEPTION;
            api.ComputePassEncoderSetBindGroup(pass, index,
                group ? static_cast<WGPUBindGroup>(group->native) : nullptr, offsets.size(),
                offsets.data());
            return JS_UNDEFINED;
        }
        if (op == "dispatchWorkgroups") {
            auto y_value = argument(1), z_value = argument(2);
            uint32_t x = input.u32(descriptor), y = input.u32(y_value, 1),
                     z = input.u32(z_value, 1);
            if (!input.ok)
                return JS_EXCEPTION;
            api.ComputePassEncoderDispatchWorkgroups(pass, x, y, z);
            return JS_UNDEFINED;
        }
        if (op == "dispatchWorkgroupsIndirect") {
            auto buffer = input.resource(descriptor, Kind::Buffer, object->device);
            auto offset_value = argument(1);
            uint64_t offset = input.integer(offset_value);
            if (!input.ok)
                return JS_EXCEPTION;
            api.ComputePassEncoderDispatchWorkgroupsIndirect(
                pass, static_cast<WGPUBuffer>(buffer->native), offset);
            return JS_UNDEFINED;
        }
        if (op == "end") {
            api.ComputePassEncoderEnd(pass);
            object->finished = true;
            return JS_UNDEFINED;
        }
    }
    if (object->kind == Kind::Queue && op == "submit") {
        auto length = input.field(descriptor, "length");
        uint32_t count = input.u32(length);
        if (count > 10000)
            return JS_ThrowRangeError(context, "Excessive command buffers");
        std::vector<WGPUCommandBuffer> commands;
        std::vector<Object*> submitted;
        for (uint32_t i = 0; i < count; ++i) {
            Value value(context, JS_GetPropertyUint32(context, descriptor, i));
            auto command = input.resource(value, Kind::CommandBuffer, object->device);
            if (!command)
                return JS_EXCEPTION;
            commands.push_back(static_cast<WGPUCommandBuffer>(command->native));
            submitted.push_back(command);
            command->submitted = true;
        }
        if (!input.ok)
            return JS_EXCEPTION;
        bool writes=std::any_of(submitted.begin(),submitted.end(),[](Object *command){return !command->canvas_writes.empty();});
        bool accepted=true;
        if(writes) accepted=checked_mutation(object,[&]{api.QueueSubmit(static_cast<WGPUQueue>(object->native),commands.size(),commands.data());});
        else api.QueueSubmit(static_cast<WGPUQueue>(object->native),commands.size(),commands.data());
        if(accepted)for(Object *command:submitted)publish_canvas_commands(command);
        return JS_UNDEFINED;
    }
    if (object->kind == Kind::Queue && op == "writeBuffer") {
        auto buffer = input.resource(descriptor, Kind::Buffer, object->device);
        auto offset_value = argument(1), data_value = argument(2);
        auto data_offset_value = argument(3), size_value = argument(4);
        Bytes bytes(context, data_value);
        if (!buffer || !bytes.data)
            return JS_EXCEPTION;
        uint64_t offset = input.integer(offset_value);
        uint64_t data_offset = input.integer(data_offset_value);
        uint64_t elements = bytes.length / bytes.element;
        uint64_t count
            = input.integer(size_value, data_offset <= elements ? elements - data_offset : 0);
        if (!input.ok)
            return JS_EXCEPTION;
        if (data_offset > elements || count > elements - data_offset)
            return operation_error(context, "writeBuffer exceeds supplied BufferSource view");
        uint64_t byte_size = count * bytes.element;
        if (byte_size % 4)
            return operation_error(context, "writeBuffer byte length must be a multiple of four");
        api.QueueWriteBuffer(static_cast<WGPUQueue>(object->native),
            static_cast<WGPUBuffer>(buffer->native), offset,
            bytes.data + data_offset * bytes.element, static_cast<size_t>(byte_size));
        return JS_UNDEFINED;
    }
    if (object->kind == Kind::Queue && op == "onSubmittedWorkDone") {
        JSValue promise;
        Job* job = job_value(state, JobKind::Submitted, argv[0], object->device, promise);
        if (!job)
            return promise;
        WGPUQueueWorkDoneCallbackInfo callback = WGPU_QUEUE_WORK_DONE_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = submitted_callback;
        callback.userdata1 = job;
        api.QueueOnSubmittedWorkDone(static_cast<WGPUQueue>(object->native), callback);
        return promise;
    }
    if (object->kind == Kind::Shader && op == "getCompilationInfo") {
        JSValue promise;
        Job* job = job_value(state, JobKind::Compilation, argv[0], object->device, promise);
        if (!job)
            return promise;
        WGPUCompilationInfoCallbackInfo callback = WGPU_COMPILATION_INFO_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = compilation_callback;
        callback.userdata1 = job;
        api.ShaderModuleGetCompilationInfo(static_cast<WGPUShaderModule>(object->native), callback);
        return promise;
    }
    return JS_ThrowTypeError(context, "Unknown native WebGPU operation: %s", op.c_str());
}
static JSValue native_safe(JSContext* context, JSValueConst self, int count, JSValueConst* args)
{
    try {
        JSValue result = native_call(context, self, count, args);
        if (JS_HasException(context) && !JS_IsException(result)) {
            JS_FreeValue(context, result);
            return JS_EXCEPTION;
        }
        return result;
    } catch (const std::bad_alloc&) {
        return JS_ThrowOutOfMemory(context);
    }
}
} // namespace

int pu_webgpu_pending(JSContext* context)
{
    auto found = states.find(context);
    return found != states.end() && !found->second->closed && !found->second->jobs.empty();
}
size_t pu_webgpu_live_resources(void) { return live_resources; }
static int pump_native(JSContext* context)
{
    auto found = states.find(context);
    if (found == states.end() || found->second->closed)
        return 0;
    auto state = found->second;
    if (!state->instance)
        return 0;
    state->api->InstanceProcessEvents(state->instance);
    for (auto& readback : state->canvas_readbacks) {
        if (!readback->done.load(std::memory_order_acquire)) {
            WGPUFutureWaitInfo wait = WGPU_FUTURE_WAIT_INFO_INIT;
            wait.future = readback->future;
            state->api->InstanceWaitAny(state->instance, 1, &wait, 0);
        }
    }
    state->canvas_readbacks.erase(
        std::remove_if(state->canvas_readbacks.begin(), state->canvas_readbacks.end(),
            [](const auto& readback) { return readback->done.load(std::memory_order_acquire); }),
        state->canvas_readbacks.end());
    int count = 0;
    auto devices = state->devices;
    for (auto& device : devices) {
        std::vector<Event> events;
        {
            std::lock_guard<std::mutex> lock(device->mutex);
            if (device->callback_oom) {
                device->callback_oom = false;
                JS_ThrowOutOfMemory(context);
                return -1;
            }
            events.swap(device->events);
        }
        for (auto& event : events) {
            auto object = device->object;
            if (!object)
                continue;
            JSValue value = JS_NewObject(context);
            JS_SetPropertyStr(
                context, value, "message", JS_NewString(context, event.message.c_str()));
            JSValue callback;
            if (event.lost) {
                device->destroyed = true;
                for (auto resource : state->objects)
                    if (resource->device == device)
                        detach(resource);
                JS_SetPropertyStr(context, value, "reason",
                    JS_NewString(context,
                        event.type == WGPUDeviceLostReason_Destroyed ? "destroyed" : "unknown"));
                callback = JS_DupValue(context, object->lost_resolve);
            } else {
                JS_SetPropertyStr(context, value, "type", JS_NewInt32(context, event.type));
                callback = JS_DupValue(context, object->error_handler);
                if (JS_IsUndefined(callback))
                    std::fprintf(
                        stderr, "[webgpu] uncaptured native error: %s\n", event.message.c_str());
            }
            if (JS_IsFunction(context, callback)) {
                JSValue result = JS_Call(context, callback, JS_UNDEFINED, 1, &value);
                JS_FreeValue(context, result);
            }
            JS_FreeValue(context, callback);
            JS_FreeValue(context, value);
            ++count;
        }
    }
    // Swap completed jobs out before executing JS, which may append new jobs.
    std::vector<std::unique_ptr<Job>> completed;
    completed.reserve(state->jobs.size());
    for (auto iterator = state->jobs.begin(); iterator != state->jobs.end();) {
        bool done;
        {
            std::lock_guard<std::mutex> lock((*iterator)->mutex);
            done = (*iterator)->done;
        }
        if (done) {
            completed.push_back(std::move(*iterator));
            iterator = state->jobs.erase(iterator);
        } else
            ++iterator;
    }
    for (auto& job : completed) {
        bool success = false;
        switch (job->kind) {
        case JobKind::Adapter:
            success = job->status == WGPURequestAdapterStatus_Success;
            break;
        case JobKind::Device:
            success = job->status == WGPURequestDeviceStatus_Success;
            break;
        case JobKind::Map:
            success = job->status == WGPUMapAsyncStatus_Success;
            break;
        case JobKind::Submitted:
            success = job->status == WGPUQueueWorkDoneStatus_Success;
            break;
        case JobKind::Scope:
            success = job->status == WGPUPopErrorScopeStatus_Success;
            break;
        case JobKind::Compilation:
            success = job->status == WGPUCompilationInfoRequestStatus_Success;
            break;
        case JobKind::ComputePipeline:
            success = job->status == WGPUCreatePipelineAsyncStatus_Success;
            break;
        case JobKind::RenderPipeline:
            success = job->status == WGPUCreatePipelineAsyncStatus_Success;
            break;
        }
        if (job->callback_oom)
            success = false;
        if (success && job->kind == JobKind::Adapter && job->require_software) {
            WGPUAdapterInfo info = WGPU_ADAPTER_INFO_INIT;
            bool software = false;
            std::string error;
            bool valid = state->api->AdapterGetInfo(static_cast<WGPUAdapter>(job->native), &info)
                == WGPUStatus_Success;
            if (valid)
                valid = pu_dawn_is_software(info, software, error);
            state->api->AdapterInfoFreeMembers(info);
            if (!valid || !software) {
                success = false;
                job->message = valid
                    ? "Explicit software WebGPU policy selected a non-software adapter"
                    : "Cannot verify software WebGPU adapter: " + error;
            }
        }
        JSValue value = JS_UNDEFINED;
        if (job->kind == JobKind::Adapter) {
            if (success) {
                void* native = job->native;
                job->native = nullptr;
                value = object_value(state, Kind::Adapter, native, JS_UNDEFINED);
            } else if (job->status == WGPURequestAdapterStatus_Unavailable) {
                success = true;
                value = JS_NULL;
            }
        } else if (job->kind == JobKind::Device && success) {
            job->device->native = static_cast<WGPUDevice>(job->native);
            void* native = job->native;
            job->native = nullptr;
            value = object_value(state, Kind::Device, native, job->owner, job->device);
        } else if (job->kind == JobKind::Map && success) {
            auto buffer = static_cast<Object*>(JS_GetOpaque(job->owner, object_class));
            if (buffer) {
                buffer->map_offset = job->map_offset;
                buffer->map_size = job->map_size;
                buffer->writable = job->writable;
            }
        } else if (job->kind == JobKind::ComputePipeline && success) {
            void* native = job->native;
            job->native = nullptr;
            value = object_value(state, Kind::ComputePipeline, native, job->owner, job->device);
        } else if (job->kind == JobKind::RenderPipeline && success) {
            void* native = job->native;
            job->native = nullptr;
            value = object_value(state, Kind::RenderPipeline, native, job->owner, job->device);
        } else if (job->kind == JobKind::Compilation && success) {
            value = JS_NewObject(context);
            JSValue messages = JS_NewArray(context);
            for (uint32_t i = 0; i < job->compilation.size(); ++i) {
                const auto& message = job->compilation[i];
                JSValue item = JS_NewObject(context);
                JS_SetPropertyStr(
                    context, item, "message", JS_NewString(context, message.message.c_str()));
                JS_SetPropertyStr(context, item, "type",
                    JS_NewString(context,
                        message.type == WGPUCompilationMessageType_Error         ? "error"
                            : message.type == WGPUCompilationMessageType_Warning ? "warning"
                                                                                 : "info"));
                for (auto pair :
                    { std::make_pair("lineNum", message.line), { "linePos", message.column },
                        { "offset", message.offset }, { "length", message.length } })
                    JS_SetPropertyStr(context, item, pair.first,
                        JS_NewFloat64(context, static_cast<double>(pair.second)));
                JS_SetPropertyUint32(context, messages, i, item);
            }
            JS_SetPropertyStr(context, value, "messages", messages);
        } else if (job->kind == JobKind::Scope && success) {
            if (job->error_type == WGPUErrorType_NoError)
                value = JS_NULL;
            else {
                value = JS_NewObject(context);
                JS_SetPropertyStr(context, value, "type", JS_NewInt32(context, job->error_type));
                JS_SetPropertyStr(
                    context, value, "message", JS_NewString(context, job->message.c_str()));
            }
        }
        if (!success) {
            value = dom_error(context, job->message.c_str(),
                job->kind == JobKind::ComputePipeline || job->kind == JobKind::RenderPipeline
                    ? "GPUPipelineError"
                    : "OperationError");
            if ((job->kind == JobKind::ComputePipeline || job->kind == JobKind::RenderPipeline)
                && !JS_IsException(value)) {
                JS_SetPropertyStr(context, value, "reason",
                    JS_NewString(context,
                        job->status == WGPUCreatePipelineAsyncStatus_ValidationError ? "validation"
                                                                                     : "internal"));
            }
        }
        if (job->callback_oom) {
            JS_FreeValue(context, value);
            JS_ThrowOutOfMemory(context);
            value = JS_GetException(context);
            success = false;
        }
        if (JS_IsException(value)) {
            value = JS_GetException(context);
            success = false;
        }
        if (!JS_IsException(value)) {
            JSValue result
                = JS_Call(context, success ? job->resolve : job->reject, JS_UNDEFINED, 1, &value);
            JS_FreeValue(context, result);
            JS_FreeValue(context, value);
        }
        ++count;
    }
    return JS_HasException(context) ? -1 : count;
}
int pu_webgpu_pump(JSContext* context)
{
    try {
        return pump_native(context);
    } catch (const std::bad_alloc&) {
        JS_ThrowOutOfMemory(context);
        return -1;
    }
}
void pu_webgpu_shutdown(JSContext* context)
{
    auto found = states.find(context);
    if (found == states.end())
        return;
    auto state = found->second;
    state->closed = true;
    for (auto& getter : state->data_view_getters) {
        JS_FreeValue(context, getter);
        getter = JS_UNDEFINED;
    }
    for (auto object : state->objects)
        detach(object);
    for (auto& device : state->devices) {
        if (device->native && !device->destroyed)
            state->api->DeviceDestroy(device->native);
        device->destroyed = true;
        device->object = nullptr;
    }
    // Cancels instance futures while all native callback userdata is still alive.
    if (state->instance)
        state->api->InstanceRelease(state->instance);
    state->instance = nullptr;
    state->canvas_readbacks.clear();
    state->mutation_checks.clear();
    state->jobs.clear();
    states.erase(found);
}
size_t pu_webgpu_live_readbacks(void)
{
    size_t count=0;
    for(const auto &entry:states)count+=entry.second->canvas_readbacks.size();
    return count;
}
JSValue pu_webgpu_factory(JSContext* context)
{
    auto state = std::make_shared<State>();
    state->context = context;
    state->runtime = JS_GetRuntime(context);
    {
        Value global(context, JS_GetGlobalObject(context));
        Value constructor(context, JS_GetPropertyStr(context, global, "DataView"));
        Value prototype(context, JS_GetPropertyStr(context, constructor, "prototype"));
        const char* names[] = { "buffer", "byteOffset", "byteLength" };
        for (unsigned i = 0; i < 3; ++i) {
            JSAtom atom = JS_NewAtom(context, names[i]);
            JSPropertyDescriptor descriptor = { };
            int found = JS_GetOwnProperty(context, &descriptor, prototype, atom);
            JS_FreeAtom(context, atom);
            if (found <= 0)
                return JS_ThrowInternalError(context, "Missing DataView intrinsic getter");
            state->data_view_getters[i] = descriptor.getter;
            JS_FreeValue(context, descriptor.setter);
            JS_FreeValue(context, descriptor.value);
        }
    }
    JSRuntime* runtime = JS_GetRuntime(context);
    if (!object_class)
        JS_NewClassID(runtime, &object_class);
    JSClassDef definition = { };
    definition.class_name = "WebGPUResource";
    definition.finalizer = finalizer;
    definition.gc_mark = mark;
    if (!JS_IsRegisteredClass(runtime, object_class)
        && JS_NewClass(runtime, object_class, &definition) < 0)
        return JS_EXCEPTION;
    states[context] = state;
    JSValue installer = JS_Eval(context, reinterpret_cast<const char*>(pu_webgpu_script),
        sizeof(pu_webgpu_script) - 1, "polly:webgpu", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(installer))
        return installer;
    JSValue function = JS_NewCFunction(context, native_safe, "webgpu", 3);
    JSValue result = JS_Call(context, installer, JS_UNDEFINED, 1, &function);
    JS_FreeValue(context, function);
    JS_FreeValue(context, installer);
    return result;
}
#endif
