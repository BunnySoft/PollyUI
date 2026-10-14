function check(value,message){if(!value)throw Error(message);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
const canvas=document.createElement("canvas");canvas.width=4;canvas.height=4;
const context=canvas.getContext("webgpu");context.configure({device,format:"rgba8unorm"});
const buffer=device.createBuffer({size:4096,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
device.queue.writeBuffer(buffer,0,new Uint32Array([123]));
const module=device.createShaderModule({code:"@compute @workgroup_size(1) fn main() {}"});
let late=0;
const map=buffer.mapAsync(GPUMapMode.READ).then(()=>++late,()=>++late);
const pipeline=device.createComputePipelineAsync({layout:"auto",compute:{module,entryPoint:"main"}}).then(()=>++late,()=>++late);
device.pushErrorScope("validation");device.createBuffer({size:4,usage:0});
const scope=device.popErrorScope().then(()=>++late,()=>++late);
const submitted=device.queue.onSubmittedWorkDone().then(()=>++late,()=>++late);
const frame=new VideoFrame(new Uint8Array([255,0,0,255]),{format:"RGBA",codedWidth:1,codedHeight:1,timestamp:0});
const clone=frame.clone();
const external=device.importExternalTexture({source:frame});
globalThis.retainedGpuShutdown={adapter,device,buffer,module,canvas,context,map,pipeline,scope,submitted};
closeGpuForTest();
await Promise.resolve();
check(late===0,"no GUI promise callback after native producer/VM shutdown");
context.unconfigure();
frame.close();check(frame.format===null,"owned frame can close and expire native external after producer shutdown");
frame.close();const cloneBytes=new Uint8Array(4);await clone.copyTo(cloneBytes);
check([...cloneBytes].join()==="255,0,0,255","independent CPU frame clone survives GPU/producer shutdown and repeated source close");
clone.close();
let closed;try{device.createBuffer({size:4,usage:8});}catch(error){closed=error;}
check(closed instanceof TypeError,"closed runtime rejects later resource creation");
globalThis.webgpuTestsDone=true;
console.log("WEBGPU_SHUTDOWN pendingMapPipelineScopesQueue=true retainedAdapterDevice=true lateCallbacks=0");
