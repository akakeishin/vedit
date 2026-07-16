import type { Manifest, MusicItem, OverlayClip, SceneFile, Segment, Source, VideoClip, Word } from './types.js';

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
    out.push({ tlStart: t, tlEnd: t + d, sourceId: c.sourceId, srcStart: c.srcIn, clipId: c.id, crop: c.crop });
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
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
    throw new Error(`invalid range: ${t0}..${t1} (must be finite seconds)`);
  }
  const fps = m.fps;
  const a = snap(Math.min(t0, t1), fps);
  const b = snap(Math.max(t0, t1), fps);
  // A range that collapses to a single frame boundary would split clips
  // without removing time — a pure no-op with side effects. Refuse it.
  if (b - a < 0.5 / fps) return m;
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
  if (edge !== 'in' && edge !== 'out') {
    throw new Error(`invalid edge: ${JSON.stringify(edge)} (must be "in" or "out")`);
  }
  if (!Number.isInteger(frames)) throw new Error(`invalid frames: ${JSON.stringify(frames)} (must be a finite integer)`);
  const src = new Map(m.sources.map((s) => [s.id, s]));
  const next = m.timeline.video.map((c) => {
    if (c.id !== clipId) return c;
    // Frames are a SOURCE-time unit here: trim moves an edge across source
    // frames, so a 24fps source on a 29.97 timeline must step in 1/24s.
    const fps = src.get(c.sourceId)?.fps || m.fps;
    const delta = frames / fps;
    const dur = src.get(c.sourceId)?.duration ?? Infinity;
    if (edge === 'in') {
      const srcIn = Math.max(0, Math.min(c.srcOut - 1 / fps, snap(c.srcIn + delta, fps)));
      return { ...c, srcIn };
    }
    const srcOut = Math.min(dur, Math.max(c.srcIn + 1 / fps, snap(c.srcOut + delta, fps)));
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

/** Map a timeline time to (sourceId, source time), or null if out of range — the inverse of sourceTimeToTimeline. */
export function timelineTimeToSource(m: Manifest, tl: number): { sourceId: string; srcTime: number } | null {
  for (const s of segments(m)) {
    if (tl >= s.tlStart && tl < s.tlEnd) return { sourceId: s.sourceId, srcTime: s.srcStart + (tl - s.tlStart) };
  }
  return null;
}

// ---- clip selection / reorder (timeline vs. source pool) ----

/** Add a clip to the timeline referencing an already-ingested source. */
export function addClip(
  m: Manifest,
  sourceId: string,
  opts: { in?: number; out?: number; at?: number; id?: string } = {},
): Manifest {
  const src = m.sources.find((s) => s.id === sourceId);
  if (!src) throw new Error(`unknown source: ${sourceId}`);
  const srcIn = opts.in ?? 0;
  const srcOut = opts.out ?? src.duration;
  if (!Number.isFinite(srcIn) || !Number.isFinite(srcOut)) {
    throw new Error(`clip-add: in/out must be finite numbers (got in=${srcIn}, out=${srcOut})`);
  }
  if (srcIn < 0) throw new Error(`clip-add: in (${srcIn}) must be >= 0`);
  if (srcOut <= srcIn) throw new Error(`clip-add: out (${srcOut}) must be greater than in (${srcIn})`);
  if (srcOut > src.duration) {
    throw new Error(`clip-add: out (${srcOut}) exceeds source duration (${src.duration})`);
  }
  const id = opts.id ?? freshId('c');
  if (m.timeline.video.some((c) => c.id === id)) {
    throw new Error(`clip-add: clip id already exists: ${id}`);
  }
  const clip: VideoClip = { id, sourceId, srcIn, srcOut };
  const video = [...m.timeline.video];
  if (opts.at !== undefined && (!Number.isInteger(opts.at) || opts.at < 0 || opts.at > video.length)) {
    throw new Error(`clip-add: at (${opts.at}) must be an integer between 0 and ${video.length}`);
  }
  const at = opts.at === undefined ? video.length : opts.at;
  video.splice(at, 0, clip);
  return { ...m, timeline: { ...m.timeline, video } };
}

/** Remove a clip from the timeline; its source stays available in the pool. */
export function removeClip(m: Manifest, clipId: string): Manifest {
  const video = m.timeline.video.filter((c) => c.id !== clipId);
  if (video.length === m.timeline.video.length) throw new Error(`unknown clip: ${clipId}`);
  return { ...m, timeline: { ...m.timeline, video } };
}

/** Reorder a clip to just before `beforeClipId`, or to the end when 'end'. */
export function moveClip(m: Manifest, clipId: string, beforeClipId: string | 'end'): Manifest {
  const clip = m.timeline.video.find((c) => c.id === clipId);
  if (!clip) throw new Error(`unknown clip: ${clipId}`);
  const rest = m.timeline.video.filter((c) => c.id !== clipId);
  let at = rest.length;
  if (beforeClipId !== 'end') {
    at = rest.findIndex((c) => c.id === beforeClipId);
    if (at < 0) throw new Error(`unknown clip: ${beforeClipId}`);
  }
  rest.splice(at, 0, clip);
  return { ...m, timeline: { ...m.timeline, video: rest } };
}

// ---- 9:16 / arbitrary-aspect reframe ----

/** Parse a reframe target: "9:16"/"1:1"/"16:9" ratios, or literal "WxH" pixels. */
export function parseReframeSpec(spec: string): { width: number; height: number } {
  // yuv420p requires even dimensions; reject non-positive/non-finite values
  // outright (a 0 or Infinity ratio part would otherwise divide-by-zero into
  // NaN/Infinity below) and round odd pixel counts to the nearest even one.
  const normalizeDim = (v: number): number => {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`invalid reframe spec: ${spec} (dimensions must be positive finite numbers)`);
    }
    return Math.max(2, Math.round(v / 2) * 2);
  };
  const literal = spec.match(/^(\d+)[xX](\d+)$/);
  if (literal) return { width: normalizeDim(Number(literal[1])), height: normalizeDim(Number(literal[2])) };
  const ratio = spec.match(/^(\d+):(\d+)$/);
  if (!ratio) throw new Error(`invalid reframe spec: ${spec} (use 9:16, 1:1, 16:9, or WxH)`);
  const w = Number(ratio[1]);
  const h = Number(ratio[2]);
  if (w <= 0 || h <= 0) throw new Error(`invalid reframe spec: ${spec} (ratio parts must be positive)`);
  // Scale so the shorter ratio number lands on 1080px, matching the usual
  // shorthand for these aspects (9:16 -> 1080x1920, 16:9 -> 1920x1080).
  const scale = 1080 / Math.min(w, h);
  return { width: normalizeDim(w * scale), height: normalizeDim(h * scale) };
}

/** Parse a --focus flag: left/center/right, or an explicit 0..1 fraction. */
export function parseFocus(focus: string | number | undefined): number {
  if (focus === undefined) return 0.5;
  if (focus === 'left') return 0;
  if (focus === 'center') return 0.5;
  if (focus === 'right') return 1;
  const n = Number(focus);
  if (Number.isNaN(n)) throw new Error(`invalid focus: ${focus} (use left/center/right or 0..1)`);
  return Math.max(0, Math.min(1, n));
}

/**
 * The crop window needed to go from a source's native resolution to an
 * output aspect ratio: keep full height and narrow the width when the
 * source is relatively wider than the output, keep full width and shorten
 * the height when it's relatively taller. Matching aspects need no crop.
 */
export function cropWindow(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): { width: number; height: number; axis: 'x' | 'y' | 'none' } {
  const srcAspect = srcW / srcH;
  const outAspect = outW / outH;
  if (Math.abs(srcAspect - outAspect) < 1e-6) return { width: srcW, height: srcH, axis: 'none' };
  if (srcAspect > outAspect) {
    const width = Math.min(srcW, Math.round((srcH * outAspect) / 2) * 2);
    return { width, height: srcH, axis: 'x' };
  }
  const height = Math.min(srcH, Math.round(srcW / outAspect / 2) * 2);
  return { width: srcW, height, axis: 'y' };
}

/**
 * Convert a clip's 0..1 crop position into a pixel offset: 0 pins the
 * window to the start (left/top), 1 to the end (right/bottom), clamped to
 * whatever slack the source has left over after cropWindow.
 */
export function cropOffset(sourceDim: number, windowDim: number, pos: number | undefined): number {
  const slack = Math.max(0, sourceDim - windowDim);
  const p = Math.max(0, Math.min(1, pos ?? 0.5));
  return Math.round(slack * p);
}

/** Full crop geometry for one clip, or null when its source already matches the output aspect. */
export function cropGeometry(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  crop: { x?: number; y?: number } | undefined,
): { width: number; height: number; x: number; y: number } | null {
  const win = cropWindow(srcW, srcH, outW, outH);
  if (win.axis === 'none') return null;
  const x = win.axis === 'x' ? cropOffset(srcW, win.width, crop?.x) : 0;
  const y = win.axis === 'y' ? cropOffset(srcH, win.height, crop?.y) : 0;
  return { width: win.width, height: win.height, x, y };
}

/** Set output resolution and apply the same focus position to every clip's crop. */
export function applyReframe(m: Manifest, output: { width: number; height: number }, focus: number): Manifest {
  return {
    ...m,
    output,
    timeline: { ...m.timeline, video: m.timeline.video.map((c) => ({ ...c, crop: { x: focus, y: focus } })) },
  };
}

// ---- background music ----

const GAIN_MIN = -60;
const GAIN_MAX = 12;

function assertGain(g: number, label: string): void {
  if (!Number.isFinite(g) || g < GAIN_MIN || g > GAIN_MAX) {
    throw new Error(`${label}: gain (${g}) must be a finite number between ${GAIN_MIN} and ${GAIN_MAX} dB`);
  }
}
function assertNonNegative(v: number, label: string, name: string): void {
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`${label}: ${name} (${v}) must be a finite number >= 0`);
  }
}

/**
 * Add a background-music item to the timeline. Purely a manifest edit — the
 * caller (daemon) resolves the file's duration via ffprobe beforehand and
 * passes the already-decided `duration` (defaulting it to "shorter of the
 * source's remaining length and the timeline's remaining length" is the
 * caller's job, since that needs I/O this function must stay free of).
 */
export function addMusic(
  m: Manifest,
  path: string,
  opts: {
    tlStart?: number;
    duration: number;
    srcIn?: number;
    gain?: number;
    fadeIn?: number;
    fadeOut?: number;
    duck?: boolean;
    id?: string;
  },
): Manifest {
  const tlStart = opts.tlStart ?? 0;
  const srcIn = opts.srcIn ?? 0;
  const gain = opts.gain ?? -12;
  const fadeIn = opts.fadeIn ?? 1;
  const fadeOut = opts.fadeOut ?? 2;
  const duck = opts.duck ?? true;
  const duration = opts.duration;
  assertNonNegative(tlStart, 'music-add', 'at');
  assertNonNegative(srcIn, 'music-add', 'src-in');
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`music-add: duration (${duration}) must be a finite number > 0`);
  }
  assertGain(gain, 'music-add');
  assertNonNegative(fadeIn, 'music-add', 'fade-in');
  assertNonNegative(fadeOut, 'music-add', 'fade-out');
  const music = m.timeline.music ?? [];
  const id = opts.id ?? freshId('mu');
  if (music.some((x) => x.id === id)) throw new Error(`music-add: id already exists: ${id}`);
  const item: MusicItem = { id, path, tlStart, duration, srcIn, gain, fadeIn, fadeOut, duck };
  return { ...m, timeline: { ...m.timeline, music: [...music, item] } };
}

/** Patch an existing music item's placement/mix fields (never its path). */
export function updateMusic(
  m: Manifest,
  id: string,
  patch: {
    tlStart?: number;
    duration?: number;
    srcIn?: number;
    gain?: number;
    fadeIn?: number;
    fadeOut?: number;
    duck?: boolean;
  },
): Manifest {
  const music = m.timeline.music ?? [];
  const idx = music.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`unknown music item: ${id}`);
  const cur = music[idx];
  const next: MusicItem = { ...cur };
  if (patch.tlStart !== undefined) {
    assertNonNegative(patch.tlStart, 'music-update', 'at');
    next.tlStart = patch.tlStart;
  }
  if (patch.srcIn !== undefined) {
    assertNonNegative(patch.srcIn, 'music-update', 'src-in');
    next.srcIn = patch.srcIn;
  }
  if (patch.duration !== undefined) {
    if (!Number.isFinite(patch.duration) || patch.duration <= 0) {
      throw new Error(`music-update: duration (${patch.duration}) must be a finite number > 0`);
    }
    next.duration = patch.duration;
  }
  if (patch.gain !== undefined) {
    assertGain(patch.gain, 'music-update');
    next.gain = patch.gain;
  }
  if (patch.fadeIn !== undefined) {
    assertNonNegative(patch.fadeIn, 'music-update', 'fade-in');
    next.fadeIn = patch.fadeIn;
  }
  if (patch.fadeOut !== undefined) {
    assertNonNegative(patch.fadeOut, 'music-update', 'fade-out');
    next.fadeOut = patch.fadeOut;
  }
  if (patch.duck !== undefined) next.duck = Boolean(patch.duck);
  const out = [...music];
  out[idx] = next;
  return { ...m, timeline: { ...m.timeline, music: out } };
}

/** Remove a music item from the timeline. */
export function removeMusic(m: Manifest, id: string): Manifest {
  const music = m.timeline.music ?? [];
  const next = music.filter((x) => x.id !== id);
  if (next.length === music.length) throw new Error(`unknown music item: ${id}`);
  return { ...m, timeline: { ...m.timeline, music: next } };
}

/** Patch the final-render audio mastering settings. */
export function setAudioMix(m: Manifest, patch: { targetLufs?: number; duckAmount?: number; crossfadeMs?: number }): Manifest {
  const next = { ...(m.audioMix ?? {}) };
  if (patch.targetLufs !== undefined) {
    if (!Number.isFinite(patch.targetLufs) || patch.targetLufs < -40 || patch.targetLufs > -5) {
      throw new Error(`audio-mix: targetLufs (${patch.targetLufs}) must be a finite number between -40 and -5`);
    }
    next.targetLufs = patch.targetLufs;
  }
  if (patch.duckAmount !== undefined) {
    if (!Number.isFinite(patch.duckAmount) || patch.duckAmount < -40 || patch.duckAmount > 0) {
      throw new Error(`audio-mix: duckAmount (${patch.duckAmount}) must be a finite number between -40 and 0 dB`);
    }
    next.duckAmount = patch.duckAmount;
  }
  if (patch.crossfadeMs !== undefined) {
    if (!Number.isFinite(patch.crossfadeMs) || patch.crossfadeMs < 0 || patch.crossfadeMs > 1000) {
      throw new Error(`audio-mix: crossfadeMs (${patch.crossfadeMs}) must be a finite number between 0 and 1000`);
    }
    next.crossfadeMs = patch.crossfadeMs;
  }
  return { ...m, audioMix: next };
}

// ---- conversational-audio repair (manifest.audioRepair) ----

const AUDIO_REPAIR_PRESETS = new Set(['outdoor', 'indoor', 'wireless', 'off']);

/** Patch the conversational-audio repair setting (manifest.audioRepair). */
export function setAudioRepair(m: Manifest, patch: { preset: string; deess?: boolean }): Manifest {
  if (!AUDIO_REPAIR_PRESETS.has(patch.preset)) {
    throw new Error(`audio-repair: preset (${JSON.stringify(patch.preset)}) must be one of outdoor/indoor/wireless/off`);
  }
  const next: NonNullable<Manifest['audioRepair']> = { preset: patch.preset as 'outdoor' | 'indoor' | 'wireless' | 'off' };
  if (patch.deess !== undefined) next.deess = Boolean(patch.deess);
  return { ...m, audioRepair: next };
}

// ---- color metadata (Log/HLG detection) ----

/** Surfaced verbatim on sources flagged by `needsColorTransform`. */
export const COLOR_WARNING_MESSAGE = 'Log/HLG素材 — 入力変換は未実装(W5)。プレビュー・レンダーの色が浅く見えます';

/**
 * Whether a source's captured color metadata implies Log/HLG/PQ material
 * that the (RGB/SDR-only) pipeline doesn't transform — the picture will
 * preview/render looking flat/washed out. A transfer curve outside the
 * known-SDR set (bt709/srgb) is a direct signal (HLG=arib-std-b67,
 * PQ=smpte2084, or an explicit log curve). Many cameras' log profiles
 * (e.g. DJI D-Log) don't tag a transfer curve at all, so an untagged/
 * "unknown" transfer paired with bt2020 primaries is treated as the same
 * signal. Missing color metadata entirely is NOT flagged — absence of
 * information isn't evidence of a problem.
 */
export function needsColorTransform(color: Source['color']): boolean {
  if (!color) return false;
  const transfer = color.transfer;
  const KNOWN_SDR_TRANSFERS = new Set(['bt709', 'srgb']);
  if (transfer && transfer !== 'unknown' && !KNOWN_SDR_TRANSFERS.has(transfer)) return true;
  if ((!transfer || transfer === 'unknown') && color.primaries === 'bt2020') return true;
  return false;
}

// ---- input color transform (W5: HLG/PQ/LUT -> Rec.709 SDR) ----

const COLOR_TRANSFORM_TYPES = new Set(['hlg', 'pq', 'lut', 'none']);

/**
 * Patch a source's input color transform (`Source.colorTransform`).
 * Validates the source exists, the type is one of hlg/pq/lut/none, and a
 * 'lut' type carries a non-empty path — but does NOT check the path exists
 * on disk, since ops.ts is pure/I/O-free; that check (and resolving a
 * relative path to absolute) is the daemon's job, same division of labor as
 * music-add's probeAudio check happening in daemon.ts before this is called.
 */
export function setColorTransform(m: Manifest, sourceId: string, patch: { type: string; lut?: string }): Manifest {
  if (!m.sources.some((s) => s.id === sourceId)) throw new Error(`unknown source: ${sourceId}`);
  if (!COLOR_TRANSFORM_TYPES.has(patch.type)) {
    throw new Error(`color: type (${JSON.stringify(patch.type)}) must be one of hlg/pq/lut/none`);
  }
  if (patch.type === 'lut' && !patch.lut) {
    throw new Error('color: --lut <path> is required when type is "lut"');
  }
  const colorTransform: NonNullable<Source['colorTransform']> = { type: patch.type as 'hlg' | 'pq' | 'lut' | 'none' };
  if (patch.type === 'lut') colorTransform.lut = patch.lut;
  return { ...m, sources: m.sources.map((s) => (s.id === sourceId ? { ...s, colorTransform } : s)) };
}

// ---- per-source color adjust (W5: exposure/WB/saturation; render+preview only) ----

function assertColorRange(v: number, name: string, min: number, max: number): void {
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`color-adjust: ${name} (${v}) must be a finite number between ${min} and ${max}`);
  }
}

/**
 * Patch (merge) a source's `manifest.colorAdjust[sourceId]` entry. Fields
 * omitted from `patch` leave the existing value alone (same merge contract
 * as updateMusic), and a resulting per-source entry with no defined fields
 * at all is pruned back out of the map — same pattern as setSceneReview's
 * culling map (the top-level `colorAdjust` object itself is left as `{}`
 * rather than deleted, also matching that precedent).
 */
export function setColorAdjust(m: Manifest, sourceId: string, patch: { exposure?: number; wb?: number; sat?: number }): Manifest {
  if (!m.sources.some((s) => s.id === sourceId)) throw new Error(`unknown source: ${sourceId}`);
  if (patch.exposure !== undefined) assertColorRange(patch.exposure, 'exposure', -2, 2);
  if (patch.wb !== undefined) assertColorRange(patch.wb, 'wb', -100, 100);
  if (patch.sat !== undefined) assertColorRange(patch.sat, 'sat', 0, 2);
  const colorAdjust = { ...(m.colorAdjust ?? {}) };
  const cur = { ...(colorAdjust[sourceId] ?? {}) };
  if (patch.exposure !== undefined) cur.exposure = patch.exposure;
  if (patch.wb !== undefined) cur.wb = patch.wb;
  if (patch.sat !== undefined) cur.sat = patch.sat;
  if (Object.keys(cur).length === 0) delete colorAdjust[sourceId];
  else colorAdjust[sourceId] = cur;
  return { ...m, colorAdjust };
}

/** Adjust one clip's crop position without touching the others. */
export function setClipCrop(m: Manifest, clipId: string, patch: { x?: number; y?: number }): Manifest {
  if (!m.timeline.video.some((c) => c.id === clipId)) throw new Error(`unknown clip: ${clipId}`);
  for (const [axis, v] of [['x', patch.x], ['y', patch.y]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 1)) {
      throw new Error(`clip-crop: ${axis} (${v}) must be a finite number between 0 and 1`);
    }
  }
  // Drop explicit-undefined keys (e.g. a caller building `{ x: b.x, y: b.y }`
  // from a partial request body) before merging, so an omitted axis leaves
  // the existing value alone instead of getting clobbered by `undefined`.
  const clean = { ...(patch.x !== undefined ? { x: patch.x } : {}), ...(patch.y !== undefined ? { y: patch.y } : {}) };
  return {
    ...m,
    timeline: {
      ...m.timeline,
      video: m.timeline.video.map((c) => (c.id === clipId ? { ...c, crop: { ...c.crop, ...clean } } : c)),
    },
  };
}

// ---- scene culling (3-state review: unreviewed / keep / reject) ----

/**
 * Set (or clear) a scene's review verdict on the manifest. Purely a
 * manifest edit — it doesn't check that `sceneId` actually exists in the
 * source's scene index (this function has no access to it); the daemon
 * validates that against the real scenes-<sourceId>.json before calling in,
 * same division of labor as motion-update validating against the timeline
 * before touching the sidecar. Empty per-source/per-manifest maps are
 * pruned rather than left as `{}` so an all-cleared project's manifest
 * looks identical to one that was never culled.
 */
export function setSceneReview(m: Manifest, sourceId: string, sceneId: string, review: 'keep' | 'reject' | 'clear'): Manifest {
  if (!m.sources.some((s) => s.id === sourceId)) throw new Error(`unknown source: ${sourceId}`);
  if (review !== 'keep' && review !== 'reject' && review !== 'clear') {
    throw new Error(`invalid review: ${JSON.stringify(review)} (must be "keep", "reject", or "clear")`);
  }
  const culling = { ...(m.culling ?? {}) };
  const forSource = { ...(culling[sourceId] ?? {}) };
  if (review === 'clear') {
    delete forSource[sceneId];
  } else {
    forSource[sceneId] = review;
  }
  if (Object.keys(forSource).length === 0) delete culling[sourceId];
  else culling[sourceId] = forSource;
  return { ...m, culling };
}

/** Per-source and overall keep/reject/unreviewed tallies, for status reporting. */
export function cullingStats(
  m: Manifest,
  sceneFiles: SceneFile[],
): {
  perSource: { sourceId: string; total: number; keep: number; reject: number; unreviewed: number }[];
  totals: { total: number; keep: number; reject: number; unreviewed: number };
} {
  const perSource = sceneFiles.map((f) => {
    const forSource = m.culling?.[f.sourceId] ?? {};
    let keep = 0;
    let reject = 0;
    for (const sc of f.scenes) {
      const r = forSource[sc.id];
      if (r === 'keep') keep++;
      else if (r === 'reject') reject++;
    }
    const total = f.scenes.length;
    return { sourceId: f.sourceId, total, keep, reject, unreviewed: total - keep - reject };
  });
  const totals = perSource.reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      keep: acc.keep + s.keep,
      reject: acc.reject + s.reject,
      unreviewed: acc.unreviewed + s.unreviewed,
    }),
    { total: 0, keep: 0, reject: 0, unreviewed: 0 },
  );
  return { perSource, totals };
}

/**
 * Build a replacement video[] from every scene marked 'keep', in detection
 * order (source order as given, then scene order within each source — the
 * scenes files are already t0-sorted by detectScenesForSource). This does
 * NOT touch `m.timeline.video` — it's the caller's job to decide whether to
 * apply the replacement (the daemon's 'selects' op, after the CLI/UI has
 * shown a confirm-before-replace preview).
 */
export function buildSelectsTimeline(m: Manifest, sceneFiles: SceneFile[]): VideoClip[] {
  const out: VideoClip[] = [];
  for (const f of sceneFiles) {
    const forSource = m.culling?.[f.sourceId] ?? {};
    for (const sc of f.scenes) {
      if (forSource[sc.id] !== 'keep') continue;
      out.push({ id: freshId('c'), sourceId: f.sourceId, srcIn: sc.t0, srcOut: sc.t1 });
    }
  }
  return out;
}

// ---- B-roll V2 overlay track (W3) ----
//
// Anchor rule (see OverlayClip in types.ts): an overlay stores WHERE it's
// glued to the A-roll (anchor.sourceId + anchor.srcTime), never a timeline
// position. Every consumer (render/preview/OTIO/web) re-derives tlStart via
// sourceTimeToTimeline on demand through resolveOverlays/resolvedActiveOverlays
// below — there is no cached/absolute tlStart anywhere in the manifest, so a
// ripple edit to the A-roll can never leave a stale overlay position behind.

const OVERLAY_AUDIO_MODES = new Set(['mute', 'mix', 'replace']);

/** Default gainDb applied when an overlay's audioMode is 'mix'/'replace' and gainDb is omitted; render.ts's OVERLAY_GAIN_DEFAULT mirrors this. */
export const OVERLAY_GAIN_DEFAULT = -18;

/**
 * Resolve every overlay's current timeline placement. `tlStart` is null when
 * the anchored instant has been cut away from the A-roll (an "orphan") —
 * callers that need to render/preview/export must filter those out (see
 * resolvedActiveOverlays), while callers surfacing status/warnings want the
 * full list including orphans (see orphanedOverlays).
 */
export function resolveOverlays(m: Manifest): { overlay: OverlayClip; tlStart: number | null }[] {
  return (m.timeline.overlays ?? []).map((overlay) => ({
    overlay,
    tlStart: sourceTimeToTimeline(m, overlay.anchor.sourceId, overlay.anchor.srcTime),
  }));
}

export interface ResolvedOverlay {
  overlay: OverlayClip;
  tlStart: number;
  tlEnd: number;
}

/**
 * Non-orphan overlays with a resolved [tlStart, tlEnd) timeline placement,
 * sorted by tlStart — the only overlays render/view/OTIO ever touch. Orphans
 * (anchor cut away) are silently excluded here; see orphanedOverlays for the
 * warning-surface list.
 */
export function resolvedActiveOverlays(m: Manifest): ResolvedOverlay[] {
  const out: ResolvedOverlay[] = [];
  for (const r of resolveOverlays(m)) {
    if (r.tlStart === null) continue;
    out.push({ overlay: r.overlay, tlStart: r.tlStart, tlEnd: r.tlStart + (r.overlay.srcOut - r.overlay.srcIn) });
  }
  out.sort((a, b) => a.tlStart - b.tlStart);
  return out;
}

/** Overlays whose anchored instant is no longer on the timeline, for status/resume warnings. */
export function orphanedOverlays(m: Manifest): { id: string; reason: string }[] {
  return resolveOverlays(m)
    .filter((r) => r.tlStart === null)
    .map((r) => ({
      id: r.overlay.id,
      reason: `anchor (${r.overlay.anchor.sourceId}@${r.overlay.anchor.srcTime.toFixed(2)}s) is not on the timeline (cut away)`,
    }));
}

/** [tlStart, tlEnd) for one overlay if it currently resolves, else null (orphan — nothing to collide with). */
function resolvedOverlayRange(m: Manifest, o: OverlayClip): { tlStart: number; tlEnd: number } | null {
  const tlStart = sourceTimeToTimeline(m, o.anchor.sourceId, o.anchor.srcTime);
  if (tlStart === null) return null;
  return { tlStart, tlEnd: tlStart + (o.srcOut - o.srcIn) };
}

/**
 * V2 is a single non-overlapping layer: reject an add/update whose RESOLVED
 * region collides with another overlay's resolved region. An orphan
 * candidate (unresolvable) has nothing to collide with and is always
 * allowed through — it just won't render/preview/export until re-anchored.
 */
function assertNoOverlayOverlap(m: Manifest, candidate: OverlayClip, excludeId?: string): void {
  const range = resolvedOverlayRange(m, candidate);
  if (!range) return;
  for (const o of m.timeline.overlays ?? []) {
    if (o.id === excludeId) continue;
    const other = resolvedOverlayRange(m, o);
    if (!other) continue;
    if (range.tlStart < other.tlEnd && other.tlStart < range.tlEnd) {
      throw new Error(
        `broll: overlaps existing overlay ${o.id} (${other.tlStart.toFixed(2)}-${other.tlEnd.toFixed(2)}s); the B-roll V2 track allows no overlap`,
      );
    }
  }
}

/** Add a B-roll overlay clip, anchored to an A-roll moment (see OverlayClip). Validates finiteness, srcIn<srcOut, both sources exist, and no overlap with an existing overlay's resolved region. */
export function addOverlay(
  m: Manifest,
  sourceId: string,
  opts: {
    srcIn: number;
    srcOut: number;
    anchor: { sourceId: string; srcTime: number };
    audioMode?: 'mute' | 'mix' | 'replace';
    gainDb?: number;
    id?: string;
  },
): Manifest {
  const src = m.sources.find((s) => s.id === sourceId);
  if (!src) throw new Error(`broll-add: unknown B-roll source: ${sourceId}`);
  if (!opts.anchor || !m.sources.some((s) => s.id === opts.anchor.sourceId)) {
    throw new Error(`broll-add: unknown anchor source: ${opts.anchor?.sourceId}`);
  }
  const { srcIn, srcOut } = opts;
  if (!Number.isFinite(srcIn) || !Number.isFinite(srcOut)) {
    throw new Error(`broll-add: in/out must be finite numbers (got in=${srcIn}, out=${srcOut})`);
  }
  if (srcIn < 0) throw new Error(`broll-add: in (${srcIn}) must be >= 0`);
  if (srcOut <= srcIn) throw new Error(`broll-add: out (${srcOut}) must be greater than in (${srcIn})`);
  if (srcOut > src.duration) throw new Error(`broll-add: out (${srcOut}) exceeds source duration (${src.duration})`);
  if (!Number.isFinite(opts.anchor.srcTime) || opts.anchor.srcTime < 0) {
    throw new Error(`broll-add: anchor srcTime (${opts.anchor.srcTime}) must be a finite number >= 0`);
  }
  const audioMode = opts.audioMode ?? 'mute';
  if (!OVERLAY_AUDIO_MODES.has(audioMode)) {
    throw new Error(`broll-add: audioMode (${JSON.stringify(audioMode)}) must be "mute", "mix", or "replace"`);
  }
  if (opts.gainDb !== undefined) assertGain(opts.gainDb, 'broll-add');
  const overlays = m.timeline.overlays ?? [];
  const id = opts.id ?? freshId('ov');
  if (overlays.some((o) => o.id === id)) throw new Error(`broll-add: overlay id already exists: ${id}`);
  const item: OverlayClip = {
    id,
    sourceId,
    srcIn,
    srcOut,
    anchor: { sourceId: opts.anchor.sourceId, srcTime: opts.anchor.srcTime },
    audioMode: audioMode as 'mute' | 'mix' | 'replace',
    ...(opts.gainDb !== undefined ? { gainDb: opts.gainDb } : {}),
  };
  assertNoOverlayOverlap(m, item);
  return { ...m, timeline: { ...m.timeline, overlays: [...overlays, item] } };
}

/** Patch an existing overlay's range/anchor/audio fields (never its B-roll sourceId). Re-anchoring (patch.anchor) is how a user fixes an orphaned overlay. */
export function updateOverlay(
  m: Manifest,
  id: string,
  patch: {
    srcIn?: number;
    srcOut?: number;
    anchor?: { sourceId: string; srcTime: number };
    audioMode?: 'mute' | 'mix' | 'replace';
    gainDb?: number;
  },
): Manifest {
  const overlays = m.timeline.overlays ?? [];
  const idx = overlays.findIndex((o) => o.id === id);
  if (idx < 0) throw new Error(`unknown overlay: ${id}`);
  const cur = overlays[idx];
  const src = m.sources.find((s) => s.id === cur.sourceId)!;
  const next: OverlayClip = { ...cur };
  if (patch.anchor !== undefined) {
    if (!m.sources.some((s) => s.id === patch.anchor!.sourceId)) {
      throw new Error(`broll-update: unknown anchor source: ${patch.anchor.sourceId}`);
    }
    if (!Number.isFinite(patch.anchor.srcTime) || patch.anchor.srcTime < 0) {
      throw new Error(`broll-update: anchor srcTime (${patch.anchor.srcTime}) must be a finite number >= 0`);
    }
    next.anchor = { sourceId: patch.anchor.sourceId, srcTime: patch.anchor.srcTime };
  }
  if (patch.srcIn !== undefined || patch.srcOut !== undefined) {
    const srcIn = patch.srcIn ?? cur.srcIn;
    const srcOut = patch.srcOut ?? cur.srcOut;
    if (!Number.isFinite(srcIn) || !Number.isFinite(srcOut)) {
      throw new Error(`broll-update: in/out must be finite numbers (got in=${srcIn}, out=${srcOut})`);
    }
    if (srcIn < 0) throw new Error(`broll-update: in (${srcIn}) must be >= 0`);
    if (srcOut <= srcIn) throw new Error(`broll-update: out (${srcOut}) must be greater than in (${srcIn})`);
    if (srcOut > src.duration) throw new Error(`broll-update: out (${srcOut}) exceeds source duration (${src.duration})`);
    next.srcIn = srcIn;
    next.srcOut = srcOut;
  }
  if (patch.audioMode !== undefined) {
    if (!OVERLAY_AUDIO_MODES.has(patch.audioMode)) {
      throw new Error(`broll-update: audioMode (${JSON.stringify(patch.audioMode)}) must be "mute", "mix", or "replace"`);
    }
    next.audioMode = patch.audioMode;
  }
  if (patch.gainDb !== undefined) {
    assertGain(patch.gainDb, 'broll-update');
    next.gainDb = patch.gainDb;
  }
  assertNoOverlayOverlap(m, next, id);
  const out = [...overlays];
  out[idx] = next;
  return { ...m, timeline: { ...m.timeline, overlays: out } };
}

/** Remove an overlay from the V2 track. */
export function removeOverlay(m: Manifest, id: string): Manifest {
  const overlays = m.timeline.overlays ?? [];
  const next = overlays.filter((o) => o.id !== id);
  if (next.length === overlays.length) throw new Error(`unknown overlay: ${id}`);
  return { ...m, timeline: { ...m.timeline, overlays: next } };
}
