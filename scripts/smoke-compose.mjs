#!/usr/bin/env node
// Manual pre-release gate (NOT wired into CI, same class as smoke-export.mjs):
// builds a small W-ANIME "composition" project (background + 2 sprites with
// enter/loop(incl. breathe)/emoteAt motion + 2 dialogue lines + music) end to
// end through the REAL daemon/CLI/ffmpeg path (`node dist/cli.js`, spawned as
// a real subprocess) and renders it with `vedit export render`.
//
// Why this exists: filtergraph integration bugs — a loudnorm measurement
// pass whose output never gets wired into the apply pass, a `breathe`
// scale=eval=frame expression that's built but never consumed by the actual
// scale clause, an overlay label that doesn't line up with what got mapped —
// are invisible to unit tests and to anything that mocks ffmpeg. They only
// show up when ffmpeg actually parses and runs the generated filter_complex
// graph. src/export/render.test.ts asserts on the STRING the graph builder
// produces; this script asserts the string is real, executable ffmpeg that
// produces a real correctly-shaped file.
//
// Usage: node scripts/smoke-compose.mjs   (or: npm run smoke:compose)
//
// Runs entirely inside an isolated temp dir with vedit-specific state paths
// and on a dedicated port, so it's safe to run alongside a
// real `vedit serve` on the default port. Always tears down the daemon it
// starts and removes its scratch dir, even on failure.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Reuse the project's own ffmpeg resolver (dist build, not src — this script
// only runs against the compiled output) so asset generation and
// verification below resolve ffmpeg with the EXACT same
// $VEDIT_FFMPEG > /opt/homebrew/opt/ffmpeg-full > PATH priority the CLI/
// daemon itself uses for the actual render (see src/ingest/run.ts). ffprobe
// has no such special-casing anywhere in this codebase (every call site uses
// the bare "ffprobe" on PATH) — this script matches that as-is.
import { ffmpegBin } from '../dist/ingest/run.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = path.join(ROOT, 'dist', 'cli.js');

const WIDTH = 540;
const HEIGHT = 960;
const DURATION = 6;
const DURATION_TOLERANCE_SEC = 0.2;
const FRAME_T = 1.6; // inside dialogue #1's window, both sprites active
const STDDEV_THRESHOLD = 5; // pixel-value stddev floor for "not a flat/blank frame"

// Dedicated port derived from pid so this never collides with a real `vedit
// serve` (default 7799) or with server/daemon.test.ts's fixed 181xx ports.
const PORT = 19000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;

function ff(args, label) {
  try {
    execFileSync(ffmpegBin(), ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`[smoke-compose] ffmpeg failed (${label}):`);
    console.error(String(e.stderr || e.message).slice(-4000));
    throw new Error(`ffmpeg step failed: ${label}`);
  }
}

function ffprobe(args) {
  return execFileSync('ffprobe', args, { encoding: 'utf8' }).trim();
}

/** Run `node dist/cli.js <args>` as a real subprocess (the daemon-backed path — see this file's header doc) and return stdout. Prints ffmpeg/CLI stderr tail and throws on failure. */
function vedit(args, env) {
  try {
    return execFileSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const stderrTail = String(e.stderr || '').slice(-4000);
    const stdoutTail = String(e.stdout || '').slice(-2000);
    console.error(`[smoke-compose] \`vedit ${args.join(' ')}\` failed (exit ${e.status ?? '?'}):`);
    if (stderrTail) console.error(stderrTail);
    if (stdoutTail) console.error(`stdout: ${stdoutTail}`);
    throw new Error(`vedit ${args[0]} failed`);
  }
}

function veditJson(args, env) {
  const stdout = vedit(args, env);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`vedit ${args.join(' ')}: could not parse JSON stdout:\n${stdout}`);
  }
}

async function waitForDaemon(hasExited, getStderr) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error(`daemon process exited before becoming ready (port ${PORT}):\n${getStderr().slice(-4000)}`);
    }
    try {
      const res = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`daemon did not become ready within 15s (port ${PORT})`);
}

async function stopDaemon(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * A small transparent-margin colored-box PNG (no ImageMagick — pure ffmpeg
 * lavfi color source + drawbox=t=fill) to stand in for a kit character
 * sprite. `vedit kit-scan` computes visible_bounds_normalized/
 * ground_anchor_normalized/width/height from this the same way it would for
 * a hand-drawn asset — the alpha margin around the box gives it a
 * non-degenerate (not full-frame) bounding box, closer to a real sprite than
 * a fully-opaque rectangle would be.
 */
function makeSpritePng(outPath, colorHex) {
  const w = 240;
  const h = 320;
  const bx = Math.round(w * 0.2);
  const by = Math.round(h * 0.15);
  const bw = Math.round(w * 0.6);
  const bh = Math.round(h * 0.8);
  ff(
    [
      '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h}:d=1`,
      '-vf', `format=rgba,drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${colorHex}@1.0:t=fill`,
      '-frames:v', '1',
      outPath,
    ],
    `sprite png ${path.basename(outPath)}`,
  );
}

function makeSineWav(outPath, durationSec) {
  ff(
    ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}:sample_rate=44100`, '-ac', '2', outPath],
    'music wav',
  );
}

/** Decode a PNG to raw rgb24 via ffmpeg and compute the population stddev of every byte — a cheap, dependency-free stand-in for ffmpeg's signalstats: a solid/blank frame has stddev ~0, a frame with a background + sprites + a dialogue bubble does not. */
function frameStddev(pngPath) {
  const buf = execFileSync(ffmpegBin(), ['-v', 'error', '-i', pngPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  const n = buf.length;
  if (n === 0) throw new Error(`frameStddev: decoded 0 bytes from ${pngPath}`);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i];
  const mean = sum / n;
  let sqDiff = 0;
  for (let i = 0; i < n; i++) {
    const d = buf[i] - mean;
    sqDiff += d * d;
  }
  return Math.sqrt(sqDiff / n);
}

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'vedit-smoke-compose-'));
  const stateDir = path.join(scratch, 'state');
  const projectDir = path.join(scratch, 'project');
  const kitDir = path.join(scratch, 'kit');
  const outFile = path.join(scratch, 'out.mp4');
  const framePng = path.join(scratch, 'frame.png');
  await mkdir(stateDir, { recursive: true });

  // Every child (the `serve` daemon and each one-shot CLI) inherits only
  // app-specific scratch state plus a dedicated port. HOME remains the real
  // process value, so unrelated tools and font discovery behave normally.
  const env = {
    ...process.env,
    VEDIT_REGISTRY_PATH: path.join(stateDir, 'registry', 'projects.json'),
    VEDIT_PRESETS_PATH: path.join(stateDir, 'presets', 'presets.json'),
    VEDIT_MODEL_DIR: path.join(stateDir, 'models'),
    VEDIT_PORT: String(PORT),
  };
  delete env.VEDIT_PROJECT;

  let daemon = null;
  try {
    // ---- kit: scaffold + generate 3 sprite PNGs + scan (real kit-scan, not
    // a hand-authored kit.json — this exercises the same alpha-geometry code
    // path a real kit would go through) ----
    vedit(['kit-init', kitDir], env);
    const charactersDir = path.join(kitDir, 'assets', 'characters');
    await mkdir(charactersDir, { recursive: true });
    makeSpritePng(path.join(charactersDir, 'chibi-a.png'), '0x3b82f6');
    makeSpritePng(path.join(charactersDir, 'chibi-a-emote.png'), '0xf59e0b');
    makeSpritePng(path.join(charactersDir, 'chibi-b.png'), '0x22c55e');
    vedit(['kit-scan', kitDir], env);

    const musicWav = path.join(scratch, 'music.wav');
    makeSineWav(musicWav, DURATION);

    // ---- daemon: started explicitly by this script (not via ensureDaemon's
    // own self-spawn-and-detach) so we hold the child handle and can always
    // kill it in `finally` below ----
    daemon = spawn(process.execPath, [CLI_ENTRY, 'serve', '--project', projectDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let daemonErr = '';
    daemon.stdout.on('data', () => {});
    daemon.stderr.on('data', (d) => { daemonErr += d; });
    let daemonExited = false;
    daemon.once('exit', () => { daemonExited = true; });
    await waitForDaemon(() => daemonExited, () => daemonErr);

    // ---- composition: 6s, 540x960, single-color hex background ----
    vedit(
      ['compose', projectDir, '--duration', String(DURATION), '--size', `${WIDTH}x${HEIGHT}`, '--background', '#12141c', '--kit', kitDir],
      env,
    );
    vedit(['bg-set', '--at', '2', '--to', '#2b3a55', '--project', projectDir, '--latest'], env);
    vedit(['bg-set', '--at', '4', '--to', '#55362b', '--project', projectDir, '--latest'], env);

    // ---- sprites: enter/loop(breathe)/emoteAt on sprite A, a second
    // enter/loop variant on sprite B — "最低1つずつ" satisfied across the two ----
    const spA = veditJson(
      [
        'sprite-add', 'chibi-a',
        '--at', '0.3', '--pos', '0.32,0.82', '--scale', '0.4', '--duration', '5.4',
        '--enter', 'pop', '--loop', 'breathe', '--emote-at', '3:chibi-a-emote',
        '--project', projectDir, '--latest',
      ],
      env,
    ).id;
    const spB = veditJson(
      [
        'sprite-add', 'chibi-b',
        '--at', '1', '--pos', '0.68,0.85', '--scale', '0.32', '--duration', '4.3',
        '--enter', 'slide-left', '--loop', 'sway',
        '--project', projectDir, '--latest',
      ],
      env,
    ).id;

    // ---- dialogue: 2 lines, one per sprite ----
    vedit(
      ['dialogue-add', 'こんにちは、これはコンポジションのスモークテストです', '--at', '1.2', '--duration', '1.8', '--sprite', spA, '--project', projectDir, '--latest'],
      env,
    );
    vedit(
      ['dialogue-add', '音声なしでも表示は動きます', '--at', '3.6', '--duration', '1.3', '--sprite', spB, '--project', projectDir, '--latest'],
      env,
    );

    // ---- motion: chapter-card, added for op-path coverage only. Its
    // window (0.1-1.1s) never overlaps FRAME_T below, so this script never
    // asserts on whether it actually got burned into the render — src/ is
    // off limits for this change, so that wiring (or lack of it) isn't this
    // script's to fix either way.
    // NOTE (investigation-time finding, may already be stale by the time
    // you read this — see final report): at the start of writing this
    // script, src/cli.ts's 'export' case (kind==='render', m.composition
    // branch) called `renderComposition(m, dest, { preset })` WITHOUT
    // `motionSpecs`, even though render.ts's own `loadMotionSpecs(p, m)`
    // helper exists specifically to feed it — so a motion-add item on a
    // composition project was silently never burned into `vedit export
    // render`'s output. A concurrent edit to src/cli.ts (unrelated to this
    // script) landed mid-session and appears to wire this up; not
    // re-verified here since asserting on it would make this smoke test
    // depend on someone else's in-flight, uncommitted change. ----
    vedit(
      ['motion-add', '--type', 'chapter-card', '--text', 'Chapter 1', '--at', '0.1', '--duration', '1', '--project', projectDir, '--latest'],
      env,
    );

    // ---- music: 6s non-silent sine wav, fills the whole timeline ----
    vedit(['music-add', musicWav, '--at', '0', '--project', projectDir, '--latest'], env);

    // ---- render (plain `export render`, no --preset — the presets are
    // 16:9/9:16 platform shapes, not this project's own 540x960 canvas) ----
    vedit(['export', 'render', outFile, '--project', projectDir], env);

    // ---- verify: file ----
    const outStat = await stat(outFile);
    if (outStat.size <= 0) throw new Error(`output file is empty: ${outFile}`);

    // ---- verify: duration ----
    const durationStr = ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outFile]);
    const duration = Number(durationStr);
    if (!Number.isFinite(duration) || Math.abs(duration - DURATION) > DURATION_TOLERANCE_SEC) {
      throw new Error(`unexpected duration: ffprobe reported "${durationStr}"s, want ${DURATION}s (+/-${DURATION_TOLERANCE_SEC}s)`);
    }

    // ---- verify: video + audio streams both present ----
    const streamTypes = ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', outFile])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (!streamTypes.includes('video')) throw new Error(`no video stream in ${outFile} (streams: ${streamTypes.join(',')})`);
    if (!streamTypes.includes('audio')) throw new Error(`no audio stream in ${outFile} (streams: ${streamTypes.join(',')})`);

    // ---- verify: a frame during dialogue #1 actually has something drawn
    // on it (background + 2 sprites + a speech bubble, not a flat/black
    // frame from a broken overlay/map) ----
    ff(['-ss', String(FRAME_T), '-i', outFile, '-frames:v', '1', framePng], 'frame extraction');
    const frameStat = await stat(framePng);
    if (frameStat.size <= 0) throw new Error(`frame extraction produced an empty file: ${framePng}`);
    const stddev = frameStddev(framePng);
    if (stddev < STDDEV_THRESHOLD) {
      throw new Error(`extracted frame @${FRAME_T}s looks flat/blank (pixel stddev ${stddev.toFixed(2)} < ${STDDEV_THRESHOLD}) — composition may not be rendering sprites/dialogue`);
    }

    console.log('[smoke-compose] PASS');
    console.log(`  duration: ${duration.toFixed(3)}s (want ${DURATION}s +/-${DURATION_TOLERANCE_SEC}s)`);
    console.log(`  streams: ${streamTypes.join(', ')}`);
    console.log(`  output: ${outStat.size} bytes`);
    console.log(`  frame @${FRAME_T}s pixel stddev: ${stddev.toFixed(2)} (floor ${STDDEV_THRESHOLD})`);
  } finally {
    await stopDaemon(daemon);
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[smoke-compose] FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
});
