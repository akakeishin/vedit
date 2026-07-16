import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CutCandidate, Manifest, RevisionEntry, Scene, SceneFile, Transcript } from './types.js';
import { upsertProject } from './registry.js';

/**
 * Ids used to build filenames (sourceId, motion spec id) must never carry a
 * path separator or ".." segment — the daemon treats a manifest and its
 * requests as untrusted even though it only binds to localhost, since a
 * corrupted/tampered project.json or a crafted request param must not be
 * able to read or write outside the project directory.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id: unknown, kind: string): asserts id is string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new Error(`invalid ${kind} id: ${JSON.stringify(id)}`);
  }
}

/**
 * Resolve `rel` under `dir` and reject anything that would land outside it:
 * a string-level check via path.resolve (catches "../.." traversal even
 * when disguised inside a longer segment, e.g. "scenes-../../x"), then —
 * when the target already exists — a realpath check on both sides to catch
 * symlink-based escapes too. Used for manifest-supplied relative paths
 * (proxy/peaks/thumb) which are on-disk data, not trusted input.
 */
export async function resolveWithinDir(dir: string, rel: string): Promise<string> {
  const base = path.resolve(dir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`path escapes directory: ${rel}`);
  }
  try {
    const [realBase, realFull] = await Promise.all([fs.realpath(base), fs.realpath(full)]);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) {
      throw new Error(`path escapes directory (symlink): ${rel}`);
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e; // target not created yet: string-level check above already covers traversal
  }
  return full;
}

/**
 * Project store on disk. One directory per project:
 *   project.json / revisions.jsonl / transcript-<sourceId>.json /
 *   candidates.json / scenes-<sourceId>.json / motion/ / cache/
 */
export class Project {
  constructor(public dir: string) {}

  /**
   * Set by `open()` when reconcile() had to repair the on-disk state
   * (truncated a phantom/partial revisions.jsonl tail — see `reconcile()`).
   * Callers (the daemon) may surface this to the user; it is never thrown
   * because the project is still safely openable once reconciled.
   */
  warning?: string;

  /**
   * Per-project write mutex, implemented as a plain promise chain — no
   * cross-process locking is needed since the daemon is the sole writer
   * and the CLI always goes through it. Every entry point that mutates
   * on-disk state (commit, restore, writeCandidates, setSceneNote,
   * decideCandidates, and the motion sidecar write inside commitLocked)
   * funnels through `withLock` so a read -> check -> write sequence can
   * never interleave with another one.
   */
  private _lock: Promise<unknown> = Promise.resolve();

  /**
   * Queue `fn` behind whatever is currently running. Queued in call order:
   * `fn` for a call made after another only starts once the earlier one has
   * settled (success or failure), so e.g. two commits fired back-to-back
   * (`Promise.all([p.commit(...), p.commit(...)])`) land as consecutive
   * revisions instead of racing on read-check-write.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get manifestPath() {
    return path.join(this.dir, 'project.json');
  }
  get revisionsPath() {
    return path.join(this.dir, 'revisions.jsonl');
  }
  get cacheDir() {
    return path.join(this.dir, 'cache');
  }
  get motionDir() {
    return path.join(this.dir, 'motion');
  }

  /** Path of a motion spec file, rejecting an id that isn't a bare safe token. */
  motionSpecPath(id: string) {
    assertSafeId(id, 'motion');
    return path.join(this.motionDir, `${id}.json`);
  }

  static async create(dir: string, name: string): Promise<Project> {
    const p = new Project(dir);
    await fs.mkdir(p.cacheDir, { recursive: true });
    await fs.mkdir(p.motionDir, { recursive: true });
    const manifest: Manifest = {
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
    await p.writeManifest(manifest);
    await upsertProject(dir, name);
    return p;
  }

  static async open(dir: string): Promise<Project> {
    const p = new Project(dir);
    await fs.access(p.manifestPath);
    await p.reconcile();
    return p;
  }

  async manifest(): Promise<Manifest> {
    return JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
  }

  private async writeManifest(m: Manifest): Promise<void> {
    const tmp = this.manifestPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(m, null, 2));
    await fs.rename(tmp, this.manifestPath);
  }

  /**
   * The single write path. Rejects stale bases (optimistic concurrency).
   * `mutate` must be pure; on success the revision log gets an entry with a
   * full snapshot, enabling cheap undo. Serialized via `withLock` so two
   * concurrent commits can't both read the same `cur.revision` and both
   * land as the same next revision number.
   *
   * `motionSpecUpdates`, if given, is a map of motion-item id -> new spec
   * content that this op wants written to motion/<id>.json. The physical
   * write happens only *after* the commit is durable (see commitLocked),
   * so a rejected (stale) commit never leaves a spec file mutated with no
   * matching manifest change.
   */
  async commit(
    baseRev: number,
    actor: RevisionEntry['actor'],
    op: string,
    params: unknown,
    summary: string,
    mutate: (m: Manifest) => Manifest | Promise<Manifest>,
    motionSpecUpdates?: Record<string, unknown>,
  ): Promise<Manifest> {
    return this.withLock(() => this.commitLocked(baseRev, actor, op, params, summary, mutate, motionSpecUpdates));
  }

  /** Body of `commit()`; must only ever run inside `withLock`. */
  private async commitLocked(
    baseRev: number,
    actor: RevisionEntry['actor'],
    op: string,
    params: unknown,
    summary: string,
    mutate: (m: Manifest) => Manifest | Promise<Manifest>,
    motionSpecUpdates?: Record<string, unknown>,
  ): Promise<Manifest> {
    const cur = await this.manifest();
    if (baseRev !== cur.revision) {
      const err = new Error(
        `stale base revision ${baseRev}; current is ${cur.revision}. Re-read state before editing.`,
      ) as Error & { code: string };
      err.code = 'STALE_REVISION';
      throw err;
    }
    const next = { ...(await mutate(cur)), revision: cur.revision + 1 };

    // Snapshot every motion sidecar referenced by the new manifest, so a
    // future restore() can roll motion/*.json back in lockstep with the
    // manifest instead of leaving stale spec content behind. Ids pending a
    // write via `motionSpecUpdates` haven't hit disk yet — use the pending
    // content for those instead of re-reading the (still old) file.
    const motionSpecs: Record<string, unknown> = {};
    for (const item of next.timeline.motion) {
      if (motionSpecUpdates && Object.prototype.hasOwnProperty.call(motionSpecUpdates, item.id)) {
        motionSpecs[item.id] = motionSpecUpdates[item.id];
        continue;
      }
      try {
        motionSpecs[item.id] = JSON.parse(await fs.readFile(this.motionSpecPath(item.id), 'utf8'));
      } catch {
        // Spec file missing/unreadable — omit rather than fail the whole
        // commit over a motion sidecar unrelated to this op.
      }
    }

    const entry: RevisionEntry = {
      rev: next.revision,
      baseRev,
      actor,
      op,
      params,
      ts: new Date().toISOString(),
      summary,
      snapshot: next,
      motionSpecs,
    };

    // Write order for crash safety: (a) manifest to a revision-unique tmp
    // file, (b) append the log entry — the durable source of truth for
    // "did this revision happen" — then (c) rename the tmp into place. If
    // the process dies between (b) and (c), open()'s reconcile() sees the
    // log's tail ahead of project.json and truncates it, instead of a
    // phantom revision sitting in the log that the manifest never reflects.
    const tmp = `${this.manifestPath}.tmp-${next.revision}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2));
    await fs.appendFile(this.revisionsPath, JSON.stringify(entry) + '\n');
    await fs.rename(tmp, this.manifestPath);

    // Motion sidecar writes land only after the commit is durable.
    if (motionSpecUpdates) {
      for (const [id, content] of Object.entries(motionSpecUpdates)) {
        await fs.writeFile(this.motionSpecPath(id), JSON.stringify(content, null, 2));
      }
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
  private parseRevisionLines(raw: string): { entries: RevisionEntry[]; trailingDropped: boolean } {
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const entries: RevisionEntry[] = [];
    let trailingDropped = false;
    for (let i = 0; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]) as RevisionEntry);
      } catch {
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
  private async reconcile(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.revisionsPath, 'utf8');
    } catch {
      return; // no log yet; nothing to reconcile
    }
    if (!raw) return;
    const { entries, trailingDropped } = this.parseRevisionLines(raw);
    const m = await this.manifest();
    const ahead = entries.filter((e) => e.rev > m.revision);
    if (!trailingDropped && ahead.length === 0) return;

    const kept = entries.filter((e) => e.rev <= m.revision);
    const body = kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : '');
    await fs.writeFile(this.revisionsPath, body);

    const parts: string[] = [];
    if (trailingDropped) parts.push('dropped a partial trailing line in revisions.jsonl (crash mid-write)');
    if (ahead.length > 0) {
      const maxRev = Math.max(...entries.map((e) => e.rev));
      parts.push(
        `revisions.jsonl was ahead of project.json (log rev ${maxRev} > manifest rev ${m.revision}); truncated ${ahead.length} orphan revision(s) — redo any edit made just before the crash`,
      );
    }
    this.warning = parts.join('; ');
  }

  async revisions(): Promise<Omit<RevisionEntry, 'snapshot' | 'motionSpecs'>[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.revisionsPath, 'utf8');
    } catch {
      return [];
    }
    const { entries } = this.parseRevisionLines(raw);
    return entries.map(({ snapshot: _snapshot, motionSpecs: _motionSpecs, ...rest }) => rest);
  }

  /**
   * Restore the snapshot at `rev` as a NEW revision (history stays intact).
   * `baseRev` is required (optimistic concurrency, same contract as
   * commit()) — callers must re-read state before restoring rather than
   * always racing onto "whatever's latest". Also rolls motion/*.json
   * sidecars back to their content as of `rev`, when that revision recorded
   * it (older entries predating this feature won't have `motionSpecs`).
   */
  async restore(rev: number, actor: RevisionEntry['actor'], baseRev: number): Promise<Manifest> {
    return this.withLock(async () => {
      if (rev === 0) {
        throw new Error('cannot restore revision 0 (empty project); re-ingest instead');
      }
      let raw: string;
      try {
        raw = await fs.readFile(this.revisionsPath, 'utf8');
      } catch {
        raw = '';
      }
      const { entries } = this.parseRevisionLines(raw);
      let target: RevisionEntry | undefined;
      for (const e of entries) if (e.rev === rev) target = e; // last match wins (revs are unique in practice)
      if (!target) throw new Error(`revision ${rev} not found`);
      const snap = target.snapshot;
      return this.commitLocked(
        baseRev,
        actor,
        'restore',
        { rev },
        `restored revision ${rev}`,
        () => ({ ...snap }),
        target.motionSpecs,
      );
    });
  }

  // ---- transcript ----

  transcriptPath(sourceId: string) {
    assertSafeId(sourceId, 'source');
    return path.join(this.dir, `transcript-${sourceId}.json`);
  }

  async transcript(sourceId: string): Promise<Transcript> {
    return JSON.parse(await fs.readFile(this.transcriptPath(sourceId), 'utf8'));
  }

  async writeTranscript(t: Transcript): Promise<void> {
    await fs.writeFile(this.transcriptPath(t.sourceId), JSON.stringify(t));
  }

  // ---- cut candidates (approve/reject queue) ----

  get candidatesPath() {
    return path.join(this.dir, 'candidates.json');
  }

  private async candidatesUnlocked(): Promise<CutCandidate[]> {
    try {
      return JSON.parse(await fs.readFile(this.candidatesPath, 'utf8'));
    } catch {
      return [];
    }
  }

  async candidates(): Promise<CutCandidate[]> {
    return this.candidatesUnlocked();
  }

  private async writeCandidatesLocked(c: CutCandidate[]): Promise<void> {
    const tmp = `${this.candidatesPath}.tmp-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(c, null, 2));
    await fs.rename(tmp, this.candidatesPath);
  }

  async writeCandidates(c: CutCandidate[]): Promise<void> {
    return this.withLock(() => this.writeCandidatesLocked(c));
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
  async decideCandidates(
    select: (all: CutCandidate[]) => CutCandidate[],
    decision: 'approve' | 'reject',
    commitFor?: (
      target: CutCandidate[],
      before: Manifest,
    ) => {
      baseRev: number;
      actor: RevisionEntry['actor'];
      op: string;
      params: unknown;
      summary: string;
      mutate: (m: Manifest) => Manifest;
    },
  ): Promise<{ target: CutCandidate[]; before?: Manifest; manifest?: Manifest; all: CutCandidate[] }> {
    return this.withLock(async () => {
      const all = await this.candidatesUnlocked();
      const target = select(all);
      if (target.length === 0) throw new Error('no matching pending candidates');
      let before: Manifest | undefined;
      let manifest: Manifest | undefined;
      if (decision === 'approve' && commitFor) {
        before = await this.manifest();
        const spec = commitFor(target, before);
        manifest = await this.commitLocked(spec.baseRev, spec.actor, spec.op, spec.params, spec.summary, spec.mutate);
      }
      for (const c of target) c.status = decision === 'approve' ? 'approved' : 'rejected';
      await this.writeCandidatesLocked(all);
      return { target, before, manifest, all };
    });
  }

  // ---- scene index (detect + annotate) ----

  scenesPath(sourceId: string) {
    assertSafeId(sourceId, 'source');
    return path.join(this.dir, `scenes-${sourceId}.json`);
  }

  async scenes(sourceId: string): Promise<SceneFile> {
    try {
      return JSON.parse(await fs.readFile(this.scenesPath(sourceId), 'utf8'));
    } catch {
      return { sourceId, scenes: [] };
    }
  }

  async writeScenes(f: SceneFile): Promise<void> {
    await fs.writeFile(this.scenesPath(f.sourceId), JSON.stringify(f, null, 2));
  }

  /** Record a note on a scene, with its provenance (outsourced from detection). */
  async setSceneNote(sourceId: string, sceneId: string, text: string, by: 'user' | 'model'): Promise<Scene> {
    return this.withLock(() => this.setSceneNoteLocked(sourceId, sceneId, text, by));
  }

  private async setSceneNoteLocked(sourceId: string, sceneId: string, text: string, by: 'user' | 'model'): Promise<Scene> {
    const file = await this.scenes(sourceId);
    const idx = file.scenes.findIndex((s) => s.id === sceneId);
    if (idx < 0) throw new Error(`unknown scene: ${sceneId} (source ${sourceId})`);
    const scene: Scene = { ...file.scenes[idx], note: { text, by, at: new Date().toISOString() } };
    file.scenes[idx] = scene;
    await this.writeScenes(file);
    return scene;
  }

  /** Read a motion sidecar's current content (motion/<id>.json). */
  async readMotionSpec(id: string): Promise<unknown> {
    return JSON.parse(await fs.readFile(this.motionSpecPath(id), 'utf8'));
  }
}
