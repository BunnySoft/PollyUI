function check(ok,label){if(!ok)throw new Error(label);}
function same(a,b,label){check(JSON.stringify(a)===JSON.stringify(b),label+": "+JSON.stringify(a));}
const canvas=document.createElement("canvas");canvas.width=4;canvas.height=4;
const gl=canvas.getContext("webgl2",{alpha:false,preserveDrawingBuffer:true});
function shader(type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);
    check(gl.getShaderParameter(s,gl.COMPILE_STATUS),gl.getShaderInfoLog(s));return s;}
function program(type,expression){
    const p=gl.createProgram(),v=shader(gl.VERTEX_SHADER,"#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}");
    const f=shader(gl.FRAGMENT_SHADER,`#version 300 es\nprecision highp float;precision highp int;uniform ${type} value;out vec4 color;void main(){color=vec4(float(${expression})/4.0,0,0,1);}`);
    gl.attachShader(p,v);gl.attachShader(p,f);gl.linkProgram(p);
    check(gl.getProgramParameter(p,gl.LINK_STATUS),gl.getProgramInfoLog(p));
    gl.deleteShader(v);gl.deleteShader(f);gl.useProgram(p);
    return p;
}
for(const suffix of ["f","i","ui"])for(let width=1;width<=4;width++){
    const type=width===1?(suffix==="f"?"float":suffix==="i"?"int":"uint"):
        (suffix==="f"?"vec":suffix==="i"?"ivec":"uvec")+width;
    const expr=width===1?"value":Array.from({length:width},(_,i)=>"value["+i+"]").join("+");
    const p=program(type,expr),location=gl.getUniformLocation(p,"value"),values=Array(width).fill(1);
    gl[`uniform${width}${suffix}`](location,...values);
    const scalar=gl.getUniform(p,location);same(width===1?scalar:[...scalar],width===1?1:values,"scalar uniform "+type);
    const Type=suffix==="f"?Float32Array:suffix==="i"?Int32Array:Uint32Array;
    gl[`uniform${width}${suffix}v`](location,new Type([99,...values,99]),1,width);
    const array=gl.getUniform(p,location);same(width===1?array:[...array],width===1?1:values,"typed offset array "+type);
    gl.drawArrays(gl.TRIANGLES,0,3);const pixel=new Uint8Array(4);gl.readPixels(1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    check(pixel[0]===Math.round(width/4*255)&&pixel[1]===0&&pixel[2]===0&&pixel[3]===255,"actual uniform shader pixel "+type);
    same(gl.getError(),0,"actual uniform driver error "+type);gl.useProgram(null);gl.deleteProgram(p);
}
for(const size of ["2","3","4","2x3","3x2","2x4","4x2","3x4","4x3"]){
    const dimensions=size.split("x").map(Number),columns=dimensions[0],rows=dimensions[1]||columns;
    const expr=Array.from({length:columns},(_,c)=>Array.from({length:rows},(_,r)=>`value[${c}][${r}]`).join("+")).join("+");
    const p=program("mat"+size,expr),location=gl.getUniformLocation(p,"value");
    const values=Array(columns*rows).fill(.25);
    gl[`uniformMatrix${size}fv`](location,false,new Float32Array([99,...values,99]),1,values.length);
    same([...gl.getUniform(p,location)],values,"actual matrix setter/query "+size);
    gl[`uniformMatrix${size}fv`](location,true,new Float32Array(values));
    same(gl.getError(),gl.INVALID_VALUE,"matrix transpose rejected "+size);
    gl.useProgram(null);gl.deleteProgram(p);
}
const bool=program("bvec4","int(value.x)+int(value.y)+int(value.z)+int(value.w)");
gl.uniform4iv(gl.getUniformLocation(bool,"value"),new Int32Array([1,0,1,0]));
same(gl.getUniform(bool,gl.getUniformLocation(bool,"value")),[true,false,true,false],"boolean natural query shape");
const indices=gl.getUniformIndices(bool,["value"]);
same(gl.getActiveUniforms(bool,indices,gl.UNIFORM_BLOCK_INDEX),[-1],"signed uniform block query shape");
same(gl.getActiveUniforms(bool,indices,gl.UNIFORM_SIZE),[1],"sequence uniform size shape");
same(gl.getActiveUniforms(bool,indices,gl.UNIFORM_IS_ROW_MAJOR),[false],"boolean sequence uniform shape");
const stale=gl.getUniformLocation(bool,"value");gl.linkProgram(bool);
gl.uniform4i(stale,1,1,1,1);same(gl.getError(),gl.INVALID_OPERATION,"relinked program invalidates locations");
gl.useProgram(null);gl.deleteProgram(bool);
const feedback=gl.createTransformFeedback();gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,feedback);
const output=gl.createBuffer();gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER,output);gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER,4,gl.STREAM_READ);
gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER,0,output,0,4);
same(gl.getIndexedParameter(gl.TRANSFORM_FEEDBACK_BUFFER_SIZE,0),4,"indexed capture range size");
gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,null);gl.deleteTransformFeedback(feedback);gl.deleteBuffer(output);
same(gl.getError(),0,"uniform/range final driver status");
globalThis.gpuTestsDone=true;
console.log("PASS: all float/signed/unsigned scalar+vector/array and square/non-square matrix families with real shader values");
