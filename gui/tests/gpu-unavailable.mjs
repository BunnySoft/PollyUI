function check(ok,message){if(!ok)throw new Error(message);}
const canvas=document.createElement("canvas");
let failures=0;
canvas.addEventListener("webglcontextcreationerror",()=>++failures);
check(canvas.getContext("webgl2")===null,"genuinely unavailable GPU context must return null");
await new Promise(resolve=>setTimeout(resolve,0));
check(failures===1,"unavailable backend schedules a real creation-error event");
for(const type of ["webgl","experimental-webgl"])check(canvas.getContext(type)===null,"excluded context unavailable");
const separate=document.createElement("canvas").getContext("webgpu");
check(globalThis.navigator?.gpu ? separate instanceof GPUCanvasContext : separate===null,"independent WebGPU build capability");
const ctx=canvas.getContext("2d");check(ctx&&canvas.getContext("2d")===ctx,"failed GPU acquisition does not lock out Canvas2D");
check(canvas.getContext("webgpu")===null,"successful Canvas2D keeps WebGPU mode exclusive");
ctx.fillStyle="red";ctx.fillRect(0,0,2,2);
const pixels=ctx.getImageData(0,0,1,1).data;
check(pixels[0]===255&&pixels[3]===255,"2D pixels unaffected by unavailable GPU");
globalThis.gpuTestsDone=true;
