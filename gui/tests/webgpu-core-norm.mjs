function check(value,message){if(!value)throw Error(message);}
function rejects(fn,label){let error;try{fn();}catch(value){error=value;}check(error instanceof TypeError,label);}
const adapter=await navigator.gpu.requestAdapter();
let unknownLimit,betterLimit;
try{await adapter.requestDevice({requiredLimits:{unknownLimit:1}});}catch(error){unknownLimit=error;}
try{await adapter.requestDevice({requiredLimits:{maxTextureDimension2D:4294967296}});}catch(error){betterLimit=error;}
check(unknownLimit?.name==="OperationError"&&betterLimit?.name==="OperationError",
    "recognized uint64 required-limit values use capability OperationError, not silent ignore or uint32 TypeError");
check(await navigator.gpu.requestAdapter({featureLevel:"not-a-level"})===null,
    "unsupported DOMString featureLevel returns no adapter without pretending native support");
const features=adapter.features.has("texture-component-swizzle")?["texture-component-swizzle"]:[];
const device=await adapter.requestDevice({requiredFeatures:features});
rejects(()=>device.queue.submit(""),"sequence requires an object, not primitive empty string");
rejects(()=>device.createBindGroupLayout({entries:""}),"dictionary sequences reject primitive iterable strings");
rejects(()=>{device.label=Symbol();},"GPUDevice label rejects Symbol USVString input");
rejects(()=>device.features.has(),"setlike has enforces required argument arity");
const maximumFloat=3.4028234663852886e38;
device.createSampler({lodMaxClamp:maximumFloat*(1+1e-8)});
rejects(()=>device.createSampler({lodMaxClamp:maximumFloat*2}),"finite-to-float overflow after nearest-even rounding");
for(const [Type,name] of [[GPUAdapter,"features"],[GPUDevice,"queue"],[GPUSupportedLimits,"maxBufferSize"],
    [GPUAdapterInfo,"description"],[GPUCompilationInfo,"messages"],[GPUCompilationMessage,"type"],[GPUPipelineError,"reason"]])
    rejects(()=>Object.getOwnPropertyDescriptor(Type.prototype,name).get.call({}),"readonly "+Type.name+"."+name+" has its own brand");
const language=navigator.gpu.wgslLanguageFeatures;
check(!(language instanceof GPUSupportedFeatures),"independent WGSL and device feature interfaces");
rejects(()=>GPUSupportedFeatures.prototype.has.call(language,"x"),"setlike receiver cannot cross unrelated feature brands");
rejects(()=>device.features.forEach(1),"setlike callback validation even when there are no features");
const shader=device.createShaderModule({code:"@compute @workgroup_size(1) fn main() {}"});
const info=await shader.getCompilationInfo();check(Object.isFrozen(info.messages),"compilation messages are a true FrozenArray");
rejects(()=>device.createShaderModule({code:"",compilationHints:[{}]}),"compilation hint requires entryPoint");
rejects(()=>device.createShaderModule({code:"",compilationHints:[{entryPoint:"main",layout:"AUTO"}]}),"compilation hint layout enum is canonical");
const texture=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
check(texture.textureBindingViewDimension===(device.features.has("core-features-and-limits")?undefined:"2d"),
    "binding view dimension reflects actual native core/compatibility texture metadata");
device.queue.writeTexture({texture},new Uint8Array([255,64,32,128]),{},[1,1]);
device.pushErrorScope("validation");
const bad=texture.createView({swizzle:"bad"});
check(bad instanceof GPUTextureView&&await device.popErrorScope() instanceof GPUValidationError,
    "malformed DOMString swizzle returns native error view and actual GPUValidationError");
if(features.length){
    device.pushErrorScope("validation");
    const view=texture.createView({swizzle:"bgra"});
    const code=device.createShaderModule({code:`
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4u>;
@compute @workgroup_size(1) fn main(){output[0]=vec4u(round(textureLoad(source,vec2i(0),0)*255));}
`});
    const pipeline=device.createComputePipeline({layout:"auto",compute:{module:code,entryPoint:"main"}});
    const storage=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const read=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:view},{binding:1,resource:storage}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    encoder.copyBufferToBuffer(storage,read);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    check([...new Uint32Array(read.getMappedRange())].join()==="32,64,255,128","real native component swizzle changes WGSL sample channels");
    read.unmap();check(await device.popErrorScope()===null,"valid feature-enabled swizzle native path");
}
const renderTexture=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT});
check(GPUTextureUsage.TRANSIENT_ATTACHMENT===32,"pinned standard transient attachment usage flag");
device.pushErrorScope("validation");
const transient=device.createTexture({size:[1,1],format:"rgba8unorm",sampleCount:4,
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TRANSIENT_ATTACHMENT});
check(transient.usage===48,"logical transient usage survives ordinary native allocation");
const resolved=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const transientRead=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const transientEncoder=device.createCommandEncoder(),transientPass=transientEncoder.beginRenderPass({colorAttachments:[
    {view:transient,resolveTarget:resolved,loadOp:"clear",storeOp:"discard",clearValue:[0,1,0,1]}]});
transientPass.end();transientEncoder.copyTextureToBuffer({texture:resolved},{buffer:transientRead,bytesPerRow:256},[1,1]);
device.queue.submit([transientEncoder.finish()]);await transientRead.mapAsync(GPUMapMode.READ);
check([...new Uint8Array(transientRead.getMappedRange()).slice(0,4)].join()==="0,255,0,255",
    "actual transient MSAA attachment resolves real green pixels");
transientRead.unmap();check(await device.popErrorScope()===null,"standard transient hint works with native or ordinary allocation");
for(const invalid of [
    {usage:GPUTextureUsage.TRANSIENT_ATTACHMENT},
    {usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TRANSIENT_ATTACHMENT|GPUTextureUsage.COPY_SRC},
    {usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TRANSIENT_ATTACHMENT,viewFormats:["rgba8unorm-srgb"]},
    {usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TRANSIENT_ATTACHMENT,mipLevelCount:2},
    {usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TRANSIENT_ATTACHMENT,size:[2,2,2]},
    {usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TRANSIENT_ATTACHMENT,dimension:"1d",size:[2]},
]){
    device.pushErrorScope("validation");const invalidTexture=device.createTexture({size:[2,2],format:"rgba8unorm",...invalid});
    check(await device.popErrorScope() instanceof GPUValidationError,"transient texture constraints use real native validation");
    device.pushErrorScope("validation");invalidTexture.createView();
    check(await device.popErrorScope() instanceof GPUValidationError,"invalid transient texture is a genuine native error texture");
}
for(const usage of [GPUTextureUsage.RENDER_ATTACHMENT,GPUTextureUsage.TRANSIENT_ATTACHMENT]){
    device.pushErrorScope("validation");const invalidView=transient.createView({usage});
    check(await device.popErrorScope() instanceof GPUValidationError,"explicit transient view usage cannot narrow logical texture usage");
    device.pushErrorScope("validation");
    const invalid=device.createCommandEncoder(),rp=invalid.beginRenderPass({colorAttachments:[
        {view:invalidView,loadOp:"clear",storeOp:"discard"}]});
    rp.end();invalid.finish();
    check(await device.popErrorScope() instanceof GPUValidationError,"invalid transient view is a genuine native error view");
}
device.pushErrorScope("validation");
const explicitTransientView=transient.createView({usage:transient.usage});
const validViewEncoder=device.createCommandEncoder(),validViewPass=validViewEncoder.beginRenderPass({colorAttachments:[
    {view:explicitTransientView,loadOp:"clear",storeOp:"discard"}]});
validViewPass.end();device.queue.submit([validViewEncoder.finish()]);
check(await device.popErrorScope()===null,"explicit full transient view usage remains valid");
for(const [loadOp,storeOp] of [["load","discard"],["clear","store"]]){
    device.pushErrorScope("validation");
    const invalid=device.createCommandEncoder(),rp=invalid.beginRenderPass({colorAttachments:[
        {view:transient,loadOp,storeOp}]});
    rp.end();const invalidCommands=invalid.finish();
    check(await device.popErrorScope() instanceof GPUValidationError,"transient pass load/store constraints use real native validation");
    device.pushErrorScope("validation");device.queue.submit([invalidCommands]);
    check(await device.popErrorScope() instanceof GPUValidationError,"transient pass failure produces a native invalid command buffer, not just an injected notification");
}
device.pushErrorScope("validation");
const transientDestination=device.createTexture({size:[1,1],format:"rgba8unorm",usage:48});
const resolveEncoder=device.createCommandEncoder(),resolvePass=resolveEncoder.beginRenderPass({colorAttachments:[
    {view:transient,resolveTarget:transientDestination,loadOp:"clear",storeOp:"discard"}]});
resolvePass.end();resolveEncoder.finish();
check(await device.popErrorScope() instanceof GPUValidationError,"transient resolve destination invalidates native encoder");
const depthStencil=device.createTexture({size:[1,1],format:"depth24plus-stencil8",usage:48});
device.pushErrorScope("validation");
const depthEncoder=device.createCommandEncoder(),depthPass=depthEncoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{
    view:depthStencil.createView({usage:48}),depthLoadOp:"clear",depthStoreOp:"discard",depthClearValue:1,
    stencilLoadOp:"clear",stencilStoreOp:"discard"}});
depthPass.end();device.queue.submit([depthEncoder.finish()]);
check(await device.popErrorScope()===null,"valid transient depth-stencil attachment uses native clear/discard");
for(const invalid of [{depthLoadOp:"load"},{depthStoreOp:"store"},{stencilLoadOp:"load"},{stencilStoreOp:"store"}]){
    device.pushErrorScope("validation");
    const invalidEncoder=device.createCommandEncoder(),rp=invalidEncoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{
        view:depthStencil,depthLoadOp:"clear",depthStoreOp:"discard",depthClearValue:1,
        stencilLoadOp:"clear",stencilStoreOp:"discard",...invalid}});
    rp.end();invalidEncoder.finish();
    check(await device.popErrorScope() instanceof GPUValidationError,"transient depth/stencil clear-discard rules invalidate native encoder");
}
console.log("WEBGPU_TRANSIENT logicalUsage="+transient.usage+" resolvePixels=0,255,0,255 errorTextureReuse=true errorViewReuse=true invalidCommandSubmit=true depthStencilRules=true");
const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:renderTexture,loadOp:"clear",storeOp:"store"}]});
rejects(()=>pass.drawIndexed(3,1,0,4294967296),"signed baseVertex is EnforceRange, not wrapping int32");
rejects(()=>pass.setViewport(0,0,1e100,1,0,1),"float32 overflow is WebIDL TypeError before native validation");
rejects(()=>pass.setBlendConstant(),"required GPUColor cannot silently become zero");
pass.end();device.queue.submit([encoder.finish()]);
const canvas=document.createElement("canvas");canvas.width=canvas.height=1;
const context=canvas.getContext("webgpu");
rejects(()=>context.configure({device,format:"rgba8unorm",viewFormats:{length:0}}),"canvas viewFormats requires a true object iterable");
rejects(()=>context.configure({device,format:"rgba8unorm",usage:48}),"canvas transient usage is a synchronous TypeError");
device.pushErrorScope("validation");context.configure({device,format:"rgba8unorm",usage:0});
check(await device.popErrorScope() instanceof GPUValidationError,"configure validates native usage before getCurrentTexture or later task");
context.unconfigure();
const colors=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const pixels=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
for(const [color,expected] of [[new Float32Array([1,0,0,1]),"255,0,0,255"],[new Set([1,0,.5,.25]),"255,0,128,64"]]){
    const copy=device.createCommandEncoder(),rp=copy.beginRenderPass({colorAttachments:[{view:colors,loadOp:"clear",storeOp:"store",clearValue:color}]});
    rp.end();copy.copyTextureToBuffer({texture:colors},{buffer:pixels,bytesPerRow:256},[1,1]);device.queue.submit([copy.finish()]);
    await pixels.mapAsync(GPUMapMode.READ);
    check([...new Uint8Array(pixels.getMappedRange()).slice(0,4)].join()===expected,"GPUColor iterable produces actual native pixels "+expected);
    pixels.unmap();
}
const buffer=device.createBuffer({size:8,usage:GPUBufferUsage.COPY_DST});
rejects(()=>device.queue.writeBuffer(buffer,undefined,new Uint32Array([7])),"required queue offset cannot silently become zero");
device.destroy();await device.lost;globalThis.webgpuTestsDone=true;
console.log("WEBGPU_CORE_NORM readonlyBrands=true independentSets=true hints=true nativeSwizzle="+features.length+" signedFloatRequired=true");
