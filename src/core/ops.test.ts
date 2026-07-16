import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addClip,
  addMusic,
  addOverlay,
  applyReframe,
  buildSelectsTimeline,
  COLOR_WARNING_MESSAGE,
  cropGeometry,
  cropOffset,
  cropWindow,
  cullingStats,
  expandWordIds,
  keptWords,
  moveClip,
  needsColorTransform,
  orphanedOverlays,
  OVERLAY_GAIN_DEFAULT,
  padWordRange,
  parseFocus,
  parseReframeSpec,
  removeClip,
  removeMusic,
  removeOverlay,
  removeSourceRange,
  resolveOverlays,
  resolvedActiveOverlays,
  segments,
  setAudioMix,
  setAudioRepair,
  setClipCrop,
  setSceneReview,
  sourceTimeToTimeline,
  timelineDuration,
  timelineTimeToSource,
  trimClip,
  updateMusic,
  updateOverlay,
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
