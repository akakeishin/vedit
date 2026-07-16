import { describe, expect, it } from 'vitest';
import { packTranscript } from './pack.js';
import type { CutCandidate, Manifest, Transcript, Word } from './types.js';

function manifest(): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

// 20 plain words, none at an idEvery=8 boundary except 0/8/16/last, all high
// confidence, no candidates — the baseline "sparse id" case.
function words(overrides: (Partial<Word> & { id: string })[] = []): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < 20; i++) {
    out.push({ id: `w${i}`, text: `word${i}`, t0: i, t1: i + 0.5, p: 0.9 });
  }
  for (const o of overrides) {
    const idx = out.findIndex((w) => w.id === o.id);
    if (idx >= 0) out[idx] = { ...out[idx], ...o };
  }
  return out;
}

describe('packTranscript id exposure', () => {
  it('only tags every Nth word plus block edges when nothing is flagged', () => {
    const t: Transcript = { sourceId: 's1', language: 'en', words: words() };
    const text = packTranscript(manifest(), t, [], 8);
    // w3 is neither a boundary word nor low-confidence/candidate: no id.
    expect(text).not.toMatch(/word3⟨w3⟩/);
    // w8 is on the idEvery=8 cadence: tagged.
    expect(text).toMatch(/word8⟨w8⟩/);
  });

  it('always tags a low-confidence word even off the id cadence', () => {
    const w = words([{ id: 'w3', p: 0.2 }]);
    const t: Transcript = { sourceId: 's1', language: 'en', words: w };
    const text = packTranscript(manifest(), t, [], 8);
    expect(text).toMatch(/word3⟨w3⟩\?/);
  });

  it('always tags a word carrying a pending cut candidate, even off cadence', () => {
    const w = words();
    const cand: CutCandidate = {
      id: 'cand1',
      kind: 'filler',
      sourceId: 's1',
      t0: w[3].t0,
      t1: w[3].t1,
      wordIds: ['w3'],
      label: 'filler "word3"',
      status: 'proposed',
    };
    const t: Transcript = { sourceId: 's1', language: 'en', words: w };
    const text = packTranscript(manifest(), t, [cand], 8);
    expect(text).toMatch(/word3⟨w3⟩\[filler\]/);
  });

  it('does not tag a candidate word that has already been decided', () => {
    const w = words();
    const cand: CutCandidate = {
      id: 'cand1',
      kind: 'filler',
      sourceId: 's1',
      t0: w[3].t0,
      t1: w[3].t1,
      wordIds: ['w3'],
      label: 'filler "word3"',
      status: 'rejected',
    };
    const t: Transcript = { sourceId: 's1', language: 'en', words: w };
    const text = packTranscript(manifest(), t, [cand], 8);
    expect(text).not.toMatch(/word3⟨w3⟩/);
  });

  it('mentions the --full escape hatch in the header', () => {
    const t: Transcript = { sourceId: 's1', language: 'en', words: words() };
    const text = packTranscript(manifest(), t, [], 8);
    expect(text).toMatch(/vedit transcript --full --source/);
  });
});
