function check(condition, message) { if (!condition) throw Error(message); }
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const shader = device.createShaderModule({code: `
override scale: u32 = 2u;
@group(0) @binding(0) var<storage, read_write> a: array<u32>;
@compute @workgroup_size(1) fn main() { a[0] = a[0] * scale + 1u; }
`});
const compilation = await shader.getCompilationInfo();
check(compilation instanceof GPUCompilationInfo && compilation.messages.length === 0, "real valid WGSL diagnostics");
const pipeline = await device.createComputePipelineAsync({
    layout: "auto", compute: {module: shader, entryPoint: "main", constants: {scale: 3}},
});
const storage = device.createBuffer({size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
const readback = device.createBuffer({size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
device.queue.writeBuffer(storage, 0, new Uint32Array([3]));
const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: storage}}]});
const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, group);
pass.dispatchWorkgroups(1);
pass.end();
encoder.copyBufferToBuffer(storage, 0, readback, 0, 4);
device.queue.submit([encoder.finish()]);
await readback.mapAsync(GPUMapMode.READ);
check(new Uint32Array(readback.getMappedRange())[0] === 10, "async native pipeline with actual WGSL override constant");
readback.unmap();
device.pushErrorScope("validation");
const invalid = device.createShaderModule({code: "@compute @workgroup_size(1) fn broken( {"});
const diagnostics = await invalid.getCompilationInfo();
check(diagnostics.messages.length > 0 && diagnostics.messages.some(message =>
    message instanceof GPUCompilationMessage && message.type === "error" && message.message.length > 0 && message.lineNum > 0),
    "real Tint invalid-WGSL diagnostics, not empty success");
check((await device.popErrorScope()) instanceof GPUValidationError, "invalid WGSL native error scope");
let error;
try {
    await device.createComputePipelineAsync({layout: "auto", compute: {module: invalid, entryPoint: "broken"}});
} catch (value) { error = value; }
check(error instanceof GPUPipelineError && error.reason === "validation" && error.message.length > 0,
    "actual async pipeline failure rejects with typed GPUPipelineError");
device.destroy();
await device.lost;
globalThis.webgpuTestsDone = true;
console.log("WEBGPU_COMPILER asyncOverrideActual=10 tintErrors=" + diagnostics.messages.length + " pipelineFailure=validation");
