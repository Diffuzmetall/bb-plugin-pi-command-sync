#!/usr/bin/env python3
"""Exact BB 0.45 Pi command completion and native-menu repair; no cache mutation."""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

# Reference installation; point BB_PI_HOST_ARTIFACT at another provider-pi host.js.
TARGET = Path(os.environ.get(
    'BB_PI_HOST_ARTIFACT',
    '/home/ubuntu/.bb-server/app/node_modules/bb-app/server/dist/builtin-plugins/provider-pi/dist/host.js',
))
EDITS = (
    ('await t.requestOk(n,r);return}catch(a)',
     'return await t.requestOk(n,r)}catch(a)'),
    ('then(async()=>o.pending.queuedText!==null?(this.dropRunSettlement(),null):(this.resolvePendingInputConsumption(o.pending),await a),l=>',
     'then(async l=>{if(l?.disposition==="handled"&&!this.isCompacting&&o.pending.queuedText===null){let u=await this.getState();if(u.isStreaming!==!0){this.isProcessing=!1;this.dropRunSettlement();this.resolvePendingInputConsumption(o.pending);return{}}}return o.pending.queuedText!==null?(this.dropRunSettlement(),null):(this.resolvePendingInputConsumption(o.pending),await a)},l=>'),
    ('return{skills:tb({skills:[...n].sort().map(o=>({path:o,origin:"user",shape:"skills"}))},{warn:console.warn}).answer.skills}}s(ib,"resolvePiNativeRoots")',
     'const{createHash:bbHash}=await import("node:crypto");const bbRoot=qe.join(e.homeDir,".pi","bb-commands");let bbCommands=[],bbSkills=[];let bbKeys=e.cwd?[qe.join("projects",bbHash("sha256").update(e.cwd).digest("hex")+".json"),"global.json"]:["global.json"];for(const bbKey of bbKeys){try{const bbData=JSON.parse(await hR(qe.join(bbRoot,bbKey),"utf8"));if(!/^[a-f0-9]{64}$/.test(bbData.snapshot))continue;bbCommands.push({path:qe.join(bbRoot,"catalog",bbData.snapshot),origin:"user",shape:"commands"});if(Array.isArray(bbData.skillRoots))for(const bbSkill of bbData.skillRoots.slice(0,32))if(typeof bbSkill?.path==="string"&&qe.isAbsolute(bbSkill.path)&&(bbSkill.origin==="user"||bbSkill.origin==="project")&&(bbSkill.origin!=="project"||bbKey!=="global.json"))bbSkills.push({path:bbSkill.path,origin:bbSkill.origin,shape:"skills"});break}catch{}}return tb({skills:[...bbSkills,...[...n].sort().map(o=>({path:o,origin:"user",shape:"skills"}))],commands:bbCommands},{warn:console.warn}).answer}s(ib,"resolvePiNativeRoots")'),
    ('s(()=>ib({homeDir:kV(),env:process.env}),"resolveNativeRoots")',
     's(n=>ib({homeDir:kV(),env:process.env,cwd:n.cwd}),"resolveNativeRoots")'),
)


def patch_source(source: str) -> str:
    # Migrate the exact earlier catalog adapter, which did not import skill roots.
    legacy_menu = EDITS[2][1].replace('let bbCommands=[],bbSkills=[];', 'let bbCommands=[];').replace(
        'if(Array.isArray(bbData.skillRoots))for(const bbSkill of bbData.skillRoots.slice(0,32))if(typeof bbSkill?.path==="string"&&qe.isAbsolute(bbSkill.path)&&(bbSkill.origin==="user"||bbSkill.origin==="project")&&(bbSkill.origin!=="project"||bbKey!=="global.json"))bbSkills.push({path:bbSkill.path,origin:bbSkill.origin,shape:"skills"});', '').replace(
        'skills:[...bbSkills,...[...n].sort().map(o=>({path:o,origin:"user",shape:"skills"}))]',
        'skills:[...n].sort().map(o=>({path:o,origin:"user",shape:"skills"}))')
    if source.count(legacy_menu) == 1:
        source = source.replace(legacy_menu, EDITS[2][1], 1)
    # Accept only the exact earlier local repair, not an arbitrary nearby bundle.
    legacy = EDITS[1][1].replace('&&o.pending.queuedText===null', '', 1)
    if source.count(legacy) == 1:
        source = source.replace(legacy, EDITS[1][1], 1)
    for before, after in EDITS:
        if source.count(after) == 1 and before not in source:
            continue
        if source.count(before) != 1 or after in source:
            raise ValueError('Incompatible BB Pi bridge; no files changed. Review the command completion patch for this BB version.')
        source = source.replace(before, after, 1)
    return source


def main():
    source = TARGET.read_text()
    candidate = patch_source(source)
    meta_path = TARGET.with_name('host.meta.json')
    try:
        metadata = json.loads(meta_path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError('Unreadable BB host metadata; no files changed.') from error
    original = candidate
    for before, after in EDITS:
        original = original.replace(after, before, 1)
    digest = hashlib.sha256(candidate.encode()).hexdigest()
    valid_digests = {hashlib.sha256(text.encode()).hexdigest() for text in (source, original)}
    if not isinstance(metadata, dict) or metadata.get('pluginId') != 'provider-pi' or metadata.get('artifactDigest') not in valid_digests:
        raise ValueError('Incompatible BB host metadata; no files changed.')
    if candidate == source and metadata['artifactDigest'] == digest:
        print('BB Pi command completion patch already active.')
        return
    for path in (TARGET, meta_path):
        backup = path.with_name(path.name + '.before-bb-slash-completion')
        if not backup.exists():
            shutil.copy2(path, backup)
        revision_backup = path.with_name(path.name + '.before-bb-slash-completion-' + metadata['artifactDigest'][:12])
        if not revision_backup.exists():
            shutil.copy2(path, revision_backup)
    if candidate != source:
        TARGET.write_text(candidate)
    metadata['artifactDigest'] = digest
    meta_path.write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Patched {TARGET} and verified artifact metadata. Reload provider-pi before live verification.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
