import { describe, expect, it } from 'vitest';
import { toSrt, wrapSrtLine } from './srt.js';
import type { Manifest, Transcript, Word } from '../core/types.js';

function manifest(): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

// Each word ends with a sentence-terminating period so captionCues flushes
// it as its own cue deterministically, independent of the 0.6s pause rule —
// keeps this a pure test of toSrt's formatting, not of caption line-breaking.
function transcript(): Transcript {
  return {
    sourceId: 's1',
    language: 'en',
    words: [
      { id: 'w0', text: 'Hello.', t0: 1.0, t1: 2.0, p: 0.95 },
      { id: 'w1', text: 'World.', t0: 5.0, t1: 6.0, p: 0.95 },
    ],
  };
}

describe('toSrt', () => {
  it('renders numbered cues with comma-separated SRT timecodes', () => {
    // Each cue's raw flush duration is 0.65s, but "Hello."/"World." (6 chars)
    // need 6/8=0.75s to clear captionCues' CPS floor, so 0.1s is borrowed
    // from the idle gap after each cue, pushing the end time to :02,250 /
    // :06,250 instead of the un-extended :02,150 / :06,150.
    const srt = toSrt(manifest(), [transcript()]);
    expect(srt).toBe(
      '1\n00:00:01,500 --> 00:00:02,250\nHello.\n' +
        '\n' +
        '2\n00:00:05,500 --> 00:00:06,250\nWorld.\n',
    );
  });

  it('returns an empty string when there is nothing to caption', () => {
    expect(toSrt(manifest(), [])).toBe('');
  });

  it('returns an empty string when captions are disabled', () => {
    const m = { ...manifest(), captions: { ...manifest().captions, enabled: false } };
    expect(toSrt(m, [transcript()])).toBe('');
  });

  it('rolls milliseconds over into seconds/minutes cleanly instead of truncating', () => {
    // A word landing right at a minute boundary must not render as
    // "00:00:59,999" one frame short of "00:01:00,000".
    const m: Manifest = {
      ...manifest(),
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 65 }], motion: [] },
    };
    const t: Transcript = {
      sourceId: 's1',
      language: 'en',
      words: [{ id: 'w0', text: 'late.', t0: 59.9996, t1: 60.0004, p: 0.9 }],
    };
    const srt = toSrt(m, [t]);
    expect(srt).toContain('00:01:00,000 -->');
  });
});

describe('wrapSrtLine', () => {
  it('leaves text at or under maxChars untouched', () => {
    expect(wrapSrtLine('short', 24)).toBe('short');
  });

  it('wraps at the last word boundary at or before maxChars', () => {
    expect(wrapSrtLine('a b c d e f.', 10)).toBe('a b c d e\nf.');
  });

  it('hard-breaks at maxChars when there is no word boundary (e.g. CJK text with no spaces)', () => {
    expect(wrapSrtLine('あいうえおかきく', 6)).toBe('あいうえおか\nきく');
  });

  it('never produces more than two lines', () => {
    const wrapped = wrapSrtLine('one two three four five six seven', 8);
    expect(wrapped.split('\n')).toHaveLength(2);
  });
});

describe('toSrt line wrapping', () => {
  it('wraps a cue whose joined text exceeds maxChars into two SRT lines', () => {
    const m: Manifest = { ...manifest(), captions: { ...manifest().captions, maxChars: 10 } };
    const words: Word[] = [
      { id: 'w0', text: 'a', t0: 1.0, t1: 1.1, p: 0.9 },
      { id: 'w1', text: 'b', t0: 1.1, t1: 1.2, p: 0.9 },
      { id: 'w2', text: 'c', t0: 1.2, t1: 1.3, p: 0.9 },
      { id: 'w3', text: 'd', t0: 1.3, t1: 1.4, p: 0.9 },
      { id: 'w4', text: 'e', t0: 1.4, t1: 1.5, p: 0.9 },
      { id: 'w5', text: 'f.', t0: 1.5, t1: 1.6, p: 0.9 },
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    const srt = toSrt(m, [t]);
    expect(srt).toContain('a b c d e\nf.');
  });
});
