#!/usr/bin/env node
// Manual pre-release gate (NOT wired into CI): builds the project, writes
// each golden export fixture's .otio to a temp dir, then round-trips it
// through the REAL opentimelineio Python library (via `uvx`) to cross-check
// duration and clip count against what vedit's own segment math expects.
//
// This exists because src/export/golden.test.ts only checks the JSON shape
// vedit itself produces — it can't catch "this JSON isn't actually valid/
// readable OTIO" the way a foreign implementation reading it back can.
//
// Usage: node scripts/smoke-export.mjs   (or: npm run smoke:export)

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DURATION_TOLERANCE_SEC = 0.1; // covers independent per-clip frame rounding across mixed fps

// Run TS sources directly (no `tsc -p .` full-project build): this only
// needs src/export/otio.ts + src/core/ops.ts, and a full build would fail
// (or go stale) whenever unrelated files elsewhere in src/ are mid-edit —
// this is meant to stay runnable as a standalone gate regardless.
register();

function hasUvx() {
  try {
    execFileSync('uvx', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---- fixtures (independent, minimal versions of the golden.test.ts
// categories — this script only needs enough shape to exercise a real
// OTIO reader, not to re-prove vedit's own invariants) ------------------

const NTSC24 = 24000 / 1001; // 23.976
const NTSC30 = 30000 / 1001; // 29.97
const FILM30 = 30;

function baseManifest(fps, sources, clips, extra = {}) {
  return {
    version: 1,
    name: 'smoke',
    revision: 1,
    fps,
    width: 1920,
    height: 1080,
    sources,
    timeline: { video: clips, motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 20 },
    ...extra,
  };
}

const FIXTURES = [
  {
    name: '23976-single',
    manifest: baseManifest(
      NTSC24,
      [{ id: 's1', path: '/media/smoke-24p.mov', duration: 30, fps: NTSC24, width: 1920, height: 1080, hasAudio: true }],
      [
        { id: 'c0', sourceId: 's1', srcIn: 0.5, srcOut: 4.2 },
        { id: 'c1', sourceId: 's1', srcIn: 6.0, srcOut: 10.75 },
      ],
    ),
  },
  {
    name: '2997-single',
    manifest: baseManifest(
      NTSC30,
      [{ id: 's1', path: '/media/smoke-2997.mp4', duration: 40, fps: NTSC30, width: 1920, height: 1080, hasAudio: true }],
      [
        { id: 'c0', sourceId: 's1', srcIn: 1.2, srcOut: 5.6 },
        { id: 'c1', sourceId: 's1', srcIn: 8.0, srcOut: 9.75 },
      ],
    ),
  },
  {
    name: '30-single',
    manifest: baseManifest(
      FILM30,
      [{ id: 's1', path: '/media/smoke-30p.mp4', duration: 20, fps: FILM30, width: 1920, height: 1080, hasAudio: true }],
      [
        { id: 'c0', sourceId: 's1', srcIn: 0, srcOut: 6 },
        { id: 'c1', sourceId: 's1', srcIn: 10, srcOut: 14.5 },
      ],
    ),
  },
  {
    name: 'mixed-fps-audioless',
    manifest: baseManifest(
      NTSC30,
      [
        { id: 's1', path: '/media/smoke-a-cam.mov', duration: 30, fps: NTSC24, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/media/smoke-b-cam.mov', duration: 20, fps: NTSC30, width: 1920, height: 1080, hasAudio: false },
      ],
      [
        { id: 'c0', sourceId: 's1', srcIn: 0, srcOut: 3 },
        { id: 'c1', sourceId: 's2', srcIn: 0, srcOut: 2.5 },
        { id: 'c2', sourceId: 's1', srcIn: 5, srcOut: 9 },
        { id: 'c3', sourceId: 's2', srcIn: 5, srcOut: 6.2 },
      ],
    ),
  },
  {
    name: 'reframe',
    manifest: baseManifest(
      NTSC30,
      [{ id: 's1', path: '/media/smoke-wide.mp4', duration: 30, fps: NTSC30, width: 1920, height: 1080, hasAudio: true }],
      [
        { id: 'c0', sourceId: 's1', srcIn: 1, srcOut: 5, crop: { x: 0.2 } },
        { id: 'c1', sourceId: 's1', srcIn: 8, srcOut: 12.5, crop: { y: 0.8 } },
      ],
      { output: { width: 1080, height: 1920 } },
    ),
  },
];

function expectedMetrics(manifest, segmentsFn) {
  const segs = segmentsFn(manifest);
  const srcById = new Map(manifest.sources.map((s) => [s.id, s]));
  const durationSec = segs.reduce((a, s) => a + (s.tlEnd - s.tlStart), 0);
  const gapCount = segs.filter((s) => !srcById.get(s.sourceId).hasAudio).length;
  return { clipCount: segs.length, durationSec, gapCount };
}

// ---- python side: read each .otio back with the real opentimelineio lib ---

const PY_SCRIPT = `
import json, sys
import opentimelineio as otio

results = []
for p in sys.argv[1:]:
    tl = otio.adapters.read_from_file(p)
    entry = {"path": p, "tracks": {}}
    for track in tl.tracks:
        gap_count = sum(1 for c in track if type(c).__name__ == "Gap")
        entry["tracks"][track.kind] = {
            "duration_seconds": track.duration().to_seconds(),
            "clip_count": len(track),
            "gap_count": gap_count,
        }
    results.append(entry)
print(json.dumps(results))
`;

async function main() {
  if (!hasUvx()) {
    console.log('[smoke-export] `uv`/`uvx` not found on PATH — skipping OTIO round-trip smoke test.');
    console.log('[smoke-export] Install uv (https://docs.astral.sh/uv/) to run this gate before release.');
    return;
  }

  const { writeOtio } = await import(path.join(ROOT, 'src/export/otio.js'));
  const { segments } = await import(path.join(ROOT, 'src/core/ops.js'));

  const dir = await mkdtemp(path.join(tmpdir(), 'vedit-smoke-export-'));
  let failures = 0;
  try {
    const files = [];
    for (const fx of FIXTURES) {
      const outPath = path.join(dir, `${fx.name}.otio`);
      await writeOtio(fx.manifest, outPath);
      files.push({ ...fx, outPath, expected: expectedMetrics(fx.manifest, segments) });
    }

    console.log(`[smoke-export] verifying ${files.length} fixture(s) with opentimelineio (uvx) ...`);
    const stdout = execFileSync('uvx', ['--from', 'opentimelineio', 'python', '-c', PY_SCRIPT, ...files.map((f) => f.outPath)], {
      encoding: 'utf8',
    });
    const results = JSON.parse(stdout.trim().split('\n').pop());
    const byPath = new Map(results.map((r) => [r.path, r]));

    for (const fx of files) {
      const result = byPath.get(fx.outPath);
      if (!result) {
        console.error(`FAIL ${fx.name}: opentimelineio produced no result for ${fx.outPath}`);
        failures++;
        continue;
      }
      const video = result.tracks.Video;
      const audio = result.tracks.Audio;
      const problems = [];

      if (!video || video.clip_count !== fx.expected.clipCount) {
        problems.push(`video clip_count expected ${fx.expected.clipCount}, got ${video?.clip_count}`);
      }
      if (!audio || audio.clip_count !== fx.expected.clipCount) {
        problems.push(`audio clip_count (incl. gaps) expected ${fx.expected.clipCount}, got ${audio?.clip_count}`);
      }
      if (!audio || audio.gap_count !== fx.expected.gapCount) {
        problems.push(`audio gap_count expected ${fx.expected.gapCount}, got ${audio?.gap_count}`);
      }
      for (const [label, track] of [['video', video], ['audio', audio]]) {
        if (!track) continue;
        const diff = Math.abs(track.duration_seconds - fx.expected.durationSec);
        if (diff > DURATION_TOLERANCE_SEC) {
          problems.push(
            `${label} duration expected ~${fx.expected.durationSec.toFixed(3)}s, got ${track.duration_seconds.toFixed(3)}s (diff ${diff.toFixed(3)}s > ${DURATION_TOLERANCE_SEC}s tolerance)`,
          );
        }
      }

      if (problems.length) {
        console.error(`FAIL ${fx.name}:`);
        for (const p of problems) console.error(`  - ${p}`);
        failures++;
      } else {
        console.log(`PASS ${fx.name} (clips=${fx.expected.clipCount}, gaps=${fx.expected.gapCount}, duration=${fx.expected.durationSec.toFixed(3)}s)`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`[smoke-export] ${failures} fixture(s) failed opentimelineio round-trip.`);
    process.exit(1);
  }
  console.log('[smoke-export] all fixtures round-tripped cleanly through opentimelineio.');
}

main().catch((err) => {
  console.error('[smoke-export] error:', err);
  process.exit(1);
});
