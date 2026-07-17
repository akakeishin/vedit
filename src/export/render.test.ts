import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KitFile, Manifest, MusicItem, Transcript } from '../core/types.js';

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

// renderFinal's W-CAP "font not found" warning shells out to a real
// filesystem walk of the system font directories via listSystemFonts — stub
// just that one export (resolveKitFontFile/scanKitFonts stay real, same as
// every other kit-font test in this file, which writes real files under a
// tmpdir kit) so the warning tests below are deterministic regardless of
// what's actually installed on the test host.
const { listSystemFontsMock } = vi.hoisted(() => ({
  listSystemFontsMock: vi.fn(async () => [{ family: 'Hiragino Sans' }, { family: 'Noto Sans JP' }]),
}));
vi.mock('../core/fonts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/fonts.js')>();
  return { ...actual, listSystemFonts: listSystemFontsMock };
});

import { addOverlay, addSprite } from '../core/ops.js';
import {
  buildFilterGraph,
  buildRepairChain,
  loudnormClause,
  overlayAudioClause,
  overlayVideoClause,
  planExportPreset,
  renderFinal,
  resolveRenderParams,
  spriteVideoClause,
  toAss,
} from './render.js';
import { writeKitFile, type ResolvedKitAsset } from '../core/kit.js';

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

  // ---- W8: kit style -> ASS style ----

  function kitWithStyle(overrides: Record<string, unknown> = {}): KitFile {
    return {
      version: 'vedit-kit/v1',
      styles: [
        {
          id: 'kitStyle1',
          palette: { text: '#112233', outline: '#aabbcc', box: '#000000' },
          caption: { font: 'fonts/MyFont-Bold.ttf', size_1080p: 60, outline_width: 5, background_opacity: 0.5 },
          ...overrides,
        },
      ],
    };
  }

  it('adds the kit style ALONGSIDE the 4 built-in presets (never replaces them) and routes Dialogue to it', () => {
    const ass = toAss(manifest('kitStyle1'), [transcript()], kitWithStyle());
    for (const name of ['clean', 'bold', 'outline', 'boxed', 'kitStyle1']) {
      expect(ass).toMatch(new RegExp(`^Style: ${name},`, 'm'));
    }
    expect(ass).toMatch(/^Dialogue: 0,.*,kitStyle1,,/m);
  });

  it('converts palette hex to ASS BGR order and background_opacity to the box colour\'s alpha channel', () => {
    const ass = toAss(manifest('kitStyle1'), [transcript()], kitWithStyle());
    const line = ass.split('\n').find((l) => l.startsWith('Style: kitStyle1,'))!;
    const fields = line.replace('Style: kitStyle1,', '').split(',');
    // Format after Name: Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, ...
    expect(fields[2]).toBe('&H00332211'); // #112233 text -> BGR 332211, alpha 00 (opaque)
    expect(fields[4]).toBe('&H00CCBBAA'); // #aabbcc outline -> BGR CCBBAA
    expect(fields[5]).toBe('&H80000000'); // box #000000, background_opacity 0.5 -> alpha 0x80
  });

  it('uses the font FILE\'s basename (no extension) as the ASS Fontname, and scales size_1080p to the actual output height', () => {
    const m = { ...manifest('kitStyle1'), output: { width: 1280, height: 720 } };
    const ass = toAss(m, [transcript()], kitWithStyle());
    const line = ass.split('\n').find((l) => l.startsWith('Style: kitStyle1,'))!;
    const fields = line.replace('Style: kitStyle1,', '').split(',');
    expect(fields[0]).toBe('MyFont-Bold'); // Fontname
    expect(Number(fields[1])).toBe(Math.round(60 * (720 / 1080))); // Fontsize scaled to 720p
  });

  it('a kit with no style matching captions.style leaves toAss byte-for-byte the same as passing no kit at all', () => {
    const withoutKit = toAss(manifest('clean'), [transcript()]);
    const withUnrelatedKit = toAss(manifest('clean'), [transcript()], kitWithStyle());
    expect(withUnrelatedKit).toBe(withoutKit);
  });

  // ---- W-CAP: captions.overrides -> ASS Style line ----

  function styleFields(ass: string, name: string): string[] {
    const line = ass.split('\n').find((l) => l.startsWith(`Style: ${name},`))!;
    return line.replace(`Style: ${name},`, '').split(',');
  }
  // Format after Name: Fontname, Fontsize, PrimaryColour, SecondaryColour,
  // OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX,
  // ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment,
  // MarginL, MarginR, MarginV, Encoding
  const F = { fontname: 0, fontsize: 1, primary: 2, outline: 4, back: 5, borderStyle: 14, outlineWidth: 15, marginV: 20 };
  /** Inverse of render.ts's private hexToBgr, for asserting an ASS colour round-trips to the hex the override actually asked for. */
  function bgrToHex(assColor: string): string {
    const m = /^&H[0-9A-Fa-f]{2}([0-9A-Fa-f]{6})$/.exec(assColor)!;
    const [b, g, r] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
    return `#${r}${g}${b}`.toLowerCase();
  }

  describe('W-CAP: captions.overrides', () => {
    it('no overrides at all is a full regression — identical to before overrides existed', () => {
      const withoutField = toAss(manifest('clean'), [transcript()]);
      const m = manifest('clean');
      (m as any).captions.overrides = undefined;
      expect(toAss(m, [transcript()])).toBe(withoutField);
    });

    it('sizeScale multiplies the active style\'s fontsize only, leaving other styles\' fontsize untouched', () => {
      const m = manifest('clean');
      (m as any).captions.overrides = { sizeScale: 1.5 };
      const ass = toAss(m, [transcript()]);
      const defaultFontSize = Math.round(1080 * 0.045);
      expect(Number(styleFields(ass, 'clean')[F.fontsize])).toBe(Math.round(defaultFontSize * 1.5));
      expect(Number(styleFields(ass, 'bold')[F.fontsize])).toBe(defaultFontSize);
    });

    it('palette.text/outline convert to ASS BGR, only on the active style', () => {
      const m = manifest('clean');
      (m as any).captions.overrides = { palette: { text: '#ff00aa', outline: '#00ff88' } };
      const ass = toAss(m, [transcript()]);
      const clean = styleFields(ass, 'clean');
      expect(clean[F.primary]).toBe('&H00AA00FF');
      expect(clean[F.outline]).toBe('&H0088FF00');
      // 'bold' style's own colors are completely untouched.
      expect(styleFields(ass, 'bold')[F.primary]).toBe('&H005CE4FF');
    });

    it('palette.box alone keeps the active style\'s own alpha; bgOpacity alone keeps its own box colour', () => {
      const m1 = manifest('clean'); // clean's back is &H80000000 (alpha 80, black)
      (m1 as any).captions.overrides = { palette: { box: '#ff0000' } };
      expect(styleFields(toAss(m1, [transcript()]), 'clean')[F.back]).toBe('&H800000FF'); // alpha kept (80), colour -> red BGR

      const m2 = manifest('clean');
      (m2 as any).captions.overrides = { bgOpacity: 0 }; // fully transparent
      expect(styleFields(toAss(m2, [transcript()]), 'clean')[F.back]).toBe('&HFF000000'); // colour kept (black), alpha -> FF
    });

    it('outlineWidth 0 switches BorderStyle to an opaque box (matches kitAssStyle\'s convention); a positive value keeps BorderStyle 1', () => {
      const m1 = manifest('outline'); // built-in 'outline' style already uses BorderStyle 1
      (m1 as any).captions.overrides = { outlineWidth: 0 };
      const f1 = styleFields(toAss(m1, [transcript()]), 'outline');
      expect(f1[F.borderStyle]).toBe('3');
      expect(f1[F.outlineWidth]).toBe('0');

      const m2 = manifest('bold'); // built-in 'bold' style uses BorderStyle 3
      (m2 as any).captions.overrides = { outlineWidth: 4 };
      const f2 = styleFields(toAss(m2, [transcript()]), 'bold');
      expect(f2[F.borderStyle]).toBe('1');
      expect(f2[F.outlineWidth]).toBe('4');
    });

    it('font sets Fontname to the basename without extension, whether given as a family or a font FILE name', () => {
      const m1 = manifest('clean');
      (m1 as any).captions.overrides = { font: 'Noto Sans JP' };
      expect(styleFields(toAss(m1, [transcript()]), 'clean')[F.fontname]).toBe('Noto Sans JP');

      const m2 = manifest('clean');
      (m2 as any).captions.overrides = { font: 'MyFont-Bold.ttf' };
      expect(styleFields(toAss(m2, [transcript()]), 'clean')[F.fontname]).toBe('MyFont-Bold');
    });

    it('position.v becomes a per-style MarginV override; other styles keep the module default', () => {
      const m = manifest('clean');
      (m as any).captions.overrides = { position: { v: 0.5 } };
      const ass = toAss(m, [transcript()]);
      expect(Number(styleFields(ass, 'clean')[F.marginV])).toBe(Math.round((1 - 0.5) * 1080));
      expect(Number(styleFields(ass, 'bold')[F.marginV])).toBe(Math.round(1080 * 0.06));
    });

    it('position.v the documented default (0.94) reproduces the pre-W-CAP hardcoded MarginV exactly', () => {
      const m = manifest('clean');
      (m as any).captions.overrides = { position: { v: 0.94 } };
      const withOverride = styleFields(toAss(m, [transcript()]), 'clean')[F.marginV];
      const without = styleFields(toAss(manifest('clean'), [transcript()]), 'clean')[F.marginV];
      expect(withOverride).toBe(without);
    });

    it('applies on top of a kit style too, not just the built-in presets', () => {
      const m = manifest('kitStyle1');
      (m as any).captions.overrides = { sizeScale: 2 };
      const ass = toAss(m, [transcript()], kitWithStyle());
      // kitWithStyle's size_1080p is 60 at the default 1080p output.
      expect(Number(styleFields(ass, 'kitStyle1')[F.fontsize])).toBe(120);
    });

    it('a partial override (just outlineWidth) leaves the active style\'s own colors/font untouched', () => {
      const m = manifest('bold');
      (m as any).captions.overrides = { outlineWidth: 2 };
      const ass = toAss(m, [transcript()]);
      const fields = styleFields(ass, 'bold');
      expect(fields[F.primary]).toBe('&H005CE4FF'); // bold's own yellow, untouched
      expect(fields[F.outlineWidth]).toBe('2');
    });

    // ---- parity: the SAME manifest's raw override values (what a web CSS
    // layer would apply verbatim — a hex color, a size multiplier) and the
    // ASS Style line toAss emits represent the same color/size, just encoded
    // differently (hex RGB vs ASS's &HAABBGGRR; an absolute px size vs a
    // scale factor) — see the "反映の一貫性" contract in the task brief. ----
    it('parity: PrimaryColour round-trips to the exact overrides.palette.text hex a web layer would use as-is', () => {
      const m = manifest('clean');
      const textHex = '#3a7bd5';
      (m as any).captions.overrides = { palette: { text: textHex } };
      const ass = toAss(m, [transcript()]);
      expect(bgrToHex(styleFields(ass, 'clean')[F.primary])).toBe(textHex);
    });

    it('parity: the ASS fontsize / base fontsize ratio equals overrides.sizeScale exactly (the same multiplier a web layer would apply to its own base font-size)', () => {
      const sizeScale = 1.3;
      const m = manifest('clean');
      (m as any).captions.overrides = { sizeScale };
      const ass = toAss(m, [transcript()]);
      const baseFontSize = Math.round(1080 * 0.045);
      const assFontSize = Number(styleFields(ass, 'clean')[F.fontsize]);
      // Rounding to the nearest pixel means this is approximate, not exact
      // floating-point equality — within a pixel's worth of scale error.
      expect(assFontSize / baseFontSize).toBeCloseTo(sizeScale, 1);
    });
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

// ---- buildFilterGraph: W3 B-roll V2 overlay compositing ----
//
// baseManifest()'s A-roll timeline is seg1 tl[0,5)<-src[0,5) and
// seg2 tl[5,15)<-src[10,20) (a 5s cut sits between them, src[5,10)) — used
// below both as an anchor-resolution target and as the orphan gap.

function overlayManifest(overlays: { anchorSrcTime: number; srcIn?: number; srcOut?: number; audioMode?: 'mute' | 'mix' | 'replace'; gainDb?: number; id?: string; hasAudio?: boolean }[]): Manifest {
  let m = baseManifest();
  m = {
    ...m,
    sources: [...m.sources, { id: 's2', path: '/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: overlays[0]?.hasAudio ?? true }],
  };
  for (const o of overlays) {
    m = addOverlay(m, 's2', {
      id: o.id,
      srcIn: o.srcIn ?? 0,
      srcOut: o.srcOut ?? 2,
      anchor: { sourceId: 's1', srcTime: o.anchorSrcTime },
      audioMode: o.audioMode,
      gainDb: o.gainDb,
    });
  }
  return m;
}

describe('buildFilterGraph: B-roll V2 overlays (W3)', () => {
  it('an overlay-less project reaches byte-for-byte the same graph as before W3 (regression)', () => {
    const built = buildFilterGraph(baseManifest());
    expect(built.videoLabel).toBe('[vc]');
    expect(built.audioLabel).toBe('[ac]');
    expect(built.graph).not.toMatch(/overlay=enable|\bova\d|\bovc\d/);
    expect(built.inputPaths).toEqual(['/x.mp4']);
  });

  it('an orphaned overlay (anchor cut away) is excluded entirely — same regression guarantee as no overlays', () => {
    // src=7 falls in the A-roll's cut gap (src[5,10)) -> unresolvable.
    const m = overlayManifest([{ anchorSrcTime: 7 }]);
    const built = buildFilterGraph(m);
    expect(built.videoLabel).toBe('[vc]');
    expect(built.audioLabel).toBe('[ac]');
    expect(built.inputPaths).toEqual(['/x.mp4']); // /broll.mp4 never added as an input
  });

  it('audioMode mute: composites video only, audioLabel/inputs for audio stay untouched', () => {
    // anchor src=2 -> tl=2 (inside seg1); dur = srcOut-srcIn = 2 -> resolved tl[2,4).
    const m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'mute' }]);
    const built = buildFilterGraph(m);
    expect(built.inputPaths).toEqual(['/x.mp4', '/broll.mp4']);
    expect(built.graph).toContain('[1:v]trim=start=0:end=2,setpts=PTS-STARTPTS+2/TB');
    expect(built.graph).toContain("[vc][ov0]overlay=enable='between(t,2,4)'[ovc0]");
    expect(built.videoLabel).toBe('[ovc0]');
    expect(built.audioLabel).toBe('[ac]'); // untouched: mute never reads B-roll audio
    expect(built.graph).not.toMatch(/\bova0\b|amix/);
  });

  it('audioMode mix: B-roll audio is trimmed/delayed/gained and amixed with the A-roll audio (duration=first)', () => {
    const m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'mix', gainDb: -9 }]);
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('[1:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS,adelay=2000:all=1,volume=-9dB[ova0]');
    expect(built.graph).toContain('[ac][ova0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[ovAudioMix]');
    expect(built.audioLabel).toBe('[ovAudioMix]');
    expect(built.graph).not.toContain('volume=0:enable'); // mix never silences the A-roll
  });

  it('audioMode mix defaults gainDb to OVERLAY_GAIN_DEFAULT (-18) when omitted', () => {
    const m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'mix' }]);
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('volume=-18dB[ova0]');
  });

  it('audioMode replace: silences the A-roll audio over [tlStart,tlEnd) then mixes in the B-roll audio', () => {
    const m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'replace', gainDb: -12 }]);
    const built = buildFilterGraph(m);
    expect(built.graph).toContain("[ac]volume=0:enable='between(t,2,4)'[arepl0]");
    expect(built.graph).toContain('[1:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS,adelay=2000:all=1,volume=-12dB[ova0]');
    expect(built.graph).toContain('[arepl0][ova0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[ovAudioMix]');
    expect(built.audioLabel).toBe('[ovAudioMix]');
  });

  it('audioMode mix/replace with a B-roll source that has no audio never adds an amix (video overlay still applies)', () => {
    const m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'mix', hasAudio: false }]);
    const built = buildFilterGraph(m);
    expect(built.videoLabel).toBe('[ovc0]');
    expect(built.audioLabel).toBe('[ac]');
    expect(built.graph).not.toMatch(/amix|ova0/);
  });

  it('multiple non-overlapping overlays chain the video composite and dedupe a repeated B-roll source input', () => {
    const m = overlayManifest([
      { anchorSrcTime: 1, id: 'ov1', audioMode: 'mute' }, // tl[1,3)
      { anchorSrcTime: 3, id: 'ov2', audioMode: 'mute', srcIn: 5, srcOut: 6 }, // tl[3,4)
    ]);
    const built = buildFilterGraph(m);
    expect(built.inputPaths).toEqual(['/x.mp4', '/broll.mp4']); // one dedup'd overlay input despite 2 overlays
    expect(built.graph).toContain("[vc][ov0]overlay=enable='between(t,1,3)'[ovc0]");
    expect(built.graph).toContain("[ovc0][ov1]overlay=enable='between(t,3,4)'[ovc1]");
    expect(built.videoLabel).toBe('[ovc1]');
  });

  it('overlay compositing happens on top of a music-mixed graph (audioLabel chains from [final], not [ac])', () => {
    let m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'mix', gainDb: -6 }]);
    m = { ...m, timeline: { ...m.timeline, music: [music({ id: 'mu1', path: '/bgm.mp3', duck: false })] } };
    const built = buildFilterGraph(m);
    expect(built.graph).toContain('[final][ova0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[ovAudioMix]');
    expect(built.audioLabel).toBe('[ovAudioMix]');
    // overlay's B-roll input comes after BOTH the video source and the music source.
    expect(built.inputPaths).toEqual(['/x.mp4', '/bgm.mp3', '/broll.mp4']);
    expect(built.graph).toContain('[2:a]atrim'); // broll is ffmpeg input index 2
  });
});

describe('overlayVideoClause / overlayAudioClause (pure helpers)', () => {
  it('overlayVideoClause centers via cropGeometry when source/output aspect mismatch, and no crop clause when they match', () => {
    const matching = overlayVideoClause(1, 0, 0, 2, 5, 1920, 1080, 1920, 1080, 30);
    expect(matching).not.toContain('crop=');
    expect(matching).toBe(
      '[1:v]trim=start=0:end=2,setpts=PTS-STARTPTS+5/TB,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30[ov0]',
    );
    const mismatched = overlayVideoClause(1, 0, 0, 2, 5, 1920, 1080, 1080, 1920, 30);
    expect(mismatched).toContain('crop=');
  });

  it('overlayAudioClause rounds tlStart to milliseconds for adelay', () => {
    const clause = overlayAudioClause(2, 0, 0, 2, 1.2345, -18);
    expect(clause).toBe('[2:a]atrim=start=0:end=2,asetpts=PTS-STARTPTS,adelay=1235:all=1,volume=-18dB[ova0]');
  });
});

// ---- buildFilterGraph: W8 kit sprite compositing ----
//
// baseManifest()'s A-roll timeline is seg1 tl[0,5)<-src[0,5) and
// seg2 tl[5,15)<-src[10,20) (a 5s cut sits between them, src[5,10)) — same
// shape overlayManifest() above builds on.

function spriteManifest(
  sprites: { anchorSrcTime: number; id?: string; duration?: number; position?: { x: number; y: number }; scale?: number; opacity?: number; flip?: boolean }[],
): Manifest {
  let m = baseManifest();
  for (const s of sprites) {
    m = addSprite(m, 'char1', {
      id: s.id,
      anchor: { sourceId: 's1', srcTime: s.anchorSrcTime },
      duration: s.duration,
      position: s.position,
      scale: s.scale,
      opacity: s.opacity,
      flip: s.flip,
    });
  }
  return m;
}

function fakeAsset(id: string, overrides: Partial<ResolvedKitAsset> = {}): ResolvedKitAsset {
  return {
    id, path: `assets/characters/${id}.png`, type: 'sprite', absPath: `/kit/assets/characters/${id}.png`,
    width: 200, height: 400,
    visible_bounds_normalized: { x0: 0, y0: 0, x1: 1, y1: 1 },
    ground_anchor_normalized: { x: 0.5, y: 1 },
    ...overrides,
  };
}

describe('buildFilterGraph: W8 kit sprite compositing', () => {
  it('a sprite-less project (or omitting kitAssets entirely) reaches byte-for-byte the same graph as before W8 (regression)', () => {
    const noSprites = buildFilterGraph(baseManifest());
    expect(noSprites.graph).not.toMatch(/\bsv\d|\bsvc\d/);
    expect(noSprites.spriteInputIndices).toBeUndefined();

    const m = spriteManifest([{ anchorSrcTime: 2 }]);
    const built = buildFilterGraph(m); // sprites exist on the timeline but no kitAssets map is passed
    expect(built.graph).not.toMatch(/\bsv\d|\bsvc\d/);
    expect(built.inputPaths).toEqual(['/x.mp4']);
    expect(built.spriteInputIndices).toBeUndefined();
  });

  it('an unresolved sprite (assetId missing from kitAssets) is silently skipped', () => {
    const m = spriteManifest([{ anchorSrcTime: 2 }]);
    const built = buildFilterGraph(m, { kitAssets: new Map() });
    expect(built.graph).not.toMatch(/\bsv\d/);
    expect(built.inputPaths).toEqual(['/x.mp4']);
  });

  it('an orphaned sprite (anchor cut away) is excluded entirely — same regression guarantee as no sprites', () => {
    const m = spriteManifest([{ anchorSrcTime: 7 }]); // src[5,10) is the cut gap
    const built = buildFilterGraph(m, { kitAssets: new Map([['char1', fakeAsset('char1')]]) });
    expect(built.graph).not.toMatch(/\bsv\d/);
    expect(built.inputPaths).toEqual(['/x.mp4']);
  });

  it('composites a resolved sprite at exactly the geometry spriteGeometry computes, and records spriteInputIndices for -loop 1', () => {
    const m = spriteManifest([{ anchorSrcTime: 2, id: 'sp1', duration: 3, position: { x: 0.5, y: 1 }, scale: 0.5, opacity: 1 }]);
    const built = buildFilterGraph(m, { kitAssets: new Map([['char1', fakeAsset('char1')]]) });
    expect(built.inputPaths).toEqual(['/x.mp4', '/kit/assets/characters/char1.png']);
    expect(built.spriteInputIndices).toEqual([1]);
    // asset aspect 200/400=0.5, scale 0.5 * output height 1080 -> display/full height 540, full width 270.
    expect(built.graph).toContain('[1:v]scale=270:540,format=rgba[sv0]');
    // ground_anchor (0.5,1) of the 270x540 image at position (0.5,1)*1920x1080=(960,1080) -> top-left (960-135, 1080-540)=(825,540).
    expect(built.graph).toContain("[vc][sv0]overlay=x=825:y=540:enable='between(t,2,5)'[svc0]");
    expect(built.videoLabel).toBe('[svc0]');
  });

  it('opacity 1 (default) omits colorchannelmixer; opacity < 1 adds it', () => {
    const kitAssets = new Map([['char1', fakeAsset('char1')]]);
    const opaque = buildFilterGraph(spriteManifest([{ anchorSrcTime: 2, opacity: 1 }]), { kitAssets });
    expect(opaque.graph).not.toContain('colorchannelmixer');
    const translucent = buildFilterGraph(spriteManifest([{ anchorSrcTime: 2, opacity: 0.4 }]), { kitAssets });
    expect(translucent.graph).toContain('colorchannelmixer=aa=0.4');
  });

  it('flip adds hflip to the sprite\'s video chain', () => {
    const kitAssets = new Map([['char1', fakeAsset('char1')]]);
    const built = buildFilterGraph(spriteManifest([{ anchorSrcTime: 2, flip: true }]), { kitAssets });
    expect(built.graph).toContain('hflip');
  });

  it('multiple sprites chain the composite and each gets its own input; sprites MAY overlap (unlike B-roll V2)', () => {
    const kitAssets = new Map([['char1', fakeAsset('char1')], ['char2', fakeAsset('char2')]]);
    let m = baseManifest();
    m = addSprite(m, 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 1 }, duration: 2 });
    m = addSprite(m, 'char2', { id: 'sp2', anchor: { sourceId: 's1', srcTime: 1 }, duration: 2 }); // same window as sp1 — deliberately overlapping
    const built = buildFilterGraph(m, { kitAssets });
    expect(built.inputPaths).toEqual(['/x.mp4', '/kit/assets/characters/char1.png', '/kit/assets/characters/char2.png']);
    expect(built.spriteInputIndices).toEqual([1, 2]);
    expect(built.videoLabel).toBe('[svc1]');
  });

  it('sprite compositing is applied on top of (after) B-roll overlay compositing', () => {
    let m = overlayManifest([{ anchorSrcTime: 2, id: 'ov1', audioMode: 'mute' }]);
    m = addSprite(m, 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 2 });
    const built = buildFilterGraph(m, { kitAssets: new Map([['char1', fakeAsset('char1')]]) });
    expect(built.graph).toContain("[vc][ov0]overlay=enable='between(t,2,4)'[ovc0]");
    expect(built.graph).toContain('[ovc0][sv0]overlay=x=');
    expect(built.videoLabel).toBe('[svc0]');
  });
});

describe('spriteVideoClause (pure helper)', () => {
  it('scales (rounding to the nearest pixel) and forces format=rgba', () => {
    expect(spriteVideoClause(2, 0, 100.4, 200.6)).toBe('[2:v]scale=100:201,format=rgba[sv0]');
  });

  it('adds hflip only when flip is requested', () => {
    expect(spriteVideoClause(2, 0, 100, 200, { flip: true })).toBe('[2:v]scale=100:200,hflip,format=rgba[sv0]');
    expect(spriteVideoClause(2, 0, 100, 200, { flip: false })).toBe('[2:v]scale=100:200,format=rgba[sv0]');
  });

  it('adds colorchannelmixer only when opacity is below 1', () => {
    expect(spriteVideoClause(2, 0, 100, 200, { opacity: 0.3 })).toBe('[2:v]scale=100:200,format=rgba,colorchannelmixer=aa=0.3[sv0]');
    expect(spriteVideoClause(2, 0, 100, 200, { opacity: 1 })).not.toContain('colorchannelmixer');
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

describe('buildFilterGraph: W5 color transform + adjust splices into the per-segment video chain', () => {
  it('no colorTransform / no colorAdjust leaves the video chain byte-identical to before this feature existed', () => {
    const built = buildFilterGraph(baseManifest());
    expect(built.graph).not.toMatch(/zscale|tonemap|lut3d|eq=brightness|colortemperature|colorbalance/);
    expect(built.graph).toContain('[0:v]trim=start=0:end=5,setpts=PTS-STARTPTS,scale=1920:1080');
  });

  it('splices the HLG transform in after setpts and before crop/scale, once per segment', () => {
    const m = baseManifest();
    m.sources[0].colorTransform = { type: 'hlg' };
    const built = buildFilterGraph(m);
    const chainCount = (built.graph.match(/tonemap=hable/g) ?? []).length;
    expect(chainCount).toBe(2); // one per segment (baseManifest has 2 segments)
    expect(built.graph).toContain(
      '[0:v]trim=start=0:end=5,setpts=PTS-STARTPTS,zscale=t=linear:npl=1000,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,scale=1920:1080',
    );
  });

  it('splices colorAdjust (keyed by sourceId) in for every segment referencing that source', () => {
    const m = baseManifest();
    m.colorAdjust = { s1: { exposure: 0.4, sat: 1.2 } };
    const built = buildFilterGraph(m);
    const chainCount = (built.graph.match(/eq=brightness=0\.1:saturation=1\.2/g) ?? []).length;
    expect(chainCount).toBe(2);
  });

  it('combines colorTransform and colorAdjust in one chain, transform first', () => {
    const m = baseManifest();
    m.sources[0].colorTransform = { type: 'lut', lut: '/luts/x.cube' };
    m.colorAdjust = { s1: { wb: 0 } };
    const built = buildFilterGraph(m);
    expect(built.graph).toContain("lut3d='/luts/x.cube',colortemperature=temperature=6500,");
  });

  it("an explicit colorTransform type 'none' produces no color clause", () => {
    const m = baseManifest();
    m.sources[0].colorTransform = { type: 'none' };
    const built = buildFilterGraph(m);
    expect(built.graph).not.toMatch(/zscale|tonemap|lut3d/);
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

// ---- renderFinal: W8 kit (loads kit.json for real off disk via readKitFile;
// ffmpeg itself stays mocked via run.js, but sha256File/fs reads are real, so
// these use a real tmpdir kit directory — same approach daemon.test.ts uses
// for path-containment tests). ----

function freshKitDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `vedit-render-kit-${prefix}-`));
}

describe('renderFinal: W8 kit (styles + sprites)', () => {
  it('degrades gracefully (warning, not a thrown error) when manifest.kit points at a directory with no kit.json', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    const dir = freshKitDir('missing');
    const m = { ...baseManifest(), kit: { path: dir } };
    const res = await renderFinal(m, [], outPathIn('/tmp'));
    expect(res.warnings.some((w) => w.startsWith('kit:'))).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1); // still rendered — just without kit styles/sprites
  });

  it('resolves and composites a linked kit sprite: -loop 1 precedes the PNG input, and the graph overlays it', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    const dir = freshKitDir('sprite');
    await fsp.mkdir(path.join(dir, 'assets', 'characters'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'assets', 'characters', 'char1.png'), 'fake-png-bytes');
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      assets: [{
        id: 'char1', path: 'assets/characters/char1.png', type: 'sprite',
        width: 200, height: 400,
        visible_bounds_normalized: { x0: 0, y0: 0, x1: 1, y1: 1 },
        ground_anchor_normalized: { x: 0.5, y: 1 },
      }],
    };
    await writeKitFile(dir, kit);

    let m = { ...baseManifest(), kit: { path: dir } };
    const { addSprite } = await import('../core/ops.js');
    m = addSprite(m, 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 3 });

    const res = await renderFinal(m, [], outPathIn('/tmp'));
    expect(res.warnings.some((w) => w.includes('sha256') || w.includes('not found'))).toBe(false);

    const args = runMock.mock.calls[0][1] as string[];
    const pngIdx = args.indexOf(path.join(dir, 'assets', 'characters', 'char1.png'));
    expect(pngIdx).toBeGreaterThan(0);
    expect(args[pngIdx - 1]).toBe('-i');
    expect(args[pngIdx - 2]).toBe('1');
    expect(args[pngIdx - 3]).toBe('-loop');
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toMatch(/overlay=x=\d+:y=\d+:enable='between\(t,2,5\)'/);
  });

  it('burnCaptions with a kit style carrying a font passes fontsdir= pointing at the kit\'s font directory', async () => {
    runMock.mockClear();
    runCaptureMock.mockClear();
    const dir = freshKitDir('font');
    await fsp.mkdir(path.join(dir, 'fonts'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'fonts', 'MyFont-Bold.ttf'), 'fake-font-bytes');
    const kit: KitFile = {
      version: 'vedit-kit/v1',
      styles: [{ id: 'kitStyle1', caption: { font: 'fonts/MyFont-Bold.ttf' } }],
    };
    await writeKitFile(dir, kit);

    const m = manifest('kitStyle1');
    (m as Manifest).kit = { path: dir };
    await renderFinal(m, [transcript()], outPathIn('/tmp'), { burnCaptions: true });

    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain(`fontsdir='${path.join(dir, 'fonts')}'`);
  });
});

// ---- renderFinal: W-CAP overrides.font resolution + "not found" warning ----

describe('renderFinal: W-CAP overrides.font', () => {
  it('overrides.font resolving to a kit font file adds fontsdir (kit font file takes priority over treating it as a system family)', async () => {
    runMock.mockClear();
    const dir = freshKitDir('override-font-kit');
    await fsp.mkdir(path.join(dir, 'fonts'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'fonts', 'MyOverrideFont.ttf'), 'fake-font-bytes');
    await writeKitFile(dir, { version: 'vedit-kit/v1' });

    const m = manifest('clean');
    (m as Manifest).kit = { path: dir };
    (m as Manifest).captions.overrides = { font: 'MyOverrideFont' }; // no extension given — resolveKitFontFile tries each known one
    const res = await renderFinal(m, [transcript()], outPathIn('/tmp'), { burnCaptions: true });

    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain(`fontsdir='${path.join(dir, 'fonts')}'`);
    expect(res.warnings.some((w) => w.includes('not found'))).toBe(false);
  });

  it('overrides.font matching neither a kit font file nor a known system family produces a "not found" warning', async () => {
    const m = manifest('clean');
    (m as Manifest).captions.overrides = { font: 'TotallyMadeUpFontXYZ' };
    const res = await renderFinal(m, [transcript()], outPathIn('/tmp'), { burnCaptions: true });
    expect(res.warnings.some((w) => w.includes('TotallyMadeUpFontXYZ') && w.includes('not found'))).toBe(true);
  });

  it('overrides.font matching a known system family produces no warning and no fontsdir clause', async () => {
    runMock.mockClear();
    const m = manifest('clean');
    (m as Manifest).captions.overrides = { font: 'Noto Sans JP' };
    const res = await renderFinal(m, [transcript()], outPathIn('/tmp'), { burnCaptions: true });
    expect(res.warnings.some((w) => w.includes('not found'))).toBe(false);
    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).not.toContain('fontsdir=');
  });

  it('no overrides at all never touches the fontsdir/warning logic (regression)', async () => {
    runMock.mockClear();
    const m = manifest('clean');
    const res = await renderFinal(m, [transcript()], outPathIn('/tmp'), { burnCaptions: true });
    expect(res.warnings).toEqual([]);
    const args = runMock.mock.calls[0][1] as string[];
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).not.toContain('fontsdir=');
  });
});
