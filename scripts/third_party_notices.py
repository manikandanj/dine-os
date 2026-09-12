"""Collect installed package license files for review; reads no app credentials."""
from pathlib import Path
import json
from importlib import metadata
root=Path(__file__).resolve().parents[1]
blocks=['DineOS — third-party package notices\nGenerated from the locally installed pinned dependencies.\n']
seen=set()
for folder in sorted((root/'node_modules/.pnpm').glob('*/node_modules')):
    packages=list(folder.glob('*/package.json'))+list(folder.glob('@*/*/package.json'))
    for manifest in packages:
        package=json.loads(manifest.read_text());identity=(package['name'],package['version'])
        if identity in seen:continue
        seen.add(identity)
        licenses=[p for p in manifest.parent.iterdir() if p.is_file() and p.name.lower().split('.')[0] in ('license','licence','notice','copyright')]
        blocks.append('\n'+'='*70+'\n'+str(identity[0])+' '+str(identity[1])+'\nDeclared license: '+str(package.get('license','See package distribution'))+'\n')
        for license in licenses:blocks.append(license.name+'\n'+license.read_text(errors='replace'))
for dist in sorted(metadata.distributions(),key=lambda d:d.metadata['Name'].lower()):
    name=dist.metadata['Name'];version=dist.version
    blocks.append('\n'+'='*70+'\nPython: '+name+' '+version+'\n')
    for file in dist.files or []:
        if file.name.lower().split('.')[0] in ('license','licence','notice','copyright','license-mit','license-apache'):
            path=Path(dist.locate_file(file))
            if path.is_file():blocks.append(str(file)+'\n'+path.read_text(errors='replace'))
(root/'docs/THIRD_PARTY_NOTICES.txt').write_text('\n'.join(blocks))
print(f'Collected notices for {len(seen)} JavaScript packages and installed Python distributions.')
