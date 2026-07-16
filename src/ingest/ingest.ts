import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshId } from '../core/ops.js';
import type { Project } from '../core/project.js';
import type { Source, Transcript, Word } from '../core/types.js';
import { run, runBinary } from './run.js';

export interface ProbeResult {
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ]);
  const j = JSON.parse(out);
  const v = (j.streams as any[]).find((s) => s.codec_type === 'video');
  const a = (j.streams as any[]).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`no video stream in ${file}`);
  const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(j.format.duration ?? v.duration ?? 0),
    fps: den ? num / den : 30,
    width: v.width,
    height: v.height,
    hasAudio: Boolean(a),
  };
}

/**
 * One-time 720p-class CFR proxy for smooth seeking; original is never touched.
 * Keeps the source fps as-is (e.g. 29.97) rather than rounding it — rounding
 * to 30 drifts the proxy out of sync with the original over a long timeline.
 * Only very high frame rates (>60) get capped, to keep the proxy light.
 */
export async function makeProxy(file: string, outPath: string, p: ProbeResult): Promise<void> {
  const targetH = Math.min(720, p.height);
  const fps = p.fps > 60 ? 30 : p.fps || 30;
  const gop = Math.max(1, Math.round(fps));
  await run('ffmpeg', [
    '-y', '-i', file,
    '-vf', `scale=-2:${targetH}`,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-g', String(gop), // ~1s keyframe interval → snappy seeks
    '-pix_fmt', 'yuv420p',
    ...(p.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-dn', '-map_metadata', '-1', // drop data streams (e.g. DJI tmcd) and source metadata
    '-movflags', '+faststart',
    outPath,
  ]);
}

/** Mono peak envelope for waveform display: `rate` values per second, 0..1. */
export async function makePeaks(file: string, outPath: string, rate = 25): Promise<void> {
  const sr = 8000;
  const buf = await runBinary('ffmpeg', [
    '-v', 'error', '-i', file,
    '-map', 'a:0?', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-',
  ]);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const win = Math.floor(sr / rate);
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    let max = 0;
    for (let j = i; j < Math.min(i + win, samples.length); j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(Math.round((max / 32768) * 100) / 100);
  }
  await fs.writeFile(outPath, JSON.stringify({ rate, peaks }));
}

// ---- transcription (whisper.cpp) ----

const MODEL_DIR = path.join(os.homedir(), '.cache', 'vedit', 'models');
const MODEL_URL = (name: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${name}.bin`;

export async function findWhisperModel(): Promise<string | null> {
  const preferred = process.env.VEDIT_WHISPER_MODEL;
  if (preferred) return preferred;
  try {
    const files = await fs.readdir(MODEL_DIR);
    const bins = files.filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'));
    // Prefer larger/turbo models when several are present.
    const order = ['large-v3-turbo', 'large', 'medium', 'small', 'base', 'tiny'];
    bins.sort((a, b) => order.findIndex((o) => a.includes(o)) - order.findIndex((o) => b.includes(o)));
    return bins.length ? path.join(MODEL_DIR, bins[0]) : null;
  } catch {
    return null;
  }
}

export async function downloadWhisperModel(name = 'ggml-large-v3-turbo'): Promise<string> {
  await fs.mkdir(MODEL_DIR, { recursive: true });
  const dest = path.join(MODEL_DIR, `${name}.bin`);
  try {
    await fs.access(dest);
    return dest;
  } catch { /* download below */ }
  await run('curl', ['-L', '--fail', '-o', dest + '.part', MODEL_URL(name)], { maxBuffer: 1024 });
  await fs.rename(dest + '.part', dest);
  return dest;
}

/**
 * Word-level transcription via whisper-cli. Tokens are merged into words:
 * latin tokens merge until a leading space; CJK tokens stay as-is (token-level
 * granularity is the natural cut unit for Japanese).
 */
export async function transcribe(
  file: string,
  sourceId: string,
  opts: { model?: string; language?: string; sourceDuration?: number } = {},
): Promise<Transcript> {
  const model = opts.model ?? (await findWhisperModel());
  if (!model) {
    throw new Error(
      'no whisper model found. Run `vedit doctor --download-model` (default: large-v3-turbo, ~1.6GB) or set VEDIT_WHISPER_MODEL.',
    );
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vedit-asr-'));
  const wav = path.join(tmp, 'audio.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-map', 'a:0', '-ac', '1', '-ar', '16000', wav]);
  const outBase = path.join(tmp, 'out');
  const args = [
    '-m', model,
    '-f', wav,
    '-ojf', // full JSON with token-level offsets
    '-of', outBase,
    '--threads', String(Math.max(2, os.cpus().length - 2)),
  ];
  if (opts.language) args.push('-l', opts.language);
  else args.push('-l', 'auto');
  await run('whisper-cli', args, { maxBuffer: 256 * 1024 * 1024 });
  const j = JSON.parse(await fs.readFile(outBase + '.json', 'utf8'));
  const words: Word[] = [];
  let n = 0;
  const push = (text: string, t0: number, t1: number, p: number) => {
    const clean = text.trim();
    if (!clean) return;
    words.push({ id: `w${(n++).toString().padStart(4, '0')}`, text: clean, t0, t1, p });
  };
  for (const seg of j.transcription ?? []) {
    let cur: { text: string; t0: number; t1: number; p: number } | null = null;
    for (const tok of seg.tokens ?? []) {
      const text: string = tok.text ?? '';
      if (text.startsWith('[_') || text.startsWith('<|')) continue; // special tokens
      const t0 = (tok.offsets?.from ?? 0) / 1000;
      const t1 = (tok.offsets?.to ?? 0) / 1000;
      const p = tok.p ?? 1;
      const startsWord = text.startsWith(' ') || /^[　-鿿！-｠ぁ-んァ-ヶ]/u.test(text);
      if (cur && startsWord) {
        push(cur.text, cur.t0, cur.t1, cur.p);
        cur = null;
      }
      if (!cur) cur = { text, t0, t1, p };
      else {
        cur.text += text;
        cur.t1 = t1;
        cur.p = Math.min(cur.p, p);
      }
    }
    if (cur) push(cur.text, cur.t0, cur.t1, cur.p);
  }
  await fs.rm(tmp, { recursive: true, force: true });
  return {
    sourceId,
    language: j.result?.language ?? opts.language ?? 'auto',
    words: sanitizeWords(words, opts.sourceDuration),
  };
}

/**
 * whisper-cli sometimes collapses a run of trailing words near a clip's end
 * to the same zero-width timestamp (t0 === t1) instead of spreading them out
 * — observed in practice, and it makes remove-words/captions unusable there.
 * This pass fixes that up:
 *  - a run of zero-width words gets time reallocated across
 *    [previous good word's t1, next good word's t0 (or sourceDuration)],
 *    proportional to character count; confidence is capped at 0.3 since the
 *    timing is a guess.
 *  - standalone punctuation/symbol tokens are folded into a neighboring
 *    word's text instead of staying their own (often zero-width) Word.
 *  - a zero-width word that still can't be anchored (no usable boundary on
 *    either side) is kept as-is but marked p=0 so callers treat it as noise.
 */
export function sanitizeWords(raw: Word[], sourceDuration?: number): Word[] {
  if (raw.length === 0) return raw;

  // Fold standalone punctuation/symbol tokens into a neighbor: glued onto the
  // previous word if one exists yet, else prefixed onto the next real word.
  const PUNCT_ONLY = /^[、。！？!?」「『』()（）\[\]【】…・,.\s]+$/u;
  const folded: Word[] = [];
  let prefix = '';
  for (const w of raw) {
    if (PUNCT_ONLY.test(w.text)) {
      if (folded.length > 0) folded[folded.length - 1] = { ...folded[folded.length - 1], text: folded[folded.length - 1].text + w.text };
      else prefix += w.text;
      continue;
    }
    folded.push(prefix ? { ...w, text: prefix + w.text } : { ...w });
    prefix = '';
  }
  if (prefix) {
    // trailing punctuation with nothing after it to attach to; keep the input.
    if (folded.length === 0) return raw;
    folded[folded.length - 1] = { ...folded[folded.length - 1], text: folded[folded.length - 1].text + prefix };
  }

  // Reallocate time for runs of zero-width (t0 >= t1) words.
  const out: Word[] = [];
  for (let i = 0; i < folded.length; i++) {
    if (folded[i].t1 > folded[i].t0) {
      out.push(folded[i]);
      continue;
    }
    let j = i;
    while (j < folded.length && folded[j].t1 <= folded[j].t0) j++;
    const run = folded.slice(i, j);
    const prevGood = out[out.length - 1];
    const nextGood = folded[j];
    const start = prevGood ? prevGood.t1 : run[0].t0;
    const end = nextGood ? nextGood.t0 : sourceDuration;
    if (end !== undefined && end > start) {
      const totalChars = run.reduce((a, w) => a + Math.max(1, w.text.length), 0);
      let t = start;
      for (const w of run) {
        const share = (Math.max(1, w.text.length) / totalChars) * (end - start);
        const t0 = t;
        const t1 = t0 + share;
        out.push({ ...w, t0, t1, p: Math.min(w.p, 0.3) });
        t = t1;
      }
    } else {
      for (const w of run) out.push({ ...w, p: 0 });
    }
    i = j - 1;
  }
  return out;
}

// ---- full ingest ----

export interface IngestProgress {
  (step: string): void;
}

export interface IngestResult {
  source: Source;
  /** Wall-clock ms per phase, so slow steps (usually transcription) are visible. */
  timings: Record<string, number>;
}

export async function ingestFile(
  project: Project,
  file: string,
  opts: { language?: string; transcribe?: boolean; addToTimeline?: boolean; onProgress?: IngestProgress } = {},
): Promise<IngestResult> {
  const abs = path.resolve(file);
  await fs.access(abs);
  const notify = opts.onProgress ?? (() => {});
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - started;
    }
  };

  notify('probing');
  const p = await timed('probeMs', () => probe(abs));
  const id = freshId('src');
  const proxyRel = `cache/proxy-${id}.mp4`;
  const peaksRel = `cache/peaks-${id}.json`;
  notify('generating proxy');
  await timed('proxyMs', () => makeProxy(abs, path.join(project.dir, proxyRel), p));
  if (p.hasAudio) {
    notify('extracting waveform');
    await timed('peaksMs', () => makePeaks(abs, path.join(project.dir, peaksRel)));
  }
  const source: Source = {
    id,
    path: abs,
    duration: p.duration,
    fps: p.fps,
    width: p.width,
    height: p.height,
    hasAudio: p.hasAudio,
    proxy: proxyRel,
    peaks: p.hasAudio ? peaksRel : undefined,
    transcribed: false,
  };
  if (p.hasAudio && opts.transcribe !== false) {
    notify('transcribing (whisper)');
    const t = await timed('transcribeMs', () => transcribe(abs, id, { language: opts.language, sourceDuration: p.duration }));
    await project.writeTranscript(t);
    source.transcribed = true;
  }
  const addToTimeline = opts.addToTimeline ?? true;
  const cur = await project.manifest();
  await project.commit(
    cur.revision,
    'system',
    'ingest',
    { file: abs },
    `ingested ${path.basename(abs)} (${p.duration.toFixed(1)}s)${addToTimeline ? '' : ', pool only'}`,
    (m) => {
      const first = m.sources.length === 0;
      return {
        ...m,
        fps: first ? Math.min(60, p.fps) : m.fps,
        width: first ? p.width : m.width,
        height: first ? p.height : m.height,
        sources: [...m.sources, source],
        timeline: addToTimeline
          ? {
              ...m.timeline,
              video: [
                ...m.timeline.video,
                { id: freshId('c'), sourceId: id, srcIn: 0, srcOut: p.duration },
              ],
            }
          : m.timeline,
      };
    },
  );
  return { source, timings };
}
