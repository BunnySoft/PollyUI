import api from "gui/tests/gpu/api.mjs";
const canvas=document.createElement("canvas"),gl=canvas.getContext("webgl2");
if(!gl)throw new Error("Real WebGL2 context required for core descriptor inventory");
const missingMethods=Object.keys(api.methods).filter(name=>typeof gl[name]!=="function");
const missingAttributes=api.attributes.filter(attribute=>!(attribute.name in gl)).map(a=>a.name);
const badConstants=Object.entries(api.constants).filter(([name,value])=>gl[name]!==value).map(([name,value])=>({name,expected:value,actual:gl[name]}));
console.log(JSON.stringify({kind:"core-descriptor-inventory-not-behavior-qualification",
    revision:api.revision,methods:Object.keys(api.methods).length,constants:Object.keys(api.constants).length,
    missingMethods,missingAttributes,badConstants}));
if(missingMethods.length||missingAttributes.length||badConstants.length)
    throw new Error("Incomplete standard core descriptors");
for(const [name,overloads]of Object.entries(api.methods)){
    const required=Math.min(...overloads.map(o=>o.required));
    if(gl[name].length!==required)throw new Error("Incorrect WebIDL method length: "+name);
    if(required){
        let failed=false;try{gl[name]();}catch(e){failed=e instanceof TypeError;}
        if(!failed)throw new Error("Missing WebIDL argument-count validation: "+name);
    }
}
const lossProgram=gl.createProgram();
gl.getExtension("WEBGL_lose_context").loseContext();
if(gl.getError()!==gl.CONTEXT_LOST_WEBGL||gl.getError()!==gl.NO_ERROR)throw new Error("Loss error visibility");
for(const [name,overloads]of Object.entries(api.methods)){
    const descriptor=overloads[0];if(descriptor.handlesLoss)continue;
    const required=Math.min(...overloads.map(o=>o.required));
    const result=gl[name](...Array(required).fill(null));
    const expected=descriptor.returns==="any"||descriptor.returns.endsWith("?")?null:
        descriptor.returns==="undefined"?undefined:descriptor.returns==="boolean"||descriptor.returns==="GLboolean"?false:0;
    if(result!==expected)throw new Error("Incorrect lost-context default: "+name+" -> "+String(result));
}
if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_UNSUPPORTED||gl.getAttribLocation(lossProgram,"x")!==-1||
    gl.getFragDataLocation(lossProgram,"x")!==-1||gl.getVertexAttribOffset(0,gl.VERTEX_ATTRIB_ARRAY_POINTER)!==0||
    gl.isBuffer(null)!==false||gl.isEnabled(gl.BLEND)!==false)throw new Error("Loss-special scalar defaults");
console.log("PASS: all core WebIDL argument counts and normative lost-context return defaults (not all positive overloads)");
globalThis.gpuTestsDone=true;
