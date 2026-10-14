function check(value,message){if(!value)throw Error(message);}
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
let invalid;
try{device.pushErrorScope("VALIDATION");}catch(error){invalid=error;}
check(invalid instanceof TypeError,"noncanonical error filter rejected");
invalid=null;try{await navigator.gpu.requestAdapter({powerPreference:"HIGH_PERFORMANCE"});}catch(error){invalid=error;}
check(invalid instanceof TypeError,"noncanonical power preference rejected");
const fractional=device.createBuffer({size:16.9,usage:GPUBufferUsage.COPY_DST});
check(fractional.size===16,"EnforceRange truncates finite fractions");
const secondAdapter=await navigator.gpu.requestAdapter(),second=await secondAdapter.requestDevice();
const foreign=second.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
second.queue.writeBuffer(foreign,0,new Uint32Array([17]));
device.pushErrorScope("validation");device.queue.writeBuffer(foreign,0,new Uint32Array([99]));
check((await device.popErrorScope()) instanceof GPUValidationError,"cross device write is captured GPU validation");
await foreign.mapAsync(GPUMapMode.READ);check(new Uint32Array(foreign.getMappedRange())[0]===17,"cross device failure did not modify foreign data");foreign.unmap();
check(new GPUValidationError("x") instanceof GPUError&&new GPUOutOfMemoryError("x") instanceof GPUError&&
    new GPUInternalError("x") instanceof GPUError,"real common GPUError base");
check(!(new GPUOutOfMemoryError("x") instanceof GPUValidationError)&&
    !(new GPUInternalError("x") instanceof GPUValidationError),"OOM/internal are not validation errors");
device.destroy();second.destroy();await Promise.all([device.lost,second.lost]);
globalThis.webgpuTestsDone=true;console.log("WEBGPU_REVIEW enum=true enforceRange16=true foreignUnchanged17=true errorHierarchy=true");
