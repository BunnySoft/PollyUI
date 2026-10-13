(function installWebGL(native,descriptors) {
    "use strict";
    const contexts=new WeakMap(),objects=new WeakMap(),types={};
    // Three's LoadingManager creates a controller even for a local-only renderer.
    // This is real cancellation state/events, not a fetch/network implementation.
    const signals=new WeakMap(),controllers=new WeakMap(),signalToken={};
    class AbortSignal {
        constructor(token){if(token!==signalToken)throw new TypeError("Illegal constructor");signals.set(this,{aborted:false,reason:undefined,listeners:[],followers:[],onabort:null});}
        get aborted(){return signalState(this).aborted;}
        get reason(){return signalState(this).reason;}
        get onabort(){return signalState(this).onabort;}
        set onabort(value){signalState(this).onabort=typeof value==="function"?value:null;}
        throwIfAborted(){if(this.aborted)throw this.reason;}
        addEventListener(type,callback,options={}){
            if(String(type)!=="abort"||callback===null)return;
            const s=signalState(this),capture=typeof options==="boolean"?options:Boolean(options.capture);
            if(!s.listeners.some(l=>l.callback===callback&&l.capture===capture))
                s.listeners.push({callback,capture,once:Boolean(options&&options.once)});
        }
        removeEventListener(type,callback,options={}){
            if(String(type)!=="abort")return;
            const s=signalState(this),capture=typeof options==="boolean"?options:Boolean(options.capture);
            s.listeners=s.listeners.filter(l=>l.callback!==callback||l.capture!==capture);
        }
        static abort(reason){const signal=new AbortSignal(signalToken);abortSignal(signal,reason);return signal;}
        static timeout(milliseconds){
            const value=Number(milliseconds);
            if(!Number.isInteger(value)||value<0||value>Number.MAX_SAFE_INTEGER)throw new RangeError("Invalid timeout");
            const signal=new AbortSignal(signalToken);
            setTimeout(()=>abortSignal(signal,new DOMException("The operation timed out","TimeoutError")),value);
            return signal;
        }
        static any(inputs){
            const result=new AbortSignal(signalToken),list=Array.from(inputs);
            for(const signal of list){signalState(signal);if(signal.aborted){abortSignal(result,signal.reason);return result;}}
            for(const signal of list)signalState(signal).followers.push(result);
            return result;
        }
    }
    function signalState(signal){const s=signals.get(signal);if(!s)throw new TypeError("Illegal AbortSignal receiver");return s;}
    function abortSignal(signal,reason){
        const s=signalState(signal);if(s.aborted)return;
        s.aborted=true;s.reason=reason===undefined?new DOMException("The operation was aborted","AbortError"):reason;
        let immediate=false;
        const event={type:"abort",target:signal,currentTarget:signal,bubbles:false,cancelable:false,defaultPrevented:false,
            preventDefault(){},stopPropagation(){},stopImmediatePropagation(){immediate=true;}};
        for(const listener of [...s.listeners]){
            if(!s.listeners.includes(listener))continue;
            if(listener.once)s.listeners=s.listeners.filter(l=>l!==listener);
            if(typeof listener.callback==="function")listener.callback.call(signal,event);
            else if(listener.callback&&typeof listener.callback.handleEvent==="function")listener.callback.handleEvent(event);
            if(immediate)break;
        }
        if(!immediate&&s.onabort)s.onabort.call(signal,event);
        for(const follower of s.followers)abortSignal(follower,s.reason);
        s.followers=[];
    }
    class AbortController {
        constructor(){controllers.set(this,new AbortSignal(signalToken));}
        get signal(){const signal=controllers.get(this);if(!signal)throw new TypeError("Illegal AbortController receiver");return signal;}
        abort(reason){abortSignal(this.signal,reason);}
    }
    for(const [name,value]of Object.entries({AbortSignal,AbortController}))
        if(!(name in globalThis))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
    const constants=native(null,"constants",[]);
    if(!constants)return (canvas,options,media,call,queue)=>{
        media.shutdown=()=>{media.closed=true;};
        queue(()=>{if(!media.closed)call(canvas,"event",[],"webglcontextcreationerror");});
        return null;
    };
    Object.assign(constants,{UNPACK_FLIP_Y_WEBGL:0x9240,UNPACK_PREMULTIPLY_ALPHA_WEBGL:0x9241,
        CONTEXT_LOST_WEBGL:0x9242,UNPACK_COLORSPACE_CONVERSION_WEBGL:0x9243,BROWSER_DEFAULT_WEBGL:0x9244,
        MAX_CLIENT_WAIT_TIMEOUT_WEBGL:0x9247,TIMEOUT_IGNORED:-1});
    for(let i=1;i<32;i++)constants["TEXTURE"+i]=constants.TEXTURE0+i;
    for(let i=1;i<16;i++){constants["COLOR_ATTACHMENT"+i]=constants.COLOR_ATTACHMENT0+i;constants["DRAW_BUFFER"+i]=constants.DRAW_BUFFER0+i;}
    const names=["Buffer","Texture","Framebuffer","Renderbuffer","VertexArrayObject","Shader","Program",
        "UniformLocation","Sampler","Query","TransformFeedback","Sync"];
    class WebGLObject {constructor(){throw new TypeError("Illegal constructor");}}
    Object.defineProperty(WebGLObject.prototype,Symbol.toStringTag,{value:"WebGLObject",configurable:true});
    Object.defineProperty(globalThis,"WebGLObject",{value:WebGLObject,writable:true,configurable:true});
    for(let i=0;i<names.length;i++){
        const name="WebGL"+names[i];
        types[i]={[name]:class{constructor(){throw new TypeError("Illegal constructor");}}}[name];
        if(i!==7)Object.setPrototypeOf(types[i].prototype,WebGLObject.prototype);
        Object.defineProperty(types[i].prototype,Symbol.toStringTag,{value:name});
        Object.defineProperty(globalThis,name,{value:types[i],writable:true,configurable:true});
    }
    const infoTypes={};
    for(const name of ["WebGLActiveInfo","WebGLShaderPrecisionFormat"]){
        infoTypes[name]={[name]:class{constructor(){throw new TypeError("Illegal constructor");}}}[name];
        Object.defineProperty(infoTypes[name].prototype,Symbol.toStringTag,{value:name});
        Object.defineProperty(globalThis,name,{value:infoTypes[name],writable:true,configurable:true});
    }
    function readonlyInfo(type,value){
        if(!value)return null;
        const result=Object.create(infoTypes[type].prototype);
        for(const key of Object.keys(value))Object.defineProperty(result,key,{value:value[key],enumerable:true});
        return result;
    }
    class WebGL2RenderingContext {
        constructor(){throw new TypeError("Illegal constructor");}
        get canvas(){return state(this).canvas;}
        get drawingBufferWidth(){const s=state(this);poll(s);return s.lost?0:s.canvas.width;}
        get drawingBufferHeight(){const s=state(this);poll(s);return s.lost?0:s.canvas.height;}
        get drawingBufferFormat(){return native(state(this).handle,"format",[]);}
        get drawingBufferColorSpace(){state(this);return "srgb";}
        set drawingBufferColorSpace(value){state(this);colorSpace(value);}
        get unpackColorSpace(){state(this);return "srgb";}
        set unpackColorSpace(value){state(this);colorSpace(value);}
        drawingBufferStorage(format,width,height){
            const s=state(this);poll(s);
            if(arguments.length<3)throw new TypeError("drawingBufferStorage requires three arguments");
            if(!s.lost)native(s.canvas,"storage",[Number(format)>>>0,Number(width)>>>0,Number(height)>>>0]);
        }
        getContextAttributes(){const s=state(this);poll(s);return s.lost?null:{...s.attributes};}
        isContextLost(){const s=state(this);poll(s);return s.lost;}
        getError(){
            const s=state(this);poll(s);
            if(s.lost){if(!s.lossError){s.lossError=true;return constants.CONTEXT_LOST_WEBGL;}return constants.NO_ERROR;}
            const result=native(s.handle,"getError",[]);poll(s);
            if(s.lost&&!s.lossError){s.lossError=true;return constants.CONTEXT_LOST_WEBGL;}
            return result;
        }
        getSupportedExtensions(){
            const s=state(this);poll(s);if(s.lost)return null;
            return ["WEBGL_lose_context"];
        }
        getExtension(name){
            const s=state(this);poll(s);name=String(name).toLowerCase();
            if(s.lost)return null;
            if(name!=="webgl_lose_context")return null;
            if(!s.lossExtension)s.lossExtension=Object.freeze({
                loseContext(){if(!s.lost){native(s.handle,"lose",[]);lost(s);}},
                restoreContext(){
                    if(!s.lost||!s.restoreAllowed||s.closed){error(s,constants.INVALID_OPERATION);return;}
                    s.queue(()=>{
                        if(s.closed||!s.lost)return;
                        if(!native(s.handle,"restore",[])){console.error("WebGL2 context restoration failed");return;}
                        s.lost=false;s.lossError=false;++s.generation;s.bindings.clear();s.defaultVao={attributes:new Map(),element:null};
                        s.vao=null;s.activeTexture=0;s.unpackFlip=false;s.unpackPremultiply=false;s.unpackColor=constants.BROWSER_DEFAULT_WEBGL;
                        s.media(s.canvas,"event",[],"webglcontextrestored");
                        s.media(s.canvas,"layout");
                    });
                }
            });
            return s.lossExtension;
        }
        getParameter(name){
            const s=state(this);name=Number(name)>>>0;poll(s);
            if(s.lost)return null;
            if(name===constants.UNPACK_FLIP_Y_WEBGL)return s.unpackFlip;
            if(name===constants.UNPACK_PREMULTIPLY_ALPHA_WEBGL)return s.unpackPremultiply;
            if(name===constants.UNPACK_COLORSPACE_CONVERSION_WEBGL)return s.unpackColor;
            if(name===constants.MAX_CLIENT_WAIT_TIMEOUT_WEBGL)return 0;
            if(name===constants.SAMPLER_BINDING)return s.bindings.get(`sampler:${s.activeTexture}`)||null;
            if(name===constants.TRANSFORM_FEEDBACK_BINDING)return s.bindings.get("feedback")||null;
            if(name===constants.ELEMENT_ARRAY_BUFFER_BINDING)return vao(s).element;
            if(name===constants.VERTEX_ARRAY_BINDING)return s.vao;
            const bindingNames=new Map([[constants.ARRAY_BUFFER_BINDING,constants.ARRAY_BUFFER],
                [constants.COPY_READ_BUFFER_BINDING,constants.COPY_READ_BUFFER],[constants.COPY_WRITE_BUFFER_BINDING,constants.COPY_WRITE_BUFFER],
                [constants.UNIFORM_BUFFER_BINDING,constants.UNIFORM_BUFFER],[constants.PIXEL_PACK_BUFFER_BINDING,constants.PIXEL_PACK_BUFFER],
                [constants.PIXEL_UNPACK_BUFFER_BINDING,constants.PIXEL_UNPACK_BUFFER],[constants.CURRENT_PROGRAM,"program"],
                [constants.FRAMEBUFFER_BINDING,"drawFbo"],[constants.READ_FRAMEBUFFER_BINDING,"readFbo"],
                [constants.RENDERBUFFER_BINDING,"rbo"],[constants.TRANSFORM_FEEDBACK_BUFFER_BINDING,constants.TRANSFORM_FEEDBACK_BUFFER]]);
            if(bindingNames.has(name))return s.bindings.get(bindingNames.get(name))||null;
            const textureBindings=new Map([[constants.TEXTURE_BINDING_2D,constants.TEXTURE_2D],
                [constants.TEXTURE_BINDING_CUBE_MAP,constants.TEXTURE_CUBE_MAP],[constants.TEXTURE_BINDING_3D,constants.TEXTURE_3D],
                [constants.TEXTURE_BINDING_2D_ARRAY,constants.TEXTURE_2D_ARRAY]]);
            if(textureBindings.has(name))return s.bindings.get(`texture:${s.activeTexture}:${textureBindings.get(name)}`)||null;
            const result=call(s,"getParameter",[name]);
            if(name===constants.VERSION&&result)return "WebGL 2.0 ("+result+")";
            if(name===constants.SHADING_LANGUAGE_VERSION&&result)return "WebGL GLSL ES 3.00 ("+result+")";
            if(Array.isArray(result)){
                if([constants.VIEWPORT,constants.SCISSOR_BOX,constants.MAX_VIEWPORT_DIMS].includes(name))return new Int32Array(result);
                if(name===constants.COMPRESSED_TEXTURE_FORMATS)return new Uint32Array(result);
                if(name===constants.COLOR_WRITEMASK)return result;
                return new Float32Array(result);
            }
            return result;
        }
        pixelStorei(name,value){
            const s=state(this);name=Number(name)>>>0;
            if(name===constants.UNPACK_FLIP_Y_WEBGL){s.unpackFlip=Boolean(value);return;}
            if(name===constants.UNPACK_PREMULTIPLY_ALPHA_WEBGL){s.unpackPremultiply=Boolean(value);return;}
            if(name===constants.UNPACK_COLORSPACE_CONVERSION_WEBGL){
                value=Number(value)>>>0;
                if(value!==constants.NONE&&value!==constants.BROWSER_DEFAULT_WEBGL){error(s,constants.INVALID_VALUE);return;}
                s.unpackColor=value;return;
            }
            call(s,"pixelStorei",[name,Number(value)|0]);
        }
    }
    function state(context){
        const s=contexts.get(context);if(!s)throw new TypeError("Illegal WebGL2 receiver");
        if(s.closed)throw new TypeError("GUI WebGL scope is closed");
        return s;
    }
    function colorSpace(value){
        value=String(value);
        if(value!=="srgb"&&value!=="display-p3")throw new TypeError("Invalid PredefinedColorSpace");
        if(value!=="srgb")throw new DOMException("Only sRGB is supported","NotSupportedError");
    }
    function poll(s){if(!s.lost&&native(s.handle,"lost",[]))lost(s);}
    function lost(s){
        if(s.lost)return;
        s.lost=true;s.restoreAllowed=false;s.lossError=false;
        s.queue(()=>{if(!s.closed)s.restoreAllowed=s.media(s.canvas,"event",[],"webglcontextlost");});
        s.media(s.canvas,"layout");
    }
    function error(s,code){if(!s.lost)native(s.handle,"error",[code]);}
    function call(s,op,args){
        poll(s);if(s.lost){
            if(op==="checkFramebufferStatus")return constants.FRAMEBUFFER_UNSUPPORTED;
            if(op==="getAttribLocation"||op==="getFragDataLocation")return -1;
            if(op==="clientWaitSync"||op==="getUniformBlockIndex"||op==="getVertexAttribOffset")return 0;
            if(op==="isEnabled"||op==="is")return false;
            if(op.startsWith("get")||op==="create"||op==="fenceSync")return null;
            return undefined;
        }
        const result=native(s.handle,op,args);
        poll(s);
        if(["clear","drawArrays","drawElements","drawArraysInstanced","drawElementsInstanced","blitFramebuffer",
            "clearBufferfv","clearBufferiv","clearBufferuiv","clearBufferfi"].includes(op))s.media(s.canvas,"layout");
        if(op==="getShaderPrecisionFormat")return readonlyInfo("WebGLShaderPrecisionFormat",result);
        if(["getActiveAttrib","getActiveUniform","getTransformFeedbackVarying"].includes(op))
            return readonlyInfo("WebGLActiveInfo",result);
        if(result===undefined&&op.startsWith("get")&&op!=="getBufferSubData")return null;
        return result;
    }
    function object(s,value,kind,nullable=true,deleted=false){
        if(value===null&&nullable)return null;
        const r=objects.get(value);
        if(!r||r.kind!==kind)throw new TypeError("Expected WebGL"+names[kind]);
        if(r.state!==s||r.generation!==s.generation||(!deleted&&r.deleted)){
            error(s,constants.INVALID_OPERATION);return undefined;
        }
        return r.handle;
    }
    function wrap(s,handle,kind){
        if(!handle)return null;
        const result=Object.create(types[kind].prototype);
        objects.set(result,{handle,kind,state:s,generation:s.generation,deleted:false,
            attributes:kind===4?new Map():undefined,element:null,attached:new Map()});
        return result;
    }
    function vao(s){return s.vao?objects.get(s.vao):s.defaultVao;}
    const proto=WebGL2RenderingContext.prototype;
    for(let kind=0;kind<names.length;kind++){
        if(kind===7)continue;
        const suffix=names[kind]==="VertexArrayObject"?"VertexArray":names[kind];
        if(kind!==11)proto["create"+suffix]=function(...args){
            const s=state(this);
            if(kind===5&&!args.length)throw new TypeError("createShader requires shader type");
            return wrap(s,call(s,"create",[kind,...args.map(Number)]),kind);
        };
        proto["delete"+suffix]=function(value){
            const s=state(this);if(value===null)return;
            const handle=object(s,value,kind,true,true);if(handle===undefined)return;
            const r=objects.get(value);
            if(r.deleted)return;
            if(call(s,"delete",[kind,handle])!==true)return;r.deleted=true;
            for(const [key,bound]of s.bindings)if(bound===value&&!(kind===6&&key==="program"))s.bindings.set(key,null);
            if(kind===0){
                if(vao(s).element===value)vao(s).element=null;
                for(const a of vao(s).attributes.values())if(a.buffer===value)a.buffer=null;
            }
            if(kind===4&&s.vao===value)s.vao=null;
            if(kind===1||kind===3){
                for(const key of ["drawFbo","readFbo"]){
                    const fbo=s.bindings.get(key);
                    if(fbo)for(const [attachment,bound]of objects.get(fbo).attached)
                        if(bound===value)objects.get(fbo).attached.delete(attachment);
                }
            }
        };
        proto["is"+suffix]=function(value){
            const s=state(this),r=objects.get(value);
            return Boolean(r&&r.kind===kind&&r.state===s&&r.generation===s.generation&&!r.deleted&&
                call(s,"is",[kind,r.handle]));
        };
    }
    proto.bindBuffer=function(target,value){
        const s=state(this),handle=object(s,value,0);if(handle===undefined)return;
        target=Number(target)>>>0;
        if(call(s,"bindBuffer",[target,handle])!==true)return;
        if(target===constants.ELEMENT_ARRAY_BUFFER)vao(s).element=value;else s.bindings.set(target,value);
    };
    proto.bindTexture=function(target,value){
        const s=state(this),handle=object(s,value,1);if(handle===undefined)return;
        target=Number(target)>>>0;if(call(s,"bindTexture",[target,handle])!==true)return;
        s.bindings.set(`texture:${s.activeTexture}:${target}`,value);
    };
    proto.bindFramebuffer=function(target,value){
        const s=state(this),handle=object(s,value,2);if(handle===undefined)return;
        target=Number(target)>>>0;if(call(s,"bindFramebuffer",[target,handle])!==true)return;
        if(target!==constants.READ_FRAMEBUFFER)s.bindings.set("drawFbo",value);
        if(target!==constants.DRAW_FRAMEBUFFER)s.bindings.set("readFbo",value);
    };
    proto.bindRenderbuffer=function(target,value){
        const s=state(this),handle=object(s,value,3);if(handle===undefined)return;
        if(call(s,"bindRenderbuffer",[Number(target)>>>0,handle])!==true)return;s.bindings.set("rbo",value);
    };
    proto.bindVertexArray=function(value){
        const s=state(this),handle=object(s,value,4);if(handle===undefined)return;
        if(call(s,"bindVertexArray",[handle])!==true)return;s.vao=value;
    };
    proto.useProgram=function(value){
        const s=state(this),handle=object(s,value,6);if(handle===undefined)return;
        if(call(s,"useProgram",[handle])!==true)return;s.bindings.set("program",value);
    };
    proto.activeTexture=function(unit){
        const s=state(this);unit=Number(unit)>>>0;if(call(s,"activeTexture",[unit])!==true)return;s.activeTexture=unit-constants.TEXTURE0;
    };
    function view(s,data,offset=0,length){
        if(data instanceof DataView)data=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
        if(!ArrayBuffer.isView(data))throw new TypeError("Expected typed array");
        offset=Number(offset)>>>0;length=length===undefined||Number(length)===0?data.length-offset:Number(length)>>>0;
        if(offset>data.length||length>data.length-offset){error(s,constants.INVALID_VALUE);return null;}
        return data.subarray(offset,offset+length);
    }
    proto.bufferData=function(target,data,usage,offset,length){
        const s=state(this);
        if(arguments.length<3)throw new TypeError("bufferData requires three arguments");
        if(offset!==undefined){data=view(s,data,offset,length);if(!data)return;}
        if(data instanceof DataView)data=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
        if(data===null){error(s,constants.INVALID_VALUE);return;}
        if(typeof data!=="number"&&!(data instanceof ArrayBuffer)&&!ArrayBuffer.isView(data))throw new TypeError("Invalid buffer source");
        call(s,"bufferData",[Number(target)>>>0,data,Number(usage)>>>0]);
    };
    proto.bufferSubData=function(target,offset,data,srcOffset,length){
        const s=state(this);
        if(arguments.length<3)throw new TypeError("bufferSubData requires three arguments");
        if(srcOffset!==undefined){data=view(s,data,srcOffset,length);if(!data)return;}
        if(data instanceof DataView)data=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
        if(!(data instanceof ArrayBuffer)&&!ArrayBuffer.isView(data))throw new TypeError("Invalid buffer source");
        call(s,"bufferSubData",[Number(target)>>>0,Number(offset),data]);
    };
    proto.getBufferSubData=function(target,offset,data,dstOffset=0,length){
        const s=state(this);data=view(s,data,dstOffset,length);if(!data)return;
        call(s,"getBufferSubData",[Number(target)>>>0,Number(offset),data]);
    };
    for(const name of ["vertexAttribPointer","vertexAttribIPointer"]){
        proto[name]=function(...args){
            const s=state(this);if(args.length<(name==="vertexAttribPointer"?6:5))throw new TypeError("Not enough arguments");
            if(call(s,name,args.map(v=>typeof v==="boolean"?Number(v):Number(v)))!==true)return;
            const index=Number(args[0])>>>0,a=vao(s).attributes.get(index)||{};
            a.buffer=s.bindings.get(constants.ARRAY_BUFFER)||null;vao(s).attributes.set(index,a);
        };
    }
    for(const [name,kind]of [["shaderSource",5],["compileShader",5],["getShaderParameter",5],["getShaderInfoLog",5],
        ["getShaderSource",5],["linkProgram",6],["validateProgram",6],["getProgramParameter",6],["getProgramInfoLog",6],
        ["getActiveUniform",6],["getActiveAttrib",6],["getAttribLocation",6],["bindAttribLocation",6]]){
        proto[name]=function(value,...args){
            const s=state(this);
            if(name==="getAttribLocation"&&s.lost)return -1;
            const handle=object(s,value,kind,false,true);if(handle===undefined)return null;
            const textIndex=name==="bindAttribLocation"?1:0;
            const text=["shaderSource","getAttribLocation","bindAttribLocation"].includes(name);
            const result=call(s,name,[handle,...args.map((v,i)=>text&&i===textIndex?String(v):Number(v))]);
            return result;
        };
    }
    for(const name of ["attachShader","detachShader"]){
        proto[name]=function(program,shader){
            const s=state(this),p=object(s,program,6,false,true),h=object(s,shader,5,false,true);
            if(p===undefined||h===undefined)return;
            if(call(s,name,[p,h])!==true)return;
            if(name==="attachShader")objects.get(program).attached.set(shader,shader);
            else objects.get(program).attached.delete(shader);
        };
    }
    proto.getAttachedShaders=function(program){
        const s=state(this);if(object(s,program,6,false,true)===undefined)return null;
        return s.lost?null:[...objects.get(program).attached.values()];
    };
    proto.getUniformLocation=function(program,name){
        const s=state(this),handle=object(s,program,6,false,true);if(handle===undefined)return null;
        return wrap(s,call(s,"getUniformLocation",[handle,String(name)]),7);
    };
    for(let width=1;width<=4;width++)for(const suffix of ["f","i","ui","fv","iv","uiv"]){
        const name=`uniform${width}${suffix}`;
        proto[name]=function(location,...args){
            const s=state(this);if(location===null)return;
            const handle=object(s,location,7,false);if(handle===undefined)return;
            if(suffix.endsWith("v")){
                const Type=suffix==="fv"?Float32Array:suffix==="iv"?Int32Array:Uint32Array;
                let data=args[0] instanceof Type?args[0]:new Type(args[0]);
                data=view(s,data,args[1]||0,args[2]);if(!data)return;
                call(s,name,[handle,data]);
            }else call(s,name,[handle,...args.map(Number)]);
        };
    }
    for(const size of ["2","3","4","2x3","3x2","2x4","4x2","3x4","4x3"]){
        const name=`uniformMatrix${size}fv`;
        proto[name]=function(location,transpose,data,offset=0,length){
            const s=state(this);if(location===null)return;
            const handle=object(s,location,7,false);if(handle===undefined)return;
            data=data instanceof Float32Array?data:new Float32Array(data);data=view(s,data,offset,length);if(!data)return;
            call(s,name,[handle,Number(Boolean(transpose)),data]);
        };
    }
    function source(s,value,format,type,targetWidth,targetHeight,depth=1){
        let width,height,bytes;
        if(value instanceof ImageData){width=value.width;height=value.height;bytes=new Uint8Array(value.data);}
        else if(value instanceof HTMLCanvasElement||value instanceof HTMLImageElement){
            width=value instanceof HTMLCanvasElement?value.width:value.naturalWidth;
            height=value instanceof HTMLCanvasElement?value.height:value.naturalHeight;
            if(!width||!height){error(s,constants.INVALID_VALUE);return null;}
            const snapshot=s.media(value,"snapshot");
            if(!snapshot){error(s,constants.INVALID_VALUE);return null;}
            bytes=new Uint8Array(s.media(null,"sourcePixels",[width,height],"",snapshot));
        }else throw new TypeError("Expected ImageData, canvas or decoded Image/img");
        if(s.unpackFlip)for(let y=0;y<height/2;y++)for(let x=0;x<width*4;x++){
            const a=y*width*4+x,b=(height-y-1)*width*4+x,t=bytes[a];bytes[a]=bytes[b];bytes[b]=t;
        }
        if(s.unpackPremultiply)for(let i=0;i<bytes.length;i+=4)for(let channel=0;channel<3;channel++)
            bytes[i+channel]=Math.round(bytes[i+channel]*bytes[i+3]/255);
        const channels=format===constants.RGBA?[0,1,2,3]:format===constants.RGB?[0,1,2]:
            format===constants.RED||format===constants.LUMINANCE?[0]:format===constants.RG?[0,1]:
            format===constants.ALPHA?[3]:format===constants.LUMINANCE_ALPHA?[0,3]:null;
        if(!channels){error(s,constants.INVALID_ENUM);return null;}
        const w=targetWidth===undefined?width:Number(targetWidth)|0,h=targetHeight===undefined?height:Number(targetHeight)|0;
        const alignment=thisParameter(s,constants.UNPACK_ALIGNMENT),row=thisParameter(s,constants.UNPACK_ROW_LENGTH)||w;
        const sx=thisParameter(s,constants.UNPACK_SKIP_PIXELS),sy=thisParameter(s,constants.UNPACK_SKIP_ROWS);
        const imageHeight=thisParameter(s,constants.UNPACK_IMAGE_HEIGHT)||h;
        const skipImages=depth>1?thisParameter(s,constants.UNPACK_SKIP_IMAGES):0;
        if(w<0||h<0||depth<0||row<w||sx+w>width||sy+(skipImages+depth-1)*imageHeight+h>height){
            error(s,constants.INVALID_OPERATION);return null;
        }
        let Type,bpp;
        if(type===constants.UNSIGNED_BYTE){Type=Uint8Array;bpp=channels.length;}
        else if(type===constants.FLOAT){Type=Float32Array;bpp=channels.length*4;}
        else if(type===constants.HALF_FLOAT){Type=Uint16Array;bpp=channels.length*2;}
        else if([constants.UNSIGNED_SHORT_5_6_5,constants.UNSIGNED_SHORT_4_4_4_4,constants.UNSIGNED_SHORT_5_5_5_1].includes(type)){Type=Uint16Array;bpp=2;}
        else if([constants.UNSIGNED_INT_2_10_10_10_REV,constants.UNSIGNED_INT_10F_11F_11F_REV,constants.UNSIGNED_INT_5_9_9_9_REV].includes(type)){Type=Uint32Array;bpp=4;}
        else {error(s,constants.INVALID_ENUM);return null;}
        const stride=Math.ceil(row*bpp/alignment)*alignment,imageStride=stride*imageHeight;
        const length=w&&h&&depth?stride*(sy+h-1)+(sx+w)*bpp+imageStride*(skipImages+depth-1):0;
        if(!Number.isSafeInteger(length)||length>67108864){error(s,constants.OUT_OF_MEMORY);return null;}
        const result=new Type(Math.ceil(length/Type.BYTES_PER_ELEMENT));
        function roundEven(value){const n=Math.floor(value),fraction=value-n;return n+(fraction>.5||(fraction===.5&&(n&1))?1:0);}
        function smallFloat(value,mantissa){
            if(!value)return 0;
            let exponent=Math.floor(Math.log2(value)),fraction=roundEven((value/2**exponent-1)*2**mantissa);
            if(fraction===2**mantissa){fraction=0;++exponent;}
            return ((exponent+15)<<mantissa)|fraction;
        }
        for(let z=0;z<depth;z++)for(let y=0;y<h;y++)for(let x=0;x<w;x++){
            const at=((sy+(skipImages+z)*imageHeight+y)*width+sx+x)*4;
            const rgba=[bytes[at],bytes[at+1],bytes[at+2],bytes[at+3]];
            const out=(imageStride*(skipImages+z)+stride*(sy+y)+(sx+x)*bpp)/Type.BYTES_PER_ELEMENT;
            if(type===constants.UNSIGNED_BYTE)channels.forEach((c,i)=>result[out+i]=rgba[c]);
            else if(type===constants.FLOAT)channels.forEach((c,i)=>result[out+i]=rgba[c]/255);
            else if(type===constants.HALF_FLOAT)channels.forEach((c,i)=>result[out+i]=smallFloat(rgba[c]/255,10));
            else if(type===constants.UNSIGNED_SHORT_5_6_5)
                result[out]=(roundEven(rgba[0]*31/255)<<11)|(roundEven(rgba[1]*63/255)<<5)|roundEven(rgba[2]*31/255);
            else if(type===constants.UNSIGNED_SHORT_4_4_4_4)
                result[out]=(roundEven(rgba[0]*15/255)<<12)|(roundEven(rgba[1]*15/255)<<8)|(roundEven(rgba[2]*15/255)<<4)|roundEven(rgba[3]*15/255);
            else if(type===constants.UNSIGNED_SHORT_5_5_5_1)
                result[out]=(roundEven(rgba[0]*31/255)<<11)|(roundEven(rgba[1]*31/255)<<6)|(roundEven(rgba[2]*31/255)<<1)|(rgba[3]>=128?1:0);
            else if(type===constants.UNSIGNED_INT_2_10_10_10_REV)
                result[out]=roundEven(rgba[0]*1023/255)|(roundEven(rgba[1]*1023/255)<<10)|(roundEven(rgba[2]*1023/255)<<20)|(roundEven(rgba[3]*3/255)<<30);
            else if(type===constants.UNSIGNED_INT_10F_11F_11F_REV)
                result[out]=smallFloat(rgba[0]/255,6)|(smallFloat(rgba[1]/255,6)<<11)|(smallFloat(rgba[2]/255,5)<<22);
            else {
                const values=rgba.slice(0,3).map(v=>v/255),max=Math.max(...values);
                let exponent=max?Math.max(-16,Math.floor(Math.log2(max))+1)+15:0;
                let mantissas=values.map(v=>roundEven(v/2**(exponent-24)));
                if(Math.max(...mantissas)>511){++exponent;mantissas=values.map(v=>roundEven(v/2**(exponent-24)));}
                result[out]=mantissas[0]|(mantissas[1]<<9)|(mantissas[2]<<18)|(exponent<<27);
            }
        }
        return {width:w,height:h,bytes:result};
    }
    function thisParameter(s,name){return native(s.handle,"getParameter",[name]);}
    proto.texImage2D=function(...args){
        const s=state(this);
        if(args.length===6){
            const [target,level,internal,format,type,image]=args.map((v,i)=>i<5?Number(v):v);
            const pixels=source(s,image,format,type);if(!pixels)return;
            call(s,"texImage2D",[target,level,internal,pixels.width,pixels.height,0,format,type,pixels.bytes]);
        }else{
            if(args.length<9)throw new TypeError("Invalid texImage2D overload");
            let data=args[8];
            if(data!==null&&typeof data!=="number"&&!ArrayBuffer.isView(data)){
                const pixels=source(s,data,Number(args[6]),Number(args[7]),args[3],args[4]);if(!pixels)return;data=pixels.bytes;
            }else if(s.unpackFlip||s.unpackPremultiply){error(s,constants.INVALID_OPERATION);return;}
            if(args.length>9&&data!==null){data=view(s,data,args[9]);if(!data)return;}
            call(s,"texImage2D",[...args.slice(0,8).map(Number),data]);
        }
    };
    proto.texSubImage2D=function(...args){
        const s=state(this);
        if(args.length===7){
            const [target,level,x,y,format,type,image]=args.map((v,i)=>i<6?Number(v):v);
            const pixels=source(s,image,format,type);if(!pixels)return;
            call(s,"texSubImage2D",[target,level,x,y,pixels.width,pixels.height,format,type,pixels.bytes]);
        }else{
            if(args.length<9)throw new TypeError("Invalid texSubImage2D overload");
            let data=args[8];
            if(data!==null&&typeof data!=="number"&&!ArrayBuffer.isView(data)){
                const pixels=source(s,data,Number(args[6]),Number(args[7]),args[4],args[5]);if(!pixels)return;data=pixels.bytes;
            }else if(s.unpackFlip||s.unpackPremultiply){error(s,constants.INVALID_OPERATION);return;}
            if(args.length>9&&data!==null){data=view(s,data,args[9]);if(!data)return;}
            call(s,"texSubImage2D",[...args.slice(0,8).map(Number),data]);
        }
    };
    for(const [name,count]of [["texImage3D",10],["texSubImage3D",11]]){
        proto[name]=function(...args){
            const s=state(this);if(args.length<count)throw new TypeError("Not enough texture arguments");
            let data=args[count-1];
            if(data!==null&&typeof data!=="number"&&!ArrayBuffer.isView(data)){
                const start=name==="texImage3D"?3:5,format=name==="texImage3D"?7:8;
                const pixels=source(s,data,Number(args[format]),Number(args[format+1]),args[start],args[start+1],Number(args[start+2])|0);
                if(!pixels)return;data=pixels.bytes;
            }else if(s.unpackFlip||s.unpackPremultiply){error(s,constants.INVALID_OPERATION);return;}
            if(args.length>count&&data!==null){data=view(s,data,args[count]);if(!data)return;}
            call(s,name,[...args.slice(0,count-1).map(Number),data]);
        };
    }
    proto.readPixels=function(x,y,width,height,format,type,data,offset=0){
        const s=state(this);
        if(typeof data!=="number"){data=view(s,data,offset);if(!data)return;}
        call(s,"readPixels",[x,y,width,height,format,type].map(Number).concat(data));
    };
    for(const [name,kind,index]of [["framebufferTexture2D",1,3],["framebufferTextureLayer",1,2],
        ["framebufferRenderbuffer",3,3]]){
        proto[name]=function(...args){
            const s=state(this),value=args[index],handle=object(s,value,kind);
            if(handle===undefined)return;
            const target=Number(args[0]),fbo=s.bindings.get(target===constants.READ_FRAMEBUFFER?"readFbo":"drawFbo");
            if(call(s,name,args.map((v,i)=>i===index?handle:Number(v)))!==true)return;
            if(fbo){
                const attachments=objects.get(fbo).attached;
                if(Number(args[1])===constants.DEPTH_STENCIL_ATTACHMENT){
                    attachments.set(constants.DEPTH_ATTACHMENT,value);attachments.set(constants.STENCIL_ATTACHMENT,value);
                }else attachments.set(Number(args[1]),value);
            }
        };
    }
    proto.drawBuffers=function(values){call(state(this),"drawBuffers",[new Uint32Array(values)]);};
    proto.getUniform=function(program,location){
        const s=state(this),p=object(s,program,6,false,true),l=object(s,location,7,false);
        if(p===undefined||l===undefined)return null;
        const result=call(s,"getUniform",[p,l]);if(!result)return null;
        if(result.values.length===1)return result.values[0];
        return result.kind===0?new Float32Array(result.values):result.kind===1?result.values:
            result.kind===2?new Uint32Array(result.values):new Int32Array(result.values);
    };
    proto.getVertexAttrib=function(index,name){
        const s=state(this);index=Number(index)>>>0;name=Number(name)>>>0;
        const value=call(s,"getVertexAttrib",[index,name]);
        if(name===constants.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING)return value?vao(s).attributes.get(index)?.buffer||null:null;
        if(value&&value.values)return value.type===constants.INT?new Int32Array(value.values):
            value.type===constants.UNSIGNED_INT?new Uint32Array(value.values):new Float32Array(value.values);
        return Array.isArray(value)?new Float32Array(value):value;
    };
    for(const suffix of ["1fv","2fv","3fv","4fv","I4iv","I4uiv"]){
        const name="vertexAttrib"+suffix,scalar=name.slice(0,-1);
        proto[name]=function(index,values){
            const s=state(this),count=suffix.startsWith("I")?4:Number(suffix[0]);
            values=Array.from(values,Number);if(values.length<count){error(s,constants.INVALID_VALUE);return;}
            call(s,scalar,[Number(index)>>>0,...values.slice(0,count)]);
        };
    }
    proto.bindSampler=function(unit,value){
        const s=state(this),handle=object(s,value,8);if(handle===undefined)return;
        if(call(s,"bindSampler",[Number(unit)>>>0,handle])!==true)return;s.bindings.set(`sampler:${Number(unit)>>>0}`,value);
    };
    for(const name of ["samplerParameteri","samplerParameterf","getSamplerParameter"]){
        proto[name]=function(sampler,...args){
            const s=state(this),handle=object(s,sampler,8,false);if(handle===undefined)return null;
            return call(s,name,[handle,...args.map(Number)]);
        };
    }
    for(const name of ["bindBufferBase","bindBufferRange"]){
        proto[name]=function(target,index,buffer,...args){
            const s=state(this),handle=object(s,buffer,0);if(handle===undefined)return;
            target=Number(target)>>>0;index=Number(index)>>>0;
            if(call(s,name,[target,index,handle,...args.map(Number)])!==true)return;
            s.bindings.set(target,buffer);
            const feedback=s.bindings.get("feedback");
            if(target===constants.TRANSFORM_FEEDBACK_BUFFER&&feedback)objects.get(feedback).attached.set(index,buffer);
            else s.bindings.set(`indexed:${target}:${index}`,buffer);
        };
    }
    proto.getIndexedParameter=function(target,index){
        const s=state(this);target=Number(target)>>>0;index=Number(index)>>>0;
        const value=call(s,"getIndexedParameter",[target,index]);
        if(target===constants.UNIFORM_BUFFER_BINDING||target===constants.TRANSFORM_FEEDBACK_BUFFER_BINDING){
            if(!value)return null;
            const feedback=s.bindings.get("feedback");
            if(target===constants.TRANSFORM_FEEDBACK_BUFFER_BINDING&&feedback)return objects.get(feedback).attached.get(index)||null;
            const binding=target===constants.UNIFORM_BUFFER_BINDING?constants.UNIFORM_BUFFER:constants.TRANSFORM_FEEDBACK_BUFFER;
            return s.bindings.get(`indexed:${binding}:${index}`)||null;
        }
        return value;
    };
    for(const name of ["getUniformBlockIndex","getActiveUniformBlockName","getActiveUniformBlockParameter","uniformBlockBinding",
        "getUniformIndices","getActiveUniforms","transformFeedbackVaryings","getTransformFeedbackVarying"]){
        proto[name]=function(program,...args){
            const s=state(this),handle=object(s,program,6,false);if(handle===undefined)return null;
            if(name==="getUniformIndices"||name==="transformFeedbackVaryings")args[0]=Array.from(args[0],String);
            else if(name==="getActiveUniforms")args[0]=new Uint32Array(args[0]);
            else args=args.map((v,i)=>name==="getUniformBlockIndex"&&i===0?String(v):Number(v));
            if(name==="transformFeedbackVaryings")args[1]=Number(args[1]);
            if(name==="getActiveUniforms")args[1]=Number(args[1]);
            const result=call(s,name,[handle,...args]);
            if(Array.isArray(result)){
                if(name==="getActiveUniforms"&&args[1]===constants.UNIFORM_IS_ROW_MAJOR)return result.map(Boolean);
                if(name==="getActiveUniforms"||name==="getUniformIndices")return result;
                return new Uint32Array(result);
            }return result;
        };
    }
    function querySlot(target){return target===constants.ANY_SAMPLES_PASSED_CONSERVATIVE?constants.ANY_SAMPLES_PASSED:target;}
    proto.beginQuery=function(target,query){
        const s=state(this),handle=object(s,query,9,false);if(handle===undefined)return;
        if(call(s,"beginQuery",[Number(target)>>>0,handle])!==true)return;
        objects.get(query).visible=false;s.bindings.set(`query:${querySlot(Number(target)>>>0)}`,query);
    };
    proto.endQuery=function(target){
        const s=state(this),key=`query:${querySlot(Number(target)>>>0)}`,query=s.bindings.get(key);
        if(call(s,"endQuery",[Number(target)>>>0])!==true)return;
        s.bindings.delete(key);
        if(query){const r=objects.get(query);s.queue(()=>{if(!s.closed&&!r.deleted&&r.generation===s.generation)r.visible=true;});}
    };
    proto.getQuery=function(target,pname){
        const s=state(this),value=call(s,"getQuery",[Number(target)>>>0,Number(pname)>>>0]);
        return value?s.bindings.get(`query:${querySlot(Number(target)>>>0)}`)||null:null;
    };
    proto.getQueryParameter=function(query,pname){
        const s=state(this);poll(s);if(s.lost)return null;
        const handle=object(s,query,9,false);if(handle===undefined)return null;
        if(!objects.get(query).visible){
            if(Number(pname)===constants.QUERY_RESULT_AVAILABLE)return false;
            if(Number(pname)===constants.QUERY_RESULT){error(s,constants.INVALID_OPERATION);return null;}
        }
        return call(s,"getQueryParameter",[handle,Number(pname)>>>0]);
    };
    proto.fenceSync=function(condition,flags){
        const s=state(this),sync=wrap(s,call(s,"fenceSync",[Number(condition)>>>0,Number(flags)>>>0]),11);
        if(sync){const r=objects.get(sync);r.visible=false;s.queue(()=>{if(!s.closed&&!r.deleted&&r.generation===s.generation)r.visible=true;});}
        return sync;
    };
    for(const name of ["clientWaitSync","waitSync","getSyncParameter"]){
        proto[name]=function(sync,...args){
            const s=state(this),handle=object(s,sync,11,false);if(handle===undefined)return null;
            const result=call(s,name,[handle,...args.map(Number)]);
            if(!objects.get(sync).visible){
                if(name==="clientWaitSync"&&[constants.ALREADY_SIGNALED,constants.CONDITION_SATISFIED].includes(result))return constants.TIMEOUT_EXPIRED;
                if(name==="getSyncParameter"&&Number(args[0])===constants.SYNC_STATUS&&result===constants.SIGNALED)return constants.UNSIGNALED;
            }
            return result;
        };
    }
    proto.bindTransformFeedback=function(target,value){
        const s=state(this),handle=object(s,value,10);if(handle===undefined)return;
        if(call(s,"bindTransformFeedback",[Number(target)>>>0,handle])!==true)return;s.bindings.set("feedback",value);
    };
    for(const [name,Type]of [["clearBufferfv",Float32Array],["clearBufferiv",Int32Array],["clearBufferuiv",Uint32Array]]){
        proto[name]=function(buffer,drawbuffer,values,offset=0){
            const s=state(this);values=values instanceof Type?values:new Type(values);
            values=view(s,values,offset);if(!values)return;
            call(s,name,[Number(buffer)>>>0,Number(drawbuffer)|0,values]);
        };
    }
    proto.getInternalformatParameter=function(...args){
        const result=call(state(this),"getInternalformatParameter",args.map(Number));
        return Array.isArray(result)?new Int32Array(result):result;
    };
    proto.getFragDataLocation=function(program,name){
        const s=state(this);if(s.lost)return -1;
        const handle=object(s,program,6,false);if(handle===undefined)return -1;
        return call(s,"getFragDataLocation",[handle,String(name)]);
    };
    for(const [name,three,sub]of [["compressedTexImage2D",false,false],["compressedTexImage3D",true,false],
        ["compressedTexSubImage2D",false,true],["compressedTexSubImage3D",true,true]]){
        proto[name]=function(...args){
            const s=state(this),slot=sub?(three?9:7):(three?7:6);
            let data=args[slot],size;
            if(typeof data==="number"){
                size=Number(data);data=Number(args[slot+1]);
                if(args.length<slot+2)throw new TypeError("Compressed PBO upload requires size and offset");
            }else{
                if(args.length<slot+1)throw new TypeError("Not enough compressed texture arguments");
                if(args.length>slot+1){data=view(s,data,args[slot+1],args[slot+2]);if(!data)return;}
                if(!ArrayBuffer.isView(data))throw new TypeError("Compressed data must be an ArrayBufferView");
                size=data.byteLength;
            }
            const n=args.slice(0,slot).map(Number);
            const normalized=sub?
                [n[0],n[1],n[2],n[3],three?n[4]:0,three?n[5]:n[4],three?n[6]:n[5],three?n[7]:1,three?n[8]:n[6],data,size]:
                [n[0],n[1],n[2],n[3],n[4],three?n[5]:1,three?n[6]:n[5],data,size];
            call(s,name,normalized);
        };
    }
    for(const name of ["invalidateFramebuffer","invalidateSubFramebuffer"]){
        proto[name]=function(target,attachments,...args){
            return call(state(this),name,[Number(target)>>>0,new Uint32Array(attachments),...args.map(Number)]);
        };
    }
    proto.getFramebufferAttachmentParameter=function(target,attachment,pname){
        const s=state(this);target=Number(target)>>>0;attachment=Number(attachment)>>>0;pname=Number(pname)>>>0;
        const value=call(s,"getFramebufferAttachmentParameter",[target,attachment,pname]);
        if(pname===constants.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME){
            if(!value)return null;
            const fbo=s.bindings.get(target===constants.READ_FRAMEBUFFER?"readFbo":"drawFbo");
            return fbo?objects.get(fbo).attached.get(attachment)||null:null;
        }
        return value;
    };
    const methods={
        clear:1,clearColor:4,clearDepth:1,clearStencil:1,colorMask:4,depthMask:1,depthFunc:1,depthRange:2,
        enable:1,disable:1,isEnabled:1,cullFace:1,frontFace:1,blendColor:4,blendFunc:2,blendFuncSeparate:4,
        blendEquation:1,blendEquationSeparate:2,stencilMask:1,stencilFunc:3,stencilOp:3,stencilMaskSeparate:2,
        stencilFuncSeparate:4,stencilOpSeparate:4,lineWidth:1,polygonOffset:2,sampleCoverage:2,hint:2,
        scissor:4,viewport:4,flush:0,finish:0,drawArrays:3,drawElements:4,drawArraysInstanced:4,drawElementsInstanced:5,
        enableVertexAttribArray:1,disableVertexAttribArray:1,vertexAttribDivisor:2,
        getShaderPrecisionFormat:2,getBufferParameter:2,copyBufferSubData:5,texParameteri:3,texParameterf:3,
        getTexParameter:2,generateMipmap:1,texStorage2D:5,texStorage3D:6,
        renderbufferStorage:4,renderbufferStorageMultisample:5,getRenderbufferParameter:2,
        checkFramebufferStatus:1,readBuffer:1,getVertexAttribOffset:2,
        vertexAttrib1f:2,vertexAttrib2f:3,vertexAttrib3f:4,vertexAttrib4f:5,vertexAttribI4i:5,vertexAttribI4ui:5,
        beginTransformFeedback:1,endTransformFeedback:0,pauseTransformFeedback:0,resumeTransformFeedback:0,
        blitFramebuffer:10,clearBufferfi:4,drawRangeElements:6,
        copyTexImage2D:8,copyTexSubImage2D:8,copyTexSubImage3D:9
    };
    for(const [name,count]of Object.entries(methods))proto[name]=function(...args){
        const s=state(this);if(args.length<count)throw new TypeError(`${name} requires ${count} arguments`);
        return call(s,name,args.slice(0,count).map(v=>typeof v==="boolean"?Number(v):Number(v)));
    };
    for(const [name,descriptor]of Object.entries(descriptors)){
        const implementation=proto[name];
        if(typeof implementation!=="function")throw new Error("Missing WebGL2 core implementation: "+name);
        const method=function(...args){
            const s=state(this);
            if(args.length<descriptor.required)throw new TypeError(`${name} requires ${descriptor.required} arguments`);
            poll(s);
            if(s.lost&&!descriptor.handlesLoss){
                if(descriptor.returns==="any"||descriptor.returns.endsWith("?"))return null;
                if(descriptor.returns==="undefined")return undefined;
                if(descriptor.returns==="boolean"||descriptor.returns==="GLboolean")return false;
                return 0;
            }
            const result=implementation.apply(this,args);
            if(descriptor.returns==="undefined")return undefined;
            return result;
        };
        Object.defineProperty(method,"name",{value:name,configurable:true});
        Object.defineProperty(method,"length",{value:descriptor.required,configurable:true});
        proto[name]=method;
    }
    for(const [key,value]of Object.entries(constants)){
        Object.defineProperty(proto,key,{value,enumerable:true});
        Object.defineProperty(WebGL2RenderingContext,key,{value,enumerable:true});
    }
    Object.defineProperty(proto,Symbol.toStringTag,{value:"WebGL2RenderingContext"});
    Object.defineProperty(globalThis,"WebGL2RenderingContext",{value:WebGL2RenderingContext,writable:true,configurable:true});
    if(!("self" in globalThis))Object.defineProperty(globalThis,"self",{value:globalThis,writable:true,configurable:true});
    return function create(canvas,options,media,mediaCall,queue){
        const attributes={alpha:options.alpha===undefined?true:Boolean(options.alpha),
            depth:options.depth===undefined?true:Boolean(options.depth),stencil:Boolean(options.stencil),
            antialias:false,premultipliedAlpha:options.premultipliedAlpha===undefined?true:Boolean(options.premultipliedAlpha),
            preserveDrawingBuffer:Boolean(options.preserveDrawingBuffer),powerPreference:"default",failIfMajorPerformanceCaveat:Boolean(options.failIfMajorPerformanceCaveat),
            desynchronized:false};
        const power=options.powerPreference===undefined?"default":String(options.powerPreference);
        if(!["default","low-power","high-performance"].includes(power))throw new TypeError("Invalid powerPreference");
        attributes.powerPreference=power;
        const report=native(canvas,"open",[Number(attributes.alpha),Number(attributes.depth),
            Number(attributes.stencil),Number(attributes.premultipliedAlpha),Number(attributes.preserveDrawingBuffer),
            Number(attributes.failIfMajorPerformanceCaveat),["default","low-power","high-performance"].indexOf(power)]);
        const handle=report&&report.handle;
        if(!handle){
            media.shutdown=()=>{media.closed=true;};
            queue(()=>{if(!media.closed)mediaCall(canvas,"event",[],"webglcontextcreationerror",report?report.error:"Native WebGL2 backend unavailable");});return null;
        }
        const context=Object.create(proto),s={canvas,handle,attributes,media:mediaCall,queue,bindings:new Map(),
            defaultVao:{attributes:new Map(),element:null},vao:null,activeTexture:0,generation:1,
            lost:false,closed:false,unpackFlip:false,unpackPremultiply:false,unpackColor:constants.BROWSER_DEFAULT_WEBGL};
        contexts.set(context,s);
        media.shutdown=()=>{if(!s.closed){native(handle,"close",[]);s.closed=true;media.closed=true;s.bindings.clear();}};
        return context;
    };
})
