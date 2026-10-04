import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const libraries = execFileSync('ldd', [path.resolve(process.argv[2])], { encoding: 'utf8', timeout: 5000 });
assert.doesNotMatch(libraries, /libharfbuzz/); // Private static build, never an ABI-reduced system replacement.
assert.match(libraries, /libicuuc/);
assert.doesNotMatch(libraries, /lib(?:glib|gio|gobject)-2\.0/);
console.log('PASS: shaping and segmentation runtime has no GLib, GIO or GObject dependency');
