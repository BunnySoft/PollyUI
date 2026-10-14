template <typename T>
static void shader_stage(
    Input& input, JSValueConst value, T& stage, const std::shared_ptr<Device>& device)
{
    auto module_value = input.required(value, "module");
    auto module = input.resource(module_value, Kind::Shader, device);
    if (module)
        stage.module = static_cast<WGPUShaderModule>(module->native);
    stage.entryPoint = input.string(value, "entryPoint");
    auto constants = input.field(value, "constants");
    if (JS_IsUndefined(constants))
        return;
    JSPropertyEnum* properties = nullptr;
    uint32_t count = 0;
    if (JS_GetOwnPropertyNames(
            input.context, &properties, &count, constants, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
        input.ok = false;
        return;
    }
    struct Atoms {
        JSContext* context;
        JSPropertyEnum* properties;
        uint32_t count;
        ~Atoms()
        {
            for (uint32_t i = 0; i < count; ++i)
                JS_FreeAtom(context, properties[i].atom);
            js_free(context, properties);
        }
    } atoms { input.context, properties, count };
    auto entries = input.allocate(count, WGPU_CONSTANT_ENTRY_INIT);
    for (uint32_t i = 0; i < count; ++i) {
        const char* name = JS_AtomToCString(input.context, properties[i].atom);
        if (!name) {
            input.ok = false;
            return;
        }
        input.strings.emplace_back(name);
        JS_FreeCString(input.context, name);
        entries[i].key = view(input.strings.back());
        Value constant(input.context, JS_GetProperty(input.context, constants, properties[i].atom));
        if (JS_ToFloat64(input.context, &entries[i].value, constant)
            || !std::isfinite(entries[i].value)) {
            input.ok = false;
            if (!JS_HasException(input.context))
                JS_ThrowTypeError(input.context, "Shader constants must be finite");
            return;
        }
    }
    stage.constants = entries;
    stage.constantCount = count;
}
static WGPUPipelineLayout pipeline_layout(
    Input& input, JSValueConst value, const std::shared_ptr<Device>& device)
{
    if (JS_IsString(value)) {
        const char* name = JS_ToCString(input.context, value);
        bool automatic = name && !std::strcmp(name, "auto");
        JS_FreeCString(input.context, name);
        if (!automatic) {
            input.ok = false;
            JS_ThrowTypeError(input.context, "Expected pipeline layout auto");
        }
        return nullptr;
    }
    auto layout = input.resource(value, Kind::PipelineLayout, device);
    return layout ? static_cast<WGPUPipelineLayout>(layout->native) : nullptr;
}
static WGPUBlendComponent blend_component(Input& input, JSValueConst value)
{
    WGPUBlendComponent result = WGPU_BLEND_COMPONENT_INIT;
    result.operation
        = input.enumeration(value, "operation", "BlendOperation", WGPUBlendOperation_Add);
    result.srcFactor = input.enumeration(value, "srcFactor", "BlendFactor", WGPUBlendFactor_One);
    result.dstFactor = input.enumeration(value, "dstFactor", "BlendFactor", WGPUBlendFactor_Zero);
    return result;
}
static WGPUStencilFaceState stencil_state(Input& input, JSValueConst value)
{
    WGPUStencilFaceState result = WGPU_STENCIL_FACE_STATE_INIT;
    if (JS_IsUndefined(value))
        return result;
    result.compare
        = input.enumeration(value, "compare", "CompareFunction", WGPUCompareFunction_Always);
    result.failOp
        = input.enumeration(value, "failOp", "StencilOperation", WGPUStencilOperation_Keep);
    result.depthFailOp
        = input.enumeration(value, "depthFailOp", "StencilOperation", WGPUStencilOperation_Keep);
    result.passOp
        = input.enumeration(value, "passOp", "StencilOperation", WGPUStencilOperation_Keep);
    return result;
}
static WGPUColor gpu_color(Input& input, JSValueConst value)
{
    WGPUColor result = WGPU_COLOR_INIT;
    if (JS_IsUndefined(value))
        return result;
    double* fields[] = { &result.r, &result.g, &result.b, &result.a };
    const char* names[] = { "r", "g", "b", "a" };
    if (JS_IsArray(value)) {
        auto length = input.field(value, "length");
        if (input.u32(length) != 4) {
            input.ok = false;
            JS_ThrowTypeError(input.context, "GPUColor requires four components");
            return result;
        }
    }
    for (unsigned i = 0; i < 4; ++i) {
        Value component(input.context,
            JS_IsArray(value) ? JS_GetPropertyUint32(input.context, value, i)
                              : JS_GetPropertyStr(input.context, value, names[i]));
        if (JS_ToFloat64(input.context, fields[i], component) || !std::isfinite(*fields[i])) {
            input.ok = false;
            if (!JS_HasException(input.context))
                JS_ThrowTypeError(input.context, "GPUColor components must be finite");
        }
    }
    return result;
}
static WGPUPassTimestampWrites *timestamp_writes(Input &input,JSValueConst value,const std::shared_ptr<Device> &device)
{
    if(JS_IsUndefined(value))return nullptr;
    auto result=input.allocate(1,WGPU_PASS_TIMESTAMP_WRITES_INIT);
    auto query_value=input.required(value,"querySet");auto query=input.resource(query_value,Kind::QuerySet,device);
    if(query)result->querySet=static_cast<WGPUQuerySet>(query->native);
    result->beginningOfPassWriteIndex=input.number32(value,"beginningOfPassWriteIndex",WGPU_QUERY_SET_INDEX_UNDEFINED);
    result->endOfPassWriteIndex=input.number32(value,"endOfPassWriteIndex",WGPU_QUERY_SET_INDEX_UNDEFINED);
    return result;
}
static WGPURenderPipelineDescriptor render_pipeline(
    Input& input, JSValueConst value, const std::shared_ptr<Device>& device)
{
    WGPURenderPipelineDescriptor result = WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    result.label = input.string(value, "label");
    auto layout = input.required(value, "layout");
    result.layout = pipeline_layout(input, layout, device);
    auto vertex = input.required(value, "vertex");
    shader_stage(input, vertex, result.vertex, device);
    auto buffers = input.field(vertex, "buffers");
    if (!JS_IsUndefined(buffers)) {
        auto length = input.field(buffers, "length");
        uint32_t count = input.u32(length);
        auto layouts = input.allocate(count, WGPU_VERTEX_BUFFER_LAYOUT_INIT);
        for (uint32_t i = 0; i < count && input.ok; ++i) {
            Value buffer(input.context, JS_GetPropertyUint32(input.context, buffers, i));
            if (JS_IsNull(buffer)) {
                layouts[i].stepMode = WGPUVertexStepMode_Vertex;
                continue;
            }
            layouts[i].arrayStride = input.required_number(buffer, "arrayStride");
            layouts[i].stepMode = input.enumeration(
                buffer, "stepMode", "VertexStepMode", WGPUVertexStepMode_Vertex);
            auto attributes = input.required(buffer, "attributes");
            auto size = input.field(attributes, "length");
            uint32_t n = input.u32(size);
            auto entries = input.allocate(n, WGPU_VERTEX_ATTRIBUTE_INIT);
            for (uint32_t j = 0; j < n && input.ok; ++j) {
                Value attribute(input.context, JS_GetPropertyUint32(input.context, attributes, j));
                auto format = input.required(attribute, "format");
                entries[j].format
                    = static_cast<WGPUVertexFormat>(input.enumeration(format, "VertexFormat"));
                entries[j].offset = input.required_number(attribute, "offset");
                entries[j].shaderLocation = input.required_number32(attribute, "shaderLocation");
            }
            layouts[i].attributes = entries;
            layouts[i].attributeCount = n;
        }
        result.vertex.buffers = layouts;
        result.vertex.bufferCount = count;
    }
    auto primitive = input.field(value, "primitive");
    if (!JS_IsUndefined(primitive)) {
        result.primitive.topology = input.enumeration(
            primitive, "topology", "PrimitiveTopology", WGPUPrimitiveTopology_TriangleList);
        result.primitive.stripIndexFormat = input.enumeration(
            primitive, "stripIndexFormat", "IndexFormat", WGPUIndexFormat_Undefined);
        result.primitive.frontFace
            = input.enumeration(primitive, "frontFace", "FrontFace", WGPUFrontFace_CCW);
        result.primitive.cullMode
            = input.enumeration(primitive, "cullMode", "CullMode", WGPUCullMode_None);
        result.primitive.unclippedDepth = input.boolean(primitive, "unclippedDepth");
    }
    auto multisample = input.field(value, "multisample");
    if (!JS_IsUndefined(multisample)) {
        result.multisample.count = input.number32(multisample, "count", 1);
        result.multisample.mask = input.number32(multisample, "mask", UINT32_MAX);
        result.multisample.alphaToCoverageEnabled
            = input.boolean(multisample, "alphaToCoverageEnabled");
    }
    auto depth = input.field(value, "depthStencil");
    if (!JS_IsUndefined(depth)) {
        auto state = input.allocate(1, WGPU_DEPTH_STENCIL_STATE_INIT);
        auto format = input.required(depth, "format");
        state->format = static_cast<WGPUTextureFormat>(input.enumeration(format, "TextureFormat"));
        auto write = input.field(depth, "depthWriteEnabled");
        state->depthWriteEnabled = JS_IsUndefined(write) ? WGPUOptionalBool_Undefined
            : JS_ToBool(input.context, write)            ? WGPUOptionalBool_True
                                                         : WGPUOptionalBool_False;
        state->depthCompare = input.enumeration(
            depth, "depthCompare", "CompareFunction", WGPUCompareFunction_Undefined);
        auto front = input.field(depth, "stencilFront"), back = input.field(depth, "stencilBack");
        state->stencilFront = stencil_state(input, front);
        state->stencilBack = stencil_state(input, back);
        state->stencilReadMask = input.number32(depth, "stencilReadMask", UINT32_MAX);
        state->stencilWriteMask = input.number32(depth, "stencilWriteMask", UINT32_MAX);
        auto bias = input.field(depth, "depthBias");
        if (!JS_IsUndefined(bias))state->depthBias=input.s32(bias);
        state->depthBiasSlopeScale = input.real(depth, "depthBiasSlopeScale");
        state->depthBiasClamp = input.real(depth, "depthBiasClamp");
        result.depthStencil = state;
    }
    auto fragment = input.field(value, "fragment");
    if (!JS_IsUndefined(fragment)) {
        auto state = input.allocate(1, WGPU_FRAGMENT_STATE_INIT);
        shader_stage(input, fragment, *state, device);
        auto targets = input.required(fragment, "targets");
        auto size = input.field(targets, "length");
        uint32_t n = input.u32(size);
        auto entries = input.allocate(n, WGPU_COLOR_TARGET_STATE_INIT);
        for (uint32_t i = 0; i < n && input.ok; ++i) {
            Value target(input.context, JS_GetPropertyUint32(input.context, targets, i));
            if (JS_IsNull(target))
                continue;
            auto format = input.required(target, "format");
            entries[i].format
                = static_cast<WGPUTextureFormat>(input.enumeration(format, "TextureFormat"));
            entries[i].writeMask = input.number32(target, "writeMask", WGPUColorWriteMask_All);
            auto blend = input.field(target, "blend");
            if (!JS_IsUndefined(blend)) {
                auto state = input.allocate(1, WGPU_BLEND_STATE_INIT);
                auto color = input.required(blend, "color"), alpha = input.required(blend, "alpha");
                state->color = blend_component(input, color);
                state->alpha = blend_component(input, alpha);
                entries[i].blend = state;
            }
        }
        state->targets = entries;
        state->targetCount = n;
        result.fragment = state;
    }
    return result;
}
static JSValue render_operation(Object* object, const std::string& op, Input& input,
    JSValueConst arguments, JSValueConst self, bool& handled)
{
    auto state = object->state;
    const auto& api = *state->api;
    JSContext* context = input.context;
    auto arg = [&](uint32_t index) -> Value {
        return { context, JS_GetPropertyUint32(context, arguments, index) };
    };
    auto descriptor = arg(0);
    handled = true;
    if (object->kind == Kind::Device
        && (op == "createRenderPipeline" || op == "createRenderPipelineAsync")) {
        auto native = render_pipeline(input, descriptor, object->device);
        if (!input.ok)
            return JS_EXCEPTION;
        if (op == "createRenderPipeline")
            return object_value(state, Kind::RenderPipeline,
                api.DeviceCreateRenderPipeline(static_cast<WGPUDevice>(object->native), &native),
                self, object->device);
        JSValue promise;
        Job* job = job_value(state, JobKind::RenderPipeline, self, object->device, promise);
        if (!job)
            return promise;
        WGPUCreateRenderPipelineAsyncCallbackInfo callback
            = WGPU_CREATE_RENDER_PIPELINE_ASYNC_CALLBACK_INFO_INIT;
        callback.mode = WGPUCallbackMode_AllowProcessEvents;
        callback.callback = render_pipeline_callback;
        callback.userdata1 = job;
        api.DeviceCreateRenderPipelineAsync(
            static_cast<WGPUDevice>(object->native), &native, callback);
        return promise;
    }
    if (object->kind == Kind::RenderPipeline && op == "getBindGroupLayout") {
        uint32_t index = input.u32(descriptor);
        if (!input.ok)
            return JS_EXCEPTION;
        return object_value(state, Kind::BindGroupLayout,
            api.RenderPipelineGetBindGroupLayout(
                static_cast<WGPURenderPipeline>(object->native), index),
            object->owner, object->device);
    }
    if (object->kind == Kind::Encoder && op == "beginRenderPass") {
        WGPURenderPassDescriptor native = WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        auto colors = input.required(descriptor, "colorAttachments"),
             length = input.field(colors, "length");
        uint32_t n = input.u32(length);
        auto entries = input.allocate(n, WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT);
        std::vector<CanvasWrite> writes;
        bool clear_mutation=false;
        bool invalid_transient=false;
        for (uint32_t i = 0; i < n && input.ok; ++i) {
            Value entry(context, JS_GetPropertyUint32(context, colors, i));
            if (JS_IsNull(entry))
                continue;
            auto view = input.required(entry, "view");
            Object *resource=nullptr;
            entries[i].view=texture_view(input,view,object->device,&resource);
            if(resource&&!resource->canvas_target.expired())writes.push_back({resource->canvas_target,resource->canvas_generation});
            auto resolve = input.field(entry, "resolveTarget");
            if (!JS_IsUndefined(resolve)) {
                Object *target=nullptr;
                entries[i].resolveTarget=texture_view(input,resolve,object->device,&target);
                if(target&&!target->canvas_target.expired())writes.push_back({target->canvas_target,target->canvas_generation});
                if(target&&target->transient_attachment)invalid_transient=true;
                clear_mutation=true;
            }
            entries[i].depthSlice = input.number32(entry, "depthSlice", WGPU_DEPTH_SLICE_UNDEFINED);
            auto load = input.required(entry, "loadOp"), store = input.required(entry, "storeOp");
            entries[i].loadOp = static_cast<WGPULoadOp>(input.enumeration(load, "LoadOp"));
            if(entries[i].loadOp==WGPULoadOp_Clear)clear_mutation=true;
            entries[i].storeOp = static_cast<WGPUStoreOp>(input.enumeration(store, "StoreOp"));
            if(resource&&resource->transient_attachment&&
                (entries[i].loadOp!=WGPULoadOp_Clear||entries[i].storeOp!=WGPUStoreOp_Discard))invalid_transient=true;
            auto clear = input.field(entry, "clearValue");
            entries[i].clearValue = gpu_color(input, clear);
        }
        native.colorAttachments = entries;
        native.colorAttachmentCount = n;
        auto timestamps=input.field(descriptor,"timestampWrites");
        native.timestampWrites=timestamp_writes(input,timestamps,object->device);
        auto occlusion=input.field(descriptor,"occlusionQuerySet");
        if(!JS_IsUndefined(occlusion)) {
            auto query=input.resource(occlusion,Kind::QuerySet,object->device);
            if(query)native.occlusionQuerySet=static_cast<WGPUQuerySet>(query->native);
        }
        auto depth = input.field(descriptor, "depthStencilAttachment");
        if (!JS_IsUndefined(depth)) {
            auto entry = input.allocate(1, WGPU_RENDER_PASS_DEPTH_STENCIL_ATTACHMENT_INIT);
            auto view = input.required(depth, "view");
            Object *resource=nullptr;
            entry->view=texture_view(input,view,object->device,&resource);
            entry->depthLoadOp
                = input.enumeration(depth, "depthLoadOp", "LoadOp", WGPULoadOp_Undefined);
            entry->depthStoreOp
                = input.enumeration(depth, "depthStoreOp", "StoreOp", WGPUStoreOp_Undefined);
            entry->depthClearValue
                = input.real(depth, "depthClearValue", WGPU_DEPTH_CLEAR_VALUE_UNDEFINED);
            entry->depthReadOnly = input.boolean(depth, "depthReadOnly");
            entry->stencilLoadOp
                = input.enumeration(depth, "stencilLoadOp", "LoadOp", WGPULoadOp_Undefined);
            entry->stencilStoreOp
                = input.enumeration(depth, "stencilStoreOp", "StoreOp", WGPUStoreOp_Undefined);
            entry->stencilClearValue = input.number32(depth, "stencilClearValue");
            entry->stencilReadOnly = input.boolean(depth, "stencilReadOnly");
            if(resource&&resource->transient_attachment){
                bool has_stencil=(resource->texture_format==WGPUTextureFormat_Stencil8||
                    resource->texture_format==WGPUTextureFormat_Depth24PlusStencil8||
                    resource->texture_format==WGPUTextureFormat_Depth32FloatStencil8)&&resource->texture_aspect!=WGPUTextureAspect_DepthOnly;
                bool has_depth=resource->texture_format!=WGPUTextureFormat_Stencil8&&resource->texture_aspect!=WGPUTextureAspect_StencilOnly;
                if((has_depth&&(entry->depthLoadOp!=WGPULoadOp_Clear||entry->depthStoreOp!=WGPUStoreOp_Discard))||
                    (has_stencil&&(entry->stencilLoadOp!=WGPULoadOp_Clear||entry->stencilStoreOp!=WGPUStoreOp_Discard)))invalid_transient=true;
            }
            native.depthStencilAttachment = entry;
        }
        if (!input.ok)
            return JS_EXCEPTION;
        if(invalid_transient)api.CommandEncoderInjectValidationError(static_cast<WGPUCommandEncoder>(object->native),
            view("Transient render attachments require clear/discard and cannot be resolve destinations"));
        JSValue value=object_value(state, Kind::RenderPass,
            api.CommandEncoderBeginRenderPass(
                static_cast<WGPUCommandEncoder>(object->native), &native),
            self, object->device);
        if(!JS_IsException(value)) {
            auto pass=static_cast<Object*>(JS_GetOpaque(value,object_class));
            pass->canvas_writes=std::move(writes);pass->has_canvas_mutation=clear_mutation;
        }
        return value;
    }
    if (object->kind == Kind::RenderPass) {
        auto pass = static_cast<WGPURenderPassEncoder>(object->native);
        if(op=="beginOcclusionQuery") {uint32_t index=input.u32(descriptor);if(!input.ok)return JS_EXCEPTION;api.RenderPassEncoderBeginOcclusionQuery(pass,index);return JS_UNDEFINED;}
        if(op=="endOcclusionQuery") {api.RenderPassEncoderEndOcclusionQuery(pass);return JS_UNDEFINED;}
        if (op == "end") {
            api.RenderPassEncoderEnd(pass);
            object->finished = true;
            auto encoder=static_cast<Object*>(JS_GetOpaque(object->owner,object_class));
            if(encoder&&object->has_canvas_mutation)
                encoder->canvas_writes.insert(encoder->canvas_writes.end(),object->canvas_writes.begin(),object->canvas_writes.end());
            return JS_UNDEFINED;
        }
        if (op == "setPipeline") {
            auto pipeline = input.resource(descriptor, Kind::RenderPipeline, object->device);
            if (!pipeline)
                return JS_EXCEPTION;
            api.RenderPassEncoderSetPipeline(
                pass, static_cast<WGPURenderPipeline>(pipeline->native));
            return JS_UNDEFINED;
        }
        if (op == "setBindGroup") {
            auto group_value = arg(1), offsets_value = arg(2),
                 length = input.field(offsets_value, "length");
            auto group = JS_IsNull(group_value)
                ? nullptr
                : input.resource(group_value, Kind::BindGroup, object->device);
            uint32_t index = input.u32(descriptor), n = input.u32(length);
            auto offsets = input.allocate(n, uint32_t { 0 });
            for (uint32_t i = 0; i < n && input.ok; ++i) {
                Value value(context, JS_GetPropertyUint32(context, offsets_value, i));
                offsets[i] = input.u32(value);
            }
            if (!input.ok)
                return JS_EXCEPTION;
            api.RenderPassEncoderSetBindGroup(pass, index,
                group ? static_cast<WGPUBindGroup>(group->native) : nullptr, n, offsets);
            return JS_UNDEFINED;
        }
        if (op == "setVertexBuffer" || op == "setIndexBuffer") {
            auto buffer_value = op == "setVertexBuffer" ? arg(1) : arg(0);
            auto buffer = JS_IsNull(buffer_value)
                ? nullptr
                : input.resource(buffer_value, Kind::Buffer, object->device);
            auto offset_value = arg(2), size_value = arg(3);
            uint64_t offset = input.integer(offset_value),
                     size = input.integer(size_value, WGPU_WHOLE_SIZE);
            if (op == "setVertexBuffer") {
                uint32_t slot = input.u32(descriptor);
                if (!input.ok)
                    return JS_EXCEPTION;
                api.RenderPassEncoderSetVertexBuffer(pass, slot,
                    buffer ? static_cast<WGPUBuffer>(buffer->native) : nullptr, offset, size);
            } else {
                auto format_value = arg(1);
                auto format
                    = static_cast<WGPUIndexFormat>(input.enumeration(format_value, "IndexFormat"));
                if (!input.ok)
                    return JS_EXCEPTION;
                api.RenderPassEncoderSetIndexBuffer(pass,
                    buffer ? static_cast<WGPUBuffer>(buffer->native) : nullptr, format, offset,
                    size);
            }
            return JS_UNDEFINED;
        }
        if (op == "draw") {
            auto instances = arg(1), first = arg(2), instance = arg(3);
            uint32_t count = input.u32(descriptor), n = input.u32(instances, 1),
                     v = input.u32(first), i = input.u32(instance);
            if (!input.ok)
                return JS_EXCEPTION;
            api.RenderPassEncoderDraw(pass, count, n, v, i);
            if(count&&n)object->has_canvas_mutation=true;
            return JS_UNDEFINED;
        }
        if (op == "drawIndexed") {
            auto instances = arg(1), first = arg(2), base = arg(3), instance = arg(4);
            uint32_t count = input.u32(descriptor), n = input.u32(instances, 1),
                     f = input.u32(first), i = input.u32(instance);
            int32_t b=input.s32(base);
            if (!input.ok)
                return JS_EXCEPTION;
            api.RenderPassEncoderDrawIndexed(pass, count, n, f, b, i);
            if(count&&n)object->has_canvas_mutation=true;
            return JS_UNDEFINED;
        }
        if (op == "drawIndirect" || op == "drawIndexedIndirect") {
            auto buffer = input.resource(descriptor, Kind::Buffer, object->device);
            auto offset_value = arg(1);
            uint64_t offset = input.integer(offset_value);
            if (!input.ok)
                return JS_EXCEPTION;
            if (op == "drawIndirect")
                api.RenderPassEncoderDrawIndirect(
                    pass, static_cast<WGPUBuffer>(buffer->native), offset);
            else
                api.RenderPassEncoderDrawIndexedIndirect(
                    pass, static_cast<WGPUBuffer>(buffer->native), offset);
            object->has_canvas_mutation=true;
            return JS_UNDEFINED;
        }
        if (op == "setViewport") {
            float values[6];
            for (unsigned i = 0; i < 6; ++i) {
                Value v = arg(i);
                values[i]=input.float_value(v);
            }
            if (!input.ok)
                return JS_ThrowTypeError(context, "Viewport values must be finite");
            api.RenderPassEncoderSetViewport(
                pass, values[0], values[1], values[2], values[3], values[4], values[5]);
            return JS_UNDEFINED;
        }
        if (op == "setScissorRect") {
            auto yv = arg(1), wv = arg(2), hv = arg(3);
            uint32_t x = input.u32(descriptor), y = input.u32(yv), w = input.u32(wv),
                     h = input.u32(hv);
            if (!input.ok)
                return JS_EXCEPTION;
            api.RenderPassEncoderSetScissorRect(pass, x, y, w, h);
            return JS_UNDEFINED;
        }
        if (op == "setBlendConstant") {
            if(JS_IsUndefined(descriptor))return JS_ThrowTypeError(context,"GPUColor argument is required");
            auto color = gpu_color(input, descriptor);
            if (!input.ok)
                return JS_EXCEPTION;
            api.RenderPassEncoderSetBlendConstant(pass, &color);
            return JS_UNDEFINED;
        }
        if (op == "setStencilReference") {
            uint32_t n = input.u32(descriptor);
            if (!input.ok)
                return JS_EXCEPTION;
            api.RenderPassEncoderSetStencilReference(pass, n);
            return JS_UNDEFINED;
        }
    }
    handled = false;
    return JS_UNDEFINED;
}
