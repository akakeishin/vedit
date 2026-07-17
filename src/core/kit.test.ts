import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KitAsset, KitFile } from './types.js';

// kit-scan shells out to ffprobe/ffmpeg via run()/runBinary() (see
// scanAssetAlpha in kit.ts) — stub both so the alpha-scan orchestration
// tests below stay fast/deterministic without needing ffmpeg installed
// (same approach as render.test.ts's mock).
const { runMock, runBinaryMock } = vi.hoisted(() => ({
  runMock: vi.fn(async () => ''),
  runBinaryMock: vi.fn(async () => Buffer.alloc(0)),
}));
vi.mock('../ingest/run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  runBinary: (...args: unknown[]) => runBinaryMock(...args),
  runCapture: vi.fn(),
  ffmpegBin: () => 'ffmpeg',
  ffmpegHasFilter: () => true,
}));

import {
  AMBIENT_LAYER_OPACITY,
  applyKitDefaults,
  computeAlphaGeometry,
  deriveAssetId,
  deriveSpeechBubbleStyle,
  firstAmbientAsset,
  inferAssetType,
  KIT_VERSION,
  kitProfileHighlights,
  listAssetPngs,
  packKitAssets,
  readKitFile,
  recognizedKitSections,
  resolveKitAssets,
  scaffoldKit,
  scanAssetAlpha,
  scanKit,
  searchKitAssets,
  speechBubbleTailDirection,
  validateKitFile,
  writeKitFile,
} from './kit.js';
import { sha256File } from '../ingest/ingest.js';
import type { Manifest } from './types.js';

function freshDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `vedit-kit-${prefix}-`));
}

function manifest(): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

// ---- computeAlphaGeometry (pure) ----

describe('computeAlphaGeometry', () => {
  function rgba(w: number, h: number, alphaAt: (x: number, y: number) => number): Uint8Array {
    const buf = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        buf[(y * w + x) * 4 + 3] = alphaAt(x, y);
      }
    }
    return buf;
  }

  it('returns null for a fully transparent image', () => {
    const buf = rgba(4, 4, () => 0);
    expect(computeAlphaGeometry(4, 4, buf)).toBeNull();
  });

  it('a single opaque pixel: bounds are a 1-pixel box, anchor sits exactly on it', () => {
    const buf = rgba(5, 5, (x, y) => (x === 2 && y === 3 ? 255 : 0));
    const geo = computeAlphaGeometry(5, 5, buf);
    expect(geo).not.toBeNull();
    expect(geo!.visible_bounds_normalized).toEqual({ x0: 0.4, y0: 0.6, x1: 0.6, y1: 0.8 });
    expect(geo!.ground_anchor_normalized.x).toBeCloseTo(0.4);
    expect(geo!.ground_anchor_normalized.y).toBeCloseTo(0.8);
  });

  it('a bottom-half opaque rectangle: bounds cover it, anchor is the horizontal centroid of the bottom row', () => {
    // 4x4 image, opaque for y in [2,3] (bottom half), all x.
    const buf = rgba(4, 4, (_x, y) => (y >= 2 ? 255 : 0));
    const geo = computeAlphaGeometry(4, 4, buf)!;
    expect(geo.visible_bounds_normalized).toEqual({ x0: 0, y0: 0.5, x1: 1, y1: 1 });
    // Bottom row y=3, x=0..3 uniform alpha -> mean x = 1.5 -> 1.5/4 = 0.375.
    expect(geo.ground_anchor_normalized.x).toBeCloseTo(0.375);
    expect(geo.ground_anchor_normalized.y).toBeCloseTo(1);
  });

  it('an asymmetric alpha-weighted bottom row skews the anchor toward the more-opaque side', () => {
    // 3x1 image, bottom (only) row: x=0 alpha=255, x=2 alpha=25 (both > threshold=10), x=1 alpha=0.
    const buf = new Uint8Array(3 * 1 * 4);
    buf[0 * 4 + 3] = 255;
    buf[2 * 4 + 3] = 25;
    const geo = computeAlphaGeometry(3, 1, buf)!;
    // weighted mean x = (0*255 + 2*25) / (255+25) = 50/280 ≈ 0.1786 -> /3 ≈ 0.0595, well left of the midpoint (1/3=0.333).
    expect(geo.ground_anchor_normalized.x).toBeLessThan(1 / 3);
    expect(geo.ground_anchor_normalized.x).toBeGreaterThan(0);
  });

  it('respects the alpha threshold: alpha AT the threshold does not count, just above it does', () => {
    const atThreshold = rgba(2, 2, () => 10);
    expect(computeAlphaGeometry(2, 2, atThreshold, 10)).toBeNull();
    const aboveThreshold = rgba(2, 2, () => 11);
    expect(computeAlphaGeometry(2, 2, aboveThreshold, 10)).not.toBeNull();
  });
});

// ---- asset id/type inference (pure) ----

describe('inferAssetType / deriveAssetId', () => {
  it('maps assets/characters -> sprite, assets/backgrounds -> background, assets/ambient -> ambient, anything else -> prop', () => {
    expect(inferAssetType('assets/characters/hero.png')).toBe('sprite');
    expect(inferAssetType('assets/backgrounds/room.png')).toBe('background');
    expect(inferAssetType('assets/ambient/particles.mp4')).toBe('ambient');
    expect(inferAssetType('assets/props/mug.png')).toBe('prop');
    expect(inferAssetType('assets/misc/thing.png')).toBe('prop');
  });

  it('derives a sanitized id from the filename and dedups against existing ids', () => {
    expect(deriveAssetId('assets/characters/Happy Hero!.png', new Set())).toBe('happy-hero');
    expect(deriveAssetId('assets/characters/hero.png', new Set(['hero']))).toBe('hero-2');
    expect(deriveAssetId('assets/characters/hero.png', new Set(['hero', 'hero-2']))).toBe('hero-3');
  });
});

// ---- kit.json validation (pure) ----

describe('validateKitFile', () => {
  it('accepts a minimal valid kit file (version only)', () => {
    expect(validateKitFile({ version: KIT_VERSION })).toEqual({ version: KIT_VERSION });
  });

  it('rejects a non-object, a wrong/missing version', () => {
    expect(() => validateKitFile(null)).toThrow(/expected a JSON object/);
    expect(() => validateKitFile([])).toThrow(/expected a JSON object/);
    expect(() => validateKitFile({ version: 'nope' })).toThrow(/unrecognized version/);
    expect(() => validateKitFile({})).toThrow(/unrecognized version/);
  });

  it('rejects malformed styles/assets arrays', () => {
    expect(() => validateKitFile({ version: KIT_VERSION, styles: [{ label: 'no id' }] })).toThrow(/styles must be/);
    expect(() => validateKitFile({ version: KIT_VERSION, styles: 'nope' })).toThrow(/styles must be/);
    expect(() => validateKitFile({ version: KIT_VERSION, assets: [{ id: 'a' }] })).toThrow(/assets must be/); // missing path
  });

  it('accepts well-formed styles/assets', () => {
    const kit = validateKitFile({
      version: KIT_VERSION,
      styles: [{ id: 's1' }],
      assets: [{ id: 'a1', path: 'assets/props/x.png', type: 'prop' }],
    });
    expect(kit.styles![0].id).toBe('s1');
  });
});

// ---- defaults / profile highlights (pure) ----

describe('applyKitDefaults', () => {
  it('applies defaults.captions_style onto manifest.captions.style and reports it', () => {
    const kit: KitFile = { version: KIT_VERSION, defaults: { captions_style: 'kitStyle1' } };
    const { manifest: m2, applied } = applyKitDefaults(manifest(), kit);
    expect(m2.captions.style).toBe('kitStyle1');
    expect(applied).toEqual(['captions_style -> kitStyle1']);
  });

  it('applies nothing when defaults/captions_style is absent', () => {
    const kit: KitFile = { version: KIT_VERSION };
    const { manifest: m2, applied } = applyKitDefaults(manifest(), kit);
    expect(m2.captions.style).toBe('clean');
    expect(applied).toEqual([]);
  });
});

describe('kitProfileHighlights', () => {
  it('returns null when there is no kit, or the kit has no profile section', () => {
    expect(kitProfileHighlights(null)).toBeNull();
    expect(kitProfileHighlights({ version: KIT_VERSION })).toBeNull();
  });

  it('returns only the non-empty profile fields', () => {
    const kit: KitFile = {
      version: KIT_VERSION,
      profile: { tone_tags: ['calm'], spine: [], language: 'ja' },
    };
    // spine is an empty array -> excluded; language has no highlight slot -> excluded; tone_tags included.
    expect(kitProfileHighlights(kit)).toEqual({ tone_tags: ['calm'] });
  });
});

// ---- recognizedKitSections / search / pack (pure) ----

describe('recognizedKitSections / searchKitAssets / packKitAssets', () => {
  it('recognizedKitSections lists only the sections actually present', () => {
    const kit: KitFile = { version: KIT_VERSION, profile: {}, styles: [] };
    expect(recognizedKitSections(kit)).toEqual(['profile', 'styles']);
    expect(recognizedKitSections({ version: KIT_VERSION })).toEqual([]);
  });

  it('searchKitAssets filters by tag and/or emotion', () => {
    const assets: KitAsset[] = [
      { id: 'a1', path: 'a1.png', type: 'sprite', tags: ['quiet', 'happy'], emotion: 'happy' },
      { id: 'a2', path: 'a2.png', type: 'sprite', tags: ['quiet'], emotion: 'sad' },
      { id: 'a3', path: 'a3.png', type: 'sprite', tags: ['loud'], emotion: 'happy' },
    ];
    expect(searchKitAssets(assets, { tag: 'quiet' }).map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(searchKitAssets(assets, { emotion: 'happy' }).map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(searchKitAssets(assets, { tag: 'quiet', emotion: 'happy' }).map((a) => a.id)).toEqual(['a1']);
    expect(searchKitAssets(undefined)).toEqual([]);
  });

  it('packKitAssets flags unscanned assets and reports an empty-list message', () => {
    expect(packKitAssets([])).toMatch(/no matching assets/);
    const text = packKitAssets([
      { id: 'a1', path: 'a1.png', type: 'sprite', visible_bounds_normalized: { x0: 0, y0: 0, x1: 1, y1: 1 }, ground_anchor_normalized: { x: 0.5, y: 1 } },
      { id: 'a2', path: 'a2.png', type: 'prop' },
    ]);
    expect(text).toContain('a1 [sprite] a1.png');
    expect(text).not.toMatch(/a1.*\[unscanned\]/);
    expect(text).toMatch(/a2.*\[unscanned\]/);
  });
});

// ---- kit.json read/write + kit-init scaffolding (real tmpdir fs) ----

describe('readKitFile / writeKitFile', () => {
  it('round-trips through disk', async () => {
    const dir = freshDir('rw');
    const kit: KitFile = { version: KIT_VERSION, name: 'my-series', profile: { tone_tags: ['calm'] } };
    await writeKitFile(dir, kit);
    const read = await readKitFile(dir);
    expect(read).toEqual(kit);
  });

  it('throws an actionable error when kit.json is missing', async () => {
    const dir = freshDir('missing');
    await expect(readKitFile(dir)).rejects.toThrow(/kit-init/);
  });

  it('throws on invalid JSON', async () => {
    const dir = freshDir('badjson');
    await fsp.writeFile(path.join(dir, 'kit.json'), '{not json');
    await expect(readKitFile(dir)).rejects.toThrow(/not valid JSON/);
  });

  it('throws on an unrecognized version', async () => {
    const dir = freshDir('badversion');
    await fsp.writeFile(path.join(dir, 'kit.json'), JSON.stringify({ version: 'vedit-kit/v0' }));
    await expect(readKitFile(dir)).rejects.toThrow(/unrecognized version/);
  });
});

describe('scaffoldKit', () => {
  it('creates kit.json, GUIDE.md, fonts/, and assets/{characters,backgrounds,props}', async () => {
    const dir = freshDir('init');
    const result = await scaffoldKit(dir, 'my-series');
    expect(result.created.sort()).toEqual(['GUIDE.md', 'kit.json']);
    expect(result.existed).toEqual([]);
    const kit = await readKitFile(dir);
    expect(kit).toEqual({ version: KIT_VERSION, name: 'my-series' });
    await expect(fsp.access(path.join(dir, 'GUIDE.md'))).resolves.toBeUndefined();
    for (const sub of ['fonts', 'assets/characters', 'assets/backgrounds', 'assets/props']) {
      await expect(fsp.access(path.join(dir, sub))).resolves.toBeUndefined();
    }
  });

  it('is idempotent: re-running never clobbers an existing kit.json/GUIDE.md', async () => {
    const dir = freshDir('reinit');
    await scaffoldKit(dir, 'my-series');
    // Simulate a populated kit (kit-scan already ran, GUIDE.md was hand-edited).
    const populated: KitFile = { version: KIT_VERSION, name: 'my-series', assets: [{ id: 'a1', path: 'assets/props/x.png', type: 'prop' }] };
    await writeKitFile(dir, populated);
    await fsp.writeFile(path.join(dir, 'GUIDE.md'), 'hand-authored content');

    const result = await scaffoldKit(dir, 'my-series');
    expect(result.created).toEqual([]);
    expect(result.existed.sort()).toEqual(['GUIDE.md', 'kit.json']);
    expect(await readKitFile(dir)).toEqual(populated);
    expect(await fsp.readFile(path.join(dir, 'GUIDE.md'), 'utf8')).toBe('hand-authored content');
  });
});

// ---- alpha scan orchestration (mocked ffprobe/ffmpeg) ----

describe('scanAssetAlpha (mocked run/runBinary)', () => {
  it('probes dimensions via ffprobe, decodes rgba via ffmpeg, and computes geometry', async () => {
    runMock.mockReset();
    runBinaryMock.mockReset();
    runMock.mockResolvedValueOnce('4x4\n');
    // Bottom-half opaque, matching the computeAlphaGeometry test above.
    const buf = Buffer.alloc(4 * 4 * 4);
    for (let y = 2; y < 4; y++) for (let x = 0; x < 4; x++) buf[(y * 4 + x) * 4 + 3] = 255;
    runBinaryMock.mockResolvedValueOnce(buf);

    const geo = await scanAssetAlpha('/kit/assets/characters/hero.png');
    expect(geo).not.toBeNull();
    expect(geo!.width).toBe(4);
    expect(geo!.height).toBe(4);
    expect(geo!.visible_bounds_normalized).toEqual({ x0: 0, y0: 0.5, x1: 1, y1: 1 });

    expect(runMock).toHaveBeenCalledWith('ffprobe', expect.arrayContaining(['/kit/assets/characters/hero.png']));
    expect(runBinaryMock).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining(['-pix_fmt', 'rgba']));
  });

  it('throws a clear error when ffprobe reports no usable dimensions', async () => {
    runMock.mockReset();
    runMock.mockResolvedValueOnce('\n');
    await expect(scanAssetAlpha('/kit/bad.png')).rejects.toThrow(/could not determine image dimensions/);
  });
});

describe('listAssetPngs', () => {
  it('finds PNGs recursively under assets/, as kit-root-relative POSIX paths', async () => {
    const dir = freshDir('pnglist');
    await fsp.mkdir(path.join(dir, 'assets', 'characters'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'assets', 'backgrounds'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'assets', 'characters', 'hero.png'), '');
    await fsp.writeFile(path.join(dir, 'assets', 'backgrounds', 'room.PNG'), ''); // case-insensitive
    await fsp.writeFile(path.join(dir, 'assets', 'characters', 'notes.txt'), ''); // ignored
    const pngs = await listAssetPngs(dir);
    expect(pngs.sort()).toEqual(['assets/backgrounds/room.PNG', 'assets/characters/hero.png']);
  });

  it('returns an empty list when assets/ does not exist yet', async () => {
    const dir = freshDir('noassets');
    expect(await listAssetPngs(dir)).toEqual([]);
  });
});

describe('scanKit (mocked run/runBinary + real tmpdir fs)', () => {
  async function setupKit(): Promise<{ dir: string; kit: KitFile }> {
    const dir = freshDir('scan');
    await fsp.mkdir(path.join(dir, 'assets', 'characters'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'assets', 'props'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'assets', 'characters', 'hero.png'), '');
    const kit: KitFile = {
      version: KIT_VERSION,
      assets: [
        {
          id: 'existingid', path: 'assets/props/existing.png', type: 'prop',
          visible_bounds_normalized: { x0: 0, y0: 0, x1: 1, y1: 1 },
          ground_anchor_normalized: { x: 0.5, y: 1 }, width: 10, height: 10,
        },
      ],
    };
    return { dir, kit };
  }

  it('auto-registers a new PNG under assets/, computes its geometry, and skips an already-scanned entry', async () => {
    runMock.mockReset();
    runBinaryMock.mockReset();
    runMock.mockResolvedValue('20x20\n');
    runBinaryMock.mockResolvedValue(Buffer.alloc(20 * 20 * 4, 255)); // fully opaque

    const { dir, kit } = await setupKit();
    const result = await scanKit(dir, kit);

    expect(result.added).toEqual(['hero']);
    expect(result.scanned).toEqual(['hero']);
    expect(result.skipped).toEqual(['existingid']);
    const hero = result.kit.assets!.find((a) => a.id === 'hero')!;
    expect(hero.type).toBe('sprite');
    expect(hero.width).toBe(20);
    expect(hero.visible_bounds_normalized).toBeDefined();
  });

  it('--force re-scans already-scanned entries too', async () => {
    runMock.mockReset();
    runBinaryMock.mockReset();
    runMock.mockResolvedValue('20x20\n');
    runBinaryMock.mockResolvedValue(Buffer.alloc(20 * 20 * 4, 255));

    const { dir, kit } = await setupKit();
    const result = await scanKit(dir, kit, { force: true });
    expect(result.scanned.sort()).toEqual(['existingid', 'hero']);
    expect(result.skipped).toEqual([]);
  });

  it('warns (without failing) on a fully-transparent image', async () => {
    runMock.mockReset();
    runBinaryMock.mockReset();
    runMock.mockResolvedValue('20x20\n');
    runBinaryMock.mockResolvedValue(Buffer.alloc(20 * 20 * 4, 0)); // fully transparent

    const { dir, kit } = await setupKit();
    const result = await scanKit(dir, kit);
    expect(result.scanned).toEqual([]);
    expect(result.warnings.some((w) => w.includes('hero') && w.includes('transparent'))).toBe(true);
  });
});

// ---- resolveKitAssets (real tmpdir fs; sha256File is plain fs, no ffmpeg needed) ----

describe('resolveKitAssets', () => {
  it('resolves a valid asset, warns (but still resolves) on a sha256 mismatch, warns and excludes an escaping path, warns on an unknown id', async () => {
    const dir = freshDir('resolve');
    await fsp.mkdir(path.join(dir, 'assets', 'props'), { recursive: true });
    const filePath = path.join(dir, 'assets', 'props', 'foo.png');
    await fsp.writeFile(filePath, 'hello-bytes');
    const realHash = await sha256File(filePath);

    const outsideDir = freshDir('outside');
    await fsp.writeFile(path.join(outsideDir, 'evil.png'), 'x');

    const kit: KitFile = {
      version: KIT_VERSION,
      assets: [
        { id: 'ok', path: 'assets/props/foo.png', type: 'prop', sha256: realHash },
        { id: 'mismatch', path: 'assets/props/foo.png', type: 'prop', sha256: 'deadbeef' },
        { id: 'escape', path: '../outside/evil.png', type: 'prop' },
      ],
    };
    const { resolved, warnings } = await resolveKitAssets(dir, kit, ['ok', 'mismatch', 'escape', 'nope']);

    expect(resolved.get('ok')!.absPath).toBe(filePath);
    expect(resolved.has('mismatch')).toBe(true); // still resolved — mismatch is a warning, not a hard failure
    expect(resolved.has('escape')).toBe(false);
    expect(resolved.has('nope')).toBe(false);

    expect(warnings.some((w) => w.includes('mismatch') && w.includes('sha256'))).toBe(true);
    expect(warnings.some((w) => w.includes('escape') && w.includes('escapes kit directory'))).toBe(true);
    expect(warnings.some((w) => w.includes('nope') && w.includes('not found in kit.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ---- W-ANIME: ambient layer + speech-bubble style derivation (pure) -------
// ---------------------------------------------------------------------------

describe('firstAmbientAsset', () => {
  it('returns the FIRST type:"ambient" asset in declaration order', () => {
    const kit: KitFile = {
      version: KIT_VERSION,
      assets: [
        { id: 'a', path: 'assets/props/a.png', type: 'prop' },
        { id: 'amb1', path: 'assets/ambient/dust.mp4', type: 'ambient' },
        { id: 'amb2', path: 'assets/ambient/rain.mp4', type: 'ambient' },
      ],
    };
    expect(firstAmbientAsset(kit)?.id).toBe('amb1');
  });

  it('returns null when the kit has no ambient asset (or no kit at all) — the feature is simply absent', () => {
    expect(firstAmbientAsset({ version: KIT_VERSION, assets: [{ id: 'a', path: 'x.png', type: 'prop' }] })).toBeNull();
    expect(firstAmbientAsset(null)).toBeNull();
    expect(firstAmbientAsset(undefined)).toBeNull();
  });

  it('AMBIENT_LAYER_OPACITY is a sane low-opacity fraction', () => {
    expect(AMBIENT_LAYER_OPACITY).toBeGreaterThan(0);
    expect(AMBIENT_LAYER_OPACITY).toBeLessThan(1);
  });
});

describe('deriveSpeechBubbleStyle', () => {
  it('falls back to a neutral white-bubble/black-text default with no style linked', () => {
    const s = deriveSpeechBubbleStyle(null);
    expect(s.palette.box).toBe('#ffffff');
    expect(s.palette.text).toBe('#111111');
    expect(s.cornerRadiusFrac).toBeGreaterThan(0);
    expect(s.cornerRadiusFrac).toBeLessThan(1);
  });

  it('derives palette fields from a kit style, falling back per-field to the default when unset', () => {
    const s = deriveSpeechBubbleStyle({ id: 'main', palette: { text: '#222222', box: '#f0e0d0' } });
    expect(s.palette.text).toBe('#222222');
    expect(s.palette.box).toBe('#f0e0d0');
    expect(s.palette.outline).toBe('#111111'); // not set on the style -> default
  });

  it('a heavier outline_width yields a larger (but clamped) corner radius', () => {
    const thin = deriveSpeechBubbleStyle({ id: 'a', caption: { outline_width: 0 } });
    const thick = deriveSpeechBubbleStyle({ id: 'b', caption: { outline_width: 20 } });
    expect(thick.cornerRadiusFrac).toBeGreaterThan(thin.cornerRadiusFrac);
    expect(thick.cornerRadiusFrac).toBeLessThanOrEqual(0.4);
    expect(thin.cornerRadiusFrac).toBeGreaterThanOrEqual(0.16);
  });
});

describe('speechBubbleTailDirection', () => {
  it('points toward the sprite along whichever axis has the larger offset', () => {
    expect(speechBubbleTailDirection({ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.9 })).toBe('bottom');
    expect(speechBubbleTailDirection({ x: 0.5, y: 0.9 }, { x: 0.5, y: 0.2 })).toBe('top');
    expect(speechBubbleTailDirection({ x: 0.2, y: 0.5 }, { x: 0.9, y: 0.5 })).toBe('right');
    expect(speechBubbleTailDirection({ x: 0.9, y: 0.5 }, { x: 0.2, y: 0.5 })).toBe('left');
  });

  it('a tie defaults to "bottom" (the common case: bubble above a speaker\'s head)', () => {
    expect(speechBubbleTailDirection({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toBe('bottom');
  });
});
