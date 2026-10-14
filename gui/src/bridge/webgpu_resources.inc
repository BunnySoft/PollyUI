static const char* enum_name(const char* group, uint32_t value)
{
#define PU_GPU_ENUM(type, name, native)                                                            \
    if (!std::strcmp(group, #type) && value == static_cast<uint32_t>(native))                      \
        return name;
#include "webgpu-tables.inc"
#undef PU_GPU_ENUM
    return nullptr;
}
struct ColorConversion {
    float source_transfer[7], destination_transfer[7], gamut[9];
    explicit ColorConversion(bool display_p3,bool linear=false) {
        auto source=linear?SkColorSpace::MakeSRGBLinear():SkColorSpace::MakeSRGB();
        auto destination=display_p3?SkColorSpace::MakeRGB(SkNamedTransferFn::kSRGB,SkNamedGamut::kDisplayP3):SkColorSpace::MakeSRGB();
        skcms_TransferFunction src,dst;skcms_Matrix3x3 matrix;
        source->transferFn(&src);destination->invTransferFn(&dst);source->gamutTransformTo(destination.get(),&matrix);
        const float s[]={src.g,src.a,src.b,src.c,src.d,src.e,src.f};
        const float d[]={dst.g,dst.a,dst.b,dst.c,dst.d,dst.e,dst.f};
        std::copy(s,s+7,source_transfer);std::copy(d,d+7,destination_transfer);
        for(int row=0;row<3;++row)for(int column=0;column<3;++column)
            gamut[column*3+row]=matrix.vals[row][column];
    }
};
struct UploadedImage {
    const PuDawnApi &api;
    WGPUTexture texture=nullptr;
    bool linear=false;
    uint32_t width=0,height=0;
    explicit UploadedImage(const PuDawnApi &value):api(value){}
    ~UploadedImage(){if(texture)api.TextureRelease(texture);}
};
static bool upload_image(JSContext *context,UploadedImage &image,WGPUDevice device,WGPUQueue queue,
    PuCanvasResource *resource,uint32_t x,uint32_t y,uint32_t width,uint32_t height,bool flip)
{
    int source_width,source_height,linear;
    if(!pu_canvas_resource_info(resource,&source_width,&source_height,&linear)||
        static_cast<uint64_t>(x)+width>static_cast<uint32_t>(source_width)||
        static_cast<uint64_t>(y)+height>static_cast<uint32_t>(source_height)){
        JS_ThrowRangeError(context,"Owned image snapshot copy exceeds source bounds");return false;
    }
    image.width=width;image.height=height;image.linear=linear!=0;
    WGPUTextureDescriptor descriptor=WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.size={std::max(1u,width),std::max(1u,height),1};
    descriptor.dimension=WGPUTextureDimension_2D;
    descriptor.format=image.linear?WGPUTextureFormat_RGBA16Float:WGPUTextureFormat_RGBA8Unorm;
    descriptor.usage=WGPUTextureUsage_CopySrc|WGPUTextureUsage_CopyDst|WGPUTextureUsage_TextureBinding;
    image.texture=image.api.DeviceCreateTexture(device,&descriptor);
    if(!image.texture){JS_ThrowInternalError(context,"Cannot allocate owned image upload texture");return false;}
    size_t row_size=(size_t)width*(image.linear?8:4);
    if(row_size>PU_IMAGE_BYTE_LIMIT){JS_ThrowRangeError(context,"Owned image row exceeds byte budget");return false;}
    if(!width||!height)return true;
    std::vector<uint8_t> row(row_size);
    WGPUTexelCopyTextureInfo destination=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;destination.texture=image.texture;
    WGPUTexelCopyBufferLayout layout=WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;layout.bytesPerRow=static_cast<uint32_t>(row_size);
    WGPUExtent3D extent={width,1,1};
    for(uint32_t i=0;i<height;++i) {
        uint32_t source_y=flip?y+height-1-i:y+i;
        if(!pu_canvas_resource_read_row(resource,x,source_y,width,image.linear,row.data(),row.size())){
            JS_ThrowInternalError(context,"Cannot read actual owned image pixels");return false;
        }
        destination.origin.y=i;image.api.QueueWriteTexture(queue,&destination,row.data(),row.size(),&layout,&extent);
    }
    return true;
}
static WGPUExtent3D extent(Input& input, JSValueConst value)
{
    WGPUExtent3D result = { 0, 1, 1 };
    if (JS_IsArray(value)) {
        auto length = input.field(value, "length");
        uint32_t count = input.u32(length);
        if (!count || count > 3) {
            input.ok = false;
            JS_ThrowTypeError(input.context, "GPU extent requires one to three components");
            return result;
        }
        uint32_t* components[] = { &result.width, &result.height, &result.depthOrArrayLayers };
        for (uint32_t i = 0; i < count; ++i) {
            Value component(input.context, JS_GetPropertyUint32(input.context, value, i));
            *components[i] = input.u32(component);
        }
    } else {
        auto width = input.required(value, "width");
        result.width = input.u32(width);
        result.height = input.number32(value, "height", 1);
        result.depthOrArrayLayers = input.number32(value, "depthOrArrayLayers", 1);
    }
    return result;
}
static WGPUOrigin3D origin(Input& input, JSValueConst value)
{
    WGPUOrigin3D result = WGPU_ORIGIN_3D_INIT;
    if (JS_IsUndefined(value))
        return result;
    if (JS_IsArray(value)) {
        auto length = input.field(value, "length");
        uint32_t count = input.u32(length);
        if (count > 3) {
            input.ok = false;
            JS_ThrowTypeError(input.context, "GPU origin requires at most three components");
            return result;
        }
        uint32_t* components[] = { &result.x, &result.y, &result.z };
        for (uint32_t i = 0; i < count; ++i) {
            Value component(input.context, JS_GetPropertyUint32(input.context, value, i));
            *components[i] = input.u32(component);
        }
    } else {
        result.x = input.number32(value, "x");
        result.y = input.number32(value, "y");
        result.z = input.number32(value, "z");
    }
    return result;
}
static WGPUTexelCopyBufferLayout texel_layout(Input& input, JSValueConst value)
{
    WGPUTexelCopyBufferLayout result = WGPU_TEXEL_COPY_BUFFER_LAYOUT_INIT;
    result.offset = input.number(value, "offset");
    result.bytesPerRow = input.number32(value, "bytesPerRow", WGPU_COPY_STRIDE_UNDEFINED);
    result.rowsPerImage = input.number32(value, "rowsPerImage", WGPU_COPY_STRIDE_UNDEFINED);
    return result;
}
static WGPUTexelCopyTextureInfo texture_copy(
    Input& input, JSValueConst value, const std::shared_ptr<Device>& device, Object **target=nullptr)
{
    WGPUTexelCopyTextureInfo result = WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
    auto texture_value = input.required(value, "texture");
    auto texture = input.resource(texture_value, Kind::Texture, device);
    if(target)*target=texture;
    if (texture)
        result.texture = static_cast<WGPUTexture>(texture->native);
    result.mipLevel = input.number32(value, "mipLevel");
    auto origin_value = input.field(value, "origin");
    result.origin = origin(input, origin_value);
    result.aspect = input.enumeration(value, "aspect", "TextureAspect", WGPUTextureAspect_All);
    return result;
}
static WGPUTexelCopyBufferInfo buffer_copy(
    Input& input, JSValueConst value, const std::shared_ptr<Device>& device)
{
    WGPUTexelCopyBufferInfo result = WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
    result.layout = texel_layout(input, value);
    auto buffer_value = input.required(value, "buffer");
    auto buffer = input.resource(buffer_value, Kind::Buffer, device);
    if (buffer)
        result.buffer = static_cast<WGPUBuffer>(buffer->native);
    return result;
}
static JSValue resource_operation(Object* object, const std::string& op, Input& input,
    JSValueConst arguments, JSValueConst self, bool& handled)
{
    JSContext* context = input.context;
    const auto& api = *object->state->api;
    auto argument = [&](uint32_t index) -> Value {
        return { context, JS_GetPropertyUint32(context, arguments, index) };
    };
    auto descriptor = argument(0);
    handled = true;
    if(object->kind==Kind::Device&&op=="createQuerySet") {
        WGPUQuerySetDescriptor native=WGPU_QUERY_SET_DESCRIPTOR_INIT;
        native.label=input.string(descriptor,"label");
        auto type=input.required(descriptor,"type"),count=input.required(descriptor,"count");
        native.type=static_cast<WGPUQueryType>(input.enumeration(type,"QueryType"));native.count=input.u32(count);
        if(!input.ok)return JS_EXCEPTION;
        return object_value(object->state,Kind::QuerySet,
            api.DeviceCreateQuerySet(static_cast<WGPUDevice>(object->native),&native),self,object->device);
    }
    if(object->kind==Kind::QuerySet&&op=="queryInfo") {
        auto query=static_cast<WGPUQuerySet>(object->native);JSValue result=JS_NewObject(context);
        const char *type=enum_name("QueryType",api.QuerySetGetType(query));
        if(!type){JS_FreeValue(context,result);return JS_ThrowInternalError(context,"Unknown native query type");}
        JS_SetPropertyStr(context,result,"type",JS_NewString(context,type));
        JS_SetPropertyStr(context,result,"count",JS_NewUint32(context,api.QuerySetGetCount(query)));
        return result;
    }
    if(object->kind==Kind::Encoder&&op=="clearBuffer") {
        auto buffer=input.resource(descriptor,Kind::Buffer,object->device);auto offset_value=argument(1),size_value=argument(2);
        uint64_t offset=input.integer(offset_value),size=input.integer(size_value,WGPU_WHOLE_SIZE);
        if(!input.ok)return JS_EXCEPTION;
        api.CommandEncoderClearBuffer(static_cast<WGPUCommandEncoder>(object->native),static_cast<WGPUBuffer>(buffer->native),offset,size);
        return JS_UNDEFINED;
    }
    if(object->kind==Kind::Encoder&&op=="resolveQuerySet") {
        auto query=input.resource(descriptor,Kind::QuerySet,object->device);
        auto first_value=argument(1),count_value=argument(2),buffer_value=argument(3),offset_value=argument(4);
        auto buffer=input.resource(buffer_value,Kind::Buffer,object->device);
        uint32_t first=input.u32(first_value),count=input.u32(count_value);uint64_t offset=input.integer(offset_value);
        if(!input.ok)return JS_EXCEPTION;
        api.CommandEncoderResolveQuerySet(static_cast<WGPUCommandEncoder>(object->native),static_cast<WGPUQuerySet>(query->native),
            first,count,static_cast<WGPUBuffer>(buffer->native),offset);
        return JS_UNDEFINED;
    }
    if (object->kind == Kind::Device && op == "createBindGroupLayout") {
        WGPUBindGroupLayoutDescriptor native = WGPU_BIND_GROUP_LAYOUT_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        auto entries = input.required(descriptor, "entries"),
             length = input.field(entries, "length");
        uint32_t n = input.u32(length);
        auto items = input.allocate(n, WGPU_BIND_GROUP_LAYOUT_ENTRY_INIT);
        for (uint32_t i = 0; i < n && input.ok; ++i) {
            Value entry(context, JS_GetPropertyUint32(context, entries, i));
            items[i].binding = input.required_number32(entry, "binding");
            items[i].visibility = input.required_number32(entry, "visibility");
            auto buffer = input.field(entry, "buffer");
            if (!JS_IsUndefined(buffer)) {
                items[i].buffer = WGPU_BUFFER_BINDING_LAYOUT_INIT;
                items[i].buffer.type = input.enumeration(
                    buffer, "type", "BufferBindingType", WGPUBufferBindingType_Uniform);
                items[i].buffer.hasDynamicOffset = input.boolean(buffer, "hasDynamicOffset");
                items[i].buffer.minBindingSize = input.number(buffer, "minBindingSize");
            }
            auto sampler = input.field(entry, "sampler");
            if (!JS_IsUndefined(sampler)) {
                items[i].sampler = WGPU_SAMPLER_BINDING_LAYOUT_INIT;
                items[i].sampler.type = input.enumeration(
                    sampler, "type", "SamplerBindingType", WGPUSamplerBindingType_Filtering);
            }
            auto texture = input.field(entry, "texture");
            if (!JS_IsUndefined(texture)) {
                items[i].texture = WGPU_TEXTURE_BINDING_LAYOUT_INIT;
                items[i].texture.sampleType = input.enumeration(
                    texture, "sampleType", "TextureSampleType", WGPUTextureSampleType_Float);
                items[i].texture.viewDimension = input.enumeration(
                    texture, "viewDimension", "TextureViewDimension", WGPUTextureViewDimension_2D);
                items[i].texture.multisampled = input.boolean(texture, "multisampled");
            }
            auto storage = input.field(entry, "storageTexture");
            if (!JS_IsUndefined(storage)) {
                items[i].storageTexture = WGPU_STORAGE_TEXTURE_BINDING_LAYOUT_INIT;
                items[i].storageTexture.access = input.enumeration(
                    storage, "access", "StorageTextureAccess", WGPUStorageTextureAccess_WriteOnly);
                auto format = input.required(storage, "format");
                items[i].storageTexture.format
                    = static_cast<WGPUTextureFormat>(input.enumeration(format, "TextureFormat"));
                items[i].storageTexture.viewDimension = input.enumeration(
                    storage, "viewDimension", "TextureViewDimension", WGPUTextureViewDimension_2D);
            }
            auto external=input.field(entry,"externalTexture");
            if(!JS_IsUndefined(external)) {
                auto binding=input.allocate(1,WGPU_EXTERNAL_TEXTURE_BINDING_LAYOUT_INIT);
                items[i].nextInChain=&binding->chain;
            }
        }
        native.entries = items;
        native.entryCount = n;
        if (!input.ok)
            return JS_EXCEPTION;
        return object_value(object->state, Kind::BindGroupLayout,
            api.DeviceCreateBindGroupLayout(static_cast<WGPUDevice>(object->native), &native), self,
            object->device);
    }
    if (object->kind == Kind::Device && op == "createPipelineLayout") {
        WGPUPipelineLayoutDescriptor native = WGPU_PIPELINE_LAYOUT_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        auto layouts = input.required(descriptor, "bindGroupLayouts"),
             length = input.field(layouts, "length");
        uint32_t n = input.u32(length);
        auto entries = input.allocate(n, WGPUBindGroupLayout { nullptr });
        for (uint32_t i = 0; i < n && input.ok; ++i) {
            Value value(context, JS_GetPropertyUint32(context, layouts, i));
            if (JS_IsNull(value))
                continue;
            auto layout = input.resource(value, Kind::BindGroupLayout, object->device);
            if (layout)
                entries[i] = static_cast<WGPUBindGroupLayout>(layout->native);
        }
        native.bindGroupLayouts = entries;
        native.bindGroupLayoutCount = n;
        native.immediateSize=input.number32(descriptor,"immediateSize");
        if (!input.ok)
            return JS_EXCEPTION;
        return object_value(object->state, Kind::PipelineLayout,
            api.DeviceCreatePipelineLayout(static_cast<WGPUDevice>(object->native), &native), self,
            object->device);
    }
    if (object->kind == Kind::Device && op == "createTexture") {
        WGPUTextureDescriptor native = WGPU_TEXTURE_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        auto size_value = input.required(descriptor, "size");
        native.size = extent(input, size_value);
        auto usage = input.required(descriptor, "usage");
        native.usage = input.u32(usage);
        auto format = input.required(descriptor, "format");
        native.format = static_cast<WGPUTextureFormat>(input.enumeration(format, "TextureFormat"));
        native.dimension = input.enumeration(
            descriptor, "dimension", "TextureDimension", WGPUTextureDimension_2D);
        native.mipLevelCount = input.number32(descriptor, "mipLevelCount", 1);
        native.sampleCount = input.number32(descriptor, "sampleCount", 1);
        auto binding_dimension=input.field(descriptor,"textureBindingViewDimension");
        if(!JS_IsUndefined(binding_dimension)){
            auto binding=input.allocate(1,WGPU_TEXTURE_BINDING_VIEW_DIMENSION_INIT);
            binding->textureBindingViewDimension=static_cast<WGPUTextureViewDimension>(
                input.enumeration(binding_dimension,"TextureViewDimension"));
            if(!api.DeviceHasFeature(static_cast<WGPUDevice>(object->native),WGPUFeatureName_CoreFeaturesAndLimits))
                native.nextInChain=&binding->chain;
        }
        auto formats = input.field(descriptor, "viewFormats");
        std::vector<WGPUTextureFormat> view_formats;
        if (!JS_IsUndefined(formats)) {
            auto length = input.field(formats, "length");
            uint32_t count = input.u32(length);
            for (uint32_t i = 0; i < count && input.ok; ++i) {
                Value value(context, JS_GetPropertyUint32(context, formats, i));
                view_formats.push_back(
                    static_cast<WGPUTextureFormat>(input.enumeration(value, "TextureFormat")));
            }
        }
        native.viewFormats = view_formats.data();
        native.viewFormatCount = view_formats.size();
        if (!input.ok)
            return JS_EXCEPTION;
        WGPUTextureUsage public_usage=native.usage;
        bool transient=(public_usage&WGPUTextureUsage_TransientAttachment)!=0;
        bool ordinary=transient&&!api.DeviceHasFeature(static_cast<WGPUDevice>(object->native),WGPUFeatureName_TransientAttachments);
        bool invalid_transient=transient&&(public_usage!=(WGPUTextureUsage_TransientAttachment|WGPUTextureUsage_RenderAttachment)||
            native.viewFormatCount||native.dimension!=WGPUTextureDimension_2D||native.mipLevelCount!=1||native.size.depthOrArrayLayers!=1);
        if(ordinary)native.usage&=~WGPUTextureUsage_TransientAttachment;
        if(invalid_transient)api.DeviceInjectError(static_cast<WGPUDevice>(object->native),WGPUErrorType_Validation,
            view("Transient attachment requires only render/transient usage, no view formats, 2D, one mip and one layer"));
        auto texture=invalid_transient?api.DeviceCreateErrorTexture(static_cast<WGPUDevice>(object->native),&native):
            api.DeviceCreateTexture(static_cast<WGPUDevice>(object->native),&native);
        const char *trace=std::getenv("PU_WEBGPU_TRACE_TRANSIENT");
        if(texture&&transient&&!invalid_transient&&trace&&!std::strcmp(trace,"1"))
            std::fprintf(stderr,"[webgpu] transient allocation: privateFeature=%u nativeUsage=%llu logicalUsage=%llu\n",
                static_cast<unsigned>(api.DeviceHasFeature(object->device->native,WGPUFeatureName_TransientAttachments)),
                static_cast<unsigned long long>(api.TextureGetUsage(texture)),static_cast<unsigned long long>(public_usage));
        JSValue result=object_value(object->state,Kind::Texture,texture,self,object->device);
        if(!JS_IsException(result)){
            auto resource=static_cast<Object*>(JS_GetOpaque(result,object_class));
            resource->transient_attachment=transient;resource->transient_emulated=ordinary;
            resource->public_texture_usage=public_usage;resource->texture_format=native.format;
        }
        return result;
    }
    if(object->kind==Kind::Device&&op=="importExternalTexture") {
        auto source_value=argument(1);
        auto resource=pu_media_resource(context,source_value);
        int width,height,linear;
        if(!resource)return JS_EXCEPTION;
        if(!pu_canvas_resource_info(resource,&width,&height,&linear))
            return JS_ThrowTypeError(context,"Invalid owned external frame snapshot");
        auto device=static_cast<WGPUDevice>(object->native);
        WGPUQueue queue=api.DeviceGetQueue(device);
        struct QueueGuard {const PuDawnApi &api;WGPUQueue queue;~QueueGuard(){api.QueueRelease(queue);}} queue_guard{api,queue};
        UploadedImage image(api);
        if(!upload_image(context,image,device,queue,resource,0,0,width,height,false))return JS_EXCEPTION;
        WGPUTextureView view=api.TextureCreateView(image.texture,nullptr);
        if(!view)return JS_ThrowInternalError(context,"Cannot allocate external frame view");
        struct ViewGuard {const PuDawnApi &api;WGPUTextureView view;~ViewGuard(){api.TextureViewRelease(view);}} view_guard{api,view};
        bool display_p3=input.boolean(descriptor,"displayP3");
        ColorConversion conversion(display_p3,image.linear);
        WGPUExternalTextureDescriptor native=WGPU_EXTERNAL_TEXTURE_DESCRIPTOR_INIT;
        native.label=input.string(descriptor,"label");native.plane0=view;
        native.cropSize={image.width,image.height};native.apparentSize=native.cropSize;
        native.doYuvToRgbConversionOnly=!display_p3&&!image.linear;
        native.srcTransferFunctionParameters=conversion.source_transfer;
        native.dstTransferFunctionParameters=conversion.destination_transfer;native.gamutConversionMatrix=conversion.gamut;
        if(!input.ok)return JS_EXCEPTION;
        return object_value(object->state,Kind::ExternalTexture,api.DeviceCreateExternalTexture(device,&native),self,object->device);
    }
    if(object->kind==Kind::ExternalTexture&&op=="externalExpire") {
        api.ExternalTextureExpire(static_cast<WGPUExternalTexture>(object->native));return JS_UNDEFINED;
    }
    if (object->kind == Kind::Device && op == "createSampler") {
        WGPUSamplerDescriptor native = WGPU_SAMPLER_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        native.addressModeU = input.enumeration(
            descriptor, "addressModeU", "AddressMode", WGPUAddressMode_ClampToEdge);
        native.addressModeV = input.enumeration(
            descriptor, "addressModeV", "AddressMode", WGPUAddressMode_ClampToEdge);
        native.addressModeW = input.enumeration(
            descriptor, "addressModeW", "AddressMode", WGPUAddressMode_ClampToEdge);
        native.magFilter
            = input.enumeration(descriptor, "magFilter", "FilterMode", WGPUFilterMode_Nearest);
        native.minFilter
            = input.enumeration(descriptor, "minFilter", "FilterMode", WGPUFilterMode_Nearest);
        native.mipmapFilter = input.enumeration(
            descriptor, "mipmapFilter", "MipmapFilterMode", WGPUMipmapFilterMode_Nearest);
        native.compare = input.enumeration(
            descriptor, "compare", "CompareFunction", WGPUCompareFunction_Undefined);
        native.lodMinClamp = input.real(descriptor, "lodMinClamp");
        native.lodMaxClamp = input.real(descriptor, "lodMaxClamp", 32);
        uint32_t anisotropy = input.number32(descriptor, "maxAnisotropy", 1);
        if (anisotropy > UINT16_MAX)
            return JS_ThrowTypeError(context, "maxAnisotropy exceeds uint16");
        native.maxAnisotropy = static_cast<uint16_t>(anisotropy);
        if (!input.ok)
            return JS_EXCEPTION;
        return object_value(object->state, Kind::Sampler,
            api.DeviceCreateSampler(static_cast<WGPUDevice>(object->native), &native), self,
            object->device);
    }
    if (object->kind == Kind::Texture && op == "createView") {
        WGPUTextureViewDescriptor native = WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        native.label = input.string(descriptor, "label");
        native.format
            = input.enumeration(descriptor, "format", "TextureFormat", WGPUTextureFormat_Undefined);
        native.dimension = input.enumeration(
            descriptor, "dimension", "TextureViewDimension", WGPUTextureViewDimension_Undefined);
        native.aspect
            = input.enumeration(descriptor, "aspect", "TextureAspect", WGPUTextureAspect_All);
        native.baseMipLevel = input.number32(descriptor, "baseMipLevel");
        native.mipLevelCount
            = input.number32(descriptor, "mipLevelCount", WGPU_MIP_LEVEL_COUNT_UNDEFINED);
        native.baseArrayLayer = input.number32(descriptor, "baseArrayLayer");
        native.arrayLayerCount
            = input.number32(descriptor, "arrayLayerCount", WGPU_ARRAY_LAYER_COUNT_UNDEFINED);
        native.usage = input.number32(descriptor, "usage");
        bool invalid_transient=object->transient_attachment&&native.usage&&native.usage!=object->public_texture_usage;
        bool transient=object->transient_attachment;
        if(object->transient_emulated)native.usage&=~WGPUTextureUsage_TransientAttachment;
        bool invalid_swizzle=false;
        auto swizzle_value=input.field(descriptor,"swizzle");
        if(!JS_IsUndefined(swizzle_value)) {
            size_t length=0;const char *value=JS_ToCStringLen(context,&length,swizzle_value);
            if(!value)return JS_EXCEPTION;
            if(length!=4)invalid_swizzle=true;
            else if(std::memcmp(value,"rgba",4)!=0){
                auto swizzle=input.allocate(1,WGPU_TEXTURE_COMPONENT_SWIZZLE_DESCRIPTOR_INIT);
                WGPUComponentSwizzle *components[]={&swizzle->swizzle.r,&swizzle->swizzle.g,&swizzle->swizzle.b,&swizzle->swizzle.a};
                for(unsigned i=0;i<4;++i)switch(value[i]){
                    case 'r':*components[i]=WGPUComponentSwizzle_R;break;
                    case 'g':*components[i]=WGPUComponentSwizzle_G;break;
                    case 'b':*components[i]=WGPUComponentSwizzle_B;break;
                    case 'a':*components[i]=WGPUComponentSwizzle_A;break;
                    case '0':*components[i]=WGPUComponentSwizzle_Zero;break;
                    case '1':*components[i]=WGPUComponentSwizzle_One;break;
                    default:invalid_swizzle=true;break;
                }
                native.nextInChain=&swizzle->chain;
            }
            JS_FreeCString(context,value);
        }
        if (!input.ok)
            return JS_EXCEPTION;
        if(invalid_swizzle){
            api.DeviceInjectError(object->device->native,WGPUErrorType_Validation,view("Texture view swizzle requires exactly four rgba01 components"));
            native.nextInChain=nullptr;
        }
        if(invalid_transient)api.DeviceInjectError(object->device->native,WGPUErrorType_Validation,
            view("Transient attachment view usage must equal the texture usage"));
        JSValue value=object_value(object->state, Kind::TextureView,
            (invalid_swizzle||invalid_transient)?api.TextureCreateErrorView(static_cast<WGPUTexture>(object->native),&native):
                api.TextureCreateView(static_cast<WGPUTexture>(object->native), &native), self,
            object->device);
        if(!JS_IsException(value)) {
            auto view=static_cast<Object*>(JS_GetOpaque(value,object_class));
            view->canvas_target=object->canvas_target;view->canvas_generation=object->canvas_generation;
            view->transient_attachment=transient;view->transient_emulated=object->transient_emulated;
            view->texture_format=native.format==WGPUTextureFormat_Undefined?object->texture_format:native.format;
            view->texture_aspect=native.aspect;
        }
        return value;
    }
    if(object->kind==Kind::Queue&&op=="copyExternalImageToTexture") {
        auto source_value=argument(1),size_value=argument(2),options_value=argument(3);
        Object *target=nullptr;auto destination=texture_copy(input,descriptor,object->device,&target);
        auto size=extent(input,size_value);
        auto resource=pu_media_resource(context,source_value);
        bool display_p3=input.boolean(options_value,"displayP3"),premultiplied=input.boolean(options_value,"premultipliedAlpha");
        uint32_t x=input.number32(options_value,"x"),y=input.number32(options_value,"y");
        bool flip=input.boolean(options_value,"flipY");
        if(!input.ok||!resource)return JS_EXCEPTION;
        auto device=object->device->native;
        auto queue=static_cast<WGPUQueue>(object->native);
        auto format=api.TextureGetFormat(destination.texture);
        bool allowed=false;
        switch(format) {
            case WGPUTextureFormat_R8Unorm:case WGPUTextureFormat_RG8Unorm:
            case WGPUTextureFormat_RGBA8Unorm:case WGPUTextureFormat_RGBA8UnormSrgb:
            case WGPUTextureFormat_BGRA8Unorm:case WGPUTextureFormat_BGRA8UnormSrgb:
            case WGPUTextureFormat_R16Unorm:case WGPUTextureFormat_RG16Unorm:case WGPUTextureFormat_RGBA16Unorm:
            case WGPUTextureFormat_R16Float:case WGPUTextureFormat_RG16Float:case WGPUTextureFormat_RGBA16Float:
            case WGPUTextureFormat_R32Float:case WGPUTextureFormat_RG32Float:case WGPUTextureFormat_RGBA32Float:
            case WGPUTextureFormat_RGB10A2Unorm:case WGPUTextureFormat_RG11B10Ufloat:allowed=true;break;
            default:break;
        }
        if(!allowed) {
            api.DeviceInjectError(device,WGPUErrorType_Validation,
                view("External image destination must be a renderable unorm or float color format"));
            return JS_UNDEFINED;
        }
        UploadedImage image(api);
        if(!upload_image(context,image,device,queue,resource,x,y,size.width,size.height,flip))return JS_EXCEPTION;
        WGPUTexelCopyTextureInfo source=WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;source.texture=image.texture;
        ColorConversion conversion(display_p3,image.linear);
        WGPUCopyTextureForBrowserOptions options=WGPU_COPY_TEXTURE_FOR_BROWSER_OPTIONS_INIT;
        options.needsColorSpaceConversion=display_p3||image.linear;options.srcTransferFunctionParameters=conversion.source_transfer;
        options.dstTransferFunctionParameters=conversion.destination_transfer;options.conversionMatrix=conversion.gamut;
        options.dstAlphaMode=premultiplied?WGPUAlphaMode_Premultiplied:WGPUAlphaMode_Unpremultiplied;
        auto copy=[&]{api.QueueCopyTextureForBrowser(queue,&source,&destination,&size,&options);};
        bool accepted=true;
        if(target&&!target->canvas_target.expired())accepted=checked_mutation(object,copy);else copy();
        if(accepted&&target&&size.width&&size.height&&size.depthOrArrayLayers)publish_canvas_write(target);
        return JS_UNDEFINED;
    }
    if (object->kind == Kind::Queue && op == "writeTexture") {
        auto data_value = argument(1), layout_value = argument(2), extent_value = argument(3);
        Object *target=nullptr;
        auto destination = texture_copy(input, descriptor, object->device,&target);
        auto layout = texel_layout(input, layout_value);
        auto size = extent(input, extent_value);
        Bytes bytes(context, data_value);
        if (!input.ok || !bytes.data)
            return JS_EXCEPTION;
        bool accepted=true;
        if(target&&!target->canvas_target.expired())
            accepted=checked_mutation(object,[&]{api.QueueWriteTexture(static_cast<WGPUQueue>(object->native),&destination,bytes.data,bytes.length,&layout,&size);});
        else api.QueueWriteTexture(static_cast<WGPUQueue>(object->native),&destination,bytes.data,bytes.length,&layout,&size);
        if(accepted&&target&&size.width&&size.height&&size.depthOrArrayLayers)publish_canvas_write(target);
        return JS_UNDEFINED;
    }
    if (object->kind == Kind::Encoder
        && (op == "copyTextureToBuffer" || op == "copyBufferToTexture"
            || op == "copyTextureToTexture")) {
        auto destination_value = argument(1), extent_value = argument(2);
        auto size = extent(input, extent_value);
        auto encoder = static_cast<WGPUCommandEncoder>(object->native);
        if (op == "copyTextureToBuffer") {
            auto source = texture_copy(input, descriptor, object->device);
            auto destination = buffer_copy(input, destination_value, object->device);
            if (!input.ok)
                return JS_EXCEPTION;
            api.CommandEncoderCopyTextureToBuffer(encoder, &source, &destination, &size);
        } else if (op == "copyBufferToTexture") {
            auto source = buffer_copy(input, descriptor, object->device);
            Object *target=nullptr;
            auto destination = texture_copy(input, destination_value, object->device,&target);
            if (!input.ok)
                return JS_EXCEPTION;
            api.CommandEncoderCopyBufferToTexture(encoder, &source, &destination, &size);
            if(target&&size.width&&size.height&&size.depthOrArrayLayers)record_canvas_write(object,target);
        } else {
            auto source = texture_copy(input, descriptor, object->device);
            Object *target=nullptr;
            auto destination = texture_copy(input, destination_value, object->device,&target);
            if (!input.ok)
                return JS_EXCEPTION;
            api.CommandEncoderCopyTextureToTexture(encoder, &source, &destination, &size);
            if(target&&size.width&&size.height&&size.depthOrArrayLayers)record_canvas_write(object,target);
        }
        return JS_UNDEFINED;
    }
    handled = false;
    return JS_UNDEFINED;
}
