import path from 'node:path';
import { promises as fs } from 'node:fs';
import { cropGeometry, segments } from '../core/ops.js';
import { captionCues } from '../core/captions.js';
import type { Manifest, Transcript } from '../core/types.js';
import { ffmpegHasFilter, run } from '../ingest/run.js';

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
export function buildFilterGraph(m: Manifest): FilterGraphBuild {
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
      parts.push(`[${idx}:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS${fadePart}[a${i}]`);
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
    musicParts.push(`[mixed]loudnorm=I=${targetLufs}:TP=-1.5:LRA=11[final]`);
    graph += ';' + musicParts.join(';');
    audioLabel = '[final]';
  }

  return { inputPaths, graph, videoLabel: '[vc]', audioLabel };
}

/**
 * Final render from ORIGINAL sources (not proxies): trim+concat filtergraph,
 * optional music mix/duck/loudnorm, optional ASS caption burn. Motion
 * overlays are not baked yet (preview-only for now; on NLE export they
 * travel as markers + spec sidecars).
 */
export async function renderFinal(
  m: Manifest,
  transcripts: Transcript[],
  outPath: string,
  opts: { burnCaptions?: boolean } = {},
): Promise<string> {
  const built = buildFilterGraph(m);
  let graph = built.graph;
  const inputs: string[] = [];
  for (const p of built.inputPaths) inputs.push('-i', p);

  let assPath: string | null = null;
  if (opts.burnCaptions && m.captions.enabled && !ffmpegHasFilter('ass')) {
    throw new Error(
      'this ffmpeg build lacks the `ass` filter (caption burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or export without --burn-captions.',
    );
  }
  let vLabel = built.videoLabel;
  if (opts.burnCaptions && m.captions.enabled) {
    assPath = path.join(path.dirname(outPath), '.vedit-captions.ass');
    await fs.writeFile(assPath, toAss(m, transcripts));
    graph += `;${built.videoLabel}ass='${assPath.replace(/'/g, "\\'")}'[vout]`;
    vLabel = '[vout]';
  }

  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', graph,
    '-map', vLabel, '-map', built.audioLabel,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-dn', // drop any data streams (e.g. DJI tmcd) that survived the filtergraph
    '-movflags', '+faststart',
    outPath,
  ]);
  if (assPath) await fs.rm(assPath, { force: true });
  return outPath;
}
