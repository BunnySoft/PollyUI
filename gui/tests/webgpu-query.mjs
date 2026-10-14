function check(value,message){if(!value)throw Error(message);}
const adapter=await navigator.gpu.requestAdapter();
const features=adapter.features.has("timestamp-query")?["timestamp-query"]:[];
const device=await adapter.requestDevice({requiredFeatures:features});
const query=device.createQuerySet({type:"occlusion",count:2});
check(query.type==="occlusion"&&query.count===2,"actual native query set attributes");
const shader=device.createShaderModule({code:`
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
 var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs()->@location(0)vec4f{return vec4f(1,0,0,1);}
`});
const pipeline=device.createRenderPipeline({layout:"auto",vertex:{module:shader,entryPoint:"vs"},fragment:{module:shader,entryPoint:"fs",targets:[{format:"rgba8unorm"}]}});
const texture=device.createTexture({size:[8,8],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT});
const resolve=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
const readback=device.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
const encoder=device.createCommandEncoder();
const pass=encoder.beginRenderPass({occlusionQuerySet:query,colorAttachments:[{view:texture.createView(),loadOp:"clear",storeOp:"store"}]});
pass.setPipeline(pipeline);pass.beginOcclusionQuery(0);pass.draw(3);pass.endOcclusionQuery();
pass.beginOcclusionQuery(1);pass.endOcclusionQuery();pass.end();
encoder.resolveQuerySet(query,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,readback,0,16);
device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);
const result=new BigUint64Array(readback.getMappedRange());
check(result[0]>0n&&result[1]===0n,"actual native occlusion visibility query results");
readback.unmap();
const clear=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(clear,0,new Uint32Array([1,2,3,4]));
const ce=device.createCommandEncoder();ce.clearBuffer(clear,4,8);ce.copyBufferToBuffer(clear,0,readback,0,16);
device.queue.submit([ce.finish()]);await readback.mapAsync(GPUMapMode.READ);
check([...new Uint32Array(readback.getMappedRange())].join()==="1,0,0,4","actual native clearBuffer range");
readback.unmap();
if(features.length) {
    const timestamps=device.createQuerySet({type:"timestamp",count:2});
    const storage=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
    const cp=device.createComputePipeline({layout:"auto",compute:{module:device.createShaderModule({code:"@compute @workgroup_size(1) fn main() {}"}),entryPoint:"main"}});
    const e=device.createCommandEncoder(),p=e.beginComputePass({timestampWrites:{querySet:timestamps,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});
    p.setPipeline(cp);p.dispatchWorkgroups(1);p.end();e.resolveQuerySet(timestamps,0,2,storage,0);e.copyBufferToBuffer(storage,0,readback,0,16);
    device.queue.submit([e.finish()]);await readback.mapAsync(GPUMapMode.READ);
    const t=new BigUint64Array(readback.getMappedRange());check(t[0]>0n&&t[1]>=t[0],"actual native timestamp ordering");
    readback.unmap();timestamps.destroy();
}
query.destroy();device.destroy();await device.lost;
globalThis.webgpuTestsDone=true;console.log("WEBGPU_QUERY actualOcclusionPositiveAndZero=true clearRange=true timestampQualified="+(features.length>0));
