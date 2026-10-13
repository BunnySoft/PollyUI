import * as THREE from "gui/tests/gpu/node_modules/three/build/three.module.js";

function check(ok,message){if(!ok)throw new Error(message);}
const renderer=new THREE.WebGLRenderer({alpha:false,preserveDrawingBuffer:true});
renderer.setSize(96,64);
renderer.setClearColor(0xffffff,1);
document.body.appendChild(renderer.domElement);
const gl=renderer.getContext();
check(gl instanceof WebGL2RenderingContext,"Three must use native PollyUI WebGL2");
console.log("unmodified Three revision",THREE.REVISION);
renderer.debug.onShaderError=(context,program,vertex,fragment)=>{
    throw Error([context.getProgramInfoLog(program),context.getShaderInfoLog(vertex),context.getShaderInfoLog(fragment)].join("\n"));
};
const scene=new THREE.Scene();
const camera=new THREE.OrthographicCamera(-1.5,1.5,1,-1,.1,20);
camera.position.z=4;
const geometry=new THREE.BoxGeometry(.8,.8,.8);
const red=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:0xff0000}));
red.position.x=-.7;scene.add(red);
const data=new Uint8Array([0,255,0,255,0,255,0,255,0,255,0,255,0,255,0,255]);
const texture=new THREE.DataTexture(data,2,2,THREE.RGBAFormat);
texture.needsUpdate=true;
const green=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture}));
green.position.x=.7;scene.add(green);
renderer.render(scene,camera);
function pixel(x,y){
    const data=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);return [...data];
}
function exact(actual,expected,label){check(JSON.stringify(actual)===JSON.stringify(expected),label+": "+JSON.stringify(actual));}
exact(pixel(26,32),[255,0,0,255],"actual box geometry/red material");
exact(pixel(70,32),[0,255,0,255],"actual box geometry/DataTexture sampler");
exact(pixel(48,2),[255,255,255,255],"scene background");
check(renderer.info.render.calls===2&&renderer.info.render.triangles===24,"real indexed mesh draw accounting");
check(gl.getError()===gl.NO_ERROR,"Three draw produces no GPU validation error");
renderer.setSize(144,96);renderer.render(scene,camera);
check(gl.drawingBufferWidth===144&&gl.drawingBufferHeight===96,"Three native backing resize");
exact(pixel(39,48),[255,0,0,255],"scene survives resize");
const source=document.createElement("canvas");source.width=2;source.height=2;
const sourceContext=source.getContext("2d");sourceContext.fillStyle="blue";sourceContext.fillRect(0,0,2,2);
const canvasTexture=new THREE.CanvasTexture(source);
green.material.map=canvasTexture;green.material.needsUpdate=true;
renderer.render(scene,camera);
exact(pixel(105,48),[0,0,255,255],"real CanvasTexture snapshot upload");
const image=new Image();image.src=source.toDataURL();await image.decode();
const imageTexture=new THREE.Texture(image);imageTexture.needsUpdate=true;
green.material.map=imageTexture;green.material.needsUpdate=true;renderer.render(scene,camera);
exact(pixel(105,48),[0,0,255,255],"actual decoded HTML image texture");
check(gl.getError()===gl.NO_ERROR,"image texture GPU errors");
let loss=0,restore=0;
renderer.domElement.addEventListener("webglcontextlost",()=>++loss);
renderer.domElement.addEventListener("webglcontextrestored",()=>++restore);
renderer.forceContextLoss();
await new Promise(resolve=>setTimeout(resolve,0));
check(gl.isContextLost()&&loss===1,"Three receives actual context destruction");
renderer.forceContextRestore();
await new Promise(resolve=>setTimeout(resolve,0));
check(!gl.isContextLost()&&restore===1&&renderer.getContext()===gl,"Three receives actual EGL restoration");
renderer.render(scene,camera);
exact(pixel(39,48),[255,0,0,255],"Three recreates actual GPU buffers/programs after restoration");
exact(pixel(105,48),[0,0,255,255],"Three recreates decoded-image texture after restoration");
check(gl.getError()===gl.NO_ERROR,"Three restored scene has no native error");
geometry.dispose();red.material.dispose();green.material.dispose();
texture.dispose();canvasTexture.dispose();imageTexture.dispose();renderer.dispose();
globalThis.gpuTestsDone=true;
console.log("PASS: unmodified Three r180 indexed scene, textures, resize, actual EGL loss/restore and disposal");
