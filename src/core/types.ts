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
