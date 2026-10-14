function check(condition, message) { if (!condition) throw Error(message); }
function throws(callback, name, message) {
    let error;
    try { callback(); } catch (value) { error = value; }
    check(error?.name === name, message + ": actual " + error?.name);
}
const adapter = await navigator.gpu.requestAdapter();
const secondAdapter = await navigator.gpu.requestAdapter();
const a = await adapter.requestDevice(), b = await secondAdapter.requestDevice();
const foreign = b.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST});
a.pushErrorScope("validation");
a.queue.writeBuffer(foreign, 0, new Uint32Array([99]));
check((await a.popErrorScope()) instanceof GPUValidationError,"cross-device resource is real GPU validation, not IDL brand failure");
throws(() => a.createBuffer({size: Number.MAX_SAFE_INTEGER + 1, usage: 4}), "TypeError", "no unsafe uint64 conversion");
throws(() => a.createBuffer({size: -1, usage: 4}), "TypeError", "no negative integer wrapping");
const forged = Object.create(GPU.prototype);
let forgedError;
try { await forged.requestAdapter(); } catch (error) { forgedError = error; }
check(forgedError instanceof TypeError, "GPU receiver brand cannot be forged by its prototype");
const upload = a.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true});
Object.setPrototypeOf(upload, GPUShaderModule.prototype);
let wrongBrand;
try { await GPUShaderModule.prototype.getCompilationInfo.call(upload); } catch (error) { wrongBrand = error; }
check(wrongBrand instanceof TypeError, "a buffer cannot become a shader by prototype mutation");
check(Object.getOwnPropertyDescriptor(GPUBuffer.prototype, "size").get.call(upload) === 16,
    "the original buffer brand remains valid after prototype mutation");
Object.setPrototypeOf(upload, GPUBuffer.prototype);
const mapped = upload.getMappedRange(8, 8);
const alias = new Uint32Array(mapped);
alias.set([123, 456]);
throws(() => upload.getMappedRange(8, 4), "OperationError", "mapped ranges cannot overlap");
throws(() => upload.getMappedRange(4, 4), "OperationError", "mapped range offset alignment");
upload.unmap();
check(mapped.byteLength === 0 && alias.byteLength === 0, "mapped aliases detach");
const readback = a.createBuffer({size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
const encoder = a.createCommandEncoder();
encoder.copyBufferToBuffer(upload, 0, readback, 0, 16);
a.queue.submit([encoder.finish()]);
const mapping = readback.mapAsync(GPUMapMode.READ, 8, 8);
const rejected = readback.mapAsync(GPUMapMode.READ, 0, 4).then(
    () => { throw Error("second simultaneous mapping unexpectedly succeeded"); },
    error => check(error.name === "OperationError", "invalid mapping actually rejected"),
);
await Promise.all([mapping, rejected]);
const copied = readback.getMappedRange(8, 8);
check([...new Uint32Array(copied)].join() === "123,456", "mapped write committed to actual GPU and read back");
readback.unmap();
check(copied.byteLength === 0, "second map alias detached");
const buffer = a.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
const words = new Uint32Array([999, 7, 8, 9, 999]);
a.queue.writeBuffer(buffer, 0, words.subarray(1, 4), 1, 2);
await buffer.mapAsync(GPUMapMode.READ);
const bytes = buffer.getMappedRange();
check([...new Uint32Array(bytes).slice(0, 2)].join() === "8,9", "typed array view and element-relative offsets");
a.destroy();
check(bytes.byteLength === 0, "device destroy detaches every mapped child buffer");
check((await a.lost).reason === "destroyed", "device destroy has real loss reason");
const independent = b.createBuffer({size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
b.queue.writeBuffer(independent, 0, new Uint32Array([17]));
await independent.mapAsync(GPUMapMode.READ);
check(new Uint32Array(independent.getMappedRange())[0] === 17, "destroying one device does not destroy another");
independent.unmap();
b.destroy();
await b.lost;
gc();
globalThis.webgpuTestsDone = true;
console.log("WEBGPU_LIFETIME brands=true actualMappedWrite=123,456 independentDevice=17 aliasesDetached=true");
