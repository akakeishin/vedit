import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  backgroundIntervals,
  cropGeometry,
  emoteWindows,
  OVERLAY_GAIN_DEFAULT,
  resolvedActiveOverlays,
  resolvedActiveSprites,
  segments,
  SPRITE_EMOTE_CROSSFADE_SECONDS,
  spriteGeometry,
  spriteMotionPlan,
  timelineDuration,
} from '../core/ops.js';
import { captionCues } from '../core/captions.js';
import type { CaptionSettings, KitFile, KitStyle, Manifest, MusicItem, Transcript } from '../core/types.js';
import {
  AMBIENT_LAYER_OPACITY,
  deriveSpeechBubbleStyle,
  firstAmbientAsset,
  readKitFile,
  resolveKitAssets,
  type ResolvedKitAsset,
  type SpeechBubbleStyle,
} from '../core/kit.js';
import { resolveWithinDir } from '../core/project.js';
import { listSystemFonts, resolveKitFontFile } from '../core/fonts.js';
import { buildColorChain } from './color.js';
import { ffmpegHasFilter, run, runCapture } from '../ingest/run.js';

function assTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

/**
 * ASS style presets, one per `captions.style` id. Colours are ASS's
 * &HAABBGGRR — `bold`'s &H005CE4FF is opaque yellow (RGB FF,E4,5C = #ffe45c),
 * matching the web preview's `.style-bold` caption color exactly. At least
 * these four (clean/bold/outline/boxed) are always emitted so `--style`
 * always resolves to a real ASS style even before the web side grows more
 * presets; an unrecognized style id falls back to `clean`.
 */
interface AssStylePreset {
  primary: string;
  outline: string;
  back: string;
  bold: 0 | -1;
  borderStyle: 1 | 3;
  outlineWidth: number;
  shadow: number;
  /** Kit styles only: overrides the module-wide Hiragino Sans / height*0.045 defaults below. */
  fontname?: string;
  fontsize?: number;
  /** W-CAP overrides.position.v only: overrides the module-wide height*0.06 MarginV default below. */
  marginV?: number;
}

export const ASS_STYLE_PRESETS: Record<string, AssStylePreset> = {
  clean: { primary: '&H00FFFFFF', outline: '&H00101010', back: '&H80000000', bold: 0, borderStyle: 1, outlineWidth: 3, shadow: 1 },
  bold: { primary: '&H005CE4FF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 3, outlineWidth: 0, shadow: 0 },
  outline: { primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: 0, borderStyle: 1, outlineWidth: 3, shadow: 1 },
  boxed: { primary: '&H00FFFFFF', outline: '&H00101010', back: '&H00000000', bold: 0, borderStyle: 3, outlineWidth: 0, shadow: 2 },
};

// ---- W8: kit style -> ASS style (palette hex -> BGR, font file -> fontname, size_1080p -> scaled fontsize) ----

/** "#RRGGBB" or "#RGB" -> ASS's BBGGRR hex (no leading &H/alpha — callers prefix those). Garbage input falls back to white. */
function hexToBgr(hex: string): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'FFFFFF';
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return (b + g + r).toUpperCase();
}
function assColor(hex: string | undefined, fallbackBgr: string, alphaHex = '00'): string {
  return `&H${alphaHex}${hex ? hexToBgr(hex) : fallbackBgr}`;
}
/** 0..1 opacity -> ASS alpha hex (00 = opaque, FF = fully transparent — inverted from "opacity"). */
function opacityToAlphaHex(opacity: number | undefined, fallbackHex: string): string {
  if (opacity === undefined || !Number.isFinite(opacity)) return fallbackHex;
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255);
  return a.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Build an ASS style preset from a kit style's palette/caption fields:
 * text/outline/box hex -> ASS BGR, background_opacity -> the box colour's
 * alpha channel, outline_width verbatim, font FILE PATH -> ASS Fontname
 * (its basename without extension — matched against ffmpeg's `ass` filter
 * `fontsdir=` at render time, see renderFinal), size_1080p scaled to the
 * actual output height.
 */
function kitAssStyle(style: KitStyle, outputHeight: number): AssStylePreset {
  const palette = style.palette ?? {};
  const caption = style.caption ?? {};
  const outlineWidth = caption.outline_width ?? 3;
  const fontname = caption.font ? path.basename(caption.font, path.extname(caption.font)) : undefined;
  const fontsize = caption.size_1080p ? Math.round(caption.size_1080p * (outputHeight / 1080)) : undefined;
  return {
    primary: assColor(palette.text, 'FFFFFF'),
    outline: assColor(palette.outline, '101010'),
    back: assColor(palette.box, '000000', opacityToAlphaHex(caption.background_opacity, '80')),
    bold: 0,
    borderStyle: outlineWidth > 0 ? 1 : 3,
    outlineWidth,
    shadow: 1,
    fontname,
    fontsize,
  };
}

// ---- W-ANIME: dialogue speech bubbles -> ASS (BorderStyle=3 rounded-box approximation) ----

/** ASS style name reserved for W-ANIME dialogue speech bubbles. */
const DIALOGUE_STYLE_NAME = 'dialogue';

/**
 * Speech-bubble palette (kit.ts's deriveSpeechBubbleStyle) -> ASS style:
 * BorderStyle=3 (opaque box) is the "丸角ボックス近似" the spec calls for —
 * ASS has no literal corner-radius or tail, so the rounded shape/tail only
 * render literally in the web preview (CSS); the burned-in render gets a
 * plain solid rectangle in the bubble's colors, positioned via each
 * Dialogue event's own `\pos()` override (see dialogueAssLines) rather than
 * this style's shared Alignment/MarginV.
 */
function speechBubbleAssStyle(bubble: SpeechBubbleStyle, outputHeight: number): AssStylePreset {
  return {
    primary: assColor(bubble.palette.text, '111111'),
    outline: assColor(bubble.palette.outline, '111111'),
    back: assColor(bubble.palette.box, 'FFFFFF'),
    bold: 0,
    borderStyle: 3,
    outlineWidth: 0,
    shadow: 0,
    fontsize: Math.round(outputHeight * 0.04),
  };
}

/**
 * Pixel anchor for one dialogue line's speech bubble: above the referenced
 * sprite's head (via the SAME spriteGeometry math render/web use for
 * placement) when `spriteId` resolves to both a real sprite AND its kit
 * asset, else a fixed top-center default. Pure given an already-loaded
 * `kit` (or none).
 */
function dialogueAnchorPixels(
  m: Manifest,
  d: { spriteId?: string },
  kit: KitFile | null | undefined,
  output: { width: number; height: number },
): { x: number; y: number } {
  const sprite = d.spriteId ? (m.timeline.sprites ?? []).find((s) => s.id === d.spriteId) : undefined;
  const asset = sprite ? kit?.assets?.find((a) => a.id === sprite.assetId) : undefined;
  if (sprite && asset) {
    const geo = spriteGeometry(asset, sprite.position, sprite.scale, output, { flip: sprite.flip });
    return { x: geo.anchorX, y: Math.max(output.height * 0.08, geo.y - output.height * 0.04) };
  }
  return { x: output.width / 2, y: output.height * 0.15 };
}

/**
 * `m.timeline.dialogue` -> ASS `Dialogue:` lines, each positioned via a
 * `{\an5\pos(x,y)}` override (middle-center anchor at the computed pixel
 * point) rather than relying on the shared style's Alignment/MarginV — see
 * dialogueAnchorPixels. Empty when the manifest has no dialogue items
 * (the overwhelmingly common case — every existing project).
 */
function dialogueAssLines(m: Manifest, kit: KitFile | null | undefined, output: { width: number; height: number }): string[] {
  return (m.timeline.dialogue ?? []).map((d) => {
    const { x, y } = dialogueAnchorPixels(m, d, kit, output);
    const text = `{\\an5\\pos(${Math.round(x)},${Math.round(y)})}${d.text.replace(/\n/g, '\\N')}`;
    return `Dialogue: 0,${assTime(d.tlStart)},${assTime(d.tlStart + d.duration)},${DIALOGUE_STYLE_NAME},,0,0,0,,${text}`;
  });
}

/** Split an ASS `&HAABBGGRR` colour string into its alpha and BGR components (uppercase hex). Malformed input falls back to opaque white. */
function parseAssColor(ass: string): { alphaHex: string; bgr: string } {
  const m = /^&H([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})$/.exec(ass);
  return m ? { alphaHex: m[1].toUpperCase(), bgr: m[2].toUpperCase() } : { alphaHex: '00', bgr: 'FFFFFF' };
}

/**
 * Apply CaptionSettings.overrides (W-CAP) on top of an already-resolved
 * style preset (built-in or kit) — only the fields actually set on
 * `overrides` are touched; every other field passes through from `preset`
 * untouched, so e.g. an overrides object with just `sizeScale` never
 * disturbs the base style's colors/font. Pure — no I/O (resolving a font
 * FILE reference to a fontsdir is renderFinal's job, same division of
 * labor as kitAssStyle's own caption.font).
 */
function applyCaptionOverrides(
  preset: AssStylePreset,
  overrides: NonNullable<CaptionSettings['overrides']>,
  defaultFontSize: number,
): AssStylePreset {
  const out: AssStylePreset = { ...preset };
  const palette = overrides.palette;
  if (palette?.text) out.primary = `&H00${hexToBgr(palette.text)}`;
  if (palette?.outline) out.outline = `&H00${hexToBgr(palette.outline)}`;
  if (palette?.box || overrides.bgOpacity !== undefined) {
    const base = parseAssColor(preset.back);
    const bgr = palette?.box ? hexToBgr(palette.box) : base.bgr;
    const alphaHex = overrides.bgOpacity !== undefined ? opacityToAlphaHex(overrides.bgOpacity, base.alphaHex) : base.alphaHex;
    out.back = `&H${alphaHex}${bgr}`;
  }
  if (overrides.sizeScale !== undefined) {
    out.fontsize = Math.round((preset.fontsize ?? defaultFontSize) * overrides.sizeScale);
  }
  if (overrides.outlineWidth !== undefined) {
    out.outlineWidth = overrides.outlineWidth;
    out.borderStyle = overrides.outlineWidth > 0 ? 1 : 3;
  }
  if (overrides.font) out.fontname = path.basename(overrides.font, path.extname(overrides.font));
  return out;
}

/**
 * `kit`, when given, is an already-loaded kit.json (see readKitFile in
 * kit.ts) — toAss stays pure/I-O-free by never loading it itself. When
 * `m.captions.style` matches a kit style id, that style is added to the
 * emitted styles (the four built-in presets are ALWAYS still emitted too,
 * unchanged — full regression for every existing caller, which never passes
 * `kit` at all) and becomes the active style.
 *
 * W-CAP: `m.captions.overrides`, when set, is layered on top of the ACTIVE
 * style only (every other style line — including the active style's own
 * un-overridden preset that would otherwise apply — stays exactly as it
 * would without overrides); `overrides.position.v` becomes a per-style
 * MarginV override rather than touching the shared default. No `overrides`
 * at all reproduces the exact ASS this function emitted before W-CAP
 * existed — full regression.
 */
export function toAss(m: Manifest, transcripts: Transcript[], kit?: KitFile | null): string {
  const cues = captionCues(m, transcripts);
  const { width, height } = m.output ?? { width: m.width, height: m.height };
  const defaultFontSize = Math.round(height * 0.045);
  const defaultMarginV = Math.round(height * 0.06);

  const presets: Record<string, AssStylePreset> = { ...ASS_STYLE_PRESETS };
  let activeStyle = presets[m.captions.style] ? m.captions.style : 'clean';
  const kitStyle = kit?.styles?.find((s) => s.id === m.captions.style);
  if (kitStyle) {
    presets[kitStyle.id] = kitAssStyle(kitStyle, height);
    activeStyle = kitStyle.id;
  }

  // W-ANIME: only added when the manifest actually HAS dialogue items — an
  // unused style line would otherwise change the .ass output of every
  // existing (dialogue-less) project, breaking full regression.
  const dialogue = m.timeline.dialogue ?? [];
  if (dialogue.length > 0) {
    const dialogueKitStyle =
      kit?.styles?.find((s) => (s.use_for ?? []).some((u) => u === 'dialogue' || u === 'speech-bubble')) ?? kitStyle;
    presets[DIALOGUE_STYLE_NAME] = speechBubbleAssStyle(deriveSpeechBubbleStyle(dialogueKitStyle ?? null), height);
  }

  const overrides = m.captions.overrides;
  if (overrides) {
    presets[activeStyle] = applyCaptionOverrides(presets[activeStyle], overrides, defaultFontSize);
    if (overrides.position?.v !== undefined) {
      // Alignment stays 2 (bottom-center, hardcoded below) — MarginV is the
      // distance from the frame's BOTTOM edge to the text's anchor, so a
      // caption box whose center should sit at `v` (0=top,1=bottom) gets its
      // bottom edge at `v*height`, i.e. a margin of `(1-v)*height` from the
      // bottom. v=0.94 (the documented default) reproduces the pre-W-CAP
      // hardcoded `height*0.06` exactly.
      presets[activeStyle].marginV = Math.round((1 - overrides.position.v) * height);
    }
  }

  const styleLines = Object.entries(presets)
    .map(([name, s]) => {
      const fontname = s.fontname ?? 'Hiragino Sans';
      const fontsize = s.fontsize ?? defaultFontSize;
      const marginV = s.marginV ?? defaultMarginV;
      return `Style: ${name},${fontname},${fontsize},${s.primary},&H000000FF,${s.outline},${s.back},${s.bold},0,0,0,100,100,0,0,${s.borderStyle},${s.outlineWidth},${s.shadow},2,60,60,${marginV},1`;
    })
    .join('\n');
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLines}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map(
    (c) => `Dialogue: 0,${assTime(c.tlStart)},${assTime(c.tlEnd)},${activeStyle},,0,0,0,,${c.text.replace(/\n/g, '\\N')}`,
  );
  const dialogueLines = dialogue.length > 0 ? dialogueAssLines(m, kit, { width, height }) : [];
  return head + [...lines, ...dialogueLines].join('\n') + '\n';
}

export interface FilterGraphBuild {
  /** Ordered `-i` input paths: video sources first (dedup'd, seg order), then one per music item, then B-roll sources, then W8 sprite PNGs (one per resolved sprite). */
  inputPaths: string[];
  /** filter_complex graph string. */
  graph: string;
  /** Label to `-map` for video. */
  videoLabel: string;
  /** Label to `-map` for the final audio mix. */
  audioLabel: string;
  /** Indices into `inputPaths` that are still-image sprite inputs needing `-loop 1` (see renderFinal). Present only when the project has resolved sprites AND a `kitAssets` map was supplied. */
  spriteInputIndices?: number[];
}

// ---- W1: conversational-audio repair chain ----

const REPAIR_PRESETS: Record<'outdoor' | 'indoor' | 'wireless', { highpass: number; nr: number; nf: number }> = {
  outdoor: { highpass: 80, nr: 12, nf: -40 },
  indoor: { highpass: 60, nr: 10, nf: -45 },
  wireless: { highpass: 100, nr: 18, nf: -35 },
};

/**
 * Build the conversational-audio repair filter chain for a manifest's
 * `audioRepair` setting: highpass -> noise reduction -> (optional de-esser)
 * -> compressor, as filter clauses joined by commas (no leading/trailing
 * comma, no brackets) ready to splice into a segment's audio chain ahead of
 * the join into `[ac]`. `off`/absent returns '' so the graph is byte-for-
 * byte identical to before this feature existed — full regression.
 */
export function buildRepairChain(repair?: Manifest['audioRepair']): string {
  if (!repair || repair.preset === 'off') return '';
  const cfg = REPAIR_PRESETS[repair.preset];
  if (!cfg) return '';
  const parts = [`highpass=f=${cfg.highpass}`, `afftdn=nr=${cfg.nr}:nf=${cfg.nf}`];
  if (repair.deess) parts.push('deesser');
  parts.push('acompressor=threshold=-18dB:ratio=3:attack=20:release=250');
  return parts.join(',');
}

// ---- W1: 2-pass loudnorm ----

export interface LoudnormMeasured {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/**
 * Build a `loudnorm` filter clause (no brackets): the plain single-pass
 * form by default, a `print_format=json` measurement-pass form when
 * `printJson` is set, or a 2nd-pass form fed with 1st-pass `measured`
 * values. Pure/testable independent of actually running ffmpeg.
 */
export function loudnormClause(target: number, opts: { measured?: LoudnormMeasured; printJson?: boolean } = {}): string {
  if (opts.printJson) return `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`;
  if (opts.measured) {
    const m = opts.measured;
    return (
      `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
      `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`
    );
  }
  return `loudnorm=I=${target}:TP=-1.5:LRA=11`;
}

/** Mix `labels` into one stream via `amix`, or pass a lone label through unchanged. Appends any needed clause to `parts`. */
function mixLabels(parts: string[], labels: string[], tag: string): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[${tag}]`);
  return `[${tag}]`;
}

/**
 * Build the trim+concat(+music) filter_complex graph for the final render,
 * as a pure string-construction step independent of actually invoking
 * ffmpeg — this is what's unit-tested (see render.test.ts) since running a
 * real render needs real media.
 *
 * Video is always [vc]. Audio is [ac] (the concatenated conversation track)
 * when the project has no music at all — same shape as before music
 * support existed, so a music-less project never regresses. With music,
 * each conversation segment's audio still gets an anti-click afade at its
 * head/tail (replacing what an `acrossfade`-based concat join would do,
 * which drifts video/audio sync), each music item is trimmed/delayed/faded
 * into its own stream, ducking music gets sidechain-compressed against the
 * conversation audio, everything is mixed together, and the whole thing is
 * loudness-normalized.
 */
export function buildFilterGraph(
  m: Manifest,
  opts: { loudnorm?: { measured?: LoudnormMeasured; printJson?: boolean }; kitAssets?: Map<string, ResolvedKitAsset> } = {},
): FilterGraphBuild {
  const segs = segments(m);
  if (segs.length === 0) throw new Error('empty timeline');
  const srcIds = [...new Set(segs.map((s) => s.sourceId))];
  const srcById = new Map(m.sources.map((s) => [s.id, s]));
  const music = m.timeline.music ?? [];
  const inputPaths = [...srcIds.map((id) => srcById.get(id)!.path), ...music.map((mu) => mu.path)];
  const musicInputBase = srcIds.length;
  const output = m.output ?? { width: m.width, height: m.height };
  const crossfadeMs = m.audioMix?.crossfadeMs ?? 12;
  const xfade = Math.max(0, crossfadeMs) / 1000;
  const repairChain = buildRepairChain(m.audioRepair);

  const parts: string[] = [];
  const labels: string[] = [];
  segs.forEach((seg, i) => {
    const idx = srcIds.indexOf(seg.sourceId);
    const src = srcById.get(seg.sourceId)!;
    const a = seg.srcStart;
    const b = seg.srcStart + (seg.tlEnd - seg.tlStart);
    const dur = b - a;
    // Original sources are rendered at their real resolution, so crop
    // geometry can be computed in exact pixels (unlike the proxy-based
    // filmstrip in view.ts, which has to fall back to fractional crop).
    const geo = cropGeometry(src.width, src.height, output.width, output.height, seg.crop);
    const cropPart = geo ? `crop=${geo.width}:${geo.height}:${geo.x}:${geo.y},` : '';
    // W5: input color transform (HLG/PQ/LUT) + exposure/WB/saturation,
    // applied to the full decoded frame before crop/scale so downstream
    // filters operate on the corrected picture. A source with neither set
    // produces '' here -> byte-for-byte the same chain as before W5.
    const colorChain = buildColorChain(src.colorTransform, m.colorAdjust?.[seg.sourceId]);
    const colorPart = colorChain ? `${colorChain},` : '';
    parts.push(
      `[${idx}:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,${colorPart}${cropPart}scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2,fps=${m.fps}[v${i}]`,
    );
    if (src.hasAudio) {
      // A razor join between segments clicks; acrossfade would fix that but
      // shifts audio relative to video across the join (unacceptable for a
      // dialogue-driven cut). Fading each segment's own head/tail instead
      // fixes the click without moving anything in time.
      const fd = Math.min(xfade, dur / 2);
      const fadePart = fd > 1e-4 ? `,afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, dur - fd)}:d=${fd}` : '';
      const repairPart = repairChain ? `,${repairChain}` : '';
      parts.push(`[${idx}:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS${repairPart}${fadePart}[a${i}]`);
    } else {
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${dur}[a${i}]`);
    }
    labels.push(`[v${i}][a${i}]`);
  });
  let graph = parts.join(';') + `;${labels.join('')}concat=n=${segs.length}:v=1:a=1[vc][ac]`;
  let audioLabel = '[ac]';

  if (music.length > 0) {
    const duckAmount = m.audioMix?.duckAmount ?? -10;
    const targetLufs = m.audioMix?.targetLufs ?? -14;
    const musicParts: string[] = [];
    const duckLabels: string[] = [];
    const plainLabels: string[] = [];
    music.forEach((mu, i) => {
      const inIdx = musicInputBase + i;
      const label = `[mu${i}]`;
      const fd = Math.max(0, mu.fadeIn);
      const fo = Math.max(0, mu.fadeOut);
      musicParts.push(
        `[${inIdx}:a]atrim=start=${mu.srcIn}:end=${mu.srcIn + mu.duration},asetpts=PTS-STARTPTS,` +
          `volume=${mu.gain}dB,afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, mu.duration - fo)}:d=${fo},` +
          `adelay=${Math.round(mu.tlStart * 1000)}:all=1${label}`,
      );
      (mu.duck ? duckLabels : plainLabels).push(label);
    });

    const duckMix = mixLabels(musicParts, duckLabels, 'duckPre');
    let convLabel = audioLabel;
    let duckFinal = duckMix;
    if (duckMix) {
      // Sidechain-compress the ducking music group, keyed by the
      // conversation audio — needs its own copy of [ac] since a link can
      // only feed one consumer, hence the asplit.
      musicParts.push(`[ac]asplit=2[acMain][acKey]`);
      musicParts.push(
        `${duckMix}[acKey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1[duckOut]`,
      );
      duckFinal = '[duckOut]';
      convLabel = '[acMain]';
    }

    const plainMix = mixLabels(musicParts, plainLabels, 'plainMix');
    let musicFinal: string;
    if (duckFinal && plainMix) {
      musicParts.push(`${duckFinal}${plainMix}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[musicMix]`);
      musicFinal = '[musicMix]';
    } else {
      musicFinal = duckFinal || plainMix;
    }

    musicParts.push(`${convLabel}${musicFinal}amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`);
    musicParts.push(`[mixed]${loudnormClause(targetLufs, opts.loudnorm ?? {})}[final]`);
    graph += ';' + musicParts.join(';');
    audioLabel = '[final]';
  }

  // ---- W3: B-roll V2 overlay compositing ----
  // Applied LAST, on top of the (possibly music-mixed) [vc]/audioLabel, so
  // caption burn and preset postFilter (both applied by the caller after
  // buildFilterGraph returns) land on top of the composited B-roll frame —
  // matching the render/preview parity the spec requires. An overlay-less
  // project never reaches this block's body: `graph`/videoLabel/audioLabel
  // stay byte-for-byte what they were before W3 existed (full regression).
  let videoLabel = '[vc]';
  const activeOverlays = resolvedActiveOverlays(m);
  if (activeOverlays.length > 0) {
    const overlaySrcIds = [...new Set(activeOverlays.map((r) => r.overlay.sourceId))];
    const overlayInputBase = inputPaths.length; // video sources + music, already pushed above
    for (const id of overlaySrcIds) inputPaths.push(srcById.get(id)!.path);

    const ovParts: string[] = [];
    const audioMixLabels: string[] = [];
    activeOverlays.forEach((r, n) => {
      const ov = r.overlay;
      const ovSrc = srcById.get(ov.sourceId)!;
      const idx = overlayInputBase + overlaySrcIds.indexOf(ov.sourceId);
      ovParts.push(overlayVideoClause(idx, n, ov.srcIn, ov.srcOut, r.tlStart, ovSrc.width, ovSrc.height, output.width, output.height, m.fps));
      const composited = `[ovc${n}]`;
      ovParts.push(`${videoLabel}[ov${n}]overlay=enable='between(t,${r.tlStart},${r.tlEnd})'${composited}`);
      videoLabel = composited;

      if (ov.audioMode === 'replace') {
        const silenced = `[arepl${n}]`;
        ovParts.push(`${audioLabel}volume=0:enable='between(t,${r.tlStart},${r.tlEnd})'${silenced}`);
        audioLabel = silenced;
      }
      if (ov.audioMode !== 'mute' && ovSrc.hasAudio) {
        const gain = ov.gainDb ?? OVERLAY_GAIN_DEFAULT;
        ovParts.push(overlayAudioClause(idx, n, ov.srcIn, ov.srcOut, r.tlStart, gain));
        audioMixLabels.push(`[ova${n}]`);
      }
    });
    if (audioMixLabels.length > 0) {
      const allLabels = [audioLabel, ...audioMixLabels];
      ovParts.push(`${allLabels.join('')}amix=inputs=${allLabels.length}:duration=first:dropout_transition=0:normalize=0[ovAudioMix]`);
      audioLabel = '[ovAudioMix]';
    }
    graph += ';' + ovParts.join(';');
  }

  // ---- W8: kit sprite compositing ----
  // Applied last (after B-roll), same "top of the stack" rationale as W3's
  // comment above — captions burn on top of sprites too. A sprite whose
  // asset couldn't be resolved (missing/escaping/unreadable — see
  // resolveKitAssets in kit.ts) is silently skipped here; the caller
  // (renderFinal) already turned that into a warning before calling in, so
  // this stays a pure function of exactly the assets it was HANDED. No
  // sprites (or no `kitAssets` map at all) never reaches this block's body —
  // full regression for every pre-W8 project.
  let spriteInputIndices: number[] | undefined;
  if (opts.kitAssets) {
    const activeSprites = resolvedActiveSprites(m).filter((r) => opts.kitAssets!.has(r.sprite.assetId));
    if (activeSprites.length > 0) {
      const spriteInputBase = inputPaths.length;
      spriteInputIndices = [];
      const spParts: string[] = [];
      activeSprites.forEach((r, n) => {
        const asset = opts.kitAssets!.get(r.sprite.assetId)!;
        inputPaths.push(asset.absPath);
        const idx = spriteInputBase + n;
        spriteInputIndices!.push(idx);
        const geo = spriteGeometry(asset, r.sprite.position, r.sprite.scale, output, { flip: r.sprite.flip });
        spParts.push(spriteVideoClause(idx, n, geo.width, geo.height, { opacity: r.sprite.opacity, flip: r.sprite.flip }));
        const composited = `[svc${n}]`;
        spParts.push(
          `${videoLabel}[sv${n}]overlay=x=${Math.round(geo.x)}:y=${Math.round(geo.y)}:enable='between(t,${r.tlStart},${r.tlEnd})'${composited}`,
        );
        videoLabel = composited;
      });
      graph += ';' + spParts.join(';');
    }
  }

  return { inputPaths, graph, videoLabel, audioLabel, ...(spriteInputIndices ? { spriteInputIndices } : {}) };
}

// ---- W-ANIME: composition-mode filtergraph (background/ambient/sprites, no A-roll) ----

export interface CompositionFilterGraphBuild {
  /** Ordered `-i` inputs: deduped background/ambient/sprite image+video assets first, then one per music item. */
  inputPaths: string[];
  /** Indices into `inputPaths` needing `-loop 1` (still images: resolved kit background/sprite/emote PNGs). */
  loopInputIndices: number[];
  /** Indices into `inputPaths` needing `-stream_loop -1` (looping video backgrounds/ambient). */
  streamLoopInputIndices: number[];
  graph: string;
  videoLabel: string;
  audioLabel: string;
}

/**
 * Composition-mode counterpart to buildFilterGraph (W-ANIME) — a SEPARATE
 * function rather than a branch inside the normal one, so every existing
 * (source-driven) project's filtergraph stays byte-for-byte unaffected (see
 * ops.ts's "composition" section doc for why this split was chosen over
 * teaching segments()/buildFilterGraph itself about composition).
 *
 * Background: each backgroundIntervals() entry becomes its own chain (a
 * `color` generator, a `-loop 1` kit image, or a `-stream_loop -1` looping
 * video — all scaled/cropped "cover"-style to the exact output canvas, no
 * source-dimension probing needed since `force_original_aspect_ratio=
 * increase`+`crop` works from whatever ffmpeg actually decodes) and the
 * intervals are concatenated end-to-end. Ambient: the kit's first
 * `type:'ambient'` asset (opts.ambientAssetId), looped for the WHOLE
 * duration at a fixed low opacity, composited over the background —
 * entirely absent when the kit has none (opts.ambientAssetId undefined).
 * Sprites: same overlay-compositing shape as buildFilterGraph's W8 block,
 * but with motion-aware x/y/scale expressions (spriteMotionPlan) instead of
 * a static position, plus extra crossfade layers for `motion.emoteAt`
 * windows (emoteWindows) sharing the base sprite's motion phase. Audio:
 * dialogue voice clips (MusicItem entries a DialogueItem.voiceMusicId
 * references) are mixed into a synthesized "spoken" track that other music
 * ducks against — the composition-mode analog of a normal project's
 * concatenated A-roll conversation track ([ac]).
 */
export function buildCompositionFilterGraph(
  m: Manifest,
  opts: {
    loudnorm?: { measured?: LoudnormMeasured; printJson?: boolean };
    kitAssets?: Map<string, ResolvedKitAsset>;
    ambientAssetId?: string;
  } = {},
): CompositionFilterGraphBuild {
  if (!m.composition) throw new Error('buildCompositionFilterGraph: manifest has no composition');
  const duration = m.composition.duration;
  const output = m.output ?? { width: m.width, height: m.height };
  const fps = m.fps;

  const inputPaths: string[] = [];
  const loopInputIndices: number[] = [];
  const streamLoopInputIndices: number[] = [];
  const pathIndex = new Map<string, number>(); // dedupe by resolved absolute path
  const addImageInput = (absPath: string): number => {
    const existing = pathIndex.get(absPath);
    if (existing !== undefined) return existing;
    const idx = inputPaths.length;
    inputPaths.push(absPath);
    loopInputIndices.push(idx);
    pathIndex.set(absPath, idx);
    return idx;
  };
  const addVideoLoopInput = (absPath: string): number => {
    const existing = pathIndex.get(absPath);
    if (existing !== undefined) return existing;
    const idx = inputPaths.length;
    inputPaths.push(absPath);
    streamLoopInputIndices.push(idx);
    pathIndex.set(absPath, idx);
    return idx;
  };
  const coverScale = `scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,crop=${output.width}:${output.height}`;

  // ---- background: per-interval color/image/video chain, concatenated ----
  const intervals = backgroundIntervals(m);
  const parts: string[] = [];
  const bgLabels: string[] = [];
  intervals.forEach((iv, i) => {
    const dur = Math.max(1 / fps, iv.t1 - iv.t0);
    const label = `[bgc${i}]`;
    if (iv.ref.type === 'color') {
      parts.push(`color=c=${iv.ref.hex}:s=${output.width}x${output.height}:d=${dur}:r=${fps}${label}`);
    } else if (iv.ref.type === 'asset') {
      const asset = opts.kitAssets?.get(iv.ref.assetId);
      if (!asset) {
        // Unresolved background asset (missing/escaping — see
        // resolveKitAssets, whose warnings the caller already surfaces)
        // degrades to black rather than failing the whole render.
        parts.push(`color=c=black:s=${output.width}x${output.height}:d=${dur}:r=${fps}${label}`);
      } else {
        const idx = addImageInput(asset.absPath);
        parts.push(`[${idx}:v]${coverScale},trim=duration=${dur},setpts=PTS-STARTPTS,fps=${fps}${label}`);
      }
    } else {
      const idx = addVideoLoopInput(iv.ref.path);
      parts.push(`[${idx}:v]${coverScale},trim=duration=${dur},setpts=PTS-STARTPTS,fps=${fps}${label}`);
    }
    bgLabels.push(label);
  });
  if (bgLabels.length === 0) {
    parts.push(`color=c=black:s=${output.width}x${output.height}:d=${duration}:r=${fps}[bgAll]`);
  } else if (bgLabels.length === 1) {
    parts.push(`${bgLabels[0]}null[bgAll]`);
  } else {
    parts.push(`${bgLabels.join('')}concat=n=${bgLabels.length}:v=1:a=0[bgAll]`);
  }
  let videoLabel = '[bgAll]';

  // ---- ambient layer (optional; see kit.ts's firstAmbientAsset) ----
  if (opts.ambientAssetId) {
    const ambient = opts.kitAssets?.get(opts.ambientAssetId);
    if (ambient) {
      const idx = addVideoLoopInput(ambient.absPath);
      parts.push(
        `[${idx}:v]${coverScale},trim=duration=${duration},setpts=PTS-STARTPTS,fps=${fps},format=rgba,colorchannelmixer=aa=${AMBIENT_LAYER_OPACITY}[amb]`,
      );
      parts.push(`${videoLabel}[amb]overlay=x=0:y=0[bgAmb]`);
      videoLabel = '[bgAmb]';
    }
  }

  // ---- sprites (motion-aware; emoteAt crossfade layers on top) ----
  if (opts.kitAssets) {
    const activeSprites = resolvedActiveSprites(m).filter((r) => opts.kitAssets!.has(r.sprite.assetId));
    activeSprites.forEach((r, n) => {
      const sp = r.sprite;
      const asset = opts.kitAssets!.get(sp.assetId)!;
      const geo = spriteGeometry(asset, sp.position, sp.scale, output, { flip: sp.flip });
      const plan = spriteMotionPlan(sp.motion, geo, r.tlStart, r.tlEnd);
      const idx = addImageInput(asset.absPath);
      const chain = [`scale=${Math.max(1, Math.round(geo.width))}:${Math.max(1, Math.round(geo.height))}`];
      if (sp.flip) chain.push('hflip');
      chain.push('format=rgba');
      if (sp.opacity < 0.999) chain.push(`colorchannelmixer=aa=${sp.opacity}`);
      chain.push(...plan.fadeClauses);
      const svLabel = `[spv${n}]`;
      parts.push(`[${idx}:v]${chain.join(',')}${svLabel}`);
      const composited = `[spc${n}]`;
      parts.push(
        `${videoLabel}${svLabel}overlay=x='${plan.xExpr}':y='${plan.yExpr}':enable='between(t,${r.tlStart},${r.tlEnd})'${composited}`,
      );
      videoLabel = composited;

      const windows = emoteWindows(sp.motion?.emoteAt, sp.duration);
      windows.forEach((w, wi) => {
        const emoteAsset = opts.kitAssets!.get(w.assetId);
        if (!emoteAsset) return; // unresolved emote asset — skip this window (warning already surfaced upstream by resolveKitAssets)
        const eGeo = spriteGeometry(emoteAsset, sp.position, sp.scale, output, { flip: sp.flip });
        const eIdx = addImageInput(emoteAsset.absPath);
        const absT0 = r.tlStart + w.t0;
        const absT1 = r.tlStart + w.t1;
        const fd = Math.min(SPRITE_EMOTE_CROSSFADE_SECONDS, (w.t1 - w.t0) / 2);
        const eChain = [`scale=${Math.max(1, Math.round(eGeo.width))}:${Math.max(1, Math.round(eGeo.height))}`];
        if (sp.flip) eChain.push('hflip');
        eChain.push('format=rgba');
        if (sp.opacity < 0.999) eChain.push(`colorchannelmixer=aa=${sp.opacity}`);
        eChain.push(`fade=t=in:st=${absT0}:d=${fd}:alpha=1`, `fade=t=out:st=${Math.max(absT0, absT1 - fd)}:d=${fd}:alpha=1`);
        const evLabel = `[spe${n}_${wi}]`;
        parts.push(`[${eIdx}:v]${eChain.join(',')}${evLabel}`);
        const eComposited = `[spec${n}_${wi}]`;
        // Emote layers reuse the SAME motion x/y expression as the base
        // (phase-locked to r.tlStart), so the expression swap never visibly jumps.
        parts.push(
          `${videoLabel}${evLabel}overlay=x='${plan.xExpr}':y='${plan.yExpr}':enable='between(t,${absT0},${absT1})'${eComposited}`,
        );
        videoLabel = eComposited;
      });
    });
  }

  // ---- audio: dialogue voice clips form the "spoken" track other music ducks against ----
  const music = m.timeline.music ?? [];
  const voiceIds = new Set((m.timeline.dialogue ?? []).map((d) => d.voiceMusicId).filter((id): id is string => Boolean(id)));
  const musicInputBase = inputPaths.length;
  inputPaths.push(...music.map((mu) => mu.path));

  const musicClause = (mu: MusicItem, i: number): string => {
    const inIdx = musicInputBase + i;
    const label = `[mu${i}]`;
    const fd = Math.max(0, mu.fadeIn);
    const fo = Math.max(0, mu.fadeOut);
    parts.push(
      `[${inIdx}:a]atrim=start=${mu.srcIn}:end=${mu.srcIn + mu.duration},asetpts=PTS-STARTPTS,` +
        `volume=${mu.gain}dB,afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, mu.duration - fo)}:d=${fo},` +
        `adelay=${Math.round(mu.tlStart * 1000)}:all=1${label}`,
    );
    return label;
  };
  const voiceLabels: string[] = [];
  const bgDuckLabels: string[] = [];
  const bgPlainLabels: string[] = [];
  music.forEach((mu, i) => {
    const label = musicClause(mu, i);
    if (voiceIds.has(mu.id)) voiceLabels.push(label);
    else (mu.duck ? bgDuckLabels : bgPlainLabels).push(label);
  });

  parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`);
  let acLabel = '[silence]';
  if (voiceLabels.length > 0) {
    parts.push(
      `[silence]${voiceLabels.join('')}amix=inputs=${voiceLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[acVoice]`,
    );
    acLabel = '[acVoice]';
  }

  const targetLufs = m.audioMix?.targetLufs ?? -14;
  const duckMix = mixLabels(parts, bgDuckLabels, 'duckPre');
  let convLabel = acLabel;
  let duckFinal = duckMix;
  if (duckMix) {
    parts.push(`${acLabel}asplit=2[acMain][acKey]`);
    parts.push(`${duckMix}[acKey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1[duckOut]`);
    duckFinal = '[duckOut]';
    convLabel = '[acMain]';
  }
  const plainMix = mixLabels(parts, bgPlainLabels, 'plainMix');
  let musicFinal: string;
  if (duckFinal && plainMix) {
    parts.push(`${duckFinal}${plainMix}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[musicMix]`);
    musicFinal = '[musicMix]';
  } else {
    musicFinal = duckFinal || plainMix;
  }
  let audioLabel: string;
  if (musicFinal) {
    parts.push(`${convLabel}${musicFinal}amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`);
    audioLabel = '[mixed]';
  } else {
    audioLabel = convLabel;
  }
  parts.push(`${audioLabel}${loudnormClause(targetLufs, opts.loudnorm ?? {})}[final]`);
  audioLabel = '[final]';

  return { inputPaths, loopInputIndices, streamLoopInputIndices, graph: parts.join(';'), videoLabel, audioLabel };
}

/**
 * One sprite's video chain: scale the (still-image, `-loop 1`) PNG input to
 * its computed display size, optionally mirror it, force an alpha channel
 * (`format=rgba` — PNGs decode with one already, but this guarantees it
 * survives `scale`), and apply overall opacity via `colorchannelmixer=aa=`
 * (spec's alternative — a `fade=alpha=1` timed fade — isn't needed since
 * SpriteItem carries no fade-duration field, only a constant opacity).
 */
export function spriteVideoClause(
  inputIdx: number,
  n: number,
  displayWidth: number,
  displayHeight: number,
  opts: { opacity?: number; flip?: boolean } = {},
): string {
  const w = Math.max(1, Math.round(displayWidth));
  const h = Math.max(1, Math.round(displayHeight));
  const opacity = opts.opacity ?? 1;
  const parts = [`scale=${w}:${h}`];
  if (opts.flip) parts.push('hflip');
  parts.push('format=rgba');
  if (opacity < 0.999) parts.push(`colorchannelmixer=aa=${opacity}`);
  return `[${inputIdx}:v]${parts.join(',')}[sv${n}]`;
}

/**
 * One overlay's video chain: trim its B-roll source to [srcIn,srcOut), shift
 * its PTS to start at the resolved tlStart (so ffmpeg's `overlay` filter —
 * which samples the overlay input by ITS OWN timestamp — presents the right
 * frame once `between(t,tlStart,tlEnd)` goes true), then scale/pad/crop to
 * the output canvas exactly like a main clip. Overlays have no per-clip crop
 * field (unlike VideoClip) — `cropGeometry(...,undefined)` auto-centers.
 */
export function overlayVideoClause(
  inputIdx: number,
  n: number,
  srcIn: number,
  srcOut: number,
  tlStart: number,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  fps: number,
): string {
  const geo = cropGeometry(srcW, srcH, outW, outH, undefined);
  const cropPart = geo ? `crop=${geo.width}:${geo.height}:${geo.x}:${geo.y},` : '';
  return (
    `[${inputIdx}:v]trim=start=${srcIn}:end=${srcOut},setpts=PTS-STARTPTS+${tlStart}/TB,` +
    `${cropPart}scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,fps=${fps}[ov${n}]`
  );
}

/** One overlay's audio chain for audioMode mix/replace: trim, delay to tlStart, apply gain. */
export function overlayAudioClause(inputIdx: number, n: number, srcIn: number, srcOut: number, tlStart: number, gainDb: number): string {
  return `[${inputIdx}:a]atrim=start=${srcIn}:end=${srcOut},asetpts=PTS-STARTPTS,adelay=${Math.round(tlStart * 1000)}:all=1,volume=${gainDb}dB[ova${n}]`;
}

// ---- Wave M: publish presets ----
//
// A preset picks encode parameters (crf/preset/audio bitrate), an optional
// forced loudnorm target, and an optional post-processing video filter
// (resize) — layered on top of the existing trim+concat(+music) filtergraph
// from buildFilterGraph above, never replacing it. No preset (the default)
// must reproduce the exact ffmpeg args this module emitted before presets
// existed, so `vedit export render` without --preset never regresses.

export type ExportPreset = 'youtube' | 'shorts' | 'x';

/** crf/preset/audio-bitrate defaults matching this module's pre-Wave-M behavior — the "no preset" baseline. */
const DEFAULT_CRF = 18;
const DEFAULT_ENC_PRESET = 'medium';
const DEFAULT_AUDIO_BITRATE = '192k';

export interface ExportPresetPlan {
  crf: number;
  encPreset: string;
  audioBitrate: string;
  /** loudnorm integrated-loudness target to force onto the audio graph even when buildFilterGraph wouldn't add one itself (musicless projects); null = don't force. */
  forceLoudnormI: number | null;
  /** Extra ffmpeg video filter to append after the existing video label (e.g. a resize), or null. */
  postFilter: string | null;
  /** Non-fatal advisories (e.g. duration over a platform's soft limit) — never thrown, only surfaced. */
  warnings: string[];
}

/**
 * Preset -> encode params + post-filter, as a pure function of the current
 * output canvas size and timeline duration (both cheap to compute from the
 * manifest, so the caller passes them in rather than this needing I/O).
 * Throws only for a genuinely unsatisfiable request (shorts on a landscape
 * canvas) — duration overages are warnings, never errors, per spec.
 */
export function planExportPreset(
  preset: ExportPreset,
  output: { width: number; height: number },
  durationSeconds: number,
  targetLufsDefault: number,
): ExportPresetPlan {
  const warnings: string[] = [];
  if (preset === 'youtube') {
    // Resolution untouched (manifest.output, or the source's, wins as-is).
    return { crf: 18, encPreset: 'medium', audioBitrate: '256k', forceLoudnormI: targetLufsDefault, postFilter: null, warnings };
  }
  if (preset === 'shorts') {
    if (!(output.height > output.width)) {
      throw new Error(
        `--preset shorts requires a portrait output (height > width); current output is ${output.width}x${output.height}. ` +
          'Run `vedit reframe 9:16` (or another portrait target) first — shorts will not auto-reframe for you.',
      );
    }
    if (durationSeconds > 60) {
      warnings.push(`duration ${durationSeconds.toFixed(1)}s exceeds the recommended 60s for Shorts`);
    }
    return {
      crf: 20,
      encPreset: 'medium',
      audioBitrate: '192k',
      forceLoudnormI: -14,
      postFilter: 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
      warnings,
    };
  }
  // x
  if (durationSeconds > 140) {
    warnings.push(`duration ${durationSeconds.toFixed(1)}s exceeds the recommended 140s for X`);
  }
  const longEdge = Math.max(output.width, output.height);
  let postFilter: string | null = null;
  if (longEdge > 1280) {
    const scale = 1280 / longEdge;
    const w = Math.max(2, Math.round((output.width * scale) / 2) * 2);
    const h = Math.max(2, Math.round((output.height * scale) / 2) * 2);
    postFilter = `scale=${w}:${h}`;
  }
  return { crf: 23, encPreset: 'medium', audioBitrate: '128k', forceLoudnormI: null, postFilter, warnings };
}

/** Explicit per-call overrides — these beat whatever the preset would otherwise pick. */
export interface RenderParamOverrides {
  preset?: ExportPreset;
  crf?: number;
  encPreset?: string;
  audioBitrate?: string;
}

/**
 * Resolve the final encode params for a render: preset-derived values with
 * explicit overrides taking precedence, falling back to the pre-Wave-M
 * hardcoded defaults when no preset (and no override) is given at all — the
 * "regression zero" contract for `vedit export render` without --preset.
 */
export function resolveRenderParams(m: Manifest, opts: RenderParamOverrides = {}): ExportPresetPlan {
  const output = m.output ?? { width: m.width, height: m.height };
  const plan = opts.preset
    ? planExportPreset(opts.preset, output, timelineDuration(m), m.audioMix?.targetLufs ?? -14)
    : null;
  return {
    crf: opts.crf ?? plan?.crf ?? DEFAULT_CRF,
    encPreset: opts.encPreset ?? plan?.encPreset ?? DEFAULT_ENC_PRESET,
    audioBitrate: opts.audioBitrate ?? plan?.audioBitrate ?? DEFAULT_AUDIO_BITRATE,
    forceLoudnormI: plan?.forceLoudnormI ?? null,
    postFilter: plan?.postFilter ?? null,
    warnings: plan?.warnings ?? [],
  };
}

/**
 * Build `-i` args for `inputPaths`, prefixing `-loop 1` before any index
 * listed in `loopIndices` (W8 sprite PNGs — a still image needs looping to
 * behave like a continuous stream for the duration `overlay`'s `enable`
 * window needs it) and `-stream_loop -1` before any index in
 * `streamLoopIndices` (W-ANIME: a looping background/ambient VIDEO file,
 * which may be shorter than the interval it needs to fill — see
 * buildCompositionFilterGraph). Absent/empty `loopIndices`/
 * `streamLoopIndices` produces the exact same flat `-i p -i p ...` sequence
 * as before W8/W-ANIME — no regression for sprite-less/composition-less
 * projects.
 */
function ffmpegInputArgs(inputPaths: string[], loopIndices?: number[], streamLoopIndices?: number[]): string[] {
  const loopSet = new Set(loopIndices ?? []);
  const streamLoopSet = new Set(streamLoopIndices ?? []);
  const out: string[] = [];
  inputPaths.forEach((p, i) => {
    if (loopSet.has(i)) out.push('-loop', '1');
    if (streamLoopSet.has(i)) out.push('-stream_loop', '-1');
    out.push('-i', p);
  });
  return out;
}

/**
 * Run a measurement-only ffmpeg pass (`-f null -`) for a `print_format=json`
 * loudnorm filter and parse the JSON stats block it prints to stderr —
 * pass 1 of 2-pass loudnorm normalization. Only audio needs to be mapped;
 * ffmpeg doesn't decode/encode the unmapped video side of the graph.
 */
async function measureLoudnorm(
  inputPaths: string[],
  graph: string,
  audioLabel: string,
  videoLabel: string,
  spriteInputIndices?: number[],
): Promise<LoudnormMeasured> {
  const inputs = ffmpegInputArgs(inputPaths, spriteInputIndices);
  const { stderr } = await runCapture('ffmpeg', [
    '-y', ...inputs,
    // ffmpeg refuses a graph with an unconnected named output — it does NOT
    // prune the unmapped video side. Terminate it in-graph instead.
    '-filter_complex', `${graph};${videoLabel}nullsink`,
    '-map', audioLabel,
    '-f', 'null', '-',
  ]);
  // loudnorm's print_format=json block is a flat (non-nested) JSON object
  // logged to stderr; take the last brace-delimited block in case earlier
  // ffmpeg log lines happen to contain braces.
  const matches = stderr.match(/\{[^{}]*\}/g);
  const jsonStr = matches?.[matches.length - 1];
  if (!jsonStr) {
    throw new Error(
      'loudnorm measurement pass produced no parseable stats; retry with --fast-loudnorm to skip 2-pass normalization',
    );
  }
  const j = JSON.parse(jsonStr);
  return {
    input_i: String(j.input_i),
    input_tp: String(j.input_tp),
    input_lra: String(j.input_lra),
    input_thresh: String(j.input_thresh),
    target_offset: String(j.target_offset),
  };
}

/**
 * Final render from ORIGINAL sources (not proxies): trim+concat filtergraph,
 * optional music mix/duck, optional conversational-audio repair chain
 * (manifest.audioRepair), final-stage loudness normalization (2-pass by
 * default — measure then apply; `--fast-loudnorm`/`fastLoudnorm` falls back
 * to the old 1-pass application), optional ASS caption burn, optional
 * publish preset (encode params + forced loudnorm target + resize). Motion
 * overlays are not baked yet (preview-only for now; on NLE export they
 * travel as markers + spec sidecars).
 *
 * Regression contract: with no `--preset`, no `manifest.audioRepair` (or an
 * explicit `preset: 'off'`), and no music, this produces the exact same
 * ffmpeg filtergraph as before loudnorm/repair existed — no loudnorm filter
 * at all, audio chain unchanged.
 */
export async function renderFinal(
  m: Manifest,
  transcripts: Transcript[],
  outPath: string,
  opts: { burnCaptions?: boolean; fastLoudnorm?: boolean; noRepair?: boolean } & RenderParamOverrides = {},
): Promise<{ file: string; warnings: string[] }> {
  // --no-repair (dry-audio A/B): disable the repair chain for this render
  // only, without touching the manifest's saved setting.
  const effectiveM: Manifest = opts.noRepair ? { ...m, audioRepair: undefined } : m;
  const params = resolveRenderParams(effectiveM, opts);
  for (const w of params.warnings) console.error(`警告: ${w}`);

  const musicless = (effectiveM.timeline.music ?? []).length === 0;
  const repairActive = buildRepairChain(effectiveM.audioRepair) !== '';
  const fast = Boolean(opts.fastLoudnorm);
  // Regression clause: nothing (preset / repair / music) actually wants
  // normalization -> skip loudnorm entirely, exactly like before W1.
  const wantsLoudnorm = !musicless || params.forceLoudnormI !== null || repairActive;
  const musiclessTarget = params.forceLoudnormI ?? (effectiveM.audioMix?.targetLufs ?? -14);

  // ---- W8: kit (styles/sprites) — best-effort load ----
  // A missing/corrupt kit.json degrades to "no kit" (warning, not a thrown
  // error): the kit dir is external/shared and may have moved or been
  // edited concurrently, and a render shouldn't fail over stale style/
  // sprite decoration. Every project without `manifest.kit` set never
  // enters this block at all — full regression.
  const warnings = [...params.warnings];
  let kit: import('../core/types.js').KitFile | null = null;
  if (effectiveM.kit) {
    try {
      kit = await readKitFile(effectiveM.kit.path);
    } catch (e: any) {
      warnings.push(`kit: ${e?.message ?? e} — rendering without kit styles/sprites`);
    }
  }
  let kitAssets: Map<string, ResolvedKitAsset> | undefined;
  if (kit && effectiveM.kit) {
    const spriteAssetIds = (effectiveM.timeline.sprites ?? []).map((s) => s.assetId);
    if (spriteAssetIds.length > 0) {
      const { resolved, warnings: assetWarnings } = await resolveKitAssets(effectiveM.kit.path, kit, spriteAssetIds);
      kitAssets = resolved;
      warnings.push(...assetWarnings);
    }
  }

  let measured: LoudnormMeasured | undefined;
  if (wantsLoudnorm && !fast) {
    const measureBuilt = buildFilterGraph(effectiveM, { loudnorm: { printJson: true }, kitAssets });
    let measureGraph = measureBuilt.graph;
    let measureLabel = measureBuilt.audioLabel;
    if (musicless) {
      // Music-present graphs already end their own loudnorm(print_format=
      // json) inside buildFilterGraph above; musicless ones need it appended.
      measureGraph += `;${measureLabel}${loudnormClause(musiclessTarget, { printJson: true })}[measure]`;
      measureLabel = '[measure]';
    }
    measured = await measureLoudnorm(
      measureBuilt.inputPaths, measureGraph, measureLabel, measureBuilt.videoLabel, measureBuilt.spriteInputIndices,
    );
  }

  const loudnormOpts = fast || !wantsLoudnorm ? {} : { measured };
  const built = buildFilterGraph(effectiveM, { loudnorm: loudnormOpts, kitAssets });
  let graph = built.graph;
  const inputs = ffmpegInputArgs(built.inputPaths, built.spriteInputIndices);

  let assPath: string | null = null;
  if (opts.burnCaptions && effectiveM.captions.enabled && !ffmpegHasFilter('ass')) {
    throw new Error(
      'this ffmpeg build lacks the `ass` filter (caption burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or export without --burn-captions.',
    );
  }
  let vLabel = built.videoLabel;
  if (opts.burnCaptions && effectiveM.captions.enabled) {
    assPath = path.join(path.dirname(outPath), '.vedit-captions.ass');
    await fs.writeFile(assPath, toAss(effectiveM, transcripts, kit));
    // W8: point libass at the kit's font directory (fontsdir=) instead of
    // `--attach`ing the font, so the ASS Fontname (the font FILE's basename,
    // see kitAssStyle in toAss) actually resolves. No kit style in use (or
    // no font on it) -> fontsdirPart stays '' -> byte-for-byte the same ass
    // filter clause as before W8.
    let fontsdirPart = '';
    const activeKitStyle = kit?.styles?.find((s) => s.id === effectiveM.captions.style);
    // W-CAP: overrides.font may itself be a kit font FILE reference (rather
    // than a system family name) — it takes priority over the active kit
    // style's own caption.font when it resolves to one, since it's the more
    // specific/recent choice. Neither present (or no kit linked) leaves
    // fontsdirPart '' exactly like before W-CAP existed.
    const overrideFont = effectiveM.captions.overrides?.font;
    if (effectiveM.kit) {
      let fontDir: string | null = null;
      if (overrideFont) {
        const resolved = await resolveKitFontFile(effectiveM.kit.path, overrideFont).catch(() => null);
        if (resolved) fontDir = path.dirname(resolved);
      }
      if (!fontDir && activeKitStyle?.caption?.font) {
        try {
          const fontAbs = await resolveWithinDir(effectiveM.kit.path, activeKitStyle.caption.font);
          fontDir = path.dirname(fontAbs);
        } catch (e: any) {
          warnings.push(`kit style ${activeKitStyle.id}: font path invalid (${activeKitStyle.caption.font}) — captions burn without the kit font`);
        }
      }
      if (fontDir) fontsdirPart = `:fontsdir='${fontDir.replace(/'/g, "\\'")}'`;
    }
    // W-CAP: overrides.font that resolved to neither a kit font file (above)
    // nor a recognized system font family is very likely a typo — surface it
    // as a warning rather than silently falling back to libass's default
    // font. staticChecks (qc.ts) is untouched by this; it's purely a
    // render-time advisory.
    if (overrideFont && !fontsdirPart) {
      const family = path.basename(overrideFont, path.extname(overrideFont));
      const systemFonts = await listSystemFonts(null).catch(() => []);
      const known = systemFonts.some(
        (f) => f.family.toLowerCase() === family.toLowerCase() || f.family.toLowerCase() === overrideFont.toLowerCase(),
      );
      if (!known) {
        warnings.push(
          `caption font "${overrideFont}" was not found in the linked kit's fonts/ directory or common system font locations — burned captions may fall back to a default font`,
        );
      }
    }
    graph += `;${built.videoLabel}ass='${assPath.replace(/'/g, "\\'")}'${fontsdirPart}[vout]`;
    vLabel = '[vout]';
  }

  // Musicless loudnorm (preset-forced and/or repair-triggered) is applied
  // here, after the base graph — the music-present case already baked its
  // loudnorm into `built` above via buildFilterGraph's own loudnorm opts.
  let audioLabel = built.audioLabel;
  if (musicless && wantsLoudnorm) {
    const clause = fast ? loudnormClause(musiclessTarget) : loudnormClause(musiclessTarget, { measured });
    graph += `;${audioLabel}${clause}[presetAudio]`;
    audioLabel = '[presetAudio]';
  }

  if (params.postFilter) {
    graph += `;${vLabel}${params.postFilter}[presetVideo]`;
    vLabel = '[presetVideo]';
  }

  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', graph,
    '-map', vLabel, '-map', audioLabel,
    '-c:v', 'libx264', '-preset', params.encPreset, '-crf', String(params.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', params.audioBitrate,
    '-dn', // drop any data streams (e.g. DJI tmcd) that survived the filtergraph
    '-movflags', '+faststart',
    outPath,
  ]);
  if (assPath) await fs.rm(assPath, { force: true });
  return { file: outPath, warnings };
}

/**
 * Composition-mode counterpart to renderFinal (W-ANIME) — background +
 * ambient + motion-aware sprites + dialogue speech bubbles, no A-roll at
 * all. Dialogue is ALWAYS burned in via the same toAss()/`ass` ffmpeg
 * filter captions use (there is no other way for a DialogueItem to reach
 * the rendered output); a project with no dialogue items skips the ass
 * filter entirely (dialogueAssLines returns []). Unlike renderFinal, this
 * does not run a 2-pass loudnorm measurement pass — a single-pass loudnorm
 * target is applied directly (see the W-ANIME implementation report for
 * why this was judged an acceptable simplification for a first cut).
 */
export async function renderComposition(
  m: Manifest,
  outPath: string,
  opts: RenderParamOverrides = {},
): Promise<{ file: string; warnings: string[] }> {
  if (!m.composition) throw new Error('renderComposition: manifest has no composition');
  const params = resolveRenderParams(m, opts);
  const warnings = [...params.warnings];

  let kit: KitFile | null = null;
  if (m.kit) {
    try {
      kit = await readKitFile(m.kit.path);
    } catch (e: any) {
      warnings.push(`kit: ${e?.message ?? e} — rendering without kit background/sprites/styles`);
    }
  }

  let kitAssets: Map<string, ResolvedKitAsset> | undefined;
  let ambientAssetId: string | undefined;
  if (kit && m.kit) {
    const ids = new Set<string>();
    for (const s of m.timeline.sprites ?? []) {
      ids.add(s.assetId);
      for (const e of s.motion?.emoteAt ?? []) ids.add(e.assetId);
    }
    const bgRef = m.composition.background;
    if (bgRef.type === 'asset') ids.add(bgRef.assetId);
    for (const e of m.composition.backgroundTrack ?? []) if (e.ref.type === 'asset') ids.add(e.ref.assetId);
    const ambient = firstAmbientAsset(kit);
    if (ambient) {
      ambientAssetId = ambient.id;
      ids.add(ambient.id);
    }
    const { resolved, warnings: assetWarnings } = await resolveKitAssets(m.kit.path, kit, ids);
    kitAssets = resolved;
    warnings.push(...assetWarnings);
  }

  const built = buildCompositionFilterGraph(m, { kitAssets, ambientAssetId });
  let graph = built.graph;
  const inputs = ffmpegInputArgs(built.inputPaths, built.loopInputIndices, built.streamLoopInputIndices);

  let vLabel = built.videoLabel;
  let assPath: string | null = null;
  const hasDialogue = (m.timeline.dialogue ?? []).length > 0;
  if (hasDialogue) {
    if (!ffmpegHasFilter('ass')) {
      throw new Error(
        'this ffmpeg build lacks the `ass` filter (dialogue burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG.',
      );
    }
    assPath = path.join(path.dirname(outPath), '.vedit-dialogue.ass');
    await fs.writeFile(assPath, toAss(m, [], kit));
    let fontsdirPart = '';
    const activeKitStyle = kit?.styles?.find((s) => s.id === m.captions.style);
    if (m.kit && activeKitStyle?.caption?.font) {
      try {
        const fontAbs = await resolveWithinDir(m.kit.path, activeKitStyle.caption.font);
        fontsdirPart = `:fontsdir='${path.dirname(fontAbs).replace(/'/g, "\\'")}'`;
      } catch {
        warnings.push(`kit style ${activeKitStyle.id}: font path invalid (${activeKitStyle.caption.font}) — dialogue burns without the kit font`);
      }
    }
    graph += `;${built.videoLabel}ass='${assPath.replace(/'/g, "\\'")}'${fontsdirPart}[vout]`;
    vLabel = '[vout]';
  }

  if (params.postFilter) {
    graph += `;${vLabel}${params.postFilter}[presetVideo]`;
    vLabel = '[presetVideo]';
  }

  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', graph,
    '-map', vLabel, '-map', built.audioLabel,
    '-t', String(m.composition.duration),
    '-c:v', 'libx264', '-preset', params.encPreset, '-crf', String(params.crf),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', params.audioBitrate,
    '-dn',
    '-movflags', '+faststart',
    outPath,
  ]);
  if (assPath) await fs.rm(assPath, { force: true });
  return { file: outPath, warnings };
}
