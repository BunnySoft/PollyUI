import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

function pixel(png, x, y) {
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    assert.equal(png[24], 8);
    assert.equal(png[28], 0);
    const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0;
    assert.ok(channels && x < width && y < height);
    const chunks = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
            chunks.push(png.subarray(offset + 8, offset + 8 + length));
        offset += length + 12;
    }
    const bytes = inflateSync(Buffer.concat(chunks)), stride = width * channels;
    let previous = Buffer.alloc(stride), current;
    for (let row = 0; row <= y; row++) {
        const filter = bytes[row * (stride + 1)];
        assert.ok(filter <= 4);
        current = Buffer.from(bytes.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? current[i - channels] : 0;
            const b = previous[i], c = i >= channels ? previous[i - channels] : 0;
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ?
                Math.floor((a + b) / 2) : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
            current[i] = (current[i] + predictor) & 255;
        }
        previous = current;
    }
    return [...current.subarray(x * channels, x * channels + 3)];
}

const executable = process.argv[2];
assert.ok(executable, 'Pass the PollyUI executable');
const requireGpu = process.argv[3] === '--require-gpu';
assert.ok(process.argv.length <= 4 && (process.argv.length < 4 || requireGpu), 'Unknown fixture option');
const directory = await mkdtemp(path.join(tmpdir(), 'pollyui-multi-'));
const prefix = path.join(directory, 'frame');
try {
    const child = spawn(path.resolve(executable), ['gui/tests/multi-window.mjs', prefix], {
        env: { ...process.env, XDG_CONFIG_HOME: path.join(directory, 'config'),
            XDG_DATA_HOME: path.join(directory, 'data'), XDG_CACHE_HOME: path.join(directory, 'cache') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        assert.equal(code, 0, output);
        assert.doesNotMatch(output, /FAIL:|AddressSanitizer|runtime error:/);
        assert.match(output, /PASS: shared-runtime multi-window suite complete/);
        if (requireGpu)
            assert.match(output, /GPU backend: ANGLE|Skia GLES renderer:/, 'Required GPU backend is unavailable');
    } catch (error) {
        console.error(output);
        throw error;
    } finally { clearTimeout(timer); }
    const expected = {
        first: [208, 64, 48], second: [48, 96, 192], updated: [32, 160, 80],
        survivor: [144, 80, 176], replacement: [224, 144, 32],
    };
    for (const [name, color] of Object.entries(expected))
        assert.deepEqual(pixel(await readFile(`${prefix}-${name}.png`), 5, 100), color, `${name} pixels`);
    console.log('PASS: independent native-window pixels, shared state, close/reopen and shutdown');
} finally {
    await rm(directory, { recursive: true, force: true });
}
