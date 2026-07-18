import { describe, expect, it, vi } from 'vitest';
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
const { runMock, runCaptureMock, hasFilterMock } = vi.hoisted(() => ({
  runMock: vi.fn().mockResolvedValue(''),
  runCaptureMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  hasFilterMock: vi.fn(() => true),
}));
vi.mock('./run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  runBinary: vi.fn().mockResolvedValue(Buffer.alloc(0)),
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
  ffmpegHasFilter: (...args: unknown[]) => hasFilterMock(...args),
}));

import {
  buildWhisperPrompt,
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
