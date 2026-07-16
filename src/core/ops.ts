import type { Manifest, Segment, VideoClip, Word } from './types.js';

/** Snap a time to the timeline frame grid. */
export function snap(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

let idCounter = 0;
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** Compute the timeline→source mapping from the ordered clip list. */
export function segments(m: Manifest): Segment[] {
  const out: Segment[] = [];
  let t = 0;
  for (const c of m.timeline.video) {
    const d = c.srcOut - c.srcIn;
    if (d <= 0) continue;
    out.push({ tlStart: t, tlEnd: t + d, sourceId: c.sourceId, srcStart: c.srcIn, clipId: c.id });
    t += d;
  }
  return out;
}

export function timelineDuration(m: Manifest): number {
  return segments(m).reduce((acc, s) => acc + (s.tlEnd - s.tlStart), 0);
}

/** Map a source-time range to what remains on the timeline, if anything. */
export function sourceRangeToTimeline(m: Manifest, sourceId: string, t0: number, t1: number): { tlStart: number; tlEnd: number } | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const s of segments(m)) {
    if (s.sourceId !== sourceId) continue;
    const srcEnd = s.srcStart + (s.tlEnd - s.tlStart);
    const a = Math.max(t0, s.srcStart);
    const b = Math.min(t1, srcEnd);
    if (b <= a) continue;
    const tlA = s.tlStart + (a - s.srcStart);
    const tlB = s.tlStart + (b - s.srcStart);
    if (start === null || tlA < start) start = tlA;
    if (end === null || tlB > end) end = tlB;
  }
  return start === null || end === null ? null : { tlStart: start, tlEnd: end };
}

/**
 * Remove a source-time range from every clip that references it.
 * Clips are split/trimmed; empty clips are dropped. Ripple layout means
 * downstream content shifts left automatically.
 */
export function removeSourceRange(m: Manifest, sourceId: string, t0: number, t1: number): Manifest {
  const fps = m.fps;
  const a = snap(Math.min(t0, t1), fps);
  const b = snap(Math.max(t0, t1), fps);
  const next: VideoClip[] = [];
  for (const c of m.timeline.video) {
    if (c.sourceId !== sourceId || b <= c.srcIn || a >= c.srcOut) {
      next.push(c);
      continue;
    }
    const left: VideoClip | null = a > c.srcIn ? { ...c, srcOut: Math.min(a, c.srcOut) } : null;
    const right: VideoClip | null = b < c.srcOut ? { ...c, id: left ? freshId('c') : c.id, srcIn: Math.max(b, c.srcIn) } : null;
    if (left && left.srcOut - left.srcIn > 1e-6) next.push(left);
    if (right && right.srcOut - right.srcIn > 1e-6) next.push(right);
  }
  return { ...m, timeline: { ...m.timeline, video: next } };
}

/** Remove the source range spanned by a contiguous run of words (with padding trimmed to word gaps). */
export function wordRange(words: Word[], ids: string[]): { t0: number; t1: number } {
  const set = new Set(ids);
  const hit = words.filter((w) => set.has(w.id));
  if (hit.length === 0) throw new Error(`no words matched ids: ${ids.slice(0, 5).join(',')}...`);
  const t0 = Math.min(...hit.map((w) => w.t0));
  const t1 = Math.max(...hit.map((w) => w.t1));
  return { t0, t1 };
}

/**
 * Widen a word-derived removal range by `pad` seconds on each side, without
 * biting into a surviving (non-removed) neighbor word. Whisper's word
 * boundaries are often a hair too tight, so a razor cut at t0/t1 can clip the
 * tail of speech; padding outward — clamped at the nearest kept word —
 * avoids that while never touching audio the user meant to keep.
 */
export function padWordRange(
  words: Word[],
  ids: string[],
  range: { t0: number; t1: number },
  pad: number,
): { t0: number; t1: number } {
  const idSet = new Set(ids);
  let t0 = range.t0 - pad;
  let t1 = range.t1 + pad;
  for (const w of words) {
    if (idSet.has(w.id)) continue;
    if (w.t1 <= range.t0 && w.t1 > t0) t0 = w.t1;
    if (w.t0 >= range.t1 && w.t0 < t1) t1 = w.t0;
  }
  t0 = Math.max(0, t0);
  return { t0, t1: Math.max(t0, t1) };
}

/** Expand "w12..w34" style ranges into explicit id lists. */
export function expandWordIds(spec: string[], words: Word[]): string[] {
  const order = new Map(words.map((w, i) => [w.id, i]));
  const out: string[] = [];
  for (const s of spec) {
    const m = s.match(/^(\S+?)\.\.(\S+)$/);
    if (!m) {
      if (!order.has(s)) throw new Error(`unknown word id: ${s}`);
      out.push(s);
      continue;
    }
    const i0 = order.get(m[1]);
    const i1 = order.get(m[2]);
    if (i0 === undefined || i1 === undefined) throw new Error(`unknown word id in range: ${s}`);
    for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) out.push(words[i].id);
  }
  return out;
}

/** Trim one edge of a clip by a signed number of frames (+ extends, - shortens... in source time). */
export function trimClip(m: Manifest, clipId: string, edge: 'in' | 'out', frames: number): Manifest {
  const delta = frames / m.fps;
  const src = new Map(m.sources.map((s) => [s.id, s]));
  const next = m.timeline.video.map((c) => {
    if (c.id !== clipId) return c;
    const dur = src.get(c.sourceId)?.duration ?? Infinity;
    if (edge === 'in') {
      const srcIn = Math.max(0, Math.min(c.srcOut - 1 / m.fps, snap(c.srcIn + delta, m.fps)));
      return { ...c, srcIn };
    }
    const srcOut = Math.min(dur, Math.max(c.srcIn + 1 / m.fps, snap(c.srcOut + delta, m.fps)));
    return { ...c, srcOut };
  });
  if (!m.timeline.video.some((c) => c.id === clipId)) throw new Error(`unknown clip: ${clipId}`);
  return { ...m, timeline: { ...m.timeline, video: next } };
}

/** Which words survive the current timeline (for captions / packed transcript). */
export function keptWords(m: Manifest, sourceId: string, words: Word[]): Word[] {
  const segs = segments(m).filter((s) => s.sourceId === sourceId);
  return words.filter((w) => {
    const mid = (w.t0 + w.t1) / 2;
    return segs.some((s) => mid >= s.srcStart && mid < s.srcStart + (s.tlEnd - s.tlStart));
  });
}

/** Map a source time to timeline time, or null if cut away. */
export function sourceTimeToTimeline(m: Manifest, sourceId: string, t: number): number | null {
  for (const s of segments(m)) {
    if (s.sourceId !== sourceId) continue;
    const d = s.tlEnd - s.tlStart;
    if (t >= s.srcStart && t < s.srcStart + d) return s.tlStart + (t - s.srcStart);
  }
  return null;
}
