import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http, { type Server } from 'node:http';
import { WebSocket } from 'ws';
import { Project, resolveRedoTarget, resolveUndoTarget } from '../core/project.js';
import { startDaemon } from './daemon.js';
import { writeKitFile } from '../core/kit.js';
import { appendExportResult, type ExportResultRecord } from '../core/exportResults.js';
import {
  exportJobPartialPath as exportJobPartialPathForTest,
  readExportJob as readExportJobForTest,
  writeExportJob as writeExportJobForTest,
} from '../core/exportJob.js';
import { appendNote } from '../core/notes.js';
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
// POST /api/transcribe (W-LAZY) shells out to whisper via transcribe(); stub
// it so the "daemon: transcribe job" suite below is fast/deterministic
// without needing whisper-cli/a real model installed. Default resolves
// immediately with a tiny fabricated transcript; individual tests override
// it (mockImplementationOnce / mockReset+mockImplementation) to control
// timing (double-start guard) or simulate failure (transcribe-error).
const { probeAudioMock, makeProxyMock, transcribeMock } = vi.hoisted(() => ({
  probeAudioMock: vi.fn(async (file: string) => {
    if (file.includes('missing')) throw new Error('ffprobe failed: no such file');
    if (file.includes('novoice')) return { duration: 30, hasAudio: false };
    if (file.includes('short')) return { duration: 3, hasAudio: true };
    return { duration: 300, hasAudio: true };
  }),
  makeProxyMock: vi.fn(async () => undefined),
  transcribeMock: vi.fn(async (_file: string, sourceId: string, opts?: { language?: string; glossary?: string[]; signal?: AbortSignal }) => ({
    sourceId,
    language: opts?.language ?? 'ja',
    words: [{ id: 'w0000', text: 'hello', t0: 0, t1: 1, p: 0.9 }],
  })),
}));
vi.mock('../ingest/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/ingest.js')>();
  return { ...actual, probeAudio: probeAudioMock, makeProxy: makeProxyMock, transcribe: transcribeMock };
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

// GET /api/fonts shells out to a real filesystem walk of the system font
// directories (+ optionally `fc-list`) via listSystemFonts/scanKitFonts —
// stub both so the "daemon: GET /api/fonts" suite is deterministic and
// doesn't depend on what happens to be installed on the test host. Real
// scanning/caching behavior is covered directly by src/core/fonts.test.ts.
const { listSystemFontsMock, scanKitFontsMock } = vi.hoisted(() => ({
  listSystemFontsMock: vi.fn(async () => [{ family: 'Hiragino Sans' }, { family: 'Noto Sans JP' }]),
  scanKitFontsMock: vi.fn(async () => [{ name: 'MyFont-Bold', path: 'fonts/MyFont-Bold.ttf' }]),
}));
vi.mock('../core/fonts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/fonts.js')>();
  return { ...actual, listSystemFonts: listSystemFontsMock, scanKitFonts: scanKitFontsMock };
});

// App-triggered MP4 jobs call the shared render orchestration. Daemon route
// tests exercise job lifecycle/path/revision/cancellation; actual ffmpeg and
// result-record behavior is covered by projectRender/render tests and the
// real smoke, so keep this file deterministic with a tiny partial file.
const { renderProjectMp4Mock } = vi.hoisted(() => ({
  renderProjectMp4Mock: vi.fn(async (_project: any, outPath: string, opts: any) => {
    await opts.onPhase?.('preparing');
    await opts.onPhase?.('encoding');
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(outPath, 'mock-mp4');
    await opts.onPhase?.('finalizing');
    await opts.finalize?.();
    return { file: opts.recordFile ?? outPath, revision: opts.manifest.revision, warnings: [] };
  }),
}));
vi.mock('../export/projectRender.js', () => ({ renderProjectMp4: renderProjectMp4Mock }));

// GET /media/thumb/<sourceId> shells out to ffmpeg via run() (src/ingest/run.ts)
// to extract a poster frame — stub it so the "daemon: GET /media/thumb" suite
// is deterministic and doesn't need real ffmpeg/media files. The mock records
// the args it was invoked with (so a test can assert the -ss value chosen for
// an image vs. a video source) and writes a tiny placeholder file to the
// requested output path (ffmpeg's last positional arg), mirroring real
// ffmpeg's contract of "produces a file there" so the route's downstream
// createReadStream still succeeds. No other suite in this file hits
// /media/thumb, so this stub can't affect them.
const { runMock, sceneRunCaptureMock } = vi.hoisted(() => ({
  runMock: vi.fn(async (_cmd: string, args: string[]) => {
    if (args.some((arg) => arg.includes('managed-ingest-fail'))) {
      throw new Error('forced probe failure for managed-upload cleanup');
    }
    const outPath = args[args.length - 1];
    const { promises: fs } = await import('node:fs');
    await fs.writeFile(outPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return '';
  }),
  sceneRunCaptureMock: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('../ingest/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ingest/run.js')>();
  return { ...actual, run: runMock, runCapture: (...args: unknown[]) => sceneRunCaptureMock(...args) };
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
  const project = pathname === '/api/open' ? null : (await (await fetch(base + '/api/ping')).json()).project;
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(project ? { 'x-vedit-project-dir': encodeURIComponent(project) } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getJson(base: string, pathname: string) {
  const res = await fetch(base + pathname);
  return { status: res.status, body: await res.json() };
}

async function deleteJson(base: string, pathname: string) {
  const project = (await (await fetch(base + '/api/ping')).json()).project;
  const res = await fetch(base + pathname, {
    method: 'DELETE',
    headers: project ? { 'x-vedit-project-dir': encodeURIComponent(project) } : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function getText(base: string, pathname: string) {
  const res = await fetch(base + pathname);
  return { status: res.status, text: await res.text() };
}

function websocketHandshakeStatus(base: string, options: ConstructorParameters<typeof WebSocket>[1] = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', options);
    let settled = false;
    ws.once('open', () => {
      settled = true;
      resolve(101);
      ws.close();
    });
    ws.once('unexpected-response', (_req, response) => {
      settled = true;
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    ws.once('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function rawHttpGet(base: string, pathname: string, hostHeader: string): Promise<{ status: number; body: any }> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method: 'GET',
      headers: { host: hostHeader },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fire a POST whose headers land immediately (so the server's route()
 * synchronously captures `p = ctx.project` right away) but whose body isn't
 * sent until `delayMs` later — used to deterministically win a race against
 * a concurrent /api/open that reassigns ctx.project while this request is
 * still "parked" inside readBody(). Returns the eventual response promise
 * plus a promise that resolves once headers have been flushed locally.
 */
function postJsonDelayedBody(base: string, pathname: string, body: unknown, delayMs: number, expectedProjectDir: string) {
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
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
          'x-vedit-project-dir': encodeURIComponent(expectedProjectDir),
        },
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

describe('daemon: browser mutation boundary', () => {
  const PORT = 18263;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let projectDir: string;
  let alternateDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-browser-boundary-'));
    // Exercise the percent-encoded header contract used by Fetch/CLI for
    // real-world Unicode project paths, not only ASCII temp directories.
    projectDir = path.join(root, '案件-a');
    alternateDir = path.join(root, '案件-b');
    await Project.create(projectDir, 'project-a');
    await Project.create(alternateDir, 'project-b');
    server = (await startDaemon({ port: PORT, projectDir })).server;
  });

  afterAll(() => server.close());

  it('rejects a cross-origin JSON edit before it can advance the revision', async () => {
    const before = (await getJson(BASE, '/api/state')).body;
    const res = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ui', baseRev: before.revision, op: 'captions', patch: { style: 'bold' } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/cross-origin/);
    expect((await getJson(BASE, '/api/state')).body.revision).toBe(before.revision);
  });

  it('rejects a simple text/plain mutation even when it has no Origin header', async () => {
    const before = (await getJson(BASE, '/api/state')).body;
    const res = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ actor: 'ui', baseRev: before.revision, op: 'captions', patch: { style: 'bold' } }),
    });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/application\/json/);
    expect((await getJson(BASE, '/api/state')).body.revision).toBe(before.revision);
  });

  it('accepts same-origin browser JSON and Origin-less CLI JSON with project identity, including /api/open', async () => {
    const before = (await getJson(BASE, '/api/state')).body;
    const edit = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      headers: {
        origin: BASE,
        'content-type': 'application/json',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      body: JSON.stringify({ actor: 'ui', baseRev: before.revision, op: 'captions', patch: { style: 'bold' } }),
    });
    expect(edit.status).toBe(200);

    const hostileOpen = await fetch(`${BASE}/api/open`, {
      method: 'POST',
      headers: { origin: 'http://attacker.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ dir: alternateDir }),
    });
    expect(hostileOpen.status).toBe(403);
    expect((await getJson(BASE, '/api/ping')).body.project).toBe(projectDir);

    const cliOpen = await fetch(`${BASE}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: alternateDir }),
    });
    expect(cliOpen.status).toBe(200);
    expect((await getJson(BASE, '/api/ping')).body.project).toBe(alternateDir);
  });

  it('rejects cross-origin and simple uploads, while same-origin binary upload still streams', async () => {
    expect((await postJson(BASE, '/api/open', { dir: alternateDir })).status).toBe(200);
    const blockedOrigin = await fetch(`${BASE}/api/upload?name=origin-blocked.mp4`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/octet-stream' },
      body: 'blocked',
    });
    expect(blockedOrigin.status).toBe(403);

    const blockedSimple = await fetch(`${BASE}/api/upload?name=simple-blocked.mp4`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'blocked',
    });
    expect(blockedSimple.status).toBe(415);

    const accepted = await fetch(`${BASE}/api/upload?name=accepted.mp4`, {
      method: 'POST',
      headers: {
        origin: BASE,
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(alternateDir),
      },
      body: 'video-bytes',
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(await fsp.readFile(acceptedBody.path, 'utf8')).toBe('video-bytes');
    await expect(fsp.stat(path.join(alternateDir, 'media', 'origin-blocked.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(path.join(alternateDir, 'media', 'simple-blocked.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects non-loopback Host and cross-site Origin on reads and static UI', async () => {
    const hostileHost = await rawHttpGet(BASE, '/api/state', 'attacker.example');
    expect(hostileHost.status).toBe(403);
    expect(hostileHost.body.error).toMatch(/Host/);

    const hostileOrigin = await fetch(`${BASE}/api/state`, { headers: { origin: 'https://attacker.example' } });
    expect(hostileOrigin.status).toBe(403);
    expect((await hostileOrigin.json()).error).toMatch(/cross-origin/);

    const crossSiteStatic = await fetch(`${BASE}/`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSiteStatic.status).toBe(403);

    const sameOrigin = await fetch(`${BASE}/api/state`, { headers: { origin: BASE, 'sec-fetch-site': 'same-origin' } });
    expect(sameOrigin.status).toBe(200);
  });

  it('applies the same loopback Host/Origin boundary to WebSocket upgrades', async () => {
    expect(await websocketHandshakeStatus(BASE, { headers: { host: 'attacker.example' } })).toBe(403);
    expect(await websocketHandshakeStatus(BASE, { origin: 'https://attacker.example' })).toBe(403);
    expect(await websocketHandshakeStatus(BASE, { origin: BASE })).toBe(101);
    // Native local clients have no Origin and remain compatible.
    expect(await websocketHandshakeStatus(BASE)).toBe(101);
  });

  it('requires project identity and rejects a stale A mutation after switching to same-revision B', async () => {
    expect((await postJson(BASE, '/api/open', { dir: projectDir })).status).toBe(200);
    const stateA = (await getJson(BASE, '/api/state')).body;
    const projectB = await Project.open(alternateDir);
    let manifestB = await projectB.manifest();
    while (manifestB.revision < stateA.revision) {
      manifestB = await projectB.commit(
        manifestB.revision,
        'system',
        'test-align-revision',
        {},
        'align B revision with A',
        (manifest) => manifest,
      );
    }
    expect((await postJson(BASE, '/api/open', { dir: alternateDir })).status).toBe(200);
    const beforeB = (await getJson(BASE, '/api/state')).body;
    expect(beforeB.revision).toBe(stateA.revision);

    const missing = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ui', baseRev: beforeB.revision, op: 'captions', patch: { style: 'missing-id' } }),
    });
    expect(missing.status).toBe(428);
    expect((await missing.json()).code).toBe('PROJECT_IDENTITY_REQUIRED');

    const staleA = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      // A and B genuinely have the same revision. Revision locking alone
      // would accept this even though the old control belonged to A.
      body: JSON.stringify({ actor: 'ui', baseRev: stateA.revision, op: 'captions', patch: { style: 'must-not-land-on-b' } }),
    });
    expect(staleA.status).toBe(409);
    expect((await staleA.json()).code).toBe('PROJECT_IDENTITY_MISMATCH');
    expect((await getJson(BASE, '/api/state')).body.revision).toBe(beforeB.revision);
  });

  it('binds upload -> ingest to the project where the upload started', async () => {
    expect((await postJson(BASE, '/api/open', { dir: projectDir })).status).toBe(200);
    const uploaded = await fetch(`${BASE}/api/upload?name=bound.mp4`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      body: 'uploaded-to-a',
    });
    expect(uploaded.status).toBe(200);
    const uploadBody = await uploaded.json();
    expect(uploadBody.projectDir).toBe(projectDir);

    expect((await postJson(BASE, '/api/open', { dir: alternateDir })).status).toBe(200);
    const beforeB = (await getJson(BASE, '/api/state')).body;
    const staleSecondStep = await fetch(`${BASE}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      body: JSON.stringify({ file: uploadBody.path }),
    });
    expect(staleSecondStep.status).toBe(409);
    expect((await staleSecondStep.json()).code).toBe('PROJECT_IDENTITY_MISMATCH');
    expect((await getJson(BASE, '/api/state')).body).toMatchObject({ revision: beforeB.revision, sources: [] });
  });
});

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

  it('#1 applies the same optimistic-lock contract to the provider-neutral agent actor', async () => {
    const missing = await postJson(BASE, '/api/edit', { actor: 'agent', op: 'captions', patch: { style: 'bold' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/baseRev is required/);

    const state = (await getJson(BASE, '/api/state')).body;
    const accepted = await postJson(BASE, '/api/edit', {
      actor: 'agent', baseRev: state.revision, op: 'captions', patch: { style: 'bold' },
    });
    expect(accepted.status).toBe(200);
  });

  it('#1 rejects unknown actors instead of letting them bypass agent locking', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'codex-pretending-to-be-ui', baseRev: state.revision, op: 'captions', patch: { style: 'clean' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid actor/);
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

  it('clip-audio sets gainDb and muted on one clip, and muted:false clears the flag again', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let project = (await getJson(BASE, '/api/project')).body;
    const clipId = project.manifest.timeline.video[0].id;

    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-audio', clipId, gainDb: -6, muted: true });
    expect(r.status).toBe(200);
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video[0]).toMatchObject({ gainDb: -6, muted: true });

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-audio', clipId, muted: false });
    expect(r.status).toBe(200);
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video[0].gainDb).toBe(-6); // untouched by the muted-only patch
    expect(project.manifest.timeline.video[0].muted).toBeUndefined();
  });

  it('clip-audio rejects an out-of-range gainDb and an unknown clip', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    const project = (await getJson(BASE, '/api/project')).body;
    const clipId = project.manifest.timeline.video[0].id;

    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-audio', clipId, gainDb: 20 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gainDb \(20\)/);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'clip-audio', clipId: 'nope', gainDb: -3 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown clip/);
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
    const project = (await (await fetch(`${BASE}/api/ping`)).json()).project;
    const res = await fetch(`${BASE}/api/edit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vedit-project-dir': encodeURIComponent(project),
      },
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

describe('daemon: static/media regular-file streaming resilience', () => {
  const PORT = 18316;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let staticDir: string;
  let staticRoute: string;
  let racePath: string;
  let movedRacePath: string;
  const raceContent = Buffer.alloc(2 * 1024 * 1024, 0x5a);

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-file-serving-'));
    const projectDir = path.join(root, 'proj');
    const project = await Project.create(projectDir, 'file-serving');
    await fsp.mkdir(project.cacheDir, { recursive: true });
    await fsp.mkdir(path.join(project.cacheDir, 'proxy-is-directory'));
    racePath = path.join(project.cacheDir, 'race.bin');
    movedRacePath = path.join(project.cacheDir, 'race-moved.bin');
    await fsp.writeFile(racePath, raceContent);
    await project.commit(0, 'system', 'setup', {}, 'seed file-serving sources', (m) => ({
      ...m,
      sources: [
        { id: 'sdir', path: '/media/dir.mp4', duration: 1, fps: 30, width: 16, height: 16, hasAudio: false, proxy: 'cache/proxy-is-directory' },
        { id: 'smissing', path: '/media/missing.mp4', duration: 1, fps: 30, width: 16, height: 16, hasAudio: false, proxy: 'cache/disappeared.bin' },
        { id: 'srace', path: '/media/race.mp4', duration: 1, fps: 30, width: 16, height: 16, hasAudio: false, proxy: 'cache/race.bin' },
      ],
    }));

    // A static directory is the deterministic EISDIR case that previously
    // escaped the surrounding statSync try/catch from createReadStream's
    // asynchronous 'error' event.
    staticDir = await fsp.mkdtemp(path.join(process.cwd(), 'web', '.daemon-static-dir-'));
    staticRoute = `/${path.basename(staticDir)}/`;
    server = (await startDaemon({ port: PORT, projectDir })).server;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (staticDir) await fsp.rm(staticDir, { recursive: true, force: true });
  });

  it('404s for static and media directories without an unhandled EISDIR or daemon crash', async () => {
    const staticResponse = await fetch(BASE + staticRoute);
    expect(staticResponse.status).toBe(404);
    expect((await fetch(`${BASE}/media/proxy/sdir`)).status).toBe(404);
    expect((await getJson(BASE, '/api/ping')).body.ok).toBe(true);
  });

  it('404s a disappeared media path and remains healthy', async () => {
    expect((await fetch(`${BASE}/media/proxy/smissing`)).status).toBe(404);
    expect((await getJson(BASE, '/api/ping')).body.ok).toBe(true);
  });

  it('keeps streaming the opened inode when its pathname is renamed and replaced by a directory', async () => {
    const response = await fetch(`${BASE}/media/proxy/srace`);
    expect(response.status).toBe(200);
    await fsp.rename(racePath, movedRacePath);
    await fsp.mkdir(racePath);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(raceContent);
    expect((await fetch(`${BASE}/media/proxy/srace`)).status).toBe(404);
    expect((await getJson(BASE, '/api/ping')).body.ok).toBe(true);
  }, 15_000);
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
      dir,
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

  it('music-add passes b.role through to addMusic (persisted on the item)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm.mp3', tlStart: 0, duration: 5, role: 'sfx',
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const mu = project.manifest.timeline.music.find((x: any) => x.id === body.id);
    expect(mu.role).toBe('sfx');
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: project.manifest.revision, op: 'music-remove', id: body.id });
  });

  it('music-add rejects an invalid role — addMusic\'s runtime guard throws, converted to 400 by the generic route() catch', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm.mp3', tlStart: 0, duration: 5, role: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/role/);
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

  it('color-transform emits an explicit terminal done event after proxy regeneration', async () => {
    makeProxyMock.mockClear();
    const ws = await openWs(BASE);
    try {
      const terminal = nextWsMessage(ws, (m) => m.type === 'color-transform-done');
      const state = (await getJson(BASE, '/api/state')).body;
      const response = await postJson(BASE, '/api/edit', {
        actor: 'agent', baseRev: state.revision, op: 'color-transform', sourceId: 's1', type: 'pq',
      });
      expect(response.status).toBe(200);
      const message = await terminal;
      expect(message).toMatchObject({
        type: 'color-transform-done', projectDir: dir, sourceId: 's1', proxyRegenerated: true,
      });
      expect(message.taskId).toMatch(/^color/);
    } finally {
      ws.close();
    }
  });

  it('color-transform emits a terminal error that says the setting committed when proxy regeneration fails', async () => {
    makeProxyMock.mockRejectedValueOnce(new Error('proxy regeneration exploded'));
    const ws = await openWs(BASE);
    try {
      const terminal = nextWsMessage(ws, (m) => m.type === 'color-transform-error');
      const state = (await getJson(BASE, '/api/state')).body;
      const response = await postJson(BASE, '/api/edit', {
        actor: 'agent', baseRev: state.revision, op: 'color-transform', sourceId: 's1', type: 'hlg',
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/proxy regeneration exploded/);
      await expect(terminal).resolves.toMatchObject({
        type: 'color-transform-error', projectDir: dir, sourceId: 's1', committed: true,
        error: 'proxy regeneration exploded',
      });
      const project = (await getJson(BASE, '/api/project')).body;
      expect(project.manifest.sources.find((s: any) => s.id === 's1').colorTransform).toEqual({ type: 'hlg' });
    } finally {
      ws.close();
    }
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
      expect(msg).toMatchObject({ type: 'show', directive: { kind: 'range', tlStart: 6.3, tlEnd: 7.5 } });
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

// ---- N2 デザイン波「計器盤」K6「押している間、直前」: GET /api/manifest-at ----
// 読み取り専用(revisionSnapshot を再利用 — /api/show kind=compare と同じ
// 関数、revisions.jsonl から再構成するだけで一切コミットしない)。
describe('daemon: GET /api/manifest-at (N2 K6 "押している間、直前")', () => {
  const PORT = 18257;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-manifest-at-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'manifest-at');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;

    // r1 (seed, 30s) -> r2 (trim -1s => 29s) -> r3 (captions patch, no duration change).
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 1, op: 'trim', clipId: 'c1', edge: 'out', frames: -30 });
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 2, op: 'captions', patch: { style: 'bold' } });
  });

  afterAll(() => server.close());

  it('reconstructs the manifest/segments/duration as of an earlier revision, without committing anything', async () => {
    const before = (await getJson(BASE, '/api/state')).body.revision;
    const { status, body } = await getJson(BASE, '/api/manifest-at?revision=1');
    expect(status).toBe(200);
    expect(body.revision).toBe(1);
    expect(body.duration).toBe(30);
    expect(body.segments).toHaveLength(1);
    expect(body.manifest.captions.style).not.toBe('bold'); // pre-captions-patch snapshot
    const after = (await getJson(BASE, '/api/state')).body.revision;
    expect(after).toBe(before); // read-only GET — no new revision committed
  });

  it("reflects a later revision's timeline change (trim -1s)", async () => {
    const { status, body } = await getJson(BASE, '/api/manifest-at?revision=2');
    expect(status).toBe(200);
    expect(body.duration).toBe(29);
    expect(body.manifest.captions.style).not.toBe('bold'); // trim landed before the captions patch
  });

  it('the response shape matches GET /api/project (manifest/segments/duration/overlays/sprites/dialogue/backgroundIntervals)', async () => {
    const { body } = await getJson(BASE, '/api/manifest-at?revision=2');
    expect(Object.keys(body).sort()).toEqual(
      ['backgroundIntervals', 'dialogue', 'duration', 'manifest', 'overlays', 'revision', 'segments', 'sprites'].sort(),
    );
  });

  it('rejects revision=0 (pristine pre-history — nothing for the hold-to-compare UI to show)', async () => {
    const { status, body } = await getJson(BASE, '/api/manifest-at?revision=0');
    expect(status).toBe(400);
    expect(body.error).toMatch(/revision must be an integer/);
  });

  it('rejects a non-integer revision', async () => {
    const { status, body } = await getJson(BASE, '/api/manifest-at?revision=1.5');
    expect(status).toBe(400);
    expect(body.error).toMatch(/revision must be an integer/);
  });

  it('rejects a revision beyond the current one', async () => {
    const { status, body } = await getJson(BASE, '/api/manifest-at?revision=999');
    expect(status).toBe(400);
    expect(body.error).toMatch(/revision must be an integer/);
  });

  it('rejects a missing revision param', async () => {
    const { status, body } = await getJson(BASE, '/api/manifest-at');
    expect(status).toBe(400);
    expect(body.error).toMatch(/revision must be an integer/);
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

describe('daemon: ingest task terminal state', () => {
  const PORT = 18310;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let projectDir: string;
  let brokenFile: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-ingest-terminal-'));
    projectDir = path.join(root, 'proj');
    brokenFile = path.join(root, 'broken.mp4');
    await Project.create(projectDir, 'ingest-terminal');
    server = (await startDaemon({ port: PORT, projectDir })).server;
  });

  afterAll(() => server.close());

  it('emits ingest-error after ingest-start when probing fails, so browser busy state can settle', async () => {
    const ws = await openWs(BASE);
    try {
      const started = nextWsMessage(ws, (m) => m.type === 'ingest-start');
      const terminal = nextWsMessage(ws, (m) => m.type === 'ingest-error');
      const response = await postJson(BASE, '/api/ingest', { file: brokenFile, scenes: false });
      expect(response.status).toBe(400);
      const startMessage = await started;
      expect(startMessage).toMatchObject({ type: 'ingest-start', projectDir, file: brokenFile });
      const message = await terminal;
      expect(message).toMatchObject({ type: 'ingest-error', projectDir, file: brokenFile });
      expect(message.taskId).toBe(startMessage.taskId);
      expect(message.error).toBeTruthy();
    } finally {
      ws.close();
    }
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
      headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
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
      headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      body: 'hi',
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.path.startsWith(path.join(projectDir, 'media'))).toBe(true);
    expect(body.path).not.toContain('..');
  });

  it('de-duplicates a second upload of the same filename instead of clobbering the first', async () => {
    const params = new URLSearchParams({ name: 'dup.mp4' });
    const first = await fetch(`${BASE}/api/upload?${params}`, {
      method: 'POST', headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      }, body: 'first',
    });
    const second = await fetch(`${BASE}/api/upload?${params}`, {
      method: 'POST', headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      }, body: 'second-longer',
    });
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.path).not.toBe(secondBody.path);
    expect(await fsp.readFile(firstBody.path, 'utf8')).toBe('first');
    expect(await fsp.readFile(secondBody.path, 'utf8')).toBe('second-longer');
  });

  it('atomically reserves 24 concurrent same-name uploads without path collisions or overwritten payloads', async () => {
    const payloads = Array.from({ length: 24 }, (_, i) => `parallel-payload-${i}-${'x'.repeat(i * 17)}`);
    const responses = await Promise.all(payloads.map(async (payload) => {
      const res = await fetch(`${BASE}/api/upload?${new URLSearchParams({ name: 'parallel.mp4' })}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-vedit-project-dir': encodeURIComponent(projectDir),
        },
        body: payload,
      });
      expect(res.status).toBe(200);
      return res.json();
    }));

    const paths = responses.map((body) => body.path as string);
    expect(new Set(paths).size).toBe(payloads.length);
    expect(responses.every((body) => typeof body.uploadToken === 'string' && body.uploadToken.length > 0)).toBe(true);
    await Promise.all(responses.map(async (body, i) => {
      expect(await fsp.readFile(body.path, 'utf8')).toBe(payloads[i]);
    }));
  });

  it('removes only the managed upload when its token-linked ingest fails', async () => {
    const uploaded = await fetch(`${BASE}/api/upload?name=managed-ingest-fail.mp4`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      body: 'not a real video',
    });
    expect(uploaded.status).toBe(200);
    const receipt = await uploaded.json();
    expect(await fsp.readFile(receipt.path, 'utf8')).toBe('not a real video');

    const ingest = await postJson(BASE, '/api/ingest', {
      file: receipt.path,
      uploadToken: receipt.uploadToken,
      scenes: false,
    });
    expect(ingest.status).toBe(400);
    await expect(fsp.access(receipt.path)).rejects.toThrow();
  });

  it('never deletes a pre-existing user file after an unrelated ingest failure', async () => {
    const userFile = path.join(projectDir, 'media', 'user-owned-invalid.mp4');
    await fsp.writeFile(userFile, 'user bytes must remain');
    const before = await fsp.stat(userFile);
    const ingest = await postJson(BASE, '/api/ingest', { file: userFile, scenes: false });
    expect(ingest.status).toBe(400);
    // daemon.test's ffprobe stub writes a tiny placeholder to its final arg,
    // so byte equality is intentionally not meaningful in this mocked
    // harness.  The ownership invariant is that the pre-existing inode was
    // not unlinked by failed-upload cleanup.
    const after = await fsp.stat(userFile);
    expect(after.isFile()).toBe(true);
    expect(after.ino).toBe(before.ino);
  });

  it('rejects a replacement before ingest and never deletes it when presented with the original upload token', async () => {
    const uploaded = await fetch(`${BASE}/api/upload?name=managed-ingest-fail-replaced.mp4`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      },
      body: 'daemon-owned bytes',
    });
    const receipt = await uploaded.json();
    expect(uploaded.status).toBe(200);

    await fsp.unlink(receipt.path);
    const replacement = 'replacement user bytes that must not be deleted';
    await fsp.writeFile(receipt.path, replacement);
    const ingest = await postJson(BASE, '/api/ingest', {
      file: receipt.path,
      uploadToken: receipt.uploadToken,
      scenes: false,
    });
    expect(ingest.status).toBe(409);
    expect(ingest.body).toMatchObject({ code: 'UPLOAD_IDENTITY_MISMATCH' });
    expect(await fsp.readFile(receipt.path, 'utf8')).toBe(replacement);

    // The stale one-shot token is consumed and cannot authorize a later
    // replacement at the same path either.
    const retry = await postJson(BASE, '/api/ingest', {
      file: receipt.path,
      uploadToken: receipt.uploadToken,
      scenes: false,
    });
    expect(retry.status).toBe(400);
    expect(retry.body.error).toMatch(/does not own/);
  });

  it('defaults to a safe filename when none is given', async () => {
    const res = await fetch(`${BASE}/api/upload`, {
      method: 'POST', headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(projectDir),
      }, body: 'no-name-given',
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(path.basename(body.path)).toMatch(/^upload(-\d+)?\.bin$/);
  });

  it('emits upload-error and removes the partial file when the client interrupts the stream', async () => {
    const ws = await openWs(BASE);
    const name = 'interrupted.mp4';
    try {
      const started = nextWsMessage(ws, (m) => m.type === 'upload-start' && m.name === name);
      const terminal = nextWsMessage(ws, (m) => m.type === 'upload-error' && m.name === name);
      const req = http.request(`${BASE}/api/upload?${new URLSearchParams({ name })}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': 8 * 1024 * 1024,
          'x-vedit-project-dir': encodeURIComponent(projectDir),
        },
      });
      req.on('error', () => {}); // expected: this test deliberately aborts the socket
      req.write(Buffer.alloc(64 * 1024, 0x61));
      const startMessage = await started;
      req.destroy(new Error('test interrupted upload'));

      const message = await terminal;
      expect(message).toMatchObject({ type: 'upload-error', projectDir, name });
      expect(message.taskId).toBe(startMessage.taskId);
      expect(message.bytes).toBeGreaterThan(0);
      expect(message.error).toBeTruthy();
      await expect(fsp.access(path.join(projectDir, 'media', name))).rejects.toThrow();
    } finally {
      ws.close();
    }
  });
});

describe('daemon: upload directory containment', () => {
  const PORT = 18227;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let outside: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-upload-containment-'));
    const projectDir = path.join(root, 'proj');
    outside = path.join(root, 'outside');
    await Project.create(projectDir, 'upload-containment');
    await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(projectDir, 'media'));
    server = (await startDaemon({ port: PORT, projectDir })).server;
  });

  afterAll(() => server.close());

  it('rejects a media symlink that escapes the project before streaming bytes', async () => {
    const project = (await (await fetch(`${BASE}/api/ping`)).json()).project;
    const response = await fetch(`${BASE}/api/upload?name=escape.mp4`, {
      method: 'POST', headers: {
        'content-type': 'application/octet-stream',
        'x-vedit-project-dir': encodeURIComponent(project),
      }, body: 'blocked',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/path escapes directory \(symlink\)/);
    expect(await fsp.readdir(outside)).toEqual([]);
  });
});

// ---- W-CAP: caption style overrides + text corrections + font listing ----

describe('daemon: captions.overrides patch validation + merge', () => {
  const PORT = 18220;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-capoverrides-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'capoverrides');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects an out-of-range sizeScale', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: { sizeScale: 3 } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/sizeScale must be a number between 0.5 and 2/);
  });

  it('rejects a non-hex palette color', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: { palette: { text: 'red' } } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/hex color/);
  });

  it('rejects an out-of-range position.v', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: { position: { v: 1.5 } } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/position\.v must be a number between 0 and 1/);
  });

  it('rejects a negative outlineWidth and an out-of-range bgOpacity', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const bad1 = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: { outlineWidth: -1 } },
    });
    expect(bad1.status).toBe(400);
    const bad2 = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: { bgOpacity: 2 } },
    });
    expect(bad2.status).toBe(400);
  });

  it('accepts a valid overrides patch and stores it verbatim', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions',
      patch: { overrides: { sizeScale: 1.2, palette: { text: '#ff0000' } } },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.overrides).toEqual({ sizeScale: 1.2, palette: { text: '#ff0000' } });
  });

  it('merges a second partial patch onto the first without dropping previously-set fields', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions',
      patch: { overrides: { outlineWidth: 5 } },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.overrides).toEqual({
      sizeScale: 1.2, palette: { text: '#ff0000' }, outlineWidth: 5,
    });
  });

  it('merges a palette patch onto an existing palette field-by-field (never wholesale-replaces it)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions',
      patch: { overrides: { palette: { outline: '#000000' } } },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.overrides.palette).toEqual({ text: '#ff0000', outline: '#000000' });
  });

  it('overrides: null clears every override at once', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: null },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.overrides).toBeUndefined();
  });

  it('a captions patch that never mentions overrides leaves it completely untouched', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { overrides: { bgOpacity: 0.3 } },
    });
    state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'captions', patch: { maxChars: 30 },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxChars).toBe(30);
    expect(project.manifest.captions.overrides).toEqual({ bgOpacity: 0.3 });
  });
});

describe('daemon: caption-text op', () => {
  const PORT = 18221;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-captiontext-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'captiontext');
    // Each word ends with a sentence-terminating period so captionCues
    // flushes it as its own cue deterministically (same trick srt.test.ts
    // uses), independent of the 0.6s pause/maxChars rules.
    const words: Word[] = [
      { id: 'w0000', text: 'Hello.', t0: 1.0, t1: 1.5, p: 0.9 },
      { id: 'w0001', text: 'World.', t0: 5.0, t1: 5.5, p: 0.9 },
    ];
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 8, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 8 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects a key without a "sourceId:wordId" shape', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'caption-text', key: 'nocolon', text: 'x',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/sourceId:wordId/);
  });

  it('rejects a key whose source does not exist in the manifest', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'caption-text', key: 'nope:w0000', text: 'x',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('rejects a non-string, non-null text', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'caption-text', key: 's1:w0000', text: 42,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/text must be a string/);
  });

  it('applies a text correction, reflected in GET /api/captions with the original preserved', async () => {
    const before = (await getJson(BASE, '/api/captions')).body;
    expect(before[0].key).toBe('s1:w0000');
    expect(before[0].text).toBe('Hello.');
    expect(before[0].originalText).toBeUndefined();

    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'caption-text', key: 's1:w0000', text: 'こんにちは',
    });
    expect(status).toBe(200);

    const after = (await getJson(BASE, '/api/captions')).body;
    const cue = after.find((c: any) => c.key === 's1:w0000');
    expect(cue.text).toBe('こんにちは');
    expect(cue.originalText).toBe('Hello.');

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captionTextOverrides).toEqual({ 's1:w0000': 'こんにちは' });
  });

  it('an empty-string correction hides that cue entirely', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'caption-text', key: 's1:w0001', text: '',
    });
    expect(status).toBe(200);
    const after = (await getJson(BASE, '/api/captions')).body;
    expect(after.some((c: any) => c.key === 's1:w0001')).toBe(false);
  });

  it('text: null clears a previously-set correction, restoring the original text', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'caption-text', key: 's1:w0000', text: null,
    });
    expect(status).toBe(200);
    const after = (await getJson(BASE, '/api/captions')).body;
    const cue = after.find((c: any) => c.key === 's1:w0000');
    expect(cue.text).toBe('Hello.');
    expect(cue.originalText).toBeUndefined();

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captionTextOverrides['s1:w0000']).toBeUndefined();
  });
});

describe('daemon: GET /api/fonts', () => {
  const PORT = 18222;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-fonts-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'fonts');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('returns system fonts and an empty kit list when no kit is linked', async () => {
    const { status, body } = await getJson(BASE, '/api/fonts');
    expect(status).toBe(200);
    expect(body.kit).toEqual([]);
    expect(body.system).toEqual([{ family: 'Hiragino Sans' }, { family: 'Noto Sans JP' }]);
  });
});

describe('daemon: GET /api/fonts with a linked kit', () => {
  const PORT = 18223;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let kitDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-fonts-kit-'));
    kitDir = path.join(root, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    await writeKitFile(kitDir, { version: 'vedit-kit/v1', name: 'k' });
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'fonts-kit');
    await project.commit(0, 'system', 'setup', {}, 'link kit', (m) => ({ ...m, kit: { path: kitDir } }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('includes the kit fonts alongside system fonts', async () => {
    const { status, body } = await getJson(BASE, '/api/fonts');
    expect(status).toBe(200);
    expect(body.kit).toEqual([{ name: 'MyFont-Bold', path: 'fonts/MyFont-Bold.ttf' }]);
    expect(body.system).toEqual([{ family: 'Hiragino Sans' }, { family: 'Noto Sans JP' }]);
    expect(scanKitFontsMock).toHaveBeenCalledWith(kitDir);
  });
});

// ---- W-LAZY: POST /api/transcribe (async job) ----
describe('daemon: transcribe job (W-LAZY)', () => {
  const PORT = 18230;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-transcribe-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'transcribe');
    const src = (id: string, overrides: Partial<{ hasAudio: boolean; transcribed: boolean }> = {}) => ({
      id, path: `/media/${id}.mp4`, duration: 20, fps: 30, width: 1920, height: 1080,
      hasAudio: true, transcribed: false, ...overrides,
    });
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        src('s1'), src('s2'), src('s3', { transcribed: true }), src('s4', { hasAudio: false }), src('s5'), src('s6'),
      ],
      timeline: { video: [], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('rejects when sourceId is missing', async () => {
    const { status, body } = await postJson(BASE, '/api/transcribe', {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/sourceId is required/);
  });

  it('rejects an unknown sourceId', async () => {
    const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 'nope' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source: nope/);
  });

  it('rejects a sourceId with no audio instead of starting a doomed job', async () => {
    const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 's4' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no audio/);
    expect(transcribeMock).not.toHaveBeenCalledWith(expect.anything(), 's4', expect.anything());
  });

  it('responds immediately with {started:[sourceId]} without waiting for the job to finish', async () => {
    const ws = await openWs(BASE);
    try {
      let releaseJob!: (t: unknown) => void;
      transcribeMock.mockImplementationOnce(() => new Promise((resolve) => { releaseJob = resolve; }));
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's1');

      const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 's1' });
      expect(status).toBe(200);
      expect(body.started).toEqual(['s1']);
      expect(body.skipped).toEqual([]);
      expect(body.jobs).toEqual([
        expect.objectContaining({
          taskId: expect.stringMatching(/^transcribe/),
          projectDir: expect.any(String),
          sourceId: 's1',
          status: 'queued',
          phase: 'queued',
        }),
      ]);

      // still running: /api/state reflects it via the per-source `transcribing` flag
      const mid = (await getJson(BASE, '/api/state')).body;
      expect(mid.sources.find((s: any) => s.id === 's1').transcribing).toBe(true);
      expect(mid.sources.find((s: any) => s.id === 's1').transcribed).toBe(false);
      expect(mid.sources.find((s: any) => s.id === 's1').transcribeJob.taskId).toBe(body.jobs[0].taskId);

      const listed = await getJson(BASE, '/api/transcribe-jobs');
      expect(listed.status).toBe(200);
      expect(listed.body.jobs).toContainEqual(expect.objectContaining({ taskId: body.jobs[0].taskId, status: 'running' }));

      releaseJob({ sourceId: 's1', language: 'ja', words: [{ id: 'w0000', text: 'hi', t0: 0, t1: 1, p: 0.9 }] });
      await done;
    } finally {
      ws.close();
    }
  });

  it('cancels by stable taskId, reports an explicit cancelled terminal state, and allows retry', async () => {
    const ws = await openWs(BASE);
    try {
      let signalSeen: AbortSignal | undefined;
      transcribeMock.mockImplementationOnce((_file, sourceId, opts) => new Promise((resolve, reject) => {
        signalSeen = opts?.signal;
        opts?.signal?.addEventListener('abort', () => {
          const error = new Error('operation cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }));
      const terminal = nextWsMessage(ws, (m) => m.type === 'transcribe-error' && m.sourceId === 's2' && m.cancelled === true);
      const started = await postJson(BASE, '/api/transcribe', { sourceId: 's2' });
      expect(started.status).toBe(200);
      const taskId = started.body.jobs[0].taskId;
      await expect.poll(() => signalSeen).toBeDefined();
      expect(signalSeen).toBeDefined();
      expect(signalSeen!.aborted).toBe(false);

      const cancelled = await deleteJson(BASE, `/api/transcribe-jobs/${taskId}`);
      expect(cancelled.status).toBe(202);
      expect(cancelled.body.job).toMatchObject({ taskId, sourceId: 's2', status: 'cancelling' });
      expect(signalSeen!.aborted).toBe(true);

      const terminalMsg = await terminal;
      expect(terminalMsg).toMatchObject({ taskId, sourceId: 's2', status: 'cancelled', cancelled: true });
      const after = (await getJson(BASE, '/api/state')).body;
      const s2 = after.sources.find((s: any) => s.id === 's2');
      expect(s2).toMatchObject({ transcribed: false, transcribing: false });
      expect(s2.transcribeJob).toMatchObject({ taskId, status: 'cancelled', phase: 'finished' });

      const secondCancel = await deleteJson(BASE, `/api/transcribe-jobs/${taskId}`);
      expect(secondCancel.status).toBe(409);
      expect(secondCancel.body.job.status).toBe('cancelled');
    } finally {
      ws.close();
    }
  });

  it('rejects a second transcribe for the same source while the first job is still running (double-start guard)', async () => {
    const ws = await openWs(BASE);
    try {
      let releaseJob!: (t: unknown) => void;
      transcribeMock.mockImplementationOnce(() => new Promise((resolve) => { releaseJob = resolve; }));

      const first = await postJson(BASE, '/api/transcribe', { sourceId: 's2' });
      expect(first.status).toBe(200);
      expect(first.body.started).toEqual(['s2']);

      const second = await postJson(BASE, '/api/transcribe', { sourceId: 's2' });
      expect(second.status).toBe(400);
      expect(second.body.error).toMatch(/already transcribing/);

      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's2');
      releaseJob({ sourceId: 's2', language: 'ja', words: [] });
      await done;

      // the job cleared out of the registry, so a follow-up request for the
      // same source is accepted again (not permanently stuck as "running").
      // s2 is already transcribed by now, so this exercises the explicit
      // re-transcribe path rather than double-start.
      const third = await postJson(BASE, '/api/transcribe', { sourceId: 's2' });
      expect(third.status).toBe(200);
      expect(third.body.started).toEqual(['s2']);
      await nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's2');
    } finally {
      ws.close();
    }
  });

  it('broadcasts transcribe-progress then transcribe-done, and commits Source.transcribed=true as actor "system"', async () => {
    const ws = await openWs(BASE);
    try {
      const progress = nextWsMessage(ws, (m) => m.type === 'transcribe-progress' && m.sourceId === 's5' && m.status === 'running');
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's5');
      const updated = nextWsMessage(ws, (m) => m.type === 'update' && m.op === 'transcribe');

      const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 's5', language: 'en' });
      expect(status).toBe(200);
      expect(body.started).toEqual(['s5']);

      const progressMsg = await progress;
      expect(progressMsg.step).toMatch(/transcrib/i);
      await done;
      await updated;

      expect(transcribeMock).toHaveBeenCalledWith('/media/s5.mp4', 's5', expect.objectContaining({ language: 'en' }));

      const state = (await getJson(BASE, '/api/state')).body;
      const s5 = state.sources.find((s: any) => s.id === 's5');
      expect(s5.transcribed).toBe(true);
      expect(s5.transcribing).toBe(false);

      const revs = await getJson(BASE, '/api/revisions');
      const last = revs.body[revs.body.length - 1];
      expect(last.actor).toBe('system');
      expect(last.op).toBe('transcribe');
    } finally {
      ws.close();
    }
  });

  it('accepts an explicit glossary (array), persists it to the manifest, and passes it to transcribe()', async () => {
    const ws = await openWs(BASE);
    try {
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's1');
      const state = (await getJson(BASE, '/api/state')).body;
      const { status, body } = await postJson(BASE, '/api/transcribe', {
        sourceId: 's1', glossary: ['Claude', 'vedit'], actor: 'agent', baseRev: state.revision,
      });
      expect(status).toBe(200);
      expect(body.glossary).toEqual(['Claude', 'vedit']);
      await done;

      expect(transcribeMock).toHaveBeenCalledWith('/media/s1.mp4', 's1', expect.objectContaining({ glossary: ['Claude', 'vedit'] }));

      const project = (await getJson(BASE, '/api/project')).body;
      expect(project.manifest.transcription).toEqual({ glossary: ['Claude', 'vedit'] });
    } finally {
      ws.close();
    }
  });

  it('accepts a comma-separated glossary string (same shape the CLI\'s --glossary flag sends)', async () => {
    const ws = await openWs(BASE);
    try {
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's1');
      const state = (await getJson(BASE, '/api/state')).body;
      const { status, body } = await postJson(BASE, '/api/transcribe', {
        sourceId: 's1', glossary: ' Anthropic , Cowork ', actor: 'agent', baseRev: state.revision,
      });
      expect(status).toBe(200);
      expect(body.glossary).toEqual(['Anthropic', 'Cowork']);
      await done;

      expect(transcribeMock).toHaveBeenCalledWith('/media/s1.mp4', 's1', expect.objectContaining({ glossary: ['Anthropic', 'Cowork'] }));

      const project = (await getJson(BASE, '/api/project')).body;
      expect(project.manifest.transcription).toEqual({ glossary: ['Anthropic', 'Cowork'] });
    } finally {
      ws.close();
    }
  });

  it('falls back to the manifest\'s already-stored glossary when the request omits it', async () => {
    const ws = await openWs(BASE);
    try {
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's1');
      const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 's1' });
      expect(status).toBe(200);
      expect(body.glossary).toEqual(['Anthropic', 'Cowork']); // carried over from the previous test, unchanged
      await done;

      expect(transcribeMock).toHaveBeenCalledWith('/media/s1.mp4', 's1', expect.objectContaining({ glossary: ['Anthropic', 'Cowork'] }));
    } finally {
      ws.close();
    }
  });

  it('"all" starts every untranscribed hasAudio source, skipping already-transcribed and no-audio ones', async () => {
    // By this point in the suite s1/s2 have already been transcribed above;
    // s3 was seeded already-transcribed and s4 has no audio — s6 is the only
    // source left that should qualify.
    const ws = await openWs(BASE);
    try {
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's6');
      const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 'all' });
      expect(status).toBe(200);
      expect(body.started).toEqual(['s6']);
      await done;
      const state = (await getJson(BASE, '/api/state')).body;
      expect(state.sources.find((s: any) => s.id === 's6').transcribed).toBe(true);
    } finally {
      ws.close();
    }
  });

  it('"all" is a no-op (200, started:[]) when nothing is eligible', async () => {
    // every source is now transcribed or has no audio (see the test above).
    const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 'all' });
    expect(status).toBe(200);
    expect(body.started).toEqual([]);
  });
});

// ---- W-LAZY: POST /api/transcribe job failure ----
describe('daemon: transcribe job failure (W-LAZY)', () => {
  const PORT = 18231;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-transcribe-fail-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'transcribe-fail');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/s1.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false }],
      timeline: { video: [], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('broadcasts transcribe-error, does not commit, and clears the job so it can be retried', async () => {
    const ws = await openWs(BASE);
    try {
      transcribeMock.mockRejectedValueOnce(new Error('whisper-cli exploded'));
      const err = nextWsMessage(ws, (m) => m.type === 'transcribe-error' && m.sourceId === 's1');

      const { status, body } = await postJson(BASE, '/api/transcribe', { sourceId: 's1' });
      expect(status).toBe(200);
      expect(body.started).toEqual(['s1']);

      const errMsg = await err;
      expect(errMsg.error).toMatch(/whisper-cli exploded/);

      const state = (await getJson(BASE, '/api/state')).body;
      const s1 = state.sources.find((s: any) => s.id === 's1');
      expect(s1.transcribed).toBe(false); // no commit happened
      expect(s1.transcribing).toBe(false); // job cleared out of the registry

      const revs = await getJson(BASE, '/api/revisions');
      expect(revs.body.some((r: any) => r.op === 'transcribe')).toBe(false);

      // retry succeeds now that the failed job cleared the registry
      transcribeMock.mockResolvedValueOnce({ sourceId: 's1', language: 'ja', words: [] });
      const done = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.sourceId === 's1');
      const retry = await postJson(BASE, '/api/transcribe', { sourceId: 's1' });
      expect(retry.status).toBe(200);
      await done;
    } finally {
      ws.close();
    }
  });
});

describe('daemon: transcribe ownership and shutdown isolation', () => {
  const restoreDefaultTranscribe = () => {
    transcribeMock.mockImplementation(async (_file: string, sourceId: string, opts?: { language?: string }) => ({
      sourceId,
      language: opts?.language ?? 'ja',
      words: [{ id: 'w0000', text: 'hello', t0: 0, t1: 1, p: 0.9 }],
    }));
  };

  it('allows the same sourceId to run independently in two projects/forks and reports only the current project', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-transcribe-project-scope-'));
    const dirA = path.join(root, 'project-a');
    const dirB = path.join(root, 'project-b');
    for (const [dir, media] of [[dirA, '/media/a.mp4'], [dirB, '/media/b.mp4']] as const) {
      const project = await Project.create(dir, path.basename(dir));
      await project.commit(0, 'system', 'setup', {}, 'seed same-id source', (m) => ({
        ...m,
        sources: [{ id: 's1', path: media, duration: 8, fps: 30, width: 640, height: 360, hasAudio: true, transcribed: false }],
        timeline: { video: [], motion: [] },
      }));
    }

    const releases: ((transcript: unknown) => void)[] = [];
    transcribeMock.mockImplementation((_file, _sourceId, _opts) => new Promise((resolve) => releases.push(resolve)));
    const BASE = 'http://localhost:18313';
    const startedDaemon = await startDaemon({ port: 18313, projectDir: dirA });
    const ws = await openWs(BASE);
    try {
      const first = await postJson(BASE, '/api/transcribe', { sourceId: 's1' });
      expect(first.status).toBe(200);
      await expect.poll(() => releases.length).toBe(1);

      const openedB = await postJson(BASE, '/api/open', { dir: dirB });
      expect(openedB.status).toBe(200);
      const beforeB = (await getJson(BASE, '/api/state')).body;
      expect(beforeB.sources[0]).toMatchObject({ id: 's1', transcribing: false, transcribed: false });
      expect((await getJson(BASE, '/api/transcribe-jobs')).body.jobs).toEqual([]);

      const second = await postJson(BASE, '/api/transcribe', { sourceId: 's1' });
      expect(second.status).toBe(200);
      expect(second.body.jobs[0].taskId).not.toBe(first.body.jobs[0].taskId);
      // whisper itself uses nearly every CPU thread. The second project is
      // independently owned and cancellable, but waits for the one decoder
      // slot instead of oversubscribing the machine.
      expect(releases).toHaveLength(1);
      const runningB = (await getJson(BASE, '/api/state')).body;
      expect(runningB.sources[0].transcribeJob.taskId).toBe(second.body.jobs[0].taskId);
      expect(runningB.sources[0].transcribeJob.status).toBe('queued');

      await postJson(BASE, '/api/open', { dir: dirA });
      const runningA = (await getJson(BASE, '/api/state')).body;
      expect(runningA.sources[0]).toMatchObject({ id: 's1', transcribing: true, transcribed: false });
      expect(runningA.sources[0].transcribeJob.taskId).toBe(first.body.jobs[0].taskId);

      const doneA = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.projectDir === dirA);
      const doneB = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.projectDir === dirB);
      releases[0]({ sourceId: 's1', language: 'ja', words: [] });
      await doneA;
      await expect.poll(() => releases.length).toBe(2);
      releases[1]({ sourceId: 's1', language: 'ja', words: [] });
      await doneB;

      for (const dir of [dirA, dirB]) {
        await postJson(BASE, '/api/open', { dir });
        const state = (await getJson(BASE, '/api/state')).body;
        expect(state.sources[0]).toMatchObject({ id: 's1', transcribing: false, transcribed: true });
        expect(state.sources[0].transcribeJob.status).toBe('success');
      }
    } finally {
      ws.close();
      await startedDaemon.close();
      restoreDefaultTranscribe();
    }
  });

  it('aborts and drains an in-flight child before the daemon close promise resolves', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-transcribe-shutdown-'));
    const dir = path.join(root, 'project');
    const project = await Project.create(dir, 'shutdown');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/shutdown.mp4', duration: 8, fps: 30, width: 640, height: 360, hasAudio: true, transcribed: false }],
      timeline: { video: [], motion: [] },
    }));

    let signal: AbortSignal | undefined;
    transcribeMock.mockImplementationOnce((_file, _sourceId, opts) => new Promise((_resolve, reject) => {
      signal = opts?.signal;
      opts?.signal?.addEventListener('abort', () => {
        const error = new Error('operation cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const startedDaemon = await startDaemon({ port: 18314, projectDir: dir });
    try {
      const started = await postJson('http://localhost:18314', '/api/transcribe', { sourceId: 's1' });
      expect(started.status).toBe(200);
      await expect.poll(() => signal).toBeDefined();
      await startedDaemon.close();
      expect(signal!.aborted).toBe(true);
      expect((await project.manifest()).sources[0].transcribed).toBe(false);
    } finally {
      if (startedDaemon.server.listening) await startedDaemon.close();
      restoreDefaultTranscribe();
    }
  });

  it('cancels a queued project job immediately without ever spawning its whisper child', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-transcribe-queued-cancel-'));
    const dirA = path.join(root, 'project-a');
    const dirB = path.join(root, 'project-b');
    for (const [dir, sourceId] of [[dirA, 'a1'], [dirB, 'b1']] as const) {
      const project = await Project.create(dir, path.basename(dir));
      await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
        ...m,
        sources: [{ id: sourceId, path: `/media/${sourceId}.mp4`, duration: 8, fps: 30, width: 640, height: 360, hasAudio: true, transcribed: false }],
        timeline: { video: [], motion: [] },
      }));
    }

    const releases: ((transcript: unknown) => void)[] = [];
    transcribeMock.mockImplementation((_file, _sourceId, _opts) => new Promise((resolve) => releases.push(resolve)));
    const BASE = 'http://localhost:18315';
    const startedDaemon = await startDaemon({ port: 18315, projectDir: dirA });
    const ws = await openWs(BASE);
    try {
      await postJson(BASE, '/api/transcribe', { sourceId: 'a1' });
      await expect.poll(() => releases.length).toBe(1);
      await postJson(BASE, '/api/open', { dir: dirB });
      const queued = await postJson(BASE, '/api/transcribe', { sourceId: 'b1' });
      expect(queued.body.jobs[0]).toMatchObject({ sourceId: 'b1', status: 'queued' });
      const terminal = nextWsMessage(ws, (m) => m.type === 'transcribe-error' && m.taskId === queued.body.jobs[0].taskId);
      const cancelled = await deleteJson(BASE, `/api/transcribe-jobs/${queued.body.jobs[0].taskId}`);
      expect(cancelled.status).toBe(202);
      expect(await terminal).toMatchObject({ sourceId: 'b1', status: 'cancelled', cancelled: true });
      expect(releases).toHaveLength(1);
      const bState = (await getJson(BASE, '/api/state')).body;
      expect(bState.sources[0]).toMatchObject({ id: 'b1', transcribed: false, transcribing: false });

      const doneA = nextWsMessage(ws, (m) => m.type === 'transcribe-done' && m.projectDir === dirA);
      releases[0]({ sourceId: 'a1', language: 'ja', words: [] });
      await doneA;
    } finally {
      ws.close();
      await startedDaemon.close();
      restoreDefaultTranscribe();
    }
  });
});

// ---- W-INTENT: intent zones (静寂スコア protection zones) ----
describe('daemon: intent zones (W-INTENT ops)', () => {
  const PORT = 18240;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let zoneId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-intent-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'intent');
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

  it('rejects intent-add for actor=claude without a numeric baseRev', async () => {
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', op: 'intent-add', sourceId: 's1', t0: 1, t1: 2, label: '間',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
  });

  it('intent-add rejects an unknown source', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'intent-add', sourceId: 'nope', t0: 1, t1: 2, label: '間',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('intent-add rejects t1 <= t0', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'intent-add', sourceId: 's1', t0: 5, t1: 5, label: '間',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/must be greater than t0/);
  });

  it('intent-add creates a zone with default kind=quiet, reflected in /api/project', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'intent-add', sourceId: 's1', t0: 5, t1: 10, label: '余韻',
    });
    expect(status).toBe(200);
    zoneId = body.id;
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.intentZones).toEqual([{ id: zoneId, sourceId: 's1', t0: 5, t1: 10, label: '余韻', kind: 'quiet' }]);
  });

  it('intent-add accepts an explicit kind=hold', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'intent-add', sourceId: 's1', t0: 15, t1: 20, label: '見せ場', kind: 'hold',
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.intentZones).toHaveLength(2);
    expect(project.manifest.intentZones.find((z: any) => z.id === body.id).kind).toBe('hold');
  });

  it('intent-remove rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'intent-remove', id: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown intent zone/);
  });

  it('intent-remove removes the zone', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'intent-remove', id: zoneId,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.intentZones).toHaveLength(1);
    expect(project.manifest.intentZones.some((z: any) => z.id === zoneId)).toBe(false);
  });
});

// ---- W-INTENT: /api/detect auto-excludes silence candidates inside a zone ----
describe('daemon: /api/detect excludes silence candidates inside intent zones', () => {
  const PORT = 18241;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-detect-intent-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'detect-intent');
    // gap1 [1,3) — inside the intent zone; gap2 [4,10) — outside it.
    const words: Word[] = [
      { id: 'w0000', text: 'a', t0: 0, t1: 1, p: 0.9 },
      { id: 'w0001', text: 'b', t0: 3, t1: 4, p: 0.9 },
      { id: 'w0002', text: 'c', t0: 10, t1: 11, p: 0.9 },
    ];
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 12, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 12 }], motion: [] },
      intentZones: [{ id: 'iz1', sourceId: 's1', t0: 1, t1: 3, label: '間', kind: 'quiet' }],
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('excludes the silence candidate overlapping the intent zone and reports the count', async () => {
    const { status, body } = await postJson(BASE, '/api/detect', {});
    expect(status).toBe(200);
    expect(body.excludedByIntentZones).toBe(1);
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0].t0).toBeGreaterThan(4); // the [4,10) gap's candidate, not the protected [1,3) one
  });
});

// ---- AI-first autonomy experiment: corroborated low-risk work is applied
// in one revision; preference-sensitive items remain as the only questions.
describe('daemon: autonomous first draft', () => {
  const PORT = 18220;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-autonomy-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'autonomy');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'clip1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    }));
    const safe: CutCandidate[] = Array.from({ length: 12 }, (_, i) => ({
      id: `safe${i}`,
      kind: 'silence',
      sourceId: 's1',
      t0: 1 + i * 3,
      t1: 2 + i * 3,
      wordIds: [],
      label: '1.2s silence after "x"',
      status: 'proposed',
      evidence: { transcriptGap: true, waveform: true, transcriptConflict: false, edge: 'interior' },
    }));
    const fillers: CutCandidate[] = Array.from({ length: 3 }, (_, i) => ({
      id: `filler${i}`,
      kind: 'filler',
      sourceId: 's1',
      t0: 40 + i * 2,
      t1: 40.4 + i * 2,
      wordIds: [`w${i}`],
      label: 'filler "えーと"',
      status: 'proposed',
      evidence: { transcriptGap: true, waveform: false, transcriptConflict: false, edge: 'interior' },
    }));
    await project.writeCandidates([...safe, ...fillers]);
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('applies 12 corroborated silences in one AI revision and leaves exactly 3 real questions', async () => {
    const before = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/first-draft', { actor: 'agent', baseRev: before.revision });
    expect(status).toBe(200);
    expect(body.autoApplied).toBe(12);
    expect(body.questionCount).toBe(3);
    expect(body.needsDecision).toHaveLength(3);
    expect(body.needsDecision.every((x: any) => x.reasonCode === 'preference-required')).toBe(true);
    expect(body.removedSeconds).toBeCloseTo(12, 5);
    expect(body.state.revision).toBe(before.revision + 1);
    expect(body.state.pendingCandidates).toBe(3);

    const all = (await getJson(BASE, '/api/candidates?all=1')).body as CutCandidate[];
    expect(all.filter((c) => c.status === 'approved')).toHaveLength(12);
    expect(all.filter((c) => c.status === 'proposed')).toHaveLength(3);
    expect(all.filter((c) => c.status === 'proposed').map((c) => c.aiReview?.disposition)).toEqual([
      'question', 'question', 'question',
    ]);
    const revs = (await getJson(BASE, '/api/revisions')).body;
    const last = revs.at(-1);
    expect(last.actor).toBe('agent');
    expect(last.op).toBe('apply-candidates');
    expect(last.params).toMatchObject({ mode: 'autonomous', autoApplied: 12, questionCount: 3 });
  });

  it('is idempotent: rerunning does not reapply decided ids or create another revision', async () => {
    const before = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/first-draft', { actor: 'claude', baseRev: before.revision });
    expect(status).toBe(200);
    expect(body.autoApplied).toBe(0);
    expect(body.questionCount).toBe(3);
    const after = (await getJson(BASE, '/api/state')).body;
    expect(after.revision).toBe(before.revision);

    const duplicate = await postJson(BASE, '/api/candidates/decide', {
      actor: 'ui', baseRev: after.revision, ids: ['safe0'], decision: 'approve',
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toMatch(/no matching pending candidates/);
    expect((await getJson(BASE, '/api/state')).body.revision).toBe(after.revision);
  });

  it('rejects bulk approval of AI question candidates and leaves the queue untouched', async () => {
    const before = (await getJson(BASE, '/api/state')).body;
    const bulk = await postJson(BASE, '/api/candidates/decide', {
      actor: 'ui',
      baseRev: before.revision,
      ids: ['filler0', 'filler1'],
      decision: 'approve',
    });
    expect(bulk.status).toBe(400);
    expect(bulk.body.error).toMatch(/一件ずつ明示/);
    expect((await getJson(BASE, '/api/state')).body.revision).toBe(before.revision);
    const all = (await getJson(BASE, '/api/candidates?all=1')).body as CutCandidate[];
    expect(all.filter((candidate) => candidate.id.startsWith('filler') && candidate.status === 'proposed')).toHaveLength(3);
  });

  it('one undo restores both the original duration and the 12 candidate questions; redo reapplies both', async () => {
    const applied = (await getJson(BASE, '/api/state')).body;
    const undone = await postJson(BASE, '/api/undo', { actor: 'ui', baseRev: applied.revision });
    expect(undone.status).toBe(200);
    expect(undone.body.state.duration).toBeCloseTo(60, 5);
    let all = (await getJson(BASE, '/api/candidates?all=1')).body as CutCandidate[];
    expect(all.filter((c) => c.status === 'proposed')).toHaveLength(15);

    const redone = await postJson(BASE, '/api/redo', { actor: 'ui', baseRev: undone.body.state.revision });
    expect(redone.status).toBe(200);
    expect(redone.body.state.duration).toBeCloseTo(48, 5);
    all = (await getJson(BASE, '/api/candidates?all=1')).body as CutCandidate[];
    expect(all.filter((c) => c.status === 'approved')).toHaveLength(12);
    expect(all.filter((c) => c.status === 'proposed')).toHaveLength(3);
  });
});

describe('daemon: excluded autonomy findings are diagnostic, not human questions', () => {
  const PORT = 18224;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-autonomy-excluded-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'autonomy-excluded');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'clip1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    await project.writeCandidates([{
      id: 'zero', kind: 'silence', sourceId: 's1', t0: 3, t1: 3,
      wordIds: [], label: 'invalid zero range', status: 'proposed',
      evidence: { transcriptGap: true, waveform: true, transcriptConflict: false, edge: 'interior' },
    }]);
    server = (await startDaemon({ port: PORT, projectDir: dir })).server;
  });

  afterAll(() => server.close());

  it('records the AI review but exposes zero actionable questions and refuses a no-op cut', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const draft = await postJson(BASE, '/api/first-draft', { actor: 'claude', baseRev: state.revision });
    expect(draft.status).toBe(200);
    expect(draft.body.autoApplied).toBe(0);
    expect(draft.body.questionCount).toBe(0);
    expect(draft.body.state.pendingCandidates).toBe(0);
    expect((await getJson(BASE, '/api/candidates')).body).toEqual([]);
    const all = (await getJson(BASE, '/api/candidates?all=1')).body as CutCandidate[];
    expect(all[0].aiReview).toMatchObject({ disposition: 'excluded', reasonCode: 'invalid-range' });

    const decide = await postJson(BASE, '/api/candidates/decide', {
      actor: 'ui', baseRev: state.revision, ids: ['zero'], decision: 'approve',
    });
    expect(decide.status).toBe(400);
    expect(decide.body.error).toMatch(/no matching pending candidates/);
    expect((await getJson(BASE, '/api/state')).body.revision).toBe(state.revision);
  });
});

describe('daemon: app-owned local MP4 export job', () => {
  const PORT = 18221;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;

  async function waitForJob(status: string): Promise<any> {
    const deadline = Date.now() + 3000;
    let last: any;
    while (Date.now() < deadline) {
      last = (await getJson(BASE, '/api/export-job')).body.job;
      if (last?.status === status) return last;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`job did not reach ${status}: ${JSON.stringify(last)}`);
  }

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-export-job-'));
    dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'export-job');
    await project.commit(0, 'system', 'setup', {}, 'seed composition', (m) => ({
      ...m,
      width: 640,
      height: 360,
      composition: { duration: 2, background: { type: 'color', hex: '#000000' } },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('requires the exact visible revision and writes only to project/exports with a server-generated name', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const stale = await postJson(BASE, '/api/export-job', { baseRev: state.revision - 1 });
    expect(stale.status).toBe(409);

    const started = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(started.status).toBe(202);
    expect(started.body.job.status).toBe('running');
    const done = await waitForJob('success');
    expect(done.revision).toBe(state.revision);
    expect(done.file.startsWith(path.join(dir, 'exports') + path.sep)).toBe(true);
    expect(path.extname(done.file)).toBe('.mp4');
    await expect(fsp.access(done.file)).resolves.toBeUndefined();
  });

  it('atomically reserves concurrent starts so exactly one POST receives 202', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    renderProjectMp4Mock.mockImplementationOnce(async (_project: any, outPath: string, opts: any) => {
      await opts.onPhase?.('encoding');
      await gate;
      await fsp.writeFile(outPath, 'mock-mp4');
      await opts.finalize?.();
      return { file: opts.recordFile, revision: opts.manifest.revision, warnings: [] };
    });
    const state = (await getJson(BASE, '/api/state')).body;
    const [first, second] = await Promise.all([
      postJson(BASE, '/api/export-job', { baseRev: state.revision }),
      postJson(BASE, '/api/export-job', { baseRev: state.revision }),
    ]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    release();
    await waitForJob('success');
  });

  it('cancels the owned render, removes the partial, and can retry successfully', async () => {
    renderProjectMp4Mock.mockImplementationOnce(async (_project: any, _outPath: string, opts: any) => {
      await opts.onPhase?.('encoding');
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          const e = new Error('operation cancelled');
          e.name = 'AbortError';
          reject(e);
        };
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener('abort', abort, { once: true });
      });
      throw new Error('unreachable');
    });
    const state = (await getJson(BASE, '/api/state')).body;
    const started = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(started.status).toBe(202);
    const cancelRes = await deleteJson(BASE, `/api/export-job/${started.body.job.id}`);
    expect(cancelRes.status).toBe(202);
    const cancelled = await waitForJob('cancelled');
    await expect(fsp.access(cancelled.file)).rejects.toThrow();

    const retry = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(retry.status).toBe(202);
    await waitForJob('success');
  });

  it('surfaces a real render failure and permits a clean retry', async () => {
    renderProjectMp4Mock.mockRejectedValueOnce(new Error('disk full'));
    const state = (await getJson(BASE, '/api/state')).body;
    expect((await postJson(BASE, '/api/export-job', { baseRev: state.revision })).status).toBe(202);
    const failed = await waitForJob('error');
    expect(failed.error).toContain('disk full');
    await expect(fsp.access(failed.file)).rejects.toThrow();

    expect((await postJson(BASE, '/api/export-job', { baseRev: state.revision })).status).toBe(202);
    await waitForJob('success');
  });

  it('repairs a failed terminal-state write before allowing the next export claim', async () => {
    const statePath = path.join(dir, 'cache', 'export-job.json');
    const realRename = fsp.rename.bind(fsp);
    let blockTerminal = true;
    const rename = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (blockTerminal && String(to) === statePath) {
        try {
          const staged = JSON.parse(await fsp.readFile(from, 'utf8'));
          if (staged.status !== 'running') {
            const error = new Error('injected terminal-state disk failure') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
        } catch (error) {
          if ((error as Error).message.includes('injected terminal-state')) throw error;
        }
      }
      return realRename(from, to);
    });
    try {
      const state = (await getJson(BASE, '/api/state')).body;
      expect((await postJson(BASE, '/api/export-job', { baseRev: state.revision })).status).toBe(202);
      const visibleSuccess = await waitForJob('success');
      expect(visibleSuccess.warnings.join(' ')).toMatch(/状態を保存できませんでした/);
      expect((await readExportJobForTest(dir))?.status).toBe('running');

      const blocked = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
      expect(blocked.status).toBe(503);
      expect(blocked.body.code).toBe('EXPORT_STATE_PERSISTENCE_PENDING');

      blockTerminal = false;
      const retry = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
      expect(retry.status).toBe(202);
      await waitForJob('success');
    } finally {
      blockTerminal = false;
      rename.mockRestore();
    }
  });

  it('releases the start reservation when the initial job-state write fails', async () => {
    await fsp.rm(path.join(dir, 'cache'), { recursive: true, force: true });
    await fsp.writeFile(path.join(dir, 'cache'), 'not-a-directory');
    const state = (await getJson(BASE, '/api/state')).body;
    const failed = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(failed.status).toBe(400);

    await fsp.rm(path.join(dir, 'cache'), { force: true });
    await fsp.mkdir(path.join(dir, 'cache'), { recursive: true });
    const retry = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(retry.status).toBe(202);
    await waitForJob('success');
  });

  it('makes cancellation too late immediately after the atomic final rename', async () => {
    let finalized!: () => void;
    let releaseResult!: () => void;
    const finalizedPromise = new Promise<void>((resolve) => { finalized = resolve; });
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    renderProjectMp4Mock.mockImplementationOnce(async (_project: any, outPath: string, opts: any) => {
      await opts.onPhase?.('encoding');
      await fsp.writeFile(outPath, 'complete-final-mp4');
      await opts.onPhase?.('finalizing');
      await opts.finalize?.();
      finalized();
      await resultGate;
      return { file: opts.recordFile, revision: opts.manifest.revision, warnings: [] };
    });
    const state = (await getJson(BASE, '/api/state')).body;
    const started = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(started.status).toBe(202);
    await finalizedPromise;

    const cancel = await deleteJson(BASE, `/api/export-job/${started.body.job.id}`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toMatch(/確定済み/);
    await expect(fsp.readFile(started.body.job.file, 'utf8')).resolves.toBe('complete-final-mp4');

    releaseResult();
    await waitForJob('success');
  });
});

describe('daemon: cross-daemon export lease', () => {
  const PORT_A = 18316;
  const PORT_B = 18317;
  const BASE_A = `http://localhost:${PORT_A}`;
  const BASE_B = `http://localhost:${PORT_B}`;
  let daemonA: Awaited<ReturnType<typeof startDaemon>>;
  let daemonB: Awaited<ReturnType<typeof startDaemon>>;
  let dir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-export-lease-'));
    dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'two-daemon-export');
    await project.commit(0, 'system', 'setup', {}, 'seed composition', (m) => ({
      ...m,
      width: 640,
      height: 360,
      composition: { duration: 2, background: { type: 'color', hex: '#000000' } },
    }));
    daemonA = await startDaemon({ port: PORT_A, projectDir: dir });
    daemonB = await startDaemon({ port: PORT_B, projectDir: dir });
  });

  afterAll(async () => {
    await Promise.all([daemonA.close(), daemonB.close()]);
  });

  it('returns one 202/one 409 and a GET never steals the live owner\'s partial', async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    renderProjectMp4Mock.mockImplementationOnce(async (_project: any, outPath: string, opts: any) => {
      await opts.onPhase?.('encoding');
      await fsp.writeFile(outPath, 'daemon-a-live-partial');
      entered();
      await gate;
      await opts.onPhase?.('finalizing');
      await opts.finalize?.();
      return { file: opts.recordFile, revision: opts.manifest.revision, warnings: [] };
    });

    const state = (await getJson(BASE_A, '/api/state')).body;
    const [attemptA, attemptB] = await Promise.all([
      postJson(BASE_A, '/api/export-job', { baseRev: state.revision }),
      postJson(BASE_B, '/api/export-job', { baseRev: state.revision }),
    ]);
    expect([attemptA.status, attemptB.status].sort()).toEqual([202, 409]);
    const first = attemptA.status === 202 ? attemptA : attemptB;
    const second = attemptA.status === 409 ? attemptA : attemptB;
    const observerBase = attemptA.status === 409 ? BASE_A : BASE_B;
    expect(second.body.job).toMatchObject({ id: first.body.job.id, status: 'running' });
    await enteredPromise;

    const observed = await getJson(observerBase, '/api/export-job');
    expect(observed.status).toBe(200);
    expect(observed.body.job).toMatchObject({ id: first.body.job.id, status: 'running' });
    expect(observed.body.job).not.toHaveProperty('owner');
    expect(observed.body.job.partialBytes).toBeGreaterThan(0);
    await expect(fsp.readFile(exportJobPartialPathForTest(first.body.job), 'utf8')).resolves.toBe('daemon-a-live-partial');

    // Opening another daemon after encoding has started exercises startup
    // recovery, not just GET recovery: it must observe the owner as live and
    // leave both the running state and partial bytes untouched.
    const startupObserver = await startDaemon({ port: 18319, projectDir: dir });
    try {
      const afterStartup = await getJson('http://localhost:18319', '/api/export-job');
      expect(afterStartup.body.job).toMatchObject({ id: first.body.job.id, status: 'running' });
      await expect(fsp.readFile(exportJobPartialPathForTest(first.body.job), 'utf8')).resolves.toBe('daemon-a-live-partial');
    } finally {
      await startupObserver.close();
    }

    release();
    await expect.poll(async () => (await getJson(observerBase, '/api/export-job')).body.job?.status).toBe('success');
  });

  it('recovers on startup only after the recorded PID/start-token owner is provably dead', async () => {
    const dead = {
      id: 'dead-daemon-export',
      revision: 1,
      status: 'running' as const,
      phase: 'encoding' as const,
      startedAt: '2026-07-18T00:00:00.000Z',
      file: path.join(dir, 'exports', 'dead-daemon.mp4'),
      owner: {
        pid: 2_147_483_647,
        processStartToken: 'dead-process-start',
        leaseToken: 'dead-daemon-lease',
        acquiredAt: '2026-07-18T00:00:00.000Z',
      },
    };
    const partial = exportJobPartialPathForTest(dead);
    await fsp.mkdir(path.dirname(partial), { recursive: true });
    await fsp.writeFile(partial, 'abandoned-partial');
    await writeExportJobForTest(dir, dead);

    const restarted = await startDaemon({ port: 18320, projectDir: dir });
    try {
      const recovered = await getJson('http://localhost:18320', '/api/export-job');
      expect(recovered.body.job).toMatchObject({ id: dead.id, status: 'interrupted' });
      expect(recovered.body.job).not.toHaveProperty('owner');
      await expect(fsp.access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await restarted.close();
    }
  });
});

describe('daemon: shutdown drains active export', () => {
  const PORT = 18318;
  const BASE = `http://localhost:${PORT}`;

  it('gates closing, aborts before final commit, and resolves only after cleanup + cancelled persistence', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-export-shutdown-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'shutdown-export');
    await project.commit(0, 'system', 'setup', {}, 'seed composition', (m) => ({
      ...m,
      composition: { duration: 2, background: { type: 'color', hex: '#000000' } },
    }));
    const daemon = await startDaemon({ port: PORT, projectDir: dir });
    let entered!: () => void;
    let aborted!: () => void;
    let releaseCleanup!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const abortedPromise = new Promise<void>((resolve) => { aborted = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    renderProjectMp4Mock.mockImplementationOnce(async (_project: any, outPath: string, opts: any) => {
      await opts.onPhase?.('encoding');
      await fsp.writeFile(outPath, 'shutdown-partial');
      entered();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = async () => {
          aborted();
          await cleanupGate;
          const error = new Error('operation cancelled');
          error.name = 'AbortError';
          reject(error);
        };
        if (opts.signal.aborted) void onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      });
      throw new Error('unreachable');
    });

    const state = (await getJson(BASE, '/api/state')).body;
    const started = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(started.status).toBe(202);
    await enteredPromise;
    const partial = exportJobPartialPathForTest(started.body.job);

    let closeResolved = false;
    const closing = daemon.close().then(() => { closeResolved = true; });
    await abortedPromise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closeResolved).toBe(false);
    await expect(fsp.readFile(partial, 'utf8')).resolves.toBe('shutdown-partial');

    releaseCleanup();
    await closing;
    expect(closeResolved).toBe(true);
    expect((await readExportJobForTest(dir))?.status).toBe('cancelled');
    await expect(fsp.access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.access(started.body.job.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('daemon: export directory containment', () => {
  const PORT = 18225;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let outside: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-export-containment-'));
    const dir = path.join(root, 'proj');
    outside = path.join(root, 'outside');
    const project = await Project.create(dir, 'export-containment');
    await project.commit(0, 'system', 'setup', {}, 'seed composition', (m) => ({
      ...m,
      composition: { duration: 1, background: { type: 'color', hex: '#000000' } },
    }));
    await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(dir, 'exports'));
    server = (await startDaemon({ port: PORT, projectDir: dir })).server;
  });

  afterAll(() => server.close());

  it('rejects an exports symlink that escapes the project', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const response = await postJson(BASE, '/api/export-job', { baseRev: state.revision });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/path escapes directory \(symlink\)/);
    expect(await fsp.readdir(outside)).toEqual([]);
  });
});

// ---- F-s1-3: /api/detect's non-blocking "silence cut fragments this
// material" hint (verification: a no-speech street-walk source turned into
// dozens of 0.1-0.4s clips; scenes/culling fits that footage better) ----
describe('daemon: /api/detect fragmentation hint (F-s1-3)', () => {
  const PORT = 18253;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-detect-hint-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'detect-hint');
    await fsp.writeFile(path.join(project.cacheDir, 'peaks-s1.json'), JSON.stringify({
      rate: 1,
      peaks: Array.from({ length: 12 }, () => 0),
    }));
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      // No transcript at all — untranscribed source (the street-walk case).
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 12, fps: 30, width: 1920, height: 1080, hasAudio: true, peaks: 'cache/peaks-s1.json' }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 12 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('hints at scene culling when no source has a transcript at all — never blocks the detect', async () => {
    const { status, body } = await postJson(BASE, '/api/detect', {});
    expect(status).toBe(200); // advisory only — detect still runs and returns normally
    expect(body.pending).toEqual([]); // waveform-only visual footage never floods the human question queue
    expect(body.warnings).toEqual(['発話が少ない素材では無音カットは断片化しやすい — シーン選別(カリング)の方が向いています']);
  });

  it('the hint is absent when --no-silence is passed (nothing to forecast fragmentation for)', async () => {
    const { status, body } = await postJson(BASE, '/api/detect', { silence: false });
    expect(status).toBe(200);
    expect(body.warnings).toBeUndefined();
  });
});

// ---- F-s1-3: the same hint via the OTHER trigger — a transcript exists,
// but this batch of freshly proposed silence candidates would fragment the
// timeline into a lot of sub-threshold slivers (forecast via removeSourceRange's
// own F-s1-1 absorption, simulated against the current timeline and discarded) ----
describe('daemon: /api/detect fragmentation hint (F-s1-3) — candidate-fragmentation forecast', () => {
  const PORT = 18256;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-detect-hint2-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'detect-hint2');
    // 8 very short (0.02s) "blip" words spaced 1s apart: each inter-word gap
    // (0.98s) clears detectSilences' default minGap (0.7s), so 7 silence
    // candidates get proposed. The island of untouched material LEFT
    // BETWEEN two consecutive candidates is (word duration + 2*pad) =
    // 0.02 + 0.24 = 0.26s — comfortably under removeSourceRange's 0.35s
    // absorption floor even after frame-snap rounding, so applying this
    // candidate batch sequentially (the forecast simulation) absorbs a
    // fragment at nearly every step.
    const words: Word[] = Array.from({ length: 8 }, (_, i) => ({
      id: `w${i}`, text: `blip${i}`, t0: i * 1.0, t1: i * 1.0 + 0.02, p: 0.9,
    }));
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 8, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 8 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('hints at scene culling when the freshly proposed candidate batch would fragment the timeline, even though a transcript exists', async () => {
    const { status, body } = await postJson(BASE, '/api/detect', {});
    expect(status).toBe(200);
    expect(body.pending.length).toBeGreaterThanOrEqual(6); // 7 gap candidates expected
    expect(body.warnings).toEqual(['発話が少ない素材では無音カットは断片化しやすい — シーン選別(カリング)の方が向いています']);
  });
});

describe('daemon: durable candidate-detection completion marker', () => {
  const PORT = 18311;
  const SECOND_PORT = 18312;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-detect-run-'));
    dir = path.join(root, 'proj');
    await Project.create(dir, 'detect-run');
    server = (await startDaemon({ port: PORT, projectDir: dir })).server;
  });

  afterAll(() => server.close());

  it('persists a successful zero-result run, survives another daemon, and becomes explicitly stale after a revision change', async () => {
    const detected = await postJson(BASE, '/api/detect', { silence: false, fillers: false, minGap: 1.1 });
    expect(detected.status).toBe(200);
    expect(detected.body.pending).toEqual([]);
    expect(detected.body.detectRun).toMatchObject({
      version: 1,
      revision: 0,
      proposalCount: 0,
      stale: false,
      parameters: { silence: false, fillers: false, minGap: 1.1 },
    });

    const markerPath = path.join(dir, 'detect-run.json');
    const onDisk = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
    expect(onDisk).toMatchObject({ version: 1, revision: 0, proposalCount: 0 });

    const second = (await startDaemon({ port: SECOND_PORT, projectDir: dir })).server;
    try {
      const reopened = (await getJson(`http://localhost:${SECOND_PORT}`, '/api/project')).body;
      expect(reopened.detectRun).toMatchObject({ revision: 0, proposalCount: 0, stale: false });
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
    }

    const edited = await postJson(BASE, '/api/edit', {
      actor: 'ui', baseRev: 0, op: 'captions', patch: { maxChars: 30 },
    });
    expect(edited.status).toBe(200);
    const stale = (await getJson(BASE, '/api/project')).body.detectRun;
    expect(stale).toMatchObject({ revision: 0, proposalCount: 0, stale: true, staleReason: 'revision-changed' });

    const refreshed = await postJson(BASE, '/api/detect', { silence: false, fillers: false });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.detectRun).toMatchObject({ revision: 1, proposalCount: 0, stale: false });
    expect((await getJson(BASE, '/api/project')).body.detectRun.stale).toBe(false);
  });

  it('treats a corrupt derived marker as unknown, never as a clean verdict', async () => {
    await fsp.writeFile(path.join(dir, 'detect-run.json'), '{broken');
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.detectRun).toBeNull();
  });

  it('also rejects structurally valid but impossible marker values', async () => {
    await fsp.writeFile(path.join(dir, 'detect-run.json'), JSON.stringify({
      version: 1,
      completedAt: 'not-a-date',
      revision: 1,
      proposalCount: -1,
      excludedByIntentZones: 0,
      parameters: { silence: true, fillers: true, minGap: 0.7 },
    }));
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.detectRun).toBeNull();
  });
});

describe('daemon: cross-daemon candidate/marker publication', () => {
  const FIRST_PORT = 18315;
  const SECOND_PORT = 18316;
  const FIRST = `http://localhost:${FIRST_PORT}`;
  const SECOND = `http://localhost:${SECOND_PORT}`;

  it('never leaves one daemon\'s candidates paired with the other daemon\'s completion marker', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-detect-publish-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'detect-publish');
    await project.commit(0, 'system', 'seed', {}, 'seed transcribed source', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 4, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 4 }], motion: [] },
    }));
    await project.writeTranscript({
      sourceId: 's1',
      language: 'en',
      words: [
        { id: 'w1', text: 'hello', t0: 0, t1: 0.3, p: 0.99 },
        { id: 'w2', text: 'um', t0: 0.5, t1: 0.7, p: 0.99 },
        { id: 'w3', text: 'world', t0: 1.6, t1: 2, p: 0.99 },
      ],
    });

    const first = (await startDaemon({ port: FIRST_PORT, projectDir: dir })).server;
    const second = (await startDaemon({ port: SECOND_PORT, projectDir: dir })).server;
    try {
      // Opposite publications deliberately have distinguishable truth: one
      // clears every proposal, the other detects filler/silence candidates.
      for (let i = 0; i < 12; i++) {
        const responses = await Promise.all([
          postJson(FIRST, '/api/detect', { silence: false, fillers: false }),
          postJson(SECOND, '/api/detect', {}),
        ]);
        expect(responses.every((response) => response.status === 200)).toBe(true);

        const marker = JSON.parse(await fsp.readFile(path.join(dir, 'detect-run.json'), 'utf8'));
        const proposed = (await project.candidates()).filter((candidate) => candidate.status === 'proposed');
        expect(marker.proposalCount).toBe(proposed.length);
        if (marker.parameters.silence === false && marker.parameters.fillers === false) {
          expect(proposed).toHaveLength(0);
        } else {
          expect(proposed.length).toBeGreaterThan(0);
        }
      }
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => first.close(() => resolve())),
        new Promise<void>((resolve) => second.close(() => resolve())),
      ]);
    }
  });
});

// ---- W-INTENT: music-add/-update duck warning near a 'quiet' zone (never rejects) ----
describe('daemon: music duck warning near a quiet intent zone', () => {
  const PORT = 18242;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let musicId2: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-duck-warn-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'duck-warn');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
      // quiet zone at source time [10,15) -> timeline [10,15) (single 1:1 clip)
      intentZones: [{ id: 'iz1', sourceId: 's1', t0: 10, t1: 15, label: '余韻', kind: 'quiet' }],
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('music-add with default duck warns when the placed region overlaps the quiet zone (never rejects)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm.mp3', tlStart: 8, duration: 5, // [8,13) overlaps [10,15)
    });
    expect(status).toBe(200);
    expect(body.warning).toMatch(/余韻/);
  });

  it('music-add with --no-duck does not warn even though the region overlaps', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm2.mp3', tlStart: 8, duration: 5, duck: false,
    });
    expect(status).toBe(200);
    expect(body.warning).toBeUndefined();
    musicId2 = body.id;
  });

  it('music-add away from the zone does not warn', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm3.mp3', tlStart: 0, duration: 3,
    });
    expect(status).toBe(200);
    expect(body.warning).toBeUndefined();
  });

  it('music-update turning duck on for an overlapping item surfaces the warning without re-specifying tlStart/duration', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-update', id: musicId2, duck: true,
    });
    expect(status).toBe(200);
    expect(body.warning).toMatch(/余韻/);
  });
});

// ---- W9: GET /api/qc (static-only report, merged into the いま inbox) ----
describe('daemon: GET /api/qc (static-only report)', () => {
  const PORT = 18243;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let kitDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-qc-'));
    const dir = path.join(root, 'proj');
    kitDir = path.join(root, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    await writeKitFile(kitDir, { version: 'vedit-kit/v1', profile: { duration_seconds: { target: 10 } } });

    const project = await Project.create(dir, 'qc');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: path.join(root, 'does-not-exist.mp4'), duration: 5, fps: 30, width: 1920, height: 1080, hasAudio: false },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
      kit: { path: kitDir },
    }));
    await project.writeCandidates([
      { id: 'cand1', kind: 'silence', sourceId: 's1', t0: 5, t1: 6, wordIds: [], label: '無音 1.0s', status: 'proposed' } as CutCandidate,
    ]);

    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('returns a StaticCheckReport surfacing pending candidates, a missing source file, and a kit duration mismatch — never a render probe', async () => {
    const { status, body } = await getJson(BASE, '/api/qc');
    expect(status).toBe(200);
    expect(body.probe).toBeUndefined(); // static-only — never ffmpeg-probes a render
    expect(body.tempo).toBeUndefined();
    expect(body.issues.some((i: any) => i.category === 'candidates')).toBe(true);
    expect(body.issues.some((i: any) => i.category === 'source-missing' && i.message.includes('s2'))).toBe(true);
    expect(body.issues.some((i: any) => i.category === 'kit-duration')).toBe(true);
    expect(body.counts.errors).toBeGreaterThanOrEqual(1); // source-missing is an error
    expect(body.counts.warnings).toBeGreaterThanOrEqual(2); // pending candidate + kit-duration
  });
});

// ---- W11: GET /api/takes (read-only detectTakes wiring) ----
describe('daemon: GET /api/takes', () => {
  const PORT = 18244;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  function retakeWords(startAt: number): Word[] {
    return [
      { id: `w${startAt}0`, text: 'hello', t0: startAt, t1: startAt + 0.5, p: 0.9 },
      { id: `w${startAt}1`, text: 'there', t0: startAt + 0.5, t1: startAt + 1.0, p: 0.9 },
      { id: `w${startAt}2`, text: 'friend', t0: startAt + 1.0, t1: startAt + 1.5, p: 0.9 },
    ];
  }

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-takes-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'takes');
    // s1: same "hello there friend" said twice, 1.5s apart -> one retake group.
    await project.writeTranscript({ sourceId: 's1', language: 'en', words: [...retakeWords(0), ...retakeWords(3)] });
    await project.writeTranscript({ sourceId: 's2', language: 'en', words: wordsFor('s2w', 4) });
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
        { id: 's2', path: '/media/two.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true },
        { id: 's3', path: '/media/three.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false },
      ],
      timeline: { video: [], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('returns detected take groups (raw TakeGroup[] JSON) for an explicit source', async () => {
    const { status, body } = await getJson(BASE, '/api/takes?source=s1');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].utterances).toHaveLength(2);
  });

  it('with no source and multiple transcribed sources: 400 listing the candidates', async () => {
    const { status, body } = await getJson(BASE, '/api/takes');
    expect(status).toBe(400);
    expect(body.error).toMatch(/multiple transcribed sources/);
    expect(body.sources.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('rejects an unknown source (404)', async () => {
    const { status, body } = await getJson(BASE, '/api/takes?source=nope');
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown source/);
  });

  it('rejects a source that exists but has no transcript (400)', async () => {
    const { status, body } = await getJson(BASE, '/api/takes?source=s3');
    expect(status).toBe(400);
    expect(body.error).toMatch(/no transcript/);
  });
});

// ---- W-INTENT/W11: POST /api/show kind='takes' ----
describe('daemon: show takes directive', () => {
  const PORT = 18245;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let groupId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-show-takes-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'show-takes');
    const words: Word[] = [
      { id: 'w0000', text: 'hello', t0: 0, t1: 0.5, p: 0.9 },
      { id: 'w0001', text: 'there', t0: 0.5, t1: 1.0, p: 0.9 },
      { id: 'w0002', text: 'friend', t0: 1.0, t1: 1.5, p: 0.9 },
      { id: 'w0003', text: 'hello', t0: 3.0, t1: 3.5, p: 0.9 },
      { id: 'w0004', text: 'there', t0: 3.5, t1: 4.0, p: 0.9 },
      { id: 'w0005', text: 'friend', t0: 4.0, t1: 4.5, p: 0.9 },
    ];
    await project.writeTranscript({ sourceId: 's1', language: 'en', words });
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;

    const takes = (await getJson(BASE, '/api/takes?source=s1')).body;
    groupId = takes[0].id;
  });

  afterAll(() => server.close());

  it('does not create a revision and broadcasts {kind:"takes", sourceId, groupId}', async () => {
    const before = (await getJson(BASE, '/api/state')).body.revision;
    const ws = await openWs(BASE);
    try {
      const waiting = nextWsMessage(ws, (m) => m.type === 'show');
      const { status, body } = await postJson(BASE, '/api/show', { kind: 'takes', sourceId: 's1', groupId });
      expect(status).toBe(200);
      expect(body.directive).toEqual({ kind: 'takes', sourceId: 's1', groupId });
      const msg = await waiting;
      expect(msg).toMatchObject({ type: 'show', directive: { kind: 'takes', sourceId: 's1', groupId } });
    } finally {
      ws.close();
    }
    const after = (await getJson(BASE, '/api/state')).body.revision;
    expect(after).toBe(before);
  });

  it('rejects an unknown groupId', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'takes', sourceId: 's1', groupId: 'nope' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown take group/);
  });

  it('rejects an unknown sourceId', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'takes', sourceId: 'nope', groupId });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown source/);
  });

  it('rejects a missing groupId', async () => {
    const { status, body } = await postJson(BASE, '/api/show', { kind: 'takes', sourceId: 's1' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/groupId is required/);
  });
});

// ---- Suite: W-ANIME composition (compose / bg-set / bg-remove / sprite anchor+motion / dialogue) ----
describe('daemon: W-ANIME composition', () => {
  const PORT = 18250;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;
  let kitDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-anime-'));
    dir = path.join(root, 'proj');
    kitDir = path.join(root, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      assets: [
        { id: 'char1', path: 'assets/characters/char1.png', type: 'sprite' },
        { id: 'happy', path: 'assets/characters/happy.png', type: 'sprite' },
        { id: 'room', path: 'assets/backgrounds/room.png', type: 'background' },
      ],
    };
    await writeKitFile(kitDir, kit);
    await Project.create(dir, 'anime');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('compose creates a source-less composition project (width/height set directly, background defaults to black)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'compose', duration: 20, width: 1080, height: 1920,
    });
    expect(status).toBe(200);
    expect(body.state.composition).toEqual({ duration: 20 });
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.composition.background).toEqual({ type: 'color', hex: '#000000' });
    expect(project.manifest.width).toBe(1080);
    expect(project.manifest.height).toBe(1920);
    expect(project.duration).toBe(20);
  });

  it('compose --kit links the kit in a second op (CLI issues these as two sequential edits)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'kit-link', path: kitDir,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.kit).toEqual({ path: kitDir });
  });

  it('bg-set --to <#hex> sets the base background at t=0', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'bg-set', t: 0, to: '#ff0000',
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.composition.background).toEqual({ type: 'color', hex: '#ff0000' });
    expect(project.backgroundIntervals).toEqual([{ t0: 0, t1: 20, ref: { type: 'color', hex: '#ff0000' } }]);
  });

  it('bg-set --to <kitAssetId> resolves against the linked kit', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'bg-set', t: 5, to: 'room',
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const cut = project.manifest.composition.backgroundTrack.find((e: any) => e.t === 5);
    expect(cut.ref).toEqual({ type: 'asset', assetId: 'room' });
  });

  it('bg-set --to <relative-name> resolves against toPathHint (the CLI\'s cwd), NOT the daemon process\'s own cwd', async () => {
    // Simulates the real CLI: `to` is whatever the user typed (here a bare
    // relative filename), `toPathHint` is what cli.ts's `path.resolve(to)`
    // would have computed against the user's actual shell cwd — which the
    // long-lived daemon process has no way to know on its own (see
    // resolveBackgroundArg's doc). Omitting toPathHint here would 400 (the
    // daemon's own cwd almost certainly has no file named "loop.mp4").
    const videoPath = path.join(dir, 'loop.mp4');
    await fsp.writeFile(videoPath, 'fake-bytes');
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'bg-set', t: 10, to: 'loop.mp4', toPathHint: videoPath,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const cut = project.manifest.composition.backgroundTrack.find((e: any) => e.t === 10);
    expect(cut.ref).toEqual({ type: 'video', path: videoPath });
  });

  it('bg-set --to <unresolvable> (not a hex, kit asset, or existing file) is rejected with a clear message', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'bg-set', t: 1, to: 'totally-unknown-thing',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not a hex color, known kit asset id, or existing file/);
  });

  it('bg-remove removes a cut; refuses t=0', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'bg-remove', t: 10,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.composition.backgroundTrack.some((e: any) => e.t === 10)).toBe(false);
    const state2 = (await getJson(BASE, '/api/state')).body;
    const rejected = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state2.revision, op: 'bg-remove', t: 0 });
    expect(rejected.status).toBe(400);
  });

  let spriteId: string;
  it('sprite-add accepts --at (COMP_SOURCE_ID sentinel) in a composition project, with motion', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1',
      anchor: { sourceId: '__comp__', srcTime: 1 }, duration: 5, position: { x: 0.3, y: 0.9 }, scale: 0.35,
      motion: { enter: 'hop-in', loop: 'sway', emoteAt: [{ t: 2, assetId: 'happy' }] },
    });
    expect(status).toBe(200);
    spriteId = body.id;
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.sprites.find((r: any) => r.sprite.id === spriteId);
    expect(resolved.tlStart).toBeCloseTo(1); // COMP_SOURCE_ID: srcTime IS the absolute timeline time
    expect(resolved.sprite.motion).toEqual({ enter: 'hop-in', loop: 'sway', emoteAt: [{ t: 2, assetId: 'happy' }] });
  });

  it('sprite-update merges a motion patch rather than replacing it wholesale', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-update', id: spriteId, motion: { loop: 'bob' },
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.sprites.find((r: any) => r.sprite.id === spriteId);
    expect(resolved.sprite.motion).toEqual({ enter: 'hop-in', loop: 'bob', emoteAt: [{ t: 2, assetId: 'happy' }] });
  });

  let dialogueId: string;
  let voiceMusicId: string;
  it('dialogue-add with --voice creates a MusicItem (duck=false, short fades) alongside the dialogue line', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-add', text: '今日は雨…',
      tlStart: 2, duration: 2.5, spriteId, voice: '/media/voice.mp3',
    });
    expect(status).toBe(200);
    dialogueId = body.id;
    voiceMusicId = body.voiceMusicId;
    expect(voiceMusicId).toMatch(/^mu/);
    const project = (await getJson(BASE, '/api/project')).body;
    const dl = project.dialogue.find((d: any) => d.id === dialogueId);
    expect(dl).toMatchObject({ text: '今日は雨…', tlStart: 2, duration: 2.5, spriteId, voiceMusicId });
    const mu = project.manifest.timeline.music.find((x: any) => x.id === voiceMusicId);
    expect(mu).toMatchObject({ path: '/media/voice.mp3', tlStart: 2, gain: 0, duck: false });
  });

  it('dialogue-add rejects an unknown --sprite, and a --voice file with no audio stream', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const noSprite = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-add', text: 'x', tlStart: 0, spriteId: 'nope',
    });
    expect(noSprite.status).toBe(400);
    expect(noSprite.body.error).toMatch(/unknown sprite/);

    const noAudio = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-add', text: 'x', tlStart: 0, voice: '/media/novoice.mp3',
    });
    expect(noAudio.status).toBe(400);
    expect(noAudio.body.error).toMatch(/no audio stream/);
  });

  it('dialogue-add stores an optional --pos and warns when it overlaps an existing pos-less dialogue window', async () => {
    // dialogueId (added above at tlStart=2, duration=2.5 -> window [2,4.5))
    // still has no pos at this point in the sequence.
    const state = (await getJson(BASE, '/api/state')).body;
    const overlapping = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-add', text: 'overlap', tlStart: 3, duration: 1,
    });
    expect(overlapping.status).toBe(200);
    expect(overlapping.body.warnings).toEqual(['同時刻のセリフが重なる可能性(--pos で位置を分けられます)']);

    const state2 = (await getJson(BASE, '/api/state')).body;
    const withPos = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state2.revision, op: 'dialogue-add', text: 'positioned',
      tlStart: 3.2, duration: 1, pos: { x: 0.1, y: 0.1 },
    });
    expect(withPos.status).toBe(200);
    expect(withPos.body.warnings).toBeUndefined(); // this one specifies pos -> no collision risk flagged
    const project = (await getJson(BASE, '/api/project')).body;
    const dl = project.dialogue.find((d: any) => d.id === withPos.body.id);
    expect(dl.pos).toEqual({ x: 0.1, y: 0.1 });

    const invalidPos = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: (await getJson(BASE, '/api/state')).body.revision,
      op: 'dialogue-add', text: 'bad', tlStart: 10, pos: { x: 1.5, y: 0.5 },
    });
    expect(invalidPos.status).toBe(400);
    expect(invalidPos.body.error).toMatch(/pos\.x/);
  });

  it('dialogue-update patches pos; pos:null clears it back to auto-anchor', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const added = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-add', text: 'movable', tlStart: 15,
    });
    const id = added.body.id;
    const state2 = (await getJson(BASE, '/api/state')).body;
    const patched = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state2.revision, op: 'dialogue-update', id, pos: { x: 0.3, y: 0.4 },
    });
    expect(patched.status).toBe(200);
    let project = (await getJson(BASE, '/api/project')).body;
    expect(project.dialogue.find((d: any) => d.id === id).pos).toEqual({ x: 0.3, y: 0.4 });

    const state3 = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state3.revision, op: 'dialogue-update', id, pos: null });
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.dialogue.find((d: any) => d.id === id).pos).toBeUndefined();
  });

  it('dialogue-update patches text/timing and can clear spriteId', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-update', id: dialogueId, text: '晴れました', spriteId: null,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const dl = project.dialogue.find((d: any) => d.id === dialogueId);
    expect(dl.text).toBe('晴れました');
    expect(dl.spriteId).toBeUndefined();
  });

  it('dialogue-remove cascades: also removes the voiceMusicId MusicItem it created', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-remove', id: dialogueId,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.dialogue.find((d: any) => d.id === dialogueId)).toBeUndefined();
    expect(project.manifest.timeline.music.find((x: any) => x.id === voiceMusicId)).toBeUndefined();
  });

  it('/api/state reports dialogue count and composition summary', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    expect(state.composition).toEqual({ duration: 20 });
    expect(typeof state.dialogue).toBe('number');
  });

  it('/api/qc flags a sprite whose assetId is no longer in the linked kit (checkKitAssetReferences)', async () => {
    // sprite-add itself validates assetId against the CURRENT kit (see the
    // "sprite-add rejects an unknown kit asset id" test above) — the
    // realistic way this check ever fires is a kit edited EXTERNALLY after
    // the sprite was placed (the asset renamed/removed from kit.json).
    const state = (await getJson(BASE, '/api/state')).body;
    const added = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1',
      anchor: { sourceId: '__comp__', srcTime: 0 }, id: 'spGhost',
    });
    expect(added.status).toBe(200);
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      assets: [{ id: 'happy', path: 'assets/characters/happy.png', type: 'sprite' }, { id: 'room', path: 'assets/backgrounds/room.png', type: 'background' }],
    };
    await writeKitFile(kitDir, kit); // 'char1' removed externally
    const qc = (await getJson(BASE, '/api/qc')).body;
    expect(qc.issues.some((i: any) => i.category === 'kit-asset-missing' && i.message.includes('char1'))).toBe(true);
  });
});

// ---- Suite: compose refuses a project that already has ingested sources ----
describe('daemon: compose on an already-ingested project is refused', () => {
  const PORT = 18251;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-anime-refuse-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'refuse');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('compose is rejected with a clear message', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'compose', duration: 10, width: 100, height: 100,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/already has ingested/);
  });
});

// ---- Suite: shift op (composition-only "間" gap adjust) ----
describe('daemon: shift op (composition gap adjust)', () => {
  const PORT = 18252;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;
  let kitDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-shift-'));
    dir = path.join(root, 'proj');
    kitDir = path.join(root, 'kit');
    await fsp.mkdir(kitDir, { recursive: true });
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      assets: [{ id: 'char1', path: 'assets/characters/char1.png', type: 'sprite' }],
    };
    await writeKitFile(kitDir, kit);
    await Project.create(dir, 'shift');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('shift moves sprites/dialogue/music/bg-cuts at/after --from, grows duration by --by, and reports a per-kind summary', async () => {
    // Build up a composition with one item of every kind shiftComposition
    // touches, all sitting at t=5 (>= the from we'll shift with below).
    let state = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'compose', duration: 20, width: 1080, height: 1920,
    });
    state = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'kit-link', path: kitDir });
    state = (await getJson(BASE, '/api/state')).body;
    const sprite = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'sprite-add', assetId: 'char1',
      anchor: { sourceId: '__comp__', srcTime: 5 }, duration: 3,
    });
    expect(sprite.status).toBe(200);
    state = (await getJson(BASE, '/api/state')).body;
    const dialogue = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'dialogue-add', text: 'hi', tlStart: 5,
    });
    expect(dialogue.status).toBe(200);
    state = (await getJson(BASE, '/api/state')).body;
    const music = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'music-add', path: '/tmp/bgm.mp3', tlStart: 5, duration: 3,
    });
    expect(music.status).toBe(200);
    state = (await getJson(BASE, '/api/state')).body;
    const bg = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'bg-set', t: 8, to: '#ff0000',
    });
    expect(bg.status).toBe(200);

    state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'shift', from: 5, by: 2,
    });
    expect(status).toBe(200);
    expect(body.summary).toEqual({ sprites: 1, dialogue: 1, music: 1, bgCuts: 1, duration: 22 });

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.composition.duration).toBe(22);
    expect(project.sprites.find((r: any) => r.sprite.id === sprite.body.id).tlStart).toBeCloseTo(7);
    expect(project.dialogue.find((d: any) => d.id === dialogue.body.id).tlStart).toBe(7);
    expect(project.manifest.timeline.music.find((x: any) => x.id === music.body.id).tlStart).toBe(7);
    expect(project.manifest.composition.backgroundTrack.some((e: any) => e.t === 10)).toBe(true);

    const revs = (await getJson(BASE, '/api/revisions')).body;
    const last = revs[revs.length - 1];
    expect(last.op).toBe('shift');
    expect(last.summary).toBe('shift from=5s by=2s');
  });

  it('shift is refused (400) on a normal (source-driven) project — composition-only op', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-shift-refuse-'));
    const realDir = path.join(root, 'proj');
    const project = await Project.create(realDir, 'shift-refuse');
    await project.commit(0, 'system', 'setup', {}, 'seed source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    }));
    const PORT2 = 18253;
    const started = await startDaemon({ port: PORT2, projectDir: realDir });
    try {
      const state = (await getJson(`http://localhost:${PORT2}`, '/api/state')).body;
      const { status, body } = await postJson(`http://localhost:${PORT2}`, '/api/edit', {
        actor: 'claude', baseRev: state.revision, op: 'shift', from: 0, by: 1,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/コンポジション専用|実写プロジェクト/);
    } finally {
      started.server.close();
    }
  });
});

// ---- Suite: selects raw wiring (daemon 'selects' op passes b.raw through to buildSelectsTimeline) ----
describe('daemon: selects raw wiring', () => {
  const PORT = 18254;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-selects-raw-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'selects-raw');
    await project.commit(0, 'system', 'setup', {}, 'seed source + micro-edit + keep verdict', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: false }],
      // Narrower than the scene's full [0,10) range below — simulates a
      // prior remove-words/remove-range micro-edit inside the kept scene.
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 2, srcOut: 8 }], motion: [] },
      culling: { s1: { sc1: 'keep' } },
    }));
    await project.writeScenes({
      sourceId: 's1',
      scenes: [{ id: 'sc1', t0: 0, t1: 10, thumb: 'cache/sc-s1-sc1.jpg', hasSpeech: false, energy: 0.1 }],
    });
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('selects (default) preserves the existing micro-edit inside the kept scene', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'selects',
    });
    expect(status).toBe(200);
    expect(body.newClips).toBe(1);
    const project = (await getJson(BASE, '/api/project')).body;
    const video = project.manifest.timeline.video;
    expect(video).toHaveLength(1);
    expect(video[0]).toMatchObject({ sourceId: 's1', srcIn: 2, srcOut: 8 }); // micro-edit preserved
  });

  it('selects raw:true restores the old behavior (full scene bounds, discarding the micro-edit)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'selects', raw: true,
    });
    expect(status).toBe(200);
    expect(body.newClips).toBe(1);
    const project = (await getJson(BASE, '/api/project')).body;
    const video = project.manifest.timeline.video;
    expect(video).toHaveLength(1);
    expect(video[0]).toMatchObject({ sourceId: 's1', srcIn: 0, srcOut: 10 }); // raw: full scene range, micro-edit discarded
  });
});

// ---- 「書き出し結果カード」read-only route: GET /api/export-results ----
// docs/product-bet-sensory-vs-structural.md: 構造系(書き出し)に必要なのは
// 操作ではなく結果の可視化。実行ルートはここにも daemon にも作らない——
// CLI(export/publish-pack)が cache/export-results.json に書いた記録を
// そのまま読むだけの route。stateSummary(/api/state)には含めないので、
// その非混入も別途確認する。
describe('daemon: GET /api/export-results', () => {
  const PORT = 18255;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;

  function rec(overrides: Partial<ExportResultRecord> = {}): ExportResultRecord {
    return {
      ts: new Date().toISOString(),
      kind: 'render',
      file: '/tmp/out.mp4',
      ok: true,
      revision: 0,
      ...overrides,
    };
  }

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-export-results-'));
    dir = path.join(root, 'proj');
    await Project.create(dir, 'export-results');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('returns [] when no export has ever been recorded', async () => {
    const { status, body } = await getJson(BASE, '/api/export-results');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns the most recent records first, defaulting to 5', async () => {
    for (let i = 0; i < 7; i++) {
      await appendExportResult(dir, rec({ file: `out-${i}.mp4`, revision: i }));
    }
    const { status, body } = await getJson(BASE, '/api/export-results');
    expect(status).toBe(200);
    expect(body).toHaveLength(5);
    expect(body.map((r: ExportResultRecord) => r.file)).toEqual(['out-6.mp4', 'out-5.mp4', 'out-4.mp4', 'out-3.mp4', 'out-2.mp4']);
  });

  it('honors ?n= to widen or narrow the count', async () => {
    const { body: wide } = await getJson(BASE, '/api/export-results?n=7');
    expect(wide).toHaveLength(7);
    const { body: narrow } = await getJson(BASE, '/api/export-results?n=1');
    expect(narrow).toHaveLength(1);
    expect(narrow[0].file).toBe('out-6.mp4');
  });

  it('surfaces a failed export record with ok=false and error intact', async () => {
    await appendExportResult(dir, rec({ kind: 'srt', file: 'out.srt', ok: false, error: 'disk full' }));
    const { body } = await getJson(BASE, '/api/export-results?n=1');
    expect(body[0]).toMatchObject({ kind: 'srt', file: 'out.srt', ok: false, error: 'disk full' });
  });

  it('does not leak into /api/state (stateSummary stays export-results-free by design)', async () => {
    const { body } = await getJson(BASE, '/api/state');
    expect(body).not.toHaveProperty('exportResults');
    expect(body).not.toHaveProperty('export-results');
  });
});

// ---- IA v3 波B §8: read-only route GET /api/notes ----
// src/core/notes.ts(`vedit note` の NOTES.md)を読むだけの route——書き込み
// ルートは daemon に一切追加しない(appendNote/markTodoDone は CLI 専用のまま)。
// web の「机」のプロジェクトメモ表示(renderQueueSheetDesk in app.js)がこれを叩く。
describe('daemon: GET /api/notes', () => {
  const PORT = 18256;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-notes-'));
    dir = path.join(root, 'proj');
    await Project.create(dir, 'notes-route');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('returns [] when NOTES.md does not exist yet', async () => {
    const { status, body } = await getJson(BASE, '/api/notes');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns appended entries oldest-first, with type/text/todos intact', async () => {
    await appendNote(dir, { type: 'policy', text: '前半はテンポ重視で0.5s以上の間を全部詰める。', rev: 3 });
    await appendNote(dir, { type: 'todo', text: 'BGMの候補を3曲ユーザーに出す' });

    const { status, body } = await getJson(BASE, '/api/notes');
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ type: 'policy', rev: 3, text: '前半はテンポ重視で0.5s以上の間を全部詰める。' });
    expect(body[1]).toMatchObject({ type: 'todo' });
    expect(body[1].todos).toEqual([{ done: false, text: 'BGMの候補を3曲ユーザーに出す' }]);
  });

  it('does not leak into /api/state (no write route exists for this data)', async () => {
    const { body } = await getJson(BASE, '/api/state');
    expect(body).not.toHaveProperty('notes');
  });
});

// ---- E-1 (波E NLE操作性パック): split / duplicate ----
describe('daemon: split / duplicate ops (E-1)', () => {
  const PORT = 18258;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-splitdup-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'splitdup');
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [{ id: 's1', path: '/media/one.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('split rejects an unknown clip id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'split', clipId: 'nope', at: 10 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown clip/);
  });

  it('split rejects a point too close to the clip\'s own edge', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'split', clipId: 'c1', at: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/too close/);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'split', clipId: 'c1', at: 30 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/too close/);
  });

  let rightClipId: string;

  it('split divides one clip into two contiguous pieces, content and total duration unchanged', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'split', clipId: 'c1', at: 10 });
    expect(status).toBe(200);
    expect(body.newClipId).toBeTruthy();
    expect(body.newClipId).not.toBe('c1');
    rightClipId = body.newClipId;

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video).toHaveLength(2);
    expect(project.manifest.timeline.video[0]).toMatchObject({ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 });
    expect(project.manifest.timeline.video[1]).toMatchObject({ id: rightClipId, sourceId: 's1', srcIn: 10, srcOut: 30 });
    expect(project.duration).toBeCloseTo(30); // boundary added, no content lost
  });

  it('duplicate splices an identical copy immediately after the original, extending the timeline', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'duplicate', clipId: 'c1' });
    expect(status).toBe(200);
    expect(body.newClipId).toBeTruthy();
    expect(body.newClipId).not.toBe('c1');
    const dupId = body.newClipId;

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.timeline.video.map((c: any) => c.id)).toEqual(['c1', dupId, rightClipId]);
    expect(project.manifest.timeline.video[1]).toMatchObject({ sourceId: 's1', srcIn: 0, srcOut: 10 });
    expect(project.duration).toBeCloseTo(40); // +10s from the duplicated clip
  });

  it('duplicate rejects an unknown clip id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'duplicate', clipId: 'nope' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown clip/);
  });
});

// ---- オーバーレイ・スタック: overlay-add/-update/-remove (generalizes broll-*
// into N layers + image sources + rect/opacity/fade — see
// docs/superpowers/specs/2026-07-18-vedit-overlay-stack.md) ----
describe('daemon: overlay-add / overlay-update / overlay-remove ops', () => {
  const PORT = 18259;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let overlayId: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-overlaystack-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'overlaystack');
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      fps: 30,
      sources: [
        { id: 's1', path: '/media/aroll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/media/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's3', path: '/media/logo.png', duration: 86400, fps: 0, width: 800, height: 450, hasAudio: false, kind: 'image' },
      ],
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 30 }], motion: [] },
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('overlay-add rejects a missing anchor', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-add', sourceId: 's2', in: 0, out: 4,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/anchor/);
  });

  it('overlay-add creates a layer-1 overlay with rect/opacity/fade passed through to addOverlay', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-add', sourceId: 's2', in: 0, out: 4,
      anchor: { sourceId: 's1', srcTime: 2 }, layer: 1, rect: { x: 0, y: 0.1, w: 0.5 }, opacity: 0.8, fade: { in: 0.5 },
    });
    expect(status).toBe(200);
    overlayId = body.id;
    expect(overlayId).toMatch(/^ov/);

    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.overlays.find((r: any) => r.overlay.id === overlayId);
    expect(resolved.tlStart).toBeCloseTo(2);
    expect(resolved.overlay).toMatchObject({
      sourceId: 's2', srcIn: 0, srcOut: 4, layer: 1, rect: { x: 0, y: 0.1, w: 0.5 }, opacity: 0.8, fade: { in: 0.5 },
    });
  });

  it('overlay-add on the same layer overlapping an existing overlay is rejected', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-add', sourceId: 's2', in: 0, out: 2,
      anchor: { sourceId: 's1', srcTime: 3 }, // resolved tl[3,5) overlaps the existing layer-1 [2,6)
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/overlaps existing overlay/);
  });

  let imageOverlayId: string;

  it('overlay-add on a DIFFERENT layer at the same moment stacks instead of conflicting (image source)', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-add', sourceId: 's3', in: 0, out: 4,
      anchor: { sourceId: 's1', srcTime: 2 }, layer: 2, rect: { x: 0.6, y: 0.1, w: 0.3 },
    });
    expect(status).toBe(200);
    imageOverlayId = body.id;
    expect(body.state.overlays).toBe(2);
  });

  it('overlay-update patches layer/rect/opacity, moving the first overlay off layer 1', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-update', id: overlayId, layer: 3, opacity: 0.4,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.overlays.find((r: any) => r.overlay.id === overlayId);
    expect(resolved.overlay).toMatchObject({ layer: 3, opacity: 0.4, rect: { x: 0, y: 0.1, w: 0.5 } }); // rect untouched
  });

  it('overlay-update with rect/opacity/fade set to null clears them back to defaults', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-update', id: overlayId, rect: null, opacity: null, fade: null,
    });
    expect(status).toBe(200);
    const project = (await getJson(BASE, '/api/project')).body;
    const resolved = project.overlays.find((r: any) => r.overlay.id === overlayId);
    expect(resolved.overlay.rect).toBeUndefined();
    expect(resolved.overlay.opacity).toBeUndefined();
    expect(resolved.overlay.fade).toBeUndefined();
    expect(resolved.overlay.layer).toBe(3); // untouched by this patch
  });

  it('overlay-update rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-update', id: 'nope', opacity: 0.5,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown overlay/);
  });

  it('overlay-update rejects a malformed anchor', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-update', id: overlayId, anchor: { sourceId: 's1' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/anchor/);
  });

  it('overlay-remove rejects an unknown id', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/edit', {
      actor: 'claude', baseRev: state.revision, op: 'overlay-remove', id: 'nope',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown overlay/);
  });

  it('overlay-remove removes both overlays', async () => {
    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'overlay-remove', id: overlayId });
    expect(r.status).toBe(200);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'overlay-remove', id: imageOverlayId });
    expect(r.status).toBe(200);

    const finalState = (await getJson(BASE, '/api/state')).body;
    expect(finalState.overlays).toBe(0);
  });
});

// ---- E-1: restore `cause` forwarding (undo/redo tag) — regression coverage
// for the real "連続 undo がバウンスする" bug: /api/edit's 'restore' branch
// used to call p.restore(rev, actor, baseRev) WITHOUT the 4th `cause`
// argument, so every restore — even one the CLI's `vedit undo`/`redo`
// requested with cause:'undo'/'redo' — landed on revisions.jsonl as a bare
// {rev} restore (indistinguishable from a manual jump). resolveUndoTarget
// (core/project.ts) then replayed it as an ORDINARY edit on the next call,
// so a second `vedit undo` recomputed the same "one before current" target
// and bounced right back to the state the first undo had just left, instead
// of walking further back. This suite proves the fix end-to-end over HTTP,
// using the exact same resolveUndoTarget/resolveRedoTarget the CLI itself
// uses to compute the next target from GET /api/revisions. ----
describe('daemon: restore cause forwarding + consecutive undo (E-1 regression)', () => {
  const PORT = 18260;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-undo-regress-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'undo-regress');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('a cause:"undo" restore persists the cause tag on the revision log entry', async () => {
    // Three ordinary edits (rev1/2/3), each independently identifiable by
    // captions.maxCps.
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 0, op: 'captions', patch: { maxCps: 5 } });
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 1, op: 'captions', patch: { maxCps: 10 } });
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 2, op: 'captions', patch: { maxCps: 15 } });

    const revs1 = (await getJson(BASE, '/api/revisions')).body;
    const target1 = resolveUndoTarget(revs1);
    expect(target1).toBe(2); // one step back from rev3: the state right after edit 2

    const r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 3, op: 'restore', rev: target1, cause: 'undo' });
    expect(r.status).toBe(200);

    const revsAfter = (await getJson(BASE, '/api/revisions')).body;
    const last = revsAfter.at(-1);
    expect(last.op).toBe('restore');
    expect(last.params).toMatchObject({ rev: target1, cause: 'undo' }); // the regression: this used to be bare {rev} with no cause

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxCps).toBe(10);
  });

  it('a second consecutive undo walks FURTHER back (to rev1), not back to rev3 ("undo of undo" ping-pong)', async () => {
    const revs2 = (await getJson(BASE, '/api/revisions')).body;
    const target2 = resolveUndoTarget(revs2);
    expect(target2).toBe(1); // must NOT be 3 (that would be the ping-pong bug)

    const state = (await getJson(BASE, '/api/state')).body;
    const r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'restore', rev: target2, cause: 'undo' });
    expect(r.status).toBe(200);

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxCps).toBe(5); // NOT 15 — proves the walk went further back, not backwards-and-forwards
  });

  it('redo brings back the state the second undo just left (rev2\'s content, maxCps=10)', async () => {
    const revs3 = (await getJson(BASE, '/api/revisions')).body;
    const target3 = resolveRedoTarget(revs3);

    const state = (await getJson(BASE, '/api/state')).body;
    const r = await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state.revision, op: 'restore', rev: target3, cause: 'redo' });
    expect(r.status).toBe(200);

    const project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxCps).toBe(10);
  });
});

// ---- E-1: POST /api/undo and POST /api/redo (thin routing over
// Project.undo()/redo(), for a caller — the web UI's Cmd+Z/Shift+Cmd+Z — that
// wants a single request instead of resolving the target client-side like
// cli.ts's `vedit undo`/`redo` do). ----
describe('daemon: POST /api/undo and /api/redo', () => {
  const PORT = 18261;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-undoredo-route-'));
    const dir = path.join(root, 'proj');
    await Project.create(dir, 'undoredo-route');
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('POST /api/undo without baseRev is rejected for actor=claude', async () => {
    const { status, body } = await postJson(BASE, '/api/undo', { actor: 'claude' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseRev is required/);
  });

  it('POST /api/undo on a pristine project returns a Japanese "nothing to undo" 400', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/undo', { actor: 'claude', baseRev: state.revision });
    expect(status).toBe(400);
    expect(body.error).toBe('戻す対象がありません');
  });

  it('POST /api/redo with no prior undo returns a Japanese "nothing to redo" 400', async () => {
    const state = (await getJson(BASE, '/api/state')).body;
    const { status, body } = await postJson(BASE, '/api/redo', { actor: 'claude', baseRev: state.revision });
    expect(status).toBe(400);
    expect(body.error).toBe('やり直す対象がありません');
  });

  it('after two edits, /api/undo restores the state before the second edit, and /api/redo brings it back', async () => {
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 0, op: 'captions', patch: { maxCps: 7 } });
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: 1, op: 'captions', patch: { maxCps: 9 } });

    let state = (await getJson(BASE, '/api/state')).body;
    let r = await postJson(BASE, '/api/undo', { actor: 'claude', baseRev: state.revision });
    expect(r.status).toBe(200);
    let project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxCps).toBe(7);

    state = (await getJson(BASE, '/api/state')).body;
    r = await postJson(BASE, '/api/redo', { actor: 'claude', baseRev: state.revision });
    expect(r.status).toBe(200);
    project = (await getJson(BASE, '/api/project')).body;
    expect(project.manifest.captions.maxCps).toBe(9);
  });

  it('POST /api/undo defaults baseRev from the current revision for a non-claude actor (e.g. "ui")', async () => {
    // One more ordinary edit gives undo a fresh, valid (non-zero) target.
    const state0 = (await getJson(BASE, '/api/state')).body;
    await postJson(BASE, '/api/edit', { actor: 'claude', baseRev: state0.revision, op: 'captions', patch: { maxCps: 11 } });

    const { status } = await postJson(BASE, '/api/undo', { actor: 'ui' }); // no baseRev
    expect(status).toBe(200);
  });
});

// ---- 画像サムネ特例: GET /media/thumb/<sourceId> must never try to seek 30s
// into a still image (Source.kind==='image' carries the 24h
// IMAGE_SOURCE_DURATION sentinel, not a real duration — see the fix's doc
// comment in daemon.ts). run() is stubbed (see this file's top) so this
// suite is deterministic without real ffmpeg/media. ----
describe('daemon: GET /media/thumb (image-kind -ss fix)', () => {
  const PORT = 18262;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;

  beforeAll(async () => {
    runMock.mockClear();
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-thumb-image-'));
    const dir = path.join(root, 'proj');
    const project = await Project.create(dir, 'thumb-image');
    await project.commit(0, 'system', 'setup', {}, 'seed sources', (m) => ({
      ...m,
      sources: [
        { id: 's1', path: '/media/long.mp4', duration: 300, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/media/short.mp4', duration: 40, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's3', path: '/media/logo.png', duration: 86400, fps: 0, width: 800, height: 450, hasAudio: false, kind: 'image' },
      ],
    }));
    const started = await startDaemon({ port: PORT, projectDir: dir });
    server = started.server;
  });

  afterAll(() => server.close());

  it('seeks to 0 for an image-kind source, not 30s (the min(duration*0.25, 30) heuristic would land on 30 for the 86400s sentinel)', async () => {
    const res = await fetch(`${BASE}/media/thumb/s3`);
    expect(res.status).toBe(200);
    const call = runMock.mock.calls.at(-1)!;
    const args = call[1] as string[];
    const ssIdx = args.indexOf('-ss');
    expect(args[ssIdx + 1]).toBe('0');
  });

  it('keeps the existing 25%-of-duration heuristic for a real video source (uncapped case)', async () => {
    const res = await fetch(`${BASE}/media/thumb/s2`); // duration 40 -> 40*0.25=10, under the 30s cap
    expect(res.status).toBe(200);
    const call = runMock.mock.calls.at(-1)!;
    const args = call[1] as string[];
    const ssIdx = args.indexOf('-ss');
    expect(args[ssIdx + 1]).toBe('10');
  });

  it('keeps the existing 30s cap for a long video source', async () => {
    const res = await fetch(`${BASE}/media/thumb/s1`); // duration 300 -> 300*0.25=75, capped at 30
    expect(res.status).toBe(200);
    const call = runMock.mock.calls.at(-1)!;
    const args = call[1] as string[];
    const ssIdx = args.indexOf('-ss');
    expect(args[ssIdx + 1]).toBe('30');
  });
});

// ---- Long media work: stable project-scoped identity, explicit cancellation,
// child AbortSignal propagation, commit-too-late truth, and shutdown drain. ----
describe('daemon: cancellable ingest media jobs', () => {
  const PORT = 18330;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let dirA: string;
  let dirB: string;
  let root: string;

  const fakeProbe = () => JSON.stringify({
    format: { duration: '6' },
    streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 640, height: 360, duration: '6' }],
  });
  const installFastIngest = () => {
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeProbe();
      const output = String(args.at(-1));
      if (cmd === 'ffmpeg' && output.includes('proxy-')) await fsp.writeFile(output, 'complete proxy');
      return '';
    });
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-media-job-ingest-'));
    dirA = path.join(root, 'a');
    dirB = path.join(root, 'b');
    await Project.create(dirA, 'a');
    await Project.create(dirB, 'b');
    server = (await startDaemon({ port: PORT, projectDir: dirA })).server;
  });

  afterAll(() => server.close());

  it('scopes a running task to its project, explicitly cancels before commit, cleans partials, and retries', async () => {
    const file = path.join(root, 'cancel.mp4');
    await fsp.writeFile(file, 'source');
    let proxyStarted!: () => void;
    const proxyIsRunning = new Promise<void>((resolve) => { proxyStarted = resolve; });
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (cmd === 'ffprobe') return fakeProbe();
      const output = String(args.at(-1));
      if (cmd === 'ffmpeg' && output.includes('proxy-')) {
        await fsp.writeFile(output, 'partial proxy');
        proxyStarted();
        return new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const error = new Error('operation cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return '';
    });

    const request = postJson(BASE, '/api/ingest', { file, scenes: false });
    await proxyIsRunning;
    const active = await getJson(BASE, '/api/media-jobs?kind=ingest');
    expect(active.status).toBe(200);
    expect(active.body.jobs).toHaveLength(1);
    expect(active.body.jobs[0]).toMatchObject({ projectDir: dirA, kind: 'ingest', status: 'running' });
    const taskId = active.body.jobs[0].taskId;

    await postJson(BASE, '/api/open', { dir: dirB });
    const wrongProject = await deleteJson(BASE, `/api/media-jobs/${taskId}`);
    expect(wrongProject.status).toBe(404);
    await postJson(BASE, '/api/open', { dir: dirA });

    const cancelled = await deleteJson(BASE, `/api/media-jobs/${taskId}`);
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.job).toMatchObject({ taskId, status: 'cancelling' });
    const terminalResponse = await request;
    expect(terminalResponse).toMatchObject({ status: 409, body: { code: 'OPERATION_CANCELLED' } });
    expect((await Project.open(dirA).then((p) => p.manifest())).revision).toBe(0);
    expect((await Project.open(dirA).then((p) => p.manifest())).sources).toEqual([]);
    expect(await fsp.readdir(path.join(dirA, 'cache'))).toEqual([]);
    const terminal = await getJson(BASE, '/api/media-jobs?kind=ingest');
    expect(terminal.body.jobs[0]).toMatchObject({ taskId, status: 'cancelled', phase: 'finished' });

    installFastIngest();
    const retry = await postJson(BASE, '/api/ingest', { file, scenes: false });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ job: { status: 'success', kind: 'ingest' } });
    expect((await Project.open(dirA).then((p) => p.manifest())).revision).toBe(1);
  });

  it('keeps processing after the initiating HTTP client disconnects; only explicit DELETE cancels', async () => {
    const file = path.join(root, 'disconnect.mp4');
    await fsp.writeFile(file, 'source');
    let proxyStarted!: () => void;
    let finishProxy!: () => void;
    const proxyIsRunning = new Promise<void>((resolve) => { proxyStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishProxy = resolve; });
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (cmd === 'ffprobe') return fakeProbe();
      const output = String(args.at(-1));
      if (cmd === 'ffmpeg' && output.includes('proxy-')) {
        proxyStarted();
        await new Promise<void>((resolve, reject) => {
          finish.then(resolve);
          opts?.signal?.addEventListener('abort', () => reject(new Error('unexpected abort')), { once: true });
        });
        await fsp.writeFile(output, 'complete proxy');
      }
      return '';
    });
    const body = JSON.stringify({ file, scenes: false });
    const target = new URL(BASE);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/api/ingest',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-vedit-project-dir': encodeURIComponent(dirA),
      },
    });
    req.on('error', () => {});
    req.end(body);
    await proxyIsRunning;
    req.destroy();
    finishProxy();

    const deadline = Date.now() + 2_000;
    while ((await Project.open(dirA).then((p) => p.manifest())).revision < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await Project.open(dirA).then((p) => p.manifest())).revision).toBe(2);
    const jobs = await getJson(BASE, '/api/media-jobs?kind=ingest');
    expect(jobs.body.jobs.at(-1)).toMatchObject({ file, status: 'success' });
  });
});

describe('daemon: ingest commit-too-late cancellation boundary', () => {
  const PORT = 18331;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let projectDir: string;
  let file: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-ingest-commit-boundary-'));
    projectDir = path.join(root, 'proj');
    file = path.join(root, 'clip.mp4');
    await fsp.writeFile(file, 'source');
    await Project.create(projectDir, 'commit-boundary');
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return JSON.stringify({
        format: { duration: '6' },
        streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 640, height: 360, duration: '6' }],
      });
      const output = String(args.at(-1));
      if (cmd === 'ffmpeg' && output.includes('proxy-')) await fsp.writeFile(output, 'proxy');
      return '';
    });
    server = (await startDaemon({ port: PORT, projectDir })).server;
  });

  afterAll(() => server.close());

  it('returns 409 instead of claiming cancellation once Project.commit has been invoked', async () => {
    const original = Project.prototype.commit;
    let commitEntered!: () => void;
    let releaseCommit!: () => void;
    const entered = new Promise<void>((resolve) => { commitEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const spy = vi.spyOn(Project.prototype, 'commit').mockImplementation(async function (...args: Parameters<Project['commit']>) {
      if (args[2] === 'ingest') {
        commitEntered();
        await release;
      }
      return original.apply(this, args);
    });
    try {
      const request = postJson(BASE, '/api/ingest', { file, scenes: false });
      await entered;
      const jobs = await getJson(BASE, '/api/media-jobs?kind=ingest');
      const taskId = jobs.body.jobs[0].taskId;
      const cancel = await deleteJson(BASE, `/api/media-jobs/${taskId}`);
      expect(cancel.status).toBe(409);
      expect(cancel.body.error).toMatch(/保存が始まっている/);
      expect(cancel.body.job).toMatchObject({ taskId, phase: 'committing', status: 'running' });
      releaseCommit();
      expect((await request).status).toBe(200);
      expect((await Project.open(projectDir).then((p) => p.manifest())).revision).toBe(1);
    } finally {
      releaseCommit();
      spy.mockRestore();
    }
  });
});

describe('daemon: cancellable scene jobs', () => {
  const PORT = 18332;
  const BASE = `http://localhost:${PORT}`;
  let server: Server;
  let projectDir: string;

  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-scene-job-'));
    projectDir = path.join(root, 'proj');
    const media = path.join(root, 'clip.mp4');
    await fsp.writeFile(media, 'source');
    const project = await Project.create(projectDir, 'scene-job');
    await project.commit(0, 'system', 'setup', {}, 'source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: media, duration: 6, fps: 30, width: 640, height: 360, hasAudio: false }],
    }));
    server = (await startDaemon({ port: PORT, projectDir })).server;
  });

  afterAll(() => server.close());

  it('aborts detection before publication, leaves no sidecar/temp, records terminal truth, and retries', async () => {
    let detectorStarted!: () => void;
    const detectorIsRunning = new Promise<void>((resolve) => { detectorStarted = resolve; });
    sceneRunCaptureMock.mockReset().mockImplementation(async (_cmd: string, _args: string[], opts?: { signal?: AbortSignal }) => {
      detectorStarted();
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const error = new Error('operation cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const request = postJson(BASE, '/api/scenes/detect', { sourceId: 's1' });
    await detectorIsRunning;
    const active = await getJson(BASE, '/api/media-jobs?kind=scenes');
    const taskId = active.body.jobs[0].taskId;
    expect(active.body.jobs[0]).toMatchObject({ projectDir, sourceIds: ['s1'], status: 'running' });
    expect((await deleteJson(BASE, `/api/media-jobs/${taskId}`)).status).toBe(202);
    expect((await request).status).toBe(409);
    await expect(fsp.access(path.join(projectDir, 'scenes-s1.json'))).rejects.toThrow();
    expect((await fsp.readdir(path.join(projectDir, 'cache'))).filter((name) => name.includes('.tmp-') || name.includes('.bak-'))).toEqual([]);
    expect((await Project.open(projectDir).then((p) => p.manifest())).revision).toBe(1);
    const terminal = await getJson(BASE, '/api/media-jobs?kind=scenes');
    expect(terminal.body.jobs[0]).toMatchObject({ taskId, status: 'cancelled', phase: 'finished' });

    sceneRunCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    runMock.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
      const output = String(args.at(-1));
      if (output.includes('.tmp-') && output.endsWith('.jpg')) {
        await fsp.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      return '';
    });
    const retry = await postJson(BASE, '/api/scenes/detect', { sourceId: 's1' });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ job: { kind: 'scenes', status: 'success' } });
    expect((await Project.open(projectDir).then((p) => p.scenes('s1'))).scenes).toHaveLength(1);
    expect((await Project.open(projectDir).then((p) => p.manifest())).revision).toBe(1);
  });
});

describe('daemon: shutdown drains cancelled ingest cleanup', () => {
  const PORT = 18333;
  const BASE = `http://localhost:${PORT}`;

  it('aborts a real registered ingest job before commit and resolves close only after partial cleanup', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-daemon-ingest-shutdown-'));
    const projectDir = path.join(root, 'proj');
    const file = path.join(root, 'clip.mp4');
    await fsp.writeFile(file, 'source');
    await Project.create(projectDir, 'shutdown');
    let proxyStarted!: () => void;
    const proxyIsRunning = new Promise<void>((resolve) => { proxyStarted = resolve; });
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (cmd === 'ffprobe') return JSON.stringify({
        format: { duration: '6' },
        streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 640, height: 360, duration: '6' }],
      });
      const output = String(args.at(-1));
      if (cmd === 'ffmpeg' && output.includes('proxy-')) {
        await fsp.writeFile(output, 'partial');
        proxyStarted();
        return new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            setTimeout(() => {
              const error = new Error('operation cancelled');
              error.name = 'AbortError';
              reject(error);
            }, 40);
          }, { once: true });
        });
      }
      return '';
    });
    const started = await startDaemon({ port: PORT, projectDir });
    const request = postJson(BASE, '/api/ingest', { file, scenes: false });
    await proxyIsRunning;
    const closing = started.close();
    expect(await Promise.race([
      closing.then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('draining'), 10)),
    ])).toBe('draining');
    await closing;
    expect((await request).status).toBe(409);
    expect((await Project.open(projectDir).then((p) => p.manifest())).revision).toBe(0);
    expect(await fsp.readdir(path.join(projectDir, 'cache'))).toEqual([]);

    // A clean daemon can immediately retry the same source after the drained
    // shutdown; no lock, child, or derived partial remains behind.
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return JSON.stringify({
        format: { duration: '6' },
        streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 640, height: 360, duration: '6' }],
      });
      const output = String(args.at(-1));
      if (cmd === 'ffmpeg' && output.includes('proxy-')) await fsp.writeFile(output, 'complete');
      return '';
    });
    const restarted = await startDaemon({ port: 18334, projectDir });
    try {
      const retry = await postJson('http://localhost:18334', '/api/ingest', { file, scenes: false });
      expect(retry.status).toBe(200);
      expect((await Project.open(projectDir).then((p) => p.manifest())).revision).toBe(1);
    } finally {
      await restarted.close();
    }
  });
});
