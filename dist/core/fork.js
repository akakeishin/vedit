import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Project, resolveWithinDir } from './project.js';
import { upsertProject } from './registry.js';
const SAFE_FILE_ID = /^[A-Za-z0-9_-]+$/;
function errorCode(error) {
    return error?.code;
}
function isWithin(parent, candidate) {
    return candidate === parent || candidate.startsWith(parent + path.sep);
}
function assertSafeFileId(value, label) {
    if (typeof value !== 'string' || !SAFE_FILE_ID.test(value)) {
        throw new Error(`fork: invalid ${label} id: ${JSON.stringify(value)}`);
    }
}
async function lstatIfPresent(file) {
    try {
        return await fs.lstat(file);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function assertRegularFile(file, label, required = true) {
    const stat = await lstatIfPresent(file);
    if (!stat) {
        if (required)
            throw new Error(`fork: referenced ${label} is missing: ${file}`);
        return false;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`fork: referenced ${label} must be a regular non-symlink file: ${file}`);
    }
    return true;
}
/** Resolve and enforce the manifest contract that derived media lives below cache/. */
async function resolveCacheArtifact(projectDir, rel, label) {
    if (typeof rel !== 'string' || rel.length === 0 || path.isAbsolute(rel) || rel.includes('\0')) {
        throw new Error(`fork: invalid ${label} path: ${JSON.stringify(rel)}`);
    }
    const normalized = path.normalize(rel);
    const cachePrefix = `cache${path.sep}`;
    if (!normalized.startsWith(cachePrefix) || normalized === `cache${path.sep}`) {
        throw new Error(`fork: ${label} must be a file below cache/: ${rel}`);
    }
    // Resolve from the project root, not from cache/ itself: a cache symlink
    // escaping the project must not redefine the trusted base directory.
    const abs = await resolveWithinDir(projectDir, normalized);
    return { rel: normalized, abs };
}
async function readJsonRegularFile(file, label) {
    await assertRegularFile(file, label);
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    }
    catch (error) {
        throw new Error(`fork: ${label} is not valid JSON (${error?.message ?? String(error)})`);
    }
}
async function captureCurrentInputs(source) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const observed = await source.manifest();
        try {
            return await source.captureRenderInputs(observed.revision);
        }
        catch (error) {
            if (errorCode(error) !== 'STALE_REVISION')
                throw error;
        }
    }
    throw new Error('fork: source project kept changing; retry once current edits have settled');
}
async function buildForkPlan(source, nameOverride) {
    const inputs = await captureCurrentInputs(source);
    const manifest = inputs.manifest;
    if (!Array.isArray(manifest.sources) || !manifest.timeline || !Array.isArray(manifest.timeline.motion)) {
        throw new Error('fork: source project manifest has an invalid sources/timeline shape');
    }
    if (nameOverride !== undefined && typeof nameOverride !== 'string') {
        throw new Error('fork: --name must be a string');
    }
    const name = nameOverride ?? `${manifest.name} (fork)`;
    const cloned = JSON.parse(JSON.stringify({ ...manifest, name, revision: 0 }));
    const sourceIds = new Set();
    const motionIds = new Set();
    const claimedManagedPaths = new Map();
    const cacheArtifacts = [];
    const sceneArtifacts = [];
    const pinnedJson = [];
    const claim = (rel, label) => {
        const normalized = path.normalize(rel);
        const prior = claimedManagedPaths.get(normalized);
        if (prior)
            throw new Error(`fork: managed path collision at ${normalized} (${prior} and ${label})`);
        claimedManagedPaths.set(normalized, label);
    };
    const transcriptBySource = new Map(inputs.transcripts.map((transcript) => [transcript.sourceId, transcript]));
    for (const sourceItem of cloned.sources) {
        assertSafeFileId(sourceItem?.id, 'source');
        // Exercise the canonical Project filename builders as a second invariant:
        // every source id must be safe wherever this fork is opened later.
        source.transcriptPath(sourceItem.id);
        source.scenesPath(sourceItem.id);
        if (sourceIds.has(sourceItem.id))
            throw new Error(`fork: duplicate source id: ${sourceItem.id}`);
        sourceIds.add(sourceItem.id);
        if (typeof sourceItem.path !== 'string' || !path.isAbsolute(sourceItem.path) || sourceItem.path.includes('\0')) {
            throw new Error(`fork: source ${sourceItem.id} has an invalid original-media path`);
        }
        for (const [kind, rel, counter] of [
            ['proxy', sourceItem.proxy, 'proxies'],
            ['peaks', sourceItem.peaks, 'peaks'],
        ]) {
            if (rel === undefined)
                continue;
            const resolved = await resolveCacheArtifact(source.dir, rel, `${kind} for source ${sourceItem.id}`);
            claim(resolved.rel, `${kind} for source ${sourceItem.id}`);
            await assertRegularFile(resolved.abs, `${kind} for source ${sourceItem.id}`);
            cacheArtifacts.push({ rel: resolved.rel, label: `${kind} for source ${sourceItem.id}`, counter });
        }
        if (sourceItem.transcribed) {
            const transcript = transcriptBySource.get(sourceItem.id);
            if (!transcript || transcript.sourceId !== sourceItem.id) {
                throw new Error(`fork: source ${sourceItem.id} is marked transcribed but has no revision-pinned transcript`);
            }
            const rel = `transcript-${sourceItem.id}.json`;
            claim(rel, `transcript for source ${sourceItem.id}`);
            const sourcePath = source.transcriptPath(sourceItem.id);
            await assertRegularFile(sourcePath, `transcript for source ${sourceItem.id}`, false);
            pinnedJson.push({
                id: sourceItem.id,
                value: transcript,
                sourcePath,
                counter: 'transcripts',
                label: `transcript for source ${sourceItem.id}`,
            });
        }
        const scenePath = source.scenesPath(sourceItem.id);
        const sceneStat = await lstatIfPresent(scenePath);
        if (sceneStat) {
            const sceneFile = await readJsonRegularFile(scenePath, `scene index for source ${sourceItem.id}`);
            if (sceneFile?.sourceId !== sourceItem.id || !Array.isArray(sceneFile.scenes)) {
                throw new Error(`fork: scene index for source ${sourceItem.id} has an invalid shape/sourceId`);
            }
            const sceneIds = new Set();
            for (const scene of sceneFile.scenes) {
                assertSafeFileId(scene?.id, `scene (${sourceItem.id})`);
                if (sceneIds.has(scene.id))
                    throw new Error(`fork: duplicate scene id ${scene.id} for source ${sourceItem.id}`);
                sceneIds.add(scene.id);
                const thumb = await resolveCacheArtifact(source.dir, scene.thumb, `thumbnail for scene ${scene.id}`);
                claim(thumb.rel, `thumbnail for scene ${scene.id}`);
                await assertRegularFile(thumb.abs, `thumbnail for scene ${scene.id}`);
                cacheArtifacts.push({ rel: thumb.rel, label: `thumbnail for scene ${scene.id}`, counter: 'sceneThumbs' });
            }
            claim(`scenes-${sourceItem.id}.json`, `scene index for source ${sourceItem.id}`);
            sceneArtifacts.push({ sourceId: sourceItem.id, file: sceneFile });
        }
    }
    for (const item of cloned.timeline.motion) {
        assertSafeFileId(item?.id, 'motion');
        source.motionSpecPath(item.id);
        if (motionIds.has(item.id))
            throw new Error(`fork: duplicate motion id: ${item.id}`);
        motionIds.add(item.id);
        if (item.spec !== `${item.id}.json`) {
            throw new Error(`fork: motion ${item.id} has an invalid spec path: ${JSON.stringify(item.spec)}`);
        }
        if (!Object.prototype.hasOwnProperty.call(inputs.motionSpecs, item.id)) {
            throw new Error(`fork: motion ${item.id} has no revision-pinned spec`);
        }
        const rel = path.join('motion', `${item.id}.json`);
        claim(rel, `motion spec ${item.id}`);
        const sourcePath = source.motionSpecPath(item.id);
        await assertRegularFile(sourcePath, `motion spec ${item.id}`, false);
        pinnedJson.push({
            id: item.id,
            value: inputs.motionSpecs[item.id],
            sourcePath,
            counter: 'motionSpecs',
            label: `motion spec ${item.id}`,
        });
    }
    return { sourceDir: source.dir, inputs, cloned, cacheArtifacts, sceneArtifacts, pinnedJson };
}
async function writeJsonExclusive(file, value, label) {
    let body;
    try {
        body = JSON.stringify(value, null, 2);
    }
    catch (error) {
        throw new Error(`fork: cannot serialize ${label} (${error?.message ?? String(error)})`);
    }
    if (body === undefined)
        throw new Error(`fork: cannot serialize ${label}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const handle = await fs.open(file, 'wx', 0o600);
    try {
        await handle.writeFile(body);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
/**
 * Give the fork an independent inode. COPYFILE_FICLONE asks APFS/btrfs/etc.
 * for a copy-on-write clone (near-hardlink disk efficiency without shared
 * mutations); Node transparently falls back to a regular byte copy when the
 * filesystem cannot clone.
 */
async function cloneOrCopyRegular(src, dest, label) {
    await assertRegularFile(src, label);
    const before = await fs.lstat(src);
    if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error(`fork: referenced ${label} changed into a non-regular file before copy: ${src}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    const after = await fs.lstat(src);
    if (!after.isFile() ||
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) {
        await fs.rm(dest, { force: true }).catch(() => { });
        throw new Error(`fork: ${label} changed while it was being copied; retry after cache generation finishes`);
    }
}
/**
 * Transcript/motion compatibility files normally CoW-clone/copy, but their
 * exact revision-pinned JSON is authoritative. If a concurrent atomic sidecar
 * replacement made the copied value newer/older than the captured revision,
 * replace the staged copy with the captured value before publication.
 */
async function materializePinnedJson(src, dest, value, label) {
    if (await assertRegularFile(src, label, false)) {
        await cloneOrCopyRegular(src, dest, label);
        try {
            const materialized = JSON.parse(await fs.readFile(dest, 'utf8'));
            if (isDeepStrictEqual(materialized, value))
                return;
        }
        catch {
            // Fall through and materialize the captured revision truth.
        }
        await fs.rm(dest, { force: true });
    }
    await writeJsonExclusive(dest, value, label);
}
async function syncDirectory(dir) {
    let handle;
    try {
        handle = await fs.open(dir, 'r');
        await handle.sync();
    }
    catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(errorCode(error) ?? ''))
            throw error;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function canonicalizeMissingPath(input) {
    let cursor = path.resolve(input);
    const suffix = [];
    while (true) {
        try {
            return path.join(await fs.realpath(cursor), ...suffix.reverse());
        }
        catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? ''))
                throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor)
                throw error;
            suffix.push(path.basename(cursor));
            cursor = parent;
        }
    }
}
async function prepareDestination(srcDir, destDir) {
    if (typeof destDir !== 'string' || destDir.trim().length === 0)
        throw new Error('fork: --to must not be empty');
    const requested = path.resolve(destDir);
    if (requested === path.parse(requested).root)
        throw new Error('fork: refusing to use a filesystem root as --to');
    if (await lstatIfPresent(requested)) {
        throw new Error(`fork: destination already exists (including empty directories and symlinks): ${requested}`);
    }
    const realSource = await fs.realpath(srcDir);
    const projectedDestination = await canonicalizeMissingPath(requested);
    if (projectedDestination === realSource) {
        throw new Error('fork: --to must be a different directory from the source project');
    }
    if (isWithin(realSource, projectedDestination) || isWithin(projectedDestination, realSource)) {
        throw new Error('fork: source and destination directories must not contain one another');
    }
    const parentRequested = path.dirname(requested);
    await fs.mkdir(parentRequested, { recursive: true });
    const parent = await fs.realpath(parentRequested);
    const parentStat = await fs.stat(parent);
    if (!parentStat.isDirectory())
        throw new Error(`fork: destination parent is not a directory: ${parentRequested}`);
    const basename = path.basename(requested);
    const canonical = path.join(parent, basename);
    if (await lstatIfPresent(requested)) {
        throw new Error(`fork: destination already exists (including empty directories and symlinks): ${requested}`);
    }
    if (canonical !== requested && await lstatIfPresent(canonical)) {
        throw new Error(`fork: canonical destination already exists: ${canonical}`);
    }
    if (canonical === realSource)
        throw new Error('fork: --to must be a different directory from the source project');
    if (isWithin(realSource, canonical) || isWithin(canonical, realSource)) {
        throw new Error('fork: source and destination directories must not contain one another');
    }
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return {
        requested,
        canonical,
        parent,
        basename,
        lockPath: path.join(parent, `.vedit-fork-${digest}.lock`),
    };
}
async function destinationStillAbsent(dest) {
    if (await lstatIfPresent(dest.requested) || (dest.canonical !== dest.requested && await lstatIfPresent(dest.canonical))) {
        throw new Error(`fork: destination appeared while the fork was being prepared: ${dest.requested}`);
    }
}
async function acquirePublishLock(lockPath) {
    const token = `${process.pid}-${randomUUID()}`;
    let handle;
    try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }));
        await handle.sync();
        return { token, handle };
    }
    catch (error) {
        await handle?.close().catch(() => { });
        if (handle)
            await fs.rm(lockPath, { force: true }).catch(() => { });
        if (errorCode(error) !== 'EEXIST')
            throw error;
        throw new Error(`fork: another fork is already publishing to this destination (${lockPath})`);
    }
}
async function releasePublishLock(lockPath, lock) {
    await lock.handle.close().catch(() => { });
    try {
        const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (current.token !== lock.token)
            return `fork publish lock ownership changed: ${lockPath}`;
        await fs.rm(lockPath, { force: true });
        return undefined;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return undefined;
        return `could not remove fork publish lock ${lockPath}: ${error?.message ?? String(error)}`;
    }
}
async function stageFork(plan, stageDir) {
    await fs.mkdir(stageDir, { recursive: false, mode: 0o700 });
    const staged = new Project(stageDir);
    await fs.mkdir(staged.cacheDir, { recursive: false });
    await fs.mkdir(staged.motionDir, { recursive: false });
    const linked = {
        proxies: 0,
        peaks: 0,
        sceneFiles: 0,
        sceneThumbs: 0,
        transcripts: 0,
        motionSpecs: 0,
    };
    for (const artifact of plan.cacheArtifacts) {
        // Re-resolve immediately before touching the source so a changed symlink
        // ancestor cannot reuse the earlier preflight decision.
        const src = await resolveCacheArtifact(plan.sourceDir, artifact.rel, artifact.label);
        const dest = await resolveCacheArtifact(stageDir, artifact.rel, artifact.label);
        await cloneOrCopyRegular(src.abs, dest.abs, artifact.label);
        linked[artifact.counter]++;
    }
    for (const scene of plan.sceneArtifacts) {
        await writeJsonExclusive(staged.scenesPath(scene.sourceId), scene.file, `scene index ${scene.sourceId}`);
        linked.sceneFiles++;
    }
    for (const artifact of plan.pinnedJson) {
        const dest = artifact.counter === 'transcripts'
            ? staged.transcriptPath(artifact.id)
            : staged.motionSpecPath(artifact.id);
        await resolveWithinDir(plan.sourceDir, path.relative(plan.sourceDir, artifact.sourcePath));
        await materializePinnedJson(artifact.sourcePath, dest, artifact.value, artifact.label);
        linked[artifact.counter]++;
    }
    // project.json is deliberately written last. Until every referenced
    // artifact is complete, even the hidden staging directory is not an
    // openable/discoverable vedit project.
    await writeJsonExclusive(staged.manifestPath, plan.cloned, 'fork manifest');
    const verified = await Project.open(stageDir);
    const stagedManifest = await verified.manifest();
    if (!isDeepStrictEqual(stagedManifest, plan.cloned)) {
        throw new Error('fork: staged manifest verification failed');
    }
    await Promise.all([syncDirectory(staged.cacheDir), syncDirectory(staged.motionDir)]);
    await syncDirectory(stageDir);
    return linked;
}
async function publishedManifestMatches(dest, expected) {
    try {
        const stat = await fs.lstat(dest);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return false;
        const parsed = JSON.parse(await fs.readFile(path.join(dest, 'project.json'), 'utf8'));
        return isDeepStrictEqual(parsed, expected);
    }
    catch {
        return false;
    }
}
export async function forkProject(srcDir, destDir, opts = {}) {
    const absSrc = path.resolve(srcDir);
    const absDest = path.resolve(destDir);
    if (absDest === path.parse(absDest).root)
        throw new Error('fork: refusing to use a filesystem root as --to');
    if (absSrc === absDest)
        throw new Error('fork: --to must be a different directory from the source project');
    const sourceManifestStat = await lstatIfPresent(path.join(absSrc, 'project.json'));
    if (!sourceManifestStat?.isFile() || sourceManifestStat.isSymbolicLink()) {
        throw new Error(`fork: source project.json must be a regular non-symlink file: ${absSrc}`);
    }
    const source = await Project.open(absSrc);
    const plan = await buildForkPlan(source, opts.name);
    const destination = await prepareDestination(absSrc, absDest);
    const publishLock = await acquirePublishLock(destination.lockPath);
    const stageDir = path.join(destination.parent, `.${destination.basename}.vedit-fork-stage-${process.pid}-${randomUUID()}`);
    let published = false;
    let linked;
    let warning;
    try {
        await destinationStillAbsent(destination);
        linked = await stageFork(plan, stageDir);
        await destinationStillAbsent(destination);
        try {
            await fs.rename(stageDir, destination.canonical);
            published = true;
        }
        catch (error) {
            // Some filesystems can report an error after completing rename. Only
            // convert that ambiguous result to success if the complete staged
            // manifest is now present at the final path.
            if (await publishedManifestMatches(destination.canonical, plan.cloned)) {
                published = true;
            }
            else {
                throw error;
            }
        }
        try {
            await syncDirectory(destination.parent);
        }
        catch (error) {
            warning = `fork published, but its parent directory could not be fsynced: ${error?.message ?? String(error)}`;
        }
        // Publication is already complete and atomic. A registry problem must
        // not turn that success into a reported failure or trigger deletion of a
        // valid fork; surface it as an actionable warning instead.
        try {
            await upsertProject(destination.requested, plan.cloned.name);
        }
        catch (error) {
            const registryWarning = `fork completed, but the project registry could not be updated: ${error?.message ?? String(error)}`;
            warning = warning ? `${warning}; ${registryWarning}` : registryWarning;
        }
    }
    finally {
        if (!published) {
            const stageStat = await lstatIfPresent(stageDir).catch(() => undefined);
            if (stageStat?.isDirectory() && !stageStat.isSymbolicLink()) {
                await fs.rm(stageDir, { recursive: true, force: true }).catch(() => { });
            }
        }
        const lockWarning = await releasePublishLock(destination.lockPath, publishLock);
        if (lockWarning)
            warning = warning ? `${warning}; ${lockWarning}` : lockWarning;
    }
    return {
        dir: destination.requested,
        name: plan.cloned.name,
        sourceDir: absSrc,
        sourceRevision: plan.inputs.manifest.revision,
        linked: linked,
        ...(warning ? { warning } : {}),
    };
}
