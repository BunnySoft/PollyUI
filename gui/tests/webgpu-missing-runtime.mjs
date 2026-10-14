function check(value,message){if(!value)throw Error(message);}
const canvas=document.createElement("canvas");canvas.width=4;canvas.height=4;
const context=canvas.getContext("2d");context.fillStyle="red";context.fillRect(0,0,4,4);
check([...context.getImageData(1,1,1,1).data].join()==="255,0,0,255","missing provider preserves real Canvas2D");
let error;try{await navigator.gpu.requestAdapter();}catch(value){error=value;}
check(error&&error.message.includes("Dawn provider"),"WebGPU request reports actual missing native provider");
check([...context.getImageData(1,1,1,1).data].join()==="255,0,0,255","WebGPU failure does not break existing 2D");
globalThis.webgpuTestsDone=true;console.log("WEBGPU_MISSING_RUNTIME actual2Dred=true runtimeError="+error.message);
