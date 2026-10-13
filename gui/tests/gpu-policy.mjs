function check(ok,message){if(!ok)throw new Error(message);}
const original=gpuRequestedPolicy;
let failures=0,status="";
const canvas=document.createElement("canvas");
canvas.addEventListener("webglcontextcreationerror",event=>{++failures;status=event.statusMessage;});
const context=canvas.getContext("webgl2",{powerPreference:"high-performance"});
await new Promise(resolve=>setTimeout(resolve,0));
if(context){
    check(!failures,"successful provider has no creation error");
    check(context.getContextAttributes().powerPreference==="high-performance","standard attribute preserves requested power hint");
    if(original==="hardware")console.log("Observed actual native-verified GPU-backed default; see native device-type receipt");
}else{
    check(failures===1&&status.length>0,"hardware/runtime refusal surfaces native reason through creation event");
    const raster=canvas.getContext("2d");raster.fillStyle="red";raster.fillRect(0,0,1,1);
    check(raster.getImageData(0,0,1,1).data[0]===255,"refused hardware does not lock out 2D");
    console.log("Observed unavailable/rejected hardware provider, not a software substitute:",status);
}
gpuSetPolicyForTest("software");
const software=document.createElement("canvas"),gl=software.getContext("webgl2",{preserveDrawingBuffer:true});
check(gl,"explicit software qualification context");
gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
let lost=0,restored=0;
software.addEventListener("webglcontextlost",event=>{event.preventDefault();++lost;});
software.addEventListener("webglcontextrestored",()=>++restored);
const loss=gl.getExtension("WEBGL_lose_context");
gpuSetPolicyForTest("hardware");
loss.loseContext();await new Promise(resolve=>setTimeout(resolve,0));
loss.restoreContext();await new Promise(resolve=>setTimeout(resolve,0));
check(!gl.isContextLost()&&lost===1&&restored===1,"restore pins the selected software provider despite a later process-policy change");
gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
check(pixel[0]===0&&pixel[1]===255&&pixel[2]===0&&pixel[3]===255,"restored provider still renders real pixels");
gpuSetPolicyForTest("software");
const strict=document.createElement("canvas");let strictReason="";
strict.addEventListener("webglcontextcreationerror",event=>strictReason=event.statusMessage);
check(strict.getContext("webgl2",{failIfMajorPerformanceCaveat:true})===null,"strict actual CPU is refused");
gpuSetPolicyForTest("invalid-policy");
const invalid=document.createElement("canvas");let reason="";
invalid.addEventListener("webglcontextcreationerror",event=>reason=event.statusMessage);
check(invalid.getContext("webgl2")===null,"invalid runtime policy cannot become success");
await new Promise(resolve=>setTimeout(resolve,0));
check(reason.includes("PU_WEBGL2_DEVICE"),"invalid configuration reason surfaced");
check(strictReason.includes("Strict performance-caveat"),"queued native refusal owns its message across deletion and later failed creation");
gpuSetPolicyForTest("software");
globalThis.gpuTestsDone=true;
console.log("PASS: actual hardware/default outcome, creation reason, explicit software, fixed restore policy and invalid-config rejection");
