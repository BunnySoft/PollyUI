function check(value,message){if(!value)throw Error(message);}
const error=new GPUValidationError("native-shaped");
const event=new GPUUncapturedErrorEvent("uncapturederror",{error,cancelable:true});
check(event instanceof Event&&event.error===error&&event.error===event.error&&!event.isTrusted,
    "genuine Event-derived GPUUncapturedErrorEvent with SameObject error");
let forged;
try{new GPUUncapturedErrorEvent("x",{error:Object.create(GPUError.prototype)});}catch(error){forged=error;}
check(forged instanceof TypeError,"error dictionary cannot forge GPUError brand");
const target=new EventTarget(),calls=[];
const controller=new AbortController();
target.addEventListener("x",()=>calls.push("removed"),{signal:controller.signal});
controller.abort();
let badSignal;
const fakeSignal=Object.create(AbortSignal.prototype);
Object.defineProperty(fakeSignal,"aborted",{value:false});
fakeSignal.addEventListener=()=>{};
try{target.addEventListener("x",()=>{}, {signal:fakeSignal});}catch(error){badSignal=error;}
check(badSignal instanceof TypeError,"AbortSignal private brand cannot be forged by prototype and field overrides");
target.addEventListener("x",()=>calls.push("bubble"));
target.addEventListener("x",()=>calls.push("capture"),true);
target.addEventListener("x",e=>{calls.push("once");e.preventDefault();},{once:true});
const canceled=new Event("x",{cancelable:true});
check(target.dispatchEvent(canceled)===false&&calls.join()==="capture,bubble,once"&&canceled.defaultPrevented,
    "capture ordering, once and cancellation on real EventTarget");
calls.length=0;target.dispatchEvent(canceled);
check(calls.join()==="capture,bubble"&&canceled.currentTarget===null&&canceled.eventPhase===Event.NONE,
    "once removal and post-dispatch event state");
const passive=new EventTarget();
passive.addEventListener("x",e=>e.preventDefault(),{passive:true});
check(passive.dispatchEvent(new Event("x",{cancelable:true}))===true,"passive listener cannot cancel event");
const immediate=new EventTarget(),stopped=new Event("x");let stoppedCount=0,reentrant;
immediate.addEventListener("x",e=>{
    ++stoppedCount;
    try{immediate.dispatchEvent(e);}catch(error){reentrant=error;}
    e.stopImmediatePropagation();
});
immediate.addEventListener("x",()=>++stoppedCount);immediate.dispatchEvent(stopped);
check(stoppedCount===1&&reentrant?.name==="InvalidStateError","stopImmediatePropagation and same-event reentrant dispatch");
const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
check(device instanceof EventTarget&&device.onuncapturederror===null,"GPUDevice genuine EventTarget and default handler");
let nativeEvents=0,handlerEvents=0;
device.addEventListener("uncapturederror",e=>{
    check(e instanceof GPUUncapturedErrorEvent&&e.isTrusted&&e.target===device&&e.currentTarget===device,
        "real native uncaptured error event and trusted target");
    check(e.error instanceof GPUValidationError,"native validation class preserved");
    ++nativeEvents;e.preventDefault();
},{once:true});
device.onuncapturederror=e=>{check(e.error instanceof GPUError,"native event handler GPUError");++handlerEvents;e.preventDefault();};
device.createBuffer({size:4,usage:0});await device.queue.onSubmittedWorkDone();
check(nativeEvents===1&&handlerEvents===1,"real native event delivered exactly once to listener and handler");
device.onuncapturederror=null;
device.pushErrorScope("validation");device.createBuffer({size:4,usage:0});
check(await device.popErrorScope() instanceof GPUValidationError&&nativeEvents===1&&handlerEvents===1,
    "captured native errors do not emit uncaptured events");
device.destroy();const info=await device.lost;
check(info instanceof GPUDeviceLostInfo&&info.reason==="destroyed"&&typeof info.message==="string",
    "native loss wraps genuine readonly GPUDeviceLostInfo");
let badInfo;
try{Object.getOwnPropertyDescriptor(GPUDeviceLostInfo.prototype,"reason").get.call({});}catch(error){badInfo=error;}
check(badInfo instanceof TypeError,"device loss info attribute receiver has real brand");
globalThis.webgpuTestsDone=true;
console.log("WEBGPU_EVENTS nativeTrustedError=true scopes=true lostInfo=true captureOnceSignalPassive=true");
