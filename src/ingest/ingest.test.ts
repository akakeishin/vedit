import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project } from '../core/project.js';
import type { Word } from '../core/types.js';

// makeProxy/probe/transcribe shell out via run(); stub it so these tests only
// assert on the constructed argv (and, for probe/transcribe, fake ffprobe's
// JSON / whisper-cli's output file), without needing ffmpeg/ffprobe/whisper
// installed. runCapture is ALSO stubbed (W-LAZY: ingestFile now runs
// detectScenesForSource by default, which shells out via runCapture for the
// ffmpeg scene-change filter — see core/scenes.ts) so a plain ingestFile()
// call without scenes:false doesn't fail on an unmocked import; it defaults
// to "no scene-change boundaries found" (a single whole-clip scene) unless a
// test overrides it. runBinary defaults to an empty buffer (makePeaks parses
// it into a zero-length peaks array) rather than being left unconfigured,
// since ingestFile now always at least probes+proxies+scene-detects even a
// hasAudio:true source without any test explicitly opting into transcribe.
const { runMock, runBinaryMock, runCaptureMock, hasFilterMock } = vi.hoisted(() => ({
  runMock: vi.fn().mockResolvedValue(''),
  runBinaryMock: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  runCaptureMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  hasFilterMock: vi.fn(() => true),
}));
vi.mock('./run.js', () => ({
  run: async (...args: unknown[]) => {
    const result = await runMock(...args);
    const [cmd, argv] = args as [string, string[]];
    const output = argv?.at(-1);
    // Scene thumbnails now publish temp->rename atomically. The production
    // ffmpeg contract creates that temp JPEG; preserve it in this shell mock.
    if (cmd === 'ffmpeg' && typeof output === 'string' && output.endsWith('.jpg') && output.includes('.tmp-')) {
      const { promises: fs } = await import('node:fs');
      await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
    return result;
  },
  runBinary: (...args: unknown[]) => runBinaryMock(...args),
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
  ffmpegHasFilter: (...args: unknown[]) => hasFilterMock(...args),
}));

import {
  buildWhisperPrompt,
  downloadWhisperModel,
  findWhisperModel,
  IMAGE_SOURCE_DURATION,
  ingestFile,
  ingestImageFile,
  isImageFile,
  makeProxy,
  probe,
  probeImage,
  sanitizeWords,
  transcribe,
} from './ingest.js';
import { detectScenesForSource } from '../core/scenes.js';

describe('whisper model path isolation', () => {
  it('discovers models from VEDIT_MODEL_DIR without changing HOME', async () => {
    const modelDir = mkdtempSync(path.join(tmpdir(), 'vedit-model-dir-'));
    const previousDir = process.env.VEDIT_MODEL_DIR;
    const previousModel = process.env.VEDIT_WHISPER_MODEL;
    process.env.VEDIT_MODEL_DIR = modelDir;
    delete process.env.VEDIT_WHISPER_MODEL;
    try {
      await fs.writeFile(path.join(modelDir, 'ggml-base.bin'), 'base');
      await fs.writeFile(path.join(modelDir, 'ggml-large-v3-turbo.bin'), 'turbo');
      await expect(findWhisperModel()).resolves
        .toBe(path.join(modelDir, 'ggml-large-v3-turbo.bin'));
    } finally {
      if (previousDir === undefined) delete process.env.VEDIT_MODEL_DIR;
      else process.env.VEDIT_MODEL_DIR = previousDir;
      if (previousModel === undefined) delete process.env.VEDIT_WHISPER_MODEL;
      else process.env.VEDIT_WHISPER_MODEL = previousModel;
      await fs.rm(modelDir, { recursive: true, force: true });
    }
  });

  it('publishes one complete model atomically when two downloads race and cleans both private partials', async () => {
    const modelDir = mkdtempSync(path.join(tmpdir(), 'vedit-model-race-'));
    const previousDir = process.env.VEDIT_MODEL_DIR;
    process.env.VEDIT_MODEL_DIR = modelDir;
    let arrivals = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
      expect(cmd).toBe('curl');
      const out = args[args.indexOf('-o') + 1];
      arrivals++;
      if (arrivals === 2) release();
      await bothStarted;
      await fs.writeFile(out, `complete-model-${path.basename(out)}`);
      return '';
    });
    try {
      const [a, b] = await Promise.all([
        downloadWhisperModel('ggml-race'),
        downloadWhisperModel('ggml-race'),
      ]);
      expect(a).toBe(path.join(modelDir, 'ggml-race.bin'));
      expect(b).toBe(a);
      expect(await fs.readFile(a, 'utf8')).toMatch(/^complete-model-/);
      expect((await fs.readdir(modelDir)).filter((name) => name.includes('.part-'))).toEqual([]);
    } finally {
      runMock.mockReset().mockResolvedValue('');
      if (previousDir === undefined) delete process.env.VEDIT_MODEL_DIR;
      else process.env.VEDIT_MODEL_DIR = previousDir;
      await fs.rm(modelDir, { recursive: true, force: true });
    }
  });

  it('removes a failed download partial without exposing it as a model', async () => {
    const modelDir = mkdtempSync(path.join(tmpdir(), 'vedit-model-failure-'));
    const previousDir = process.env.VEDIT_MODEL_DIR;
    process.env.VEDIT_MODEL_DIR = modelDir;
    runMock.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
      const out = args[args.indexOf('-o') + 1];
      await fs.writeFile(out, 'truncated');
      throw new Error('network interrupted');
    });
    try {
      await expect(downloadWhisperModel('ggml-failure')).rejects.toThrow(/network interrupted/);
      expect(await fs.readdir(modelDir)).toEqual([]);
    } finally {
      runMock.mockReset().mockResolvedValue('');
      if (previousDir === undefined) delete process.env.VEDIT_MODEL_DIR;
      else process.env.VEDIT_MODEL_DIR = previousDir;
      await fs.rm(modelDir, { recursive: true, force: true });
    }
  });
});

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

  it('bakes in colorTransform (W5) as a prefix to -vf when given', async () => {
    runMock.mockClear();
    await makeProxy(
      '/in.mp4', '/out.mp4',
      { duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true },
      { type: 'hlg' },
    );
    const [, args] = runMock.mock.calls[0] as [string, string[]];
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toBe('zscale=t=linear:npl=1000,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,scale=-2:720');
  });

  it('omitting colorTransform (the normal ingest path) leaves -vf byte-identical to before this parameter existed', async () => {
    runMock.mockClear();
    await makeProxy('/in.mp4', '/out.mp4', { duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true });
    const [, args] = runMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:720');
  });

  it('an explicit colorTransform type "none" also leaves -vf unchanged', async () => {
    runMock.mockClear();
    await makeProxy(
      '/in.mp4', '/out.mp4',
      { duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true },
      { type: 'none' },
    );
    const [, args] = runMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf('-vf') + 1]).toBe('scale=-2:720');
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

  // ---- W1: color metadata extraction ----

  it('extracts color_primaries/color_transfer/color_space/bits_per_raw_sample when ffprobe reports them', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: '10' },
        streams: [
          {
            codec_type: 'video', avg_frame_rate: '30/1', width: 1920, height: 1080, duration: '10',
            color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', bits_per_raw_sample: '10',
          },
        ],
      }),
    );
    const p = await probe('/in.mp4');
    expect(p.color).toEqual({ primaries: 'bt2020', transfer: 'arib-std-b67', space: 'bt2020nc', bitDepth: 10 });
  });

  it('leaves color undefined when ffprobe reports no color fields at all', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: '10' },
        streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 1920, height: 1080, duration: '10' }],
      }),
    );
    const p = await probe('/in.mp4');
    expect(p.color).toBeUndefined();
  });

  it('still captures a numeric bits_per_raw_sample even when ffprobe reports it as a JSON number, not a string', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: '10' },
        streams: [
          { codec_type: 'video', avg_frame_rate: '30/1', width: 1920, height: 1080, duration: '10', bits_per_raw_sample: 8 },
        ],
      }),
    );
    const p = await probe('/in.mp4');
    expect(p.color).toEqual({ bitDepth: 8 });
  });

  it('carries the literal "unknown" string through for an explicitly-tagged-unknown transfer (needsColorTransform interprets it, probe does not judge)', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        format: { duration: '10' },
        streams: [
          {
            codec_type: 'video', avg_frame_rate: '30/1', width: 1920, height: 1080, duration: '10',
            color_transfer: 'unknown', color_primaries: 'bt2020',
          },
        ],
      }),
    );
    const p = await probe('/in.mp4');
    expect(p.color).toEqual({ transfer: 'unknown', primaries: 'bt2020' });
  });
});

describe('transcribe', () => {
  it('passes explicit --beam-size/--best-of/--split-on-word and records provenance meta on the transcript', async () => {
    const controller = new AbortController();
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
    const t = await transcribe('/in.mp4', 'src1', { model: '/models/ggml-small.bin', signal: controller.signal });
    const ffmpegCall = runMock.mock.calls.find(([cmd]) => cmd === 'ffmpeg') as [string, string[], { signal?: AbortSignal }];
    const whisperCall = runMock.mock.calls.find(([cmd]) => cmd === 'whisper-cli') as [string, string[], { signal?: AbortSignal }];
    const [, args] = whisperCall;
    expect(ffmpegCall[2].signal).toBe(controller.signal);
    expect(whisperCall[2].signal).toBe(controller.signal);
    expect(args).toEqual(expect.arrayContaining(['--beam-size', '5', '--best-of', '5', '--split-on-word']));
    const meta = (t as any).meta;
    expect(meta.model).toBe('ggml-small.bin');
    expect(meta.args).toEqual(args);
    expect(meta.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.words).toHaveLength(1);
    expect(t.words[0].text).toBe('hello');
  });

  it('retries a crashed whisper Metal process once on CPU and records the effective args', async () => {
    runMock.mockReset();
    let whisperCalls = 0;
    runMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd !== 'whisper-cli') return '';
      whisperCalls++;
      if (whisperCalls === 1) {
        throw Object.assign(new Error('whisper-cli failed'), { signal: 'SIGSEGV' });
      }
      const outBase = args[args.indexOf('-of') + 1];
      await fs.writeFile(
        `${outBase}.json`,
        JSON.stringify({ transcription: [], result: { language: 'en' } }),
      );
      return '';
    });

    const t = await transcribe('/in.mp4', 'src1', { model: '/models/ggml-small.bin' });
    const whisperInvocations = runMock.mock.calls.filter(([cmd]) => cmd === 'whisper-cli');
    expect(whisperInvocations).toHaveLength(2);
    expect(whisperInvocations[0][1]).not.toContain('--no-gpu');
    expect(whisperInvocations[1][1]).toContain('--no-gpu');
    expect((t as any).meta.args).toContain('--no-gpu');
  });

  it('does not retry ordinary whisper errors as CPU work', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'whisper-cli') throw new Error('invalid model');
      return '';
    });

    await expect(transcribe('/in.mp4', 'src1', { model: '/models/bad.bin' }))
      .rejects.toThrow('invalid model');
    expect(runMock.mock.calls.filter(([cmd]) => cmd === 'whisper-cli')).toHaveLength(1);
  });

  it('removes its ASR temp directory when extraction fails or is cancelled', async () => {
    const controller = new AbortController();
    let asrTmp: string | undefined;
    runMock.mockReset();
    runMock.mockImplementation(async (cmd: string, args: string[], opts?: { signal?: AbortSignal }) => {
      if (cmd === 'ffmpeg') {
        asrTmp = path.dirname(args[args.length - 1]);
        expect(opts?.signal).toBe(controller.signal);
        const error = new Error('operation cancelled');
        error.name = 'AbortError';
        throw error;
      }
      return '';
    });

    await expect(transcribe('/in.mp4', 'src1', {
      model: '/models/ggml-small.bin',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(asrTmp).toMatch(/vedit-asr-/);
    await expect(fs.access(asrTmp!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // ---- roadmap "whisper 用語集プロンプト": buildWhisperPrompt is pure
  // (no whisper invocation needed) — see its doc in ingest.ts. ----
  it('buildWhisperPrompt joins trimmed, non-empty terms with a Japanese comma', () => {
    expect(buildWhisperPrompt(['ヴィエディット', ' Claude ', '空 ']))
      .toBe('ヴィエディット、Claude、空');
  });

  it('buildWhisperPrompt drops empty/whitespace-only terms', () => {
    expect(buildWhisperPrompt(['', '  ', 'termA'])).toBe('termA');
  });

  it('buildWhisperPrompt returns "" for an empty or all-blank glossary', () => {
    expect(buildWhisperPrompt([])).toBe('');
    expect(buildWhisperPrompt(['', '   '])).toBe('');
  });

  it('transcribe passes --prompt to whisper-cli when glossary is given, omits it otherwise', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'whisper-cli') {
        const outBase = args[args.indexOf('-of') + 1];
        await fs.writeFile(
          `${outBase}.json`,
          JSON.stringify({ transcription: [], result: { language: 'ja' } }),
        );
      }
      return '';
    });
    await transcribe('/in.mp4', 'src1', { model: '/models/ggml-small.bin', glossary: ['ヴィエディット', 'Claude'] });
    const withGlossary = runMock.mock.calls.find(([cmd]) => cmd === 'whisper-cli') as [string, string[]];
    expect(withGlossary[1]).toEqual(expect.arrayContaining(['--prompt', 'ヴィエディット、Claude']));

    runMock.mockClear();
    await transcribe('/in.mp4', 'src1', { model: '/models/ggml-small.bin' });
    const withoutGlossary = runMock.mock.calls.find(([cmd]) => cmd === 'whisper-cli') as [string, string[]];
    expect(withoutGlossary[1]).not.toContain('--prompt');
  });
});

describe('ingestFile concurrency', () => {
  // ingest-batch (src/ingest/batch.ts) runs up to 2 ingests concurrently for
  // the slow proxy/transcribe work, but Project.commit() rejects a stale
  // baseRev. ingestFile reads the manifest and commits against it as its
  // very last step — a straightforward read-then-write race when a second
  // concurrent ingestFile lands its own commit in between. This is a
  // regression test for the retry-on-STALE_REVISION loop that closes that
  // race: both ingests must land as two distinct sources, not one succeeding
  // and the other throwing.
  it('retries on stale-revision conflicts so two concurrent ingests both land', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'ffprobe') {
        return JSON.stringify({
          format: { duration: '5' },
          streams: [{ codec_type: 'video', avg_frame_rate: '30/1', width: 640, height: 360, duration: '5' }],
          // no audio stream: skips peaks + transcribe entirely, keeping this
          // test focused on the commit race rather than needing to also fake
          // whisper-cli output.
        });
      }
      return ''; // ffmpeg (makeProxy) — no real encode needed, argv isn't asserted here
    });

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-race-'));
    const project = await Project.create(path.join(root, 'proj'), 'race');
    const fileA = path.join(root, 'a.mp4');
    const fileB = path.join(root, 'b.mp4');
    await fs.writeFile(fileA, 'a');
    await fs.writeFile(fileB, 'b');

    const [ra, rb] = await Promise.all([
      // scenes: false — this test is specifically about the commit-retry
      // race, not scene detection (which now defaults on; see the
      // "ingestFile defaults (W-LAZY)" suite below) — keeping it off here
      // keeps the assertions below focused on revision/commit outcomes.
      ingestFile(project, fileA, { transcribe: false, scenes: false }),
      ingestFile(project, fileB, { transcribe: false, scenes: false }),
    ]);

    expect(ra.source.id).not.toBe(rb.source.id);
    const m = await project.manifest();
    expect(m.sources.map((s) => s.id).sort()).toEqual([ra.source.id, rb.source.id].sort());
    expect(m.timeline.video).toHaveLength(2);
    expect(m.revision).toBe(2); // two accepted commits, no lost update
  });
});

describe('ingestFile defaults (W-LAZY: transcribe off, scenes on)', () => {
  let previousWhisperModel: string | undefined;

  beforeAll(() => {
    previousWhisperModel = process.env.VEDIT_WHISPER_MODEL;
    // The subprocess runner is mocked in this suite, so a stable explicit
    // model path keeps the tests independent of any model installed for the
    // developer account.
    process.env.VEDIT_WHISPER_MODEL = '/models/ggml-test.bin';
  });

  afterAll(() => {
    if (previousWhisperModel === undefined) delete process.env.VEDIT_WHISPER_MODEL;
    else process.env.VEDIT_WHISPER_MODEL = previousWhisperModel;
  });

  function fakeFfprobe(hasAudioStream: boolean, duration = '6') {
    return JSON.stringify({
      format: { duration },
      streams: [
        { codec_type: 'video', avg_frame_rate: '30/1', width: 640, height: 360, duration },
        ...(hasAudioStream ? [{ codec_type: 'audio' }] : []),
      ],
    });
  }
  function fakeWhisperOutput(args: string[], text = 'hi', toMs = 300): Promise<void> {
    const outBase = args[args.indexOf('-of') + 1];
    return fs.writeFile(
      `${outBase}.json`,
      JSON.stringify({
        transcription: [{ tokens: [{ text, offsets: { from: 0, to: toMs }, p: 0.9 }] }],
        result: { language: 'ja' },
      }),
    );
  }

  it('removes a partial proxy when ffmpeg fails before the source is committed', async () => {
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeFfprobe(false);
      if (cmd === 'ffmpeg' && String(args.at(-1)).includes('proxy-')) {
        await fs.writeFile(args.at(-1)!, 'partial proxy bytes');
        throw new Error('proxy encoder failed');
      }
      return '';
    });
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-proxy-cleanup-'));
    const project = await Project.create(path.join(root, 'proj'), 'proxy-cleanup');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    await expect(ingestFile(project, file, { scenes: false })).rejects.toThrow(/proxy encoder failed/);
    expect((await project.manifest()).sources).toEqual([]);
    expect(await fs.readdir(project.cacheDir)).toEqual([]);
  });

  it('removes proxy, waveform, transcript and scene sidecars when late scene detection fails', async () => {
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeFfprobe(true);
      if (cmd === 'whisper-cli') await fakeWhisperOutput(args);
      if (cmd === 'ffmpeg' && String(args.at(-1)).includes('proxy-')) {
        await fs.writeFile(args.at(-1)!, 'complete proxy bytes');
      }
      return '';
    });
    runCaptureMock.mockReset().mockRejectedValue(new Error('scene detector failed'));
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-late-cleanup-'));
    const project = await Project.create(path.join(root, 'proj'), 'late-cleanup');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    await expect(ingestFile(project, file, { transcribe: true })).rejects.toThrow(/scene detector failed/);
    expect((await project.manifest()).sources).toEqual([]);
    const rootNames = await fs.readdir(project.dir);
    expect(rootNames.some((name) => name.startsWith('transcript-') || name.startsWith('scenes-'))).toBe(false);
    expect(await fs.readdir(project.cacheDir)).toEqual([]);
  });

  it('cancels an in-flight proxy child, removes every partial, leaves revision truth untouched, and can retry', async () => {
    let proxyStarted!: () => void;
    const proxyIsRunning = new Promise<void>((resolve) => { proxyStarted = resolve; });
    runMock.mockReset().mockImplementation(async (cmd: string, args: string[], runOpts?: { signal?: AbortSignal }) => {
      if (cmd === 'ffprobe') return fakeFfprobe(false);
      if (cmd === 'ffmpeg' && String(args.at(-1)).includes('proxy-')) {
        await fs.writeFile(args.at(-1)!, 'partial proxy bytes');
        proxyStarted();
        return new Promise<string>((_resolve, reject) => {
          runOpts?.signal?.addEventListener('abort', () => {
            const error = new Error('operation cancelled');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return '';
    });
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-cancel-cleanup-'));
    const project = await Project.create(path.join(root, 'proj'), 'cancel-cleanup');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');
    const controller = new AbortController();

    const first = ingestFile(project, file, { scenes: false, signal: controller.signal });
    await proxyIsRunning;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect((await project.manifest()).revision).toBe(0);
    expect((await project.manifest()).sources).toEqual([]);
    expect(await fs.readdir(project.cacheDir)).toEqual([]);

    runMock.mockReset().mockImplementation(async (cmd: string) => (cmd === 'ffprobe' ? fakeFfprobe(false) : ''));
    const retry = await ingestFile(project, file, { scenes: false });
    expect(retry.source.path).toBe(file);
    expect((await project.manifest()).revision).toBe(1);
    expect((await project.manifest()).sources).toHaveLength(1);
  });

  it('threads one AbortSignal through probe, proxy, peaks, scene analysis and thumbnail children', async () => {
    runMock.mockReset().mockImplementation(async (cmd: string) => (cmd === 'ffprobe' ? fakeFfprobe(true) : ''));
    runBinaryMock.mockReset().mockResolvedValue(Buffer.alloc(0));
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-signal-chain-'));
    const project = await Project.create(path.join(root, 'proj'), 'signal-chain');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');
    const controller = new AbortController();

    await ingestFile(project, file, { signal: controller.signal });

    const ffprobe = runMock.mock.calls.find(([cmd]) => cmd === 'ffprobe');
    const proxy = runMock.mock.calls.find(([cmd, args]) => cmd === 'ffmpeg' && String(args.at(-1)).includes('proxy-'));
    const thumb = runMock.mock.calls.find(([cmd, args]) => cmd === 'ffmpeg' && String(args.at(-1)).includes('.tmp-'));
    expect(ffprobe?.[2]).toMatchObject({ signal: controller.signal });
    expect(proxy?.[2]).toMatchObject({ signal: controller.signal });
    expect(runBinaryMock.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(runCaptureMock.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(thumb?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('keeps the previous scene index/thumbnails intact when thumbnail generation is cancelled, then retries cleanly', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vedit-scenes-cancel-staging-'));
    const project = await Project.create(path.join(root, 'proj'), 'scene-cancel-staging');
    const media = path.join(root, 'clip.mp4');
    await fs.writeFile(media, 'x');
    await project.commit(0, 'system', 'setup', {}, 'source', (m) => ({
      ...m,
      sources: [{ id: 's1', path: media, duration: 6, fps: 30, width: 640, height: 360, hasAudio: false }],
    }));
    const oldThumb = path.join(project.cacheDir, 'sc-s1-s0001.jpg');
    await fs.writeFile(oldThumb, 'old-thumb');
    await project.writeScenes({
      sourceId: 's1',
      scenes: [{
        id: 's0001', t0: 0, t1: 6, thumb: 'cache/sc-s1-s0001.jpg',
        hasSpeech: false, energy: 0,
        note: { text: 'keep this note', by: 'user', at: new Date().toISOString() },
      }],
    });
    const before = await project.scenes('s1');
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: 'pts_time:3.000' });
    let secondStarted!: () => void;
    const secondIsRunning = new Promise<void>((resolve) => { secondStarted = resolve; });
    let thumbnail = 0;
    runMock.mockReset().mockImplementation(async (_cmd: string, args: string[], runOpts?: { signal?: AbortSignal }) => {
      if (!String(args.at(-1)).includes('.tmp-')) return '';
      thumbnail++;
      if (thumbnail === 1) return '';
      await fs.writeFile(args.at(-1)!, 'partial-new-thumb');
      secondStarted();
      return new Promise<string>((_resolve, reject) => {
        runOpts?.signal?.addEventListener('abort', () => {
          const error = new Error('operation cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    const controller = new AbortController();
    const detection = detectScenesForSource(project, await project.manifest(), 's1', { signal: controller.signal });
    await secondIsRunning;
    controller.abort();
    await expect(detection).rejects.toMatchObject({ name: 'AbortError' });

    expect(await project.scenes('s1')).toEqual(before);
    expect(await fs.readFile(oldThumb, 'utf8')).toBe('old-thumb');
    expect((await fs.readdir(project.cacheDir)).filter((name) => name.includes('.tmp-') || name.includes('.bak-'))).toEqual([]);

    runMock.mockReset().mockResolvedValue('');
    const retried = await detectScenesForSource(project, await project.manifest(), 's1');
    expect(retried.scenes).toHaveLength(2);
    expect(retried.scenes[0].note?.text).toBe('keep this note');
    expect((await fs.readdir(project.cacheDir)).some((name) => name.includes('.tmp-') || name.includes('.bak-'))).toBe(false);
  });

  it('does not transcribe by default even when the source has audio', async () => {
    runMock.mockReset();
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    runMock.mockImplementation(async (cmd: string) => (cmd === 'ffprobe' ? fakeFfprobe(true) : ''));

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-lazy-'));
    const project = await Project.create(path.join(root, 'proj'), 'lazy');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    const { source } = await ingestFile(project, file);
    expect(source.transcribed).toBe(false);
    expect(runMock.mock.calls.some(([cmd]) => cmd === 'whisper-cli')).toBe(false);
    await expect(project.transcript(source.id)).rejects.toThrow(); // no transcript-<id>.json was ever written
  });

  it('runs scene detection by default, without needing --transcribe first', async () => {
    runMock.mockReset();
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' }); // no scene-change boundaries -> one whole-clip scene
    runMock.mockImplementation(async (cmd: string) => (cmd === 'ffprobe' ? fakeFfprobe(false) : ''));

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-scenes-'));
    const project = await Project.create(path.join(root, 'proj'), 'scenes-default');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    const { source } = await ingestFile(project, file);
    const scenes = await project.scenes(source.id);
    expect(scenes.scenes.length).toBeGreaterThan(0);
    expect(runCaptureMock).toHaveBeenCalled();
  });

  it('skips scene detection when scenes:false is passed (--no-scenes)', async () => {
    runMock.mockReset();
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    runMock.mockImplementation(async (cmd: string) => (cmd === 'ffprobe' ? fakeFfprobe(false) : ''));

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-noscenes-'));
    const project = await Project.create(path.join(root, 'proj'), 'no-scenes');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    const { source } = await ingestFile(project, file, { scenes: false });
    const scenes = await project.scenes(source.id);
    expect(scenes.scenes).toEqual([]); // Project.scenes() falls back to an empty SceneFile when none was ever written
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it('still transcribes when opts.transcribe is explicitly true (old "transcribe at ingest" behavior)', async () => {
    runMock.mockReset();
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    runMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeFfprobe(true);
      if (cmd === 'whisper-cli') await fakeWhisperOutput(args);
      return '';
    });

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-explicit-'));
    const project = await Project.create(path.join(root, 'proj'), 'explicit');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    const { source } = await ingestFile(project, file, { transcribe: true, scenes: false });
    expect(source.transcribed).toBe(true);
    const t = await project.transcript(source.id);
    expect(t.words[0].text).toBe('hi');
  });

  it('scenes detected alongside an explicit transcribe:true reflect hasSpeech from that same transcript', async () => {
    // Regression coverage for ordering: detectScenesForSource is handed a
    // manifest built via ingestFile's own buildNext (source + its
    // full-range timeline clip), NOT the on-disk pre-commit manifest —
    // otherwise keptWords() sees no segment for this brand-new source yet
    // and every scene would come back hasSpeech:false regardless of the
    // transcript (see the comment above buildNext in ingest.ts).
    runMock.mockReset();
    runCaptureMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' }); // one whole-clip scene
    runMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return fakeFfprobe(true);
      if (cmd === 'whisper-cli') await fakeWhisperOutput(args);
      return '';
    });

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-hasspeech-'));
    const project = await Project.create(path.join(root, 'proj'), 'hasspeech');
    const file = path.join(root, 'clip.mp4');
    await fs.writeFile(file, 'x');

    const { source } = await ingestFile(project, file, { transcribe: true });
    const scenes = await project.scenes(source.id);
    expect(scenes.scenes.length).toBeGreaterThan(0);
    expect(scenes.scenes.every((s) => s.hasSpeech)).toBe(true);
  });
});

// ---- オーバーレイ・スタック: isImageFile / probeImage / ingestImageFile ----

describe('isImageFile', () => {
  it('recognizes png/jpg/jpeg/webp case-insensitively', () => {
    expect(isImageFile('/x/logo.png')).toBe(true);
    expect(isImageFile('/x/photo.JPG')).toBe(true);
    expect(isImageFile('/x/photo.jpeg')).toBe(true);
    expect(isImageFile('/x/sticker.WebP')).toBe(true);
  });

  it('rejects video/other extensions', () => {
    expect(isImageFile('/x/clip.mp4')).toBe(false);
    expect(isImageFile('/x/clip.mov')).toBe(false);
    expect(isImageFile('/x/notes.txt')).toBe(false);
    expect(isImageFile('/x/no-extension')).toBe(false);
  });
});

describe('IMAGE_SOURCE_DURATION', () => {
  it('is a large but finite, JSON-safe number (not Infinity, which would serialize to null and corrupt the manifest)', () => {
    expect(Number.isFinite(IMAGE_SOURCE_DURATION)).toBe(true);
    expect(IMAGE_SOURCE_DURATION).toBeGreaterThan(3600); // comfortably longer than any practical overlay
    expect(JSON.parse(JSON.stringify({ d: IMAGE_SOURCE_DURATION })).d).toBe(IMAGE_SOURCE_DURATION);
  });
});

describe('probeImage', () => {
  it('extracts width/height from ffprobe, without requiring (or reporting) a duration', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'png', width: 400, height: 200, pix_fmt: 'rgba' }],
      }),
    );
    const p = await probeImage('/logo.png');
    expect(p).toEqual({ width: 400, height: 200 });
  });

  it('throws a clear error when ffprobe reports no video stream or unusable dimensions', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(JSON.stringify({ streams: [] }));
    await expect(probeImage('/broken.png')).rejects.toThrow(/no usable image dimensions/);

    runMock.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video', width: 0, height: 0 }] }));
    await expect(probeImage('/zero.png')).rejects.toThrow(/no usable image dimensions/);
  });
});

describe('ingestImageFile', () => {
  function fakeImageProbe(width = 400, height = 200) {
    return JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', width, height }] });
  }

  it('creates a kind:"image" Source with the probed dimensions, hasAudio:false, fps:0, and the IMAGE_SOURCE_DURATION sentinel — no proxy/peaks/transcribed fields', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(fakeImageProbe(400, 200));

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-image-'));
    const project = await Project.create(path.join(root, 'proj'), 'img-test');
    const file = path.join(root, 'logo.png');
    await fs.writeFile(file, 'x');

    const { source, timings } = await ingestImageFile(project, file);
    expect(source.kind).toBe('image');
    expect(source.width).toBe(400);
    expect(source.height).toBe(200);
    expect(source.hasAudio).toBe(false);
    expect(source.fps).toBe(0);
    expect(source.duration).toBe(IMAGE_SOURCE_DURATION);
    expect(source.proxy).toBeUndefined();
    expect(source.peaks).toBeUndefined();
    expect(source.transcribed).toBeUndefined();
    expect(timings.probeMs).toBeGreaterThanOrEqual(0);

    const m = await project.manifest();
    expect(m.sources).toHaveLength(1);
    expect(m.sources[0].id).toBe(source.id);
  });

  it('never adds the image to timeline.video, even into a brand-new project with no other sources yet', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(fakeImageProbe());

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-image-notl-'));
    const project = await Project.create(path.join(root, 'proj'), 'img-notl');
    const file = path.join(root, 'logo.png');
    await fs.writeFile(file, 'x');

    await ingestImageFile(project, file);
    const m = await project.manifest();
    expect(m.timeline.video).toEqual([]);
  });

  it('never touches manifest-level fps/width/height, even as the very first source ingested', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(fakeImageProbe(4000, 3000)); // deliberately NOT the project's own canvas size

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-image-canvas-'));
    const project = await Project.create(path.join(root, 'proj'), 'img-canvas');
    const before = await project.manifest();
    const file = path.join(root, 'logo.png');
    await fs.writeFile(file, 'x');

    await ingestImageFile(project, file);
    const after = await project.manifest();
    expect(after.fps).toBe(before.fps);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
  });

  it('records sha256 when given, same as the video ingest path', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(fakeImageProbe());

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingest-image-sha-'));
    const project = await Project.create(path.join(root, 'proj'), 'img-sha');
    const file = path.join(root, 'logo.png');
    await fs.writeFile(file, 'x');

    const { source } = await ingestImageFile(project, file, { sha256: 'deadbeef' });
    expect(source.sha256).toBe('deadbeef');
  });
});

describe('ingestFile routes image files to ingestImageFile automatically', () => {
  it('a .png file ingested via ingestFile produces a kind:"image" source without ever calling makeProxy/scene-detection', async () => {
    runMock.mockReset();
    runCaptureMock.mockReset();
    runMock.mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'png', width: 100, height: 50 }] }));

    const root = mkdtempSync(path.join(tmpdir(), 'vedit-ingestfile-image-'));
    const project = await Project.create(path.join(root, 'proj'), 'ingestfile-image');
    const file = path.join(root, 'sticker.png');
    await fs.writeFile(file, 'x');

    const { source } = await ingestFile(project, file, { scenes: true, transcribe: true, addToTimeline: true });
    expect(source.kind).toBe('image');
    expect(source.width).toBe(100);
    expect(source.height).toBe(50);
    // scenes/transcribe/addToTimeline were all requested but must be silently
    // ignored for an image — no scene-change ffmpeg call, no timeline entry.
    expect(runCaptureMock).not.toHaveBeenCalled();
    const m = await project.manifest();
    expect(m.timeline.video).toEqual([]);
    // No proxy/peaks -> ffmpeg's video-encode `-c:v libx264` proxy args never appear in any run() call.
    expect(runMock.mock.calls.every(([cmd]) => cmd === 'ffprobe')).toBe(true);
  });
});
