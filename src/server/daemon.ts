import http from 'node:http';
import { promises as fs, createReadStream, createWriteStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Project, resolveWithinDir } from '../core/project.js';
import {
  addClip,
  addMusic,
  addOverlay,
  addSprite,
  applyReframe,
  buildSelectsTimeline,
  COLOR_WARNING_MESSAGE,
  cullingStats,
  expandWordIds,
  moveClip,
  needsColorTransform,
  orphanedOverlays,
  orphanedSprites,
  padWordRange,
  parseFocus,
  parseReframeSpec,
  removeClip,
  removeMusic,
  removeOverlay,
  removeSourceRange,
  removeSprite,
  resolveOverlays,
  resolveSprites,
  segments,
  setAudioMix,
  setAudioRepair,
  setClipCrop,
  setColorAdjust,
  setColorTransform,
  setSceneReview,
  sourceRangeToTimeline,
  timelineDuration,
  trimClip,
  updateMusic,
  updateOverlay,
  updateSprite,
  wordRange,
} from '../core/ops.js';
import { upsertProject } from '../core/registry.js';
import { captionCues } from '../core/captions.js';
import { detectFillers, detectSilences, detectSilencesFromPeaks } from '../core/detect.js';
import type { Peaks } from '../core/detect.js';
import { packTranscript } from '../core/pack.js';
import { detectScenesForSource, packScenes } from '../core/scenes.js';
import { ingestFile, makeProxy, probeAudio } from '../ingest/ingest.js';
import { run } from '../ingest/run.js';
import type { CutCandidate, Manifest, MotionItem, RevisionEntry, SceneFile, Transcript } from '../core/types.js';
import { freshId } from '../core/ops.js';
import { applyKitDefaults, readKitFile, recognizedKitSections } from '../core/kit.js';
import { locateMedia, type MediaFingerprint } from '../ingest/locate.js';

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

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB

class PayloadTooLargeError extends Error {
  code = 'PAYLOAD_TOO_LARGE';
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Keep draining the stream instead of destroying the socket: an abrupt
      // reset while the client is still mid-upload surfaces as a raw socket
      // error on their end rather than our 413 response.
      tooLarge = true;
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} byte limit`);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Open an existing project at `dir`, or create a fresh one if none exists
 * yet. Only a missing project.json (ENOENT) counts as "no project here" —
 * any other failure (corrupt JSON, permissions, ...) is surfaced as-is so a
 * damaged project.json is never silently clobbered by Project.create's
 * blank manifest.
 */
async function openOrCreateProject(dir: string, name: string): Promise<{ project: Project; created: boolean }> {
  try {
    const project = await Project.open(dir);
    await project.manifest(); // force a parse now so corruption surfaces before we decide whether to fall back
    return { project, created: false };
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      return { project: await Project.create(dir, name), created: true };
    }
    throw e;
  }
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

/**
 * Parse a revision reference for `POST /api/show {kind:'compare'}` — accepts
 * either a bare number or the "r12" display form the activity feed/CLI use
 * (`vedit show compare r5 r7`). Returns null on anything else so the caller
 * can 400 with a clear message instead of comparing against NaN.
 */
function parseRevRef(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.trim().replace(/^r/i, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read-only lookup of the manifest snapshot as of revision `rev`, straight
 * from revisions.jsonl (via Project's public `revisionsPath` getter) — kept
 * local to daemon.ts rather than added to core/project.ts, which is off
 * limits while another agent works in src/core/ for this change (see the
 * task brief). Used only by /api/show's kind=compare (never commits
 * anything, unlike Project.restore()). Revision 0 is the pristine
 * pre-history state (no commits logged yet), which resolves to `null`;
 * callers that need a duration for it should treat that as 0.
 */
async function revisionSnapshot(p: Project, rev: number): Promise<Manifest | null> {
  if (rev === 0) return null;
  let raw: string;
  try {
    raw = await fs.readFile(p.revisionsPath, 'utf8');
  } catch {
    raw = '';
  }
  let target: RevisionEntry | undefined;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: RevisionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tolerate a partial trailing line (crash mid-append), same as Project's own reconcile()
    }
    if (entry.rev === rev) target = entry; // last match wins (revs are unique in practice)
  }
  if (!target) throw new Error(`revision ${rev} not found`);
  return target.snapshot;
}

/**
 * Sanitize a browser-supplied filename for `POST /api/upload` (D&D ingest
 * fallback when a dropped file can't be located on disk — see
 * src/ingest/locate.ts): strip any directory components (defense in depth;
 * uniqueDestPath below also always joins under the fixed media/ dir, so a
 * "../.." here couldn't escape it either way) and replace anything but a
 * conservative safe-character set.
 */
function sanitizeUploadName(name: string): string {
  const base = path.basename(String(name || '')).replace(/[\x00-\x1f]/g, '');
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  return cleaned || 'upload.bin';
}

/** Append -1, -2, ... before the extension until `dir/name` doesn't already exist, so a second drop of a same-named file never clobbers the first. */
async function uniqueDestPath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'upload';
  let candidate = path.join(dir, name);
  for (let i = 1; ; i++) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
}

/** Every source's scenes file, skipping sources with no detected scenes (out of culling scope). */
async function sceneFilesFor(p: Project, m: Manifest): Promise<SceneFile[]> {
  const out: SceneFile[] = [];
  for (const s of m.sources) {
    const f = await p.scenes(s.id);
    if (f.scenes.length) out.push(f);
  }
  return out;
}

function reviewMapFor(m: Manifest, sourceId: string): Record<string, 'keep' | 'reject'> {
  return m.culling?.[sourceId] ?? {};
}

/** Merge review verdicts onto a SceneFile's scenes for API responses, without ever writing them back to scenes-<sourceId>.json (review state lives only on the manifest). */
function withReview(f: SceneFile, m: Manifest): { sourceId: string; scenes: (SceneFile['scenes'][number] & { review?: 'keep' | 'reject' })[] } {
  const rv = reviewMapFor(m, f.sourceId);
  return { ...f, scenes: f.scenes.map((s) => (rv[s.id] ? { ...s, review: rv[s.id] } : s)) };
}

/** Snapshot the state Claude/UI needs after every mutation. */
async function stateSummary(p: Project) {
  const m = await p.manifest();
  const cands = await p.candidates();
  const pending = cands.filter((c) => c.status === 'proposed').length;
  const orphans = orphanedOverlays(m);
  const spriteOrphans = orphanedSprites(m);
  return {
    revision: m.revision,
    name: m.name,
    fps: m.fps,
    duration: timelineDuration(m),
    clips: m.timeline.video.length,
    motion: m.timeline.motion.length,
    music: (m.timeline.music ?? []).length,
    overlays: (m.timeline.overlays ?? []).length,
    sprites: (m.timeline.sprites ?? []).length,
    kit: m.kit ? { path: m.kit.path } : undefined,
    sources: m.sources.map((s) => ({
      id: s.id,
      path: s.path,
      duration: s.duration,
      transcribed: !!s.transcribed,
      ...(needsColorTransform(s.color) ? { colorWarning: COLOR_WARNING_MESSAGE } : {}),
    })),
    pendingCandidates: pending,
    captions: m.captions,
    // orphaned B-roll overlays (anchor cut away) — see ops.ts's
    // orphanedOverlays; only present when non-empty, like `warning` below.
    ...(orphans.length ? { orphanedOverlays: orphans } : {}),
    // orphaned W8 sprites (anchor cut away) — see ops.ts's orphanedSprites.
    ...(spriteOrphans.length ? { orphanedSprites: spriteOrphans } : {}),
    // Set only when Project.open() had to repair a crash-damaged
    // revisions.jsonl (see Project.reconcile); absent otherwise.
    ...(p.warning ? { warning: p.warning } : {}),
  };
}

export async function startDaemon(opts: { port?: number; projectDir?: string } = {}) {
  const port = opts.port ?? Number(process.env.VEDIT_PORT ?? 7799);
  const ctx: Ctx = { project: null, clients: new Set() };
  if (opts.projectDir) {
    const { project } = await openOrCreateProject(opts.projectDir, path.basename(opts.projectDir));
    ctx.project = project;
    if (project.warning) console.warn(`[vedit] ${project.dir}: ${project.warning}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    try {
      await route(ctx, req, res, url);
    } catch (e: any) {
      const status = e?.code === 'STALE_REVISION' ? 409 : e?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
      json(res, status, { error: e?.message ?? String(e), code: e?.code });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ctx.clients.add(ws);
    ws.on('close', () => ctx.clients.delete(ws));
  });

  // The single mutation wrapper: commit + notify everyone. `p` is always the
  // project the caller captured at the top of route() for THIS request — not
  // `ctx.project` re-read at call time — so a /api/open that swaps the
  // globally-open project mid-request can never redirect an in-flight edit
  // onto a different project directory.
  async function mutate(
    p: Project,
    actor: 'claude' | 'ui' | 'system',
    baseRev: number,
    op: string,
    params: unknown,
    summary: string,
    fn: (m: Manifest) => Manifest,
    motionSpecUpdates?: Record<string, unknown>,
  ) {
    const m = await p.commit(baseRev, actor, op, params, summary, fn, motionSpecUpdates);
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
      const { project, created } = await openOrCreateProject(dir, b.name ?? path.basename(dir));
      ctx.project = project;
      if (!created) await upsertProject(dir, (await project.manifest()).name); // Project.create() upserts on its own path
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
      // `overlays`/`sprites` carry every item's resolved tlStart (null =
      // orphan) so the web UI never has to reimplement sourceTimeToTimeline
      // itself.
      return json(res, 200, {
        manifest: m, segments: segments(m), duration: timelineDuration(m),
        overlays: resolveOverlays(m), sprites: resolveSprites(m),
      });
    }
    if (pathname === '/api/kit') {
      const m = await p.manifest();
      if (!m.kit) return json(res, 200, { path: null, kit: null });
      try {
        const kit = await readKitFile(m.kit.path);
        return json(res, 200, { path: m.kit.path, kit, recognizedSections: recognizedKitSections(kit) });
      } catch (e: any) {
        return json(res, 200, { path: m.kit.path, kit: null, error: e?.message ?? String(e) });
      }
    }
    if (pathname === '/api/revisions') return json(res, 200, await p.revisions());
    if (pathname === '/api/transcript') {
      const m = await p.manifest();
      const requestedSource = url.searchParams.get('source');
      const full = Boolean(url.searchParams.get('full'));
      // Never resolve a transcript path for an id that isn't a real source —
      // the manifest is the allowlist, not just a character-class check.
      if (requestedSource && !m.sources.some((s) => s.id === requestedSource)) {
        return json(res, 404, { error: `unknown source: ${requestedSource}` });
      }
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
        const spec = JSON.parse(await fs.readFile(p.motionSpecPath(id), 'utf8'));
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
      // Same allowlist-against-manifest rule as /api/transcript above.
      if (requestedSource && !m.sources.some((s) => s.id === requestedSource)) {
        return json(res, 404, { error: `unknown source: ${requestedSource}` });
      }

      if (requestedSource) {
        const f = await p.scenes(requestedSource);
        if (full) return json(res, 200, withReview(f, m));
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(packScenes(f, reviewMapFor(m, requestedSource)));
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
          parts.push(packScenes(await p.scenes(id), reviewMapFor(m, id)));
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end(parts.join('\n\n'));
      }

      const only = withScenes[0];
      if (full) return json(res, 200, withReview(await p.scenes(only), m));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(packScenes(await p.scenes(only), reviewMapFor(m, only)));
    }
    if (pathname === '/api/review-status' && method === 'GET') {
      const m = await p.manifest();
      const sceneFiles = await sceneFilesFor(p, m);
      const stats = cullingStats(m, sceneFiles);
      let next: { sourceId: string; sceneId: string } | null = null;
      outer: for (const f of sceneFiles) {
        const rv = reviewMapFor(m, f.sourceId);
        for (const sc of f.scenes) {
          if (!rv[sc.id]) {
            next = { sourceId: f.sourceId, sceneId: sc.id };
            break outer;
          }
        }
      }
      return json(res, 200, { ...stats, next });
    }

    // ---- ingest ----
    if (pathname === '/api/ingest' && method === 'POST') {
      const b = await readBody(req);
      broadcast(ctx, { type: 'ingest-start', file: b.file });
      const { source: src, timings } = await ingestFile(p, b.file, {
        language: b.language,
        transcribe: b.transcribe,
        addToTimeline: b.addToTimeline,
        // Set only by `ingest-batch` (see src/ingest/batch.ts), which
        // computes the hash itself during its verification pass; a plain
        // `vedit ingest` never sends this, so `source.sha256` stays unset
        // exactly as before this option existed.
        sha256: b.sha256,
        onProgress: (step) => broadcast(ctx, { type: 'ingest-progress', step }),
      });
      broadcast(ctx, { type: 'update', revision: (await p.manifest()).revision, op: 'ingest', summary: `ingested ${b.file}` });
      return json(res, 200, { source: src, timings, state: await stateSummary(p) });
    }

    // ---- drag-and-drop ingest (W-UI §4): locate the dropped file's real
    // path on disk (link, no copy) by name + content fingerprint, or accept
    // a streamed upload when nothing matches. ----
    if (pathname === '/api/locate-media' && method === 'POST') {
      const b = await readBody(req);
      const name = typeof b.name === 'string' ? b.name : '';
      const size = Number(b.size);
      const headSha256 = typeof b.headSha256 === 'string' ? b.headSha256 : '';
      const tailSha256 = typeof b.tailSha256 === 'string' ? b.tailSha256 : '';
      if (!name || !Number.isFinite(size) || size < 0 || !headSha256 || !tailSha256) {
        return json(res, 400, { error: 'locate-media: name, size, headSha256, tailSha256 are required' });
      }
      const fingerprint: MediaFingerprint = { size, headSha256, tailSha256 };
      const found = await locateMedia(name, fingerprint);
      return json(res, 200, { found: found != null, path: found ?? null });
    }
    if (pathname === '/api/upload' && method === 'POST') {
      // Deliberately bypasses readBody() (10MB JSON-body cap, buffers fully
      // into memory): an upload is raw binary of arbitrary size, streamed
      // straight to disk. The client sends the File itself as the request
      // body (fetch(..., {body: file})) with the name as a query param,
      // since a filename can't safely ride inside a header.
      const rawName = url.searchParams.get('name') ?? 'upload.bin';
      const safeName = sanitizeUploadName(rawName);
      const mediaDir = path.join(p.dir, 'media');
      await fs.mkdir(mediaDir, { recursive: true });
      const destPath = await uniqueDestPath(mediaDir, safeName);
      broadcast(ctx, { type: 'upload-start', name: safeName });
      let written = 0;
      let lastBroadcast = 0;
      const out = createWriteStream(destPath);
      try {
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) => {
            written += chunk.length;
            const now = Date.now();
            if (now - lastBroadcast > 250) {
              lastBroadcast = now;
              broadcast(ctx, { type: 'upload-progress', name: safeName, bytes: written, done: false });
            }
          });
          req.on('error', reject);
          out.on('error', reject);
          out.on('finish', () => resolve());
          req.pipe(out);
        });
      } catch (e: any) {
        await fs.rm(destPath, { force: true }).catch(() => {});
        return json(res, 400, { error: `upload failed: ${e?.message ?? e}` });
      }
      broadcast(ctx, { type: 'upload-progress', name: safeName, bytes: written, done: true });
      return json(res, 200, { path: destPath, bytes: written });
    }

    // ---- W-UI companion channel (W-UI §0): tell every connected browser to
    // jump/highlight/show something, without creating a revision or needing
    // an actor — purely a UI cue so a user watching the browser alongside
    // the chat sees what's being talked about. ----
    if (pathname === '/api/show' && method === 'POST') {
      const b = await readBody(req);
      const m = await p.manifest();
      let directive: Record<string, unknown>;

      if (b.kind === 'range') {
        const tlStart = Number(b.tlStart);
        const tlEnd = Number(b.tlEnd);
        if (!Number.isFinite(tlStart) || !Number.isFinite(tlEnd)) {
          return json(res, 400, { error: 'show range: tlStart/tlEnd must be finite numbers' });
        }
        directive = { kind: 'range', tlStart: Math.min(tlStart, tlEnd), tlEnd: Math.max(tlStart, tlEnd) };
      } else if (b.kind === 'words') {
        let sourceId = b.sourceId as string | undefined;
        if (!sourceId) {
          const amb = ambiguousSources(m);
          if (amb) return json(res, 400, { error: 'multiple transcribed sources; specify sourceId', sources: amb });
          sourceId = m.sources.find((s) => s.transcribed)?.id;
        }
        if (!sourceId || !m.sources.some((s) => s.id === sourceId)) {
          return json(res, 400, { error: `unknown source: ${sourceId}` });
        }
        if (!Array.isArray(b.ids) || b.ids.length === 0) {
          return json(res, 400, { error: 'show words: ids is required (non-empty array)' });
        }
        let ids: string[];
        try {
          const t = await p.transcript(sourceId);
          ids = expandWordIds(b.ids, t.words);
        } catch (e: any) {
          return json(res, 400, { error: `show words: ${e?.message ?? e}` });
        }
        directive = { kind: 'words', sourceId, ids };
      } else if (b.kind === 'candidate') {
        if (typeof b.id !== 'string' || !b.id) return json(res, 400, { error: 'show candidate: id is required' });
        const all = await p.candidates();
        if (!all.some((c) => c.id === b.id)) return json(res, 400, { error: `unknown candidate: ${b.id}` });
        directive = { kind: 'candidate', id: b.id };
      } else if (b.kind === 'compare') {
        const revA = parseRevRef(b.revA);
        const revB = parseRevRef(b.revB);
        if (revA == null || revB == null) {
          return json(res, 400, { error: 'show compare: revA and revB are required revision numbers (or "r5" form)' });
        }
        for (const r of [revA, revB]) {
          if (!Number.isInteger(r) || r < 0 || r > m.revision) {
            return json(res, 400, { error: `show compare: unknown revision ${r}` });
          }
        }
        const [snapA, snapB, revs] = await Promise.all([revisionSnapshot(p, revA), revisionSnapshot(p, revB), p.revisions()]);
        const durationA = snapA ? timelineDuration(snapA) : 0;
        const durationB = snapB ? timelineDuration(snapB) : 0;
        const lo = Math.min(revA, revB);
        const hi = Math.max(revA, revB);
        const ops = revs
          .filter((r) => r.rev > lo && r.rev <= hi)
          .map((r) => ({ rev: r.rev, actor: r.actor, op: r.op, summary: r.summary }));
        directive = { kind: 'compare', revA, revB, durationA, durationB, deltaSeconds: durationB - durationA, ops };
      } else if (b.kind === 'source') {
        const sourceId = b.sourceId as string | undefined;
        if (!sourceId || !m.sources.some((s) => s.id === sourceId)) {
          return json(res, 400, { error: `unknown source: ${sourceId}` });
        }
        let at: number | undefined;
        if (b.at !== undefined) {
          at = Number(b.at);
          if (!Number.isFinite(at)) return json(res, 400, { error: 'show source: at must be a finite number' });
        }
        directive = { kind: 'source', sourceId, ...(at !== undefined ? { at } : {}) };
      } else {
        return json(res, 400, { error: `unknown show kind: ${JSON.stringify(b.kind)} (use range/words/candidate/compare/source)` });
      }

      broadcast(ctx, { type: 'show', directive });
      return json(res, 200, { ok: true, directive });
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
        if (removedSeconds < 1 / m0.fps) {
          // The words themselves are real, but that source range no longer has
          // any clip on the timeline (e.g. already cut) — refuse rather than
          // commit a revision that changes nothing.
          return json(res, 400, { error: 'range does not intersect source media' });
        }
        await mutate(p, actor, baseRev, 'remove-words', b, `removed ${removed} words (${removedSeconds.toFixed(1)}s): "${text.slice(0, 40)}"`, (m) =>
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
        if (removedSeconds < 1 / m0.fps) {
          return json(res, 400, { error: 'range does not intersect source media' });
        }
        await mutate(p, actor, baseRev, 'remove-range', b, `removed ${removedSeconds.toFixed(1)}s of source ${sourceId}`, (m) =>
          removeSourceRange(m, sourceId!, b.t0, b.t1),
        );
        return json(res, 200, { removedSeconds, state: await stateSummary(p) });
      }
      if (b.op === 'trim') {
        await mutate(p, actor, baseRev, 'trim', b, `trim ${b.clipId} ${b.edge} ${b.frames}f`, (m) =>
          trimClip(m, b.clipId, b.edge, b.frames),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'captions') {
        // maxCps is a recognized, validated patch field (CLI integration
        // support) — everything else stays an unvalidated passthrough merge
        // as before, so this doesn't tighten the contract for existing
        // callers (presets, the web UI) that may send other captions
        // fields.
        if (b.patch && Object.prototype.hasOwnProperty.call(b.patch, 'maxCps')) {
          const v = b.patch.maxCps;
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 30) {
            return json(res, 400, { error: 'captions.maxCps must be a number between 1 and 30' });
          }
        }
        await mutate(p, actor, baseRev, 'captions', b, `captions ${JSON.stringify(b.patch)}`, (m) => ({
          ...m,
          captions: { ...m.captions, ...b.patch },
        }));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'motion-add') {
        const specId = freshId('mo');
        const specContent = { id: specId, ...b.spec };
        const item: MotionItem = { id: specId, spec: `${specId}.json`, tlStart: b.tlStart, duration: b.duration };
        // The sidecar file itself is written by commit() only after the
        // commit is durable (motionSpecUpdates), so a stale-baseRev 400
        // never leaves an orphan spec file with no timeline reference.
        await mutate(
          p, actor, baseRev, 'motion-add', b, `motion ${b.spec.type} at ${b.tlStart}s`,
          (m) => ({ ...m, timeline: { ...m.timeline, motion: [...m.timeline.motion, item] } }),
          { [specId]: specContent },
        );
        return json(res, 200, { id: specId, state: await stateSummary(p) });
      }
      if (b.op === 'motion-update') {
        // Only an id that's actually on the timeline may be touched — this
        // is the allowlist; motionSpecPath (inside readMotionSpec) is a
        // second, independent guard that the resolved file stays inside
        // motion/.
        if (!m0.timeline.motion.some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown motion item: ${b.id}` });
        }
        // The spec file is NOT written here: reading the old content is
        // fine (read-only), but the merged new content is only handed to
        // commit() as `motionSpecUpdates`, which writes it to disk after
        // the commit succeeds. Previously this wrote the sidecar file
        // before knowing whether the commit would even be accepted, so a
        // 409 (stale baseRev) still left the file mutated.
        let motionSpecUpdates: Record<string, unknown> | undefined;
        if (b.spec) {
          const old = await p.readMotionSpec(b.id);
          motionSpecUpdates = { [b.id]: { ...(old as Record<string, unknown>), ...b.spec, id: b.id } };
        }
        await mutate(
          p, actor, baseRev, 'motion-update', b, `motion ${b.id} updated`,
          (m) => ({
            ...m,
            timeline: {
              ...m.timeline,
              motion: m.timeline.motion.map((x) =>
                x.id === b.id
                  ? { ...x, tlStart: b.tlStart ?? x.tlStart, duration: b.duration ?? x.duration }
                  : x,
              ),
            },
          }),
          motionSpecUpdates,
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'motion-remove') {
        if (!m0.timeline.motion.some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown motion item: ${b.id}` });
        }
        await mutate(p, actor, baseRev, 'motion-remove', b, `motion ${b.id} removed`, (m) => ({
          ...m,
          timeline: { ...m.timeline, motion: m.timeline.motion.filter((x) => x.id !== b.id) },
        }));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'music-add') {
        if (typeof b.path !== 'string' || !b.path) {
          return json(res, 400, { error: 'music-add: path is required' });
        }
        const filePath = path.resolve(b.path);
        let info: { duration: number; hasAudio: boolean };
        try {
          info = await probeAudio(filePath);
        } catch (e: any) {
          return json(res, 400, { error: `music-add: could not read ${filePath}: ${e?.message ?? e}` });
        }
        if (!info.hasAudio) {
          return json(res, 400, { error: `music-add: no audio stream in ${filePath}` });
        }
        const tlStart = typeof b.tlStart === 'number' ? b.tlStart : 0;
        if (!Number.isFinite(tlStart) || tlStart < 0) {
          return json(res, 400, { error: 'music-add: at must be a finite number >= 0' });
        }
        const srcIn = typeof b.srcIn === 'number' ? b.srcIn : 0;
        if (!Number.isFinite(srcIn) || srcIn < 0) {
          return json(res, 400, { error: 'music-add: src-in must be a finite number >= 0' });
        }
        // Unspecified duration defaults to whichever runs out first: the
        // music source (from srcIn) or the timeline (from tlStart).
        const remainingSrc = Math.max(0, info.duration - srcIn);
        const remainingTl = Math.max(0, timelineDuration(m0) - tlStart);
        const duration = typeof b.duration === 'number' ? b.duration : Math.min(remainingSrc, remainingTl);
        if (!Number.isFinite(duration) || duration <= 0) {
          return json(res, 400, { error: 'music-add: no room for music at this position (timeline or source exhausted)' });
        }
        const id = freshId('mu');
        await mutate(
          p, actor, baseRev, 'music-add', b,
          `music-add ${path.basename(filePath)} at ${tlStart}s (+${duration.toFixed(1)}s)`,
          (m) => addMusic(m, filePath, { id, tlStart, srcIn, duration, gain: b.gain, fadeIn: b.fadeIn, fadeOut: b.fadeOut, duck: b.duck }),
        );
        return json(res, 200, { id, state: await stateSummary(p) });
      }
      if (b.op === 'music-update') {
        if (!(m0.timeline.music ?? []).some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown music item: ${b.id}` });
        }
        await mutate(p, actor, baseRev, 'music-update', b, `music-update ${b.id}`, (m) =>
          updateMusic(m, b.id, {
            tlStart: b.tlStart, duration: b.duration, srcIn: b.srcIn,
            gain: b.gain, fadeIn: b.fadeIn, fadeOut: b.fadeOut, duck: b.duck,
          }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'music-remove') {
        if (!(m0.timeline.music ?? []).some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown music item: ${b.id}` });
        }
        await mutate(p, actor, baseRev, 'music-remove', b, `music-remove ${b.id}`, (m) => removeMusic(m, b.id));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'broll-add') {
        if (!b.anchor || typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number') {
          return json(res, 400, { error: 'broll-add: anchor {sourceId, srcTime} is required' });
        }
        const id = freshId('ov');
        await mutate(
          p, actor, baseRev, 'broll-add', b,
          `broll-add ${b.sourceId} [${b.in}-${b.out}] anchor ${b.anchor.sourceId}@${Number(b.anchor.srcTime).toFixed(2)}`,
          (m) => addOverlay(m, b.sourceId, { srcIn: b.in, srcOut: b.out, anchor: b.anchor, audioMode: b.audioMode, gainDb: b.gainDb, id }),
        );
        return json(res, 200, { id, state: await stateSummary(p) });
      }
      if (b.op === 'broll-update') {
        if (!(m0.timeline.overlays ?? []).some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown overlay: ${b.id}` });
        }
        if (b.anchor !== undefined && (typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number')) {
          return json(res, 400, { error: 'broll-update: anchor must be {sourceId, srcTime}' });
        }
        await mutate(p, actor, baseRev, 'broll-update', b, `broll-update ${b.id}`, (m) =>
          updateOverlay(m, b.id, { srcIn: b.in, srcOut: b.out, anchor: b.anchor, audioMode: b.audioMode, gainDb: b.gainDb }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'broll-remove') {
        if (!(m0.timeline.overlays ?? []).some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown overlay: ${b.id}` });
        }
        await mutate(p, actor, baseRev, 'broll-remove', b, `broll-remove ${b.id}`, (m) => removeOverlay(m, b.id));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'sprite-add') {
        if (!m0.kit) return json(res, 400, { error: 'sprite-add: no kit linked; run `vedit kit-link <dir>` first' });
        if (!b.anchor || typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number') {
          return json(res, 400, { error: 'sprite-add: anchor {sourceId, srcTime} is required' });
        }
        let kit;
        try {
          kit = await readKitFile(m0.kit.path);
        } catch (e: any) {
          return json(res, 400, { error: `sprite-add: could not read kit: ${e?.message ?? e}` });
        }
        if (!(kit.assets ?? []).some((a) => a.id === b.assetId)) {
          return json(res, 400, { error: `sprite-add: unknown kit asset: ${b.assetId}` });
        }
        const id = freshId('sp');
        await mutate(
          p, actor, baseRev, 'sprite-add', b,
          `sprite-add ${b.assetId} anchor ${b.anchor.sourceId}@${Number(b.anchor.srcTime).toFixed(2)}`,
          (m) => addSprite(m, b.assetId, {
            anchor: b.anchor, duration: b.duration, position: b.position, scale: b.scale, opacity: b.opacity, flip: b.flip, id,
          }),
        );
        return json(res, 200, { id, state: await stateSummary(p) });
      }
      if (b.op === 'sprite-update') {
        if (!(m0.timeline.sprites ?? []).some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown sprite: ${b.id}` });
        }
        if (b.anchor !== undefined && (typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number')) {
          return json(res, 400, { error: 'sprite-update: anchor must be {sourceId, srcTime}' });
        }
        await mutate(p, actor, baseRev, 'sprite-update', b, `sprite-update ${b.id}`, (m) =>
          updateSprite(m, b.id, {
            anchor: b.anchor, duration: b.duration, position: b.position, scale: b.scale, opacity: b.opacity, flip: b.flip,
          }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'sprite-remove') {
        if (!(m0.timeline.sprites ?? []).some((x) => x.id === b.id)) {
          return json(res, 400, { error: `unknown sprite: ${b.id}` });
        }
        await mutate(p, actor, baseRev, 'sprite-remove', b, `sprite-remove ${b.id}`, (m) => removeSprite(m, b.id));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'audio-mix') {
        await mutate(
          p, actor, baseRev, 'audio-mix', b,
          `audio-mix target=${b.targetLufs ?? -14} duck=${b.duckAmount ?? -10} xfade=${b.crossfadeMs ?? 12}`,
          (m) => setAudioMix(m, { targetLufs: b.targetLufs, duckAmount: b.duckAmount, crossfadeMs: b.crossfadeMs }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'audio-repair') {
        await mutate(
          p, actor, baseRev, 'audio-repair', b,
          `audio-repair preset=${b.preset}${b.deess ? ' deess' : ''}`,
          (m) => setAudioRepair(m, { preset: b.preset, deess: b.deess }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'color-transform') {
        const sourceId = b.sourceId as string | undefined;
        if (!sourceId) return json(res, 400, { error: 'color-transform: sourceId is required' });
        if (!m0.sources.some((s) => s.id === sourceId)) {
          return json(res, 400, { error: `unknown source: ${sourceId}` });
        }
        const type = b.type as string | undefined;
        if (!type) return json(res, 400, { error: 'color-transform: type is required (hlg/pq/lut/none)' });
        let lutAbs: string | undefined;
        if (type === 'lut') {
          if (typeof b.lut !== 'string' || !b.lut) {
            return json(res, 400, { error: 'color-transform: --lut <path> is required when type is "lut"' });
          }
          // LUTs are user-owned assets, deliberately not sandboxed to the
          // project directory (unlike proxy/peaks) — only existence is
          // checked, mirroring music-add's probeAudio validation.
          lutAbs = path.resolve(b.lut);
          try {
            await fs.access(lutAbs);
          } catch {
            return json(res, 400, { error: `color-transform: lut file not found: ${lutAbs}` });
          }
        }
        const updated = await mutate(
          p, actor, baseRev, 'color-transform', b,
          `color-transform ${sourceId} -> ${type}${lutAbs ? ` (${path.basename(lutAbs)})` : ''}`,
          (m) => setColorTransform(m, sourceId, { type, lut: lutAbs }),
        );
        // Proxy regen happens AFTER the commit is durable — same ordering
        // rationale as the motion sidecar writes in commit() (see its doc
        // comment): if makeProxy throws here, the manifest already
        // correctly reflects the new colorTransform even though the proxy
        // on disk is stale until `vedit color` is retried, rather than a
        // commit silently failing to apply a setting the user just made.
        const updatedSrc = updated.sources.find((s) => s.id === sourceId)!;
        let proxyRegenerated = false;
        if (updatedSrc.proxy) {
          broadcast(ctx, { type: 'color-transform-progress', sourceId, step: 'regenerating proxy' });
          await makeProxy(
            updatedSrc.path,
            path.join(p.dir, updatedSrc.proxy),
            { duration: updatedSrc.duration, fps: updatedSrc.fps, width: updatedSrc.width, height: updatedSrc.height, hasAudio: updatedSrc.hasAudio },
            updatedSrc.colorTransform,
          );
          proxyRegenerated = true;
        }
        return json(res, 200, { proxyRegenerated, state: await stateSummary(p) });
      }
      if (b.op === 'color-adjust') {
        const sourceId = b.sourceId as string | undefined;
        if (!sourceId) return json(res, 400, { error: 'color-adjust: sourceId is required' });
        if (!m0.sources.some((s) => s.id === sourceId)) {
          return json(res, 400, { error: `unknown source: ${sourceId}` });
        }
        await mutate(
          p, actor, baseRev, 'color-adjust', b,
          `color-adjust ${sourceId} exposure=${b.exposure ?? '-'} wb=${b.wb ?? '-'} sat=${b.sat ?? '-'}`,
          (m) => setColorAdjust(m, sourceId, { exposure: b.exposure, wb: b.wb, sat: b.sat }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'clip-add') {
        const clipId = freshId('c');
        await mutate(p, actor, baseRev, 'clip-add', b, `clip-add ${b.sourceId} [${b.in ?? 0}-${b.out ?? '*'}]`, (m) =>
          addClip(m, b.sourceId, { in: b.in, out: b.out, at: b.at, id: clipId }),
        );
        return json(res, 200, { clipId, state: await stateSummary(p) });
      }
      if (b.op === 'clip-remove') {
        await mutate(p, actor, baseRev, 'clip-remove', b, `clip-remove ${b.clipId}`, (m) => removeClip(m, b.clipId));
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'clip-move') {
        await mutate(p, actor, baseRev, 'clip-move', b, `clip-move ${b.clipId} before ${b.before}`, (m) =>
          moveClip(m, b.clipId, b.before),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'reframe') {
        const output = parseReframeSpec(b.spec);
        const focus = parseFocus(b.focus);
        await mutate(p, actor, baseRev, 'reframe', b, `reframe ${output.width}x${output.height} focus=${b.focus ?? 'center'}`, (m) =>
          applyReframe(m, output, focus),
        );
        return json(res, 200, { output, state: await stateSummary(p) });
      }
      if (b.op === 'clip-crop') {
        await mutate(p, actor, baseRev, 'clip-crop', b, `clip-crop ${b.clipId} x=${b.x ?? '-'} y=${b.y ?? '-'}`, (m) =>
          setClipCrop(m, b.clipId, { x: b.x, y: b.y }),
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'scene-review') {
        const sourceId = b.sourceId as string | undefined;
        if (!sourceId) return json(res, 400, { error: 'scene-review: sourceId is required' });
        if (!m0.sources.some((s) => s.id === sourceId)) {
          return json(res, 400, { error: `unknown source: ${sourceId}` });
        }
        const review = b.review;
        if (review !== 'keep' && review !== 'reject' && review !== 'clear') {
          return json(res, 400, { error: `scene-review: review must be "keep", "reject", or "clear" (got ${JSON.stringify(review)})` });
        }
        const sceneIds: string[] = Array.isArray(b.sceneIds) ? b.sceneIds : b.sceneId ? [b.sceneId] : [];
        if (sceneIds.length === 0) {
          return json(res, 400, { error: 'scene-review: sceneIds (or sceneId) is required' });
        }
        const sceneFile = await p.scenes(sourceId);
        const known = new Set(sceneFile.scenes.map((s) => s.id));
        const unknown = sceneIds.filter((id) => !known.has(id));
        if (unknown.length) return json(res, 400, { error: `unknown scene id(s): ${unknown.join(', ')} (source ${sourceId})` });
        await mutate(
          p, actor, baseRev, 'scene-review', b,
          `scene-review ${sourceId} ${sceneIds.join(',')} -> ${review}`,
          (m) => {
            let cur = m;
            for (const id of sceneIds) cur = setSceneReview(cur, sourceId, id, review);
            return cur;
          },
        );
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'selects') {
        const sceneFiles = await sceneFilesFor(p, m0);
        const newVideo = buildSelectsTimeline(m0, sceneFiles);
        if (newVideo.length === 0) {
          return json(res, 400, { error: 'selects: no scenes are marked "keep" — nothing to build a timeline from' });
        }
        const previousClips = m0.timeline.video.length;
        await mutate(
          p, actor, baseRev, 'selects', b,
          `selects: replaced ${previousClips} clip(s) with ${newVideo.length} keep-scene clip(s)`,
          (m) => ({ ...m, timeline: { ...m.timeline, video: newVideo } }),
        );
        return json(res, 200, { previousClips, newClips: newVideo.length, state: await stateSummary(p) });
      }
      if (b.op === 'kit-link') {
        const dir = typeof b.path === 'string' ? path.resolve(b.path) : undefined;
        if (!dir) return json(res, 400, { error: 'kit-link: path is required' });
        let kit;
        try {
          kit = await readKitFile(dir);
        } catch (e: any) {
          return json(res, 400, { error: `kit-link: ${e?.message ?? e}` });
        }
        const sections = recognizedKitSections(kit);
        let applied: string[] = [];
        await mutate(p, actor, baseRev, 'kit-link', b, `kit-link ${dir}`, (m) => {
          const linked: Manifest = { ...m, kit: { path: dir } };
          const { manifest, applied: a } = applyKitDefaults(linked, kit!);
          applied = a;
          return manifest;
        });
        return json(res, 200, { path: dir, recognizedSections: sections, appliedDefaults: applied, state: await stateSummary(p) });
      }
      if (b.op === 'kit-unlink') {
        await mutate(p, actor, baseRev, 'kit-unlink', b, 'kit-unlink', (m) => {
          const { kit: _kit, ...rest } = m;
          return rest as Manifest;
        });
        return json(res, 200, { state: await stateSummary(p) });
      }
      if (b.op === 'restore') {
        // `baseRev` here is the same value every other /api/edit op uses
        // (b.baseRev, falling back to the pre-request revision for
        // actor=ui) — the wire contract is unchanged; restore() now just
        // requires it explicitly instead of always racing onto "latest".
        const m = await p.restore(b.rev, actor, baseRev);
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
            // undefined lets the per-source adaptive threshold kick in;
            // a fixed default here would defeat it on quiet outdoor footage.
            threshold: b.threshold,
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
      // Candidate selection, the approve-commit, and the candidates.json
      // rewrite all happen inside ONE critical section (Project.decideCandidates)
      // so a concurrent /api/detect or another decide can't interleave a
      // stale read of candidates.json between "decide what to apply" and
      // "write the result".
      const result = await p.decideCandidates(
        (all) => (b.ids === 'all' ? all.filter((c) => c.status === 'proposed') : all.filter((c) => b.ids.includes(c.id))),
        b.decision,
        b.decision === 'approve'
          ? (target, before) => {
              const baseRev = b.baseRev ?? before.revision;
              // Compute the real (frame-snapped) delta against `before` —
              // the manifest as of right now, inside the same critical
              // section as the commit itself — so the summary/response
              // agree with what actually lands on the timeline, and can't
              // be thrown off by a concurrent write between "preview" and
              // "commit" (the bug this whole method exists to close).
              let preview = before;
              for (const c of target) preview = removeSourceRange(preview, c.sourceId, c.t0, c.t1);
              const removedSeconds = timelineDuration(before) - timelineDuration(preview);
              return {
                baseRev,
                actor,
                op: 'apply-candidates',
                params: { ids: target.map((c) => c.id) },
                summary: `applied ${target.length} cuts (-${removedSeconds.toFixed(1)}s)`,
                mutate: (m: Manifest) => {
                  let cur = m;
                  for (const c of target) cur = removeSourceRange(cur, c.sourceId, c.t0, c.t1);
                  return cur;
                },
              };
            }
          : undefined,
      );
      if (result.manifest && result.before) {
        const removedSeconds = timelineDuration(result.before) - timelineDuration(result.manifest);
        broadcast(ctx, {
          type: 'update',
          revision: result.manifest.revision,
          op: 'apply-candidates',
          summary: `applied ${result.target.length} cuts (-${removedSeconds.toFixed(1)}s)`,
        });
      }
      broadcast(ctx, { type: 'candidates', pending: result.all.filter((c) => c.status === 'proposed').length });
      return json(res, 200, { decided: result.target.length, state: await stateSummary(p) });
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

  /** Guess a browser-playable audio MIME type from a music file's extension. */
  function audioMime(file: string): string {
    const types: Record<string, string> = {
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
      '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus',
    };
    return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  }

  /** Serve a real on-disk file with byte-range support (used by proxy/peaks/music). */
  function serveFileWithRange(req: http.IncomingMessage, res: http.ServerResponse, full: string, stat: { size: number }, type: string) {
    const range = req.headers.range;
    if (range) {
      const parsed = parseByteRange(range, stat.size);
      if (parsed === 'unsatisfiable') {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      if (parsed) {
        const { start, end } = parsed;
        res.writeHead(206, {
          'content-type': type,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
        });
        createReadStream(full, { start, end }).pipe(res);
        return;
      }
      // Malformed or multi-range header: ignore it and serve the full body.
    }
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
    createReadStream(full).pipe(res);
  }

  /** Guess a browser MIME type for a kit-served font/asset file. */
  function kitMediaMime(file: string): string {
    const types: Record<string, string> = {
      '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    };
    return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  }

  /**
   * /media/kit/<relPath> (fonts/*, assets/**\/*.png, ...): the kit root is
   * OUTSIDE the project directory (that's the whole point — a kit is shared
   * across projects), so this is a SEPARATE containment root from
   * resolveWithinDir(p.dir, ...) used everywhere else in serveMedia —
   * sandboxed to Manifest.kit.path instead. `relPath` may contain slashes
   * (nested asset subfolders), unlike the fixed 4-segment /media/<kind>/<id>
   * shape the rest of serveMedia uses, hence the dedicated branch.
   */
  async function serveKitMedia(p: Project, relPath: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const m = await p.manifest();
    if (!m.kit) return json(res, 404, { error: 'no kit linked' });
    let full: string;
    try {
      full = await resolveWithinDir(m.kit.path, decodeURIComponent(relPath));
    } catch {
      return json(res, 404, { error: 'invalid kit media path' });
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      return json(res, 404, { error: 'kit media not found' });
    }
    return serveFileWithRange(req, res, full, stat, kitMediaMime(full));
  }

  async function serveMedia(p: Project, pathname: string, req: http.IncomingMessage, res: http.ServerResponse) {
    // /media/kit/<relPath>: separate containment root (see serveKitMedia doc).
    if (pathname.startsWith('/media/kit/')) return serveKitMedia(p, pathname.slice('/media/kit/'.length), req, res);
    // /media/proxy/<sourceId> | /media/peaks/<sourceId> | /media/thumb/<sourceId> | /media/music/<musicId>
    const [, , kind, id] = pathname.split('/');
    const m = await p.manifest();
    if (kind === 'music') {
      // Music items reference the original file directly (never a proxy) —
      // same trust model as Source.path in renderFinal: an absolute path the
      // user supplied via the CLI, not sandboxed to the project directory.
      const mu = (m.timeline.music ?? []).find((x) => x.id === id);
      if (!mu) return json(res, 404, { error: 'unknown music item' });
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(mu.path);
      } catch {
        return json(res, 404, { error: 'music file not found' });
      }
      return serveFileWithRange(req, res, mu.path, stat, audioMime(mu.path));
    }
    const sourceId = id;
    const src = m.sources.find((s) => s.id === sourceId);
    if (!src) return json(res, 404, { error: 'unknown source' });
    if (kind === 'thumb') {
      // Poster frame for the media pool panel; generated once, then cached.
      const relThumb = `cache/thumb-${src.id}.jpg`;
      const fullThumb = path.join(p.dir, relThumb);
      try {
        await fs.access(fullThumb);
      } catch {
        const media = src.proxy ? path.join(p.dir, src.proxy) : src.path;
        const at = Math.min(src.duration * 0.25, 30);
        await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', media, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', fullThumb]);
      }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' });
      return createReadStream(fullThumb).pipe(res);
    }
    const rel = kind === 'proxy' ? src.proxy : src.peaks;
    if (!rel) return json(res, 404, { error: `no ${kind} for source` });
    // The manifest is on-disk data, not trusted input: a tampered/corrupted
    // project.json could point proxy/peaks outside the project directory.
    let full: string;
    try {
      full = await resolveWithinDir(p.dir, rel);
    } catch {
      return json(res, 404, { error: `invalid ${kind} path for source` });
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      return json(res, 404, { error: `${kind} file not found` });
    }
    const type = kind === 'proxy' ? 'video/mp4' : 'application/json';
    return serveFileWithRange(req, res, full, stat, type);
  }

  /**
   * Parse a single-range `Range: bytes=...` header per RFC 7233 §2.1:
   * "N-M", "N-" (open-ended), and "-N" (suffix: last N bytes). Returns
   * `null` for anything we don't support (malformed, multiple ranges) so
   * the caller falls back to a normal 200, and `'unsatisfiable'` when the
   * range is well-formed but out of bounds (416).
   */
  function parseByteRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    let start: number;
    let end: number;
    if (m[1] === '') {
      const suffixLen = Number(m[2]);
      if (!Number.isFinite(suffixLen) || suffixLen <= 0) return 'unsatisfiable';
      start = Math.max(0, size - suffixLen);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Number(m[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
      return 'unsatisfiable';
    }
    return { start, end: Math.min(end, size - 1) };
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, url: `http://localhost:${port}` };
}
