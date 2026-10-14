import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";

const [idlPath, outputPath] = process.argv.slice(2);
if (!idlPath || !outputPath) throw Error("Expected pinned WebGPU IDL and output path");
const idl = readFileSync(idlPath, "utf8");
const enums = {};
for (const match of idl.matchAll(/enum (GPU\w+) \{([\s\S]*?)\};/g))
    enums[match[1].slice(3)] = [...match[2].matchAll(/"([^"]+)"/g)].map(value => value[1]);
if (!enums.TextureFormat || !enums.VertexFormat || !enums.FeatureName)
    throw Error("Pinned IDL is missing core enum definitions");
writeFileSync(outputPath, JSON.stringify({
    sourceCommit: "25a5dc4537074c9b3844dd95891f5cfd193f4407",
    derivedIdlSha256: createHash("sha256").update(idl).digest("hex"),
    enums,
}, null, 2) + "\n");
