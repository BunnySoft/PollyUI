function check(value,message){if(!value)throw Error(message);}
function near(actual,expected,tolerance,label){check(Math.abs(actual-expected)<=tolerance,label+": "+actual+" expected "+expected);}
const adapter=await navigator.gpu.requestAdapter();
const features=["texture-formats-tier1","rg11b10ufloat-renderable"].filter(value=>adapter.features.has(value));
const device=await adapter.requestDevice({requiredFeatures:features});
const frame=new VideoFrame(new Uint8Array([255,64,0,128]),{format:"RGBA",codedWidth:1,codedHeight:1,timestamp:0});
const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
function half(value){const sign=value&0x8000?-1:1,e=(value>>>10)&31,m=value&1023;return sign*(e?2**(e-15)*(1+m/1024):2**-14*m/1024);}
async function read(texture,bytes){
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:256},[1,1]);
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const data=buffer.getMappedRange().slice(0,bytes);buffer.unmap();return data;
}
const formats=[
    ["r8unorm",1,"unorm"],["rg8unorm",2,"unorm"],["rgba8unorm",4,"unorm"],["rgba8unorm-srgb",4,"unorm"],
    ["bgra8unorm",4,"bgra"],["bgra8unorm-srgb",4,"bgra"],
    ["r16float",1,"half"],["rg16float",2,"half"],["rgba16float",4,"half"],
    ["r32float",1,"float"],["rg32float",2,"float"],["rgba32float",4,"float"],
    ["rgb10a2unorm",4,"packed"],
];
if(features.includes("texture-formats-tier1"))
    formats.push(["r16unorm",1,"unorm16"],["rg16unorm",2,"unorm16"],["rgba16unorm",4,"unorm16"]);
if(features.includes("rg11b10ufloat-renderable"))formats.push(["rg11b10ufloat",3,"ufloat"]);
for(const [format,channels,kind] of formats){
    device.pushErrorScope("validation");
    const texture=device.createTexture({size:[1,1],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
    device.queue.copyExternalImageToTexture({source:frame},{texture},[1,1]);
    const bytes=kind==="half"||kind==="unorm16"?channels*2:kind==="float"?channels*4:kind==="packed"||kind==="ufloat"?4:channels;
    const data=await read(texture,bytes),view=new DataView(data),expected=[1,64/255,0,128/255];
    if(kind==="packed"){
        const value=view.getUint32(0,true);near(value&1023,1023,0,format+" red");
        near((value>>>10)&1023,64/255*1023,1,format+" green");near(value>>>30,128/255*3,1,format+" alpha");
    } else if(kind==="ufloat"){
        const value=view.getUint32(0,true),r=value&2047,g=(value>>>11)&2047,b=value>>>22;
        near((1+(r&63)/64)*2**((r>>>6)-15),1,.01,format+" red");
        near((1+(g&63)/64)*2**((g>>>6)-15),64/255,.005,format+" green");check(b===0,format+" blue");
    } else for(let i=0;i<channels;++i){
        const value=kind==="half"?half(view.getUint16(i*2,true)):kind==="float"?view.getFloat32(i*4,true):
            kind==="unorm16"?view.getUint16(i*2,true)/65535:view.getUint8(i)/255;
        const channel=kind==="bgra"?(i===0?2:i===2?0:i):i;
        near(value,expected[channel],kind==="half"?.001:kind==="float"?1e-5:1/255,format+" channel "+i);
    }
    check(await device.popErrorScope()===null,"valid native external copy "+format);texture.destroy();
}
const bad=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
device.queue.writeTexture({texture:bad},new Uint8Array([0,0,255,255]),{},[1,1]);
device.pushErrorScope("validation");device.queue.copyExternalImageToTexture({source:frame},{texture:bad},[1,1]);
check(await device.popErrorScope() instanceof GPUValidationError,"copyExternalImage requires actual RENDER_ATTACHMENT usage");
check([...new Uint8Array(await read(bad,4))].join()==="0,0,255,255","invalid external destination leaves pixels unchanged");
const color=device.createTexture({size:[1,1],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
const red=new VideoFrame(new Uint8Array([255,0,0,255]),{format:"RGBA",codedWidth:1,codedHeight:1,timestamp:0});
device.queue.copyExternalImageToTexture({source:red},{texture:color,colorSpace:"display-p3"},[1,1]);
const p3=new Uint8Array(await read(color,4));
for(const [i,value] of [234,51,35,255].entries())near(p3[i],value,2,"actual sRGB-to-display-p3 conversion "+i);
device.queue.copyExternalImageToTexture({source:frame},{texture:color,premultipliedAlpha:true},[1,1]);
const premul=new Uint8Array(await read(color,4));
check([...premul].join()==="128,32,0,128","native source alpha premultiplication before destination encoding");
frame.close();red.close();device.destroy();await device.lost;globalThis.webgpuTestsDone=true;
console.log("WEBGPU_IMAGE_FORMATS nativeFormats="+formats.length+" actualP3="+[...p3]+" alpha=true invalidUsageUnchanged=true");
