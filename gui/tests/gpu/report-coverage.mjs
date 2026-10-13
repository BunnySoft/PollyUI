import {readFileSync,writeFileSync} from "node:fs";
import api from "./api.mjs";
const [logFile,output]=process.argv.slice(2);
if(!logFile||!output)throw new Error("usage: node report-coverage.mjs CTest-LastTest.log output.json");
const log=readFileSync(logFile,"utf8"),reports=[];
for(const match of log.matchAll(/(\d+)\/\d+ Testing: (gui-gpu[^\r\n]*)\r?\n([\s\S]*?)(?=\r?\n\d+\/\d+ Testing:|\s*$)/g)){
    const calls=/GPU_METHOD_CALLS (\{[^\r\n]*\})/.exec(match[3]);
    if(calls)reports.push({fixture:match[2],passed:/Test Passed\./.test(match[3]),calls:JSON.parse(calls[1])});
}
if(!reports.length)throw new Error("No actual GPU fixture call receipts in the provided CTest log");
const methods=Object.fromEntries(Object.entries(api.methods).map(([name,overloads])=>[name,{
    overloads:overloads.length,required:Math.min(...overloads.map(o=>o.required)),
    descriptorFixtures:reports.filter(r=>r.fixture==="gui-gpu-api"&&r.passed).map(r=>r.fixture),
    exercisedFixtures:reports.filter(r=>r.fixture!=="gui-gpu-api"&&r.passed&&r.calls[name]>0)
        .map(r=>({fixture:r.fixture,calls:r.calls[name]}))
}]));
const result={kind:"mechanical-interface-and-exercised-call-inventory-not-full-WebGL-conformance",
    specRevision:api.revision,methods:Object.keys(methods).length,overloads:Object.values(methods).reduce((s,m)=>s+m.overloads,0),
    constants:Object.keys(api.constants).length,attributes:api.attributes,
    warning:"A recorded call is not proof of every overload, valid/invalid-input branch, format, or shader rule. Read fixture assertions and WEBGL2.md boundaries.",
    unexercisedInNonDescriptorFixtures:Object.entries(methods).filter(([,m])=>!m.exercisedFixtures.length).map(([n])=>n),
    fixtures:reports.map(({fixture,passed})=>({fixture,passed})),methodInventory:methods,constantInventory:api.constants};
writeFileSync(output,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({methods:result.methods,overloads:result.overloads,constants:result.constants,
    unexercised:result.unexercisedInNonDescriptorFixtures,fixtures:result.fixtures}));
