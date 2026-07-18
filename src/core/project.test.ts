import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Project, resolveRedoTarget, resolveUndoRedoStacks, resolveUndoTarget, type UndoLogEntry } from './project.js';
import type { CutCandidate, Manifest, RevisionEntry, Transcript } from './types.js';

function freshDir(prefix: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `vedit-project-${prefix}-`)), 'proj');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    delay(40, 'pending'),
  ]);
  expect(state).toBe('pending');
}

describe('Project: create safety', () => {
  it('refuses to recreate an existing project and preserves its durable state', async () => {
    const dir = freshDir('create-existing');
    const original = await Project.create(dir, 'original');
    await original.commit(0, 'ui', 'rename', {}, 'kept revision', (manifest) => ({
      ...manifest,
      name: 'must survive',
    }));

    await expect(Project.create(dir, 'destructive replacement')).rejects.toThrow(/already exists|recovery/i);

    const reopened = await Project.open(dir);
    const manifest = await reopened.manifest();
    expect(manifest.name).toBe('must survive');
    expect(manifest.revision).toBe(1);
    expect((await reopened.revisions()).map((entry) => entry.rev)).toEqual([1]);
  });

  it('keeps a durably created project usable when the optional global registry cannot be written', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-project-registry-failure-'));
    const blocker = path.join(root, 'not-a-directory');
    await fsp.writeFile(blocker, 'file');
    const oldRegistryPath = process.env.VEDIT_REGISTRY_PATH;
    process.env.VEDIT_REGISTRY_PATH = path.join(blocker, 'projects.json');
    try {
      const dir = path.join(root, 'project');
      const project = await Project.create(dir, 'registry-independent');
      expect((await project.manifest()).name).toBe('registry-independent');
      expect(project.warning).toMatch(/project-list registration failed/);
      expect((await Project.open(dir)).warning).toBeUndefined();
    } finally {
      if (oldRegistryPath === undefined) delete process.env.VEDIT_REGISTRY_PATH;
      else process.env.VEDIT_REGISTRY_PATH = oldRegistryPath;
    }
  });
});

describe('Project: scene sidecar publication', () => {
  it('preserves a note written while a stale scene-detection result is being published', async () => {
    const dir = freshDir('scene-note-race');
    const detector = await Project.create(dir, 'scene-note-race');
    await detector.writeScenes({
      sourceId: 'source1',
      scenes: [
        { id: 's0001', t0: 0, t1: 5, thumb: 'cache/old.jpg', hasSpeech: false, energy: 0 },
      ],
    });

    // This is the result the detector computed from its earlier snapshot.
    // It intentionally has no note and must not overwrite a newer one.
    const staleDetection = {
      sourceId: 'source1',
      scenes: [
        { id: 's0001', t0: 0, t1: 5.2, thumb: 'cache/new.jpg', hasSpeech: true, energy: 0.4 },
      ],
    };
    const annotator = await Project.open(dir);
    await Promise.all([
      annotator.setSceneNote('source1', 's0001', '決定的な見せ場', 'user'),
      detector.publishDetectedScenes(staleDetection),
    ]);

    const published = await detector.scenes('source1');
    expect(published.scenes[0]).toMatchObject({
      t1: 5.2,
      thumb: 'cache/new.jpg',
      note: { text: '決定的な見せ場', by: 'user' },
    });
  });

  it('reports a corrupt scene sidecar and never replaces it with an empty/new detection', async () => {
    const dir = freshDir('scene-corrupt');
    const project = await Project.create(dir, 'scene-corrupt');
    const sidecar = project.scenesPath('source1');
    const corrupt = '{"sourceId":"source1","scenes":[broken';
    await fsp.writeFile(sidecar, corrupt);

    await expect(project.scenes('source1')).rejects.toThrow(/scene index.*corrupt/i);
    await expect(project.publishDetectedScenes({ sourceId: 'source1', scenes: [] }))
      .rejects.toThrow(/scene index.*corrupt/i);
    expect(await fsp.readFile(sidecar, 'utf8')).toBe(corrupt);
  });

  it('rejects a valid-JSON scene sidecar with the wrong source identity', async () => {
    const dir = freshDir('scene-shape');
    const project = await Project.create(dir, 'scene-shape');
    await fsp.writeFile(project.scenesPath('source1'), JSON.stringify({ sourceId: 'other', scenes: [] }));
    await expect(project.scenes('source1')).rejects.toThrow(/invalid SceneFile shape/);
  });

  it('rejects malformed nested scenes instead of crashing later or dropping their notes on redetection', async () => {
    const invalidScenes = [
      null,
      { id: 7, t0: 0, t1: 1, thumb: 'cache/x.jpg', hasSpeech: false, energy: 0 },
      { id: 's0001', t0: 0, t1: 1, thumb: 'cache/x.jpg', hasSpeech: false, energy: 0, note: { text: 'keep', by: 'user', at: 'not-a-date' } },
    ];
    for (const [index, invalid] of invalidScenes.entries()) {
      const dir = freshDir(`scene-nested-${index}`);
      const project = await Project.create(dir, 'scene-nested');
      const raw = JSON.stringify({ sourceId: 'source1', scenes: [invalid] });
      const sidecar = project.scenesPath('source1');
      await fsp.writeFile(sidecar, raw);
      await expect(project.scenes('source1')).rejects.toThrow(/invalid scene at index 0/);
      await expect(project.publishDetectedScenes({ sourceId: 'source1', scenes: [] }))
        .rejects.toThrow(/invalid scene at index 0/);
      expect(await fsp.readFile(sidecar, 'utf8')).toBe(raw);
    }
  });
});

describe('Project: candidate completion publication', () => {
  const candidate = (label: string, n = 0): CutCandidate => ({
    id: `candidate-${n}`,
    kind: 'silence',
    sourceId: 'source1',
    t0: n,
    t1: n + 0.8,
    wordIds: [],
    label,
    status: 'proposed',
  });

  async function seededProject(prefix: string): Promise<Project> {
    const project = await Project.create(freshDir(prefix), prefix);
    await project.commit(0, 'system', 'seed', {}, 'seed source', (manifest) => ({
      ...manifest,
      sources: [
        { id: 'source1', path: '/media/a.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: { video: [], motion: [] },
    }));
    return project;
  }

  it('keeps the final candidates and marker from the same writer across independent Project instances', async () => {
    const first = await seededProject('candidate-marker-race');
    const second = await Project.open(first.dir);
    const markerPath = path.join(first.dir, 'detect-run.json');

    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const project = index % 2 ? first : second;
      const label = `run-${index}`;
      return project.replaceCandidateProposals(
        [candidate(label, index)],
        () => true,
        () => ({ relativePath: 'detect-run.json', label: 'test marker', value: { label } }),
      );
    }));

    const current = await first.candidates();
    const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8')) as { label: string };
    expect(current).toHaveLength(1);
    expect(marker.label).toBe(current[0].label);
  });

  it('removes the old completion marker if publishing the new marker fails after candidates land', async () => {
    const project = await seededProject('candidate-marker-failure');
    const markerPath = path.join(project.dir, 'detect-run.json');
    await fsp.writeFile(markerPath, JSON.stringify({ label: 'old-clean-verdict' }));

    const realRename = fsp.rename.bind(fsp);
    const rename = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === markerPath && String(from).includes('.tmp-sidecar-')) {
        const error = new Error('injected marker publication failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return realRename(from, to);
    });
    try {
      const result = await project.replaceCandidateProposals(
        [candidate('new-result')],
        () => true,
        () => ({ relativePath: 'detect-run.json', label: 'test marker', value: { label: 'new-result' } }),
      );
      expect(result.completionWarning).toMatch(/injected marker publication failure/);
    } finally {
      rename.mockRestore();
    }

    expect((await project.candidates())[0].label).toBe('new-result');
    await expect(fsp.readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

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

describe('Project: cross-instance persistence lock', () => {
  it('open/reconcile waits through the live log-append -> manifest-rename commit window', async () => {
    const dir = freshDir('lock-open-vs-commit');
    const writer = await Project.create(dir, 'open-vs-commit');
    const renameReached = deferred();
    const allowRename = deferred();
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      const fromPath = String(from);
      if (String(to) === writer.manifestPath && fromPath.startsWith(`${writer.manifestPath}.tmp-1-`)) {
        renameReached.resolve();
        await allowRename.promise;
      }
      return realRename(from, to);
    });

    let commitPromise: Promise<Manifest> | undefined;
    try {
      commitPromise = writer.commit(0, 'ui', 'a', {}, 'commit a', (manifest) => ({
        ...manifest,
        name: 'committed',
      }));
      // commitLocked has appended rev 1, but project.json is intentionally
      // still rev 0. An unlocked open() would now truncate the live entry.
      await renameReached.promise;

      const openPromise = Project.open(dir);
      await expectStillPending(openPromise);

      allowRename.resolve();
      const [committed, reopened] = await Promise.all([commitPromise, openPromise]);
      expect(committed.revision).toBe(1);
      expect(reopened.warning).toBeUndefined();
      expect((await reopened.manifest()).revision).toBe(1);
      expect((await reopened.revisions()).map((entry) => entry.rev)).toEqual([1]);
      await expect(fsp.access(writer.lockPath)).rejects.toThrow();
    } finally {
      allowRename.resolve();
      await commitPromise?.catch(() => {});
      renameSpy.mockRestore();
    }
  });

  it('a commit waits for compact replacement, so compaction cannot drop the new log entry', async () => {
    const dir = freshDir('lock-compact-vs-commit');
    const seed = await Project.create(dir, 'compact-vs-commit');
    await seed.commit(0, 'ui', 'seed', {}, 'seed', (manifest) => manifest);
    const compactor = await Project.open(dir);
    const writer = await Project.open(dir);
    const renameReached = deferred();
    const allowRename = deferred();
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (
        String(to) === compactor.revisionsPath &&
        String(from).startsWith(`${compactor.revisionsPath}.tmp-compact-`)
      ) {
        renameReached.resolve();
        await allowRename.promise;
      }
      return realRename(from, to);
    });

    let compactPromise: ReturnType<Project['compact']> | undefined;
    let commitPromise: Promise<Manifest> | undefined;
    try {
      compactPromise = compactor.compact();
      await renameReached.promise;
      commitPromise = writer.commit(1, 'ui', 'after-compact', {}, 'after compact', (manifest) => ({
        ...manifest,
        name: 'after-compact',
      }));
      await expectStillPending(commitPromise);

      allowRename.resolve();
      await Promise.all([compactPromise, commitPromise]);
      const reopened = await Project.open(dir);
      expect((await reopened.manifest()).revision).toBe(2);
      expect((await reopened.revisions()).map((entry) => entry.rev)).toEqual([1, 2]);
      expect(reopened.warning).toBeUndefined();
    } finally {
      allowRename.resolve();
      await compactPromise?.catch(() => {});
      await commitPromise?.catch(() => {});
      renameSpy.mockRestore();
    }
  });

  it('fails with a typed, owner-identifying timeout instead of waiting forever', async () => {
    const dir = freshDir('lock-timeout');
    const holder = await Project.create(dir, 'timeout');
    const waiter = new Project(dir, { timeoutMs: 35, retryMs: 5 });
    const holderEntered = deferred();
    const releaseHolder = deferred();
    const heldCommit = holder.commit(0, 'ui', 'held', {}, 'held', async (manifest) => {
      holderEntered.resolve();
      await releaseHolder.promise;
      return manifest;
    });

    try {
      await holderEntered.promise;
      await expect(waiter.compact()).rejects.toMatchObject({
        code: 'PROJECT_LOCK_TIMEOUT',
        lockPath: holder.lockPath,
        timeoutMs: 35,
        owner: { pid: process.pid },
      });
    } finally {
      releaseHolder.resolve();
      await heldCommit;
    }
    await expect(fsp.access(holder.lockPath)).rejects.toThrow();
  });

  it('reclaims an abandoned lock after its owning process is gone', async () => {
    const dir = freshDir('lock-abandoned');
    const project = await Project.create(dir, 'abandoned');
    await fsp.writeFile(project.lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-process-token',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      processStartedAt: 0,
    }));

    const reopened = await Project.open(dir, { timeoutMs: 100, retryMs: 5 });
    expect((await reopened.manifest()).revision).toBe(0);
    await expect(fsp.access(project.lockPath)).rejects.toThrow();
  });
});

describe('Project: derived-work lock', () => {
  it('serializes the same work scope across independently opened project instances', async () => {
    const dir = freshDir('work-lock-same-scope');
    const first = await Project.create(dir, 'same-scope');
    const second = await Project.open(dir);
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const firstRun = first.withWorkLock('scenes-source1', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first';
    });
    await firstEntered.promise;

    let secondEntered = false;
    const secondRun = second.withWorkLock('scenes-source1', async () => {
      secondEntered = true;
      return 'second';
    });
    await expectStillPending(secondRun);
    expect(secondEntered).toBe(false);

    releaseFirst.resolve();
    await expect(firstRun).resolves.toBe('first');
    await expect(secondRun).resolves.toBe('second');
    expect(secondEntered).toBe(true);
  });

  it('allows independent work scopes to run concurrently', async () => {
    const dir = freshDir('work-lock-different-scopes');
    const project = await Project.create(dir, 'different-scopes');
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const firstRun = project.withWorkLock('scenes-source1', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    await expect(project.withWorkLock('scenes-source2', async () => 'second')).resolves.toBe('second');
    releaseFirst.resolve();
    await firstRun;
  });

  it('aborts promptly while waiting for a busy derived-work scope without entering the callback', async () => {
    const dir = freshDir('work-lock-abort-waiter');
    const holder = await Project.create(dir, 'abort-waiter');
    const waiter = await Project.open(dir);
    const holderEntered = deferred();
    const releaseHolder = deferred();
    const held = holder.withWorkLock('scenes-source1', async () => {
      holderEntered.resolve();
      await releaseHolder.promise;
    });
    await holderEntered.promise;
    const controller = new AbortController();
    let waiterEntered = false;
    const waiting = waiter.withWorkLock('scenes-source1', async () => {
      waiterEntered = true;
    }, controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError', message: 'operation cancelled' });
    expect(waiterEntered).toBe(false);
    releaseHolder.resolve();
    await held;
    await expect(fsp.access(path.join(dir, '.vedit-work-scenes-source1.lock'))).rejects.toThrow();
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

  it('rejects a sidecar staging failure before the revision becomes durable', async () => {
    const dir = freshDir('motion-stage-failure');
    const p = await Project.create(dir, 'motion-stage-failure');
    const withMotion = (m: Manifest): Manifest => ({
      ...m,
      timeline: { ...m.timeline, motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 0, duration: 2 }] },
    });
    await p.commit(0, 'ui', 'motion-add', {}, 'add', withMotion, {
      mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'v1' } },
    });

    const realWriteFile = fsp.writeFile.bind(fsp);
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file).includes('.tmp-sidecar-')) throw new Error('simulated staging disk failure');
      return realWriteFile(file, data, options as any);
    });
    try {
      await expect(p.commit(1, 'ui', 'motion-update', {}, 'update', (m) => m, {
        mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'MUST-NOT-COMMIT' } },
      })).rejects.toThrow(/simulated staging disk failure/);
    } finally {
      writeSpy.mockRestore();
    }

    expect((await p.manifest()).revision).toBe(1);
    expect((await p.revisions()).map((entry) => entry.rev)).toEqual([1]);
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'v1' } });
  });

  it('returns the committed revision when motion publication fails, then open repairs it from revision truth', async () => {
    const dir = freshDir('motion-publish-failure');
    const p = await Project.create(dir, 'motion-publish-failure');
    const withMotion = (m: Manifest): Manifest => ({
      ...m,
      timeline: { ...m.timeline, motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 0, duration: 2 }] },
    });
    await p.commit(0, 'ui', 'motion-add', {}, 'add', withMotion, {
      mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'OLD' } },
    });

    const target = p.motionSpecPath('mo1');
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target && String(from).includes('.tmp-sidecar-')) {
        throw new Error('simulated motion publish failure');
      }
      return realRename(from, to);
    });
    let committed: Manifest;
    try {
      committed = await p.commit(1, 'ui', 'motion-update', {}, 'update', (m) => m, {
        mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'NEW' } },
      });
    } finally {
      renameSpy.mockRestore();
    }

    // The manifest rename already crossed the commit boundary. Reporting a
    // rejected edit here would be a false rollback, so commit resolves and
    // exposes a recovery warning while revision-pinned reads stay exact.
    expect(committed.revision).toBe(2);
    expect((await p.manifest()).revision).toBe(2);
    expect((await p.revisions()).map((entry) => entry.rev)).toEqual([1, 2]);
    expect(p.warning).toMatch(/revision 2 was committed/);
    expect(p.warning).toMatch(/reopen the project/);
    const stalePhysical = JSON.parse(await fsp.readFile(target, 'utf8')) as { params: { text: string } };
    expect(stalePhysical).toMatchObject({ params: { text: 'OLD' } });
    expect(await p.readMotionSpec('mo1')).toMatchObject({ params: { text: 'NEW' } });
    expect((await p.captureRenderInputs(2)).motionSpecs.mo1).toMatchObject({ params: { text: 'NEW' } });

    // Continuing to edit before reopening must not promote the stale
    // compatibility file back into revision truth.
    const continued = await p.commit(2, 'ui', 'rename', {}, 'unrelated edit', (m) => ({
      ...m,
      name: 'continued safely',
    }));
    expect(continued.revision).toBe(3);
    expect((await p.captureRenderInputs(3)).motionSpecs.mo1).toMatchObject({ params: { text: 'NEW' } });

    const reopened = await Project.open(dir);
    expect(reopened.warning).toMatch(/repaired 1 compatibility sidecar/);
    expect(await reopened.readMotionSpec('mo1')).toMatchObject({ params: { text: 'NEW' } });
    expect((await reopened.captureRenderInputs(3)).motionSpecs.mo1).toMatchObject({ params: { text: 'NEW' } });
    expect((await fsp.readdir(p.motionDir)).filter((name) => name.includes('.tmp-sidecar-'))).toEqual([]);
  });
});

// ---- item 7: candidates decide + commit atomicity ----
describe('Project: decideCandidates atomicity', () => {
  function cand(over: Partial<CutCandidate> = {}): CutCandidate {
    return { id: 'c1', kind: 'silence', sourceId: 's1', t0: 2, t1: 3, wordIds: [], label: 'x', status: 'proposed', ...over };
  }

  async function projectWithSource(name: string): Promise<Project> {
    const p = await Project.create(freshDir(name), name);
    await p.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/a.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    }));
    return p;
  }

  it('approve applies the commit and rewrites candidates.json inside one critical section', async () => {
    const p = await projectWithSource('decide-ok');
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
    expect(result.manifest?.revision).toBe(2);
    expect(result.manifest?.name).toBe('cut-applied');
    expect(result.target.map((c) => c.id)).toEqual(['c1']);
    expect(result.all.find((c) => c.id === 'c1')?.status).toBe('approved');

    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('approved');
  });

  it('reject writes candidates.json without touching the manifest', async () => {
    const p = await projectWithSource('decide-reject');
    await p.writeCandidates([cand()]);
    const result = await p.decideCandidates((all) => all.filter((c) => c.status === 'proposed'), 'reject');
    expect(result.manifest).toBeUndefined();
    const m = await p.manifest();
    expect(m.revision).toBe(1);
    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('rejected');
  });

  it('throws "no matching pending candidates" and writes nothing when selection is empty', async () => {
    const p = await projectWithSource('decide-empty');
    await p.writeCandidates([cand({ status: 'approved' })]); // nothing left proposed
    await expect(p.decideCandidates((all) => all.filter((c) => c.status === 'proposed'), 'approve')).rejects.toThrow(
      /no matching pending candidates/,
    );
    const onDisk = await p.candidates();
    expect(onDisk[0].status).toBe('approved'); // untouched
  });

  it('leaves candidates.json untouched when the approve commit itself is rejected (stale baseRev)', async () => {
    const p = await projectWithSource('decide-stale');
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

  it('replays the durable decision if candidates.json fails after the timeline commit', async () => {
    const p = await projectWithSource('decide-sidecar-failure');
    await p.writeCandidates([cand()]);
    vi.spyOn(p as any, 'writeCandidatesLocked').mockRejectedValueOnce(new Error('simulated candidates rename failure'));

    await expect(p.decideCandidates(
      (all) => all.filter((candidate) => candidate.status === 'proposed'),
      'approve',
      (target, before) => ({
        baseRev: before.revision,
        actor: 'ui',
        op: 'apply-candidates',
        params: { ids: target.map((candidate) => candidate.id) },
        summary: 'applied before sidecar failure',
        mutate: (manifest) => ({ ...manifest, name: 'durable-cut' }),
      }),
    )).rejects.toThrow(/simulated candidates rename failure/);

    expect((await p.manifest()).name).toBe('durable-cut');
    expect((await p.candidates())[0].status).toBe('approved');
    await expect(
      p.decideCandidates(
        (all) => all.filter((candidate) => candidate.id === 'c1' && candidate.status === 'proposed'),
        'approve',
      ),
    ).rejects.toThrow(/no matching pending candidates/);
  });

  it('undo and redo keep an applied candidate decision in lockstep with the restored timeline', async () => {
    const dir = freshDir('decide-undo-redo');
    const p = await Project.create(dir, 'decide-undo-redo');
    await p.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/a.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'clip1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    await p.writeCandidates([cand()]);
    await p.decideCandidates(
      (all) => all.filter((c) => c.status === 'proposed'),
      'approve',
      (target, before) => ({
        baseRev: before.revision,
        actor: 'claude',
        op: 'apply-candidates',
        params: { ids: target.map((c) => c.id), mode: 'autonomous' },
        summary: 'AI first draft',
        mutate: (m) => ({ ...m, name: 'cut-applied' }),
      }),
    );
    expect((await p.candidates())[0].status).toBe('approved');

    await p.undo('ui', 2);
    expect((await p.candidates())[0].status).toBe('proposed');

    await p.redo('ui', 3);
    expect((await p.candidates())[0].status).toBe('approved');
  });

  it('hides candidates whose source exists only in an undone future branch, then restores them on redo', async () => {
    const p = await projectWithSource('candidate-membership');
    await p.commit(1, 'system', 'ingest', {}, 'add future source', (m) => ({
      ...m,
      sources: [
        ...m.sources,
        { id: 's2', path: '/media/b.mp4', duration: 5, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
    }));
    await p.writeCandidates([cand({ id: 'future', sourceId: 's2' })]);
    expect((await p.candidates()).map((candidate) => candidate.id)).toEqual(['future']);

    await p.undo('ui', 2);
    expect(await p.candidates()).toEqual([]);
    await expect(
      p.decideCandidates((all) => all.filter((candidate) => candidate.id === 'future'), 'approve'),
    ).rejects.toThrow(/no matching pending candidates/);

    await p.redo('ui', 3);
    expect((await p.candidates()).map((candidate) => candidate.id)).toEqual(['future']);
  });

  it('surfaces candidates.json corruption instead of treating it as an empty queue', async () => {
    const p = await projectWithSource('candidate-corrupt');
    await fsp.writeFile(p.candidatesPath, '{broken');
    await expect(p.candidates()).rejects.toThrow();
  });
});

describe('Project: revision-pinned transcripts', () => {
  const transcript = (text: string): Transcript => ({
    sourceId: 's1',
    language: 'ja',
    words: [{ id: 'w1', text, t0: 0, t1: 1, p: 0.99 }],
  });

  it('undo/redo restore the transcript sidecar and export capture with the matching revision', async () => {
    const p = await Project.create(freshDir('transcript-history'), 'transcript-history');
    await p.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/a.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    }));
    await p.commitTranscript(transcript('OLD'), 'system', { sourceId: 's1' }, 'old transcript');
    await p.commitTranscript(transcript('NEW'), 'system', { sourceId: 's1' }, 'new transcript');

    const undone = await p.undo('ui', 3);
    expect((await p.transcript('s1')).words[0].text).toBe('OLD');
    expect((await p.captureRenderInputs(undone.revision)).transcripts[0].words[0].text).toBe('OLD');

    const redone = await p.redo('ui', undone.revision);
    expect((await p.transcript('s1')).words[0].text).toBe('NEW');
    expect((await p.captureRenderInputs(redone.revision)).transcripts[0].words[0].text).toBe('NEW');

    // Simulate a crash after the revision became durable but before the
    // compatibility sidecar rename. open() repairs it from revision truth.
    await fsp.writeFile(p.transcriptPath('s1'), JSON.stringify(transcript('STALE')));
    await Project.open(p.dir);
    const repaired = JSON.parse(await fsp.readFile(p.transcriptPath('s1'), 'utf8')) as Transcript;
    expect(repaired.words[0].text).toBe('NEW');
  });

  it('returns the committed revision when transcript publication fails, then open repairs it from revision truth', async () => {
    const p = await Project.create(freshDir('transcript-publish-failure'), 'transcript-publish-failure');
    await p.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/a.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    }));
    await p.commitTranscript(transcript('OLD'), 'system', { sourceId: 's1' }, 'old transcript');

    const target = p.transcriptPath('s1');
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === target && String(from).includes('.tmp-sidecar-')) {
        throw new Error('simulated transcript publish failure');
      }
      return realRename(from, to);
    });
    let committed: Manifest;
    try {
      committed = await p.commitTranscript(
        transcript('NEW'),
        'system',
        { sourceId: 's1' },
        'new transcript',
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(committed.revision).toBe(3);
    expect((await p.manifest()).revision).toBe(3);
    expect((await p.revisions()).map((entry) => entry.rev)).toEqual([1, 2, 3]);
    expect(p.warning).toMatch(/revision 3 was committed/);
    expect(p.warning).toMatch(/transcript sidecar s1/);
    const stalePhysical = JSON.parse(await fsp.readFile(target, 'utf8')) as Transcript;
    expect(stalePhysical.words[0].text).toBe('OLD');
    expect((await p.transcript('s1')).words[0].text).toBe('NEW');
    expect((await p.captureRenderInputs(3)).transcripts[0].words[0].text).toBe('NEW');

    const reopened = await Project.open(p.dir);
    expect(reopened.warning).toMatch(/repaired 1 compatibility sidecar/);
    const repaired = JSON.parse(await fsp.readFile(target, 'utf8')) as Transcript;
    expect(repaired.words[0].text).toBe('NEW');
    expect((await reopened.transcript('s1')).words[0].text).toBe('NEW');
    expect((await reopened.captureRenderInputs(3)).transcripts[0].words[0].text).toBe('NEW');
    expect((await fsp.readdir(p.dir)).filter((name) => name.includes('.tmp-sidecar-'))).toEqual([]);
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
