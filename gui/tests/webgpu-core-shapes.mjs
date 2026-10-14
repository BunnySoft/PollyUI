function check(value,message){if(!value)throw Error(message);}
function rejects(fn,label){let error;try{fn();}catch(value){error=value;}check(error instanceof TypeError,label);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
const receiverDescriptor={usage:GPUBufferUsage.COPY_DST,
    get size(){return this===receiverDescriptor?16:4;},
    get unknownGetter(){throw Error("Unknown dictionary members must not be read");}};
check(device.createBuffer(receiverDescriptor).size===16,"shared dictionary conversion preserves original getter receiver without enumerating unknown fields");
const source=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,label:0});
check(source.label==="0","native descriptor label preserves non-string falsy value conversion");
device.queue.writeBuffer(source,0,new Uint32Array([3,7,11,13]));
const destination=device.createBuffer({size:32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
async function words(buffer){await buffer.mapAsync(GPUMapMode.READ);const result=[...new Uint32Array(buffer.getMappedRange())];buffer.unmap();return result;}
for(const [args,expected,offset] of [
    [[source,destination],[3,7,11,13],0],
    [[source,destination,8],[3,7],0],
    [[source,4,destination,8],[7,11,13],2],
    [[source,4,destination,4,4],[7],1],
]){
    device.pushErrorScope("validation");const encoder=device.createCommandEncoder();
    encoder.copyBufferToBuffer(...args);device.queue.submit([encoder.finish()]);
    check((await words(destination)).slice(offset,offset+expected.length).join()===expected.join(),"actual buffer-copy overload data "+args.length);
    check(await device.popErrorScope()===null,"native buffer-copy overload validation "+args.length);
}
rejects(()=>device.createBindGroupLayout({entries:[{visibility:GPUShaderStage.COMPUTE,buffer:{}}]}),"required binding is not silently zero");
rejects(()=>device.createBindGroupLayout({entries:[{binding:0,buffer:{}}]}),"required visibility is not silently zero");
rejects(()=>device.createBindGroupLayout({entries:{length:0}}),"WebIDL sequence rejects noniterable array-like object");
const alignment=device.limits.minUniformBufferOffsetAlignment;
const uniform=device.createBuffer({size:alignment+16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(uniform,alignment,new Uint32Array([17,0,0,0]));
const storage=device.createBuffer({size:4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
const read=device.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const layout=device.createBindGroupLayout({entries:new Set([
    {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"uniform",hasDynamicOffset:true}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}},
])});
const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:new Set([null,layout])});
const module=device.createShaderModule({code:`
@group(1) @binding(0) var<uniform> input:vec4u;
@group(1) @binding(1) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(1) fn main(){output[0]=input.x;}
`,compilationHints:new Set([{entryPoint:"main",layout:pipelineLayout}])});
const pipeline=device.createComputePipeline({layout:pipelineLayout,compute:{module,entryPoint:"main"}});
const group=device.createBindGroup({layout,entries:new Set([
    {binding:0,resource:{buffer:uniform,size:16}},{binding:1,resource:storage},
])});
device.pushErrorScope("validation");
const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
pass.setPipeline(pipeline);
const backing=new Uint32Array([99,99,0,alignment,99]),view=backing.subarray(2,4);
rejects(()=>pass.setBindGroup(1,group,view,1),"typed overload requires a length argument");
const forged=Object.create(Uint32Array.prototype);forged.subarray=()=>new Uint32Array([alignment]);
rejects(()=>pass.setBindGroup(1,group,forged,0,1),"typed offsets use intrinsic Uint32Array brand");
pass.setBindGroup(1,group,view,1.9,1.9);
let speciesReads=0,iteratorReads=0;
class Offsets extends Uint32Array {
    static get [Symbol.species](){++speciesReads;return Uint8Array;}
    get [Symbol.iterator](){++iteratorReads;throw Error("Typed offsets must not iterate");}
}
pass.setBindGroup(1,group,new Offsets([99,alignment,99]),1,1);
rejects(()=>pass.dispatchWorkgroups(),"required workgroup count does not default to zero");
pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(storage,read);device.queue.submit([encoder.finish()]);
check((await words(read))[0]===17,"actual sparse layout, iterable entries, direct buffer binding and view-relative fractional offsets");
check(speciesReads===0&&iteratorReads===0,"typed BufferSource element copy avoids species and iterator hooks");
check(await device.popErrorScope()===null,"valid sparse/dynamic native compute path");
const texture=device.createTexture({size:[2,2],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
const depth=device.createTexture({size:[2,2],format:"depth24plus",usage:GPUTextureUsage.RENDER_ATTACHMENT});
let colorIteratorReads=0;
const oneShotColor={get [Symbol.iterator](){
    if(++colorIteratorReads!==1)throw Error("GPUColor iterator queried twice");
    return function*(){yield 1;yield 0;yield 0;yield 1;};
}};
const clear=device.createCommandEncoder(),render=clear.beginRenderPass({colorAttachments:new Set([
    {view:texture,loadOp:"clear",storeOp:"store",clearValue:oneShotColor}]),
    depthStencilAttachment:{view:depth,depthLoadOp:"clear",depthStoreOp:"store",depthClearValue:1}});
render.end();device.queue.submit([clear.finish()]);
const sampling=device.createShaderModule({code:`
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(1) fn main(){output[0]=u32(textureLoad(image,vec2i(0),0).r*255);}
`});
const samplingPipeline=device.createComputePipeline({layout:"auto",compute:{module:sampling,entryPoint:"main"}});
const samplingGroup=device.createBindGroup({layout:samplingPipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:texture},{binding:1,resource:storage}]});
const sample=device.createCommandEncoder(),compute=sample.beginComputePass();
compute.setPipeline(samplingPipeline);compute.setBindGroup(0,samplingGroup);compute.dispatchWorkgroups(1);compute.end();
sample.copyBufferToBuffer(storage,read);device.queue.submit([sample.finish()]);
check((await words(read))[0]===255,"actual color/depth GPUTexture attachment union and direct texture binding sample");
check(colorIteratorReads===1,"GPUColor union obtains its iterator method only once");
const canvas=document.createElement("canvas");canvas.width=canvas.height=2;
const context=canvas.getContext("webgpu"),mode={mode:"extended"};
context.configure({device,format:"rgba8unorm",toneMapping:mode});mode.mode="bad";
const configuration=context.getConfiguration();check(configuration.toneMapping.mode==="extended","configure captures valid normalized tone-mapping value");
configuration.toneMapping.mode="bad";check(context.getConfiguration().toneMapping.mode==="extended","getConfiguration returns independent tone-mapping copies");
const reads=new Map(),conversions=new Map();
function field(name,value){return {toString(){conversions.set(name,(conversions.get(name)??0)+1);return value;}};}
const configuredValues={device,format:field("format","rgba8unorm"),usage:"16.9",
    alphaMode:field("alpha","premultiplied"),colorSpace:field("color","srgb"),
    viewFormats:new Set([field("view","rgba8unorm")]),toneMapping:{mode:field("tone","standard")}};
const receiverConfiguration={get unknown(){throw Error("Unknown canvas dictionary field must not be enumerated");}};
for(const name of Object.keys(configuredValues))Object.defineProperty(receiverConfiguration,name,{get(){
    check(this===receiverConfiguration,"canvas dictionary getters retain their original receiver");
    reads.set(name,(reads.get(name)??0)+1);return configuredValues[name];
}});
context.configure(receiverConfiguration);
const normalized=context.getConfiguration();
check(normalized.format==="rgba8unorm"&&normalized.usage===16&&normalized.alphaMode==="premultiplied"&&
    normalized.colorSpace==="srgb"&&normalized.viewFormats[0]==="rgba8unorm"&&normalized.toneMapping.mode==="standard",
    "canvas configuration captures converted IDL values, not original descriptor objects");
check([...reads.values()].every(value=>value===1)&&[...conversions.values()].every(value=>value===1),
    "canvas dictionary getters and string conversion hooks are each invoked once");
normalized.viewFormats[0]="bad";
check(context.getConfiguration().viewFormats[0]==="rgba8unorm","configuration sequence copies do not alias captured values");
for(const [name,value] of [["format",Symbol()],["alphaMode",Symbol()],["colorSpace",Symbol()],
    ["usage",Symbol()],["viewFormats",[Symbol()]],["toneMapping",{mode:Symbol()}]]){
    rejects(()=>context.configure({device,format:"rgba8unorm",[name]:value}),"canvas "+name+" rejects Symbol conversion");
    check(context.getConfiguration().usage===16,"failed conversion preserves prior configuration");
}
rejects(()=>context.configure({device,format:"rgba8unorm",toneMapping:{mode:"INVALID"}}),"invalid tone-mapping enum rejected");
const target=new EventTarget(),handler=Object.getOwnPropertyDescriptor(GPUDevice.prototype,"onuncapturederror");
rejects(()=>handler.get.call(target),"GPUDevice handler getter enforces its own brand");
rejects(()=>handler.set.call(target,()=>{}),"GPUDevice handler setter enforces its own brand");
const multisample=device.createTexture({size:[2,2],format:"rgba8unorm",sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT});
const rasterCanvas=document.createElement("canvas");rasterCanvas.width=rasterCanvas.height=2;
const raster=rasterCanvas.getContext("2d");
for(const [color,expected] of [[[0,0,1,1],"0,0,255,255"],[[0,1,0,1],"0,255,0,255"]]){
    const resolve=device.createCommandEncoder(),rp=resolve.beginRenderPass({colorAttachments:[
        {view:multisample,resolveTarget:context.getCurrentTexture(),loadOp:"clear",storeOp:"store",clearValue:color}]});
    rp.end();device.queue.submit([resolve.finish()]);raster.clearRect(0,0,2,2);raster.drawImage(canvas,0,0);
    check([...raster.getImageData(0,0,1,1).data].join()===expected,"actual MSAA resolve target advances canvas snapshot "+expected);
}
for(const [name,value] of [["format",Symbol()],["alphaMode",Symbol()],["colorSpace",Symbol()],
    ["usage",Symbol()],["viewFormats",[Symbol()]],["toneMapping",{mode:Symbol()}],["usage",48]]){
    rejects(()=>context.configure({device,format:"rgba8unorm",[name]:value}),"failed canvas conversion retains completed frame");
    raster.clearRect(0,0,2,2);raster.drawImage(canvas,0,0);
    check(context.getConfiguration().usage===16&&[...raster.getImageData(0,0,1,1).data].join()==="0,255,0,255",
        "failed "+name+" configuration preserves canonical state and actual green canvas pixels");
}
context.unconfigure();device.destroy();await device.lost;globalThis.webgpuTestsDone=true;
console.log("WEBGPU_CORE_SHAPES copyOverloads2_3_4_5=true sparseIterablesDynamic17=true textureUnion255=true resolveCanvas=true handlerToneBrand=true canonicalConfigGetConvertOnce=true failedConfigRetainsGreen=true");
