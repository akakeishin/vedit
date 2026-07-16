import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CutCandidate, Manifest, RevisionEntry, Transcript } from './types.js';
import { upsertProject } from './registry.js';

/**
 * Project store on disk. One directory per project:
 *   project.json / revisions.jsonl / transcript-<sourceId>.json /
 *   candidates.json / motion/ / cache/
 */
export class Project {
  constructor(public dir: string) {}

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
   * full snapshot, enabling cheap undo.
   */
  async commit(
    baseRev: number,
    actor: RevisionEntry['actor'],
    op: string,
    params: unknown,
    summary: string,
    mutate: (m: Manifest) => Manifest | Promise<Manifest>,
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
    const entry: RevisionEntry = {
      rev: next.revision,
      baseRev,
      actor,
      op,
      params,
      ts: new Date().toISOString(),
      summary,
      snapshot: next,
    };
    await fs.appendFile(this.revisionsPath, JSON.stringify(entry) + '\n');
    await this.writeManifest(next);
    return next;
  }

  async revisions(): Promise<Omit<RevisionEntry, 'snapshot'>[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.revisionsPath, 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const { snapshot: _snapshot, ...rest } = JSON.parse(l) as RevisionEntry;
        return rest;
      });
  }

  /** Restore the snapshot at `rev` as a NEW revision (history stays intact). */
  async restore(rev: number, actor: RevisionEntry['actor']): Promise<Manifest> {
    const raw = await fs.readFile(this.revisionsPath, 'utf8');
    let snap: Manifest | null = null;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line) as RevisionEntry;
      if (e.rev === rev) snap = e.snapshot;
    }
    if (rev === 0) {
      throw new Error('cannot restore revision 0 (empty project); re-ingest instead');
    }
    if (!snap) throw new Error(`revision ${rev} not found`);
    const cur = await this.manifest();
    return this.commit(cur.revision, actor, 'restore', { rev }, `restored revision ${rev}`, () => ({
      ...snap!,
    }));
  }

  // ---- transcript ----

  transcriptPath(sourceId: string) {
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

  async candidates(): Promise<CutCandidate[]> {
    try {
      return JSON.parse(await fs.readFile(this.candidatesPath, 'utf8'));
    } catch {
      return [];
    }
  }

  async writeCandidates(c: CutCandidate[]): Promise<void> {
    await fs.writeFile(this.candidatesPath, JSON.stringify(c, null, 2));
  }
}
