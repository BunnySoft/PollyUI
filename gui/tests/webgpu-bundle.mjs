function check(value,message){if(!value)throw Error(message);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
device.pushErrorScope("validation");
const shader=device.createShaderModule({code:`
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn fs()->@location(0)vec4f {return vec4f(0,1,0,1);}
`});
const pipeline=device.createRenderPipeline({layout:"auto",vertex:{module:shader,entryPoint:"vs"},fragment:{module:shader,entryPoint:"fs",targets:[{format:"rgba8unorm"}]}});
const indirect=device.createBuffer({size:16,usage:GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(indirect,0,new Uint32Array([3,1,0,0]));
const bundleEncoder=device.createRenderBundleEncoder({colorFormats:["rgba8unorm"]});
bundleEncoder.pushDebugGroup("real bundle");bundleEncoder.setPipeline(pipeline);
bundleEncoder.insertDebugMarker("draw indirect");bundleEncoder.drawIndirect(indirect,0);bundleEncoder.popDebugGroup();
const bundle=bundleEncoder.finish();
check(bundle instanceof GPURenderBundle,"actual native render bundle");
const texture=device.createTexture({size:[8,8],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const buffer=device.createBuffer({size:2048,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const encoder=device.createCommandEncoder();encoder.pushDebugGroup("submit bundle");
const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:"clear",storeOp:"store"}]});
pass.executeBundles([bundle]);pass.end();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:256},[8,8]);encoder.popDebugGroup();
device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
const bytes=new Uint8Array(buffer.getMappedRange());
for(let y=0;y<8;++y)for(let x=0;x<8;++x)check([...bytes.slice(y*256+x*4,y*256+x*4+4)].join()==="0,255,0,255","exact real render bundle green output");
buffer.unmap();check(await device.popErrorScope()===null,"bundle/debug/indirect path has no native validation error");
device.destroy();await device.lost;
globalThis.webgpuTestsDone=true;console.log("WEBGPU_BUNDLE actualIndirectDraw=true exact64GreenPixels=true debugGroups=true");
