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
  /** Final-render audio mastering settings; all optional, see defaults on each field. */
  audioMix?: {
    /** Integrated loudness target (LUFS) for the final mix; default -14. */
    targetLufs?: number;
    /** How much a ducking music item drops under speech, in dB (negative); default -10. */
    duckAmount?: number;
    /** Anti-click fade applied to each speech segment's audio head/tail, in ms; default 12. */
    crossfadeMs?: number;
  };
  /**
   * Conversational-audio repair chain applied to speech segments at render
   * time (highpass + noise reduction + compressor, optionally de-esser).
   * Optional; absent (or preset 'off') means no repair chain at all —
   * byte-for-byte the same audio graph as before this feature existed.
   */
  audioRepair?: {
    preset: 'outdoor' | 'indoor' | 'wireless' | 'off';
    deess?: boolean;
  };
  /**
   * Scene-level keep/reject review verdicts, keyed by sourceId then sceneId.
   * Lives on the manifest (not the scenes-<sourceId>.json index) so it rides
   * along with revision history / undo / the 409 stale-baseRev guard like
   * every other edit. A scene with no entry here is unreviewed; an entry is
   * only ever 'keep' or 'reject' — "clear" is an action (setSceneReview),
   * never a stored value. Optional for backward compatibility with existing
   * project.json files. Sources with no detected scenes are out of scope
   * for culling (see scenes.ts) so never appear as a key here.
   */
  culling?: Record<string, Record<string, 'keep' | 'reject'>>;
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
  /**
   * Color metadata captured from the video stream at ingest, when ffprobe
   * reports it. Optional/absent for sources ingested before this field
   * existed, or when the container carries no color tags at all — absence
   * is not evidence of anything, just missing information.
   */
  color?: {
    primaries?: string;
    transfer?: string;
    space?: string;
    bitDepth?: number;
  };
}

export interface Timeline {
  /** Ordered video clips; timeline position is implicit (ripple layout). */
  video: VideoClip[];
  motion: MotionItem[];
  /** Background-music items; optional for backward compatibility with older project.json files. */
  music?: MusicItem[];
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

export interface MusicItem {
  id: string;
  /** Absolute path to the original music file. Never modified. */
  path: string;
  /** Timeline-domain placement, in seconds. */
  tlStart: number;
  /** Length placed on the timeline, in seconds (may be shorter than the source). */
  duration: number;
  /** Start offset within the music file, in seconds. */
  srcIn: number;
  /** Gain applied to the music, in dB. Default -12. */
  gain: number;
  /** Fade-in length, in seconds. Default 1. */
  fadeIn: number;
  /** Fade-out length, in seconds. Default 2. */
  fadeOut: number;
  /** Automatically duck under speech at render/preview time. Default true. */
  duck: boolean;
}

export interface CaptionSettings {
  enabled: boolean;
  /** Preset id, see web/captions.css + references/motion-catalog.md */
  style: string;
  /** Max characters per caption line before splitting. */
  maxChars: number;
  /**
   * Max characters-per-second a cue may be displayed at before its duration
   * is extended (or it's merged with a neighbor) to stay readable. Optional
   * for backward compatibility with existing project.json files; defaults
   * to 8 when absent.
   */
  maxCps?: number;
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
  /**
   * Content of every motion/*.json sidecar referenced by
   * `snapshot.timeline.motion`, keyed by MotionItem.id, as of this
   * revision. Lets restore() roll motion sidecars back in lockstep with
   * the manifest. Optional so revisions written before this field existed
   * still parse; restore() just can't roll sidecars back for those.
   */
  motionSpecs?: Record<string, unknown>;
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
