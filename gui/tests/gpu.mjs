function check(ok,message){if(!ok)throw new Error(message);}
function same(actual,expected,message){check(JSON.stringify(actual)===JSON.stringify(expected),`${message}: ${JSON.stringify(actual)}`);}
const canvas=document.createElementNS("http://www.w3.org/1999/xhtml","canvas");
canvas.width=32;canvas.height=24;
for(const name of ["webgl","experimental-webgl","webgpu"])check(canvas.getContext(name)===null,name+" unavailable");
const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true,alpha:false});
check(gl instanceof WebGL2RenderingContext,"real WebGL2 context");
check(gl.canvas===canvas&&canvas.getContext("webgl2")===gl,"stable identity");
check(canvas.getContext("2d")===null,"exclusive mode");
console.log("runtime",gl.getParameter(gl.VENDOR),gl.getParameter(gl.RENDERER),gl.getParameter(gl.VERSION));
gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
let pixels=new Uint8Array(4);gl.readPixels(5,5,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
same([...pixels],[255,0,0,255],"real GPU clear/read");
const copy=document.createElement("canvas");copy.width=32;copy.height=24;
const ctx=copy.getContext("2d");ctx.drawImage(canvas,0,0);
same([...ctx.getImageData(5,5,1,1).data],[255,0,0,255],"GPU snapshot to Canvas2D");
check(canvas.toDataURL().startsWith("data:image/png;base64,"),"GPU PNG export");
check(gl.getError()===gl.NO_ERROR,"native clear/snapshot errors");
globalThis.gpuTestsDone=true;
