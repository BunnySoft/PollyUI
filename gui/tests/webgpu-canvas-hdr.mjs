function check(value,message){if(!value)throw Error(message);}
function half(value){const sign=value&0x8000?-1:1,e=(value>>>10)&31,m=value&1023;return sign*(e?2**(e-15)*(1+m/1024):2**-14*m/1024);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
const canvas=document.createElement("canvas");canvas.width=canvas.height=2;
const context=canvas.getContext("webgpu");
context.configure({device,format:"rgba16float",alphaMode:"premultiplied",
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST});
const output=device.createTexture({size:[2,2],format:"rgba16float",
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
const buffer=device.createBuffer({size:512,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const data=new Uint16Array([0x3c00,0xb400,0x3000,0x3800,0x3c00,0xb400,0x3000,0x3800,
    0x3c00,0xb400,0x3000,0x3800,0x3c00,0xb400,0x3000,0x3800]);
const rasterCanvas=document.createElement("canvas");rasterCanvas.width=rasterCanvas.height=2;
const raster=rasterCanvas.getContext("2d");
device.pushErrorScope("validation");
for(let frame=0;frame<24;++frame){
    device.queue.writeTexture({texture:context.getCurrentTexture()},data,{bytesPerRow:16},[2,2]);
    device.queue.copyExternalImageToTexture({source:canvas},{texture:output},[2,2]);
    const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:output},{buffer,bytesPerRow:256},[2,2]);
    device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
    const values=[...new Uint16Array(buffer.getMappedRange()).slice(0,4)].map(half);
    for(const [i,expected] of [2,-.5,.25,.5].entries())
        check(Math.abs(values[i]-expected)<.015,"real canvas F16 source preserves extended and negative values before copy: "+values);
    buffer.unmap();
    check(nativeReadbacksForTest()===0,"completed native canvas map buffers are released per frame, not accumulated to shutdown");
}
raster.drawImage(canvas,0,0);
const pixel=[...raster.getImageData(0,0,1,1).data];
check(pixel.join()==="255,0,64,128","same HDR source clips only at actual RGBA8 Canvas2D destination: "+pixel);
check(await device.popErrorScope()===null,"HDR canvas and native image copy have no validation errors");
context.unconfigure();device.destroy();await device.lost;globalThis.webgpuTestsDone=true;
console.log("WEBGPU_CANVAS_HDR originalExtended2NegativeHalf=true actual24Frames=true liveNativeReadbacks=0 sRGB8="+pixel);
