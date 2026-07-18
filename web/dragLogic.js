// web/dragLogic.js — pure browser-interaction helpers for the W-UI timeline
// and inline editing surfaces. Deliberately dependency-free (no DOM, no
// fetch) so every export here is a plain data-in/data-out function that
// app.js can call after reading browser events/measurements, and that this
// file's colocated dragLogic.test.js can exercise directly under Vitest.
//
// `timelineTimeToSource` mirrors src/core/ops.ts's function of the same
// name — same hand-kept-in-sync duplication convention app.js already uses
// for spriteGeometry (see spriteGeometryJS in app.js).

/**
 * Timeline-time -> (sourceId, source time), or null if `tl` isn't covered by
 * any segment. `segments` is S.segments (or any array of
 * {tlStart,tlEnd,sourceId,srcStart}) in timeline order.
 */
export function timelineTimeToSource(segments, tl) {
  for (const s of segments) {
    if (tl >= s.tlStart && tl < s.tlEnd) return { sourceId: s.sourceId, srcTime: s.srcStart + (tl - s.tlStart) };
  }
  return null;
}

const RULER_NICE_STEPS = [
  0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900,
  1800, 3600, 7200, 14400, 28800, 43200, 86400,
];

/**
 * Pick a timeline ruler interval that stays at least `targetPx` apart.
 * The former fixed list stopped at 15 minutes, so multi-hour projects
 * rendered dozens of overlapping labels. Durations beyond a day fall back
 * to whole-day multiples and retain the same no-crowding invariant.
 */
export function rulerStepFor(duration, width, targetPx = 70) {
  if (!(duration > 0) || !(width > 0) || !(targetPx > 0)) return 1;
  const rawStep = duration / Math.max(1, width / targetPx);
  return RULER_NICE_STEPS.find((step) => step >= rawStep)
    ?? Math.ceil(rawStep / 86400) * 86400;
}

/**
 * Whether Enter should commit a single-line inline edit. During Japanese
 * IME conversion Chromium/Safari can emit Enter with either isComposing or
 * the legacy keyCode 229 marker; neither event is an editing decision.
 */
export function shouldCommitInlineEdit(event) {
  return event?.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && event.keyCode !== 229;
}

/**
 * Index (0..N) into `rects` — the OTHER clips' current on-screen boxes,
 * left-to-right, as `{left, width}` — that pointer position `x` falls into.
 * Used to turn a clip-body drag's live pointer position into an insertion
 * index; the dragged clip's own rect must NOT be included (see clipMoveOp).
 */
export function dropIndexForX(rects, x) {
  let idx = 0;
  for (const r of rects) {
    if (x > r.left + r.width / 2) idx++;
    else break;
  }
  return idx;
}

/**
 * `{op:'clip-move'}` args for dropping `draggedClipId` at `dropIndex` (an
 * index from dropIndexForX, or any 0..N) among `orderedClipIds` — the
 * CURRENT timeline order, dragged clip included. Returns null when the drop
 * would reproduce the exact same order (nothing to commit).
 */
export function clipMoveOp(orderedClipIds, draggedClipId, dropIndex) {
  const currentIdx = orderedClipIds.indexOf(draggedClipId);
  if (currentIdx < 0) return null;
  const withoutDragged = orderedClipIds.filter((id) => id !== draggedClipId);
  const clamped = Math.max(0, Math.min(dropIndex, withoutDragged.length));
  if (clamped === currentIdx) return null; // reinserting at its original slot = no-op
  const before = withoutDragged[clamped] ?? 'end';
  return { op: 'clip-move', clipId: draggedClipId, before };
}

/**
 * `{op:'trim'}` args for dragging a clip edge by `deltaSeconds` (positive =
 * dragged toward later timeline time). Returns null when the drag rounds to
 * 0 frames — dropping back where it started shouldn't commit a no-op trim.
 */
export function trimDragOp(clipId, edge, deltaSeconds, fps) {
  const frames = Math.round(deltaSeconds * fps);
  if (frames === 0) return null;
  return { op: 'trim', clipId, edge, frames };
}

/**
 * `{op:'motion-update'|'music-update'}` args for dragging a motion/BGM block
 * to a new timeline start time (clamped to >= 0). Returns null when the
 * clamped position is unchanged from `originalTlStart` (nothing to commit).
 */
export function blockMoveOp(kind, id, newTlStart, originalTlStart) {
  const tlStart = Math.max(0, newTlStart);
  if (Math.abs(tlStart - originalTlStart) < 1e-6) return null;
  if (kind === 'motion') return { op: 'motion-update', id, tlStart };
  if (kind === 'music') return { op: 'music-update', id, tlStart };
  throw new Error(`blockMoveOp: unsupported kind ${JSON.stringify(kind)}`);
}

/**
 * `{op:'broll-update'|'sprite-update'}` args for dragging a B-roll/sprite
 * block to a new timeline position — re-resolves the anchor AT THE DROP
 * POSITION via timelineTimeToSource (W-UI §2: "ドロップ先の tl 時刻を
 * timelineTimeToSource で逆解決"), so the item re-attaches to whatever
 * speech/frame is there now instead of carrying a stale anchor. Returns null
 * if the drop position isn't covered by any segment (nothing to anchor to).
 */
export function anchoredBlockMoveOp(kind, id, segments, newTl) {
  const anchor = timelineTimeToSource(segments, Math.max(0, newTl));
  if (!anchor) return null;
  if (kind === 'broll') return { op: 'broll-update', id, anchor };
  if (kind === 'sprite') return { op: 'sprite-update', id, anchor };
  throw new Error(`anchoredBlockMoveOp: unsupported kind ${JSON.stringify(kind)}`);
}
