import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CaptionCue } from '../core/captions.js';
import type { Peaks } from '../core/detect.js';
import type { CutCandidate, KitProfile, Manifest, SceneFile, Source, Transcript } from '../core/types.js';

// probeRenderedFile shells out to ffmpeg via runCapture() (see run.js) —
// stub it so parser-orchestration tests below stay fast/deterministic
// without needing ffmpeg installed (same approach as render.test.ts's
// runCaptureMock). Every other test in this file (staticChecks and its
// sub-checks, tempoContractLite, buildQcReport, the parser pure functions
// fed hand-built stderr text) never touches run.js.
const { runCaptureMock } = vi.hoisted(() => ({
  runCaptureMock: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('../ingest/run.js', () => ({
  run: vi.fn(),
  runBinary: vi.fn(),
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
  ffmpegBin: () => 'ffmpeg',
  ffmpegHasFilter: () => true,
}));

import {
  buildQcReport,
  checkCaptionCues,
  checkColorWarnings,
  checkKitDuration,
  checkMediaFilesExist,
  checkOrphans,
  checkOverlayGeometry,
  checkPendingQueues,
  parseAstatsOverall,
  parseBlackDetect,
  parseEbur128Summary,
  parseSilenceDetect,
  probeRenderedFile,
  staticChecks,
  tempoContractLite,
} from './qc.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `vedit-qc-${prefix}-`));
}

function manifest(partial: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    name: 'proj',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/media/one.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
    ...partial,
  };
}

function candidate(partial: Partial<CutCandidate> & { id: string; status: CutCandidate['status'] }): CutCandidate {
  return { kind: 'silence', sourceId: 's1', t0: 0, t1: 1, wordIds: [], label: '', ...partial };
}

function sceneFile(partial: Partial<SceneFile> = {}): SceneFile {
  return {
    sourceId: 's1',
    scenes: [
      { id: 'sc1', t0: 0, t1: 5, thumb: 'x', hasSpeech: true, energy: 0.1 },
      { id: 'sc2', t0: 5, t1: 10, thumb: 'x', hasSpeech: true, energy: 0.1 },
    ],
    ...partial,
  };
}

function cue(partial: Partial<CaptionCue> & { text: string }): CaptionCue {
  return { tlStart: 0, tlEnd: 1, wordIds: [], ...partial };
}

// ---------------------------------------------------------------------------
// ---- real-world ffmpeg stderr fixture --------------------------------------
// ---------------------------------------------------------------------------
// Captured verbatim from a real ffmpeg 8.1.2 run (2026-07) against a
// synthetic 6s clip (black 0-1s / red 1-3s / black 3-4s / blue 4-6s video;
// silence 0-1.5s / 440Hz tone 1.5-4s / silence 4-6s audio) through:
//   ffmpeg -i sample.mp4 -filter_complex
//     "[0:v]blackdetect=d=0.5:pix_th=0.10[vout];
//      [0:a]silencedetect=n=-50dB:d=1,ebur128=peak=true,astats=metadata=0:reset=0[aout]"
//     -map [vout] -map [aout] -f null -
// This is exactly the graph probeRenderedFile builds, so it's ground truth
// for the parser functions below rather than a guessed-at format.
const REAL_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'sample.mp4':
  Duration: 00:00:06.00, start: 0.000000, bitrate: 67 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 320x240 [SAR 1:1 DAR 4:3], 4 kb/s, 25 fps, 25 tbr, 12800 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 55 kb/s (default)
Stream mapping:
  Stream #0:0 (h264) -> blackdetect:default
  Stream #0:1 (aac) -> silencedetect:default
Press [q] to stop, [?] for help
[Parsed_ebur128_2 @ 0xa17013000] t: 0.0999792  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK:  -inf  -inf dBFS  TPK:  -inf  -inf dBFS
Output #0, null, to 'pipe:':
[Parsed_silencedetect_1 @ 0xa17012f40] silence_start: 0
[Parsed_blackdetect_0 @ 0xa17012e80] black_start:0 black_end:1 black_duration:1
[Parsed_silencedetect_1 @ 0xa17012f40] silence_end: 1.500042 | silence_duration: 1.500042
[Parsed_ebur128_2 @ 0xa17013000] t: 1.599979   TARGET:-23 LUFS    M: -27.7 S:-120.7     I: -27.8 LUFS       LRA:   0.0 LU  FTPK: -20.4 -20.4 dBFS  TPK: -20.4 -20.4 dBFS
[Parsed_blackdetect_0 @ 0xa17012e80] black_start:3 black_end:4 black_duration:1
[Parsed_silencedetect_1 @ 0xa17012f40] silence_start: 4
[Parsed_astats_3 @ 0xa170130c0] Channel: 1
[Parsed_astats_3 @ 0xa170130c0] Peak level dB: -20.369904
[Parsed_astats_3 @ 0xa170130c0] RMS level dB: -27.829681
[Parsed_astats_3 @ 0xa170130c0] Crest factor: 2.360418
[Parsed_astats_3 @ 0xa170130c0] Peak count: 2
[Parsed_astats_3 @ 0xa170130c0] Noise floor dB: -inf
[Parsed_astats_3 @ 0xa170130c0] Channel: 2
[Parsed_astats_3 @ 0xa170130c0] Peak level dB: -20.369904
[Parsed_astats_3 @ 0xa170130c0] RMS level dB: -27.829681
[Parsed_astats_3 @ 0xa170130c0] Crest factor: 2.360418
[Parsed_astats_3 @ 0xa170130c0] Peak count: 2
[Parsed_astats_3 @ 0xa170130c0] Noise floor dB: -inf
[Parsed_astats_3 @ 0xa170130c0] Overall
[Parsed_astats_3 @ 0xa170130c0] Peak level dB: -20.369904
[Parsed_astats_3 @ 0xa170130c0] RMS level dB: -27.829681
[Parsed_astats_3 @ 0xa170130c0] Flat factor: 0.000000
[Parsed_astats_3 @ 0xa170130c0] Peak count: 2.000000
[Parsed_astats_3 @ 0xa170130c0] Noise floor dB: -inf
[Parsed_ebur128_2 @ 0xa17013000] Summary:

  Integrated loudness:
    I:         -22.2 LUFS
    Threshold: -32.4 LUFS

  Loudness range:
    LRA:         2.8 LU
    Threshold: -43.5 LUFS
    LRA low:   -25.4 LUFS
    LRA high:  -22.5 LUFS

  True peak:
    Peak:      -20.4 dBFS
[Parsed_silencedetect_1 @ 0xa17012f40] silence_end: 5.994667 | silence_duration: 1.994667
[out#0/null @ 0xa17010a80] video:62KiB audio:1124KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown
frame=  150 fps=0.0 q=-0.0 Lsize=N/A time=00:00:05.99 bitrate=N/A speed= 128x elapsed=0:00:00.04
`;

// ---------------------------------------------------------------------------
// ---- parsers (pure) --------------------------------------------------------
// ---------------------------------------------------------------------------

describe('parseBlackDetect', () => {
  it('extracts every black_start/black_end/black_duration line from real ffmpeg output', () => {
    expect(parseBlackDetect(REAL_STDERR)).toEqual([
      { start: 0, end: 1, duration: 1 },
      { start: 3, end: 4, duration: 1 },
    ]);
  });

  it('returns [] when nothing matches', () => {
    expect(parseBlackDetect('no black here')).toEqual([]);
  });

  it('handles decimal timestamps', () => {
    const text = '[x] black_start:12.34 black_end:15.67 black_duration:3.33';
    expect(parseBlackDetect(text)).toEqual([{ start: 12.34, end: 15.67, duration: 3.33 }]);
  });
});

describe('parseSilenceDetect', () => {
  it('pairs silence_start/silence_end lines in stream order from real ffmpeg output', () => {
    expect(parseSilenceDetect(REAL_STDERR)).toEqual([
      { start: 0, end: 1.500042, duration: 1.500042 },
      { start: 4, end: 5.994667, duration: 1.994667 },
    ]);
  });

  it('returns end:null/duration:null for a trailing unmatched silence_start (file ends mid-silence)', () => {
    const text = '[x] silence_start: 2.5';
    expect(parseSilenceDetect(text)).toEqual([{ start: 2.5, end: null, duration: null }]);
  });

  it('returns [] when nothing matches', () => {
    expect(parseSilenceDetect('nothing here')).toEqual([]);
  });
});

describe('parseEbur128Summary', () => {
  it('extracts integrated LUFS/threshold, LRA, and true peak from the final Summary: block', () => {
    expect(parseEbur128Summary(REAL_STDERR)).toEqual({
      integratedLufs: -22.2,
      integratedThresholdLufs: -32.4,
      loudnessRangeLu: 2.8,
      truePeakDb: -20.4,
    });
  });

  it('ignores per-frame progress lines that precede the Summary: block (different I:/LRA: layout)', () => {
    // REAL_STDERR's progress lines report I: -70.0 LUFS / -27.8 LUFS etc.,
    // very different from the true Summary value (-22.2) — a naive
    // "first I: match" parser would get this wrong.
    expect(parseEbur128Summary(REAL_STDERR).integratedLufs).toBe(-22.2);
  });

  it('returns all nulls when there is no Summary: block at all', () => {
    expect(parseEbur128Summary('nothing to see here')).toEqual({
      integratedLufs: null,
      integratedThresholdLufs: null,
      loudnessRangeLu: null,
      truePeakDb: null,
    });
  });

  it('truePeakDb stays null when the ebur128 filter ran without peak=true (no "True peak:" section)', () => {
    const text = `[x] Summary:

  Integrated loudness:
    I:         -18.0 LUFS
    Threshold: -28.0 LUFS

  Loudness range:
    LRA:         5.0 LU
    Threshold: -38.0 LUFS
`;
    expect(parseEbur128Summary(text).truePeakDb).toBeNull();
    expect(parseEbur128Summary(text).integratedLufs).toBe(-18.0);
  });
});

describe('parseAstatsOverall', () => {
  it('picks the LAST (Overall) occurrence of each key, not a per-channel one', () => {
    // Deliberately DIFFERENT numbers per channel vs. Overall (unlike
    // REAL_STDERR, where they happen to coincide) — this is the test that
    // actually proves "last occurrence == Overall block", not just
    // "matches something".
    const text = `[a] Channel: 1
[a] Peak level dB: -6.000000
[a] RMS level dB: -18.000000
[a] Peak count: 5.000000
[a] Noise floor dB: -70.000000
[a] Channel: 2
[a] Peak level dB: -7.000000
[a] RMS level dB: -19.000000
[a] Peak count: 3.000000
[a] Noise floor dB: -72.000000
[a] Overall
[a] Peak level dB: -6.500000
[a] RMS level dB: -18.500000
[a] Peak count: 8.000000
[a] Noise floor dB: -71.000000
`;
    expect(parseAstatsOverall(text)).toEqual({ peakDb: -6.5, rmsDb: -18.5, peakCount: 8, noiseFloorDb: -71 });
  });

  it('parses -inf as -Infinity (real ffmpeg output: silent Overall channel)', () => {
    const r = parseAstatsOverall(REAL_STDERR);
    expect(r).toEqual({ peakDb: -20.369904, rmsDb: -27.829681, peakCount: 2, noiseFloorDb: -Infinity });
  });

  it('returns all nulls when astats never logged anything', () => {
    expect(parseAstatsOverall('nothing here')).toEqual({ peakDb: null, rmsDb: null, peakCount: null, noiseFloorDb: null });
  });
});

// ---------------------------------------------------------------------------
// ---- staticChecks: individual branches -------------------------------------
// ---------------------------------------------------------------------------

describe('checkPendingQueues', () => {
  it('flags proposed (not approved/rejected) cut candidates', () => {
    const cands = [
      candidate({ id: 'c1', status: 'proposed' }),
      candidate({ id: 'c2', status: 'approved' }),
      candidate({ id: 'c3', status: 'proposed' }),
    ];
    const issues = checkPendingQueues(manifest(), [], cands);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ category: 'candidates', severity: 'warning' });
    expect(issues[0].message).toContain('2件');
  });

  it('flags unreviewed scenes via cullingStats when sceneFiles is given', () => {
    const issues = checkPendingQueues(manifest(), [sceneFile()], []);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ category: 'scene-review', severity: 'info' });
    expect(issues[0].message).toContain('2件');
  });

  it('scene-review issue disappears once every scene is keep/reject', () => {
    const m = manifest({ culling: { s1: { sc1: 'keep', sc2: 'reject' } } });
    expect(checkPendingQueues(m, [sceneFile()], [])).toEqual([]);
  });

  it('returns [] with no candidates and no sceneFiles', () => {
    expect(checkPendingQueues(manifest(), [], [])).toEqual([]);
  });
});

describe('checkOrphans', () => {
  it('flags an overlay/sprite whose anchor was cut away, one issue each', () => {
    const m = manifest({
      timeline: {
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }],
        motion: [],
        overlays: [{ id: 'ov1', sourceId: 's1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 50 }, audioMode: 'mute' }],
        sprites: [{ id: 'sp1', assetId: 'a1', anchor: { sourceId: 's1', srcTime: 50 }, duration: 3, position: { x: 0.5, y: 0.9 }, scale: 0.3, opacity: 1 }],
      },
    });
    const issues = checkOrphans(m);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.category).sort()).toEqual(['overlay-orphan', 'sprite-orphan']);
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
  });

  it('returns [] when every overlay/sprite still resolves', () => {
    const m = manifest({
      timeline: {
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }],
        motion: [],
        overlays: [{ id: 'ov1', sourceId: 's1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 5 }, audioMode: 'mute' }],
      },
    });
    expect(checkOrphans(m)).toEqual([]);
  });
});

describe('checkOverlayGeometry (オーバーレイ・スタック)', () => {
  it('returns [] for a manifest with no overlays', () => {
    expect(checkOverlayGeometry(manifest())).toEqual([]);
  });

  it('warns (category overlay-geometry, severity warning) when an overlay extends past the timeline\'s own end', () => {
    const m = manifest({
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/media/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: {
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }],
        motion: [],
        overlays: [{ id: 'ov1', sourceId: 's2', srcIn: 0, srcOut: 5, anchor: { sourceId: 's1', srcTime: 8 }, audioMode: 'mute' }], // tl[8,13) — past tl end 10
      },
    });
    const issues = checkOverlayGeometry(m);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('overlay-geometry');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('ov1');
  });

  it('is wired into staticChecks (a real render/qc pass surfaces the same warning)', async () => {
    const m = manifest({
      sources: [
        { id: 's1', path: '/media/one.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 'img1', path: '/media/portrait.png', duration: 86400, fps: 0, width: 400, height: 800, hasAudio: false, kind: 'image' },
      ],
      timeline: {
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }],
        motion: [],
        overlays: [{ id: 'ov1', sourceId: 'img1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 }, audioMode: 'mute' }],
      },
    });
    const report = await staticChecks(m, []);
    expect(report.issues.some((i) => i.category === 'overlay-geometry')).toBe(true);
  });
});

describe('checkCaptionCues', () => {
  it('flags an overlapping cue pair (belt-and-suspenders — captionCues itself never produces this)', () => {
    const cues = [cue({ tlStart: 0, tlEnd: 2, text: 'abc' }), cue({ tlStart: 1, tlEnd: 3, text: 'def' })];
    const issues = checkCaptionCues(cues, 8);
    expect(issues.filter((i) => i.category === 'captions' && i.severity === 'error')).toHaveLength(1);
  });

  it('flags a cue whose characters-per-second exceeds maxCps', () => {
    const cues = [cue({ tlStart: 0, tlEnd: 1, text: 'a'.repeat(20) })]; // 20 cps
    const issues = checkCaptionCues(cues, 8);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', category: 'captions', tlTime: 0 });
    expect(issues[0].message).toContain('cps');
  });

  it('returns [] for cues within cps and with no overlap', () => {
    const cues = [cue({ tlStart: 0, tlEnd: 2, text: 'short' }), cue({ tlStart: 2, tlEnd: 4, text: 'also short' })];
    expect(checkCaptionCues(cues, 8)).toEqual([]);
  });

  it('returns [] for an empty cue list', () => {
    expect(checkCaptionCues([], 8)).toEqual([]);
  });
});

describe('checkColorWarnings', () => {
  it('flags sources needing color transform, leaves SDR/untagged sources alone', () => {
    const sources: Source[] = [
      { id: 's1', path: '/a.mp4', duration: 1, fps: 30, width: 1, height: 1, hasAudio: true, color: { transfer: 'arib-std-b67' } },
      { id: 's2', path: '/b.mp4', duration: 1, fps: 30, width: 1, height: 1, hasAudio: true, color: { transfer: 'bt709' } },
      { id: 's3', path: '/c.mp4', duration: 1, fps: 30, width: 1, height: 1, hasAudio: true },
    ];
    const issues = checkColorWarnings(sources);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ category: 'color', severity: 'warning' });
    expect(issues[0].message).toContain('s1');
    expect(issues[0].message).toMatch(/Log\/HLG/);
  });
});

describe('checkMediaFilesExist', () => {
  it('flags a missing source and a missing music file, leaves an existing one alone', async () => {
    const dir = tmpDir('media');
    const realFile = path.join(dir, 'real.mp4');
    await fsp.writeFile(realFile, 'x');
    const m = manifest({
      sources: [
        { id: 's1', path: realFile, duration: 1, fps: 30, width: 1, height: 1, hasAudio: true },
        { id: 's2', path: path.join(dir, 'missing.mp4'), duration: 1, fps: 30, width: 1, height: 1, hasAudio: true },
      ],
      timeline: {
        video: [],
        motion: [],
        music: [{ id: 'mu1', path: path.join(dir, 'missing.mp3'), tlStart: 0, duration: 1, srcIn: 0, gain: -12, fadeIn: 1, fadeOut: 2, duck: true }],
      },
    });
    const issues = await checkMediaFilesExist(m);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.category)).toEqual(['source-missing', 'source-missing']);
    expect(issues.some((i) => i.message.includes('s2'))).toBe(true);
    expect(issues.some((i) => i.message.includes('mu1'))).toBe(true);
  });

  it('returns [] when every referenced file exists', async () => {
    const dir = tmpDir('media-ok');
    const realFile = path.join(dir, 'real.mp4');
    await fsp.writeFile(realFile, 'x');
    const m = manifest({ sources: [{ id: 's1', path: realFile, duration: 1, fps: 30, width: 1, height: 1, hasAudio: true }] });
    expect(await checkMediaFilesExist(m)).toEqual([]);
  });
});

describe('checkKitDuration', () => {
  const profile = (d: KitProfile['duration_seconds']): KitProfile => ({ duration_seconds: d });

  it('does nothing when no kit is linked, regardless of kitProfile', () => {
    expect(checkKitDuration(manifest(), 100, profile({ target: 60 }))).toEqual([]);
  });

  it('does nothing when a kit is linked but no kitProfile was supplied', () => {
    expect(checkKitDuration(manifest({ kit: { path: '/kit' } }), 100)).toEqual([]);
  });

  it('warns when actual duration is >10% off the kit target', () => {
    const m = manifest({ kit: { path: '/kit' } });
    const issues = checkKitDuration(m, 100, profile({ target: 60 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ category: 'kit-duration', severity: 'warning' });
    expect(issues[0].message).toContain('+66.7%');
  });

  it('stays silent within the ±10% band and within min/max bounds', () => {
    const m = manifest({ kit: { path: '/kit' } });
    expect(checkKitDuration(m, 65, profile({ target: 60, min: 50, max: 70 }))).toEqual([]);
  });

  it('flags min/max bound violations independently of the target band', () => {
    const m = manifest({ kit: { path: '/kit' } });
    const issues = checkKitDuration(m, 80, profile({ target: 60, min: 50, max: 70 }));
    // both the >10% target deviation AND the max-bound violation fire
    expect(issues).toHaveLength(2);
    expect(issues.some((i) => i.message.includes('上限'))).toBe(true);
  });
});

describe('staticChecks (orchestration)', () => {
  it('returns zero counts for a clean manifest', async () => {
    const dir = tmpDir('clean');
    const realFile = path.join(dir, 'real.mp4');
    await fsp.writeFile(realFile, 'x');
    const m = manifest({ sources: [{ id: 's1', path: realFile, duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }] });
    const report = await staticChecks(m, []);
    expect(report.issues).toEqual([]);
    expect(report.counts).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });

  it('aggregates issues from every sub-check', async () => {
    const dir = tmpDir('dirty');
    const m = manifest({
      sources: [{ id: 's1', path: path.join(dir, 'missing.mp4'), duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true, color: { transfer: 'arib-std-b67' } }],
      kit: { path: '/kit' },
    });
    const cands = [candidate({ id: 'c1', status: 'proposed' })];
    const report = await staticChecks(m, [], [sceneFile()], { candidates: cands, kitProfile: { duration_seconds: { target: 1 } } });
    const categories = new Set(report.issues.map((i) => i.category));
    expect(categories).toContain('candidates');
    expect(categories).toContain('scene-review');
    expect(categories).toContain('color');
    expect(categories).toContain('source-missing');
    expect(categories).toContain('kit-duration');
    expect(report.counts.errors + report.counts.warnings + report.counts.infos).toBe(report.issues.length);
    expect(report.issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ---- probeRenderedFile (orchestration; ffmpeg mocked) ----------------------
// ---------------------------------------------------------------------------

describe('probeRenderedFile', () => {
  it('parses real ffmpeg output into structured black/silence/loudness/audio + derived issues', async () => {
    runCaptureMock.mockReset();
    runCaptureMock.mockResolvedValueOnce({ stdout: '', stderr: REAL_STDERR });
    const result = await probeRenderedFile('/out.mp4');

    expect(result.black).toHaveLength(2);
    expect(result.silence).toHaveLength(2);
    expect(result.loudness.integratedLufs).toBe(-22.2);
    expect(result.audio.peakCount).toBe(2);

    // 2 black (warning) + 2 silence (info) + 1 loudness deviation (-22.2 vs default -14 target)
    expect(result.issues.filter((i) => i.kind === 'black')).toHaveLength(2);
    expect(result.issues.filter((i) => i.kind === 'silence')).toHaveLength(2);
    expect(result.issues.filter((i) => i.kind === 'loudness')).toHaveLength(1);
    expect(result.issues.filter((i) => i.kind === 'true-peak')).toHaveLength(0); // -20.4 is well under the -1.5 ceiling
    expect(result.issues.filter((i) => i.kind === 'clipping')).toHaveLength(0); // -20.4dB peak, nowhere near 0dBFS

    const args = runCaptureMock.mock.calls[0][1] as string[];
    expect(args).toContain('/out.mp4');
    expect(args.join(' ')).toContain('blackdetect=d=0.5');
    expect(args.join(' ')).toContain('silencedetect=n=-50dB:d=1');
    expect(args.join(' ')).toContain('ebur128=peak=true');
  });

  it('intentZones covering >=50% of a black/silence window suppress it from `issues` but not from the raw lists', async () => {
    runCaptureMock.mockReset();
    runCaptureMock.mockResolvedValueOnce({ stdout: '', stderr: REAL_STDERR });
    const result = await probeRenderedFile('/out.mp4', { intentZones: [{ t0: 0, t1: 1, reason: 'intentional cold open' }] });

    expect(result.black).toHaveLength(2); // raw list unaffected
    expect(result.issues.filter((i) => i.kind === 'black')).toHaveLength(1); // only the 3-4s one remains
  });

  it('flags true-peak and clipping when thresholds are crossed (isolated fixture)', async () => {
    const text = `[x] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.0 LUFS

  Loudness range:
    LRA:         3.0 LU
    Threshold: -30.0 LUFS

  True peak:
    Peak:       -0.8 dBFS
[a] Overall
[a] Peak level dB: -0.100000
[a] Peak count: 12.000000
`;
    runCaptureMock.mockReset();
    runCaptureMock.mockResolvedValueOnce({ stdout: '', stderr: text });
    const result = await probeRenderedFile('/out.mp4');

    expect(result.issues.filter((i) => i.kind === 'loudness')).toHaveLength(0); // -14.3 vs default -14 target, within 1LU
    expect(result.issues.filter((i) => i.kind === 'true-peak')).toHaveLength(1);
    expect(result.issues.filter((i) => i.kind === 'clipping')).toHaveLength(1);
    expect(result.issues.find((i) => i.kind === 'clipping')!.severity).toBe('error');
  });

  it('respects a custom targetLufs', async () => {
    runCaptureMock.mockReset();
    runCaptureMock.mockResolvedValueOnce({ stdout: '', stderr: REAL_STDERR });
    const result = await probeRenderedFile('/out.mp4', { targetLufs: -22 });
    expect(result.issues.filter((i) => i.kind === 'loudness')).toHaveLength(0); // -22.2 vs -22 target, within 1LU
  });
});

// ---------------------------------------------------------------------------
// ---- tempoContractLite (pure facts, no verdict) ----------------------------
// ---------------------------------------------------------------------------

describe('tempoContractLite', () => {
  function pacedManifest(): Manifest {
    return manifest({
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 2 },
          { id: 'c2', sourceId: 's1', srcIn: 10, srcOut: 14 },
          { id: 'c3', sourceId: 's1', srcIn: 20, srcOut: 26 },
        ],
        motion: [],
      },
    });
  }

  it('computes shot-length distribution from the current timeline', () => {
    const facts = tempoContractLite(pacedManifest());
    expect(facts.shotLengths).toEqual({ count: 3, meanSeconds: 4, minSeconds: 2, maxSeconds: 6, medianSeconds: 4 });
  });

  it('shotLengths is null for an empty timeline', () => {
    const facts = tempoContractLite(manifest({ timeline: { video: [], motion: [] } }));
    expect(facts.shotLengths).toBeNull();
  });

  it('diffs the measured mean against kitProfile.pacing.average_shot_seconds', () => {
    const facts = tempoContractLite(pacedManifest(), { pacing: { average_shot_seconds: 5 } });
    expect(facts.kitAverageShotSeconds).toBe(5);
    expect(facts.deltaSeconds).toBeCloseTo(-1);
    expect(facts.deltaPercent).toBeCloseTo(-20);
  });

  it('never produces a pass/fail verdict — just returns the numbers, even for a huge mismatch', () => {
    const facts = tempoContractLite(pacedManifest(), { pacing: { average_shot_seconds: 100 } });
    expect(facts).not.toHaveProperty('pass');
    expect(facts).not.toHaveProperty('ok');
    expect(facts.deltaPercent).toBeCloseTo(-96);
  });

  it('kitAverageShotSeconds/delta are null with no kitProfile', () => {
    const facts = tempoContractLite(pacedManifest());
    expect(facts.kitAverageShotSeconds).toBeNull();
    expect(facts.deltaSeconds).toBeNull();
    expect(facts.deltaPercent).toBeNull();
  });

  it('computes silenceRatio from peaks within kept segment ranges when supplied', () => {
    const m = manifest({ timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 4 }], motion: [] } });
    // 4 samples/sec covering [0,4): first half loud (0.9), second half silent (0.0)
    const peaks: Peaks = { rate: 1, peaks: [0.9, 0.9, 0.0, 0.0] };
    const facts = tempoContractLite(m, undefined, { peaksBySource: { s1: peaks }, silenceThreshold: 0.1 });
    expect(facts.silenceRatio).toBeCloseTo(0.5);
  });

  it('silenceRatio is null when no peaksBySource is given', () => {
    expect(tempoContractLite(pacedManifest()).silenceRatio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ---- buildQcReport (self-contained HTML) -----------------------------------
// ---------------------------------------------------------------------------

describe('buildQcReport', () => {
  it('renders a self-contained HTML doc with title, counts, and a data-tl attribute on timed rows', () => {
    const html = buildQcReport({
      title: 'Test QC',
      generatedAt: '2026-07-17T00:00:00.000Z',
      staticReport: {
        issues: [{ id: 'a', severity: 'error', category: 'source-missing', message: 'missing file', tlTime: undefined }],
        counts: { errors: 1, warnings: 0, infos: 0 },
      },
      probe: {
        black: [], silence: [],
        loudness: { integratedLufs: -20, integratedThresholdLufs: -30, loudnessRangeLu: 3, truePeakDb: -2 },
        audio: { peakDb: -6, rmsDb: -18, peakCount: 1, noiseFloorDb: -60 },
        issues: [{ kind: 'black', severity: 'warning', message: '暗転を検出', t0: 12.5, t1: 13 }],
      },
      tempo: { shotLengths: { count: 4, meanSeconds: 3, minSeconds: 1, maxSeconds: 5, medianSeconds: 3 }, silenceRatio: 0.2, kitAverageShotSeconds: 4, deltaSeconds: -1, deltaPercent: -25 },
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Test QC');
    expect(html).toContain('1 errors');
    expect(html).toContain('1 warnings'); // from the probe black issue
    expect(html).toContain('data-tl="12.5"');
    expect(html).toContain('Loudness / Audio');
    expect(html).toContain('Tempo Contract');
    // no click handler is wired up — click-to-seek is later web-integration work
    expect(html).not.toMatch(/onclick=/);
  });

  it('omits the Loudness/Tempo sections when probe/tempo are not supplied', () => {
    const html = buildQcReport({ staticReport: { issues: [], counts: { errors: 0, warnings: 0, infos: 0 } } });
    expect(html).not.toContain('Loudness / Audio');
    expect(html).not.toContain('Tempo Contract');
  });

  it('shows a "no issues" row when there is nothing to report', () => {
    const html = buildQcReport({});
    expect(html).toContain('検出された問題はありません');
    expect(html).toContain('0 errors');
  });

  it('escapes HTML-significant characters in issue messages (defensive against transcript-derived text)', () => {
    const html = buildQcReport({
      staticReport: {
        issues: [{ id: 'a', severity: 'warning', category: 'captions', message: '<script>alert(1)</script> & "quoted"' }],
        counts: { errors: 0, warnings: 1, infos: 0 },
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('sorts rows by severity (error, warning, info) then by timeline time', () => {
    const html = buildQcReport({
      staticReport: {
        issues: [
          { id: 'a', severity: 'info', category: 'scene-review', message: 'info-issue', tlTime: 1 },
          { id: 'b', severity: 'error', category: 'source-missing', message: 'error-issue', tlTime: 5 },
          { id: 'c', severity: 'warning', category: 'captions', message: 'warn-issue', tlTime: 2 },
        ],
        counts: { errors: 1, warnings: 1, infos: 1 },
      },
    });
    const order = ['error-issue', 'warn-issue', 'info-issue'].map((m) => html.indexOf(m));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });
});
