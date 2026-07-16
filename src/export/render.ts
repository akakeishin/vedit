import path from 'node:path';
import { promises as fs } from 'node:fs';
import { cropGeometry, segments, timelineDuration } from '../core/ops.js';
import { captionCues } from '../core/captions.js';
import type { Manifest, Transcript } from '../core/types.js';
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
const ASS_STYLE_PRESETS: Record<string, { primary: string; outline: string; back: string; bold: 0 | -1; borderStyle: 1 | 3; outlineWidth: number; shadow: number }> = {
  clean: { primary: '&H00FFFFFF', outline: '&H00101010', back: '&H80000000', bold: 0, borderStyle: 1, outlineWidth: 3, shadow: 1 },
  bold: { primary: '&H005CE4FF', outline: '&H00000000', back: '&H00000000', bold: -1, borderStyle: 3, outlineWidth: 0, shadow: 0 },
  outline: { primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', bold: 0, borderStyle: 1, outlineWidth: 3, shadow: 1 },
  boxed: { primary: '&H00FFFFFF', outline: '&H00101010', back: '&H00000000', bold: 0, borderStyle: 3, outlineWidth: 0, shadow: 2 },
};

export function toAss(m: Manifest, transcripts: Transcript[]): string {
  const cues = captionCues(m, transcripts);
  const { width, height } = m.output ?? { width: m.width, height: m.height };
  const fontSize = Math.round(height * 0.045);
  const marginV = Math.round(height * 0.06);
  const styleLines = Object.entries(ASS_STYLE_PRESETS)
    .map(
      ([name, s]) =>
        `Style: ${name},Hiragino Sans,${fontSize},${s.primary},&H000000FF,${s.outline},${s.back},${s.bold},0,0,0,100,100,0,0,${s.borderStyle},${s.outlineWidth},${s.shadow},2,60,60,${marginV},1`,
    )
    .join('\n');
  const activeStyle = ASS_STYLE_PRESETS[m.captions.style] ? m.captions.style : 'clean';
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
  return head + lines.join('\n') + '\n';
}

export interface FilterGraphBuild {
  /** Ordered `-i` input paths: video sources first (dedup'd, seg order), then one per music item. */
  inputPaths: string[];
  /** filter_complex graph string. */
  graph: string;
  /** Label to `-map` for video. */
  videoLabel: string;
  /** Label to `-map` for the final audio mix. */
  audioLabel: string;
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
  opts: { loudnorm?: { measured?: LoudnormMeasured; printJson?: boolean } } = {},
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
    parts.push(
      `[${idx}:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,${cropPart}scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2,fps=${m.fps}[v${i}]`,
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

  return { inputPaths, graph, videoLabel: '[vc]', audioLabel };
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
 * Run a measurement-only ffmpeg pass (`-f null -`) for a `print_format=json`
 * loudnorm filter and parse the JSON stats block it prints to stderr —
 * pass 1 of 2-pass loudnorm normalization. Only audio needs to be mapped;
 * ffmpeg doesn't decode/encode the unmapped video side of the graph.
 */
async function measureLoudnorm(inputPaths: string[], graph: string, audioLabel: string): Promise<LoudnormMeasured> {
  const inputs: string[] = [];
  for (const p of inputPaths) inputs.push('-i', p);
  const { stderr } = await runCapture('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', graph,
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

  let measured: LoudnormMeasured | undefined;
  if (wantsLoudnorm && !fast) {
    const measureBuilt = buildFilterGraph(effectiveM, { loudnorm: { printJson: true } });
    let measureGraph = measureBuilt.graph;
    let measureLabel = measureBuilt.audioLabel;
    if (musicless) {
      // Music-present graphs already end their own loudnorm(print_format=
      // json) inside buildFilterGraph above; musicless ones need it appended.
      measureGraph += `;${measureLabel}${loudnormClause(musiclessTarget, { printJson: true })}[measure]`;
      measureLabel = '[measure]';
    }
    measured = await measureLoudnorm(measureBuilt.inputPaths, measureGraph, measureLabel);
  }

  const loudnormOpts = fast || !wantsLoudnorm ? {} : { measured };
  const built = buildFilterGraph(effectiveM, { loudnorm: loudnormOpts });
  let graph = built.graph;
  const inputs: string[] = [];
  for (const p of built.inputPaths) inputs.push('-i', p);

  let assPath: string | null = null;
  if (opts.burnCaptions && effectiveM.captions.enabled && !ffmpegHasFilter('ass')) {
    throw new Error(
      'this ffmpeg build lacks the `ass` filter (caption burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or export without --burn-captions.',
    );
  }
  let vLabel = built.videoLabel;
  if (opts.burnCaptions && effectiveM.captions.enabled) {
    assPath = path.join(path.dirname(outPath), '.vedit-captions.ass');
    await fs.writeFile(assPath, toAss(effectiveM, transcripts));
    graph += `;${built.videoLabel}ass='${assPath.replace(/'/g, "\\'")}'[vout]`;
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
  return { file: outPath, warnings: params.warnings };
}
