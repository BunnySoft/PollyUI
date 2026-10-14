struct CanvasSource {
    std::shared_ptr<State> state;
    std::shared_ptr<Device> device;
    WGPUDevice native_device = nullptr;
    WGPUTexture texture = nullptr;
    PuCanvas* canvas = nullptr;
    PuNode* node = nullptr;
    int width = 0, height = 0;
    WGPUTextureFormat format = WGPUTextureFormat_BGRA8Unorm;
    WGPUTextureUsage usage = WGPUTextureUsage_RenderAttachment;
    std::vector<WGPUTextureFormat> view_formats;
    uint64_t revision = 1, generation = 1;
    bool attached = false, premultiplied = false, display_p3 = false;
    ~CanvasSource()
    {
        if (texture) {
            state->api->TextureDestroy(texture);
            state->api->TextureRelease(texture);
        }
        if (native_device)
            state->api->DeviceRelease(native_device);
    }
    void expire()
    {
        if (texture) {
            state->api->TextureDestroy(texture);
            state->api->TextureRelease(texture);
            texture = nullptr;
        }
        ++generation;
    }
};
static int source_resize(void* userdata, int width, int height)
{
    auto& source = **static_cast<std::shared_ptr<CanvasSource>*>(userdata);
    WGPULimits limits = WGPU_LIMITS_INIT;
    if (source.state->closed || source.device->destroyed
        || source.state->api->DeviceGetLimits(source.native_device, &limits) != WGPUStatus_Success
        || width < 0 || height < 0 || static_cast<uint32_t>(width) > limits.maxTextureDimension2D
        || static_cast<uint32_t>(height) > limits.maxTextureDimension2D||
        ((source.format==WGPUTextureFormat_RGBA16Float||source.display_p3)&&
            (uint64_t)width*height>PU_IMAGE_BYTE_LIMIT/8))
        return 0;
    source.expire();
    source.width = width;
    source.height = height;
    ++source.revision;
    return 1;
}
static uint64_t source_revision(void* userdata)
{
    return (*static_cast<std::shared_ptr<CanvasSource>*>(userdata))->revision;
}
static void source_present(void* userdata)
{
    (*static_cast<std::shared_ptr<CanvasSource>*>(userdata))->expire();
}
static void source_release(void* userdata)
{
    auto holder = static_cast<std::shared_ptr<CanvasSource>*>(userdata);
    (*holder)->attached = false;
    (*holder)->canvas = nullptr;
    (*holder)->node = nullptr;
    (*holder)->expire();
    delete holder;
}
static WGPUTexture source_texture(CanvasSource& source)
{
    if (source.texture)
        return source.texture;
    if (!source.width || !source.height || source.state->closed || source.device->destroyed)
        return nullptr;
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.size
        = { static_cast<uint32_t>(source.width), static_cast<uint32_t>(source.height), 1 };
    descriptor.dimension = WGPUTextureDimension_2D;
    descriptor.format = source.format;
    descriptor.usage = source.usage;
    WGPUDawnTextureInternalUsageDescriptor internal
        = WGPU_DAWN_TEXTURE_INTERNAL_USAGE_DESCRIPTOR_INIT;
    internal.internalUsage = WGPUTextureUsage_CopySrc;
    descriptor.nextInChain = &internal.chain;
    descriptor.viewFormats = source.view_formats.data();
    descriptor.viewFormatCount = source.view_formats.size();
    source.texture = source.state->api->DeviceCreateTexture(source.native_device, &descriptor);
    return source.texture;
}
static void canvas_map_callback(WGPUMapAsyncStatus status, WGPUStringView, void* userdata, void*)
{
    auto readback = static_cast<CanvasReadback*>(userdata);
    readback->status.store(status);
    readback->done.store(true, std::memory_order_release);
}
static int source_read_impl(void* userdata, uint8_t* pixels, size_t length,bool linear=false)
{
    auto& source = **static_cast<std::shared_ptr<CanvasSource>*>(userdata);
    auto state = source.state;
    if (state->closed || source.device->destroyed
        || length != (size_t)source.width * source.height * (linear?8:4) || length > PU_IMAGE_BYTE_LIMIT
        || !length)
        return 0;
    WGPUTexture texture = source_texture(source);
    if (!texture)
        return 0;
    const auto& api = *state->api;
    size_t pixel_size = source.format == WGPUTextureFormat_RGBA16Float ? 8 : 4;
    size_t row = ((size_t)source.width * pixel_size + 255) & ~size_t(255);
    size_t bytes = row * source.height;
    auto readback = std::make_unique<CanvasReadback>();
    readback->api = state->api;
    WGPUBufferDescriptor buffer_descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    buffer_descriptor.size = bytes;
    buffer_descriptor.usage = WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
    readback->buffer = api.DeviceCreateBuffer(source.native_device, &buffer_descriptor);
    if (!readback->buffer)
        return 0;
    WGPUCommandEncoderDescriptor encoder_descriptor = WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    WGPUDawnEncoderInternalUsageDescriptor internal
        = WGPU_DAWN_ENCODER_INTERNAL_USAGE_DESCRIPTOR_INIT;
    internal.useInternalUsages = true;
    encoder_descriptor.nextInChain = &internal.chain;
    WGPUCommandEncoder encoder
        = api.DeviceCreateCommandEncoder(source.native_device, &encoder_descriptor);
    if (!encoder)
        return 0;
    WGPUTexelCopyTextureInfo src = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    src.texture = texture;
    src.aspect = WGPUTextureAspect_All;
    WGPUTexelCopyBufferInfo dst = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    dst.buffer = readback->buffer;
    dst.layout.bytesPerRow = static_cast<uint32_t>(row);
    WGPUExtent3D extent
        = { static_cast<uint32_t>(source.width), static_cast<uint32_t>(source.height), 1 };
    api.CommandEncoderCopyTextureToBuffer(encoder, &src, &dst, &extent);
    WGPUCommandBufferDescriptor command_descriptor = WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
    WGPUCommandBuffer command = api.CommandEncoderFinish(encoder, &command_descriptor);
    api.CommandEncoderRelease(encoder);
    if (!command)
        return 0;
    WGPUQueue queue = api.DeviceGetQueue(source.native_device);
    api.QueueSubmit(queue, 1, &command);
    api.QueueRelease(queue);
    api.CommandBufferRelease(command);
    state->canvas_readbacks.reserve(state->canvas_readbacks.size() + 1);
    auto pending = readback.get();
    state->canvas_readbacks.push_back(std::move(readback));
    struct ReadbackGuard {
        std::shared_ptr<State> state;
        CanvasReadback *record;
        ~ReadbackGuard(){
            if(record->done.load(std::memory_order_acquire))
                state->canvas_readbacks.erase(std::remove_if(state->canvas_readbacks.begin(),state->canvas_readbacks.end(),
                    [this](const auto &value){return value.get()==record;}),state->canvas_readbacks.end());
        }
    } guard{state,pending};
    WGPUBufferMapCallbackInfo callback = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    callback.mode = WGPUCallbackMode_WaitAnyOnly;
    callback.callback = canvas_map_callback;
    callback.userdata1 = pending;
    pending->future = api.BufferMapAsync(pending->buffer, WGPUMapMode_Read, 0, bytes, callback);
    WGPUFutureWaitInfo wait = WGPU_FUTURE_WAIT_INFO_INIT;
    wait.future = pending->future;
    WGPUWaitStatus result = api.InstanceWaitAny(state->instance, 1, &wait, UINT64_C(10000000000));
    if (result != WGPUWaitStatus_Success || !pending->done.load(std::memory_order_acquire)
        || pending->status.load() != WGPUMapAsyncStatus_Success) {
        std::fprintf(stderr, "[webgpu] canvas readback failed wait=%d map=%d\n", result,
            pending->status.load());
        return 0;
    }
    const void* mapped = api.BufferGetConstMappedRange(pending->buffer, 0, bytes);
    if (!mapped)
        return 0;
    auto space = source.display_p3
        ? SkColorSpace::MakeRGB(SkNamedTransferFn::kSRGB, SkNamedGamut::kDisplayP3)
        : SkColorSpace::MakeSRGB();
    SkColorType type = source.format == WGPUTextureFormat_BGRA8Unorm ? kBGRA_8888_SkColorType
        : source.format == WGPUTextureFormat_RGBA16Float             ? kRGBA_F16_SkColorType
                                                                     : kRGBA_8888_SkColorType;
    auto info = SkImageInfo::Make(source.width, source.height, type,
        source.premultiplied ? kPremul_SkAlphaType : kOpaque_SkAlphaType, space);
    auto target = SkImageInfo::Make(source.width, source.height, linear?kRGBA_F16_SkColorType:kRGBA_8888_SkColorType,
        kUnpremul_SkAlphaType, linear?SkColorSpace::MakeSRGBLinear():SkColorSpace::MakeSRGB());
    bool converted
        = SkPixmap(info, mapped, row).readPixels(target, pixels, (size_t)source.width * (linear?8:4));
    api.BufferUnmap(pending->buffer);
    return converted;
}
static int source_read(void* userdata, uint8_t* pixels, size_t length)
{
    try {
        return source_read_impl(userdata, pixels, length);
    } catch (const std::bad_alloc&) {
        std::fprintf(stderr, "[webgpu] canvas readback allocation failed\n");
        return 0;
    }
}
static int source_read_f16(void* userdata,uint8_t* pixels,size_t length)
{
    try{return source_read_impl(userdata,pixels,length,true);}
    catch(const std::bad_alloc&){std::fprintf(stderr,"[webgpu] float canvas readback allocation failed\n");return 0;}
}
static const PuCanvasGpuSourceOps source_ops
    = { source_resize, source_read, source_revision, source_present, source_release, nullptr };
static void publish_write(const CanvasWrite &write)
{
    auto source=write.source.lock();
    if(source&&source->attached&&source->texture&&!source->device->destroyed&&
        write.generation==source->generation) {
        ++source->revision;
        if(source->node)pu_node_mark_paint_dirty(source->node);
    }
}
static void record_canvas_write(Object *encoder,Object *texture)
{
    if(!texture->canvas_target.expired())
        encoder->canvas_writes.push_back({texture->canvas_target,texture->canvas_generation});
}
static void publish_canvas_write(Object *texture)
{
    publish_write({texture->canvas_target,texture->canvas_generation});
}
static void publish_canvas_commands(Object *command)
{
    for(const auto &write:command->canvas_writes)publish_write(write);
}
static void canvas_context_release(Object* object)
{
    auto holder = static_cast<std::shared_ptr<CanvasSource>*>(object->native);
    if ((*holder)->attached)
        pu_canvas_set_gpu_source((*holder)->canvas, nullptr, nullptr);
    delete holder;
}
static JSValue canvas_operation(Object* object, const std::string& op, Input& input,
    JSValueConst arguments, JSValueConst self, bool& handled)
{
    handled = true;
    JSContext* context = input.context;
    auto arg = [&](uint32_t i) -> Value {
        return { context, JS_GetPropertyUint32(context, arguments, i) };
    };
    if (object->kind == Kind::Device && op == "canvasConfigure") {
        auto element = arg(0), descriptor = arg(1);
        PuNode* node = pu_bridge_node(element);
        if (!node || !node->tag || std::strcmp(node->tag, "canvas"))
            return JS_ThrowTypeError(context, "Expected owned HTML canvas");
        if (!node->canvas)
            node->canvas = pu_canvas_create(300, 150);
        if (!node->canvas)
            return JS_ThrowOutOfMemory(context);
        auto source = std::make_shared<CanvasSource>();
        source->state = object->state;
        source->device = object->device;
        source->native_device = static_cast<WGPUDevice>(object->native);
        source->state->api->DeviceAddRef(source->native_device);
        auto format = input.required(descriptor, "format");
        source->format = static_cast<WGPUTextureFormat>(input.enumeration(format, "TextureFormat"));
        if (source->format != WGPUTextureFormat_BGRA8Unorm
            && source->format != WGPUTextureFormat_RGBA8Unorm
            && source->format != WGPUTextureFormat_RGBA16Float)
            return JS_ThrowTypeError(context, "Invalid canvas texture format");
        source->usage = input.number32(descriptor, "usage", WGPUTextureUsage_RenderAttachment);
        if(source->usage&WGPUTextureUsage_TransientAttachment)
            return JS_ThrowTypeError(context,"Canvas usage cannot include TRANSIENT_ATTACHMENT");
        auto alpha = input.field(descriptor, "alphaMode");
        if (!JS_IsUndefined(alpha)) {
            const char* mode = JS_ToCString(context, alpha);
            if (!mode)
                return JS_EXCEPTION;
            bool valid = !std::strcmp(mode, "opaque") || !std::strcmp(mode, "premultiplied");
            source->premultiplied = !std::strcmp(mode, "premultiplied");
            JS_FreeCString(context, mode);
            if (!valid)
                return JS_ThrowTypeError(context, "Invalid canvas alphaMode");
        }
        auto color = input.field(descriptor, "colorSpace");
        if (!JS_IsUndefined(color)) {
            const char* space = JS_ToCString(context, color);
            if (!space)
                return JS_EXCEPTION;
            bool valid = !std::strcmp(space, "srgb") || !std::strcmp(space, "display-p3");
            source->display_p3 = !std::strcmp(space, "display-p3");
            JS_FreeCString(context, space);
            if (!valid)
                return JS_ThrowTypeError(context, "Invalid canvas colorSpace");
        }
        auto formats = input.field(descriptor, "viewFormats");
        if (!JS_IsUndefined(formats)) {
            auto length = input.field(formats, "length");
            uint32_t n = input.u32(length);
            for (uint32_t i = 0; i < n && input.ok; ++i) {
                Value value(context, JS_GetPropertyUint32(context, formats, i));
                source->view_formats.push_back(
                    static_cast<WGPUTextureFormat>(input.enumeration(value, "TextureFormat")));
            }
        }
        if (!input.ok)
            return JS_EXCEPTION;
        WGPUTextureDescriptor validation=WGPU_TEXTURE_DESCRIPTOR_INIT;
        validation.size={1,1,1};validation.dimension=WGPUTextureDimension_2D;
        validation.format=source->format;validation.usage=source->usage;
        validation.viewFormats=source->view_formats.data();validation.viewFormatCount=source->view_formats.size();
        auto validation_texture=source->state->api->DeviceCreateTexture(source->native_device,&validation);
        if(!validation_texture)return JS_ThrowInternalError(context,"Cannot validate native canvas configuration");
        source->state->api->TextureRelease(validation_texture);
        auto holder = std::make_unique<std::shared_ptr<CanvasSource>>(source);
        auto ops=source_ops;
        if(source->format==WGPUTextureFormat_RGBA16Float||source->display_p3)ops.read_f16=source_read_f16;
        if (!pu_canvas_set_gpu_source(node->canvas, &ops, holder.get()))
            return JS_ThrowInternalError(context, "Cannot attach native WebGPU canvas source");
        holder.release();
        source->attached = true;
        source->canvas = node->canvas;
        source->node = node;
        object->state->canvas_sources.push_back(source);
        auto resource = new std::shared_ptr<CanvasSource>(source);
        JSValue value
            = object_value(object->state, Kind::CanvasContext, resource, element, object->device);
        if (!JS_IsException(value)) {
            auto wrapped = static_cast<Object*>(JS_GetOpaque(value, object_class));
            wrapped->dependency = JS_DupValue(context, self);
        }
        pu_node_mark_paint_dirty(node);
        return value;
    }
    if (object->kind == Kind::CanvasContext) {
        auto source = *static_cast<std::shared_ptr<CanvasSource>*>(object->native);
        if (op == "canvasUnconfigure") {
            if (source->attached)
                pu_canvas_set_gpu_source(source->canvas, nullptr, nullptr);
            return JS_UNDEFINED;
        }
        if (op == "canvasGeneration")
            return JS_NewFloat64(context, static_cast<double>(source->generation));
        if (op == "canvasCurrentTexture") {
            if (!source->attached || source->state->closed || source->device->destroyed)
                return operation_error(context, "WebGPU canvas is unconfigured, closed or lost");
            WGPUTexture texture = source_texture(*source);
            if (!texture)
                return operation_error(context, "WebGPU canvas has no nonzero drawing buffer");
            source->state->api->TextureAddRef(texture);
            JSValue value=object_value(object->state, Kind::Texture, texture, self, source->device);
            if(!JS_IsException(value)) {
                auto texture_object=static_cast<Object*>(JS_GetOpaque(value,object_class));
                texture_object->canvas_target=source;texture_object->canvas_generation=source->generation;
            }
            return value;
        }
    }
    handled = false;
    return JS_UNDEFINED;
}
