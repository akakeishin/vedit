import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  expandWordIds,
  keptWords,
  removeSourceRange,
  segments,
  sourceTimeToTimeline,
  timelineDuration,
  trimClip,
  wordRange,
} from './ops.js';
import { Project } from './project.js';
import { detectFillers, detectSilences } from './detect.js';
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
});
