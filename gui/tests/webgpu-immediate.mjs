function check(value,message){if(!value)throw Error(message);}
const language=navigator.gpu.wgslLanguageFeatures;
check(language===navigator.gpu.wgslLanguageFeatures&&language instanceof WGSLLanguageFeatures,
    "actual native WGSL feature query has SameObject setlike surface");
for(const value of language)check(language.has(value)&&/^[a-z0-9_]+$/.test(value),"canonical native WGSL feature");
const adapter=await navigator.gpu.requestAdapter();
console.log("WEBGPU_IMMEDIATE_CAPABILITIES",JSON.stringify({language:[...language],maxImmediateSize:adapter.limits.maxImmediateSize}));
check(adapter.limits.maxImmediateSize>=4,"qualification adapter supports a real positive immediate-data case");
const device=await adapter.requestDevice({requiredLimits:{maxImmediateSize:4}});
device.pushErrorScope("validation");
const module=device.createShaderModule({code:`
var<immediate> value:u32;
@group(0) @binding(0) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(1) fn main(){output[0]=value;}
`});
const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:"storage"}}]});
const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout],immediateSize:4});
const pipeline=device.createComputePipeline({layout:pipelineLayout,compute:{module,entryPoint:"main"}});
const output=device.createBuffer({size:4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
const read=device.createBuffer({size:4,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
const group=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:output}}]});
const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
pass.setPipeline(pipeline);pass.setBindGroup(0,group);
pass.setImmediates(0,new Uint32Array([90,1234,91]),1,1);pass.dispatchWorkgroups(1);pass.end();
encoder.copyBufferToBuffer(output,0,read,0,4);device.queue.submit([encoder.finish()]);
await read.mapAsync(GPUMapMode.READ);check(new Uint32Array(read.getMappedRange())[0]===1234,"real immediate WGSL value and view-relative data offsets");
read.unmap();check(await device.popErrorScope()===null,"real immediate dispatch native validation");
device.destroy();await device.lost;globalThis.webgpuTestsDone=true;
console.log("WEBGPU_IMMEDIATE actualWGSL1234=true nativeLanguageFeatures=true");
