import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import {resolve,relative,isAbsolute,sep} from "node:path";
import {execFileSync} from "node:child_process";
const [rootInput,buildInput,output,publishedReceipt]=process.argv.slice(2);
if(!rootInput||!buildInput||!output)throw new Error("usage: node capture-receipt.mjs source-root build-directory output.json");
const root=resolve(rootInput),build=resolve(buildInput);
const hash=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
function local(path){
    const name=relative(root,resolve(path));
    return name&&!name.startsWith(".."+sep)&&!isAbsolute(name)?name:null;
}
const commands=JSON.parse(readFileSync(resolve(build,"compile_commands.json"),"utf8"));
const sources=commands.map(entry=>({path:resolve(entry.directory,entry.file),command:entry.command||entry.arguments,
        object:entry.output?resolve(entry.directory,entry.output):null}))
    .filter(entry=>local(entry.path)&&existsSync(entry.path)&&entry.object&&existsSync(entry.object))
    .map(entry=>({path:local(entry.path),sha256:hash(entry.path),command:entry.command,
        object:local(entry.object),objectSha256:hash(entry.object)}));
const dependencies=new Set();
for(const line of execFileSync("ninja",["-C",build,"-t","deps"],{encoding:"utf8",maxBuffer:64*1024*1024}).split(/\r?\n/)){
    if(!/^\s{4}/.test(line))continue;
    const path=resolve(build,line.trim()),name=local(path);
    if(name&&existsSync(path))dependencies.add(name);
}
const embedded=[];
for(const [source,header,symbol]of [
    ["gui/sdk/canvas.js","gui/canvas-script.h","pu_canvas_script"],
    ["gui/sdk/webgl.js","gui/webgl-script.h","pu_webgl_script"],
    ["gui/sdk/webgl-interface.js","gui/webgl-script.h","pu_webgl_interface"]]){
    const file=resolve(build,header),text=readFileSync(file,"utf8");
    const match=new RegExp(symbol+"\\[\\]\\s*=\\s*\\{([^}]+)\\}").exec(text);
    if(!match)throw new Error("Missing embedded symbol "+symbol);
    const bytes=Buffer.from(Array.from(match[1].matchAll(/0x([0-9a-fA-F]{2})/g),m=>parseInt(m[1],16)));
    const sourceHash=hash(resolve(root,source)),embeddedHash=createHash("sha256").update(bytes).digest("hex");
    if(sourceHash!==embeddedHash)throw new Error("Embedded script differs from actual source: "+source);
    embedded.push({source,sourceSha256:sourceHash,header:relative(root,file),headerSha256:hash(file),
        embeddedSha256:embeddedHash,bytes:bytes.length,matches:true});
}
const artifacts=[];
for(const name of ["pollyui-gpu-test","pollyui-gpu-current-test","pollyui-canvas-test","pollyui-playground"]){
    const path=resolve(build,"gui",name+(process.platform==="win32"?".exe":""));
    if(existsSync(path))artifacts.push({path:local(path),sha256:hash(path)});
}
for(const name of ["libEGL.dll","libGLESv2.dll","d3dcompiler_47.dll"]){
    const path=resolve(build,"gui",name);
    if(existsSync(path))artifacts.push({path:local(path),sha256:hash(path),developmentCopyOnly:true});
}
const git=args=>execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();
const metadata=publishedReceipt?JSON.parse(readFileSync(publishedReceipt,"utf8")):
    {head:git(["rev-parse","HEAD"]),tree:git(["rev-parse","HEAD^{tree}"]),dirty:git(["status","--porcelain"])};
const receipt={generatedAt:new Date().toISOString(),sourceRoot:root,buildDirectory:build,
    base:"20df3da4cfcfffc043aaea0dc76a1bf21f90fec8",head:metadata.head,tree:metadata.tree,
    dirty:metadata.dirty,gitIdentitySource:publishedReceipt?"published native source receipt; private source copy has no .git":".git",
    compiledSources:sources,
    compiledLocalDependencies:[...dependencies].sort().map(path=>({path,sha256:hash(resolve(root,path))})),
    embeddedScripts:embedded,artifacts,dependencyReceipt:JSON.parse(readFileSync(resolve(root,"gui/tests/gpu/dependency-receipt.json"),"utf8")),
    limits:"Hashes describe the actual configured inputs and artifacts. No statement of complete WebGL/WPT, physical-GPU or release DLL redistribution qualification."};
writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");
console.log(JSON.stringify({sources:sources.length,headers:dependencies.size,embeddedScripts:embedded.length,
    artifacts:artifacts.length,head:receipt.head,tree:receipt.tree,dirty:Boolean(receipt.dirty)}));
