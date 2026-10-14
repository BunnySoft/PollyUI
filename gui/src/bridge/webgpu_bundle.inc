static JSValue bundle_operation(Object *object,const std::string &op,Input &input,
    JSValueConst arguments,JSValueConst self,bool &handled)
{
    auto state=object->state;const auto &api=*state->api;JSContext *context=input.context;
    auto arg=[&](uint32_t i)->Value{return {context,JS_GetPropertyUint32(context,arguments,i)};};
    auto descriptor=arg(0);handled=true;
    if(op=="setImmediates") {
        auto data_value=arg(1),offset_value=arg(2),size_value=arg(3);
        Bytes bytes(context,data_value);
        uint32_t range_offset=input.u32(descriptor);
        uint64_t offset=input.integer(offset_value),count=input.integer(size_value,offset<=bytes.length/bytes.element?bytes.length/bytes.element-offset:0);
        if(!input.ok||!bytes.data)return JS_EXCEPTION;
        if(offset>bytes.length/bytes.element||count>bytes.length/bytes.element-offset)
            return operation_error(context,"Immediate data exceeds BufferSource view");
        const uint8_t *data=bytes.data+offset*bytes.element;size_t length=(size_t)count*bytes.element;
        switch(object->kind) {
            case Kind::ComputePass:api.ComputePassEncoderSetImmediates(static_cast<WGPUComputePassEncoder>(object->native),range_offset,data,length);break;
            case Kind::RenderPass:api.RenderPassEncoderSetImmediates(static_cast<WGPURenderPassEncoder>(object->native),range_offset,data,length);break;
            case Kind::BundleEncoder:api.RenderBundleEncoderSetImmediates(static_cast<WGPURenderBundleEncoder>(object->native),range_offset,data,length);break;
            default:return JS_ThrowTypeError(context,"Resource has no immediate data operation");
        }
        return JS_UNDEFINED;
    }
    if(object->kind==Kind::Device&&op=="createRenderBundleEncoder") {
        WGPURenderBundleEncoderDescriptor native=WGPU_RENDER_BUNDLE_ENCODER_DESCRIPTOR_INIT;
        native.label=input.string(descriptor,"label");
        auto formats=input.required(descriptor,"colorFormats"),length=input.field(formats,"length");
        uint32_t n=input.u32(length);auto entries=input.allocate(n,WGPUTextureFormat_Undefined);
        for(uint32_t i=0;i<n&&input.ok;++i){Value value(context,JS_GetPropertyUint32(context,formats,i));
            if(!JS_IsNull(value))entries[i]=static_cast<WGPUTextureFormat>(input.enumeration(value,"TextureFormat"));}
        native.colorFormats=entries;native.colorFormatCount=n;
        native.depthStencilFormat=input.enumeration(descriptor,"depthStencilFormat","TextureFormat",WGPUTextureFormat_Undefined);
        native.sampleCount=input.number32(descriptor,"sampleCount",1);
        native.depthReadOnly=input.boolean(descriptor,"depthReadOnly");native.stencilReadOnly=input.boolean(descriptor,"stencilReadOnly");
        if(!input.ok)return JS_EXCEPTION;
        return object_value(state,Kind::BundleEncoder,api.DeviceCreateRenderBundleEncoder(static_cast<WGPUDevice>(object->native),&native),self,object->device);
    }
    if(object->kind==Kind::RenderPass&&op=="executeBundles") {
        auto length=input.field(descriptor,"length");uint32_t n=input.u32(length);
        auto entries=input.allocate(n,WGPURenderBundle{nullptr});
        for(uint32_t i=0;i<n&&input.ok;++i){Value value(context,JS_GetPropertyUint32(context,descriptor,i));auto bundle=input.resource(value,Kind::Bundle,object->device);
            if(bundle)entries[i]=static_cast<WGPURenderBundle>(bundle->native);}
        if(!input.ok)return JS_EXCEPTION;
        api.RenderPassEncoderExecuteBundles(static_cast<WGPURenderPassEncoder>(object->native),n,entries);
        if(n)object->has_canvas_mutation=true;return JS_UNDEFINED;
    }
    if(object->kind==Kind::BundleEncoder) {
        auto encoder=static_cast<WGPURenderBundleEncoder>(object->native);
        if(op=="finish") {
            WGPURenderBundleDescriptor native=WGPU_RENDER_BUNDLE_DESCRIPTOR_INIT;native.label=input.string(descriptor,"label");
            if(!input.ok)return JS_EXCEPTION;
            object->finished=true;return object_value(state,Kind::Bundle,api.RenderBundleEncoderFinish(encoder,&native),object->owner,object->device);
        }
        if(op=="setPipeline"){auto pipeline=input.resource(descriptor,Kind::RenderPipeline,object->device);
            if(!pipeline)return JS_EXCEPTION;api.RenderBundleEncoderSetPipeline(encoder,static_cast<WGPURenderPipeline>(pipeline->native));return JS_UNDEFINED;}
        if(op=="setBindGroup") {
            auto group_value=arg(1),offsets_value=arg(2),length=input.field(offsets_value,"length");
            auto group=JS_IsNull(group_value)?nullptr:input.resource(group_value,Kind::BindGroup,object->device);
            uint32_t index=input.u32(descriptor),n=input.u32(length);auto offsets=input.allocate(n,uint32_t{0});
            for(uint32_t i=0;i<n&&input.ok;++i){Value v(context,JS_GetPropertyUint32(context,offsets_value,i));offsets[i]=input.u32(v);}
            if(!input.ok)return JS_EXCEPTION;
            api.RenderBundleEncoderSetBindGroup(encoder,index,group?static_cast<WGPUBindGroup>(group->native):nullptr,n,offsets);return JS_UNDEFINED;
        }
        if(op=="setVertexBuffer"||op=="setIndexBuffer") {
            auto value=op=="setVertexBuffer"?arg(1):arg(0),offset_value=arg(2),size_value=arg(3);
            auto buffer=JS_IsNull(value)?nullptr:input.resource(value,Kind::Buffer,object->device);
            uint64_t offset=input.integer(offset_value),size=input.integer(size_value,WGPU_WHOLE_SIZE);
            if(op=="setVertexBuffer") {
                uint32_t slot=input.u32(descriptor);if(!input.ok)return JS_EXCEPTION;
                api.RenderBundleEncoderSetVertexBuffer(encoder,slot,buffer?static_cast<WGPUBuffer>(buffer->native):nullptr,offset,size);
            } else {
                auto format_value=arg(1);auto format=static_cast<WGPUIndexFormat>(input.enumeration(format_value,"IndexFormat"));
                if(!input.ok)return JS_EXCEPTION;
                api.RenderBundleEncoderSetIndexBuffer(encoder,buffer?static_cast<WGPUBuffer>(buffer->native):nullptr,format,offset,size);
            }
            return JS_UNDEFINED;
        }
        if(op=="draw"){auto iv=arg(1),fv=arg(2),sv=arg(3);uint32_t n=input.u32(descriptor),i=input.u32(iv,1),f=input.u32(fv),s=input.u32(sv);
            if(!input.ok)return JS_EXCEPTION;api.RenderBundleEncoderDraw(encoder,n,i,f,s);return JS_UNDEFINED;}
        if(op=="drawIndexed"){auto iv=arg(1),fv=arg(2),bv=arg(3),sv=arg(4);uint32_t n=input.u32(descriptor),i=input.u32(iv,1),f=input.u32(fv),s=input.u32(sv);
            int32_t b=input.s32(bv);
            if(!input.ok)return JS_EXCEPTION;api.RenderBundleEncoderDrawIndexed(encoder,n,i,f,b,s);return JS_UNDEFINED;}
        if(op=="drawIndirect"||op=="drawIndexedIndirect") {
            auto buffer=input.resource(descriptor,Kind::Buffer,object->device);auto offset_value=arg(1);uint64_t offset=input.integer(offset_value);
            if(!input.ok)return JS_EXCEPTION;
            if(op=="drawIndirect")api.RenderBundleEncoderDrawIndirect(encoder,static_cast<WGPUBuffer>(buffer->native),offset);
            else api.RenderBundleEncoderDrawIndexedIndirect(encoder,static_cast<WGPUBuffer>(buffer->native),offset);return JS_UNDEFINED;
        }
    }
    if(op=="insertDebugMarker"||op=="pushDebugGroup"||op=="popDebugGroup") {
        const char *label=op=="popDebugGroup"?nullptr:JS_ToCString(context,descriptor);
        if(op!="popDebugGroup"&&!label)return JS_EXCEPTION;
        WGPUStringView text={label,WGPU_STRLEN};
#define DEBUG(kind,type) case Kind::kind: {auto handle=static_cast<WGPU##type>(object->native); \
    if(op=="insertDebugMarker")api.type##InsertDebugMarker(handle,text); \
    else if(op=="pushDebugGroup")api.type##PushDebugGroup(handle,text);else api.type##PopDebugGroup(handle);break;}
        switch(object->kind){DEBUG(Encoder,CommandEncoder);DEBUG(ComputePass,ComputePassEncoder);
            DEBUG(RenderPass,RenderPassEncoder);DEBUG(BundleEncoder,RenderBundleEncoder);
            default:JS_FreeCString(context,label);return JS_ThrowTypeError(context,"Resource has no debug group operations");}
#undef DEBUG
        JS_FreeCString(context,label);return JS_UNDEFINED;
    }
    handled=false;return JS_UNDEFINED;
}
