#!/usr/bin/env node
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDaemon } from './server/daemon.js';
import { Project } from './core/project.js';
import { buildSelectsTimeline, segments, timelineDuration, timelineTimeToSource } from './core/ops.js';
import { listProjects } from './core/registry.js';
import { loadPreset, listPresets, savePreset } from './core/presets.js';
import { renderView, renderSceneSheet } from './export/view.js';
import { hasReframe, writeOtio } from './export/otio.js';
import { renderFinal, toAss } from './export/render.js';
import { publishPack } from './export/publish.js';
import { writeSrt } from './export/srt.js';
import { downloadWhisperModel, findWhisperModel, sha256File } from './ingest/ingest.js';
import {
  buildPlan,
  copyAndVerify,
  copyPlain,
  createJournal,
  detectDuplicates,
  type DuplicateResult,
  journalPath,
  listVideoFiles,
  readJournal,
  runPool,
  sortByCreationTime,
} from './ingest/batch.js';
import { ffmpegBin, ffmpegHasFilter, run } from './ingest/run.js';
import { buildResume } from './core/resume.js';
import type { Transcript } from './core/types.js';

const PORT = Number(process.env.VEDIT_PORT ?? 7799);
const BASE = `http://localhost:${PORT}`;

// ---- tiny arg parsing ----
// Flags that never consume the following token as a value — without this,
// `--no-transcribe clip.mp4` would eat `clip.mp4` as the flag's value and
// leave the positional argument list empty.
const BOOLEAN_FLAGS = new Set([
  'no-transcribe', 'no-add', 'no-fillers', 'no-silence',
  'latest', 'full', 'all', 'burn-captions', 'no-duck',
  'no-repair', 'fast-loudnorm', 'deess', 'confirm',
  'plan', 'link', 'no-verify',
]);
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    }
  } else pos.push(a);
}

function out(obj: unknown) {
  console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));
}

function fail(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

/** Parse a `--flag` value as a finite number, or fail with a clear message before it ever reaches the API. */
function numFlag(name: string, raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be a finite number (got ${JSON.stringify(raw)})`);
  return n;
}

/** Parse a positional argument as a finite number, or fail with a clear message before it ever reaches the API. */
function numArg(label: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${label} must be a finite number (got ${JSON.stringify(raw)})`);
  return n;
}

const MUTATE_HINT = '確認: vedit view / 取消: vedit undo';

function projectDir(): string {
  const dir = (flags.project as string) ?? process.env.VEDIT_PROJECT ?? process.cwd();
  const abs = path.resolve(dir);
  if (!existsSync(path.join(abs, 'project.json'))) {
    fail(`no project.json in ${abs}. Use --project <dir> or run \`vedit create <dir>\` first.`);
  }
  return abs;
}

// ---- daemon client ----
async function api(pathname: string, init?: RequestInit): Promise<any> {
  const res = await fetch(BASE + pathname, init);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = body?.error ?? text;
    if (res.status === 409) fail(`REJECTED (stale revision): ${msg}`);
    fail(msg);
  }
  return body;
}

/**
 * Like `api()`, but never exits the process on a backend error — resolves
 * to a discriminated result instead. `api()`'s exit-on-error is right for
 * every other command (one shot, fail fast), but `ingest-batch` processes
 * many files in one invocation and is designed to survive a single file's
 * ingest failure (record it in the journal, keep going, let the user retry
 * just that file later) — see the 'ingest-batch' case below.
 */
async function apiTry(pathname: string, init?: RequestInit): Promise<{ ok: true; body: any } | { ok: false; error: string }> {
  try {
    const res = await fetch(BASE + pathname, init);
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) return { ok: false, error: body?.error ?? text };
    return { ok: true, body };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

async function daemonUp(): Promise<boolean> {
  try {
    await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(dir?: string): Promise<void> {
  if (!(await daemonUp())) {
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'serve', ...(dir ? ['--project', dir] : [])], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await daemonUp()) break;
    }
    if (!(await daemonUp())) fail('failed to start vedit daemon');
  }
  if (dir) await api('/api/open', { method: 'POST', body: JSON.stringify({ dir }) });
}

function baseRevOf(state: any): number {
  if (flags.base !== undefined) return numFlag('base', flags.base)!;
  if (flags.latest) return Number(state.revision);
  fail('--base <revision> is required (or --latest to explicitly use the current one); run `vedit status` first');
}

/** Submit an edit against an already-known baseRev, bypassing the --base/--latest requirement (used by `undo`, which always bases itself on the current revision). */
async function editRaw(baseRev: number, body: Record<string, unknown>) {
  const res = await api('/api/edit', {
    method: 'POST',
    body: JSON.stringify({ baseRev, actor: flags.actor ?? 'claude', ...body }),
  });
  out({ ...res, hint: MUTATE_HINT });
}

async function edit(body: Record<string, unknown>) {
  const dir = projectDir();
  await ensureDaemon(dir);
  const state = await api('/api/state');
  await editRaw(baseRevOf(state), body);
}

/**
 * Resolve `--scene <id>` sugar to (sourceId, t0, t1). Scene ids restart per
 * source (like word ids), so when `explicitSource` isn't given this searches
 * every source's scenes file and fails if the id is ambiguous across more
 * than one of them.
 */
async function resolveScene(dir: string, sceneId: string, explicitSource?: string): Promise<{ sourceId: string; t0: number; t1: number }> {
  const p = await Project.open(dir);
  const m = await p.manifest();
  const sourceIds = explicitSource ? [explicitSource] : m.sources.map((s) => s.id);
  const hits: { sourceId: string; t0: number; t1: number }[] = [];
  for (const sourceId of sourceIds) {
    const f = await p.scenes(sourceId);
    const sc = f.scenes.find((s) => s.id === sceneId);
    if (sc) hits.push({ sourceId, t0: sc.t0, t1: sc.t1 });
  }
  if (hits.length === 0) fail(`scene ${sceneId} not found${explicitSource ? ` in source ${explicitSource}` : ''} — run \`vedit scenes detect\` first`);
  if (hits.length > 1) fail(`scene id ${sceneId} is ambiguous across sources (${hits.map((h) => h.sourceId).join(', ')}); specify --source`);
  return hits[0];
}

/**
 * Resolve a B-roll overlay's anchor sugar — at most one of --at-word /
 * --at-src / --at-tl — to {sourceId, srcTime}. Returns undefined when none
 * were given (broll-update: "don't change the anchor"); broll-add's caller
 * additionally requires the result to be present.
 *
 * --at-src's syntax is `--at-src <aRollSrc> <秒>`: the tiny flag parser at
 * the top of this file only ever consumes ONE token as a flag's value, so
 * `<aRollSrc>` lands in flags['at-src'] and the trailing `<秒>` token falls
 * through to the positional list — it's pos[1] here since pos[0] is always
 * the command's own id/sourceId positional for broll-add/broll-update.
 */
async function resolveAnchorFlags(dir: string): Promise<{ sourceId: string; srcTime: number } | undefined> {
  const given = ['at-word', 'at-src', 'at-tl'].filter((k) => flags[k] !== undefined);
  if (given.length === 0) return undefined;
  if (given.length > 1) fail(`specify only one of --at-word / --at-src / --at-tl (got ${given.map((k) => `--${k}`).join(', ')})`);

  if (flags['at-word'] !== undefined) {
    const wordId = String(flags['at-word']);
    const p = await Project.open(dir);
    const m = await p.manifest();
    let sourceId = flags.source as string | undefined;
    if (!sourceId) {
      const hits: string[] = [];
      for (const s of m.sources) {
        if (!s.transcribed) continue;
        try {
          const t = await p.transcript(s.id);
          if (t.words.some((w) => w.id === wordId)) hits.push(s.id);
        } catch { /* transcript file missing; skip */ }
      }
      if (hits.length === 0) fail(`word id ${wordId} not found in any transcribed source; specify --source`);
      if (hits.length > 1) fail(`word id ${wordId} is ambiguous across sources (${hits.join(', ')}); specify --source`);
      sourceId = hits[0];
    }
    const t = await p.transcript(sourceId);
    const w = t.words.find((x) => x.id === wordId);
    if (!w) fail(`unknown word id: ${wordId} (source ${sourceId})`);
    return { sourceId, srcTime: w.t0 };
  }

  if (flags['at-src'] !== undefined) {
    return { sourceId: String(flags['at-src']), srcTime: numArg('--at-src seconds', pos[1]) };
  }

  // --at-tl: reverse-resolve a CURRENT timeline second to (sourceId, srcTime).
  const tl = numFlag('at-tl', flags['at-tl'])!;
  const p = await Project.open(dir);
  const m = await p.manifest();
  const r = timelineTimeToSource(m, tl);
  if (!r) fail(`--at-tl ${tl}: not a valid timeline position (0..${timelineDuration(m).toFixed(2)})`);
  return r;
}

const HELP = `vedit — conversational local NLE

usage: vedit <command> [args] [--project <dir>]

project:   create <dir> [--name n] | status | resume | revisions | undo [--rev N] | open | projects
ingest:    ingest <file...> [--language ja] [--no-transcribe] [--no-add]
           ingest-batch <dir|files...> [--plan] [--copy destDir | --link] [--no-verify]
             [--language ja] [--no-transcribe] [--no-add]   # 撮影カード一括取込、検証付き・再開可能
read:      transcript [--full] [--source id] | candidates [--all] | sources
detect:    detect [--min-gap 0.7] [--threshold 0.06] [--no-fillers] [--no-silence]
cut:       remove-words <w1 w5..w9 ...> [--source id] [--pad 0.08] | remove-range <t0> <t1> [--source id]
           approve <id...|all> | reject <id...> | trim <clipId> <in|out> <±frames>
clips:     clip-add <sourceId> [--in s] [--out s] [--at index] | clip-remove <clipId>
           clip-move <clipId> --before <clipId|end>
scenes:    scenes detect [--source id] [--sensitivity 0.3] [--max-len 12] [--min-len 1.5]
           scenes [--source id]                    # packed scene list (id/range/hasSpeech/energy/[keep|reject]/note)
           scenes sheet [--source id] [--cols n]    # contact sheet PNG (prints path; Read it)
           scenes note <sceneId> "<text>" --by model|user [--source id]
           --scene <sceneId> sugar on clip-add / remove-range / view (resolves to sourceId+t0+t1)
culling:   review <sceneId...> keep|reject|clear [--source id] --base <rev>   # 3状態カリング(未確認/keep/reject)
           review-status                            # keep/reject/未確認の集計 + 次に確認すべきシーン id
           selects --base <rev> [--confirm]         # keep シーンだけの仮タイムラインでタイムラインを置換(--confirm 無しはプレビューのみ)
reframe:   reframe <9:16|1:1|16:9|WxH> [--focus left|center|right|0..1]
           clip-crop <clipId> [--x 0..1] [--y 0..1]
captions:  captions [--enabled true|false] [--style clean|bold] [--max-chars 24]
motion:    motion-add --type chapter-card --text "..." --at 12 --duration 4 [--subtitle ...]
           motion-update <id> [--text ...] [--at ...] [--duration ...] | motion-remove <id>
music:     music-add <file> [--at 0] [--duration N] [--src-in 0] [--gain -12] [--fade-in 1] [--fade-out 2] [--no-duck]
           music-update <id> [同フラグ] | music-remove <id>
           audio-mix [--target-lufs -14] [--duck-amount -10] [--crossfade-ms 12]
           audio-repair --preset outdoor|indoor|wireless|off [--deess]   # 会話音声リペア(既定 off)
broll:     broll-add <brollSourceId> [--in s --out s | --scene sX]
             (--at-word wXXXX [--source aRollSrc] | --at-src aRollSrc t | --at-tl t)
             [--audio mute|mix|replace] [--gain -18] --base <rev>        # B-roll V2 トラック(重複不可・話者音声に張り付く)
           broll-update <id> [同フラグ] --base <rev> | broll-remove <id> --base <rev>
inspect:   view [--from a] [--to b] [--domain timeline|source] [--source id] [--scene id] (prints PNG path)
export:    export otio <out.otio> | export render <out.mp4> [--burn-captions] [--preset youtube|shorts|x]
           export render ... [--no-repair] [--fast-loudnorm]   # 乾音A/B比較 / 1-passループドネスに落とす
           export fcp7xml <out.xml> | export srt <out.srt> | export ass <out.ass>
publish:   publish-pack <outdir> [--thumbs 6]   # chapters.txt + thumbnails/ + materials.json (read-only)
presets:   preset-save <name> [--data '{"k":"v"}'] | preset-apply <name> | preset-list
misc:      doctor [--download-model [name]] | serve [--port]

Mutating commands REQUIRE --base <rev> (or --latest to explicitly use the
current one); if the project changed since that revision the edit is
REJECTED (409) — re-read state first. Exception: \`undo\` never needs --base —
it always bases itself on the current revision, since undoing inherently
means "from here, go back one step".`;

async function main() {
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return out(HELP);

    case 'serve': {
      const dir = (flags.project as string) ? path.resolve(flags.project as string) : undefined;
      const { url } = await startDaemon({ port: numFlag('port', flags.port) ?? PORT, projectDir: dir });
      console.log(`vedit daemon on ${url}${dir ? ` (project: ${dir})` : ''}`);
      return; // keeps running
    }

    case 'create': {
      const dir = path.resolve(pos[0] ?? fail('usage: vedit create <dir>'));
      await Project.create(dir, (flags.name as string) ?? path.basename(dir));
      await ensureDaemon(dir);
      return out({ ok: true, dir, next: `vedit ingest <video> --project ${dir}` });
    }

    case 'open': {
      const dir = projectDir();
      await ensureDaemon(dir);
      return out({ url: BASE, hint: 'open this URL in a browser (or Claude browser pane) for live preview' });
    }

    case 'status': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const state = await api('/api/state');
      return out({ ...state, previewUrl: BASE, hint: 'pass --base ' + state.revision + ' to mutating commands' });
    }

    case 'resume': {
      // Read-only session-resume snapshot — deliberately reads project.json
      // + revisions.jsonl + candidates.json directly (like `sources`), no
      // daemon required, no --base needed.
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const revs = await p.revisions();
      const cands = await p.candidates();
      return out(buildResume(m, dir, revs, cands));
    }

    case 'projects': {
      // Global registry, not tied to any single project — reads the
      // project.json files directly instead of going through the daemon.
      const entries = await listProjects();
      const rows = [];
      for (const e of entries) {
        try {
          const p = await Project.open(e.dir);
          const m = await p.manifest();
          rows.push({ name: m.name, dir: e.dir, lastOpened: e.lastOpened, duration: timelineDuration(m) });
        } catch {
          rows.push({ name: e.name, dir: e.dir, lastOpened: e.lastOpened, duration: null });
        }
      }
      return out(rows);
    }

    case 'ingest': {
      const dir = projectDir();
      await ensureDaemon(dir);
      if (pos.length === 0) fail('usage: vedit ingest <file...>');
      for (const f of pos) {
        console.error(`ingesting ${f} (proxy + waveform + transcription; this can take a while)...`);
        const res = await api('/api/ingest', {
          method: 'POST',
          body: JSON.stringify({
            file: path.resolve(f),
            language: flags.language,
            transcribe: flags['no-transcribe'] ? false : undefined,
            addToTimeline: flags['no-add'] ? false : undefined,
          }),
        });
        out(res);
      }
      return;
    }

    case 'ingest-batch': {
      const USAGE = 'usage: vedit ingest-batch <dir|files...> [--plan] [--copy destDir | --link] [--no-verify] [--language ja] [--no-transcribe] [--no-add]';
      if (pos.length === 0) fail(USAGE);
      if (flags.copy && flags.link) fail('--copy and --link are mutually exclusive');
      const dir = projectDir();

      const files = await listVideoFiles(pos);
      if (files.length === 0) fail('no video files found (recognized extensions: .mp4/.mov/.m4v)');
      console.error(`scanning ${files.length} file(s)...`);
      const plan = await buildPlan(files);
      const sorted = await sortByCreationTime(plan.entries);

      if (flags.plan) {
        return out({
          fileCount: plan.fileCount,
          totalSize: plan.totalSize,
          totalDuration: Number(plan.totalDuration.toFixed(1)),
          files: sorted.map((e) => ({
            file: e.file,
            size: e.size,
            duration: Number(e.duration.toFixed(1)),
            codec: e.codec,
            hasAudio: e.hasAudio,
            warnings: e.warnings.map((w) => w.message),
          })),
          applied: false,
          hint: '読み取り専用プラン(重複検出・取り込みは未実行)。実行するには --plan を外して再実行してください',
        });
      }

      const copyDest = flags.copy ? path.resolve(String(flags.copy)) : undefined;
      const verify = !flags['no-verify'];

      // Existing-source dedup: read the manifest directly (like `vedit
      // sources`) rather than through the daemon — this is a read-only
      // lookup that doesn't need the daemon up yet.
      const p = await Project.open(dir);
      const m0 = await p.manifest();
      const existingBySha = new Map<string, string>();
      for (const s of m0.sources) if (s.sha256) existingBySha.set(s.sha256, s.id);

      // Journal resume: skip files already fully ingested by a prior
      // (possibly interrupted) run of this same command.
      const priorJournal = await readJournal(dir);
      const alreadyIngested = new Set(priorJournal.filter((e) => e.status === 'ingested').map((e) => e.file));
      const journal = createJournal(dir, priorJournal);
      const toProcess = sorted.filter((e) => !alreadyIngested.has(e.file));
      const resumeSkipped = sorted.length - toProcess.length;
      if (resumeSkipped > 0) console.error(`skipping ${resumeSkipped} already-ingested file(s) (journal resume: ${journalPath(dir)})`);

      // Hashing (unless --no-verify): sequential with N/M progress, since a
      // multi-GB file can take real wall-clock time to hash and interleaving
      // hash progress with 2-wide ingest progress would be unreadable.
      const fileHashes = new Map<string, string>();
      if (verify) {
        for (let i = 0; i < toProcess.length; i++) {
          const f = toProcess[i].file;
          console.error(`hashing ${i + 1}/${toProcess.length}: ${path.basename(f)}`);
          const hash = await sha256File(f);
          fileHashes.set(f, hash);
          await journal.record({ file: f, sha256: hash, status: 'planned', at: new Date().toISOString() });
        }
      } else {
        for (const e of toProcess) {
          await journal.record({ file: e.file, status: 'planned', at: new Date().toISOString() });
        }
      }

      // Duplicate detection (batch-internal + against existing sources) —
      // only meaningful when hashes were actually computed.
      let targets = toProcess;
      const skippedDuplicates: DuplicateResult[] = [];
      if (verify) {
        const { unique, duplicates } = detectDuplicates(
          toProcess.map((e) => ({ file: e.file, hash: fileHashes.get(e.file)! })),
          existingBySha,
        );
        skippedDuplicates.push(...duplicates);
        const uniqueFiles = new Set(unique.map((u) => u.file));
        targets = toProcess.filter((e) => uniqueFiles.has(e.file));
        for (const d of duplicates) {
          console.error(`skip duplicate (${d.kind === 'existing' ? 'already in project: ' + d.duplicateOf : 'same as ' + path.basename(d.duplicateOf)}): ${path.basename(d.file)}`);
        }
      }

      if (targets.length === 0) {
        return out({
          ingested: 0,
          failed: [],
          skippedDuplicates: skippedDuplicates.map((d) => ({ file: d.file, kind: d.kind, duplicateOf: d.duplicateOf })),
          skippedAlreadyIngested: resumeSkipped,
          journal: journalPath(dir),
          hint: '取り込み対象なし(全件が重複または取り込み済み)',
        });
      }

      await ensureDaemon(dir);

      const results: { file: string; ok: boolean; error?: string }[] = [];
      // Bounded to 2 concurrent files: proxy generation + transcription are
      // the expensive part of each /api/ingest call (see runPool in
      // batch.ts). Copy-then-verify happens inside the same worker so it's
      // bounded by the same concurrency limit.
      await runPool(targets, 2, async (entry) => {
        const hash = fileHashes.get(entry.file);
        let ingestPath = entry.file;
        if (copyDest) {
          try {
            ingestPath = hash ? await copyAndVerify(entry.file, copyDest, hash) : await copyPlain(entry.file, copyDest);
          } catch (e: any) {
            await journal.record({ file: entry.file, sha256: hash, status: 'failed', error: e?.message ?? String(e), at: new Date().toISOString() });
            // Copy verification failure means the copy (or the read of the
            // original) is corrupt — a data-integrity problem, not a
            // per-file quirk — so abort the whole batch rather than risk
            // silently ingesting bad footage from the rest of the run.
            fail(`copy verification failed for ${entry.file}, aborting batch: ${e?.message ?? e}`);
          }
          await journal.record({ file: entry.file, sha256: hash, status: 'copied', destPath: ingestPath, at: new Date().toISOString() });
        }
        console.error(`ingesting ${path.basename(entry.file)}...`);
        const res = await apiTry('/api/ingest', {
          method: 'POST',
          body: JSON.stringify({
            file: ingestPath,
            sha256: hash,
            language: flags.language,
            transcribe: flags['no-transcribe'] ? false : undefined,
            addToTimeline: flags['no-add'] ? false : undefined,
          }),
        });
        if (res.ok) {
          await journal.record({ file: entry.file, sha256: hash, status: 'ingested', destPath: copyDest ? ingestPath : undefined, at: new Date().toISOString() });
          results.push({ file: entry.file, ok: true });
        } else {
          await journal.record({ file: entry.file, sha256: hash, status: 'failed', error: res.error, at: new Date().toISOString() });
          results.push({ file: entry.file, ok: false, error: res.error });
        }
      });

      return out({
        ingested: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).map((r) => ({ file: r.file, error: r.error })),
        skippedDuplicates: skippedDuplicates.map((d) => ({ file: d.file, kind: d.kind, duplicateOf: d.duplicateOf })),
        skippedAlreadyIngested: resumeSkipped,
        journal: journalPath(dir),
        hint: results.some((r) => !r.ok) ? '失敗したファイルは同じコマンドを再実行すれば再試行される(ジャーナルで完了済みはスキップ)' : undefined,
      });
    }

    case 'transcript': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const q = new URLSearchParams();
      if (flags.full) q.set('full', '1');
      if (flags.source) q.set('source', String(flags.source));
      const res = await fetch(`${BASE}/api/transcript?${q}`);
      if (!res.ok) fail(await res.text());
      return console.log(await res.text());
    }

    case 'detect': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const res = await api('/api/detect', {
        method: 'POST',
        body: JSON.stringify({
          minGap: numFlag('min-gap', flags['min-gap']),
          threshold: numFlag('threshold', flags.threshold),
          fillers: flags['no-fillers'] ? false : undefined,
          silence: flags['no-silence'] ? false : undefined,
        }),
      });
      return out(res);
    }

    case 'candidates': {
      const dir = projectDir();
      await ensureDaemon(dir);
      return out(await api(`/api/candidates${flags.all ? '?all=1' : ''}`));
    }

    case 'sources': {
      // Read-only project inventory; reads project.json directly like
      // `view`/`export` rather than going through the daemon.
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const used = new Map<string, number>();
      for (const s of segments(m)) used.set(s.sourceId, (used.get(s.sourceId) ?? 0) + (s.tlEnd - s.tlStart));
      return out(
        m.sources.map((s) => ({
          id: s.id,
          file: path.basename(s.path),
          duration: s.duration,
          transcribed: !!s.transcribed,
          usedSeconds: used.get(s.id) ?? 0,
        })),
      );
    }

    case 'approve':
    case 'reject': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const state = await api('/api/state');
      const ids = pos[0] === 'all' ? 'all' : pos;
      if (!ids || (Array.isArray(ids) && ids.length === 0)) fail(`usage: vedit ${cmd} <candidateId...|all>`);
      const res = await api('/api/candidates/decide', {
        method: 'POST',
        body: JSON.stringify({ ids, decision: cmd === 'approve' ? 'approve' : 'reject', actor: flags.actor ?? 'claude', baseRev: baseRevOf(state) }),
      });
      return out({ ...res, hint: MUTATE_HINT });
    }

    case 'remove-words':
      if (pos.length === 0) fail('usage: vedit remove-words <w12 w40..w52 ...>');
      return edit({ op: 'remove-words', ids: pos, sourceId: flags.source, pad: numFlag('pad', flags.pad) });

    case 'remove-range': {
      if (flags.scene) {
        if (pos.length > 0) fail('--scene cannot be combined with explicit t0/t1');
        const dir = projectDir();
        const r = await resolveScene(dir, String(flags.scene), flags.source as string | undefined);
        return edit({ op: 'remove-range', t0: r.t0, t1: r.t1, sourceId: r.sourceId });
      }
      if (pos.length < 2) fail('usage: vedit remove-range <t0> <t1> [--scene id]');
      return edit({ op: 'remove-range', t0: numArg('t0', pos[0]), t1: numArg('t1', pos[1]), sourceId: flags.source });
    }

    case 'trim':
      if (pos.length < 3) fail('usage: vedit trim <clipId> <in|out> <±frames>');
      return edit({ op: 'trim', clipId: pos[0], edge: pos[1], frames: numArg('±frames', pos[2]) });

    case 'clip-add': {
      if (pos.length === 0 && !flags.scene) fail('usage: vedit clip-add <sourceId> [--in s] [--out s] [--at index] [--scene id]');
      if (flags.scene && (flags.in !== undefined || flags.out !== undefined)) fail('--scene cannot be combined with --in/--out');
      let sourceId = pos[0];
      let inVal = numFlag('in', flags.in);
      let outVal = numFlag('out', flags.out);
      if (flags.scene) {
        const dir = projectDir();
        const r = await resolveScene(dir, String(flags.scene), sourceId);
        sourceId = r.sourceId;
        inVal = r.t0;
        outVal = r.t1;
      }
      return edit({
        op: 'clip-add',
        sourceId,
        in: inVal,
        out: outVal,
        at: numFlag('at', flags.at),
      });
    }

    case 'clip-remove':
      if (pos.length === 0) fail('usage: vedit clip-remove <clipId>');
      return edit({ op: 'clip-remove', clipId: pos[0] });

    case 'clip-move':
      if (pos.length === 0 || flags.before === undefined) fail('usage: vedit clip-move <clipId> --before <clipId|end>');
      return edit({ op: 'clip-move', clipId: pos[0], before: flags.before });

    case 'scenes': {
      const sub = pos[0];

      if (sub === 'detect') {
        const dir = projectDir();
        await ensureDaemon(dir);
        const res = await api('/api/scenes/detect', {
          method: 'POST',
          body: JSON.stringify({
            sourceId: flags.source,
            sensitivity: numFlag('sensitivity', flags.sensitivity),
            maxLen: numFlag('max-len', flags['max-len']),
            minLen: numFlag('min-len', flags['min-len']),
          }),
        });
        return out(res);
      }

      if (sub === 'sheet') {
        const dir = projectDir();
        const p = await Project.open(dir);
        const m = await p.manifest();
        const sourceId = (flags.source as string) ?? m.sources[0]?.id;
        if (!sourceId) fail('no sources in project');
        const file = await p.scenes(sourceId);
        const v = await renderSceneSheet(file, dir, { cols: numFlag('cols', flags.cols) });
        return out({ ...v, hint: 'Read the png to inspect scene thumbnails; grid maps cells to scene ids' });
      }

      if (sub === 'note') {
        const sceneId = pos[1] ?? fail('usage: vedit scenes note <sceneId> "<text>" --by model|user [--source id]');
        const text = pos[2] ?? fail('usage: vedit scenes note <sceneId> "<text>" --by model|user [--source id]');
        const by = flags.by as string | undefined;
        if (by !== 'user' && by !== 'model') fail('usage: vedit scenes note <sceneId> "<text>" --by model|user');
        const dir = projectDir();
        await ensureDaemon(dir);
        let sourceId = flags.source as string | undefined;
        if (!sourceId) {
          const p = await Project.open(dir);
          const m = await p.manifest();
          for (const s of m.sources) {
            const f = await p.scenes(s.id);
            if (f.scenes.some((sc) => sc.id === sceneId)) {
              sourceId = s.id;
              break;
            }
          }
          if (!sourceId) fail(`scene ${sceneId} not found in any source; specify --source`);
        }
        const res = await api('/api/scenes/note', {
          method: 'POST',
          body: JSON.stringify({ sourceId, id: sceneId, text, by }),
        });
        return out(res);
      }

      // list (packed scene text, like `vedit transcript`)
      const dir = projectDir();
      await ensureDaemon(dir);
      const q = new URLSearchParams();
      if (flags.source) q.set('source', String(flags.source));
      const res = await fetch(`${BASE}/api/scenes?${q}`);
      if (!res.ok) fail(await res.text());
      return console.log(await res.text());
    }

    case 'review': {
      if (pos.length < 2) fail('usage: vedit review <sceneId...> keep|reject|clear [--source id] --base <rev>');
      const verdict = pos[pos.length - 1];
      if (verdict !== 'keep' && verdict !== 'reject' && verdict !== 'clear') {
        fail('usage: vedit review <sceneId...> keep|reject|clear [--source id] --base <rev>');
      }
      const sceneIds = pos.slice(0, -1);
      const dir = projectDir();
      let sourceId = flags.source as string | undefined;
      if (!sourceId) {
        const p = await Project.open(dir);
        const m = await p.manifest();
        for (const s of m.sources) {
          const f = await p.scenes(s.id);
          if (sceneIds.every((id) => f.scenes.some((sc) => sc.id === id))) {
            sourceId = s.id;
            break;
          }
        }
        if (!sourceId) fail(`scene(s) ${sceneIds.join(',')} not found together in any single source; specify --source`);
      }
      return edit({ op: 'scene-review', sourceId, sceneIds, review: verdict });
    }

    case 'review-status': {
      const dir = projectDir();
      await ensureDaemon(dir);
      return out(await api('/api/review-status'));
    }

    case 'selects': {
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const sceneFiles = [];
      for (const s of m.sources) {
        const f = await p.scenes(s.id);
        if (f.scenes.length) sceneFiles.push(f);
      }
      const newVideo = buildSelectsTimeline(m, sceneFiles);
      const preview = {
        currentClips: m.timeline.video.length,
        currentDuration: Number(timelineDuration(m).toFixed(2)),
        newClips: newVideo.length,
        newDuration: Number(newVideo.reduce((sum, c) => sum + (c.srcOut - c.srcIn), 0).toFixed(2)),
      };
      if (!flags.confirm) {
        return out({
          ...preview,
          applied: false,
          hint: 'プレビューのみ(タイムラインは未変更)。適用するには --confirm を付けて再実行してください',
        });
      }
      await ensureDaemon(dir);
      const state = await api('/api/state');
      const res = await api('/api/edit', {
        method: 'POST',
        body: JSON.stringify({ baseRev: baseRevOf(state), actor: flags.actor ?? 'claude', op: 'selects' }),
      });
      return out({ ...res, ...preview, applied: true, hint: MUTATE_HINT });
    }

    case 'reframe':
      if (pos.length === 0) fail('usage: vedit reframe <9:16|1:1|16:9|WxH> [--focus left|center|right|0..1]');
      return edit({ op: 'reframe', spec: pos[0], focus: flags.focus });

    case 'clip-crop':
      if (pos.length === 0) fail('usage: vedit clip-crop <clipId> [--x 0..1] [--y 0..1]');
      return edit({
        op: 'clip-crop',
        clipId: pos[0],
        x: numFlag('x', flags.x),
        y: numFlag('y', flags.y),
      });

    case 'captions': {
      const patch: Record<string, unknown> = {};
      if (flags.enabled !== undefined) patch.enabled = flags.enabled === 'true' || flags.enabled === true;
      if (flags.style) patch.style = flags.style;
      if (flags['max-chars']) patch.maxChars = numFlag('max-chars', flags['max-chars']);
      if (Object.keys(patch).length === 0) {
        const dir = projectDir();
        await ensureDaemon(dir);
        return out(await api('/api/captions'));
      }
      return edit({ op: 'captions', patch });
    }

    case 'motion-add': {
      const type = (flags.type as string) ?? 'chapter-card';
      const params: Record<string, unknown> = {};
      for (const k of ['text', 'subtitle', 'palette', 'position', 'animation']) if (flags[k]) params[k] = flags[k];
      return edit({
        op: 'motion-add',
        spec: { type, params, html: flags.html },
        tlStart: numFlag('at', flags.at) ?? 0,
        duration: numFlag('duration', flags.duration) ?? 4,
      });
    }
    case 'motion-update': {
      const params: Record<string, unknown> = {};
      for (const k of ['text', 'subtitle', 'palette', 'position', 'animation']) if (flags[k]) params[k] = flags[k];
      return edit({
        op: 'motion-update',
        id: pos[0] ?? fail('usage: vedit motion-update <id> [--text ...]'),
        spec: Object.keys(params).length ? { params } : undefined,
        tlStart: numFlag('at', flags.at),
        duration: numFlag('duration', flags.duration),
      });
    }
    case 'motion-remove':
      return edit({ op: 'motion-remove', id: pos[0] ?? fail('usage: vedit motion-remove <id>') });

    case 'music-add': {
      if (pos.length === 0) {
        fail('usage: vedit music-add <file> [--at 0] [--duration N] [--src-in 0] [--gain -12] [--fade-in 1] [--fade-out 2] [--no-duck]');
      }
      return edit({
        op: 'music-add',
        path: path.resolve(pos[0]),
        tlStart: numFlag('at', flags.at),
        duration: numFlag('duration', flags.duration),
        srcIn: numFlag('src-in', flags['src-in']),
        gain: numFlag('gain', flags.gain),
        fadeIn: numFlag('fade-in', flags['fade-in']),
        fadeOut: numFlag('fade-out', flags['fade-out']),
        duck: flags['no-duck'] ? false : undefined,
      });
    }

    case 'music-update': {
      const id = pos[0] ?? fail('usage: vedit music-update <id> [--at ...] [--duration ...] [--src-in ...] [--gain ...] [--fade-in ...] [--fade-out ...] [--no-duck]');
      return edit({
        op: 'music-update',
        id,
        tlStart: numFlag('at', flags.at),
        duration: numFlag('duration', flags.duration),
        srcIn: numFlag('src-in', flags['src-in']),
        gain: numFlag('gain', flags.gain),
        fadeIn: numFlag('fade-in', flags['fade-in']),
        fadeOut: numFlag('fade-out', flags['fade-out']),
        duck: flags['no-duck'] ? false : undefined,
      });
    }

    case 'music-remove':
      return edit({ op: 'music-remove', id: pos[0] ?? fail('usage: vedit music-remove <id>') });

    case 'audio-mix':
      return edit({
        op: 'audio-mix',
        targetLufs: numFlag('target-lufs', flags['target-lufs']),
        duckAmount: numFlag('duck-amount', flags['duck-amount']),
        crossfadeMs: numFlag('crossfade-ms', flags['crossfade-ms']),
      });

    case 'audio-repair': {
      const preset = flags.preset as string | undefined;
      if (!preset || !['outdoor', 'indoor', 'wireless', 'off'].includes(preset)) {
        fail('usage: vedit audio-repair --preset outdoor|indoor|wireless|off [--deess] --base <rev>');
      }
      return edit({ op: 'audio-repair', preset, deess: flags.deess ? true : undefined });
    }

    case 'broll-add': {
      const USAGE =
        'usage: vedit broll-add <brollSourceId> [--in s --out s | --scene sX] ' +
        '(--at-word wXXXX [--source aRollSrc] | --at-src aRollSrc t | --at-tl t) ' +
        '[--audio mute|mix|replace] [--gain -18] --base <rev>';
      if (pos.length === 0) fail(USAGE);
      const brollSourceId = pos[0];
      if (flags.scene && (flags.in !== undefined || flags.out !== undefined)) fail('--scene cannot be combined with --in/--out');
      const dir = projectDir();
      let inVal = numFlag('in', flags.in);
      let outVal = numFlag('out', flags.out);
      if (flags.scene) {
        const r = await resolveScene(dir, String(flags.scene), brollSourceId);
        inVal = r.t0;
        outVal = r.t1;
      }
      if (inVal === undefined || outVal === undefined) fail(`broll-add requires --in/--out or --scene\n${USAGE}`);
      const anchor = await resolveAnchorFlags(dir);
      if (!anchor) fail(`broll-add requires an anchor: --at-word / --at-src / --at-tl\n${USAGE}`);
      return edit({
        op: 'broll-add',
        sourceId: brollSourceId,
        in: inVal,
        out: outVal,
        anchor,
        audioMode: flags.audio,
        gainDb: numFlag('gain', flags.gain),
      });
    }

    case 'broll-update': {
      const id = pos[0] ?? fail('usage: vedit broll-update <id> [--in s --out s | --scene sX] [--at-word .. | --at-src .. | --at-tl ..] [--audio mute|mix|replace] [--gain -18] --base <rev>');
      if (flags.scene && (flags.in !== undefined || flags.out !== undefined)) fail('--scene cannot be combined with --in/--out');
      const dir = projectDir();
      let inVal = numFlag('in', flags.in);
      let outVal = numFlag('out', flags.out);
      if (flags.scene) {
        const p = await Project.open(dir);
        const m = await p.manifest();
        const ov = (m.timeline.overlays ?? []).find((o) => o.id === id);
        if (!ov) fail(`unknown overlay: ${id}`);
        const r = await resolveScene(dir, String(flags.scene), ov.sourceId);
        inVal = r.t0;
        outVal = r.t1;
      }
      const anchor = await resolveAnchorFlags(dir);
      return edit({
        op: 'broll-update',
        id,
        in: inVal,
        out: outVal,
        anchor,
        audioMode: flags.audio,
        gainDb: numFlag('gain', flags.gain),
      });
    }

    case 'broll-remove':
      return edit({ op: 'broll-remove', id: pos[0] ?? fail('usage: vedit broll-remove <id>') });

    case 'preset-save': {
      const name = pos[0] ?? fail('usage: vedit preset-save <name> [--data \'{"k":"v"}\']');
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const extra = flags.data ? JSON.parse(String(flags.data)) : undefined;
      return out({ ok: true, preset: await savePreset(name, m.captions, extra) });
    }

    case 'preset-apply': {
      // Reuses the existing `captions` edit op — presets currently only
      // carry caption settings, so no new daemon op is needed.
      const name = pos[0] ?? fail('usage: vedit preset-apply <name>');
      const preset = await loadPreset(name);
      return edit({ op: 'captions', patch: preset.captions });
    }

    case 'preset-list':
      return out(await listPresets());

    case 'undo': {
      // Unlike other mutating commands, undo doesn't need --base/--latest —
      // it always bases itself on whatever the current revision is, since
      // "undo" inherently means "from here, go back one step".
      const dir = projectDir();
      await ensureDaemon(dir);
      const state = await api('/api/state');
      const revs = await api('/api/revisions');
      const target = flags.rev !== undefined ? numFlag('rev', flags.rev)! : Math.max(1, (revs.at(-1)?.rev ?? 1) - 1);
      return editRaw(Number(state.revision), { op: 'restore', rev: target });
    }

    case 'revisions': {
      const dir = projectDir();
      await ensureDaemon(dir);
      const revs = await api('/api/revisions');
      return out(revs.map((r: any) => `r${r.rev} [${r.actor}] ${r.op}: ${r.summary}`).join('\n'));
    }

    case 'view': {
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      let sourceId = flags.source as string | undefined;
      let from = numFlag('from', flags.from);
      let to = numFlag('to', flags.to);
      let domain = (flags.domain as 'timeline' | 'source') ?? 'timeline';
      if (flags.scene) {
        if (flags.from !== undefined || flags.to !== undefined) fail('--scene cannot be combined with --from/--to');
        const r = await resolveScene(dir, String(flags.scene), sourceId);
        sourceId = r.sourceId;
        from = r.t0;
        to = r.t1;
        domain = 'source'; // scenes are addressed in source time (cut-away material is a valid target)
      }
      const v = await renderView(m, dir, {
        domain,
        sourceId,
        from,
        to,
        cols: numFlag('cols', flags.cols),
        rows: numFlag('rows', flags.rows),
      });
      return out({ ...v, hint: 'Read the png to inspect frames; grid maps cells to source times' });
    }

    case 'export': {
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const kind = pos[0];
      const dest = pos[1] ?? fail('usage: vedit export <otio|render|fcp7xml|srt|ass> <outfile>');
      const transcriptsOf = async (): Promise<Transcript[]> => {
        const t: Transcript[] = [];
        for (const s of m.sources) if (s.transcribed) t.push(await p.transcript(s.id));
        return t;
      };
      if (kind === 'otio') {
        await writeOtio(m, path.resolve(dest));
        // OTIO has no cue-list concept, so captions would silently vanish on
        // import; write a sidecar .srt next to it so Resolve/Premiere still
        // get the subtitles.
        const parsed = path.parse(path.resolve(dest));
        const srtPath = path.join(parsed.dir, parsed.name + '.srt');
        await writeSrt(m, await transcriptsOf(), srtPath);
        if (hasReframe(m)) console.error('Resolve 側でリフレームは再現されません(メタデータとして記録)');
        return out({
          ok: true,
          file: dest,
          srt: srtPath,
          hint: 'DaVinci Resolve: File > Import > Timeline (18.5+, free version OK). 字幕は File > Import > Subtitle で .srt を読み込んでください',
        });
      }
      if (kind === 'render') {
        const presetRaw = flags.preset as string | undefined;
        if (presetRaw !== undefined && !['youtube', 'shorts', 'x'].includes(presetRaw)) {
          fail(`unknown --preset: ${presetRaw} (use youtube, shorts, or x)`);
        }
        console.error('rendering from original sources (this encodes the full timeline)...');
        const res = await renderFinal(m, await transcriptsOf(), path.resolve(dest), {
          burnCaptions: Boolean(flags['burn-captions']),
          preset: presetRaw as 'youtube' | 'shorts' | 'x' | undefined,
          noRepair: Boolean(flags['no-repair']),
          fastLoudnorm: Boolean(flags['fast-loudnorm']),
        });
        return out({ ok: true, file: dest, ...(res.warnings.length ? { warnings: res.warnings } : {}) });
      }
      if (kind === 'fcp7xml') {
        const otioTmp = path.resolve(dest) + '.otio';
        await writeOtio(m, otioTmp);
        try {
          await run('uvx', ['--from', 'opentimelineio', '--with', 'otio-fcp-adapter', 'otioconvert', '-i', otioTmp, '-o', path.resolve(dest)]);
        } catch (e: any) {
          fail(`fcp7xml conversion failed (needs uv + python): ${e.message}\nThe .otio file was written to ${otioTmp}; Resolve can import it directly.`);
        }
        await fs.rm(otioTmp, { force: true });
        if (hasReframe(m)) console.error('Resolve 側でリフレームは再現されません(メタデータとして記録)');
        return out({ ok: true, file: dest, hint: 'Premiere: File > Import (FCP7 XML)' });
      }
      if (kind === 'srt') {
        await writeSrt(m, await transcriptsOf(), path.resolve(dest));
        return out({ ok: true, file: dest });
      }
      if (kind === 'ass') {
        await fs.writeFile(path.resolve(dest), toAss(m, await transcriptsOf()));
        return out({ ok: true, file: dest });
      }
      fail(`unknown export kind: ${kind}`);
      return;
    }

    case 'publish-pack': {
      const outdir = path.resolve(pos[0] ?? fail('usage: vedit publish-pack <outdir> [--thumbs 6]'));
      const dir = projectDir();
      const p = await Project.open(dir);
      const m = await p.manifest();
      const transcripts: Transcript[] = [];
      for (const s of m.sources) if (s.transcribed) transcripts.push(await p.transcript(s.id));
      const thumbs = numFlag('thumbs', flags.thumbs) ?? 6;
      const res = await publishPack(p, m, transcripts, outdir, { thumbs });
      return out({
        ok: true,
        outdir,
        files: res.files,
        ...(res.chaptersReason ? { chaptersSkipped: res.chaptersReason } : {}),
        hint: 'タイトル/説明文は materials.json と transcript を材料に会話で起草する(モデル創作コピーはユーザー承認後のみ書き込む)',
      });
    }

    case 'doctor': {
      const checks: Record<string, string> = {};
      for (const [bin, args] of [
        ['ffmpeg', ['-version']],
        ['ffprobe', ['-version']],
        ['whisper-cli', ['--help']],
      ] as const) {
        try {
          const o = await run(bin, args as unknown as string[]);
          checks[bin] = 'ok ' + (o.split('\n')[0]?.slice(0, 60) ?? '');
        } catch (e: any) {
          checks[bin] = 'MISSING — ' + (bin === 'whisper-cli' ? 'brew install whisper-cpp' : `brew install ${bin === 'ffprobe' ? 'ffmpeg' : bin}`);
        }
      }
      checks['ffmpeg (resolved)'] = `${ffmpegBin()} — drawtext:${ffmpegHasFilter('drawtext') ? 'ok' : 'NO (view timecodes off)'} ass:${ffmpegHasFilter('ass') ? 'ok' : 'NO (caption burn off; brew install ffmpeg-full)'}`;
      let model = await findWhisperModel();
      if (flags['download-model']) {
        const name = typeof flags['download-model'] === 'string' ? (flags['download-model'] as string) : 'ggml-large-v3-turbo';
        console.error(`downloading ${name} ...`);
        model = await downloadWhisperModel(name);
      }
      checks['whisper model'] = model ?? 'MISSING — run `vedit doctor --download-model` (large-v3-turbo, ~1.6GB) or --download-model ggml-small (~470MB)';
      try {
        await run('uvx', ['--version']);
        checks['uv (for fcp7xml export)'] = 'ok';
      } catch {
        checks['uv (for fcp7xml export)'] = 'missing (optional) — brew install uv';
      }
      return out(checks);
    }

    default:
      fail(`unknown command: ${cmd}\n${HELP}`);
  }
}

main().catch((e) => fail(e?.message ?? String(e)));
