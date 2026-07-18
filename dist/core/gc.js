import { promises as fs } from 'node:fs';
import path from 'node:path';
function classifyCacheOrphan(name) {
    if (name.startsWith('proxy-'))
        return 'orphan proxy (no source references it)';
    if (name.startsWith('peaks-'))
        return 'orphan waveform (no source references it)';
    if (name.startsWith('sc-'))
        return 'orphan scene thumbnail';
    if (name.startsWith('thumb-'))
        return 'orphan source thumbnail (source removed)';
    return 'orphan cache file (unreferenced by current manifest)';
}
/** Enumerate cache/+transcript orphans without touching disk (besides reading). Always safe to call. */
export async function planGc(project) {
    const m = await project.manifest();
    const liveSourceIds = new Set(m.sources.map((s) => s.id));
    const protectedRel = new Set(['cache/fonts.json', 'cache/export-results.json']);
    for (const s of m.sources) {
        if (s.proxy)
            protectedRel.add(s.proxy);
        if (s.peaks)
            protectedRel.add(s.peaks);
        // Poster-frame thumbnail (media pool panel) is convention-named, never
        // recorded on the manifest — see daemon.ts's /media/thumb/<sourceId>
        // handler (`cache/thumb-${src.id}.jpg`), the one file this module
        // protects by naming convention rather than a manifest field.
        protectedRel.add(`cache/thumb-${s.id}.jpg`);
    }
    for (const id of liveSourceIds) {
        const sceneFile = await project.scenes(id);
        for (const scene of sceneFile.scenes) {
            if (scene.thumb)
                protectedRel.add(scene.thumb);
        }
    }
    const orphans = [];
    let cacheEntries = [];
    try {
        cacheEntries = await fs.readdir(project.cacheDir);
    }
    catch {
        cacheEntries = []; // no cache/ dir yet — nothing to prune
    }
    for (const name of cacheEntries) {
        if (name.includes('.tmp-'))
            continue; // in-flight / crash-remnant write — never gc's business
        const rel = `cache/${name}`;
        if (protectedRel.has(rel))
            continue;
        const abs = path.join(project.cacheDir, name);
        const st = await fs.stat(abs).catch(() => null);
        if (!st || !st.isFile())
            continue; // skip subdirectories defensively
        orphans.push({ path: rel, bytes: st.size, reason: classifyCacheOrphan(name) });
    }
    // Orphan transcripts: transcript-<sourceId>.json at the project ROOT whose
    // source no longer exists in the manifest at all (spec: "ソースが manifest
    // に残る限り保持、ソースごと消えた孤児 transcript は削除対象" — kept
    // regardless of Source.transcribed as long as the SOURCE itself is still
    // present; only a fully-removed source's leftover transcript is an
    // orphan).
    let rootEntries = [];
    try {
        rootEntries = await fs.readdir(project.dir);
    }
    catch {
        rootEntries = [];
    }
    for (const name of rootEntries) {
        const match = /^transcript-(.+)\.json$/.exec(name);
        if (!match)
            continue;
        const sourceId = match[1];
        if (liveSourceIds.has(sourceId))
            continue;
        const abs = path.join(project.dir, name);
        const st = await fs.stat(abs).catch(() => null);
        if (!st)
            continue;
        orphans.push({ path: name, bytes: st.size, reason: 'orphan transcript (source removed from project)' });
    }
    const totalBytes = orphans.reduce((acc, o) => acc + o.bytes, 0);
    return { orphans, totalBytes, deleted: false };
}
/** Plan, then (only when `opts.yes`) actually delete every listed orphan. Default is dry-run — never deletes anything. */
export async function runGc(project, opts = {}) {
    const plan = await planGc(project);
    if (!opts.yes)
        return plan;
    for (const o of plan.orphans) {
        await fs.rm(path.join(project.dir, o.path), { force: true });
    }
    return { ...plan, deleted: true };
}
