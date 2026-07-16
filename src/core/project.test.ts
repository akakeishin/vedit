import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project } from './project.js';
import type { CutCandidate, Manifest } from './types.js';

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
