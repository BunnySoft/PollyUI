function check(ok,message){if(!ok)throw new Error(message);}
function same(actual,expected,message){check(JSON.stringify(actual)===JSON.stringify(expected),message+": "+JSON.stringify(actual));}
const canvas=document.createElement("canvas");canvas.width=8;canvas.height=8;
const gl=canvas.getContext("webgl2",{preserveDrawingBuffer:true});
function error(code,label){same(gl.getError(),code,label);same(gl.getError(),0,label+" drains once");}
same(gl.getVertexAttrib(gl.getParameter(gl.MAX_VERTEX_ATTRIBS),gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),null,"invalid cached vertex binding result");
error(gl.INVALID_VALUE,"cached vertex binding validates index");
for(const [binding,limit]of [[gl.UNIFORM_BUFFER_BINDING,gl.MAX_UNIFORM_BUFFER_BINDINGS],
    [gl.TRANSFORM_FEEDBACK_BUFFER_BINDING,gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS]]){
    same(gl.getIndexedParameter(binding,gl.getParameter(limit)),null,"invalid cached indexed binding result");
    error(gl.INVALID_VALUE,"cached indexed binding validates index");
}
same(gl.getFramebufferAttachmentParameter(0,gl.COLOR_ATTACHMENT0,gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),null,"invalid cached attachment target result");
error(gl.INVALID_ENUM,"cached attachment validates target");
const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
same(gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER,0,gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),null,"invalid cached attachment result");
error(gl.INVALID_ENUM,"cached attachment validates attachment");
gl.bindFramebuffer(gl.FRAMEBUFFER,null);
const query=gl.createQuery(),conservative=gl.createQuery();
gl.beginQuery(gl.ANY_SAMPLES_PASSED,query);
same(gl.getQuery(gl.ANY_SAMPLES_PASSED,0),null,"invalid query pname must not return cached active query");
error(gl.INVALID_ENUM,"query getter validates pname");
gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,conservative);
error(gl.INVALID_OPERATION,"occlusion targets share one active slot");
check(gl.getQuery(gl.ANY_SAMPLES_PASSED,gl.CURRENT_QUERY)===query,"failed query begin preserves original active identity");
gl.endQuery(gl.ANY_SAMPLES_PASSED);
gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,conservative);
error(gl.NO_ERROR,"failed begin must not contaminate later successful query");
check(gl.getQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE,gl.CURRENT_QUERY)===conservative,"valid conservative query identity");
gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);gl.deleteQuery(query);gl.deleteQuery(conservative);
for(const name of ["drawingBufferColorSpace","unpackColorSpace"]){
    const property=Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype,name);
    for(const operation of [()=>property.get.call({}),()=>property.set.call({},"srgb")]){
        let threw=false;try{operation();}catch(e){threw=e instanceof TypeError;}
        check(threw,"color-space attribute requires a real context brand: "+name);
    }
}
const strict=document.createElement("canvas");let creationErrors=0;
strict.addEventListener("webglcontextcreationerror",()=>++creationErrors);
const strictContext=strict.getContext("webgl2",{failIfMajorPerformanceCaveat:true});
if(gpuRequestedPolicy==="hardware")check(strictContext&&strictContext.getContextAttributes().failIfMajorPerformanceCaveat,
    "strict hardware request accepts an actual native GPU-backed device");
else same(strictContext,null,"strict performance request refuses software/unclassified device");
await new Promise(resolve=>setTimeout(resolve,0));
same(creationErrors,strictContext?0:1,"strict acquisition/refusal emits the correct creation event");
const permissive=strictContext?document.createElement("canvas").getContext("webgl2"):strict.getContext("webgl2");
check(permissive&&!permissive.getContextAttributes().failIfMajorPerformanceCaveat,"strict failure does not lock canvas mode");
const pixel=new Uint8Array(4);
function readMip(texture,target,level,layer,expected=[255,255,255,255]){
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
    if(layer===undefined)gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,target,texture,level);
    else gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,texture,level,layer);
    same(gl.checkFramebufferStatus(gl.FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE,"generated mip framebuffer complete");
    gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    same([...pixel],expected,"actual generated mip pixels");
    error(gl.NO_ERROR,"generated mip readback");
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
}
for(const target of [gl.TEXTURE_2D,gl.TEXTURE_CUBE_MAP,gl.TEXTURE_3D,gl.TEXTURE_2D_ARRAY]){
    const texture=gl.createTexture();gl.bindTexture(target,texture);
    const isVolume=target===gl.TEXTURE_3D||target===gl.TEXTURE_2D_ARRAY;
    const width=4,height=4,depth=isVolume?4:1;
    if(target===gl.TEXTURE_CUBE_MAP){
        for(let face=gl.TEXTURE_CUBE_MAP_POSITIVE_X;face<=gl.TEXTURE_CUBE_MAP_NEGATIVE_Z;face++)
            gl.texImage2D(face,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(width*height*4).fill(255));
    }else if(isVolume)gl.texImage3D(target,0,gl.RGBA8,width,height,depth,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(width*height*depth*4).fill(255));
    else gl.texImage2D(target,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(width*height*4).fill(255));
    gl.generateMipmap(target);error(gl.NO_ERROR,"real mip generation "+target);
    readMip(texture,target===gl.TEXTURE_CUBE_MAP?gl.TEXTURE_CUBE_MAP_NEGATIVE_Z:target,1,isVolume?1:undefined);
    canvas.width=8;
    readMip(texture,target===gl.TEXTURE_CUBE_MAP?gl.TEXTURE_CUBE_MAP_POSITIVE_X:target,2,isVolume?(target===gl.TEXTURE_3D?0:3):undefined);
    gl.deleteTexture(texture);
}
const based=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,based);
gl.texImage2D(gl.TEXTURE_2D,2,gl.RGBA8,4,4,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(64).fill(255));
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_BASE_LEVEL,2);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,3);
readMip(based,gl.TEXTURE_2D,2);
gl.generateMipmap(gl.TEXTURE_2D);error(gl.NO_ERROR,"nonzero base/max level generation");
gl.finish();
readMip(based,gl.TEXTURE_2D,3);gl.deleteTexture(based);
const immutable=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,immutable);
gl.texStorage2D(gl.TEXTURE_2D,3,gl.RGBA8,4,4);
gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,4,4,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(64).fill(255));
gl.generateMipmap(gl.TEXTURE_2D);readMip(immutable,gl.TEXTURE_2D,1);gl.deleteTexture(immutable);
for(const target of [gl.TEXTURE_2D,gl.TEXTURE_CUBE_MAP,gl.TEXTURE_3D,gl.TEXTURE_2D_ARRAY])for(const immutable of [false,true]){
    const t=gl.createTexture();gl.bindTexture(target,t);
    const volume=target===gl.TEXTURE_3D||target===gl.TEXTURE_2D_ARRAY,depth=volume?4:1;
    if(immutable){
        if(volume)gl.texStorage3D(target,5,gl.RGBA8,16,16,target===gl.TEXTURE_3D?16:4);
        else gl.texStorage2D(target,5,gl.RGBA8,16,16);
    }
    const faces=target===gl.TEXTURE_CUBE_MAP?Array.from({length:6},(_,i)=>gl.TEXTURE_CUBE_MAP_POSITIVE_X+i):[target];
    for(const face of faces){
        const white=new Uint8Array(4*4*depth*4).fill(255);
        if(immutable){
            if(volume)gl.texSubImage3D(target,2,0,0,0,4,4,depth,gl.RGBA,gl.UNSIGNED_BYTE,white);
            else gl.texSubImage2D(face,2,0,0,4,4,gl.RGBA,gl.UNSIGNED_BYTE,white);
        }else if(volume)gl.texImage3D(target,2,gl.RGBA8,4,4,depth,0,gl.RGBA,gl.UNSIGNED_BYTE,white);
        else gl.texImage2D(face,2,gl.RGBA8,4,4,0,gl.RGBA,gl.UNSIGNED_BYTE,white);
    }
    gl.texParameteri(target,gl.TEXTURE_BASE_LEVEL,2);gl.texParameteri(target,gl.TEXTURE_MAX_LEVEL,3);
    gl.generateMipmap(target);error(gl.NO_ERROR,"all targets nonzero-base mip generation");
    readMip(t,faces[faces.length-1],3,volume?(target===gl.TEXTURE_3D?1:3):undefined);
    canvas.height=8;
    readMip(t,faces[0],3,volume?0:undefined);
    if(immutable)readMip(t,faces[0],4,volume?0:undefined,[0,0,0,0]);
    gl.deleteTexture(t);
}
const limit=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D_ARRAY,limit);
gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,512,512,64,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
error(gl.NO_ERROR,"exact 64 MiB base allocation");
gl.generateMipmap(gl.TEXTURE_2D_ARRAY);error(gl.OUT_OF_MEMORY,"mipmap storage is included in real per-resource budget");
gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,limit,0,0);
same(gl.checkFramebufferStatus(gl.FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE,"mipmap budget failure preserves base storage");
gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);same([...pixel],[0,0,0,0],"base stays initialized after mip rejection");
gl.framebufferTextureLayer(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,limit,1,0);
check(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE,"rejected mip is not falsely published");
gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteTexture(limit);gl.deleteFramebuffer(fbo);
error(gl.NO_ERROR,"independent review regression cleanup");
globalThis.gpuTestsDone=true;
console.log("PASS: cached getter validation, strict caveat acquisition, query atomicity, attribute brands, generated mip metadata/budgets");
