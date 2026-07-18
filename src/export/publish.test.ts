import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BackgroundRef, Manifest, SceneFile, SpriteItem, Transcript } from '../core/types.js';
import type { Peaks } from '../core/detect.js';
import { COMP_SOURCE_ID } from '../core/ops.js';

// publishPack's thumbnail extraction shells out via run(); stub it so the
// integration tests below only assert on the constructed argv, without
// needing ffmpeg installed (same approach as ingest.test.ts / daemon.test.ts).
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn().mockResolvedValue('') }));
vi.mock('../ingest/run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  ffmpegHasFilter: () => true,
  ffmpegBin: () => 'ffmpeg',
}));

import {
  assembleChapterLines,
  buildMaterials,
  chaptersFromMotion,
  chaptersFromScenes,
  formatChapterTimestamp,
  publishPack,
  selectThumbnailPoints,
} from './publish.js';
import { Project } from '../core/project.js';

function baseManifest(opts: { srcDuration?: number; clipOut?: number } = {}): Manifest {
  const srcDuration = opts.srcDuration ?? 30;
  const clipOut = opts.clipOut ?? srcDuration;
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/media/a.mp4', duration: srcDuration, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: clipOut }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

// W-ANIME composition ("コンポジション/スプライトアニメ") fixture: no A-roll
// source at all — see Manifest.composition's doc. `sprites`/`backgroundTrack`
// let each test control the candidate pool (background cuts + sprite
// entrances) that selectThumbnailPoints/publishPack must derive.
function compositionManifest(opts: {
  duration?: number;
  backgroundTrack?: { t: number; ref: BackgroundRef }[];
  sprites?: SpriteItem[];
} = {}): Manifest {
  return {
    version: 1,
    name: 't-comp',
    revision: 0,
    fps: 30,
    width: 1080,
    height: 1920,
    sources: [],
    timeline: { video: [], motion: [], sprites: opts.sprites ?? [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
    composition: {
      duration: opts.duration ?? 60,
      background: { type: 'color', hex: '#000000' },
      ...(opts.backgroundTrack ? { backgroundTrack: opts.backgroundTrack } : {}),
    },
  };
}

function sprite(id: string, srcTime: number, duration = 5): SpriteItem {
  return {
    id,
    assetId: 'char-a',
    anchor: { sourceId: COMP_SOURCE_ID, srcTime },
    duration,
    position: { x: 0.5, y: 0.9 },
    scale: 0.4,
    opacity: 1,
  };
}

// ---- formatChapterTimestamp ----

describe('formatChapterTimestamp', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatChapterTimestamp(0)).toBe('0:00');
    expect(formatChapterTimestamp(65)).toBe('1:05');
    expect(formatChapterTimestamp(599)).toBe('9:59');
  });

  it('formats an hour or more as H:MM:SS', () => {
    expect(formatChapterTimestamp(3661)).toBe('1:01:01');
  });
});

// ---- chaptersFromMotion ----

describe('chaptersFromMotion', () => {
  it('keeps only chapter-card items with non-empty text, sorted ascending', () => {
    const out = chaptersFromMotion([
      { tlStart: 20, type: 'chapter-card', text: 'Second' },
      { tlStart: 5, type: 'chapter-card', text: 'First' },
      { tlStart: 10, type: 'lower-third', text: 'ignored (wrong type)' },
      { tlStart: 15, type: 'chapter-card', text: '  ' }, // blank text, ignored
      { tlStart: 12, type: 'chapter-card' }, // no text, ignored
    ]);
    expect(out).toEqual([
      { tlTime: 5, title: 'First' },
      { tlTime: 20, title: 'Second' },
    ]);
  });

  it('returns an empty list when there are no chapter-card overlays', () => {
    expect(chaptersFromMotion([])).toEqual([]);
    expect(chaptersFromMotion([{ tlStart: 1, type: 'cta', text: 'Subscribe' }])).toEqual([]);
  });
});

// ---- chaptersFromScenes ----

describe('chaptersFromScenes', () => {
  it('maps noted scenes from source time to timeline time, skipping scenes without notes', () => {
    const m = baseManifest({ srcDuration: 30, clipOut: 30 });
    const sceneFile: SceneFile = {
      sourceId: 's1',
      scenes: [
        { id: 's0001', t0: 0, t1: 5, thumb: 'x', hasSpeech: true, energy: 0.1, note: { text: 'Intro', by: 'model', at: 'now' } },
        { id: 's0002', t0: 5, t1: 10, thumb: 'x', hasSpeech: true, energy: 0.1 }, // no note
        { id: 's0003', t0: 10, t1: 15, thumb: 'x', hasSpeech: true, energy: 0.1, note: { text: 'Middle', by: 'user', at: 'now' } },
      ],
    };
    expect(chaptersFromScenes(m, sceneFile)).toEqual([
      { tlTime: 0, title: 'Intro' },
      { tlTime: 10, title: 'Middle' },
    ]);
  });

  it('skips a noted scene whose boundary was cut away from the timeline', () => {
    const m = baseManifest({ srcDuration: 30, clipOut: 10 }); // only source [0,10) survives
    const sceneFile: SceneFile = {
      sourceId: 's1',
      scenes: [{ id: 's0009', t0: 25, t1: 30, thumb: 'x', hasSpeech: false, energy: 0, note: { text: 'Cut away', by: 'model', at: 'now' } }],
    };
    expect(chaptersFromScenes(m, sceneFile)).toEqual([]);
  });
});

// ---- assembleChapterLines ----

describe('assembleChapterLines', () => {
  it('returns a reason (no lines) when there are no entries at all', () => {
    const result = assembleChapterLines([]);
    expect(result.entries).toBeNull();
    expect(result.lines).toBeNull();
    expect((result as any).reason).toMatch(/nothing to base chapters on/);
  });

  it('prepends a synthetic 0:00 opening when the first real chapter is not at 0', () => {
    const result = assembleChapterLines([{ tlTime: 12, title: 'First real chapter' }]);
    expect(result.lines).toEqual(['0:00 オープニング', '0:12 First real chapter']);
  });

  it('does not duplicate an opening chapter that already starts at (near) 0', () => {
    const result = assembleChapterLines([{ tlTime: 0.1, title: 'Cold open' }]);
    expect(result.lines).toEqual(['0:00 Cold open']);
  });

  it('sorts and drops near-duplicate entries within 0.5s of a kept one', () => {
    const result = assembleChapterLines([
      { tlTime: 0, title: 'Start' },
      { tlTime: 30, title: 'Middle A' },
      { tlTime: 30.2, title: 'Middle B (near-dup, dropped)' },
      { tlTime: 10, title: 'Earlier' },
    ]);
    expect(result.lines).toEqual(['0:00 Start', '0:10 Earlier', '0:30 Middle A']);
  });
});

// ---- selectThumbnailPoints ----

describe('selectThumbnailPoints', () => {
  it('returns an empty list for an empty timeline or a non-positive count', () => {
    const m = baseManifest();
    expect(selectThumbnailPoints({ ...m, timeline: { video: [], motion: [] } }, [], {}, 6)).toEqual([]);
    expect(selectThumbnailPoints(m, [], {}, 0)).toEqual([]);
  });

  it('places one point at each chapter start when the budget covers them all', () => {
    const m = baseManifest({ srcDuration: 60, clipOut: 60 });
    const points = selectThumbnailPoints(m, [0, 30], {}, 6);
    expect(points.map((p) => p.reason)).toEqual(['chapter', 'chapter']);
    expect(points.map((p) => p.tlTime)).toEqual([0, 30]);
    expect(points.every((p) => p.sourceId === 's1')).toBe(true);
  });

  it('fills remaining budget with the highest-energy timeline moments', () => {
    const m = baseManifest({ srcDuration: 20, clipOut: 20 });
    const peaks: Peaks = { rate: 1, peaks: [0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }; // spike at t=3
    const points = selectThumbnailPoints(m, [10], { s1: peaks }, 2);
    expect(points).toHaveLength(2);
    const reasons = points.map((p) => p.reason).sort();
    expect(reasons).toEqual(['chapter', 'energy']);
    const energyPoint = points.find((p) => p.reason === 'energy')!;
    expect(energyPoint.tlTime).toBeCloseTo(3);
  });

  it('does not place two points closer together than the spacing floor — a near-duplicate chapter time is skipped, freeing budget for an energy pick', () => {
    const m = baseManifest({ srcDuration: 100, clipOut: 100 });
    const peaks: Peaks = { rate: 1, peaks: new Array(100).fill(0) };
    peaks.peaks[80] = 0.9; // clear energy spike far from the chapter cluster
    const points = selectThumbnailPoints(m, [10, 10.1], { s1: peaks }, 2); // two chapter times almost on top of each other
    expect(points).toHaveLength(2);
    expect(points.filter((p) => p.reason === 'chapter')).toHaveLength(1); // the near-dup was rejected as too close
    expect(points.some((p) => p.reason === 'energy' && Math.abs(p.tlTime - 80) < 1)).toBe(true);
  });

  it('never exceeds the requested count', () => {
    const m = baseManifest({ srcDuration: 60, clipOut: 60 });
    const points = selectThumbnailPoints(m, [0, 5, 10, 15, 20, 25, 30, 35], {}, 3);
    expect(points.length).toBeLessThanOrEqual(3);
  });

  // ---- composition (W-ANIME) — regression bug: this used to always return
  // [] because segments(m) is always empty for a composition project (no
  // A-roll), and the guard at the top of the function bailed out before any
  // composition-aware candidate logic ran at all.
  describe('composition projects', () => {
    it('candidates are background-track cut points (plus t=0) unioned with sprite entrance times, deduped', () => {
      const m = compositionManifest({
        duration: 60,
        backgroundTrack: [
          { t: 20, ref: { type: 'color', hex: '#111111' } },
          { t: 40, ref: { type: 'color', hex: '#222222' } },
        ],
        sprites: [sprite('sp1', 10)],
      });
      const points = selectThumbnailPoints(m, [], {}, 6);
      expect(points.map((p) => p.tlTime)).toEqual([0, 10, 20, 40]);
      expect(points.every((p) => p.sourceId === COMP_SOURCE_ID)).toBe(true);
      expect(points.every((p) => p.reason === 'composition')).toBe(true);
      // srcTime IS absolute timeline time for the COMP_SOURCE_ID sentinel —
      // same convention as sourceTimeToTimeline's `__comp__` branch.
      expect(points.every((p) => p.srcTime === p.tlTime)).toBe(true);
    });

    it('a background cut and a sprite entrance landing on the same instant collapse to one candidate, not two', () => {
      const m = compositionManifest({
        duration: 60,
        backgroundTrack: [{ t: 10, ref: { type: 'color', hex: '#111111' } }],
        sprites: [sprite('sp1', 10)],
      });
      const points = selectThumbnailPoints(m, [], {}, 6);
      expect(points.map((p) => p.tlTime)).toEqual([0, 10]);
    });

    it('chapter times still take priority, filling remaining budget from background/sprite candidates', () => {
      const m = compositionManifest({
        duration: 60,
        backgroundTrack: [{ t: 40, ref: { type: 'color', hex: '#111111' } }],
        sprites: [],
      });
      const points = selectThumbnailPoints(m, [5], {}, 6);
      expect(points.map((p) => ({ tlTime: p.tlTime, reason: p.reason }))).toEqual([
        { tlTime: 0, reason: 'composition' },
        { tlTime: 5, reason: 'chapter' },
        { tlTime: 40, reason: 'composition' },
      ]);
    });

    it('never exceeds the requested count', () => {
      const m = compositionManifest({
        duration: 60,
        backgroundTrack: [
          { t: 10, ref: { type: 'color', hex: '#111111' } },
          { t: 20, ref: { type: 'color', hex: '#222222' } },
          { t: 30, ref: { type: 'color', hex: '#333333' } },
        ],
        sprites: [sprite('sp1', 5), sprite('sp2', 45)],
      });
      const points = selectThumbnailPoints(m, [], {}, 2);
      expect(points.length).toBeLessThanOrEqual(2);
      // minGap at count=2 is duration/(2*4)=7.5s, so the t=5 sprite entrance
      // (only 5s after t=0) is rejected as too close; t=10 is the next pick.
      expect(points.map((p) => p.tlTime)).toEqual([0, 10]);
    });

    it('an "empty" composition (no background cuts, no sprites) still yields the base t=0 candidate', () => {
      const m = compositionManifest({ duration: 60 });
      const points = selectThumbnailPoints(m, [], {}, 6);
      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ tlTime: 0, sourceId: COMP_SOURCE_ID, reason: 'composition' });
    });

    it('returns an empty list for a zero-duration composition or a non-positive count', () => {
      const m = compositionManifest({ duration: 0 });
      expect(selectThumbnailPoints(m, [], {}, 6)).toEqual([]);
      const m2 = compositionManifest({ duration: 60 });
      expect(selectThumbnailPoints(m2, [], {}, 0)).toEqual([]);
    });
  });
});

// ---- buildMaterials ----

describe('buildMaterials', () => {
  it('summarizes duration, sources, chapter list, kept word count, and caption cue count', () => {
    const m = baseManifest({ srcDuration: 10, clipOut: 10 });
    m.captions.enabled = true;
    const transcripts: Transcript[] = [
      {
        sourceId: 's1',
        language: 'en',
        words: [
          { id: 'w0', text: 'Hello.', t0: 0, t1: 1, p: 0.9 },
          { id: 'w1', text: 'World.', t0: 2, t1: 3, p: 0.9 },
        ],
      },
    ];
    const materials = buildMaterials(m, transcripts, ['0:00 Intro']);
    expect(materials.duration).toBeCloseTo(10);
    expect(materials.chapterList).toEqual(['0:00 Intro']);
    expect(materials.sources).toEqual([{ file: 'a.mp4', duration: 10 }]);
    expect(materials.keptWordCount).toBe(2);
    expect(materials.captionsCueCount).toBeGreaterThan(0);
  });

  it('excludes kind:"image" overlay sources from the sources list (a synthetic ~24h duration would read as bogus footage length)', () => {
    const m = baseManifest({ srcDuration: 10, clipOut: 10 });
    m.sources = [
      ...m.sources,
      { id: 'img1', path: '/media/logo.png', duration: 86400, fps: 0, width: 400, height: 200, hasAudio: false, kind: 'image' },
    ];
    const materials = buildMaterials(m, [], []);
    expect(materials.sources).toEqual([{ file: 'a.mp4', duration: 10 }]);
  });
});

// ---- publishPack (integration: real Project on a tmpdir, ffmpeg mocked) ----

describe('publishPack', () => {
  async function makeProject(): Promise<Project> {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-publish-'));
    return Project.create(dir, 'pub-test');
  }

  it('prefers motion chapter-cards over scene notes, writes chapters.txt/thumbnails/materials.json, and extracts thumbnails from the ORIGINAL source path', async () => {
    runMock.mockClear();
    const project = await makeProject();
    const m = baseManifest({ srcDuration: 40, clipOut: 40 });
    m.timeline.motion = [{ id: 'mo1', spec: 'mo1.json', tlStart: 5, duration: 3 }];
    await fs.writeFile(project.motionSpecPath('mo1'), JSON.stringify({ id: 'mo1', type: 'chapter-card', params: { text: 'Chapter One' } }));
    // A scene note exists too, but must be ignored since motion chapters win.
    await project.writeScenes({
      sourceId: 's1',
      scenes: [{ id: 's0001', t0: 20, t1: 25, thumb: 'x', hasSpeech: true, energy: 0.1, note: { text: 'Should be ignored', by: 'model', at: 'now' } }],
    });
    const peaks: Peaks = { rate: 1, peaks: new Array(40).fill(0.05) };
    peaks.peaks[30] = 0.95;
    await fs.writeFile(path.join(project.dir, 'cache', 'peaks-s1.json'), JSON.stringify(peaks));
    m.sources[0].peaks = 'cache/peaks-s1.json';

    const outdir = path.join(project.dir, 'pack-out');
    const result = await publishPack(project, m, [], outdir, { thumbs: 3 });

    expect(result.chaptersFile).toBe(path.join(outdir, 'chapters.txt'));
    expect(result.chaptersReason).toBeUndefined();
    const chaptersText = await fs.readFile(result.chaptersFile!, 'utf8');
    expect(chaptersText).toContain('0:00 オープニング'); // motion chapter starts at 5s, not 0
    expect(chaptersText).toContain('0:05 Chapter One');
    expect(chaptersText).not.toContain('Should be ignored');

    expect(result.thumbnails).toHaveLength(3);
    expect(result.materialsFile).toBe(path.join(outdir, 'materials.json'));
    const materials = JSON.parse(await fs.readFile(result.materialsFile, 'utf8'));
    expect(materials.sources).toEqual([{ file: 'a.mp4', duration: 40 }]);
    expect(materials.chapterList.length).toBeGreaterThan(0);

    // ffmpeg was invoked against the ORIGINAL source path, never a proxy.
    for (const call of runMock.mock.calls) {
      const [cmd, args] = call as [string, string[]];
      expect(cmd).toBe('ffmpeg');
      expect(args).toContain('/media/a.mp4');
    }
  });

  it('falls back to annotated scene notes when there are no motion chapter-cards', async () => {
    runMock.mockClear();
    const project = await makeProject();
    const m = baseManifest({ srcDuration: 20, clipOut: 20 });
    await project.writeScenes({
      sourceId: 's1',
      scenes: [{ id: 's0001', t0: 8, t1: 12, thumb: 'x', hasSpeech: true, energy: 0.1, note: { text: 'From scenes', by: 'user', at: 'now' } }],
    });
    const outdir = path.join(project.dir, 'pack-out');
    const result = await publishPack(project, m, [], outdir, { thumbs: 1 });
    expect(result.chaptersFile).not.toBeNull();
    const chaptersText = await fs.readFile(result.chaptersFile!, 'utf8');
    expect(chaptersText).toContain('From scenes');
  });

  it('skips writing chapters.txt and reports a reason when there is nothing to chapter', async () => {
    runMock.mockClear();
    const project = await makeProject();
    const m = baseManifest({ srcDuration: 20, clipOut: 20 });
    const outdir = path.join(project.dir, 'pack-out');
    const result = await publishPack(project, m, [], outdir, { thumbs: 1 });
    expect(result.chaptersFile).toBeNull();
    expect(result.chaptersReason).toBeTruthy();
    await expect(fs.access(path.join(outdir, 'chapters.txt'))).rejects.toThrow();
  });

  // ---- composition (W-ANIME) — regression bug: publish-pack always
  // produced 0 thumbnails for a composition project, silently, because
  // selectThumbnailPoints bailed out before any composition-aware candidate
  // logic ran (segments(m) is always [] for a composition — no A-roll).
  it('reports a clear reason (not silence, not an error) when a composition project has thumbnail candidates but no rendered file was given', async () => {
    runMock.mockClear();
    const project = await makeProject();
    const m = compositionManifest({ duration: 30, sprites: [sprite('sp1', 5)] });
    const outdir = path.join(project.dir, 'pack-out');
    const result = await publishPack(project, m, [], outdir, { thumbs: 6 });

    expect(result.thumbnails).toEqual([]);
    expect(result.thumbnailsReason).toBeTruthy();
    expect(result.thumbnailsReason).toMatch(/レンダー済み/);
    // Materials/chapters pipeline is unaffected by the missing render.
    expect(result.materialsFile).toBe(path.join(outdir, 'materials.json'));
    await expect(fs.access(result.materialsFile)).resolves.toBeUndefined();
    // ffmpeg was never invoked — there's nothing to extract from.
    expect(runMock).not.toHaveBeenCalled();
  });

  it('extracts composition thumbnails from opts.renderedFile (never the nonexistent original source) when one is given', async () => {
    runMock.mockClear();
    const project = await makeProject();
    const m = compositionManifest({
      duration: 30,
      backgroundTrack: [{ t: 15, ref: { type: 'color', hex: '#111111' } }],
      sprites: [sprite('sp1', 5)],
    });
    const outdir = path.join(project.dir, 'pack-out');
    const renderedFile = '/renders/final.mp4';
    const result = await publishPack(project, m, [], outdir, { thumbs: 6, renderedFile });

    expect(result.thumbnailsReason).toBeUndefined();
    expect(result.thumbnails.length).toBeGreaterThan(0);
    expect(result.thumbnails).toHaveLength(3); // t=0, 5, 15

    for (const call of runMock.mock.calls) {
      const [cmd, args] = call as [string, string[]];
      expect(cmd).toBe('ffmpeg');
      expect(args).toContain(renderedFile);
      expect(args).not.toContain('-vf'); // no cropGeometry for a rendered-file extraction
    }
  });
});
