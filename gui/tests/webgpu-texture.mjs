function check(value, message) { if (!value) throw Error(message); }
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const texture = device.createTexture({size: new Uint32Array([2, 2, 1]), format: "rgba8unorm",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING});
check(texture.width === 2 && texture.height === 2 && texture.depthOrArrayLayers === 1 &&
    texture.format === "rgba8unorm" && texture.dimension === "2d", "actual native texture metadata");
const view = texture.createView({dimension: "2d"});
check(view instanceof GPUTextureView && device.createSampler({magFilter: "linear"}) instanceof GPUSampler,
    "real native views and samplers");
const colors = [255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255];
const source = new Uint8Array(40).fill(99);
source.set(colors, 12);
device.queue.writeTexture({texture}, new DataView(source.buffer, 12, 16), {bytesPerRow: 8}, {width: 2, height: 2});
const copied = device.createTexture({size: [2, 2], format: "rgba8unorm",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC});
const readback = device.createBuffer({size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
const encoder = device.createCommandEncoder();
encoder.copyTextureToTexture({texture}, {texture: copied}, [2,2]);
encoder.copyTextureToBuffer({texture: copied}, {buffer: readback, bytesPerRow: 256}, [2,2]);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const pixels = new Uint8Array(readback.getMappedRange());
check([...pixels.slice(0,8), ...pixels.slice(256,264)].join() === colors.join(), "exact native RGBA texture rows and DataView byteOffset");
readback.unmap();
const upload = device.createBuffer({size: 512, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
const padded = new Uint8Array(512);
padded.set(colors.slice(0,8)); padded.set(colors.slice(8),256);
device.queue.writeBuffer(upload,0,padded);
const second = device.createCommandEncoder();
second.copyBufferToTexture({buffer:upload,bytesPerRow:256},{texture:copied},[2,2]);
second.copyTextureToBuffer({texture:copied},{buffer:readback,bytesPerRow:256},[2,2]);
device.queue.submit([second.finish()]);
await readback.mapAsync(GPUMapMode.READ);
const roundtrip = new Uint8Array(readback.getMappedRange());
check([...roundtrip.slice(0,8), ...roundtrip.slice(256,264)].join() === colors.join(), "real buffer-to-texture-to-buffer roundtrip");
readback.unmap();
let invalid;
try { device.createTexture({size:[1],format:"RGBA8UNORM",usage:1}); } catch (error) { invalid=error; }
check(invalid instanceof TypeError,"standard enum spellings are strict");
device.destroy(); await device.lost;
globalThis.webgpuTestsDone = true;
console.log("WEBGPU_TEXTURE exactRGBA=" + colors.join());
