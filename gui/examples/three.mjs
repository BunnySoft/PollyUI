import * as THREE from "gui/tests/gpu/node_modules/three/build/three.module.js";

const app=window.create({title:"PollyUI native Three.js r180",width:640,height:420});
const document=app.document;
Object.assign(document.body.style,{backgroundColor:"#101820",alignItems:"flex-start"});
const canvas=document.createElement("canvas");
Object.assign(canvas.style,{width:"640",height:"420"});
document.body.appendChild(canvas);
const renderer=new THREE.WebGLRenderer({canvas,alpha:false});
renderer.setSize(640,420,false);
renderer.setClearColor(0x101820);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(45,640/420,.1,100);
camera.position.z=4;
const source=document.createElement("canvas");source.width=64;source.height=64;
const ctx=source.getContext("2d");
ctx.fillStyle="#38bdf8";ctx.fillRect(0,0,64,64);
ctx.fillStyle="#fbbf24";ctx.fillRect(0,0,32,32);ctx.fillRect(32,32,32,32);
const texture=new THREE.CanvasTexture(source);
const mesh=new THREE.Mesh(new THREE.BoxGeometry(1.4,1.4,1.4),new THREE.MeshBasicMaterial({map:texture}));
scene.add(mesh);
renderer.debug.onShaderError=(gl,p,v,f)=>{throw new Error([gl.getProgramInfoLog(p),gl.getShaderInfoLog(v),gl.getShaderInfoLog(f)].join("\n"));};
canvas.addEventListener("mousedown",()=>{mesh.rotation.y+=.5;renderer.render(scene,camera);});
let last=0;
function frame(time){
    mesh.rotation.y+=(time-last)*.0004;mesh.rotation.x=.3;last=time;
    renderer.render(scene,camera);requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
