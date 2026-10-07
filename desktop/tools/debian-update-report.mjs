import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRelease } from './release-report.mjs';

export function parseCandidates(text) {
  const result = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|').map(value => value.trim());
    if (parts.length !== 3 || !/^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/.test(parts[0]) ||
        !/^[A-Za-z0-9._+~:-]+$/.test(parts[1])) throw new Error('Unexpected APT candidate output: ' + line);
    const origin = /^(https?:\/\/(?:deb\.debian\.org\/debian(?:-security)?|security\.debian\.org\/debian-security))\s+(trixie(?:-updates|-security|-backports)?)\/(main|non-free-firmware)\s+(?:(?:amd64|all)\s+Packages|Sources)$/.exec(parts[2]);
    if (!origin) throw new Error('Candidate source is outside the approved Debian suites/components: ' + parts[2]);
    if (parts[2].endsWith(' Sources')) continue;
    const name = parts[0].replace(/:amd64$/, '');
    if (!result.has(name)) result.set(name, []);
    result.get(name).push({ version: parts[1], suite: origin[2], component: origin[3], repository: origin[1] });
  }
  return result;
}

export function planUpdates(packages, candidates, newer) {
  return packages.map(pkg => {
    const backport = /~bpo13[+u.]/.test(pkg.version);
    const allowed = (candidates.get(pkg.name.replace(/:amd64$/, '')) || [])
      .filter(item => backport ? item.suite === 'trixie-backports' : item.suite !== 'trixie-backports');
    let newest = null;
    for (const item of allowed) if (!newest || newer(item.version, newest.version)) newest = item;
    return { name: pkg.name, pinned: pkg.version, channel: backport ? 'explicit-backports' : 'stable',
      available: newest !== null, candidate: newest,
      newerThanPinned: newest ? newer(newest.version, pkg.version) : false,
      pinnedVersionStillListed: allowed.some(item => item.version === pkg.version) };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: debian-update-report.mjs RUNTIME_RELEASE_DIRECTORY');
    if (!existsSync('/run/.containerenv') && !existsSync('/.dockerenv'))
      throw new Error('Run this report only in a disposable Debian build container');
    if (!/^VERSION_CODENAME=trixie$/m.test(readFileSync('/etc/os-release', 'utf8')))
      throw new Error('The report requires the Debian trixie tool environment');
    const release = await inspectRelease(process.argv[2]);
    if (release.distribution !== 'debian13' || release.kind !== 'runtime')
      throw new Error('Use a verified Debian runtime package inventory');
    const names = release.packages.map(pkg => pkg.name);
    if (!names.length || names.length > 4096) throw new Error('Package count exceeds update-report bounds');
    const text = execFileSync('apt-cache', ['madison', ...names], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    const newer = (a, b) => {
      const result = spawnSync('dpkg', ['--compare-versions', a, 'gt', b], { encoding: 'utf8', timeout: 5000 });
      if (result.error || ![0, 1].includes(result.status)) throw new Error('Debian version comparison failed');
      return result.status === 0;
    };
    const packages = planUpdates(release.packages, parseCandidates(text), newer);
    console.log(JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(),
      source: release.source, distribution: release.distribution, packages,
      summary: { total: packages.length, newer: packages.filter(pkg => pkg.newerThanPinned).length,
        unavailable: packages.filter(pkg => !pkg.available).length,
        pinsNoLongerListed: packages.filter(pkg => !pkg.pinnedVersionStillListed).length },
      limits: [
        'Read-only candidate report; no package installation, upgrade, repository promotion or scheduled automation.',
        'Stable packages do not automatically move to backports; existing bpo13 pins are checked in their explicit channel.',
        'A newer version is not proof of a security fix. Advisory triage, dependency solving, builds and hardware acceptance remain separate.',
        'APT metadata reflects the last refresh in this disposable container. Upstream source/payload retention is not guaranteed.',
      ] }, null, 2));
  } catch (error) {
    console.error('[debian-update-report] ' + String(error));
    process.exitCode = 1;
  }
}
