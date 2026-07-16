import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { Manifest } from '../core/types.js';

// renderView shells out to ffmpeg via run()/ffmpegHasFilter; stub both so the
// "B-roll V2 sample point" suite below only asserts on which media path each
// per-frame ffmpeg call used (and the grid legend text), without needing
// ffmpeg installed or touching the real filesystem (same approach as
// render.test.ts's mocks).
const { runMock, hasFilterMock } = vi.hoisted(() => ({
  runMock: vi.fn(async () => ''),
  hasFilterMock: vi.fn(() => false), // no drawtext, matching this suite's prior fixed behavior
}));
vi.mock('../ingest/run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  ffmpegHasFilter: (...args: unknown[]) => hasFilterMock(...args),
}));

import { addOverlay, addSprite } from '../core/ops.js';
import { renderView } from './view.js';

function manifest(): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [
      { id: 's1', path: '/aroll.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true },
      { id: 's2', path: '/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
    ],
    // A single, uncut A-roll clip: tl[0,10) <- src[0,10) (1:1 mapping), so
    // sample-point math below stays simple.
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

/** ffmpeg calls that extract one frame (as opposed to the final xstack tile-compose call). */
function frameCalls() {
  return runMock.mock.calls.filter((c) => c[0] === 'ffmpeg' && (c[1] as string[]).includes('-frames:v'));
}

describe('renderView: B-roll V2 overlay sample points (W3)', () => {
  it('draws the B-roll frame (not the A-roll) for sample points inside a resolved overlay window', async () => {
    runMock.mockClear();
    // anchor src=2 -> tlStart=2 (1:1 mapping); dur=4 -> resolved tl[2,6).
    const m = addOverlay(manifest(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } });
    const { grid } = await renderView(m, '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    // 5 sample centers at tl = 1,3,5,7,9 — only 3 and 5 fall inside [2,6).
    expect(grid[0]).toContain('@s1');
    expect(grid[0]).not.toContain('overlay');
    expect(grid[1]).toContain('@s2');
    expect(grid[1]).toContain('[overlay ov1]');
    expect(grid[2]).toContain('@s2');
    expect(grid[2]).toContain('[overlay ov1]');
    expect(grid[3]).toContain('@s1');
    expect(grid[4]).toContain('@s1');

    // The underlying ffmpeg frame-extraction calls actually read from the
    // B-roll source's media for the overlay-covered cells — the grid legend
    // isn't lying about what render.ts would also composite at that instant.
    const calls = frameCalls();
    expect(calls).toHaveLength(5);
    expect(calls[0][1]).toContain('/aroll.mp4');
    expect(calls[1][1]).toContain('/broll.mp4');
    expect(calls[2][1]).toContain('/broll.mp4');
    expect(calls[3][1]).toContain('/aroll.mp4');
    expect(calls[4][1]).toContain('/aroll.mp4');
  });

  it('an orphaned overlay never affects sample points (falls back to the A-roll everywhere)', async () => {
    runMock.mockClear();
    // src=50 is past the A-roll's only clip (tl[0,10)<-src[0,10)) -> unresolvable.
    const m = addOverlay(manifest(), 's2', { id: 'ov1', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 50 } });
    const { grid } = await renderView(m, '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid.every((g) => g.includes('@s1') && !g.includes('overlay'))).toBe(true);
    expect(frameCalls().every((c) => (c[1] as string[]).some((a) => a === '/aroll.mp4'))).toBe(true);
  });

  it('an overlay-less project never tags any grid cell with [overlay ...] (regression)', async () => {
    runMock.mockClear();
    const { grid } = await renderView(manifest(), '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid.every((g) => !g.includes('overlay'))).toBe(true);
  });

  it('domain "source" ignores overlays entirely (raw, uncut source inspection)', async () => {
    runMock.mockClear();
    const m = addOverlay(manifest(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } });
    const { grid } = await renderView(m, '/proj', { domain: 'source', sourceId: 's1', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid.every((g) => g.includes('@s1') && !g.includes('overlay'))).toBe(true);
  });
});

describe('renderView: W8 kit sprite grid-legend annotation', () => {
  // Sprites are a translucent compositing layer, not a frame-source swap
  // like B-roll — renderView deliberately does NOT draw sprite pixels into
  // the filmstrip (spec leaves this to implementer judgment); it only notes
  // which sample points fall inside a resolved sprite's window, same spirit
  // as the `[overlay <id>]` annotation above.
  it('tags grid cells inside a resolved sprite window with [sprite <id>], without changing which media each cell reads from', async () => {
    runMock.mockClear();
    // anchor src=2 -> tlStart=2 (1:1 mapping); dur=4 -> resolved tl[2,6).
    const m = addSprite(manifest(), 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 4 });
    const { grid } = await renderView(m, '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    // 5 sample centers at tl = 1,3,5,7,9 — only 3 and 5 fall inside [2,6).
    expect(grid[0]).not.toContain('sprite');
    expect(grid[1]).toContain('[sprite sp1]');
    expect(grid[2]).toContain('[sprite sp1]');
    expect(grid[3]).not.toContain('sprite');
    expect(grid[4]).not.toContain('sprite');
    // Every cell still reads from the A-roll — sprites never swap the sampled source (unlike B-roll).
    expect(grid.every((g) => g.includes('@s1'))).toBe(true);
    expect(frameCalls().every((c) => (c[1] as string[]).some((a) => a === '/aroll.mp4'))).toBe(true);
  });

  it('multiple overlapping sprites at the same sample point are all listed, comma-separated', async () => {
    runMock.mockClear();
    let m = addSprite(manifest(), 'char1', { id: 'spA', anchor: { sourceId: 's1', srcTime: 2 }, duration: 4 });
    m = addSprite(m, 'char2', { id: 'spB', anchor: { sourceId: 's1', srcTime: 2 }, duration: 4 });
    const { grid } = await renderView(m, '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid[1]).toContain('[sprite spA,spB]');
  });

  it('an orphaned sprite never affects the grid legend', async () => {
    runMock.mockClear();
    // src=50 is past the A-roll's only clip (tl[0,10)<-src[0,10)) -> unresolvable.
    const m = addSprite(manifest(), 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 50 } });
    const { grid } = await renderView(m, '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid.every((g) => !g.includes('sprite'))).toBe(true);
  });

  it('a sprite-less project never tags any grid cell with [sprite ...] (regression)', async () => {
    runMock.mockClear();
    const { grid } = await renderView(manifest(), '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid.every((g) => !g.includes('sprite'))).toBe(true);
  });

  it('overlay and sprite annotations coexist on the same cell', async () => {
    runMock.mockClear();
    let m = addOverlay(manifest(), 's2', { id: 'ov1', srcIn: 0, srcOut: 4, anchor: { sourceId: 's1', srcTime: 2 } });
    m = addSprite(m, 'char1', { id: 'sp1', anchor: { sourceId: 's1', srcTime: 2 }, duration: 4 });
    const { grid } = await renderView(m, '/proj', { domain: 'timeline', from: 0, to: 10, cols: 5, rows: 1 });
    expect(grid[1]).toContain('[overlay ov1]');
    expect(grid[1]).toContain('[sprite sp1]');
  });
});

describe('renderView: W5 color transform + adjust (proxy vs no-proxy)', () => {
  it('applies the full colorTransform chain when the source has no proxy yet (falls back to the original file)', async () => {
    runMock.mockClear();
    hasFilterMock.mockImplementation(() => true); // pretend zscale/tonemap are available
    const m = manifest();
    m.sources[0].colorTransform = { type: 'hlg' };
    await renderView(m, '/proj', { domain: 'source', sourceId: 's1', from: 0, to: 1, cols: 1, rows: 1 });
    const calls = frameCalls();
    expect(calls).toHaveLength(1);
    const vf = calls[0][1][calls[0][1].indexOf('-vf') + 1] as string;
    expect(vf).toContain('tonemap=hable');
    hasFilterMock.mockImplementation(() => false);
  });

  it('does NOT re-apply colorTransform once a proxy exists (already baked in) but still applies colorAdjust on top', async () => {
    runMock.mockClear();
    const m = manifest();
    m.sources[0] = { ...m.sources[0], proxy: 'cache/proxy-s1.mp4', colorTransform: { type: 'hlg' } };
    m.colorAdjust = { s1: { sat: 1.3 } };
    await renderView(m, '/proj', { domain: 'source', sourceId: 's1', from: 0, to: 1, cols: 1, rows: 1 });
    const calls = frameCalls();
    const [cmd, args] = calls[0] as [string, string[]];
    const vf = args[args.indexOf('-vf') + 1] as string;
    expect(vf).not.toMatch(/zscale|tonemap/);
    expect(vf).toContain('eq=brightness=0:saturation=1.3');
    expect(args).toContain(path.join('/proj', 'cache/proxy-s1.mp4'));
    expect(cmd).toBe('ffmpeg');
  });

  it('no colorTransform/colorAdjust anywhere leaves every -vf identical to before this feature existed (regression)', async () => {
    runMock.mockClear();
    await renderView(manifest(), '/proj', { domain: 'timeline', from: 0, to: 10, cols: 2, rows: 1 });
    for (const [, args] of frameCalls() as [string, string[]][]) {
      const vf = args[args.indexOf('-vf') + 1] as string;
      expect(vf).not.toMatch(/zscale|tonemap|lut3d|eq=brightness|colortemperature|colorbalance/);
    }
  });
});
