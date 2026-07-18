import { describe, expect, it } from 'vitest';
import {
  anchoredBlockMoveOp,
  blockMoveOp,
  clipMoveOp,
  dropIndexForX,
  rulerStepFor,
  shouldCommitInlineEdit,
  timelineTimeToSource,
  trimDragOp,
} from './dragLogic.js';

describe('shouldCommitInlineEdit', () => {
  it('commits an ordinary unmodified Enter', () => {
    expect(shouldCommitInlineEdit({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 })).toBe(true);
  });

  it('does not commit Enter while an IME composition is active', () => {
    expect(shouldCommitInlineEdit({ key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13 })).toBe(false);
    expect(shouldCommitInlineEdit({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 })).toBe(false);
  });

  it('keeps Shift+Enter available for multiline/native editing behavior', () => {
    expect(shouldCommitInlineEdit({ key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe('rulerStepFor', () => {
  it('keeps short-project ticks dense enough to be useful', () => {
    expect(rulerStepFor(60, 700)).toBe(10);
  });

  it('uses hour-scale ticks instead of overlapping labels on a 7.6-hour timeline', () => {
    expect(rulerStepFor(27_294, 560)).toBe(3600);
  });

  it('continues scaling beyond the fixed nice-step table', () => {
    expect(rulerStepFor(10 * 86400, 700)).toBe(86400);
    expect(rulerStepFor(100 * 86400, 700)).toBe(10 * 86400);
  });

  it('returns a safe interval for missing layout inputs', () => {
    expect(rulerStepFor(0, 700)).toBe(1);
    expect(rulerStepFor(60, 0)).toBe(1);
  });
});

describe('timelineTimeToSource', () => {
  const segments = [
    { tlStart: 0, tlEnd: 5, sourceId: 's1', srcStart: 10 },
    { tlStart: 5, tlEnd: 8, sourceId: 's2', srcStart: 0 },
  ];

  it('maps a timeline time inside the first segment back to source time', () => {
    expect(timelineTimeToSource(segments, 2)).toEqual({ sourceId: 's1', srcTime: 12 });
  });

  it('maps a timeline time inside the second segment', () => {
    expect(timelineTimeToSource(segments, 6)).toEqual({ sourceId: 's2', srcTime: 1 });
  });

  it('returns null for a time past the end of the timeline', () => {
    expect(timelineTimeToSource(segments, 20)).toBeNull();
  });
});

describe('dropIndexForX', () => {
  const rects = [
    { left: 0, width: 100 }, // midpoint 50
    { left: 100, width: 100 }, // midpoint 150
    { left: 200, width: 100 }, // midpoint 250
  ];

  it('returns 0 when the pointer is left of the first midpoint', () => {
    expect(dropIndexForX(rects, 10)).toBe(0);
  });

  it('returns an index between two rects when the pointer is past their midpoint', () => {
    expect(dropIndexForX(rects, 160)).toBe(2);
  });

  it('returns the full length when the pointer is past every midpoint', () => {
    expect(dropIndexForX(rects, 999)).toBe(3);
  });

  it('returns 0 for an empty rect list', () => {
    expect(dropIndexForX([], 50)).toBe(0);
  });
});

describe('clipMoveOp', () => {
  const order = ['c1', 'c2', 'c3', 'c4'];

  it('moves a clip to the front', () => {
    expect(clipMoveOp(order, 'c2', 0)).toEqual({ op: 'clip-move', clipId: 'c2', before: 'c1' });
  });

  it('moves a clip to the end', () => {
    expect(clipMoveOp(order, 'c2', 3)).toEqual({ op: 'clip-move', clipId: 'c2', before: 'end' });
  });

  it('returns null when the drop index reproduces the exact same order', () => {
    // c2 currently sits at index 1; dropping it back at index 1 among the
    // other 3 clips reproduces the original order exactly.
    expect(clipMoveOp(order, 'c2', 1)).toBeNull();
  });

  it('clamps an out-of-range drop index to the end', () => {
    expect(clipMoveOp(order, 'c1', 999)).toEqual({ op: 'clip-move', clipId: 'c1', before: 'end' });
  });

  it('returns null for an unknown dragged clip id', () => {
    expect(clipMoveOp(order, 'nope', 0)).toBeNull();
  });

  it('moving the first clip to index 0 is a no-op (already there)', () => {
    expect(clipMoveOp(order, 'c1', 0)).toBeNull();
  });
});

describe('trimDragOp', () => {
  it('rounds a positive delta to whole frames', () => {
    expect(trimDragOp('c1', 'out', 0.5, 30)).toEqual({ op: 'trim', clipId: 'c1', edge: 'out', frames: 15 });
  });

  it('rounds a negative delta to whole frames', () => {
    expect(trimDragOp('c1', 'in', -1 / 30, 30)).toEqual({ op: 'trim', clipId: 'c1', edge: 'in', frames: -1 });
  });

  it('returns null when the delta rounds to 0 frames', () => {
    expect(trimDragOp('c1', 'out', 0.001, 30)).toBeNull();
  });
});

describe('blockMoveOp', () => {
  it('builds a motion-update op with the clamped tlStart', () => {
    expect(blockMoveOp('motion', 'mo1', 12.3, 5)).toEqual({ op: 'motion-update', id: 'mo1', tlStart: 12.3 });
  });

  it('builds a music-update op', () => {
    expect(blockMoveOp('music', 'mu1', 3, 5)).toEqual({ op: 'music-update', id: 'mu1', tlStart: 3 });
  });

  it('clamps a negative drop position to 0', () => {
    expect(blockMoveOp('motion', 'mo1', -4, 5)).toEqual({ op: 'motion-update', id: 'mo1', tlStart: 0 });
  });

  it('returns null when the clamped position matches the original (no-op drag)', () => {
    expect(blockMoveOp('motion', 'mo1', 5, 5)).toBeNull();
  });

  it('throws for an unsupported kind', () => {
    expect(() => blockMoveOp('sprite', 'x', 1, 0)).toThrow(/unsupported kind/);
  });
});

describe('anchoredBlockMoveOp', () => {
  const segments = [
    { tlStart: 0, tlEnd: 5, sourceId: 's1', srcStart: 10 },
    { tlStart: 5, tlEnd: 8, sourceId: 's2', srcStart: 0 },
  ];

  it('re-resolves a B-roll anchor at the drop position', () => {
    expect(anchoredBlockMoveOp('broll', 'ov1', segments, 6)).toEqual({
      op: 'broll-update', id: 'ov1', anchor: { sourceId: 's2', srcTime: 1 },
    });
  });

  it('re-resolves a sprite anchor at the drop position', () => {
    expect(anchoredBlockMoveOp('sprite', 'sp1', segments, 2)).toEqual({
      op: 'sprite-update', id: 'sp1', anchor: { sourceId: 's1', srcTime: 12 },
    });
  });

  it('returns null when the drop position is not covered by any segment', () => {
    expect(anchoredBlockMoveOp('broll', 'ov1', segments, 999)).toBeNull();
  });

  it('throws for an unsupported kind', () => {
    expect(() => anchoredBlockMoveOp('motion', 'x', segments, 1)).toThrow(/unsupported kind/);
  });
});
