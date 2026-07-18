import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withRegistryFileLock } from './registryLock.js';
import { resolveRegistryPath } from './statePaths.js';
function backupPath(registryFile) {
    return `${registryFile}.backup`;
}
export class ProjectRegistryCorruptError extends Error {
    registryPath;
    quarantinePath;
    backupPath;
    constructor(registryFile, quarantineFile, backupFile, detail) {
        super(`project registry is malformed at ${registryFile}; original bytes were preserved at ` +
            `${quarantineFile}. ${detail} Restore valid JSON from ${backupFile} or remove the malformed ` +
            'registry only after confirming the quarantined copy is no longer needed.');
        this.name = 'ProjectRegistryCorruptError';
        this.registryPath = registryFile;
        this.quarantinePath = quarantineFile;
        this.backupPath = backupFile;
    }
}
function isRegistryEntry(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.dir === 'string' &&
        value.dir.length > 0 &&
        typeof value.name === 'string' &&
        typeof value.lastOpened === 'string');
}
function parseRegistry(raw, source) {
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    }
    catch (error) {
        throw new Error(`${source} is not valid JSON: ${error?.message ?? error}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(isRegistryEntry)) {
        throw new Error(`${source} must be an array of project registry entries`);
    }
    return parsed;
}
async function readFileIfPresent(file) {
    try {
        return await fs.readFile(file);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function syncDirectory(dir) {
    let handle = null;
    try {
        handle = await fs.open(dir, 'r');
        await handle.sync();
    }
    catch (error) {
        // Some platforms/filesystems do not permit opening or fsyncing a
        // directory. File fsync + same-directory rename still provides atomic
        // visibility there; durability is best-effort on those platforms.
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code))
            throw error;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function atomicReplace(file, bytes) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
    let handle = null;
    try {
        handle = await fs.open(tmp, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(tmp, file);
        await syncDirectory(dir);
    }
    finally {
        await handle?.close().catch(() => { });
        await fs.rm(tmp, { force: true }).catch(() => { });
    }
}
async function writeQuarantineCopy(sourceFile, raw) {
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 20);
    let quarantineFile = `${sourceFile}.corrupt-${digest}`;
    for (let attempt = 0; attempt < 2; attempt++) {
        let handle = null;
        try {
            handle = await fs.open(quarantineFile, 'wx', 0o600);
            await handle.writeFile(raw);
            await handle.sync();
            await handle.close();
            handle = null;
            await syncDirectory(path.dirname(sourceFile));
            return quarantineFile;
        }
        catch (error) {
            await handle?.close().catch(() => { });
            if (error?.code !== 'EEXIST') {
                await fs.rm(quarantineFile, { force: true }).catch(() => { });
                throw error;
            }
            const existing = await readFileIfPresent(quarantineFile);
            if (existing?.equals(raw))
                return quarantineFile;
            quarantineFile = `${sourceFile}.corrupt-${digest}-${randomUUID()}`;
        }
    }
    throw new Error(`could not preserve malformed project registry bytes from ${sourceFile}`);
}
async function corruptRegistryError(registryFile, corruptFile, raw, detail) {
    const quarantineFile = await writeQuarantineCopy(corruptFile, raw);
    return new ProjectRegistryCorruptError(registryFile, quarantineFile, backupPath(registryFile), detail);
}
/** Read, validate, and if necessary recover the registry while holding its lock. */
async function readRegistryLocked(registryFile) {
    const backupFile = backupPath(registryFile);
    const mainRaw = await readFileIfPresent(registryFile);
    if (mainRaw === null) {
        const backupRaw = await readFileIfPresent(backupFile);
        if (backupRaw === null)
            return [];
        let recovered;
        try {
            recovered = parseRegistry(backupRaw, backupFile);
        }
        catch (error) {
            throw await corruptRegistryError(registryFile, backupFile, backupRaw, `The primary registry is missing and its backup is unusable: ${error?.message ?? error}.`);
        }
        await atomicReplace(registryFile, backupRaw);
        return recovered;
    }
    try {
        return parseRegistry(mainRaw, registryFile);
    }
    catch (mainError) {
        const quarantineFile = await writeQuarantineCopy(registryFile, mainRaw);
        const backupRaw = await readFileIfPresent(backupFile);
        if (backupRaw !== null) {
            try {
                const recovered = parseRegistry(backupRaw, backupFile);
                await atomicReplace(registryFile, backupRaw);
                return recovered;
            }
            catch (backupError) {
                throw new ProjectRegistryCorruptError(registryFile, quarantineFile, backupFile, `Its backup is also unusable: ${backupError?.message ?? backupError}.`);
            }
        }
        throw new ProjectRegistryCorruptError(registryFile, quarantineFile, backupFile, `No valid backup exists (${mainError?.message ?? mainError}).`);
    }
}
/**
 * Durably replace the registry. The previous valid primary is first saved as
 * a complete backup, so a crash between the two renames leaves at least one
 * validated generation that readRegistryLocked can recover.
 */
async function writeRegistryLocked(registryFile, entries) {
    const nextRaw = Buffer.from(`${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    const currentRaw = await readFileIfPresent(registryFile);
    if (currentRaw !== null) {
        try {
            parseRegistry(currentRaw, registryFile);
        }
        catch (error) {
            throw await corruptRegistryError(registryFile, registryFile, currentRaw, `It changed before the pending update and was not overwritten: ${error?.message ?? error}.`);
        }
        await atomicReplace(backupPath(registryFile), currentRaw);
    }
    else {
        // The first generation doubles as its own recovery point. If the process
        // dies after this rename but before the primary rename, the next read
        // restores the primary from this backup.
        await atomicReplace(backupPath(registryFile), nextRaw);
    }
    await atomicReplace(registryFile, nextRaw);
}
/** Record or refresh a project's entry; most-recently-opened first. */
export async function upsertProject(dir, name) {
    const p = resolveRegistryPath();
    await withRegistryFileLock(p, async () => {
        const entries = await readRegistryLocked(p);
        const next = entries.filter((e) => e.dir !== dir);
        next.unshift({ dir, name, lastOpened: new Date().toISOString() });
        await writeRegistryLocked(p, next);
    });
}
/**
 * List known projects, self-healing the registry as it goes: any entry
 * whose `dir` no longer has a project.json (deleted project, stale test
 * scratch dir, etc.) is dropped and the pruned list is written back. Every
 * caller of listProjects (currently just `vedit projects`) goes through
 * this same path, so the registry can never accumulate dead entries for
 * long — it prunes itself on the next read.
 *
 * fs.stat calls run in parallel (Promise.all) rather than sequentially, so
 * pruning stays fast even with a few hundred entries.
 */
export async function listProjects() {
    const p = resolveRegistryPath();
    return withRegistryFileLock(p, async () => {
        const entries = await readRegistryLocked(p);
        const checks = await Promise.all(entries.map(async (e) => {
            try {
                await fs.stat(path.join(e.dir, 'project.json'));
                return e;
            }
            catch {
                return null; // project directory gone; drop it from the registry
            }
        }));
        const alive = checks.filter((e) => e !== null);
        if (alive.length !== entries.length)
            await writeRegistryLocked(p, alive);
        return alive;
    });
}
