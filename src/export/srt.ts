import { promises as fs } from 'node:fs';
import { captionCues, captionCuesWithExclusions, formatCaptionExclusionWarning } from '../core/captions.js';
import type { CaptionCue } from '../core/captions.js';
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

/**
 * Wrap a cue's text into at most two lines when it exceeds `maxChars`,
 * breaking at the last word boundary at or before the limit. Falls back to a
 * hard character-count split when there's no word boundary to break on
 * (e.g. CJK text, which captionCues joins without spaces).
 */
export function wrapSrtLine(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  let breakAt = -1;
  for (let i = Math.min(maxChars, text.length - 1); i > 0; i--) {
    if (/\s/.test(text[i])) {
      breakAt = i;
      break;
    }
  }
  if (breakAt === -1) return text.slice(0, maxChars) + '\n' + text.slice(maxChars);
  return text.slice(0, breakAt).trimEnd() + '\n' + text.slice(breakAt + 1).trimStart();
}

function srtFromCues(cues: CaptionCue[], maxChars: number): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.tlStart)} --> ${srtTime(c.tlEnd)}\n${wrapSrtLine(c.text, maxChars)}\n`)
    .join('\n');
}

export function toSrt(m: Manifest, transcripts: Transcript[]): string {
  return srtFromCues(captionCues(m, transcripts), m.captions.maxChars);
}

/**
 * P1: same non-speech-tag exclusion captionCues applies internally (a
 * Whisper hallucination like "[MÚSICA DE FUNDO]" never becomes an SRT cue),
 * surfaced here as a stderr warning — the same "警告: " channel renderFinal
 * uses — so running `vedit export srt` directly (without a full render)
 * still makes a dropped cue visible instead of silent.
 */
export async function writeSrt(m: Manifest, transcripts: Transcript[], outPath: string): Promise<string> {
  const { cues, excluded } = captionCuesWithExclusions(m, transcripts);
  if (excluded.length > 0) console.error(`警告: ${formatCaptionExclusionWarning(excluded)}`);
  await fs.writeFile(outPath, srtFromCues(cues, m.captions.maxChars));
  return outPath;
}
