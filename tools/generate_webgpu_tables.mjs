import { readFileSync, writeFileSync } from 'node:fs';
import {fileURLToPath} from 'node:url';

const [headerPath, outputPath] = process.argv.slice(2);
if (!headerPath || !outputPath) throw new Error('Expected native header and output paths');
const header = readFileSync(headerPath, 'utf8');
const specification = JSON.parse(readFileSync(fileURLToPath(new URL('../gui/sdk/webgpu-enums.json', import.meta.url)), 'utf8'));
let result = '// Generated from the checksum-pinned Dawn C header; do not edit.\n';
const coreTypes = new Set([
    'FeatureName', 'WGSLLanguageFeatureName', 'PowerPreference', 'FeatureLevel',
    'TextureFormat', 'TextureDimension', 'TextureViewDimension', 'TextureAspect',
    'AddressMode', 'FilterMode', 'MipmapFilterMode', 'CompareFunction',
    'BufferBindingType', 'SamplerBindingType', 'TextureSampleType', 'StorageTextureAccess',
    'PrimitiveTopology', 'IndexFormat', 'FrontFace', 'CullMode', 'BlendFactor',
    'BlendOperation', 'StencilOperation', 'VertexFormat', 'VertexStepMode',
    'LoadOp', 'StoreOp', 'QueryType', 'ErrorFilter',
]);
for (const match of header.matchAll(/typedef enum WGPU(\w+) \{([\s\S]*?)\} WGPU\1/g)) {
    if (!coreTypes.has(match[1])) continue;
    const type = match[1];
    for (const entry of match[2].matchAll(new RegExp(`WGPU${type}_(\\w+) = (0x[0-9A-Fa-f]+)`, 'g'))) {
        if (['Undefined', 'Force32', 'BindingNotUsed'].includes(entry[1])) continue;
        const normalized = entry[1].replaceAll('_', '').toLowerCase();
        const standard = specification.enums[type]?.find(value => value.replaceAll('-', '').replaceAll('_', '').toLowerCase() === normalized);
        if(type==='WGSLLanguageFeatureName' && Number(entry[2])<0x50000) {
            const name=entry[1].replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().replace('packed4x8','packed_4x8');
            result += `#ifdef PU_GPU_LANG\nPU_GPU_LANG("${name}", WGPU${type}_${entry[1]})\n#endif\n`;
        }
        if (standard) result += `PU_GPU_ENUM(${type}, "${standard}", WGPU${type}_${entry[1]})\n`;
        else if (type === 'FeatureLevel')
            result += `PU_GPU_ENUM(${type}, "${entry[1].toLowerCase()}", WGPU${type}_${entry[1]})\n`;
    }
}
result += '#ifdef PU_GPU_LIMIT\n';
const limits = /typedef struct WGPULimits \{([\s\S]*?)\} WGPULimits/.exec(header);
if (!limits) throw new Error('Missing native limits');
for (const field of limits[1].matchAll(/(uint32_t|uint64_t) (\w+);/g))
    result += `PU_GPU_LIMIT(${field[2]}, ${field[1]})\n`;
result += '#endif\n';
writeFileSync(outputPath, result);
