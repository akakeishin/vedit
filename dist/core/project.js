import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { upsertProject } from './registry.js';
const DEFAULT_PROJECT_LOCK_OPTIONS = {
    timeoutMs: 30_000,
    retryMs: 20,
    staleCreationMs: 30_000,
};
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
/** Raised when another live process keeps the project persistence lock. */
export class ProjectLockTimeoutError extends Error {
    lockPath;
    timeoutMs;
    owner;
    code = 'PROJECT_LOCK_TIMEOUT';
    constructor(lockPath, timeoutMs, owner) {
        const heldBy = owner
            ? ` (held by pid ${owner.pid} since ${owner.acquiredAt})`
            : '';
        super(`timed out after ${timeoutMs}ms waiting for project lock ${lockPath}${heldBy}`);
        this.lockPath = lockPath;
        this.timeoutMs = timeoutMs;
        this.owner = owner;
        this.name = 'ProjectLockTimeoutError';
    }
}
function normalizeLockOptions(options = {}) {
    const numberOr = (value, fallback, minimum) => (Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback);
    return {
        timeoutMs: numberOr(options.timeoutMs, DEFAULT_PROJECT_LOCK_OPTIONS.timeoutMs, 0),
        retryMs: numberOr(options.retryMs, DEFAULT_PROJECT_LOCK_OPTIONS.retryMs, 1),
        staleCreationMs: numberOr(options.staleCreationMs, DEFAULT_PROJECT_LOCK_OPTIONS.staleCreationMs, 1),
    };
}
function looksLikeLockOwner(value) {
    const owner = value;
    return Boolean(owner &&
        Number.isInteger(owner.pid) &&
        Number(owner.pid) > 0 &&
        typeof owner.token === 'string' &&
        owner.token.length > 0 &&
        typeof owner.acquiredAt === 'string' &&
        Number.isFinite(owner.processStartedAt));
}
async function observeProjectLock(lockPath) {
    let stat;
    try {
        stat = await fs.stat(lockPath);
    }
    catch (error) {
        if (isMissingFile(error))
            return undefined;
        throw error;
    }
    try {
        const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        return { owner: looksLikeLockOwner(parsed) ? parsed : undefined, stat };
    }
    catch (error) {
        if (isMissingFile(error))
            return undefined;
        return { stat };
    }
}
function processOwnsLiveLock(owner) {
    // The process-start stamp distinguishes an abandoned file left by an old
    // incarnation that happened to use this process's now-reused pid.
    if (owner.pid === process.pid)
        return owner.processStartedAt === PROCESS_STARTED_AT;
    try {
        process.kill(owner.pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
function sameLockObservation(a, b) {
    if (a.owner || b.owner) {
        return Boolean(a.owner && b.owner && a.owner.token === b.owner.token);
    }
    return (a.stat.dev === b.stat.dev &&
        a.stat.ino === b.stat.ino &&
        a.stat.size === b.stat.size &&
        a.stat.mtimeMs === b.stat.mtimeMs);
}
/**
 * Reclaim a lock whose owning process is gone. A token-specific reaper guard
 * prevents two waiters that observed the same dead owner from deleting a
 * replacement lock. The identity is checked again after taking that guard.
 */
async function reclaimAbandonedProjectLock(lockPath, observed, staleCreationMs) {
    if (observed.owner) {
        if (processOwnsLiveLock(observed.owner))
            return false;
    }
    else if (Date.now() - observed.stat.mtimeMs < staleCreationMs) {
        // The creator may still be between open('wx') and writing its metadata.
        return false;
    }
    const identity = observed.owner?.token ?? [
        observed.stat.dev,
        observed.stat.ino,
        observed.stat.size,
        Math.floor(observed.stat.mtimeMs),
    ].join('-');
    const guardPath = `${lockPath}.reap-${identity.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    let guard;
    try {
        guard = await fs.open(guardPath, 'wx');
    }
    catch (error) {
        if (error.code === 'EEXIST')
            return false;
        throw error;
    }
    try {
        const current = await observeProjectLock(lockPath);
        if (!current || !sameLockObservation(observed, current))
            return !current;
        if (current.owner && processOwnsLiveLock(current.owner))
            return false;
        if (!current.owner && Date.now() - current.stat.mtimeMs < staleCreationMs)
            return false;
        await fs.rm(lockPath, { force: true });
        return true;
    }
    finally {
        await guard.close().catch(() => { });
        await fs.rm(guardPath, { force: true }).catch(() => { });
    }
}
async function acquireProjectLock(lockPath, options, signal) {
    const throwIfAborted = () => {
        if (!signal?.aborted)
            return;
        const error = new Error('operation cancelled');
        error.name = 'AbortError';
        throw error;
    };
    const startedAt = performance.now();
    let lastObservation;
    while (true) {
        throwIfAborted();
        const owner = {
            pid: process.pid,
            token: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            acquiredAt: new Date().toISOString(),
            processStartedAt: PROCESS_STARTED_AT,
        };
        let handle;
        try {
            handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(JSON.stringify(owner));
            await handle.close();
            return owner;
        }
        catch (error) {
            await handle?.close().catch(() => { });
            if (error.code !== 'EEXIST') {
                // If creation succeeded but metadata publication failed, do not leave
                // an owner-less lock that blocks every future project open.
                if (handle)
                    await fs.rm(lockPath, { force: true }).catch(() => { });
                throw error;
            }
        }
        lastObservation = await observeProjectLock(lockPath);
        if (!lastObservation)
            continue;
        if (await reclaimAbandonedProjectLock(lockPath, lastObservation, options.staleCreationMs))
            continue;
        const elapsed = performance.now() - startedAt;
        if (elapsed >= options.timeoutMs) {
            throw new ProjectLockTimeoutError(lockPath, options.timeoutMs, lastObservation.owner
                ? { pid: lastObservation.owner.pid, acquiredAt: lastObservation.owner.acquiredAt }
                : undefined);
        }
        try {
            await delay(Math.min(options.retryMs, Math.max(1, options.timeoutMs - elapsed)), undefined, { signal });
        }
        catch (error) {
            if (signal?.aborted)
                throwIfAborted();
            throw error;
        }
    }
}
async function releaseProjectLock(lockPath, owner) {
    const current = await observeProjectLock(lockPath);
    if (!current)
        return;
    if (current.owner?.token !== owner.token) {
        const error = new Error(`project lock ownership changed before release: ${lockPath}`);
        error.code = 'PROJECT_LOCK_LOST';
        throw error;
    }
    await fs.rm(lockPath, { force: true });
}
/**
 * Ids used to build filenames (sourceId, motion spec id) must never carry a
 * path separator or ".." segment — the daemon treats a manifest and its
 * requests as untrusted even though it only binds to localhost, since a
 * corrupted/tampered project.json or a crafted request param must not be
 * able to read or write outside the project directory.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function assertSafeId(id, kind) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
        throw new Error(`invalid ${kind} id: ${JSON.stringify(id)}`);
    }
}
/**
 * Resolve a path as far as the filesystem currently permits. If the final
 * path does not exist, canonicalize its nearest existing ancestor and append
 * the missing suffix. This is the important difference from calling
 * `realpath()` only on the final target: `cache/link/new.mp4` must still
 * notice that the existing `cache/link` ancestor is a symlink even though
 * `new.mp4` has not been created yet.
 */
async function canonicalizeThroughExistingAncestor(input) {
    let cursor = path.resolve(input);
    const missing = [];
    while (true) {
        try {
            const existing = await fs.realpath(cursor);
            return path.join(existing, ...missing.reverse());
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR')
                throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor)
                throw error;
            missing.push(path.basename(cursor));
            cursor = parent;
        }
    }
}
/**
 * Resolve `rel` under `dir` and reject anything that would land outside it:
 * a string-level check via path.resolve catches lexical traversal, then a
 * nearest-existing-ancestor canonicalization catches symlink escapes for
 * both existing targets and not-yet-created managed write paths. Used for
 * manifest-supplied relative paths (proxy/peaks/thumb), which are on-disk
 * data rather than trusted input.
 */
export async function resolveWithinDir(dir, rel) {
    const base = path.resolve(dir);
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) {
        throw new Error(`path escapes directory: ${rel}`);
    }
    const [realBase, realFull] = await Promise.all([
        canonicalizeThroughExistingAncestor(base),
        canonicalizeThroughExistingAncestor(full),
    ]);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) {
        throw new Error(`path escapes directory (symlink): ${rel}`);
    }
    return full;
}
/** Reconstruct the undo/redo stacks by replaying `entries` (any order; sorted by rev internally) — see the design note above. Exported mainly for direct unit testing; callers wanting a target should use resolveUndoTarget/resolveRedoTarget. */
export function resolveUndoRedoStacks(entries) {
    const undoStack = [];
    const redoStack = [];
    const sorted = [...entries].sort((a, b) => a.rev - b.rev);
    for (const e of sorted) {
        const cause = e.op === 'restore' ? e.params?.cause : undefined;
        if (cause === 'undo') {
            undoStack.pop();
            redoStack.push(e.baseRev);
        }
        else if (cause === 'redo') {
            redoStack.pop();
            undoStack.push(e.baseRev);
        }
        else {
            // Ordinary edit, or a 'restore' with cause 'manual'/absent — both
            // extend the linear undo history and invalidate any pending redo.
            undoStack.push(e.baseRev);
            redoStack.length = 0;
        }
    }
    return { undoStack, redoStack };
}
/** Resolve what `Project.undo()` should restore to, or throw a clear "nothing to undo" error. */
export function resolveUndoTarget(entries) {
    const { undoStack } = resolveUndoRedoStacks(entries);
    const target = undoStack.at(-1);
    if (target === undefined || target === 0) {
        throw new Error('nothing to undo');
    }
    return target;
}
/** Resolve what `Project.redo()` should restore to, or throw a clear "nothing to redo" error. */
export function resolveRedoTarget(entries) {
    const { redoStack } = resolveUndoRedoStacks(entries);
    const target = redoStack.at(-1);
    if (target === undefined) {
        throw new Error('nothing to redo (undo something first — a normal edit or manual restore since the last undo discards it)');
    }
    return target;
}
/**
 * Reconstruct candidate decisions for a historical revision. Candidate
 * proposals live outside the manifest, but approve/reject operations are in
 * the revision log. Replaying those operations (and following restore
 * targets recursively) lets undo/redo keep the queue aligned with the
 * restored timeline without pretending candidates.json is a second source
 * of history truth. Only ids ever mentioned by a logged decision are
 * returned; legacy unlogged rejections are deliberately left untouched.
 */
export function resolveCandidateDecisionStatuses(entries, targetRev) {
    const byRev = new Map(entries.map((e) => [e.rev, e]));
    const allLoggedIds = new Set();
    for (const e of entries) {
        if (e.op !== 'apply-candidates' && e.op !== 'reject-candidates')
            continue;
        const ids = e.params?.ids;
        if (Array.isArray(ids))
            for (const id of ids)
                if (typeof id === 'string')
                    allLoggedIds.add(id);
    }
    const memo = new Map();
    const visiting = new Set();
    const stateAt = (rev) => {
        if (rev <= 0)
            return new Map();
        const cached = memo.get(rev);
        if (cached)
            return new Map(cached);
        if (visiting.has(rev))
            throw new Error(`candidate decision history contains a restore cycle at revision ${rev}`);
        visiting.add(rev);
        const entry = byRev.get(rev);
        if (!entry) {
            visiting.delete(rev);
            return new Map();
        }
        let state;
        if (entry.op === 'restore') {
            const restoreRev = Number(entry.params?.rev);
            state = Number.isFinite(restoreRev) ? stateAt(restoreRev) : stateAt(entry.baseRev);
        }
        else {
            state = stateAt(entry.baseRev);
            if (entry.op === 'apply-candidates' || entry.op === 'reject-candidates') {
                const ids = entry.params?.ids;
                if (Array.isArray(ids)) {
                    const status = entry.op === 'apply-candidates' ? 'approved' : 'rejected';
                    for (const id of ids)
                        if (typeof id === 'string')
                            state.set(id, status);
                }
            }
        }
        visiting.delete(rev);
        memo.set(rev, new Map(state));
        return state;
    };
    const result = stateAt(targetRev);
    for (const id of allLoggedIds)
        if (!result.has(id))
            result.set(id, 'proposed');
    return result;
}
/** Resolve the effective transcript values at a revision through edits and restores. */
export function resolveTranscriptState(entries, targetRev) {
    const byRev = new Map(entries.map((entry) => [entry.rev, entry]));
    const memo = new Map();
    const visiting = new Set();
    const stateAt = (rev) => {
        if (rev <= 0)
            return new Map();
        const cached = memo.get(rev);
        if (cached)
            return new Map(cached);
        if (visiting.has(rev))
            throw new Error(`transcript history contains a restore cycle at revision ${rev}`);
        visiting.add(rev);
        const entry = byRev.get(rev);
        if (!entry) {
            visiting.delete(rev);
            return new Map();
        }
        const restoreRev = entry.op === 'restore'
            ? Number(entry.params?.rev)
            : NaN;
        const state = Number.isFinite(restoreRev) ? stateAt(restoreRev) : stateAt(entry.baseRev);
        for (const [sourceId, transcript] of Object.entries(entry.transcriptUpdates ?? {})) {
            state.set(sourceId, transcript);
        }
        visiting.delete(rev);
        memo.set(rev, new Map(state));
        return state;
    };
    return stateAt(targetRev);
}
function applyCandidateDecisionStatuses(candidates, entries, targetRev) {
    const statuses = resolveCandidateDecisionStatuses(entries, targetRev);
    let changed = false;
    for (const candidate of candidates) {
        const status = statuses.get(candidate.id);
        if (status && candidate.status !== status) {
            candidate.status = status;
            changed = true;
        }
    }
    return changed;
}
function sameCandidateRange(a, b, requireKind = false) {
    return ((!requireKind || a.kind === b.kind) &&
        a.sourceId === b.sourceId &&
        Math.abs(a.t0 - b.t0) < 0.05 &&
        Math.abs(a.t1 - b.t1) < 0.05);
}
function candidateBelongsToManifest(candidate, manifest) {
    return manifest.sources.some((source) => source.id === candidate.sourceId);
}
function isMissingFile(error) {
    return error?.code === 'ENOENT';
}
/**
 * Project store on disk. One directory per project:
 *   project.json / revisions.jsonl / transcript-<sourceId>.json /
 *   candidates.json / scenes-<sourceId>.json / motion/ / cache/
 */
export class Project {
    dir;
    lockOptions;
    constructor(dir, lockOptions = {}) {
        this.dir = dir;
        this.lockOptions = normalizeLockOptions(lockOptions);
    }
    /**
     * Set when open-time reconciliation repaired on-disk state, or when a
     * committed revision could not refresh one of its compatibility sidecars.
     * Callers (the daemon) surface this through project state. A post-commit
     * sidecar warning is deliberately not thrown: the revision already landed
     * and reporting the mutation as rejected would be a false rollback.
     */
    warning;
    addWarning(message) {
        this.warning = this.warning ? `${this.warning}; ${message}` : message;
    }
    /**
     * The promise chain preserves call order within one Project instance. Each
     * queued operation also takes `.vedit-project.lock`, so a second daemon,
     * CLI process, or independently-opened Project cannot interleave a
     * read/check/write sequence with this instance. This is especially
     * important for commit's log-append -> manifest-rename crash window:
     * open/reconcile must not mistake a live append for an orphan revision.
     */
    _lock = Promise.resolve();
    /**
     * Queue `fn` behind whatever is currently running. Queued in call order:
     * `fn` for a call made after another only starts once the earlier one has
     * settled (success or failure), so e.g. two commits fired back-to-back
     * (`Promise.all([p.commit(...), p.commit(...)])`) land as consecutive
     * revisions instead of racing on read-check-write.
     */
    withLock(fn) {
        const runWithProjectLock = async () => {
            const owner = await acquireProjectLock(this.lockPath, this.lockOptions);
            try {
                return await fn();
            }
            finally {
                await releaseProjectLock(this.lockPath, owner);
            }
        };
        const run = this._lock.then(runWithProjectLock, runWithProjectLock);
        this._lock = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * Serialize a small project-adjacent persistence transaction with manifest
     * commits in this process and every other vedit process.  This is used by
     * durable job/lease stores that must make a read-check-write decision
     * atomically with respect to another daemon.
     *
     * The callback must operate on files directly and must not call another
     * lock-taking Project method (commit/captureRenderInputs/etc.).
     */
    withPersistenceLock(fn) {
        return this.withLock(fn);
    }
    /**
     * Serialize expensive derived work for one safe scope across processes
     * without holding the main persistence lock for its duration. Scene
     * detection uses a per-source scope: notes/edits remain responsive, while
     * two daemons cannot concurrently overwrite the same thumbnail names.
     */
    async withWorkLock(scope, fn, signal) {
        assertSafeId(scope, 'work-lock');
        const lockPath = path.join(this.dir, `.vedit-work-${scope}.lock`);
        const owner = await acquireProjectLock(lockPath, {
            ...this.lockOptions,
            timeoutMs: Math.max(this.lockOptions.timeoutMs, 30 * 60_000),
        }, signal);
        try {
            return await fn();
        }
        finally {
            await releaseProjectLock(lockPath, owner);
        }
    }
    get manifestPath() {
        return path.join(this.dir, 'project.json');
    }
    get revisionsPath() {
        return path.join(this.dir, 'revisions.jsonl');
    }
    get lockPath() {
        return path.join(this.dir, '.vedit-project.lock');
    }
    get cacheDir() {
        return path.join(this.dir, 'cache');
    }
    get motionDir() {
        return path.join(this.dir, 'motion');
    }
    /** Path of a motion spec file, rejecting an id that isn't a bare safe token. */
    motionSpecPath(id) {
        assertSafeId(id, 'motion');
        return path.join(this.motionDir, `${id}.json`);
    }
    static async create(dir, name, lockOptions = {}) {
        const p = new Project(dir, lockOptions);
        await fs.mkdir(dir, { recursive: true });
        const manifest = {
            version: 1,
            name,
            revision: 0,
            fps: 30,
            width: 1920,
            height: 1080,
            sources: [],
            timeline: { video: [], motion: [] },
            captions: { enabled: true, style: 'clean', maxChars: 24 },
        };
        await p.withLock(async () => {
            // Creating at an existing project path is never an idempotent no-op:
            // rewriting project.json would silently reset its revision, sources,
            // and timeline while leaving sidecars behind. Refuse before touching
            // either durable project file. This also protects a crash-recovery
            // directory that has a log but temporarily lacks its manifest.
            const durableFiles = [p.manifestPath, p.revisionsPath];
            for (const file of durableFiles) {
                try {
                    await fs.access(file);
                    throw new Error(`project already exists or needs recovery: ${dir}`);
                }
                catch (error) {
                    if (!isMissingFile(error))
                        throw error;
                }
            }
            await fs.mkdir(p.cacheDir, { recursive: true });
            await fs.mkdir(p.motionDir, { recursive: true });
            await p.writeManifest(manifest);
        });
        try {
            await upsertProject(dir, name);
        }
        catch (error) {
            // The project directory is the source of truth; the cross-project
            // registry is only a convenience index. Once the durable manifest has
            // landed, reporting creation as failed would invite a destructive
            // retry against an already-valid project. Keep it usable and surface
            // the indexing failure through normal project state instead.
            p.addWarning(`project created, but project-list registration failed: ${error?.message ?? String(error)}`);
        }
        return p;
    }
    static async open(dir, lockOptions = {}) {
        const p = new Project(dir, lockOptions);
        await fs.access(p.manifestPath);
        await p.withLock(() => p.reconcileLocked());
        return p;
    }
    async manifest() {
        return JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
    }
    /**
     * Capture every mutable render sidecar under the same project lock as the
     * revision check. The returned objects are detached JSON values, so a
     * transcript or motion edit that lands after this method returns cannot
     * leak newer content into an already-started export.
     */
    async captureRenderInputs(baseRev) {
        return this.withLock(async () => {
            const manifest = await this.manifest();
            if (manifest.revision !== baseRev) {
                const err = new Error(`stale base revision ${baseRev}; current is ${manifest.revision}. Re-read state before exporting.`);
                err.code = 'STALE_REVISION';
                throw err;
            }
            let entries = [];
            try {
                entries = this.parseRevisionLines(await fs.readFile(this.revisionsPath, 'utf8')).entries;
            }
            catch (error) {
                if (!isMissingFile(error))
                    throw error;
            }
            const transcriptState = resolveTranscriptState(entries, manifest.revision);
            const transcripts = [];
            for (const source of manifest.sources) {
                if (!source.transcribed)
                    continue;
                const recorded = transcriptState.get(source.id);
                if (recorded) {
                    transcripts.push(recorded);
                    continue;
                }
                try {
                    transcripts.push(JSON.parse(await fs.readFile(this.transcriptPath(source.id), 'utf8')));
                }
                catch (error) {
                    throw new Error(`cannot export revision ${baseRev}: transcript for source ${source.id} is missing or corrupt (${error?.message ?? String(error)})`);
                }
            }
            const exact = entries.find((entry) => entry.rev === manifest.revision)?.motionSpecs;
            const motionSpecs = {};
            for (const item of manifest.timeline.motion) {
                if (exact && Object.prototype.hasOwnProperty.call(exact, item.id)) {
                    motionSpecs[item.id] = exact[item.id];
                    continue;
                }
                try {
                    motionSpecs[item.id] = JSON.parse(await fs.readFile(this.motionSpecPath(item.id), 'utf8'));
                }
                catch (error) {
                    throw new Error(`cannot export revision ${baseRev}: motion spec ${item.id} is missing or corrupt (${error?.message ?? String(error)})`);
                }
            }
            return { manifest, transcripts, motionSpecs };
        });
    }
    async writeManifest(m) {
        const tmp = this.manifestPath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(m, null, 2));
        await fs.rename(tmp, this.manifestPath);
    }
    serializeJsonSidecar(value, label) {
        let serialized;
        try {
            serialized = JSON.stringify(value, null, 2);
        }
        catch (error) {
            throw new Error(`cannot serialize ${label} before commit: ${error?.message ?? String(error)}`);
        }
        if (serialized === undefined) {
            throw new Error(`cannot serialize ${label} before commit: value is not JSON`);
        }
        return serialized;
    }
    /**
     * Write a JSON sidecar to a revision/token-specific file in the target's
     * own directory. Publication is a same-directory rename, so observers see
     * either the complete old file or the complete new file, never a partial
     * write. The caller owns cleanup of `stagedPath`.
     */
    async stageJsonSidecarLocked(targetPath, value, label, token, index) {
        const serialized = this.serializeJsonSidecar(value, label);
        const stagedPath = `${targetPath}.tmp-sidecar-${token}-${index}`;
        await fs.writeFile(stagedPath, serialized);
        return { label, targetPath, stagedPath, value };
    }
    async jsonSidecarMatches(targetPath, expected) {
        try {
            const current = JSON.parse(await fs.readFile(targetPath, 'utf8'));
            return isDeepStrictEqual(current, expected);
        }
        catch {
            return false;
        }
    }
    /** Atomic single-sidecar replacement used by non-commit writes and repair. */
    async replaceJsonSidecarLocked(targetPath, value, label) {
        const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        let staged;
        try {
            staged = await this.stageJsonSidecarLocked(targetPath, value, label, token, 0);
            await fs.rename(staged.stagedPath, staged.targetPath);
        }
        finally {
            if (staged)
                await fs.rm(staged.stagedPath, { force: true }).catch(() => { });
        }
    }
    /**
     * The single write path. Rejects stale bases (optimistic concurrency).
     * `mutate` must be pure; on success the revision log gets an entry with a
     * full snapshot, enabling cheap undo. Serialized via `withLock` so two
     * concurrent commits can't both read the same `cur.revision` and both
     * land as the same next revision number.
     *
     * `motionSpecUpdates`, if given, is a map of motion-item id -> new spec
     * content that this op wants written to motion/<id>.json. Sidecars are
     * serialized and staged before the durable commit boundary, then exposed
     * by atomic rename only after project.json reflects the new revision. A
     * rejected/staging-failed commit therefore never mutates a live sidecar.
     */
    async commit(baseRev, actor, op, params, summary, mutate, motionSpecUpdates, transcriptUpdates) {
        return this.withLock(() => this.commitLocked(baseRev, actor, op, params, summary, mutate, motionSpecUpdates, transcriptUpdates));
    }
    /** Body of `commit()`; must only ever run inside `withLock`. */
    async commitLocked(baseRev, actor, op, params, summary, mutate, motionSpecUpdates, transcriptUpdates) {
        const cur = await this.manifest();
        if (baseRev !== cur.revision) {
            const err = new Error(`stale base revision ${baseRev}; current is ${cur.revision}. Re-read state before editing.`);
            err.code = 'STALE_REVISION';
            throw err;
        }
        const next = { ...(await mutate(cur)), revision: cur.revision + 1 };
        // The current revision entry, not a mutable compatibility file, is the
        // first choice for unchanged motion state. This matters after a prior
        // post-commit publication warning: a subsequent unrelated edit must carry
        // the committed motion value forward instead of snapshotting a stale
        // motion/<id>.json and turning the compatibility lag into history truth.
        let currentMotionSpecs;
        try {
            const entries = this.parseRevisionLines(await fs.readFile(this.revisionsPath, 'utf8')).entries;
            currentMotionSpecs = entries.find((entry) => entry.rev === cur.revision)?.motionSpecs;
        }
        catch (error) {
            if (!isMissingFile(error))
                throw error;
        }
        // Snapshot every motion sidecar referenced by the new manifest, so a
        // future restore() can roll motion/*.json back in lockstep with the
        // manifest instead of leaving stale spec content behind. Ids pending a
        // write via `motionSpecUpdates` haven't hit disk yet — use the pending
        // content for those instead of re-reading the (still old) file.
        const motionSpecs = {};
        for (const item of next.timeline.motion) {
            if (motionSpecUpdates && Object.prototype.hasOwnProperty.call(motionSpecUpdates, item.id)) {
                motionSpecs[item.id] = motionSpecUpdates[item.id];
                continue;
            }
            if (currentMotionSpecs && Object.prototype.hasOwnProperty.call(currentMotionSpecs, item.id)) {
                motionSpecs[item.id] = currentMotionSpecs[item.id];
                continue;
            }
            try {
                motionSpecs[item.id] = JSON.parse(await fs.readFile(this.motionSpecPath(item.id), 'utf8'));
            }
            catch {
                // Spec file missing/unreadable — omit rather than fail the whole
                // commit over a motion sidecar unrelated to this op.
            }
        }
        const entry = {
            rev: next.revision,
            baseRev,
            actor,
            op,
            params,
            ts: new Date().toISOString(),
            summary,
            snapshot: next,
            motionSpecs,
            ...(transcriptUpdates ? { transcriptUpdates } : {}),
        };
        // Validate and fully stage every requested sidecar before the durable
        // revision files are touched. A serialization/disk error here is a true
        // rollback: project.json, revisions.jsonl, and every live sidecar still
        // describe the old revision. Map keys are also validated before becoming
        // filenames or revision-history identifiers.
        const sidecarToken = `${process.pid}-${next.revision}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const sidecarRequests = [];
        if (motionSpecUpdates) {
            for (const [id, content] of Object.entries(motionSpecUpdates)) {
                sidecarRequests.push({
                    targetPath: this.motionSpecPath(id),
                    value: content,
                    label: `motion sidecar ${id}`,
                });
            }
        }
        if (transcriptUpdates) {
            for (const [sourceId, transcript] of Object.entries(transcriptUpdates)) {
                assertSafeId(sourceId, 'source');
                if (!transcript || transcript.sourceId !== sourceId) {
                    throw new Error(`transcript update key ${JSON.stringify(sourceId)} does not match transcript.sourceId ${JSON.stringify(transcript?.sourceId)}`);
                }
                sidecarRequests.push({
                    targetPath: this.transcriptPath(sourceId),
                    value: transcript,
                    label: `transcript sidecar ${sourceId}`,
                });
            }
        }
        const stagedSidecars = [];
        try {
            for (let i = 0; i < sidecarRequests.length; i++) {
                const request = sidecarRequests[i];
                stagedSidecars.push(await this.stageJsonSidecarLocked(request.targetPath, request.value, request.label, sidecarToken, i));
            }
        }
        catch (error) {
            await Promise.all(stagedSidecars.map((sidecar) => fs.rm(sidecar.stagedPath, { force: true }).catch(() => { })));
            throw error;
        }
        // Write order for crash safety: (a) manifest to a revision-unique tmp
        // file, (b) append the log entry — the durable source of truth for
        // "did this revision happen" — then (c) rename the tmp into place. If
        // the process dies between (b) and (c), open()'s reconcile() sees the
        // log's tail ahead of project.json and truncates it, instead of a
        // phantom revision sitting in the log that the manifest never reflects.
        const tmp = `${this.manifestPath}.tmp-${next.revision}-${Math.random().toString(36).slice(2)}`;
        try {
            await fs.writeFile(tmp, JSON.stringify(next, null, 2));
            await fs.appendFile(this.revisionsPath, JSON.stringify(entry) + '\n');
            await fs.rename(tmp, this.manifestPath);
            // project.json's rename is the logical commit boundary. From here on,
            // a sidecar publication failure must not be thrown as though the edit
            // rolled back: revisions.jsonl already contains the authoritative
            // values, captureRenderInputs() reads those revision-pinned values, and
            // open() can repair compatibility sidecars from the same entry.
            const failures = [];
            for (const sidecar of stagedSidecars) {
                try {
                    await fs.rename(sidecar.stagedPath, sidecar.targetPath);
                }
                catch (error) {
                    // A platform/filesystem can report an error after completing an
                    // operation. Verify the target before declaring repair necessary.
                    if (await this.jsonSidecarMatches(sidecar.targetPath, sidecar.value))
                        continue;
                    failures.push(`${sidecar.label}: ${error?.message ?? String(error)}`);
                }
            }
            if (failures.length > 0) {
                this.addWarning(`revision ${next.revision} was committed, but ${failures.length} compatibility sidecar(s) need repair (${failures.join('; ')}). ` +
                    'Revision-pinned reads and exports remain correct; reopen the project after checking disk space and permissions to retry repair');
            }
        }
        finally {
            await fs.rm(tmp, { force: true }).catch(() => { });
            await Promise.all(stagedSidecars.map((sidecar) => fs.rm(sidecar.stagedPath, { force: true }).catch(() => { })));
        }
        return next;
    }
    /**
     * Parse revisions.jsonl content into entries, tolerant of a partial
     * trailing line (a crash mid-append, dropped silently) but throwing on
     * any earlier line that fails to parse — that's real corruption, not an
     * in-progress write, and silently skipping it would make restore/undo
     * return the wrong snapshot with no indication anything is missing.
     */
    parseRevisionLines(raw) {
        const lines = raw.split('\n').filter((l) => l.length > 0);
        const entries = [];
        let trailingDropped = false;
        for (let i = 0; i < lines.length; i++) {
            try {
                entries.push(JSON.parse(lines[i]));
            }
            catch {
                if (i === lines.length - 1) {
                    trailingDropped = true;
                    break;
                }
                throw new Error(`revisions.jsonl corrupted at line ${i + 1}; manual recovery required`);
            }
        }
        return { entries, trailingDropped };
    }
    /**
     * Crash-recovery check run once when a project is opened. commitLocked's
     * write order means that if the process dies between the log append and
     * the manifest rename, revisions.jsonl describes a revision project.json
     * never durably reflects. Detect that by comparing the log's highest
     * revision to the manifest's, and if the log is ahead (or its tail is a
     * partial line from a crash mid-append), truncate it back to what the
     * manifest actually reflects and record `warning` — never throw, since
     * the project itself is still safely openable once reconciled.
     */
    /** Body of open-time recovery; must hold the cross-process project lock. */
    async reconcileLocked() {
        let raw;
        try {
            raw = await fs.readFile(this.revisionsPath, 'utf8');
        }
        catch {
            return; // no log yet; nothing to reconcile
        }
        if (!raw)
            return;
        const { entries, trailingDropped } = this.parseRevisionLines(raw);
        const m = await this.manifest();
        const ahead = entries.filter((e) => e.rev > m.revision);
        const kept = entries.filter((e) => e.rev <= m.revision);
        if (trailingDropped || ahead.length > 0) {
            const body = kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : '');
            const tmp = `${this.revisionsPath}.tmp-reconcile-${process.pid}-${Math.random().toString(36).slice(2)}`;
            try {
                await fs.writeFile(tmp, body);
                await fs.rename(tmp, this.revisionsPath);
            }
            finally {
                await fs.rm(tmp, { force: true }).catch(() => { });
            }
        }
        const parts = [];
        if (trailingDropped)
            parts.push('dropped a partial trailing line in revisions.jsonl (crash mid-write)');
        if (ahead.length > 0) {
            const maxRev = Math.max(...entries.map((e) => e.rev));
            parts.push(`revisions.jsonl was ahead of project.json (log rev ${maxRev} > manifest rev ${m.revision}); truncated ${ahead.length} orphan revision(s) — redo any edit made just before the crash`);
        }
        if (parts.length > 0)
            this.addWarning(parts.join('; '));
        // A revision is durable before its mutable sidecars are updated. If the
        // process died in that narrow window, repair current transcript/motion
        // files from the revision log before serving the project again.
        const repaired = [];
        const transcriptState = resolveTranscriptState(kept, m.revision);
        for (const source of m.sources) {
            if (!source.transcribed)
                continue;
            const transcript = transcriptState.get(source.id);
            if (!transcript || await this.jsonSidecarMatches(this.transcriptPath(source.id), transcript))
                continue;
            try {
                await this.replaceJsonSidecarLocked(this.transcriptPath(source.id), transcript, `transcript sidecar ${source.id}`);
                repaired.push(`transcript ${source.id}`);
            }
            catch (error) {
                throw new Error(`project revision ${m.revision} is committed, but transcript sidecar ${source.id} could not be repaired ` +
                    `(${error?.message ?? String(error)}). Check disk space and permissions, then reopen the project`);
            }
        }
        const currentEntry = kept.find((entry) => entry.rev === m.revision);
        for (const item of m.timeline.motion) {
            const spec = currentEntry?.motionSpecs?.[item.id];
            if (spec === undefined || await this.jsonSidecarMatches(this.motionSpecPath(item.id), spec))
                continue;
            try {
                await this.replaceJsonSidecarLocked(this.motionSpecPath(item.id), spec, `motion sidecar ${item.id}`);
                repaired.push(`motion ${item.id}`);
            }
            catch (error) {
                throw new Error(`project revision ${m.revision} is committed, but motion sidecar ${item.id} could not be repaired ` +
                    `(${error?.message ?? String(error)}). Check disk space and permissions, then reopen the project`);
            }
        }
        if (repaired.length > 0) {
            this.addWarning(`repaired ${repaired.length} compatibility sidecar(s) for committed revision ${m.revision}: ${repaired.join(', ')}`);
        }
    }
    async revisions() {
        let raw;
        try {
            raw = await fs.readFile(this.revisionsPath, 'utf8');
        }
        catch {
            return [];
        }
        const { entries } = this.parseRevisionLines(raw);
        return entries.map(({ snapshot: _snapshot, motionSpecs: _motionSpecs, transcriptUpdates: _transcriptUpdates, ...rest }) => rest);
    }
    /**
     * Restore the snapshot at `rev` as a NEW revision (history stays intact).
     * `baseRev` is required (optimistic concurrency, same contract as
     * commit()) — callers must re-read state before restoring rather than
     * always racing onto "whatever's latest". Also rolls motion/*.json
     * sidecars back to their content as of `rev`, when that revision recorded
     * it (older entries predating this feature won't have `motionSpecs`).
     *
     * `vedit compact` (see compact() below) can have dropped `rev`'s snapshot
     * to bound revisions.jsonl's growth — RevisionEntry.snapshot is declared
     * required in types.ts (every WRITER always fills it in) but a compacted
     * entry's JSON on disk genuinely omits the key, so this checks for that
     * at runtime and fails with a "nearest restorable revision" pointer
     * instead of restoring `undefined`.
     */
    /**
     * `cause`, when given, is stamped onto the recorded restore's `params` as
     * `{ rev, cause }` — see resolveUndoTarget/resolveRedoTarget below, which
     * read it back out of `revisions()` to tell a logical-undo-produced
     * restore apart from a logical-redo-produced one and from an arbitrary
     * ("manual") jump to an old revision, e.g. the existing `vedit undo --rev
     * N` / a UI "restore this old revision" action. Omitted (the pre-E-1
     * call shape every existing caller — including daemon.ts's `/api/edit`
     * 'restore' branch — still uses) records bare `{ rev }`, exactly as
     * before; resolveUndoTarget/resolveRedoTarget treat that the same as
     * `cause: 'manual'` (see their doc), so this is purely additive and
     * every pre-E-1 revisions.jsonl still replays correctly.
     */
    async restore(rev, actor, baseRev, cause) {
        return this.withLock(async () => {
            if (rev === 0) {
                throw new Error('cannot restore revision 0 (empty project); re-ingest instead');
            }
            let raw;
            try {
                raw = await fs.readFile(this.revisionsPath, 'utf8');
            }
            catch {
                raw = '';
            }
            const { entries } = this.parseRevisionLines(raw);
            let target;
            for (const e of entries)
                if (e.rev === rev)
                    target = e; // last match wins (revs are unique in practice)
            if (!target)
                throw new Error(`revision ${rev} not found`);
            if (!target.snapshot) {
                const withSnapshot = entries.filter((e) => e.snapshot);
                if (withSnapshot.length === 0) {
                    throw new Error(`revision ${rev} has no stored snapshot (compacted by \`vedit compact\`), and no other revision has one either — cannot restore`);
                }
                let nearest = withSnapshot[0];
                let bestDist = Math.abs(nearest.rev - rev);
                for (const e of withSnapshot) {
                    const d = Math.abs(e.rev - rev);
                    if (d < bestDist) {
                        nearest = e;
                        bestDist = d;
                    }
                }
                throw new Error(`revision ${rev} has no stored snapshot (compacted by \`vedit compact\`); nearest restorable revision is ${nearest.rev} ("${nearest.summary}") — run \`vedit undo --rev ${nearest.rev}\``);
            }
            const snap = target.snapshot;
            const targetSourceIds = new Set(snap.sources.filter((source) => source.transcribed).map((source) => source.id));
            const targetTranscripts = Object.fromEntries([...resolveTranscriptState(entries, target.rev)]
                .filter(([sourceId]) => targetSourceIds.has(sourceId)));
            const restored = await this.commitLocked(baseRev, actor, 'restore', cause ? { rev, cause } : { rev }, `restored revision ${rev}`, () => ({ ...snap }), target.motionSpecs, targetTranscripts);
            await this.syncCandidateDecisionStatusesLocked(entries, target.rev);
            return restored;
        });
    }
    /**
     * Logical undo (E-1, 波E NLE操作性パック): restore to "the state one
     * effective edit before the current one", correctly walking further back
     * on each successive call rather than flip-flopping between two states
     * (see resolveUndoTarget's doc for why a naive "restore rev N-1" breaks
     * on the second press). `baseRev` follows the same optimistic-concurrency
     * contract as every other mutation; `actor` is recorded on the resulting
     * restore revision like any other. Throws when there is nothing left to
     * undo (a pristine project, or every prior edit already undone).
     */
    async undo(actor, baseRev) {
        const target = resolveUndoTarget(await this.revisions());
        return this.restore(target, actor, baseRev, 'undo');
    }
    /**
     * Logical redo (E-1): the mirror of undo(), valid only while the tail of
     * the log is an unbroken run of undos with nothing else (no ordinary
     * edit, no manual restore) committed since — see resolveRedoTarget's doc.
     * Throws when there is nothing to redo.
     */
    async redo(actor, baseRev) {
        const target = resolveRedoTarget(await this.revisions());
        return this.restore(target, actor, baseRev, 'redo');
    }
    /**
     * Bound revisions.jsonl's growth (HANDOFF §5: "revisions.jsonl は全量
     * スナップショット追記で肥大" — every commit appends a full manifest
     * snapshot). Policy: the most recent `RECENT_KEEP` entries always keep
     * their full snapshot+motionSpecs untouched; among OLDER entries, every
     * `SNAPSHOT_STRIDE`-th one (0-based position within the older subset, so
     * the very OLDEST entry always qualifies — restore() never runs out of a
     * fallback target) also keeps its snapshot, and the rest have `snapshot`/
     * `motionSpecs` dropped, leaving only the summary metadata
     * (`Project.revisions()` never reads `.snapshot` at all, so the UI/CLI
     * history list is byte-for-byte unaffected by compaction — see that
     * method's doc). `dryRun` computes the projected byte delta without
     * writing anything; a real run first copies the current file to
     * `revisions.jsonl.bak` (overwriting any earlier backup), then replaces
     * revisions.jsonl atomically (tmp + rename).
     */
    async compact(opts = {}) {
        return this.withLock(() => this.compactLocked(opts));
    }
    async compactLocked(opts) {
        const RECENT_KEEP = 100;
        const SNAPSHOT_STRIDE = 10;
        let raw;
        try {
            raw = await fs.readFile(this.revisionsPath, 'utf8');
        }
        catch {
            raw = '';
        }
        const bytesBefore = Buffer.byteLength(raw, 'utf8');
        if (!raw) {
            return { totalEntries: 0, recentKept: 0, olderTotal: 0, snapshotsKept: 0, snapshotsDropped: 0, bytesBefore: 0, bytesAfter: 0, bytesSaved: 0, dryRun: Boolean(opts.dryRun) };
        }
        const { entries } = this.parseRevisionLines(raw); // append order === ascending rev
        const total = entries.length;
        const recentCount = Math.min(RECENT_KEEP, total);
        const olderCount = total - recentCount;
        let snapshotsKept = 0;
        let snapshotsDropped = 0;
        const rewritten = entries.map((e, i) => {
            if (i >= olderCount)
                return e; // within the "recent" window — untouched
            if (i % SNAPSHOT_STRIDE === 0) {
                snapshotsKept++;
                return e;
            }
            snapshotsDropped++;
            const { snapshot: _snapshot, motionSpecs: _motionSpecs, ...rest } = e;
            return rest;
        });
        const body = rewritten.map((e) => JSON.stringify(e)).join('\n') + (rewritten.length ? '\n' : '');
        const bytesAfter = Buffer.byteLength(body, 'utf8');
        const base = {
            totalEntries: total,
            recentKept: recentCount,
            olderTotal: olderCount,
            snapshotsKept,
            snapshotsDropped,
            bytesBefore,
            bytesAfter,
            bytesSaved: bytesBefore - bytesAfter,
        };
        if (opts.dryRun)
            return { ...base, dryRun: true };
        const backupPath = `${this.revisionsPath}.bak`;
        await fs.writeFile(backupPath, raw);
        const tmp = `${this.revisionsPath}.tmp-compact-${Math.random().toString(36).slice(2)}`;
        await fs.writeFile(tmp, body);
        await fs.rename(tmp, this.revisionsPath);
        return { ...base, dryRun: false, backupPath };
    }
    // ---- transcript ----
    transcriptPath(sourceId) {
        assertSafeId(sourceId, 'source');
        return path.join(this.dir, `transcript-${sourceId}.json`);
    }
    async transcript(sourceId) {
        return this.withLock(async () => {
            const manifest = await this.manifest();
            try {
                const entries = this.parseRevisionLines(await fs.readFile(this.revisionsPath, 'utf8')).entries;
                const recorded = resolveTranscriptState(entries, manifest.revision).get(sourceId);
                if (recorded)
                    return recorded;
            }
            catch (error) {
                if (!isMissingFile(error))
                    throw error;
            }
            return JSON.parse(await fs.readFile(this.transcriptPath(sourceId), 'utf8'));
        });
    }
    async writeTranscript(t) {
        return this.withLock(() => this.writeTranscriptLocked(t));
    }
    async writeTranscriptLocked(t) {
        await this.replaceJsonSidecarLocked(this.transcriptPath(t.sourceId), t, `transcript sidecar ${t.sourceId}`);
    }
    /**
     * Publish a completed transcript and the manifest revision that enables it
     * inside one project critical section. An export capture can therefore see
     * either the old pair or the new pair, never a mid-update mix.
     */
    async commitTranscript(transcript, actor, params, summary) {
        return this.withLock(async () => {
            const current = await this.manifest();
            if (!current.sources.some((source) => source.id === transcript.sourceId)) {
                throw new Error(`unknown source: ${transcript.sourceId}`);
            }
            return this.commitLocked(current.revision, actor, 'transcribe', params, summary, (manifest) => ({
                ...manifest,
                sources: manifest.sources.map((source) => (source.id === transcript.sourceId ? { ...source, transcribed: true } : source)),
            }), undefined, { [transcript.sourceId]: transcript });
        });
    }
    // ---- cut candidates (approve/reject queue) ----
    get candidatesPath() {
        return path.join(this.dir, 'candidates.json');
    }
    async candidatesUnlocked() {
        try {
            return JSON.parse(await fs.readFile(this.candidatesPath, 'utf8'));
        }
        catch (error) {
            if (isMissingFile(error))
                return [];
            throw error;
        }
    }
    async candidates() {
        return this.withLock(async () => {
            const all = await this.candidatesUnlocked();
            let raw = '';
            try {
                raw = await fs.readFile(this.revisionsPath, 'utf8');
            }
            catch { /* no revision history yet */ }
            const entries = raw ? this.parseRevisionLines(raw).entries : [];
            const current = await this.manifest();
            // revisions.jsonl is the durable decision truth. Returning the replayed
            // state also repairs the observable result of a crash/disk error between
            // the manifest commit and candidates.json rewrite.
            applyCandidateDecisionStatuses(all, entries, current.revision);
            return all.filter((candidate) => candidateBelongsToManifest(candidate, current));
        });
    }
    async writeCandidatesLocked(c) {
        const tmp = `${this.candidatesPath}.tmp-${Math.random().toString(36).slice(2)}`;
        try {
            await fs.writeFile(tmp, JSON.stringify(c, null, 2));
            await fs.rename(tmp, this.candidatesPath);
        }
        finally {
            await fs.rm(tmp, { force: true }).catch(() => { });
        }
    }
    async writeCandidates(c) {
        return this.withLock(() => this.writeCandidatesLocked(c));
    }
    /** Update candidate-only AI review metadata against an exact revision. */
    async reviewCandidatesAtRevision(baseRev, review) {
        return this.withLock(async () => {
            const current = await this.manifest();
            if (current.revision !== baseRev) {
                const err = new Error(`stale base revision ${baseRev}; current is ${current.revision}. Re-read state before editing.`);
                err.code = 'STALE_REVISION';
                throw err;
            }
            const all = await this.candidatesUnlocked();
            let raw = '';
            try {
                raw = await fs.readFile(this.revisionsPath, 'utf8');
            }
            catch { /* no revision history yet */ }
            const entries = raw ? this.parseRevisionLines(raw).entries : [];
            applyCandidateDecisionStatuses(all, entries, current.revision);
            const visible = all.filter((candidate) => candidateBelongsToManifest(candidate, current));
            const result = review(visible, current);
            await this.writeCandidatesLocked(all);
            return { all: visible, current, result };
        });
    }
    /** Apply the revision-derived status only to ids with logged decisions. */
    async syncCandidateDecisionStatusesLocked(entries, targetRev) {
        const all = await this.candidatesUnlocked();
        const changed = applyCandidateDecisionStatuses(all, entries, targetRev);
        if (changed)
            await this.writeCandidatesLocked(all);
    }
    /**
     * Replace only the proposed detection set while preserving every decision
     * and reusing the id of a matching prior proposal. The whole merge is under
     * the project lock, so a concurrent approve/reject cannot be overwritten;
     * stable ids also let redo find the same candidate after re-detection.
     */
    async replaceCandidateProposals(detected, accept = () => true, completion) {
        return this.withLock(async () => {
            const current = await this.manifest();
            const prior = await this.candidatesUnlocked();
            let raw = '';
            try {
                raw = await fs.readFile(this.revisionsPath, 'utf8');
            }
            catch { /* no revision history yet */ }
            const entries = raw ? this.parseRevisionLines(raw).entries : [];
            applyCandidateDecisionStatuses(prior, entries, current.revision);
            const decided = prior.filter((candidate) => candidate.status !== 'proposed');
            const previousProposals = prior.filter((candidate) => candidate.status === 'proposed');
            // Proposals from a future undo branch stay dormant on disk so redo can
            // recover the same ids, but are never returned or selectable while
            // their source is absent from the effective manifest.
            const dormantProposals = previousProposals.filter((candidate) => !candidateBelongsToManifest(candidate, current));
            const reused = new Set();
            const proposed = [];
            let excluded = 0;
            for (const candidate of detected) {
                if (!candidateBelongsToManifest(candidate, current)) {
                    excluded++;
                    continue;
                }
                if (!accept(candidate, current)) {
                    excluded++;
                    continue;
                }
                if (decided.some((old) => sameCandidateRange(old, candidate)))
                    continue;
                const previous = previousProposals.find((old) => !reused.has(old.id) && sameCandidateRange(old, candidate, true));
                if (previous)
                    reused.add(previous.id);
                proposed.push({
                    ...candidate,
                    id: previous?.id ?? candidate.id,
                    status: 'proposed',
                });
            }
            const all = [...decided, ...dormantProposals, ...proposed];
            const result = {
                all: all.filter((candidate) => candidateBelongsToManifest(candidate, current)),
                proposed,
                excluded,
            };
            if (!completion) {
                await this.writeCandidatesLocked(all);
                return result;
            }
            // candidates.json and detection's durable completion marker describe a
            // single publication. Stage the marker before touching live state, then
            // remove the old marker before replacing candidates. A crash/failure can
            // therefore leave an UNKNOWN run (no marker), never an old clean verdict
            // attached to a new candidate set. The project lock makes this ordering
            // cross-process, not merely per-daemon.
            const spec = completion(result, current);
            if (!spec.relativePath || path.isAbsolute(spec.relativePath)) {
                throw new Error(`candidate completion sidecar must be a non-empty project-relative path: ${spec.relativePath}`);
            }
            const targetPath = await resolveWithinDir(this.dir, spec.relativePath);
            if (targetPath === path.resolve(this.dir)) {
                throw new Error('candidate completion sidecar cannot replace the project directory');
            }
            const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const staged = await this.stageJsonSidecarLocked(targetPath, spec.value, spec.label, token, 0);
            let completionWarning;
            try {
                await fs.rm(targetPath, { force: true });
                await this.writeCandidatesLocked(all);
                try {
                    await fs.rename(staged.stagedPath, staged.targetPath);
                }
                catch (error) {
                    completionWarning = `could not publish ${spec.label}: ${error?.message ?? String(error)}`;
                }
            }
            finally {
                await fs.rm(staged.stagedPath, { force: true }).catch(() => { });
            }
            return {
                ...result,
                completionValue: spec.value,
                ...(completionWarning ? { completionWarning } : {}),
            };
        });
    }
    /**
     * Apply a cut-candidate decision atomically: candidate selection, the
     * optional manifest commit (on approve), and the candidates.json rewrite
     * all happen inside one critical section, so a concurrent /api/detect or
     * another decide can't interleave a stale read of candidates.json between
     * "decide what to apply" and "write the result".
     *
     * `select` picks the target candidates from a freshly-read `all` (read
     * inside the lock, not by the caller beforehand). `commitFor`, when
     * `decision === 'approve'`, builds the commit() arguments from the
     * resolved target and the manifest as of right now (`before`) — letting
     * the caller compute a baseRev fallback / summary against genuinely
     * current state rather than a pre-lock snapshot that might already be
     * stale.
     */
    async decideCandidates(select, decision, commitFor, opts = {}) {
        return this.withLock(async () => {
            const all = await this.candidatesUnlocked();
            // Read the manifest before selection when a commit is requested, so
            // autonomy policies can preflight against the exact same revision the
            // commit will use (no plan/apply gap inside this critical section).
            let before = commitFor ? await this.manifest() : undefined;
            const currentForStatus = before ?? await this.manifest();
            let raw = '';
            try {
                raw = await fs.readFile(this.revisionsPath, 'utf8');
            }
            catch { /* no revision history yet */ }
            const entries = raw ? this.parseRevisionLines(raw).entries : [];
            applyCandidateDecisionStatuses(all, entries, currentForStatus.revision);
            const visible = all.filter((candidate) => candidateBelongsToManifest(candidate, currentForStatus));
            const target = select(visible, before);
            if (target.length === 0) {
                if (!opts.allowEmpty)
                    throw new Error('no matching pending candidates');
                // `select` may have attached non-destructive AI review metadata. Save
                // that work without manufacturing a no-op timeline revision.
                await this.writeCandidatesLocked(all);
                return { target, before, all: visible };
            }
            let manifest;
            if (commitFor) {
                before ??= await this.manifest();
                const spec = commitFor(target, before);
                manifest = await this.commitLocked(spec.baseRev, spec.actor, spec.op, spec.params, spec.summary, spec.mutate);
            }
            for (const c of target)
                c.status = decision === 'approve' ? 'approved' : 'rejected';
            await this.writeCandidatesLocked(all);
            return { target, before, manifest, all: visible };
        });
    }
    // ---- scene index (detect + annotate) ----
    scenesPath(sourceId) {
        assertSafeId(sourceId, 'source');
        return path.join(this.dir, `scenes-${sourceId}.json`);
    }
    async scenesUnlocked(sourceId) {
        const target = this.scenesPath(sourceId);
        let parsed;
        try {
            parsed = JSON.parse(await fs.readFile(target, 'utf8'));
        }
        catch (error) {
            if (isMissingFile(error))
                return { sourceId, scenes: [] };
            // A malformed sidecar can contain irreplaceable human/model notes.  Do
            // not disguise corruption as an empty first detection and overwrite it.
            throw new Error(`scene index for source ${sourceId} is corrupt: ${error?.message ?? String(error)}`, { cause: error });
        }
        const file = parsed;
        if (!file || file.sourceId !== sourceId || !Array.isArray(file.scenes)) {
            throw new Error(`scene index for source ${sourceId} is corrupt: invalid SceneFile shape`);
        }
        const ids = new Set();
        for (let index = 0; index < file.scenes.length; index++) {
            const scene = file.scenes[index];
            const note = scene?.note;
            const validNote = note === undefined || Boolean(note
                && typeof note.text === 'string'
                && (note.by === 'user' || note.by === 'model')
                && typeof note.at === 'string'
                && Number.isFinite(Date.parse(note.at)));
            if (!scene
                || typeof scene.id !== 'string'
                || !SAFE_ID.test(scene.id)
                || ids.has(scene.id)
                || !Number.isFinite(scene.t0) || scene.t0 < 0
                || !Number.isFinite(scene.t1) || scene.t1 <= scene.t0
                || typeof scene.thumb !== 'string' || !scene.thumb
                || typeof scene.hasSpeech !== 'boolean'
                || !Number.isFinite(scene.energy)
                || !validNote) {
                throw new Error(`scene index for source ${sourceId} is corrupt: invalid scene at index ${index}`);
            }
            ids.add(scene.id);
        }
        return file;
    }
    async scenes(sourceId) {
        // Publication is an atomic rename, so readers outside the persistence
        // lock still see a complete old or new file.  Detection deliberately does
        // its expensive ffmpeg work without holding the project-wide write lock.
        return this.scenesUnlocked(sourceId);
    }
    async writeScenes(f) {
        return this.withLock(() => this.writeScenesLocked(f));
    }
    async writeScenesLocked(f) {
        await this.replaceJsonSidecarLocked(this.scenesPath(f.sourceId), f, `scene index ${f.sourceId}`);
    }
    /**
     * Publish a completed, expensive scene-detection result without losing a
     * note that arrived while ffmpeg was running.  The detector may have read
     * the old index minutes ago; re-read the latest index under the shared
     * cross-process lock and let its matching-id notes win at publication.
     */
    async publishDetectedScenes(detected) {
        return this.withLock(async () => {
            const latest = await this.scenesUnlocked(detected.sourceId);
            const notesById = new Map(latest.scenes
                .filter((scene) => scene.note)
                .map((scene) => [scene.id, scene.note]));
            const merged = {
                sourceId: detected.sourceId,
                scenes: detected.scenes.map((scene) => {
                    const note = notesById.get(scene.id) ?? scene.note;
                    return note ? { ...scene, note } : scene;
                }),
            };
            await this.writeScenesLocked(merged);
            return merged;
        });
    }
    /** Record a note on a scene, with its provenance (outsourced from detection). */
    async setSceneNote(sourceId, sceneId, text, by) {
        return this.withLock(() => this.setSceneNoteLocked(sourceId, sceneId, text, by));
    }
    async setSceneNoteLocked(sourceId, sceneId, text, by) {
        const file = await this.scenes(sourceId);
        const idx = file.scenes.findIndex((s) => s.id === sceneId);
        if (idx < 0)
            throw new Error(`unknown scene: ${sceneId} (source ${sourceId})`);
        const scene = { ...file.scenes[idx], note: { text, by, at: new Date().toISOString() } };
        file.scenes[idx] = scene;
        await this.writeScenesLocked(file);
        return scene;
    }
    /** Read current motion revision truth, falling back to a legacy sidecar. */
    async readMotionSpec(id) {
        return this.withLock(async () => {
            const manifest = await this.manifest();
            try {
                const entries = this.parseRevisionLines(await fs.readFile(this.revisionsPath, 'utf8')).entries;
                const recorded = entries.find((entry) => entry.rev === manifest.revision)?.motionSpecs;
                if (recorded && Object.prototype.hasOwnProperty.call(recorded, id))
                    return recorded[id];
            }
            catch (error) {
                if (!isMissingFile(error))
                    throw error;
            }
            return JSON.parse(await fs.readFile(this.motionSpecPath(id), 'utf8'));
        });
    }
}
