function check(value,message){if(!value)throw Error(message);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
device.pushErrorScope("validation");
const frame=new VideoFrame(new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]),
    {format:"RGBA",codedWidth:2,codedHeight:2,timestamp:1});
const external=device.importExternalTexture({source:frame});
check(external instanceof GPUExternalTexture,"actual Dawn external texture resource");
const shader=device.createShaderModule({code:`
struct Out { @builtin(position) p:vec4f, @location(0) uv:vec2f };
@group(0) @binding(0) var video:texture_external;
@group(0) @binding(1) var sample:sampler;
@vertex fn vs(@builtin(vertex_index) i:u32)->Out {
 var points=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
 var out:Out;out.p=vec4f(points[i],0,1);out.uv=vec2f((points[i].x+1)*.5,(1-points[i].y)*.5);return out;
}
@fragment fn fs(in:Out)->@location(0) vec4f{return textureSampleBaseClampToEdge(video,sample,in.uv);}
`});
const pipeline=device.createRenderPipeline({layout:"auto",vertex:{module:shader,entryPoint:"vs"},
    fragment:{module:shader,entryPoint:"fs",targets:[{format:"rgba8unorm"}]}});
const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:external},{binding:1,resource:device.createSampler()}]});
const target=device.createTexture({size:[8,8],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
const buffer=device.createBuffer({size:2048,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:"clear",storeOp:"store"}]});
pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:256},[8,8]);device.queue.submit([encoder.finish()]);
await buffer.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(buffer.getMappedRange());
for(const [x,y,color] of [[1,1,[255,0,0,255]],[6,1,[0,255,0,255]],[1,6,[0,0,255,255]],[6,6,[255,255,255,255]]])
    check([...bytes.slice(y*256+x*4,y*256+x*4+4)].join()===color.join(),"actual WGSL texture_external RGBA sample "+x+","+y);
buffer.unmap();check(await device.popErrorScope()===null,"native texture_external path has no validation error");
device.pushErrorScope("validation");
const converted=device.importExternalTexture({source:frame,colorSpace:"display-p3"});
const convertedGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:converted},{binding:1,resource:device.createSampler()}]});
const next=device.createCommandEncoder(),colorPass=next.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:"clear",storeOp:"store"}]});
colorPass.setPipeline(pipeline);colorPass.setBindGroup(0,convertedGroup);colorPass.draw(3);colorPass.end();
next.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:256},[8,8]);device.queue.submit([next.finish()]);
await buffer.mapAsync(GPUMapMode.READ);const colorBytes=new Uint8Array(buffer.getMappedRange()),p3=[...colorBytes.slice(260,264)];
for(const [i,expected] of [234,51,35,255].entries())check(Math.abs(p3[i]-expected)<=2,"actual texture_external sRGB-to-P3 red "+p3);
buffer.unmap();check(await device.popErrorScope()===null,"native external P3 conversion has no validation error");
frame.close();frame.close();
device.pushErrorScope("validation");
const invalid=device.createCommandEncoder(),closedPass=invalid.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:"clear",storeOp:"store"}]});
closedPass.setPipeline(pipeline);closedPass.setBindGroup(0,group);closedPass.draw(3);closedPass.end();device.queue.submit([invalid.finish()]);
check(await device.popErrorScope() instanceof GPUValidationError,"closed genuine frame expires already-bound native external textures");
device.destroy();await device.lost;
globalThis.webgpuTestsDone=true;console.log("WEBGPU_EXTERNAL actualDawnExternalResource=true WGSLtextureExternal=true exactFourColors=true actualP3="+p3+" closedExpires=true");
