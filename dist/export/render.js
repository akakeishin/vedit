import path from 'node:path';
import { promises as fs } from 'node:fs';
import { backgroundIntervals, cropGeometry, emoteWindows, overlayGeometryWarnings, OVERLAY_GAIN_DEFAULT, resolvedActiveOverlays, resolvedActiveSprites, segments, sliceTimelineRange, SPRITE_EMOTE_CROSSFADE_SECONDS, spriteGeometry, spriteMotionPlan, timelineDuration, } from '../core/ops.js';
import { captionCues, captionCuesWithExclusions, formatCaptionExclusionWarning } from '../core/captions.js';
import { AMBIENT_LAYER_OPACITY, deriveSpeechBubbleStyle, firstAmbientAsset, readKitFile, resolveKitAssets, } from '../core/kit.js';
import { resolveWithinDir } from '../core/project.js';
import { listSystemFonts, resolveKitFontFile } from '../core/fonts.js';
import { buildColorChain } from './color.js';
import { buildMotionAss } from './motion.js';
import { ffmpegHasFilter, run, runCapture } from '../ingest/run.js';
function assTime(t) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${h}:${String(m).padStart(2, '0')}:${s}`;
}
export const ASS_STYLE_PRESETS = {
    clean: { primary: '&H00FFFFFF', outline: '&H00101010', back: '&H80000000', bold: 0, borderStyle: 1, outlineWidth: 3, shadow: 1 },
    bold: { primary: '&H005CE4FF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 3, outlineWidth: 0, shadow: 0 },
    outline: { primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: 0, borderStyle: 1, outlineWidth: 3, shadow: 1 },
    boxed: { primary: '&H00FFFFFF', outline: '&H00101010', back: '&H00000000', bold: 0, borderStyle: 3, outlineWidth: 0, shadow: 2 },
};
// ---- W8: kit style -> ASS style (palette hex -> BGR, font file -> fontname, size_1080p -> scaled fontsize) ----
/** "#RRGGBB" or "#RGB" -> ASS's BBGGRR hex (no leading &H/alpha — callers prefix those). Garbage input falls back to white. */
function hexToBgr(hex) {
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3)
        h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h))
        return 'FFFFFF';
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    return (b + g + r).toUpperCase();
}
function assColor(hex, fallbackBgr, alphaHex = '00') {
    return `&H${alphaHex}${hex ? hexToBgr(hex) : fallbackBgr}`;
}
/** 0..1 opacity -> ASS alpha hex (00 = opaque, FF = fully transparent — inverted from "opacity"). */
function opacityToAlphaHex(opacity, fallbackHex) {
    if (opacity === undefined || !Number.isFinite(opacity))
        return fallbackHex;
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
function kitAssStyle(style, outputHeight) {
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
 *
 * libass draws the BorderStyle=3 box in the OUTLINE colour, padded by the
 * Outline width — Outline=0 draws no box at all (plain floating text), so
 * the bubble fill must go in `outline` with a real width; the bubble's own
 * outline colour survives only as the Shadow box (a small offset accent).
 */
function speechBubbleAssStyle(bubble, outputHeight) {
    const fontsize = Math.round(outputHeight * 0.04);
    return {
        primary: assColor(bubble.palette.text, '111111'),
        outline: assColor(bubble.palette.box, 'FFFFFF'),
        back: assColor(bubble.palette.outline, '111111'),
        bold: 0,
        borderStyle: 3,
        outlineWidth: Math.round(fontsize * 0.4),
        shadow: 2,
        fontsize,
    };
}
/**
 * Pixel anchor for one dialogue line's speech bubble: a manual `pos` (0..1
 * normalized canvas position — see DialogueItem's doc), when set, always
 * wins; otherwise above the referenced sprite's head (via the SAME
 * spriteGeometry math render/web use for placement) when `spriteId`
 * resolves to both a real sprite AND its kit asset, else a fixed top-center
 * default. Pure given an already-loaded `kit` (or none).
 */
function dialogueAnchorPixels(m, d, kit, output) {
    if (d.pos)
        return { x: d.pos.x * output.width, y: d.pos.y * output.height };
    const sprite = d.spriteId ? (m.timeline.sprites ?? []).find((s) => s.id === d.spriteId) : undefined;
    const asset = sprite ? kit?.assets?.find((a) => a.id === sprite.assetId) : undefined;
    if (sprite && asset) {
        const geo = spriteGeometry(asset, sprite.position, sprite.scale, output, { flip: sprite.flip });
        // geo.y is the FULL image's top — transparent headroom included — so the
        // bubble must anchor off the visible top (y0 into the full height) or it
        // floats far above characters whose PNGs have padding above the head.
        const visibleTop = geo.y + (asset.visible_bounds_normalized?.y0 ?? 0) * geo.height;
        return { x: geo.anchorX, y: Math.max(output.height * 0.08, visibleTop - output.height * 0.04) };
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
function dialogueAssLines(m, kit, output) {
    return (m.timeline.dialogue ?? []).map((d) => {
        const { x, y } = dialogueAnchorPixels(m, d, kit, output);
        const text = `{\\an5\\pos(${Math.round(x)},${Math.round(y)})}${d.text.replace(/\n/g, '\\N')}`;
        return `Dialogue: 0,${assTime(d.tlStart)},${assTime(d.tlStart + d.duration)},${DIALOGUE_STYLE_NAME},,0,0,0,,${text}`;
    });
}
/** Split an ASS `&HAABBGGRR` colour string into its alpha and BGR components (uppercase hex). Malformed input falls back to opaque white. */
function parseAssColor(ass) {
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
function applyCaptionOverrides(preset, overrides, defaultFontSize) {
    const out = { ...preset };
    const palette = overrides.palette;
    if (palette?.text)
        out.primary = `&H00${hexToBgr(palette.text)}`;
    if (palette?.outline)
        out.outline = `&H00${hexToBgr(palette.outline)}`;
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
    if (overrides.font)
        out.fontname = path.basename(overrides.font, path.extname(overrides.font));
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
 *
 * `opts.includeCaptions` (default true): set to `false` to omit caption
 * cues entirely while still emitting dialogue `Dialogue:` lines — this is
 * how renderFinal produces a dialogue-only burn (captions.enabled=false, or
 * --no-burn-captions with dialogue on the timeline) without a second ASS
 * document. Every existing caller omits this option, so the default (true)
 * reproduces the exact pre-existing output — full regression.
 */
export function toAss(m, transcripts, kit, opts = {}) {
    const includeCaptions = opts.includeCaptions ?? true;
    const cues = includeCaptions ? captionCues(m, transcripts) : [];
    const { width, height } = m.output ?? { width: m.width, height: m.height };
    const defaultFontSize = Math.round(height * 0.045);
    const defaultMarginV = Math.round(height * 0.06);
    const presets = { ...ASS_STYLE_PRESETS };
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
        const dialogueKitStyle = kit?.styles?.find((s) => (s.use_for ?? []).some((u) => u === 'dialogue' || u === 'speech-bubble')) ?? kitStyle;
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
    const lines = cues.map((c) => `Dialogue: 0,${assTime(c.tlStart)},${assTime(c.tlEnd)},${activeStyle},,0,0,0,,${c.text.replace(/\n/g, '\\N')}`);
    const dialogueLines = dialogue.length > 0 ? dialogueAssLines(m, kit, { width, height }) : [];
    return head + [...lines, ...dialogueLines].join('\n') + '\n';
}
// ---- W1: conversational-audio repair chain ----
const REPAIR_PRESETS = {
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
export function buildRepairChain(repair) {
    if (!repair || repair.preset === 'off')
        return '';
    const cfg = REPAIR_PRESETS[repair.preset];
    if (!cfg)
        return '';
    const parts = [`highpass=f=${cfg.highpass}`, `afftdn=nr=${cfg.nr}:nf=${cfg.nf}`];
    if (repair.deess)
        parts.push('deesser');
    parts.push('acompressor=threshold=-18dB:ratio=3:attack=20:release=250');
    return parts.join(',');
}
/**
 * Build a `loudnorm` filter clause (no brackets): the plain single-pass
 * form by default, a `print_format=json` measurement-pass form when
 * `printJson` is set, or a 2nd-pass form fed with 1st-pass `measured`
 * values. Pure/testable independent of actually running ffmpeg.
 */
export function loudnormClause(target, opts = {}) {
    if (opts.printJson)
        return `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`;
    if (opts.measured) {
        const m = opts.measured;
        return (`loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:` +
            `measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`);
    }
    return `loudnorm=I=${target}:TP=-1.5:LRA=11`;
}
/** Mix `labels` into one stream via `amix`, or pass a lone label through unchanged. Appends any needed clause to `parts`. */
function mixLabels(parts, labels, tag) {
    if (labels.length === 0)
        return '';
    if (labels.length === 1)
        return labels[0];
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
export function buildFilterGraph(m, opts = {}) {
    const segs = segments(m);
    if (segs.length === 0)
        throw new Error('empty timeline');
    const srcIds = [...new Set(segs.map((s) => s.sourceId))];
    const srcById = new Map(m.sources.map((s) => [s.id, s]));
    // Roadmap "クリップ単位の音量・ミュート": looked up per-segment via
    // seg.clipId below (each Segment carries the originating VideoClip.id —
    // see segments() in ops.ts) so a clip's gainDb/muted override applies to
    // exactly its own audio, not neighboring clips from the same source.
    const clipById = new Map(m.timeline.video.map((c) => [c.id, c]));
    const music = m.timeline.music ?? [];
    const inputPaths = [...srcIds.map((id) => srcById.get(id).path), ...music.map((mu) => mu.path)];
    const musicInputBase = srcIds.length;
    const output = m.output ?? { width: m.width, height: m.height };
    const crossfadeMs = m.audioMix?.crossfadeMs ?? 12;
    const xfade = Math.max(0, crossfadeMs) / 1000;
    const repairChain = buildRepairChain(m.audioRepair);
    const parts = [];
    const labels = [];
    segs.forEach((seg, i) => {
        const idx = srcIds.indexOf(seg.sourceId);
        const src = srcById.get(seg.sourceId);
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
        parts.push(`[${idx}:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,${colorPart}${cropPart}scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2,fps=${m.fps}[v${i}]`);
        if (src.hasAudio) {
            // A razor join between segments clicks; acrossfade would fix that but
            // shifts audio relative to video across the join (unacceptable for a
            // dialogue-driven cut). Fading each segment's own head/tail instead
            // fixes the click without moving anything in time.
            const fd = Math.min(xfade, dur / 2);
            const fadePart = fd > 1e-4 ? `,afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, dur - fd)}:d=${fd}` : '';
            const repairPart = repairChain ? `,${repairChain}` : '';
            // Roadmap "クリップ単位の音量・ミュート": muted wins over gainDb (no
            // need to also clear a previously-set gain to silence a clip); a clip
            // with neither set produces '' here — byte-for-byte the same chain as
            // before this feature existed.
            const clip = clipById.get(seg.clipId);
            const clipAudioPart = clip?.muted ? ',volume=0' : clip?.gainDb ? `,volume=${clip.gainDb}dB` : '';
            parts.push(`[${idx}:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS${repairPart}${fadePart}${clipAudioPart}[a${i}]`);
        }
        else {
            parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${dur}[a${i}]`);
        }
        labels.push(`[v${i}][a${i}]`);
    });
    let graph = parts.join(';') + `;${labels.join('')}concat=n=${segs.length}:v=1:a=1[vc][ac]`;
    let audioLabel = '[ac]';
    if (music.length > 0) {
        const duckAmount = m.audioMix?.duckAmount ?? -10;
        const targetLufs = m.audioMix?.targetLufs ?? -14;
        const musicParts = [];
        const duckLabels = [];
        const plainLabels = [];
        music.forEach((mu, i) => {
            const inIdx = musicInputBase + i;
            const label = `[mu${i}]`;
            const fd = Math.max(0, mu.fadeIn);
            const fo = Math.max(0, mu.fadeOut);
            musicParts.push(`[${inIdx}:a]atrim=start=${mu.srcIn}:end=${mu.srcIn + mu.duration},asetpts=PTS-STARTPTS,` +
                `volume=${mu.gain}dB,afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, mu.duration - fo)}:d=${fo},` +
                `adelay=${Math.round(mu.tlStart * 1000)}:all=1${label}`);
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
            musicParts.push(`${duckMix}[acKey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400:makeup=1[duckOut]`);
            duckFinal = '[duckOut]';
            convLabel = '[acMain]';
        }
        const plainMix = mixLabels(musicParts, plainLabels, 'plainMix');
        let musicFinal;
        if (duckFinal && plainMix) {
            musicParts.push(`${duckFinal}${plainMix}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[musicMix]`);
            musicFinal = '[musicMix]';
        }
        else {
            musicFinal = duckFinal || plainMix;
        }
        musicParts.push(`${convLabel}${musicFinal}amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`);
        musicParts.push(`[mixed]${loudnormClause(targetLufs, opts.loudnorm ?? {})}[final]`);
        graph += ';' + musicParts.join(';');
        audioLabel = '[final]';
    }
    // ---- W3: B-roll V2 overlay compositing, generalized into a multi-layer
    // ---- "overlay stack" (オーバーレイ・スタック) ----
    // Applied LAST, on top of the (possibly music-mixed) [vc]/audioLabel, so
    // caption burn and preset postFilter (both applied by the caller after
    // buildFilterGraph returns) land on top of the composited overlay stack —
    // matching the render/preview parity the spec requires. An overlay-less
    // project never reaches this block's body: `graph`/videoLabel/audioLabel
    // stay byte-for-byte what they were before W3 existed (full regression).
    // `activeOverlays` is already sorted (layer asc, then tlStart — see
    // resolvedActiveOverlays) so simply compositing in array order IS the
    // z-order the spec requires ("layer 昇順に構築"); every pre-existing
    // project has every overlay on layer 1 (overlayLayerOf's default), so this
    // collapses to the original tlStart-only order — no regression.
    let videoLabel = '[vc]';
    // Overlay image sources (Source.kind:'image') need `-loop 1` on their
    // ffmpeg `-i`, same mechanism as W8 sprite PNGs below — collected here and
    // merged with the sprite block's own indices into a single array (returned
    // as `spriteInputIndices` for back-compat with existing callers/tests;
    // the field is really "still-image inputs needing -loop 1", sprites were
    // just the only source of those before this feature existed).
    const loopInputIndices = [];
    const activeOverlays = resolvedActiveOverlays(m);
    if (activeOverlays.length > 0) {
        const overlaySrcIds = [...new Set(activeOverlays.map((r) => r.overlay.sourceId))];
        const overlayInputBase = inputPaths.length; // video sources + music, already pushed above
        for (const id of overlaySrcIds) {
            const s = srcById.get(id);
            inputPaths.push(s.path);
            if (s.kind === 'image')
                loopInputIndices.push(inputPaths.length - 1);
        }
        const ovParts = [];
        const audioMixLabels = [];
        activeOverlays.forEach((r, n) => {
            const ov = r.overlay;
            const ovSrc = srcById.get(ov.sourceId);
            const idx = overlayInputBase + overlaySrcIds.indexOf(ov.sourceId);
            const fxOpts = { rect: ov.rect, opacity: ov.opacity, fade: ov.fade };
            if (ovSrc.kind === 'image') {
                ovParts.push(overlayImageVideoClause(idx, n, ovSrc.width, ovSrc.height, output.width, output.height, m.fps, ov.srcOut - ov.srcIn, fxOpts));
            }
            else {
                ovParts.push(overlayVideoClause(idx, n, ov.srcIn, ov.srcOut, r.tlStart, ovSrc.width, ovSrc.height, output.width, output.height, m.fps, fxOpts));
            }
            const composited = `[ovc${n}]`;
            const posPart = ov.rect
                ? (() => {
                    const geo = overlayRectGeometry(ov.rect, ovSrc.width, ovSrc.height, output.width, output.height);
                    return `x=${geo.x}:y=${geo.y}:`;
                })()
                : '';
            // shortest=1 (image-kind sources only): a `-loop 1` still-image input
            // is infinite from ffmpeg's own perspective — it never reaches EOF, so
            // `overlay`'s default eof_action (which only fires on the SECONDARY
            // input's own EOF) never triggers and the whole render hangs forever
            // on a REAL ffmpeg run (verified empirically — the mocked-ffmpeg unit
            // tests below can't catch this at all). `shortest=1` forces the filter
            // to end at the shorter of its two inputs; since the looped image is
            // always the longer one, this safely reproduces exactly the main
            // branch's own natural length, every time. Deliberately NOT applied to
            // a video-kind overlay: a finite B-roll clip shorter than the
            // remaining timeline is SUPPOSED to just stop being drawn (the
            // `enable` gate already handles that) without truncating the render —
            // `shortest=1` there would wrongly cut the whole output short at the
            // B-roll's own end.
            const shortestPart = ovSrc.kind === 'image' ? 'shortest=1:' : '';
            ovParts.push(`${videoLabel}[ov${n}]overlay=${posPart}${shortestPart}enable='between(t,${r.tlStart},${r.tlEnd})'${composited}`);
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
    if (opts.kitAssets) {
        const activeSprites = resolvedActiveSprites(m).filter((r) => opts.kitAssets.has(r.sprite.assetId));
        if (activeSprites.length > 0) {
            const spriteInputBase = inputPaths.length;
            const spParts = [];
            activeSprites.forEach((r, n) => {
                const asset = opts.kitAssets.get(r.sprite.assetId);
                inputPaths.push(asset.absPath);
                const idx = spriteInputBase + n;
                loopInputIndices.push(idx);
                const geo = spriteGeometry(asset, r.sprite.position, r.sprite.scale, output, { flip: r.sprite.flip });
                spParts.push(spriteVideoClause(idx, n, geo.width, geo.height, { opacity: r.sprite.opacity, flip: r.sprite.flip }));
                const composited = `[svc${n}]`;
                // shortest=1: a sprite's `-loop 1` PNG input is unconditionally
                // infinite (no video-vs-image branch needed here, unlike the W3
                // overlay-stack block above — every sprite input IS a still image).
                // Pre-existing bug fix (found while building this feature's real-
                // ffmpeg verification, see the sibling comment on the overlay-stack
                // `overlay=` call above for the full explanation): without this, a
                // NORMAL (non-composition) project with ANY sprite hangs forever on
                // a real `vedit export render` — `renderComposition`'s own sprite/
                // background loop inputs are unaffected (a hard `-t` bound already
                // protects that separate code path), so this fix is scoped to just
                // this call site.
                spParts.push(`${videoLabel}[sv${n}]overlay=x=${Math.round(geo.x)}:y=${Math.round(geo.y)}:shortest=1:enable='between(t,${r.tlStart},${r.tlEnd})'${composited}`);
                videoLabel = composited;
            });
            graph += ';' + spParts.join(';');
        }
    }
    return { inputPaths, graph, videoLabel, audioLabel, ...(loopInputIndices.length ? { spriteInputIndices: loopInputIndices } : {}) };
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
 * increase`+`crop` works from whatever ffmpeg actually decodes). An image/
 * video chain is then ALWAYS flattened onto an opaque black backdrop via a
 * real alpha-aware `overlay` (see flattenOpaque below) — a "background"-
 * typed kit asset is not guaranteed fully opaque, and nothing downstream of
 * [bgAll] preserves alpha, so skipping this would let a transparent asset's
 * under-alpha RGB (often literal black) leak straight through. The intervals
 * are concatenated end-to-end. Ambient: the kit's first
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
export function buildCompositionFilterGraph(m, opts = {}) {
    if (!m.composition)
        throw new Error('buildCompositionFilterGraph: manifest has no composition');
    const duration = m.composition.duration;
    const output = m.output ?? { width: m.width, height: m.height };
    const fps = m.fps;
    const inputPaths = [];
    const loopInputIndices = [];
    const streamLoopInputIndices = [];
    const pathIndex = new Map(); // dedupe by resolved absolute path
    const addImageInput = (absPath) => {
        const existing = pathIndex.get(absPath);
        if (existing !== undefined)
            return existing;
        const idx = inputPaths.length;
        inputPaths.push(absPath);
        loopInputIndices.push(idx);
        pathIndex.set(absPath, idx);
        return idx;
    };
    const addVideoLoopInput = (absPath) => {
        const existing = pathIndex.get(absPath);
        if (existing !== undefined)
            return existing;
        const idx = inputPaths.length;
        inputPaths.push(absPath);
        streamLoopInputIndices.push(idx);
        pathIndex.set(absPath, idx);
        return idx;
    };
    const coverScale = `scale=${output.width}:${output.height}:force_original_aspect_ratio=increase,crop=${output.width}:${output.height}`;
    // ---- background: per-interval color/image/video chain, concatenated ----
    const intervals = backgroundIntervals(m);
    const parts = [];
    const bgLabels = [];
    const warnings = [];
    const warnedNonBleedIds = new Set();
    /** kit-scan's alpha-bbox tolerance for "no transparent margin at all". */
    const FULL_BLEED_EPS = 0.01;
    // A background-typed kit asset (or a --to <video path> cut) is NOT
    // guaranteed fully opaque — a kit's "backgrounds/" PNG can still carry an
    // alpha channel (e.g. authored/exported with a transparent surround,
    // rather than a genuine full-bleed room illustration). Nothing downstream
    // of [bgAll] (concat, then the final yuv420p encode) preserves alpha, so a
    // raw `scale,crop,trim` chain silently keeps whatever RGB the source
    // happened to store under its transparent pixels once that alpha is
    // dropped — frequently (0,0,0), which reads as a literal black hole rather
    // than a neutral fill. Flatten with a real alpha-aware `overlay` onto an
    // opaque black backdrop (the same pattern sprite/ambient layers already
    // use) so the result is deterministic regardless of what garbage RGB sits
    // under alpha=0 in the source — harmless no-op for a genuinely opaque
    // asset (the backdrop is fully occluded), corrective for one that isn't.
    const flattenOpaque = (rawLabel, label, i, dur) => {
        const backdrop = `[bgbase${i}]`;
        parts.push(`color=c=black:s=${output.width}x${output.height}:d=${dur}:r=${fps}${backdrop}`);
        parts.push(`${backdrop}${rawLabel}overlay=x=0:y=0:format=auto${label}`);
    };
    intervals.forEach((iv, i) => {
        const dur = Math.max(1 / fps, iv.t1 - iv.t0);
        const label = `[bgc${i}]`;
        if (iv.ref.type === 'color') {
            parts.push(`color=c=${iv.ref.hex}:s=${output.width}x${output.height}:d=${dur}:r=${fps}${label}`);
        }
        else if (iv.ref.type === 'asset') {
            const asset = opts.kitAssets?.get(iv.ref.assetId);
            if (!asset) {
                // Unresolved background asset (missing/escaping — see
                // resolveKitAssets, whose warnings the caller already surfaces)
                // degrades to black rather than failing the whole render.
                parts.push(`color=c=black:s=${output.width}x${output.height}:d=${dur}:r=${fps}${label}`);
            }
            else {
                // kit-scan writes visible_bounds_normalized from the asset's actual
                // alpha bounding box; a background asset with no transparency at all
                // scans as the full canvas ({x0:0,y0:0,x1:1,y1:1} — see
                // resolveKitAssets/kit-scan). Anything tighter means the source has
                // a transparent margin — i.e. it's not a genuine full-bleed
                // background — which flattenOpaque below will silently paper over
                // with black rather than failing, so surface it as a warning instead
                // (same "don't fail the whole render, but don't stay silent either"
                // contract as resolveKitAssets' own warnings).
                const vb = asset.visible_bounds_normalized;
                if (vb && (vb.x0 > FULL_BLEED_EPS || vb.y0 > FULL_BLEED_EPS || vb.x1 < 1 - FULL_BLEED_EPS || vb.y1 < 1 - FULL_BLEED_EPS)) {
                    if (!warnedNonBleedIds.has(iv.ref.assetId)) {
                        warnedNonBleedIds.add(iv.ref.assetId);
                        warnings.push(`background asset "${iv.ref.assetId}": only x[${vb.x0.toFixed(2)},${vb.x1.toFixed(2)}] y[${vb.y0.toFixed(2)},${vb.y1.toFixed(2)}] of the canvas is opaque — likely not a full-bleed background image (looks more like a sprite/expression PNG); the transparent margin renders as black`);
                    }
                }
                const idx = addImageInput(asset.absPath);
                const rawLabel = `[bgraw${i}]`;
                parts.push(`[${idx}:v]${coverScale},trim=duration=${dur},setpts=PTS-STARTPTS,fps=${fps},format=rgba${rawLabel}`);
                flattenOpaque(rawLabel, label, i, dur);
            }
        }
        else {
            const idx = addVideoLoopInput(iv.ref.path);
            const rawLabel = `[bgraw${i}]`;
            parts.push(`[${idx}:v]${coverScale},trim=duration=${dur},setpts=PTS-STARTPTS,fps=${fps},format=rgba${rawLabel}`);
            flattenOpaque(rawLabel, label, i, dur);
        }
        bgLabels.push(label);
    });
    if (bgLabels.length === 0) {
        parts.push(`color=c=black:s=${output.width}x${output.height}:d=${duration}:r=${fps}[bgAll]`);
    }
    else if (bgLabels.length === 1) {
        parts.push(`${bgLabels[0]}null[bgAll]`);
    }
    else {
        parts.push(`${bgLabels.join('')}concat=n=${bgLabels.length}:v=1:a=0[bgAll]`);
    }
    let videoLabel = '[bgAll]';
    // ---- ambient layer (optional; see kit.ts's firstAmbientAsset) ----
    if (opts.ambientAssetId) {
        const ambient = opts.kitAssets?.get(opts.ambientAssetId);
        if (ambient) {
            const idx = addVideoLoopInput(ambient.absPath);
            parts.push(`[${idx}:v]${coverScale},trim=duration=${duration},setpts=PTS-STARTPTS,fps=${fps},format=rgba,colorchannelmixer=aa=${AMBIENT_LAYER_OPACITY}[amb]`);
            parts.push(`${videoLabel}[amb]overlay=x=0:y=0[bgAmb]`);
            videoLabel = '[bgAmb]';
        }
    }
    // ---- sprites (motion-aware; emoteAt crossfade layers on top) ----
    if (opts.kitAssets) {
        const activeSprites = resolvedActiveSprites(m).filter((r) => opts.kitAssets.has(r.sprite.assetId));
        activeSprites.forEach((r, n) => {
            const sp = r.sprite;
            const asset = opts.kitAssets.get(sp.assetId);
            const geo = spriteGeometry(asset, sp.position, sp.scale, output, { flip: sp.flip });
            const plan = spriteMotionPlan(sp.motion, geo, r.tlStart, r.tlEnd);
            const idx = addImageInput(asset.absPath);
            // emoteWindows() windows are always CONTIGUOUS through to the sprite's
            // own duration end (each entry's window runs until the next entry's t,
            // or duration — see ops.ts's emoteWindows doc), so once the first
            // window starts, the base sprite is never shown again for the rest of
            // its lifetime; only ONE base->first-emote transition ever needs a
            // fade. Without this, the base kept rendering underneath every emote
            // layer for the sprite's whole life, which is the "ぽんしゃすが複数
            // 出てきた" bug — a base silhouette peeking out from behind a
            // differently-shaped emote reads as a second character.
            const windows = emoteWindows(sp.motion?.emoteAt, sp.duration);
            // breathe is scale-only: its pulse lives in eval=frame w/h expressions
            // (plan.breathe), which a static `scale=W:H` would silently discard —
            // the preset must animate in the render exactly like the web preview.
            const chain = [
                plan.breathe
                    ? `scale=eval=frame:w='${plan.breathe.widthExpr}':h='${plan.breathe.heightExpr}'`
                    : `scale=${Math.max(1, Math.round(geo.width))}:${Math.max(1, Math.round(geo.height))}`,
            ];
            if (sp.flip)
                chain.push('hflip');
            chain.push('format=rgba');
            if (sp.opacity < 0.999)
                chain.push(`colorchannelmixer=aa=${sp.opacity}`);
            chain.push(...plan.fadeClauses);
            if (windows.length > 0) {
                const first = windows[0];
                const hideAt = r.tlStart + first.t0;
                const hideFd = Math.min(SPRITE_EMOTE_CROSSFADE_SECONDS, (first.t1 - first.t0) / 2);
                // Same st/d as the first emote layer's own fade=in below — a real
                // simultaneous crossfade, not a sequential fade-out-then-in.
                chain.push(`fade=t=out:st=${hideAt}:d=${hideFd}:alpha=1`);
            }
            const svLabel = `[spv${n}]`;
            parts.push(`[${idx}:v]${chain.join(',')}${svLabel}`);
            const composited = `[spc${n}]`;
            parts.push(`${videoLabel}${svLabel}overlay=x='${plan.xExpr}':y='${plan.yExpr}':enable='between(t,${r.tlStart},${r.tlEnd})'${composited}`);
            videoLabel = composited;
            windows.forEach((w, wi) => {
                const emoteAsset = opts.kitAssets.get(w.assetId);
                if (!emoteAsset)
                    return; // unresolved emote asset — skip this window (warning already surfaced upstream by resolveKitAssets)
                const eGeo = spriteGeometry(emoteAsset, sp.position, sp.scale, output, { flip: sp.flip });
                // Emote layers get their OWN plan from their own geometry (an emote
                // PNG may have different bounds/aspect) — the formulas are pure in t
                // and share tlStart, so base and emote stay phase-locked anyway.
                const ePlan = spriteMotionPlan(sp.motion, eGeo, r.tlStart, r.tlEnd);
                const eIdx = addImageInput(emoteAsset.absPath);
                const absT0 = r.tlStart + w.t0;
                const absT1 = r.tlStart + w.t1;
                const fd = Math.min(SPRITE_EMOTE_CROSSFADE_SECONDS, (w.t1 - w.t0) / 2);
                const eChain = [
                    ePlan.breathe
                        ? `scale=eval=frame:w='${ePlan.breathe.widthExpr}':h='${ePlan.breathe.heightExpr}'`
                        : `scale=${Math.max(1, Math.round(eGeo.width))}:${Math.max(1, Math.round(eGeo.height))}`,
                ];
                if (sp.flip)
                    eChain.push('hflip');
                eChain.push('format=rgba');
                if (sp.opacity < 0.999)
                    eChain.push(`colorchannelmixer=aa=${sp.opacity}`);
                eChain.push(`fade=t=in:st=${absT0}:d=${fd}:alpha=1`, `fade=t=out:st=${Math.max(absT0, absT1 - fd)}:d=${fd}:alpha=1`);
                const evLabel = `[spe${n}_${wi}]`;
                parts.push(`[${eIdx}:v]${eChain.join(',')}${evLabel}`);
                const eComposited = `[spec${n}_${wi}]`;
                parts.push(`${videoLabel}${evLabel}overlay=x='${ePlan.xExpr}':y='${ePlan.yExpr}':enable='between(t,${absT0},${absT1})'${eComposited}`);
                videoLabel = eComposited;
            });
        });
    }
    // ---- audio: dialogue voice clips form the "spoken" track other music ducks against ----
    const music = m.timeline.music ?? [];
    const voiceIds = new Set((m.timeline.dialogue ?? []).map((d) => d.voiceMusicId).filter((id) => Boolean(id)));
    const musicInputBase = inputPaths.length;
    inputPaths.push(...music.map((mu) => mu.path));
    const musicClause = (mu, i) => {
        const inIdx = musicInputBase + i;
        const label = `[mu${i}]`;
        const fd = Math.max(0, mu.fadeIn);
        const fo = Math.max(0, mu.fadeOut);
        parts.push(`[${inIdx}:a]atrim=start=${mu.srcIn}:end=${mu.srcIn + mu.duration},asetpts=PTS-STARTPTS,` +
            `volume=${mu.gain}dB,afade=t=in:st=0:d=${fd},afade=t=out:st=${Math.max(0, mu.duration - fo)}:d=${fo},` +
            `adelay=${Math.round(mu.tlStart * 1000)}:all=1${label}`);
        return label;
    };
    const voiceLabels = [];
    const bgDuckLabels = [];
    const bgPlainLabels = [];
    music.forEach((mu, i) => {
        const label = musicClause(mu, i);
        if (voiceIds.has(mu.id))
            voiceLabels.push(label);
        else
            (mu.duck ? bgDuckLabels : bgPlainLabels).push(label);
    });
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`);
    let acLabel = '[silence]';
    if (voiceLabels.length > 0) {
        parts.push(`[silence]${voiceLabels.join('')}amix=inputs=${voiceLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[acVoice]`);
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
    let musicFinal;
    if (duckFinal && plainMix) {
        parts.push(`${duckFinal}${plainMix}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[musicMix]`);
        musicFinal = '[musicMix]';
    }
    else {
        musicFinal = duckFinal || plainMix;
    }
    let audioLabel;
    if (musicFinal) {
        parts.push(`${convLabel}${musicFinal}amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`);
        audioLabel = '[mixed]';
    }
    else {
        audioLabel = convLabel;
    }
    parts.push(`${audioLabel}${loudnormClause(targetLufs, opts.loudnorm ?? {})}[final]`);
    audioLabel = '[final]';
    return { inputPaths, loopInputIndices, streamLoopInputIndices, graph: parts.join(';'), videoLabel, audioLabel, warnings };
}
/**
 * One sprite's video chain: scale the (still-image, `-loop 1`) PNG input to
 * its computed display size, optionally mirror it, force an alpha channel
 * (`format=rgba` — PNGs decode with one already, but this guarantees it
 * survives `scale`), and apply overall opacity via `colorchannelmixer=aa=`
 * (spec's alternative — a `fade=alpha=1` timed fade — isn't needed since
 * SpriteItem carries no fade-duration field, only a constant opacity).
 */
export function spriteVideoClause(inputIdx, n, displayWidth, displayHeight, opts = {}) {
    const w = Math.max(1, Math.round(displayWidth));
    const h = Math.max(1, Math.round(displayHeight));
    const opacity = opts.opacity ?? 1;
    const parts = [`scale=${w}:${h}`];
    if (opts.flip)
        parts.push('hflip');
    parts.push('format=rgba');
    if (opacity < 0.999)
        parts.push(`colorchannelmixer=aa=${opacity}`);
    return `[${inputIdx}:v]${parts.join(',')}[sv${n}]`;
}
/**
 * Pixel placement geometry for an overlay's `rect` (0..1 normalized box) —
 * or the ORIGINAL W3 full-bleed geometry (x=0,y=0,w=outW,h=outH) when `rect`
 * is absent. With a rect, width comes straight from `rect.w * outW`
 * (rounded to an even pixel count — most encoders require even chroma
 * dimensions), and height is DERIVED from the overlay source's own aspect
 * ratio applied to that width (also rounded even) so the box is never
 * distorted/stretched — "縦は元比率維持". Pure/side-effect-free; used both
 * by overlayVideoClause/overlayImageVideoClause (to size the `scale=`
 * clause) and by buildFilterGraph directly (to position the outer
 * `overlay=x=..:y=..` filter).
 */
export function overlayRectGeometry(rect, srcW, srcH, outW, outH) {
    if (!rect)
        return { x: 0, y: 0, w: outW, h: outH };
    const w = Math.max(2, Math.round((rect.w * outW) / 2) * 2);
    const h = Math.max(2, Math.round((w * (srcH / Math.max(1, srcW))) / 2) * 2);
    return { x: Math.round(rect.x * outW), y: Math.round(rect.y * outH), w, h };
}
/** The ORIGINAL W3 "fill the whole output canvas, preserving aspect via letterbox/pillarbox" scale+pad clause (no leading/trailing comma) — shared by the legacy overlayVideoClause path, the extended (opacity/fade, still no rect) video path, and any rect-less image overlay. Overlays have no per-clip crop field (unlike VideoClip) — `cropGeometry(...,undefined)` auto-centers. */
function overlayFullBleedScalePad(srcW, srcH, outW, outH) {
    const geo = cropGeometry(srcW, srcH, outW, outH, undefined);
    const cropPart = geo ? `crop=${geo.width}:${geo.height}:${geo.x}:${geo.y},` : '';
    return `${cropPart}scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2`;
}
/**
 * Opacity/fade filter suffix (leading comma, no trailing one) shared by the
 * video- and image-kind overlay clauses below. `duration` is the overlay's
 * own LOCAL displayed length (srcOut-srcIn) — `fade.out`'s `st=` is computed
 * against it, so the caller must apply this BEFORE shifting into the
 * absolute timeline domain (see overlayVideoClause's two-stage setpts).
 * Returns '' (no format=rgba, no filter at all) when neither opacity nor a
 * real fade is set — the ONLY case a video-kind overlay's chain must stay
 * byte-for-byte identical to before this feature existed; an image-kind
 * overlay always forces format=rgba itself regardless (see
 * overlayImageVideoClause), independent of this helper.
 */
function overlayOpacityFadeClause(opts, duration) {
    const fadeIn = opts.fade?.in;
    const fadeOut = opts.fade?.out;
    const hasFade = (fadeIn !== undefined && fadeIn > 0) || (fadeOut !== undefined && fadeOut > 0);
    const hasOpacity = opts.opacity !== undefined && opts.opacity < 0.999;
    if (!hasFade && !hasOpacity)
        return '';
    const parts = ['format=rgba'];
    if (fadeIn !== undefined && fadeIn > 0)
        parts.push(`fade=t=in:st=0:d=${fadeIn}:alpha=1`);
    if (fadeOut !== undefined && fadeOut > 0) {
        const st = Math.max(0, duration - fadeOut);
        parts.push(`fade=t=out:st=${st}:d=${fadeOut}:alpha=1`);
    }
    if (hasOpacity)
        parts.push(`colorchannelmixer=aa=${opts.opacity}`);
    return ',' + parts.join(',');
}
/**
 * One overlay's video chain for a VIDEO-kind B-roll source: trim to
 * [srcIn,srcOut), shift PTS to the resolved tlStart (so ffmpeg's `overlay`
 * filter — which samples the overlay input by ITS OWN timestamp — presents
 * the right frame once `between(t,tlStart,tlEnd)` goes true), then
 * scale/pad/crop to the output canvas.
 *
 * With no `opts` (or opts with rect/opacity/fade all absent) this reproduces
 * the ORIGINAL W3 chain byte-for-byte — trim+setpts combined into one
 * filter, full-bleed scale+pad, no rgba/fade/opacity anywhere — the
 * back-compat contract for every `broll-add`-created overlay. Once any of
 * rect/opacity/fade IS set, geometry/opacity/fade are applied FIRST in the
 * clip's own LOCAL time domain (trim, then a bare `setpts=PTS-STARTPTS`
 * reset to 0 — required so a `fade` filter's `st=`/`d=` land at the right
 * LOCAL moments, not the absolute timeline), and only THEN shifted into the
 * absolute timeline domain via a second `setpts=PTS+tlStart/TB` at the very
 * end — mirroring how each A-roll segment's own `afade` already works in
 * buildFilterGraph's main segment loop above.
 */
export function overlayVideoClause(inputIdx, n, srcIn, srcOut, tlStart, srcW, srcH, outW, outH, fps, opts = {}) {
    const fadeIn = opts.fade?.in;
    const fadeOut = opts.fade?.out;
    const hasFade = (fadeIn !== undefined && fadeIn > 0) || (fadeOut !== undefined && fadeOut > 0);
    const hasOpacity = opts.opacity !== undefined && opts.opacity < 0.999;
    const hasExtra = Boolean(opts.rect) || hasFade || hasOpacity;
    if (!hasExtra) {
        return `[${inputIdx}:v]trim=start=${srcIn}:end=${srcOut},setpts=PTS-STARTPTS+${tlStart}/TB,${overlayFullBleedScalePad(srcW, srcH, outW, outH)},fps=${fps}[ov${n}]`;
    }
    const scalePart = opts.rect
        ? (() => {
            const geo = overlayRectGeometry(opts.rect, srcW, srcH, outW, outH);
            return `scale=${geo.w}:${geo.h}`;
        })()
        : overlayFullBleedScalePad(srcW, srcH, outW, outH);
    const fxPart = overlayOpacityFadeClause(opts, srcOut - srcIn);
    return (`[${inputIdx}:v]trim=start=${srcIn}:end=${srcOut},setpts=PTS-STARTPTS,` +
        `${scalePart},fps=${fps}${fxPart},setpts=PTS+${tlStart}/TB[ov${n}]`);
}
/**
 * One overlay's video chain for an IMAGE-kind source (Source.kind:'image',
 * オーバーレイ・スタック): unlike overlayVideoClause, there's no
 * trim/PTS-shift — a `-loop 1` still image presents the same frame at every
 * timestamp, so (exactly like W8's spriteVideoClause) only geometry/
 * opacity/fade matter; the caller's outer `overlay=enable=
 * 'between(t,tlStart,tlEnd)'` gate is what actually confines it to its
 * placed window. `format=rgba` is ALWAYS applied (unlike the video path)
 * so a PNG's alpha survives even with no opacity/fade requested — same
 * rationale as spriteVideoClause's unconditional format=rgba.
 */
export function overlayImageVideoClause(inputIdx, n, srcW, srcH, outW, outH, fps, displayDuration, opts = {}) {
    const scalePart = opts.rect
        ? (() => {
            const geo = overlayRectGeometry(opts.rect, srcW, srcH, outW, outH);
            return `scale=${geo.w}:${geo.h}`;
        })()
        : overlayFullBleedScalePad(srcW, srcH, outW, outH);
    const fxPart = overlayOpacityFadeClause(opts, displayDuration);
    const tail = fxPart ? `,fps=${fps}${fxPart}` : `,fps=${fps},format=rgba`;
    return `[${inputIdx}:v]${scalePart}${tail}[ov${n}]`;
}
/** One overlay's audio chain for audioMode mix/replace: trim, delay to tlStart, apply gain. */
export function overlayAudioClause(inputIdx, n, srcIn, srcOut, tlStart, gainDb) {
    return `[${inputIdx}:a]atrim=start=${srcIn}:end=${srcOut},asetpts=PTS-STARTPTS,adelay=${Math.round(tlStart * 1000)}:all=1,volume=${gainDb}dB[ova${n}]`;
}
/** crf/preset/audio-bitrate defaults matching this module's pre-Wave-M behavior — the "no preset" baseline. */
const DEFAULT_CRF = 18;
const DEFAULT_ENC_PRESET = 'medium';
const DEFAULT_AUDIO_BITRATE = '192k';
/**
 * Preset -> encode params + post-filter, as a pure function of the current
 * output canvas size and timeline duration (both cheap to compute from the
 * manifest, so the caller passes them in rather than this needing I/O).
 * Throws only for a genuinely unsatisfiable request (shorts on a landscape
 * canvas) — duration overages are warnings, never errors, per spec.
 */
export function planExportPreset(preset, output, durationSeconds, targetLufsDefault) {
    const warnings = [];
    if (preset === 'youtube') {
        // Resolution untouched (manifest.output, or the source's, wins as-is).
        return { crf: 18, encPreset: 'medium', audioBitrate: '256k', forceLoudnormI: targetLufsDefault, postFilter: null, warnings };
    }
    if (preset === 'shorts') {
        if (!(output.height > output.width)) {
            throw new Error(`--preset shorts requires a portrait output (height > width); current output is ${output.width}x${output.height}. ` +
                'Run `vedit reframe 9:16` (or another portrait target) first — shorts will not auto-reframe for you.');
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
    let postFilter = null;
    if (longEdge > 1280) {
        const scale = 1280 / longEdge;
        const w = Math.max(2, Math.round((output.width * scale) / 2) * 2);
        const h = Math.max(2, Math.round((output.height * scale) / 2) * 2);
        postFilter = `scale=${w}:${h}`;
    }
    return { crf: 23, encPreset: 'medium', audioBitrate: '128k', forceLoudnormI: null, postFilter, warnings };
}
/**
 * Resolve the final encode params for a render: preset-derived values with
 * explicit overrides taking precedence, falling back to the pre-Wave-M
 * hardcoded defaults when no preset (and no override) is given at all — the
 * "regression zero" contract for `vedit export render` without --preset.
 */
export function resolveRenderParams(m, opts = {}) {
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
function ffmpegInputArgs(inputPaths, loopIndices, streamLoopIndices) {
    const loopSet = new Set(loopIndices ?? []);
    const streamLoopSet = new Set(streamLoopIndices ?? []);
    const out = [];
    inputPaths.forEach((p, i) => {
        if (loopSet.has(i))
            out.push('-loop', '1');
        if (streamLoopSet.has(i))
            out.push('-stream_loop', '-1');
        out.push('-i', p);
    });
    return out;
}
/**
 * W7: convenience I/O loader for renderFinal/renderComposition's
 * `opts.motionSpecs` — resolves every `m.timeline.motion` item's sidecar via
 * `Project.readMotionSpec` (motion/<id>.json), skipping (not throwing on) a
 * missing or corrupt sidecar, same "best effort, ignore on failure" contract
 * as web/app.js's own loadMotionSpecs. Not called by renderFinal/
 * renderComposition themselves — render.ts stays I/O-free for
 * project-relative files it has no directory reference for (see
 * buildMotionAss's doc in motion.ts) — this exists purely so a caller that
 * DOES have a `Project` (e.g. the CLI) can build the map in one line:
 * `renderFinal(m, transcripts, dest, { motionSpecs: await loadMotionSpecs(p, m) })`.
 */
export async function loadMotionSpecs(p, m) {
    const out = {};
    for (const item of m.timeline.motion) {
        try {
            out[item.id] = (await p.readMotionSpec(item.id));
        }
        catch {
            /* missing/corrupt sidecar — skip, matching web's loadMotionSpecs ignore-on-error */
        }
    }
    return out;
}
/** Unique render sidecar path: concurrent CLI/web renders never share ASS files. */
function temporaryAssPath(outPath, kind) {
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    return path.join(path.dirname(outPath), `.${path.basename(outPath)}.${token}.vedit-${kind}.ass`);
}
/**
 * Run a measurement-only ffmpeg pass (`-f null -`) for a `print_format=json`
 * loudnorm filter and parse the JSON stats block it prints to stderr —
 * pass 1 of 2-pass loudnorm normalization. Only audio needs to be mapped;
 * ffmpeg doesn't decode/encode the unmapped video side of the graph.
 */
async function measureLoudnorm(inputPaths, graph, audioLabel, videoLabel, spriteInputIndices, signal) {
    const inputs = ffmpegInputArgs(inputPaths, spriteInputIndices);
    const { stderr } = await runCapture('ffmpeg', [
        '-y', ...inputs,
        // ffmpeg refuses a graph with an unconnected named output — it does NOT
        // prune the unmapped video side. Terminate it in-graph instead.
        '-filter_complex', `${graph};${videoLabel}nullsink`,
        '-map', audioLabel,
        '-f', 'null', '-',
    ], { signal });
    // loudnorm's print_format=json block is a flat (non-nested) JSON object
    // logged to stderr; take the last brace-delimited block in case earlier
    // ffmpeg log lines happen to contain braces.
    const matches = stderr.match(/\{[^{}]*\}/g);
    const jsonStr = matches?.[matches.length - 1];
    if (!jsonStr) {
        throw new Error('loudnorm measurement pass produced no parseable stats; retry with --fast-loudnorm to skip 2-pass normalization');
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
 * to the old 1-pass application), ASS caption/dialogue burn (see the gate
 * below), W7 motion burn (see below), optional publish preset (encode
 * params + forced loudnorm target + resize).
 *
 * Caption/dialogue burn gate: captions burn by DEFAULT whenever
 * `m.captions.enabled` is true and actually produce at least one cue for
 * the given transcripts — `opts.noBurnCaptions` (CLI: --no-burn-captions)
 * opts OUT of the caption burn for a clean hand-off render (NLE/editor
 * wants to add its own subtitles). `opts.burnCaptions` is accepted for
 * backward compatibility but is now a no-op — it no longer gates anything,
 * since burning is the default. `m.timeline.dialogue` (speech-bubble lines,
 * see its doc in types.ts) burns UNCONDITIONALLY whenever present,
 * independent of the captions gate — a render is dialogue's only output
 * path, so there is no "off" switch for it (matches renderComposition's
 * dialogue burn, which has always been unconditional). The two are still
 * ONE shared ASS document/`ass` filter (toAss's `includeCaptions` option
 * controls only whether caption cues are added to it; dialogue lines are
 * always added when present) — see toAss's doc.
 *
 * W7 motion burn: when `opts.motionSpecs` is supplied (caller-resolved
 * MotionItem sidecar content, keyed by id — see loadMotionSpecs below), the
 * 4 built-in presets (chapter-card/lower-third/callout/cta) are burned in via
 * a SECOND `ass` filter chained on top of the caption burn (matching
 * #motionLayer sitting above #captionLayer in the web preview's DOM — see
 * web/index.html); custom-html items are never burned and instead produce a
 * `custom-html は焼き込み対象外(N件)` warning. Omitting `motionSpecs`
 * entirely (the pre-W7 default — no existing caller passes it) skips this
 * block completely, so a caller that never opts in gets the exact same
 * filtergraph as before W7 existed regardless of what's on
 * `m.timeline.motion` — see src/export/motion.ts's buildMotionAss doc for
 * why render.ts can't resolve the sidecars itself.
 *
 * Regression contract: with no `--preset`, no `manifest.audioRepair` (or an
 * explicit `preset: 'off'`), no music, no `opts.motionSpecs`, and nothing
 * that would actually produce a caption cue or dialogue line (no
 * transcripts, or captions disabled/opted out, and no `m.timeline.dialogue`)
 * this produces the exact same ffmpeg filtergraph as before loudnorm/repair/
 * W7/this default-burn change existed — no loudnorm filter at all, audio
 * chain unchanged, no `ass` filter at all.
 */
export async function renderFinal(m, transcripts, outPath, opts = {}) {
    // --no-repair (dry-audio A/B): disable the repair chain for this render
    // only, without touching the manifest's saved setting.
    const effectiveM = opts.noRepair ? { ...m, audioRepair: undefined } : m;
    const params = resolveRenderParams(effectiveM, opts);
    for (const w of params.warnings)
        console.error(`警告: ${w}`);
    const musicless = (effectiveM.timeline.music ?? []).length === 0;
    const repairActive = buildRepairChain(effectiveM.audioRepair) !== '';
    const fast = Boolean(opts.fastLoudnorm);
    // Regression clause: nothing (preset / repair / music) actually wants
    // normalization -> skip loudnorm entirely, exactly like before W1.
    // `audio-mix --target-lufs` is an explicit user decision even when the
    // project has no BGM and repair is off.  Ignoring it in that common
    // dialogue-only shape made the UI/manifest claim a target that the final
    // render never attempted to meet.  An entirely untouched legacy manifest
    // still takes the regression-zero path below (no loudnorm at all).
    const explicitMixTarget = effectiveM.audioMix?.targetLufs !== undefined;
    const wantsLoudnorm = !musicless || params.forceLoudnormI !== null || repairActive || explicitMixTarget;
    const musiclessTarget = params.forceLoudnormI ?? (effectiveM.audioMix?.targetLufs ?? -14);
    // ---- W8: kit (styles/sprites) — best-effort load ----
    // A missing/corrupt kit.json degrades to "no kit" (warning, not a thrown
    // error): the kit dir is external/shared and may have moved or been
    // edited concurrently, and a render shouldn't fail over stale style/
    // sprite decoration. Every project without `manifest.kit` set never
    // enters this block at all — full regression.
    const warnings = [...params.warnings];
    // HANDOFF §5 known compromise, now surfaced as a warning instead of a
    // silent gap: buildFilterGraph (this pipeline) composites sprites at a
    // fixed STATIC position/frame always — see its W8 block above, which
    // never touches spriteMotionPlan's motion-aware x/y/scale expressions
    // (those only run in buildCompositionFilterGraph, the composition-mode
    // pipeline). So any sprite overlay here — whether or not it has a
    // `.motion` preset configured — renders as a still image; every existing
    // non-composition project without sprites is unaffected (empty array,
    // condition false).
    if ((effectiveM.timeline.sprites ?? []).length > 0) {
        warnings.push('スプライト/モーションのアニメーションは通常プロジェクトの書き出しでは静止画になります');
    }
    // Roadmap "クリップ単位の音量・ミュート": the web preview doesn't apply
    // gainDb/muted yet (that's a separate, untouched wave — see the
    // roadmap item's spec) — self-report the parity gap on every render that
    // actually has an override set, rather than silently diverging.
    if (effectiveM.timeline.video.some((c) => c.gainDb !== undefined || c.muted)) {
        warnings.push('クリップ音量/ミュートはプレビュー未反映(書き出しで確認)');
    }
    // オーバーレイ・スタック: timeline-overflow / full-bleed-aspect-mismatch
    // advisories — see overlayGeometryWarnings' doc in ops.ts. A project with
    // no overlays (or none tripping either check) pushes nothing here — full
    // regression.
    warnings.push(...overlayGeometryWarnings(effectiveM));
    let kit = null;
    if (effectiveM.kit) {
        try {
            kit = await readKitFile(effectiveM.kit.path);
        }
        catch (e) {
            warnings.push(`kit: ${e?.message ?? e} — rendering without kit styles/sprites`);
        }
    }
    let kitAssets;
    if (kit && effectiveM.kit) {
        const spriteAssetIds = (effectiveM.timeline.sprites ?? []).map((s) => s.assetId);
        if (spriteAssetIds.length > 0) {
            const { resolved, warnings: assetWarnings } = await resolveKitAssets(effectiveM.kit.path, kit, spriteAssetIds);
            kitAssets = resolved;
            warnings.push(...assetWarnings);
        }
    }
    let measured;
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
        measured = await measureLoudnorm(measureBuilt.inputPaths, measureGraph, measureLabel, measureBuilt.videoLabel, measureBuilt.spriteInputIndices, opts.signal);
    }
    const loudnormOpts = fast || !wantsLoudnorm ? {} : { measured };
    const built = buildFilterGraph(effectiveM, { loudnorm: loudnormOpts, kitAssets });
    let graph = built.graph;
    const inputs = ffmpegInputArgs(built.inputPaths, built.spriteInputIndices);
    // Caption/dialogue burn gate — see this function's doc for the full
    // rationale. `burnCaptionsNow` is what actually gets PASSED to toAss (an
    // intent — "captions are allowed to appear"); `cues` is what actually
    // came OUT (captionCues returns [] for a caption-less/transcript-less
    // project even with burnCaptionsNow true), so `needsAssBurn` — the thing
    // that decides whether an .ass file/`ass` filter exists AT ALL — is keyed
    // off the real cue count, not just the intent, to keep the "nothing to
    // caption" case byte-for-byte regression-safe (no stray empty ass filter).
    const noBurnCaptions = Boolean(opts.noBurnCaptions);
    const burnCaptionsNow = effectiveM.captions.enabled && !noBurnCaptions;
    const { cues, excluded: nonSpeechExcluded } = burnCaptionsNow
        ? captionCuesWithExclusions(effectiveM, transcripts)
        : { cues: [], excluded: [] };
    // P1: a Whisper hallucination ("[MÚSICA DE FUNDO]" etc.) never makes it
    // into `cues` at all (captionCuesWithExclusions already dropped it) — this
    // just makes the drop visible rather than silent, same warnings channel
    // every other render advisory (kit issues, preset overages) already uses.
    if (nonSpeechExcluded.length > 0) {
        const w = formatCaptionExclusionWarning(nonSpeechExcluded);
        console.error(`警告: ${w}`);
        warnings.push(w);
    }
    const dialogueCount = (effectiveM.timeline.dialogue ?? []).length;
    const hasDialogue = dialogueCount > 0;
    const needsAssBurn = cues.length > 0 || hasDialogue;
    let assPath = null;
    let motionAssPath = null;
    try {
        if (needsAssBurn && !ffmpegHasFilter('ass')) {
            throw new Error('this ffmpeg build lacks the `ass` filter (caption/dialogue burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or (captions only) export with --no-burn-captions.');
        }
        let vLabel = built.videoLabel;
        if (needsAssBurn) {
            assPath = temporaryAssPath(outPath, 'captions');
            await fs.writeFile(assPath, toAss(effectiveM, transcripts, kit, { includeCaptions: burnCaptionsNow }));
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
                let fontDir = null;
                if (overrideFont) {
                    const resolved = await resolveKitFontFile(effectiveM.kit.path, overrideFont).catch(() => null);
                    if (resolved)
                        fontDir = path.dirname(resolved);
                }
                if (!fontDir && activeKitStyle?.caption?.font) {
                    try {
                        const fontAbs = await resolveWithinDir(effectiveM.kit.path, activeKitStyle.caption.font);
                        fontDir = path.dirname(fontAbs);
                    }
                    catch (e) {
                        warnings.push(`kit style ${activeKitStyle.id}: font path invalid (${activeKitStyle.caption.font}) — captions burn without the kit font`);
                    }
                }
                if (fontDir)
                    fontsdirPart = `:fontsdir='${fontDir.replace(/'/g, "\\'")}'`;
            }
            // W-CAP: overrides.font that resolved to neither a kit font file (above)
            // nor a recognized system font family is very likely a typo — surface it
            // as a warning rather than silently falling back to libass's default
            // font. staticChecks (qc.ts) is untouched by this; it's purely a
            // render-time advisory.
            if (overrideFont && !fontsdirPart) {
                const family = path.basename(overrideFont, path.extname(overrideFont));
                const systemFonts = await listSystemFonts(null).catch(() => []);
                const known = systemFonts.some((f) => f.family.toLowerCase() === family.toLowerCase() || f.family.toLowerCase() === overrideFont.toLowerCase());
                if (!known) {
                    warnings.push(`caption font "${overrideFont}" was not found in the linked kit's fonts/ directory or common system font locations — burned captions may fall back to a default font`);
                }
            }
            graph += `;${built.videoLabel}ass='${assPath.replace(/'/g, "\\'")}'${fontsdirPart}[vout]`;
            vLabel = '[vout]';
        }
        // W7: motion burn-in — a SECOND, independent `ass` filter chained on top
        // of (not merged into) the caption burn above, applied to whatever `vLabel`
        // currently is (so it draws OVER captions, matching #motionLayer sitting
        // above #captionLayer in the web preview — see web/index.html). Only runs
        // when the caller supplied `opts.motionSpecs`; see this function's doc for
        // why that's an opt-in rather than something render.ts resolves itself.
        if (opts.motionSpecs) {
            const output = effectiveM.output ?? { width: effectiveM.width, height: effectiveM.height };
            const motionDoc = buildMotionAss(effectiveM, opts.motionSpecs, kit, output);
            if (motionDoc.customHtmlSkipped > 0) {
                warnings.push(`custom-html は焼き込み対象外(${motionDoc.customHtmlSkipped}件)`);
            }
            if (motionDoc.ass) {
                if (!ffmpegHasFilter('ass')) {
                    throw new Error('this ffmpeg build lacks the `ass` filter (motion burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or render without motionSpecs.');
                }
                motionAssPath = temporaryAssPath(outPath, 'motion');
                await fs.writeFile(motionAssPath, motionDoc.ass);
                graph += `;${vLabel}ass='${motionAssPath.replace(/'/g, "\\'")}'[voutMotion]`;
                vLabel = '[voutMotion]';
            }
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
            // Some audio filters (notably loudnorm) add a short padded tail.  Bound
            // the mux to the captured timeline duration so a normalized render does
            // not outlive its last video frame merely because of filter latency.
            '-t', String(timelineDuration(effectiveM)),
            '-c:v', 'libx264', '-preset', params.encPreset, '-crf', String(params.crf),
            '-pix_fmt', 'yuv420p',
            // loudnorm internally upsamples (commonly to 192 kHz).  Without an
            // explicit output rate ffmpeg can let that leak into AAC as 96 kHz,
            // producing needlessly large/non-standard delivery audio.  All generated
            // silence and the editor's delivery contract are 48 kHz, so pin it here.
            '-c:a', 'aac', '-b:a', params.audioBitrate, '-ar', '48000',
            '-dn', // drop any data streams (e.g. DJI tmcd) that survived the filtergraph
            '-movflags', '+faststart',
            outPath,
        ], { signal: opts.signal });
        return {
            file: outPath,
            warnings,
            captionsBurned: cues.length > 0,
            captionCueCount: cues.length,
            dialogueBurned: hasDialogue,
            dialogueCount,
        };
    }
    finally {
        // Cleanup must never turn a completed MP4 (or the original ffmpeg error)
        // into a different failure merely because a temp sidecar cannot be
        // removed. Unique names prevent a leftover from corrupting later jobs.
        if (assPath)
            await fs.rm(assPath, { force: true }).catch(() => { });
        if (motionAssPath)
            await fs.rm(motionAssPath, { force: true }).catch(() => { });
    }
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
 *
 * W7 motion burn: same `opts.motionSpecs`-gated behavior as renderFinal (see
 * its doc), but chained BEFORE the dialogue burn below rather than after —
 * #motionLayer sits below #dialogueLayer in the web preview's DOM (see
 * web/index.html), so motion draws under speech bubbles here, unlike
 * renderFinal where it draws over captions.
 */
export async function renderComposition(m, outPath, opts = {}) {
    if (!m.composition)
        throw new Error('renderComposition: manifest has no composition');
    const params = resolveRenderParams(m, opts);
    const warnings = [...params.warnings];
    let kit = null;
    if (m.kit) {
        try {
            kit = await readKitFile(m.kit.path);
        }
        catch (e) {
            warnings.push(`kit: ${e?.message ?? e} — rendering without kit background/sprites/styles`);
        }
    }
    let kitAssets;
    let ambientAssetId;
    if (kit && m.kit) {
        const ids = new Set();
        for (const s of m.timeline.sprites ?? []) {
            ids.add(s.assetId);
            for (const e of s.motion?.emoteAt ?? [])
                ids.add(e.assetId);
        }
        const bgRef = m.composition.background;
        if (bgRef.type === 'asset')
            ids.add(bgRef.assetId);
        for (const e of m.composition.backgroundTrack ?? [])
            if (e.ref.type === 'asset')
                ids.add(e.ref.assetId);
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
    warnings.push(...built.warnings);
    let graph = built.graph;
    const inputs = ffmpegInputArgs(built.inputPaths, built.loopInputIndices, built.streamLoopInputIndices);
    let vLabel = built.videoLabel;
    // W7: motion burn-in, applied BEFORE the dialogue burn below so motion
    // sits under speech bubbles (matches #motionLayer < #dialogueLayer in the
    // web DOM). Opt-in via opts.motionSpecs — see renderFinal's doc for why.
    let motionAssPath = null;
    let assPath = null;
    try {
        if (opts.motionSpecs) {
            const output = m.output ?? { width: m.width, height: m.height };
            const motionDoc = buildMotionAss(m, opts.motionSpecs, kit, output);
            if (motionDoc.customHtmlSkipped > 0) {
                warnings.push(`custom-html は焼き込み対象外(${motionDoc.customHtmlSkipped}件)`);
            }
            if (motionDoc.ass) {
                if (!ffmpegHasFilter('ass')) {
                    throw new Error('this ffmpeg build lacks the `ass` filter (motion burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or render without motionSpecs.');
                }
                motionAssPath = temporaryAssPath(outPath, 'motion');
                await fs.writeFile(motionAssPath, motionDoc.ass);
                graph += `;${vLabel}ass='${motionAssPath.replace(/'/g, "\\'")}'[voutMotion]`;
                vLabel = '[voutMotion]';
            }
        }
        const hasDialogue = (m.timeline.dialogue ?? []).length > 0;
        if (hasDialogue) {
            if (!ffmpegHasFilter('ass')) {
                throw new Error('this ffmpeg build lacks the `ass` filter (dialogue burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG.');
            }
            assPath = temporaryAssPath(outPath, 'dialogue');
            await fs.writeFile(assPath, toAss(m, [], kit));
            let fontsdirPart = '';
            const activeKitStyle = kit?.styles?.find((s) => s.id === m.captions.style);
            if (m.kit && activeKitStyle?.caption?.font) {
                try {
                    const fontAbs = await resolveWithinDir(m.kit.path, activeKitStyle.caption.font);
                    fontsdirPart = `:fontsdir='${path.dirname(fontAbs).replace(/'/g, "\\'")}'`;
                }
                catch {
                    warnings.push(`kit style ${activeKitStyle.id}: font path invalid (${activeKitStyle.caption.font}) — dialogue burns without the kit font`);
                }
            }
            // Chains onto `vLabel` (not `built.videoLabel`) so this lands on top of
            // the W7 motion burn above when one happened — with no motion burn
            // (the common/pre-W7 case), vLabel === built.videoLabel here still, so
            // this is byte-for-byte the same clause as before W7 existed.
            graph += `;${vLabel}ass='${assPath.replace(/'/g, "\\'")}'${fontsdirPart}[vout]`;
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
            '-c:a', 'aac', '-b:a', params.audioBitrate, '-ar', '48000',
            '-dn',
            '-movflags', '+faststart',
            outPath,
        ], { signal: opts.signal });
        return { file: outPath, warnings };
    }
    finally {
        if (assPath)
            await fs.rm(assPath, { force: true }).catch(() => { });
        if (motionAssPath)
            await fs.rm(motionAssPath, { force: true }).catch(() => { });
    }
}
/**
 * `vedit export render --range <a>..<b>`: a fast A/B preview of audio/color/
 * caption changes over just the timeline window [a,b) — NOT a lower-fidelity
 * pipeline. `sliceTimelineRange` (core/ops.ts) does the one real piece of
 * work: it produces a manifest whose timeline IS exactly that window
 * remapped to [0,b-a), then this function hands that sliced manifest to the
 * SAME renderFinal/renderComposition every normal export uses — captions,
 * BGM ducking, color, dialogue, motion burn-in all behave identically,
 * because nothing about their code path changed, only the input manifest's
 * shape.
 *
 * "下見品質で良い" (spec): this is the ONLY place preview quality is
 * downgraded — `-preset veryfast` (fast x264 encode), a single-pass loudnorm
 * (no measurement pass — `fastLoudnorm: true`, same flag `--fast-loudnorm`
 * already exposes on a normal render), and the output canvas capped so its
 * long edge is <=1280 (720p-class in either orientation; never upscales a
 * canvas that's already smaller). The returned `warnings` always leads with
 * an explicit "下見品質" disclaimer so a caller can't mistake this for a
 * final-quality export.
 */
export async function renderRangePreview(m, transcripts, outPath, range, opts = {}) {
    const sliced = sliceTimelineRange(m, range.a, range.b);
    const baseOutput = sliced.output ?? { width: sliced.width, height: sliced.height };
    const longEdge = Math.max(baseOutput.width, baseOutput.height);
    const previewOutput = longEdge > 1280
        ? {
            width: Math.max(2, Math.round((baseOutput.width * (1280 / longEdge)) / 2) * 2),
            height: Math.max(2, Math.round((baseOutput.height * (1280 / longEdge)) / 2) * 2),
        }
        : baseOutput;
    const previewManifest = { ...sliced, output: previewOutput };
    const warnings = ['下見品質(本番は通常書き出しで)'];
    if (previewManifest.composition) {
        const res = await renderComposition(previewManifest, outPath, {
            encPreset: 'veryfast',
            ...(opts.motionSpecs ? { motionSpecs: opts.motionSpecs } : {}),
            signal: opts.signal,
        });
        return { file: res.file, warnings: [...warnings, ...res.warnings], range };
    }
    const res = await renderFinal(previewManifest, transcripts, outPath, {
        encPreset: 'veryfast',
        fastLoudnorm: true,
        noBurnCaptions: opts.noBurnCaptions,
        noRepair: opts.noRepair,
        ...(opts.motionSpecs ? { motionSpecs: opts.motionSpecs } : {}),
        signal: opts.signal,
    });
    return {
        file: res.file,
        warnings: [...warnings, ...res.warnings],
        range,
        captionsBurned: res.captionsBurned,
        captionCueCount: res.captionCueCount,
        dialogueBurned: res.dialogueBurned,
        dialogueCount: res.dialogueCount,
    };
}
