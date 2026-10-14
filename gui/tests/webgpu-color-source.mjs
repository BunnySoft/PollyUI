function check(value,message){if(!value)throw Error(message);}
function near(actual,expected,label){check(Math.abs(actual-expected)<.003,label+": "+actual+" expected "+expected);}
function half(value){const e=(value>>>10)&31,m=value&1023,sign=value&0x8000?-1:1;return sign*(e?2**(e-15)*(1+m/1024):2**-14*m/1024);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
const texture=device.createTexture({size:[1,1],format:"rgba16float",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const frames=[];
function frame(bytes,colorSpace){const value=new VideoFrame(new Uint8Array(bytes),{format:"RGBA",codedWidth:1,codedHeight:1,timestamp:0,colorSpace});frames.push(value);return value;}
async function copy(value,colorSpace="srgb"){
    device.pushErrorScope("validation");
    device.queue.copyExternalImageToTexture({source:value},{texture,colorSpace},[1,1]);
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:256},[1,1]);
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const bytes=new Uint16Array(buffer.getMappedRange()),result=[...bytes.slice(0,4)].map(half);buffer.unmap();
    check(await device.popErrorScope()===null,"native color source copy has no validation error");
    return result;
}
const linear=frame([128,128,128,255],{primaries:"bt709",transfer:"linear",matrix:"rgb",fullRange:true});
Object.defineProperty(linear,"colorSpace",{value:{primaries:"fake",transfer:"fake"}});
const gray=await copy(linear),expected=1.055*(128/255)**(1/2.4)-.055;
near(gray[0],expected,"real linear source transfer");near(gray[1],expected,"real linear source green");
const raster=document.createElement("canvas");raster.width=raster.height=1;
const context=raster.getContext("2d");context.drawImage(linear,0,0);
check([...context.getImageData(0,0,1,1).data].join()==="188,188,188,255","same actual linear frame converts to sRGB Canvas2D pixels");
const p3=frame([255,0,0,255],{primaries:"smpte432",transfer:"iec61966-2-1",matrix:"rgb",fullRange:true});
const extended=await copy(p3);
check(extended[0]>1.08&&extended[1]<-.20&&extended[2]<-.13,"native F16 preserves actual P3 out-of-sRGB gamut values, no early byte clamp: "+extended);
const original=await copy(p3,"display-p3");
near(original[0],1,"real P3 source to P3 target red");near(original[1],0,"real P3 identity green");near(original[2],0,"real P3 identity blue");
const bt709=frame([64,64,64,255],{primaries:"bt709",transfer:"bt709",matrix:"rgb",fullRange:true});
const transformed=await copy(bt709),linear709=((64/255+.099)/1.099)**(1/.45),encoded709=1.055*linear709**(1/2.4)-.055;
near(transformed[0],encoded709,"true BT709 source transfer is not silently sRGB");
const black=frame([16,16,16,255],{primaries:"bt709",transfer:"iec61966-2-1",matrix:"rgb",fullRange:false});
const white=frame([235,235,235,255],{primaries:"bt709",transfer:"iec61966-2-1",matrix:"rgb",fullRange:false});
near((await copy(black))[0],0,"real limited range black");near((await copy(white))[0],1,"real limited range white");
const shader=device.createShaderModule({code:`
@group(0) @binding(0) var image:texture_external;
@group(0) @binding(1) var sample:sampler;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn fs()->@location(0)vec4f {return textureSampleBaseClampToEdge(image,sample,vec2f(.5));}
`});
const pipeline=device.createRenderPipeline({layout:"auto",vertex:{module:shader,entryPoint:"vs"},fragment:{module:shader,entryPoint:"fs",targets:[{format:"rgba16float"}]}});
device.pushErrorScope("validation");
const external=device.importExternalTexture({source:linear});
const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:external},{binding:1,resource:device.createSampler()}]});
const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:"clear",storeOp:"store"}]});
pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:256},[1,1]);device.queue.submit([encoder.finish()]);
await buffer.mapAsync(GPUMapMode.READ);near(half(new Uint16Array(buffer.getMappedRange())[0]),expected,"real texture_external honors source linear metadata");
buffer.unmap();check(await device.popErrorScope()===null,"color-managed native external path validation");
let invalid;try{new VideoColorSpace({transfer:"SRGB"});}catch(error){invalid=error;}
check(invalid instanceof TypeError,"VideoColorSpace enums are canonical, not arbitrary accepted metadata");
for(const value of frames)value.close();device.destroy();await device.lost;globalThis.webgpuTestsDone=true;
console.log("WEBGPU_COLOR_SOURCE trueLinear709P3=true extendedF16="+extended+" limitedRange=true trueExternal=true shared2D=true");
