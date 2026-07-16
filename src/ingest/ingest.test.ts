import { describe, expect, it, vi } from 'vitest';
import type { Word } from '../core/types.js';

// makeProxy shells out to ffmpeg via run(); stub it so these tests only
// assert on the constructed argv, without needing ffmpeg installed.
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn().mockResolvedValue('') }));
vi.mock('./run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  runBinary: vi.fn(),
}));

import { makeProxy, sanitizeWords } from './ingest.js';

describe('sanitizeWords', () => {
  it('leaves well-formed words untouched', () => {
    const words: Word[] = [
      { id: 'w0', text: 'hello', t0: 0, t1: 0.5, p: 0.9 },
      { id: 'w1', text: 'world', t0: 0.5, t1: 1, p: 0.9 },
    ];
    expect(sanitizeWords(words)).toEqual(words);
  });

  it('reallocates time across a zero-width run, anchored on the next good word', () => {
    const words: Word[] = [
      { id: 'w0', text: 'hello', t0: 0, t1: 1, p: 0.9 },
      { id: 'w1', text: 'ab', t0: 1.5, t1: 1.5, p: 0.9 }, // whisper collapsed these two
      { id: 'w2', text: 'cd', t0: 1.5, t1: 1.5, p: 0.9 },
      { id: 'w3', text: 'good', t0: 3, t1: 3.5, p: 0.9 },
    ];
    const out = sanitizeWords(words);
    const w1 = out.find((w) => w.id === 'w1')!;
    const w2 = out.find((w) => w.id === 'w2')!;
    expect(w1.t0).toBeCloseTo(1); // anchored on prev good word's t1
    expect(w2.t1).toBeCloseTo(3); // anchored on next good word's t0
    expect(w1.t1).toBeCloseTo(w2.t0); // contiguous split, proportional to length
    expect(w1.p).toBeLessThanOrEqual(0.3);
    expect(w2.p).toBeLessThanOrEqual(0.3);
  });

  it('uses sourceDuration as the anchor for a trailing collapse at the very end of a clip', () => {
    const words: Word[] = [
      { id: 'w0', text: 'hello', t0: 0, t1: 1, p: 0.9 },
      { id: 'w1', text: 'end', t0: 1, t1: 1, p: 0.9 },
    ];
    const out = sanitizeWords(words, 2);
    const w1 = out.find((w) => w.id === 'w1')!;
    expect(w1.t0).toBeCloseTo(1);
    expect(w1.t1).toBeCloseTo(2);
    expect(w1.p).toBeLessThanOrEqual(0.3);
  });

  it('marks an unanchored zero-width word p=0 instead of dropping or guessing', () => {
    const words: Word[] = [{ id: 'w0', text: 'orphan', t0: 5, t1: 5, p: 0.9 }];
    const out = sanitizeWords(words); // no neighbors, no sourceDuration
    expect(out).toHaveLength(1);
    expect(out[0].t0).toBe(5);
    expect(out[0].t1).toBe(5);
    expect(out[0].p).toBe(0);
  });

  it('folds a standalone punctuation token into the previous word', () => {
    const words: Word[] = [
      { id: 'w0', text: '視聴', t0: 0, t1: 0.5, p: 0.9 },
      { id: 'w1', text: '、', t0: 0.5, t1: 0.5, p: 0.9 },
      { id: 'w2', text: 'ありがとう', t0: 0.6, t1: 1.2, p: 0.9 },
    ];
    const out = sanitizeWords(words);
    expect(out.map((w) => w.id)).toEqual(['w0', 'w2']);
    expect(out[0].text).toBe('視聴、');
  });

  it('folds a leading punctuation token onto the next word when there is no previous word', () => {
    const words: Word[] = [
      { id: 'w0', text: '「', t0: 0, t1: 0, p: 0.9 },
      { id: 'w1', text: 'こんにちは', t0: 0.1, t1: 0.6, p: 0.9 },
    ];
    const out = sanitizeWords(words);
    expect(out.map((w) => w.id)).toEqual(['w1']);
    expect(out[0].text).toBe('「こんにちは');
  });
});

describe('makeProxy', () => {
  it('preserves the source fps instead of rounding it, and drops data streams/metadata', async () => {
    runMock.mockClear();
    await makeProxy('/in.mp4', '/out.mp4', { duration: 10, fps: 29.97, width: 1920, height: 1080, hasAudio: true });
    const [cmd, args] = runMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('ffmpeg');
    expect(args[args.indexOf('-r') + 1]).toBe('29.97');
    expect(args[args.indexOf('-g') + 1]).toBe('30'); // gop = round(fps)
    expect(args).toContain('-dn');
    expect(args[args.indexOf('-map_metadata') + 1]).toBe('-1');
  });

  it('caps fps at 30 for very high frame rate sources', async () => {
    runMock.mockClear();
    await makeProxy('/in.mp4', '/out.mp4', { duration: 10, fps: 120, width: 1920, height: 1080, hasAudio: true });
    const [, args] = runMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf('-r') + 1]).toBe('30');
  });
});
