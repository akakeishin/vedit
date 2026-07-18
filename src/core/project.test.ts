import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project, resolveRedoTarget, resolveUndoRedoStacks, resolveUndoTarget, type UndoLogEntry } from './project.js';
import type { CutCandidate, Manifest, RevisionEntry } from './types.js';

function freshDir(prefix: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `vedit-project-${prefix}-`)), 'proj');
}

// ---- item 1: per-project write mutex (serializes commit/restore/etc) ----
describe('Project: write serialization', () => {
  it('two commits fired via Promise.all in call order land as consecutive revisions (FIFO queue, not a race)', async () => {
    const p = await Project.create(freshDir('mutex-fifo'), 'race');
    // Constructing the array evaluates both `commit()` calls synchronously
    // left-to-right, so the first call's withLock() enters the queue before
    // the second's — this is exactly the "queue in call order" guarantee
    // the mutex provides. The second commit deliberately uses baseRev=1,
    // anticipating the first will land at rev 1 first.
    const [m1, m2] = await Promise.all([
      p.commit(0, 'ui', 'a', {}, 'op a', (m) => ({ ...m, name: 'a' })),
      p.commit(1, 'ui', 'b', {}, 'op b', (m) => ({ ...m, name: 'b' })),
    ]);
    expect(m1.revision).toBe(1);
    expect(m2.revision).toBe(2);
    expect(m2.name).toBe('b'); // b's mutate ran against a's already-committed manifest, not a stale copy

    const revs = await p.revisions();
    expect(revs.map((r) => r.rev)).toEqual([1, 2]);
  });

  it('two commits racing with the SAME (now-stale) baseRev never both land as the same revision number', async () => {
    // This is the literal P0 bug: unlocked read->check->write let two
    // concurrent commits with an identical baseRev both pass the staleness
    // check and both write revision 1, corrupting the log with a
    // duplicate. With serialization, only the first to actually run the
    // check-then-write sees baseRev match; the second is correctly
    // rejected once it observes the real (now-advanced) revision.
    const p = await Project.create(freshDir('mutex-collision'), 'collide');
    const results = await Promise.allSettled([
      p.commit(0, 'ui', 'a', {}, 'op a', (m) => m),
      p.commit(0, 'ui', 'b', {}, 'op b', (m) => m),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as any).code).toBe('STALE_REVISION');

    const revs = await p.revisions();
    expect(revs.map((r) => r.rev)).toEqual([1]); // no duplicate rev=1 entries
  });
});

// ---- item 2/6: write order, crash reconcile, corrupted revisions.jsonl ----
describe('Project: crash recovery and log integrity', () => {
  it('reconcile() truncates a revisions.jsonl tail ahead of project.json and reports a warning', async () => {
    const dir = freshDir('reconcile');
    const p = await Project.create(dir, 'crash');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => m); // rev1, manifest.revision === 1

    // Simulate a crash between step (b) (log append) and step (c) (manifest
    // rename) in commitLocked: the log gets a phantom rev-2 entry, but
    // project.json never advances past rev 1.
    const cur = await p.manifest();
    const phantom = {
      rev: 2,
      baseRev: 1,
      actor: 'ui' as const,
      op: 'b',
      params: {},
      ts: new Date().toISOString(),
      summary: 'b',
      snapshot: { ...cur, revision: 2 },
    };
    await fsp.appendFile(path.join(dir, 'revisions.jsonl'), JSON.stringify(phantom) + '\n');

    const reopened = await Project.open(dir);
    expect(reopened.warning).toMatch(/ahead of project\.json/);
    expect(reopened.warning).toMatch(/log rev 2 > manifest rev 1/);

    const revs = await reopened.revisions();
    expect(revs.map((r) => r.rev)).toEqual([1]); // phantom rev 2 truncated

    const m = await reopened.manifest();
    expect(m.revision).toBe(1);

    // The log is genuinely rewritten on disk, not just filtered in memory.
    const raw = await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('open() is a no-op (no warning) when the log and manifest already agree', async () => {
    const dir = freshDir('reconcile-clean');
    const p = await Project.create(dir, 'clean');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => m);
    const reopened = await Project.open(dir);
    expect(reopened.warning).toBeUndefined();
  });

  it('revisions() and restore() ignore a partial trailing line in revisions.jsonl (crash mid-append)', async () => {
    const dir = freshDir('trailing-partial');
    const p = await Project.create(dir, 'partial');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => m); // rev1
    // A write that died mid-append: no trailing newline, truncated JSON.
    await fsp.appendFile(path.join(dir, 'revisions.jsonl'), '{"rev":2,"baseRev":1,"op":"b"');

    const revs = await p.revisions();
    expect(revs.map((r) => r.rev)).toEqual([1]);

    // restore() must also tolerate it rather than throwing on the garbage tail.
    const m = await p.restore(1, 'ui', 1);
    expect(m.revision).toBe(2); // restore is itself a new revision
  });

  it('revisions() and restore() throw a clear error when a non-trailing line is corrupted', async () => {
    const dir = freshDir('mid-corrupt');
    const p = await Project.create(dir, 'corrupt');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => m); // rev1
    await p.commit(1, 'ui', 'b', {}, 'b', (m) => m); // rev2

    const revPath = path.join(dir, 'revisions.jsonl');
    const raw = await fsp.readFile(revPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    lines[0] = '{not valid json at all';
    await fsp.writeFile(revPath, lines.join('\n') + '\n');

    await expect(p.revisions()).rejects.toThrow(/revisions\.jsonl corrupted at line 1; manual recovery required/);
    await expect(p.restore(2, 'ui', 2)).rejects.toThrow(/corrupted at line 1/);
  });

  it('open() surfaces the same "corrupted at line N" error when reconcile hits a mid-log corruption', async () => {
    const dir = freshDir('open-mid-corrupt');
    const p = await Project.create(dir, 'corrupt2');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => m);
    await p.commit(1, 'ui', 'b', {}, 'b', (m) => m);
    const revPath = path.join(dir, 'revisions.jsonl');
    const raw = await fsp.readFile(revPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    lines[0] = 'garbage';
    await fsp.writeFile(revPath, lines.join('\n') + '\n');

    await expect(Project.open(dir)).rejects.toThrow(/corrupted at line 1/);
  });
});

// ---- item 5: restore() requires and validates baseRev like commit() ----
describe('Project: restore baseRev', () => {
  it('rejects a stale baseRev the same way commit() does', async () => {
    const dir = freshDir('restore-stale');
    const p = await Project.create(dir, 'restore-stale');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => m); // rev1
    await p.commit(1, 'ui', 'b', {}, 'b', (m) => m); // rev2
    await expect(p.restore(1, 'ui', 0)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });

  it('succeeds and advances the revision when baseRev matches current', async () => {
    const dir = freshDir('restore-ok');
    const p = await Project.create(dir, 'restore-ok');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => ({ ...m, name: 'a' })); // rev1
    await p.commit(1, 'ui', 'b', {}, 'b', (m) => ({ ...m, name: 'b' })); // rev2
    const m = await p.restore(1, 'ui', 2);
    expect(m.revision).toBe(3);
    expect(m.name).toBe('a');
  });
});

// ---- item 4: motion sidecar transactionality + restore rollback ----
describe('Project: motion sidecar writes are transactional with commit', () => {
  it('a stale commit carrying motionSpecUpdates never writes the sidecar file', async () => {
    const dir = freshDir('motion-tx');
    const p = await Project.create(dir, 'motion-tx');
    const withMotion = (m: Manifest): Manifest => ({
      ...m,
      timeline: { ...m.timeline, motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 0, duration: 2 }] },
    });
    const m1 = await p.commit(0, 'ui', 'motion-add', {}, 'add', withMotion, {
      mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'v1' } },
    });
    expect(m1.revision).toBe(1);
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'v1' } });

    const m2 = await p.commit(1, 'ui', 'motion-update', {}, 'update', (m) => m, {
      mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'v2' } },
    });
    expect(m2.revision).toBe(2);
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'v2' } });

    // A rejected (stale) commit that ALSO carries a spec update must not
    // touch the sidecar at all — this is the exact bug being fixed: the
    // old code wrote the sidecar unconditionally before knowing whether
    // the commit itself would be accepted.
    await expect(
      p.commit(1 /* stale: current is 2 */, 'ui', 'motion-update', {}, 'stale', (m) => m, {
        mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'SHOULD-NOT-LAND' } },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'v2' } }); // unchanged
  });

  it('restore() rolls motion/*.json sidecars back to their content as of the target revision', async () => {
    const dir = freshDir('motion-restore');
    const p = await Project.create(dir, 'motion-restore');
    const withMotion = (m: Manifest): Manifest => ({
      ...m,
      timeline: { ...m.timeline, motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 0, duration: 2 }] },
    });
    await p.commit(0, 'ui', 'motion-add', {}, 'add', withMotion, {
      mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'v1' } },
    }); // rev1: spec is v1
    await p.commit(1, 'ui', 'motion-update', {}, 'update', (m) => m, {
      mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'v2' } },
    }); // rev2: spec is v2
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'v2' } });

    const restored = await p.restore(1, 'ui', 2); // roll back to rev1
    expect(restored.revision).toBe(3);
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'v1' } });
  });
});

// ---- item 7: candidates decide + commit atomicity ----
describe('Project: decideCandidates atomicity', () => {
  function cand(over: Partial<CutCandidate> = {}): CutCandidate {
    return { id: 'c1', kind: 'silence', sourceId: 's1', t0: 2, t1: 3, wordIds: [], label: 'x', status: 'proposed', ...over };
  }

  it('approve applies the commit and rewrites candidates.json inside one critical section', async () => {
    const dir = freshDir('decide-ok');
    const p = await Project.create(dir, 'decide-ok');
    await p.writeCandidates([cand()]);

    const result = await p.decideCandidates(
      (all) => all.filter((c) => c.status === 'proposed'),
      'approve',
      (target, before) => ({
        baseRev: before.revision,
        actor: 'ui',
        op: 'apply-candidates',
        params: { ids: target.map((c) => c.id) },
        summary: 'applied',
        mutate: (m) => ({ ...m, name: 'cut-applied' }),
      }),
    );
    expect(result.manifest?.revision).toBe(1);
    expect(result.manifest?.name).toBe('cut-applied');
    expect(result.target.map((c) => c.id)).toEqual(['c1']);
    expect(result.all.find((c) => c.id === 'c1')?.status).toBe('approved');

    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('approved');
  });

  it('reject writes candidates.json without touching the manifest', async () => {
    const dir = freshDir('decide-reject');
    const p = await Project.create(dir, 'decide-reject');
    await p.writeCandidates([cand()]);
    const result = await p.decideCandidates((all) => all.filter((c) => c.status === 'proposed'), 'reject');
    expect(result.manifest).toBeUndefined();
    const m = await p.manifest();
    expect(m.revision).toBe(0);
    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('rejected');
  });

  it('throws "no matching pending candidates" and writes nothing when selection is empty', async () => {
    const dir = freshDir('decide-empty');
    const p = await Project.create(dir, 'decide-empty');
    await p.writeCandidates([cand({ status: 'approved' })]); // nothing left proposed
    await expect(p.decideCandidates((all) => all.filter((c) => c.status === 'proposed'), 'approve')).rejects.toThrow(
      /no matching pending candidates/,
    );
    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('approved'); // untouched
  });

  it('leaves candidates.json untouched when the approve commit itself is rejected (stale baseRev)', async () => {
    const dir = freshDir('decide-stale');
    const p = await Project.create(dir, 'decide-stale');
    await p.writeCandidates([cand()]);
    await expect(
      p.decideCandidates(
        (all) => all.filter((c) => c.status === 'proposed'),
        'approve',
        () => ({ baseRev: 999, actor: 'ui', op: 'apply-candidates', params: {}, summary: 'x', mutate: (m) => m }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' });
    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('proposed'); // untouched — commit failed before the status flip
  });
});

// ---- roadmap "revisions.jsonl 世代圧縮": Project.compact() ----
describe('Project: compact()', () => {
  function fixtureManifest(n: number): Manifest {
    return {
      version: 1, name: `rev${n}`, revision: n, fps: 30, width: 1920, height: 1080,
      sources: [], timeline: { video: [], motion: [] },
      captions: { enabled: true, style: 'clean', maxChars: 24 },
    };
  }

  function fixtureEntry(rev: number): RevisionEntry {
    return {
      rev, baseRev: rev - 1, actor: 'ui', op: `op${rev}`, params: {}, ts: '2020-01-01T00:00:00.000Z',
      summary: `summary ${rev}`, snapshot: fixtureManifest(rev),
    };
  }

  /**
   * Bypasses commit() entirely — writes N synthetic full-snapshot entries
   * directly (so 100+-entry retention-policy tests don't need hundreds of
   * real commits), and also overwrites project.json's own `revision` to
   * `count` so it stays consistent with the log (matching what a real
   * sequence of commits would have left behind) — compact() itself never
   * reads/compares against project.json, but restore()'s baseRev check
   * does.
   */
  async function seedRevisions(dir: string, count: number): Promise<void> {
    const body = Array.from({ length: count }, (_, i) => JSON.stringify(fixtureEntry(i + 1))).join('\n') + '\n';
    await fsp.writeFile(path.join(dir, 'revisions.jsonl'), body);
    await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(fixtureManifest(count), null, 2));
  }

  it('an empty/no revisions.jsonl compacts to a no-op (no error, no .bak)', async () => {
    const dir = freshDir('compact-empty');
    const p = await Project.create(dir, 'empty');
    const res = await p.compact();
    expect(res).toMatchObject({ totalEntries: 0, recentKept: 0, olderTotal: 0, snapshotsKept: 0, snapshotsDropped: 0, dryRun: false });
    await expect(fsp.access(path.join(dir, 'revisions.jsonl.bak'))).rejects.toThrow();
  });

  it('fewer than 100 entries: everything stays in the "recent" window untouched, byte count unchanged', async () => {
    const dir = freshDir('compact-small');
    const p = await Project.create(dir, 'small');
    for (let i = 0; i < 5; i++) await p.commit(i, 'ui', `op${i}`, {}, `s${i}`, (m) => m);
    const before = await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8');

    const dry = await p.compact({ dryRun: true });
    expect(dry).toMatchObject({ totalEntries: 5, recentKept: 5, olderTotal: 0, snapshotsKept: 0, snapshotsDropped: 0, dryRun: true });
    expect(dry.bytesAfter).toBe(dry.bytesBefore);
    expect(dry.bytesSaved).toBe(0);
    // dry-run truly never writes anything.
    expect(await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8')).toBe(before);

    const real = await p.compact();
    expect(real.dryRun).toBe(false);
    expect(real.bytesSaved).toBe(0);
    expect(await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8')).toBe(before); // still byte-identical

    const revs = await p.revisions();
    expect(revs.map((r) => r.rev)).toEqual([1, 2, 3, 4, 5]);
  });

  it('130 entries: keeps the most recent 100 in full, and every 10th of the older 30 (oldest included)', async () => {
    const dir = freshDir('compact-130');
    const p = await Project.create(dir, 'big');
    await seedRevisions(dir, 130);
    const raw = await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8');
    const bytesBefore = Buffer.byteLength(raw, 'utf8');

    const res = await p.compact();
    expect(res).toMatchObject({
      totalEntries: 130, recentKept: 100, olderTotal: 30, snapshotsKept: 3, snapshotsDropped: 27, dryRun: false,
    });
    expect(res.bytesBefore).toBe(bytesBefore);
    expect(res.bytesAfter).toBeLessThan(bytesBefore);
    expect(res.bytesSaved).toBe(bytesBefore - res.bytesAfter);
    expect(res.backupPath).toBe(path.join(dir, 'revisions.jsonl.bak'));
    expect(await fsp.readFile(res.backupPath!, 'utf8')).toBe(raw); // backup is the PRE-compaction content

    // Re-parse the compacted file directly (bypassing Project's own
    // snapshot-stripping accessors) to check exactly which entries kept a
    // snapshot: rev 1/11/21 (older-subset positions 0/10/20) plus every one
    // of rev 31..130 (the always-kept recent window).
    const after = (await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as RevisionEntry);
    expect(after).toHaveLength(130);
    const withSnapshot = new Set(after.filter((e) => e.snapshot).map((e) => e.rev));
    expect(withSnapshot.has(1)).toBe(true);
    expect(withSnapshot.has(11)).toBe(true);
    expect(withSnapshot.has(21)).toBe(true);
    expect(withSnapshot.has(2)).toBe(false);
    expect(withSnapshot.has(25)).toBe(false);
    for (let rev = 31; rev <= 130; rev++) expect(withSnapshot.has(rev)).toBe(true);

    // History display (UI list / `vedit revisions`) never reads .snapshot at
    // all — revisions() must be byte-for-byte unaffected by compaction.
    const revs = await p.revisions();
    expect(revs).toHaveLength(130);
    expect(revs.map((r) => r.rev)).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
    expect(revs[1]).toMatchObject({ rev: 2, actor: 'ui', op: 'op2', summary: 'summary 2' }); // a DROPPED entry's metadata still reads fine
    expect((revs[1] as any).snapshot).toBeUndefined();
  });

  it('restore() on a compacted (snapshot-dropped) revision throws pointing at the nearest restorable one', async () => {
    const dir = freshDir('compact-restore-dropped');
    const p = await Project.create(dir, 'restore-dropped');
    await seedRevisions(dir, 130);
    await p.compact();

    // rev 25 (dropped) sits between kept rev 21 (dist 4) and the always-kept
    // rev 31 (dist 6) — nearest must be 21, not just "the first one found".
    await expect(p.restore(25, 'ui', 0)).rejects.toThrow(/no stored snapshot.*nearest restorable revision is 21/s);
  });

  it('restore() on a still-full (kept) revision works exactly as before compaction', async () => {
    const dir = freshDir('compact-restore-kept');
    const p = await Project.create(dir, 'restore-kept');
    await seedRevisions(dir, 130);
    await p.compact();

    const restored = await p.restore(21, 'ui', 130); // rev21 kept its snapshot (older-subset position 20); baseRev=130 matches seedRevisions' project.json
    expect(restored.revision).toBe(131); // restore is itself a new revision
    expect(restored.name).toBe('rev21'); // fixtureManifest(21)'s content
  });
});

// ---- E-1 (波E NLE操作性パック): logical undo/redo ----

describe('Project: restore() cause tagging', () => {
  it('records { rev, cause } in params when a cause is given', async () => {
    const dir = freshDir('restore-cause');
    const p = await Project.create(dir, 'restore-cause');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => ({ ...m, name: 'a' })); // rev1
    await p.restore(1, 'claude', 1, 'undo'); // rev2
    const revs = await p.revisions();
    expect(revs.at(-1)).toMatchObject({ op: 'restore', params: { rev: 1, cause: 'undo' } });
  });

  it('omitting cause records bare { rev } — the pre-E-1 shape every existing caller (daemon.ts) still uses', async () => {
    const dir = freshDir('restore-no-cause');
    const p = await Project.create(dir, 'restore-no-cause');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => ({ ...m, name: 'a' })); // rev1
    await p.restore(1, 'ui', 1); // rev2, no cause — same call shape as before this feature
    const revs = await p.revisions();
    expect(revs.at(-1)?.params).toEqual({ rev: 1 });
  });
});

describe('resolveUndoRedoStacks / resolveUndoTarget / resolveRedoTarget (pure — replay-based reconstruction)', () => {
  /** Build a synthetic linear entry list; each element is either a plain edit ('e') or a restore with a cause. rev/baseRev are assigned sequentially starting at 1. */
  function entries(spec: Array<'edit' | { restore: number; cause?: 'undo' | 'redo' | 'manual' }>): UndoLogEntry[] {
    const out: UndoLogEntry[] = [];
    let rev = 0;
    for (const s of spec) {
      const baseRev = rev;
      rev += 1;
      if (s === 'edit') {
        out.push({ rev, baseRev, op: 'some-edit' });
      } else {
        out.push({ rev, baseRev, op: 'restore', params: s.cause ? { rev: s.restore, cause: s.cause } : { rev: s.restore } });
      }
    }
    return out;
  }

  it('three edits: first undo targets the state after edit 2 (rev2)', () => {
    const e = entries(['edit', 'edit', 'edit']); // rev1=A rev2=B rev3=C
    expect(resolveUndoTarget(e)).toBe(2);
  });

  it('CRITICAL: consecutive undo calls walk further back each time, not "undo of undo" ping-pong', () => {
    // rev1=A rev2=B rev3=C, then two undos issued back-to-back (as the CLI
    // would, using each resolved target to build the NEXT restore entry).
    let e = entries(['edit', 'edit', 'edit']);
    const t1 = resolveUndoTarget(e); // -> 2 (undo C, back to "A+B")
    expect(t1).toBe(2);
    e = [...e, { rev: 4, baseRev: 3, op: 'restore', params: { rev: t1, cause: 'undo' } }];
    const t2 = resolveUndoTarget(e); // must be 1 (undo B too, back to "A" alone) — NOT 3 (that would restore C right back)
    expect(t2).toBe(1);
    e = [...e, { rev: 5, baseRev: 4, op: 'restore', params: { rev: t2, cause: 'undo' } }];
    // A third undo would only leave revision 0 (pristine project) — not a real restorable target.
    expect(() => resolveUndoTarget(e)).toThrow(/nothing to undo/);
  });

  it('redo after a single undo brings back the undone edit', () => {
    let e = entries(['edit', 'edit', 'edit']); // rev1=A rev2=B rev3=C
    const undoTarget = resolveUndoTarget(e); // 2
    e = [...e, { rev: 4, baseRev: 3, op: 'restore', params: { rev: undoTarget, cause: 'undo' } }];
    const redoTarget = resolveRedoTarget(e);
    expect(redoTarget).toBe(3); // back to C
  });

  it('two undos then one redo returns to the state after the FIRST undo, not all the way back to the latest edit', () => {
    let e = entries(['edit', 'edit', 'edit']); // rev1=A rev2=B rev3=C
    const t1 = resolveUndoTarget(e); // 2
    e = [...e, { rev: 4, baseRev: 3, op: 'restore', params: { rev: t1, cause: 'undo' } }];
    const t2 = resolveUndoTarget(e); // 1
    e = [...e, { rev: 5, baseRev: 4, op: 'restore', params: { rev: t2, cause: 'undo' } }];
    const redoTarget = resolveRedoTarget(e);
    expect(redoTarget).toBe(4); // rev4's snapshot === rev2's snapshot ("A+B") — undoing the SECOND undo only
  });

  it('redo is discarded once an ordinary edit lands after an undo', () => {
    let e = entries(['edit', 'edit', 'edit']); // rev1=A rev2=B rev3=C
    const t1 = resolveUndoTarget(e);
    e = [...e, { rev: 4, baseRev: 3, op: 'restore', params: { rev: t1, cause: 'undo' } }];
    expect(resolveRedoTarget(e)).toBe(3); // redo available right after the undo
    e = [...e, { rev: 5, baseRev: 4, op: 'edit', params: {} }]; // a normal edit (D) lands
    expect(() => resolveRedoTarget(e)).toThrow(/nothing to redo/);
  });

  it('redo is discarded by an explicit manual restore (vedit undo --rev N / a UI "restore old revision" action), same as any edit', () => {
    let e = entries(['edit', 'edit', 'edit']);
    const t1 = resolveUndoTarget(e);
    e = [...e, { rev: 4, baseRev: 3, op: 'restore', params: { rev: t1, cause: 'undo' } }];
    // A manual jump to an arbitrary older revision, tagged cause:'manual'.
    e = [...e, { rev: 5, baseRev: 4, op: 'restore', params: { rev: 1, cause: 'manual' } }];
    expect(() => resolveRedoTarget(e)).toThrow(/nothing to redo/);
  });

  it('a legacy restore entry with no cause field (pre-E-1 shape) is treated the same as "manual" — invalidates redo, becomes undo-able itself', () => {
    let e = entries(['edit', 'edit', 'edit']);
    const t1 = resolveUndoTarget(e);
    e = [...e, { rev: 4, baseRev: 3, op: 'restore', params: { rev: t1, cause: 'undo' } }];
    expect(resolveRedoTarget(e)).toBe(3);
    // Untagged restore (exactly what daemon.ts's /api/edit issues today, since it doesn't forward `cause` yet).
    e = [...e, { rev: 5, baseRev: 4, op: 'restore', params: { rev: 1 } }];
    expect(() => resolveRedoTarget(e)).toThrow(/nothing to redo/);
    // And it's itself a valid undo target, like any ordinary edit would be.
    expect(resolveUndoTarget(e)).toBe(4);
  });

  it('resolveUndoTarget throws "nothing to undo" on an empty log (pristine project)', () => {
    expect(() => resolveUndoTarget([])).toThrow(/nothing to undo/);
  });

  it('resolveRedoTarget throws "nothing to redo" when no undo has ever happened', () => {
    const e = entries(['edit', 'edit']);
    expect(() => resolveRedoTarget(e)).toThrow(/nothing to redo/);
  });

  it('resolveUndoRedoStacks exposes the full stacks for callers that want more than just the top', () => {
    const e = entries(['edit', 'edit', 'edit']); // rev1=A rev2=B rev3=C
    const { undoStack, redoStack } = resolveUndoRedoStacks(e);
    expect(undoStack).toEqual([0, 1, 2]);
    expect(redoStack).toEqual([]);
  });
});

describe('Project.undo / Project.redo (E-1 integration — real commits, not synthetic entries)', () => {
  it('undo/redo/undo walks a real 3-edit history correctly, including the "undo of undo" regression', async () => {
    const dir = freshDir('undo-redo-integration');
    const p = await Project.create(dir, 'undo-redo-integration');
    await p.commit(0, 'ui', 'a', {}, 'edit A', (m) => ({ ...m, name: 'A' })); // rev1
    await p.commit(1, 'ui', 'b', {}, 'edit B', (m) => ({ ...m, name: 'B' })); // rev2
    await p.commit(2, 'ui', 'c', {}, 'edit C', (m) => ({ ...m, name: 'C' })); // rev3

    let m = await p.undo('claude', 3); // rev4: back to "B"
    expect(m.revision).toBe(4);
    expect(m.name).toBe('B');

    m = await p.undo('claude', 4); // rev5: back to "A" — must NOT bounce back to "C"
    expect(m.revision).toBe(5);
    expect(m.name).toBe('A');

    m = await p.redo('claude', 5); // rev6: forward to "B"
    expect(m.revision).toBe(6);
    expect(m.name).toBe('B');

    // A fresh edit now discards the remaining redo (back to "C" is no longer reachable via redo).
    await p.commit(6, 'ui', 'd', {}, 'edit D', (m2) => ({ ...m2, name: 'D' })); // rev7
    await expect(p.redo('claude', 7)).rejects.toThrow(/nothing to redo/);
  });

  it('undo throws a clear error on a pristine project (nothing to undo)', async () => {
    const dir = freshDir('undo-pristine');
    const p = await Project.create(dir, 'undo-pristine');
    await expect(p.undo('claude', 0)).rejects.toThrow(/nothing to undo/);
  });

  it('undo() still enforces optimistic concurrency via the underlying restore()', async () => {
    const dir = freshDir('undo-stale');
    const p = await Project.create(dir, 'undo-stale');
    await p.commit(0, 'ui', 'a', {}, 'a', (m) => ({ ...m, name: 'a' }));
    await p.commit(1, 'ui', 'b', {}, 'b', (m) => ({ ...m, name: 'b' }));
    await expect(p.undo('claude', 0)).rejects.toMatchObject({ code: 'STALE_REVISION' });
  });
});
