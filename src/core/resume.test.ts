import { describe, expect, it } from 'vitest';
import { buildResume, type ResumeRevisionEntry } from './resume.js';
import type { CutCandidate, Manifest } from './types.js';

function manifest(partial: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    name: 'proj',
    revision: 3,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/media/one.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
    ...partial,
  };
}

function rev(partial: Partial<ResumeRevisionEntry> & { rev: number; actor: ResumeRevisionEntry['actor'] }): ResumeRevisionEntry {
  return { baseRev: partial.rev - 1, op: 'edit', params: {}, ts: `2026-01-0${Math.min(partial.rev, 9)}T00:00:00.000Z`, summary: `rev ${partial.rev}`, ...partial };
}

function candidate(partial: Partial<CutCandidate> & { id: string; kind: CutCandidate['kind']; status: CutCandidate['status'] }): CutCandidate {
  return { sourceId: 's1', t0: 0, t1: 1, wordIds: [], label: '', ...partial };
}

describe('buildResume', () => {
  it('carries project identity/revision/duration/output through verbatim', () => {
    const m = manifest({ output: { width: 1080, height: 1920 } });
    const r = buildResume(m, '/proj/dir', [], []);
    expect(r.project).toEqual({ name: 'proj', dir: '/proj/dir', revision: 3, duration: 60, output: { width: 1080, height: 1920 } });
  });

  it('output is null when the manifest has no output canvas set', () => {
    const r = buildResume(manifest(), '/proj/dir', [], []);
    expect(r.project.output).toBeNull();
  });

  it('lastSession keeps only the most recent 5 revisions, oldest first, plus updatedAt from the last one', () => {
    const revs = Array.from({ length: 8 }, (_, i) => rev({ rev: i + 1, actor: 'claude' }));
    const r = buildResume(manifest(), '/d', revs, []);
    expect(r.lastSession.revisions).toHaveLength(5);
    expect(r.lastSession.revisions.map((x) => x.rev)).toEqual([4, 5, 6, 7, 8]);
    expect(r.lastSession.updatedAt).toBe(revs[7].ts);
  });

  it('updatedAt is null when there is no revision history yet', () => {
    const r = buildResume(manifest(), '/d', [], []);
    expect(r.lastSession.updatedAt).toBeNull();
  });

  it('userEditsSinceClaude collects non-claude revisions after the most recent claude revision', () => {
    const revs = [
      rev({ rev: 1, actor: 'claude' }),
      rev({ rev: 2, actor: 'claude' }),
      rev({ rev: 3, actor: 'ui' }),
      rev({ rev: 4, actor: 'system' }),
    ];
    const r = buildResume(manifest(), '/d', revs, []);
    expect(r.userEditsSinceClaude.map((x) => x.rev)).toEqual([3, 4]);
  });

  it('userEditsSinceClaude is empty when the most recent revision is claude\'s own', () => {
    const revs = [rev({ rev: 1, actor: 'ui' }), rev({ rev: 2, actor: 'claude' })];
    const r = buildResume(manifest(), '/d', revs, []);
    expect(r.userEditsSinceClaude).toEqual([]);
  });

  it('userEditsSinceClaude covers everything when claude has never edited yet', () => {
    const revs = [rev({ rev: 1, actor: 'system' }), rev({ rev: 2, actor: 'ui' })];
    const r = buildResume(manifest(), '/d', revs, []);
    expect(r.userEditsSinceClaude.map((x) => x.rev)).toEqual([1, 2]);
  });

  it('pendingCandidates counts only status=proposed, broken down by kind', () => {
    const cands = [
      candidate({ id: 'c1', kind: 'silence', status: 'proposed' }),
      candidate({ id: 'c2', kind: 'silence', status: 'proposed' }),
      candidate({ id: 'c3', kind: 'filler', status: 'proposed' }),
      candidate({ id: 'c4', kind: 'filler', status: 'approved' }),
      candidate({ id: 'c5', kind: 'retake', status: 'rejected' }),
    ];
    const r = buildResume(manifest(), '/d', [], cands);
    expect(r.pendingCandidates).toEqual({ total: 3, byKind: { silence: 2, filler: 1 } });
  });

  it('sources report id/file/transcribed and surface colorWarning only when needsColorTransform is true', () => {
    const m = manifest({
      sources: [
        { id: 's1', path: '/media/hlg.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false, color: { transfer: 'arib-std-b67' } },
        { id: 's2', path: '/media/normal.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true, color: { transfer: 'bt709' } },
      ],
    });
    const r = buildResume(m, '/d', [], []);
    expect(r.sources).toEqual([
      { id: 's1', file: 'hlg.mp4', transcribed: false, colorWarning: expect.stringMatching(/Log\/HLG/) },
      { id: 's2', file: 'normal.mp4', transcribed: true },
    ]);
  });

  it('nextSteps surfaces pending candidates, disabled captions, and color warnings, capped at 3', () => {
    const m = manifest({
      captions: { enabled: false, style: 'clean', maxChars: 24 },
      sources: [
        { id: 's1', path: '/media/hlg.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, color: { transfer: 'smpte2084' } },
      ],
    });
    const cands = [candidate({ id: 'c1', kind: 'silence', status: 'proposed' })];
    const r = buildResume(m, '/d', [], cands);
    expect(r.nextSteps.length).toBeLessThanOrEqual(3);
    expect(r.nextSteps.some((s) => s.includes('候補'))).toBe(true);
    expect(r.nextSteps.some((s) => s.includes('字幕'))).toBe(true);
    expect(r.nextSteps.some((s) => /Log\/HLG/.test(s))).toBe(true);
  });

  it('nextSteps is empty when there is nothing mechanically actionable', () => {
    const r = buildResume(manifest(), '/d', [], []);
    expect(r.nextSteps).toEqual([]);
  });

  it('nextSteps suggests ingesting when the timeline is empty and nothing else applies', () => {
    const m = manifest({ timeline: { video: [], motion: [] } });
    const r = buildResume(m, '/d', [], []);
    expect(r.nextSteps.some((s) => s.includes('ingest'))).toBe(true);
  });
});
