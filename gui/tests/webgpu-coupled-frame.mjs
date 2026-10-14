function check(value,message){if(!value)throw Error(message);}
function same(actual,expected,message){check([...actual].join()===[...expected].join(),message+": "+[...actual]);}
const coded=new Uint8Array([
    9,9,9,255,0,0,255,255,0,255,0,255,
    9,9,9,255,255,0,0,255,255,255,255,255,
]);
const frame=new VideoFrame(coded,{format:"BGRA",codedWidth:3,codedHeight:2,timestamp:1,
    visibleRect:{x:1,y:0,width:2,height:2},displayWidth:4,displayHeight:4});
coded.fill(0);
Object.defineProperties(frame,{displayWidth:{value:9000},codedWidth:{value:0},visibleRect:{value:null}});
const clone=frame.clone();
const source=document.createElement("canvas");source.width=4;source.height=4;
const raster=source.getContext("2d");raster.drawImage(frame,0,0);
const expected=raster.getImageData(0,0,4,4).data;
same(expected.slice(0,4),[255,0,0,255],"owned crop/display top-left");
same(expected.slice(12,16),[0,255,0,255],"owned crop/display top-right");
same(expected.slice(48,52),[0,0,255,255],"owned crop/display bottom-left");
const canvas=document.createElement("canvas");canvas.width=4;canvas.height=4;
const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true});
check(gl,"real native WebGL2 context");
const texture=gl.createTexture(),fbo=gl.createFramebuffer();
gl.bindTexture(gl.TEXTURE_2D,texture);
gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
function upload(value,flip=false,premultiply=false){
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,flip);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,premultiply);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE,value);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    check(gl.getError()===gl.NO_ERROR,"owned frame native upload has no GLES error");
    const pixels=new Uint8Array(64);gl.readPixels(0,0,4,4,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    check(gl.getError()===gl.NO_ERROR,"real frame framebuffer readback");
    return pixels;
}
same(upload(frame),expected,"shared VideoFrame 2D/WebGL snapshot pixels, unforgeable dimensions");
const flipped=new Uint8Array(64);
for(let y=0;y<4;++y)flipped.set(expected.slice(y*16,y*16+16),(3-y)*16);
same(upload(frame,true),flipped,"existing WebGL pixelStore flip applies to actual frame");
frame.close();
same(upload(clone),expected,"independently owned clone survives source close");
let closed,forged;
try{upload(frame);}catch(error){closed=error;}
try{upload(Object.create(VideoFrame.prototype));}catch(error){forged=error;}
check(closed?.name==="InvalidStateError"&&forged instanceof TypeError,"closed and forged frames cannot upload");
const oversized=new VideoFrame(new Uint8Array([255,0,0,255]),{format:"RGBA",codedWidth:1,codedHeight:1,
    displayWidth:16777217,displayHeight:1,timestamp:0});
let budget;try{upload(oversized);}catch(error){budget=error;}
check(budget instanceof TypeError,"display snapshot pixel budget rejects before native allocation");
oversized.close();
const alpha=new VideoFrame(new Uint8Array([255,0,0,128]),{format:"RGBA",codedWidth:1,codedHeight:1,
    displayWidth:4,displayHeight:4,timestamp:0});
same(upload(alpha,false,true).slice(0,4),[128,0,0,128],"existing unpack premultiply uses owned RGBA alpha");
const linear=new VideoFrame(new Uint8Array([128,128,128,255]),{format:"RGBA",codedWidth:1,codedHeight:1,
    displayWidth:4,displayHeight:4,timestamp:0,colorSpace:{primaries:"bt709",transfer:"linear",matrix:"rgb",fullRange:true}});
same(upload(linear).slice(0,4),[188,188,188,255],"same private frame source applies real linear-to-sRGB metadata conversion to WebGL");
linear.close();
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
const target=device.createTexture({size:[4,4],format:"rgba8unorm",usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT});
device.queue.copyExternalImageToTexture({source:clone},{texture:target},[4,4]);
const buffer=device.createBuffer({size:1024,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:256},[4,4]);
device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
const bytes=new Uint8Array(buffer.getMappedRange()),packed=new Uint8Array(64);
for(let y=0;y<4;++y)packed.set(bytes.subarray(y*256,y*256+16),y*16);
same(packed,expected,"same genuine cropped/display frame pixels through WebGPU");
buffer.unmap();alpha.close();clone.close();gl.deleteTexture(texture);gl.deleteFramebuffer(fbo);
device.destroy();await device.lost;
globalThis.webgpuTestsDone=true;
console.log("WEBGPU_COUPLED_FRAME actual2DWebGLWebGPU=true BGRAcropDisplay=true closedForgeClone=true flipPremultiply=true");
