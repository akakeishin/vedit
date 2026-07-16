import path from 'node:path';
import { cropGeometry, segments } from '../core/ops.js';
import type { Manifest } from '../core/types.js';
import { ffmpegHasFilter, run } from '../ingest/run.js';

/**
 * Frames come from the proxy (or, for domain 'source', straight from the
 * source path) at whatever resolution ffmpeg actually decodes — not
 * necessarily src.width/height, which record the ORIGINAL file. Pixel-exact
 * crop coordinates computed against the original resolution would be wrong
 * here, so express the crop as iw/ih-relative fractions instead; ffmpeg
 * resolves those against the real decoded frame size.
 */
function cropFilterExpr(geo: { width: number; height: number; x: number; y: number } | null, srcW: number, srcH: number): string {
  if (!geo) return '';
  const fw = geo.width / srcW;
  const fh = geo.height / srcH;
  const fx = geo.x / srcW;
  const fy = geo.y / srcH;
  return `crop=iw*${fw}:ih*${fh}:iw*${fx}:ih*${fy},`;
}

/**
 * Filmstrip + waveform digest PNG so Claude can inspect footage without
 * playing video. Frames carry burned-in SOURCE timecodes.
 *
 * domain 'timeline': renders the current edit (cuts skipped) for a timeline
 * range. domain 'source': renders raw source time (cuts visible).
 */
export async function renderView(
  m: Manifest,
  projectDir: string,
  opts: {
    domain?: 'timeline' | 'source';
    sourceId?: string;
    from?: number;
    to?: number;
    cols?: number;
    rows?: number;
  } = {},
): Promise<{ png: string; timecodesBurnedIn: boolean; grid: string[] }> {
  const cols = opts.cols ?? 6;
  const rows = opts.rows ?? 2;
  const n = cols * rows;
  const domain = opts.domain ?? 'timeline';
  const segs = segments(m);
  if (segs.length === 0) throw new Error('empty timeline');
  const srcById = new Map(m.sources.map((s) => [s.id, s]));

  // Build the list of (sourceId, srcTime) sample points. Crop only applies
  // in 'timeline' domain — it's a per-clip concept, and 'source' domain is
  // meant to show the raw, uncut, unframed source for inspection.
  const points: { sourceId: string; t: number; crop?: { x?: number; y?: number } }[] = [];
  if (domain === 'timeline') {
    const total = segs[segs.length - 1].tlEnd;
    const from = opts.from ?? 0;
    const to = Math.min(opts.to ?? total, total);
    for (let i = 0; i < n; i++) {
      const tl = from + ((to - from) * (i + 0.5)) / n;
      const seg = segs.find((s) => tl >= s.tlStart && tl < s.tlEnd) ?? segs[segs.length - 1];
      points.push({ sourceId: seg.sourceId, t: seg.srcStart + (tl - seg.tlStart), crop: seg.crop });
    }
  } else {
    const sourceId = opts.sourceId ?? m.sources[0].id;
    const dur = srcById.get(sourceId)!.duration;
    const from = opts.from ?? 0;
    const to = Math.min(opts.to ?? dur, dur);
    for (let i = 0; i < n; i++) points.push({ sourceId, t: from + ((to - from) * (i + 0.5)) / n });
  }

  // Extract each frame (proxy, fast seeks), stamp timecode, tile, add waveform.
  const canDrawText = ffmpegHasFilter('drawtext');
  const tmpFrames: string[] = [];
  const outPath = path.join(projectDir, 'cache', `view-${Date.now()}.png`);
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const src = srcById.get(pt.sourceId)!;
    const media = src.proxy ? path.join(projectDir, src.proxy) : src.path;
    const f = path.join(projectDir, 'cache', `.vf${i}.png`);
    const mm = Math.floor(pt.t / 60);
    const ss = (pt.t % 60).toFixed(1).padStart(4, '0');
    const geo = m.output ? cropGeometry(src.width, src.height, m.output.width, m.output.height, pt.crop) : null;
    const cropPart = cropFilterExpr(geo, src.width, src.height);
    const vf = canDrawText
      ? `${cropPart}scale=320:-2,drawtext=text='${mm}\\:${ss}':x=6:y=h-th-6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6`
      : `${cropPart}scale=320:-2`;
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(pt.t), '-i', media, '-frames:v', '1', '-vf', vf, f]);
    tmpFrames.push(f);
  }
  const inputs = tmpFrames.flatMap((f) => ['-i', f]);
  const tile = tmpFrames.map((_, i) => `[${i}:v]`).join('') + `xstack=grid=${cols}x${rows}[strip]`;
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', tile, '-map', '[strip]', outPath]);
  await run('rm', tmpFrames);
  // Grid legend (left-to-right, top-to-bottom): source times of each cell,
  // essential when timecodes could not be burned in.
  const grid = points.map((pt, i) => `cell${i + 1}(r${Math.floor(i / cols) + 1}c${(i % cols) + 1})=${pt.t.toFixed(1)}s@${pt.sourceId}`);
  return { png: outPath, timecodesBurnedIn: canDrawText, grid };
}
