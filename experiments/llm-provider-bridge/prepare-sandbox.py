"""Copy a checkout and align its three Effect packages without changing it.

OPENCODE_SOURCE must have the remaining dependencies installed already.
Only an OS temporary sandbox is written. No project manifest/lockfile is edited.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

source = Path(os.environ['OPENCODE_SOURCE']).resolve()
root = Path(tempfile.mkdtemp(prefix='yuri-clean-llm-', dir=os.environ.get('EXPERIMENT_TMPDIR')))
catalog = json.loads((source / 'package.json').read_text())['workspaces']['catalog']
for name in ['effect', '@effect/platform-node', '@effect/platform-node-shared']:
    version = catalog[name]
    with urllib.request.urlopen(f'https://registry.npmjs.org/{name}/{version}') as response:
        metadata = json.load(response)
    with urllib.request.urlopen(metadata['dist']['tarball']) as response:
        data = response.read()
    algorithm, digest = metadata['dist']['integrity'].split('-', 1)
    assert algorithm == 'sha512'
    assert base64.b64encode(hashlib.sha512(data).digest()).decode() == digest
    destination = root / 'node_modules' / name
    destination.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive.getmembers():
            if member.name.startswith('package/'):
                member.name = member.name[8:]
                if member.name:
                    archive.extract(member, destination, filter='data')

copied = root / 'source'
copied.mkdir()
for name in ['package.json', 'bunfig.toml', 'tsconfig.json']:
    if (source / name).exists():
        shutil.copy2(source / name, copied / name)
for folder in ['packages', 'services']:
    for package in (source / folder).iterdir():
        if package.is_dir() and (package / 'package.json').exists():
            shutil.copytree(package, copied / folder / package.name,
                            ignore=shutil.ignore_patterns('node_modules', '.git', 'dist', '.scratch', 'test', 'tests'))
for original in [source / 'node_modules', *source.glob('packages/*/node_modules'), *source.glob('services/*/node_modules')]:
    if not original.exists():
        continue
    destination = copied / original.relative_to(source)
    destination.mkdir(parents=True, exist_ok=True)
    for entry in original.iterdir():
        if entry.name == '.bin':
            continue
        output = destination / entry.name
        if entry.name == 'effect':
            output.symlink_to(root / 'node_modules/effect', target_is_directory=True)
        elif entry.name in ['@opencode', '@effect']:
            output.mkdir()
            for item in entry.iterdir():
                resolved = item.resolve()
                if entry.name == '@effect' and item.name in ['platform-node', 'platform-node-shared']:
                    target = root / 'node_modules/@effect' / item.name
                elif resolved.is_relative_to(source):
                    target = copied / resolved.relative_to(source)
                else:
                    target = resolved
                (output / item.name).symlink_to(target, target_is_directory=item.is_dir())
        else:
            output.symlink_to(entry.resolve(), target_is_directory=entry.is_dir())
print(copied)
