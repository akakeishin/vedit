import type {
  BackgroundRef,
  DialogueItem,
  IntentZoneItem,
  Manifest,
  MusicItem,
  OverlayClip,
  SceneFile,
  Segment,
  Source,
  SpriteItem,
  SpriteLoopName,
  SpriteMotionName,
  VideoClip,
  Word,
} from './types.js';

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

/**
 * Timeline length in seconds. For a W-ANIME composition project (no video
 * clips at all — see Manifest.composition), this is the composition's
 * declared duration directly rather than a segments() sum (which would
 * always be 0, since compositions never populate `timeline.video`); every
 * normal (source-driven) project is completely unaffected — full
 * regression — since `m.composition` is unset for those.
 */
export function timelineDuration(m: Manifest): number {
  if (m.composition) return m.composition.duration;
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

/**
 * W-ANIME sentinel `sourceId` recognized by sprite/dialogue anchors in a
 * composition project (see Manifest.composition): under this id,
 * `anchor.srcTime` IS the absolute timeline time directly — a composition
 * has no A-roll source to anchor into, so there is nothing to "resolve".
 * Only ever meaningful when `m.composition` is set (see
 * sourceTimeToTimeline below and addSprite/updateSprite's anchor
 * validation); a normal project's real source ids (freshId() output) never
 * collide with this literal string, so this is purely additive — no normal
 * project's anchor resolution changes at all.
 */
export const COMP_SOURCE_ID = '__comp__';

/** Map a source time to timeline time, or null if cut away. */
export function sourceTimeToTimeline(m: Manifest, sourceId: string, t: number): number | null {
  if (m.composition && sourceId === COMP_SOURCE_ID) {
    return t >= 0 && t <= m.composition.duration ? t : null;
  }
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
    /** Display/reporting tag (see MusicItem.role) — persisted only when given, so pre-existing callers/items are byte-for-byte unchanged. */
    role?: 'bgm' | 'sfx';
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
  // Runtime guard (not just TS): the future daemon wiring passes b.role from
  // the request body verbatim.
  if (opts.role !== undefined && opts.role !== 'bgm' && opts.role !== 'sfx') {
    throw new Error(`music-add: role (${JSON.stringify(opts.role)}) must be "bgm" or "sfx"`);
  }
  const music = m.timeline.music ?? [];
  const id = opts.id ?? freshId('mu');
  if (music.some((x) => x.id === id)) throw new Error(`music-add: id already exists: ${id}`);
  const item: MusicItem = { id, path, tlStart, duration, srcIn, gain, fadeIn, fadeOut, duck, ...(opts.role ? { role: opts.role } : {}) };
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

/** Non-enumerable summary counters attached to buildSelectsTimeline's return value (see below). */
export interface SelectsBuildSummary {
  /** Scenes marked 'keep' across every source (== the scenes actually considered). */
  keepScenes: number;
  /** Total output clips. */
  clips: number;
  /** Keep-scenes whose range overlapped the current timeline — their existing in-scene edits (e.g. remove-words) were preserved rather than reset to the raw scene bounds. */
  preservedScenes: number;
  /** Keep-scenes with no overlap in the current timeline — newly promoted to keep, so the raw scene range was used as-is. */
  newScenes: number;
  /** Whether opts.raw was set (old scene-bounds-only behavior; preservedScenes/newScenes don't apply). */
  raw: boolean;
}

/** buildSelectsTimeline's return value: a plain VideoClip[] (so existing array-typed call sites keep working unchanged) with a non-enumerable `.summary` for richer CLI/daemon reporting — invisible to JSON.stringify/toEqual, so it never leaks into the persisted manifest or breaks array equality checks. */
export type SelectsBuildResult = VideoClip[] & { summary: SelectsBuildSummary };

/**
 * Build a replacement video[] from every scene marked 'keep', in detection
 * order (source order as given, then scene order within each source — the
 * scenes files are already t0-sorted by detectScenesForSource). This does
 * NOT touch `m.timeline.video` — it's the caller's job to decide whether to
 * apply the replacement (the daemon's 'selects' op, after the CLI/UI has
 * shown a confirm-before-replace preview).
 *
 * Default behavior (opts?.raw falsy) preserves in-scene micro-edits that
 * were already applied to the current timeline (e.g. remove-words cutting a
 * filler out of the middle of a kept scene): for each keep scene's source
 * range R, let U be the union of the current timeline's clip ranges for
 * that same source. If R ∩ U is non-empty, each connected component of
 * R ∩ U becomes its own output clip — so a word-level cut inside the scene
 * survives as a gap between two clips instead of being silently reverted
 * to the scene's raw t0/t1. If R ∩ U is empty (the scene has no presence
 * on the timeline at all — e.g. it was just newly marked 'keep'), the raw
 * scene range is used as-is: there's nothing to preserve, and the new
 * keep verdict should win outright.
 *
 * opts.raw restores the old behavior (every keep scene emitted as its raw
 * [t0,t1), unconditionally replacing whatever was already on the timeline).
 */
export function buildSelectsTimeline(m: Manifest, sceneFiles: SceneFile[], opts?: { raw?: boolean }): SelectsBuildResult {
  const raw = opts?.raw ?? false;
  const EPS = 1e-6;

  // Union of existing timeline ranges per source, merged into disjoint,
  // time-sorted intervals — only computed when needed (raw mode skips it
  // entirely, since nothing is preserved).
  const unionBySource = new Map<string, { t0: number; t1: number }[]>();
  if (!raw) {
    for (const c of m.timeline.video) {
      if (c.srcOut - c.srcIn <= EPS) continue;
      const list = unionBySource.get(c.sourceId) ?? [];
      list.push({ t0: c.srcIn, t1: c.srcOut });
      unionBySource.set(c.sourceId, list);
    }
    for (const [sourceId, ranges] of unionBySource) {
      ranges.sort((a, b) => a.t0 - b.t0);
      const merged: { t0: number; t1: number }[] = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r.t0 <= last.t1 + EPS) last.t1 = Math.max(last.t1, r.t1);
        else merged.push({ ...r });
      }
      unionBySource.set(sourceId, merged);
    }
  }

  const out: VideoClip[] = [];
  let keepScenes = 0;
  let preservedScenes = 0;
  let newScenes = 0;

  for (const f of sceneFiles) {
    const forSource = m.culling?.[f.sourceId] ?? {};
    const union = raw ? [] : (unionBySource.get(f.sourceId) ?? []);
    for (const sc of f.scenes) {
      if (forSource[sc.id] !== 'keep') continue;
      keepScenes++;

      if (raw) {
        if (sc.t1 - sc.t0 > EPS) {
          out.push({ id: freshId('c'), sourceId: f.sourceId, srcIn: sc.t0, srcOut: sc.t1 });
          newScenes++;
        }
        continue;
      }

      const components: { t0: number; t1: number }[] = [];
      for (const r of union) {
        const a = Math.max(sc.t0, r.t0);
        const b = Math.min(sc.t1, r.t1);
        if (b - a > EPS) components.push({ t0: a, t1: b });
      }

      if (components.length === 0) {
        // R ∩ U = ∅ — this scene has no presence on the timeline yet
        // (freshly promoted to keep). Nothing to preserve; use it whole.
        if (sc.t1 - sc.t0 > EPS) {
          out.push({ id: freshId('c'), sourceId: f.sourceId, srcIn: sc.t0, srcOut: sc.t1 });
          newScenes++;
        }
      } else {
        // R ∩ U ≠ ∅ — reuse the existing connected components so any
        // in-scene micro-edit (e.g. a removed filler word) stays cut.
        components.sort((a, b) => a.t0 - b.t0);
        for (const comp of components) {
          out.push({ id: freshId('c'), sourceId: f.sourceId, srcIn: comp.t0, srcOut: comp.t1 });
        }
        preservedScenes++;
      }
    }
  }

  const result = out as SelectsBuildResult;
  Object.defineProperty(result, 'summary', {
    value: { keepScenes, clips: out.length, preservedScenes, newScenes, raw } satisfies SelectsBuildSummary,
    enumerable: false,
    configurable: true,
  });
  return result;
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

// ---- sprite overlays (W8 kit) ----
//
// Character/prop sprites anchored to an A-roll moment via the SAME
// (sourceId, srcTime) contract as B-roll overlays above —
// resolveSprites/resolvedActiveSprites/orphanedSprites mirror
// resolveOverlays/resolvedActiveOverlays/orphanedOverlays exactly. Unlike
// the B-roll V2 track, sprites are NOT a single exclusive layer: multiple
// sprites may resolve to overlapping timeline ranges (more than one
// character on screen at once), so there is no overlap check here.
// `assetId` is validated by the caller (daemon.ts), not here — this module
// has no access to the linked kit's asset list, only Manifest.kit.path.

/** Resolve every sprite's current timeline placement; `tlStart` null = orphan (anchor cut away). */
export function resolveSprites(m: Manifest): { sprite: SpriteItem; tlStart: number | null }[] {
  return (m.timeline.sprites ?? []).map((sprite) => ({
    sprite,
    tlStart: sourceTimeToTimeline(m, sprite.anchor.sourceId, sprite.anchor.srcTime),
  }));
}

export interface ResolvedSprite {
  sprite: SpriteItem;
  tlStart: number;
  tlEnd: number;
}

/**
 * Non-orphan sprites with a resolved [tlStart, tlEnd) placement, in MANIFEST
 * ARRAY ORDER — what render/view/OTIO/web actually touch. Array order IS the
 * z-order contract: a later `timeline.sprites` entry composites on top of an
 * earlier one wherever they overlap. The web preview always drew in array
 * order (later DOM node = on top); render.ts overlays in this function's
 * iteration order — it used to re-sort by tlStart here, which made the final
 * render stack overlapping sprites differently from the preview whenever
 * they were added out of time order. Do NOT re-add a time sort: no consumer
 * needs one (view/otio/publish are order-insensitive), and it would
 * reintroduce that preview/render mismatch.
 */
export function resolvedActiveSprites(m: Manifest): ResolvedSprite[] {
  const out: ResolvedSprite[] = [];
  for (const r of resolveSprites(m)) {
    if (r.tlStart === null) continue;
    out.push({ sprite: r.sprite, tlStart: r.tlStart, tlEnd: r.tlStart + r.sprite.duration });
  }
  return out;
}

/** Sprites whose anchored instant is no longer on the timeline, for status/resume warnings. */
export function orphanedSprites(m: Manifest): { id: string; reason: string }[] {
  return resolveSprites(m)
    .filter((r) => r.tlStart === null)
    .map((r) => ({
      id: r.sprite.id,
      reason: `anchor (${r.sprite.anchor.sourceId}@${r.sprite.anchor.srcTime.toFixed(2)}s) is not on the timeline (cut away)`,
    }));
}

function assertUnit(v: number, label: string, name: string): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${label}: ${name} (${v}) must be a finite number between 0 and 1`);
  }
}

/**
 * Whether `sourceId` is a valid sprite/dialogue anchor source: a real
 * ingested source, OR (W-ANIME) the COMP_SOURCE_ID sentinel when the
 * project is a composition — see sourceTimeToTimeline's doc. A normal
 * project has no `m.composition`, so the sentinel branch never activates
 * for it; full regression.
 */
function isKnownAnchorSource(m: Manifest, sourceId: string): boolean {
  if (m.composition && sourceId === COMP_SOURCE_ID) return true;
  return m.sources.some((s) => s.id === sourceId);
}

const SPRITE_MOTION_NAMES = new Set<SpriteMotionName>(['slide-left', 'slide-right', 'hop-in', 'pop', 'fade']);
const SPRITE_LOOP_NAMES = new Set<SpriteLoopName>(['sway', 'bob', 'hop', 'breathe', 'none']);

/**
 * Validate a `SpriteItem.motion` patch (W-ANIME) — every field optional,
 * unrecognized enum values rejected, `emoteAt` entries shape-checked (NOT
 * that their `assetId` resolves in a linked kit — same "daemon validates
 * against the kit, ops.ts validates shape only" split as the sprite's own
 * top-level `assetId`, see the module doc above). Returns a normalized
 * copy, or `undefined` when `motion` itself is undefined or ends up with no
 * recognized fields set (so a `{}` patch never gets stored as clutter).
 */
function assertSpriteMotion(motion: SpriteItem['motion'] | undefined, label: string): SpriteItem['motion'] | undefined {
  if (motion === undefined) return undefined;
  if (typeof motion !== 'object' || motion === null || Array.isArray(motion)) {
    throw new Error(`${label}: motion must be an object`);
  }
  const out: NonNullable<SpriteItem['motion']> = {};
  if (motion.enter !== undefined) {
    if (!SPRITE_MOTION_NAMES.has(motion.enter)) {
      throw new Error(`${label}: motion.enter (${JSON.stringify(motion.enter)}) is not a recognized preset`);
    }
    out.enter = motion.enter;
  }
  if (motion.exit !== undefined) {
    if (!SPRITE_MOTION_NAMES.has(motion.exit)) {
      throw new Error(`${label}: motion.exit (${JSON.stringify(motion.exit)}) is not a recognized preset`);
    }
    out.exit = motion.exit;
  }
  if (motion.loop !== undefined) {
    if (!SPRITE_LOOP_NAMES.has(motion.loop)) {
      throw new Error(`${label}: motion.loop (${JSON.stringify(motion.loop)}) is not a recognized preset`);
    }
    out.loop = motion.loop;
  }
  if (motion.emoteAt !== undefined) {
    if (!Array.isArray(motion.emoteAt)) throw new Error(`${label}: motion.emoteAt must be an array`);
    out.emoteAt = motion.emoteAt.map((e, i) => {
      if (!e || typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t < 0) {
        throw new Error(`${label}: motion.emoteAt[${i}].t must be a finite number >= 0`);
      }
      if (typeof e.assetId !== 'string' || !e.assetId) {
        throw new Error(`${label}: motion.emoteAt[${i}].assetId is required`);
      }
      return { t: e.t, assetId: e.assetId };
    });
  }
  return Object.keys(out).length ? out : undefined;
}

/** Add a sprite, anchored to an A-roll moment (or, in a composition project, the COMP_SOURCE_ID sentinel — see isKnownAnchorSource). Validates finiteness, the anchor source exists, and 0..1 ranges — NOT that assetId exists in a kit (see module doc above). */
export function addSprite(
  m: Manifest,
  assetId: string,
  opts: {
    anchor: { sourceId: string; srcTime: number };
    duration?: number;
    position?: { x: number; y: number };
    scale?: number;
    opacity?: number;
    flip?: boolean;
    id?: string;
    motion?: SpriteItem['motion'];
  },
): Manifest {
  if (typeof assetId !== 'string' || !assetId) throw new Error('sprite-add: assetId is required');
  if (!opts.anchor || !isKnownAnchorSource(m, opts.anchor.sourceId)) {
    throw new Error(`sprite-add: unknown anchor source: ${opts.anchor?.sourceId}`);
  }
  if (!Number.isFinite(opts.anchor.srcTime) || opts.anchor.srcTime < 0) {
    throw new Error(`sprite-add: anchor srcTime (${opts.anchor.srcTime}) must be a finite number >= 0`);
  }
  const duration = opts.duration ?? 3;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`sprite-add: duration (${duration}) must be a finite number > 0`);
  }
  const position = opts.position ?? { x: 0.5, y: 0.9 };
  assertUnit(position.x, 'sprite-add', 'position.x');
  assertUnit(position.y, 'sprite-add', 'position.y');
  const scale = opts.scale ?? 0.3;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
    throw new Error(`sprite-add: scale (${scale}) must be a finite number between 0 (exclusive) and 1`);
  }
  const opacity = opts.opacity ?? 1;
  assertUnit(opacity, 'sprite-add', 'opacity');
  const sprites = m.timeline.sprites ?? [];
  const id = opts.id ?? freshId('sp');
  if (sprites.some((s) => s.id === id)) throw new Error(`sprite-add: sprite id already exists: ${id}`);
  const motion = assertSpriteMotion(opts.motion, 'sprite-add');
  const item: SpriteItem = {
    id,
    assetId,
    anchor: { sourceId: opts.anchor.sourceId, srcTime: opts.anchor.srcTime },
    duration,
    position,
    scale,
    opacity,
    ...(opts.flip ? { flip: true } : {}),
    ...(motion ? { motion } : {}),
  };
  return { ...m, timeline: { ...m.timeline, sprites: [...sprites, item] } };
}

/** Patch an existing sprite's placement/anchor fields (never its assetId — remove+re-add to swap character). */
export function updateSprite(
  m: Manifest,
  id: string,
  patch: {
    anchor?: { sourceId: string; srcTime: number };
    duration?: number;
    position?: { x: number; y: number };
    scale?: number;
    opacity?: number;
    flip?: boolean;
    motion?: SpriteItem['motion'] | null;
  },
): Manifest {
  const sprites = m.timeline.sprites ?? [];
  const idx = sprites.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error(`unknown sprite: ${id}`);
  const cur = sprites[idx];
  const next: SpriteItem = { ...cur };
  if (patch.anchor !== undefined) {
    if (!isKnownAnchorSource(m, patch.anchor!.sourceId)) {
      throw new Error(`sprite-update: unknown anchor source: ${patch.anchor.sourceId}`);
    }
    if (!Number.isFinite(patch.anchor.srcTime) || patch.anchor.srcTime < 0) {
      throw new Error(`sprite-update: anchor srcTime (${patch.anchor.srcTime}) must be a finite number >= 0`);
    }
    next.anchor = { sourceId: patch.anchor.sourceId, srcTime: patch.anchor.srcTime };
  }
  if (patch.duration !== undefined) {
    if (!Number.isFinite(patch.duration) || patch.duration <= 0) {
      throw new Error(`sprite-update: duration (${patch.duration}) must be a finite number > 0`);
    }
    next.duration = patch.duration;
  }
  if (patch.position !== undefined) {
    assertUnit(patch.position.x, 'sprite-update', 'position.x');
    assertUnit(patch.position.y, 'sprite-update', 'position.y');
    next.position = { x: patch.position.x, y: patch.position.y };
  }
  if (patch.scale !== undefined) {
    if (!Number.isFinite(patch.scale) || patch.scale <= 0 || patch.scale > 1) {
      throw new Error(`sprite-update: scale (${patch.scale}) must be a finite number between 0 (exclusive) and 1`);
    }
    next.scale = patch.scale;
  }
  if (patch.opacity !== undefined) {
    assertUnit(patch.opacity, 'sprite-update', 'opacity');
    next.opacity = patch.opacity;
  }
  if (patch.flip !== undefined) {
    if (patch.flip) next.flip = true;
    else delete next.flip;
  }
  if (patch.motion !== undefined) {
    if (patch.motion === null) {
      delete next.motion;
    } else {
      // Merge field-by-field onto the existing motion (same convention as
      // mergeCaptionOverrides in daemon.ts) — a patch that only sets `loop`
      // never wipes out an already-set `enter`/`exit`/`emoteAt`. Pass
      // `motion: null` to clear everything instead.
      const validated = assertSpriteMotion(patch.motion, 'sprite-update');
      const merged = { ...(cur.motion ?? {}), ...(validated ?? {}) };
      if (Object.keys(merged).length) next.motion = merged;
      else delete next.motion;
    }
  }
  const out = [...sprites];
  out[idx] = next;
  return { ...m, timeline: { ...m.timeline, sprites: out } };
}

/** Remove a sprite from the timeline. */
export function removeSprite(m: Manifest, id: string): Manifest {
  const sprites = m.timeline.sprites ?? [];
  const next = sprites.filter((s) => s.id !== id);
  if (next.length === sprites.length) throw new Error(`unknown sprite: ${id}`);
  return { ...m, timeline: { ...m.timeline, sprites: next } };
}

// ---- sprite placement geometry (pure; shared math for render/view/web — see spec §2) ----

export interface SpriteAssetGeometry {
  width?: number;
  height?: number;
  visible_bounds_normalized?: { x0: number; y0: number; x1: number; y1: number };
  ground_anchor_normalized?: { x: number; y: number };
}

export interface SpriteGeometryResult {
  /** Top-left corner + displayed size of the FULL (incl. any transparent padding) sprite image, in output pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the asset's ground_anchor_normalized point actually lands (== position * outputWH), for convenience. */
  anchorX: number;
  anchorY: number;
}

/**
 * Map a kit asset + placement (SpriteItem's position/scale/flip) onto output
 * pixels. `scale` is the displayed height of the asset's VISIBLE region
 * (visible_bounds_normalized) as a fraction of the output height — not the
 * full (possibly padded) image — so two assets with different amounts of
 * transparent padding around the character still read as "the same size" at
 * the same scale. `position` places the asset's ground_anchor_normalized
 * point (its "feet") at that 0..1 fraction of the output canvas. Missing
 * bounds/anchor (asset not yet `vedit kit-scan`ned) fall back to "whole
 * image is visible" / "anchor at bottom-center" so an unscanned asset still
 * places reasonably. Missing width/height (same reason) fall back to a
 * square (1:1) aspect ratio. `flip` mirrors the image horizontally, which
 * also mirrors where the anchor point falls within it.
 */
export function spriteGeometry(
  asset: SpriteAssetGeometry,
  position: { x: number; y: number },
  scale: number,
  outputWH: { width: number; height: number },
  opts: { flip?: boolean } = {},
): SpriteGeometryResult {
  const bounds = asset.visible_bounds_normalized ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const anchor = asset.ground_anchor_normalized ?? { x: 0.5, y: 1 };
  const aspect = asset.width && asset.height ? asset.width / asset.height : 1;
  const visibleHeightFrac = Math.max(1e-6, bounds.y1 - bounds.y0);
  const displayHeight = Math.max(0, scale) * outputWH.height;
  const fullHeight = displayHeight / visibleHeightFrac;
  const fullWidth = fullHeight * aspect;
  const anchorXFrac = opts.flip ? 1 - anchor.x : anchor.x;
  const anchorPxX = anchorXFrac * fullWidth;
  const anchorPxY = anchor.y * fullHeight;
  const anchorX = position.x * outputWH.width;
  const anchorY = position.y * outputWH.height;
  return { x: anchorX - anchorPxX, y: anchorY - anchorPxY, width: fullWidth, height: fullHeight, anchorX, anchorY };
}

// ---- sprite motion presets (W-ANIME "ゆる紙芝居" — see docs/superpowers/specs/2026-07-17-vedit-anime-design.md) ----
//
// Pure ffmpeg-expression builders: given a sprite's static SpriteGeometryResult
// (from spriteGeometry above) and its resolved [tlStart,tlEnd) window,
// spriteMotionPlan produces `overlay` x/y expressions (and, for the 'breathe'
// loop, `scale` w/h expressions) plus any `fade`-filter alpha-fade clauses —
// every value stays byte-for-byte the pre-W-ANIME static x/y when
// SpriteItem.motion is unset (full regression). render.ts splices these
// directly into the ffmpeg filtergraph; web/app.js's spriteMotionOffsetJS is
// a hand-kept-in-sync per-frame NUMERIC port of the same formulas (evaluated
// directly in JS every rendered frame, rather than as ffmpeg expression
// strings) — spec: "見た目近似で可" (only the TIMING, not pixel-identical
// curves between render and preview, is guaranteed to match).

/** Entrance/exit transition length, seconds. */
export const SPRITE_TRANSITION_SECONDS = 0.35;
/** emoteAt crossfade length, seconds (spec: "フェード 0.15s"). */
export const SPRITE_EMOTE_CROSSFADE_SECONDS = 0.15;
/** sway/bob loop amplitude in pixels — matches the spec's own ffmpeg example (`x='X + 8*sin(...)'`) literally. */
const SPRITE_LOOP_SWAY_PX = 8;
const SPRITE_LOOP_BOB_PX = 6;
const SPRITE_LOOP_HOP_PX = 10;
/** breathe scale-pulse amplitude as a 0..1 fraction; spec's stated default ("既定1.2%"). A per-kit-style override was left unwired — see the W-ANIME implementation report. */
export const SPRITE_BREATHE_AMPLITUDE = 0.012;

/** Format a number for splicing into an ffmpeg expression (fixed precision, no trailing noise). */
function fexpr(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(6);
}

/** `min(1,max(0,(t-t0)/d))` — a 0..1 ramp that's flat outside [t0,t0+d]. */
function rampExpr(t0: number, d: number): string {
  return `min(1,max(0,(t-${fexpr(t0)})/${fexpr(d)}))`;
}

interface MotionTerms {
  /** Additive x/y offset expression fragments (e.g. "+8*sin(...)"), or '' when the preset doesn't touch that axis. */
  dx: string;
  dy: string;
  /** ffmpeg `fade=...:alpha=1` clause (no brackets), or null when the preset has no alpha fade. */
  fade: string | null;
}

const NO_TERMS: MotionTerms = { dx: '', dy: '', fade: null };

/** Entrance-transition terms, active during [tlStart, tlStart+D). */
function enterTerms(name: SpriteMotionName | undefined, tlStart: number, geo: { width: number; height: number }): MotionTerms {
  if (!name) return NO_TERMS;
  const D = SPRITE_TRANSITION_SECONDS;
  const p = rampExpr(tlStart, D);
  const travelX = geo.width * 0.6;
  const travelY = geo.height * 0.5;
  const bounceY = geo.height * 0.05;
  switch (name) {
    case 'slide-left':
      // Starts displaced to the right of rest, settles as p->1 — reads as sliding LEFT into place.
      return { dx: `+${fexpr(travelX)}*(1-${p})`, dy: '', fade: null };
    case 'slide-right':
      return { dx: `-${fexpr(travelX)}*(1-${p})`, dy: '', fade: null };
    case 'hop-in':
      // Ease-out rise from below.
      return { dx: '', dy: `+${fexpr(travelY)}*(1-${p})*(1-${p})`, fade: null };
    case 'pop':
      return { dx: '', dy: `-${fexpr(bounceY)}*sin(PI*${p})`, fade: `fade=t=in:st=${fexpr(tlStart)}:d=${fexpr(D)}:alpha=1` };
    case 'fade':
      return { dx: '', dy: '', fade: `fade=t=in:st=${fexpr(tlStart)}:d=${fexpr(D)}:alpha=1` };
  }
}

/** Exit-transition terms, active during [tlEnd-D, tlEnd). */
function exitTerms(name: SpriteMotionName | undefined, tlEnd: number, geo: { width: number; height: number }): MotionTerms {
  if (!name) return NO_TERMS;
  const D = SPRITE_TRANSITION_SECONDS;
  const start = tlEnd - D;
  const p = rampExpr(start, D);
  const travelX = geo.width * 0.6;
  const travelY = geo.height * 0.5;
  const bounceY = geo.height * 0.05;
  switch (name) {
    case 'slide-left':
      return { dx: `-${fexpr(travelX)}*${p}`, dy: '', fade: null };
    case 'slide-right':
      return { dx: `+${fexpr(travelX)}*${p}`, dy: '', fade: null };
    case 'hop-in':
      return { dx: '', dy: `+${fexpr(travelY)}*${p}*${p}`, fade: null };
    case 'pop':
      return { dx: '', dy: `-${fexpr(bounceY)}*sin(PI*(1-${p}))`, fade: `fade=t=out:st=${fexpr(start)}:d=${fexpr(D)}:alpha=1` };
    case 'fade':
      return { dx: '', dy: '', fade: `fade=t=out:st=${fexpr(start)}:d=${fexpr(D)}:alpha=1` };
  }
}

/** Continuous idle-loop terms, active across the sprite's whole [tlStart,tlEnd) window ('breathe' is handled separately in spriteMotionPlan — it's scale-only, not a simple x/y offset). */
function loopTerms(loop: SpriteLoopName | undefined, tlStart: number): { dx: string; dy: string } {
  if (!loop || loop === 'none' || loop === 'breathe') return { dx: '', dy: '' };
  const lt = `(t-${fexpr(tlStart)})`;
  if (loop === 'sway') return { dx: `+${SPRITE_LOOP_SWAY_PX}*sin(2*PI*${lt}/3)`, dy: '' };
  if (loop === 'bob') return { dx: '', dy: `+${SPRITE_LOOP_BOB_PX}*sin(2*PI*${lt}/2.4)` };
  // hop: periodic upward bounce back to baseline.
  return { dx: '', dy: `-${SPRITE_LOOP_HOP_PX}*abs(sin(2*PI*${lt}/1))` };
}

export interface SpriteMotionExpr {
  /** ffmpeg `overlay` x expression (a plain number string when nothing touches x). */
  xExpr: string;
  yExpr: string;
  /** ffmpeg filter clause(s) (no brackets) to splice into the sprite's own per-frame chain, ahead of the overlay — alpha fades for pop/fade enter/exit. */
  fadeClauses: string[];
  /** Set only when `motion.loop === 'breathe'`: eval=frame `scale` width/height expressions replacing the static display size. */
  breathe?: { widthExpr: string; heightExpr: string };
}

/**
 * Build ffmpeg expressions for one sprite's motion (W-ANIME), given its
 * static placement (`geo`, from spriteGeometry) and resolved [tlStart,tlEnd)
 * window. `motion` undefined (or `{}`) returns a plan whose x/y are the
 * plain static geo.x/geo.y and no fade/breathe — byte-for-byte what a
 * pre-W-ANIME static overlay would use.
 */
export function spriteMotionPlan(
  motion: SpriteItem['motion'] | undefined,
  geo: { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number },
  tlStart: number,
  tlEnd: number,
): SpriteMotionExpr {
  const enter = enterTerms(motion?.enter, tlStart, geo);
  const exit = exitTerms(motion?.exit, tlEnd, geo);
  const loop = loopTerms(motion?.loop, tlStart);
  const dxTerms = [enter.dx, exit.dx, loop.dx].filter(Boolean).join('');
  const dyTerms = [enter.dy, exit.dy, loop.dy].filter(Boolean).join('');
  const fadeClauses = [enter.fade, exit.fade].filter((c): c is string => Boolean(c));

  if (motion?.loop === 'breathe') {
    const period = 2;
    const lt = `(t-${fexpr(tlStart)})`;
    const scaleExpr = `(1+${SPRITE_BREATHE_AMPLITUDE}*sin(2*PI*${lt}/${period}))`;
    const widthExpr = `${fexpr(geo.width)}*${scaleExpr}`;
    const heightExpr = `${fexpr(geo.height)}*${scaleExpr}`;
    // Keep the anchor point (the character's feet) fixed as it breathes:
    // recompute the top-left corner from the anchor's fixed fraction within
    // the sprite's own resting box, applied to the CURRENT (pulsing) size.
    const fracX = geo.width > 0 ? (geo.anchorX - geo.x) / geo.width : 0.5;
    const fracY = geo.height > 0 ? (geo.anchorY - geo.y) / geo.height : 1;
    return {
      xExpr: `${fexpr(geo.anchorX)}-${fexpr(fracX)}*(${widthExpr})${dxTerms}`,
      yExpr: `${fexpr(geo.anchorY)}-${fexpr(fracY)}*(${heightExpr})${dyTerms}`,
      fadeClauses,
      breathe: { widthExpr, heightExpr },
    };
  }

  return {
    xExpr: dxTerms ? `${fexpr(geo.x)}${dxTerms}` : fexpr(geo.x),
    yExpr: dyTerms ? `${fexpr(geo.y)}${dyTerms}` : fexpr(geo.y),
    fadeClauses,
  };
}

export interface EmoteWindow {
  /** Sprite-local seconds (0 = the sprite's own tlStart), NOT absolute timeline time. */
  t0: number;
  t1: number;
  assetId: string;
}

/**
 * Turn a sprite's `motion.emoteAt` list into non-overlapping, time-sorted
 * windows (W-ANIME "表情差分"): each entry is active from its own `t` until
 * either the next entry's `t` or the sprite's own `duration`, whichever
 * comes first. Entries at/after `duration` (or with a negative/non-finite
 * `t`) are dropped — nothing to show. Pure; render.ts/web/app.js both walk
 * this to know which extra asset layer to crossfade in during which
 * sprite-local window.
 */
export function emoteWindows(emoteAt: { t: number; assetId: string }[] | undefined, duration: number): EmoteWindow[] {
  const valid = (emoteAt ?? []).filter((e) => Number.isFinite(e.t) && e.t >= 0 && e.t < duration);
  const sorted = [...valid].sort((a, b) => a.t - b.t);
  const out: EmoteWindow[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t0 = sorted[i].t;
    const t1 = i + 1 < sorted.length ? Math.min(sorted[i + 1].t, duration) : duration;
    if (t1 - t0 < 1e-6) continue;
    out.push({ t0, t1, assetId: sorted[i].assetId });
  }
  return out;
}

// ---- composition (W-ANIME): source-less "sprite anime" production mode ----
//
// A composition project (Manifest.composition) has NO video sources/clips
// at all — `segments()`/`timeline.video` stay permanently empty, and every
// consumer that iterates them (buildFilterGraph, view.ts, otio.ts, qc.ts's
// segment-based checks) simply sees "nothing there" rather than needing a
// special case, EXCEPT timelineDuration/sourceTimeToTimeline above (which
// composition needs a real answer from) and the composition-specific
// mutators/resolvers below. render.ts's buildCompositionFilterGraph (a
// SEPARATE function from the normal buildFilterGraph — see its doc) is
// where the actual background/sprite/dialogue compositing happens.

const COMP_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function assertBackgroundRef(ref: BackgroundRef, label: string): void {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`${label}: background ref is required`);
  if (ref.type === 'color') {
    if (typeof ref.hex !== 'string' || !COMP_HEX_COLOR_RE.test(ref.hex)) {
      throw new Error(`${label}: invalid hex color: ${JSON.stringify((ref as { hex?: unknown }).hex)}`);
    }
  } else if (ref.type === 'asset') {
    if (typeof ref.assetId !== 'string' || !ref.assetId) throw new Error(`${label}: assetId is required`);
  } else if (ref.type === 'video') {
    if (typeof ref.path !== 'string' || !ref.path) throw new Error(`${label}: path is required`);
  } else {
    throw new Error(`${label}: background type must be "color", "asset", or "video" (got ${JSON.stringify((ref as { type?: unknown })?.type)})`);
  }
}

/**
 * `vedit compose <dir> --duration --size [--kit]`: initialize (or re-tune) a
 * project as a composition (see Manifest.composition's doc in types.ts).
 * Refuses a project that already has ingested sources/clips — composition
 * and normal A-roll editing are mutually exclusive modes on one project.
 * Calling this again on an already-composed (still source-less) project is
 * allowed and updates ONLY the explicitly-given fields: duration/size are
 * always applied (they're required args), `background` only when passed —
 * an omitted `--background` on a re-compose keeps the existing background
 * instead of resetting it to black, and everything else already on the
 * composition (backgroundTrack's "紙芝居" cuts, any future field) is
 * carried over untouched. The only re-compose side effect: shrinking
 * `duration` drops backgroundTrack cuts now at/after the new end (they'd
 * be unreachable — backgroundIntervals only iterates t < duration), which
 * is silent for now (the return is a bare Manifest with no warning
 * channel). First-time compose is unchanged: background defaults to black.
 * `width`/`height` are written directly onto the manifest (there is no
 * source to derive them from, unlike a normal project's ingest-time fps/
 * width/height) and rounded to the nearest even pixel (yuv420p requirement,
 * same convention as parseReframeSpec).
 */
export function setComposition(
  m: Manifest,
  opts: { duration: number; width: number; height: number; background?: BackgroundRef },
): Manifest {
  if (m.sources.length > 0 || m.timeline.video.length > 0) {
    throw new Error('compose: project already has ingested video sources; composition mode is for a source-less production project only');
  }
  if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
    throw new Error(`compose: duration (${opts.duration}) must be a finite number > 0`);
  }
  if (!Number.isFinite(opts.width) || opts.width <= 0 || !Number.isFinite(opts.height) || opts.height <= 0) {
    throw new Error('compose: size must be positive width/height');
  }
  const prev = m.composition;
  const background = opts.background ?? prev?.background ?? { type: 'color', hex: '#000000' };
  assertBackgroundRef(background, 'compose');
  // Spread the previous composition first so backgroundTrack and any future
  // field survive a re-compose; then overwrite just what this call sets.
  const composition: NonNullable<Manifest['composition']> = { ...prev, duration: opts.duration, background };
  if (composition.backgroundTrack) {
    const inRange = composition.backgroundTrack.filter((e) => e.t < opts.duration);
    if (inRange.length) composition.backgroundTrack = inRange;
    else delete composition.backgroundTrack;
  }
  return {
    ...m,
    width: Math.max(2, Math.round(opts.width / 2) * 2),
    height: Math.max(2, Math.round(opts.height / 2) * 2),
    composition,
  };
}

/**
 * `vedit bg-set --at <t> --to <ref>`: set the active background from `t`
 * onward — a "紙芝居" scene change. `t` at (or within half a frame of) 0
 * replaces the base `composition.background` itself (the layer active
 * before any cut); any later `t` upserts (by frame-snapped time, replacing
 * an existing cut at the same instant) into `backgroundTrack`, kept sorted
 * ascending — see resolvedBackgroundAt/backgroundIntervals for how these
 * resolve at a given instant.
 */
export function setBackgroundAt(m: Manifest, t: number, ref: BackgroundRef): Manifest {
  if (!m.composition) throw new Error('bg-set: project has no composition (run `vedit compose` first)');
  if (!Number.isFinite(t) || t < 0) throw new Error(`bg-set: at (${t}) must be a finite number >= 0`);
  if (t > m.composition.duration) {
    throw new Error(`bg-set: at (${t}) exceeds composition duration (${m.composition.duration})`);
  }
  assertBackgroundRef(ref, 'bg-set');
  const fps = m.fps;
  if (t < 0.5 / fps) {
    return { ...m, composition: { ...m.composition, background: ref } };
  }
  const tSnapped = snap(t, fps);
  const track = [...(m.composition.backgroundTrack ?? [])];
  const idx = track.findIndex((e) => Math.abs(e.t - tSnapped) < 0.5 / fps);
  if (idx >= 0) track[idx] = { t: tSnapped, ref };
  else track.push({ t: tSnapped, ref });
  track.sort((a, b) => a.t - b.t);
  return { ...m, composition: { ...m.composition, backgroundTrack: track } };
}

/** Remove a background cut at (or within half a frame of) `t` from `backgroundTrack`. Refuses t=0 (that's the base `background`, not removable — use another `bg-set --at 0` to replace it instead). */
export function removeBackgroundAt(m: Manifest, t: number): Manifest {
  if (!m.composition) throw new Error('bg-remove: project has no composition');
  const fps = m.fps;
  if (t < 0.5 / fps) throw new Error('bg-remove: t=0 is the base background — replace it with `vedit bg-set --at 0 --to ...` instead of removing it');
  const track = m.composition.backgroundTrack ?? [];
  const next = track.filter((e) => Math.abs(e.t - t) >= 0.5 / fps);
  if (next.length === track.length) throw new Error(`bg-remove: no background cut at t=${t}`);
  return { ...m, composition: { ...m.composition, backgroundTrack: next } };
}

/** The active background ref at absolute timeline time `t` — the base `background` unless a `backgroundTrack` cut at or before `t` overrides it. */
export function resolvedBackgroundAt(m: Manifest, t: number): BackgroundRef {
  if (!m.composition) throw new Error('resolvedBackgroundAt: project has no composition');
  let active = m.composition.background;
  for (const e of m.composition.backgroundTrack ?? []) {
    if (e.t <= t) active = e.ref;
    else break; // backgroundTrack is kept sorted ascending by setBackgroundAt
  }
  return active;
}

export interface BackgroundInterval {
  t0: number;
  t1: number;
  ref: BackgroundRef;
}

/** The full "紙芝居" as non-overlapping, time-sorted [t0,t1) intervals covering [0,duration) — what render.ts/web/app.js actually iterate to build the background layer. Empty for a non-composition manifest. */
export function backgroundIntervals(m: Manifest): BackgroundInterval[] {
  if (!m.composition) return [];
  const duration = m.composition.duration;
  const cutPoints = [0, ...(m.composition.backgroundTrack ?? []).map((e) => e.t)];
  const points = [...new Set(cutPoints)].filter((t) => t < duration).sort((a, b) => a - b);
  const out: BackgroundInterval[] = [];
  for (let i = 0; i < points.length; i++) {
    const t0 = points[i];
    const t1 = i + 1 < points.length ? points[i + 1] : duration;
    if (t1 - t0 < 1e-9) continue;
    out.push({ t0, t1, ref: resolvedBackgroundAt(m, t0) });
  }
  return out;
}

/** How many items `shiftComposition` moved, plus the composition's duration AFTER the shift. */
export interface ShiftSummary {
  sprites: number;
  dialogue: number;
  music: number;
  bgCuts: number;
  duration: number;
}

/**
 * `vedit shift --from <t> --by <±秒>`: composition-only "間" (pacing gap)
 * adjustment — translate everything placed at/after `from` by `by` seconds
 * in one move: sprites (their `__comp__` anchor srcTime IS the timeline
 * time in a composition — see COMP_SOURCE_ID), dialogue, music, and
 * backgroundTrack cuts. An item sitting exactly AT `from` moves.
 *
 * A normal (source-driven) project is refused outright: its cut editing
 * already ripples automatically (remove-range/remove-words shift everything
 * downstream), so a manual shift op would only fight that model.
 *
 * Duration: stretches/shrinks by `by` by default (making room / closing a
 * gap); `opts.keepDuration` pins it instead, in which case any item or cut
 * that the shift would push beyond the end is an ERROR — never silently
 * dropped. In every mode, an item that would land at t < 0, or that this
 * op's own duration shrink would strand beyond the new end, is an error
 * too. All validation happens BEFORE anything is applied — on error the
 * manifest is untouched (no partial application). Items that were ALREADY
 * out of range before the call (e.g. a sprite orphaned by an earlier
 * duration change) are left alone rather than blocking the shift.
 *
 * backgroundTrack is re-sorted after the move (a negative shift can carry a
 * moved cut past an unmoved one), preserving setBackgroundAt's
 * sorted-ascending invariant.
 */
export function shiftComposition(
  m: Manifest,
  from: number,
  by: number,
  opts?: { keepDuration?: boolean },
): { manifest: Manifest; summary: ShiftSummary } {
  if (!m.composition) {
    throw new Error('shift: コンポジション専用の操作です。実写プロジェクトはカット編集が自動リップルします — remove-range / remove-words / clip-move 等を使ってください');
  }
  if (!Number.isFinite(from) || from < 0) throw new Error(`shift: from (${from}) must be a finite number >= 0`);
  if (!Number.isFinite(by) || by === 0) throw new Error(`shift: by (${by}) must be a finite, non-zero number of seconds`);
  const EPS = 1e-6;
  const keep = opts?.keepDuration ?? false;
  const oldDuration = m.composition.duration;
  const newDuration = keep ? oldDuration : oldDuration + by;
  if (newDuration <= EPS) {
    throw new Error(`shift: 移動後の duration (${newDuration.toFixed(3)}s) が 0 以下になります`);
  }

  // Validate-then-apply: collect every violation first; throw before any
  // part of the manifest is rebuilt if there is one.
  const problems: string[] = [];
  /** moved=true: the shifted position must land inside [0, newDuration]. moved=false: only flag it if THIS op's duration change strands a previously-in-range item. */
  const check = (label: string, id: string, tNew: number, moved: boolean, tOld: number): void => {
    if (moved && tNew < -EPS) {
      problems.push(`${label} ${id}: 移動後 t=${tNew.toFixed(3)}s が 0 秒より前になります`);
    } else if (tNew > newDuration + EPS && (moved || tOld <= oldDuration + EPS)) {
      problems.push(`${label} ${id}: 移動後 t=${tNew.toFixed(3)}s が duration (${newDuration.toFixed(3)}s) を超えます${keep ? '(--keep-duration 指定のため尺は伸びません)' : ''}`);
    }
  };

  let spriteCount = 0;
  const sprites = (m.timeline.sprites ?? []).map((s) => {
    const moved = s.anchor.sourceId === COMP_SOURCE_ID && s.anchor.srcTime >= from;
    const t = moved ? s.anchor.srcTime + by : s.anchor.srcTime;
    check('sprite', s.id, t, moved, s.anchor.srcTime);
    if (!moved) return s;
    spriteCount++;
    return { ...s, anchor: { ...s.anchor, srcTime: t } };
  });

  let dialogueCount = 0;
  const dialogue = (m.timeline.dialogue ?? []).map((d) => {
    const moved = d.tlStart >= from;
    const t = moved ? d.tlStart + by : d.tlStart;
    check('dialogue', d.id, t, moved, d.tlStart);
    if (!moved) return d;
    dialogueCount++;
    return { ...d, tlStart: t };
  });

  let musicCount = 0;
  const music = (m.timeline.music ?? []).map((mu) => {
    const moved = mu.tlStart >= from;
    const t = moved ? mu.tlStart + by : mu.tlStart;
    check('music', mu.id, t, moved, mu.tlStart);
    if (!moved) return mu;
    musicCount++;
    return { ...mu, tlStart: t };
  });

  let bgCount = 0;
  const bgTrack = (m.composition.backgroundTrack ?? []).map((e, i) => {
    const moved = e.t >= from;
    const t = moved ? e.t + by : e.t;
    check('bg-cut', `#${i + 1}@${e.t}s`, t, moved, e.t);
    if (!moved) return e;
    bgCount++;
    return { ...e, t };
  });

  if (problems.length) {
    throw new Error(`shift: 適用できません(部分適用はしません):\n- ${problems.join('\n- ')}`);
  }

  const composition = { ...m.composition, duration: newDuration };
  if (m.composition.backgroundTrack) {
    composition.backgroundTrack = [...bgTrack].sort((a, b) => a.t - b.t);
  }
  const timeline = { ...m.timeline };
  if (m.timeline.sprites) timeline.sprites = sprites;
  if (m.timeline.dialogue) timeline.dialogue = dialogue;
  if (m.timeline.music) timeline.music = music;

  return {
    manifest: { ...m, composition, timeline },
    summary: { sprites: spriteCount, dialogue: dialogueCount, music: musicCount, bgCuts: bgCount, duration: newDuration },
  };
}

// ---- dialogue (W-ANIME speech bubbles) ----
//
// Unlike sprites/overlays, a DialogueItem is placed directly at an absolute
// timeline time (no anchor indirection) — see DialogueItem's doc in
// types.ts. Available on any project (not gated to composition), since
// nothing about it depends on Manifest.composition.

/** Add a speech-bubble line at an absolute timeline time. `spriteId`, when given, must reference an existing sprite (used only to aim the bubble's tail — see kit.ts's deriveSpeechBubbleStyle). */
export function addDialogue(
  m: Manifest,
  text: string,
  opts: { tlStart: number; duration?: number; spriteId?: string; voiceMusicId?: string; id?: string },
): Manifest {
  if (typeof text !== 'string' || !text.trim()) throw new Error('dialogue-add: text is required');
  if (!Number.isFinite(opts.tlStart) || opts.tlStart < 0) {
    throw new Error(`dialogue-add: at (${opts.tlStart}) must be a finite number >= 0`);
  }
  const duration = opts.duration ?? 2.5;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`dialogue-add: duration (${duration}) must be a finite number > 0`);
  }
  if (opts.spriteId !== undefined && !(m.timeline.sprites ?? []).some((s) => s.id === opts.spriteId)) {
    throw new Error(`dialogue-add: unknown sprite: ${opts.spriteId}`);
  }
  const dialogue = m.timeline.dialogue ?? [];
  const id = opts.id ?? freshId('dl');
  if (dialogue.some((d) => d.id === id)) throw new Error(`dialogue-add: id already exists: ${id}`);
  const item: DialogueItem = {
    id,
    text,
    tlStart: opts.tlStart,
    duration,
    ...(opts.spriteId ? { spriteId: opts.spriteId } : {}),
    ...(opts.voiceMusicId ? { voiceMusicId: opts.voiceMusicId } : {}),
  };
  return { ...m, timeline: { ...m.timeline, dialogue: [...dialogue, item] } };
}

/** Patch an existing dialogue line's text/placement/sprite reference (never its `voiceMusicId` — re-add with `--voice` to change the voice clip). `spriteId: null` clears the tail-direction reference. */
export function updateDialogue(
  m: Manifest,
  id: string,
  patch: { text?: string; tlStart?: number; duration?: number; spriteId?: string | null },
): Manifest {
  const dialogue = m.timeline.dialogue ?? [];
  const idx = dialogue.findIndex((d) => d.id === id);
  if (idx < 0) throw new Error(`unknown dialogue item: ${id}`);
  const cur = dialogue[idx];
  const next: DialogueItem = { ...cur };
  if (patch.text !== undefined) {
    if (typeof patch.text !== 'string' || !patch.text.trim()) throw new Error('dialogue-update: text must be a non-empty string');
    next.text = patch.text;
  }
  if (patch.tlStart !== undefined) {
    if (!Number.isFinite(patch.tlStart) || patch.tlStart < 0) {
      throw new Error(`dialogue-update: at (${patch.tlStart}) must be a finite number >= 0`);
    }
    next.tlStart = patch.tlStart;
  }
  if (patch.duration !== undefined) {
    if (!Number.isFinite(patch.duration) || patch.duration <= 0) {
      throw new Error(`dialogue-update: duration (${patch.duration}) must be a finite number > 0`);
    }
    next.duration = patch.duration;
  }
  if (patch.spriteId !== undefined) {
    if (patch.spriteId === null) {
      delete next.spriteId;
    } else {
      if (!(m.timeline.sprites ?? []).some((s) => s.id === patch.spriteId)) {
        throw new Error(`dialogue-update: unknown sprite: ${patch.spriteId}`);
      }
      next.spriteId = patch.spriteId;
    }
  }
  const out = [...dialogue];
  out[idx] = next;
  return { ...m, timeline: { ...m.timeline, dialogue: out } };
}

/** Remove a dialogue line. Does NOT remove its `voiceMusicId`'s MusicItem — that cascade (one commit, two ops.ts calls) is the daemon's job, keeping this a single-purpose mutator like removeSprite/removeMusic. */
export function removeDialogue(m: Manifest, id: string): Manifest {
  const dialogue = m.timeline.dialogue ?? [];
  const next = dialogue.filter((d) => d.id !== id);
  if (next.length === dialogue.length) throw new Error(`unknown dialogue item: ${id}`);
  return { ...m, timeline: { ...m.timeline, dialogue: next } };
}

// ---- intent zones ("静寂スコア" protection zones — W-INTENT) ------------------
//
// Source-domain ranges the director has flagged as deliberate (a meaningful
// pause, a held reaction) so detection/ducking stop treating them as
// defects — see Manifest.intentZones / IntentZoneItem in types.ts. Two pure
// mutators (add/remove) plus overlap-query helpers consumed by the daemon's
// /api/detect exclusion and music-add/-update duck warning, and by the CLI's
// `vedit qc --render` (which maps a zone's source range onto the rendered
// timeline via sourceRangeToTimeline before handing it to qc.ts's
// probeRenderedFile — that mapping lives in cli.ts, not here, since it needs
// both this module's sourceRangeToTimeline AND qc.ts's IntentZone shape).

const INTENT_ZONE_KINDS = new Set(['quiet', 'hold']);

/** Add a protection zone. `t0`/`t1` are in `sourceId`'s own time domain (see IntentZoneItem doc). Kind defaults to 'quiet'. */
export function addIntentZone(
  m: Manifest,
  sourceId: string,
  t0: number,
  t1: number,
  opts: { label: string; kind?: 'quiet' | 'hold'; id?: string },
): Manifest {
  if (!m.sources.some((s) => s.id === sourceId)) throw new Error(`intent-add: unknown source: ${sourceId}`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
    throw new Error(`intent-add: t0/t1 must be finite numbers (got t0=${t0}, t1=${t1})`);
  }
  if (t0 < 0) throw new Error(`intent-add: t0 (${t0}) must be >= 0`);
  if (t1 <= t0) throw new Error(`intent-add: t1 (${t1}) must be greater than t0 (${t0})`);
  if (typeof opts.label !== 'string' || !opts.label.trim()) {
    throw new Error('intent-add: label is required');
  }
  const kind = opts.kind ?? 'quiet';
  if (!INTENT_ZONE_KINDS.has(kind)) {
    throw new Error(`intent-add: kind (${JSON.stringify(kind)}) must be "quiet" or "hold"`);
  }
  const zones = m.intentZones ?? [];
  const id = opts.id ?? freshId('iz');
  if (zones.some((z) => z.id === id)) throw new Error(`intent-add: id already exists: ${id}`);
  const zone: IntentZoneItem = { id, sourceId, t0, t1, label: opts.label, kind };
  return { ...m, intentZones: [...zones, zone] };
}

/** Remove a protection zone. */
export function removeIntentZone(m: Manifest, id: string): Manifest {
  const zones = m.intentZones ?? [];
  const next = zones.filter((z) => z.id !== id);
  if (next.length === zones.length) throw new Error(`unknown intent zone: ${id}`);
  return { ...m, intentZones: next };
}

/** Every intent zone for one source, source-domain (unfiltered by kind). */
export function intentZonesForSource(m: Manifest, sourceId: string): IntentZoneItem[] {
  return (m.intentZones ?? []).filter((z) => z.sourceId === sourceId);
}

/** Zones (from `zones`, already narrowed to one source — see intentZonesForSource) whose [t0,t1) overlaps the given source-domain range at all. */
export function overlappingIntentZones(zones: IntentZoneItem[], t0: number, t1: number): IntentZoneItem[] {
  return zones.filter((z) => Math.max(t0, z.t0) < Math.min(t1, z.t1));
}

/**
 * 'quiet'-kind zones overlapping a TIMELINE-domain range (e.g. a BGM item's
 * [tlStart, tlStart+duration)) — walks the range's segments() and maps each
 * back to source time before comparing against that segment's source's
 * zones, since Manifest.intentZones itself is source-domain. Used by
 * music-add/-update's duck warning (a duck region swallowing a deliberate
 * quiet moment is worth flagging, even though it's never rejected — see
 * daemon.ts). 'hold'-kind zones are deliberately excluded: they protect a
 * moment from being CUT, not from BGM ducking.
 */
export function quietZonesOverlappingTimelineRange(m: Manifest, tlStart: number, tlEnd: number): IntentZoneItem[] {
  const zones = m.intentZones ?? [];
  if (zones.length === 0) return [];
  const hits: IntentZoneItem[] = [];
  for (const seg of segments(m)) {
    const a = Math.max(tlStart, seg.tlStart);
    const b = Math.min(tlEnd, seg.tlEnd);
    if (b <= a) continue;
    const srcA = seg.srcStart + (a - seg.tlStart);
    const srcB = seg.srcStart + (b - seg.tlStart);
    for (const z of zones) {
      if (z.kind !== 'quiet' || z.sourceId !== seg.sourceId) continue;
      if (Math.max(srcA, z.t0) < Math.min(srcB, z.t1) && !hits.some((h) => h.id === z.id)) hits.push(z);
    }
  }
  return hits;
}
