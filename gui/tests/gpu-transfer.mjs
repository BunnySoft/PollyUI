function check(ok,label){if(!ok)throw new Error(label);}
function same(a,b,label){check(JSON.stringify(a)===JSON.stringify(b),`${label}: ${JSON.stringify(a)}`);}
const canvas=document.createElement("canvas");canvas.width=8;canvas.height=8;
const gl=canvas.getContext("webgl2",{alpha:true,preserveDrawingBuffer:true});
function ok(label){same(gl.getError(),0,label);}
function shader(type,text){const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);check(gl.getShaderParameter(s,gl.COMPILE_STATUS),gl.getShaderInfoLog(s));return s;}
const p=gl.createProgram();
gl.attachShader(p,shader(gl.VERTEX_SHADER,"#version 300 es\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}"));
gl.attachShader(p,shader(gl.FRAGMENT_SHADER,"#version 300 es\nprecision highp float;in vec2 uv;uniform sampler2D image;out vec4 color;void main(){color=texture(image,uv);}"));
gl.linkProgram(p);check(gl.getProgramParameter(p,gl.LINK_STATUS),gl.getProgramInfoLog(p));gl.useProgram(p);
gl.uniform1i(gl.getUniformLocation(p,"image"),0);gl.disable(gl.DEPTH_TEST);
const fbo=gl.createFramebuffer(),texture=gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D,texture);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,4,4);
gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
gl.clearColor(1,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
const pack=gl.createBuffer();gl.bindBuffer(gl.PIXEL_PACK_BUFFER,pack);gl.bufferData(gl.PIXEL_PACK_BUFFER,32,gl.STREAM_READ);
gl.readPixels(0,0,2,1,gl.RGBA,gl.UNSIGNED_BYTE,8);
const packed=new Uint8Array(32);gl.getBufferSubData(gl.PIXEL_PACK_BUFFER,0,packed);
same([...packed.slice(8,16)],[255,0,255,255,255,0,255,255],"actual pixel-pack buffer with byte offset");
same([...packed.slice(0,8)],Array(8).fill(0),"PBO untouched prefix");
ok("PBO pack");
gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,new Float32Array(4));same(gl.getError(),gl.INVALID_OPERATION,"pack type mismatch");
const unpack=gl.createBuffer();gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER,unpack);
gl.bufferData(gl.PIXEL_UNPACK_BUFFER,new Uint8Array([77,77,77,77,0,255,0,255]),gl.STATIC_DRAW);
gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,4);
const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
same([...pixel],[0,255,0,255],"actual unpack PBO with byte offset");
ok("PBO unpack");
gl.bindFramebuffer(gl.FRAMEBUFFER,null);
gl.pixelStorei(gl.UNPACK_ROW_LENGTH,4);gl.pixelStorei(gl.UNPACK_SKIP_PIXELS,1);
canvas.width=8;check(gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING)===unpack,"resize preserves unpack binding");
ok("PBO-bound resize");
same(gl.getParameter(gl.UNPACK_ROW_LENGTH),4,"resize preserves unpack row state");
gl.pixelStorei(gl.UNPACK_ROW_LENGTH,0);gl.pixelStorei(gl.UNPACK_SKIP_PIXELS,0);gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER,null);
gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
gl.validateProgram(p);check(gl.getProgramParameter(p,gl.VALIDATE_STATUS),gl.getProgramInfoLog(p));
gl.viewport(0,0,8,8);gl.drawArrays(gl.TRIANGLES,0,3);ok("PBO texture draw");
gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);same([...pixel],[0,255,0,255],"sample actual PBO-uploaded texel");
const integer=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,integer);
gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32UI,1,1,0,gl.RGBA_INTEGER,gl.UNSIGNED_INT,new Uint32Array([7,9,11,13]));
gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,integer,0);
const integers=new Uint32Array(4);gl.readPixels(0,0,1,1,gl.RGBA_INTEGER,gl.UNSIGNED_INT,integers);
same([...integers],[7,9,11,13],"real integer texture/FBO/readPixels format");
gl.clearBufferuiv(gl.COLOR,0,new Uint32Array([1,2,3,4]));
gl.readPixels(0,0,1,1,gl.RGBA_INTEGER,gl.UNSIGNED_INT,integers);same([...integers],[1,2,3,4],"real integer attachment clear");
gl.bindFramebuffer(gl.FRAMEBUFFER,null);
const src=document.createElement("canvas");src.width=2;src.height=2;
const ctx=src.getContext("2d");ctx.fillStyle="blue";ctx.fillRect(0,0,2,2);
for(const [internal,format,type]of [[gl.RGBA8,gl.RGBA,gl.UNSIGNED_BYTE],[gl.RGB8,gl.RGB,gl.UNSIGNED_BYTE],
    [gl.RGBA16F,gl.RGBA,gl.HALF_FLOAT],[gl.RGBA32F,gl.RGBA,gl.FLOAT],
    [gl.RGB565,gl.RGB,gl.UNSIGNED_SHORT_5_6_5],[gl.RGBA4,gl.RGBA,gl.UNSIGNED_SHORT_4_4_4_4],
    [gl.RGB5_A1,gl.RGBA,gl.UNSIGNED_SHORT_5_5_5_1]]){
    const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,internal,format,type,src);
    gl.drawArrays(gl.TRIANGLES,0,3);gl.readPixels(2,2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    same([...pixel],[0,0,255,255],"real DOM-source format "+internal);ok("DOM format "+internal);gl.deleteTexture(t);
}
const compressedFormats=gl.getParameter(gl.COMPRESSED_TEXTURE_FORMATS);
same([...compressedFormats],[],"no compressed extension enabled; GLES ETC2 must not leak into WebGL2 core");
check(gl.getExtension("WEBGL_compressed_texture_etc")===null,"software-renderer ETC extension not falsely advertised");
const unsupported=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,unsupported);
gl.compressedTexImage2D(gl.TEXTURE_2D,0,gl.COMPRESSED_RGB8_ETC2,4,4,0,new Uint8Array(8));
same(gl.getError(),gl.INVALID_ENUM,"unenabled optional ETC2 format correctly rejects");
gl.texStorage2D(gl.TEXTURE_2D,1,gl.COMPRESSED_RGB8_ETC2,4,4);
same(gl.getError(),gl.INVALID_ENUM,"unenabled optional compressed immutable storage correctly rejects");
gl.compressedTexSubImage2D(gl.TEXTURE_2D,0,0,0,4,4,gl.COMPRESSED_RGB8_ETC2,new Uint8Array(8));
same(gl.getError(),gl.INVALID_ENUM,"optional compressed 2D subimage correctly rejects");
const unenabledArray=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D_ARRAY,unenabledArray);
gl.compressedTexImage3D(gl.TEXTURE_2D_ARRAY,0,gl.COMPRESSED_RGB8_ETC2,4,4,1,0,new Uint8Array(8));
same(gl.getError(),gl.INVALID_ENUM,"optional compressed array image correctly rejects");
gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,0,4,4,1,gl.COMPRESSED_RGB8_ETC2,new Uint8Array(8));
same(gl.getError(),gl.INVALID_ENUM,"optional compressed array subimage correctly rejects");
gl.deleteTexture(unenabledArray);
gl.deleteTexture(unsupported);
gl.drawingBufferStorage(gl.SRGB8_ALPHA8,12,6);
same(gl.drawingBufferFormat,gl.SRGB8_ALPHA8,"actual drawing buffer format");
same([gl.drawingBufferWidth,gl.drawingBufferHeight],[12,6],"atomic drawing buffer resize");
gl.drawingBufferStorage(gl.RGBA8,8,8);gl.viewport(0,0,8,8);
gl.vertexAttribI4i(1,-1,2,3,4);check(gl.getVertexAttrib(1,gl.CURRENT_VERTEX_ATTRIB) instanceof Int32Array,"integer current attribute shape");
same([...gl.getVertexAttrib(1,gl.CURRENT_VERTEX_ATTRIB)],[-1,2,3,4],"integer current attribute values");
ok("transfer/storage/state formats");
globalThis.gpuTestsDone=true;
console.log("PASS: actual PBO, integer FBO, DOM float/packed formats, optional compressed-format rejection, atomic storage");
