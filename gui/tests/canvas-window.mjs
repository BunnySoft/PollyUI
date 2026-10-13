function check(ok,message){if(!ok)throw new Error(message);}
const main=window.create({title:"Canvas2D.mapped",width:200,height:160});
const document=main.document;
Object.assign(document.body.style,{backgroundColor:"white",alignItems:"flex-start"});
const clip=document.createElement("view");
Object.assign(clip.style,{position:"absolute",left:"10",top:"10",width:"30",height:"20",overflow:"hidden",scrollLeft:"2"});
const canvas=document.createElement("canvas");canvas.width=4;canvas.height=4;
Object.assign(canvas.style,{width:"40",height:"40"});
const ctx=canvas.getContext("2d");ctx.fillStyle="red";ctx.fillRect(0,0,4,4);
clip.appendChild(canvas);document.body.appendChild(clip);
const source=document.createElement("canvas");source.width=2;source.height=2;
source.getContext("2d").fillStyle="blue";source.getContext("2d").fillRect(0,0,2,2);
const image=new Image();image.src=source.toDataURL();await image.decode();
Object.assign(image.style,{position:"absolute",left:"60",top:"10",width:"10",height:"10"});
document.body.appendChild(image);
canvas.addEventListener("mousedown",event=>{
    check(Math.abs(event.clientX-20)<1&&Math.abs(event.clientY-20)<1,"logical Canvas input coordinates at 1.5 DPI");
    check(canvas.width===4&&canvas.height===4,"DPI does not resize backing store");
    ctx.fillStyle="lime";ctx.fillRect(0,0,4,4);
    console.log("PASS: mapped canvas receives logical input, backing remains 4x4");
    setTimeout(()=>window.quit(),100);
});
setTimeout(()=>{console.error("FAIL: mapped canvas input timed out");window.quit();},8000);
