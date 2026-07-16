import http from 'node:http';
import { promises as fs, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Project } from '../core/project.js';
import {
  addClip,
  applyReframe,
  expandWordIds,
  moveClip,
  padWordRange,
  parseFocus,
  parseReframeSpec,
  removeClip,
  removeSourceRange,
  segments,
  setClipCrop,
  sourceRangeToTimeline,
  timelineDuration,
  trimClip,
  wordRange,
} from '../core/ops.js';
import { upsertProject } from '../core/registry.js';
import { captionCues } from '../core/captions.js';
import { detectFillers, detectSilences, detectSilencesFromPeaks } from '../core/detect.js';
import type { Peaks } from '../core/detect.js';
import { packTranscript } from '../core/pack.js';
import { detectScenesForSource, packScenes } from '../core/scenes.js';
import { ingestFile } from '../ingest/ingest.js';
import type { CutCandidate, Manifest, MotionItem, SceneFile, Transcript } from '../core/types.js';
import { freshId } from '../core/ops.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

interface Ctx {
  project: Project | null;
  clients: Set<WebSocket>;
}

async function allTranscripts(p: Project): Promise<Transcript[]> {
  const m = await p.manifest();
  const out: Transcript[] = [];
  for (const s of m.sources) {
    if (!s.transcribed) continue;
    try {
      out.push(await p.transcript(s.id));
    } catch { /* transcript file missing; skip */ }
  }
  return out;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 1);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function broadcast(ctx: Ctx, msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of ctx.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

/**
 * Word ids restart at w0000 per source, so a sourceId-less remove-words /
 * remove-range is ambiguous the moment there's more than one transcribed
 * source. Returns the list to disambiguate against, or null when it's safe
 * to default (0 or 1 transcribed sources).
 */
function ambiguousSources(m: Manifest): { id: string; path: string }[] | null {
  const transcribed = m.sources.filter((s) => s.transcribed);
  return transcribed.length >= 2 ? transcribed.map((s) => ({ id: s.id, path: path.basename(s.path) })) : null;
}

/** Snapshot the state Claude/UI needs after every mutation. */
async function stateSummary(p: Project) {
  const m = await p.manifest();
  const cands = await p.candidates();
  const pending = cands.filter((c) => c.status === 'proposed').length;
  return {
    revision: m.revision,
    name: m.name,
    fps: m.fps,
    duration: timelineDuration(m),
    clips: m.timeline.video.length,
    motion: m.timeline.motion.length,
    sources: m.sources.map((s) => ({ id: s.id, path: s.path, duration: s.duration, transcribed: !!s.transcribed })),
    pendingCandidates: pending,
    captions: m.captions,
  };
}

export async function startDaemon(opts: { port?: number; projectDir?: string } = {}) {
  const port = opts.port ?? Number(process.env.VEDIT_PORT ?? 7799);
  const ctx: Ctx = { project: null, clients: new Set() };
  if (opts.projectDir) {
    try {
      ctx.project = await Project.open(opts.projectDir);
    } catch {
      ctx.project = await Project.create(opts.projectDir, path.basename(opts.projectDir));
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    try {
      await route(ctx, req, res, url);
    } catch (e: any) {
      const status = e?.code === 'STALE_REVISION' ? 409 : 400;
      json(res, status, { error: e?.message ?? String(e), code: e?.code });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ctx.clients.add(ws);
    ws.on('close', () => ctx.clients.delete(ws));
  });

  // The single mutation wrapper: commit + notify everyone.
  async function mutate(
    actor: 'claude' | 'ui' | 'system',
    baseRev: number,
    op: string,
    params: unknown,
    summary: string,
    fn: (m: Manifest) => Manifest,
  ) {
    const p = ctx.project!;
    const m = await p.commit(baseRev, actor, op, params, summary, fn);
    broadcast(ctx, { type: 'update', revision: m.revision, op, summary });
    return m;
  }

  async function route(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const { pathname } = url;
    const method = req.method ?? 'GET';

    // ---- project lifecycle ----
    if (pathname === '/api/open' && method === 'POST') {
      const b = await readBody(req);
      const dir = path.resolve(b.dir);
      try {
        ctx.project = await Project.open(dir);
        await upsertProject(dir, (await ctx.project.manifest()).name); // Project.create() upserts on its own path
      } catch {
        ctx.project = await Project.create(dir, b.name ?? path.basename(dir));
      }
      broadcast(ctx, { type: 'project', dir });
      return json(res, 200, { ok: true, dir, state: await stateSummary(ctx.project) });
    }
    if (pathname === '/api/ping') return json(res, 200, { ok: true, project: ctx.project?.dir ?? null });

    const p = ctx.project;
    if (!p) {
      if (pathname.startsWith('/api/')) return json(res, 400, { error: 'no project open; POST /api/open {dir}' });
    }

    // ---- static web UI + media ----
    if (!pathname.startsWith('/api/') && method === 'GET') {
      if (pathname.startsWith('/media/') && p) return serveMedia(p, pathname, req, res);
      return serveStatic(pathname, res);
    }
    if (!p) return json(res, 400, { error: 'no project open' });

    // ---- reads ----
    if (pathname === '/api/state') return json(res, 200, await stateSummary(p));
    if (pathname === '/api/project') {
      const m = await p.manifest();
      return json(res, 200, { manifest: m, segments: segments(m), duration: timelineDuration(m) });
    }
    if (pathname === '/api/revisions') return json(res, 200, await p.revisions());
    if (pathname === '/api/transcript') {
      const m = await p.manifest();
      const requestedSource = url.searchParams.get('source');
      const full = Boolean(url.searchParams.get('full'));
      const transcribedSrcs = m.sources.filter((s) => s.transcribed);
      if (transcribedSrcs.length === 0) return json(res, 404, { error: 'no transcribed source' });

      const renderPacked = async (sourceId: string) => {
        const t = await p.transcript(sourceId);
        const cands = await p.candidates();
        return packTranscript(m, t, cands);
      };

      if (requestedSource) {
        if (full) return json(res, 200, await p.transcript(requestedSource));
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(await renderPacked(requestedSource));
      }

      if (transcribedSrcs.length > 1) {
        if (full) {
          return json(res, 400, {
            error: 'multiple transcribed sources; specify sourceId (--source <id>)',
            sources: transcribedSrcs.map((s) => ({ id: s.id, path: path.basename(s.path) })),
          });
        }
        const parts: string[] = [];
        for (const s of transcribedSrcs) {
          parts.push(`## source ${s.id} (${path.basename(s.path)}) — use --source ${s.id} for edits`);
          parts.push(await renderPacked(s.id));
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(parts.join('\n\n'));
      }

      // exactly one transcribed source
      const sourceId = transcribedSrcs[0].id;
      if (full) return json(res, 200, await p.transcript(sourceId));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(await renderPacked(sourceId));
    }
    if (pathname === '/api/captions') {
      const m = await p.manifest();
      return json(res, 200, captionCues(m, await allTranscripts(p)));
    }
    if (pathname.startsWith('/api/motion/') && method === 'GET') {
      const id = pathname.split('/')[3];
      try {
        const spec = JSON.parse(await fs.readFile(path.join(p.motionDir, `${id}.json`), 'utf8'));
        return json(res, 200, spec);
      } catch {
        return json(res, 404, { error: `no motion spec: ${id}` });
      }
    }
    if (pathname === '/api/candidates') {
      const all = await p.candidates();
      const pending = url.searchParams.get('all') ? all : all.filter((c) => c.status === 'proposed');
      return json(res, 200, pending);
    }
    if (pathname === '/api/scenes' && method === 'GET') {
      const m = await p.manifest();
      const requestedSource = url.searchParams.get('source');
      const full = Boolean(url.searchParams.get('full'));

      if (requestedSource) {
        const f = await p.scenes(requestedSource);
        if (full) return json(res, 200, f);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(packScenes(f));
      }

      const withScenes: string[] = [];
      for (const s of m.sources) {
        const f = await p.scenes(s.id);
        if (f.scenes.length) withScenes.push(s.id);
      }
      if (withScenes.length === 0) {
        return json(res, 404, { error: 'no scenes detected yet; run `vedit scenes detect`' });
      }
      if (withScenes.length > 1) {
        if (full) {
          return json(res, 400, {
            error: 'multiple sources have scenes; specify sourceId (--source <id>)',
            sources: withScenes,
          });
        }
        const parts: string[] = [];
        for (const id of withScenes) {
          parts.push(`## source ${id} — use --source ${id} for edits`);
          parts.push(packScenes(await p.scenes(id)));
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(parts.join('\n\n'));
      }

      const only = withScenes[0];
      if (full) return json(res, 200, await p.scenes(only));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(packScenes(await p.scenes(only)));
    }

    // ---- ingest ----
    if (pathname === '/api/ingest' && method === 'POST') {
      const b = await readBody(req);
      broadcast(ctx, { type: 'ingest-start', file: b.file });
      const { source: src, timings } = await ingestFile(p, b.file, {
        language: b.language,
        transcribe: b.transcribe,
        addToTimeline: b.addToTimeline,
        onProgress: (step) => broadcast(ctx, { type: 'ingest-progress', step }),
      });
      broadcast(ctx, { type: 'update', revision: (await p.manifest()).revision, op: 'ingest', summary: `ingested ${b.file}` });
      return json(res, 200, { source: src, timings, state: await stateSummary(p) });
    }

    // ---- edits ----
    if (pathname === '/api/edit' && method === 'POST') {
      const b = await readBody(req);
      const actor = b.actor ?? 'claude';
      if (actor === 'claude' && typeof b.baseRev !== 'number') {
        return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
      }
      const m0 = await p.manifest();
      const baseRev = b.baseRev ?? m0.revision;

      if (b.op === 'remove-words') {
        let sourceId = b.sourceId as string | undefined;
        if (!sourceId) {
          const amb = ambiguousSources(m0);
          if (amb) return json(res, 400, { error: 'multiple transcribed sources; specify sourceId (--source <id>)', sources: amb });
          sourceId = m0.sources.find((s) => s.transcribed)?.id;
        }
        const t = await p.transcript(sourceId!);
        const ids = expandWordIds(b.ids, t.words);
        const raw = wordRange(t.words, ids);
        const pad = typeof b.pad === 'number' ? b.pad : 0.08;
        const r = padWordRange(t.words, ids, raw, pad);
        if (r.t1 - r.t0 < 1 / m0.fps) {
          return json(res, 400, { error: 'nothing to remove (range collapsed to zero frames)' });
        }
        const removed = ids.length;
        const text = t.words.filter((w) => ids.includes(w.id)).map((w) => w.text).join('');
        const before = timelineDuration(m0);
        const preview = removeSourceRange(m0, sourceId!, r.t0, r.t1);
        const removedSeconds = before - timelineDuration(preview);
        await mutate(actor, baseRev, 'remove-words', b, `removed ${removed} words (${removedSeconds.toFixed(1)}s): "${text.slice(0, 40)}"`, (m) =>
          removeSourceRange(m, sourceId!, r.t0, r.t1),
        );
        return json(res, 200, { removedSeconds, state: await stateSummary(p) });
      }
      if (b.op === 'remove-range') {
        let sourceId = b.sourceId as string | undefined;
        if (!sourceId) {
          const amb = ambiguousSources(m0);
          if (amb) return json(res, 400, { error: 'multiple transcribed sources; specify sourceId (--source <id>)', sources: amb });
          sourceId = m0.sources[0]?.id;
        }
        if (Math.abs(b.t1 - b.t0) < 1 / m0.fps) {
          return json(res, 400, { error: 'nothing to remove (range collapsed to zero frames)' });
        }
        const before = timelineDuration(m0);
        const preview = removeSourceRange(m0, sourceId!, b.t0, b.t1);
        const removedSeconds = before - timelineDuration(preview);
        await mutate(actor, baseRev, 'remove-range', b, `removed ${removedSeconds.toFixed(1)}s of source ${sourceId}`, (m) =>
          removeSourceRange(m, sourceId!, b.t0, b.t1),
        );
        return json(res, 200, { removedSeconds, state: await stateSummary(p) });
      }
      if (b.op === 'trim') {
        await mutate(actor, baseRev, 'trim', b, `trim ${b.clipId} ${b.edge} ${b.frames}f`, (m) =>
          trimClip(m, b.clipId, b.edge, b.frames),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'captions') {
        await mutate(actor, baseRev, 'captions', b, `captions ${JSON.stringify(b.patch)}`, (m) => ({
          ...m,
          captions: { ...m.captions, ...b.patch },
        }));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'motion-add') {
        const specId = freshId('mo');
        const specFile = `${specId}.json`;
        await fs.writeFile(path.join(p.motionDir, specFile), JSON.stringify({ id: specId, ...b.spec }, null, 2));
        const item: MotionItem = { id: specId, spec: specFile, tlStart: b.tlStart, duration: b.duration };
        await mutate(actor, baseRev, 'motion-add', b, `motion ${b.spec.type} at ${b.tlStart}s`, (m) => ({
          ...m,
          timeline: { ...m.timeline, motion: [...m.timeline.motion, item] },
        }));
        return json(res, 200, { id: specId, state: await stateSummary(p) });
      }
      if (b.op === 'motion-update') {
        const specPath = path.join(p.motionDir, `${b.id}.json`);
        if (b.spec) {
          const old = JSON.parse(await fs.readFile(specPath, 'utf8'));
          await fs.writeFile(specPath, JSON.stringify({ ...old, ...b.spec, id: b.id }, null, 2));
        }
        await mutate(actor, baseRev, 'motion-update', b, `motion ${b.id} updated`, (m) => ({
          ...m,
          timeline: {
            ...m.timeline,
            motion: m.timeline.motion.map((x) =>
              x.id === b.id
                ? { ...x, tlStart: b.tlStart ?? x.tlStart, duration: b.duration ?? x.duration }
                : x,
            ),
          },
        }));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'motion-remove') {
        await mutate(actor, baseRev, 'motion-remove', b, `motion ${b.id} removed`, (m) => ({
          ...m,
          timeline: { ...m.timeline, motion: m.timeline.motion.filter((x) => x.id !== b.id) },
        }));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'clip-add') {
        const clipId = freshId('c');
        await mutate(actor, baseRev, 'clip-add', b, `clip-add ${b.sourceId} [${b.in ?? 0}-${b.out ?? '*'}]`, (m) =>
          addClip(m, b.sourceId, { in: b.in, out: b.out, at: b.at, id: clipId }),
        );
        return json(res, 200, { clipId, state: await stateSummary(p) });
      }
      if (b.op === 'clip-remove') {
        await mutate(actor, baseRev, 'clip-remove', b, `clip-remove ${b.clipId}`, (m) => removeClip(m, b.clipId));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'clip-move') {
        await mutate(actor, baseRev, 'clip-move', b, `clip-move ${b.clipId} before ${b.before}`, (m) =>
          moveClip(m, b.clipId, b.before),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'reframe') {
        const output = parseReframeSpec(b.spec);
        const focus = parseFocus(b.focus);
        await mutate(actor, baseRev, 'reframe', b, `reframe ${output.width}x${output.height} focus=${b.focus ?? 'center'}`, (m) =>
          applyReframe(m, output, focus),
        );
        return json(res, 200, { output, state: await stateSummary(p) });
      }
      if (b.op === 'clip-crop') {
        await mutate(actor, baseRev, 'clip-crop', b, `clip-crop ${b.clipId} x=${b.x ?? '-'} y=${b.y ?? '-'}`, (m) =>
          setClipCrop(m, b.clipId, { x: b.x, y: b.y }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'restore') {
        const m = await p.restore(b.rev, actor);
        broadcast(ctx, { type: 'update', revision: m.revision, op: 'restore', summary: `restored r${b.rev}` });
        return json(res, 200, { state: await stateSummary(p) });
      }
      return json(res, 400, { error: `unknown op: ${b.op}` });
    }

    // ---- detection & candidate queue ----
    if (pathname === '/api/detect' && method === 'POST') {
      const b = await readBody(req);
      const m = await p.manifest();
      const out: CutCandidate[] = [];
      const transcripts = await allTranscripts(p);
      const wordsBySource = new Map(transcripts.map((t) => [t.sourceId, t.words]));
      for (const t of transcripts) {
        if (b.silence !== false) out.push(...detectSilences(t, b.minGap ?? 0.7));
        if (b.fillers !== false) out.push(...detectFillers(t));
      }
      // Word-gap detection misses silence when whisper packs words with no
      // gap; fall back to the waveform for every source that has peaks, and
      // merge with anything the word-gap pass already found nearby.
      if (b.silence !== false) {
        for (const src of m.sources) {
          if (!src.peaks) continue;
          let peaks: Peaks;
          try {
            peaks = JSON.parse(await fs.readFile(path.join(p.dir, src.peaks), 'utf8'));
          } catch {
            continue;
          }
          const waveCands = detectSilencesFromPeaks(peaks, {
            sourceId: src.id,
            threshold: b.threshold ?? 0.06,
            minGap: b.minGap ?? 0.7,
            words: wordsBySource.get(src.id),
          });
          for (const c of waveCands) {
            const dup = out.some(
              (o) => o.kind === 'silence' && o.sourceId === c.sourceId && Math.abs(o.t0 - c.t0) <= 0.2 && Math.abs(o.t1 - c.t1) <= 0.2,
            );
            if (!dup) out.push(c);
          }
        }
      }
      // Keep prior decisions: don't resurrect ranges already approved/rejected.
      const prior = await p.candidates();
      const decided = prior.filter((c) => c.status !== 'proposed');
      const fresh = out.filter(
        (c) => !decided.some((d) => d.sourceId === c.sourceId && Math.abs(d.t0 - c.t0) < 0.05 && Math.abs(d.t1 - c.t1) < 0.05),
      );
      const merged = [...decided, ...fresh];
      await p.writeCandidates(merged);
      broadcast(ctx, { type: 'candidates', pending: fresh.length });
      return json(res, 200, {
        pending: fresh.filter((c) => c.status === 'proposed'),
        summary: `${fresh.length} candidates (use approve/reject; approving applies the cut)`,
        revision: m.revision,
      });
    }
    if (pathname === '/api/candidates/decide' && method === 'POST') {
      const b = await readBody(req); // { ids: string[] | 'all', decision, actor, baseRev }
      const actor = b.actor ?? 'ui';
      if (actor === 'claude' && typeof b.baseRev !== 'number') {
        return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
      }
      const all = await p.candidates();
      const target = b.ids === 'all' ? all.filter((c) => c.status === 'proposed') : all.filter((c) => b.ids.includes(c.id));
      if (target.length === 0) return json(res, 400, { error: 'no matching pending candidates' });
      if (b.decision === 'approve') {
        const m0 = await p.manifest();
        const baseRev = b.baseRev ?? m0.revision;
        // Apply all approved cuts in ONE revision so undo is atomic. Compute
        // the real (frame-snapped) delta up front so the summary and
        // response agree with what actually lands on the timeline.
        const before = timelineDuration(m0);
        let preview = m0;
        for (const c of target) preview = removeSourceRange(preview, c.sourceId, c.t0, c.t1);
        const removedSeconds = before - timelineDuration(preview);
        await mutate(actor, baseRev, 'apply-candidates', { ids: target.map((c) => c.id) },
          `applied ${target.length} cuts (-${removedSeconds.toFixed(1)}s)`, (m) => {
            let cur = m;
            for (const c of target) cur = removeSourceRange(cur, c.sourceId, c.t0, c.t1);
            return cur;
          });
      }
      for (const c of target) c.status = b.decision === 'approve' ? 'approved' : 'rejected';
      await p.writeCandidates(all);
      broadcast(ctx, { type: 'candidates', pending: all.filter((c) => c.status === 'proposed').length });
      return json(res, 200, { decided: target.length, state: await stateSummary(p) });
    }

    // ---- scene index (non-destructive: no baseRev, like candidates.json) ----
    if (pathname === '/api/scenes/detect' && method === 'POST') {
      const b = await readBody(req);
      const m = await p.manifest();
      const targets: string[] = b.sourceId ? [b.sourceId] : m.sources.map((s) => s.id);
      const results: SceneFile[] = [];
      for (const sourceId of targets) {
        results.push(
          await detectScenesForSource(p, m, sourceId, {
            sensitivity: b.sensitivity,
            maxLen: b.maxLen,
            minLen: b.minLen,
          }),
        );
      }
      broadcast(ctx, { type: 'scenes', sources: targets });
      return json(res, 200, { detected: results.map((f) => ({ sourceId: f.sourceId, count: f.scenes.length })) });
    }
    if (pathname === '/api/scenes/note' && method === 'POST') {
      const b = await readBody(req); // { sourceId, id, text, by }
      if (!b.sourceId || !b.id || !b.text || !b.by) {
        return json(res, 400, { error: 'sourceId, id, text, and by are required' });
      }
      if (b.by !== 'user' && b.by !== 'model') {
        return json(res, 400, { error: `by must be "user" or "model" (got ${JSON.stringify(b.by)})` });
      }
      const scene = await p.setSceneNote(b.sourceId, b.id, b.text, b.by);
      broadcast(ctx, { type: 'scenes', sources: [b.sourceId] });
      return json(res, 200, { scene });
    }

    return json(res, 404, { error: `no route: ${method} ${pathname}` });
  }

  function serveStatic(pathname: string, res: http.ServerResponse) {
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const full = path.join(WEB_DIR, path.normalize(file));
    if (!full.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
    try {
      const data = statSync(full);
      const types: Record<string, string> = {
        '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
      };
      res.writeHead(200, { 'content-type': types[path.extname(full)] ?? 'application/octet-stream', 'content-length': data.size });
      createReadStream(full).pipe(res);
    } catch {
      json(res, 404, { error: 'not found' });
    }
  }

  async function serveMedia(p: Project, pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
    // /media/proxy/<sourceId> | /media/peaks/<sourceId>
    const [, , kind, sourceId] = pathname.split('/');
    const m = await p.manifest();
    const src = m.sources.find((s) => s.id === sourceId);
    if (!src) return json(res, 404, { error: 'unknown source' });
    const rel = kind === 'proxy' ? src.proxy : src.peaks;
    if (!rel) return json(res, 404, { error: `no ${kind} for source` });
    const full = path.join(p.dir, rel);
    const stat = statSync(full);
    const type = kind === 'proxy' ? 'video/mp4' : 'application/json';
    const range = req.headers.range;
    if (range) {
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = Number(a);
      const end = b ? Number(b) : stat.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      createReadStream(full, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
      createReadStream(full).pipe(res);
    }
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, url: `http://localhost:${port}` };
}
