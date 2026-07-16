// Canonical manifest types. All times are seconds (float) in source or
// timeline domain as noted. Frame-accurate ops snap to fps at the edges.

export interface Manifest {
  version: 1;
  name: string;
  /** Monotonic revision; every accepted write bumps it. */
  revision: number;
  /** Timeline format, taken from the primary source at ingest. */
  fps: number;
  width: number;
  height: number;
  sources: Source[];
  timeline: Timeline;
  captions: CaptionSettings;
  /** Export/preview canvas size; omitted means "use source width/height" (no reframe). */
  output?: { width: number; height: number };
}

export interface Source {
  id: string;
  /** Absolute path to the original media. Never modified. */
  path: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Relative path under cache/ once generated. */
  proxy?: string;
  peaks?: string;
  /** Set once transcription completed. */
  transcribed?: boolean;
}

export interface Timeline {
  /** Ordered video clips; timeline position is implicit (ripple layout). */
  video: VideoClip[];
  motion: MotionItem[];
}

export interface VideoClip {
  id: string;
  sourceId: string;
  /** Kept range in source time. */
  srcIn: number;
  srcOut: number;
  /**
   * Crop window position when manifest.output's aspect differs from the
   * source's, as a 0..1 fraction of the available slack (0 = window pinned
   * to the start/left-top, 1 = pinned to the end/right-bottom). Only the
   * axis actually being cropped (width XOR height, decided by comparing
   * aspect ratios at render time) is used; the other is ignored.
   */
  crop?: { x?: number; y?: number };
}

export interface MotionItem {
  id: string;
  /** Relative path of the MotionSpec JSON under motion/. */
  spec: string;
  /** Timeline-domain placement. */
  tlStart: number;
  duration: number;
}

export interface CaptionSettings {
  enabled: boolean;
  /** Preset id, see web/captions.css + references/motion-catalog.md */
  style: string;
  /** Max characters per caption line before splitting. */
  maxChars: number;
}

// ---- transcript ----

export interface Transcript {
  sourceId: string;
  language: string;
  words: Word[];
}

export interface Word {
  /** Stable id like "w0001"; never renumbered. */
  id: string;
  text: string;
  t0: number;
  t1: number;
  /** 0..1 from whisper; low-confidence words flagged in packed view. */
  p: number;
}

// ---- revision log ----

export interface RevisionEntry {
  rev: number;
  baseRev: number;
  actor: 'claude' | 'ui' | 'system';
  op: string;
  params: unknown;
  ts: string;
  /** Human-readable effect summary, e.g. "removed 3.2s (w120..w134)". */
  summary: string;
  /** Full manifest snapshot after applying the op (manifests are small). */
  snapshot: Manifest;
}

// ---- playback mapping ----

export interface Segment {
  tlStart: number;
  tlEnd: number;
  sourceId: string;
  srcStart: number;
  clipId: string;
  crop?: { x?: number; y?: number };
}

// ---- detection ----

export interface CutCandidate {
  id: string;
  kind: 'silence' | 'filler' | 'retake' | 'low-energy';
  sourceId: string;
  t0: number;
  t1: number;
  /** Word ids covered, if any. */
  wordIds: string[];
  label: string;
  status: 'proposed' | 'approved' | 'rejected';
}

export interface MotionSpec {
  id: string;
  type: 'chapter-card' | 'lower-third' | 'callout' | 'cta' | 'custom-html';
  params: Record<string, unknown>;
  /** For custom-html: full HTML fragment rendered in the overlay. */
  html?: string;
}

// ---- scene index ----

export interface Scene {
  /** Stable within a source; re-detection preserves it for matching ranges (±0.5s). */
  id: string;
  /** Source time. */
  t0: number;
  t1: number;
  /** Relative path under cache/, e.g. "cache/sc-<sourceId>-<sceneId>.jpg". */
  thumb: string;
  /** Whether any kept transcript word overlaps this range. */
  hasSpeech: boolean;
  /** Mean waveform peak over the range (motion proxy); 0 when the source has no peaks. */
  energy: number;
  /** Model/human annotation; outsourced from detection so provenance is explicit. */
  note?: { text: string; by: 'user' | 'model'; at: string };
}

export interface SceneFile {
  sourceId: string;
  scenes: Scene[];
}
