import { promises as fs } from 'node:fs';
import { captionCues } from '../core/captions.js';
import type { Manifest, Transcript } from '../core/types.js';

// SRT export exists because OTIO drops captions entirely (no cue-list
// concept in the schema) — Resolve/Premiere need a sidecar file instead.

function srtTime(t: number): string {
  // Round to whole milliseconds first so e.g. 59.9996s doesn't truncate to
  // "59,999" one frame short of rolling over to the next minute.
  const totalMs = Math.max(0, Math.round(t * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function toSrt(m: Manifest, transcripts: Transcript[]): string {
  const cues = captionCues(m, transcripts);
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.tlStart)} --> ${srtTime(c.tlEnd)}\n${c.text}\n`).join('\n');
}

export async function writeSrt(m: Manifest, transcripts: Transcript[], outPath: string): Promise<string> {
  await fs.writeFile(outPath, toSrt(m, transcripts));
  return outPath;
}
