import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http, { type Server } from 'node:http';
import { WebSocket } from 'ws';
import { Project } from '../core/project.js';
import { startDaemon } from './daemon.js';
import { writeKitFile } from '../core/kit.js';
import type { CutCandidate, KitFile, Word } from '../core/types.js';

// music-add shells out to ffprobe via probeAudio(); stub it so the "daemon:
// music ops" suite below stays fast/deterministic without needing ffmpeg
// installed (same approach as ingest.test.ts's run() mock). vi.mock is
// hoisted above the imports above by vitest's transform, so daemon.ts's own
// `import { probeAudio } from '../ingest/ingest.js'` picks up this stub too.
// Every other suite in this file is unaffected since none of them touch
// music-add.
// color-transform shells out to makeProxy() (real proxy regen would need
// real ffmpeg + real media files neither of which exist in these tests) —
// stub it too, same rationale as probeAudio below.
const { probeAudioMock, makeProxyMock } = vi.hoisted(() => ({
  probeAudioMock: vi.fn(async (file: string) => {
    if (file.includes('missing')) throw new Error('ffprobe failed: no such file');
    if (file.includes('novoice')) return { duration: 30, hasAudio: false };
    if (file.includes('short')) return { duration: 3, hasAudio: true };
    return { duration: 300, hasAudio: true };
  }),
  makeProxyMock: vi.fn(async () => undefined),
}));
vi.mock('../ingest/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/ingest.js')>();
  return { ...actual, probeAudio: probeAudioMock, makeProxy: makeProxyMock };
});

// POST /api/locate-media shells out to `mdfind` (macOS-only, and depends on
// what happens to be on the test host's disk) via locateMedia(); stub it so
// the "daemon: locate-media" suite is deterministic and OS-independent. Real
// locateMedia()/mdfindByName()/fingerprintFile() behavior is covered by
// src/ingest/locate.test.ts directly.
const { locateMediaMock } = vi.hoisted(() => ({
  locateMediaMock: vi.fn(async (name: string) => (name === 'findme.mp4' ? '/Volumes/Cards/findme.mp4' : null)),
}));
vi.mock('../ingest/locate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/locate.js')>();
  return { ...actual, locateMedia: locateMediaMock };
});

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

/**
 * Fire a POST whose headers land immediately (so the server's route()
 * synchronously captures `p = ctx.project` right away) but whose body isn't
 * sent until `delayMs` later — used to deterministically win a race against
 * a concurrent /api/open that reassigns ctx.project while this request is
 * still "parked" inside readBody(). Returns the eventual response promise
 * plus a promise that resolves once headers have been flushed locally.
 */
function postJsonDelayedBody(base: string, pathname: string, body: unknown, delayMs: number) {
  const bodyStr = JSON.stringify(body);
  const u = new URL(base + pathname);
  let resolveHeadersSent: () => void;
  const headersSent = new Promise<void>((res) => {
    resolveHeadersSent = res;
  });
  const promise = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.flushHeaders(); // send headers now, without waiting for the body
    resolveHeadersSent();
    setTimeout(() => req.end(bodyStr), delayMs);
  });
  return { promise, headersSent };
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

  it('remove-range that does not intersect any clip on the timeline is rejected without committing a revision', async () => {
    const revsBefore = (await getJson(BASE, '/api/revisions')).body;
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude',
      baseRev: state.revision,
      op: 'remove-range',
      t0: 500,
      t1: 501,
      sourceId: 's1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/does not intersect/);
    const revsAfter = (await getJson(BASE, '/api/revisions')).body;
    expect(revsAfter.length).toBe(revsBefore.length);
  });
});

// ---- Suite 2b: remove-words whose source range is no longer on the
// timeline (isolated project so it isn't coupled to Suite 2's mutations) ----
describe('daemon: remove-words with a source range already cut', () => {
  const PORT = 18185;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-nointersect-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'nointersect');

    const words = wordsFor('w', 5); // w0003 spans ~3.5..4.3
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

  it('is rejected once the word\'s source range has already been cut, instead of committing a no-op revision', async () => {
    // Cut a range that fully covers w0003 (3.5..4.3) outright.
    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'remove-range', t0: 3.0, t1: 5.0, sourceId: 's1',
    });
    expect(r.status).toBe(200);

    // The word id still resolves (word data is independent of the
    // timeline), but its source range is gone — must be a 400, not a
    // silent no-op commit.
    const revsBefore = (await getJson(BASE, '/api/revisions')).body;
    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'remove-words', ids: ['w0003'], sourceId: 's1', pad: 0,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not intersect/);
    const revsAfter = (await getJson(BASE, '/api/revisions')).body;
    expect(revsAfter.length).toBe(revsBefore.length);
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

  it('clip-add rejects an out beyond the source duration and a non-integer at', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-add', sourceId: 's2', in: 0, out: 9999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceeds source duration/);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-add', sourceId: 's2', at: 0.5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at \(0\.5\)/);
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

  it('clip-move and clip-remove reject an unknown clip id (400, not a silent no-op)', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-move', clipId: 'nope', before: 'end' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown clip/);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-remove', clipId: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown clip/);
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

  it('reframe rejects a degenerate 0x0 spec', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'reframe', spec: '0x0' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid reframe spec/);
  });

  it('clip-crop rejects an out-of-range x', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    const project = (await getJson(BASE, '/api/project')).body;
    const clipId = project.manifest.timeline.video[0].id;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-crop', clipId, x: 1.5 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/x \(1\.5\)/);
  });
});

// ---- Suite 3b: trim validation ----
describe('daemon: trim validation', () => {
  const PORT = 18191;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-trim-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'trim');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects an edge that is not exactly "in" or "out"', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'trim', clipId: 'c1', edge: 'left', frames: 1 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid edge/);
  });

  it('rejects non-integer frames', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'trim', clipId: 'c1', edge: 'in', frames: 1.5 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid frames/);
  });

  it('accepts a valid integer frame trim', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'trim', clipId: 'c1', edge: 'in', frames: 5 });
    expect(status).toBe(200);
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
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: false },
        // No scenes file for this one — distinct from a wholly unknown sourceId.
        { id: 's2', path: '/media/two.mp4', duration: 15, fps: 30, width: 1920, height: 1080, hasAudio: false },
      ],
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

  it('GET /api/scenes for a known source with no scenes file yet returns an empty packed list', async () => {
    const { status, text } = await getText(BASE, '/api/scenes?source=s2');
    expect(status).toBe(200);
    expect(text).toMatch(/no scenes detected/);
  });

  it('GET /api/scenes rejects a sourceId that is not in the manifest (404, not a silent empty list)', async () => {
    const { status, body } = await getJson(BASE, '/api/scenes?source=nope');
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown source/);
  });

  it('GET /api/scenes rejects a path-traversal sourceId (400/404, not a file read outside the project)', async () => {
    const { status, body } = await getJson(BASE, '/api/scenes?source=' + encodeURIComponent('../../../../etc/passwd'));
    expect([400, 404]).toContain(status);
    expect(body.error).toBeTruthy();
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

// ---- W2: 3-state scene culling (scene-review op, review-status, selects) ----
describe('daemon: scene culling (review / selects)', () => {
  const PORT = 18196;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let project: Project;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-culling-'));
    const dir = path.join(root, 'proj');
    project = await Project.create(dir, 'culling');

    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: false },
        { id: 's2', path: '/media/two.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: false },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));

    await project.writeScenes({
      sourceId: 's1',
      scenes: [
        { id: 'sc1', t0: 0, t1: 5, thumb: 'cache/sc-s1-sc1.jpg', hasSpeech: false, energy: 0.1 },
        { id: 'sc2', t0: 5, t1: 10, thumb: 'cache/sc-s1-sc2.jpg', hasSpeech: false, energy: 0.2 },
        { id: 'sc3', t0: 10, t1: 30, thumb: 'cache/sc-s1-sc3.jpg', hasSpeech: true, energy: 0.3 },
      ],
    });
    await project.writeScenes({
      sourceId: 's2',
      scenes: [{ id: 'sc1', t0: 0, t1: 10, thumb: 'cache/sc-s2-sc1.jpg', hasSpeech: false, energy: 0.4 }],
    });

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects /api/edit scene-review for actor=claude without a numeric baseRev', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', op: 'scene-review', sourceId: 's1', sceneIds: ['sc1'], review: 'keep',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
  });

  it('scene-review rejects an unknown source', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'ui', op: 'scene-review', sourceId: 'nope', sceneIds: ['sc1'], review: 'keep',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('scene-review rejects an invalid review value', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'ui', op: 'scene-review', sourceId: 's1', sceneIds: ['sc1'], review: 'maybe',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/must be "keep", "reject", or "clear"/);
  });

  it('scene-review rejects an unknown scene id without recording anything', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'ui', op: 'scene-review', sourceId: 's1', sceneIds: ['sc1', 'sc9999'], review: 'keep',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown scene id/);
    const { body: full } = await getJson(BASE, '/api/scenes?source=s1&full=1');
    expect(full.scenes.find((s: any) => s.id === 'sc1').review).toBeUndefined();
  });

  it('scene-review sets keep/reject for multiple sceneIds in one call, merged into GET /api/scenes', async () => {
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'ui', op: 'scene-review', sourceId: 's1', sceneIds: ['sc1', 'sc2'], review: 'keep',
    });
    expect(status).toBe(200);

    const { body: full } = await getJson(BASE, '/api/scenes?source=s1&full=1');
    expect(full.scenes.find((s: any) => s.id === 'sc1').review).toBe('keep');
    expect(full.scenes.find((s: any) => s.id === 'sc2').review).toBe('keep');
    expect(full.scenes.find((s: any) => s.id === 'sc3').review).toBeUndefined();

    const { text } = await getText(BASE, '/api/scenes?source=s1');
    expect(text).toMatch(/sc1 .*\[keep\]/);
    expect(text).toMatch(/sc2 .*\[keep\]/);
    expect(text).not.toMatch(/sc3 .*\[(keep|reject)\]/);
  });

  it('scene-review "clear" removes a previously-recorded verdict', async () => {
    await postJson(BASE, '/api/edit', { actor: 'ui', op: 'scene-review', sourceId: 's1', sceneIds: ['sc2'], review: 'clear' });
    const { body: full } = await getJson(BASE, '/api/scenes?source=s1&full=1');
    expect(full.scenes.find((s: any) => s.id === 'sc2').review).toBeUndefined();
    // sc1 (still 'keep' from the previous test) is untouched by clearing sc2.
    expect(full.scenes.find((s: any) => s.id === 'sc1').review).toBe('keep');
  });

  it('GET /api/review-status tallies keep/reject/unreviewed across sources and names the next unreviewed scene', async () => {
    await postJson(BASE, '/api/edit', { actor: 'ui', op: 'scene-review', sourceId: 's2', sceneIds: ['sc1'], review: 'reject' });
    const { status, body } = await getJson(BASE, '/api/review-status');
    expect(status).toBe(200);
    // sc1(s1)=keep, sc1(s2)=reject at this point in the suite; sc2(s1)/sc3(s1) unreviewed.
    expect(body.perSource).toEqual(
      expect.arrayContaining([
        { sourceId: 's1', total: 3, keep: 1, reject: 0, unreviewed: 2 },
        { sourceId: 's2', total: 1, keep: 0, reject: 1, unreviewed: 0 },
      ]),
    );
    expect(body.totals).toEqual({ total: 4, keep: 1, reject: 1, unreviewed: 2 });
    // First unreviewed scene in source order: s1/sc2 (sc1 is keep, sc2 has no verdict).
    expect(body.next).toEqual({ sourceId: 's1', sceneId: 'sc2' });
  });

  it('selects refuses to run (400) when nothing is marked keep', async () => {
    // Clear s1/sc1's 'keep' from earlier tests so nothing is keep for this check.
    const state0 = await getJson(BASE, '/api/state');
    await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state0.body.revision, op: 'scene-review', sourceId: 's1', sceneIds: ['sc1'], review: 'clear',
    });
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'ui', op: 'selects' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no scenes are marked "keep"/);
  });

  it('selects replaces the timeline with keep-scene clips, reporting previous/new clip counts', async () => {
    // Mark s1/sc1 and s1/sc3 keep, s2/sc1 stays 'reject' from earlier.
    await postJson(BASE, '/api/edit', { actor: 'ui', op: 'scene-review', sourceId: 's1', sceneIds: ['sc1', 'sc3'], review: 'keep' });
    const before = await getJson(BASE, '/api/project');
    expect(before.body.manifest.timeline.video).toHaveLength(1); // the original seeded clip c1

    const state = await getJson(BASE, '/api/state');
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.body.revision, op: 'selects',
    });
    expect(status).toBe(200);
    expect(body.previousClips).toBe(1);
    expect(body.newClips).toBe(2); // s1/sc1 [0,5) + s1/sc3 [10,30) — s2/sc1 is 'reject', not included

    const after = await getJson(BASE, '/api/project');
    const video = after.body.manifest.timeline.video;
    expect(video).toHaveLength(2);
    expect(video.map((c: any) => [c.sourceId, c.srcIn, c.srcOut])).toEqual([
      ['s1', 0, 5],
      ['s1', 10, 30],
    ]);
    // Replaced entirely — the original seeded clip c1 is gone.
    expect(video.some((c: any) => c.id === 'c1')).toBe(false);
  });

  it('selects rejects /api/edit for actor=claude without a numeric baseRev, same as any other mutating op', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', op: 'selects' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
  });
});

// ---- Suite 5: path containment (security) — /api/transcript, /media escape ----
describe('daemon: path containment (security)', () => {
  const PORT = 18186;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let root: string;
  let dir: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-security-'));
    dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'security');
    await project.writeTranscript({ sourceId: 's1', language: 'en', words: wordsFor('w', 3) });

    // A file OUTSIDE the project directory that a path-traversal attack
    // against /media might try to read via a manifest-supplied proxy path.
    await fsp.writeFile(path.join(root, 'secret.mp4'), 'TOP SECRET CONTENT');

    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [
        {
          id: 's1',
          path: '/media/one.mp4',
          duration: 10,
          fps: 30,
          width: 1920,
          height: 1080,
          hasAudio: true,
          transcribed: true,
          // Simulates a corrupted/tampered manifest: escapes the project dir.
          proxy: '../secret.mp4',
        },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('GET /media/proxy/<id> refuses to serve a manifest proxy path that escapes the project directory', async () => {
    const res = await fetch(`${BASE}/media/proxy/s1`);
    expect(res.status).not.toBe(200);
    const text = await res.text();
    expect(text).not.toContain('TOP SECRET CONTENT');
  });

  it('GET /api/transcript?source=<traversal> is rejected (source must exist in the manifest)', async () => {
    const { status, body } = await getJson(BASE, '/api/transcript?full=1&source=' + encodeURIComponent('x/../../../../etc/passwd'));
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown source/);
  });

  it('GET /api/transcript?source=s1&full=1 still works for a real source', async () => {
    const { status, body } = await getJson(BASE, '/api/transcript?source=s1&full=1');
    expect(status).toBe(200);
    expect(body.sourceId).toBe('s1');
  });

  it('GET /api/scenes?source=<traversal> is rejected the same way', async () => {
    const { status, body } = await getJson(BASE, '/api/scenes?source=' + encodeURIComponent('x/../../../../etc/passwd'));
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown source/);
  });
});

// ---- Suite 6: motion-update / motion-remove validation + traversal ----
describe('daemon: motion ops', () => {
  const PORT = 18187;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let motionId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-motion-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'motion');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('motion-add creates a spec and a timeline item', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'motion-add',
      spec: { type: 'chapter-card', params: { text: 'Intro' } }, tlStart: 0, duration: 2,
    });
    expect(status).toBe(200);
    motionId = body.id;
    expect(motionId).toBeTruthy();
  });

  it('motion-update rejects an id that is not on the timeline', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'motion-update', id: 'nope', tlStart: 1,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown motion item/);
  });

  it('motion-update rejects a path-traversal id (never touches project.json)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'motion-update', id: '../../project', spec: { type: 'chapter-card' },
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
    // project.json is still intact and parseable — the attack never landed.
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.name).toBe('motion');
  });

  it('GET /api/motion/<id> rejects an id with unsafe characters', async () => {
    const res = await fetch(`${BASE}/api/motion/..%2f..%2fproject`);
    expect(res.status).toBe(404);
  });

  it('motion-update with a valid id updates the spec and timeline placement', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'motion-update', id: motionId, tlStart: 5,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.motion[0].tlStart).toBe(5);
  });

  it('motion-remove rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'motion-remove', id: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown motion item/);
  });

  it('motion-remove with a valid id removes it', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'motion-remove', id: motionId,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.motion).toHaveLength(0);
  });
});

// ---- Suite 7: /api/open safety (corrupted project.json must not be clobbered) ----
describe('daemon: /api/open safety', () => {
  const PORT = 18188;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const started = await startDaemon({ port: PORT }); // no projectDir: nothing open yet
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects opening a corrupted project.json instead of silently recreating it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-corrupt-'));
    const dir = path.join(root, 'proj');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'project.json'), '{ this is not valid json');

    const { status, body } = await postJson(BASE, '/api/open', { dir });
    expect(status).not.toBe(200);
    expect(body.error).toBeTruthy();

    const raw = await fsp.readFile(path.join(dir, 'project.json'), 'utf8');
    expect(raw).toBe('{ this is not valid json'); // untouched — Project.create never ran
  });

  it('opening a genuinely missing project creates a fresh one', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-fresh-'));
    const dir = path.join(root, 'proj');
    const { status, body } = await postJson(BASE, '/api/open', { dir, name: 'fresh' });
    expect(status).toBe(200);
    expect(body.state.name).toBe('fresh');
  });
});

// ---- Suite 8: HTTP robustness — body size cap, Range header edge cases ----
describe('daemon: http robustness', () => {
  const PORT = 18189;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  const content = '0123456789AB'; // 12 bytes

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-http-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'http');
    await fsp.mkdir(project.cacheDir, { recursive: true });
    await fsp.writeFile(path.join(project.cacheDir, 'dummy.bin'), content);

    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{
        id: 's1', path: '/media/one.mp4', duration: 1, fps: 30, width: 1920, height: 1080, hasAudio: true,
        proxy: 'cache/dummy.bin',
      }],
      timeline: { video: [], motion: [] },
    }));

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('POST /api/edit rejects a body over the 10MB limit with 413', async () => {
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
    const res = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      body: JSON.stringify({ actor: 'ui', op: 'captions', patch: { note: huge } }),
    });
    expect(res.status).toBe(413);
  });

  it('GET /media with a suffix range (bytes=-N) returns the last N bytes', async () => {
    const res = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'bytes=-4' } });
    expect(res.status).toBe(206);
    const text = await res.text();
    expect(text).toBe('89AB');
    expect(res.headers.get('content-range')).toBe(`bytes 8-11/${content.length}`);
  });

  it('GET /media with an open-ended range (bytes=N-) returns from N to the end', async () => {
    const res = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'bytes=10-' } });
    expect(res.status).toBe(206);
    const text = await res.text();
    expect(text).toBe('AB');
  });

  it('GET /media with an end beyond the file size clamps to the last byte', async () => {
    const res = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'bytes=0-9999' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 0-11/${content.length}`);
  });

  it('GET /media with a start beyond the file size returns 416', async () => {
    const res = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'bytes=9999-10000' } });
    expect(res.status).toBe(416);
  });

  it('GET /media with an inverted range (start > end) returns 416', async () => {
    const res = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'bytes=10-2' } });
    expect(res.status).toBe(416);
  });

  it('GET /media with a malformed or multi-range header ignores it and serves the full body (200)', async () => {
    const res1 = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'bytes=0-3,6-9' } });
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe(content);

    const res2 = await fetch(`${BASE}/media/proxy/s1`, { headers: { range: 'not-a-range' } });
    expect(res2.status).toBe(200);
  });
});

// ---- Suite 9: project-switch mid-edit race (item 3 in the revision-store audit) ----
describe('daemon: project switch does not redirect an in-flight edit', () => {
  const PORT = 18190;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-race-'));
    dir = path.join(root, 'proj');
    await Project.create(dir, 'race-original');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('a commit whose body arrives after a concurrent /api/open still lands on the original project', async () => {
    const root2 = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-race-other-'));
    const dir2 = path.join(root2, 'proj2');

    const state = (await getJson(BASE, '/api/state')).body;
    // Headers land immediately (so route() captures `p` = the ORIGINAL
    // project synchronously), but the body — and therefore the actual
    // mutate()/commit() call — is delayed well past when /api/open below
    // has already reassigned ctx.project.
    const { promise: editPromise, headersSent } = postJsonDelayedBody(
      BASE,
      '/api/edit',
      { actor: 'claude', baseRev: state.revision, op: 'captions', patch: { style: 'race-should-land-here' } },
      150,
    );
    await headersSent;
    await new Promise((r) => setTimeout(r, 30)); // give the server time to actually receive/parse the headers

    const openResult = await postJson(BASE, '/api/open', { dir: dir2, name: 'other' });
    expect(openResult.status).toBe(200);

    const editResult = await editPromise;
    expect(editResult.status).toBe(200);

    // ctx.project has genuinely moved on to the second project...
    const ping = (await getJson(BASE, '/api/ping')).body;
    expect(ping.project).toBe(dir2);

    // ...but the edit committed against the ORIGINAL project directory, not
    // the one opened while it was in flight.
    const origRevsRaw = await fsp.readFile(path.join(dir, 'revisions.jsonl'), 'utf8');
    const origRevs = origRevsRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(origRevs.some((r: any) => r.op === 'captions' && r.summary.includes('race-should-land-here'))).toBe(true);

    // The new project's own log must NOT have picked up this edit.
    const newRevsRaw = await fsp.readFile(path.join(dir2, 'revisions.jsonl'), 'utf8').catch(() => '');
    expect(newRevsRaw).not.toMatch(/race-should-land-here/);
  });
});

// ---- Suite 10: captions patch maxCps validation (item 8) ----
describe('daemon: captions patch maxCps validation', () => {
  const PORT = 18192;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-maxcps-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'maxcps');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('accepts a valid maxCps (1..30) and stores it on captions', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { maxCps: 12 },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxCps).toBe(12);
  });

  it('rejects a maxCps outside 1..30', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { maxCps: 31 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/maxCps must be a number between 1 and 30/);
  });

  it('rejects a non-numeric maxCps', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { maxCps: 'fast' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/maxCps must be a number/);
  });
});

// ---- Suite 11: restore over HTTP requires baseRev (item 5) ----
describe('daemon: restore requires and validates baseRev', () => {
  const PORT = 18193;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-restore-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'restore-http');
    await project.commit(0, 'system', 'setup', {}, 'seed', (m) => ({ ...m, name: 'seeded' }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('restore without baseRev is rejected for actor=claude', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', op: 'restore', rev: 1 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
  });

  it('restore with a stale baseRev is rejected with 409', async () => {
    // rev1 exists (seeded), current is rev1 — pass an intentionally stale baseRev.
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 999, op: 'restore', rev: 1 });
    expect(status).toBe(409);
    expect(body.code).toBe('STALE_REVISION');
  });

  it('restore with a correct baseRev succeeds and advances the revision', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'restore', rev: 1 });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.revision).toBe(2);
  });
});

// ---- Suite 12: background music (Wave I) ----
describe('daemon: music ops', () => {
  const PORT = 18194;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let musicId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-music-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'music');
    // 20s timeline — shorter than probeAudioMock's default 300s source, so
    // an unspecified duration should default to the timeline's remaining
    // length, not the source's.
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 20 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('music-add rejects a missing path', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'music-add' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/path is required/);
  });

  it('music-add rejects a file ffprobe cannot read', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/missing.mp3',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/could not read/);
  });

  it('music-add rejects a file with no audio stream', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/novoice.mp4',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no audio stream/);
  });

  it('music-add with no explicit duration defaults to the shorter of source-remaining and timeline-remaining', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm.mp3', tlStart: 5,
    });
    expect(status).toBe(200);
    musicId = body.id;
    const project = (await getJson(BASE, '/api/project')).body;
    const mu = project.manifest.timeline.music.find((x: any) => x.id === musicId);
    // timeline remaining from tlStart=5 on a 20s timeline is 15s, source
    // remaining (300s mock duration) is far larger — timeline should win.
    expect(mu.duration).toBeCloseTo(15, 5);
    expect(mu.gain).toBe(-12); // default
    expect(mu.duck).toBe(true); // default
  });

  it('music-add with a short source caps the default duration at the source-remaining length', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/short.mp3', tlStart: 0,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const mu = project.manifest.timeline.music.find((x: any) => x.id === body.id);
    expect(mu.duration).toBeCloseTo(3, 5); // probeAudioMock('short') => 3s
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: project.manifest.revision, op: 'music-remove', id: body.id });
  });

  it('music-add rejects an out-of-range gain', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm.mp3', duration: 5, gain: 50,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/gain/);
  });

  it('/api/state reports the music count', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    expect(state.music).toBe(1);
  });

  it('music-update rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-update', id: 'nope', gain: -6,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown music item/);
  });

  it('music-update with a valid id patches the item', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-update', id: musicId, gain: -6, duck: false,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const mu = project.manifest.timeline.music.find((x: any) => x.id === musicId);
    expect(mu.gain).toBe(-6);
    expect(mu.duck).toBe(false);
  });

  it('audio-mix rejects an out-of-range target LUFS', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'audio-mix', targetLufs: 10,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/targetLufs/);
  });

  it('audio-mix with valid values patches manifest.audioMix', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'audio-mix', targetLufs: -16, duckAmount: -8, crossfadeMs: 20,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.audioMix).toEqual({ targetLufs: -16, duckAmount: -8, crossfadeMs: 20 });
  });

  it('music-remove rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-remove', id: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown music item/);
  });

  it('music-remove with a valid id removes it', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-remove', id: musicId,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.music).toHaveLength(0);
  });
});

// ---- Suite 13: audio-repair op (W1) + color warning in stateSummary ----
describe('daemon: audio-repair op and color warning', () => {
  const PORT = 18195;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-repair-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'repair');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [
        {
          id: 's1', path: '/media/hlg.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true,
          color: { transfer: 'arib-std-b67', primaries: 'bt2020' },
        },
        { id: 's2', path: '/media/normal.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true, color: { transfer: 'bt709' } },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 20 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects an unknown preset without touching the manifest', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'audio-repair', preset: 'studio',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/outdoor\/indoor\/wireless\/off/);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.audioRepair).toBeUndefined();
  });

  it('accepts a valid preset (+deess) and patches manifest.audioRepair', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'audio-repair', preset: 'outdoor', deess: true,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.audioRepair).toEqual({ preset: 'outdoor', deess: true });
  });

  it('/api/state surfaces colorWarning only for the HLG-tagged source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const s1 = state.sources.find((s: any) => s.id === 's1');
    const s2 = state.sources.find((s: any) => s.id === 's2');
    expect(s1.colorWarning).toMatch(/Log\/HLG/);
    expect(s2.colorWarning).toBeUndefined();
  });
});

// ---- Suite: B-roll V2 overlay ops (W3) ----
describe('daemon: broll (B-roll V2 overlay) ops', () => {
  const PORT = 18197;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let overlayId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-broll-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'broll');
    // A-roll (s1) with a cut: tl[0,10)<-src[0,10), tl[10,20)<-src[20,30) —
    // the gap src[10,20) is used below as the orphan target. s2 is B-roll.
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/aroll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/media/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
        motion: [],
      },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('broll-add rejects a missing anchor', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-add', sourceId: 's2', in: 0, out: 2,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/anchor/);
  });

  it('broll-add rejects an unknown B-roll source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-add', sourceId: 'nope', in: 0, out: 2,
      anchor: { sourceId: 's1', srcTime: 2 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown B-roll source/);
  });

  it('broll-add with a valid anchor creates a resolved overlay', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-add', sourceId: 's2', in: 0, out: 4,
      anchor: { sourceId: 's1', srcTime: 2 }, audioMode: 'mix', gainDb: -9,
    });
    expect(status).toBe(200);
    overlayId = body.id;
    expect(overlayId).toMatch(/^ov/);
    expect(body.state.overlays).toBe(1);
    expect(body.state.orphanedOverlays).toBeUndefined(); // resolved -> no orphan warning

    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.overlays.find((r: any) => r.overlay.id === overlayId);
    expect(resolved.tlStart).toBeCloseTo(2); // 1:1 mapping on the first (uncut) clip
    expect(resolved.overlay).toMatchObject({ sourceId: 's2', srcIn: 0, srcOut: 4, audioMode: 'mix', gainDb: -9 });
  });

  it('broll-add rejects a resolved-region overlap with the existing overlay', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-add', sourceId: 's2', in: 0, out: 4,
      anchor: { sourceId: 's1', srcTime: 3 }, // resolved tl[3,7) overlaps the existing [2,6)
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/overlaps existing overlay/);
  });

  it('broll-add with an anchor in the A-roll cut gap creates an ORPHANED overlay, surfaced in state', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-add', sourceId: 's2', in: 0, out: 2,
      anchor: { sourceId: 's1', srcTime: 15 }, // src[10,20) is the cut gap
    });
    expect(status).toBe(200);
    const orphanId = body.id;
    expect(body.state.overlays).toBe(2);
    expect(body.state.orphanedOverlays).toHaveLength(1);
    expect(body.state.orphanedOverlays[0].id).toBe(orphanId);
    expect(body.state.orphanedOverlays[0].reason).toMatch(/not on the timeline/);

    // broll-update re-anchoring it onto a live instant clears the orphan warning.
    const state2 = (await getJson(BASE, '/api/state')).body;
    const upd = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state2.revision, op: 'broll-update', id: orphanId,
      anchor: { sourceId: 's1', srcTime: 22 },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.state.orphanedOverlays).toBeUndefined();
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.overlays.find((r: any) => r.overlay.id === orphanId);
    expect(resolved.tlStart).toBeCloseTo(12); // tl[10,20)<-src[20,30): src22 -> tl12

    // clean up so later tests in this suite see only `overlayId`.
    const state3 = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state3.revision, op: 'broll-remove', id: orphanId });
  });

  it('broll-update rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-update', id: 'nope', audioMode: 'mute',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown overlay/);
  });

  it('broll-update rejects a malformed anchor', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-update', id: overlayId, anchor: { sourceId: 's1' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/anchor/);
  });

  it('broll-update with a valid id patches audioMode/gainDb', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-update', id: overlayId, audioMode: 'replace', gainDb: -20,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.overlays.find((r: any) => r.overlay.id === overlayId);
    expect(resolved.overlay.audioMode).toBe('replace');
    expect(resolved.overlay.gainDb).toBe(-20);
  });

  it('broll-remove rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-remove', id: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown overlay/);
  });

  it('broll-remove with a valid id removes it', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'broll-remove', id: overlayId,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.overlays).toHaveLength(0);
    const finalState = (await getJson(BASE, '/api/state')).body;
    expect(finalState.overlays).toBe(0);
  });
});

// ---- Suite: color-transform / color-adjust ops (W5) ----
describe('daemon: color-transform and color-adjust ops', () => {
  const PORT = 18198;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;
  let lutPath: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-color-'));
    dir = path.join(root, 'proj');
    lutPath = path.join(root, 'test.cube');
    await fsp.writeFile(lutPath, 'LUT_3D_SIZE 2\n');
    const project = await Project.create(dir, 'color');
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/hlg.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true, proxy: 'cache/proxy-s1.mp4' },
        { id: 's2', path: '/media/noproxy.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 20 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('color-transform rejects an unknown source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-transform', sourceId: 'nope', type: 'hlg',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('color-transform rejects an unrecognized type without touching the manifest', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-transform', sourceId: 's1', type: 'dlog',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/hlg\/pq\/lut\/none/);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.sources.find((s: any) => s.id === 's1').colorTransform).toBeUndefined();
  });

  it('color-transform rejects type "lut" without --lut', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-transform', sourceId: 's1', type: 'lut',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/--lut/);
  });

  it('color-transform rejects a lut path that does not exist on disk', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-transform', sourceId: 's1', type: 'lut', lut: '/nope/x.cube',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/lut file not found/);
  });

  it('color-transform accepts type "hlg", patches colorTransform, and regenerates the proxy (source has one)', async () => {
    makeProxyMock.mockClear();
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-transform', sourceId: 's1', type: 'hlg',
    });
    expect(status).toBe(200);
    expect(body.proxyRegenerated).toBe(true);
    expect(makeProxyMock).toHaveBeenCalledTimes(1);
    const [file, outPath, , colorTransform] = makeProxyMock.mock.calls[0];
    expect(file).toBe('/media/hlg.mp4');
    expect(outPath).toBe(path.join(dir, 'cache/proxy-s1.mp4'));
    expect(colorTransform).toEqual({ type: 'hlg' });
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.sources.find((s: any) => s.id === 's1').colorTransform).toEqual({ type: 'hlg' });
  });

  it('color-transform accepts type "lut" with an existing path and skips proxy regen for a source with none', async () => {
    makeProxyMock.mockClear();
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-transform', sourceId: 's2', type: 'lut', lut: lutPath,
    });
    expect(status).toBe(200);
    expect(body.proxyRegenerated).toBe(false);
    expect(makeProxyMock).not.toHaveBeenCalled();
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.sources.find((s: any) => s.id === 's2').colorTransform).toEqual({ type: 'lut', lut: lutPath });
  });

  it('color-adjust rejects an unknown source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-adjust', sourceId: 'nope', exposure: 0.3,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('color-adjust rejects an out-of-range value without touching the manifest', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-adjust', sourceId: 's1', exposure: 5,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/exposure/);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.colorAdjust).toBeUndefined();
  });

  it('color-adjust patches manifest.colorAdjust for the given source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'color-adjust', sourceId: 's1', exposure: 0.3, wb: -10, sat: 1.1,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.colorAdjust).toEqual({ s1: { exposure: 0.3, wb: -10, sat: 1.1 } });
  });
});

// ---- Suite: W8 kit (kit-link / kit-unlink / /api/kit) ----
describe('daemon: kit-link / kit-unlink / /api/kit', () => {
  const PORT = 18199;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;
  let kitDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-kit-'));
    dir = path.join(root, 'proj');
    kitDir = path.join(root, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      profile: { tone_tags: ['calm'] },
      styles: [{ id: 'kitStyle1', label: 'Kit Style' }],
      defaults: { captions_style: 'kitStyle1' },
    };
    await writeKitFile(kitDir, kit);
    const project = await Project.create(dir, 'kit');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('/api/kit returns {path:null,kit:null} before any kit is linked', async () => {
    const { status, body } = await getJson(BASE, '/api/kit');
    expect(status).toBe(200);
    expect(body).toEqual({ path: null, kit: null });
  });

  it('kit-link rejects a directory with no kit.json', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'kit-link', path: path.join(kitDir, 'nope'),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/kit-init/);
  });

  it('kit-link succeeds: recognizes sections, applies defaults.captions_style, and is reflected in /api/project + /api/state', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'kit-link', path: kitDir,
    });
    expect(status).toBe(200);
    expect(body.path).toBe(kitDir);
    expect(body.recognizedSections.sort()).toEqual(['defaults', 'profile', 'styles']);
    expect(body.appliedDefaults).toEqual(['captions_style -> kitStyle1']);

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.kit).toEqual({ path: kitDir });
    expect(project.manifest.captions.style).toBe('kitStyle1'); // applied at link time

    const finalState = (await getJson(BASE, '/api/state')).body;
    expect(finalState.kit).toEqual({ path: kitDir });
  });

  it('/api/kit now returns the linked kit content with recognizedSections', async () => {
    const { status, body } = await getJson(BASE, '/api/kit');
    expect(status).toBe(200);
    expect(body.path).toBe(kitDir);
    expect(body.kit.profile).toEqual({ tone_tags: ['calm'] });
    expect(body.recognizedSections.sort()).toEqual(['defaults', 'profile', 'styles']);
  });

  it('kit-unlink clears manifest.kit', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'kit-unlink',
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.kit).toBeUndefined();
    const kitRes = await getJson(BASE, '/api/kit');
    expect(kitRes.body).toEqual({ path: null, kit: null });
  });
});

// ---- Suite: W8 sprite ops ----
describe('daemon: W8 sprite ops', () => {
  const PORT = 18200;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;
  let spriteId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-sprite-'));
    dir = path.join(root, 'proj');
    const kitDir = path.join(root, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      assets: [{ id: 'char1', path: 'assets/characters/char1.png', type: 'sprite' }],
    };
    await writeKitFile(kitDir, kit);

    const project = await Project.create(dir, 'sprite');
    // A-roll (s1) with a cut: tl[0,10)<-src[0,10), tl[10,20)<-src[20,30) —
    // the gap src[10,20) is used below as the orphan target.
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      kit: { path: kitDir },
      sources: [{ id: 's1', path: '/media/aroll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
        motion: [],
      },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('sprite-add rejects an unknown kit asset id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'nope', anchor: { sourceId: 's1', srcTime: 2 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown kit asset/);
  });

  it('sprite-add rejects a missing anchor', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/anchor/);
  });

  it('sprite-add with a valid assetId+anchor creates a resolved sprite', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1',
      anchor: { sourceId: 's1', srcTime: 2 }, duration: 3, position: { x: 0.5, y: 0.9 }, scale: 0.3,
    });
    expect(status).toBe(200);
    spriteId = body.id;
    expect(spriteId).toMatch(/^sp/);
    expect(body.state.sprites).toBe(1);
    expect(body.state.orphanedSprites).toBeUndefined();

    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.sprites.find((r: any) => r.sprite.id === spriteId);
    expect(resolved.tlStart).toBeCloseTo(2);
    expect(resolved.sprite).toMatchObject({ assetId: 'char1', duration: 3, scale: 0.3 });
  });

  it('sprite-add with an anchor in the A-roll cut gap creates an ORPHANED sprite, surfaced in state', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1',
      anchor: { sourceId: 's1', srcTime: 15 }, // src[10,20) is the cut gap
    });
    expect(status).toBe(200);
    const orphanId = body.id;
    expect(body.state.sprites).toBe(2);
    expect(body.state.orphanedSprites).toHaveLength(1);
    expect(body.state.orphanedSprites[0].id).toBe(orphanId);
    expect(body.state.orphanedSprites[0].reason).toMatch(/not on the timeline/);

    // sprite-update re-anchoring it onto a live instant clears the orphan warning.
    const state2 = (await getJson(BASE, '/api/state')).body;
    const upd = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state2.revision, op: 'sprite-update', id: orphanId,
      anchor: { sourceId: 's1', srcTime: 22 },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.state.orphanedSprites).toBeUndefined();
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.sprites.find((r: any) => r.sprite.id === orphanId);
    expect(resolved.tlStart).toBeCloseTo(12); // tl[10,20)<-src[20,30): src22 -> tl12

    // clean up so later tests in this suite see only `spriteId`.
    const state3 = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state3.revision, op: 'sprite-remove', id: orphanId });
  });

  it('sprite-update rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-update', id: 'nope', opacity: 0.5,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown sprite/);
  });

  it('sprite-update patches opacity/scale', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-update', id: spriteId, opacity: 0.6, scale: 0.5,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.sprites.find((r: any) => r.sprite.id === spriteId);
    expect(resolved.sprite.opacity).toBe(0.6);
    expect(resolved.sprite.scale).toBe(0.5);
  });

  it('sprite-remove rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-remove', id: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown sprite/);
  });

  it('sprite-remove with a valid id removes it', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-remove', id: spriteId,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.sprites).toHaveLength(0);
    const finalState = (await getJson(BASE, '/api/state')).body;
    expect(finalState.sprites).toBe(0);
  });
});

// ---- Suite: sprite-add without any kit linked ----
describe('daemon: sprite-add without a linked kit', () => {
  const PORT = 18201;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-nosprite-kit-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'nokit');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('sprite-add is rejected with a clear message when no kit is linked', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1', anchor: { sourceId: 's1', srcTime: 1 },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no kit linked/);
  });
});

// ---- Suite: /media/kit path containment (security) ----
describe('daemon: /media/kit path containment (security)', () => {
  const PORT = 18202;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let kitDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-kitmedia-'));
    const dir = path.join(root, 'proj');
    kitDir = path.join(root, 'kit');
    await fsp.mkdir(path.join(kitDir, 'fonts'), { recursive: true });
    await fsp.writeFile(path.join(kitDir, 'fonts', 'MyFont.ttf'), 'fake-font-bytes');
    await fsp.mkdir(path.join(kitDir, 'assets', 'characters'), { recursive: true });
    await fsp.writeFile(path.join(kitDir, 'assets', 'characters', 'char1.png'), 'fake-png-bytes');
    // A file OUTSIDE the kit directory a traversal attempt might try to read.
    await fsp.writeFile(path.join(root, 'secret.txt'), 'TOP SECRET CONTENT');
    await writeKitFile(kitDir, { version: 'vedit-kit/v1' });

    const project = await Project.create(dir, 'kitmedia');
    await project.commit(0, 'system', 'setup', {}, 'seed', (m) => ({ ...m, kit: { path: kitDir } }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('serves a real font file with the correct content-type', async () => {
    const res = await fetch(`${BASE}/media/kit/fonts/MyFont.ttf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('font/ttf');
    expect(await res.text()).toBe('fake-font-bytes');
  });

  it('serves a real asset PNG under a nested subfolder', async () => {
    const res = await fetch(`${BASE}/media/kit/assets/characters/char1.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('refuses a traversal attempt that would escape the kit directory', async () => {
    const res = await fetch(`${BASE}/media/kit/${encodeURIComponent('../secret.txt')}`);
    expect(res.status).not.toBe(200);
    const text = await res.text();
    expect(text).not.toContain('TOP SECRET CONTENT');
  });

  it('404s for a font/asset that does not exist', async () => {
    const res = await fetch(`${BASE}/media/kit/fonts/nope.ttf`);
    expect(res.status).toBe(404);
  });

  it('404s with "no kit linked" when the project has no kit', async () => {
    const root2 = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-kitmedia-nolink-'));
    const dir2 = path.join(root2, 'proj');
    await Project.create(dir2, 'nolink');
    const port2 = 18203;
    const started2 = await startDaemon({ port: port2, projectDir: dir2 });
    try {
      const res = await fetch(`http://localhost:${port2}/media/kit/fonts/MyFont.ttf`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/no kit linked/);
    } finally {
      await new Promise((resolve) => started2.server.close(() => resolve(undefined)));
    }
  });
});

// ---- W-UI companion channel: POST /api/show (W-UI §0) ----
function wsUrlOf(base: string): string {
  return base.replace(/^http/, 'ws') + '/ws';
}
function openWs(base: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlOf(base));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function nextWsMessage(ws: WebSocket, predicate?: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for a ws message'));
    }, timeoutMs);
    const onMessage = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('daemon: show channel (W-UI §0, single transcribed source)', () => {
  const PORT = 18210;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-show-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'show');
    await project.writeTranscript({ sourceId: 's1', language: 'en', words: wordsFor('w', 6) });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const cand: CutCandidate = { id: 'cand1', kind: 'silence', sourceId: 's1', t0: 5, t1: 6, wordIds: [], label: '無音 1.0s', status: 'proposed' };
    await project.writeCandidates([cand]);

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;

    // Build a small revision history for the "compare" tests below:
    // r1 (seed, 30s) -> r2 (captions patch, no duration change) -> r3 (trim, -1s).
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 1, op: 'captions', patch: { style: 'bold' } });
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 2, op: 'trim', clipId: 'c1', edge: 'out', frames: -30 });
  });

  afterAll(() => server.close());

  it('does not create a revision (pure UI cue)', async () => {
    const before = (await getJson(BASE, '/api/state')).body.revision;
    const { status } = await postJson(BASE, '/api/show', { kind: 'range', tlStart: 1, tlEnd: 2 });
    expect(status).toBe(200);
    const after = (await getJson(BASE, '/api/state')).body.revision;
    expect(after).toBe(before);
  });

  it('kind=range: normalizes a reversed tlStart/tlEnd and broadcasts it over the websocket', async () => {
    const ws = await openWs(BASE);
    try {
      const waiting = nextWsMessage(ws, (m) => m.type === 'show');
      const { status, body } = await postJson(BASE, '/api/show', { kind: 'range', tlStart: 7.5, tlEnd: 6.3 });
      expect(status).toBe(200);
      expect(body.directive).toEqual({ kind: 'range', tlStart: 6.3, tlEnd: 7.5 });
      const msg = await waiting;
      expect(msg).toEqual({ type: 'show', directive: { kind: 'range', tlStart: 6.3, tlEnd: 7.5 } });
    } finally {
      ws.close();
    }
  });

  it('kind=range: rejects non-finite bounds', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'range', tlStart: 'x', tlEnd: 2 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/finite numbers/);
  });

  it('kind=words: defaults sourceId to the single transcribed source and expands a w0000..w0002 range', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'words', ids: ['w0000..w0002'] });
    expect(status).toBe(200);
    expect(body.directive).toEqual({ kind: 'words', sourceId: 's1', ids: ['w0000', 'w0001', 'w0002'] });
  });

  it('kind=words: rejects an unknown sourceId', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'words', sourceId: 'nope', ids: ['w0000'] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('kind=words: rejects an empty ids array', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'words', sourceId: 's1', ids: [] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/ids is required/);
  });

  it('kind=candidate: accepts a known candidate id', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'candidate', id: 'cand1' });
    expect(status).toBe(200);
    expect(body.directive).toEqual({ kind: 'candidate', id: 'cand1' });
  });

  it('kind=candidate: rejects an unknown candidate id', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'candidate', id: 'nope' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown candidate/);
  });

  it('kind=source: accepts a known sourceId with an optional "at", rejects an unknown one', async () => {
    const ok = await postJson(BASE, '/api/show', { kind: 'source', sourceId: 's1', at: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body.directive).toEqual({ kind: 'source', sourceId: 's1', at: 3 });

    const noAt = await postJson(BASE, '/api/show', { kind: 'source', sourceId: 's1' });
    expect(noAt.body.directive).toEqual({ kind: 'source', sourceId: 's1' });

    const bad = await postJson(BASE, '/api/show', { kind: 'source', sourceId: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('kind=compare: accepts "r"-prefixed revision refs, computes duration delta and the op list between them', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'compare', revA: 'r1', revB: 'r3' });
    expect(status).toBe(200);
    expect(body.directive.revA).toBe(1);
    expect(body.directive.revB).toBe(3);
    expect(body.directive.durationA).toBe(30);
    expect(body.directive.durationB).toBe(29);
    expect(body.directive.deltaSeconds).toBeCloseTo(-1, 5);
    expect(body.directive.ops.map((o: any) => o.op)).toEqual(['captions', 'trim']);
  });

  it('kind=compare: rejects an out-of-range revision', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'compare', revA: 1, revB: 999 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown revision/);
  });

  it('rejects an unknown kind', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'teleport' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown show kind/);
  });
});

describe('daemon: show words (ambiguous multi-source project)', () => {
  const PORT = 18211;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-show-ambig-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'show-ambig');
    await project.writeTranscript({ sourceId: 's1', language: 'en', words: wordsFor('a', 3) });
    await project.writeTranscript({ sourceId: 's2', language: 'en', words: wordsFor('b', 3) });
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
        { id: 's2', path: '/media/two.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects show words with no sourceId when multiple sources are transcribed', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'words', ids: ['w0000'] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/multiple transcribed sources/);
    expect(body.sources).toHaveLength(2);
  });

  it('an explicit sourceId disambiguates', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'words', sourceId: 's2', ids: ['w0000'] });
    expect(status).toBe(200);
    expect(body.directive.sourceId).toBe('s2');
  });
});

// ---- drag-and-drop ingest: POST /api/locate-media + POST /api/upload (W-UI §4) ----
describe('daemon: locate-media', () => {
  const PORT = 18212;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-locate-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'locate');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('returns found:true with the resolved path when locateMedia finds a match', async () => {
    const { status, body } = await postJson(BASE, '/api/locate-media', {
      name: 'findme.mp4', size: 123, headSha256: 'aa', tailSha256: 'bb',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ found: true, path: '/Volumes/Cards/findme.mp4' });
  });

  it('returns found:false when nothing matches', async () => {
    const { status, body } = await postJson(BASE, '/api/locate-media', {
      name: 'nowhere.mp4', size: 123, headSha256: 'aa', tailSha256: 'bb',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ found: false, path: null });
  });

  it('rejects a request missing required fingerprint fields', async () => {
    const { status, body } = await postJson(BASE, '/api/locate-media', { name: 'x.mp4', size: 10 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name, size, headSha256, tailSha256/);
  });
});

describe('daemon: upload', () => {
  const PORT = 18213;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let projectDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-upload-'));
    projectDir = path.join(root, 'proj');
    await Project.create(projectDir, 'upload');
    const started = await startDaemon({ port: PORT, projectDir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('streams the request body to project/media/<sanitized name> and reports bytes written', async () => {
    const content = 'x'.repeat(5000);
    const res = await fetch(`${BASE}/api/upload?${new URLSearchParams({ name: 'my clip.mp4' })}`, {
      method: 'POST',
      body: content,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bytes).toBe(content.length);
    expect(body.path).toBe(path.join(projectDir, 'media', 'my clip.mp4'));
    const written = await fsp.readFile(body.path, 'utf8');
    expect(written).toBe(content);
  });

  it('sanitizes a path-traversal-y filename down to a safe basename inside media/', async () => {
    const res = await fetch(`${BASE}/api/upload?${new URLSearchParams({ name: '../../etc/evil.mp4' })}`, {
      method: 'POST',
      body: 'hi',
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.path.startsWith(path.join(projectDir, 'media'))).toBe(true);
    expect(body.path).not.toContain('..');
  });

  it('de-duplicates a second upload of the same filename instead of clobbering the first', async () => {
    const params = new URLSearchParams({ name: 'dup.mp4' });
    const first = await fetch(`${BASE}/api/upload?${params}`, { method: 'POST', body: 'first' });
    const second = await fetch(`${BASE}/api/upload?${params}`, { method: 'POST', body: 'second-longer' });
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.path).not.toBe(secondBody.path);
    expect(await fsp.readFile(firstBody.path, 'utf8')).toBe('first');
    expect(await fsp.readFile(secondBody.path, 'utf8')).toBe('second-longer');
  });

  it('defaults to a safe filename when none is given', async () => {
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: 'no-name-given' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(path.basename(body.path)).toMatch(/^upload(-\d+)?\.bin$/);
  });
});
