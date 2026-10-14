(function installWebGPU(native) {
    "use strict";
    const resources = new WeakMap(), token = {};
    const lostOwners = new WeakMap();
    const canvasContexts = new WeakMap();
    const videoFrames = new WeakMap();
    const gpuErrors=new WeakMap(),events=new WeakMap(),eventTargets=new WeakMap();
    const deviceLostInfos=new WeakMap();
    const readonlyValues=new WeakMap();
    let imageSourceSnapshot=null;
    let isAbortSignal=()=>false;
    function eventState(value) {
        const state=events.get(value);
        if(!state)throw new TypeError("Illegal Event receiver");
        return state;
    }
    class Event {
        constructor(type,init={}) {
            if(!arguments.length)throw new TypeError("Event type is required");
            init=dictionary(init);
            events.set(this,{type:String(type),bubbles:Boolean(init.bubbles),cancelable:Boolean(init.cancelable),
                composed:Boolean(init.composed),target:null,currentTarget:null,phase:0,defaultPrevented:false,
                stopped:false,immediate:false,dispatching:false,passive:false,trusted:false,timeStamp:performance.now()});
            Object.defineProperty(this,"isTrusted",{get:()=>eventState(this).trusted,enumerable:true});
        }
        get type(){return eventState(this).type;}
        get target(){return eventState(this).target;}
        get currentTarget(){return eventState(this).currentTarget;}
        get eventPhase(){return eventState(this).phase;}
        get bubbles(){return eventState(this).bubbles;}
        get cancelable(){return eventState(this).cancelable;}
        get composed(){return eventState(this).composed;}
        get defaultPrevented(){return eventState(this).defaultPrevented;}
        get isTrusted(){return eventState(this).trusted;}
        get timeStamp(){return eventState(this).timeStamp;}
        get cancelBubble(){return eventState(this).stopped;}
        set cancelBubble(value){if(value)eventState(this).stopped=true;}
        get returnValue(){return !eventState(this).defaultPrevented;}
        set returnValue(value){if(!value)this.preventDefault();}
        preventDefault(){const s=eventState(this);if(s.cancelable&&!s.passive)s.defaultPrevented=true;}
        stopPropagation(){eventState(this).stopped=true;}
        stopImmediatePropagation(){const s=eventState(this);s.stopped=s.immediate=true;}
        composedPath(){const s=eventState(this);return s.dispatching?[s.currentTarget]:[];}
        initEvent(type,bubbles=false,cancelable=false){
            const s=eventState(this);if(s.dispatching)return;
            Object.assign(s,{type:String(type),bubbles:Boolean(bubbles),cancelable:Boolean(cancelable),
                target:null,trusted:false,defaultPrevented:false,stopped:false,immediate:false});
        }
    }
    for(const [name,value] of Object.entries({NONE:0,CAPTURING_PHASE:1,AT_TARGET:2,BUBBLING_PHASE:3})) {
        Object.defineProperty(Event,name,{value,enumerable:true});
        Object.defineProperty(Event.prototype,name,{value,enumerable:true});
    }
    function targetState(value) {
        const state=eventTargets.get(value);
        if(!state)throw new TypeError("Illegal EventTarget receiver");
        return state;
    }
    class EventTarget {
        constructor(){eventTargets.set(this,{listeners:[]});}
        addEventListener(type,callback,options={}) {
            const s=targetState(this);type=String(type);options=typeof options==="boolean"?{capture:options}:dictionary(options);
            if(callback==null)return;
            if(typeof callback!=="function"&&(typeof callback!=="object"))throw new TypeError("Invalid event listener");
            const capture=Boolean(options.capture),signal=options.signal;
            if(signal!==undefined&&!isAbortSignal(signal))throw new TypeError("Invalid AbortSignal");
            if(signal?.aborted||s.listeners.some(l=>l.type===type&&l.callback===callback&&l.capture===capture))return;
            const listener={type,callback,capture,once:Boolean(options.once),passive:Boolean(options.passive),signal};
            if(signal){listener.abort=()=>this.removeEventListener(type,callback,capture);signal.addEventListener("abort",listener.abort,{once:true});}
            s.listeners.push(listener);
        }
        removeEventListener(type,callback,options={}) {
            const s=targetState(this),capture=typeof options==="boolean"?options:Boolean(options?.capture);
            type=String(type);
            const index=s.listeners.findIndex(l=>l.type===type&&l.callback===callback&&l.capture===capture);
            if(index<0)return;
            const [listener]=s.listeners.splice(index,1);
            listener.signal?.removeEventListener("abort",listener.abort);
        }
        dispatchEvent(event) {
            const target=targetState(this),s=eventState(event);
            if(s.dispatching)throw new DOMException("Event is already being dispatched","InvalidStateError");
            s.trusted=false;
            return dispatch(this,target,event,s);
        }
    }
    function dispatch(target,list,event,s) {
        s.dispatching=true;s.target=s.currentTarget=target;s.phase=2;
        try {
            const listeners=[...list.listeners];
            for(const capture of [true,false])for(const listener of listeners) {
                if(s.immediate)break;
                if(listener.type!==s.type||listener.capture!==capture||!list.listeners.includes(listener))continue;
                if(listener.once)target.removeEventListener(listener.type,listener.callback,listener.capture);
                s.passive=listener.passive;
                try {
                    if(typeof listener.callback==="function")listener.callback.call(target,event);
                    else listener.callback.handleEvent?.(event);
                } catch(error) {
                    setTimeout(()=>{throw error;},0);
                }
                s.passive=false;
            }
            return !s.defaultPrevented;
        } finally {
            s.dispatching=false;s.currentTarget=null;s.phase=0;s.passive=false;s.stopped=s.immediate=false;
        }
    }
    const coreFeatures = [
        "atomic-vec2u-min-max","core-features-and-limits",
        "depth-clip-control", "depth32float-stencil8", "texture-compression-bc",
        "texture-compression-bc-sliced-3d", "texture-compression-etc2",
        "texture-compression-astc", "texture-compression-astc-sliced-3d",
        "timestamp-query", "indirect-first-instance", "shader-f16", "rg11b10ufloat-renderable",
        "bgra8unorm-storage", "float32-filterable", "float32-blendable", "clip-distances",
        "dual-source-blending", "subgroups", "texture-formats-tier1", "texture-formats-tier2",
        "primitive-index","texture-component-swizzle","subgroup-size-control","texture-compression-unaligned",
    ];
    function state(object, type) {
        const s = resources.get(object);
        if (!s || (type && s.type !== type)) throw new TypeError("Illegal WebGPU receiver");
        return s;
    }
    function copyExternalImage(source,destination,size) {
        state(this,GPUQueue);source=dictionary(source);destination=dictionary(destination);
        state(destination.texture,GPUTexture);
        const colorSpace=String(destination.colorSpace??"srgb");
        if(colorSpace!=="srgb"&&colorSpace!=="display-p3")throw new TypeError("Invalid destination colorSpace");
        const image=imageSourceSnapshot?.(source.source);
        if(!image)throw new TypeError("Expected a supported owned external image source");
        const extent=copyExtent(size),width=Math.trunc(Number(Array.isArray(extent)?extent[0]:extent.width));
        const height=Math.trunc(Number(Array.isArray(extent)?extent[1]??1:extent.height??1));
        const depth=Math.trunc(Number(Array.isArray(extent)?extent[2]??1:extent.depthOrArrayLayers??1));
        const origin=copyExtent(source.origin??[0,0]),x=Math.trunc(Number(Array.isArray(origin)?origin[0]??0:origin.x??0)),
            y=Math.trunc(Number(Array.isArray(origin)?origin[1]??0:origin.y??0));
        if((Array.isArray(extent)&&(!extent.length||extent.length>3))||(Array.isArray(origin)&&origin.length>2))
            throw new TypeError("Invalid external image extent or origin shape");
        for(const value of [width,height,depth,x,y])if(!Number.isSafeInteger(value)||value<0||value>4294967295)
            throw new TypeError("External image dimensions exceed GPUSize32 range");
        if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||
            depth>1||x+width>image.width||y+height>image.height)
            throw new DOMException("External image copy exceeds source bounds","OperationError");
        call(this,"copyExternalImageToTexture",destination,image.handle,[width,height,depth],{
            x,y,flipY:Boolean(source.flipY),displayP3:colorSpace==="display-p3",
            premultipliedAlpha:Boolean(destination.premultipliedAlpha)});
    }
    function call(object, operation, ...args) {
        return native(object === null ? null : state(object).handle, operation, args);
    }
    function ownedFramePixels(value) {
        const s=frameState(value);
        if(s.closed)throw new DOMException("VideoFrame is closed","InvalidStateError");
        const r=s.visible,pixels=new Uint8Array(r.width*r.height*4);
        for(let row=0;row<r.height;++row)for(let x=0;x<r.width;++x) {
            const a=((r.y+row)*s.width+r.x+x)*4,b=(row*r.width+x)*4;
            pixels[b]=s.pixels[a+(s.format==="BGRA"?2:0)];pixels[b+1]=s.pixels[a+1];
            pixels[b+2]=s.pixels[a+(s.format==="BGRA"?0:2)];pixels[b+3]=s.pixels[a+3];
        }
        const primaries={"bt709":0,"bt2020":1,"smpte432":2,"bt470bg":3,"smpte170m":4}[s.colorSpace.primaries??"bt709"];
        const transfer={"iec61966-2-1":0,"bt709":1,"smpte170m":1,"linear":2,"pq":3,"hlg":4}[s.colorSpace.transfer??"iec61966-2-1"];
        return {width:r.width,height:r.height,displayWidth:s.displayWidth,displayHeight:s.displayHeight,
            primaries,transfer,fullRange:s.colorSpace.fullRange??true,pixels};
    }
    function dictionary(value = {}) {
        if (value === null) return {};
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Expected WebGPU dictionary");
        return value;
    }
    function domString(value){
        if(typeof value==="symbol")throw new TypeError("WebGPU string cannot be a Symbol");
        return String(value);
    }
    function dictionaryOverlay(value){
        const cache=new Map();
        return new Proxy(Object.create(null),{get(target,key){
            if(Object.prototype.hasOwnProperty.call(target,key))return Reflect.get(target,key);
            if(cache.has(key))return cache.get(key);
            const member=Reflect.get(value,key,value);
            cache.set(key,member);return member;
        }});
    }
    function gpuColor(value){
        const method=value?.[Symbol.iterator];
        return method!==undefined&&method!==null?sequence(value,member=>member,method):dictionary(value);
    }
    function colorAttachment(value){
        if(value===null)return null;
        value=dictionary(value);
        const clear=value.clearValue;
        if(clear===undefined)return value;
        const result=dictionaryOverlay(value);
        Object.defineProperty(result,"clearValue",{value:gpuColor(clear),enumerable:true});
        return result;
    }
    function required(value, keys) {
        value = dictionary(value);
        const converted=dictionaryOverlay(value);
        for(const key of keys){
            const member=value[key];
            if(member===undefined)throw new TypeError(`Missing WebGPU ${key}`);
            Object.defineProperty(converted,key,{value:member,enumerable:true});
        }
        return converted;
    }
    function sequence(value,convert=value=>value,method){
        if(value==null||(typeof value!=="object"&&typeof value!=="function"))throw new TypeError("Expected an object iterable WebGPU sequence");
        if(arguments.length<3)method=value[Symbol.iterator];
        if(typeof method!=="function")throw new TypeError("Expected an iterable WebGPU sequence");
        const iterator=method.call(value);
        return Array.from({[Symbol.iterator]:()=>iterator},convert);
    }
    function sequenceFields(value,fields){
        value=dictionary(value);
        let result=value;
        for(const [name,convert] of Object.entries(fields)){
            const member=value[name];
            if(member===undefined)continue;
            if(result===value)result=dictionaryOverlay(value);
            Object.defineProperty(result,name,{value:sequence(member,convert),enumerable:true});
        }
        return result;
    }
    function objectDescriptor(value={}){
        value=dictionary(value);
        const label=value.label;
        const result=dictionaryOverlay(value);
        Object.defineProperty(result,"label",{value:label===undefined?"":domString(label),enumerable:true});
        return result;
    }
    function pipelineDescriptor(value){
        value=objectDescriptor(value);
        const vertex=value.vertex,fragment=value.fragment;
        if(vertex!==undefined)Object.defineProperty(value,"vertex",{value:sequenceFields(vertex,{buffers:buffer=>
            buffer===null?null:sequenceFields(buffer,{attributes:dictionary})})});
        if(fragment!==undefined)Object.defineProperty(value,"fragment",{value:sequenceFields(fragment,{targets:target=>
            target===null?null:dictionary(target)})});
        return value;
    }
    function enforcedInteger(value,max=9007199254740991){
        const number=Math.trunc(+value);
        if(!Number.isFinite(number)||number<0||number>max)throw new TypeError("Invalid EnforceRange WebGPU integer");
        return number;
    }
    const typedPrototype=Object.getPrototypeOf(Uint32Array.prototype);
    const typedName=Object.getOwnPropertyDescriptor(typedPrototype,Symbol.toStringTag).get;
    const typedLength=Object.getOwnPropertyDescriptor(typedPrototype,"length").get;
    const typedBuffer=Object.getOwnPropertyDescriptor(typedPrototype,"buffer").get;
    const typedOffset=Object.getOwnPropertyDescriptor(typedPrototype,"byteOffset").get;
    const NativeDataView=DataView,dataViewUint32=DataView.prototype.getUint32;
    const nativeLittleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
    function convertDynamicOffsets(value,start,length,count){
        if(count>=4){
            if(count<5||typedName.call(value)!=="Uint32Array")throw new TypeError("Typed dynamic offsets require Uint32Array, start and length");
            start=enforcedInteger(start);length=enforcedInteger(length,4294967295);
            const size=typedLength.call(value);
            if(start>size||length>size-start)throw new RangeError("Dynamic offset range exceeds supplied view");
            const bytes=new NativeDataView(typedBuffer.call(value),typedOffset.call(value)+start*4,length*4);
            return Array.from({length},(_,index)=>dataViewUint32.call(bytes,index*4,nativeLittleEndian));
        }
        return sequence(value,offset=>enforcedInteger(offset,4294967295));
    }
    function wrap(handle, Type, owner, label = "") {
        const object = Object.setPrototypeOf(handle, Type.prototype);
        resources.set(object, {type: Type, handle, owner, label: String(label), listeners: new Map()});
        if(Type===GPUDevice)eventTargets.set(object,{listeners:[],handler:null,attributeListener:null});
        return object;
    }
    class GPUObjectBase {
        constructor(key) { if (key !== token) throw new TypeError("Illegal constructor"); }
        get label() { return state(this).label; }
        set label(value) {
            value = String(value);
            call(this, "setLabel", value);
            state(this).label = value;
        }
    }
    class GPUSupportedFeatures {
        constructor(key, features) {
            if (key !== token) throw new TypeError("Illegal constructor");
            resources.set(this, {type: GPUSupportedFeatures, features: new Set(features)});
        }
    }
    class GPUSupportedLimits { constructor() { throw new TypeError("Illegal constructor"); } }
    class WGSLLanguageFeatures {
        constructor(key,features){
            if(key!==token)throw new TypeError("Illegal constructor");
            resources.set(this,{type:WGSLLanguageFeatures,features:new Set(features)});
        }
    }
    for(const Type of [GPUSupportedFeatures,WGSLLanguageFeatures]){
        const methods={
            has(value){const features=state(this,Type).features;if(!arguments.length||typeof value==="symbol")throw new TypeError("DOMString argument is required");return features.has(String(value));},
            entries(){return state(this,Type).features.entries();},
            keys(){return state(this,Type).features.keys();},
            values(){return state(this,Type).features.values();},
            forEach(callback,thisArg){
                const features=state(this,Type).features;
                if(typeof callback!=="function")throw new TypeError("Expected a callable setlike callback");
                features.forEach(value=>Reflect.apply(callback,thisArg,[value,value,this]));
            },
        };
        Object.defineProperty(Type.prototype,"size",{enumerable:true,configurable:true,get(){return state(this,Type).features.size;}});
        for(const [name,method] of Object.entries(methods))Object.defineProperty(Type.prototype,name,{
            value:method,enumerable:true,writable:true,configurable:true});
        Object.defineProperty(Type.prototype,Symbol.iterator,{value:methods.values,writable:true,configurable:true});
    }
    class GPUAdapterInfo { constructor() { throw new TypeError("Illegal constructor"); } }
    function readonly(Type, values) {
        const object = Object.create(Type.prototype);
        if(Type===GPUDeviceLostInfo){deviceLostInfos.set(object,values);return object;}
        if([GPUSupportedLimits,GPUAdapterInfo,GPUCompilationInfo,GPUCompilationMessage].includes(Type)){
            readonlyValues.set(object,{Type,values});return object;
        }
        for (const [name, value] of Object.entries(values))
            Object.defineProperty(object, name, {value, enumerable: true});
        return object;
    }
    function capabilities(object) {
        const info = call(object, "info");
        const features = info.features.filter(name => coreFeatures.includes(name));
        Object.assign(state(object),{features:new GPUSupportedFeatures(token,features),
            limits:readonly(GPUSupportedLimits,info.limits)});
        return readonly(GPUAdapterInfo, info.info);
    }
    class GPUAdapter {
        constructor(key) { if (key !== token) throw new TypeError("Illegal constructor"); }
        get features(){return state(this,GPUAdapter).features;}
        get limits(){return state(this,GPUAdapter).limits;}
        get info(){return state(this,GPUAdapter).info;}
        async requestDevice(descriptor = {}) {
            state(this, GPUAdapter);
            descriptor = objectDescriptor(descriptor);
            const converted = {
                label: descriptor.label, requiredFeatures: [...new Set(sequence(descriptor.requiredFeatures===undefined?[]:descriptor.requiredFeatures,String))],
                requiredLimits: descriptor.requiredLimits, defaultQueue: objectDescriptor(descriptor.defaultQueue),
            };
            if(converted.requiredLimits!==undefined){
                if(converted.requiredLimits===null)throw new TypeError("Expected WebGPU limits record");
                const limits=dictionary(converted.requiredLimits),values={};
                for(const [name,value] of Object.entries(limits)){
                    if(value===undefined){values[name]=undefined;continue;}
                    const number=enforcedInteger(value);
                    if(!readonlyAttributes.GPUSupportedLimits.includes(name))
                        throw new DOMException("Unknown required WebGPU limit: "+name,"OperationError");
                    const alignment=name.startsWith("min");
                    if((alignment&&(number===0||number>=4294967296||Math.log2(number)%1!==0||number<this.limits[name]))||
                        (!alignment&&number>this.limits[name]))
                        throw new DOMException("Required WebGPU limit exceeds adapter capabilities: "+name,"OperationError");
                    values[name]=number;
                }
                converted.requiredLimits=values;
            }
            for (const feature of converted.requiredFeatures)
                if (!coreFeatures.includes(feature)) throw new TypeError(`Unknown GPUFeatureName: ${feature}`);
            const handle = await call(this, "requestDevice", converted).catch(error=>{
                if(converted.requiredFeatures.some(feature=>!this.features.has(feature)))throw new TypeError(error.message);
                throw error;
            });
            const device = wrap(handle, GPUDevice, this, converted.label);
            const lost = call(device, "lost").then(value=>readonly(GPUDeviceLostInfo,value));
            lostOwners.set(lost, device);
            lost.then(() => lostOwners.delete(lost));
            Object.assign(state(device),{adapterInfo:capabilities(device),
                queue:wrap(call(device,"queue"),GPUQueue,device,converted.defaultQueue.label),lost});
            call(device, "errorHandler", value => {
                const event = new GPUUncapturedErrorEvent("uncapturederror",{error:gpuError(value),cancelable:true});
                const s=eventState(event);s.trusted=true;
                if (dispatch(device,targetState(device),event,s)) console.error("[webgpu] uncaptured error: " + event.error.message);
            });
            return device;
        }
    }
    class GPUDevice extends EventTarget {
        constructor(){throw new TypeError("Illegal constructor");}
        get features(){return state(this,GPUDevice).features;}
        get limits(){return state(this,GPUDevice).limits;}
        get adapterInfo(){return state(this,GPUDevice).adapterInfo;}
        get queue(){return state(this,GPUDevice).queue;}
        get lost(){return state(this,GPUDevice).lost;}
        get label(){return state(this,GPUDevice).label;}
        set label(value){state(this,GPUDevice);value=domString(value);
            call(this,"setLabel",value);state(this,GPUDevice).label=value;}
        destroy() { state(this, GPUDevice); call(this, "destroy"); }
        get onuncapturederror(){state(this,GPUDevice);return targetState(this).handler;}
        set onuncapturederror(value){
            state(this,GPUDevice);
            const s=targetState(this);s.handler=typeof value==="function"?value:null;
            if(s.handler&&!s.attributeListener){
                s.attributeListener=event=>s.handler?.call(this,event);
                this.addEventListener("uncapturederror",s.attributeListener);
            } else if(!s.handler&&s.attributeListener){
                this.removeEventListener("uncapturederror",s.attributeListener);s.attributeListener=null;
            }
        }
        createBuffer(descriptor) {
            state(this, GPUDevice);
            descriptor = objectDescriptor(descriptor);
            return wrap(call(this, "createBuffer", descriptor), GPUBuffer, this, descriptor.label || "");
        }
        createShaderModule(descriptor) {
            state(this, GPUDevice);
            descriptor = sequenceFields(objectDescriptor(descriptor),{compilationHints:hint=>{
                hint=required(hint,["entryPoint"]);
                const entryPoint=String(hint.entryPoint),layout=hint.layout;
                if(layout!==undefined){
                    if(typeof layout==="string"){if(layout!=="auto")throw new TypeError("Invalid GPUAutoLayoutMode");}
                    else state(layout,GPUPipelineLayout);
                }
                return {entryPoint,layout};
            }});
            return wrap(call(this, "createShaderModule", descriptor), GPUShaderModule, this, descriptor.label || "");
        }
        createTexture(descriptor) {
            state(this, GPUDevice);
            descriptor = objectDescriptor(descriptor);
            const converted = {};
            for (const key of ["label", "usage", "dimension", "format", "mipLevelCount", "sampleCount","textureBindingViewDimension"])
                converted[key] = descriptor[key];
            const size = descriptor.size;
            converted.size = copyExtent(size);
            const formats = descriptor.viewFormats;
            converted.viewFormats = formats === undefined ? undefined : sequence(formats);
            return wrap(call(this, "createTexture", converted), GPUTexture, this, converted.label || "");
        }
        createSampler(descriptor = {}) {
            state(this, GPUDevice); descriptor = objectDescriptor(descriptor);
            return wrap(call(this, "createSampler", descriptor), GPUSampler, this, descriptor.label || "");
        }
        importExternalTexture(descriptor) {
            state(this,GPUDevice);descriptor=objectDescriptor(descriptor);
            const source=descriptor.source,s=frameState(source);
            if(s.closed)throw new DOMException("VideoFrame is closed","InvalidStateError");
            const colorSpace=descriptor.colorSpace===undefined?"srgb":String(descriptor.colorSpace);
            if(colorSpace!=="srgb"&&colorSpace!=="display-p3")throw new TypeError("Invalid external texture colorSpace");
            const image=imageSourceSnapshot(source);
            const converted={label:descriptor.label,displayP3:colorSpace==="display-p3"};
            const external=wrap(call(this,"importExternalTexture",converted,image.handle),GPUExternalTexture,this,descriptor.label||"");
            if(!s.externals)s.externals=new Set();s.externals.add(external);
            return external;
        }
        createComputePipeline(descriptor) {
            state(this, GPUDevice);
            descriptor = objectDescriptor(required(descriptor, ["layout", "compute"]));
            return wrap(call(this, "createComputePipeline", descriptor), GPUComputePipeline, this, descriptor.label || "");
        }
        async createComputePipelineAsync(descriptor) {
            state(this, GPUDevice);
            descriptor = objectDescriptor(required(descriptor, ["layout", "compute"]));
            const handle = await call(this, "createComputePipelineAsync", descriptor).catch(error => {
                if (error.name === "GPUPipelineError") throw new GPUPipelineError(error.message, {reason: error.reason});
                throw error;
            });
            return wrap(handle, GPUComputePipeline, this, descriptor.label || "");
        }
        createRenderPipeline(descriptor) {
            state(this, GPUDevice); descriptor = pipelineDescriptor(descriptor);
            return wrap(call(this, "createRenderPipeline", descriptor), GPURenderPipeline, this, descriptor.label || "");
        }
        async createRenderPipelineAsync(descriptor) {
            state(this, GPUDevice); descriptor = pipelineDescriptor(descriptor);
            const handle = await call(this, "createRenderPipelineAsync", descriptor).catch(error => {
                if (error.name === "GPUPipelineError") throw new GPUPipelineError(error.message, {reason:error.reason});
                throw error;
            });
            return wrap(handle, GPURenderPipeline, this, descriptor.label || "");
        }
        createBindGroup(descriptor) {
            state(this, GPUDevice);
            descriptor = sequenceFields(objectDescriptor(required(descriptor, ["layout", "entries"])),{entries:dictionary});
            return wrap(call(this, "createBindGroup", descriptor), GPUBindGroup, this, descriptor.label || "");
        }
        createBindGroupLayout(descriptor) {
            state(this,GPUDevice);descriptor=sequenceFields(objectDescriptor(descriptor),{entries:dictionary});
            return wrap(call(this,"createBindGroupLayout",descriptor),GPUBindGroupLayout,this,descriptor.label||"");
        }
        createPipelineLayout(descriptor) {
            state(this,GPUDevice);descriptor=sequenceFields(objectDescriptor(descriptor),{bindGroupLayouts:value=>value});
            return wrap(call(this,"createPipelineLayout",descriptor),GPUPipelineLayout,this,descriptor.label||"");
        }
        createQuerySet(descriptor) {
            state(this,GPUDevice);descriptor=objectDescriptor(descriptor);
            return wrap(call(this,"createQuerySet",descriptor),GPUQuerySet,this,descriptor.label||"");
        }
        createRenderBundleEncoder(descriptor) {
            state(this,GPUDevice);descriptor=sequenceFields(objectDescriptor(descriptor),{colorFormats:value=>value});
            return wrap(call(this,"createRenderBundleEncoder",descriptor),GPURenderBundleEncoder,this,descriptor.label||"");
        }
        createCommandEncoder(descriptor = {}) {
            state(this, GPUDevice); descriptor = objectDescriptor(descriptor);
            return wrap(call(this, "createCommandEncoder", descriptor), GPUCommandEncoder, this, descriptor.label || "");
        }
        pushErrorScope(filter) { state(this, GPUDevice); call(this, "pushErrorScope", filter); }
        async popErrorScope() {
            state(this, GPUDevice);
            const value = await call(this, "popErrorScope");
            return value ? gpuError(value) : null;
        }
    }
    class GPUBuffer extends GPUObjectBase {
        get size() { state(this, GPUBuffer); return call(this, "info").size; }
        get usage() { state(this, GPUBuffer); return call(this, "info").usage; }
        get mapState() { state(this, GPUBuffer); return call(this, "info").mapState; }
        mapAsync(mode, offset = 0, size) { state(this, GPUBuffer); return call(this, "mapAsync", mode, offset, size); }
        getMappedRange(offset = 0, size) { state(this, GPUBuffer); return call(this, "getMappedRange", offset, size); }
        unmap() { state(this, GPUBuffer); call(this, "unmap"); }
        destroy() { state(this, GPUBuffer); call(this, "destroy"); }
    }
    class GPUTexture extends GPUObjectBase {
        get width() { state(this, GPUTexture); return call(this, "info").width; }
        get height() { state(this, GPUTexture); return call(this, "info").height; }
        get depthOrArrayLayers() { state(this, GPUTexture); return call(this, "info").depthOrArrayLayers; }
        get mipLevelCount() { state(this, GPUTexture); return call(this, "info").mipLevelCount; }
        get sampleCount() { state(this, GPUTexture); return call(this, "info").sampleCount; }
        get dimension() { state(this, GPUTexture); return call(this, "info").dimension; }
        get format() { state(this, GPUTexture); return call(this, "info").format; }
        get usage() { state(this, GPUTexture); return call(this, "info").usage; }
        get textureBindingViewDimension(){state(this,GPUTexture);return call(this,"info").textureBindingViewDimension;}
        createView(descriptor = {}) {
            state(this, GPUTexture); descriptor = objectDescriptor(descriptor);
            return wrap(call(this, "createView", descriptor), GPUTextureView, this, descriptor.label || "");
        }
        destroy() { state(this, GPUTexture); call(this, "destroy"); }
    }
    class GPUTextureView extends GPUObjectBase {}
    class GPUSampler extends GPUObjectBase {}
    class GPUExternalTexture extends GPUObjectBase {}
    function frameState(value) {
        const state=videoFrames.get(value);
        if(!state)throw new TypeError("Illegal VideoFrame receiver");
        return state;
    }
    function frameInteger(value,name,positive=false) {
        value=Math.trunc(Number(value));
        if(!Number.isSafeInteger(value)||(positive&&value<=0))throw new TypeError("Invalid VideoFrame "+name);
        return value;
    }
    function framePlane(layout,width,height) {
        const planes=layout===undefined?[{offset:0,stride:width*4}]:Array.from(layout);
        if(planes.length!==1)throw new TypeError("Packed RGBA/BGRA requires exactly one plane");
        const plane=dictionary(planes[0]),offset=frameInteger(plane.offset??0,"layout.offset"),
            stride=frameInteger(plane.stride,"layout.stride",true);
        const length=offset+stride*(height-1)+width*4;
        if(offset<0||stride<width*4||!Number.isSafeInteger(length)||length>67108864)
            throw new RangeError("VideoFrame plane exceeds stride or byte budget");
        return {offset,stride,length};
    }
    function frameCopyPlan(s,options) {
        options=dictionary(options);
        const r=options.rect??s.visible;
        const rect={x:frameInteger(r.x??0,"rect.x"),y:frameInteger(r.y??0,"rect.y"),
            width:frameInteger(r.width,"rect.width",true),height:frameInteger(r.height,"rect.height",true)};
        if(rect.x<0||rect.y<0||rect.x+rect.width>s.width||rect.y+rect.height>s.height)
            throw new RangeError("VideoFrame copy rect exceeds coded dimensions");
        const format=String(options.format??s.format);
        if(!["RGBA","BGRA"].includes(format))throw new DOMException("Unsupported VideoFrame copy format","NotSupportedError");
        return {rect,format,...framePlane(options.layout,rect.width,rect.height)};
    }
    class VideoColorSpace {
        constructor(init={}) {
            init=dictionary(init);
            const domains={
                primaries:["bt709","bt470bg","smpte170m","bt2020","smpte432"],
                transfer:["bt709","smpte170m","iec61966-2-1","linear","pq","hlg"],
                matrix:["rgb","bt709","bt470bg","smpte170m","bt2020-ncl"],
            };
            for(const key of ["primaries","transfer","matrix","fullRange"]){
                let value=init[key]??null;
                if(value!==null){
                    if(key==="fullRange")value=Boolean(value);
                    else {value=String(value);if(!domains[key].includes(value))throw new TypeError("Invalid VideoColorSpace "+key);}
                }
                Object.defineProperty(this,key,{value,enumerable:true});
            }
        }
        toJSON(){return {primaries:this.primaries,transfer:this.transfer,matrix:this.matrix,fullRange:this.fullRange};}
    }
    class VideoFrame {
        constructor(source,init={}) {
            init=dictionary(init);
            if(videoFrames.has(source)) {
                const original=frameState(source);
                if(original.closed)throw new DOMException("VideoFrame is closed","InvalidStateError");
                videoFrames.set(this,{...original,externals:new Set(),pixels:original.pixels.slice(),timestamp:init.timestamp===undefined?original.timestamp:
                    frameInteger(init.timestamp,"timestamp"),duration:init.duration??original.duration});
                return;
            }
            const width=frameInteger(init.codedWidth,"codedWidth",true),height=frameInteger(init.codedHeight,"codedHeight",true);
            const timestamp=frameInteger(init.timestamp,"timestamp");
            if(width*height>16*1024*1024)throw new RangeError("VideoFrame exceeds image pixel budget");
            const format=String(init.format);
            if(!["RGBA","BGRA"].includes(format))throw new DOMException("Owned VideoFrame supports RGBA/BGRA BufferSource only","NotSupportedError");
            let bytes;
            if(source instanceof ArrayBuffer)bytes=new Uint8Array(source);
            else if(ArrayBuffer.isView(source))bytes=new Uint8Array(source.buffer,source.byteOffset,source.byteLength);
            else throw new TypeError("Expected owned RGBA/BGRA BufferSource");
            const {offset,stride,length}=framePlane(init.layout,width,height);
            if(length>bytes.byteLength)
                throw new RangeError("VideoFrame source plane exceeds the supplied BufferSource view");
            const pixels=new Uint8Array(width*height*4);
            for(let y=0;y<height;++y)pixels.set(bytes.subarray(offset+y*stride,offset+y*stride+width*4),y*width*4);
            const rect=init.visibleRect??{x:0,y:0,width,height};
            const visible={x:frameInteger(rect.x??0,"visibleRect.x"),y:frameInteger(rect.y??0,"visibleRect.y"),
                width:frameInteger(rect.width,"visibleRect.width",true),height:frameInteger(rect.height,"visibleRect.height",true)};
            if(visible.x<0||visible.y<0||visible.x+visible.width>width||visible.y+visible.height>height)
                throw new RangeError("VideoFrame visibleRect exceeds coded dimensions");
            const displayWidth=frameInteger(init.displayWidth??visible.width,"displayWidth",true);
            const displayHeight=frameInteger(init.displayHeight??visible.height,"displayHeight",true);
            const duration=init.duration===undefined?null:frameInteger(init.duration,"duration");
            if(duration!==null&&duration<0)throw new TypeError("VideoFrame duration must be nonnegative");
            videoFrames.set(this,{pixels,width,height,timestamp,duration,format,visible,displayWidth,displayHeight,closed:false,
                colorSpace:new VideoColorSpace(init.colorSpace??{primaries:"bt709",transfer:"iec61966-2-1",matrix:"rgb",fullRange:true})});
        }
        get format(){const s=frameState(this);return s.closed?null:s.format;}
        get codedWidth(){const s=frameState(this);return s.closed?0:s.width;}
        get codedHeight(){const s=frameState(this);return s.closed?0:s.height;}
        get codedRect(){const s=frameState(this);return s.closed?null:{x:0,y:0,width:s.width,height:s.height};}
        get visibleRect(){const s=frameState(this);return s.closed?null:{...s.visible};}
        get displayWidth(){const s=frameState(this);return s.closed?0:s.displayWidth;}
        get displayHeight(){const s=frameState(this);return s.closed?0:s.displayHeight;}
        get timestamp(){return frameState(this).timestamp;}
        get duration(){return frameState(this).duration;}
        get colorSpace(){return frameState(this).colorSpace;}
        allocationSize(options={}) {
            const s=frameState(this);if(s.closed)throw new DOMException("VideoFrame is closed","InvalidStateError");
            return frameCopyPlan(s,options).length;
        }
        async copyTo(destination,options={}) {
            const s=frameState(this);if(s.closed)throw new DOMException("VideoFrame is closed","InvalidStateError");
            const {rect,format,offset,stride,length}=frameCopyPlan(s,options);
            const bytes=destination instanceof ArrayBuffer?new Uint8Array(destination):ArrayBuffer.isView(destination)?
                new Uint8Array(destination.buffer,destination.byteOffset,destination.byteLength):null;
            if(!bytes||length>bytes.length)
                throw new RangeError("VideoFrame destination plane exceeds supplied BufferSource");
            for(let y=0;y<rect.height;++y)for(let x=0;x<rect.width;++x){
                const src=((rect.y+y)*s.width+rect.x+x)*4,dst=offset+y*stride+x*4;
                bytes[dst]=s.pixels[src+(format===s.format?0:2)];bytes[dst+1]=s.pixels[src+1];
                bytes[dst+2]=s.pixels[src+(format===s.format?2:0)];bytes[dst+3]=s.pixels[src+3];
            }
            return [{offset,stride}];
        }
        clone(){return new VideoFrame(this);}
        close(){
            const s=frameState(this);
            if(s.closed)return;
            const externals=s.externals;
            s.closed=true;s.pixels=new Uint8Array(0);s.externals=new Set();
            if(externals)for(const external of externals)call(external,"externalExpire");
            externals?.clear();
        }
        metadata(){const s=frameState(this);if(s.closed)throw new DOMException("VideoFrame is closed","InvalidStateError");return {};}
    }
    class GPUCanvasContext {
        constructor(key) { if(key!==token)throw new TypeError("Illegal constructor"); }
        get canvas() { const s=canvasContexts.get(this);if(!s)throw new TypeError("Illegal GPUCanvasContext");return s.canvas; }
        configure(descriptor) {
            const s=canvasContexts.get(this);
            if(!s||s.media.closed)throw new DOMException("Canvas scope is closed","InvalidStateError");
            descriptor=dictionaryOverlay(dictionary(descriptor));
            state(descriptor.device,GPUDevice);
            const toneMapping=dictionaryOverlay(dictionary(descriptor.toneMapping));
            const mode=toneMapping.mode===undefined?"standard":domString(toneMapping.mode);
            if(mode!=="standard"&&mode!=="extended")throw new TypeError("Invalid GPUCanvasToneMappingMode");
            const configuration={device:descriptor.device,format:domString(descriptor.format),
                usage:descriptor.usage===undefined?GPUTextureUsage.RENDER_ATTACHMENT:enforcedInteger(descriptor.usage,4294967295),
                alphaMode:descriptor.alphaMode===undefined?"opaque":domString(descriptor.alphaMode),
                colorSpace:descriptor.colorSpace===undefined?"srgb":domString(descriptor.colorSpace),
                viewFormats:sequence(descriptor.viewFormats===undefined?[]:descriptor.viewFormats,domString),toneMapping:{mode}};
            const raw=call(configuration.device,"canvasConfigure",s.canvas,configuration);
            s.raw=wrap(raw,GPUCanvasContext,configuration.device);
            s.configuration=configuration;s.texture=null;s.generation=-1;
        }
        unconfigure() {
            const s=canvasContexts.get(this);if(!s)throw new TypeError("Illegal GPUCanvasContext");
            if(s.raw)call(s.raw,"canvasUnconfigure");
            s.raw=null;s.configuration=null;s.texture=null;
        }
        getConfiguration() {
            const s=canvasContexts.get(this);if(!s)throw new TypeError("Illegal GPUCanvasContext");
            return s.configuration?{...s.configuration,viewFormats:[...s.configuration.viewFormats],
                toneMapping:{...s.configuration.toneMapping}}:null;
        }
        getCurrentTexture() {
            const s=canvasContexts.get(this);
            if(!s||!s.raw||s.media.closed)throw new DOMException("Canvas is unconfigured or closed","InvalidStateError");
            let generation=call(s.raw,"canvasGeneration");
            if(!s.texture||generation!==s.generation){
                s.texture=wrap(call(s.raw,"canvasCurrentTexture"),GPUTexture,s.configuration.device);
                s.generation=call(s.raw,"canvasGeneration");
            }
            return s.texture;
        }
    }
    function copyExtent(value) {
        const method=value?.[Symbol.iterator];
        return method!==undefined&&method!==null?sequence(value,member=>member,method):value;
    }
    class GPUQueue extends GPUObjectBase {
        copyExternalImageToTexture(source,destination,size) { return copyExternalImage.call(this,source,destination,size); }
        writeBuffer(buffer, offset, data, dataOffset = 0, size) {
            state(this, GPUQueue);
            call(this, "writeBuffer", buffer, offset, data, dataOffset, size);
        }
        writeTexture(destination, data, layout, size) {
            state(this, GPUQueue);
            call(this, "writeTexture", destination, data, dictionary(layout), copyExtent(size));
        }
        submit(commands) { state(this, GPUQueue); call(this, "submit", sequence(commands)); }
        onSubmittedWorkDone() { state(this, GPUQueue); return call(this, "onSubmittedWorkDone"); }
    }
    class GPUShaderModule extends GPUObjectBase {
        async getCompilationInfo() {
            state(this, GPUShaderModule);
            const info = await call(this, "getCompilationInfo");
            return readonly(GPUCompilationInfo, {messages: Object.freeze(info.messages.map(message => readonly(GPUCompilationMessage, message)))});
        }
    }
    class GPUCompilationInfo { constructor() { throw new TypeError("Illegal constructor"); } }
    class GPUCompilationMessage { constructor() { throw new TypeError("Illegal constructor"); } }
    class GPUPipelineError extends DOMException {
        constructor(message, options) {
            options = required(options, ["reason"]);
            if (!["validation", "internal"].includes(options.reason)) throw new TypeError("Invalid GPUPipelineErrorReason");
            super(message, "GPUPipelineError");
            readonlyValues.set(this,{Type:GPUPipelineError,values:{reason:options.reason}});
        }
    }
    class GPUBindGroupLayout extends GPUObjectBase {}
    class GPUPipelineLayout extends GPUObjectBase {}
    class GPUQuerySet extends GPUObjectBase {
        get type(){state(this,GPUQuerySet);return call(this,"queryInfo").type;}
        get count(){state(this,GPUQuerySet);return call(this,"queryInfo").count;}
        destroy(){state(this,GPUQuerySet);call(this,"destroy");}
    }
    class GPUBindGroup extends GPUObjectBase {}
    class GPUComputePipeline extends GPUObjectBase {
        getBindGroupLayout(index) {
            state(this, GPUComputePipeline);
            return wrap(call(this, "getBindGroupLayout", index), GPUBindGroupLayout, state(this).owner);
        }
    }
    class GPURenderPipeline extends GPUObjectBase {
        getBindGroupLayout(index) {
            state(this, GPURenderPipeline);
            return wrap(call(this, "getBindGroupLayout", index), GPUBindGroupLayout, state(this).owner);
        }
    }
    class GPUCommandEncoder extends GPUObjectBase {
        clearBuffer(buffer,offset=0,size){state(this,GPUCommandEncoder);call(this,"clearBuffer",buffer,offset,size);}
        resolveQuerySet(query,first,count,buffer,offset){state(this,GPUCommandEncoder);call(this,"resolveQuerySet",query,first,count,buffer,offset);}
        beginRenderPass(descriptor) {
            state(this, GPUCommandEncoder); descriptor = sequenceFields(objectDescriptor(descriptor),{
                colorAttachments:colorAttachment});
            return wrap(call(this,"beginRenderPass",descriptor),GPURenderPassEncoder,this,descriptor.label||"");
        }
        beginComputePass(descriptor = {}) {
            state(this, GPUCommandEncoder);
            descriptor=objectDescriptor(descriptor);
            return wrap(call(this, "beginComputePass", descriptor), GPUComputePassEncoder, this, descriptor.label);
        }
        copyBufferToBuffer(source, destinationOrOffset, ...rest) {
            state(this, GPUCommandEncoder);
            if(resources.get(destinationOrOffset)?.type===GPUBuffer)
                call(this,"copyBufferToBuffer",source,0,destinationOrOffset,0,rest[0]);
            else {
                if(arguments.length<4)throw new TypeError("copyBufferToBuffer requires two buffers or two buffers and offsets");
                call(this,"copyBufferToBuffer",source,destinationOrOffset,rest[0],rest[1],rest[2]);
            }
        }
        copyTextureToBuffer(source, destination, size) {
            state(this, GPUCommandEncoder); call(this, "copyTextureToBuffer", source, destination, copyExtent(size));
        }
        copyBufferToTexture(source, destination, size) {
            state(this, GPUCommandEncoder); call(this, "copyBufferToTexture", source, destination, copyExtent(size));
        }
        copyTextureToTexture(source, destination, size) {
            state(this, GPUCommandEncoder); call(this, "copyTextureToTexture", source, destination, copyExtent(size));
        }
        finish(descriptor = {}) {
            state(this, GPUCommandEncoder); descriptor = objectDescriptor(descriptor);
            return wrap(call(this, "finish", descriptor), GPUCommandBuffer, state(this).owner, descriptor.label || "");
        }
    }
    class GPUComputePassEncoder extends GPUObjectBase {
        setPipeline(pipeline) { state(this, GPUComputePassEncoder); call(this, "setPipeline", pipeline); }
        setBindGroup(index, group, dynamicOffsets = [], start = 0, length) {
            state(this, GPUComputePassEncoder);
            call(this, "setBindGroup", index, group, convertDynamicOffsets(dynamicOffsets,start,length,arguments.length));
        }
        dispatchWorkgroups(x, y = 1, z = 1) { state(this, GPUComputePassEncoder); call(this, "dispatchWorkgroups", x, y, z); }
        dispatchWorkgroupsIndirect(buffer, offset) { state(this, GPUComputePassEncoder); call(this, "dispatchWorkgroupsIndirect", buffer, offset); }
        end() { state(this, GPUComputePassEncoder); call(this, "end"); }
    }
    class GPURenderPassEncoder extends GPUObjectBase {
        executeBundles(bundles){state(this,GPURenderPassEncoder);call(this,"executeBundles",Array.from(bundles));}
        beginOcclusionQuery(index){state(this,GPURenderPassEncoder);call(this,"beginOcclusionQuery",index);}
        endOcclusionQuery(){state(this,GPURenderPassEncoder);call(this,"endOcclusionQuery");}
        setPipeline(pipeline) { state(this,GPURenderPassEncoder);call(this,"setPipeline",pipeline); }
        setBindGroup(index,group,dynamicOffsets=[],start=0,length) {
            state(this,GPURenderPassEncoder);
            call(this,"setBindGroup",index,group,convertDynamicOffsets(dynamicOffsets,start,length,arguments.length));
        }
        setVertexBuffer(slot,buffer,offset=0,size) { state(this,GPURenderPassEncoder);call(this,"setVertexBuffer",slot,buffer,offset,size); }
        setIndexBuffer(buffer,format,offset=0,size) { state(this,GPURenderPassEncoder);call(this,"setIndexBuffer",buffer,format,offset,size); }
        draw(count,instances=1,first=0,firstInstance=0) { state(this,GPURenderPassEncoder);call(this,"draw",count,instances,first,firstInstance); }
        drawIndexed(count,instances=1,first=0,base=0,firstInstance=0) { state(this,GPURenderPassEncoder);call(this,"drawIndexed",count,instances,first,base,firstInstance); }
        drawIndirect(buffer,offset) { state(this,GPURenderPassEncoder);call(this,"drawIndirect",buffer,offset); }
        drawIndexedIndirect(buffer,offset) { state(this,GPURenderPassEncoder);call(this,"drawIndexedIndirect",buffer,offset); }
        setViewport(x,y,width,height,minDepth,maxDepth) { state(this,GPURenderPassEncoder);call(this,"setViewport",x,y,width,height,minDepth,maxDepth); }
        setScissorRect(x,y,width,height) { state(this,GPURenderPassEncoder);call(this,"setScissorRect",x,y,width,height); }
        setBlendConstant(color) { state(this,GPURenderPassEncoder);call(this,"setBlendConstant",gpuColor(color)); }
        setStencilReference(value) { state(this,GPURenderPassEncoder);call(this,"setStencilReference",value); }
        end() { state(this,GPURenderPassEncoder);call(this,"end"); }
    }
    class GPUCommandBuffer extends GPUObjectBase {}
    class GPURenderBundleEncoder extends GPUObjectBase {
        setPipeline(pipeline){state(this,GPURenderBundleEncoder);call(this,"setPipeline",pipeline);}
        setBindGroup(index,group,offsets=[],start=0,length){state(this,GPURenderBundleEncoder);
            call(this,"setBindGroup",index,group,convertDynamicOffsets(offsets,start,length,arguments.length));}
        setVertexBuffer(slot,buffer,offset=0,size){state(this,GPURenderBundleEncoder);call(this,"setVertexBuffer",slot,buffer,offset,size);}
        setIndexBuffer(buffer,format,offset=0,size){state(this,GPURenderBundleEncoder);call(this,"setIndexBuffer",buffer,format,offset,size);}
        draw(count,instances=1,first=0,firstInstance=0){state(this,GPURenderBundleEncoder);call(this,"draw",count,instances,first,firstInstance);}
        drawIndexed(count,instances=1,first=0,base=0,firstInstance=0){state(this,GPURenderBundleEncoder);call(this,"drawIndexed",count,instances,first,base,firstInstance);}
        drawIndirect(buffer,offset){state(this,GPURenderBundleEncoder);call(this,"drawIndirect",buffer,offset);}
        drawIndexedIndirect(buffer,offset){state(this,GPURenderBundleEncoder);call(this,"drawIndexedIndirect",buffer,offset);}
        finish(descriptor={}){state(this,GPURenderBundleEncoder);descriptor=objectDescriptor(descriptor);
            return wrap(call(this,"finish",descriptor),GPURenderBundle,state(this).owner,descriptor.label||"");}
    }
    class GPURenderBundle extends GPUObjectBase {}
    for(const Type of [GPUCommandEncoder,GPUComputePassEncoder,GPURenderPassEncoder,GPURenderBundleEncoder])
        for(const name of ["insertDebugMarker","pushDebugGroup","popDebugGroup"])
            Object.defineProperty(Type.prototype,name,{value:function(...args){state(this,Type);call(this,name,...args);},writable:true,configurable:true});
    for(const Type of [GPUComputePassEncoder,GPURenderPassEncoder,GPURenderBundleEncoder])
        Object.defineProperty(Type.prototype,"setImmediates",{value:function(offset,data,dataOffset=0,size){
            state(this,Type);call(this,"setImmediates",offset,data,dataOffset,size);
        },writable:true,configurable:true});
    class GPUError {
        constructor(message,key) {
            if(key!==token)throw new TypeError("Illegal constructor");
            gpuErrors.set(this,String(message));
        }
        get message(){if(!gpuErrors.has(this))throw new TypeError("Illegal GPUError receiver");return gpuErrors.get(this);}
    }
    class GPUValidationError extends GPUError { constructor(message){if(!arguments.length)throw new TypeError("Message is required");super(message,token);} }
    class GPUOutOfMemoryError extends GPUError { constructor(message){if(!arguments.length)throw new TypeError("Message is required");super(message,token);} }
    class GPUInternalError extends GPUError { constructor(message){if(!arguments.length)throw new TypeError("Message is required");super(message,token);} }
    function deviceLostInfo(value){const s=deviceLostInfos.get(value);if(!s)throw new TypeError("Illegal GPUDeviceLostInfo receiver");return s;}
    class GPUDeviceLostInfo {
        constructor(){throw new TypeError("Illegal constructor");}
        get reason(){return deviceLostInfo(this).reason;}
        get message(){return deviceLostInfo(this).message;}
    }
    class GPUUncapturedErrorEvent extends Event {
        constructor(type,init) {
            if(arguments.length<2)throw new TypeError("GPUUncapturedErrorEvent requires an error dictionary");
            init=required(init,["error"]);
            if(!gpuErrors.has(init.error))throw new TypeError("Expected a genuine GPUError");
            super(type,init);eventState(this).error=init.error;
        }
        get error(){const s=eventState(this);if(!s.error)throw new TypeError("Illegal GPUUncapturedErrorEvent receiver");return s.error;}
    }
    function gpuError(value) {
        return new (value.type === 2 ? GPUValidationError : value.type === 3 ? GPUOutOfMemoryError : GPUInternalError)(value.message);
    }
    class GPU {
        constructor(key) {
            if (key !== token) throw new TypeError("Illegal constructor");
            resources.set(this, {type: GPU});
        }
        async requestAdapter(options = {}) {
            state(this, GPU);
            options=dictionary(options);
            const level=options.featureLevel===undefined?"core":String(options.featureLevel);
            if(level!=="core"&&level!=="compatibility")return null;
            if(options.xrCompatible)return null;
            const converted=dictionaryOverlay(options);
            Object.defineProperty(converted,"featureLevel",{value:level});
            const handle = await call(null, "requestAdapter", converted);
            if (!handle) return null;
            const adapter = wrap(handle, GPUAdapter);
            state(adapter).info=capabilities(adapter);
            return adapter;
        }
        getPreferredCanvasFormat() { state(this, GPU); return "bgra8unorm"; }
        get wgslLanguageFeatures() {
            const s=state(this,GPU);
            if(!s.languageFeatures)s.languageFeatures=new WGSLLanguageFeatures(token,call(null,"languageFeatures"));
            return s.languageFeatures;
        }
    }
    const globals = {Event,EventTarget,GPU, GPUAdapter, GPUDevice, GPUBuffer, GPUTexture, GPUTextureView, GPUSampler, GPUExternalTexture, GPUCanvasContext, VideoFrame, VideoColorSpace, GPUQueue, GPUShaderModule,
        GPUBindGroupLayout, GPUPipelineLayout, GPUBindGroup, GPUQuerySet, GPUComputePipeline, GPURenderPipeline, GPUCommandEncoder,
        GPUComputePassEncoder, GPURenderPassEncoder, GPUCommandBuffer, GPURenderBundleEncoder, GPURenderBundle, GPUSupportedFeatures, WGSLLanguageFeatures, GPUSupportedLimits, GPUAdapterInfo,
        GPUCompilationInfo, GPUCompilationMessage, GPUPipelineError, GPUError, GPUValidationError, GPUOutOfMemoryError, GPUInternalError,GPUDeviceLostInfo,GPUUncapturedErrorEvent};
    const readonlyAttributes={
        GPUSupportedLimits:["maxTextureDimension1D","maxTextureDimension2D","maxTextureDimension3D","maxTextureArrayLayers",
            "maxBindGroups","maxBindGroupsPlusVertexBuffers","maxImmediateSize","maxBindingsPerBindGroup",
            "maxDynamicUniformBuffersPerPipelineLayout","maxDynamicStorageBuffersPerPipelineLayout","maxSampledTexturesPerShaderStage",
            "maxSamplersPerShaderStage","maxStorageBuffersPerShaderStage","maxStorageBuffersInVertexStage","maxStorageBuffersInFragmentStage",
            "maxStorageTexturesPerShaderStage","maxStorageTexturesInVertexStage","maxStorageTexturesInFragmentStage","maxUniformBuffersPerShaderStage",
            "maxUniformBufferBindingSize","maxStorageBufferBindingSize","minUniformBufferOffsetAlignment","minStorageBufferOffsetAlignment",
            "maxVertexBuffers","maxBufferSize","maxVertexAttributes","maxVertexBufferArrayStride","maxInterStageShaderVariables",
            "maxColorAttachments","maxColorAttachmentBytesPerSample","maxComputeWorkgroupStorageSize","maxComputeInvocationsPerWorkgroup",
            "maxComputeWorkgroupSizeX","maxComputeWorkgroupSizeY","maxComputeWorkgroupSizeZ","maxComputeWorkgroupsPerDimension"],
        GPUAdapterInfo:["vendor","architecture","device","description","subgroupMinSize","subgroupMaxSize","isFallbackAdapter"],
        GPUCompilationInfo:["messages"],
        GPUCompilationMessage:["message","type","lineNum","linePos","offset","length"],
        GPUPipelineError:["reason"],
    };
    for(const [name,attributes] of Object.entries(readonlyAttributes)){
        const Type=globals[name];
        for(const attribute of attributes)Object.defineProperty(Type.prototype,attribute,{enumerable:true,configurable:true,get(){
            const record=readonlyValues.get(this);
            if(record?.Type!==Type)throw new TypeError("Illegal "+name+" receiver");
            if(!(attribute in record.values))throw new Error("Native WebGPU result omitted "+attribute);
            return record.values[attribute];
        }});
    }
    for(const Type of Object.values(globals))if(GPUObjectBase.prototype.isPrototypeOf(Type.prototype))
        Object.defineProperty(Type.prototype,"label",{enumerable:true,configurable:true,
            get(){return state(this,Type).label;},
            set(value){const s=state(this,Type);value=domString(value);
                call(this,"setLabel",value);s.label=value;}});
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(value.prototype, Symbol.toStringTag, {value: name, configurable: true});
        Object.defineProperty(globalThis, name, {value, writable: true, configurable: true});
    }
    for (const [name, values] of Object.entries({
        GPUBufferUsage: {MAP_READ:1, MAP_WRITE:2, COPY_SRC:4, COPY_DST:8, INDEX:16, VERTEX:32, UNIFORM:64, STORAGE:128, INDIRECT:256, QUERY_RESOLVE:512},
        GPUTextureUsage: {COPY_SRC:1, COPY_DST:2, TEXTURE_BINDING:4, STORAGE_BINDING:8, RENDER_ATTACHMENT:16,TRANSIENT_ATTACHMENT:32},
        GPUShaderStage: {VERTEX:1, FRAGMENT:2, COMPUTE:4}, GPUMapMode: {READ:1, WRITE:2},
        GPUColorWrite: {RED:1, GREEN:2, BLUE:4, ALPHA:8, ALL:15},
    })) Object.defineProperty(globalThis, name, {value: Object.freeze(values), configurable: true});
    if (!globalThis.navigator) globalThis.navigator = {};
    Object.defineProperty(globalThis.navigator, "gpu", {value: new GPU(token), configurable: true, enumerable: true});
    const createCanvas=(canvas,media)=>{
        const context=new GPUCanvasContext(token);
        canvasContexts.set(context,{canvas,media,raw:null,configuration:null,texture:null,generation:-1});
        media.shutdown=()=>context.unconfigure();
        return context;
    };
    createCanvas.framePixels=value=>videoFrames.has(value)?ownedFramePixels(value):null;
    createCanvas.setImageSource=getter=>{imageSourceSnapshot=getter;};
    createCanvas.setAbortSignalValidator=validator=>{isAbortSignal=validator;};
    return createCanvas;
})
