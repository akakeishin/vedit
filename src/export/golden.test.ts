import { describe, expect, it } from 'vitest';
import { hasReframe, toOtio } from './otio.js';
import { toSrt } from './srt.js';
import { toAss } from './render.js';
import { segments } from '../core/ops.js';
import { captionCues } from '../core/captions.js';
import type { Manifest, Source, Transcript, VideoClip, Word } from '../core/types.js';

// Golden export tests: fixed manifest fixtures spanning the fps/source
// combinations real projects hit (23.976 / 29.97 / 30fps, mixed-fps sources,
// an audio-less source mixed in, and a reframed/cropped timeline), asserting
// STRUCTURAL invariants of the otio/srt/ass output rather than snapshotting
// exact strings. Snapshots would break on every cosmetic formatting change;
// these invariants only break when the export is actually wrong.
//
// Fixtures/timings here are deliberately distinct from otio.test.ts /
// srt.test.ts / render.test.ts so this file adds coverage rather than
// re-asserting the same cases.

const NTSC24 = 24000 / 1001; // 23.976
const NTSC30 = 30000 / 1001; // 29.97
const FILM30 = 30;

function src(partial: Partial<Source> & { id: string; path: string; duration: number; fps: number }): Source {
  return { width: 1920, height: 1080, hasAudio: true, ...partial };
}

function clip(partial: Partial<VideoClip> & { id: string; sourceId: string; srcIn: number; srcOut: number }): VideoClip {
  return partial;
}

function manifestOf(opts: {
  fps: number;
  sources: Source[];
  clips: VideoClip[];
  output?: { width: number; height: number };
  maxChars?: number;
}): Manifest {
  return {
    version: 1,
    name: 'golden',
    revision: 1,
    fps: opts.fps,
    width: 1920,
    height: 1080,
    sources: opts.sources,
    timeline: { video: opts.clips, motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: opts.maxChars ?? 20 },
    ...(opts.output ? { output: opts.output } : {}),
  };
}

/** Synthetic word list: one sentence, words spaced at a plausible speech rate, source-time absolute. */
function wordsFromText(idPrefix: string, startT: number, text: string, wordDur = 0.3, gap = 0.05): Word[] {
  const parts = text.split(' ');
  let t = startT;
  return parts.map((w, i) => {
    const t0 = t;
    const t1 = t0 + wordDur;
    t = t1 + gap;
    return { id: `${idPrefix}${i}`, text: w, t0, t1, p: 0.9 };
  });
}

// ---- fixtures -------------------------------------------------------------

const FX_23976 = {
  label: '23.976fps single source',
  manifest: manifestOf({
    fps: NTSC24,
    sources: [src({ id: 's1', path: '/footage/interview-a.mov', duration: 40, fps: NTSC24 })],
    clips: [
      clip({ id: 'gc0', sourceId: 's1', srcIn: 0.5, srcOut: 4.2 }),
      clip({ id: 'gc1', sourceId: 's1', srcIn: 6.0, srcOut: 10.75 }),
      clip({ id: 'gc2', sourceId: 's1', srcIn: 15.0, srcOut: 19.3 }),
    ],
  }),
  transcripts: [
    {
      sourceId: 's1',
      language: 'en',
      words: [
        ...wordsFromText('a', 1.0, 'This is the opening line of the interview.'),
        ...wordsFromText('b', 7.0, 'Now we move to the middle section here.'),
        ...wordsFromText('c', 16.0, 'Finally the conclusion arrives now.'),
      ],
    },
  ] as Transcript[],
};

const FX_2997 = {
  label: '29.97fps single source',
  manifest: manifestOf({
    fps: NTSC30,
    sources: [src({ id: 's1', path: '/footage/vlog-b.mp4', duration: 50, fps: NTSC30 })],
    clips: [
      clip({ id: 'gc0', sourceId: 's1', srcIn: 1.2, srcOut: 5.6 }),
      clip({ id: 'gc1', sourceId: 's1', srcIn: 8.0, srcOut: 9.75 }),
      clip({ id: 'gc2', sourceId: 's1', srcIn: 20.333, srcOut: 24.9 }),
    ],
    maxChars: 18,
  }),
  transcripts: [
    {
      sourceId: 's1',
      language: 'en',
      words: [
        ...wordsFromText('d', 1.5, 'Quick clip about testing exports.'),
        ...wordsFromText('e', 8.2, 'Short middle beat here.'),
        ...wordsFromText('f', 20.6, 'Wrap up and roll credits now please.'),
      ],
    },
  ] as Transcript[],
};

const FX_30 = {
  label: '30fps single source',
  manifest: manifestOf({
    fps: FILM30,
    sources: [src({ id: 's1', path: '/footage/screencast-c.mp4', duration: 25, fps: FILM30 })],
    clips: [
      clip({ id: 'gc0', sourceId: 's1', srcIn: 0, srcOut: 6 }),
      clip({ id: 'gc1', sourceId: 's1', srcIn: 10, srcOut: 14.5 }),
      clip({ id: 'gc2', sourceId: 's1', srcIn: 18, srcOut: 24 }),
    ],
    maxChars: 22,
  }),
  transcripts: [
    {
      sourceId: 's1',
      language: 'en',
      words: [
        ...wordsFromText('g', 0.5, 'Screen capture demo starts now.'),
        ...wordsFromText('h', 10.5, 'Middle explanation continues steadily.'),
        ...wordsFromText('i', 18.5, 'Final thoughts and thank you.'),
      ],
    },
  ] as Transcript[],
};

// Mixed fps across two sources (24p A-cam / 29.97 B-cam) at a 29.97 timeline
// rate, with the B-cam source carrying no audio track (slate/drone-style
// footage) — covers both the "mixed fps 2 sources" and "audio-less source
// mixed in" backlog items in one fixture, interleaved on the timeline.
const FX_MIXED = {
  label: 'mixed fps 2 sources, one audio-less',
  manifest: manifestOf({
    fps: NTSC30,
    sources: [
      src({ id: 's1', path: '/footage/a-cam-24p.mov', duration: 30, fps: NTSC24 }),
      src({ id: 's2', path: '/footage/b-cam-slate.mov', duration: 20, fps: NTSC30, hasAudio: false }),
    ],
    clips: [
      clip({ id: 'gc0', sourceId: 's1', srcIn: 0, srcOut: 3 }),
      clip({ id: 'gc1', sourceId: 's2', srcIn: 0, srcOut: 2.5 }),
      clip({ id: 'gc2', sourceId: 's1', srcIn: 5, srcOut: 9 }),
      clip({ id: 'gc3', sourceId: 's2', srcIn: 5, srcOut: 6.2 }),
    ],
  }),
  transcripts: [
    {
      sourceId: 's1',
      language: 'en',
      words: [
        ...wordsFromText('j', 0.4, 'Camera one intro segment starts.'),
        ...wordsFromText('k', 5.3, 'Camera one returns for more footage.'),
      ],
    },
  ] as Transcript[],
};

// Reframe: vertical output canvas cropped from a horizontal source, with
// per-clip crop windows on two of three clips (the third relies on default
// centering, i.e. no `crop` field at all).
const FX_REFRAME = {
  label: 'reframe with per-clip crop',
  manifest: manifestOf({
    fps: NTSC30,
    sources: [src({ id: 's1', path: '/footage/wide-shot.mp4', duration: 30, fps: NTSC30 })],
    clips: [
      clip({ id: 'gc0', sourceId: 's1', srcIn: 1, srcOut: 5, crop: { x: 0.2 } }),
      clip({ id: 'gc1', sourceId: 's1', srcIn: 8, srcOut: 12.5, crop: { y: 0.8 } }),
      clip({ id: 'gc2', sourceId: 's1', srcIn: 15, srcOut: 18 }),
    ],
    output: { width: 1080, height: 1920 },
  }),
  transcripts: [
    {
      sourceId: 's1',
      language: 'en',
      words: [
        ...wordsFromText('l', 1.5, 'Vertical reframe test clip one.'),
        ...wordsFromText('m', 8.5, 'Second clip with different crop position.'),
        ...wordsFromText('n', 15.3, 'Third clip no crop override applied.'),
      ],
    },
  ] as Transcript[],
};

const FIXTURES = [FX_23976, FX_2997, FX_30, FX_MIXED, FX_REFRAME];

// ---- otio invariant helpers -----------------------------------------------

function videoTrack(o: any) {
  return o.tracks.children.find((t: any) => t.kind === 'Video');
}
function audioTrack(o: any) {
  return o.tracks.children.find((t: any) => t.kind === 'Audio');
}
function trackSeconds(track: any): number {
  return track.children.reduce((acc: number, c: any) => acc + c.source_range.duration.value / c.source_range.duration.rate, 0);
}

function assertOtioInvariants(m: Manifest, label: string) {
  const o: any = toOtio(m);
  const rate = m.fps;
  const segs = segments(m);
  const srcById = new Map(m.sources.map((s) => [s.id, s]));
  const video = videoTrack(o);
  const audio = audioTrack(o);

  expect(video.children, `${label}: video track length`).toHaveLength(segs.length);
  expect(audio.children, `${label}: audio track length`).toHaveLength(segs.length);
  // no Gaps ever appear on the video track (audio-only concept)
  expect(video.children.some((c: any) => c.OTIO_SCHEMA === 'Gap.1'), `${label}: no video gaps`).toBe(false);

  // Total track duration (rate-normalized to seconds) matches the segment-
  // derived timeline duration for both tracks. This must be compared in
  // seconds rather than raw frame counts: Clip.1 source_range lives in the
  // MEDIA's own timebase (per-source fps), while Gap.1 (audio-less segments)
  // lives in the TIMELINE's timebase — see otio.ts's comments on both. Raw
  // frame values are therefore not directly summable across a mixed-fps
  // track; seconds are the common unit. Tolerance covers each clip
  // independently rounding its own start/end to the nearest frame at its
  // own rate (bounded by half a frame per segment, at whichever rate it used).
  const totalTlSeconds = segs.reduce((a, s) => a + (s.tlEnd - s.tlStart), 0);
  const tolerance = segs.reduce((a, s) => {
    const clipRate = (srcById.get(s.sourceId)!.fps || rate) as number;
    return a + 0.5 / Math.min(clipRate, rate);
  }, 1e-9);
  expect(Math.abs(trackSeconds(video) - totalTlSeconds), `${label}: video total seconds`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(trackSeconds(audio) - totalTlSeconds), `${label}: audio total seconds`).toBeLessThanOrEqual(tolerance);

  segs.forEach((seg, i) => {
    const source = srcById.get(seg.sourceId)!;
    const srcRate = source.fps || rate;
    const vClip = video.children[i];
    const aClip = audio.children[i];
    const expectedEndFrame = Math.round((seg.srcStart + (seg.tlEnd - seg.tlStart)) * srcRate);

    // video: always a real clip; start+duration = independently-rounded end
    // frame (no cross-clip drift); rate matches the clip's own source fps.
    expect(vClip.OTIO_SCHEMA, `${label} seg${i}: video kind`).toBe('Clip.1');
    expect(
      vClip.source_range.start_time.value + vClip.source_range.duration.value,
      `${label} seg${i}: video start+duration=end`,
    ).toBe(expectedEndFrame);
    expect(vClip.source_range.start_time.rate, `${label} seg${i}: video rate=source fps`).toBe(srcRate);
    expect(vClip.media_reference.available_range.start_time.rate, `${label} seg${i}: media rate=source fps`).toBe(srcRate);

    // audio: Gap.1 exactly where hasAudio=false, Clip.1 (mirroring video)
    // otherwise. This is the "gap position" invariant.
    if (source.hasAudio) {
      expect(aClip.OTIO_SCHEMA, `${label} seg${i}: audio kind`).toBe('Clip.1');
      expect(
        aClip.source_range.start_time.value + aClip.source_range.duration.value,
        `${label} seg${i}: audio start+duration=end`,
      ).toBe(expectedEndFrame);
      expect(aClip.source_range.start_time.rate, `${label} seg${i}: audio rate=source fps`).toBe(srcRate);
    } else {
      expect(aClip.OTIO_SCHEMA, `${label} seg${i}: gap present for audio-less source`).toBe('Gap.1');
      // A Gap's source_range is LOCAL (0..duration), not the segment's
      // absolute timeline position — toOtio builds it via tr(0, tlEnd-tlStart,
      // rate), so start_time is always frame 0 and duration is the segment's
      // own length rounded once (unlike Clip's start+duration, which is two
      // independently-rounded absolute frames subtracted).
      const expectedGapDurationFrames = Math.round((seg.tlEnd - seg.tlStart) * rate);
      expect(aClip.source_range.start_time.value, `${label} seg${i}: gap start=0 (local range)`).toBe(0);
      expect(
        aClip.source_range.start_time.value + aClip.source_range.duration.value,
        `${label} seg${i}: gap start+duration=end`,
      ).toBe(expectedGapDurationFrames);
      expect(aClip.source_range.duration.value, `${label} seg${i}: gap duration frames`).toBe(expectedGapDurationFrames);
      // a Gap isn't tied to any source media, so its rate is the TIMELINE
      // fps, not the (silent) source's fps.
      expect(aClip.source_range.start_time.rate, `${label} seg${i}: gap rate=timeline fps`).toBe(rate);
    }
  });
}

// ---- srt invariant helpers -------------------------------------------------

function parseSrtTimecode(tc: string): number {
  const [hms, ms] = tc.split(',');
  const [h, mnt, s] = hms.split(':').map(Number);
  return h * 3600 + mnt * 60 + s + Number(ms) / 1000;
}

function parseSrtCues(srt: string): { start: number; end: number; lines: string[] }[] {
  const trimmed = srt.trim();
  if (!trimmed) return [];
  return trimmed.split(/\n\n+/).map((block) => {
    const lines = block.split('\n');
    const [startStr, endStr] = lines[1].split(' --> ');
    return { start: parseSrtTimecode(startStr), end: parseSrtTimecode(endStr), lines: lines.slice(2) };
  });
}

function assertSrtInvariants(m: Manifest, transcripts: Transcript[], label: string) {
  const srt = toSrt(m, transcripts);
  const cues = parseSrtCues(srt);
  expect(cues.length, `${label}: has at least one cue`).toBeGreaterThan(0);
  for (let i = 0; i < cues.length; i++) {
    expect(cues[i].start, `${label}: cue${i} start<end`).toBeLessThan(cues[i].end);
    expect(cues[i].lines.length, `${label}: cue${i} 1..2 lines`).toBeGreaterThanOrEqual(1);
    expect(cues[i].lines.length, `${label}: cue${i} 1..2 lines`).toBeLessThanOrEqual(2);
    if (i > 0) {
      // ascending timecodes, no duplicate/overlapping ranges
      expect(cues[i].start, `${label}: cue${i} start ascending`).toBeGreaterThanOrEqual(cues[i - 1].start);
      expect(cues[i].start, `${label}: cue${i} does not overlap cue${i - 1}`).toBeGreaterThanOrEqual(cues[i - 1].end);
    }
  }
}

// ---- ass invariant helper ---------------------------------------------------

function assertAssInvariants(m: Manifest, transcripts: Transcript[], label: string) {
  const ass = toAss(m, transcripts);
  const dialogueCount = ass.split('\n').filter((l) => l.startsWith('Dialogue: ')).length;
  const cueCount = captionCues(m, transcripts).length;
  expect(dialogueCount, `${label}: Dialogue count = cue count`).toBe(cueCount);
  expect(cueCount, `${label}: fixture actually produced cues`).toBeGreaterThan(0);
}

// ---- tests ------------------------------------------------------------------

describe('golden export fixtures — structural invariants', () => {
  for (const fx of FIXTURES) {
    describe(fx.label, () => {
      it('otio: track length, frame consistency, rate, and gap position hold', () => {
        assertOtioInvariants(fx.manifest, fx.label);
      });

      it('srt: ascending, non-overlapping, <=2-line cues', () => {
        assertSrtInvariants(fx.manifest, fx.transcripts, fx.label);
      });

      it('ass: Dialogue count equals cue count', () => {
        assertAssInvariants(fx.manifest, fx.transcripts, fx.label);
      });
    });
  }
});

describe('golden export fixtures — reframe metadata', () => {
  it('flags hasReframe and carries output/crop metadata that OTIO cannot express natively', () => {
    const { manifest } = FX_REFRAME;
    expect(hasReframe(manifest)).toBe(true);

    const o: any = toOtio(manifest);
    expect(o.metadata.vedit.output).toEqual(manifest.output);
    expect(o.metadata.vedit.reframeNote).toBeTruthy();

    const video = videoTrack(o);
    expect(video.children[0].metadata.vedit.crop).toEqual({ x: 0.2 });
    expect(video.children[1].metadata.vedit.crop).toEqual({ y: 0.8 });
    expect(video.children[2].metadata.vedit.crop).toBeUndefined();
  });

  it('a manifest without output/crop does not flag hasReframe', () => {
    expect(hasReframe(FX_30.manifest)).toBe(false);
  });
});
