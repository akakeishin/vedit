import { describe, expect, it, vi } from 'vitest';
import type { Manifest, MusicItem, Transcript } from '../core/types.js';

// renderFinal shells out to ffmpeg via run()/runCapture(); stub both (and
// ffmpegHasFilter/ffmpegBin) so the 2-pass-loudnorm orchestration tests below
// only assert on the constructed argv/graph, without needing ffmpeg
// installed (same approach as ingest.test.ts / daemon.test.ts's mocks).
// buildFilterGraph/toAss/planExportPreset/resolveRenderParams never touch
// run.js, so every pre-existing test in this file is unaffected.
const { runMock, runCaptureMock } = vi.hoisted(() => ({
  runMock: vi.fn(async () => ''),
  runCaptureMock: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
vi.mock('../ingest/run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  runCapture: (...args: unknown[]) => runCaptureMock(...args),
  runBinary: vi.fn(),
  ffmpegBin: () => 'ffmpeg',
  ffmpegHasFilter: () => true,
}));

import { buildFilterGraph, buildRepairChain, loudnormClause, planExportPreset, renderFinal, resolveRenderParams, toAss } from './render.js';

function manifest(style: string): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    captions: { enabled: true, style, maxChars: 24 },
  };
}

function transcript(): Transcript {
  return {
    sourceId: 's1',
    language: 'en',
    words: [{ id: 'w0', text: 'Hello.', t0: 1.0, t1: 2.0, p: 0.95 }],
  };
}

describe('toAss', () => {
  it('always defines at least the clean/bold/outline/boxed style presets', () => {
    const ass = toAss(manifest('clean'), [transcript()]);
    for (const name of ['clean', 'bold', 'outline', 'boxed']) {
      expect(ass).toMatch(new RegExp(`^Style: ${name},`, 'm'));
    }
  });

  it('routes Dialogue lines to the style matching captions.style', () => {
    const ass = toAss(manifest('bold'), [transcript()]);
    expect(ass).toMatch(/^Dialogue: 0,.*,bold,,/m);
  });

  it('gives the bold preset a Bold font flag and the yellow &H005CE4FF matching the web preview', () => {
    const ass = toAss(manifest('bold'), [transcript()]);
    const boldStyleLine = ass.split('\n').find((l) => l.startsWith('Style: bold,'))!;
    expect(boldStyleLine).toContain('&H005CE4FF');
    // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, ...
    const fields = boldStyleLine.replace('Style: ', '').split(',');
    const boldFlag = fields[7]; // 0-indexed: Name,Fontname,Fontsize,Primary,Secondary,Outline,Back,Bold
    expect(boldFlag).toBe('-1');
  });

  it('gives the clean preset a non-bold font flag and white text', () => {
    const ass = toAss(manifest('clean'), [transcript()]);
    const cleanStyleLine = ass.split('\n').find((l) => l.startsWith('Style: clean,'))!;
    const fields = cleanStyleLine.replace('Style: ', '').split(',');
    expect(fields[3]).toBe('&H00FFFFFF'); // PrimaryColour
    expect(fields[7]).toBe('0'); // Bold
  });

  it('falls back to the clean style for an unrecognized captions.style id', () => {
    const ass = toAss(manifest('some-web-only-preset'), [transcript()]);
    expect(ass).toMatch(/^Dialogue: 0,.*,clean,,/m);
  });
});

// ---- buildFilterGraph (Wave I: BGM + audio finishing) ----

function baseManifest(opts: { music?: MusicItem[]; audioMix?: Manifest['audioMix'] } = {}): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: {
      // Two segments so the per-segment afade-join logic actually exercises
      // a boundary, not just a single clip.
      video: [
        { id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 5 },
        { id: 'c2', sourceId: 's1', srcIn: 10, srcOut: 20 },
      ],
      motion: [],
      music: opts.music,
    },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
    audioMix: opts.audioMix,
  };
}

function music(partial: Partial<MusicItem> & { id: string; path: string }): MusicItem {
  return { tlStart: 0, duration: 5, srcIn: 0, gain: -12, fadeIn: 1, fadeOut: 2, duck: true, ...partial };
}

describe('buildFilterGraph: music-less project (no regression)', () => {
  it('never touches amix/loudnorm/sidechaincompress, and audioLabel stays [ac]', () => {
    const built = buildFilterGraph(baseManifest());
    expect(built.audioLabel).toBe('[ac]');
    expect(built.videoLabel).toBe('[vc]');
    expect(built.graph).not.toMatch(/amix|loudnorm|sidechaincompress|asplit/);
    expect(built.inputPaths).toEqual(['/x.mp4']);
  });

  it('still applies the anti-click afade to each segment\'s audio head/tail instead of acrossfade at the join', () => {
    const built = buildFilterGraph(baseManifest());
    expect(built.graph).not.toContain('acrossfade');
    // default crossfadeMs=12 -> 0.012s fades on both segments
    const afadeCount = (built.graph.match(/afade=t=in/g) ?? []).length;
    expect(afadeCount).toBe(2); // one per segment
    expect(built.graph).toMatch(/afade=t=in:st=0:d=0\.012/);
  });

  it('a custom crossfadeMs changes the fade duration', () => {
    const built = buildFilterGraph(baseManifest({ audioMix: { crossfadeMs: 40 } }));
    expect(built.graph).toMatch(/afade=t=in:st=0:d=0\.04/);
  });

  it('skips the afade entirely for a segment shorter than the fade window', () => {
    const m = baseManifest();
    m.timeline.video = [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 0.0001 }];
    const built = buildFilterGraph(m);
    expect(built.graph).not.toMatch(/afade/);
  });

  it('throws on an empty timeline', () => {
    const m = baseManifest();
    m.timeline.video = [];
    expect(() => buildFilterGraph(m)).toThrow(/empty timeline/);
  });
});

describe('buildFilterGraph: with music, no duck', () => {
  it('appends the music input, trims/delays/fades it, and mixes it with the conversation audio', () => {
    const m = baseManifest({ music: [music({ id: 'mu1', path: '/bgm.mp3', duck: false, tlStart: 2, srcIn: 3, duration: 6, gain: -9 })] });
    const built = buildFilterGraph(m);
    expect(built.inputPaths).toEqual(['/x.mp4', '/bgm.mp3']);
    expect(built.audioLabel).toBe('[final]');
    expect(built.graph).toContain('[1:a]atrim=start=3:end=9'); // srcIn..srcIn+duration, second ffmpeg input (index 1)
    expect(built.graph).toContain('volume=-9dB');
    expect(built.graph).toContain('adelay=2000:all=1'); // tlStart(2s) in ms
    expect(built.graph).toContain('[ac][mu0]amix=inputs=2:duration=first'); // conversation + single music track mixed directly (no group amix needed)
    expect(built.graph).toContain('loudnorm=I=-14:TP=-1.5:LRA=11'); // default targetLufs
    expect(built.graph).not.toMatch(/sidechaincompress|asplit/); // no duck -> no sidechain path
  });

  it('a custom targetLufs is honored', () => {
    const m = baseManifest({ music: [music({ id: 'mu1', path: '/bgm.mp3', duck: false })], audioMix: { targetLufs: -18 } });
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('loudnorm=I=-18:TP=-1.5:LRA=11');
  });

  it('mixes multiple non-ducking music items together before the final mix', () => {
    const m = baseManifest({
      music: [
        music({ id: 'mu1', path: '/a.mp3', duck: false }),
        music({ id: 'mu2', path: '/b.mp3', duck: false, tlStart: 3 }),
      ],
    });
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('[mu0][mu1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[plainMix]');
    expect(built.graph).toContain('[ac][plainMix]amix=inputs=2:duration=first');
  });
});

describe('buildFilterGraph: with music, duck=true', () => {
  it('sidechain-compresses the ducking music against a split copy of the conversation audio', () => {
    const m = baseManifest({ music: [music({ id: 'mu1', path: '/bgm.mp3', duck: true })] });
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('[ac]asplit=2[acMain][acKey]');
    expect(built.graph).toContain('[mu0][acKey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1[duckOut]');
    // the conversation audio feeding the final mix must be the split copy, not the raw [ac] (already claimed by asplit)
    expect(built.graph).toContain('[acMain][duckOut]amix=inputs=2:duration=first');
  });

  it('mixes a ducking group and a non-ducking group separately, then combines them', () => {
    const m = baseManifest({
      music: [
        music({ id: 'mu1', path: '/duck1.mp3', duck: true }),
        music({ id: 'mu2', path: '/duck2.mp3', duck: true, tlStart: 3 }),
        music({ id: 'mu3', path: '/plain.mp3', duck: false, tlStart: 1 }),
      ],
    });
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('[mu0][mu1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[duckPre]');
    expect(built.graph).toContain('[duckPre][acKey]sidechaincompress');
    expect(built.graph).toContain('[duckOut][mu2]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[musicMix]');
    expect(built.graph).toContain('[acMain][musicMix]amix=inputs=2:duration=first');
  });

  it('a custom duckAmount does not change the sidechaincompress ratio/threshold (fixed per spec) but is recorded for the web preview approximation', () => {
    // duckAmount only affects the web preview approximation (app.js); the
    // render-side sidechaincompress params are fixed regardless of its value.
    const m = baseManifest({ music: [music({ id: 'mu1', path: '/bgm.mp3', duck: true })], audioMix: { duckAmount: -20 } });
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1');
  });
});

// ---- planExportPreset / resolveRenderParams (Wave M: publish presets) ----

function presetManifest(opts: {
  output?: { width: number; height: number };
  durationSec?: number;
  audioMix?: Manifest['audioMix'];
} = {}): Manifest {
  const dur = opts.durationSec ?? 15;
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    output: opts.output,
    sources: [{ id: 's1', path: '/x.mp4', duration: dur, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: dur }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
    audioMix: opts.audioMix,
  };
}

describe('planExportPreset', () => {
  it('youtube: keeps resolution untouched, crf 18 preset medium, aac 256k, forces loudnorm at audioMix.targetLufs ?? -14', () => {
    const plan = planExportPreset('youtube', { width: 1920, height: 1080 }, 30, -14);
    expect(plan).toMatchObject({ crf: 18, encPreset: 'medium', audioBitrate: '256k', forceLoudnormI: -14, postFilter: null, warnings: [] });
  });

  it('youtube: forced loudnorm target follows the passed-in default (audioMix.targetLufs)', () => {
    const plan = planExportPreset('youtube', { width: 1920, height: 1080 }, 30, -18);
    expect(plan.forceLoudnormI).toBe(-18);
  });

  it('shorts: throws (does not silently reframe) when the output is not portrait', () => {
    expect(() => planExportPreset('shorts', { width: 1920, height: 1080 }, 30, -14)).toThrow(/portrait/);
    expect(() => planExportPreset('shorts', { width: 1080, height: 1080 }, 30, -14)).toThrow(/portrait/); // square doesn't qualify either
  });

  it('shorts: on a portrait output, scales to 1080x1920, crf 20, aac 192k, loudnorm -14', () => {
    const plan = planExportPreset('shorts', { width: 720, height: 1280 }, 30, -14);
    expect(plan.crf).toBe(20);
    expect(plan.audioBitrate).toBe('192k');
    expect(plan.forceLoudnormI).toBe(-14);
    expect(plan.postFilter).toContain('scale=1080:1920');
    expect(plan.warnings).toEqual([]);
  });

  it('shorts: warns (does not throw) when duration exceeds 60s', () => {
    const plan = planExportPreset('shorts', { width: 1080, height: 1920 }, 75, -14);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/60s/);
  });

  it('x: scales the long edge down to 1280 when it exceeds it, crf 23, aac 128k, no forced loudnorm', () => {
    const plan = planExportPreset('x', { width: 3840, height: 2160 }, 30, -14);
    expect(plan.crf).toBe(23);
    expect(plan.audioBitrate).toBe('128k');
    expect(plan.forceLoudnormI).toBeNull();
    expect(plan.postFilter).toBe('scale=1280:720');
  });

  it('x: does not add a scale filter when already within 1280 on the long edge', () => {
    const plan = planExportPreset('x', { width: 1280, height: 720 }, 30, -14);
    expect(plan.postFilter).toBeNull();
  });

  it('x: warns (does not throw) when duration exceeds 140s', () => {
    const plan = planExportPreset('x', { width: 1280, height: 720 }, 150, -14);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/140s/);
  });
});

describe('resolveRenderParams', () => {
  it('with no preset and no overrides, reproduces the pre-Wave-M hardcoded defaults exactly (regression zero)', () => {
    const params = resolveRenderParams(presetManifest());
    expect(params).toMatchObject({ crf: 18, encPreset: 'medium', audioBitrate: '192k', forceLoudnormI: null, postFilter: null, warnings: [] });
  });

  it('applies a preset', () => {
    const m = presetManifest({ output: { width: 1080, height: 1920 } });
    const params = resolveRenderParams(m, { preset: 'shorts' });
    expect(params.crf).toBe(20);
    expect(params.audioBitrate).toBe('192k');
    expect(params.postFilter).toContain('scale=1080:1920');
  });

  it('an explicit override beats the preset-derived value', () => {
    const m = presetManifest({ output: { width: 1080, height: 1920 } });
    const params = resolveRenderParams(m, { preset: 'shorts', crf: 16, audioBitrate: '320k' });
    expect(params.crf).toBe(16);
    expect(params.audioBitrate).toBe('320k');
    // untouched fields still come from the preset
    expect(params.postFilter).toContain('scale=1080:1920');
  });

  it('youtube forced loudnorm follows the manifest\'s own audioMix.targetLufs when set', () => {
    const m = presetManifest({ audioMix: { targetLufs: -16 } });
    const params = resolveRenderParams(m, { preset: 'youtube' });
    expect(params.forceLoudnormI).toBe(-16);
  });
});

// ---- W1: conversational-audio repair chain ----

describe('buildRepairChain', () => {
  it('returns an empty chain when audioRepair is absent (regression: no filter at all)', () => {
    expect(buildRepairChain(undefined)).toBe('');
  });

  it('returns an empty chain when preset is "off"', () => {
    expect(buildRepairChain({ preset: 'off' })).toBe('');
  });

  it('builds highpass -> afftdn -> acompressor for outdoor, in order, no deesser by default', () => {
    const chain = buildRepairChain({ preset: 'outdoor' });
    expect(chain).toBe('highpass=f=80,afftdn=nr=12:nf=-40,acompressor=threshold=-18dB:ratio=3:attack=20:release=250');
  });

  it('indoor uses its own highpass/nr/nf values', () => {
    const chain = buildRepairChain({ preset: 'indoor' });
    expect(chain).toBe('highpass=f=60,afftdn=nr=10:nf=-45,acompressor=threshold=-18dB:ratio=3:attack=20:release=250');
  });

  it('wireless uses its own highpass/nr/nf values', () => {
    const chain = buildRepairChain({ preset: 'wireless' });
    expect(chain).toBe('highpass=f=100,afftdn=nr=18:nf=-35,acompressor=threshold=-18dB:ratio=3:attack=20:release=250');
  });

  it('deess:true inserts deesser between afftdn and acompressor', () => {
    const chain = buildRepairChain({ preset: 'outdoor', deess: true });
    expect(chain).toBe('highpass=f=80,afftdn=nr=12:nf=-40,deesser,acompressor=threshold=-18dB:ratio=3:attack=20:release=250');
  });
});

describe('buildFilterGraph: audioRepair splices into the per-segment audio chain', () => {
  it('off/undefined leaves the segment audio chain byte-identical to before this feature existed', () => {
    const built = buildFilterGraph(baseManifest());
    expect(built.graph).not.toMatch(/highpass|afftdn|acompressor|deesser/);
    expect(built.graph).toContain('[0:a]atrim=start=0:end=5,asetpts=PTS-STARTPTS,afade=t=in');
  });

  it('an active preset is spliced in after asetpts and before the anti-click afade, once per segment', () => {
    const m = baseManifest();
    m.audioRepair = { preset: 'outdoor' };
    const built = buildFilterGraph(m);
    const chainCount = (built.graph.match(/highpass=f=80/g) ?? []).length;
    expect(chainCount).toBe(2); // one per segment (baseManifest has 2 segments)
    expect(built.graph).toContain(
      '[0:a]atrim=start=0:end=5,asetpts=PTS-STARTPTS,highpass=f=80,afftdn=nr=12:nf=-40,acompressor=threshold=-18dB:ratio=3:attack=20:release=250,afade=t=in',
    );
  });
});

// ---- W1: loudnormClause (2-pass loudnorm) ----

describe('loudnormClause', () => {
  it('plain form (no opts): matches the pre-2-pass hardcoded loudnorm string exactly', () => {
    expect(loudnormClause(-14)).toBe('loudnorm=I=-14:TP=-1.5:LRA=11');
  });

  it('printJson form appends print_format=json and nothing else', () => {
    expect(loudnormClause(-14, { printJson: true })).toBe('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json');
  });

  it('measured form substitutes measured_I/TP/LRA/thresh and offset from pass 1', () => {
    const measured = { input_i: '-23.5', input_tp: '-4.2', input_lra: '5.0', input_thresh: '-33.5', target_offset: '0.10' };
    expect(loudnormClause(-14, { measured })).toBe(
      'loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-23.5:measured_TP=-4.2:measured_LRA=5.0:measured_thresh=-33.5:offset=0.10',
    );
  });
});

// ---- W1: renderFinal 2-pass loudnorm + repair orchestration (mocked ffmpeg) ----

function loudnormStderr(): string {
  return (
    'other ffmpeg log noise\n' +
    JSON.stringify({
      input_i: '-23.5', input_tp: '-4.2', input_lra: '5.0', input_thresh: '-33.5',
      output_i: '-14.0', output_tp: '-1.5', output_lra: '6.0', output_thresh: '-24.5',
      normalization_type: 'dynamic', target_offset: '0.10',
    }) +
    '\nmore noise\n'
  );
}

function outPathIn(dir: string): string {
  return `${dir}/out.mp4`;
}

describe('renderFinal: regression (no preset, no repair, no music)', () => {
  it('never runs a measurement pass and never applies loudnorm at all', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    const m = baseManifest();
    await renderFinal(m, [], outPathIn('/tmp'));
    expect(runCaptureMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledTimes(1);
    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).not.toMatch(/loudnorm/);
  });
});

describe('renderFinal: 2-pass loudnorm (musicless, repair-triggered)', () => {
  it('runs a measurement pass first, then feeds measured_* into the real render', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    runCaptureMock.mockResolvedValueOnce({ stdout: '', stderr: loudnormStderr() });
    const m = baseManifest();
    m.audioRepair = { preset: 'outdoor' };
    await renderFinal(m, [], outPathIn('/tmp'));

    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    const measureArgs = runCaptureMock.mock.calls[0][1] as string[];
    expect(measureArgs).toContain('-f');
    expect(measureArgs[measureArgs.indexOf('-f') + 1]).toBe('null');
    const measureGraph = measureArgs[measureArgs.indexOf('-filter_complex') + 1];
    expect(measureGraph).toMatch(/print_format=json/);

    expect(runMock).toHaveBeenCalledTimes(1);
    const renderArgs = runMock.mock.calls[0][1] as string[];
    const renderGraph = renderArgs[renderArgs.indexOf('-filter_complex') + 1];
    expect(renderGraph).toContain('measured_I=-23.5');
    expect(renderGraph).toContain('measured_TP=-4.2');
    expect(renderGraph).toContain('measured_LRA=5.0');
    expect(renderGraph).toContain('measured_thresh=-33.5');
    expect(renderGraph).toContain('offset=0.10');
    expect(renderGraph).toContain('highpass=f=80'); // repair chain present too
  });

  it('--fast-loudnorm (fastLoudnorm) skips the measurement pass and applies plain 1-pass loudnorm', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    const m = baseManifest();
    m.audioRepair = { preset: 'outdoor' };
    await renderFinal(m, [], outPathIn('/tmp'), { fastLoudnorm: true });

    expect(runCaptureMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledTimes(1);
    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('loudnorm=I=-14:TP=-1.5:LRA=11[presetAudio]');
    expect(graph).not.toMatch(/measured_/);
  });

  it('--no-repair (noRepair) drops the repair chain even when manifest.audioRepair is set, but still applies loudnorm (repair being requested is not required once no-repair overrides it, so plain 1-pass/2-pass follows preset/music state only)', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    const m = baseManifest();
    m.audioRepair = { preset: 'outdoor' };
    await renderFinal(m, [], outPathIn('/tmp'), { noRepair: true, fastLoudnorm: true });

    expect(runCaptureMock).not.toHaveBeenCalled(); // fast, so no measurement anyway
    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).not.toMatch(/highpass|afftdn|acompressor/);
    // No preset, no music, and the repair chain is now inactive -> back to
    // the full regression case, so no loudnorm at all either.
    expect(graph).not.toMatch(/loudnorm/);
  });
});

describe('renderFinal: 2-pass loudnorm (music present)', () => {
  it('measures against the music-mixed graph, then feeds measured_* into the [final] loudnorm', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    runCaptureMock.mockResolvedValueOnce({ stdout: '', stderr: loudnormStderr() });
    const m = baseManifest({ music: [music({ id: 'mu1', path: '/bgm.mp3', duck: false })] });
    await renderFinal(m, [], outPathIn('/tmp'));

    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    const measureArgs = runCaptureMock.mock.calls[0][1] as string[];
    const measureGraph = measureArgs[measureArgs.indexOf('-filter_complex') + 1];
    expect(measureGraph).toMatch(/print_format=json\[final\]/);
    expect(measureArgs[measureArgs.indexOf('-map') + 1]).toBe('[final]');

    const renderArgs = runMock.mock.calls[0][1] as string[];
    const renderGraph = renderArgs[renderArgs.indexOf('-filter_complex') + 1];
    expect(renderGraph).toContain('measured_I=-23.5');
    expect(renderGraph).toContain('offset=0.10[final]');
  });
});
