function check(value,message){if(!value)throw Error(message);}
const data=new Uint8Array(40).fill(99);
data.set([255,0,0,255,0,255,0,255],4);data.set([0,0,255,255,255,255,255,255],16);
const frame=new VideoFrame(new DataView(data.buffer,4,28),{format:"RGBA",codedWidth:2,codedHeight:2,
    timestamp:-3,duration:10,layout:[{offset:0,stride:12}],displayWidth:4,displayHeight:4});
data.fill(0);
check(frame.format==="RGBA"&&frame.codedWidth===2&&frame.displayWidth===4&&frame.timestamp===-3&&frame.duration===10,
    "actual owned frame metadata");
const clone=frame.clone();frame.close();
check(frame.format===null&&frame.codedWidth===0,"closed frame state");
const output=new Uint8Array(40).fill(88);
const layouts=await clone.copyTo(new DataView(output.buffer,4,28),{format:"BGRA",layout:[{offset:0,stride:12}]});
check(layouts[0].stride===12&&[...output.slice(4,12),...output.slice(16,24)].join()===
    "0,0,255,255,0,255,0,255,255,0,0,255,255,255,255,255","owned/clone/stride/byteOffset and RGBA-to-BGRA conversion");
check(clone.allocationSize({rect:{x:1,y:0,width:1,height:2}})===8,"actual cropped allocation size");
const cropped=new Uint8Array(8);await clone.copyTo(cropped,{rect:{x:1,y:0,width:1,height:2}});
check([...cropped].join()==="0,255,0,255,255,255,255,255","actual visible/copy crop pixels");
for(const options of [{rect:{x:2,y:0,width:1,height:1}},
    {layout:[{offset:-1,stride:8}]},{layout:[{offset:0,stride:7}]},{layout:[]},
    {layout:[{offset:67108864,stride:8}]},{format:"I420"}]){
    let allocationError,copyError;
    try{clone.allocationSize(options);}catch(error){allocationError=error;}
    try{await clone.copyTo(new Uint8Array(32),options);}catch(error){copyError=error;}
    check(allocationError&&copyError&&allocationError.name===copyError.name,
        "allocationSize and copyTo enforce identical actual rect/layout/format budgets");
}
clone.close();let closed;
try{await clone.copyTo(new Uint8Array(16));}catch(error){closed=error;}
check(closed?.name==="InvalidStateError","closed frame copy explicitly rejects");
globalThis.webgpuTestsDone=true;console.log("WEBGPU_FRAME ownedPixels=true clone=true stride=true byteOffset=true crop=true closed=true");
