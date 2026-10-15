(function installCanvas(native, nodePrototype, createWebGL) {
    "use strict";
    const {Array,ArrayBuffer,Uint8Array,Uint8ClampedArray,Float32Array,Float64Array,String,Number,
        Object,Boolean,Math,Promise,TypeError,RangeError,Error}=globalThis;
    const timeout=globalThis.setTimeout,promiseResolve=Promise.resolve.bind(Promise);
    const contexts = new WeakMap(), images = new WeakMap(), paths = new WeakMap();
    let createWebGPU = null;
    let framePixels = null;
    const gradients = new WeakMap(), patterns = new WeakMap(), states = new WeakMap();
    const call = (target, op, args = [], text = "", resource = null) =>
        native(target, op, args.length ? new Float64Array(args) : null, text, resource);
    const queueTask = typeof timeout==="function" ? callback=>timeout(callback,0) :
        ()=>{throw new TypeError("Image loading and toBlob require the GUI Script event loop");};
    function fail(name, message) { throw new DOMException(message, name); }
    class DOMException extends Error {
        constructor(message = "", name = "Error") {
            super(String(message)); this.name = String(name);
            this.code = ({IndexSizeError:1, InvalidStateError:11, SyntaxError:12,
                NotSupportedError:9, EncodingError:0, AbortError:20})[this.name] || 0;
        }
    }
    function finite(values) { return values.every(Number.isFinite); }
    function filterFunctions(value) {
        if(!/^(?:blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia|url)\(/.test(value)||
            !value.endsWith(")"))return false;
        let depth=0;
        for(const character of value){
            if(character==="(")depth++;
            if(character===")"&&--depth<0)return false;
        }
        return depth===0;
    }
    function wellFormed(value) {
        return String(value).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,s=>s.length===1?"\uFFFD":s);
    }
    function numeric(args, count) {
        if (args.length < count) throw new TypeError("Not enough arguments");
        return args.slice(0, count).map(Number);
    }
    function integer(value) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : 0;
    }
    function rgba(value) {
        let text = String(value).trim().toLowerCase();
        if(text[0]!=="#"&&!/^rgba?\(/.test(text)&&!/^hsla?\(/.test(text))return call(null,"namedColor",[],text);
        if (/^#[\da-f]{3,4}$/.test(text)) text = "#" + [...text.slice(1)].map(c => c+c).join("");
        if (/^#[\da-f]{6}([\da-f]{2})?$/.test(text))
            return [0,2,4].map(i=>parseInt(text.slice(i+1,i+3),16)).concat(text.length===9 ? parseInt(text.slice(7),16) : 255);
        const match = /^rgba?\(\s*([^)]*)\)$/.exec(text);
        if (match) {
            const parts=match[1].replace(/\s*\/\s*/,",").split(/,\s*|\s+/).filter(Boolean);
            if (parts.length!==3 && parts.length!==4) return null;
            if(!parts.every(p=>/^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?%?$/.test(p)))return null;
            const color=parts.slice(0,3).map(p=>parseFloat(p)*(p.endsWith("%")?2.55:1));
            color.push(parts.length===4 ? parseFloat(parts[3])*(parts[3].endsWith("%")?2.55:255) : 255);
            return finite(color) ? color.map((v,i)=>i===3?Math.min(255,Math.max(0,v)):Math.round(Math.min(255,Math.max(0,v)))) : null;
        }
        const hsl=/^hsla?\(\s*([^)]*)\)$/.exec(text);
        if (hsl) {
            const p=hsl[1].replace(/\s*\/\s*/,",").split(/,\s*|\s+/).filter(Boolean);
            if (p.length<3 || p.length>4 || !p[1].endsWith("%") || !p[2].endsWith("%")) return null;
            if(!/^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:deg|rad|grad|turn)?$/.test(p[0])||
                !p.slice(1).every(v=>/^[+-]?(?:\d*\.\d+|\d+\.?\d*)%?$/.test(v)))return null;
            let [h,s,l]=p.slice(0,3).map(parseFloat);
            if(p[0].endsWith("turn"))h*=360;
            else if(p[0].endsWith("grad"))h*=.9;
            else if(p[0].endsWith("rad"))h*=180/Math.PI;
            let a=p.length===4 ? parseFloat(p[3])*(p[3].endsWith("%")?2.55:255) : 255;
            if (!finite([h,s,l,a])) return null;
            h=((h%360)+360)%360/60; s=Math.max(0,Math.min(1,s/100)); l=Math.max(0,Math.min(1,l/100));
            const c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs(h%2-1)), m=l-c/2;
            const v=h<1?[c,x,0]:h<2?[x,c,0]:h<3?[0,c,x]:h<4?[0,x,c]:h<5?[x,0,c]:[c,0,x];
            return v.map(z=>Math.round((z+m)*255)).concat(Math.max(0,Math.min(255,a)));
        }
        return null;
    }
    function colorText(c) {
        return c[3]===255?"#"+c.slice(0,3).map(v=>v.toString(16).padStart(2,"0")).join(""):
            `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.round(c[3]/255*1000000)/1000000})`;
    }
    class DOMMatrix {
        constructor(init = [1,0,0,1,0,0]) {
            if (typeof init==="string") {
                if(!init.trim())init="matrix(1,0,0,1,0,0)";
                const match=/^matrix\(([^)]+)\)$/.exec(init);
                if (!match) fail("SyntaxError","Only 2D matrix() is supported");
                init=match[1].split(",").map(Number);
            }
            const a=Array.from(init,Number);
            if(a.length===16){
                if(a[2]||a[3]||a[6]||a[7]||a[8]||a[9]||a[11]||a[14]||a[10]!==1||a[15]!==1)
                    fail("NotSupportedError","3D matrices are not supported");
                a.splice(0,a.length,a[0],a[1],a[4],a[5],a[12],a[13]);
            }
            if (a.length!==6) throw new TypeError("A 2D matrix requires six components");
            [this.a,this.b,this.c,this.d,this.e,this.f]=a;
        }
        get is2D() { return true; }
        get isIdentity() { return this.a===1&&this.b===0&&this.c===0&&this.d===1&&this.e===0&&this.f===0; }
        toFloat64Array() {
            return new Float64Array([this.a,this.b,0,0,this.c,this.d,0,0,0,0,1,0,this.e,this.f,0,1]);
        }
        toFloat32Array() { return new Float32Array(this.toFloat64Array()); }
        multiply(other) { return new DOMMatrix(multiply(affine(this),matrixArgs(other))); }
        multiplySelf(other) { Object.assign(this,this.multiply(other)); return this; }
        translate(x=0,y=0) { return this.multiply(new DOMMatrix([1,0,0,1,Number(x),Number(y)])); }
        scale(x=1,y=x) { return this.multiply(new DOMMatrix([Number(x),0,0,Number(y),0,0])); }
        rotate(degrees=0) { const r=Number(degrees)*Math.PI/180; return this.multiply(new DOMMatrix([Math.cos(r),Math.sin(r),-Math.sin(r),Math.cos(r),0,0])); }
        inverse() {
            const {a,b,c,d,e,f}=this, det=a*d-b*c;
            return new DOMMatrix(det ? [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det] : Array(6).fill(NaN));
        }
        invertSelf() { Object.assign(this,this.inverse()); return this; }
        transformPoint(point={}) {
            const p=DOMPoint.fromPoint(point);
            return new DOMPoint(this.a*p.x+this.c*p.y+this.e*p.w,this.b*p.x+this.d*p.y+this.f*p.w,p.z,p.w);
        }
        toString() { return `matrix(${affine(this).join(", ")})`; }
    }
    class DOMPoint {
        constructor(x=0,y=0,z=0,w=1) { this.x=Number(x);this.y=Number(y);this.z=Number(z);this.w=Number(w); }
        static fromPoint(p={}) { return new DOMPoint(p.x,p.y,p.z,p.w); }
        matrixTransform(matrix={}) { return new DOMMatrix(matrixArgs(matrix)).transformPoint(this); }
        toJSON() { return {x:this.x,y:this.y,z:this.z,w:this.w}; }
    }
    for (const [alias,key] of Object.entries({m11:"a",m12:"b",m21:"c",m22:"d",m41:"e",m42:"f"}))
        Object.defineProperty(DOMMatrix.prototype,alias,{get(){return this[key];},set(v){this[key]=Number(v);}});
    for(const [key,value] of Object.entries({m13:0,m14:0,m23:0,m24:0,m31:0,m32:0,m33:1,m34:0,m43:0,m44:1}))
        Object.defineProperty(DOMMatrix.prototype,key,{get(){return value;},set(v){if(Number(v)!==value)fail("NotSupportedError","3D matrices are not supported");}});
    function matrixArgs(value={}) {
        if (value.is2D===false) throw new TypeError("A 2D matrix is required");
        return [["a","m11",1],["b","m12",0],["c","m21",0],["d","m22",1],["e","m41",0],["f","m42",0]].map(([a,b,def])=>{
            const x=value[a],y=value[b];
            if (x!==undefined&&y!==undefined&&Number(x)!==Number(y)) throw new TypeError("Conflicting matrix aliases");
            return Number(x===undefined ? y===undefined ? def : y : x);
        });
    }
    function affine(matrix) { return [matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f]; }
    function multiply(a,b) {
        return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
    }
    class Path2D {
        constructor(source) {
            if (source!==undefined && typeof source!=="string" && !paths.has(source)) throw new TypeError("Expected a Path2D or SVG path string");
            paths.set(this,call(null,"path",[],typeof source==="string"?source:"",paths.get(source)||null));
        }
        addPath(path, transform={}) {
            if (!paths.has(path)) throw new TypeError("Expected a Path2D");
            const a=matrixArgs(transform); if (finite(a)) call(paths.get(this),"add",a,"",paths.get(path));
        }
    }
    function pathTarget(object) {
        if (paths.has(object)) return paths.get(object);
        if (states.has(object)) return object.canvas;
        throw new TypeError("Illegal path receiver");
    }
    for (const [name,op,n] of [["moveTo","move",2],["lineTo","line",2],["quadraticCurveTo","quad",4],["bezierCurveTo","bezier",6],["rect","rect",4],["arcTo","arcTo",5]]) {
        Path2D.prototype[name]=function(...values) {
            const a=numeric(values,n); if (!finite(a)) return;
            if (name==="arcTo"&&a[4]<0) fail("IndexSizeError","The radius must not be negative");
            call(pathTarget(this),op,a);
        };
    }
    Path2D.prototype.closePath=function(){call(pathTarget(this),"close");};
    // Keep the native ellipse layout explicit: center, radii, rotation, reserved, start, end, anticlockwise.
    Path2D.prototype.ellipse=function(x,y,rx,ry,rotation,start,end,anticlockwise=false) {
        if (arguments.length<7) throw new TypeError("Not enough arguments");
        const a=[x,y,rx,ry,rotation,start,end].map(Number);
        if (!finite(a)) return;
        if (a[2]<0||a[3]<0) fail("IndexSizeError","The radii must not be negative");
        call(pathTarget(this),"ellipse",[...a.slice(0,5),0,a[5],a[6],Number(Boolean(anticlockwise))]);
    };
    Path2D.prototype.arc=function(x,y,r,start,end,anticlockwise=false) {
        if (arguments.length<5) throw new TypeError("Not enough arguments");
        return this.ellipse(x,y,r,r,0,start,end,anticlockwise);
    };
    Path2D.prototype.roundRect=function(x,y,width,height,radii=0) {
        const a=numeric([...arguments],4);
        let corners=typeof radii==="number"||radii===null||typeof radii!=="object"?[radii]:
            typeof radii[Symbol.iterator]==="function"?Array.from(radii):[radii];
        if(!corners.length||corners.length>4)throw new RangeError("roundRect requires one to four radii");
        corners=corners.map(r=>r&&typeof r==="object"?[Number(r.x??0),Number(r.y??0)]:[Number(r),Number(r)]);
        if(corners.some(r=>r[0]<0||r[1]<0))throw new RangeError("roundRect radii must not be negative");
        if(!finite(a)||!finite(corners.flat()))return;
        if(corners.length===1)corners=[corners[0],corners[0],corners[0],corners[0]];
        else if(corners.length===2)corners=[corners[0],corners[1],corners[0],corners[1]];
        else if(corners.length===3)corners=[corners[0],corners[1],corners[2],corners[1]];
        const reversed=(a[2]<0)!==(a[3]<0);
        if(a[2]<0){a[0]+=a[2];a[2]=-a[2];corners=[corners[1],corners[0],corners[3],corners[2]];}
        if(a[3]<0){a[1]+=a[3];a[3]=-a[3];corners=[corners[3],corners[2],corners[1],corners[0]];}
        const sums=[corners[0][0]+corners[1][0],corners[3][0]+corners[2][0],
            corners[0][1]+corners[3][1],corners[1][1]+corners[2][1]];
        const factor=Math.min(1,...sums.map((v,i)=>v?(i<2?a[2]:a[3])/v:1));
        call(pathTarget(this),"roundRect",[...a,...corners.flat().map(v=>v*factor),Number(reversed)]);
    };
    class CanvasGradient {
        constructor() { throw new TypeError("Illegal constructor"); }
        addColorStop(offset,color) {
            offset=Number(offset); const c=rgba(color);
            if (!Number.isFinite(offset)||offset<0||offset>1) fail("IndexSizeError","Invalid gradient offset");
            if (!c) fail("SyntaxError","Invalid color");
            call(gradients.get(this),"stop",[offset,...c]);
        }
    }
    class CanvasPattern {
        constructor() { throw new TypeError("Illegal constructor"); }
        setTransform(transform={}) { const a=matrixArgs(transform); if (finite(a)) call(patterns.get(this),"matrix",a); }
    }
    class ImageData {
        constructor(data,width,height,settings={}) {
            if (data instanceof Uint8ClampedArray) {
                if(height && typeof height==="object")settings=height;
                width=integer(width);
                if (!width||!data.length||data.length%4||data.length%(width*4)) fail("IndexSizeError","Invalid ImageData dimensions");
                if (height!==undefined && typeof height!=="object" && integer(height)!==data.length/(width*4)) fail("IndexSizeError","Invalid ImageData height");
                height=data.length/(width*4);
            } else {
                settings=height||{}; height=integer(width); width=integer(data);
                if (width<=0||height<=0) fail("IndexSizeError","ImageData dimensions must be positive");
                if (width*height>16777216) throw new RangeError("ImageData exceeds safety limits");
                data=new Uint8ClampedArray(width*height*4);
            }
            if (width<1||height<1||width*height>16777216) throw new RangeError("ImageData exceeds safety limits");
            if (settings.colorSpace && settings.colorSpace!=="srgb") fail("NotSupportedError","Only sRGB ImageData is supported");
            Object.defineProperties(this,{data:{value:data,enumerable:true},width:{value:width,enumerable:true},
                height:{value:height,enumerable:true},colorSpace:{value:"srgb",enumerable:true}});
        }
    }
    const blobBytes=new WeakMap();
    class Blob {
        constructor(parts=[],options={}) {
            const chunks=Array.from(parts,p=>{
                if (blobBytes.has(p)) return blobBytes.get(p);
                if (p instanceof ArrayBuffer) return new Uint8Array(p);
                if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer,p.byteOffset,p.byteLength);
                const text=unescape(encodeURIComponent(wellFormed(p)));
                return Uint8Array.from(text,c=>c.charCodeAt(0));
            });
            const size=chunks.reduce((n,c)=>n+c.length,0), bytes=new Uint8Array(size);
            let offset=0; for (const c of chunks) {bytes.set(c,offset);offset+=c.length;}
            blobBytes.set(this,bytes);
            const type=String(options.type||"").toLowerCase();
            Object.defineProperties(this,{size:{value:size,enumerable:true},type:{value:/^[\x20-\x7e]*$/.test(type)?type:"",enumerable:true}});
        }
        async arrayBuffer() { return blobBytes.get(this).slice().buffer; }
        async text() {
            const bytes=blobBytes.get(this);let text="",i=0;
            if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)i=3;
            while(i<bytes.length){
                const lead=bytes[i];
                if(lead<128){text+=String.fromCharCode(lead);++i;continue;}
                const count=lead>=194&&lead<=223?2:lead>=224&&lead<=239?3:lead>=240&&lead<=244?4:0;
                if(!count){text+="\uFFFD";++i;continue;}
                let cp=lead&((1<<(7-count))-1),j=1;
                for(;j<count&&i+j<bytes.length;++j){
                    const b=bytes[i+j];
                    if(b<128||b>191||(j===1&&((lead===224&&b<160)||(lead===237&&b>159)||(lead===240&&b<144)||(lead===244&&b>143))))break;
                    cp=(cp<<6)|(b&63);
                }
                text+=j===count?String.fromCodePoint(cp):"\uFFFD";i+=j;
            }return text;
        }
        slice(start=0,end=this.size,type="") {
            const adjust=n=>n<0?Math.max(0,this.size+integer(n)):Math.min(this.size,integer(n));
            return new Blob([blobBytes.get(this).slice(adjust(start),Math.max(adjust(start),adjust(end)))],{type});
        }
    }
    const defaults={fillStyle:"#000000",strokeStyle:"#000000",globalAlpha:1,globalCompositeOperation:"source-over",
        lineWidth:1,lineCap:"butt",lineJoin:"miter",miterLimit:10,lineDashOffset:0,shadowColor:"rgba(0, 0, 0, 0)",
        shadowBlur:0,shadowOffsetX:0,shadowOffsetY:0,font:"10px sans-serif",textAlign:"start",textBaseline:"alphabetic",
        direction:"inherit",imageSmoothingEnabled:true,imageSmoothingQuality:"low",filter:"none"};
    const blends=["clear","copy","destination","source-over","destination-over","source-in","destination-in",
        "source-out","destination-out","source-atop","destination-atop","xor","lighter","modulate",
        "screen","overlay","darken","lighten","color-dodge","color-burn","hard-light","soft-light","difference",
        "exclusion","multiply","hue","saturation","color","luminosity"];
    // SkBlendMode ordinal order; unsupported non-Canvas names are not exposed.
    const compositeNames=new Set(["source-over","source-in","source-out","source-atop","destination-over",
        "destination-in","destination-out","destination-atop","lighter","copy","xor","multiply","screen",
        "overlay","darken","lighten","color-dodge","color-burn","hard-light","soft-light","difference",
        "exclusion","hue","saturation","color","luminosity"]);
    function fontInfo(font) {
        const m=/^(?:(italic|oblique)\s+)?(?:(bold|normal|[1-9]00)\s+)?(\d+(?:\.\d+)?)(px|pt)\s+(.+)$/.exec(font);
        if (!m) return null;
        if(/[\x00-\x1f]/.test(m[5]))return null;
        const size=Number(m[3])*(m[4]==="pt"?4/3:1);
        if (size<=0||size>4096) return null;
        return [size,m[2]==="bold"?700:parseInt(m[2],10)||400,m[1]?1:0,m[5].split(",")[0].trim().replace(/^["']|["']$/g,"")];
    }
    function configure(ctx,stroke=false) {
        const s=states.get(ctx),paint=stroke?s.strokeStyle:s.fillStyle;
        const c=typeof paint==="string"?rgba(paint):[0,0,0,255], shadow=rgba(s.shadowColor);
        call(ctx.canvas,"configure",[...c,s.globalAlpha,s.lineWidth,s.miterLimit,
            ["butt","round","square"].indexOf(s.lineCap),["miter","round","bevel"].indexOf(s.lineJoin),
            blends.indexOf(s.globalCompositeOperation),Number(s.imageSmoothingEnabled),
            ...shadow,s.shadowBlur,s.shadowOffsetX,s.shadowOffsetY,s.lineDashOffset,
            s.filter==="none"?0:Number(s.filter.slice(5,-3)),...s.dash],
            "",gradients.get(paint)||patterns.get(paint)||null);
    }
    const metricsToken=Symbol();
    class TextMetrics {
        constructor(values,align,token) {
            if(token!==metricsToken)throw new TypeError("Illegal constructor");
            const shift=align===1?values[0]/2:align===2?values[0]:0;
            const metrics={width:values[0],actualBoundingBoxLeft:values[1]+shift,
                actualBoundingBoxRight:values[2]-shift,actualBoundingBoxAscent:values[3],
                actualBoundingBoxDescent:values[4],fontBoundingBoxAscent:values[5],fontBoundingBoxDescent:values[6],
                emHeightAscent:values[5],emHeightDescent:values[6],hangingBaseline:values[5]*.8,
                alphabeticBaseline:0,ideographicBaseline:-values[6]};
            for(const [key,value] of Object.entries(metrics))Object.defineProperty(this,key,{value,enumerable:true});
        }
    }
    class CanvasRenderingContext2D {
        constructor() { throw new TypeError("Illegal constructor"); }
        get canvas() { return states.get(this).canvas; }
        getContextAttributes() { return {...states.get(this).attributes}; }
        isContextLost() { if(!states.has(this))throw new TypeError("Illegal context receiver");return false; }
        save() { const s=states.get(this); s.stack.push({...s,dash:s.dash.slice(),matrix:s.matrix.slice(),stack:undefined}); call(this.canvas,"save"); }
        restore() {
            const s=states.get(this),last=s.stack.pop();
            if (last) {const stack=s.stack; Object.assign(s,last);s.stack=stack;call(this.canvas,"restore");}
        }
        reset() { this.canvas.width=this.canvas.width; }
        beginPath() { call(this.canvas,"begin"); }
        getTransform() { return new DOMMatrix(states.get(this).matrix); }
        setTransform(...args) {
            const a=args.length===1 ? matrixArgs(args[0]) : args.length===0 ? [1,0,0,1,0,0] : numeric(args,6);
            if (finite(a)) {states.get(this).matrix=a;call(this.canvas,"matrix",a);}
        }
        resetTransform() { this.setTransform(); }
        transform(...args) { const a=numeric(args,6); if (finite(a)) this.setTransform(...multiply(states.get(this).matrix,a)); }
        translate(x,y) { const a=numeric([...arguments],2); if(finite(a))this.transform(1,0,0,1,...a); }
        scale(x,y) { const a=numeric([...arguments],2); if(finite(a))this.transform(a[0],0,0,a[1],0,0); }
        rotate(angle) { angle=Number(angle); if(Number.isFinite(angle))this.transform(Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0); }
        setLineDash(segments) {
            let a=Array.from(segments,Number);
            if (!finite(a)||a.some(n=>n<0)) return;
            if (a.length%2) a=a.concat(a);
            if (a.length>4000) throw new RangeError("Line dash exceeds safety limits");
            states.get(this).dash=a;
        }
        getLineDash() { return states.get(this).dash.slice(); }
        createLinearGradient(...values) {
            const a=numeric(values,4); if(!finite(a))throw new TypeError("Non-finite gradient coordinates");
            const obj=Object.create(CanvasGradient.prototype);
            gradients.set(obj,call(null,"linear",[...a,...states.get(this).matrix]));return obj;
        }
        createRadialGradient(...values) {
            const a=numeric(values,6);if(!finite(a))throw new TypeError("Non-finite gradient coordinates");
            if(a[2]<0||a[5]<0)fail("IndexSizeError","The radii must not be negative");
            const obj=Object.create(CanvasGradient.prototype);
            gradients.set(obj,call(null,"radial",[...a,...states.get(this).matrix]));return obj;
        }
        createPattern(image,repetition="repeat") {
            repetition=String(repetition);
            if(repetition==="")repetition="repeat";
            if(!["repeat","repeat-x","repeat-y","no-repeat"].includes(repetition))fail("SyntaxError","Invalid repetition");
            const source=imageSource(image,true);if(!source)return null;
            const obj=Object.create(CanvasPattern.prototype);patterns.set(obj,call(null,"pattern",[],repetition,source.handle));return obj;
        }
        drawImage(image,...values) {
            if(![2,4,8].includes(values.length))throw new TypeError("Invalid drawImage overload");
            const a=values.map(Number);if(!finite(a))return;
            const source=imageSource(image);if(!source)return;
            let rect=a.length===2?[0,0,source.width,source.height,...a,source.width,source.height]:
                a.length===4?[0,0,source.width,source.height,...a]:a;
            for(const i of [0,4]) {
                if(rect[i+2]<0){rect[i]+=rect[i+2];rect[i+2]=-rect[i+2];}
                if(rect[i+3]<0){rect[i+1]+=rect[i+3];rect[i+3]=-rect[i+3];}
            }
            if(!rect[2]||!rect[3]||!rect[6]||!rect[7])return;
            // Clip the source rectangle and proportionally trim its destination.
            const x=Math.max(0,rect[0]),y=Math.max(0,rect[1]),right=Math.min(source.width,rect[0]+rect[2]),bottom=Math.min(source.height,rect[1]+rect[3]);
            if(right<=x||bottom<=y)return;
            rect=[x,y,right-x,bottom-y,rect[4]+(x-rect[0])*rect[6]/rect[2],
                rect[5]+(y-rect[1])*rect[7]/rect[3],(right-x)*rect[6]/rect[2],(bottom-y)*rect[7]/rect[3]];
            configure(this);call(this.canvas,"image",rect,"",source.handle);
        }
        createImageData(width,height,settings) {
            if(width instanceof ImageData)return new ImageData(width.width,width.height);
            return new ImageData(Math.abs(integer(width)),Math.abs(integer(height)),settings);
        }
        getImageData(x,y,width,height,settings={}) {
            let a=numeric([...arguments],4).map(integer);
            if(!a[2]||!a[3])fail("IndexSizeError","Pixel dimensions must not be zero");
            if(a[2]<0){a[0]+=a[2];a[2]=-a[2];}if(a[3]<0){a[1]+=a[3];a[3]=-a[3];}
            if(settings.colorSpace&&settings.colorSpace!=="srgb")fail("NotSupportedError","Only sRGB is supported");
            return new ImageData(new Uint8ClampedArray(call(this.canvas,"pixels",a)),a[2],a[3]);
        }
        putImageData(image,x,y,...dirty) {
            if(!(image instanceof ImageData))throw new TypeError("Expected ImageData");
            x=Number(x);y=Number(y);
            const a=dirty.length ? numeric(dirty,4) : [0,0,image.width,image.height];
            if(!finite([x,y,...a]))fail("NotSupportedError","Pixel coordinates must be finite");
            if(!image.data.byteLength)fail("InvalidStateError","ImageData is detached");
            if(a[2]<0){a[0]+=a[2];a[2]=-a[2];}if(a[3]<0){a[1]+=a[3];a[3]=-a[3];}
            const copy=image.data.slice().buffer;
            call(this.canvas,"put",[image.width,image.height,integer(x),integer(y),...a.map(integer)],"",copy);
        }
        fill(path,rule="nonzero") { pathDraw(this,"fill",path,rule); }
        stroke(path) { pathDraw(this,"stroke",path); }
        clip(path,rule="nonzero") { pathDraw(this,"clip",path,rule); }
        isPointInPath(...args) { return point(this,false,args); }
        isPointInStroke(...args) { return point(this,true,args); }
        fillText(text,x,y,maxWidth) { textDraw(this,false,text,x,y,maxWidth); }
        strokeText(text,x,y,maxWidth) { textDraw(this,true,text,x,y,maxWidth); }
        measureText(text) {
            text=wellFormed(text).replace(/[\t\n\f\r]/g," ");
            const s=states.get(this),f=fontInfo(s.font);
            const baseline={alphabetic:0,top:1,hanging:2,middle:3,bottom:4,ideographic:4}[s.textBaseline];
            const direction=s.direction==="inherit"?call(this.canvas,"direction"):s.direction;
            return new TextMetrics(call(this.canvas,"measure",[...f.slice(0,3),0,0,0,baseline,0,0,direction==="rtl"?1:0],f[3]+"\0"+text),alignment(s),metricsToken);
        }
    }
    for(const name of Object.getOwnPropertyNames(Path2D.prototype))
        if(name!=="constructor"&&name!=="addPath")CanvasRenderingContext2D.prototype[name]=Path2D.prototype[name];
    for(const name of ["fillRect","strokeRect","clearRect"])CanvasRenderingContext2D.prototype[name]=function(...values) {
        const a=numeric(values,4);if(!finite(a))return;
        if(name!=="clearRect")configure(this,name==="strokeRect");call(this.canvas,name,a);
    };
    function pathDraw(ctx,op,path,rule="nonzero") {
        if(typeof path==="string"&&op!=="stroke"){rule=path;path=undefined;}
        if(path!==undefined&&!paths.has(path))throw new TypeError("Expected Path2D");
        rule=String(rule);if(!["nonzero","evenodd"].includes(rule))throw new TypeError("Invalid fill rule");
        if(op!=="clip")configure(ctx,op==="stroke");
        call(ctx.canvas,op,[],rule,paths.get(path)||null);
    }
    function point(ctx,stroke,args) {
        let path;if(paths.has(args[0]))path=args.shift();
        const a=numeric(args,2);if(!finite(a))return false;
        const rule=stroke?"nonzero":String(args[2]||"nonzero");if(!["nonzero","evenodd"].includes(rule))throw new TypeError("Invalid fill rule");
        configure(ctx,stroke);return Boolean(call(ctx.canvas,"contains",[...a,Number(stroke)],rule,paths.get(path)||null)[0]);
    }
    function alignment(s) {
        const direction=s.direction==="inherit"?call(s.canvas,"direction"):s.direction;
        return s.textAlign==="center"?1:s.textAlign==="right"||(s.textAlign==="end"&&direction!=="rtl")||(s.textAlign==="start"&&direction==="rtl")?2:0;
    }
    function textDraw(ctx,stroke,text,x,y,maxWidth) {
        text=wellFormed(text).replace(/[\t\n\f\r]/g," ");x=Number(x);y=Number(y);
        maxWidth=maxWidth===undefined?0:Number(maxWidth);
        if(!finite([x,y,maxWidth])||(maxWidth<=0&&arguments[5]!==undefined))return;
        const s=states.get(ctx),f=fontInfo(s.font);configure(ctx,stroke);
        const baseline={alphabetic:0,top:1,hanging:2,middle:3,bottom:4,ideographic:4}[s.textBaseline];
        const direction=s.direction==="inherit"?call(ctx.canvas,"direction"):s.direction;
        call(ctx.canvas,"text",[...f.slice(0,3),x,y,alignment(s),baseline,Number(stroke),maxWidth,direction==="rtl"?1:0],f[3]+"\0"+text);
    }
    for(const key of Object.keys(defaults))Object.defineProperty(CanvasRenderingContext2D.prototype,key,{
        enumerable:true,configurable:true,get(){return states.get(this)[key];},set(value){
            const s=states.get(this);
            if(key==="fillStyle"||key==="strokeStyle"){
                if(gradients.has(value)||patterns.has(value)){s[key]=value;return;}const c=rgba(value);if(!c)return;value=colorText(c);
            }else if(["shadowColor"].includes(key)){const c=rgba(value);if(!c)return;value=colorText(c);
            }else if(key==="filter"){
                value=String(value).trim();
                if(value!=="none"){
                    const match=/^blur\(\s*(\+?(?:\d*\.?\d+)(?:[eE][+-]?\d+)?)px\s*\)$/.exec(value);
                    if(match){
                        const sigma=Number(match[1]);if(!Number.isFinite(sigma))return;
                        if(sigma>128)throw new RangeError("Canvas blur exceeds 128 backing pixels");
                        value=`blur(${sigma}px)`;
                    }else if(/^blur\(\s*[+]?0\s*\)$/.test(value))value="blur(0px)";
                    else if(filterFunctions(value)&&!/^blur\([^()]*\)$/.test(value))
                        fail("NotSupportedError","Only none and a single blur(px) filter are supported");
                    else return;
                }
            }else if(key==="font"){value=String(value).trim();if(!fontInfo(value))return;
            }else if(key==="globalCompositeOperation"){value=String(value);if(!compositeNames.has(value))return;
            }else if(typeof defaults[key]==="number"){
                value=Number(value);if(!Number.isFinite(value))return;
                if(key==="globalAlpha"&&(value<0||value>1))return;
                if(["lineWidth","miterLimit"].includes(key)&&value<=0)return;
                if(key==="shadowBlur"&&value<0)return;
            }else if(typeof defaults[key]==="boolean")value=Boolean(value);
            else{
                value=String(value);
                const options={lineCap:["butt","round","square"],lineJoin:["miter","round","bevel"],textAlign:["start","end","left","right","center"],
                    textBaseline:["top","hanging","middle","alphabetic","ideographic","bottom"],direction:["ltr","rtl","inherit"],
                    imageSmoothingQuality:["low","medium","high"]};
                if(!options[key].includes(value))return;
            }
            s[key]=value;
        }
    });
    const getAttribute=nodePrototype.getAttribute,setAttribute=nodePrototype.setAttribute,removeAttribute=nodePrototype.removeAttribute;
    function canvasSize(canvas) { return call(canvas,"size"); }
    function retained(canvas) {
        let value=call(canvas,"state");
        if(!value){value={element:canvas};call(canvas,"state",[],"",value);}
        return value;
    }
    function resetCanvas(canvas,width,height) {
        call(canvas,"resize",[width,height]);
        const ctx=retained(canvas).context;if(ctx&&states.has(ctx)){const s=states.get(ctx);Object.assign(s,defaults,{dash:[],matrix:[1,0,0,1,0,0],stack:[]});}
    }
    function dimensionAttribute(value,def) {
        if(value===null||!/^\s*\+?\d+\s*$/.test(value))return def;
        const n=Number(value);return n<=2147483647?n:def;
    }
    class HTMLCanvasElement {
        constructor() { throw new TypeError("Illegal constructor"); }
        get tagName(){return "CANVAS";}
        get nodeName(){return "CANVAS";}
        get width(){return canvasSize(this)[0];}
        set width(v){v=Number(v)>>>0;const h=this.height;resetCanvas(this,v,h);setAttribute.call(this,"width",String(v));}
        get height(){return canvasSize(this)[1];}
        set height(v){v=Number(v)>>>0;const w=this.width;resetCanvas(this,w,v);setAttribute.call(this,"height",String(v));}
        setAttribute(name,value) {
            name=String(name).toLowerCase();value=String(value);
            if(name==="width"||name==="height"){
                const size=canvasSize(this);size[name==="width"?0:1]=dimensionAttribute(value,name==="width"?300:150);
                resetCanvas(this,...size);
            }
            setAttribute.call(this,name,value);
        }
        removeAttribute(name) {
            name=String(name).toLowerCase();
            if(name==="width"||name==="height"){
                const size=canvasSize(this);size[name==="width"?0:1]=name==="width"?300:150;resetCanvas(this,...size);
            }
            removeAttribute.call(this,name);
        }
        getContext(type,options={}) {
            type=String(type);if(type!=="2d"&&type!=="webgl2"&&type!=="webgpu")return null;
            const media=retained(this);
            if(media.context)return media.mode===type?media.context:null;
            if(options===null)options={};
            if(typeof options!=="object")throw new TypeError("Context attributes require a dictionary");
            if(type==="webgl2"){
                const ctx=createWebGL(this,options,media,call,queueTask);
                if(ctx){media.context=ctx;media.mode=type;}return ctx;
            }
            if(type==="webgpu") {
                if(!createWebGPU)return null;
                const ctx=createWebGPU(this,media);
                media.context=ctx;media.mode=type;return ctx;
            }
            const colorSpace=options.colorSpace,colorType=options.colorType;
            const alpha=options.alpha,desynchronized=options.desynchronized,willReadFrequently=options.willReadFrequently;
            void desynchronized;
            if(colorSpace&&colorSpace!=="srgb")fail("NotSupportedError","Only sRGB canvas is supported");
            if(retained(this).context)return retained(this).context;
            const ctx=Object.create(CanvasRenderingContext2D.prototype);
            const attributes={alpha:alpha===undefined?true:Boolean(alpha),colorSpace:"srgb",colorType:"unorm8",desynchronized:false,willReadFrequently:Boolean(willReadFrequently)};
            if(colorType && colorType!=="unorm8")fail("NotSupportedError","Only RGBA8 contexts are supported");
            call(this,"alpha",[Number(attributes.alpha)]);
            states.set(ctx,{...defaults,canvas:this,attributes,dash:[],matrix:[1,0,0,1,0,0],stack:[]});
            contexts.set(this,ctx);retained(this).context=ctx;retained(this).mode="2d";return ctx;
        }
        toDataURL(type="image/png",quality=.92) {
            if(!this.width||!this.height)return "data:,";
            const data=encoded(this,type,quality);return `data:${data.type};base64,${base64(new Uint8Array(data.buffer))}`;
        }
        toBlob(callback,type="image/png",quality=.92) {
            if(typeof callback!=="function")throw new TypeError("A callback is required");
            const blob=this.width&&this.height?(()=>{const data=encoded(this,type,quality);return new Blob([data.buffer],{type:data.type});})():null;
            queueTask(()=>{if(call(null,"alive")&&!retained(this).closed)callback(blob);});
        }
    }
    function encoded(canvas,type,quality) {
        type=String(type).toLowerCase();if(type!=="image/jpeg")type="image/png";
        quality=Number(quality);if(!Number.isFinite(quality)||quality<0||quality>1)quality=.92;
        return {type,buffer:call(canvas,"encode",[Number(type==="image/jpeg"),quality])};
    }
    function base64(bytes) {
        const chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";let out="";
        for(let i=0;i<bytes.length;i+=3){
            const a=bytes[i],b=bytes[i+1],c=bytes[i+2];
            out+=chars[a>>2]+chars[((a&3)<<4)|((b||0)>>4)]+(i+1<bytes.length?chars[((b&15)<<2)|((c||0)>>6)]:"=")+(i+2<bytes.length?chars[c&63]:"=");
        }return out;
    }
    function dataBytes(src) {
        const match=/^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/\s]*={0,2})$/i.exec(src);
        if(!match)fail("EncodingError","Only base64 PNG/JPEG data URLs are supported");
        const input=match[1].replace(/\s/g,"");
        if(input.length%4||input.length>89478488)fail("EncodingError","Invalid or oversized data URL");
        const chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const size=input.length/4*3-(input.endsWith("==")?2:input.endsWith("=")?1:0),bytes=new Uint8Array(size);
        let offset=0;for(let i=0;i<input.length;i+=4){
            const v=(chars.indexOf(input[i])<<18)|(chars.indexOf(input[i+1])<<12)|((chars.indexOf(input[i+2])&63)<<6)|(chars.indexOf(input[i+3])&63);
            for(const shift of [16,8,0])if(offset<size)bytes[offset++]=(v>>shift)&255;
        }return bytes.buffer;
    }
    function imageState(image) {
        if(!images.has(image)){
            const root=retained(image);
            if(!root.image)root.image={src:"",currentSrc:"",complete:true,generation:0,error:null,pending:[],width:0,height:0};
            images.set(image,root.image);
        }
        return images.get(image);
    }
    function imageSource(image,pattern=false) {
        const frame=framePixels?.(image);
        if(frame)return {width:frame.displayWidth,height:frame.displayHeight,
            handle:call(null,"rgbaImage",[frame.width,frame.height,frame.displayWidth,frame.displayHeight,
                frame.primaries,frame.transfer,Number(frame.fullRange)],"",frame.pixels.buffer)};
        if(image instanceof HTMLCanvasElement){
            const width=image.width,height=image.height;
            if(!width||!height)fail("InvalidStateError","The source canvas has zero size");
            return {width,height,handle:call(image,"snapshot")};
        }
        if(image instanceof HTMLImageElement){
            const s=imageState(image);
            if(!s.complete)return null;
            if(s.error||!s.width||!s.height){if(pattern)return null;fail("InvalidStateError","The source image is not decoded");}
            return {width:s.width,height:s.height,handle:call(image,"snapshot")};
        }
        if(image&&typeof image.close==="function"&&typeof image.closed==="boolean"){
            if(image.closed)fail("InvalidStateError","The bitmap is closed");
            const handle=call(image,"snapshot");if(handle)return {width:image.width,height:image.height,handle};
        }
        throw new TypeError("Expected canvas, Image/img, or an owned bitmap");
    }
    function loadImage(image,src) {
        const s=imageState(image),generation=++s.generation;
        retained(image).shutdown=()=>{
            ++s.generation;
            if(!s.complete){s.complete=true;s.error=new DOMException("GUI image scope closed","EncodingError");}
            for(const p of s.pending)p.reject(new DOMException("GUI image scope closed","EncodingError"));
            s.pending=[];
        };
        for(const p of s.pending)p.reject(new DOMException("Image source changed","EncodingError"));
        s.pending=[];s.src=src;s.currentSrc="";s.complete=!src;s.error=null;s.width=s.height=0;
        call(image,"clearImage");
        if(!src)return;
        let path=null,resolutionError=null;
        try{
            if(!/^data:/i.test(src)&&!/^https?:/i.test(src)){
                const local=filePath(src);
                path=call(image,"resolve",[],local);
                s.src=fileURL(path);
            }
        }catch(error){resolutionError=error;}
        queueTask(()=>{
            if(generation!==s.generation||!call(null,"alive"))return;
            s.currentSrc=s.src;
            try{
                if(resolutionError)throw resolutionError;
                const bytes=/^data:/i.test(src)?dataBytes(src):null;
                [s.width,s.height]=call(image,"load",[],bytes?"":path||src,bytes);
                s.complete=true;s.currentSrc=s.src;
            }catch(error){s.complete=true;s.error=new DOMException("PNG/JPEG image could not be loaded","EncodingError");}
            for(const p of s.pending)s.error?p.reject(s.error):p.resolve();s.pending=[];
            const type=s.error?"error":"load";
            call(image,"event",[],type);
        });
    }
    function filePath(source) {
        if(/^file:/i.test(source)){
            const match=/^file:\/\/([^/]*)(\/[^?#]*)(?:[?#].*)?$/i.exec(source);
            if(!match||!["","localhost"].includes(match[1].toLowerCase()))fail("EncodingError","Only local file URLs are supported");
            let path=decodeURIComponent(match[2]);
            if(/^\/[A-Za-z]:\//.test(path))path=path.slice(1);
            if(path.includes("\0")||path.startsWith("//")||path.startsWith("\\\\"))fail("EncodingError","Invalid local file URL");
            return path;
        }
        if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)&&!/^[A-Za-z]:[\\/]/.test(source))fail("EncodingError","Unsupported image URL scheme");
        if(source.includes("\0")||source.startsWith("//")||source.startsWith("\\\\"))fail("EncodingError","Invalid local image path");
        if(source.startsWith("/")||/^[A-Za-z]:[\\/]/.test(source))return source;
        return decodeURIComponent(source.split(/[?#]/)[0]);
    }
    function fileURL(path) {
        path=path.replace(/\\/g,"/");
        const drive=/^[A-Za-z]:\//.test(path);
        let segments=path.split("/").map(encodeURIComponent);
        if(drive)segments[0]=path.slice(0,2).toUpperCase();
        return (drive?"file:///":"file://")+segments.join("/");
    }
    class HTMLImageElement {
        constructor() { throw new TypeError("Illegal constructor"); }
        get tagName(){return "IMG";}
        get nodeName(){return "IMG";}
        get src(){return imageState(this).src;}
        set src(value){value=String(value);setAttribute.call(this,"src",value);loadImage(this,value);}
        get currentSrc(){return imageState(this).currentSrc;}
        get complete(){return imageState(this).complete;}
        get naturalWidth(){return call(this,"imageSize")[0];}
        get naturalHeight(){return call(this,"imageSize")[1];}
        get width(){
            const size=call(this,"displaySize");if(size)return Math.floor(size[0]);
            const v=getAttribute.call(this,"width");return v===null?this.naturalWidth:dimensionAttribute(v,0);
        }
        set width(v){this.setAttribute("width",String(Number(v)>>>0));}
        get height(){
            const size=call(this,"displaySize");if(size)return Math.floor(size[1]);
            const v=getAttribute.call(this,"height");return v===null?this.naturalHeight:dimensionAttribute(v,0);
        }
        set height(v){this.setAttribute("height",String(Number(v)>>>0));}
        setAttribute(name,value) {
            name=String(name).toLowerCase();value=String(value);setAttribute.call(this,name,value);
            if(name==="src")loadImage(this,value);
            if(name==="width"||name==="height")call(this,"layout");
        }
        removeAttribute(name) {
            name=String(name).toLowerCase();removeAttribute.call(this,name);
            if(name==="src")loadImage(this,"");
            if(name==="width"||name==="height")call(this,"layout");
        }
        decode() {
            const s=imageState(this),generation=s.generation;
            return promiseResolve().then(()=>{
                if(generation!==s.generation||s.error||!s.src)fail("EncodingError","Image is not decoded");
                if(s.complete)return;
                return new Promise((resolve,reject)=>s.pending.push({resolve,reject}));
            });
        }
    }
    Object.setPrototypeOf(HTMLCanvasElement.prototype,nodePrototype);
    Object.setPrototypeOf(HTMLImageElement.prototype,nodePrototype);
    function Image(width,height) {
        if(!new.target)throw new TypeError("Image requires new");
        const image=document.createElement("img");
        if(width!==undefined)image.width=width;if(height!==undefined)image.height=height;return image;
    }
    Image.prototype=HTMLImageElement.prototype;
    const globals={HTMLCanvasElement,CanvasRenderingContext2D,HTMLImageElement,Image,Path2D,CanvasGradient,
        CanvasPattern,ImageData,TextMetrics,DOMMatrix,DOMPoint,Blob};
    if(!globalThis.DOMException)globals.DOMException=DOMException;
    for(const [name,type] of Object.entries(globals))
        if(name!=="Image")Object.defineProperty(type.prototype,Symbol.toStringTag,{value:name,configurable:true});
    for(const [name,value] of Object.entries(globals))Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
    return [HTMLCanvasElement.prototype,HTMLImageElement.prototype,factory=>{
        createWebGPU=factory;framePixels=factory?.framePixels??null;
        const pixels=image=>{
            const source=imageSource(image);if(!source)throw new DOMException("Image source is not ready","InvalidStateError");
            return {width:source.width,height:source.height,pixels:new Uint8Array(call(null,"sourcePixels",[source.width,source.height],"",source.handle))};
        };
        if(factory)factory.setImageSource(image=>{
            const source=imageSource(image);if(!source)throw new DOMException("Image source is not ready","InvalidStateError");
            const info=call(null,"sourceInfo",[],"",source.handle);
            return {handle:source.handle,width:info[0],height:info[1]};
        });
        if(factory)factory.setAbortSignalValidator(createWebGL.isAbortSignal);
        createWebGL?.setFramePixels?.(image=>framePixels?.(image)?pixels(image):null);
    }];
})
