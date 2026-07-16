import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Project } from '../core/project.js';
import { startDaemon } from './daemon.js';
import type { Word } from '../core/types.js';

function wordsFor(prefix: string, count: number, spacing = 1, dur = 0.8): Word[] {
  const out: Word[] = [];
  let t = 0.5;
  for (let i = 0; i < count; i++) {
    out.push({ id: `w${i.toString().padStart(4, '0')}`, text: `${prefix}${i}`, t0: t, t1: t + dur, p: 0.9 });
    t += spacing;
  }
  return out;
}

async function postJson(base: string, pathname: string, body: unknown) {
  const res = await fetch(base + pathname, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function getJson(base: string, pathname: string) {
  const res = await fetch(base + pathname);
  return { status: res.status, body: await res.json() };
}

async function getText(base: string, pathname: string) {
  const res = await fetch(base + pathname);
  return { status: res.status, text: await res.text() };
}

// ---- Suite 1: two transcribed sources (id collision / ambiguity surface) ----
describe('daemon: multi-source project', () => {
  const PORT = 18179;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-multi-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'multi');

    const w1 = wordsFor('s1w', 10);
    const w2 = wordsFor('s2w', 5);
    await project.writeTranscript({ sourceId: 's1', language: 'en', words: w1 });
    await project.writeTranscript({ sourceId: 's2', language: 'en', words: w2 });
    const dur1 = w1[w1.length - 1].t1 + 1;
    const dur2 = w2[w2.length - 1].t1 + 1;

    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: dur1, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
        { id: 's2', path: '/media/two.mp4', duration: dur2, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
      ],
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: dur1 },
          { id: 'c2', sourceId: 's2', srcIn: 0, srcOut: dur2 },
        ],
        motion: [],
      },
    }));

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('#1 rejects /api/edit for actor=claude without a numeric baseRev', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', op: 'captions', patch: { style: 'bold' } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
    expect(body.error).toMatch(/vedit status/);
  });

  it('#1 accepts /api/edit for actor=claude with an explicit numeric baseRev', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'captions', patch: { style: 'bold' } });
    expect(status).toBe(200);
  });

  it('#1 does not require baseRev for actor=ui', async () => {
    const { status } = await postJson(BASE, '/api/edit', { actor: 'ui', op: 'captions', patch: { style: 'clean' } });
    expect(status).toBe(200);
  });

  it('#1 rejects /api/candidates/decide for actor=claude without a numeric baseRev', async () => {
    const { status, body } = await postJson(BASE, '/api/candidates/decide', { actor: 'claude', ids: 'all', decision: 'reject' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
  });

  it('#7 remove-words without sourceId is rejected (word ids collide across sources)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'remove-words', ids: ['w0002'] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/multiple transcribed sources/);
    expect(body.sources.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('#7 remove-range without sourceId is rejected the same way', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'remove-range', t0: 200, t1: 201 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/multiple transcribed sources/);
  });

  it('#7 an explicit sourceId disambiguates and the edit proceeds', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'remove-words',
      ids: ['w0002'],
      sourceId: 's1',
    });
    expect(status).toBe(200);
    expect(body.removedSeconds).toBeGreaterThan(0);
  });

  it('#8 GET /api/transcript with no source concatenates all transcribed sources, headed', async () => {
    const { status, text } = await getText(BASE, '/api/transcript');
    expect(status).toBe(200);
    expect(text).toMatch(/## source s1 \(one\.mp4\) — use --source s1 for edits/);
    expect(text).toMatch(/## source s2 \(two\.mp4\) — use --source s2 for edits/);
  });

  it('#8 GET /api/transcript?full=1 with no source requires one, and lists the choices', async () => {
    const { status, body } = await getJson(BASE, '/api/transcript?full=1');
    expect(status).toBe(400);
    expect(body.error).toMatch(/multiple transcribed sources/);
    expect(body.sources.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('#8 GET /api/transcript?source=s2 returns only that source', async () => {
    const { status, text } = await getText(BASE, '/api/transcript?source=s2');
    expect(status).toBe(200);
    expect(text).toMatch(/source s2/);
    expect(text).not.toMatch(/s1w/);
  });
});

// ---- Suite 2: single source (padding / zero-width guard / removedSeconds) ----
describe('daemon: single-source project', () => {
  const PORT = 18180;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-single-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'single');

    const words = wordsFor('w', 5); // 0.5..4.8ish, 0.2s gaps between words
    words.push({ id: 'w0005', text: 'orphan', t0: 20, t1: 20, p: 0.9 }); // isolated, pre-collapsed
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    const dur = 25;

    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: dur, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: dur }], motion: [] },
    }));

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('#4/#5 pads the removal range and reports the frame-snapped removedSeconds', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'remove-words',
      ids: ['w0002'], // raw word duration 0.8s, 0.2s gap on each side
      sourceId: 's1',
    });
    expect(status).toBe(200);
    // default pad is 0.08s each side -> ~0.96s removed, comfortably more than the raw 0.8s word.
    expect(body.removedSeconds).toBeGreaterThan(0.85);
    expect(body.removedSeconds).toBeLessThan(1.0);

    const revs = (await getJson(BASE, '/api/revisions')).body;
    const last = revs[revs.length - 1];
    expect(last.summary).toContain(body.removedSeconds.toFixed(1));
  });

  it('#4 remove-words with pad=0 on an already zero-width word is rejected', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'remove-words',
      ids: ['w0005'],
      sourceId: 's1',
      pad: 0,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/nothing to remove/);
  });

  it('#4 remove-range with t0===t1 is rejected', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'remove-range',
      t0: 12,
      t1: 12,
      sourceId: 's1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/nothing to remove/);
  });
});

// ---- Suite 3: clip selection/reorder + reframe (P0 workflow ops) ----
describe('daemon: clip ops and reframe', () => {
  const PORT = 18181;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-clips-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'clips');

    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      width: 1920,
      height: 1080,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/media/two.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('clip-add appends a new clip and returns its id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'clip-add',
      sourceId: 's2',
      in: 2,
      out: 8,
    });
    expect(status).toBe(200);
    expect(body.clipId).toBeTruthy();

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video).toHaveLength(2);
    expect(project.manifest.timeline.video[1]).toMatchObject({ id: body.clipId, sourceId: 's2', srcIn: 2, srcOut: 8 });
  });

  it('clip-add rejects an unknown source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'clip-add',
      sourceId: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('clip-move reorders, then clip-remove drops a clip without touching its source', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let project = (await getJson(BASE, '/api/project')).body;
    const [c1, c2] = project.manifest.timeline.video;

    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-move', clipId: c2.id, before: c1.id });
    expect(r.status).toBe(200);
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video.map((c: any) => c.id)).toEqual([c2.id, c1.id]);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-remove', clipId: c2.id });
    expect(r.status).toBe(200);
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video.map((c: any) => c.id)).toEqual([c1.id]);
    expect(project.manifest.sources.some((s: any) => s.id === 's2')).toBe(true); // source stays in the pool
  });

  it('reframe sets output and stamps crop onto every clip; clip-crop adjusts one clip', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'reframe', spec: '9:16', focus: 'left' });
    expect(r.status).toBe(200);
    expect(r.body.output).toEqual({ width: 1080, height: 1920 });

    let project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.output).toEqual({ width: 1080, height: 1920 });
    const clipId = project.manifest.timeline.video[0].id;
    expect(project.manifest.timeline.video[0].crop).toEqual({ x: 0, y: 0 });

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-crop', clipId, x: 0.75 });
    expect(r.status).toBe(200);
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video[0].crop).toEqual({ x: 0.75, y: 0 });
  });

  it('reframe rejects an invalid spec', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'reframe', spec: 'nonsense' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid reframe spec/);
  });
});

// ---- Suite 4: scene index routes (list/note; detect shells out to ffmpeg and
// is covered by the pure functions in core/scenes.test.ts instead) ----
describe('daemon: scene index routes', () => {
  const PORT = 18182;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let project: Project;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-scenes-'));
    const dir = path.join(root, 'proj');
    project = await Project.create(dir, 'scenes');

    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: false }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));

    // Seed a scenes file directly (bypasses ffmpeg — detect itself is
    // exercised end-to-end only in the real-material smoke test).
    await project.writeScenes({
      sourceId: 's1',
      scenes: [
        { id: 's0001', t0: 0, t1: 12, thumb: 'cache/sc-s1-s0001.jpg', hasSpeech: false, energy: 0.1 },
        { id: 's0002', t0: 12, t1: 30, thumb: 'cache/sc-s1-s0002.jpg', hasSpeech: false, energy: 0.2 },
      ],
    });

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('GET /api/scenes returns the packed text list by default', async () => {
    const { status, text } = await getText(BASE, '/api/scenes');
    expect(status).toBe(200);
    expect(text).toMatch(/s0001 \[0:00\.0–0:12\.0\]/);
    expect(text).toMatch(/s0002 \[0:12\.0–0:30\.0\]/);
  });

  it('GET /api/scenes?source=s1&full=1 returns the raw SceneFile JSON', async () => {
    const { status, body } = await getJson(BASE, '/api/scenes?source=s1&full=1');
    expect(status).toBe(200);
    expect(body.sourceId).toBe('s1');
    expect(body.scenes).toHaveLength(2);
  });

  it('GET /api/scenes for a source with no scenes file yet returns an empty packed list', async () => {
    const { status, text } = await getText(BASE, '/api/scenes?source=nope');
    expect(status).toBe(200);
    expect(text).toMatch(/no scenes detected/);
  });

  it('POST /api/scenes/note records text + "by" provenance and an ISO timestamp', async () => {
    const { status, body } = await postJson(BASE, '/api/scenes/note', {
      sourceId: 's1',
      id: 's0001',
      text: 'エスカレーター上りの追い撮り',
      by: 'model',
    });
    expect(status).toBe(200);
    expect(body.scene.note).toMatchObject({ text: 'エスカレーター上りの追い撮り', by: 'model' });
    expect(new Date(body.scene.note.at).toString()).not.toBe('Invalid Date');

    const { text } = await getText(BASE, '/api/scenes?source=s1');
    expect(text).toMatch(/s0001.*エスカレーター上りの追い撮り \(by:model\)/);
  });

  it('POST /api/scenes/note rejects a "by" value other than user/model', async () => {
    const { status, body } = await postJson(BASE, '/api/scenes/note', {
      sourceId: 's1',
      id: 's0002',
      text: 'x',
      by: 'claude',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/by must be "user" or "model"/);
  });

  it('POST /api/scenes/note rejects an unknown scene id', async () => {
    const { status, body } = await postJson(BASE, '/api/scenes/note', {
      sourceId: 's1',
      id: 's9999',
      text: 'x',
      by: 'user',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown scene/);
  });
});
