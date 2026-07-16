import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import type { Word } from '../core/types.js';

// makeProxy/probe/transcribe shell out via run(); stub it so these tests only
// assert on the constructed argv (and, for probe/transcribe, fake ffprobe's
// JSON / whisper-cli's output file), without needing ffmpeg/ffprobe/whisper
// installed.
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn().mockResolvedValue('') }));
vi.mock('./run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  runBinary: vi.fn(),
}));

import { makeProxy, probe, sanitizeWords, transcribe } from './ingest.js';

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

  it('attaches a closing bracket to the previous word and an opening bracket to the next word, even mid-stream (regression: both used to glue onto the previous word, producing "な」「")', () => {
    const words: Word[] = [
      { id: 'w0', text: 'な', t0: 0, t1: 0.2, p: 0.9 },
      { id: 'w1', text: '」', t0: 0.2, t1: 0.2, p: 0.9 }, // closing: attaches to the previous word
      { id: 'w2', text: '「', t0: 0.25, t1: 0.25, p: 0.9 }, // opening: attaches to the next word
      { id: 'w3', text: 'つぎ', t0: 0.3, t1: 0.6, p: 0.9 },
    ];
    const out = sanitizeWords(words);
    expect(out.map((w) => w.id)).toEqual(['w0', 'w3']);
    expect(out[0].text).toBe('な」');
    expect(out[1].text).toBe('「つぎ');
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

describe('probe', () => {
  it('falls back from avg_frame_rate "0/0" to r_frame_rate instead of silently guessing 30fps', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: '12.5' },
        streams: [
          { codec_type: 'video', avg_frame_rate: '0/0', r_frame_rate: '30000/1001', width: 1920, height: 1080, duration: '12.5' },
          { codec_type: 'audio' },
        ],
      }),
    );
    const p = await probe('/in.mp4');
    expect(p.fps).toBeCloseTo(30000 / 1001, 5);
    expect(p.duration).toBeCloseTo(12.5);
    expect(p.hasAudio).toBe(true);
  });

  it('falls back from format.duration "N/A" to the video stream duration instead of producing NaN', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: 'N/A' },
        streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 1280, height: 720, duration: '7.25' }],
      }),
    );
    const p = await probe('/in.mp4');
    expect(p.duration).toBeCloseTo(7.25);
    expect(p.hasAudio).toBe(false);
  });

  it('throws an explicit error when neither format nor stream duration is usable', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: 'N/A' },
        streams: [{ codec_type: 'video', avg_frame_rate: '0/0', r_frame_rate: '0/0', width: 100, height: 100 }],
      }),
    );
    await expect(probe('/in.mp4')).rejects.toThrow(/duration/i);
  });
});

describe('transcribe', () => {
  it('passes explicit --beam-size/--best-of/--split-on-word and records provenance meta on the transcript', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'whisper-cli') {
        const outBase = args[args.indexOf('-of') + 1];
        await fs.writeFile(
          `${outBase}.json`,
          JSON.stringify({
            transcription: [{ tokens: [{ text: 'hello', offsets: { from: 0, to: 500 }, p: 0.9 }] }],
            result: { language: 'en' },
          }),
        );
      }
      return '';
    });
    const t = await transcribe('/in.mp4', 'src1', { model: '/models/ggml-small.bin' });
    const whisperCall = runMock.mock.calls.find(([cmd]) => cmd === 'whisper-cli') as [string, string[]];
    const [, args] = whisperCall;
    expect(args).toEqual(expect.arrayContaining(['--beam-size', '5', '--best-of', '5', '--split-on-word']));
    const meta = (t as any).meta;
    expect(meta.model).toBe('ggml-small.bin');
    expect(meta.args).toEqual(args);
    expect(meta.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.words).toHaveLength(1);
    expect(t.words[0].text).toBe('hello');
  });
});
