function check(value,message){if(!value)throw Error(message);}
const adapter=await navigator.gpu.requestAdapter();
const device=await adapter.requestDevice();
device.pushErrorScope("validation");
const source=device.createTexture({size:[2,2],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
device.queue.writeTexture({texture:source},new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]),{bytesPerRow:8},[2,2]);
const target=device.createTexture({size:[16,16],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const depth=device.createTexture({size:[16,16],format:"depth24plus",usage:GPUTextureUsage.RENDER_ATTACHMENT});
const shader=device.createShaderModule({code:`
struct Out { @builtin(position) pos:vec4f, @location(0) uv:vec2f };
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@vertex fn vs(@location(0) data:vec4f)->Out {
 var out:Out;out.pos=vec4f(data.xy,0.5,1.0);out.uv=data.zw;return out;
}
@fragment fn fs(in:Out)->@location(0) vec4f {return textureSample(image,imageSampler,in.uv);}
`});
const pipeline=await device.createRenderPipelineAsync({layout:"auto",
    vertex:{module:shader,entryPoint:"vs",buffers:[{arrayStride:16,attributes:[{shaderLocation:0,offset:0,format:"float32x4"}]}]},
    fragment:{module:shader,entryPoint:"fs",targets:[{format:"rgba8unorm"}]},
    primitive:{topology:"triangle-list",cullMode:"back"},
    depthStencil:{format:"depth24plus",depthWriteEnabled:true,depthCompare:"less"}});
const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:source.createView()},{binding:1,resource:device.createSampler()}]});
const vertices=device.createBuffer({size:64,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(vertices,0,new Float32Array([-1,1,0,0,-1,-1,0,1,1,1,1,0,1,-1,1,1]));
const indices=device.createBuffer({size:12,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(indices,0,new Uint16Array([0,1,2,2,1,3]));
const readback=device.createBuffer({size:4096,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const encoder=device.createCommandEncoder();
const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:"clear",storeOp:"store",clearValue:[0,0,0,1]}],
    depthStencilAttachment:{view:depth.createView(),depthLoadOp:"clear",depthStoreOp:"store",depthClearValue:1}});
pass.setPipeline(pipeline);pass.setBindGroup(0,group);
pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,"uint16");
pass.setViewport(0,0,16,16,0,1);pass.setScissorRect(0,0,16,16);
pass.drawIndexed(6);pass.end();
encoder.copyTextureToBuffer({texture:target},{buffer:readback,bytesPerRow:256},[16,16]);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const pixels=new Uint8Array(readback.getMappedRange());
for(const [x,y,expected] of [[3,3,[255,0,0,255]],[12,3,[0,255,0,255]],[3,12,[0,0,255,255]],[12,12,[255,255,255,255]]])
    check([...pixels.slice(y*256+x*4,y*256+x*4+4)].join()===expected.join(),"exact actual indexed/depth/textured render pixel "+x+","+y);
readback.unmap();
check(await device.popErrorScope()===null,"render path has no native validation errors");
device.destroy();await device.lost;
globalThis.webgpuTestsDone=true;
console.log("WEBGPU_RENDER indexed=true depth=true texture=true exactFourQuadrants=true");
