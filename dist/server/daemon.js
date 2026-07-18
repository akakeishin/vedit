import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Project, resolveWithinDir } from '../core/project.js';
import { addClip, addDialogue, addIntentZone, backgroundIntervals, dialogueOverlapWithoutPosRisk, addMusic, addOverlay, addSprite, applyReframe, buildSelectsTimeline, COLOR_WARNING_MESSAGE, cullingStats, duplicateClip, expandWordIds, intentZonesForSource, moveClip, needsColorTransform, orphanedOverlays, orphanedSprites, overlappingIntentZones, padWordRange, parseFocus, parseReframeSpec, quietZonesOverlappingTimelineRange, removeBackgroundAt, removeClip, removeDialogue, removeIntentZone, removeMusic, removeOverlay, removeSourceRange, removeSprite, resolveOverlays, resolveSprites, segments, setAudioMix, setAudioRepair, setBackgroundAt, setClipAudio, setClipCrop, setColorAdjust, setColorTransform, setComposition, setSceneReview, setTranscriptionGlossary, shiftComposition, splitClip, timelineDuration, trimClip, updateDialogue, updateMusic, updateOverlay, updateSprite, wordRange, } from '../core/ops.js';
import { upsertProject } from '../core/registry.js';
import { captionCues } from '../core/captions.js';
import { detectFillers, detectSilences, detectSilencesFromPeaks } from '../core/detect.js';
import { planAutonomousCandidateBatch } from '../core/autonomy.js';
import { packTranscript } from '../core/pack.js';
import { detectScenesForSource, packScenes, sceneThumbPath } from '../core/scenes.js';
import { detectTakes } from '../core/takes.js';
import { staticChecks } from '../export/qc.js';
import { ingestFile, makeProxy, probeAudio, transcribe } from '../ingest/ingest.js';
import { run } from '../ingest/run.js';
import { isAgentActor, isRevisionActor } from '../core/types.js';
import { freshId } from '../core/ops.js';
import { applyKitDefaults, readKitFile, recognizedKitSections } from '../core/kit.js';
import { listSystemFonts, scanKitFonts } from '../core/fonts.js';
import { locateMedia } from '../ingest/locate.js';
import { readExportResults } from '../core/exportResults.js';
import { claimExportJob, ExportJobConflictError, exportJobPartialPath, readExportJob, recoverInterruptedExportJob, writeOwnedExportJob, } from '../core/exportJob.js';
import { renderProjectMp4 } from '../export/projectRender.js';
import { readNotes } from '../core/notes.js';
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const DETECT_RUN_FILENAME = 'detect-run.json';
const MAX_CONCURRENT_TRANSCRIBES = 1;
async function allTranscripts(p) {
    const m = await p.manifest();
    const out = [];
    for (const s of m.sources) {
        if (!s.transcribed)
            continue;
        try {
            out.push(await p.transcript(s.id));
        }
        catch { /* transcript file missing; skip */ }
    }
    return out;
}
function json(res, status, body) {
    const data = JSON.stringify(body, null, 1);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(data);
}
/**
 * F-s1-1: turns a removeSourceRange result's `fragmentsAbsorbed` annotation
 * (see ops.ts) into a short human-readable suffix — used by remove-words/
 * remove-range/apply-candidates below so a short leftover fragment getting
 * swallowed into a cut shows up in the revision summary/CLI output instead
 * of silently vanishing. '' (never absorbed anything) is the common case.
 */
function fragmentAbsorptionNote(fragments) {
    if (!fragments || fragments.length === 0)
        return '';
    const totalSeconds = fragments.reduce((sum, f) => sum + f.seconds, 0);
    return ` (${totalSeconds.toFixed(1)}秒の断片を${fragments.length}件吸収)`;
}
function stampAutonomyReview(plan, baseRev, reviewId, evaluatedAt) {
    const stamp = (item, disposition) => {
        item.candidate.aiReview = {
            reviewId,
            evaluatedAt,
            baseRev,
            disposition,
            reasonCode: item.reasonCode,
            reason: item.reason,
        };
    };
    for (const item of plan.autoApply)
        stamp(item, 'auto-applied');
    for (const item of plan.needsDecision)
        stamp(item, 'question');
    for (const item of plan.excluded)
        stamp(item, 'excluded');
}
function isActionableCandidate(candidate) {
    return candidate.status === 'proposed' && candidate.aiReview?.disposition !== 'excluded';
}
function requiresIndividualCandidateDecision(candidate) {
    return candidate.aiReview?.disposition === 'question'
        || (candidate.aiReview?.disposition === 'auto-applied' && candidate.status === 'proposed');
}
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const MUTATING_API_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXPECTED_PROJECT_HEADER = 'x-vedit-project-dir';
const CORS_SAFELISTED_CONTENT_TYPES = new Set([
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
]);
function requestMediaType(req) {
    const raw = req.headers['content-type'];
    if (typeof raw !== 'string')
        return null;
    const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
    return mediaType || null;
}
function isLoopbackHost(rawHost) {
    if (typeof rawHost !== 'string' || rawHost.length === 0)
        return false;
    const authority = rawHost.toLowerCase();
    // Keep the accepted authority syntax intentionally literal. URL would
    // canonicalize values such as decimal `2130706433` to 127.0.0.1; accepting
    // those surprising spellings weakens Host allow-list reviewability.
    if (!/^(?:localhost\.?|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(authority))
        return false;
    try {
        const parsed = new URL(`http://${authority}`);
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    }
    catch {
        return false;
    }
}
/**
 * Browser requests may carry an Origin while CLI/Node callers normally do
 * not. Any Origin-bearing request (reads, media and mutations alike) is
 * accepted only when it came from the exact loopback origin serving this
 * daemon. `Sec-Fetch-Site` closes cross-site embed/navigation shapes that do
 * not carry Origin, while remaining absent for native CLI clients.
 */
function hasTrustedRequestOrigin(req) {
    if (!isLoopbackHost(req.headers.host))
        return false;
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite != null && fetchSite !== 'same-origin' && fetchSite !== 'none')
        return false;
    const rawOrigin = req.headers.origin;
    if (rawOrigin == null)
        return true;
    if (typeof rawOrigin !== 'string')
        return false;
    try {
        const origin = new URL(rawOrigin);
        const hostname = origin.hostname.toLowerCase().replace(/\.$/, '');
        const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
        return origin.protocol === 'http:' && loopback && origin.host.toLowerCase() === req.headers.host.toLowerCase();
    }
    catch {
        return false;
    }
}
/** Reject before routing so even static UI, media, ping and read APIs cannot
 * be used through an attacker-controlled Host/Origin. */
function rejectUntrustedHttpRequest(req, res) {
    if (!isLoopbackHost(req.headers.host)) {
        json(res, 403, { error: 'non-loopback Host rejected' });
        return true;
    }
    if (!hasTrustedRequestOrigin(req)) {
        json(res, 403, { error: 'cross-origin local-daemon request rejected' });
        return true;
    }
    return false;
}
/**
 * CSRF boundary for the unauthenticated loopback daemon.
 *
 * - A hostile browser origin cannot mutate the project, even if it can reach
 *   localhost.
 * - JSON endpoints require a non-simple JSON media type.
 * - The streaming upload endpoint accepts arbitrary non-simple binary media
 *   types but rejects HTML-form/fetch "simple request" types (and a missing
 *   type), ensuring a cross-origin browser must preflight. We deliberately do
 *   not enable CORS, so that preflight cannot authorize the write.
 *
 * Origin-less local CLI calls remain supported; this is a browser boundary,
 * not an authentication layer for other processes running as the user.
 */
function rejectUnsafeApiMutation(req, res, pathname, method) {
    if (!pathname.startsWith('/api/') || !MUTATING_API_METHODS.has(method))
        return false;
    if (!hasTrustedRequestOrigin(req)) {
        json(res, 403, { error: 'cross-origin API mutation rejected' });
        return true;
    }
    if (method === 'DELETE')
        return false;
    const mediaType = requestMediaType(req);
    if (pathname === '/api/upload') {
        if (!mediaType || CORS_SAFELISTED_CONTENT_TYPES.has(mediaType)) {
            json(res, 415, { error: 'upload requires a non-simple Content-Type such as application/octet-stream or video/*' });
            return true;
        }
        return false;
    }
    if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
        json(res, 415, { error: 'API mutation requires Content-Type: application/json' });
        return true;
    }
    return false;
}
function decodeExpectedProjectDir(req) {
    const raw = req.headers[EXPECTED_PROJECT_HEADER];
    if (typeof raw !== 'string' || raw.length === 0)
        return null;
    try {
        return decodeURIComponent(raw);
    }
    catch {
        return null;
    }
}
/**
 * Every write-method API except `/api/open` is bound to the absolute project
 * identity the caller rendered/read. `/api/open` already carries its target
 * identity as the mandatory `dir` body field. This precondition is separate
 * from revision locking: two unrelated projects can legitimately have the
 * same revision number after A -> B is switched in another tab.
 */
function rejectMismatchedProjectIdentity(req, res, pathname, method, project) {
    if (!pathname.startsWith('/api/')
        || !MUTATING_API_METHODS.has(method)
        || pathname === '/api/open')
        return false;
    const expected = decodeExpectedProjectDir(req);
    if (!expected || !path.isAbsolute(expected)) {
        json(res, 428, {
            error: `project identity precondition required (${EXPECTED_PROJECT_HEADER})`,
            code: 'PROJECT_IDENTITY_REQUIRED',
        });
        return true;
    }
    if (path.resolve(expected) !== path.resolve(project.dir)) {
        json(res, 409, {
            error: 'project changed before this operation; reload and retry against the intended project',
            code: 'PROJECT_IDENTITY_MISMATCH',
            expectedProjectDir: path.resolve(expected),
            currentProjectDir: path.resolve(project.dir),
        });
        return true;
    }
    return false;
}
class PayloadTooLargeError extends Error {
    code = 'PAYLOAD_TOO_LARGE';
}
async function readBody(req) {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    for await (const c of req) {
        const buf = c;
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
    if (tooLarge)
        throw new PayloadTooLargeError(`request body exceeds ${MAX_BODY_BYTES} byte limit`);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}
/** Parse an untrusted API actor without letting unknown strings bypass locks. */
function revisionActor(value, fallback) {
    const actor = value ?? fallback;
    if (!isRevisionActor(actor)) {
        throw new Error(`invalid actor: ${JSON.stringify(actor)} (use agent/ui/system)`);
    }
    return actor;
}
/**
 * Open an existing project at `dir`, or create a fresh one if none exists
 * yet. Only a missing project.json (ENOENT) counts as "no project here" —
 * any other failure (corrupt JSON, permissions, ...) is surfaced as-is so a
 * damaged project.json is never silently clobbered by Project.create's
 * blank manifest.
 */
async function openOrCreateProject(dir, name) {
    try {
        const project = await Project.open(dir);
        await project.manifest(); // force a parse now so corruption surfaces before we decide whether to fall back
        return { project, created: false };
    }
    catch (e) {
        if (e?.code === 'ENOENT') {
            return { project: await Project.create(dir, name), created: true };
        }
        throw e;
    }
}
function broadcast(ctx, msg) {
    const data = JSON.stringify(msg);
    for (const ws of ctx.clients)
        if (ws.readyState === WebSocket.OPEN)
            ws.send(data);
}
/** Run one project-scoped job at a time without letting a rejected job poison
 * the queue. Detection needs this because candidates.json and detect-run.json
 * are separate atomic files: serial completion keeps their last writer the
 * same even when two callers press re-detect together. */
async function serialProjectJob(tails, projectDir, job) {
    const previous = tails.get(projectDir) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    tails.set(projectDir, tail);
    await previous;
    try {
        return await job();
    }
    finally {
        release();
        if (tails.get(projectDir) === tail)
            tails.delete(projectDir);
    }
}
function detectRunPath(projectDir) {
    // Project root, alongside candidates.json: cache/ is intentionally pruned
    // by `vedit gc`, but this is durable decision-state metadata rather than a
    // regenerable media cache.
    return path.join(projectDir, DETECT_RUN_FILENAME);
}
/** Derived detection metadata must never prevent a project from opening. A
 * missing/corrupt marker means "no trustworthy completed run", not "clean". */
async function readDetectRun(projectDir, currentRevision) {
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(detectRunPath(projectDir), 'utf8'));
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    const r = parsed;
    if (r.version !== 1
        || typeof r.completedAt !== 'string'
        || !Number.isFinite(Date.parse(r.completedAt))
        || typeof r.revision !== 'number' || !Number.isInteger(r.revision) || r.revision < 0
        || typeof r.proposalCount !== 'number' || !Number.isInteger(r.proposalCount) || r.proposalCount < 0
        || typeof r.excludedByIntentZones !== 'number' || !Number.isInteger(r.excludedByIntentZones) || r.excludedByIntentZones < 0
        || !r.parameters
        || typeof r.parameters.silence !== 'boolean'
        || typeof r.parameters.fillers !== 'boolean'
        || !Number.isFinite(r.parameters.minGap)
        || (r.parameters.threshold !== undefined && !Number.isFinite(r.parameters.threshold)))
        return null;
    const stale = r.revision !== currentRevision;
    return {
        ...r,
        stale,
        ...(stale ? { staleReason: 'revision-changed' } : {}),
    };
}
/**
 * Word ids restart at w0000 per source, so a sourceId-less remove-words /
 * remove-range is ambiguous the moment there's more than one transcribed
 * source. Returns the list to disambiguate against, or null when it's safe
 * to default (0 or 1 transcribed sources).
 */
function ambiguousSources(m) {
    const transcribed = m.sources.filter((s) => s.transcribed);
    return transcribed.length >= 2 ? transcribed.map((s) => ({ id: s.id, path: path.basename(s.path) })) : null;
}
/**
 * Parse a revision reference for `POST /api/show {kind:'compare'}` — accepts
 * either a bare number or the "r12" display form the activity feed/CLI use
 * (`vedit show compare r5 r7`). Returns null on anything else so the caller
 * can 400 with a clear message instead of comparing against NaN.
 */
function parseRevRef(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const n = Number(v.trim().replace(/^r/i, ''));
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
// ---- W-CAP: captions.overrides patch validation + merge (pure) ----
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/**
 * Validate a `captions` patch's `overrides` field (before it's null, which
 * the caller handles separately as "clear everything"). Every field is
 * optional — only fields actually present are checked — matching every
 * other patch-shaped op in this file (e.g. `maxCps` above). Returns an
 * error message, or null when the patch is well-formed.
 */
function validateCaptionOverridesPatch(patch) {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return 'captions.overrides must be an object (or null to clear all overrides)';
    }
    const o = patch;
    if (o.sizeScale !== undefined) {
        const v = o.sizeScale;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 2) {
            return 'captions.overrides.sizeScale must be a number between 0.5 and 2';
        }
    }
    if (o.outlineWidth !== undefined) {
        const v = o.outlineWidth;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            return 'captions.overrides.outlineWidth must be a non-negative number';
        }
    }
    if (o.bgOpacity !== undefined) {
        const v = o.bgOpacity;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
            return 'captions.overrides.bgOpacity must be a number between 0 and 1';
        }
    }
    if (o.font !== undefined && (typeof o.font !== 'string' || !o.font)) {
        return 'captions.overrides.font must be a non-empty string';
    }
    if (o.palette !== undefined) {
        if (typeof o.palette !== 'object' || o.palette === null || Array.isArray(o.palette)) {
            return 'captions.overrides.palette must be an object';
        }
        for (const [k, v] of Object.entries(o.palette)) {
            if (!['text', 'outline', 'box'].includes(k))
                return `captions.overrides.palette: unknown field "${k}"`;
            if (v !== undefined && (typeof v !== 'string' || !HEX_COLOR_RE.test(v))) {
                return `captions.overrides.palette.${k} must be a hex color like #rrggbb`;
            }
        }
    }
    if (o.position !== undefined) {
        if (typeof o.position !== 'object' || o.position === null || Array.isArray(o.position)) {
            return 'captions.overrides.position must be an object';
        }
        const pos = o.position;
        if (pos.v !== undefined) {
            const v = pos.v;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
                return 'captions.overrides.position.v must be a number between 0 and 1';
            }
        }
        if (pos.h !== undefined && pos.h !== 'center') {
            return 'captions.overrides.position.h must be "center" (only supported value today)';
        }
    }
    return null;
}
/**
 * Merge a validated `overrides` patch onto the current
 * `CaptionSettings.overrides` — one level deep for `palette`/`position` too,
 * so e.g. patching just `{palette:{text:'#fff'}}` never drops a
 * previously-set `palette.outline`. Mirrors the motion-update sidecar
 * merge convention elsewhere in this file (old content spread first, patch
 * fields win). Full clear is a separate path (`overrides: null`), not
 * expressible through this merge — see the `captions` op handler below.
 */
function mergeCaptionOverrides(base, patch) {
    const merged = { ...base };
    if (patch.font !== undefined)
        merged.font = patch.font;
    if (patch.sizeScale !== undefined)
        merged.sizeScale = patch.sizeScale;
    if (patch.outlineWidth !== undefined)
        merged.outlineWidth = patch.outlineWidth;
    if (patch.bgOpacity !== undefined)
        merged.bgOpacity = patch.bgOpacity;
    if (patch.palette !== undefined)
        merged.palette = { ...base?.palette, ...patch.palette };
    if (patch.position !== undefined)
        merged.position = { ...base?.position, ...patch.position };
    return merged;
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
async function revisionSnapshot(p, rev) {
    if (rev === 0)
        return null;
    let raw;
    try {
        raw = await fs.readFile(p.revisionsPath, 'utf8');
    }
    catch {
        raw = '';
    }
    let target;
    for (const line of raw.split('\n')) {
        if (!line)
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue; // tolerate a partial trailing line (crash mid-append), same as Project's own reconcile()
        }
        if (entry.rev === rev)
            target = entry; // last match wins (revs are unique in practice)
    }
    if (!target)
        throw new Error(`revision ${rev} not found`);
    return target.snapshot;
}
/**
 * Sanitize a browser-supplied filename for `POST /api/upload` (D&D ingest
 * fallback when a dropped file can't be located on disk — see
 * src/ingest/locate.ts): strip any directory components (defense in depth;
 * reserveUniqueUpload below also always joins under the fixed media/ dir, so a
 * "../.." here couldn't escape it either way) and replace anything but a
 * conservative safe-character set.
 */
function sanitizeUploadName(name) {
    const base = path.basename(String(name || '')).replace(/[\x00-\x1f]/g, '');
    const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').trim();
    return cleaned || 'upload.bin';
}
/**
 * Atomically reserve `dir/name`, then `dir/name-1`, ... with O_EXCL.
 *
 * A prior access()-then-create implementation had a classic TOCTOU window:
 * same-name uploads could both observe a free candidate and then open it for
 * truncating writes.  Returning the owning FileHandle also guarantees the
 * upload stream writes to the exact inode it reserved, even if another local
 * process renames the pathname while bytes are arriving.
 */
async function reserveUniqueUpload(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length) || 'upload';
    for (let i = 0;; i++) {
        const candidate = path.join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
        try {
            return { path: candidate, handle: await fs.open(candidate, 'wx', 0o600) };
        }
        catch (error) {
            if (error?.code === 'EEXIST')
                continue;
            throw error;
        }
    }
}
function uploadLeaseForPath(leases, projectDir, file) {
    const resolvedProject = path.resolve(projectDir);
    const resolvedFile = path.resolve(file);
    return [...leases.values()].find((lease) => (path.resolve(lease.projectDir) === resolvedProject && path.resolve(lease.path) === resolvedFile));
}
async function uploadLeaseStillOwnsPath(lease) {
    try {
        const current = await fs.lstat(lease.path);
        return Boolean(current.isFile()
            && current.dev === lease.dev
            && current.ino === lease.ino
            && current.size === lease.size);
    }
    catch {
        return false;
    }
}
/** Conservative recursive reference check: a false positive only retains an orphan; it can never delete live media. */
function containsExactString(value, target, seen = new Set()) {
    if (value === target)
        return true;
    if (value == null || typeof value !== 'object')
        return false;
    if (seen.has(value))
        return false;
    seen.add(value);
    if (Array.isArray(value))
        return value.some((item) => containsExactString(item, target, seen));
    return Object.values(value).some((item) => containsExactString(item, target, seen));
}
/**
 * Remove a failed-ingest upload only while the path still names the exact
 * regular-file inode created with O_EXCL.  Any missing, renamed, replaced,
 * directory, or manifest-referenced path is retained.  This deliberately
 * prefers a harmless orphan over deleting bytes the daemon cannot prove it
 * owns.
 */
async function cleanupFailedUpload(p, lease) {
    let manifest;
    try {
        manifest = await p.manifest();
    }
    catch {
        return false;
    }
    if (containsExactString(manifest, lease.path))
        return false;
    let current;
    try {
        current = await fs.lstat(lease.path);
    }
    catch {
        return false;
    }
    if (!current.isFile()
        || current.dev !== lease.dev
        || current.ino !== lease.ino
        || current.size !== lease.size)
        return false;
    try {
        await fs.unlink(lease.path);
        return true;
    }
    catch {
        return false;
    }
}
/** Every source's scenes file, skipping sources with no detected scenes (out of culling scope). */
async function sceneFilesFor(p, m) {
    const out = [];
    for (const s of m.sources) {
        const f = await p.scenes(s.id);
        if (f.scenes.length)
            out.push(f);
    }
    return out;
}
function reviewMapFor(m, sourceId) {
    return m.culling?.[sourceId] ?? {};
}
/** The linked kit's profile section, or null when no kit is linked / it's unreadable — same "degrade, never fail" contract as every other kit-optional lookup in this file (see /api/kit above). Shared by GET /api/qc (staticChecks' checkKitDuration) and could be reused by future kit-aware reads. */
async function kitProfileFor(m) {
    if (!m.kit)
        return null;
    try {
        return (await readKitFile(m.kit.path)).profile ?? null;
    }
    catch {
        return null;
    }
}
/** W-ANIME: the linked kit's asset list, or undefined when no kit is linked / it's unreadable — feeds GET /api/qc's checkKitAssetReferences (undefined means "skip the check", never "flag everything as missing"; see that function's doc). */
async function kitAssetsFor(m) {
    if (!m.kit)
        return undefined;
    try {
        return (await readKitFile(m.kit.path)).assets;
    }
    catch {
        return undefined;
    }
}
/**
 * W-ANIME: resolve a `compose --background <ref>` / `bg-set --to <ref>` CLI
 * argument into a BackgroundRef — the daemon's job (not ops.ts, which stays
 * I/O-free) since disambiguating "kit asset id" vs "video file path" needs
 * to read the linked kit and stat the filesystem. Resolution order: a
 * `#rrggbb`/`#rgb` string is always a color (kit asset ids/file paths never
 * start with `#`); else, when a kit is linked, a matching asset id wins;
 * else it's a video file path, checked for existence at `pathHint` when
 * given. `pathHint` — NOT `path.resolve(raw)` computed here — matters
 * because the daemon is a long-lived background process that may have been
 * launched from a different (and, across many CLI invocations, possibly
 * stale) working directory than whatever `vedit bg-set`/`compose` is run
 * from right now; the CLI resolves `raw` against ITS OWN (the user's
 * actual) cwd before sending, same convention as music-add's `path` /
 * color's `--lut` (both resolved client-side in cli.ts). A direct API
 * caller that omits `pathHint` (e.g. a test) falls back to resolving `raw`
 * against the daemon's own cwd, same as before this parameter existed.
 */
async function resolveBackgroundArg(raw, pathHint, m) {
    if (HEX_COLOR_RE.test(raw))
        return { ref: { type: 'color', hex: raw } };
    if (m.kit) {
        try {
            const kit = await readKitFile(m.kit.path);
            if ((kit.assets ?? []).some((a) => a.id === raw))
                return { ref: { type: 'asset', assetId: raw } };
        }
        catch { /* kit unreadable — fall through to video-path interpretation */ }
    }
    const abs = pathHint ?? path.resolve(raw);
    try {
        await fs.access(abs);
    }
    catch {
        return { error: `background: not a hex color, known kit asset id, or existing file: ${raw}` };
    }
    return { ref: { type: 'video', path: abs } };
}
/** Stable in-process ownership key for project-local source ids. */
function projectSourceKey(projectDir, sourceId) {
    return `${path.resolve(projectDir)}\0${sourceId}`;
}
function projectTaskKey(projectDir, taskId) {
    return `${path.resolve(projectDir)}\0${taskId}`;
}
function isActiveTranscribeJob(job) {
    return job?.status === 'queued' || job?.status === 'running' || job?.status === 'cancelling';
}
function transcribeJobFor(jobs, projectDir, sourceId) {
    return jobs.get(projectSourceKey(projectDir, sourceId));
}
function publicTranscribeJob(job) {
    return {
        taskId: job.taskId,
        projectDir: job.projectDir,
        sourceId: job.sourceId,
        status: job.status,
        phase: job.phase,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(job.error ? { error: job.error } : {}),
    };
}
function isActiveMediaJob(job) {
    return job?.status === 'running' || job?.status === 'cancelling';
}
function publicMediaJob(job) {
    return {
        taskId: job.taskId,
        projectDir: job.projectDir,
        kind: job.kind,
        status: job.status,
        phase: job.phase,
        startedAt: job.startedAt,
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(job.error ? { error: job.error } : {}),
        ...(job.file ? { file: job.file } : {}),
        ...(job.sourceIds ? { sourceIds: [...job.sourceIds] } : {}),
    };
}
function mediaJobsForProject(jobs, projectDir) {
    const resolved = path.resolve(projectDir);
    return [...jobs.values()].filter((job) => path.resolve(job.projectDir) === resolved);
}
/** Lease identity is daemon-internal; the browser needs only job progress. */
function publicExportJob(job) {
    const { owner: _owner, ...publicState } = job;
    return publicState;
}
function transcribeJobsForProject(jobs, projectDir) {
    const resolved = path.resolve(projectDir);
    return [...jobs.values()].filter((job) => path.resolve(job.projectDir) === resolved);
}
/** Memoized detectTakes(t) per project+sourceId — see Ctx.takesCache's doc for why this can't just call detectTakes fresh on every route. */
function takesFor(ctx, p, sourceId, t) {
    const key = projectSourceKey(p.dir, sourceId);
    if (!ctx.takesCache.has(key))
        ctx.takesCache.set(key, detectTakes(t));
    return ctx.takesCache.get(key);
}
/**
 * W-INTENT: non-blocking warning when a music item's duck region overlaps a
 * director-flagged 'quiet' intent zone (see ops.ts's
 * quietZonesOverlappingTimelineRange) — never rejects the music-add/-update,
 * just surfaces it in the response so the director can decide (lower the
 * duck amount, move the BGM, or accept it). `item` must already be the
 * item's state AS COMMITTED (post-mutate), not the pre-mutate request body,
 * so a music-update that only changes `gain` still gets warned against its
 * unchanged tlStart/duration/duck.
 */
function duckWarningFor(m, item) {
    if (!item.duck)
        return undefined;
    const zones = quietZonesOverlappingTimelineRange(m, item.tlStart, item.tlStart + item.duration);
    if (zones.length === 0)
        return undefined;
    const labels = zones.map((z) => z.label).join(', ');
    return `duck対象区間が意図ゾーン(quiet: ${labels})と重なっています — 発話扱いで自動的に音量が下がる可能性があります(拒否はしません; 気になる場合は --no-duck か配置をずらしてください)`;
}
/** Merge review verdicts onto a SceneFile's scenes for API responses, without ever writing them back to scenes-<sourceId>.json (review state lives only on the manifest). */
function withReview(f, m) {
    const rv = reviewMapFor(m, f.sourceId);
    return { ...f, scenes: f.scenes.map((s) => (rv[s.id] ? { ...s, review: rv[s.id] } : s)) };
}
/**
 * Snapshot the state the AI/UI needs after every mutation. `transcribeJobs`
 * keeps the last state per project-local source. Each source therefore gets
 * both the backward-compatible `transcribing` boolean and an additive,
 * explicit terminal/running job state without leaking a same-named source
 * from another open/forked project.
 */
async function stateSummary(p, transcribeJobs = new Map()) {
    const m = await p.manifest();
    const cands = await p.candidates();
    const pending = cands.filter(isActionableCandidate).length;
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
        dialogue: (m.timeline.dialogue ?? []).length,
        composition: m.composition ? { duration: m.composition.duration } : undefined,
        kit: m.kit ? { path: m.kit.path } : undefined,
        sources: m.sources.map((s) => {
            const job = transcribeJobFor(transcribeJobs, p.dir, s.id);
            return {
                id: s.id,
                path: s.path,
                duration: s.duration,
                transcribed: !!s.transcribed,
                // Kept for existing CLI/web consumers. `cancelling` stays true until
                // the child has exited and its temporary files have been removed.
                transcribing: isActiveTranscribeJob(job),
                ...(job ? { transcribeJob: publicTranscribeJob(job) } : {}),
                ...(needsColorTransform(s.color) ? { colorWarning: COLOR_WARNING_MESSAGE } : {}),
            };
        }),
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
export async function startDaemon(opts = {}) {
    const port = opts.port ?? Number(process.env.VEDIT_PORT ?? 7799);
    const ctx = {
        project: null,
        clients: new Set(),
        transcribeJobs: new Map(),
        transcribeRunning: 0,
        transcribeWaiters: [],
        mediaJobs: new Map(),
        takesCache: new Map(),
        activeExport: null,
        exportStarting: false,
        closing: false,
        detectTails: new Map(),
        uploadLeases: new Map(),
    };
    if (opts.projectDir) {
        const { project } = await openOrCreateProject(opts.projectDir, path.basename(opts.projectDir));
        ctx.project = project;
        await recoverInterruptedExportJob(project);
        if (project.warning)
            console.warn(`[vedit] ${project.dir}: ${project.warning}`);
    }
    const server = http.createServer(async (req, res) => {
        try {
            // The daemon is deliberately unauthenticated because it is local-only.
            // Validate the network identity before constructing/routing any URL so
            // a DNS-rebound Host cannot read even `/`, `/media/*`, or `/api/ping`.
            if (rejectUntrustedHttpRequest(req, res))
                return;
            const url = new URL(req.url ?? '/', `http://localhost:${port}`);
            await route(ctx, req, res, url);
        }
        catch (e) {
            const status = e?.code === 'DAEMON_CLOSING'
                ? 503
                : (e?.code === 'STALE_REVISION' || e?.code === 'EXPORT_JOB_CONFLICT')
                    ? 409
                    : e?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
            json(res, status, { error: e?.message ?? String(e), code: e?.code });
        }
    });
    // Upgrade requests bypass the normal HTTP request callback, so apply the
    // same Host/Origin boundary explicitly before handing a socket to `ws`.
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        let pathname = '';
        try {
            pathname = new URL(req.url ?? '/', `http://localhost:${port}`).pathname;
        }
        catch { /* rejected below */ }
        if (pathname !== '/ws' || !hasTrustedRequestOrigin(req)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    wss.on('connection', (ws) => {
        ctx.clients.add(ws);
        ws.on('close', () => ctx.clients.delete(ws));
    });
    // The single mutation wrapper: commit + notify everyone. `p` is always the
    // project the caller captured at the top of route() for THIS request — not
    // `ctx.project` re-read at call time — so a /api/open that swaps the
    // globally-open project mid-request can never redirect an in-flight edit
    // onto a different project directory.
    async function mutate(p, actor, baseRev, op, params, summary, fn, motionSpecUpdates) {
        const m = await p.commit(baseRev, actor, op, params, summary, fn, motionSpecUpdates);
        broadcast(ctx, { type: 'update', projectDir: p.dir, revision: m.revision, op, summary });
        return m;
    }
    function transcribeAbortError() {
        const error = new Error('operation cancelled');
        error.name = 'AbortError';
        return error;
    }
    function grantTranscribeWaiters() {
        while (ctx.transcribeRunning < MAX_CONCURRENT_TRANSCRIBES && ctx.transcribeWaiters.length > 0) {
            const waiter = ctx.transcribeWaiters.shift();
            waiter.job.controller.signal.removeEventListener('abort', waiter.onAbort);
            if (waiter.job.controller.signal.aborted) {
                waiter.reject(transcribeAbortError());
                continue;
            }
            ctx.transcribeRunning++;
            let released = false;
            waiter.resolve(() => {
                if (released)
                    return;
                released = true;
                ctx.transcribeRunning = Math.max(0, ctx.transcribeRunning - 1);
                grantTranscribeWaiters();
            });
        }
    }
    function acquireTranscribeSlot(job) {
        return new Promise((resolve, reject) => {
            const waiter = {
                job,
                resolve,
                reject,
                onAbort: () => {
                    const index = ctx.transcribeWaiters.indexOf(waiter);
                    if (index >= 0)
                        ctx.transcribeWaiters.splice(index, 1);
                    reject(transcribeAbortError());
                },
            };
            if (job.controller.signal.aborted)
                return reject(transcribeAbortError());
            job.controller.signal.addEventListener('abort', waiter.onAbort, { once: true });
            ctx.transcribeWaiters.push(waiter);
            grantTranscribeWaiters();
        });
    }
    /** Request cancellation while it can still prevent the logical commit. */
    function cancelTranscribeJob(job) {
        if (!isActiveTranscribeJob(job) || job.commitStarted)
            return false;
        job.status = 'cancelling';
        job.updatedAt = new Date().toISOString();
        job.controller.abort();
        return true;
    }
    /**
     * Background job body for `vedit transcribe` (W-LAZY: POST /api/transcribe
     * below). Runs whisper on the ORIGINAL file (never the proxy), propagates
     * cancellation to ffmpeg/whisper, then atomically publishes transcript +
     * Source.transcribed through Project.commitTranscript(). The job owns a
     * fixed Project instance and stable taskId, so /api/open cannot redirect
     * either its output or terminal state to another project/fork.
     */
    async function runTranscribeJob(job, language, glossary) {
        const { project: p, sourceId, taskId, controller } = job;
        let releaseSlot;
        try {
            broadcast(ctx, {
                type: 'transcribe-progress', projectDir: p.dir, sourceId, taskId,
                status: job.status, step: 'queued for transcription', job: publicTranscribeJob(job),
            });
            releaseSlot = await acquireTranscribeSlot(job);
            if (controller.signal.aborted)
                throw transcribeAbortError();
            job.status = 'running';
            job.phase = 'transcribing';
            job.updatedAt = new Date().toISOString();
            broadcast(ctx, {
                type: 'transcribe-progress', projectDir: p.dir, sourceId, taskId,
                status: job.status, step: 'transcribing (whisper)', job: publicTranscribeJob(job),
            });
            const m0 = await p.manifest();
            const src = m0.sources.find((s) => s.id === sourceId);
            if (!src)
                throw new Error(`unknown source: ${sourceId}`);
            const t = await transcribe(src.path, sourceId, {
                language,
                sourceDuration: src.duration,
                glossary,
                signal: controller.signal,
            });
            if (controller.signal.aborted) {
                const cancelled = new Error('operation cancelled');
                cancelled.name = 'AbortError';
                throw cancelled;
            }
            // No await between the abort check and this boundary. Once true, a
            // DELETE returns 409 instead of claiming it cancelled a transcript
            // whose atomic project commit may already be landing.
            job.commitStarted = true;
            job.phase = 'committing';
            job.updatedAt = new Date().toISOString();
            broadcast(ctx, {
                type: 'transcribe-progress', projectDir: p.dir, sourceId, taskId,
                status: job.status, step: 'saving transcript', job: publicTranscribeJob(job),
            });
            const summary = `transcribed ${path.basename(src.path)}`;
            const committed = await p.commitTranscript(t, 'system', { sourceId, language, taskId }, summary);
            ctx.takesCache.delete(projectSourceKey(p.dir, sourceId));
            job.status = 'success';
            job.phase = 'finished';
            job.finishedAt = new Date().toISOString();
            job.updatedAt = job.finishedAt;
            broadcast(ctx, {
                type: 'transcribe-done', projectDir: p.dir, sourceId, taskId,
                status: job.status, job: publicTranscribeJob(job),
            });
            broadcast(ctx, {
                type: 'update', projectDir: p.dir, revision: committed.revision,
                op: 'transcribe', summary, taskId,
            });
        }
        catch (e) {
            const cancelled = controller.signal.aborted || e?.name === 'AbortError';
            job.status = cancelled ? 'cancelled' : 'error';
            job.phase = 'finished';
            job.finishedAt = new Date().toISOString();
            job.updatedAt = job.finishedAt;
            job.error = cancelled ? undefined : (e?.message ?? String(e));
            // Keep the established error event for compatibility, with explicit
            // cancelled/status fields so current clients can distinguish a user
            // stop from a failure without leaving their progress indicator stuck.
            broadcast(ctx, {
                type: 'transcribe-error', projectDir: p.dir, sourceId, taskId,
                status: job.status, cancelled, error: job.error ?? 'operation cancelled',
                job: publicTranscribeJob(job),
            });
        }
        finally {
            releaseSlot?.();
        }
    }
    async function cancelAndDrainTranscribeJobs() {
        const active = [...ctx.transcribeJobs.values()].filter(isActiveTranscribeJob);
        for (const job of active)
            cancelTranscribeJob(job);
        await Promise.allSettled(active.map((job) => job.completion ?? Promise.resolve()));
    }
    /** Abort only while it can still prevent every logical publication. */
    function cancelMediaJob(job) {
        if (!isActiveMediaJob(job) || job.commitStarted)
            return false;
        job.status = 'cancelling';
        job.controller.abort();
        broadcast(ctx, {
            type: 'media-job',
            projectDir: job.projectDir,
            taskId: job.taskId,
            job: publicMediaJob(job),
        });
        return true;
    }
    async function cancelAndDrainMediaJobs() {
        const active = [...ctx.mediaJobs.values()].filter(isActiveMediaJob);
        for (const job of active)
            cancelMediaJob(job);
        await Promise.allSettled(active.map((job) => job.completion ?? Promise.resolve()));
    }
    function abortActiveExportBeforeFinalCommit() {
        const active = ctx.activeExport;
        if (active?.state.status === 'running' && !active.finalCommitted) {
            active.controller.abort();
        }
    }
    async function cancelAndDrainExportJob() {
        abortActiveExportBeforeFinalCommit();
        const completion = ctx.activeExport?.completion;
        if (completion)
            await completion;
    }
    let closePromise = null;
    function closeDaemon() {
        if (closePromise)
            return closePromise;
        closePromise = (async () => {
            // Gate routes before the first await, then abort a not-yet-committed
            // export before closing listeners. This is the clean SIGINT/SIGTERM
            // path used by the CLI.
            ctx.closing = true;
            abortActiveExportBeforeFinalCommit();
            const serverClosed = new Promise((resolve, reject) => {
                if (!server.listening)
                    return resolve();
                server.close((error) => error ? reject(error) : resolve());
            });
            // A browser that stopped servicing the WebSocket close handshake must
            // not keep SIGTERM shutdown (and ASR cleanup) alive indefinitely.
            for (const ws of ctx.clients)
                ws.terminate();
            const websocketClosed = new Promise((resolve) => wss.close(() => resolve()));
            // Cancel work already registered while server.close waits for any HTTP
            // handler that entered just before the gate. Once the server is closed,
            // repeat cancellation to catch a job that was being claimed by that
            // final in-flight request, then drain terminal-state writes/cleanup.
            const firstTranscribeDrain = cancelAndDrainTranscribeJobs();
            const firstMediaDrain = cancelAndDrainMediaJobs();
            await serverClosed;
            await Promise.all([
                firstTranscribeDrain,
                firstMediaDrain,
                cancelAndDrainTranscribeJobs(),
                cancelAndDrainMediaJobs(),
                cancelAndDrainExportJob(),
                websocketClosed,
            ]);
        })();
        return closePromise;
    }
    // Tests and embedders historically call `server.close()` directly. They
    // cannot await the richer closeDaemon contract, but must still terminate
    // children instead of leaving whisper/ffmpeg running after the HTTP server
    // dies. Callers needing the drain guarantee use the returned close().
    server.once('close', () => {
        ctx.closing = true;
        abortActiveExportBeforeFinalCommit();
        void cancelAndDrainTranscribeJobs();
        void cancelAndDrainMediaJobs();
        void cancelAndDrainExportJob();
    });
    async function runExportJob(active, inputs) {
        const { project, controller, partialPath } = active;
        const setState = async (patch) => {
            const next = { ...active.state, ...patch };
            try {
                await writeOwnedExportJob(project, next);
                active.state = next;
                active.durableStatePending = false;
            }
            catch (e) {
                if (e?.code === 'EXPORT_JOB_LEASE_LOST') {
                    active.durableStatePending = false;
                    controller.abort();
                    throw e;
                }
                const warning = `書き出し状態を保存できませんでした: ${e?.message ?? String(e)}`;
                active.state = next;
                if (!active.state.warnings?.includes(warning)) {
                    active.state = { ...active.state, warnings: [...(active.state.warnings ?? []), warning] };
                }
                active.durableStatePending = true;
            }
            broadcast(ctx, { type: 'export-job', projectDir: project.dir, job: publicExportJob(active.state) });
        };
        try {
            if (controller.signal.aborted) {
                const error = new Error('operation cancelled');
                error.name = 'AbortError';
                throw error;
            }
            const rendered = await renderProjectMp4(project, partialPath, {
                manifest: inputs.manifest,
                transcripts: inputs.transcripts,
                motionSpecs: inputs.motionSpecs,
                signal: controller.signal,
                recordFile: active.state.file,
                onPhase: async (phase) => setState({ phase }),
                finalize: async () => {
                    if (controller.signal.aborted) {
                        const e = new Error('operation cancelled');
                        e.name = 'AbortError';
                        throw e;
                    }
                    await fs.rename(partialPath, active.state.file);
                    // The successful same-directory rename is the commit boundary.
                    // No await between rename continuation and this assignment means a
                    // later DELETE/shutdown truthfully reports cancellation is too late
                    // and never removes a complete final MP4.
                    active.finalCommitted = true;
                },
            });
            await setState({
                status: 'success',
                phase: 'finalizing',
                finishedAt: new Date().toISOString(),
                warnings: rendered.warnings,
                error: undefined,
            });
        }
        catch (e) {
            await fs.rm(partialPath, { force: true }).catch(() => { });
            const cancelled = e?.name === 'AbortError' || controller.signal.aborted;
            const terminalPatch = cancelled
                ? { status: 'cancelled', finishedAt: new Date().toISOString(), error: undefined }
                : { status: 'error', finishedAt: new Date().toISOString(), error: e?.message ?? String(e) };
            try {
                await setState(terminalPatch);
            }
            catch (stateError) {
                // A lost lease must never be overwritten. Keep an honest in-memory
                // terminal state for this daemon while the current owner remains the
                // sole writer of durable state.
                active.state = {
                    ...active.state,
                    ...terminalPatch,
                    warnings: [
                        ...(active.state.warnings ?? []),
                        `書き出し終了状態を保存できませんでした: ${stateError?.message ?? String(stateError)}`,
                    ],
                };
                broadcast(ctx, { type: 'export-job', projectDir: project.dir, job: publicExportJob(active.state) });
            }
        }
        finally {
            await fs.rm(partialPath, { force: true }).catch(() => { });
            // Keep the terminal state in memory. If a later cache write failed,
            // GET can still report the honest outcome for this daemon lifetime;
            // the next POST simply replaces this non-running entry.
        }
    }
    async function repairPendingExportState(active) {
        if (!active.durableStatePending)
            return true;
        try {
            await writeOwnedExportJob(active.project, active.state);
            active.durableStatePending = false;
            return true;
        }
        catch (error) {
            if (error?.code === 'EXPORT_JOB_LEASE_LOST')
                active.durableStatePending = false;
            return false;
        }
    }
    async function route(ctx, req, res, url) {
        const { pathname } = url;
        const method = req.method ?? 'GET';
        // This must run before /api/open and before any request body is consumed:
        // hostile form/fetch requests therefore cannot switch projects, start an
        // upload, or park a large body in memory before being rejected.
        if (rejectUnsafeApiMutation(req, res, pathname, method))
            return;
        if (ctx.closing && pathname.startsWith('/api/') && MUTATING_API_METHODS.has(method)) {
            return json(res, 503, { error: 'daemon is shutting down; new work is not accepted', code: 'DAEMON_CLOSING' });
        }
        // ---- project lifecycle ----
        if (pathname === '/api/open' && method === 'POST') {
            const b = await readBody(req);
            const dir = path.resolve(b.dir);
            const { project, created } = await openOrCreateProject(dir, b.name ?? path.basename(dir));
            ctx.project = project;
            if (ctx.activeExport?.project.dir !== project.dir)
                await recoverInterruptedExportJob(project);
            // A switched-to project's sourceIds could collide with the previous
            // project's — clear the take-group memoization so /api/takes and
            // /api/show's kind='takes' never serve another project's cached
            // groups (and their ephemeral ids) under a same-named sourceId.
            ctx.takesCache.clear();
            if (!created) {
                try {
                    await upsertProject(dir, (await project.manifest()).name); // Project.create() upserts on its own path
                }
                catch (error) {
                    // Opening an explicit project must not depend on the optional
                    // global recent-projects index. Keep the source-of-truth project
                    // open and make the degraded discovery state visible to the user.
                    project.addWarning(`project opened, but project-list registration failed: ${error?.message ?? String(error)}`);
                }
            }
            broadcast(ctx, { type: 'project', projectDir: dir, dir });
            return json(res, 200, { ok: true, dir, state: await stateSummary(ctx.project, ctx.transcribeJobs) });
        }
        if (pathname === '/api/ping')
            return json(res, 200, { ok: true, project: ctx.project?.dir ?? null });
        const p = ctx.project;
        if (!p) {
            if (pathname.startsWith('/api/'))
                return json(res, 400, { error: 'no project open; POST /api/open {dir}' });
        }
        // Capture `p` once, then require the caller's rendered/read project
        // identity to match it before consuming any mutation body. This is what
        // prevents a stale A tab from editing B when both happen to be at rev N.
        if (p && rejectMismatchedProjectIdentity(req, res, pathname, method, p))
            return;
        // ---- static web UI + media ----
        if (!pathname.startsWith('/api/') && method === 'GET') {
            if (pathname.startsWith('/media/') && p)
                return serveMedia(p, pathname, req, res);
            return serveStatic(pathname, req, res);
        }
        if (!p)
            return json(res, 400, { error: 'no project open' });
        // ---- reads ----
        if (pathname === '/api/state')
            return json(res, 200, await stateSummary(p, ctx.transcribeJobs));
        if (pathname === '/api/project') {
            const m = await p.manifest();
            const detectRun = await readDetectRun(p.dir, m.revision);
            // `overlays`/`sprites` carry every item's resolved tlStart (null =
            // orphan) so the web UI never has to reimplement sourceTimeToTimeline
            // itself. `transcribing` (W-LAZY) is the queued/running subset for THIS
            // project — live job state, not part of the manifest — so the web UI can render the
            // right "文字起こし: なし/処理中/済" state even for a browser tab that
            // (re)loads mid-job, before the next transcribe-progress WS message.
            // W-ANIME: `backgroundIntervals` gives the web preview/timeline the
            // fully-resolved "紙芝居" ([t0,t1)+ref per cut) without reimplementing
            // resolvedBackgroundAt itself; empty for a non-composition manifest.
            // `dialogue` rides along verbatim (already absolute-placed, no
            // resolution needed — see DialogueItem's doc).
            return json(res, 200, {
                projectDir: p.dir,
                manifest: m, segments: segments(m), duration: timelineDuration(m),
                overlays: resolveOverlays(m), sprites: resolveSprites(m),
                dialogue: m.timeline.dialogue ?? [],
                backgroundIntervals: backgroundIntervals(m),
                transcribing: transcribeJobsForProject(ctx.transcribeJobs, p.dir)
                    .filter(isActiveTranscribeJob)
                    .map((job) => job.sourceId),
                transcribeJobs: transcribeJobsForProject(ctx.transcribeJobs, p.dir).map(publicTranscribeJob),
                mediaJobs: mediaJobsForProject(ctx.mediaJobs, p.dir).map(publicMediaJob),
                detectRun,
            });
        }
        if (pathname === '/api/kit') {
            const m = await p.manifest();
            if (!m.kit)
                return json(res, 200, { path: null, kit: null });
            try {
                const kit = await readKitFile(m.kit.path);
                return json(res, 200, { path: m.kit.path, kit, recognizedSections: recognizedKitSections(kit) });
            }
            catch (e) {
                return json(res, 200, { path: m.kit.path, kit: null, error: e?.message ?? String(e) });
            }
        }
        if (pathname === '/api/revisions')
            return json(res, 200, await p.revisions());
        // N2 デザイン波「計器盤」K6「押している間、直前」: 読み取り専用の revision
        // スナップショット再構成(revisionSnapshot は既存の /api/show kind=compare
        // が使っているのと同じ関数 — 書き込みは一切行わない)。web は現行
        // revision-1 をホールド開始時に1回だけ取得してキャッシュする(ブリーフ
        // §3)ので、レスポンス形は GET /api/project と同じ形(manifest/segments/
        // duration/overlays/sprites/dialogue/backgroundIntervals)に揃え、web 側が
        // 別のデータ整形を持たずに済むようにする。
        if (pathname === '/api/manifest-at') {
            const m = await p.manifest();
            const revParam = url.searchParams.get('revision');
            const rev = Number(revParam);
            if (!revParam || !Number.isInteger(rev) || rev < 1 || rev > m.revision) {
                return json(res, 400, { error: `manifest-at: revision must be an integer between 1 and ${m.revision}` });
            }
            let snapshot;
            try {
                snapshot = await revisionSnapshot(p, rev);
            }
            catch (e) {
                return json(res, 404, { error: e?.message ?? String(e) });
            }
            if (!snapshot)
                return json(res, 404, { error: `revision ${rev} has no snapshot` });
            return json(res, 200, {
                revision: rev,
                manifest: snapshot,
                segments: segments(snapshot),
                duration: timelineDuration(snapshot),
                overlays: resolveOverlays(snapshot),
                sprites: resolveSprites(snapshot),
                dialogue: snapshot.timeline.dialogue ?? [],
                backgroundIntervals: backgroundIntervals(snapshot),
            });
        }
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
            if (transcribedSrcs.length === 0)
                return json(res, 404, { error: 'no transcribed source' });
            const renderPacked = async (sourceId) => {
                const t = await p.transcript(sourceId);
                const cands = await p.candidates();
                return packTranscript(m, t, cands);
            };
            if (requestedSource) {
                if (full)
                    return json(res, 200, await p.transcript(requestedSource));
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
                const parts = [];
                for (const s of transcribedSrcs) {
                    parts.push(`## source ${s.id} (${path.basename(s.path)}) — use --source ${s.id} for edits`);
                    parts.push(await renderPacked(s.id));
                }
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end(parts.join('\n\n'));
            }
            // exactly one transcribed source
            const sourceId = transcribedSrcs[0].id;
            if (full)
                return json(res, 200, await p.transcript(sourceId));
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end(await renderPacked(sourceId));
        }
        if (pathname === '/api/captions') {
            const m = await p.manifest();
            return json(res, 200, captionCues(m, await allTranscripts(p)));
        }
        if (pathname === '/api/fonts' && method === 'GET') {
            // W-CAP: font <select> for the web caption style popover (grouped
            // kit/system). Kit fonts are re-scanned fresh every call (small
            // directory, same convention as readKitFile); system fonts are
            // memory+disk cached (1 day) — see listSystemFonts in core/fonts.ts —
            // so this route stays cheap after its first, possibly-slow call.
            const m = await p.manifest();
            const kitFonts = m.kit ? await scanKitFonts(m.kit.path).catch(() => []) : [];
            const systemFonts = await listSystemFonts(path.join(p.cacheDir, 'fonts.json'));
            return json(res, 200, { kit: kitFonts, system: systemFonts });
        }
        if (pathname.startsWith('/api/motion/') && method === 'GET') {
            const id = pathname.split('/')[3];
            try {
                const spec = JSON.parse(await fs.readFile(p.motionSpecPath(id), 'utf8'));
                return json(res, 200, spec);
            }
            catch {
                return json(res, 404, { error: `no motion spec: ${id}` });
            }
        }
        if (pathname === '/api/candidates') {
            const all = await p.candidates();
            const pending = url.searchParams.get('all') ? all : all.filter(isActionableCandidate);
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
                if (full)
                    return json(res, 200, withReview(f, m));
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end(packScenes(f, reviewMapFor(m, requestedSource)));
            }
            const withScenes = [];
            for (const s of m.sources) {
                const f = await p.scenes(s.id);
                if (f.scenes.length)
                    withScenes.push(s.id);
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
                const parts = [];
                for (const id of withScenes) {
                    parts.push(`## source ${id} — use --source ${id} for edits`);
                    parts.push(packScenes(await p.scenes(id), reviewMapFor(m, id)));
                }
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end(parts.join('\n\n'));
            }
            const only = withScenes[0];
            if (full)
                return json(res, 200, withReview(await p.scenes(only), m));
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end(packScenes(await p.scenes(only), reviewMapFor(m, only)));
        }
        if (pathname === '/api/review-status' && method === 'GET') {
            const m = await p.manifest();
            const sceneFiles = await sceneFilesFor(p, m);
            const stats = cullingStats(m, sceneFiles);
            let next = null;
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
        // ---- W9 QC / W11 multi-take (both read-only) ----
        if (pathname === '/api/qc' && method === 'GET') {
            // Static-only: manifest-level checks that need no rendered file (see
            // qc.ts's staticChecks doc) — deliberately cheap enough to call on
            // every "いま" tab render. The heavier probeRenderedFile/
            // tempoContractLite passes are `vedit qc --render`-only (CLI, not the
            // daemon) since they need an actual rendered file / ffmpeg probe.
            const m = await p.manifest();
            const [transcripts, sceneFiles, candidates, kitProfile, kitAssets] = await Promise.all([
                allTranscripts(p),
                sceneFilesFor(p, m),
                p.candidates(),
                kitProfileFor(m),
                kitAssetsFor(m),
            ]);
            const report = await staticChecks(m, transcripts, sceneFiles, { candidates, kitProfile, kitAssets });
            return json(res, 200, report);
        }
        if (pathname === '/api/takes' && method === 'GET') {
            // Read-only: detectTakes → raw TakeGroup[] JSON (see core/takes.js's
            // module doc — this never edits the manifest). Same
            // "?source= optional, ambiguous across >1 transcribed source" contract
            // as /api/transcript above.
            const m = await p.manifest();
            const requestedSource = url.searchParams.get('source');
            if (requestedSource && !m.sources.some((s) => s.id === requestedSource)) {
                return json(res, 404, { error: `unknown source: ${requestedSource}` });
            }
            const transcribedSrcs = m.sources.filter((s) => s.transcribed);
            if (transcribedSrcs.length === 0)
                return json(res, 404, { error: 'no transcribed source' });
            let sourceId = requestedSource ?? undefined;
            if (!sourceId) {
                if (transcribedSrcs.length > 1) {
                    return json(res, 400, {
                        error: 'multiple transcribed sources; specify sourceId (--source <id>)',
                        sources: transcribedSrcs.map((s) => ({ id: s.id, path: path.basename(s.path) })),
                    });
                }
                sourceId = transcribedSrcs[0].id;
            }
            else if (!transcribedSrcs.some((s) => s.id === sourceId)) {
                return json(res, 400, { error: `source has no transcript: ${sourceId}` });
            }
            const t = await p.transcript(sourceId);
            return json(res, 200, takesFor(ctx, p, sourceId, t));
        }
        if (pathname === '/api/export-results' && method === 'GET') {
            // CLI とアプリ内ローカルMP4ジョブが残した結果を返す読み取り面。
            // 公開/送信は扱わず、stateSummaryにも混ぜない。
            const n = Math.min(Math.max(Number(url.searchParams.get('n') ?? 5) || 5, 1), 20);
            const all = await readExportResults(p.dir);
            return json(res, 200, all.slice(0, n));
        }
        if (pathname === '/api/export-job' && method === 'GET') {
            let job;
            const active = ctx.activeExport?.project.dir === p.dir ? ctx.activeExport : null;
            if (active?.durableStatePending)
                await repairPendingExportState(active);
            const durable = await readExportJob(p.dir);
            if (active && (active.state.status === 'running' || durable?.id === active.state.id)) {
                job = active.state;
            }
            else {
                job = durable;
                if (job?.status === 'running')
                    job = await recoverInterruptedExportJob(p);
            }
            if (job?.status === 'running') {
                try {
                    const candidate = exportJobPartialPath(job);
                    const safePartial = await resolveWithinDir(p.dir, path.relative(p.dir, candidate));
                    const st = await fs.stat(safePartial);
                    job = { ...job, partialBytes: st.size };
                }
                catch { /* partial file may not exist during preparation */ }
            }
            return json(res, 200, { job: job ? publicExportJob(job) : null });
        }
        if (pathname === '/api/export-job' && method === 'POST') {
            const b = await readBody(req);
            if (typeof b.baseRev !== 'number')
                return json(res, 400, { error: 'baseRev is required' });
            if (ctx.activeExport?.durableStatePending && !(await repairPendingExportState(ctx.activeExport))) {
                return json(res, 503, {
                    code: 'EXPORT_STATE_PERSISTENCE_PENDING',
                    error: '前の書き出し終了状態を保存できていません。保存先を確認して再試行してください',
                    ...(ctx.activeExport.project.dir === p.dir ? { job: publicExportJob(ctx.activeExport.state) } : {}),
                });
            }
            if (ctx.exportStarting || ctx.activeExport?.state.status === 'running') {
                const sameProject = ctx.activeExport?.project.dir === p.dir ? ctx.activeExport : null;
                return json(res, 409, {
                    error: sameProject ? 'このプロジェクトのMP4書き出しが実行中です' : '別のプロジェクトのMP4書き出しが実行中です',
                    ...(sameProject ? { job: publicExportJob(sameProject.state) } : {}),
                });
            }
            // Claim the start slot synchronously before any preparation await. Two
            // concurrent POSTs can no longer both pass the guard above.
            ctx.exportStarting = true;
            try {
                const inputs = await p.captureRenderInputs(b.baseRev);
                const m = inputs.manifest;
                const requestedOutDir = path.join(p.dir, 'exports');
                await fs.mkdir(requestedOutDir, { recursive: true });
                const outDir = await resolveWithinDir(p.dir, 'exports');
                const id = freshId('export');
                const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
                const file = path.join(outDir, `rev-${m.revision}-${stamp}-${id}.mp4`);
                const proposed = {
                    id,
                    revision: m.revision,
                    status: 'running',
                    phase: 'preparing',
                    startedAt: new Date().toISOString(),
                    file,
                };
                let state;
                try {
                    state = await claimExportJob(p, proposed);
                }
                catch (e) {
                    if (e instanceof ExportJobConflictError) {
                        return json(res, 409, { error: e.message, job: publicExportJob(e.job) });
                    }
                    throw e;
                }
                const active = {
                    project: p,
                    state,
                    partialPath: exportJobPartialPath(state),
                    controller: new AbortController(),
                    finalCommitted: false,
                    completion: null,
                    durableStatePending: false,
                };
                ctx.activeExport = active;
                broadcast(ctx, { type: 'export-job', projectDir: p.dir, job: publicExportJob(state) });
                // closeDaemon may have started while claimExportJob was awaiting the
                // project lock. Register ownership first, then abort before launching
                // any encoder work when the closing gate is already set.
                if (ctx.closing)
                    active.controller.abort();
                const completion = runExportJob(active, inputs);
                active.completion = completion;
                void completion.catch((e) => {
                    console.error(`[vedit] export job ${state.id} failed outside its state handler: ${e?.message ?? String(e)}`);
                });
                return json(res, 202, { job: publicExportJob(state) });
            }
            finally {
                ctx.exportStarting = false;
            }
        }
        if ((pathname === '/api/export-job' || pathname.startsWith('/api/export-job/')) && method === 'DELETE') {
            const requestedId = pathname.split('/')[3] || url.searchParams.get('id');
            const active = ctx.activeExport;
            if (!active ||
                active.state.status !== 'running' ||
                active.project.dir !== p.dir ||
                (requestedId && requestedId !== active.state.id)) {
                return json(res, 404, { error: '実行中の書き出しはありません' });
            }
            if (active.finalCommitted) {
                return json(res, 409, { error: 'MP4ファイルは確定済みのため中止できません', job: publicExportJob(active.state) });
            }
            active.controller.abort();
            return json(res, 202, { job: publicExportJob(active.state) });
        }
        if (pathname === '/api/notes' && method === 'GET') {
            // IA v3 波B §8: read-only surface for `vedit note`(src/core/notes.ts,
            // NOTES.md)——同じ「実行系ルートは作らない、記録済みのものを返すだけ」
            // 規律を /api/export-results と共有する。web の「机」(キューシート常設面
            // §1.1「紙を白紙にしない」)がプロジェクトメモの policy/todo 先頭数件を
            // ここから拾う(renderQueueSheetDesk in app.js)。古い順の全件を返し、
            // 「先頭数件」の選び方(最新優先か記載順か)は表示側の裁量に委ねる。
            return json(res, 200, await readNotes(p.dir));
        }
        // Ingest and scene detection remain synchronous for backward-compatible
        // CLI responses, but their stable task ids and terminal truth are
        // independently inspectable/cancellable. We intentionally do NOT bind
        // cancellation to the initiating HTTP socket: a browser reload or brief
        // disconnect must not discard minutes of valid local processing. DELETE
        // is the sole cancellation request and survives reconnection.
        if (pathname === '/api/media-jobs' && method === 'GET') {
            const requestedKind = url.searchParams.get('kind');
            if (requestedKind && requestedKind !== 'ingest' && requestedKind !== 'scenes') {
                return json(res, 400, { error: 'media-jobs: kind must be ingest or scenes' });
            }
            return json(res, 200, {
                jobs: mediaJobsForProject(ctx.mediaJobs, p.dir)
                    .filter((job) => !requestedKind || job.kind === requestedKind)
                    .map(publicMediaJob),
            });
        }
        if ((pathname === '/api/media-jobs' || pathname.startsWith('/api/media-jobs/')) && method === 'DELETE') {
            const requestedTaskId = pathname.split('/')[3] || url.searchParams.get('id');
            if (!requestedTaskId)
                return json(res, 400, { error: 'media-jobs: task id is required' });
            const job = ctx.mediaJobs.get(projectTaskKey(p.dir, requestedTaskId));
            if (!job)
                return json(res, 404, { error: 'このプロジェクトの処理ジョブが見つかりません' });
            if (!isActiveMediaJob(job)) {
                return json(res, 409, { error: '処理ジョブはすでに終了しています', job: publicMediaJob(job) });
            }
            if (job.commitStarted) {
                return json(res, 409, { error: '結果の保存が始まっているため中止できません', job: publicMediaJob(job) });
            }
            cancelMediaJob(job);
            return json(res, 202, { job: publicMediaJob(job) });
        }
        // ---- ingest ----
        if (pathname === '/api/ingest' && method === 'POST') {
            const b = await readBody(req);
            const explicitUploadToken = b.uploadToken;
            let uploadLease;
            if (explicitUploadToken !== undefined) {
                if (typeof explicitUploadToken !== 'string' || !explicitUploadToken) {
                    return json(res, 400, { error: 'ingest: uploadToken must be a non-empty string' });
                }
                uploadLease = ctx.uploadLeases.get(explicitUploadToken);
                if (!uploadLease
                    || path.resolve(uploadLease.projectDir) !== path.resolve(p.dir)
                    || path.resolve(uploadLease.path) !== path.resolve(String(b.file ?? ''))) {
                    return json(res, 400, { error: 'ingest: uploadToken does not own this file in the current project' });
                }
            }
            else if (typeof b.file === 'string') {
                // Backward-compatible linkage for the existing browser: the exact
                // path returned by /api/upload is enough to claim its in-memory
                // ownership receipt.  A pre-existing user path can never enter this
                // map because upload reservation uses O_EXCL.
                uploadLease = uploadLeaseForPath(ctx.uploadLeases, p.dir, b.file);
            }
            if (uploadLease && !(await uploadLeaseStillOwnsPath(uploadLease))) {
                // The token/path receipt authorizes the exact inode uploaded by this
                // daemon, not whatever bytes later occupy the same pathname. Consume
                // the stale receipt but never unlink the replacement; the browser can
                // upload again and receive a fresh token.
                ctx.uploadLeases.delete(uploadLease.token);
                return json(res, 409, {
                    code: 'UPLOAD_IDENTITY_MISMATCH',
                    error: 'ingest: uploaded file changed before ingest; upload it again',
                });
            }
            // A lease belongs to at most one ingest attempt.  Claim synchronously
            // before slow probing/proxy work so concurrent duplicate requests
            // cannot both decide they are entitled to delete the same pathname.
            if (uploadLease)
                ctx.uploadLeases.delete(uploadLease.token);
            const taskId = freshId('ingest');
            const controller = new AbortController();
            const job = {
                taskId,
                projectDir: p.dir,
                project: p,
                kind: 'ingest',
                status: 'running',
                phase: 'starting',
                startedAt: new Date().toISOString(),
                ...(typeof b.file === 'string' ? { file: b.file } : {}),
                controller,
                completion: null,
                commitStarted: false,
            };
            ctx.mediaJobs.set(projectTaskKey(p.dir, taskId), job);
            broadcast(ctx, {
                type: 'ingest-start', projectDir: p.dir, taskId, file: b.file,
                job: publicMediaJob(job),
            });
            const operation = (async () => {
                try {
                    const ingested = await ingestFile(p, b.file, {
                        language: b.language,
                        transcribe: b.transcribe,
                        // W-LAZY: undefined (the common case — neither `vedit ingest` nor
                        // `ingest-batch` sends this unless `--no-scenes` was given) falls
                        // through to ingestFile's own default (true).
                        scenes: b.scenes,
                        addToTimeline: b.addToTimeline,
                        // Set only by `ingest-batch` (see src/ingest/batch.ts), which
                        // computes the hash itself during its verification pass; a plain
                        // `vedit ingest` never sends this, so `source.sha256` stays unset
                        // exactly as before this option existed.
                        sha256: b.sha256,
                        signal: controller.signal,
                        onCommitStart: () => {
                            job.commitStarted = true;
                            job.phase = 'committing';
                            broadcast(ctx, {
                                type: 'ingest-progress', projectDir: p.dir, taskId, file: b.file,
                                step: 'committing', job: publicMediaJob(job),
                            });
                        },
                        onProgress: (step) => {
                            if (!job.commitStarted)
                                job.phase = step;
                            broadcast(ctx, {
                                type: 'ingest-progress', projectDir: p.dir, taskId, file: b.file,
                                step, job: publicMediaJob(job),
                            });
                        },
                    });
                    job.status = 'success';
                    job.phase = 'finished';
                    job.finishedAt = new Date().toISOString();
                    const { source: src } = ingested;
                    broadcast(ctx, {
                        type: 'ingest-done', projectDir: p.dir, taskId, file: b.file,
                        sourceId: src.id, job: publicMediaJob(job),
                    });
                    broadcast(ctx, {
                        type: 'update', projectDir: p.dir, revision: (await p.manifest()).revision,
                        op: 'ingest', summary: `ingested ${b.file}`, taskId,
                    });
                    return ingested;
                }
                catch (e) {
                    const cancelled = controller.signal.aborted || e?.name === 'AbortError';
                    const removedManagedUpload = uploadLease ? await cleanupFailedUpload(p, uploadLease) : false;
                    job.status = cancelled ? 'cancelled' : 'error';
                    job.phase = 'finished';
                    job.finishedAt = new Date().toISOString();
                    job.error = cancelled ? undefined : (e?.message ?? String(e));
                    broadcast(ctx, {
                        type: 'ingest-error',
                        projectDir: p.dir,
                        taskId,
                        file: b.file,
                        status: job.status,
                        cancelled,
                        error: job.error ?? 'operation cancelled',
                        job: publicMediaJob(job),
                        ...(uploadLease ? { removedManagedUpload } : {}),
                    });
                    throw e;
                }
            })();
            // Completion includes child termination, derived-file cleanup, managed
            // upload cleanup and terminal event publication. Shutdown drains this,
            // not merely the initiating HTTP socket.
            job.completion = operation.then(() => undefined, () => undefined);
            let ingested;
            try {
                ingested = await operation;
            }
            catch (e) {
                if (job.status === 'cancelled') {
                    return json(res, 409, {
                        code: 'OPERATION_CANCELLED',
                        error: 'ingest was cancelled before saving',
                        job: publicMediaJob(job),
                    });
                }
                throw e;
            }
            const { source: src, timings } = ingested;
            return json(res, 200, {
                taskId,
                job: publicMediaJob(job),
                source: src,
                timings,
                state: await stateSummary(p, ctx.transcribeJobs),
            });
        }
        // Explicit transcription job truth. Terminal states remain available
        // until this source is started again (or the daemon exits), while every
        // query/cancel is scoped to the currently-open project.
        if (pathname === '/api/transcribe-jobs' && method === 'GET') {
            return json(res, 200, {
                jobs: transcribeJobsForProject(ctx.transcribeJobs, p.dir).map(publicTranscribeJob),
            });
        }
        if ((pathname === '/api/transcribe-jobs' || pathname.startsWith('/api/transcribe-jobs/')) && method === 'DELETE') {
            const requestedTaskId = pathname.split('/')[3] || url.searchParams.get('id');
            const requestedSourceId = url.searchParams.get('sourceId');
            const job = transcribeJobsForProject(ctx.transcribeJobs, p.dir).find((candidate) => (requestedTaskId ? candidate.taskId === requestedTaskId : requestedSourceId ? candidate.sourceId === requestedSourceId : false));
            if (!job)
                return json(res, 404, { error: '実行中の文字起こしジョブが見つかりません' });
            if (!isActiveTranscribeJob(job)) {
                return json(res, 409, { error: '文字起こしジョブはすでに終了しています', job: publicTranscribeJob(job) });
            }
            if (job.commitStarted) {
                return json(res, 409, { error: '文字起こし結果の保存が始まっているため中止できません', job: publicTranscribeJob(job) });
            }
            cancelTranscribeJob(job);
            broadcast(ctx, {
                type: 'transcribe-progress', projectDir: p.dir, sourceId: job.sourceId, taskId: job.taskId,
                status: job.status, step: 'cancelling', job: publicTranscribeJob(job),
            });
            return json(res, 202, { job: publicTranscribeJob(job) });
        }
        // ---- W-LAZY: explicit, async transcribe job (decoupled from ingest —
        // see ingestFile's `transcribe` default of false). Responds immediately
        // (the "202-equivalent" contract) with which sourceIds actually started;
        // progress/completion arrive over the websocket as transcribe-progress /
        // transcribe-done / transcribe-error (see runTranscribeJob above), and
        // /api/state's per-source `transcribing`/`transcribed` reflect it too. ----
        if (pathname === '/api/transcribe' && method === 'POST') {
            const b = await readBody(req);
            const requested = typeof b.sourceId === 'string' && b.sourceId ? b.sourceId : undefined;
            if (!requested)
                return json(res, 400, { error: 'transcribe: sourceId is required ("all" or a specific source id)' });
            const m = await p.manifest();
            let targets;
            if (requested === 'all') {
                targets = m.sources.filter((s) => s.hasAudio && !s.transcribed).map((s) => s.id);
            }
            else {
                const src = m.sources.find((s) => s.id === requested);
                if (!src)
                    return json(res, 400, { error: `unknown source: ${requested}` });
                // Same gate ingestFile itself applies (transcribe only ever runs for
                // p.hasAudio) — failing fast here is clearer than letting the
                // background job start whisper against a file with no audio stream
                // and surface the ffmpeg "-map a:0" failure later as
                // transcribe-error.
                if (!src.hasAudio)
                    return json(res, 400, { error: `source has no audio: ${requested}` });
                targets = [requested];
            }
            const alreadyRunning = targets.filter((id) => isActiveTranscribeJob(transcribeJobFor(ctx.transcribeJobs, p.dir, id)));
            // A specific sourceId that's already mid-job is a real double-start —
            // reject it outright (the daemon-side "同一ソースの二重起動は拒否"
            // guard). "all" instead just skips whichever of its targets are
            // already running and starts the rest — an "all" call while every
            // eligible source happens to already be running isn't an error, just
            // nothing new to start.
            if (requested !== 'all' && alreadyRunning.length > 0) {
                return json(res, 400, { error: `already transcribing: ${requested}` });
            }
            // roadmap "whisper 用語集プロンプト": b.glossary, if present, is this
            // request's explicit glossary (the CLI's `vedit transcribe --glossary`
            // already resolves "omitted -> reuse stored" client-side and always
            // sends the resolved array — see cli.ts's transcribe case — but a
            // direct API caller may also pass a raw comma-separated string, same
            // shape as the CLI's own --glossary flag value). When present, persist
            // it via setTranscriptionGlossary — same --base optimistic-lock
            // convention as /api/edit (b.baseRev, falling back to the manifest
            // revision just read) — so it keeps applying to future transcribes
            // without re-specifying it. When absent, fall back to whatever the
            // manifest already has stored.
            const explicitGlossary = b.glossary == null
                ? undefined
                : Array.isArray(b.glossary)
                    ? b.glossary.map((t) => String(t))
                    : String(b.glossary).split(',').map((t) => t.trim()).filter(Boolean);
            if (explicitGlossary !== undefined) {
                const actor = revisionActor(b.actor, 'agent');
                if (isAgentActor(actor) && typeof b.baseRev !== 'number') {
                    return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
                }
                const baseRev = typeof b.baseRev === 'number' ? b.baseRev : m.revision;
                await mutate(p, actor, baseRev, 'glossary-set', b, `glossary set (${explicitGlossary.length} term${explicitGlossary.length === 1 ? '' : 's'})`, (mm) => setTranscriptionGlossary(mm, explicitGlossary));
            }
            const glossary = explicitGlossary ?? m.transcription?.glossary;
            const toStart = targets.filter((id) => !isActiveTranscribeJob(transcribeJobFor(ctx.transcribeJobs, p.dir, id)));
            const jobs = [];
            for (const id of toStart) {
                const startedAt = new Date().toISOString();
                const job = {
                    taskId: freshId('transcribe'),
                    projectDir: p.dir,
                    sourceId: id,
                    status: 'queued',
                    phase: 'queued',
                    startedAt,
                    updatedAt: startedAt,
                    project: p,
                    controller: new AbortController(),
                    completion: null,
                    commitStarted: false,
                };
                ctx.transcribeJobs.set(projectSourceKey(p.dir, id), job);
                jobs.push(job);
                job.completion = runTranscribeJob(job, b.language, glossary).catch((error) => {
                    // runTranscribeJob owns all expected failure states. This final
                    // guard prevents an accidental handler bug from becoming an
                    // unhandled rejection that could terminate the daemon.
                    console.error(`[vedit] transcribe job ${job.taskId} failed outside its state handler: ${error?.message ?? String(error)}`);
                });
            }
            return json(res, 200, {
                started: toStart,
                skipped: alreadyRunning,
                glossary: glossary ?? [],
                jobs: jobs.map(publicTranscribeJob),
            });
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
            const fingerprint = { size, headSha256, tailSha256 };
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
            const requestedMediaDir = path.join(p.dir, 'media');
            await fs.mkdir(requestedMediaDir, { recursive: true });
            const mediaDir = await resolveWithinDir(p.dir, 'media');
            const reserved = await reserveUniqueUpload(mediaDir, safeName);
            const destPath = reserved.path;
            const initialStat = await reserved.handle.stat();
            const taskId = freshId('upload');
            broadcast(ctx, { type: 'upload-start', projectDir: p.dir, taskId, name: safeName });
            let written = 0;
            let lastBroadcast = 0;
            // Let the stream close its owning descriptor on finish.  pipeline()
            // intentionally waits for that close event; autoClose:false would
            // leave an otherwise successful HTTP upload pending forever.
            const out = reserved.handle.createWriteStream();
            req.on('data', (chunk) => {
                written += chunk.length;
                const now = Date.now();
                if (now - lastBroadcast > 250) {
                    lastBroadcast = now;
                    broadcast(ctx, { type: 'upload-progress', projectDir: p.dir, taskId, name: safeName, bytes: written, done: false });
                }
            });
            try {
                // pipeline rejects on request aborts as well as read/write failures;
                // req.pipe(out) alone can leave `finish` pending forever after the
                // browser cancels a large upload.
                await pipeline(req, out);
                const completedStat = await fs.lstat(destPath);
                if (!completedStat.isFile()
                    || completedStat.dev !== initialStat.dev
                    || completedStat.ino !== initialStat.ino)
                    throw new Error('upload destination changed before completion');
                const uploadToken = freshId('upl');
                ctx.uploadLeases.set(uploadToken, {
                    token: uploadToken,
                    projectDir: p.dir,
                    path: destPath,
                    dev: completedStat.dev,
                    ino: completedStat.ino,
                    size: completedStat.size,
                });
                // Receipts are only needed across the immediate upload -> ingest
                // hand-off.  Bound forgotten BGM/upload-only receipts without ever
                // deleting their successfully written files.
                while (ctx.uploadLeases.size > 2048) {
                    const oldest = ctx.uploadLeases.keys().next().value;
                    if (!oldest)
                        break;
                    ctx.uploadLeases.delete(oldest);
                }
                broadcast(ctx, { type: 'upload-progress', projectDir: p.dir, taskId, name: safeName, bytes: written, done: true });
                return json(res, 200, { path: destPath, bytes: written, uploadToken, projectDir: p.dir });
            }
            catch (e) {
                await reserved.handle.close().catch(() => { });
                const currentStat = await fs.lstat(destPath).catch(() => null);
                const ownedSize = currentStat
                    && currentStat.isFile()
                    && currentStat.dev === initialStat.dev
                    && currentStat.ino === initialStat.ino
                    ? currentStat.size
                    : initialStat.size;
                await cleanupFailedUpload(p, {
                    token: taskId,
                    projectDir: p.dir,
                    path: destPath,
                    // Never adopt the inode found at the pathname after an error: a
                    // local rename/replacement race must turn into a retained orphan,
                    // not ownership of (and deletion of) somebody else's file.
                    dev: initialStat.dev,
                    ino: initialStat.ino,
                    size: ownedSize,
                });
                broadcast(ctx, {
                    type: 'upload-error',
                    projectDir: p.dir,
                    taskId,
                    name: safeName,
                    bytes: written,
                    error: e?.message ?? String(e),
                });
                return json(res, 400, { error: `upload failed: ${e?.message ?? e}` });
            }
        }
        // ---- W-UI companion channel (W-UI §0): tell every connected browser to
        // jump/highlight/show something, without creating a revision or needing
        // an actor — purely a UI cue so a user watching the browser alongside
        // the chat sees what's being talked about. ----
        if (pathname === '/api/show' && method === 'POST') {
            const b = await readBody(req);
            const m = await p.manifest();
            let directive;
            if (b.kind === 'range') {
                const tlStart = Number(b.tlStart);
                const tlEnd = Number(b.tlEnd);
                if (!Number.isFinite(tlStart) || !Number.isFinite(tlEnd)) {
                    return json(res, 400, { error: 'show range: tlStart/tlEnd must be finite numbers' });
                }
                directive = { kind: 'range', tlStart: Math.min(tlStart, tlEnd), tlEnd: Math.max(tlStart, tlEnd) };
            }
            else if (b.kind === 'words') {
                let sourceId = b.sourceId;
                if (!sourceId) {
                    const amb = ambiguousSources(m);
                    if (amb)
                        return json(res, 400, { error: 'multiple transcribed sources; specify sourceId', sources: amb });
                    sourceId = m.sources.find((s) => s.transcribed)?.id;
                }
                if (!sourceId || !m.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `unknown source: ${sourceId}` });
                }
                if (!Array.isArray(b.ids) || b.ids.length === 0) {
                    return json(res, 400, { error: 'show words: ids is required (non-empty array)' });
                }
                let ids;
                try {
                    const t = await p.transcript(sourceId);
                    ids = expandWordIds(b.ids, t.words);
                }
                catch (e) {
                    return json(res, 400, { error: `show words: ${e?.message ?? e}` });
                }
                directive = { kind: 'words', sourceId, ids };
            }
            else if (b.kind === 'candidate') {
                if (typeof b.id !== 'string' || !b.id)
                    return json(res, 400, { error: 'show candidate: id is required' });
                const all = await p.candidates();
                if (!all.some((c) => c.id === b.id))
                    return json(res, 400, { error: `unknown candidate: ${b.id}` });
                directive = { kind: 'candidate', id: b.id };
            }
            else if (b.kind === 'compare') {
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
            }
            else if (b.kind === 'source') {
                const sourceId = b.sourceId;
                if (!sourceId || !m.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `unknown source: ${sourceId}` });
                }
                let at;
                if (b.at !== undefined) {
                    at = Number(b.at);
                    if (!Number.isFinite(at))
                        return json(res, 400, { error: 'show source: at must be a finite number' });
                }
                directive = { kind: 'source', sourceId, ...(at !== undefined ? { at } : {}) };
            }
            else if (b.kind === 'takes') {
                // W-INTENT/W11: {sourceId, groupId} only (mirrors 'candidate' —
                // the web client re-derives the full group via GET /api/takes rather
                // than this endpoint embedding utterance data, since that JSON can
                // be sizeable and the client already caches it per source).
                const sourceId = b.sourceId;
                if (!sourceId || !m.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `unknown source: ${sourceId}` });
                }
                if (typeof b.groupId !== 'string' || !b.groupId) {
                    return json(res, 400, { error: 'show takes: groupId is required' });
                }
                let t;
                try {
                    t = await p.transcript(sourceId);
                }
                catch {
                    return json(res, 400, { error: `show takes: source has no transcript: ${sourceId}` });
                }
                if (!takesFor(ctx, p, sourceId, t).some((g) => g.id === b.groupId)) {
                    return json(res, 400, { error: `unknown take group: ${b.groupId}` });
                }
                directive = { kind: 'takes', sourceId, groupId: b.groupId };
            }
            else {
                return json(res, 400, { error: `unknown show kind: ${JSON.stringify(b.kind)} (use range/words/candidate/compare/source/takes)` });
            }
            broadcast(ctx, { type: 'show', projectDir: p.dir, directive });
            return json(res, 200, { ok: true, directive });
        }
        // ---- edits ----
        if (pathname === '/api/edit' && method === 'POST') {
            const b = await readBody(req);
            const actor = revisionActor(b.actor, 'agent');
            if (isAgentActor(actor) && typeof b.baseRev !== 'number') {
                return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
            }
            const m0 = await p.manifest();
            const baseRev = b.baseRev ?? m0.revision;
            if (b.op === 'remove-words') {
                let sourceId = b.sourceId;
                if (!sourceId) {
                    const amb = ambiguousSources(m0);
                    if (amb)
                        return json(res, 400, { error: 'multiple transcribed sources; specify sourceId (--source <id>)', sources: amb });
                    sourceId = m0.sources.find((s) => s.transcribed)?.id;
                }
                const t = await p.transcript(sourceId);
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
                const preview = removeSourceRange(m0, sourceId, r.t0, r.t1);
                const removedSeconds = before - timelineDuration(preview);
                if (removedSeconds < 1 / m0.fps) {
                    // The words themselves are real, but that source range no longer has
                    // any clip on the timeline (e.g. already cut) — refuse rather than
                    // commit a revision that changes nothing.
                    return json(res, 400, { error: 'range does not intersect source media' });
                }
                // F-s1-1: surface any short-fragment absorption (see removeSourceRange)
                // in both the revision summary and this response's own fields.
                const fragmentsAbsorbed = preview.fragmentsAbsorbed;
                await mutate(p, actor, baseRev, 'remove-words', b, `removed ${removed} words (${removedSeconds.toFixed(1)}s): "${text.slice(0, 40)}"${fragmentAbsorptionNote(fragmentsAbsorbed)}`, (m) => removeSourceRange(m, sourceId, r.t0, r.t1));
                return json(res, 200, { removedSeconds, ...(fragmentsAbsorbed ? { fragmentsAbsorbed } : {}), state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'remove-range') {
                let sourceId = b.sourceId;
                if (!sourceId) {
                    const amb = ambiguousSources(m0);
                    if (amb)
                        return json(res, 400, { error: 'multiple transcribed sources; specify sourceId (--source <id>)', sources: amb });
                    sourceId = m0.sources[0]?.id;
                }
                if (Math.abs(b.t1 - b.t0) < 1 / m0.fps) {
                    return json(res, 400, { error: 'nothing to remove (range collapsed to zero frames)' });
                }
                const before = timelineDuration(m0);
                const preview = removeSourceRange(m0, sourceId, b.t0, b.t1);
                const removedSeconds = before - timelineDuration(preview);
                if (removedSeconds < 1 / m0.fps) {
                    return json(res, 400, { error: 'range does not intersect source media' });
                }
                const fragmentsAbsorbed = preview.fragmentsAbsorbed;
                await mutate(p, actor, baseRev, 'remove-range', b, `removed ${removedSeconds.toFixed(1)}s of source ${sourceId}${fragmentAbsorptionNote(fragmentsAbsorbed)}`, (m) => removeSourceRange(m, sourceId, b.t0, b.t1));
                return json(res, 200, { removedSeconds, ...(fragmentsAbsorbed ? { fragmentsAbsorbed } : {}), state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'trim') {
                await mutate(p, actor, baseRev, 'trim', b, `trim ${b.clipId} ${b.edge} ${b.frames}f`, (m) => trimClip(m, b.clipId, b.edge, b.frames));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            // ---- E-1 (波E NLE操作性パック): split/duplicate. Neither splitClip
            // nor duplicateClip (core/ops.ts) accepts a caller-supplied id for the
            // new clip they splice in (freshId('c') is generated inside), so the
            // new clip's id is recovered here by diffing timeline.video before vs.
            // after the commit — same trick as `updated.timeline.music.find(...)`
            // a few branches below for music-add's warning lookup, just against
            // the id set instead of a known id. ----
            if (b.op === 'split') {
                const beforeIds = new Set(m0.timeline.video.map((c) => c.id));
                const updated = await mutate(p, actor, baseRev, 'split', b, `split ${b.clipId} at ${b.at}s`, (m) => splitClip(m, b.clipId, b.at));
                const newClipId = updated.timeline.video.map((c) => c.id).find((id) => !beforeIds.has(id));
                return json(res, 200, { newClipId, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'duplicate') {
                const beforeIds = new Set(m0.timeline.video.map((c) => c.id));
                const updated = await mutate(p, actor, baseRev, 'duplicate', b, `duplicate ${b.clipId}`, (m) => duplicateClip(m, b.clipId));
                const newClipId = updated.timeline.video.map((c) => c.id).find((id) => !beforeIds.has(id));
                return json(res, 200, { newClipId, state: await stateSummary(p, ctx.transcribeJobs) });
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
                // W-CAP: `overrides` is validated + merged specially (see
                // validateCaptionOverridesPatch/mergeCaptionOverrides above) rather
                // than passed through the plain spread below — `null` means "clear
                // every override", an object means "merge these fields onto
                // whatever's already set" (never a wholesale replace, so e.g. the
                // web popover applying just a size change never drops a
                // previously-set color). Absent from the patch entirely -> captions
                // .overrides is left completely untouched, same as any other
                // unmentioned captions field.
                const hasOverridesPatch = b.patch && Object.prototype.hasOwnProperty.call(b.patch, 'overrides');
                if (hasOverridesPatch && b.patch.overrides !== null) {
                    const err = validateCaptionOverridesPatch(b.patch.overrides);
                    if (err)
                        return json(res, 400, { error: err });
                }
                await mutate(p, actor, baseRev, 'captions', b, `captions ${JSON.stringify(b.patch)}`, (m) => {
                    const { overrides: overridesPatch, ...restPatch } = b.patch ?? {};
                    let captions = { ...m.captions, ...restPatch };
                    if (hasOverridesPatch) {
                        if (overridesPatch === null) {
                            const { overrides: _drop, ...rest } = captions;
                            captions = rest;
                        }
                        else {
                            captions = { ...captions, overrides: mergeCaptionOverrides(m.captions.overrides, overridesPatch) };
                        }
                    }
                    return { ...m, captions };
                });
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'caption-text') {
                // W-CAP: text corrections keyed by the cue's leading word id
                // ("sourceId:wordId", see captionCueKey) — b.text === null clears a
                // previously-set correction, '' hides that cue entirely (see
                // captionCues in core/captions.ts), any other string replaces it.
                const key = b.key;
                if (typeof key !== 'string' || !key || !key.includes(':')) {
                    return json(res, 400, { error: 'caption-text: key is required, in "sourceId:wordId" form' });
                }
                const sourceId = key.slice(0, key.indexOf(':'));
                if (!m0.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `caption-text: unknown source in key: ${sourceId}` });
                }
                const text = b.text;
                if (text !== null && typeof text !== 'string') {
                    return json(res, 400, { error: 'caption-text: text must be a string, or null to clear the correction' });
                }
                // Look up the pre-correction cue text for a readable revision
                // summary ("字幕修正 "旧"→"新"") — best-effort: a cue that no longer
                // exists at this key (captions disabled, or that moment got cut)
                // still allows the op (the correction is simply dormant until/unless
                // the cue reappears), just with a less specific summary.
                const cues = captionCues(m0, await allTranscripts(p));
                const cue = cues.find((c) => c.key === key);
                const oldText = (cue ? cue.originalText ?? cue.text : m0.captionTextOverrides?.[key]) ?? '(不明)';
                const summary = text === null
                    ? `字幕修正解除 "${oldText.slice(0, 30)}"`
                    : `字幕修正 "${oldText.slice(0, 30)}"→"${text.slice(0, 30)}"`;
                await mutate(p, actor, baseRev, 'caption-text', b, summary, (m) => {
                    const next = { ...(m.captionTextOverrides ?? {}) };
                    if (text === null)
                        delete next[key];
                    else
                        next[key] = text;
                    return { ...m, captionTextOverrides: next };
                });
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'motion-add') {
                const specId = freshId('mo');
                const specContent = { id: specId, ...b.spec };
                const item = { id: specId, spec: `${specId}.json`, tlStart: b.tlStart, duration: b.duration };
                // The sidecar file itself is written by commit() only after the
                // commit is durable (motionSpecUpdates), so a stale-baseRev 400
                // never leaves an orphan spec file with no timeline reference.
                await mutate(p, actor, baseRev, 'motion-add', b, `motion ${b.spec.type} at ${b.tlStart}s`, (m) => ({ ...m, timeline: { ...m.timeline, motion: [...m.timeline.motion, item] } }), { [specId]: specContent });
                return json(res, 200, { id: specId, state: await stateSummary(p, ctx.transcribeJobs) });
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
                let motionSpecUpdates;
                if (b.spec) {
                    const old = await p.readMotionSpec(b.id);
                    motionSpecUpdates = { [b.id]: { ...old, ...b.spec, id: b.id } };
                }
                await mutate(p, actor, baseRev, 'motion-update', b, `motion ${b.id} updated`, (m) => ({
                    ...m,
                    timeline: {
                        ...m.timeline,
                        motion: m.timeline.motion.map((x) => x.id === b.id
                            ? { ...x, tlStart: b.tlStart ?? x.tlStart, duration: b.duration ?? x.duration }
                            : x),
                    },
                }), motionSpecUpdates);
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'motion-remove') {
                if (!m0.timeline.motion.some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown motion item: ${b.id}` });
                }
                await mutate(p, actor, baseRev, 'motion-remove', b, `motion ${b.id} removed`, (m) => ({
                    ...m,
                    timeline: { ...m.timeline, motion: m.timeline.motion.filter((x) => x.id !== b.id) },
                }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'music-add') {
                if (typeof b.path !== 'string' || !b.path) {
                    return json(res, 400, { error: 'music-add: path is required' });
                }
                const filePath = path.resolve(b.path);
                let info;
                try {
                    info = await probeAudio(filePath);
                }
                catch (e) {
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
                const updated = await mutate(p, actor, baseRev, 'music-add', b, `music-add ${path.basename(filePath)} at ${tlStart}s (+${duration.toFixed(1)}s)`, (m) => addMusic(m, filePath, { id, tlStart, srcIn, duration, gain: b.gain, fadeIn: b.fadeIn, fadeOut: b.fadeOut, duck: b.duck, role: b.role }));
                const addedItem = (updated.timeline.music ?? []).find((x) => x.id === id);
                const warning = duckWarningFor(updated, addedItem);
                return json(res, 200, { id, ...(warning ? { warning } : {}), state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'music-update') {
                if (!(m0.timeline.music ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown music item: ${b.id}` });
                }
                const updated = await mutate(p, actor, baseRev, 'music-update', b, `music-update ${b.id}`, (m) => updateMusic(m, b.id, {
                    tlStart: b.tlStart, duration: b.duration, srcIn: b.srcIn,
                    gain: b.gain, fadeIn: b.fadeIn, fadeOut: b.fadeOut, duck: b.duck,
                }));
                const updatedItem = (updated.timeline.music ?? []).find((x) => x.id === b.id);
                const warning = duckWarningFor(updated, updatedItem);
                return json(res, 200, { ...(warning ? { warning } : {}), state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'music-remove') {
                if (!(m0.timeline.music ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown music item: ${b.id}` });
                }
                await mutate(p, actor, baseRev, 'music-remove', b, `music-remove ${b.id}`, (m) => removeMusic(m, b.id));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'broll-add') {
                if (!b.anchor || typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number') {
                    return json(res, 400, { error: 'broll-add: anchor {sourceId, srcTime} is required' });
                }
                const id = freshId('ov');
                await mutate(p, actor, baseRev, 'broll-add', b, `broll-add ${b.sourceId} [${b.in}-${b.out}] anchor ${b.anchor.sourceId}@${Number(b.anchor.srcTime).toFixed(2)}`, (m) => addOverlay(m, b.sourceId, { srcIn: b.in, srcOut: b.out, anchor: b.anchor, audioMode: b.audioMode, gainDb: b.gainDb, id }));
                return json(res, 200, { id, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'broll-update') {
                if (!(m0.timeline.overlays ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown overlay: ${b.id}` });
                }
                if (b.anchor !== undefined && (typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number')) {
                    return json(res, 400, { error: 'broll-update: anchor must be {sourceId, srcTime}' });
                }
                await mutate(p, actor, baseRev, 'broll-update', b, `broll-update ${b.id}`, (m) => updateOverlay(m, b.id, { srcIn: b.in, srcOut: b.out, anchor: b.anchor, audioMode: b.audioMode, gainDb: b.gainDb }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'broll-remove') {
                if (!(m0.timeline.overlays ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown overlay: ${b.id}` });
                }
                await mutate(p, actor, baseRev, 'broll-remove', b, `broll-remove ${b.id}`, (m) => removeOverlay(m, b.id));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            // ---- オーバーレイ・スタック (docs/superpowers/specs/2026-07-18-vedit-overlay-stack.md):
            // generalizes broll-add/-update/-remove above into N layers + image
            // sources + rect/opacity/fade. broll-* stay untouched (they always
            // produce/target layer-1 overlays — "layer 1 の別名") and keep working
            // exactly as before; these ops just pass layer/rect/opacity/fade
            // through to the same addOverlay/updateOverlay/removeOverlay (ops.ts)
            // those branches already call, so validation (layer range, rect
            // bounds, opacity 0..1, fade shape, same-layer-overlap) is identical. ----
            if (b.op === 'overlay-add') {
                if (!b.anchor || typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number') {
                    return json(res, 400, { error: 'overlay-add: anchor {sourceId, srcTime} is required' });
                }
                const id = freshId('ov');
                await mutate(p, actor, baseRev, 'overlay-add', b, `overlay-add ${b.sourceId} [${b.in}-${b.out}] anchor ${b.anchor.sourceId}@${Number(b.anchor.srcTime).toFixed(2)}${b.layer !== undefined ? ` layer=${b.layer}` : ''}`, (m) => addOverlay(m, b.sourceId, {
                    srcIn: b.in, srcOut: b.out, anchor: b.anchor, audioMode: b.audioMode, gainDb: b.gainDb, id,
                    layer: b.layer, rect: b.rect, opacity: b.opacity, fade: b.fade,
                }));
                return json(res, 200, { id, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'overlay-update') {
                if (!(m0.timeline.overlays ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown overlay: ${b.id}` });
                }
                if (b.anchor !== undefined && (typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number')) {
                    return json(res, 400, { error: 'overlay-update: anchor must be {sourceId, srcTime}' });
                }
                await mutate(p, actor, baseRev, 'overlay-update', b, `overlay-update ${b.id}`, (m) => updateOverlay(m, b.id, {
                    srcIn: b.in, srcOut: b.out, anchor: b.anchor, audioMode: b.audioMode, gainDb: b.gainDb,
                    layer: b.layer, rect: b.rect, opacity: b.opacity, fade: b.fade,
                }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'overlay-remove') {
                if (!(m0.timeline.overlays ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown overlay: ${b.id}` });
                }
                await mutate(p, actor, baseRev, 'overlay-remove', b, `overlay-remove ${b.id}`, (m) => removeOverlay(m, b.id));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'sprite-add') {
                if (!m0.kit)
                    return json(res, 400, { error: 'sprite-add: no kit linked; run `vedit kit-link <dir>` first' });
                if (!b.anchor || typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number') {
                    return json(res, 400, { error: 'sprite-add: anchor {sourceId, srcTime} is required' });
                }
                let kit;
                try {
                    kit = await readKitFile(m0.kit.path);
                }
                catch (e) {
                    return json(res, 400, { error: `sprite-add: could not read kit: ${e?.message ?? e}` });
                }
                if (!(kit.assets ?? []).some((a) => a.id === b.assetId)) {
                    return json(res, 400, { error: `sprite-add: unknown kit asset: ${b.assetId}` });
                }
                const id = freshId('sp');
                await mutate(p, actor, baseRev, 'sprite-add', b, `sprite-add ${b.assetId} anchor ${b.anchor.sourceId}@${Number(b.anchor.srcTime).toFixed(2)}`, (m) => addSprite(m, b.assetId, {
                    anchor: b.anchor, duration: b.duration, position: b.position, scale: b.scale, opacity: b.opacity, flip: b.flip,
                    motion: b.motion, id,
                }));
                return json(res, 200, { id, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'sprite-update') {
                if (!(m0.timeline.sprites ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown sprite: ${b.id}` });
                }
                if (b.anchor !== undefined && (typeof b.anchor.sourceId !== 'string' || typeof b.anchor.srcTime !== 'number')) {
                    return json(res, 400, { error: 'sprite-update: anchor must be {sourceId, srcTime}' });
                }
                await mutate(p, actor, baseRev, 'sprite-update', b, `sprite-update ${b.id}`, (m) => updateSprite(m, b.id, {
                    anchor: b.anchor, duration: b.duration, position: b.position, scale: b.scale, opacity: b.opacity, flip: b.flip,
                    motion: b.motion,
                }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'sprite-remove') {
                if (!(m0.timeline.sprites ?? []).some((x) => x.id === b.id)) {
                    return json(res, 400, { error: `unknown sprite: ${b.id}` });
                }
                await mutate(p, actor, baseRev, 'sprite-remove', b, `sprite-remove ${b.id}`, (m) => removeSprite(m, b.id));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            // ---- W-ANIME: composition (source-less "sprite anime" production mode) ----
            if (b.op === 'compose') {
                const duration = Number(b.duration);
                const width = Number(b.width);
                const height = Number(b.height);
                let background;
                if (b.background !== undefined) {
                    const resolved = await resolveBackgroundArg(String(b.background), typeof b.backgroundPathHint === 'string' ? b.backgroundPathHint : undefined, m0);
                    if ('error' in resolved)
                        return json(res, 400, { error: resolved.error });
                    background = resolved.ref;
                }
                await mutate(p, actor, baseRev, 'compose', b, `compose ${width}x${height} duration=${duration}s`, (m) => setComposition(m, { duration, width, height, background }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'bg-set') {
                const t = Number(b.t);
                if (typeof b.to !== 'string' || !b.to)
                    return json(res, 400, { error: 'bg-set: to is required' });
                const resolved = await resolveBackgroundArg(b.to, typeof b.toPathHint === 'string' ? b.toPathHint : undefined, m0);
                if ('error' in resolved)
                    return json(res, 400, { error: resolved.error });
                await mutate(p, actor, baseRev, 'bg-set', b, `bg-set at ${t}s -> ${b.to}`, (m) => setBackgroundAt(m, t, resolved.ref));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'bg-remove') {
                const t = Number(b.t);
                await mutate(p, actor, baseRev, 'bg-remove', b, `bg-remove at ${t}s`, (m) => removeBackgroundAt(m, t));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'shift') {
                const from = Number(b.from);
                const by = Number(b.by);
                const keepDuration = b.keepDuration === true;
                // shiftComposition throws (non-composition project, out-of-range
                // moves, etc.) — left uncaught here so the generic route() handler
                // converts it to a 400, same as every other op in this dispatch.
                let summary;
                await mutate(p, actor, baseRev, 'shift', b, `shift from=${from}s by=${by}s`, (m) => {
                    const result = shiftComposition(m, from, by, { keepDuration });
                    summary = result.summary;
                    return result.manifest;
                });
                return json(res, 200, { summary: summary, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            // ---- W-ANIME: dialogue (speech bubbles) ----
            if (b.op === 'dialogue-add') {
                if (typeof b.text !== 'string' || !b.text.trim())
                    return json(res, 400, { error: 'dialogue-add: text is required' });
                if (b.spriteId !== undefined && !(m0.timeline.sprites ?? []).some((s) => s.id === b.spriteId)) {
                    return json(res, 400, { error: `dialogue-add: unknown sprite: ${b.spriteId}` });
                }
                const tlStart = Number(b.tlStart);
                const duration = b.duration !== undefined ? Number(b.duration) : undefined;
                // --pos <x,y>: a manual 0..1 normalized bubble position (see
                // DialogueItem.pos / dialogueAnchorPixels in render.ts) — actual
                // range validation happens inside addDialogue below, same division
                // of labor as every other numeric field here.
                const pos = b.pos && typeof b.pos === 'object' ? { x: Number(b.pos.x), y: Number(b.pos.y) } : undefined;
                // Overlap warning (non-fatal — never blocks the add): two
                // auto-anchored bubbles at the same moment are likely to collide.
                // Computed against `m0` (before this add lands) since the new
                // item's own window can't overlap itself.
                const overlapRisk = dialogueOverlapWithoutPosRisk(m0, { tlStart, duration: duration ?? 2.5, pos });
                const warnings = overlapRisk ? ['同時刻のセリフが重なる可能性(--pos で位置を分けられます)'] : [];
                const id = freshId('dl');
                let voicePath;
                let voiceMusicId;
                if (typeof b.voice === 'string' && b.voice) {
                    voicePath = path.resolve(b.voice);
                    let info;
                    try {
                        info = await probeAudio(voicePath);
                    }
                    catch (e) {
                        return json(res, 400, { error: `dialogue-add: could not read --voice ${voicePath}: ${e?.message ?? e}` });
                    }
                    if (!info.hasAudio)
                        return json(res, 400, { error: `dialogue-add: no audio stream in ${voicePath}` });
                    voiceMusicId = freshId('mu');
                }
                await mutate(p, actor, baseRev, 'dialogue-add', b, `dialogue-add "${String(b.text).slice(0, 20)}" at ${tlStart}s${overlapRisk ? ' — 同時刻のセリフが重なる可能性' : ''}`, (m) => {
                    let cur = m;
                    if (voiceMusicId && voicePath) {
                        // Voice audio rides the SAME MusicItem pathway as BGM/SE (spec:
                        // "SE と同じ経路に配置") — foreground dialogue, so duck is off
                        // and gain/fades favor a clean, un-ducked voice line rather
                        // than BGM-style long fades.
                        cur = addMusic(cur, voicePath, {
                            id: voiceMusicId, tlStart, duration: duration ?? 2.5, gain: 0, fadeIn: 0.05, fadeOut: 0.05, duck: false,
                        });
                    }
                    return addDialogue(cur, b.text, { tlStart, duration, spriteId: b.spriteId, voiceMusicId, pos, id });
                });
                return json(res, 200, {
                    id, ...(voiceMusicId ? { voiceMusicId } : {}), ...(warnings.length ? { warnings } : {}),
                    state: await stateSummary(p, ctx.transcribeJobs),
                });
            }
            if (b.op === 'dialogue-update') {
                if (!(m0.timeline.dialogue ?? []).some((d) => d.id === b.id)) {
                    return json(res, 400, { error: `unknown dialogue item: ${b.id}` });
                }
                if (b.spriteId !== undefined && b.spriteId !== null && !(m0.timeline.sprites ?? []).some((s) => s.id === b.spriteId)) {
                    return json(res, 400, { error: `dialogue-update: unknown sprite: ${b.spriteId}` });
                }
                const pos = b.pos === null ? null : b.pos && typeof b.pos === 'object' ? { x: Number(b.pos.x), y: Number(b.pos.y) } : undefined;
                await mutate(p, actor, baseRev, 'dialogue-update', b, `dialogue-update ${b.id}`, (m) => updateDialogue(m, b.id, { text: b.text, tlStart: b.tlStart, duration: b.duration, spriteId: b.spriteId, pos }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'dialogue-remove') {
                const item = (m0.timeline.dialogue ?? []).find((d) => d.id === b.id);
                if (!item)
                    return json(res, 400, { error: `unknown dialogue item: ${b.id}` });
                await mutate(p, actor, baseRev, 'dialogue-remove', b, `dialogue-remove ${b.id}`, (m) => {
                    let cur = removeDialogue(m, b.id);
                    // Cascade: a dialogue line's voice clip has no purpose once the
                    // line itself is gone — remove it too, same "one commit, two
                    // ops.ts calls" pattern the daemon uses elsewhere for
                    // multi-field mutations (see e.g. 'selects').
                    if (item.voiceMusicId && (cur.timeline.music ?? []).some((x) => x.id === item.voiceMusicId)) {
                        cur = removeMusic(cur, item.voiceMusicId);
                    }
                    return cur;
                });
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'audio-mix') {
                await mutate(p, actor, baseRev, 'audio-mix', b, `audio-mix target=${b.targetLufs ?? -14} duck=${b.duckAmount ?? -10} xfade=${b.crossfadeMs ?? 12}`, (m) => setAudioMix(m, { targetLufs: b.targetLufs, duckAmount: b.duckAmount, crossfadeMs: b.crossfadeMs }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'audio-repair') {
                await mutate(p, actor, baseRev, 'audio-repair', b, `audio-repair preset=${b.preset}${b.deess ? ' deess' : ''}`, (m) => setAudioRepair(m, { preset: b.preset, deess: b.deess }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'color-transform') {
                const sourceId = b.sourceId;
                if (!sourceId)
                    return json(res, 400, { error: 'color-transform: sourceId is required' });
                if (!m0.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `unknown source: ${sourceId}` });
                }
                const type = b.type;
                if (!type)
                    return json(res, 400, { error: 'color-transform: type is required (hlg/pq/lut/none)' });
                let lutAbs;
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
                    }
                    catch {
                        return json(res, 400, { error: `color-transform: lut file not found: ${lutAbs}` });
                    }
                }
                let committed = false;
                const taskId = freshId('color');
                broadcast(ctx, { type: 'color-transform-progress', projectDir: p.dir, taskId, sourceId, step: '色変換設定を保存中' });
                try {
                    const updated = await mutate(p, actor, baseRev, 'color-transform', b, `color-transform ${sourceId} -> ${type}${lutAbs ? ` (${path.basename(lutAbs)})` : ''}`, (m) => setColorTransform(m, sourceId, { type, lut: lutAbs }));
                    committed = true;
                    // Proxy regen happens AFTER the commit is durable — same ordering
                    // rationale as the motion sidecar writes in commit() (see its doc
                    // comment): if makeProxy throws here, the manifest already
                    // correctly reflects the new colorTransform even though the proxy
                    // on disk is stale until `vedit color` is retried, rather than a
                    // commit silently failing to apply a setting the user just made.
                    const updatedSrc = updated.sources.find((s) => s.id === sourceId);
                    let proxyRegenerated = false;
                    if (updatedSrc.proxy) {
                        broadcast(ctx, { type: 'color-transform-progress', projectDir: p.dir, taskId, sourceId, step: 'プレビューを更新中' });
                        await makeProxy(updatedSrc.path, path.join(p.dir, updatedSrc.proxy), { duration: updatedSrc.duration, fps: updatedSrc.fps, width: updatedSrc.width, height: updatedSrc.height, hasAudio: updatedSrc.hasAudio }, updatedSrc.colorTransform);
                        proxyRegenerated = true;
                    }
                    broadcast(ctx, { type: 'color-transform-done', projectDir: p.dir, taskId, sourceId, proxyRegenerated });
                    return json(res, 200, { proxyRegenerated, state: await stateSummary(p, ctx.transcribeJobs) });
                }
                catch (e) {
                    broadcast(ctx, {
                        type: 'color-transform-error',
                        projectDir: p.dir,
                        taskId,
                        sourceId,
                        committed,
                        error: e?.message ?? String(e),
                    });
                    throw e;
                }
            }
            if (b.op === 'color-adjust') {
                const sourceId = b.sourceId;
                if (!sourceId)
                    return json(res, 400, { error: 'color-adjust: sourceId is required' });
                if (!m0.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `unknown source: ${sourceId}` });
                }
                await mutate(p, actor, baseRev, 'color-adjust', b, `color-adjust ${sourceId} exposure=${b.exposure ?? '-'} wb=${b.wb ?? '-'} sat=${b.sat ?? '-'}`, (m) => setColorAdjust(m, sourceId, { exposure: b.exposure, wb: b.wb, sat: b.sat }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'clip-add') {
                const clipId = freshId('c');
                await mutate(p, actor, baseRev, 'clip-add', b, `clip-add ${b.sourceId} [${b.in ?? 0}-${b.out ?? '*'}]`, (m) => addClip(m, b.sourceId, { in: b.in, out: b.out, at: b.at, id: clipId }));
                return json(res, 200, { clipId, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'clip-remove') {
                await mutate(p, actor, baseRev, 'clip-remove', b, `clip-remove ${b.clipId}`, (m) => removeClip(m, b.clipId));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'clip-move') {
                await mutate(p, actor, baseRev, 'clip-move', b, `clip-move ${b.clipId} before ${b.before}`, (m) => moveClip(m, b.clipId, b.before));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'reframe') {
                const output = parseReframeSpec(b.spec);
                const focus = parseFocus(b.focus);
                await mutate(p, actor, baseRev, 'reframe', b, `reframe ${output.width}x${output.height} focus=${b.focus ?? 'center'}`, (m) => applyReframe(m, output, focus));
                return json(res, 200, { output, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'clip-crop') {
                await mutate(p, actor, baseRev, 'clip-crop', b, `clip-crop ${b.clipId} x=${b.x ?? '-'} y=${b.y ?? '-'}`, (m) => setClipCrop(m, b.clipId, { x: b.x, y: b.y }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'clip-audio') {
                await mutate(p, actor, baseRev, 'clip-audio', b, `clip-audio ${b.clipId} gainDb=${b.gainDb ?? '-'} muted=${b.muted ?? '-'}`, (m) => setClipAudio(m, b.clipId, { gainDb: b.gainDb, muted: b.muted }));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'scene-review') {
                const sourceId = b.sourceId;
                if (!sourceId)
                    return json(res, 400, { error: 'scene-review: sourceId is required' });
                if (!m0.sources.some((s) => s.id === sourceId)) {
                    return json(res, 400, { error: `unknown source: ${sourceId}` });
                }
                const review = b.review;
                if (review !== 'keep' && review !== 'reject' && review !== 'clear') {
                    return json(res, 400, { error: `scene-review: review must be "keep", "reject", or "clear" (got ${JSON.stringify(review)})` });
                }
                const sceneIds = Array.isArray(b.sceneIds) ? b.sceneIds : b.sceneId ? [b.sceneId] : [];
                if (sceneIds.length === 0) {
                    return json(res, 400, { error: 'scene-review: sceneIds (or sceneId) is required' });
                }
                const sceneFile = await p.scenes(sourceId);
                const known = new Set(sceneFile.scenes.map((s) => s.id));
                const unknown = sceneIds.filter((id) => !known.has(id));
                if (unknown.length)
                    return json(res, 400, { error: `unknown scene id(s): ${unknown.join(', ')} (source ${sourceId})` });
                await mutate(p, actor, baseRev, 'scene-review', b, `scene-review ${sourceId} ${sceneIds.join(',')} -> ${review}`, (m) => {
                    let cur = m;
                    for (const id of sceneIds)
                        cur = setSceneReview(cur, sourceId, id, review);
                    return cur;
                });
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'selects') {
                const sceneFiles = await sceneFilesFor(p, m0);
                const newVideo = buildSelectsTimeline(m0, sceneFiles, { raw: b.raw === true });
                if (newVideo.length === 0) {
                    return json(res, 400, { error: 'selects: no scenes are marked "keep" — nothing to build a timeline from' });
                }
                const previousClips = m0.timeline.video.length;
                await mutate(p, actor, baseRev, 'selects', b, `selects: replaced ${previousClips} clip(s) with ${newVideo.length} keep-scene clip(s)`, (m) => ({ ...m, timeline: { ...m.timeline, video: newVideo } }));
                return json(res, 200, { previousClips, newClips: newVideo.length, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'kit-link') {
                const dir = typeof b.path === 'string' ? path.resolve(b.path) : undefined;
                if (!dir)
                    return json(res, 400, { error: 'kit-link: path is required' });
                let kit;
                try {
                    kit = await readKitFile(dir);
                }
                catch (e) {
                    return json(res, 400, { error: `kit-link: ${e?.message ?? e}` });
                }
                const sections = recognizedKitSections(kit);
                let applied = [];
                await mutate(p, actor, baseRev, 'kit-link', b, `kit-link ${dir}`, (m) => {
                    const linked = { ...m, kit: { path: dir } };
                    const { manifest, applied: a } = applyKitDefaults(linked, kit);
                    applied = a;
                    return manifest;
                });
                return json(res, 200, { path: dir, recognizedSections: sections, appliedDefaults: applied, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'kit-unlink') {
                await mutate(p, actor, baseRev, 'kit-unlink', b, 'kit-unlink', (m) => {
                    const { kit: _kit, ...rest } = m;
                    return rest;
                });
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'intent-add') {
                const sourceId = b.sourceId;
                if (!sourceId)
                    return json(res, 400, { error: 'intent-add: sourceId is required' });
                const t0 = Number(b.t0);
                const t1 = Number(b.t1);
                const id = freshId('iz');
                await mutate(p, actor, baseRev, 'intent-add', b, `intent-add ${sourceId} [${t0}-${t1}] "${b.label ?? ''}" (${b.kind ?? 'quiet'})`, (m) => addIntentZone(m, sourceId, t0, t1, { label: b.label, kind: b.kind, id }));
                return json(res, 200, { id, state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'intent-remove') {
                if (!(m0.intentZones ?? []).some((z) => z.id === b.id)) {
                    return json(res, 400, { error: `unknown intent zone: ${b.id}` });
                }
                await mutate(p, actor, baseRev, 'intent-remove', b, `intent-remove ${b.id}`, (m) => removeIntentZone(m, b.id));
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            if (b.op === 'restore') {
                // `baseRev` here is the same value every other /api/edit op uses
                // (b.baseRev, falling back to the pre-request revision for
                // actor=ui) — the wire contract is unchanged; restore() now just
                // requires it explicitly instead of always racing onto "latest".
                // `b.cause` ('undo' | 'redo' | 'manual' | absent) is forwarded
                // verbatim to Project.restore() — see cli.ts's `undo`/`redo` cases,
                // which POST here with cause:'undo'/'redo' so resolveUndoTarget/
                // resolveRedoTarget (core/project.ts) can tell a logical-undo/-redo
                // restore apart from a manual one on the NEXT undo/redo call.
                // Dropping this (as this branch previously did) breaks repeated
                // undo: without the cause tag every restore replays as "manual",
                // which clears the redo stack and makes the second `vedit undo`
                // bounce back to the state the first undo just left, instead of
                // walking further back.
                const m = await p.restore(b.rev, actor, baseRev, b.cause);
                broadcast(ctx, { type: 'update', projectDir: p.dir, revision: m.revision, op: 'restore', summary: `restored r${b.rev}` });
                return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
            }
            return json(res, 400, { error: `unknown op: ${b.op}` });
        }
        // ---- E-1 (波E NLE操作性パック): logical undo/redo, thin routing over
        // Project.undo()/redo() (already implemented + unit-tested in
        // core/project.ts — resolveUndoTarget/resolveRedoTarget replay the
        // revision log's cause tags so repeated presses walk further back
        // instead of bouncing between two states). `vedit undo`/`vedit redo`
        // (cli.ts) resolve the target client-side and POST /api/edit
        // {op:'restore', cause:...} themselves — these two routes exist for a
        // caller (the web UI's Cmd+Z/Shift+Cmd+Z, per E-4) that wants a single
        // request instead of duplicating that resolution logic. Same
        // actor/baseRev contract as /api/edit: baseRev is required for
        // actor='claude', and defaults to the just-read current revision for
        // 'ui'/'system' callers. ----
        if (pathname === '/api/undo' && method === 'POST') {
            const b = await readBody(req);
            const actor = revisionActor(b.actor, 'agent');
            if (isAgentActor(actor) && typeof b.baseRev !== 'number') {
                return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
            }
            const m0 = await p.manifest();
            const baseRev = typeof b.baseRev === 'number' ? b.baseRev : m0.revision;
            let m;
            try {
                m = await p.undo(actor, baseRev);
            }
            catch (e) {
                if (e?.message === 'nothing to undo')
                    return json(res, 400, { error: '戻す対象がありません' });
                throw e;
            }
            broadcast(ctx, { type: 'update', projectDir: p.dir, revision: m.revision, op: 'restore', summary: `undo -> r${m.revision}` });
            return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
        }
        if (pathname === '/api/redo' && method === 'POST') {
            const b = await readBody(req);
            const actor = revisionActor(b.actor, 'agent');
            if (isAgentActor(actor) && typeof b.baseRev !== 'number') {
                return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
            }
            const m0 = await p.manifest();
            const baseRev = typeof b.baseRev === 'number' ? b.baseRev : m0.revision;
            let m;
            try {
                m = await p.redo(actor, baseRev);
            }
            catch (e) {
                if (e?.message?.startsWith('nothing to redo'))
                    return json(res, 400, { error: 'やり直す対象がありません' });
                throw e;
            }
            broadcast(ctx, { type: 'update', projectDir: p.dir, revision: m.revision, op: 'restore', summary: `redo -> r${m.revision}` });
            return json(res, 200, { state: await stateSummary(p, ctx.transcribeJobs) });
        }
        // ---- detection & candidate queue ----
        if (pathname === '/api/detect' && method === 'POST') {
            const b = await readBody(req);
            return serialProjectJob(ctx.detectTails, p.dir, async () => {
                const m = await p.manifest();
                const out = [];
                const transcripts = await allTranscripts(p);
                const wordsBySource = new Map(transcripts.map((t) => [t.sourceId, t.words]));
                for (const t of transcripts) {
                    if (b.silence !== false)
                        out.push(...detectSilences(t, b.minGap ?? 0.7));
                    if (b.fillers !== false)
                        out.push(...detectFillers(t));
                }
                // Word-gap detection misses silence when whisper packs words with no
                // gap; fall back to the waveform for every source that has peaks, and
                // merge with anything the word-gap pass already found nearby.
                if (b.silence !== false) {
                    for (const src of m.sources) {
                        if (!src.peaks)
                            continue;
                        const words = wordsBySource.get(src.id);
                        // Waveform-only valleys in visual-first/untranscribed footage are
                        // not answerable edit questions. A seven-hour stock pool produced
                        // thousands of these and overwhelmed the human queue despite the
                        // same response recommending scene culling. Only corroborate a
                        // source whose transcript contains actual timed words; otherwise
                        // scenes/culling remains the structural workflow.
                        if (!words?.length)
                            continue;
                        let peaks;
                        try {
                            peaks = JSON.parse(await fs.readFile(path.join(p.dir, src.peaks), 'utf8'));
                        }
                        catch {
                            continue;
                        }
                        const waveCands = detectSilencesFromPeaks(peaks, {
                            sourceId: src.id,
                            // undefined lets the per-source adaptive threshold kick in;
                            // a fixed default here would defeat it on quiet outdoor footage.
                            threshold: b.threshold,
                            minGap: b.minGap ?? 0.7,
                            words,
                        });
                        for (const c of waveCands) {
                            const dup = out.find((o) => o.kind === 'silence' && o.sourceId === c.sourceId && Math.abs(o.t0 - c.t0) <= 0.2 && Math.abs(o.t1 - c.t1) <= 0.2);
                            if (dup) {
                                // Preserve corroboration instead of silently discarding the
                                // waveform detector when it lands on the same transcript gap.
                                // The autonomous policy requires BOTH signals and therefore
                                // depends on this merge being machine-readable, not inferred
                                // later from the English label.
                                dup.evidence = {
                                    transcriptGap: Boolean(dup.evidence?.transcriptGap || c.evidence?.transcriptGap),
                                    waveform: Boolean(dup.evidence?.waveform || c.evidence?.waveform),
                                    transcriptConflict: Boolean(dup.evidence?.transcriptConflict || c.evidence?.transcriptConflict),
                                    edge: dup.evidence?.edge ?? c.evidence?.edge ?? 'interior',
                                };
                            }
                            else
                                out.push(c);
                        }
                    }
                }
                // W-INTENT + candidate identity: filter against the CURRENT manifest
                // and merge against the CURRENT decision queue inside one Project lock.
                // This prevents a detect/decide race from resurrecting a range, and it
                // reuses matching proposed ids so undo -> re-detect -> redo can still
                // replay the logged decision onto the queue.
                const replaced = await p.replaceCandidateProposals(out, (candidate, current) => {
                    return overlappingIntentZones(intentZonesForSource(current, candidate.sourceId), candidate.t0, candidate.t1).length === 0;
                }, (result) => ({
                    relativePath: DETECT_RUN_FILENAME,
                    label: 'candidate detection completion marker',
                    value: {
                        version: 1,
                        completedAt: new Date().toISOString(),
                        // `m` is the snapshot detection actually inspected. If an edit
                        // landed during the scan, the published run is deliberately
                        // stale instead of pretending it covered the newer revision.
                        revision: m.revision,
                        proposalCount: result.proposed.length,
                        excludedByIntentZones: result.excluded,
                        parameters: {
                            silence: b.silence !== false,
                            fillers: b.fillers !== false,
                            minGap: typeof b.minGap === 'number' && Number.isFinite(b.minGap) ? b.minGap : 0.7,
                            ...(typeof b.threshold === 'number' && Number.isFinite(b.threshold) ? { threshold: b.threshold } : {}),
                        },
                    },
                }));
                const fresh = replaced.proposed;
                const excludedByIntentZones = replaced.excluded;
                // F-s1-3: a soft, non-blocking hint — never refuses to detect, just
                // flags when silence-cutting is likely to fragment the timeline into
                // a lot of tiny slivers (the reported real case: a no-speech street
                // walk turned into dozens of 0.1–0.4s clips). Two conservative,
                // cheap-to-check triggers, either one is enough:
                //   (a) no source has a transcript at all — silence detection on
                //       material with no speech to anchor against is exactly the
                //       "scenes/culling fits better" case from verification.
                //   (b) there IS a transcript, but simulating this batch's freshly
                //       proposed candidates against the CURRENT timeline (discarded
                //       afterward — never persisted) trips removeSourceRange's own
                //       F-s1-1 short-fragment absorption (see ops.ts) often enough
                //       that the candidate set itself looks fragmentation-prone.
                const detectWarnings = [];
                if (b.silence !== false) {
                    const FRAGMENTATION_HINT = '発話が少ない素材では無音カットは断片化しやすい — シーン選別(カリング)の方が向いています';
                    const hasVisualFirstSource = m.sources.some((source) => (source.peaks && !(wordsBySource.get(source.id)?.length)));
                    if (hasVisualFirstSource || transcripts.length === 0) {
                        detectWarnings.push(FRAGMENTATION_HINT);
                    }
                    else {
                        let preview = m;
                        let absorbedCount = 0;
                        for (const c of fresh) {
                            preview = removeSourceRange(preview, c.sourceId, c.t0, c.t1);
                            const abs = preview.fragmentsAbsorbed;
                            if (abs)
                                absorbedCount += abs.length;
                        }
                        if (absorbedCount >= 3)
                            detectWarnings.push(FRAGMENTATION_HINT);
                    }
                }
                const detectRunRecord = replaced.completionValue;
                const detectRunWarning = replaced.completionWarning
                    ? `候補の検出は完了しましたが、完了状態を保存できませんでした: ${replaced.completionWarning}`
                    : undefined;
                const currentRevision = (await p.manifest()).revision;
                const detectRun = {
                    ...detectRunRecord,
                    stale: currentRevision !== detectRunRecord.revision,
                    ...(currentRevision !== detectRunRecord.revision ? { staleReason: 'revision-changed' } : {}),
                };
                broadcast(ctx, {
                    type: 'candidates',
                    projectDir: p.dir,
                    pending: fresh.length,
                    detectRun,
                    ...(detectRunWarning ? { warning: detectRunWarning } : {}),
                });
                return json(res, 200, {
                    pending: fresh.filter((c) => c.status === 'proposed'),
                    summary: `${fresh.length} candidates (use approve/reject; approving applies the cut)`,
                    revision: m.revision,
                    detectRun,
                    ...(excludedByIntentZones > 0 ? { excludedByIntentZones } : {}),
                    ...((detectWarnings.length || detectRunWarning) ? {
                        warnings: [...detectWarnings, ...(detectRunWarning ? [detectRunWarning] : [])],
                    } : {}),
                });
            });
        }
        if (pathname === '/api/first-draft' && method === 'POST') {
            const b = await readBody(req);
            const actor = revisionActor(b.actor, 'agent');
            if (!isAgentActor(actor))
                return json(res, 400, { error: 'first-draft actor must be an AI agent' });
            if (typeof b.baseRev !== 'number') {
                return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
            }
            let lockedPlan;
            let approveFragmentsAbsorbed = [];
            const reviewId = freshId('review');
            const evaluatedAt = new Date().toISOString();
            const result = await p.decideCandidates((all, before) => {
                if (before.revision !== b.baseRev) {
                    const err = new Error(`stale base revision ${b.baseRev}; current is ${before.revision}. Re-read state before editing.`);
                    err.code = 'STALE_REVISION';
                    throw err;
                }
                lockedPlan = planAutonomousCandidateBatch(before, all);
                stampAutonomyReview(lockedPlan, b.baseRev, reviewId, evaluatedAt);
                // Preserve the planner's deterministic source/time order. Applying
                // candidates.json order can absorb a short fragment even when the
                // simulated order proved the exact same set safe.
                return lockedPlan.autoApply.map((item) => item.candidate);
            }, 'approve', (target, before) => {
                let preview = before;
                const fragmentsAbsorbed = [];
                for (const c of target) {
                    preview = removeSourceRange(preview, c.sourceId, c.t0, c.t1);
                    const abs = preview.fragmentsAbsorbed;
                    if (abs)
                        fragmentsAbsorbed.push(...abs);
                }
                approveFragmentsAbsorbed = fragmentsAbsorbed;
                const removedSeconds = timelineDuration(before) - timelineDuration(preview);
                const questionCount = lockedPlan?.needsDecision.length ?? 0;
                return {
                    baseRev: b.baseRev,
                    actor,
                    op: 'apply-candidates',
                    params: {
                        ids: target.map((c) => c.id),
                        mode: 'autonomous',
                        rationale: 'transcript+waveform corroborated; intent-safe; no fragment absorption',
                        autoApplied: target.length,
                        questionCount,
                    },
                    summary: `AI first draft: applied ${target.length} clear cuts (-${removedSeconds.toFixed(1)}s); ${questionCount} need a decision`,
                    mutate: (m) => {
                        let cur = m;
                        for (const c of target)
                            cur = removeSourceRange(cur, c.sourceId, c.t0, c.t1);
                        return cur;
                    },
                };
            }, { allowEmpty: true });
            const finalPlan = lockedPlan;
            if (!result.manifest || !result.before) {
                broadcast(ctx, { type: 'candidates', projectDir: p.dir, pending: result.all.filter(isActionableCandidate).length });
                return json(res, 200, {
                    autoApplied: 0,
                    removedSeconds: 0,
                    questionCount: finalPlan.needsDecision.length,
                    needsDecision: finalPlan.needsDecision,
                    evidenceGate: 'transcript+waveform',
                    state: await stateSummary(p, ctx.transcribeJobs),
                });
            }
            const removedSeconds = result.manifest && result.before
                ? timelineDuration(result.before) - timelineDuration(result.manifest)
                : 0;
            broadcast(ctx, {
                type: 'update',
                projectDir: p.dir,
                revision: result.manifest.revision,
                op: 'apply-candidates',
                summary: `AI first draft: applied ${result.target.length} clear cuts (-${removedSeconds.toFixed(1)}s); ${finalPlan.needsDecision.length} need a decision`,
            });
            broadcast(ctx, { type: 'candidates', projectDir: p.dir, pending: result.all.filter(isActionableCandidate).length });
            return json(res, 200, {
                autoApplied: result.target.length,
                removedSeconds,
                questionCount: finalPlan.needsDecision.length,
                needsDecision: finalPlan.needsDecision,
                evidenceGate: 'transcript+waveform',
                ...(approveFragmentsAbsorbed.length ? { fragmentsAbsorbed: approveFragmentsAbsorbed } : {}),
                state: await stateSummary(p, ctx.transcribeJobs),
            });
        }
        if (pathname === '/api/candidates/decide' && method === 'POST') {
            const b = await readBody(req); // { ids: string[] | 'all', decision, actor, baseRev }
            const actor = revisionActor(b.actor, 'ui');
            if (b.decision !== 'approve' && b.decision !== 'reject') {
                return json(res, 400, { error: 'decision must be "approve" or "reject"' });
            }
            if (b.ids !== 'all' && (!Array.isArray(b.ids) || b.ids.some((id) => typeof id !== 'string'))) {
                return json(res, 400, { error: 'ids must be "all" or an array of candidate ids' });
            }
            if (isAgentActor(actor) && typeof b.baseRev !== 'number') {
                return json(res, 400, { error: 'baseRev is required; run `vedit status` and pass --base <revision>' });
            }
            // Candidate selection, the approve-commit, and the candidates.json
            // rewrite all happen inside ONE critical section (Project.decideCandidates)
            // so a concurrent /api/detect or another decide can't interleave a
            // stale read of candidates.json between "decide what to apply" and
            // "write the result".
            // F-s1-1: fragmentsAbsorbed across every candidate's removeSourceRange
            // call in this approve batch — populated inside commitFor's closure
            // below (the only place with access to each intermediate `preview`),
            // then reused after decideCandidates returns for both the broadcast
            // summary and this response's own field.
            let approveFragmentsAbsorbed = [];
            const result = await p.decideCandidates((all) => {
                const selected = b.ids === 'all'
                    ? all.filter(isActionableCandidate)
                    : all.filter((c) => isActionableCandidate(c) && b.ids.includes(c.id));
                // AI stopped on these proposals precisely because they need a
                // human judgment. Neither the `all` sentinel nor a multi-id array
                // may turn that question into an accidental bulk cut; one explicit
                // id is the only approval shape accepted for a question candidate.
                if (b.decision === 'approve'
                    && selected.some(requiresIndividualCandidateDecision)
                    && (b.ids === 'all' || b.ids.length !== 1 || selected.length !== 1)) {
                    throw new Error('AIの確認候補は一件ずつ明示してカットまたは残すを選んでください');
                }
                return selected;
            }, b.decision, (target, before) => {
                if (b.decision === 'reject') {
                    return {
                        baseRev: b.baseRev ?? before.revision,
                        actor,
                        op: 'reject-candidates',
                        params: { ids: target.map((c) => c.id), mode: 'interactive' },
                        summary: `kept ${target.length} candidate range(s)`,
                        mutate: (m) => m,
                    };
                }
                const baseRev = b.baseRev ?? before.revision;
                // Compute the real (frame-snapped) delta against `before` —
                // the manifest as of right now, inside the same critical
                // section as the commit itself — so the summary/response
                // agree with what actually lands on the timeline, and can't
                // be thrown off by a concurrent write between "preview" and
                // "commit" (the bug this whole method exists to close).
                let preview = before;
                const fragmentsAbsorbed = [];
                for (const c of target) {
                    preview = removeSourceRange(preview, c.sourceId, c.t0, c.t1);
                    const abs = preview.fragmentsAbsorbed;
                    if (abs)
                        fragmentsAbsorbed.push(...abs);
                }
                approveFragmentsAbsorbed = fragmentsAbsorbed;
                const removedSeconds = timelineDuration(before) - timelineDuration(preview);
                return {
                    baseRev,
                    actor,
                    op: 'apply-candidates',
                    params: { ids: target.map((c) => c.id) },
                    summary: `applied ${target.length} cuts (-${removedSeconds.toFixed(1)}s)${fragmentAbsorptionNote(fragmentsAbsorbed)}`,
                    mutate: (m) => {
                        let cur = m;
                        for (const c of target)
                            cur = removeSourceRange(cur, c.sourceId, c.t0, c.t1);
                        return cur;
                    },
                };
            });
            if (result.manifest && result.before) {
                const removedSeconds = timelineDuration(result.before) - timelineDuration(result.manifest);
                broadcast(ctx, {
                    type: 'update',
                    projectDir: p.dir,
                    revision: result.manifest.revision,
                    op: b.decision === 'approve' ? 'apply-candidates' : 'reject-candidates',
                    summary: b.decision === 'approve'
                        ? `applied ${result.target.length} cuts (-${removedSeconds.toFixed(1)}s)${fragmentAbsorptionNote(approveFragmentsAbsorbed)}`
                        : `kept ${result.target.length} candidate range(s)`,
                });
            }
            broadcast(ctx, { type: 'candidates', projectDir: p.dir, pending: result.all.filter(isActionableCandidate).length });
            return json(res, 200, {
                decided: result.target.length,
                removedSeconds: result.manifest && result.before ? timelineDuration(result.before) - timelineDuration(result.manifest) : 0,
                ...(approveFragmentsAbsorbed.length ? { fragmentsAbsorbed: approveFragmentsAbsorbed } : {}),
                state: await stateSummary(p, ctx.transcribeJobs),
            });
        }
        // ---- scene index (non-destructive: no baseRev, like candidates.json) ----
        if (pathname === '/api/scenes/detect' && method === 'POST') {
            const b = await readBody(req);
            const m = await p.manifest();
            const targets = b.sourceId ? [b.sourceId] : m.sources.map((s) => s.id);
            const taskId = freshId('scenes');
            const controller = new AbortController();
            const job = {
                taskId,
                projectDir: p.dir,
                project: p,
                kind: 'scenes',
                status: 'running',
                phase: 'starting',
                startedAt: new Date().toISOString(),
                sourceIds: [...targets],
                controller,
                completion: null,
                commitStarted: false,
            };
            ctx.mediaJobs.set(projectTaskKey(p.dir, taskId), job);
            broadcast(ctx, { type: 'scenes-start', projectDir: p.dir, taskId, sources: targets, job: publicMediaJob(job) });
            const operation = (async () => {
                try {
                    const results = [];
                    for (const sourceId of targets) {
                        results.push(await detectScenesForSource(p, m, sourceId, {
                            sensitivity: b.sensitivity,
                            maxLen: b.maxLen,
                            minLen: b.minLen,
                            signal: controller.signal,
                            onProgress: (phase) => {
                                if (!job.commitStarted)
                                    job.phase = `${phase}:${sourceId}`;
                                broadcast(ctx, {
                                    type: 'scenes-progress', projectDir: p.dir, taskId, sourceId,
                                    phase, job: publicMediaJob(job),
                                });
                            },
                            onCommitStart: () => {
                                job.commitStarted = true;
                                job.phase = `committing:${sourceId}`;
                            },
                        }));
                    }
                    job.status = 'success';
                    job.phase = 'finished';
                    job.finishedAt = new Date().toISOString();
                    broadcast(ctx, { type: 'scenes', projectDir: p.dir, sources: targets, taskId, job: publicMediaJob(job) });
                    broadcast(ctx, { type: 'scenes-done', projectDir: p.dir, taskId, sources: targets, job: publicMediaJob(job) });
                    return results;
                }
                catch (e) {
                    const cancelled = controller.signal.aborted || e?.name === 'AbortError';
                    job.status = cancelled ? 'cancelled' : 'error';
                    job.phase = 'finished';
                    job.finishedAt = new Date().toISOString();
                    job.error = cancelled ? undefined : (e?.message ?? String(e));
                    broadcast(ctx, {
                        type: 'scenes-error', projectDir: p.dir, taskId, sources: targets,
                        status: job.status, cancelled, error: job.error ?? 'operation cancelled',
                        job: publicMediaJob(job),
                    });
                    throw e;
                }
            })();
            job.completion = operation.then(() => undefined, () => undefined);
            try {
                const results = await operation;
                return json(res, 200, {
                    taskId,
                    job: publicMediaJob(job),
                    detected: results.map((f) => ({ sourceId: f.sourceId, count: f.scenes.length })),
                });
            }
            catch (e) {
                if (job.status === 'cancelled') {
                    return json(res, 409, {
                        code: 'OPERATION_CANCELLED',
                        error: 'scene detection was cancelled before saving',
                        job: publicMediaJob(job),
                    });
                }
                throw e;
            }
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
            broadcast(ctx, { type: 'scenes', projectDir: p.dir, sources: [b.sourceId] });
            return json(res, 200, { scene });
        }
        return json(res, 404, { error: `no route: ${method} ${pathname}` });
    }
    async function openRegularFile(full) {
        let handle;
        try {
            // Open first, then fstat the descriptor.  There is no pathname
            // stat->open window in which a rename can turn a regular file into an
            // ENOENT or directory stream, and the descriptor pins the selected
            // inode for the whole response.
            handle = await fs.open(full, 'r');
            const stat = await handle.stat();
            if (!stat.isFile()) {
                await handle.close();
                return null;
            }
            return { handle, stat };
        }
        catch {
            await handle?.close().catch(() => { });
            return null;
        }
    }
    /**
     * The one response pipeline for static files and every /media variant.
     * File/HTTP errors are fully consumed here so an EISDIR, disappearing
     * pathname, read error, or client disconnect can never become an
     * unhandled stream 'error' that terminates the daemon.
     */
    async function serveRegularFile(req, res, full, type, notFound, opts = {}) {
        const opened = await openRegularFile(full);
        if (!opened)
            return json(res, 404, { error: notFound });
        const { handle, stat } = opened;
        try {
            let start;
            let end;
            if (opts.range !== false && req.headers.range) {
                const parsed = parseByteRange(req.headers.range, stat.size);
                if (parsed === 'unsatisfiable') {
                    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
                    res.end();
                    return;
                }
                if (parsed)
                    ({ start, end } = parsed);
                // Malformed or multi-range header: ignore and serve the full body.
            }
            const partial = start !== undefined && end !== undefined;
            res.writeHead(partial ? 206 : 200, {
                'content-type': type,
                'content-length': partial ? end - start + 1 : stat.size,
                ...(opts.range !== false ? { 'accept-ranges': 'bytes' } : {}),
                ...(partial ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
                ...(opts.headers ?? {}),
            });
            const stream = handle.createReadStream({
                autoClose: false,
                ...(partial ? { start, end } : {}),
            });
            await pipeline(stream, res);
        }
        catch (error) {
            // pipeline() already destroys both endpoints.  The guard is for rare
            // failures before it can do so; never ask the outer JSON error handler
            // to write a second response after file headers have been committed.
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                json(res, 404, { error: notFound });
            }
            else if (!res.destroyed) {
                res.destroy(error instanceof Error ? error : undefined);
            }
        }
        finally {
            await handle.close().catch(() => { });
        }
    }
    async function serveStatic(pathname, req, res) {
        const file = pathname === '/' ? 'index.html' : pathname.slice(1);
        const full = path.resolve(WEB_DIR, path.normalize(file));
        const relative = path.relative(WEB_DIR, full);
        if (relative.startsWith('..') || path.isAbsolute(relative))
            return json(res, 403, { error: 'forbidden' });
        const types = {
            '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
        };
        return serveRegularFile(req, res, full, types[path.extname(full)] ?? 'application/octet-stream', 'not found', { range: false });
    }
    /** Guess a browser-playable audio MIME type from a music file's extension. */
    function audioMime(file) {
        const types = {
            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
            '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.opus': 'audio/opus',
        };
        return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    }
    /** Guess a browser MIME type for a kit-served font/asset file. */
    function kitMediaMime(file) {
        const types = {
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
    async function serveKitMedia(p, relPath, req, res) {
        const m = await p.manifest();
        if (!m.kit)
            return json(res, 404, { error: 'no kit linked' });
        let full;
        try {
            full = await resolveWithinDir(m.kit.path, decodeURIComponent(relPath));
        }
        catch {
            return json(res, 404, { error: 'invalid kit media path' });
        }
        return serveRegularFile(req, res, full, kitMediaMime(full), 'kit media not found');
    }
    async function serveMedia(p, pathname, req, res) {
        // /media/kit/<relPath>: separate containment root (see serveKitMedia doc).
        if (pathname.startsWith('/media/kit/'))
            return serveKitMedia(p, pathname.slice('/media/kit/'.length), req, res);
        // /media/scene-thumb/<sourceId>/<sceneId>: the web UI's timeline
        // filmstrip (W-UI redesign) — serves the per-scene poster frame that
        // `vedit scenes detect` already wrote to cache/ (see sceneThumbPath in
        // core/scenes.ts, the SAME path helper the write side uses, so this is
        // pure containment + a read, never a new ffmpeg invocation). 404 (not a
        // fresh render) when detection hasn't produced that file yet — the
        // caller (renderTimeline in app.js) just omits the tile.
        if (pathname.startsWith('/media/scene-thumb/')) {
            const [sourceId, sceneId] = pathname.slice('/media/scene-thumb/'.length).split('/');
            if (!sourceId || !sceneId)
                return json(res, 400, { error: 'scene-thumb: sourceId and sceneId are required' });
            const m0 = await p.manifest();
            if (!m0.sources.some((s) => s.id === sourceId))
                return json(res, 404, { error: 'unknown source' });
            let full;
            try {
                full = (await sceneThumbPath(p, sourceId, sceneId)).abs;
            }
            catch {
                return json(res, 404, { error: 'invalid scene-thumb path' });
            }
            return serveRegularFile(req, res, full, 'image/jpeg', 'scene thumbnail not found');
        }
        // /media/proxy/<sourceId> | /media/peaks/<sourceId> | /media/thumb/<sourceId> | /media/music/<musicId>
        const [, , kind, id] = pathname.split('/');
        const m = await p.manifest();
        if (kind === 'music') {
            // Music items reference the original file directly (never a proxy) —
            // same trust model as Source.path in renderFinal: an absolute path the
            // user supplied via the CLI, not sandboxed to the project directory.
            const mu = (m.timeline.music ?? []).find((x) => x.id === id);
            if (!mu)
                return json(res, 404, { error: 'unknown music item' });
            return serveRegularFile(req, res, mu.path, audioMime(mu.path), 'music file not found');
        }
        const sourceId = id;
        const src = m.sources.find((s) => s.id === sourceId);
        if (!src)
            return json(res, 404, { error: 'unknown source' });
        if (kind === 'thumb') {
            // Poster frame for the media pool panel; generated once, then cached.
            const relThumb = `cache/thumb-${src.id}.jpg`;
            const fullThumb = path.join(p.dir, relThumb);
            try {
                await fs.access(fullThumb);
            }
            catch {
                const media = src.proxy ? path.join(p.dir, src.proxy) : src.path;
                // Source.kind==='image' (オーバーレイ・スタック) always carries the
                // 24h IMAGE_SOURCE_DURATION sentinel (see ingestImageFile), not a
                // real duration — `duration * 0.25` would land on 30 (the min()'s
                // other arm) and try to seek 30s into a single still frame, which
                // fails. Seek to 0 for images; the video heuristic is unchanged.
                const at = src.kind === 'image' ? 0 : Math.min(src.duration * 0.25, 30);
                await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', media, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', fullThumb]);
            }
            return serveRegularFile(req, res, fullThumb, 'image/jpeg', 'thumbnail not found', {
                range: false,
                headers: { 'cache-control': 'max-age=3600' },
            });
        }
        const rel = kind === 'proxy' ? src.proxy : src.peaks;
        if (!rel)
            return json(res, 404, { error: `no ${kind} for source` });
        // The manifest is on-disk data, not trusted input: a tampered/corrupted
        // project.json could point proxy/peaks outside the project directory.
        let full;
        try {
            full = await resolveWithinDir(p.dir, rel);
        }
        catch {
            return json(res, 404, { error: `invalid ${kind} path for source` });
        }
        const type = kind === 'proxy' ? 'video/mp4' : 'application/json';
        return serveRegularFile(req, res, full, type, `${kind} file not found`);
    }
    /**
     * Parse a single-range `Range: bytes=...` header per RFC 7233 §2.1:
     * "N-M", "N-" (open-ended), and "-N" (suffix: last N bytes). Returns
     * `null` for anything we don't support (malformed, multiple ranges) so
     * the caller falls back to a normal 200, and `'unsatisfiable'` when the
     * range is well-formed but out of bounds (416).
     */
    function parseByteRange(header, size) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
        if (!m || (m[1] === '' && m[2] === ''))
            return null;
        let start;
        let end;
        if (m[1] === '') {
            const suffixLen = Number(m[2]);
            if (!Number.isFinite(suffixLen) || suffixLen <= 0)
                return 'unsatisfiable';
            start = Math.max(0, size - suffixLen);
            end = size - 1;
        }
        else {
            start = Number(m[1]);
            end = m[2] === '' ? size - 1 : Number(m[2]);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
            return 'unsatisfiable';
        }
        return { start, end: Math.min(end, size - 1) };
    }
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    return { server, port, url: `http://localhost:${port}`, close: closeDaemon };
}
