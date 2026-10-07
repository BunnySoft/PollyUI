import assert from 'node:assert/strict';
import { parseCandidates, planUpdates } from '../tools/debian-update-report.mjs';
const text = [
  'a | 2 | http://deb.debian.org/debian trixie/main amd64 Packages',
  'a | 4 | http://deb.debian.org/debian trixie-backports/main amd64 Packages',
  'a | 3 | http://deb.debian.org/debian-security trixie-security/main amd64 Packages',
  'b | 6~bpo13+1 | http://deb.debian.org/debian trixie-backports/main amd64 Packages',
  'b | 8 | http://deb.debian.org/debian trixie/main amd64 Packages',
  'a | 9 | http://deb.debian.org/debian trixie/main Sources',
].join('\n');
const candidates = parseCandidates(text);
const report = planUpdates([{name:'a:amd64',version:'2'}, {name:'b',version:'5~bpo13+1'},
  {name:'missing',version:'1'}], candidates, (a,b) => parseInt(a,10) > parseInt(b,10));
assert.equal(report[0].candidate.version,'3');
assert.equal(candidates.get('a').length, 3, 'Source packages must not be offered as binary candidates');
assert.equal(report[0].pinnedVersionStillListed,true);
assert.equal(report[1].candidate.version,'6~bpo13+1');
assert.equal(report[1].pinnedVersionStillListed,false);
assert.equal(report[2].available,false);
assert.equal(report[2].candidate,null);
assert.throws(()=>parseCandidates(text.replace('trixie/main','sid/main')),/outside/);
assert.throws(()=>parseCandidates(text.replace('deb.debian.org','example.org')),/outside/);
assert.throws(()=>parseCandidates('invalid output'),/Unexpected/);
assert.throws(()=>parseCandidates('a | 3 | http://deb.debian.org/debian trixie/contrib amd64 Packages'),/outside/);
console.log('PASS: explicit Debian update channels, unavailable pins and unapproved-source rejection');
