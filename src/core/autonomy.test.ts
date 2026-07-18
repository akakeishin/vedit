import { describe, expect, it } from 'vitest';
import { planAutonomousCandidateBatch, summarizeFirstDraftForCli } from './autonomy.js';
import type { CutCandidate, Manifest } from './types.js';

function manifest(): Manifest {
  return {
    version: 1,
    name: 'autonomy',
    revision: 1,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/media/a.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'clip1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

function candidate(id: string, over: Partial<CutCandidate> = {}): CutCandidate {
  const n = Number(id.replace(/\D/g, '')) || 0;
  return {
    id,
    kind: 'silence',
    sourceId: 's1',
    t0: 1 + n * 3,
    t1: 2 + n * 3,
    wordIds: [],
    label: '1.2s silence after "x"',
    status: 'proposed',
    evidence: { transcriptGap: true, waveform: true, transcriptConflict: false, edge: 'interior' },
    ...over,
  };
}

describe('planAutonomousCandidateBatch', () => {
  it('auto-applies 12 independently corroborated silences and asks only about 3 preference-sensitive fillers', () => {
    const clear = Array.from({ length: 12 }, (_, i) => candidate(`s${i}`));
    const ambiguous = Array.from({ length: 3 }, (_, i) => candidate(`f${i}`, {
      kind: 'filler',
      t0: 40 + i * 2,
      t1: 40.4 + i * 2,
      label: 'filler "えーと"',
      evidence: { transcriptGap: true, waveform: false, transcriptConflict: false, edge: 'interior' },
    }));

    const plan = planAutonomousCandidateBatch(manifest(), [...clear, ...ambiguous]);

    expect(plan.autoApply.map((x) => x.candidate.id)).toEqual(clear.map((x) => x.id));
    expect(plan.needsDecision.map((x) => x.candidate.id)).toEqual(ambiguous.map((x) => x.id));
    expect(plan.needsDecision.every((x) => x.reasonCode === 'preference-required')).toBe(true);
    expect(plan.autoApply).toHaveLength(12);
    expect(plan.needsDecision).toHaveLength(3);
    expect(plan.removedSeconds).toBeGreaterThan(11.5);
    expect(plan.removedSeconds).toBeLessThanOrEqual(12);
  });

  it.each([
    ['legacy candidate with no evidence', candidate('legacy', { evidence: undefined }), 'insufficient-evidence'],
    ['transcript-only gap', candidate('transcript-only', { evidence: { transcriptGap: true, waveform: false, transcriptConflict: false, edge: 'interior' } }), 'insufficient-evidence'],
    ['waveform/transcript conflict', candidate('conflict', { evidence: { transcriptGap: true, waveform: true, transcriptConflict: true, edge: 'interior' } }), 'transcript-conflict'],
    ['leading silence', candidate('leading', { evidence: { transcriptGap: true, waveform: true, transcriptConflict: false, edge: 'leading' } }), 'pacing-sensitive'],
  ])('asks instead of guessing for %s', (_label, c, reasonCode) => {
    const plan = planAutonomousCandidateBatch(manifest(), [c as CutCandidate]);
    expect(plan.autoApply).toHaveLength(0);
    expect(plan.needsDecision).toHaveLength(1);
    expect(plan.needsDecision[0].reasonCode).toBe(reasonCode);
  });

  it('refuses an otherwise-clear candidate that overlaps a deliberate intent zone', () => {
    const m = manifest();
    m.intentZones = [{ id: 'iz1', sourceId: 's1', t0: 3.5, t1: 5, label: '余韻', kind: 'quiet' }];
    const c = candidate('intent', { t0: 4, t1: 4.8 });
    const plan = planAutonomousCandidateBatch(m, [c]);
    expect(plan.autoApply).toHaveLength(0);
    expect(plan.needsDecision).toHaveLength(0);
    expect(plan.excluded[0].reasonCode).toBe('protected-intent');
  });

  it.each(['filler', 'retake'] as const)(
    'excludes protected %s candidates instead of converting the protection into a preference question',
    (kind) => {
      const m = manifest();
      m.intentZones = [{ id: 'iz1', sourceId: 's1', t0: 3.5, t1: 5, label: '見せ場', kind: 'quiet' }];
      const plan = planAutonomousCandidateBatch(m, [candidate(`protected-${kind}`, {
        kind,
        t0: 4,
        t1: 4.5,
      })]);
      expect(plan.autoApply).toHaveLength(0);
      expect(plan.needsDecision).toHaveLength(0);
      expect(plan.excluded[0].reasonCode).toBe('protected-intent');
    },
  );

  it('does not auto-apply an already-decided or invalid zero-width candidate', () => {
    const plan = planAutonomousCandidateBatch(manifest(), [
      candidate('done', { status: 'approved' }),
      candidate('zero', { t0: 3, t1: 3 }),
    ]);
    expect(plan.autoApply).toHaveLength(0);
    expect(plan.needsDecision).toHaveLength(0);
    expect(plan.excluded.map((x) => x.candidate.id)).toEqual(['done', 'zero']);
  });

  it('silently excludes a corroborated range that no longer affects the current timeline', () => {
    const plan = planAutonomousCandidateBatch(manifest(), [candidate('outside', { t0: 70, t1: 71 })]);
    expect(plan.autoApply).toHaveLength(0);
    expect(plan.needsDecision).toHaveLength(0);
    expect(plan.excluded[0].reasonCode).toBe('no-timeline-effect');
  });

  it.each([
    ['filler', { transcriptGap: true, waveform: false, transcriptConflict: false, edge: 'interior' }],
    ['retake', undefined],
    ['silence', undefined],
  ] as const)('silently excludes an out-of-timeline %s before asking about its kind or evidence', (kind, evidence) => {
    const plan = planAutonomousCandidateBatch(manifest(), [candidate(`outside-${kind}`, {
      kind,
      t0: 70,
      t1: 71,
      evidence,
    })]);
    expect(plan.autoApply).toHaveLength(0);
    expect(plan.needsDecision).toHaveLength(0);
    expect(plan.excluded[0].reasonCode).toBe('no-timeline-effect');
  });

  it('uses deterministic source/time order even when overlapping candidates are stored out of order', () => {
    const m = manifest();
    m.fps = 10;
    m.sources[0].duration = 5;
    m.timeline.video = [{ id: 'clip1', sourceId: 's1', srcIn: 0, srcOut: 5 }];
    const plan = planAutonomousCandidateBatch(m, [
      candidate('a', { t0: 1.5, t1: 2.7 }),
      candidate('b', { t0: 0.8, t1: 1.3 }),
      candidate('c', { t0: 1.3, t1: 2.5 }),
    ]);
    expect(plan.autoApply.map((item) => item.candidate.id)).toEqual(['b', 'c', 'a']);
    expect(plan.fragmentsAbsorbed).toEqual([]);
  });
});

describe('summarizeFirstDraftForCli', () => {
  it('bounds a large question set while preserving counts, reasons, and compact project truth', () => {
    const needsDecision = Array.from({ length: 89 }, (_, i) => ({
      candidate: candidate(`q${i}`, {
        kind: i % 2 ? 'filler' : 'silence',
        label: `question ${i}`,
      }),
      reasonCode: i % 2 ? 'preference-required' as const : 'fragmentation-risk' as const,
      reason: i % 2 ? '好みが必要です' : '断片を巻き込みます',
    }));

    const summary = summarizeFirstDraftForCli({
      autoApplied: 14,
      removedSeconds: 8.25,
      questionCount: needsDecision.length,
      needsDecision,
      evidenceGate: 'transcript+waveform',
      state: {
        revision: 94,
        duration: 27_293.7,
        clips: 93,
        pendingCandidates: 89,
        sources: Array.from({ length: 93 }, () => ({})),
      },
    }, {
      pending: Array.from({ length: 89 }, () => ({})),
      warnings: ['untranscribed sources skipped'],
    });

    expect(summary).toMatchObject({
      autoApplied: 14,
      removedSeconds: 8.25,
      questionCount: 89,
      moreQuestions: 84,
      questionReasons: { 'fragmentation-risk': 45, 'preference-required': 44 },
      detected: 89,
      state: { revision: 94, sourceCount: 93, pendingCandidates: 89 },
    });
    expect(summary.questionExamples).toHaveLength(5);
    expect(JSON.stringify(summary)).not.toContain('"sources"');
    expect(JSON.stringify(summary).length).toBeLessThan(2_500);
    expect(summary.hint).toContain('vedit candidates');
  });
});
