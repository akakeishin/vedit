import path from 'node:path';
import { segments } from '../core/ops.js';
import type { Manifest } from '../core/types.js';
import { run } from '../ingest/run.js';

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
): Promise<string> {
  const cols = opts.cols ?? 6;
  const rows = opts.rows ?? 2;
  const n = cols * rows;
  const domain = opts.domain ?? 'timeline';
  const segs = segments(m);
  if (segs.length === 0) throw new Error('empty timeline');
  const srcById = new Map(m.sources.map((s) => [s.id, s]));

  // Build the list of (sourceId, srcTime) sample points.
  const points: { sourceId: string; t: number }[] = [];
  if (domain === 'timeline') {
    const total = segs[segs.length - 1].tlEnd;
    const from = opts.from ?? 0;
    const to = Math.min(opts.to ?? total, total);
    for (let i = 0; i < n; i++) {
      const tl = from + ((to - from) * (i + 0.5)) / n;
      const seg = segs.find((s) => tl >= s.tlStart && tl < s.tlEnd) ?? segs[segs.length - 1];
      points.push({ sourceId: seg.sourceId, t: seg.srcStart + (tl - seg.tlStart) });
    }
  } else {
    const sourceId = opts.sourceId ?? m.sources[0].id;
    const dur = srcById.get(sourceId)!.duration;
    const from = opts.from ?? 0;
    const to = Math.min(opts.to ?? dur, dur);
    for (let i = 0; i < n; i++) points.push({ sourceId, t: from + ((to - from) * (i + 0.5)) / n });
  }

  // Extract each frame (proxy, fast seeks), stamp timecode, tile, add waveform.
  const tmpFrames: string[] = [];
  const outPath = path.join(projectDir, 'cache', `view-${Date.now()}.png`);
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const src = srcById.get(pt.sourceId)!;
    const media = src.proxy ? path.join(projectDir, src.proxy) : src.path;
    const f = path.join(projectDir, 'cache', `.vf${i}.png`);
    const mm = Math.floor(pt.t / 60);
    const ss = (pt.t % 60).toFixed(1).padStart(4, '0');
    await run('ffmpeg', [
      '-y', '-v', 'error', '-ss', String(pt.t), '-i', media,
      '-frames:v', '1',
      '-vf',
      `scale=320:-2,drawtext=text='${mm}\\:${ss}':x=6:y=h-th-6:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6`,
      f,
    ]);
    tmpFrames.push(f);
  }
  const inputs = tmpFrames.flatMap((f) => ['-i', f]);
  const tile = tmpFrames.map((_, i) => `[${i}:v]`).join('') + `xstack=grid=${cols}x${rows}[strip]`;
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', tile, '-map', '[strip]', outPath]);
  await run('rm', tmpFrames);
  return outPath;
}
