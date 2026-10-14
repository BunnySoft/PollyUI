function check(value,message){if(!value)throw Error(message);}
const data=new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255]);
const frame=new VideoFrame(data,{format:"RGBA",codedWidth:2,codedHeight:2,timestamp:0});
const canvas=document.createElement("canvas");canvas.width=2;canvas.height=2;
const raster=canvas.getContext("2d");raster.drawImage(frame,0,0);
check([...raster.getImageData(0,0,2,2).data].join()===data.join(),"real VideoFrame-to-Canvas2D drawImage pixels");
const image=new Image();image.src=canvas.toDataURL();await image.decode();
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
const target=device.createTexture({size:[2,2],format:"rgba8unorm",usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT});
const buffer=device.createBuffer({size:512,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
async function copy(source,flipY,expected) {
    device.queue.copyExternalImageToTexture({source,flipY},{texture:target},[2,2]);
    const encoder=device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:256},[2,2]);device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(buffer.getMappedRange());
    check([...bytes.slice(0,8),...bytes.slice(256,264)].join()===expected.join(),"real external image copy and native readback");
    buffer.unmap();
}
await copy(frame,false,data);await copy(canvas,false,data);await copy(image,false,data);
await copy(canvas,true,new Uint8Array([...data.slice(8),...data.slice(0,8)]));
frame.close();let closed;
try{raster.drawImage(frame,0,0);}catch(error){closed=error;}
check(closed?.name==="InvalidStateError","closed frame Canvas2D source is rejected");
device.destroy();await device.lost;
globalThis.webgpuTestsDone=true;console.log("WEBGPU_IMAGE_TRANSFER actualFrameCanvasImage=true realPNGdecode=true flipY=true closedSource=true");
