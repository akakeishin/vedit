import { describe, expect, it } from 'vitest';
import { buildFilterGraph, toAss } from './render.js';
import type { Manifest, MusicItem, Transcript } from '../core/types.js';

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
