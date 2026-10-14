import * as THREE from "./gpu/node_modules/three/build/three.webgpu.js";
function check(value,message){if(!value)throw Error(message);}
const canvas=document.createElement("canvas");canvas.width=64;canvas.height=64;
const renderer=new THREE.WebGPURenderer({canvas,antialias:false});
console.log("THREE_WEBGPU_PHASE init");
await renderer.init().then(()=>console.log("THREE_WEBGPU_PHASE initialized"),error=>{console.error(error.message,error.stack);throw error;});
check(renderer.backend.isWebGPUBackend===true,"original Three must use its real WebGPU backend");
renderer.setSize(64,64,false);
const scene=new THREE.Scene();
scene.background=new THREE.Color(0x000000);
const camera=new THREE.PerspectiveCamera(60,1,.1,100);camera.position.z=3;
const cube=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:0xff0000}));
scene.add(cube);
const target=new THREE.RenderTarget(64,64,{type:THREE.UnsignedByteType});
renderer.setRenderTarget(target);
console.log("THREE_WEBGPU_PHASE render");
await renderer.renderAsync(scene,camera);
console.log("THREE_WEBGPU_PHASE readback");
const pixels=await renderer.readRenderTargetPixelsAsync(target,0,0,64,64);
check(pixels instanceof Uint8Array&&pixels.length===16384,"real Three WebGPU aligned RGBA8 readback byte count");
let red=0,black=0;
for(let i=0;i<pixels.length;i+=4){
    if(pixels[i]>=240&&pixels[i+1]<=5&&pixels[i+2]<=5)++red;
    if(pixels[i]===0&&pixels[i+1]===0&&pixels[i+2]===0)++black;
}
check(red>=300&&black>=1000,"actual Three red cube against black framebuffer");
target.dispose();cube.geometry.dispose();cube.material.dispose();renderer.dispose();
globalThis.webgpuTestsDone=true;
console.log("THREE_WEBGPU revision="+THREE.REVISION+" realBackend=true red="+red+" black="+black);
