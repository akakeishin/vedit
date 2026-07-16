import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addClip,
  applyReframe,
  cropGeometry,
  cropOffset,
  cropWindow,
  expandWordIds,
  keptWords,
  moveClip,
  padWordRange,
  parseFocus,
  parseReframeSpec,
  removeClip,
  removeSourceRange,
  segments,
  setClipCrop,
  sourceTimeToTimeline,
  timelineDuration,
  trimClip,
  wordRange,
} from './ops.js';
import { Project } from './project.js';
import { detectFillers, detectSilences, detectSilencesFromPeaks } from './detect.js';
import type { Manifest, Transcript, Word } from './types.js';

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

    m = await p.restore(1, 'claude');
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
    expect(cands[0].label).toContain('unreliable');
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
