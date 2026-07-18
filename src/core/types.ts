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
  /**
   * Per-source exposure/white-balance/saturation correction (W5), keyed by
   * sourceId. Applied at render/preview time only — never baked into the
   * proxy (unlike `Source.colorTransform`, see makeProxy in
   * src/ingest/ingest.ts) — so it stays cheap to tweak without a re-encode.
   * Optional for backward compatibility with existing project.json files; a
   * source with no entry here gets no adjustment at all (see
   * buildColorChain in src/export/color.ts, which returns '' for it — full
   * regression). Set via `vedit color-adjust`; `vedit color-match` proposes
   * values here but never writes them (the user applies them explicitly).
   * Revision-tracked like every other manifest field.
   */
  colorAdjust?: Record<string, { exposure?: number; wb?: number; sat?: number }>;
  /**
   * Reference to an external, cross-project "kit" directory (W8): a shared
   * production-settings folder (caption/title styles, character sprites,
   * profile/pacing guidance for the director) that multiple projects can
   * point at. Never copied into the project — kit.json under `path` is read
   * fresh on every use, so editing the kit affects every project linked to
   * it. Optional/absent means no kit is linked; every kit-aware feature
   * (captions --style <kitStyleId>, sprites, `vedit kit`/`resume` profile
   * highlights) degrades to its pre-W8 behavior. Set via `vedit kit-link
   * <dir>`, cleared via `vedit kit-unlink`. See src/core/kit.ts.
   */
  kit?: { path: string };
  /**
   * Per-cue text corrections (W-CAP "NLE 内での字幕編集"), keyed by the
   * cue's leading word id in `"sourceId:wordId"` form (the first element of
   * CaptionCue.wordIds, prefixed with its source — see captionCueKey in
   * core/captions.ts, the only place this key format is built/consumed).
   * An empty string hides that cue entirely; there is no separate "restore
   * original" value stored here — clearing a correction means deleting its
   * key (see the daemon's `caption-text` op with `text: null`, or `vedit
   * caption-text <key> --clear`). Optional for backward compatibility with
   * existing project.json files; a cue whose key has no entry here is
   * unaffected (full regression).
   */
  captionTextOverrides?: Record<string, string>;
  /**
   * "静寂スコア" protection zones (andashi 採用案): source-domain ranges the
   * director has explicitly marked as deliberate — a meaningful pause, a
   * held reaction shot — so automated tooling stops treating them as
   * defects. `sourceId`+`t0`/`t1` are in that source's own time domain (NOT
   * timeline time), matching CutCandidate's convention, since a protected
   * moment is a property of the FOOTAGE, not of wherever it currently sits
   * on the timeline. Optional for backward compatibility with existing
   * project.json files; an empty/absent list changes nothing (every
   * consumer — detect's silence-candidate filter, music-add/update's duck
   * warning, qc.ts's probeRenderedFile via `vedit qc --render` — degrades to
   * its pre-W-INTENT behavior). Set via `vedit intent-add`/`intent-remove`
   * (see ops.ts's addIntentZone/removeIntentZone).
   */
  intentZones?: IntentZoneItem[];
  /**
   * W-ANIME "コンポジション(スプライトアニメ)": marks this project as a
   * source-less production ("映像ソースなしの製作モード") — kit sprites
   * moving over a background, no A-roll footage at all. Optional/absent
   * means a normal (source-driven) project; every composition-aware
   * consumer (timelineDuration, sourceTimeToTimeline's `__comp__` sentinel,
   * render's buildCompositionFilterGraph, the web timeline) degrades to its
   * pre-W-ANIME behavior when this is unset — full regression for every
   * existing project. Set via `vedit compose <dir> --duration --size`
   * (see ops.ts's setComposition); `width`/`height` above are set directly
   * to the composition's canvas size at that point (there is no source to
   * derive them from). `background` is the base/default layer, active from
   * t=0 until the first `backgroundTrack` cut (if any) — see
   * resolvedBackgroundAt in ops.ts. `backgroundTrack` holds subsequent
   * "紙芝居" scene changes, set via `vedit bg-set --at <t> --to <ref>`.
   */
  composition?: {
    duration: number;
    background: BackgroundRef;
    backgroundTrack?: { t: number; ref: BackgroundRef }[];
  };
  /**
   * Transcription configuration that should be remembered across
   * `vedit transcribe` invocations, rather than re-specified every time.
   * Today this is just `glossary` (roadmap "whisper 用語集プロンプト"): a
   * list of proper nouns/jargon terms formatted into whisper.cpp's
   * `--prompt` (see buildWhisperPrompt in src/ingest/ingest.ts) to bias
   * decoding toward the right spelling. Set via `vedit transcribe
   * --glossary "<語1,語2,...>"` (see setTranscriptionGlossary in
   * core/ops.ts); optional/absent means no prompt at all — full
   * regression for every project that never sets it.
   */
  transcription?: { glossary?: string[] };
}

/**
 * A composition's background layer at one instant (W-ANIME): a solid color,
 * a linked kit's background-type asset, or a looping video file (absolute
 * path, same "user-owned, not sandboxed to the project" trust model as
 * MusicItem.path / Source.colorTransform.lut). Resolved to a concrete
 * ffmpeg/web source only at render/preview time — never copied/baked
 * anywhere else in the manifest.
 */
export type BackgroundRef =
  | { type: 'color'; hex: string }
  | { type: 'asset'; assetId: string }
  | { type: 'video'; path: string };

/** One "静寂スコア" protection zone — see Manifest.intentZones. */
export interface IntentZoneItem {
  id: string;
  /** Source-domain: the footage this zone protects, independent of where it currently sits on the timeline. */
  sourceId: string;
  t0: number;
  t1: number;
  /** Human-readable reason ("見せ場直後の余韻" etc.); shown on hover in the web timeline and threaded into qc.ts's probe issues as IntentZone.reason. */
  label: string;
  /**
   * 'quiet' = protects against silence-candidate auto-detection and warns
   * BGM ducking not to swallow it; 'hold' = a held shot/reaction the
   * director wants kept regardless of audio content (protects detection
   * only, no duck-warning implication).
   */
  kind: 'quiet' | 'hold';
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
  /**
   * Media kind (オーバーレイ・スタック). Optional/absent means 'video' —
   * every source ingested before this field existed, and every source
   * ingested via the normal footage-ingest path (`vedit ingest`/
   * `ingest-batch` on .mp4/.mov/.m4v), is implicitly 'video'; full
   * regression. 'image' marks a still PNG/JPEG/WebP ingested via the
   * lightweight image-ingest path (see ingestImageFile in
   * src/ingest/ingest.ts) purely for use as an overlay (OverlayClip.rect/
   * opacity/fade) — it is NEVER added to `timeline.video` (no A-roll role),
   * always has `hasAudio: false`, `fps: 0` (unused by any consumer — render
   * passes the MANIFEST's own fps to overlay chains, never a source's own;
   * otio.ts's `s.fps || rate` falls back to the timeline rate for it), and
   * a synthetic `duration` (see IMAGE_SOURCE_DURATION) far larger than any
   * practical overlay length, since a still image has no intrinsic
   * duration of its own for OverlayClip.srcIn/srcOut to be bounded by.
   */
  kind?: 'video' | 'image';
  /** Relative path under cache/ once generated. Never set for an image-kind source (no proxy is ever generated for a still image). */
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
  /**
   * SHA-256 of the original file's bytes (hex), computed by `vedit
   * ingest-batch`'s verification pass (see src/ingest/batch.ts) and used
   * for duplicate detection across batches/re-ingests. Optional/absent for
   * sources ingested via plain `vedit ingest`, ingested with
   * `ingest-batch --no-verify`, or ingested before this field existed —
   * absence is not evidence of anything, just unverified.
   */
  sha256?: string;
  /**
   * Input color transform (W5) applied to bring Log/HLG/PQ material into
   * Rec.709 SDR before preview/render. Optional/absent (or an explicit
   * `{ type: 'none' }`) means no transform at all — `buildColorChain`
   * (src/export/color.ts) returns '' for it, so an untouched source's
   * filtergraph/proxy is byte-for-byte identical to before this feature
   * existed. Set via `vedit color --source <id> --type hlg|pq|lut|none`,
   * which also regenerates the source's proxy (see makeProxy in
   * src/ingest/ingest.ts) so the preview reflects the transform.
   */
  colorTransform?: {
    type: 'hlg' | 'pq' | 'lut' | 'none';
    /**
     * Absolute filesystem path to a user-supplied .cube LUT, required when
     * type is 'lut'. The CLI resolves a relative --lut argument against
     * the current working directory before it reaches here (same
     * resolve-then-store convention as MusicItem.path) — paths outside the
     * project directory are explicitly allowed since LUTs are typically
     * user-owned assets shared across projects, not project-local files.
     */
    lut?: string;
  };
}

export interface Timeline {
  /** Ordered video clips; timeline position is implicit (ripple layout). */
  video: VideoClip[];
  motion: MotionItem[];
  /** Background-music items; optional for backward compatibility with older project.json files. */
  music?: MusicItem[];
  /**
   * B-roll overlay track (W3), a single non-overlapping layer laid on top of
   * the A-roll video. Optional for backward compatibility with older
   * project.json files. See OverlayClip for the anchor contract.
   */
  overlays?: OverlayClip[];
  /**
   * Character/prop sprite overlays (W8), anchored to an A-roll moment via
   * the SAME (sourceId, srcTime) contract as OverlayClip below — `anchor`
   * is the single source of truth for placement, the timeline position is
   * always derived via sourceTimeToTimeline, never stored. Unlike the
   * B-roll V2 track, sprites are a much lighter compositing layer (a still
   * PNG, not a video) and MAY overlap each other (more than one character
   * on screen at once) — there is no exclusivity/overlap check. Optional
   * for backward compatibility with older project.json files.
   */
  sprites?: SpriteItem[];
  /**
   * Speech-bubble lines (W-ANIME) — the composition-mode alternative to
   * captions ("captions は使わない代わりに dialogue"), though nothing
   * restricts it to composition projects specifically. Unlike sprites/
   * overlays, a DialogueItem is placed directly at an absolute timeline
   * time (`tlStart`) rather than anchored to an A-roll moment — a
   * composition has no A-roll to anchor to, and even in a normal project a
   * speech bubble reads more like MotionItem's placement (a fixed timeline
   * decoration) than a source-anchored overlay. Optional for backward
   * compatibility with older project.json files.
   */
  dialogue?: DialogueItem[];
}

/**
 * One speech-bubble line (W-ANIME). `spriteId`, when set, must reference an
 * existing `Timeline.sprites[]` entry — used only to aim the bubble's tail
 * toward that sprite's position (a presentation detail; render/web decide
 * exactly how, see kit.ts's deriveSpeechBubbleStyle and render.ts's ASS
 * BorderStyle=3 approximation). `voiceMusicId`, when set, is the id of a
 * `Timeline.music[]` entry created alongside this dialogue item (via
 * `--voice <file>`, the "SE 経路" the spec describes — voice audio rides
 * the same MusicItem pipeline as background music/sound effects, just with
 * duck disabled and short anti-click fades instead of BGM-style ones) so
 * removing the dialogue line also removes its voice clip (see the daemon's
 * `dialogue-remove` op). `pos`, when set, is a manual 0..1 normalized
 * canvas position for the speech bubble's anchor — it takes priority over
 * both the sprite-derived anchor AND the fixed top-center default (see
 * dialogueAnchorPixels in render.ts). Absent means "auto-anchor as before
 * this field existed" — full regression for every project that never sets
 * it.
 */
export interface DialogueItem {
  id: string;
  text: string;
  tlStart: number;
  duration: number;
  spriteId?: string;
  voiceMusicId?: string;
  pos?: { x: number; y: number };
}

/**
 * One character/prop sprite placed on the timeline (W8 kit). `assetId`
 * refers to an entry in the linked kit's `assets[]` (Manifest.kit); the
 * asset's `visible_bounds_normalized`/`ground_anchor_normalized` (see
 * KitAsset) drive where exactly it lands — see `spriteGeometry` in ops.ts.
 */
export interface SpriteItem {
  id: string;
  /** KitAsset.id within the linked kit. */
  assetId: string;
  /** The A-roll moment this sprite is glued to (see OverlayClip's anchor doc). */
  anchor: { sourceId: string; srcTime: number };
  duration: number;
  /** 0..1 fraction of the output canvas where the asset's ground_anchor_normalized point is placed. */
  position: { x: number; y: number };
  /** Displayed height of the asset's VISIBLE (alpha-bounded) region, as a 0..1 fraction of the output height — not the full (possibly padded) image. */
  scale: number;
  /** 0..1 opacity. */
  opacity: number;
  /** Mirror horizontally. */
  flip?: boolean;
  /**
   * Lightweight animation (W-ANIME) — entirely a render/preview-time
   * presentation detail layered on top of the static placement above
   * (position/scale/opacity stay the sprite's RESTING values; motion
   * expressions displace/fade around them). Optional/absent means a
   * perfectly static sprite, byte-for-byte the pre-W-ANIME render/preview
   * output — see spriteMotionPlan in ops.ts (the pure expression builder)
   * and its ffmpeg/CSS consumers in render.ts/web/app.js.
   */
  motion?: {
    /** Entrance transition, played during the sprite's first ~0.35s on screen. */
    enter?: SpriteMotionName;
    /** Continuous idle animation for the sprite's full [tlStart,tlEnd) window (also runs under enter/exit — their offsets add on top). */
    loop?: SpriteLoopName;
    /** Exit transition, played during the sprite's last ~0.35s on screen. */
    exit?: SpriteMotionName;
    /**
     * Expression-swap points ("表情差分"): at each `t` (seconds from the
     * sprite's OWN tlStart, i.e. sprite-local time — not absolute timeline
     * time), `assetId` (another entry in the same linked kit) is composited
     * on top of the base asset with a 0.15s crossfade, until the next
     * emoteAt entry (or the sprite's end). Sorted by `t` ascending is not
     * required of callers — see emoteWindows in ops.ts, which sorts.
     */
    emoteAt?: { t: number; assetId: string }[];
  };
}

/** Enter/exit sprite transition presets (W-ANIME) — symmetric: the same name means "play this transition" whether entering or exiting. */
export type SpriteMotionName = 'slide-left' | 'slide-right' | 'hop-in' | 'pop' | 'fade';

/** Continuous idle-loop sprite animation presets (W-ANIME). */
export type SpriteLoopName = 'sway' | 'bob' | 'hop' | 'breathe' | 'none';

/**
 * A B-roll clip anchored to a moment in an A-roll source rather than to an
 * absolute timeline position. `anchor` (sourceId + srcTime) is the single
 * source of truth for placement: the timeline position is always derived via
 * `sourceTimeToTimeline(anchor)`, never stored, so ripple edits to the A-roll
 * (cut/reorder) that leave the anchored instant intact automatically carry
 * the overlay along with it. If the anchored instant itself gets cut away,
 * the overlay becomes "orphaned" — kept in the manifest but excluded from
 * render/preview/OTIO until the user re-anchors it (see resolveOverlays).
 */
export interface OverlayClip {
  id: string;
  /** B-roll source material. */
  sourceId: string;
  /** Kept range in the B-roll source's own time; duration = srcOut - srcIn. */
  srcIn: number;
  srcOut: number;
  /** The A-roll moment this overlay is glued to. */
  anchor: { sourceId: string; srcTime: number };
  /** How the B-roll's own audio interacts with the A-roll's; default 'mute'. An image-kind source (see Source.kind) MUST be 'mute' — addOverlay/updateOverlay reject anything else, since a still image never has audio to mix/replace with. */
  audioMode: 'mute' | 'mix' | 'replace';
  /** Gain applied to the B-roll audio when audioMode is 'mix'/'replace'; default -18 (see render.ts's OVERLAY_GAIN_DEFAULT). */
  gainDb?: number;
  /**
   * Compositing layer (オーバーレイ・スタック mini-spec:
   * docs/superpowers/specs/2026-07-18-vedit-overlay-stack.md). Overlays
   * composite onto the A-roll in ASCENDING layer order — a higher number
   * sits ABOVE a lower one wherever their resolved timeline ranges overlap
   * (see resolvedActiveOverlays' sort and buildFilterGraph's W3/overlay-
   * stack block in render.ts). Optional/absent means 1 — the original W3
   * B-roll V2 track's single implicit layer — so every overlay added
   * before this field existed, and every `broll-add`/`broll-update` call
   * (which has no --layer flag), reads as layer 1 unchanged: full
   * regression, and "broll-add is layer 1's alias" per the spec.
   * assertNoOverlayOverlap only rejects a collision WITHIN the same layer;
   * different layers may freely overlap in time (that's the whole point of
   * a multi-layer stack — logo + photo + stamp all on screen together).
   */
  layer?: number;
  /**
   * Placement box, normalized 0..1 against the OUTPUT canvas (m.output, or
   * m.width/height when unset): {x,y} is the box's top-left corner, {w} is
   * its width as a fraction of the output width. Height is NOT stored —
   * it's derived at render/preview time to preserve the overlay source's
   * own aspect ratio (see overlayRectGeometry in render.ts), matching the
   * spec's "縦は元比率維持". Optional/absent means the original W3
   * full-bleed behavior: scaled+padded to fill the entire output canvas,
   * byte-for-byte the same ffmpeg chain as before this field existed. This
   * is also the ONLY legal state for a plain video B-roll overlay added
   * via `broll-add` before this feature existed — back-compat: "rect 未指定
   * の動画 B-roll は全面".
   */
  rect?: { x: number; y: number; w: number };
  /** 0..1 opacity multiplier for the overlay's own video (1 = fully opaque). Optional/absent means 1 — byte-for-byte the same chain as before this field existed. */
  opacity?: number;
  /**
   * Alpha fade in/out at the overlay's own head/tail, in seconds — ffmpeg's
   * `fade=alpha=1` (fades the overlay's OWN transparency, not a black
   * video-content fade, and never touches the A-roll underneath). Either
   * key may be given alone. Optional/absent means no fade at all —
   * byte-for-byte the same chain as before this field existed.
   */
  fade?: { in?: number; out?: number };
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
  /**
   * Per-clip audio override (roadmap "クリップ単位の音量・ミュート"): a
   * volume filter in dB (-30..+12), applied to just this clip's OWN audio
   * segment at render time — see setClipAudio in core/ops.ts and the
   * per-segment audio chain in export/render.ts's buildFilterGraph.
   * Optional/absent means no gain adjustment at all — full regression for
   * every clip that never sets it. Set via `vedit clip-audio <clipId>
   * --gain <dB>`.
   */
  gainDb?: number;
  /**
   * Silences this clip's own audio segment entirely at render time (takes
   * priority over `gainDb` when both are set). Optional/absent means not
   * muted — full regression. Set via `vedit clip-audio <clipId> --mute`.
   * Preview (web) does not reflect this yet — see renderFinal's
   * per-render "プレビュー未反映" warning when any clip has either field
   * set.
   */
  muted?: boolean;
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
  /**
   * What this item IS, for display/reporting only — no renderer branches on
   * it (an SFX behaves like SFX because `vedit music-add --sfx` writes
   * duck:false + 0.03s click-guard fades, all above). Optional for backward
   * compatibility: absent (every pre-existing item) reads as BGM.
   */
  role?: 'bgm' | 'sfx';
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
  /**
   * Per-project caption style overrides (W-CAP "NLE 内での字幕編集"),
   * layered on TOP of whatever `style` resolves to (a built-in
   * ASS_STYLE_PRESETS id or a linked kit's style) — every field is
   * optional ("書いた分だけ効く"). Absent (or an override object with no
   * fields set) leaves toAss/toSrt/the web preview byte-for-byte the same
   * as before this feature existed. Set via the web caption style popover
   * (drag-to-reposition for `position`) or `vedit captions
   * --font/--text-color/--outline-color/--box-color/--size-scale/
   * --outline-width/--bg-opacity/--position-v` (same `captions` patch op as
   * `style`/`maxChars`; the daemon merges a given `overrides` object onto
   * the existing one field-by-field, and clears it entirely when the patch
   * sends `overrides: null`). See applyCaptionOverrides in export/render.ts
   * for exactly how each field maps onto the ASS Style line, and
   * renderCaption in web/app.js for the CSS-custom-property mirror.
   */
  overrides?: {
    /**
     * A system font family name (used as-is, resolved by libass/CoreText
     * at render/preview time), OR a font FILE name under a linked kit's
     * fonts/ directory, with or without its extension (e.g. "MyFont-Bold"
     * or "MyFont-Bold.ttf") — resolveKitFontFile in core/fonts.ts decides
     * which by trying it against the kit's fonts/ dir first. GET
     * /api/fonts lists both groups for the web font <select>.
     */
    font?: string;
    palette?: { text?: string; outline?: string; box?: string };
    /** 0.5..2, multiplies the resolved style's font size. */
    sizeScale?: number;
    /** ASS Outline width in px; 0 switches BorderStyle to an opaque box (same convention as kitAssStyle's caption.outline_width). */
    outlineWidth?: number;
    /** 0..1 background box opacity (0 = fully transparent, 1 = fully opaque). */
    bgOpacity?: number;
    position?: {
      /**
       * 0..1, vertical position of the caption box's center (0 = top of
       * frame, 1 = bottom); default ~0.94, matching the pre-W-CAP
       * hardcoded placement (web: `bottom: 6%`; ASS: MarginV = height*0.06
       * with Alignment=2/bottom-anchor) byte-for-byte when omitted.
       */
      v: number;
      /** Only 'center' is supported today; reserved for future horizontal placement. */
      h?: 'center';
    };
  };
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

/**
 * Who initiated a persisted edit.
 *
 * `agent` is the provider-neutral value written by current clients. The
 * legacy `claude` value remains readable/writable for existing projects and
 * older clients; both values have identical concurrency semantics. Provider
 * branding (Codex, Claude Code, etc.) must not decide whether optimistic
 * locking applies.
 */
export type RevisionActor = 'agent' | 'claude' | 'ui' | 'system';

export function isRevisionActor(value: unknown): value is RevisionActor {
  return value === 'agent' || value === 'claude' || value === 'ui' || value === 'system';
}

/** True for both current provider-neutral edits and legacy Claude edits. */
export function isAgentActor(value: unknown): value is Extract<RevisionActor, 'agent' | 'claude'> {
  return value === 'agent' || value === 'claude';
}

export interface RevisionEntry {
  rev: number;
  baseRev: number;
  actor: RevisionActor;
  op: string;
  params: unknown;
  ts: string;
  /** Human-readable effect summary, e.g. "removed 3.2s (w120..w134)". */
  summary: string;
  /**
   * Full manifest snapshot after applying the op (manifests are small).
   * Declared required here because every WRITER (commitLocked) always
   * fills it in — but `vedit compact` (Project.compact(), see project.ts)
   * physically drops this key (and `motionSpecs` below) from older
   * revisions.jsonl entries to bound the log's growth, the same way
   * `motionSpecs` has always been allowed to be absent for entries
   * predating that field. Every READER of a parsed entry (restore(),
   * daemon.ts's revisionSnapshot) must therefore still treat `.snapshot`
   * as possibly missing at runtime despite this static type — restore()
   * checks explicitly and throws a "nearest restorable revision" error;
   * `Project.revisions()` (the UI history list, `vedit revisions`) never
   * touches `snapshot` at all, so compaction never affects history
   * display.
   */
  snapshot: Manifest;
  /**
   * Content of every motion/*.json sidecar referenced by
   * `snapshot.timeline.motion`, keyed by MotionItem.id, as of this
   * revision. Lets restore() roll motion sidecars back in lockstep with
   * the manifest. Optional so revisions written before this field existed
   * still parse (or `vedit compact` dropped it, see `snapshot` above);
   * restore() just can't roll sidecars back for those.
   */
  motionSpecs?: Record<string, unknown>;
  /**
   * Transcript values introduced by this revision, keyed by Source.id.
   * Ordinary edits inherit the effective value through baseRev; restore
   * revisions record the restored effective set. Keeping transcript changes
   * in the revision graph makes undo/redo and revision-pinned exports use the
   * same words instead of whichever transcript sidecar happens to be newest.
   */
  transcriptUpdates?: Record<string, Transcript>;
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
  /**
   * Machine-readable corroboration used by the autonomous first-draft gate.
   * Optional for projects/candidates created before this field existed; an
   * absent or incomplete value MUST be treated as "ask", never as evidence
   * that a cut is safe. `edge` keeps leading/trailing room tone out of the
   * automatic bucket even when both detectors agree, because those pauses
   * are pacing decisions rather than ordinary interior gaps.
   */
  evidence?: {
    transcriptGap?: boolean;
    waveform?: boolean;
    transcriptConflict?: boolean;
    edge?: 'interior' | 'leading' | 'trailing';
  };
  /**
   * Last autonomous review for this exact proposal. Persisting the reason on
   * the candidate keeps a no-op first draft and its exception rationale
   * visible after reload; a later detection pass replaces the proposal and
   * therefore naturally invalidates this annotation.
   */
  aiReview?: {
    reviewId: string;
    evaluatedAt: string;
    baseRev: number;
    disposition: 'auto-applied' | 'question' | 'excluded';
    reasonCode: string;
    reason: string;
  };
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

// ---- kit (W8: cross-project production-settings directory) ----
//
// vedit-kit/v1's own schema, hand-authored via `vedit kit-init` (see
// src/core/kit.ts). Every section is optional — "書いた分だけ効く" (only
// what's written takes effect); a project links to a kit via Manifest.kit
// and reads kit.json fresh on every use, never copying it in.

export interface KitProfile {
  tone_tags?: string[];
  language?: string;
  duration_seconds?: { min?: number; target?: number; max?: number };
  pacing?: { average_shot_seconds?: number };
  /** Vocabulary of construction beats, e.g. ["honest_hook", ..., "quiet_aftertaste"] — director judgment material, never mechanically enforced. */
  spine?: string[];
  quiet_pause_policy?: string;
}

export interface KitPalette {
  text?: string;
  outline?: string;
  box?: string;
  accent?: string;
}

/** Shared shape for KitStyle's `caption`/`title` fields. */
export interface KitTextStyle {
  /** Font file path, relative to the kit root (e.g. "fonts/MyFont-Bold.ttf"). */
  font?: string;
  size_1080p?: number;
  outline_width?: number;
  /** 0..1; 1 = fully opaque background box. */
  background_opacity?: number;
}

export interface KitStyle {
  id: string;
  label?: string;
  use_for?: string[];
  palette?: KitPalette;
  caption?: KitTextStyle;
  title?: KitTextStyle;
  motion?: { entry?: string; duration_seconds?: number };
}

export interface KitAsset {
  id: string;
  /** Relative to the kit root. */
  path: string;
  /**
   * `'ambient'` (W-ANIME): an optional looping particle/atmosphere layer a
   * composition renders over its background at low opacity — purely
   * declarative (see kit.ts's firstAmbientAsset); a kit with none simply
   * never triggers the feature ("キットに無ければ機能ごと非表示").
   */
  type: 'sprite' | 'background' | 'prop' | 'ambient';
  tags?: string[];
  emotion?: string;
  intensity?: number;
  /** Bounding box of the alpha-visible region, normalized 0..1 against the full image; auto-computed by `vedit kit-scan`. */
  visible_bounds_normalized?: { x0: number; y0: number; x1: number; y1: number };
  /** Foot/ground point (alpha-weighted centroid of the bottom-most visible row), normalized 0..1 against the full image; auto-computed by `vedit kit-scan`. */
  ground_anchor_normalized?: { x: number; y: number };
  /** Pixel dimensions of the source image; filled in by `vedit kit-scan` alongside the alpha geometry above — needed to preserve aspect ratio (see spriteGeometry in ops.ts). Not part of the mini-spec's enumerated fields but required to make visible_bounds/ground_anchor usable without re-probing the file at render time. */
  width?: number;
  height?: number;
  sha256?: string;
}

export interface KitAudio {
  music_dir?: string;
  default_gain?: number;
  duck_amount?: number;
  target_lufs?: number;
  repair_preset?: string;
}

export interface KitDefaults {
  captions_style?: string;
  export_preset?: string;
  reframe_focus?: string;
}

export interface KitFile {
  version: 'vedit-kit/v1';
  name?: string;
  profile?: KitProfile;
  styles?: KitStyle[];
  assets?: KitAsset[];
  audio?: KitAudio;
  defaults?: KitDefaults;
}
