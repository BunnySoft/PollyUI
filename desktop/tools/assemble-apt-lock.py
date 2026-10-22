#!/usr/bin/env python3
"""Assemble a polly-apt-resolution lock from a frozen runtime collection."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

RAW = Path('/root/lock-final')
OUT = Path('/root/lock-final/lock')
PLAN = json.loads((RAW / 'plan.json').read_text())
RUNTIME_MANIFEST = Path('/root/polly-latest-out/runtime/manifest.json')
RUNTIME_IMAGE = Path('/root/polly-latest-out/runtime-image-id.txt').read_text().strip()
APT_VERSION = (RAW / 'apt-version.txt').read_text().strip()


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def records(path):
    result = []
    for block in path.read_text(errors='replace').split('\n\n'):
        item = {}
        for line in block.splitlines():
            if line and not line[0].isspace() and ': ' in line:
                key, value = line.split(': ', 1)
                item[key] = value
        if item:
            result.append(item)
    return result


if OUT.exists():
    shutil.rmtree(OUT)
(OUT / 'sources').mkdir(parents=True)
(OUT / 'packages').mkdir()

# Index/source mapping from the apt lists collected inside the runtime image.
source_files = {}
for path in sorted((RAW / 'lists').glob('*_Packages')):
    name = path.name
    m = re.match(r'.*_dists_(?P<suite>.+?)_(?P<component>.+?)_binary-amd64_Packages$', name)
    if not m:
        continue
    suite, component = m.group('suite'), m.group('component')
    if component not in ('main', 'non-free-firmware'):
        continue
    source_id = re.sub(r'[^a-z0-9-]', '-', (suite + '-' + component).lower())
    source_id = re.sub(r'-+', '-', source_id).strip('-')
    inrelease = next((RAW / 'lists').glob(f'*_dists_{suite}_InRelease'), None)
    if inrelease is None:
        raise SystemExit(f'missing InRelease for {suite}')
    source_files[source_id] = {
        'suite': suite, 'component': component,
        'inrelease': inrelease, 'index': path,
        'releasePath': component + '/binary-amd64/Packages',
    }

index = {}
for source_id, info in source_files.items():
    for record in records(info['index']):
        key = (record.get('Package'), record.get('Version'), record.get('Architecture'))
        if key[0]:
            index[key] = source_id

# Package inventory is the exact runtime base plus the resolved platform closure.
final = []
for line in (RAW / 'final.tsv').read_text().splitlines():
    if not line.strip():
        continue
    name, version, architecture = line.split('\t')
    final.append({'name': name, 'version': version, 'architecture': architecture,
                  'reason': 'Frozen runtime base or APT-resolved platform/boot closure.'})

archives = []
for deb in sorted((RAW / 'cache').glob('*.deb')):
    control = subprocess.check_output(
        ['dpkg-deb', '-f', str(deb), 'Package', 'Version', 'Architecture'],
        text=True, timeout=30)
    fields = dict(line.split(': ', 1) for line in control.splitlines() if ': ' in line)
    key = (fields.get('Package'), fields.get('Version'), fields.get('Architecture'))
    source_id = index.get(key)
    if source_id is None:
        raise SystemExit(f'archive has no signed index: {deb.name} {key}')
    digest = sha(deb)
    target = OUT / 'packages' / (digest + '.deb')
    shutil.copyfile(deb, target)
    archives.append({'name': key[0], 'version': key[1], 'architecture': key[2],
                     'path': 'packages/' + digest + '.deb', 'sha256': digest,
                     'bytes': deb.stat().st_size, 'source': source_id, 'stage': 'platform'})

sources = []
for source_id, info in source_files.items():
    directory = OUT / 'sources' / source_id
    directory.mkdir(parents=True)
    inrelease = directory / 'InRelease'
    package_index = directory / 'Packages'
    shutil.copyfile(info['inrelease'], inrelease)
    shutil.copyfile(info['index'], package_index)
    sources.append({'id': source_id,
                    'inRelease': {'path': f'sources/{source_id}/InRelease', 'sha256': sha(inrelease)},
                    'index': {'path': f'sources/{source_id}/Packages', 'sha256': sha(package_index)},
                    'releasePath': info['releasePath']})

lock = {
    'schemaVersion': 1,
    'kind': 'polly-apt-resolution',
    'packageRequestSha256': PLAN['packageRequestSha256'],
    'runtimeManifestSha256': sha(RUNTIME_MANIFEST),
    'runtimeImageID': RUNTIME_IMAGE,
    'solver': {'name': 'apt-get', 'version': APT_VERSION,
               'note': 'Resolved in the frozen standard-effects4 runtime image from signed Debian mirror indices.'},
    'packages': final,
    'archives': archives,
    'sources': sources,
}
(OUT / 'packages.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(f'packages={len(final)} archives={len(archives)} sources={len(sources)}')
print(f'lock={OUT / "packages.lock.json"}')
