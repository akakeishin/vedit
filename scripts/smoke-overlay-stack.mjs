#!/usr/bin/env node
// Manual pre-release gate (NOT wired into CI, same class as smoke-export.mjs
// / smoke-compose.mjs) for the オーバーレイ・スタック feature
// (docs/superpowers/specs/2026-07-18-vedit-overlay-stack.md): builds a real
// project with a real A-roll video, a real B-roll video overlay, and two
// real PNG image overlays (one carrying partial alpha baked into the
// source pixels) stacked across THREE layers, renders it with the REAL
// ffmpeg filtergraph (buildFilterGraph -> renderFinal, no mocks), extracts
// a real frame, and samples real decoded pixels to prove:
//   1. z-order: a higher `layer` composites ABOVE a lower one, even where
//      their resolved timeline ranges overlap (which a single-layer B-roll
//      V2 track could never allow at all).
//   2. alpha: a PNG's own partial-transparency pixels genuinely blend with
//      whatever is beneath them (not just drawn opaque, and not dropped).
//   3. `rect` placement: each overlay's box lands at the expected pixel
//      region of the output canvas, not full-bleed.
//
// This exercises addOverlay/buildFilterGraph/overlayVideoClause/
// overlayImageVideoClause/ingestImageFile DIRECTLY (no CLI subprocess, no
// daemon) — deliberate, since `vedit overlay-add`'s daemon-side op dispatch
// is a separate, not-yet-landed piece of wiring (see the implementation
// report); this script proves the underlying src/ logic those CLI commands
// will call into once that wiring exists, using the exact same functions.
//
// Usage: node scripts/smoke-overlay-stack.mjs

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Run TS sources directly (no `tsc -p .` build step needed first) — same
// rationale as smoke-export.mjs: this script should stay runnable
// regardless of whatever else in src/ is mid-edit.
register();

const OUT_W = 640;
const OUT_H = 360;
const DURATION = 5;
const SAMPLE_T = DURATION / 2;

function ff(args, label) {
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`[smoke-overlay-stack] ffmpeg failed (${label}):`);
    console.error(String(e.stderr || e.message).slice(-4000));
    throw new Error(`ffmpeg step failed: ${label}`);
  }
}

function ffprobe(args) {
  return execFileSync('ffprobe', args, { encoding: 'utf8' }).trim();
}

/** Decode a file (video frame or PNG) to raw rgb24 via ffmpeg. */
function decodeRgb24(inputPath) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', inputPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function pixelAt(buf, width, x, y) {
  const idx = (y * width + x) * 3;
  return [buf[idx], buf[idx + 1], buf[idx + 2]];
}

function fmtRgb([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'vedit-smoke-overlay-stack-'));
  const fakeHome = path.join(scratch, 'home');
  await mkdir(fakeHome, { recursive: true });
  // Isolated HOME so Project.create's upsertProject() never touches the
  // real ~/.cache/vedit/projects.json registry (same convention as
  // test/setup.ts / smoke-compose.mjs).
  process.env.HOME = fakeHome;

  const projectDir = path.join(scratch, 'project');
  const arollPath = path.join(scratch, 'aroll.mp4');
  const brollPath = path.join(scratch, 'broll.mp4');
  const image1Path = path.join(scratch, 'image1-red-alpha.png');
  const image2Path = path.join(scratch, 'image2-green-opaque.png');
  const outFile = path.join(scratch, 'out.mp4');
  const framePng = path.join(scratch, 'frame.png');

  try {
    // ---- real media assets ----
    // A-roll: solid BLUE, no audio (kept simple — audio isn't this test's concern).
    ff(['-f', 'lavfi', '-i', `color=c=blue:s=${OUT_W}x${OUT_H}:d=${DURATION}:r=30`, '-pix_fmt', 'yuv420p', arollPath], 'aroll');
    // B-roll: solid WHITE (layer 1's video overlay — the "動画 B-roll 1本" requirement).
    ff(['-f', 'lavfi', '-i', `color=c=white:s=${OUT_W}x${OUT_H}:d=${DURATION}:r=30`, '-pix_fmt', 'yuv420p', brollPath], 'broll');
    // Image 1: solid RED at 65% alpha — an ACTUAL alpha-carrying PNG (not
    // OverlayClip.opacity), so the render must genuinely alpha-blend it
    // against whatever is beneath, not just draw it opaque.
    ff(
      ['-f', 'lavfi', '-i', `color=c=red:s=${OUT_W}x${OUT_H}:d=1`, '-vf', 'format=rgba,colorchannelmixer=aa=0.65', '-frames:v', '1', '-update', '1', image1Path],
      'image1 (red, alpha)',
    );
    // Image 2: solid GREEN, fully opaque — the top layer, should fully occlude everything beneath it.
    ff(
      // ffmpeg's named color "green" is CSS dark-green (0,128,0), not bright
      // green — use an explicit bright-green hex so the z-order pixel check
      // below has a wide, unambiguous margin against the red/white beneath it.
      ['-f', 'lavfi', '-i', `color=c=0x00ff00:s=${OUT_W}x${OUT_H}:d=1`, '-vf', 'format=rgba', '-frames:v', '1', '-update', '1', image2Path],
      'image2 (green, opaque)',
    );

    // ---- src/ modules, imported directly (see this file's header doc) ----
    const { Project } = await import(path.join(ROOT, 'src/core/project.js'));
    const { addOverlay } = await import(path.join(ROOT, 'src/core/ops.js'));
    const { ingestFile, ingestImageFile } = await import(path.join(ROOT, 'src/ingest/ingest.js'));
    const { renderFinal } = await import(path.join(ROOT, 'src/export/render.js'));

    const project = await Project.create(projectDir, 'overlay-stack-smoke');

    console.log('[smoke-overlay-stack] ingesting sources (real ffprobe/proxy)...');
    const { source: arollSource } = await ingestFile(project, arollPath, { scenes: false, addToTimeline: true });
    const { source: brollSource } = await ingestFile(project, brollPath, { scenes: false, addToTimeline: false });
    const { source: image1Source } = await ingestImageFile(project, image1Path);
    const { source: image2Source } = await ingestImageFile(project, image2Path);

    check('A-roll ingested as kind:video (default)', image1Source.kind === 'image' && arollSource.kind === undefined);
    check('image sources probed real pixel dimensions', image1Source.width === OUT_W && image1Source.height === OUT_H, `got ${image1Source.width}x${image1Source.height}`);

    const dur = Math.min(arollSource.duration, brollSource.duration, DURATION + 1);

    console.log('[smoke-overlay-stack] adding overlay stack (3 layers: broll video, red-alpha image, green-opaque image)...');
    let m = await project.manifest();
    // Layer 1 (video B-roll, white): rect x[0, 0.6) of the canvas.
    m = addOverlay(m, brollSource.id, {
      id: 'ov-broll', srcIn: 0, srcOut: dur, anchor: { sourceId: arollSource.id, srcTime: 0 },
      layer: 1, rect: { x: 0, y: 0.1, w: 0.6 },
    });
    // Layer 2 (image, red @ 65% alpha): rect x[0.3, 0.7) — overlaps layer 1 in x[0.3,0.6).
    m = addOverlay(m, image1Source.id, {
      id: 'ov-image1', srcIn: 0, srcOut: dur, anchor: { sourceId: arollSource.id, srcTime: 0 },
      layer: 2, rect: { x: 0.3, y: 0.1, w: 0.4 },
    });
    // Layer 3 (image, green, opaque): rect x[0.5, 0.8) — overlaps BOTH layers 1 and 2 in x[0.5,0.6).
    m = addOverlay(m, image2Source.id, {
      id: 'ov-image2', srcIn: 0, srcOut: dur, anchor: { sourceId: arollSource.id, srcTime: 0 },
      layer: 3, rect: { x: 0.5, y: 0.1, w: 0.3 },
    });
    await project.commit(m.revision, 'system', 'smoke-overlay-stack', {}, 'add 3-layer overlay stack', () => m);

    check('3 overlays recorded on the manifest', m.timeline.overlays.length === 3, `got ${m.timeline.overlays.length}`);

    console.log('[smoke-overlay-stack] rendering (real ffmpeg filtergraph)...');
    m = { ...m, captions: { ...m.captions, enabled: false } };
    const result = await renderFinal(m, [], outFile, {});
    check('render produced no warnings', result.warnings.length === 0, JSON.stringify(result.warnings));

    const outStat = await stat(outFile);
    check('output file is non-empty', outStat.size > 0, `${outStat.size} bytes`);

    const durationStr = ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outFile]);
    check('output duration matches the timeline', Math.abs(Number(durationStr) - dur) < 0.3, `ffprobe reported ${durationStr}s, want ~${dur.toFixed(2)}s`);

    // ---- extract a frame at the midpoint (every overlay is active there) and sample pixels ----
    ff(['-ss', String(SAMPLE_T), '-i', outFile, '-frames:v', '1', framePng], 'frame extraction');
    const buf = decodeRgb24(framePng);

    const Y = Math.round(0.1 * OUT_H) + 50; // inside every rect's vertical span (all start at y=0.1*H)
    const zones = {
      brollOnly: pixelAt(buf, OUT_W, Math.round(OUT_W * 0.1), Y), // x=64  -> [0,0.6) only: white B-roll
      brollPlusImage1: pixelAt(buf, OUT_W, Math.round(OUT_W * 0.45), Y), // x=288 -> broll+image1: red-alpha over white
      allThreeLayers: pixelAt(buf, OUT_W, Math.round(OUT_W * 0.55), Y), // x=352 -> broll+image1+image2: opaque green on top
      background: pixelAt(buf, OUT_W, Math.round(OUT_W * 0.9), Y), // x=576 -> nothing: blue A-roll
    };
    console.log('[smoke-overlay-stack] sampled pixels @', { t: SAMPLE_T, y: Y }, Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, fmtRgb(v)])));

    // Zone 1: B-roll only (opaque white video overlay over the blue A-roll).
    {
      const [r, g, b] = zones.brollOnly;
      check('zone[B-roll only] reads as white (video overlay is opaque, occludes A-roll)', r > 200 && g > 200 && b > 200, fmtRgb(zones.brollOnly));
    }

    // Zone 2: B-roll + image1 — the key ALPHA assertion. If alpha were
    // ignored (image1 drawn fully opaque), green/blue would read near 0. If
    // image1 didn't composite at all, this would read pure white. A genuine
    // 65%-alpha red-over-white blend keeps green/blue meaningfully above 0
    // while red stays dominant.
    {
      const [r, g, b] = zones.brollPlusImage1;
      check('zone[B-roll+image1] is red-dominant (image1/layer2 is visible above the B-roll/layer1)', r > g + 30 && r > b + 30, fmtRgb(zones.brollPlusImage1));
      check('zone[B-roll+image1] is NOT pure opaque red — the white B-roll shows through (real alpha blending, not opaque draw)', g > 30 && b > 30, fmtRgb(zones.brollPlusImage1));
      check('zone[B-roll+image1] is NOT pure white — image1 is actually composited', r - g > 30, fmtRgb(zones.brollPlusImage1));
    }

    // Zone 3: all three layers overlap — the KEY Z-ORDER assertion. An
    // opaque layer-3 (green) must fully occlude both layer 2 (red-alpha)
    // and layer 1 (white) beneath it, proving layers composite in ascending
    // order and a higher layer really does sit on top.
    {
      const [r, g, b] = zones.allThreeLayers;
      check('zone[all 3 layers] reads as green (layer 3/image2 — the topmost — occludes layers 1 and 2)', g > 150 && r < 100 && b < 100, fmtRgb(zones.allThreeLayers));
    }

    // Zone 4: outside every overlay's rect — the base A-roll must still show through.
    {
      const [r, g, b] = zones.background;
      check('zone[background] reads as blue (A-roll, untouched by any overlay)', b > 150 && r < 100 && g < 100, fmtRgb(zones.background));
    }

    if (failures > 0) {
      throw new Error(`${failures} check(s) failed`);
    }
    console.log('[smoke-overlay-stack] PASS — z-order, rect placement, and real PNG alpha blending all verified via a real ffmpeg render.');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[smoke-overlay-stack] FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
});
