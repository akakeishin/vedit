import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Manifest, Source } from '../core/types.js';

// buildColorChain/proposeColorMatch shell out to ffmpeg via
// run()/ffmpegHasFilter (same approach as render.test.ts/view.test.ts's
// mocks) so these tests never need ffmpeg installed.
const { runMock, hasFilterMock } = vi.hoisted(() => ({
  runMock: vi.fn(async () => ''),
  hasFilterMock: vi.fn(() => true),
}));
vi.mock('../ingest/run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  ffmpegHasFilter: (...args: unknown[]) => hasFilterMock(...args),
}));

import { buildColorChain, parseSignalStats, proposeColorMatch, suggestColorAdjust } from './color.js';

describe('buildColorChain', () => {
  it('returns "" for no colorTransform and no adjust (full regression)', () => {
    expect(buildColorChain(undefined)).toBe('');
    expect(buildColorChain(undefined, undefined)).toBe('');
  });

  it('returns "" for an explicit type "none", even with no adjust', () => {
    expect(buildColorChain({ type: 'none' })).toBe('');
  });

  it('builds the HLG chain (zscale linear -> tonemap hable -> zscale bt709)', () => {
    hasFilterMock.mockClear();
    const chain = buildColorChain({ type: 'hlg' });
    expect(chain).toBe('zscale=t=linear:npl=1000,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p');
    expect(hasFilterMock).toHaveBeenCalledWith('zscale');
    expect(hasFilterMock).toHaveBeenCalledWith('tonemap');
  });

  it('builds the PQ chain with a different npl than HLG', () => {
    const chain = buildColorChain({ type: 'pq' });
    expect(chain).toBe('zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p');
  });

  it('throws a clear, ffmpeg-full-pointing error when zscale/tonemap is unavailable', () => {
    hasFilterMock.mockImplementation((name: string) => name !== 'zscale');
    expect(() => buildColorChain({ type: 'hlg' })).toThrow(/zscale.*ffmpeg-full/);
    hasFilterMock.mockImplementation(() => true);
  });

  it('builds a lut3d clause with the path single-quote-escaped', () => {
    const chain = buildColorChain({ type: 'lut', lut: "/luts/d'log.cube" });
    expect(chain).toBe("lut3d='/luts/d\\'log.cube'");
  });

  it('throws when type "lut" carries no lut path (should never happen past setColorTransform, but defensive)', () => {
    expect(() => buildColorChain({ type: 'lut' } as Source['colorTransform'])).toThrow(/requires a lut path/);
  });

  it('throws when lut3d is unavailable on this ffmpeg build', () => {
    hasFilterMock.mockImplementation((name: string) => name !== 'lut3d');
    expect(() => buildColorChain({ type: 'lut', lut: '/x.cube' })).toThrow(/lut3d.*ffmpeg-full/);
    hasFilterMock.mockImplementation(() => true);
  });

  it('converts exposure to eq brightness (EV/4) and passes sat through to eq saturation', () => {
    const chain = buildColorChain(undefined, { exposure: 0.4, sat: 1.2 });
    expect(chain).toBe('eq=brightness=0.1:saturation=1.2');
  });

  it('emits eq with a default saturation=1 when only exposure is set', () => {
    expect(buildColorChain(undefined, { exposure: -2 })).toBe('eq=brightness=-0.5:saturation=1');
  });

  it('emits eq with a default brightness=0 when only sat is set', () => {
    expect(buildColorChain(undefined, { sat: 0.5 })).toBe('eq=brightness=0:saturation=0.5');
  });

  it('uses colortemperature for wb when the ffmpeg build has it', () => {
    hasFilterMock.mockImplementation(() => true);
    expect(buildColorChain(undefined, { wb: -100 })).toBe('colortemperature=temperature=3000');
    expect(buildColorChain(undefined, { wb: 100 })).toBe('colortemperature=temperature=10000');
    expect(buildColorChain(undefined, { wb: 0 })).toBe('colortemperature=temperature=6500');
  });

  it('falls back to colorbalance when colortemperature is unavailable', () => {
    hasFilterMock.mockImplementation((name: string) => name !== 'colortemperature');
    expect(buildColorChain(undefined, { wb: 40 })).toBe('colorbalance=rm=0.2:bm=-0.2');
    hasFilterMock.mockImplementation(() => true);
  });

  it('combines colorTransform + adjust in one comma-joined chain, transform first', () => {
    const chain = buildColorChain({ type: 'hlg' }, { exposure: 0.4, wb: 0, sat: 1.2 });
    expect(chain).toBe(
      'zscale=t=linear:npl=1000,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p,' +
        'eq=brightness=0.1:saturation=1.2,colortemperature=temperature=6500',
    );
  });

  it('adjust with all fields undefined (no keys) produces no clause at all', () => {
    expect(buildColorChain(undefined, {})).toBe('');
  });
});

describe('parseSignalStats', () => {
  it('parses YAVG/UAVG/VAVG/SATAVG from metadata=print output', () => {
    const text = `frame:0    pts:0      pts_time:0
lavfi.signalstats.YAVG=123.456789
lavfi.signalstats.UAVG=128.100000
lavfi.signalstats.VAVG=130.250000
lavfi.signalstats.SATAVG=12.340000
`;
    expect(parseSignalStats(text)).toEqual({ yavg: 123.456789, uavg: 128.1, vavg: 130.25, satavg: 12.34 });
  });

  it('handles negative-looking values without choking (defensive; signalstats output is non-negative in practice)', () => {
    const text = 'lavfi.signalstats.YAVG=-1\nlavfi.signalstats.UAVG=1\nlavfi.signalstats.VAVG=1\nlavfi.signalstats.SATAVG=1\n';
    expect(parseSignalStats(text).yavg).toBe(-1);
  });

  it('throws when a stat is missing entirely', () => {
    expect(() => parseSignalStats('lavfi.signalstats.YAVG=1\n')).toThrow(/UAVG/);
  });
});

describe('suggestColorAdjust', () => {
  it('proposes no change when base and target measure identically', () => {
    const stats = { yavg: 128, uavg: 128, vavg: 128, satavg: 20 };
    expect(suggestColorAdjust(stats, stats)).toEqual({ exposure: 0, wb: 0, sat: 1 });
  });

  it('proposes a positive exposure delta when the target is darker than the base', () => {
    const base = { yavg: 180, uavg: 128, vavg: 128, satavg: 20 };
    const target = { yavg: 100, uavg: 128, vavg: 128, satavg: 20 };
    const s = suggestColorAdjust(base, target);
    expect(s.exposure).toBeGreaterThan(0);
  });

  it('clamps exposure/wb/sat to the same ranges setColorAdjust enforces', () => {
    const base = { yavg: 255, uavg: 255, vavg: 0, satavg: 100 };
    const target = { yavg: 0, uavg: 0, vavg: 255, satavg: 0.0000001 };
    const s = suggestColorAdjust(base, target);
    expect(s.exposure).toBeLessThanOrEqual(2);
    expect(s.exposure).toBeGreaterThanOrEqual(-2);
    expect(s.wb).toBeLessThanOrEqual(100);
    expect(s.wb).toBeGreaterThanOrEqual(-100);
    expect(s.sat).toBeLessThanOrEqual(2);
    expect(s.sat).toBeGreaterThanOrEqual(0);
  });

  it('defaults sat to 1 (no change) when the target satavg is ~0 (division guard)', () => {
    const base = { yavg: 128, uavg: 128, vavg: 128, satavg: 20 };
    const target = { yavg: 128, uavg: 128, vavg: 128, satavg: 0 };
    expect(suggestColorAdjust(base, target).sat).toBe(1);
  });
});

describe('proposeColorMatch', () => {
  function manifest(): Manifest {
    return {
      version: 1,
      name: 't',
      revision: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      sources: [
        { id: 'base', path: '/base.mp4', duration: 20, fps: 30, width: 1920, height: 1080, hasAudio: true, proxy: 'cache/proxy-base.mp4' },
        { id: 'tgt1', path: '/tgt1.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: { video: [], motion: [] },
      captions: { enabled: true, style: 'clean', maxChars: 24 },
    };
  }

  function statsText(y: number, u: number, v: number, s: number) {
    return `lavfi.signalstats.YAVG=${y}\nlavfi.signalstats.UAVG=${u}\nlavfi.signalstats.VAVG=${v}\nlavfi.signalstats.SATAVG=${s}\n`;
  }

  it('samples the mid-point of each source, preferring the proxy when one exists, and returns base + per-target proposals', async () => {
    runMock.mockReset();
    runMock.mockResolvedValueOnce(statsText(150, 128, 128, 20)); // base
    runMock.mockResolvedValueOnce(statsText(100, 128, 128, 20)); // tgt1
    const result = await proposeColorMatch(manifest(), '/proj', 'base', ['tgt1']);

    expect(result.base).toMatchObject({ sourceId: 'base', yavg: 150 });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].sourceId).toBe('tgt1');
    expect(result.proposals[0].measured.yavg).toBe(100);
    expect(result.proposals[0].suggested.exposure).toBeGreaterThan(0); // target is darker

    const baseCall = runMock.mock.calls[0][1] as string[];
    expect(baseCall[baseCall.indexOf('-ss') + 1]).toBe('10'); // duration/2
    expect(baseCall).toContain(path.join('/proj', 'cache/proxy-base.mp4')); // proxy used when present
    const tgtCall = runMock.mock.calls[1][1] as string[];
    expect(tgtCall).toContain('/tgt1.mp4'); // falls back to original when no proxy
    expect(tgtCall[tgtCall.indexOf('-ss') + 1]).toBe('5');
  });

  it('rejects an unknown source id', async () => {
    runMock.mockReset();
    await expect(proposeColorMatch(manifest(), '/proj', 'nope', ['tgt1'])).rejects.toThrow(/unknown source/);
  });
});
