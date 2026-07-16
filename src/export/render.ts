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

/**
 * Final render from ORIGINAL sources (not proxies): trim+concat filtergraph,
 * optional ASS caption burn. Motion overlays are not baked yet (preview-only
 * for now; on NLE export they travel as markers + spec sidecars).
 */
export async function renderFinal(
  m: Manifest,
  transcripts: Transcript[],
  outPath: string,
  opts: { burnCaptions?: boolean } = {},
): Promise<string> {
  const segs = segments(m);
  if (segs.length === 0) throw new Error('empty timeline');
  const srcIds = [...new Set(segs.map((s) => s.sourceId))];
  const srcById = new Map(m.sources.map((s) => [s.id, s]));
  const inputs: string[] = [];
  for (const id of srcIds) inputs.push('-i', srcById.get(id)!.path);
  const output = m.output ?? { width: m.width, height: m.height };

  const parts: string[] = [];
  const labels: string[] = [];
  segs.forEach((seg, i) => {
    const idx = srcIds.indexOf(seg.sourceId);
    const src = srcById.get(seg.sourceId)!;
    const a = seg.srcStart;
    const b = seg.srcStart + (seg.tlEnd - seg.tlStart);
    // Original sources are rendered at their real resolution, so crop
    // geometry can be computed in exact pixels (unlike the proxy-based
    // filmstrip in view.ts, which has to fall back to fractional crop).
    const geo = cropGeometry(src.width, src.height, output.width, output.height, seg.crop);
    const cropPart = geo ? `crop=${geo.width}:${geo.height}:${geo.x}:${geo.y},` : '';
    parts.push(
      `[${idx}:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS,${cropPart}scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2,fps=${m.fps}[v${i}]`,
    );
    if (src.hasAudio) parts.push(`[${idx}:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[a${i}]`);
    else parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${b - a}[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  let graph = parts.join(';') + `;${labels.join('')}concat=n=${segs.length}:v=1:a=1[vc][ac]`;

  let assPath: string | null = null;
  if (opts.burnCaptions && m.captions.enabled && !ffmpegHasFilter('ass')) {
    throw new Error(
      'this ffmpeg build lacks the `ass` filter (caption burn). Install `brew install ffmpeg-full` or set VEDIT_FFMPEG, or export without --burn-captions.',
    );
  }
  if (opts.burnCaptions && m.captions.enabled) {
    assPath = path.join(path.dirname(outPath), '.vedit-captions.ass');
    await fs.writeFile(assPath, toAss(m, transcripts));
    graph += `;[vc]ass='${assPath.replace(/'/g, "\\'")}'[vout]`;
  }
  const vLabel = assPath ? '[vout]' : '[vc]';

  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', graph,
    '-map', vLabel, '-map', '[ac]',
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
