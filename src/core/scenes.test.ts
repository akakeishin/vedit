import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assignSceneIds,
  buildSceneRanges,
  computeEnergy,
  computeHasSpeech,
  mergeShortRanges,
  packScenes,
  parseSceneChangeTimes,
  sceneThumbPath,
} from './scenes.js';
import { Project } from './project.js';
import type { Peaks } from './detect.js';
import type { Scene, SceneFile, Word } from './types.js';

// ---- parseSceneChangeTimes: pure parsing of mocked ffmpeg showinfo stderr ----

describe('parseSceneChangeTimes', () => {
  it('extracts pts_time markers from showinfo log lines', () => {
    const showinfo = [
      '[Parsed_showinfo_1 @ 0x1] n:   0 pts:    100 pts_time:1.234 pos:1000',
      '[Parsed_showinfo_1 @ 0x1] n:   1 pts:    200 pts_time:5.678 pos:2000',
    ].join('\n');
    expect(parseSceneChangeTimes(showinfo)).toEqual([1.234, 5.678]);
  });

  it('dedupes and sorts out-of-order timestamps', () => {
    const showinfo = 'pts_time:9.0\npts_time:1.0\npts_time:9.0\npts_time:4.5';
    expect(parseSceneChangeTimes(showinfo)).toEqual([1.0, 4.5, 9.0]);
  });

  it('returns an empty list when nothing matches (e.g. a static shot)', () => {
    expect(parseSceneChangeTimes('no scene changes here')).toEqual([]);
  });
});

// ---- buildSceneRanges: split long takes, merge short fragments ----

describe('buildSceneRanges', () => {
  it('brackets [0, duration] around the given boundary times', () => {
    const ranges = buildSceneRanges(30, [10, 20]);
    expect(ranges).toEqual([
      { t0: 0, t1: 10 },
      { t0: 10, t1: 20 },
      { t0: 20, t1: 30 },
    ]);
  });

  it('falls back to one whole-duration scene when no boundaries are detected', () => {
    // under the default maxLen (12s), so no split kicks in.
    expect(buildSceneRanges(10, [])).toEqual([{ t0: 0, t1: 10 }]);
  });

  it('splits a take longer than maxLen into equal-length pieces', () => {
    // 30s single take, maxLen 12 -> ceil(30/12) = 3 equal pieces of 10s each.
    const ranges = buildSceneRanges(30, [], { maxLen: 12, minLen: 1.5 });
    expect(ranges).toHaveLength(3);
    for (const r of ranges) expect(r.t1 - r.t0).toBeCloseTo(10, 5);
    expect(ranges[0].t0).toBe(0);
    expect(ranges[ranges.length - 1].t1).toBe(30);
  });

  it('merges a fragment shorter than minLen into its neighbor', () => {
    // boundaries at 5 and 5.4 create a 0.4s sliver, well under minLen=1.5.
    const ranges = buildSceneRanges(20, [5, 5.4], { minLen: 1.5 });
    expect(ranges.every((r) => r.t1 - r.t0 >= 1.5)).toBe(true);
    // total duration is preserved regardless of how the merge happened
    expect(ranges[0].t0).toBe(0);
    expect(ranges[ranges.length - 1].t1).toBe(20);
  });

  it('ignores boundary times outside (0, duration)', () => {
    const ranges = buildSceneRanges(10, [-1, 0, 10, 11]);
    expect(ranges).toEqual([{ t0: 0, t1: 10 }]);
  });
});

describe('mergeShortRanges', () => {
  it('merges the last short range backward into its predecessor', () => {
    const out = mergeShortRanges(
      [
        { t0: 0, t1: 5 },
        { t0: 5, t1: 5.3 },
      ],
      1.5,
    );
    expect(out).toEqual([{ t0: 0, t1: 5.3 }]);
  });

  it('merges a middle short range forward and rechecks the result', () => {
    // ranges: 5s, 0.2s, 0.2s, 5s -> the two slivers should collapse into one
    // 5.4s range sitting between the two long ones.
    const out = mergeShortRanges(
      [
        { t0: 0, t1: 5 },
        { t0: 5, t1: 5.2 },
        { t0: 5.2, t1: 5.4 },
        { t0: 5.4, t1: 10.4 },
      ],
      1.5,
    );
    expect(out).toEqual([
      { t0: 0, t1: 5 },
      { t0: 5, t1: 10.4 },
    ]);
  });

  it('leaves a single range untouched even if under minLen (whole source is short)', () => {
    const out = mergeShortRanges([{ t0: 0, t1: 0.8 }], 1.5);
    expect(out).toEqual([{ t0: 0, t1: 0.8 }]);
  });
});

// ---- assignSceneIds: id continuity across re-detection ----

describe('assignSceneIds', () => {
  it('assigns fresh sequential ids when there is no prior scenes file', () => {
    const ranges = [{ t0: 0, t1: 5 }, { t0: 5, t1: 10 }, { t0: 10, t1: 15 }];
    const out = assignSceneIds(ranges, []);
    expect(out.map((s) => s.id)).toEqual(['s0001', 's0002', 's0003']);
  });

  it('reuses an existing id when a new range starts within tolerance of it', () => {
    const existing: Pick<Scene, 'id' | 't0'>[] = [
      { id: 's0001', t0: 0 },
      { id: 's0002', t0: 10.1 }, // shifted slightly by a re-detect
    ];
    const ranges = [{ t0: 0, t1: 9.8 }, { t0: 9.8, t1: 20 }];
    const out = assignSceneIds(ranges, existing);
    expect(out[0].id).toBe('s0001');
    expect(out[1].id).toBe('s0002'); // 9.8 is within 0.5s of 10.1
  });

  it('gives a genuinely new range a fresh id continuing past the max existing number', () => {
    const existing: Pick<Scene, 'id' | 't0'>[] = [{ id: 's0005', t0: 0 }];
    const ranges = [{ t0: 0, t1: 8 }, { t0: 8, t1: 16 }];
    const out = assignSceneIds(ranges, existing);
    expect(out[0].id).toBe('s0005'); // matched
    expect(out[1].id).toBe('s0006'); // new, continues the counter (not s0001)
  });

  it('never assigns the same existing id to two different ranges', () => {
    const existing: Pick<Scene, 'id' | 't0'>[] = [{ id: 's0001', t0: 3 }];
    // two new ranges both start near t0=3; only the first should claim s0001.
    const ranges = [{ t0: 3, t1: 6 }, { t0: 3.1, t1: 9 }];
    const out = assignSceneIds(ranges, existing);
    const ids = out.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('s0001');
  });
});

// ---- annotation-adjacent metrics ----

describe('computeHasSpeech', () => {
  const words: Word[] = [
    { id: 'w0', text: 'hi', t0: 2, t1: 2.4, p: 0.9 },
    { id: 'w1', text: 'there', t0: 8, t1: 8.5, p: 0.9 },
  ];

  it('is true when a kept word overlaps the range', () => {
    expect(computeHasSpeech(0, 5, words)).toBe(true);
  });

  it('is false when no kept word overlaps (silent B-roll)', () => {
    expect(computeHasSpeech(3, 7, words)).toBe(false);
  });
});

describe('computeEnergy', () => {
  const peaks: Peaks = { rate: 10, peaks: [0, 0, 0.2, 0.4, 0.6, 0.8, 0, 0, 0, 0] };

  it('averages peak values over the range', () => {
    // indices 2..5 (t=0.2..0.6) -> [0.2,0.4,0.6,0.8] avg = 0.5
    expect(computeEnergy(peaks, 0.2, 0.6)).toBeCloseTo(0.5, 5);
  });

  it('returns 0 for a range with no samples', () => {
    expect(computeEnergy(peaks, 5, 5)).toBe(0);
  });
});

// ---- packScenes: note provenance surfaces in the packed text ----

describe('packScenes', () => {
  it('reports the placeholder message when there are no scenes yet', () => {
    expect(packScenes({ sourceId: 's1', scenes: [] })).toMatch(/no scenes detected/);
  });

  it('renders id, range, duration, speech/silent, energy, and note with its "by"', () => {
    const file: SceneFile = {
      sourceId: 's1',
      scenes: [
        {
          id: 's0001', t0: 0, t1: 4.2, thumb: 'cache/sc-s1-s0001.jpg',
          hasSpeech: false, energy: 0.12,
          note: { text: 'エスカレーター上りの追い撮り', by: 'model', at: '2026-07-16T00:00:00.000Z' },
        },
        {
          id: 's0002', t0: 4.2, t1: 9.0, thumb: 'cache/sc-s1-s0002.jpg',
          hasSpeech: true, energy: 0.55,
        },
      ],
    };
    const text = packScenes(file);
    expect(text).toMatch(/s0001 \[0:00\.0–0:04\.2\] 4\.2s silent energy=0\.12 — エスカレーター上りの追い撮り \(by:model\)/);
    expect(text).toMatch(/s0002 \[0:04\.2–0:09\.0\] 4\.8s speech energy=0\.55/);
    expect(text).not.toMatch(/s0002.*—/); // no note appended for s0002
  });
});

// ---- sceneThumbPath: containment for the thumbnail write path ----

describe('sceneThumbPath', () => {
  it('resolves a normal sourceId/sceneId to a path under cache/', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-'));
    const project = await Project.create(path.join(dir, 'proj'), 'test');
    const { rel, abs } = await sceneThumbPath(project, 's1', 's0001');
    expect(rel).toBe(path.join('cache', 'sc-s1-s0001.jpg'));
    expect(abs).toBe(path.join(project.dir, 'cache', 'sc-s1-s0001.jpg'));
  });

  it('rejects a sourceId/sceneId crafted to escape cache/ via traversal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-'));
    const project = await Project.create(path.join(dir, 'proj'), 'test');
    await expect(sceneThumbPath(project, '../../../../etc', 'passwd')).rejects.toThrow(/escapes directory/);
  });
});
