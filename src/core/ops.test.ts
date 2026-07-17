import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addClip,
  addDialogue,
  addIntentZone,
  addMusic,
  addOverlay,
  addSprite,
  applyReframe,
  backgroundIntervals,
  buildSelectsTimeline,
  COLOR_WARNING_MESSAGE,
  COMP_SOURCE_ID,
  cropGeometry,
  cropOffset,
  cropWindow,
  cullingStats,
  emoteWindows,
  expandWordIds,
  intentZonesForSource,
  keptWords,
  moveClip,
  needsColorTransform,
  orphanedOverlays,
  orphanedSprites,
  overlappingIntentZones,
  OVERLAY_GAIN_DEFAULT,
  padWordRange,
  parseFocus,
  parseReframeSpec,
  quietZonesOverlappingTimelineRange,
  removeBackgroundAt,
  removeClip,
  removeDialogue,
  removeIntentZone,
  removeMusic,
  removeOverlay,
  removeSourceRange,
  removeSprite,
  resolveOverlays,
  resolvedActiveOverlays,
  resolvedActiveSprites,
  resolveSprites,
  resolvedBackgroundAt,
  segments,
  setAudioMix,
  setAudioRepair,
  setBackgroundAt,
  setClipCrop,
  setColorAdjust,
  setColorTransform,
  setComposition,
  setSceneReview,
  sourceTimeToTimeline,
  spriteGeometry,
  spriteMotionPlan,
  timelineDuration,
  timelineTimeToSource,
  trimClip,
  updateDialogue,
  updateMusic,
  updateOverlay,
  updateSprite,
  wordRange,
} from './ops.js';
import { Project } from './project.js';
import { detectFillers, detectSilences, detectSilencesFromPeaks } from './detect.js';
import type { Manifest, SceneFile, Transcript, Word } from './types.js';

function manifest(): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [
      { id: 's1', path: '/x.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true },
    ],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

function words(): Word[] {
  // 10 words, 1s each, with a 2s gap after w5 and a filler at w3
  const out: Word[] = [];
  let t = 0.5;
  for (let i = 0; i < 10; i++) {
    const text = i === 3 ? 'えーと' : `word${i}`;
    out.push({ id: `w${i}`, text, t0: t, t1: t + 0.8, p: 0.9 });
    t += i === 5 ? 3 : 1;
  }
  return out;
}

describe('removeSourceRange', () => {
  it('splits a clip and ripples downstream', () => {
    const m = removeSourceRange(manifest(), 's1', 10, 20);
    expect(m.timeline.video).toHaveLength(2);
    expect(m.timeline.video[0]).toMatchObject({ srcIn: 0, srcOut: 10 });
    expect(m.timeline.video[1]).toMatchObject({ srcIn: 20, srcOut: 60 });
    expect(timelineDuration(m)).toBeCloseTo(50);
    const segs = segments(m);
    expect(segs[1].tlStart).toBeCloseTo(10);
    expect(segs[1].srcStart).toBeCloseTo(20);
  });

  it('trims edges and drops fully covered clips', () => {
    let m = removeSourceRange(manifest(), 's1', 0, 5);
    expect(m.timeline.video[0]).toMatchObject({ srcIn: 5, srcOut: 60 });
    m = removeSourceRange(m, 's1', 5, 60);
    expect(m.timeline.video).toHaveLength(0);
  });

  it('removing across an existing cut removes from both remaining clips', () => {
    let m = removeSourceRange(manifest(), 's1', 10, 20);
    m = removeSourceRange(m, 's1', 5, 25);
    expect(m.timeline.video).toHaveLength(2);
    expect(m.timeline.video[0]).toMatchObject({ srcIn: 0, srcOut: 5 });
    expect(m.timeline.video[1]).toMatchObject({ srcIn: 25, srcOut: 60 });
  });

  it('snaps to the frame grid', () => {
    const m = removeSourceRange(manifest(), 's1', 10.0001, 20.0166);
    expect(m.timeline.video[0].srcOut).toBeCloseTo(10, 5);
    expect(m.timeline.video[1].srcIn).toBeCloseTo(Math.round(20.0166 * 30) / 30, 5);
  });
});

describe('word helpers', () => {
  it('expands ranges and maps to time', () => {
    const w = words();
    const ids = expandWordIds(['w2..w4'], w);
    expect(ids).toEqual(['w2', 'w3', 'w4']);
    const r = wordRange(w, ids);
    expect(r.t0).toBeCloseTo(2.5);
    expect(r.t1).toBeCloseTo(5.3);
  });

  it('keptWords drops words under cuts', () => {
    const w = words();
    const m = removeSourceRange(manifest(), 's1', 2, 6);
    const kept = keptWords(m, 's1', w);
    expect(kept.map((x) => x.id)).toEqual(['w0', 'w1', 'w6', 'w7', 'w8', 'w9']);
  });

  it('sourceTimeToTimeline maps around cuts', () => {
    const m = removeSourceRange(manifest(), 's1', 10, 20);
    expect(sourceTimeToTimeline(m, 's1', 5)).toBeCloseTo(5);
    expect(sourceTimeToTimeline(m, 's1', 15)).toBeNull();
    expect(sourceTimeToTimeline(m, 's1', 25)).toBeCloseTo(15);
  });
});

describe('trimClip', () => {
  it('moves edges by frames, clamped', () => {
    let m = trimClip(manifest(), 'c1', 'in', 30); // +1s
    expect(m.timeline.video[0].srcIn).toBeCloseTo(1);
    m = trimClip(m, 'c1', 'out', -60); // -2s
    expect(m.timeline.video[0].srcOut).toBeCloseTo(58);
    m = trimClip(m, 'c1', 'out', 999999);
    expect(m.timeline.video[0].srcOut).toBeCloseTo(60); // clamped to source duration
  });

  it('throws on unknown clip', () => {
    expect(() => trimClip(manifest(), 'nope', 'in', 1)).toThrow(/unknown clip/);
  });

  it('rejects an edge that is not exactly "in" or "out"', () => {
    expect(() => trimClip(manifest(), 'c1', 'left' as any, 1)).toThrow(/invalid edge/);
    expect(() => trimClip(manifest(), 'c1', 'IN' as any, 1)).toThrow(/invalid edge/);
  });

  it('rejects non-integer or non-finite frames', () => {
    expect(() => trimClip(manifest(), 'c1', 'in', 1.5)).toThrow(/invalid frames/);
    expect(() => trimClip(manifest(), 'c1', 'in', NaN)).toThrow(/invalid frames/);
    expect(() => trimClip(manifest(), 'c1', 'in', Infinity)).toThrow(/invalid frames/);
  });
});

describe('detection', () => {
  const t: Transcript = { sourceId: 's1', language: 'ja', words: words() };
  it('finds the long gap', () => {
    const silences = detectSilences(t, 0.7);
    expect(silences.some((c) => c.t0 > 6 && c.t1 < 9)).toBe(true);
  });
  it('finds standalone fillers', () => {
    const fillers = detectFillers(t);
    expect(fillers).toHaveLength(1);
    expect(fillers[0].wordIds).toEqual(['w3']);
  });
});

describe('padWordRange', () => {
  const w = words(); // 10 words, 1s each, 0.8s speech + 0.2s gap, big gap after w5

  it('widens the range by pad on both sides', () => {
    const ids = ['w2'];
    const r = wordRange(w, ids); // t0=2.5, t1=3.3
    const padded = padWordRange(w, ids, r, 0.08);
    expect(padded.t0).toBeCloseTo(2.42);
    expect(padded.t1).toBeCloseTo(3.38);
  });

  it('clamps to the neighboring surviving word instead of biting into it', () => {
    // words are spaced 0.2s apart, so a 0.08 pad fits; a much larger pad
    // must not intrude past the previous/next word's boundary.
    const ids = ['w2'];
    const r = wordRange(w, ids);
    const padded = padWordRange(w, ids, r, 5);
    const prev = w.find((x) => x.id === 'w1')!;
    const next = w.find((x) => x.id === 'w3')!;
    expect(padded.t0).toBeCloseTo(prev.t1);
    expect(padded.t1).toBeCloseTo(next.t0);
  });

  it('pad is effectively zero when already flush against a neighbor', () => {
    const flush: Word[] = [
      { id: 'a', text: 'x', t0: 0, t1: 1, p: 1 },
      { id: 'b', text: 'y', t0: 1, t1: 2, p: 1 },
      { id: 'c', text: 'z', t0: 2, t1: 3, p: 1 },
    ];
    const padded = padWordRange(flush, ['b'], { t0: 1, t1: 2 }, 0.5);
    expect(padded.t0).toBeCloseTo(1);
    expect(padded.t1).toBeCloseTo(2);
  });
});

describe('detectSilencesFromPeaks', () => {
  it('finds a quiet stretch at the given threshold/minGap', () => {
    // 25 samples/sec: 1s loud, 2s quiet, 1s loud
    const rate = 25;
    const peaks: number[] = [
      ...Array(rate).fill(0.5),
      ...Array(rate * 2).fill(0.01),
      ...Array(rate).fill(0.5),
    ];
    const cands = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1' });
    expect(cands).toHaveLength(1);
    expect(cands[0].t0).toBeGreaterThan(1);
    expect(cands[0].t1).toBeLessThan(3);
    expect(cands[0].t1 - cands[0].t0).toBeGreaterThan(1.5);
  });

  it('ignores quiet stretches shorter than minGap', () => {
    const rate = 25;
    const peaks: number[] = [...Array(rate).fill(0.5), ...Array(Math.round(rate * 0.3)).fill(0.01), ...Array(rate).fill(0.5)];
    const cands = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', minGap: 0.7 });
    expect(cands).toHaveLength(0);
  });

  it('shrinks a candidate to word boundaries so it never cuts into speech', () => {
    const rate = 25;
    // 3s of quiet waveform, but the transcript says there's a word from 1..2s
    // in the middle of it (e.g. very soft speech).
    const peaks: number[] = Array(rate * 3).fill(0.01);
    const words: Word[] = [{ id: 'w0', text: 'hi', t0: 1, t1: 2, p: 0.9 }];
    const cands = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', words, pad: 0 });
    for (const c of cands) {
      expect(c.t1 <= 1 || c.t0 >= 2).toBe(true);
    }
  });
});

describe('Project store', () => {
  it('commit bumps revision, rejects stale base, restore works', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-'));
    const p = await Project.create(path.join(dir, 'proj'), 'test');
    let m = await p.manifest();
    expect(m.revision).toBe(0);

    m = await p.commit(0, 'claude', 'test-op', {}, 'noop', (x) => x);
    expect(m.revision).toBe(1);

    await expect(p.commit(0, 'claude', 'test-op', {}, 'stale', (x) => x)).rejects.toThrow(/stale/);

    m = await p.commit(1, 'ui', 'test-op2', {}, 'noop2', (x) => ({ ...x, name: 'changed' }));
    expect(m.name).toBe('changed');

    m = await p.restore(1, 'claude', 2); // baseRev is required and checked like commit()
    expect(m.name).toBe('test');
    expect(m.revision).toBe(3); // restore is itself a new revision

    const revs = await p.revisions();
    expect(revs.map((r) => r.rev)).toEqual([1, 2, 3]);
  });

  it('rejects sourceId/motion ids containing path separators or traversal segments', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-'));
    const p = await Project.create(path.join(dir, 'proj'), 'test');

    // The classic disguised-traversal payload: embedding ".." past a
    // prefix like "scenes-" or "transcript-" still escapes path.join once
    // enough ".." segments are present, so the character-class check must
    // reject "/" outright rather than trying to out-think path.normalize.
    const attacks = ['../../../../etc/passwd', 'x/../../secret', '..', 'a/b', ''];
    for (const bad of attacks) {
      expect(() => p.transcriptPath(bad)).toThrow(/invalid source id/);
      expect(() => p.scenesPath(bad)).toThrow(/invalid source id/);
      expect(() => p.motionSpecPath(bad)).toThrow(/invalid motion id/);
    }
    // A normal generated id is unaffected.
    expect(p.transcriptPath('s1')).toContain('transcript-s1.json');
    expect(p.scenesPath('s1')).toContain('scenes-s1.json');
    expect(p.motionSpecPath('mo123')).toContain(path.join('motion', 'mo123.json'));
  });

  it('resolveWithinDir rejects a relative path that escapes the base directory', async () => {
    const { resolveWithinDir } = await import('./project.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'vedit-'));
    await expect(resolveWithinDir(dir, '../secret.mp4')).rejects.toThrow(/escapes directory/);
    await expect(resolveWithinDir(dir, 'cache/../../secret.mp4')).rejects.toThrow(/escapes directory/);
    await expect(resolveWithinDir(dir, 'cache/ok.mp4')).resolves.toContain(path.join('cache', 'ok.mp4'));
  });
});

describe('adaptiveThreshold', () => {
  it('sits between the noise floor and speech level of quiet footage', async () => {
    const { adaptiveThreshold } = await import('./detect.js');
    // Quiet outdoor clip: floor ~0.03, speech peaks ~0.1 (real DJI distribution)
    const peaks = [
      ...Array(300).fill(0.03),
      ...Array(80).fill(0.05),
      ...Array(40).fill(0.1),
    ];
    const th = adaptiveThreshold(peaks);
    expect(th).toBeGreaterThan(0.03);
    expect(th).toBeLessThan(0.1);
  });
  it('clamps to a sane range on extreme inputs', async () => {
    const { adaptiveThreshold } = await import('./detect.js');
    expect(adaptiveThreshold(Array(100).fill(0.9))).toBeLessThanOrEqual(0.12);
    expect(adaptiveThreshold(Array(100).fill(0))).toBeGreaterThanOrEqual(0.02);
  });
});

describe('timestampsArePacked', () => {
  it('detects back-to-back fabricated timing and lets waveform win', async () => {
    const { timestampsArePacked, detectSilencesFromPeaks } = await import('./detect.js');
    // 10 words packed with zero gaps over 0..5s
    const packed = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`, text: 'x', t0: i * 0.5, t1: (i + 1) * 0.5, p: 0.9,
    }));
    expect(timestampsArePacked(packed)).toBe(true);
    // waveform says 1..3s is quiet; packed words must not veto it
    const rate = 25;
    const peaks = [...Array(rate).fill(0.5), ...Array(rate * 2).fill(0.01), ...Array(rate * 2).fill(0.5)];
    const cands = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', words: packed });
    expect(cands.length).toBe(1);
    expect(cands[0].label).toContain('transcript disagrees');
  });
  it('healthy transcripts still clamp', async () => {
    const { timestampsArePacked } = await import('./detect.js');
    const healthy = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`, text: 'x', t0: i * 0.6, t1: i * 0.6 + 0.4, p: 0.9,
    }));
    expect(timestampsArePacked(healthy)).toBe(false);
  });
});

describe('addClip / removeClip / moveClip', () => {
  it('addClip defaults to the full source, appended at the end', () => {
    const m = addClip(manifest(), 's1', {});
    expect(m.timeline.video).toHaveLength(2);
    expect(m.timeline.video[1]).toMatchObject({ sourceId: 's1', srcIn: 0, srcOut: 60 });
  });

  it('addClip honors in/out/at and rejects an empty range', () => {
    const m = addClip(manifest(), 's1', { in: 5, out: 15, at: 0 });
    expect(m.timeline.video).toHaveLength(2);
    expect(m.timeline.video[0]).toMatchObject({ sourceId: 's1', srcIn: 5, srcOut: 15 });
    expect(() => addClip(manifest(), 's1', { in: 10, out: 10 })).toThrow(/out .* must be greater than in/);
  });

  it('addClip rejects an unknown source', () => {
    expect(() => addClip(manifest(), 'nope', {})).toThrow(/unknown source/);
  });

  it('removeClip drops the clip but leaves the source pool untouched', () => {
    const m = removeClip(manifest(), 'c1');
    expect(m.timeline.video).toHaveLength(0);
    expect(m.sources).toHaveLength(1);
  });

  it('removeClip throws on an unknown clip', () => {
    expect(() => removeClip(manifest(), 'nope')).toThrow(/unknown clip/);
  });

  it('moveClip reorders relative to another clip, or to the end', () => {
    let m = addClip(manifest(), 's1', { in: 0, out: 10 }); // c1, c2(new)
    const newId = m.timeline.video[1].id;
    m = moveClip(m, newId, 'c1');
    expect(m.timeline.video.map((c) => c.id)).toEqual([newId, 'c1']);
    m = moveClip(m, newId, 'end');
    expect(m.timeline.video.map((c) => c.id)).toEqual(['c1', newId]);
  });

  it('moveClip throws on an unknown clip or target', () => {
    expect(() => moveClip(manifest(), 'nope', 'end')).toThrow(/unknown clip/);
    expect(() => moveClip(manifest(), 'c1', 'nope')).toThrow(/unknown clip/);
  });

  it('addClip rejects non-finite in/out', () => {
    expect(() => addClip(manifest(), 's1', { in: NaN, out: 10 })).toThrow(/finite/);
    expect(() => addClip(manifest(), 's1', { in: 0, out: Infinity })).toThrow(/finite/);
  });

  it('addClip rejects a negative in', () => {
    expect(() => addClip(manifest(), 's1', { in: -1, out: 10 })).toThrow(/in \(-1\) must be >= 0/);
  });

  it('addClip rejects an out beyond the source duration', () => {
    expect(() => addClip(manifest(), 's1', { in: 0, out: 61 })).toThrow(/exceeds source duration/);
  });

  it('addClip rejects a duplicate clip id', () => {
    expect(() => addClip(manifest(), 's1', { id: 'c1' })).toThrow(/clip id already exists: c1/);
  });

  it('addClip rejects a non-integer or out-of-range at', () => {
    expect(() => addClip(manifest(), 's1', { at: 0.5 })).toThrow(/at \(0\.5\)/);
    expect(() => addClip(manifest(), 's1', { at: -1 })).toThrow(/at \(-1\)/);
    expect(() => addClip(manifest(), 's1', { at: 99 })).toThrow(/at \(99\)/);
  });
});

describe('reframe / crop', () => {
  it('parseReframeSpec maps the common shorthands to conventional pixel sizes', () => {
    expect(parseReframeSpec('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(parseReframeSpec('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(parseReframeSpec('16:9')).toEqual({ width: 1920, height: 1080 });
  });

  it('parseReframeSpec accepts a literal WxH', () => {
    expect(parseReframeSpec('1080x1350')).toEqual({ width: 1080, height: 1350 });
  });

  it('parseReframeSpec rejects garbage', () => {
    expect(() => parseReframeSpec('vertical')).toThrow(/invalid reframe spec/);
  });

  it('parseReframeSpec rejects a zero literal dimension', () => {
    expect(() => parseReframeSpec('0x1080')).toThrow(/invalid reframe spec/);
    expect(() => parseReframeSpec('1080x0')).toThrow(/invalid reframe spec/);
  });

  it('parseReframeSpec rejects a zero ratio part (would otherwise divide by zero into NaN/Infinity)', () => {
    expect(() => parseReframeSpec('0:16')).toThrow(/invalid reframe spec/);
    expect(() => parseReframeSpec('16:0')).toThrow(/invalid reframe spec/);
  });

  it('parseReframeSpec normalizes odd literal dimensions to the nearest even pixel count', () => {
    expect(parseReframeSpec('1081x1351')).toEqual({ width: 1082, height: 1352 });
  });

  it('parseFocus maps mnemonics and clamps numeric input', () => {
    expect(parseFocus(undefined)).toBe(0.5);
    expect(parseFocus('left')).toBe(0);
    expect(parseFocus('center')).toBe(0.5);
    expect(parseFocus('right')).toBe(1);
    expect(parseFocus('0.3')).toBeCloseTo(0.3);
    expect(parseFocus(5)).toBe(1); // clamped
    expect(() => parseFocus('sideways')).toThrow(/invalid focus/);
  });

  it('cropWindow crops width for a landscape source going to a portrait output', () => {
    const win = cropWindow(1920, 1080, 1080, 1920);
    expect(win.axis).toBe('x');
    expect(win.height).toBe(1080);
    expect(win.width).toBeLessThan(1920);
    expect(win.width).toBeCloseTo(1080 * (1080 / 1920), -1); // rounded to an even pixel count
  });

  it('cropWindow crops height for a portrait source going to a landscape output', () => {
    const win = cropWindow(1080, 1920, 1920, 1080);
    expect(win.axis).toBe('y');
    expect(win.width).toBe(1080);
    expect(win.height).toBeLessThan(1920);
  });

  it('cropWindow needs no crop when aspects already match', () => {
    const win = cropWindow(1920, 1080, 1920, 1080);
    expect(win).toEqual({ width: 1920, height: 1080, axis: 'none' });
  });

  it('cropOffset positions the window within the available slack, clamped to 0..1', () => {
    expect(cropOffset(1920, 1080, 0)).toBe(0);
    expect(cropOffset(1920, 1080, 1)).toBe(1920 - 1080);
    expect(cropOffset(1920, 1080, 0.5)).toBeCloseTo((1920 - 1080) / 2, 0);
    expect(cropOffset(1920, 1080, -1)).toBe(0); // clamped
  });

  it('cropGeometry is null when no crop is needed, else combines window + offset', () => {
    expect(cropGeometry(1920, 1080, 1920, 1080, undefined)).toBeNull();
    const geo = cropGeometry(1920, 1080, 1080, 1920, { x: 0 });
    expect(geo).not.toBeNull();
    expect(geo!.x).toBe(0);
    expect(geo!.height).toBe(1080);
  });

  it('applyReframe sets output and stamps the same focus onto every clip', () => {
    let m = addClip(manifest(), 's1', {}); // two clips now
    m = applyReframe(m, { width: 1080, height: 1920 }, 0);
    expect(m.output).toEqual({ width: 1080, height: 1920 });
    expect(m.timeline.video.every((c) => c.crop?.x === 0 && c.crop?.y === 0)).toBe(true);
  });

  it('setClipCrop patches one clip without touching others', () => {
    let m = addClip(manifest(), 's1', {});
    const [c1, c2] = m.timeline.video;
    m = setClipCrop(m, c1.id, { x: 0.2 });
    expect(m.timeline.video[0].crop).toEqual({ x: 0.2 });
    expect(m.timeline.video[1].crop).toBeUndefined();
    m = setClipCrop(m, c1.id, { y: 0.8 });
    expect(m.timeline.video[0].crop).toEqual({ x: 0.2, y: 0.8 }); // merges, doesn't clobber x
  });

  it('setClipCrop throws on an unknown clip', () => {
    expect(() => setClipCrop(manifest(), 'nope', { x: 0 })).toThrow(/unknown clip/);
  });

  it('setClipCrop rejects an out-of-range or non-finite x/y', () => {
    expect(() => setClipCrop(manifest(), 'c1', { x: 1.5 })).toThrow(/x \(1\.5\)/);
    expect(() => setClipCrop(manifest(), 'c1', { x: -0.1 })).toThrow(/x \(-0\.1\)/);
    expect(() => setClipCrop(manifest(), 'c1', { y: NaN })).toThrow(/y \(NaN\)/);
    expect(() => setClipCrop(manifest(), 'c1', { y: Infinity })).toThrow(/y \(Infinity\)/);
  });
});

describe('background music (wave I)', () => {
  it('addMusic fills in defaults (gain -12, fadeIn 1, fadeOut 2, duck true, at/src-in 0)', () => {
    const m = addMusic(manifest(), '/bgm.mp3', { duration: 10 });
    expect(m.timeline.music).toHaveLength(1);
    const mu = m.timeline.music![0];
    expect(mu).toMatchObject({ path: '/bgm.mp3', tlStart: 0, duration: 10, srcIn: 0, gain: -12, fadeIn: 1, fadeOut: 2, duck: true });
    expect(mu.id).toMatch(/^mu/);
  });

  it('addMusic honors explicit fields and a caller-supplied id', () => {
    const m = addMusic(manifest(), '/bgm.mp3', {
      id: 'mu1', tlStart: 5, duration: 8, srcIn: 2, gain: -6, fadeIn: 0.5, fadeOut: 0.5, duck: false,
    });
    expect(m.timeline.music![0]).toEqual({ id: 'mu1', path: '/bgm.mp3', tlStart: 5, duration: 8, srcIn: 2, gain: -6, fadeIn: 0.5, fadeOut: 0.5, duck: false });
  });

  it('addMusic appends without disturbing existing items', () => {
    let m = addMusic(manifest(), '/a.mp3', { id: 'mu1', duration: 5 });
    m = addMusic(m, '/b.mp3', { id: 'mu2', duration: 5, tlStart: 10 });
    expect(m.timeline.music!.map((x) => x.id)).toEqual(['mu1', 'mu2']);
  });

  it('addMusic rejects a duplicate id, non-positive duration, and out-of-range gain', () => {
    expect(() => addMusic(manifest(), '/a.mp3', { id: 'mu1', duration: 5 })).not.toThrow();
    const m = addMusic(manifest(), '/a.mp3', { id: 'mu1', duration: 5 });
    expect(() => addMusic(m, '/b.mp3', { id: 'mu1', duration: 5 })).toThrow(/id already exists/);
    expect(() => addMusic(manifest(), '/a.mp3', { duration: 0 })).toThrow(/duration/);
    expect(() => addMusic(manifest(), '/a.mp3', { duration: 5, gain: 13 })).toThrow(/gain/);
    expect(() => addMusic(manifest(), '/a.mp3', { duration: 5, gain: -61 })).toThrow(/gain/);
    expect(() => addMusic(manifest(), '/a.mp3', { duration: 5, tlStart: -1 })).toThrow(/at/);
  });

  it('updateMusic patches only the given fields, leaving path/id and the rest untouched', () => {
    let m = addMusic(manifest(), '/a.mp3', { id: 'mu1', duration: 5, gain: -12 });
    m = updateMusic(m, 'mu1', { gain: -6 });
    const mu = m.timeline.music![0];
    expect(mu.gain).toBe(-6);
    expect(mu.path).toBe('/a.mp3');
    expect(mu.duration).toBe(5);
    expect(mu.duck).toBe(true);
  });

  it('updateMusic rejects an unknown id and out-of-range values', () => {
    const m = addMusic(manifest(), '/a.mp3', { id: 'mu1', duration: 5 });
    expect(() => updateMusic(m, 'nope', { gain: -6 })).toThrow(/unknown music item/);
    expect(() => updateMusic(m, 'mu1', { gain: 100 })).toThrow(/gain/);
    expect(() => updateMusic(m, 'mu1', { duration: -1 })).toThrow(/duration/);
    expect(() => updateMusic(m, 'mu1', { fadeIn: -1 })).toThrow(/fade-in/);
  });

  it('removeMusic drops the item; unknown id throws', () => {
    let m = addMusic(manifest(), '/a.mp3', { id: 'mu1', duration: 5 });
    m = addMusic(m, '/b.mp3', { id: 'mu2', duration: 5 });
    m = removeMusic(m, 'mu1');
    expect(m.timeline.music!.map((x) => x.id)).toEqual(['mu2']);
    expect(() => removeMusic(m, 'mu1')).toThrow(/unknown music item/);
  });

  it('setAudioMix defaults to an empty object and merges patches without clobbering unset fields', () => {
    let m = setAudioMix(manifest(), { targetLufs: -16 });
    expect(m.audioMix).toEqual({ targetLufs: -16 });
    m = setAudioMix(m, { duckAmount: -8 });
    expect(m.audioMix).toEqual({ targetLufs: -16, duckAmount: -8 });
  });

  it('setAudioMix rejects out-of-range values', () => {
    expect(() => setAudioMix(manifest(), { targetLufs: 0 })).toThrow(/targetLufs/);
    expect(() => setAudioMix(manifest(), { duckAmount: 5 })).toThrow(/duckAmount/);
    expect(() => setAudioMix(manifest(), { crossfadeMs: -1 })).toThrow(/crossfadeMs/);
    expect(() => setAudioMix(manifest(), { crossfadeMs: 2000 })).toThrow(/crossfadeMs/);
  });
});

// ---- W1: audio-repair setting ----

describe('setAudioRepair', () => {
  it('accepts each valid preset and stores it verbatim', () => {
    for (const preset of ['outdoor', 'indoor', 'wireless', 'off']) {
      const m = setAudioRepair(manifest(), { preset });
      expect(m.audioRepair).toEqual({ preset });
    }
  });

  it('carries deess through only when explicitly given', () => {
    let m = setAudioRepair(manifest(), { preset: 'outdoor', deess: true });
    expect(m.audioRepair).toEqual({ preset: 'outdoor', deess: true });
    m = setAudioRepair(manifest(), { preset: 'outdoor' });
    expect(m.audioRepair).toEqual({ preset: 'outdoor' });
  });

  it('rejects an unknown preset', () => {
    expect(() => setAudioRepair(manifest(), { preset: 'studio' })).toThrow(/outdoor\/indoor\/wireless\/off/);
  });
});

// ---- W1: color metadata / Log-HLG detection ----

describe('needsColorTransform', () => {
  it('returns false when color metadata is absent entirely', () => {
    expect(needsColorTransform(undefined)).toBe(false);
  });

  it('returns false for known-SDR transfer curves (bt709/srgb)', () => {
    expect(needsColorTransform({ transfer: 'bt709' })).toBe(false);
    expect(needsColorTransform({ transfer: 'srgb' })).toBe(false);
    expect(needsColorTransform({ transfer: 'bt709', primaries: 'bt709' })).toBe(false);
  });

  it('flags an explicit HLG/PQ/log transfer curve regardless of primaries', () => {
    expect(needsColorTransform({ transfer: 'arib-std-b67' })).toBe(true); // HLG
    expect(needsColorTransform({ transfer: 'smpte2084' })).toBe(true); // PQ
    expect(needsColorTransform({ transfer: 'log100' })).toBe(true);
  });

  it('flags an untagged/"unknown" transfer paired with bt2020 primaries (e.g. DJI D-Log)', () => {
    expect(needsColorTransform({ transfer: 'unknown', primaries: 'bt2020' })).toBe(true);
    expect(needsColorTransform({ primaries: 'bt2020' })).toBe(true); // transfer absent entirely
  });

  it('does not flag an untagged transfer without bt2020 primaries', () => {
    expect(needsColorTransform({ transfer: 'unknown', primaries: 'bt709' })).toBe(false);
    expect(needsColorTransform({})).toBe(false);
    expect(needsColorTransform({ bitDepth: 10 })).toBe(false);
  });

  it('exposes a stable warning message constant', () => {
    expect(COLOR_WARNING_MESSAGE).toMatch(/Log\/HLG/);
  });
});

// ---- W5: input color transform (setColorTransform) ----

describe('setColorTransform', () => {
  it('rejects an unknown source', () => {
    expect(() => setColorTransform(manifest(), 'nope', { type: 'hlg' })).toThrow(/unknown source/);
  });

  it('rejects an unrecognized type', () => {
    expect(() => setColorTransform(manifest(), 's1', { type: 'dlog' })).toThrow(/hlg\/pq\/lut\/none/);
  });

  it('sets hlg/pq/none without a lut path', () => {
    const m = setColorTransform(manifest(), 's1', { type: 'hlg' });
    expect(m.sources[0].colorTransform).toEqual({ type: 'hlg' });
    const m2 = setColorTransform(manifest(), 's1', { type: 'none' });
    expect(m2.sources[0].colorTransform).toEqual({ type: 'none' });
  });

  it('rejects type "lut" without a lut path', () => {
    expect(() => setColorTransform(manifest(), 's1', { type: 'lut' })).toThrow(/--lut/);
  });

  it('sets type "lut" with a lut path, leaving other sources untouched', () => {
    const m = setColorTransform(manifest(), 's1', { type: 'lut', lut: '/luts/dlog.cube' });
    expect(m.sources[0].colorTransform).toEqual({ type: 'lut', lut: '/luts/dlog.cube' });
  });

  it('overwrites a previously-set transform rather than merging', () => {
    let m = setColorTransform(manifest(), 's1', { type: 'lut', lut: '/luts/a.cube' });
    m = setColorTransform(m, 's1', { type: 'hlg' });
    expect(m.sources[0].colorTransform).toEqual({ type: 'hlg' });
  });
});

// ---- W5: per-source color adjust (setColorAdjust) ----

describe('setColorAdjust', () => {
  it('rejects an unknown source', () => {
    expect(() => setColorAdjust(manifest(), 'nope', { exposure: 0.5 })).toThrow(/unknown source/);
  });

  it('rejects out-of-range exposure/wb/sat', () => {
    expect(() => setColorAdjust(manifest(), 's1', { exposure: 3 })).toThrow(/exposure/);
    expect(() => setColorAdjust(manifest(), 's1', { exposure: -3 })).toThrow(/exposure/);
    expect(() => setColorAdjust(manifest(), 's1', { wb: 150 })).toThrow(/wb/);
    expect(() => setColorAdjust(manifest(), 's1', { sat: -0.1 })).toThrow(/sat/);
    expect(() => setColorAdjust(manifest(), 's1', { sat: 2.5 })).toThrow(/sat/);
  });

  it('accepts boundary values', () => {
    const m = setColorAdjust(manifest(), 's1', { exposure: -2, wb: -100, sat: 0 });
    expect(m.colorAdjust).toEqual({ s1: { exposure: -2, wb: -100, sat: 0 } });
    const m2 = setColorAdjust(manifest(), 's1', { exposure: 2, wb: 100, sat: 2 });
    expect(m2.colorAdjust).toEqual({ s1: { exposure: 2, wb: 100, sat: 2 } });
  });

  it('merges a partial patch onto an existing entry without clobbering unset fields', () => {
    let m = setColorAdjust(manifest(), 's1', { exposure: 0.3 });
    m = setColorAdjust(m, 's1', { wb: -10 });
    expect(m.colorAdjust).toEqual({ s1: { exposure: 0.3, wb: -10 } });
  });

  it('prunes the per-source entry down to only the fields that were actually set (no undefined keys)', () => {
    const m = setColorAdjust(manifest(), 's1', { sat: 1.1 });
    expect(Object.keys(m.colorAdjust!.s1)).toEqual(['sat']);
  });

  it('an empty patch prunes the per-source entry down to nothing (same pattern as setSceneReview\'s culling map)', () => {
    const m = setColorAdjust(manifest(), 's1', {});
    expect(m.colorAdjust).toEqual({});
  });
});

// ---- W2: scene culling (3-state review + selects timeline) ----

function twoSourceManifest(): Manifest {
  const m = manifest();
  return {
    ...m,
    sources: [
      ...m.sources,
      { id: 's2', path: '/y.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
    ],
  };
}

function sceneFiles(): SceneFile[] {
  return [
    {
      sourceId: 's1',
      scenes: [
        { id: 'sc1', t0: 0, t1: 5, thumb: 'cache/sc-s1-sc1.jpg', hasSpeech: false, energy: 0.1 },
        { id: 'sc2', t0: 5, t1: 10, thumb: 'cache/sc-s1-sc2.jpg', hasSpeech: false, energy: 0.2 },
        { id: 'sc3', t0: 10, t1: 15, thumb: 'cache/sc-s1-sc3.jpg', hasSpeech: true, energy: 0.3 },
      ],
    },
    {
      sourceId: 's2',
      scenes: [
        { id: 'sc1', t0: 0, t1: 8, thumb: 'cache/sc-s2-sc1.jpg', hasSpeech: false, energy: 0.4 },
      ],
    },
  ];
}

describe('setSceneReview', () => {
  it('records a keep/reject verdict under manifest.culling[sourceId][sceneId]', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    expect(m.culling).toEqual({ s1: { sc1: 'keep' } });
    m = setSceneReview(m, 's1', 'sc2', 'reject');
    expect(m.culling).toEqual({ s1: { sc1: 'keep', sc2: 'reject' } });
  });

  it('overwrites an existing verdict for the same scene', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    m = setSceneReview(m, 's1', 'sc1', 'reject');
    expect(m.culling).toEqual({ s1: { sc1: 'reject' } });
  });

  it('"clear" removes the entry, pruning an emptied source/manifest map entirely', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    m = setSceneReview(m, 's1', 'sc1', 'clear');
    expect(m.culling).toEqual({});
  });

  it('keeps per-source maps independent', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    m = setSceneReview(m, 's2', 'sc1', 'reject');
    expect(m.culling).toEqual({ s1: { sc1: 'keep' }, s2: { sc1: 'reject' } });
  });

  it('rejects an unknown source', () => {
    expect(() => setSceneReview(manifest(), 'nope', 'sc1', 'keep')).toThrow(/unknown source/);
  });

  it('rejects an invalid review value', () => {
    expect(() => setSceneReview(manifest(), 's1', 'sc1', 'maybe' as any)).toThrow(/must be "keep", "reject", or "clear"/);
  });

  it('does not mutate the input manifest (pure)', () => {
    const m = twoSourceManifest();
    const before = JSON.stringify(m);
    setSceneReview(m, 's1', 'sc1', 'keep');
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe('cullingStats', () => {
  it('tallies keep/reject/unreviewed per source and overall, for an unculled manifest', () => {
    const m = twoSourceManifest();
    const stats = cullingStats(m, sceneFiles());
    expect(stats.perSource).toEqual([
      { sourceId: 's1', total: 3, keep: 0, reject: 0, unreviewed: 3 },
      { sourceId: 's2', total: 1, keep: 0, reject: 0, unreviewed: 1 },
    ]);
    expect(stats.totals).toEqual({ total: 4, keep: 0, reject: 0, unreviewed: 4 });
  });

  it('reflects keep/reject verdicts recorded on the manifest', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    m = setSceneReview(m, 's1', 'sc2', 'reject');
    m = setSceneReview(m, 's2', 'sc1', 'keep');
    const stats = cullingStats(m, sceneFiles());
    expect(stats.perSource).toEqual([
      { sourceId: 's1', total: 3, keep: 1, reject: 1, unreviewed: 1 },
      { sourceId: 's2', total: 1, keep: 1, reject: 0, unreviewed: 0 },
    ]);
    expect(stats.totals).toEqual({ total: 4, keep: 2, reject: 1, unreviewed: 1 });
  });

  it('returns all-zero stats for an empty sceneFiles list', () => {
    expect(cullingStats(twoSourceManifest(), [])).toEqual({ perSource: [], totals: { total: 0, keep: 0, reject: 0, unreviewed: 0 } });
  });
});

describe('buildSelectsTimeline', () => {
  it('returns only "keep" scenes, in scene-file order (source order, then detection order within a source)', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    m = setSceneReview(m, 's1', 'sc3', 'keep');
    m = setSceneReview(m, 's2', 'sc1', 'keep');
    const video = buildSelectsTimeline(m, sceneFiles());
    expect(video.map((c) => [c.sourceId, c.srcIn, c.srcOut])).toEqual([
      ['s1', 0, 5],
      ['s1', 10, 15],
      ['s2', 0, 8],
    ]);
    for (const c of video) expect(typeof c.id).toBe('string');
    // Fresh, distinct clip ids (not scene ids) — freshId() throughout ops.ts.
    expect(new Set(video.map((c) => c.id)).size).toBe(video.length);
  });

  it('excludes rejected and unreviewed scenes', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'reject');
    m = setSceneReview(m, 's1', 'sc2', 'keep');
    // sc3 left unreviewed, s2/sc1 left unreviewed.
    const video = buildSelectsTimeline(m, sceneFiles());
    expect(video.map((c) => [c.sourceId, c.srcIn, c.srcOut])).toEqual([['s1', 5, 10]]);
  });

  it('returns an empty array when nothing is marked keep', () => {
    expect(buildSelectsTimeline(twoSourceManifest(), sceneFiles())).toEqual([]);
  });

  it('does not touch m.timeline.video — it only returns a candidate replacement', () => {
    let m = twoSourceManifest();
    m = setSceneReview(m, 's1', 'sc1', 'keep');
    const before = JSON.stringify(m.timeline.video);
    buildSelectsTimeline(m, sceneFiles());
    expect(JSON.stringify(m.timeline.video)).toBe(before);
  });
});

// ---- W3: B-roll V2 overlay track ----

describe('timelineTimeToSource', () => {
  // A-roll (s1) with a cut in the middle: tl[0,10) <- src[0,10), tl[10,20) <- src[20,30).
  function m(): Manifest {
    const base = manifest();
    return {
      ...base,
      timeline: {
        ...base.timeline,
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
      },
    };
  }

  it('is the exact inverse of sourceTimeToTimeline across a cut', () => {
    const r = timelineTimeToSource(m(), 15);
    expect(r).toEqual({ sourceId: 's1', srcTime: 25 });
    expect(sourceTimeToTimeline(m(), r.sourceId, r.srcTime)).toBeCloseTo(15);
  });

  it('returns null past the end of the timeline', () => {
    expect(timelineTimeToSource(m(), 20)).toBeNull();
    expect(timelineTimeToSource(m(), -1)).toBeNull();
  });
});

describe('B-roll V2 overlays (addOverlay / updateOverlay / removeOverlay)', () => {
  // s1 = A-roll with a cut: tl[0,10) <- src[0,10), tl[10,20) <- src[20,30).
  // s2 = B-roll source, off-timeline (pure overlay material).
  function m(): Manifest {
    const base = manifest();
    return {
      ...base,
      sources: [
        ...base.sources,
        { id: 's2', path: '/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: {
        ...base.timeline,
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
      },
    };
  }

  it('addOverlay defaults audioMode to mute and stores no gainDb when omitted', () => {
    const r = addOverlay(m(), 's2', { srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } });
    expect(r.timeline.overlays).toHaveLength(1);
    const ov = r.timeline.overlays[0];
    expect(ov).toMatchObject({ sourceId: 's2', srcIn: 0, srcOut: 4, audioMode: 'mute', anchor: { sourceId: 's1', srcTime: 2 } });
    expect(ov.gainDb).toBeUndefined();
    expect(ov.id).toMatch(/^ov/);
  });

  it('addOverlay honors explicit audioMode/gainDb/id', () => {
    const r = addOverlay(m(), 's2', {
      id: 'ovX', srcIn: 1, srcOut: 5, anchor: { sourceId: 's1', srcTime: 3 }, audioMode: 'mix', gainDb: -6,
    });
    expect(r.timeline.overlays![0]).toEqual({
      id: 'ovX', sourceId: 's2', srcIn: 1, srcOut: 5, anchor: { sourceId: 's1', srcTime: 3 }, audioMode: 'mix', gainDb: -6,
    });
  });

  it('addOverlay rejects an unknown B-roll source or anchor source', () => {
    expect(() => addOverlay(m(), 'nope', { srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } })).toThrow(/unknown B-roll source/);
    expect(() => addOverlay(m(), 's2', { srcIn: 0, srcOut: 4, anchor: { sourceId: 'nope', srcTime: 2 } })).toThrow(/unknown anchor source/);
  });

  it('addOverlay rejects invalid ranges and an out-of-source-duration out', () => {
    expect(() => addOverlay(m(), 's2', { srcIn: 5, srcOut: 5, anchor: { sourceId: 's1', srcTime: 2 } })).toThrow(/out.*greater than in/);
    expect(() => addOverlay(m(), 's2', { srcIn: -1, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } })).toThrow(/in.*>= 0/);
    expect(() => addOverlay(m(), 's2', { srcIn: 0, srcOut: 999, anchor: { sourceId: 's1', srcTime: 2 } })).toThrow(/exceeds source duration/);
  });

  it('addOverlay rejects an invalid audioMode and an out-of-range gainDb', () => {
    expect(() => addOverlay(m(), 's2', { srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 }, audioMode: 'loud' as any })).toThrow(/audioMode/);
    expect(() => addOverlay(m(), 's2', { srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 }, gainDb: 50 })).toThrow(/gain/);
  });

  it('addOverlay rejects a duplicate id', () => {
    const r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 1 } });
    expect(() => addOverlay(r, 's2', { id: 'ov1', srcIn: 4, srcOut: 6, anchor: { sourceId: 's1', srcTime: 15 } })).toThrow(/id already exists/);
  });

  it('addOverlay rejects a resolved-region overlap with an existing overlay (V2 allows no overlap)', () => {
    // First overlay: anchored at src=2 (tl=2), duration 4 -> resolved tl[2,6).
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } });
    // Second overlay anchored at src=4 (tl=4), duration 4 -> resolved tl[4,8) — overlaps [2,6).
    expect(() =>
      addOverlay(r, 's2', { id: 'ov2', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 4 } }),
    ).toThrow(/overlaps existing overlay ov1/);
    // A non-overlapping placement (resolved tl[6,8)) succeeds.
    r = addOverlay(r, 's2', { id: 'ov2', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 6 } });
    expect(r.timeline.overlays).toHaveLength(2);
  });

  it('addOverlay allows an overlay whose anchor is currently orphaned (nothing to collide with)', () => {
    // src=15 falls in the A-roll's cut gap (10..20) -> unresolvable.
    const r = addOverlay(m(), 's2', { srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 15 } });
    expect(r.timeline.overlays).toHaveLength(1);
    expect(resolveOverlays(r)[0].tlStart).toBeNull();
  });

  it('updateOverlay patches only the given fields, leaving sourceId/id untouched', () => {
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 }, audioMode: 'mute' });
    r = updateOverlay(r, 'ov1', { audioMode: 'mix', gainDb: -10 });
    const ov = r.timeline.overlays![0];
    expect(ov).toMatchObject({ id: 'ov1', sourceId: 's2', srcIn: 0, srcOut: 4, audioMode: 'mix', gainDb: -10 });
    expect(ov.anchor).toEqual({ sourceId: 's1', srcTime: 2 });
  });

  it('updateOverlay re-anchors (patch.anchor) — this is how a user fixes an orphan', () => {
    // Anchored in the cut gap -> orphan.
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 15 } });
    expect(resolveOverlays(r)[0].tlStart).toBeNull();
    r = updateOverlay(r, 'ov1', { anchor: { sourceId: 's1', srcTime: 22 } });
    expect(resolveOverlays(r)[0].tlStart).toBeCloseTo(12); // tl[10,20) <- src[20,30): src22 -> tl12
  });

  it('updateOverlay rejects an unknown id and invalid values', () => {
    const r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } });
    expect(() => updateOverlay(r, 'nope', { audioMode: 'mix' })).toThrow(/unknown overlay/);
    expect(() => updateOverlay(r, 'ov1', { audioMode: 'loud' as any })).toThrow(/audioMode/);
    expect(() => updateOverlay(r, 'ov1', { gainDb: 50 })).toThrow(/gain/);
    expect(() => updateOverlay(r, 'ov1', { srcOut: 0 })).toThrow(/out.*greater than in/);
    expect(() => updateOverlay(r, 'ov1', { anchor: { sourceId: 'nope', srcTime: 1 } })).toThrow(/unknown anchor source/);
  });

  it('updateOverlay rejects a re-anchor that collides with another overlay\'s resolved region', () => {
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } }); // tl[2,6)
    r = addOverlay(r, 's2', { id: 'ov2', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 8 } }); // tl[8,10)
    expect(() => updateOverlay(r, 'ov2', { anchor: { sourceId: 's1', srcTime: 4 } })).toThrow(/overlaps existing overlay ov1/);
  });

  it('updateOverlay allows patching other fields on an orphaned overlay without requiring the anchor to resolve', () => {
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 15 } }); // orphan
    r = updateOverlay(r, 'ov1', { audioMode: 'replace', gainDb: -3 });
    const ov = r.timeline.overlays![0];
    expect(ov.audioMode).toBe('replace');
    expect(ov.gainDb).toBe(-3);
    expect(resolveOverlays(r)[0].tlStart).toBeNull(); // still orphaned — anchor untouched
  });

  it('removeOverlay drops the item; unknown id throws', () => {
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 2 } });
    r = addOverlay(r, 's2', { id: 'ov2', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 8 } });
    r = removeOverlay(r, 'ov1');
    expect(r.timeline.overlays!.map((o) => o.id)).toEqual(['ov2']);
    expect(() => removeOverlay(r, 'ov1')).toThrow(/unknown overlay/);
  });
});

describe('resolveOverlays / resolvedActiveOverlays / orphanedOverlays', () => {
  function m(): Manifest {
    const base = manifest();
    return {
      ...base,
      sources: [
        ...base.sources,
        { id: 's2', path: '/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: {
        ...base.timeline,
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
      },
    };
  }

  it('an anchor whose instant survives a ripple cut automatically follows the new timeline position', () => {
    // Anchor at src=25 (inside the surviving second clip) -> tl[10,20)<-src[20,30): tl=15.
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 25 } });
    expect(resolveOverlays(r)[0].tlStart).toBeCloseTo(15);
    // Ripple-cut more of the FIRST clip (src[0,5) removed) — everything downstream shifts left by 5s.
    r = removeSourceRange(r, 's1', 0, 5);
    // The anchored instant (src=25) still exists and is still kept, so the
    // overlay follows the ripple: new tl = 15 - 5 = 10.
    expect(resolveOverlays(r)[0].tlStart).toBeCloseTo(10);
  });

  it('an anchor whose instant gets cut away becomes orphaned (excluded from resolvedActiveOverlays)', () => {
    let r = addOverlay(m(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 25 } });
    expect(resolvedActiveOverlays(r)).toHaveLength(1);
    // Cut away the anchored instant itself.
    r = removeSourceRange(r, 's1', 24, 26);
    const resolved = resolveOverlays(r);
    expect(resolved[0].tlStart).toBeNull();
    expect(resolvedActiveOverlays(r)).toHaveLength(0);
    const orphans = orphanedOverlays(r);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ id: 'ov1' });
    expect(orphans[0].reason).toMatch(/not on the timeline/);
  });

  it('resolvedActiveOverlays sorts by resolved tlStart', () => {
    let r = addOverlay(m(), 's2', { id: 'ovLater', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 25 } }); // tl 15
    r = addOverlay(r, 's2', { id: 'ovEarlier', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 2 } }); // tl 2
    const active = resolvedActiveOverlays(r);
    expect(active.map((a) => a.overlay.id)).toEqual(['ovEarlier', 'ovLater']);
    expect(active[0].tlEnd - active[0].tlStart).toBeCloseTo(2);
  });

  it('OVERLAY_GAIN_DEFAULT is -18 (the documented default for mix/replace)', () => {
    expect(OVERLAY_GAIN_DEFAULT).toBe(-18);
  });
});

// ---- W8: kit sprites (addSprite / updateSprite / removeSprite, resolve*, orphanedSprites, spriteGeometry) ----

describe('sprites (addSprite / updateSprite / removeSprite)', () => {
  // Same A-roll-with-a-cut shape as the B-roll suite above: tl[0,10)<-src[0,10), tl[10,20)<-src[20,30).
  function m(): Manifest {
    const base = manifest();
    return {
      ...base,
      timeline: {
        ...base.timeline,
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
      },
    };
  }

  it('addSprite fills in sensible defaults (duration/position/scale/opacity) when omitted', () => {
    const r = addSprite(m(), 'char1', { anchor: { sourceId: 's1', srcTime: 2 } });
    const sp = r.timeline.sprites![0];
    expect(sp.assetId).toBe('char1');
    expect(sp.id).toMatch(/^sp/);
    expect(sp.duration).toBeGreaterThan(0);
    expect(sp.position.x).toBeGreaterThanOrEqual(0);
    expect(sp.position.x).toBeLessThanOrEqual(1);
    expect(sp.scale).toBeGreaterThan(0);
    expect(sp.opacity).toBe(1);
    expect(sp.flip).toBeUndefined();
  });

  it('addSprite honors explicit fields including flip', () => {
    const r = addSprite(m(), 'char1', {
      id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 5,
      position: { x: 0.2, y: 0.8 }, scale: 0.4, opacity: 0.5, flip: true,
    });
    expect(r.timeline.sprites![0]).toMatchObject({
      id: 'sp1', assetId: 'char1', duration: 5, position: { x: 0.2, y: 0.8 }, scale: 0.4, opacity: 0.5, flip: true,
    });
  });

  it('addSprite requires a non-empty assetId and a valid anchor', () => {
    expect(() => addSprite(m(), '', { anchor: { sourceId: 's1', srcTime: 2 } })).toThrow(/assetId is required/);
    expect(() => addSprite(m(), 'char1', { anchor: { sourceId: 'nope', srcTime: 2 } })).toThrow(/unknown anchor source/);
    expect(() => addSprite(m(), 'char1', { anchor: { sourceId: 's1', srcTime: -1 } })).toThrow(/srcTime.*>= 0/);
  });

  it('addSprite rejects out-of-range duration/position/scale/opacity', () => {
    const anchor = { sourceId: 's1', srcTime: 2 };
    expect(() => addSprite(m(), 'c', { anchor, duration: 0 })).toThrow(/duration/);
    expect(() => addSprite(m(), 'c', { anchor, position: { x: 1.5, y: 0.5 } })).toThrow(/position\.x/);
    expect(() => addSprite(m(), 'c', { anchor, scale: 0 })).toThrow(/scale/);
    expect(() => addSprite(m(), 'c', { anchor, scale: 1.5 })).toThrow(/scale/);
    expect(() => addSprite(m(), 'c', { anchor, opacity: 2 })).toThrow(/opacity/);
  });

  it('addSprite rejects a duplicate id; two sprites MAY resolve to overlapping ranges (no exclusivity check, unlike B-roll V2)', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 4 });
    expect(() => addSprite(r, 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 8 }, duration: 4 })).toThrow(/id already exists/);
    // Same window as sp1 [2,6) — must NOT throw (sprites can overlap).
    r = addSprite(r, 'c2', { id: 'sp2', anchor: { sourceId: 's1', srcTime: 3 }, duration: 2 });
    expect(r.timeline.sprites!.map((s) => s.id)).toEqual(['sp1', 'sp2']);
  });

  it('updateSprite patches only given fields, never assetId; unknown id / bad anchor throw', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, opacity: 1 });
    r = updateSprite(r, 'sp1', { opacity: 0.6, scale: 0.5 });
    const sp = r.timeline.sprites![0];
    expect(sp.assetId).toBe('c1');
    expect(sp.opacity).toBe(0.6);
    expect(sp.scale).toBe(0.5);
    expect(() => updateSprite(r, 'nope', { opacity: 0.5 })).toThrow(/unknown sprite/);
    expect(() => updateSprite(r, 'sp1', { anchor: { sourceId: 'nope', srcTime: 1 } })).toThrow(/unknown anchor source/);
    expect(() => updateSprite(r, 'sp1', { scale: 2 })).toThrow(/scale/);
  });

  it('updateSprite can set and clear flip', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 } });
    r = updateSprite(r, 'sp1', { flip: true });
    expect(r.timeline.sprites![0].flip).toBe(true);
    r = updateSprite(r, 'sp1', { flip: false });
    expect(r.timeline.sprites![0].flip).toBeUndefined();
  });

  it('removeSprite drops the item; unknown id throws', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 } });
    r = addSprite(r, 'c2', { id: 'sp2', anchor: { sourceId: 's1', srcTime: 8 } });
    r = removeSprite(r, 'sp1');
    expect(r.timeline.sprites!.map((s) => s.id)).toEqual(['sp2']);
    expect(() => removeSprite(r, 'sp1')).toThrow(/unknown sprite/);
  });
});

describe('resolveSprites / resolvedActiveSprites / orphanedSprites', () => {
  function m(): Manifest {
    const base = manifest();
    return {
      ...base,
      timeline: {
        ...base.timeline,
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 },
          { id: 'c2', sourceId: 's1', srcIn: 20, srcOut: 30 },
        ],
      },
    };
  }

  it('an anchor whose instant survives a ripple cut automatically follows the new timeline position', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 25 } }); // tl[10,20)<-src[20,30): tl=15
    expect(resolveSprites(r)[0].tlStart).toBeCloseTo(15);
    r = removeSourceRange(r, 's1', 0, 5); // ripple: everything downstream shifts left by 5s
    expect(resolveSprites(r)[0].tlStart).toBeCloseTo(10);
  });

  it('an anchor whose instant gets cut away becomes orphaned (excluded from resolvedActiveSprites)', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 25 } });
    expect(resolvedActiveSprites(r)).toHaveLength(1);
    r = removeSourceRange(r, 's1', 24, 26); // cut away the anchored instant itself
    expect(resolveSprites(r)[0].tlStart).toBeNull();
    expect(resolvedActiveSprites(r)).toHaveLength(0);
    const orphans = orphanedSprites(r);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ id: 'sp1' });
    expect(orphans[0].reason).toMatch(/not on the timeline/);
  });

  it('resolvedActiveSprites sorts by resolved tlStart', () => {
    let r = addSprite(m(), 'c1', { id: 'spLater', anchor: { sourceId: 's1', srcTime: 8 }, duration: 2 });
    r = addSprite(r, 'c2', { id: 'spEarlier', anchor: { sourceId: 's1', srcTime: 2 }, duration: 2 });
    const active = resolvedActiveSprites(r);
    expect(active.map((a) => a.sprite.id)).toEqual(['spEarlier', 'spLater']);
    expect(active[0].tlEnd - active[0].tlStart).toBeCloseTo(2);
  });

  it('two sprites resolve to overlapping active ranges without error (unlike the B-roll V2 track)', () => {
    let r = addSprite(m(), 'c1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 6 });
    r = addSprite(r, 'c2', { id: 'sp2', anchor: { sourceId: 's1', srcTime: 4 }, duration: 6 });
    const active = resolvedActiveSprites(r);
    expect(active).toHaveLength(2);
    expect(active[0].tlEnd).toBeGreaterThan(active[1].tlStart); // overlapping
  });
});

describe('spriteGeometry (ground-anchor placement, scale, flip, defaults)', () => {
  const outputWH = { width: 1000, height: 1000 };

  it('places the asset\'s ground_anchor_normalized point exactly at position * outputWH', () => {
    const asset = {
      width: 200, height: 400,
      visible_bounds_normalized: { x0: 0.25, y0: 0.1, x1: 0.75, y1: 0.9 },
      ground_anchor_normalized: { x: 0.5, y: 0.9 },
    };
    const geo = spriteGeometry(asset, { x: 0.5, y: 0.8 }, 0.2, outputWH);
    expect(geo.anchorX).toBeCloseTo(500);
    expect(geo.anchorY).toBeCloseTo(800);
    // The anchor point, once the image is scaled+positioned, must land exactly on (anchorX, anchorY).
    const anchorPxX = geo.x + 0.5 * geo.width;
    const anchorPxY = geo.y + 0.9 * geo.height;
    expect(anchorPxX).toBeCloseTo(500);
    expect(anchorPxY).toBeCloseTo(800);
  });

  it('scale sets the displayed height of the VISIBLE region (not the full padded image) as a fraction of output height', () => {
    const asset = {
      width: 200, height: 400,
      visible_bounds_normalized: { x0: 0, y0: 0.25, x1: 1, y1: 0.75 }, // visible region is 50% of the image's own height
      ground_anchor_normalized: { x: 0.5, y: 0.75 },
    };
    const geo = spriteGeometry(asset, { x: 0.5, y: 0.9 }, 0.3, outputWH); // visible height should be 0.3 * 1000 = 300
    const visibleHeightPx = geo.height * 0.5; // 50% of the full (scaled) image height is "visible"
    expect(visibleHeightPx).toBeCloseTo(300);
    // aspect (200/400 = 0.5) is preserved in the full image dimensions.
    expect(geo.width / geo.height).toBeCloseTo(200 / 400);
  });

  it('flip mirrors which side of the image the anchor point sits on', () => {
    const asset = {
      width: 100, height: 100,
      visible_bounds_normalized: { x0: 0, y0: 0, x1: 1, y1: 1 },
      ground_anchor_normalized: { x: 0.2, y: 1 }, // anchor near the LEFT edge
    };
    const normal = spriteGeometry(asset, { x: 0.5, y: 0.5 }, 0.2, outputWH);
    const flipped = spriteGeometry(asset, { x: 0.5, y: 0.5 }, 0.2, outputWH, { flip: true });
    // Same displayed size, but the top-left x must differ (anchor offset mirrors).
    expect(flipped.width).toBeCloseTo(normal.width);
    expect(flipped.x).not.toBeCloseTo(normal.x);
    // Flipped: anchor sits at 1 - 0.2 = 0.8 of the width from the left.
    expect(flipped.anchorX - flipped.x).toBeCloseTo(0.8 * flipped.width);
    expect(normal.anchorX - normal.x).toBeCloseTo(0.2 * normal.width);
  });

  it('falls back to "whole image visible" / "bottom-center anchor" / square aspect when the asset is unscanned', () => {
    const geo = spriteGeometry({}, { x: 0.5, y: 1 }, 0.2, outputWH);
    expect(geo.width).toBeCloseTo(geo.height); // square fallback aspect
    expect(geo.anchorX - geo.x).toBeCloseTo(0.5 * geo.width); // anchor.x fallback = 0.5
    expect(geo.anchorY - geo.y).toBeCloseTo(1.0 * geo.height); // anchor.y fallback = 1 (bottom)
  });
});

// ---- intent zones ("静寂スコア" protection zones — W-INTENT) ----
describe('addIntentZone / removeIntentZone', () => {
  it('adds a zone with defaults (kind=quiet, freshId)', () => {
    const m = addIntentZone(manifest(), 's1', 10, 15, { label: '余韻' });
    expect(m.intentZones).toHaveLength(1);
    expect(m.intentZones![0]).toMatchObject({ sourceId: 's1', t0: 10, t1: 15, label: '余韻', kind: 'quiet' });
    expect(m.intentZones![0].id).toMatch(/^iz/);
  });

  it('accepts an explicit kind and id', () => {
    const m = addIntentZone(manifest(), 's1', 10, 15, { label: '見せ場の間', kind: 'hold', id: 'iz-fixed' });
    expect(m.intentZones![0]).toMatchObject({ id: 'iz-fixed', kind: 'hold' });
  });

  it('rejects an unknown source', () => {
    expect(() => addIntentZone(manifest(), 'nope', 0, 5, { label: 'x' })).toThrow(/unknown source/);
  });

  it('rejects t1 <= t0, negative t0, non-finite times, and an empty/whitespace label', () => {
    expect(() => addIntentZone(manifest(), 's1', 10, 10, { label: 'x' })).toThrow(/t1 .* must be greater than t0/);
    expect(() => addIntentZone(manifest(), 's1', 10, 5, { label: 'x' })).toThrow(/t1 .* must be greater than t0/);
    expect(() => addIntentZone(manifest(), 's1', -1, 5, { label: 'x' })).toThrow(/t0 .* must be >= 0/);
    expect(() => addIntentZone(manifest(), 's1', 0, Infinity, { label: 'x' })).toThrow(/finite numbers/);
    expect(() => addIntentZone(manifest(), 's1', 0, 5, { label: '' })).toThrow(/label is required/);
    expect(() => addIntentZone(manifest(), 's1', 0, 5, { label: '   ' })).toThrow(/label is required/);
  });

  it('rejects an unrecognized kind', () => {
    expect(() => addIntentZone(manifest(), 's1', 0, 5, { label: 'x', kind: 'loud' as any })).toThrow(/must be "quiet" or "hold"/);
  });

  it('rejects a duplicate explicit id', () => {
    const m = addIntentZone(manifest(), 's1', 0, 5, { label: 'a', id: 'iz1' });
    expect(() => addIntentZone(m, 's1', 10, 15, { label: 'b', id: 'iz1' })).toThrow(/id already exists/);
  });

  it('appends to an existing list rather than replacing it', () => {
    let m = addIntentZone(manifest(), 's1', 0, 5, { label: 'a' });
    m = addIntentZone(m, 's1', 10, 15, { label: 'b' });
    expect(m.intentZones).toHaveLength(2);
  });

  it('removes a zone by id', () => {
    let m = addIntentZone(manifest(), 's1', 0, 5, { label: 'a', id: 'iz1' });
    m = addIntentZone(m, 's1', 10, 15, { label: 'b', id: 'iz2' });
    m = removeIntentZone(m, 'iz1');
    expect(m.intentZones).toHaveLength(1);
    expect(m.intentZones![0].id).toBe('iz2');
  });

  it('throws removing an unknown id', () => {
    expect(() => removeIntentZone(manifest(), 'nope')).toThrow(/unknown intent zone/);
  });
});

describe('intentZonesForSource / overlappingIntentZones', () => {
  it('filters zones by source and overlap (half-open ranges)', () => {
    let m = addIntentZone(manifest(), 's1', 10, 20, { label: 'a', id: 'a' });
    m = addIntentZone(m, 's1', 30, 40, { label: 'b', id: 'b' });
    const zones = intentZonesForSource(m, 's1');
    expect(zones.map((z) => z.id)).toEqual(['a', 'b']);
    expect(overlappingIntentZones(zones, 15, 25).map((z) => z.id)).toEqual(['a']);
    expect(overlappingIntentZones(zones, 25, 35).map((z) => z.id)).toEqual(['b']);
    expect(overlappingIntentZones(zones, 0, 10)).toEqual([]); // touches but doesn't overlap (half-open)
    expect(overlappingIntentZones(zones, 20, 30)).toEqual([]); // gap between the two zones
    expect(overlappingIntentZones(zones, 5, 45).map((z) => z.id)).toEqual(['a', 'b']); // fully contains both
  });

  it('intentZonesForSource returns [] for a source with no zones (including an unset Manifest.intentZones)', () => {
    expect(intentZonesForSource(manifest(), 's1')).toEqual([]);
    const m = addIntentZone(manifest(), 's1', 0, 5, { label: 'x' });
    expect(intentZonesForSource(m, 's2')).toEqual([]);
  });
});

describe('quietZonesOverlappingTimelineRange', () => {
  function twoSourceManifest(): Manifest {
    return {
      version: 1,
      name: 't',
      revision: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      sources: [
        { id: 's1', path: '/a.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true },
        { id: 's2', path: '/b.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 20 }, // tl [0,20) <- s1 [0,20)
          { id: 'c2', sourceId: 's2', srcIn: 0, srcOut: 20 }, // tl [20,40) <- s2 [0,20)
        ],
        motion: [],
      },
      captions: { enabled: true, style: 'clean', maxChars: 24 },
    };
  }

  it('maps a timeline range back to source time and only matches "quiet"-kind zones', () => {
    let m = twoSourceManifest();
    m = addIntentZone(m, 's1', 5, 10, { label: '静寂ゾーン', kind: 'quiet', id: 'q1' });
    // BGM sitting at tl [3,8) overlaps s1 source time [3,8), which overlaps [5,10).
    expect(quietZonesOverlappingTimelineRange(m, 3, 8).map((z) => z.id)).toEqual(['q1']);
    // A duck region entirely before the zone (tl [0,3) -> src [0,3)) doesn't overlap.
    expect(quietZonesOverlappingTimelineRange(m, 0, 3)).toEqual([]);
  });

  it('excludes "hold"-kind zones (they protect against cuts, not BGM ducking)', () => {
    let m = twoSourceManifest();
    m = addIntentZone(m, 's1', 5, 10, { label: '見せ場', kind: 'hold', id: 'h1' });
    expect(quietZonesOverlappingTimelineRange(m, 0, 20)).toEqual([]);
  });

  it('checks the SECOND source too, mapping through its own segment', () => {
    let m = twoSourceManifest();
    m = addIntentZone(m, 's2', 5, 10, { label: 'B-rollの静寂', kind: 'quiet', id: 'q2' });
    // s2's source time [5,10) sits at timeline [20+5, 20+10) = [25,30).
    expect(quietZonesOverlappingTimelineRange(m, 24, 26).map((z) => z.id)).toEqual(['q2']);
    expect(quietZonesOverlappingTimelineRange(m, 0, 20)).toEqual([]); // s1's segment carries no zone here
  });

  it('returns [] when the manifest has no intentZones at all', () => {
    expect(quietZonesOverlappingTimelineRange(twoSourceManifest(), 0, 40)).toEqual([]);
  });

  it('never double-reports the same zone id across multiple segments', () => {
    // A source whose footage appears twice on the timeline (two clips of s1).
    const m: Manifest = {
      version: 1, name: 't', revision: 0, fps: 30, width: 1920, height: 1080,
      sources: [{ id: 's1', path: '/a.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }],
      timeline: {
        video: [
          { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 20 }, // tl [0,20) <- s1 [0,20)
          { id: 'c2', sourceId: 's1', srcIn: 10, srcOut: 20 }, // tl [20,30) <- s1 [10,20) (re-appears)
        ],
        motion: [],
      },
      captions: { enabled: true, style: 'clean', maxChars: 24 },
    };
    const zoned = addIntentZone(m, 's1', 12, 18, { label: 'z', kind: 'quiet', id: 'z1' });
    // A duck range spanning the whole timeline overlaps s1's [12,18) via BOTH clips.
    const hits = quietZonesOverlappingTimelineRange(zoned, 0, 30);
    expect(hits.map((z) => z.id)).toEqual(['z1']);
  });
});

// ---------------------------------------------------------------------------
// ---- W-ANIME: composition (source-less "sprite anime" production mode) ----
// ---------------------------------------------------------------------------

function blankManifest(): Manifest {
  return {
    version: 1, name: 't', revision: 0, fps: 30, width: 1920, height: 1080,
    sources: [], timeline: { video: [], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}
function compositionManifest(): Manifest {
  return setComposition(blankManifest(), { duration: 20, width: 1080, height: 1920 });
}

describe('setComposition', () => {
  it('sets composition + width/height, defaulting background to black', () => {
    const m = setComposition(blankManifest(), { duration: 20, width: 1080, height: 1920 });
    expect(m.composition).toEqual({ duration: 20, background: { type: 'color', hex: '#000000' } });
    expect(m.width).toBe(1080);
    expect(m.height).toBe(1920);
  });

  it('accepts an explicit background ref', () => {
    const m = setComposition(blankManifest(), {
      duration: 10, width: 100, height: 100, background: { type: 'asset', assetId: 'bg1' },
    });
    expect(m.composition!.background).toEqual({ type: 'asset', assetId: 'bg1' });
  });

  it('rounds odd width/height to the nearest even pixel', () => {
    const m = setComposition(blankManifest(), { duration: 10, width: 1081, height: 1919 });
    expect(m.width % 2).toBe(0);
    expect(m.height % 2).toBe(0);
  });

  it('refuses a project that already has ingested sources/clips', () => {
    expect(() => setComposition(manifest(), { duration: 10, width: 100, height: 100 })).toThrow(/already has ingested/);
  });

  it('rejects invalid duration/width/height', () => {
    expect(() => setComposition(blankManifest(), { duration: 0, width: 100, height: 100 })).toThrow(/duration/);
    expect(() => setComposition(blankManifest(), { duration: 10, width: 0, height: 100 })).toThrow(/size/);
    expect(() => setComposition(blankManifest(), { duration: 10, width: 100, height: -1 })).toThrow(/size/);
  });

  it('rejects a malformed background ref', () => {
    expect(() =>
      setComposition(blankManifest(), { duration: 10, width: 100, height: 100, background: { type: 'color', hex: 'red' } as any }),
    ).toThrow(/invalid hex/);
  });

  it('re-running compose on an already-composed (still source-less) project updates its fields', () => {
    let m = compositionManifest();
    m = setComposition(m, { duration: 30, width: 720, height: 1280 });
    expect(m.composition!.duration).toBe(30);
    expect(m.width).toBe(720);
  });
});

describe('setBackgroundAt / removeBackgroundAt / resolvedBackgroundAt / backgroundIntervals', () => {
  it('t=0 (or within half a frame) replaces the BASE background, not backgroundTrack', () => {
    let m = compositionManifest();
    m = setBackgroundAt(m, 0, { type: 'color', hex: '#ff0000' });
    expect(m.composition!.background).toEqual({ type: 'color', hex: '#ff0000' });
    expect(m.composition!.backgroundTrack ?? []).toHaveLength(0);
  });

  it('t>0 upserts into backgroundTrack, kept sorted ascending', () => {
    let m = compositionManifest();
    m = setBackgroundAt(m, 10, { type: 'color', hex: '#00ff00' });
    m = setBackgroundAt(m, 5, { type: 'color', hex: '#0000ff' });
    expect(m.composition!.backgroundTrack!.map((e) => e.t)).toEqual([5, 10]);
  });

  it('a second bg-set at the same (frame-snapped) t replaces the earlier cut rather than duplicating it', () => {
    let m = compositionManifest();
    m = setBackgroundAt(m, 5, { type: 'color', hex: '#00ff00' });
    m = setBackgroundAt(m, 5.001, { type: 'color', hex: '#0000ff' }); // within half a frame at 30fps
    expect(m.composition!.backgroundTrack).toHaveLength(1);
    expect(m.composition!.backgroundTrack![0].ref).toEqual({ type: 'color', hex: '#0000ff' });
  });

  it('resolvedBackgroundAt picks the LAST cut at or before t', () => {
    let m = compositionManifest();
    m = setBackgroundAt(m, 5, { type: 'color', hex: '#00ff00' });
    m = setBackgroundAt(m, 10, { type: 'color', hex: '#0000ff' });
    expect(resolvedBackgroundAt(m, 0)).toEqual({ type: 'color', hex: '#000000' });
    expect(resolvedBackgroundAt(m, 4.9)).toEqual({ type: 'color', hex: '#000000' });
    expect(resolvedBackgroundAt(m, 5)).toEqual({ type: 'color', hex: '#00ff00' });
    expect(resolvedBackgroundAt(m, 9.9)).toEqual({ type: 'color', hex: '#00ff00' });
    expect(resolvedBackgroundAt(m, 10)).toEqual({ type: 'color', hex: '#0000ff' });
    expect(resolvedBackgroundAt(m, 19.9)).toEqual({ type: 'color', hex: '#0000ff' });
  });

  it('backgroundIntervals covers [0,duration) as non-overlapping, time-sorted intervals', () => {
    let m = compositionManifest(); // duration 20
    m = setBackgroundAt(m, 5, { type: 'color', hex: '#00ff00' });
    m = setBackgroundAt(m, 10, { type: 'color', hex: '#0000ff' });
    const ivs = backgroundIntervals(m);
    expect(ivs).toEqual([
      { t0: 0, t1: 5, ref: { type: 'color', hex: '#000000' } },
      { t0: 5, t1: 10, ref: { type: 'color', hex: '#00ff00' } },
      { t0: 10, t1: 20, ref: { type: 'color', hex: '#0000ff' } },
    ]);
  });

  it('backgroundIntervals is empty for a non-composition manifest', () => {
    expect(backgroundIntervals(blankManifest())).toEqual([]);
  });

  it('bg-set rejects a t beyond the composition duration, an unset composition, or a malformed ref', () => {
    const m = compositionManifest();
    expect(() => setBackgroundAt(m, 999, { type: 'color', hex: '#fff' })).toThrow(/exceeds composition duration/);
    expect(() => setBackgroundAt(blankManifest(), 1, { type: 'color', hex: '#fff' })).toThrow(/no composition/);
    expect(() => setBackgroundAt(m, 1, { type: 'asset', assetId: '' } as any)).toThrow(/assetId is required/);
    expect(() => setBackgroundAt(m, 1, { type: 'video', path: '' } as any)).toThrow(/path is required/);
  });

  it('removeBackgroundAt removes a cut, refuses t=0, and throws on an unknown t', () => {
    let m = compositionManifest();
    m = setBackgroundAt(m, 5, { type: 'color', hex: '#00ff00' });
    m = removeBackgroundAt(m, 5);
    expect(m.composition!.backgroundTrack ?? []).toHaveLength(0);
    expect(() => removeBackgroundAt(m, 0)).toThrow(/base background/);
    expect(() => removeBackgroundAt(m, 5)).toThrow(/no background cut/);
  });
});

describe('timelineDuration / sourceTimeToTimeline (composition)', () => {
  it('timelineDuration returns composition.duration directly (never a segments() sum)', () => {
    const m = compositionManifest();
    expect(timelineDuration(m)).toBe(20);
    expect(segments(m)).toEqual([]); // never populated for a composition project
  });

  it('a normal (non-composition) project is completely unaffected — full regression', () => {
    const m = manifest();
    expect(timelineDuration(m)).toBeCloseTo(60);
    expect(sourceTimeToTimeline(m, COMP_SOURCE_ID, 5)).toBeNull(); // sentinel means nothing without m.composition
  });

  it('sourceTimeToTimeline(COMP_SOURCE_ID, t) is the identity within [0,duration], null outside', () => {
    const m = compositionManifest();
    expect(sourceTimeToTimeline(m, COMP_SOURCE_ID, 0)).toBe(0);
    expect(sourceTimeToTimeline(m, COMP_SOURCE_ID, 12.5)).toBe(12.5);
    expect(sourceTimeToTimeline(m, COMP_SOURCE_ID, 20)).toBe(20); // inclusive at the end (see doc)
    expect(sourceTimeToTimeline(m, COMP_SOURCE_ID, -1)).toBeNull();
    expect(sourceTimeToTimeline(m, COMP_SOURCE_ID, 21)).toBeNull();
  });
});

describe('sprite anchor (COMP_SOURCE_ID) + motion validation', () => {
  it('addSprite accepts the COMP_SOURCE_ID anchor only when the project is a composition', () => {
    const comp = compositionManifest();
    const r = addSprite(comp, 'char1', { anchor: { sourceId: COMP_SOURCE_ID, srcTime: 3 } });
    expect(resolveSprites(r)[0].tlStart).toBe(3);
    expect(() => addSprite(manifest(), 'char1', { anchor: { sourceId: COMP_SOURCE_ID, srcTime: 3 } })).toThrow(
      /unknown anchor source/,
    );
  });

  it('addSprite validates motion presets, rejecting unrecognized enter/loop/exit/emoteAt values', () => {
    const comp = compositionManifest();
    const anchor = { sourceId: COMP_SOURCE_ID, srcTime: 0 };
    const r = addSprite(comp, 'c1', { anchor, motion: { enter: 'pop', loop: 'sway', exit: 'fade' } });
    expect(r.timeline.sprites![0].motion).toEqual({ enter: 'pop', loop: 'sway', exit: 'fade' });
    expect(() => addSprite(comp, 'c1', { anchor, motion: { enter: 'nope' as any } })).toThrow(/motion.enter/);
    expect(() => addSprite(comp, 'c1', { anchor, motion: { loop: 'nope' as any } })).toThrow(/motion.loop/);
    expect(() => addSprite(comp, 'c1', { anchor, motion: { emoteAt: [{ t: -1, assetId: 'x' }] } })).toThrow(/emoteAt/);
    expect(() => addSprite(comp, 'c1', { anchor, motion: { emoteAt: [{ t: 1, assetId: '' }] } })).toThrow(/emoteAt/);
  });

  it('updateSprite MERGES a motion patch field-by-field rather than replacing wholesale; motion:null clears it', () => {
    const comp = compositionManifest();
    const anchor = { sourceId: COMP_SOURCE_ID, srcTime: 0 };
    let r = addSprite(comp, 'c1', { anchor, id: 'sp1', motion: { enter: 'pop', loop: 'sway' } });
    r = updateSprite(r, 'sp1', { motion: { loop: 'bob' } }); // only touches loop
    expect(r.timeline.sprites![0].motion).toEqual({ enter: 'pop', loop: 'bob' });
    r = updateSprite(r, 'sp1', { motion: null });
    expect(r.timeline.sprites![0].motion).toBeUndefined();
  });
});

describe('spriteMotionPlan (pure ffmpeg-expression builder — every preset)', () => {
  const geo = { x: 100, y: 100, width: 200, height: 300, anchorX: 200, anchorY: 400 };
  const tlStart = 10;
  const tlEnd = 20;

  it('no motion at all -> plain static x/y, no fades, no breathe (byte-for-byte pre-W-ANIME)', () => {
    const plan = spriteMotionPlan(undefined, geo, tlStart, tlEnd);
    expect(plan.xExpr).toBe('100');
    expect(plan.yExpr).toBe('100');
    expect(plan.fadeClauses).toEqual([]);
    expect(plan.breathe).toBeUndefined();
  });

  const enterPresets = ['slide-left', 'slide-right', 'hop-in', 'pop', 'fade'] as const;
  it.each(enterPresets)('enter=%s produces a distinct, well-formed expression', (name) => {
    const plan = spriteMotionPlan({ enter: name }, geo, tlStart, tlEnd);
    // Every enter preset's expression must reference the sprite's own tlStart
    // (the entrance window's origin) somewhere in x, y, or a fade clause.
    const touchesTlStart = plan.xExpr.includes('10') || plan.yExpr.includes('10') || plan.fadeClauses.some((f) => f.includes('st=10'));
    expect(touchesTlStart).toBe(true);
    if (name === 'pop' || name === 'fade') expect(plan.fadeClauses.length).toBeGreaterThan(0);
    else expect(plan.fadeClauses).toEqual([]);
  });

  const exitPresets = enterPresets;
  it.each(exitPresets)('exit=%s produces a distinct, well-formed expression anchored at tlEnd-D', (name) => {
    const plan = spriteMotionPlan({ exit: name }, geo, tlStart, tlEnd);
    expect(plan.xExpr + plan.yExpr + plan.fadeClauses.join('')).toMatch(/19\.65|20/); // tlEnd(20) - 0.35 = 19.65
    if (name === 'pop' || name === 'fade') expect(plan.fadeClauses.length).toBeGreaterThan(0);
  });

  it('loop=sway offsets x with the spec\'s own literal example shape (X + 8*sin(2*PI*(t-t0)/3))', () => {
    const plan = spriteMotionPlan({ loop: 'sway' }, geo, tlStart, tlEnd);
    expect(plan.xExpr).toContain('8*sin(2*PI*(t-10');
    expect(plan.yExpr).toBe('100'); // sway never touches y
  });

  it('loop=bob offsets y, loop=hop offsets y with an abs(sin(...)) envelope', () => {
    const bob = spriteMotionPlan({ loop: 'bob' }, geo, tlStart, tlEnd);
    expect(bob.yExpr).toContain('sin(2*PI*(t-10');
    expect(bob.xExpr).toBe('100');
    const hop = spriteMotionPlan({ loop: 'hop' }, geo, tlStart, tlEnd);
    expect(hop.yExpr).toContain('abs(sin(');
  });

  it('loop=none is a full no-op (same as undefined)', () => {
    const plan = spriteMotionPlan({ loop: 'none' }, geo, tlStart, tlEnd);
    expect(plan.xExpr).toBe('100');
    expect(plan.yExpr).toBe('100');
    expect(plan.breathe).toBeUndefined();
  });

  it('loop=breathe emits eval=frame-style scale w/h expressions AND keeps the anchor (feet) fixed', () => {
    const plan = spriteMotionPlan({ loop: 'breathe' }, geo, tlStart, tlEnd);
    expect(plan.breathe).toBeDefined();
    expect(plan.breathe!.widthExpr).toContain('200');
    expect(plan.breathe!.heightExpr).toContain('300');
    // anchor-relative recompute, not the plain static geo.x/geo.y.
    expect(plan.xExpr).toContain(String(geo.anchorX));
    expect(plan.yExpr).toContain(String(geo.anchorY));
  });

  it('enter/exit/loop offsets compose additively (all three present at once)', () => {
    const plan = spriteMotionPlan({ enter: 'fade', loop: 'sway', exit: 'fade' }, geo, tlStart, tlEnd);
    expect(plan.xExpr).toContain('8*sin'); // sway term present
    expect(plan.fadeClauses).toHaveLength(2); // one for enter, one for exit
  });
});

describe('emoteWindows (pure)', () => {
  it('no emoteAt -> []', () => {
    expect(emoteWindows(undefined, 5)).toEqual([]);
    expect(emoteWindows([], 5)).toEqual([]);
  });

  it('a single entry covers from its own t to the sprite\'s duration', () => {
    const w = emoteWindows([{ t: 1, assetId: 'happy' }], 5);
    expect(w).toEqual([{ t0: 1, t1: 5, assetId: 'happy' }]);
  });

  it('multiple entries are sorted and non-overlapping, each ending where the next begins', () => {
    const w = emoteWindows([{ t: 3, assetId: 'sad' }, { t: 1, assetId: 'happy' }], 5);
    expect(w).toEqual([
      { t0: 1, t1: 3, assetId: 'happy' },
      { t0: 3, t1: 5, assetId: 'sad' },
    ]);
  });

  it('entries at/after duration, or with a negative t, are dropped', () => {
    const w = emoteWindows([{ t: 5, assetId: 'late' }, { t: -1, assetId: 'bad' }, { t: 2, assetId: 'ok' }], 5);
    expect(w).toEqual([{ t0: 2, t1: 5, assetId: 'ok' }]);
  });
});

describe('dialogue (addDialogue / updateDialogue / removeDialogue)', () => {
  it('addDialogue fills in a default duration and validates required text', () => {
    const r = addDialogue(compositionManifest(), '今日は雨…', { tlStart: 3 });
    const d = r.timeline.dialogue![0];
    expect(d.text).toBe('今日は雨…');
    expect(d.tlStart).toBe(3);
    expect(d.duration).toBeCloseTo(2.5);
    expect(d.id).toMatch(/^dl/);
    expect(() => addDialogue(compositionManifest(), '', { tlStart: 0 })).toThrow(/text is required/);
    expect(() => addDialogue(compositionManifest(), 'x', { tlStart: -1 })).toThrow(/at.*>= 0/);
  });

  it('addDialogue validates an optional spriteId against existing sprites', () => {
    let m = compositionManifest();
    m = addSprite(m, 'c1', { id: 'sp1', anchor: { sourceId: COMP_SOURCE_ID, srcTime: 0 } });
    const r = addDialogue(m, 'hi', { tlStart: 1, spriteId: 'sp1' });
    expect(r.timeline.dialogue![0].spriteId).toBe('sp1');
    expect(() => addDialogue(m, 'hi', { tlStart: 1, spriteId: 'nope' })).toThrow(/unknown sprite/);
  });

  it('addDialogue carries voiceMusicId through untouched (the daemon creates the MusicItem, ops.ts just records the id)', () => {
    const r = addDialogue(compositionManifest(), 'hi', { tlStart: 1, voiceMusicId: 'mu1' });
    expect(r.timeline.dialogue![0].voiceMusicId).toBe('mu1');
  });

  it('updateDialogue patches text/tlStart/duration/spriteId; spriteId:null clears it', () => {
    let m = compositionManifest();
    m = addSprite(m, 'c1', { id: 'sp1', anchor: { sourceId: COMP_SOURCE_ID, srcTime: 0 } });
    let r = addDialogue(m, 'hi', { tlStart: 1, id: 'dl1', spriteId: 'sp1' });
    r = updateDialogue(r, 'dl1', { text: 'bye', tlStart: 2 });
    expect(r.timeline.dialogue![0]).toMatchObject({ text: 'bye', tlStart: 2, spriteId: 'sp1' });
    r = updateDialogue(r, 'dl1', { spriteId: null });
    expect(r.timeline.dialogue![0].spriteId).toBeUndefined();
    expect(() => updateDialogue(r, 'nope', { text: 'x' })).toThrow(/unknown dialogue item/);
    expect(() => updateDialogue(r, 'dl1', { text: '' })).toThrow(/non-empty string/);
  });

  it('removeDialogue drops the item; unknown id throws', () => {
    let r = addDialogue(compositionManifest(), 'hi', { tlStart: 1, id: 'dl1' });
    r = removeDialogue(r, 'dl1');
    expect(r.timeline.dialogue).toEqual([]);
    expect(() => removeDialogue(r, 'dl1')).toThrow(/unknown dialogue item/);
  });
});
