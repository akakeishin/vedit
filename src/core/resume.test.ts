import { describe, expect, it } from 'vitest';
import { buildResume, type ResumeRevisionEntry } from './resume.js';
import type { NoteEntry } from './notes.js';
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

  it('W-ANIME: a composition project (no video sources by design) never suggests ingesting; nudges toward sprite-add instead', () => {
    const m = manifest({
      sources: [],
      timeline: { video: [], motion: [] },
      composition: { duration: 20, background: { type: 'color', hex: '#000000' } },
    });
    const r = buildResume(m, '/d', [], []);
    expect(r.nextSteps.some((s) => s.includes('ingest'))).toBe(false);
    expect(r.nextSteps.some((s) => s.includes('スプライトを配置') && s.includes('sprite-add'))).toBe(true);
    expect(r.project.duration).toBe(20); // timelineDuration is composition-aware
  });

  it('W-ANIME: a composition with sprites already placed drops the sprite-add nudge too', () => {
    const m = manifest({
      sources: [],
      timeline: {
        video: [], motion: [],
        sprites: [{ id: 'sp1', assetId: 'char1', anchor: { sourceId: '__comp__', srcTime: 0 }, duration: 3, position: { x: 0.5, y: 0.9 }, scale: 0.3, opacity: 1 }],
      },
      composition: { duration: 20, background: { type: 'color', hex: '#000000' } },
    });
    const r = buildResume(m, '/d', [], []);
    expect(r.nextSteps.some((s) => s.includes('スプライトを配置'))).toBe(false);
  });

  it('orphanedOverlays is empty and no nextSteps hint appears when there are no B-roll overlays', () => {
    const r = buildResume(manifest(), '/d', [], []);
    expect(r.orphanedOverlays).toEqual([]);
    expect(r.nextSteps.some((s) => s.includes('orphan'))).toBe(false);
  });

  it('surfaces orphaned B-roll overlays (W3) and a re-anchor nextSteps hint', () => {
    const m = manifest({
      sources: [
        ...manifest().sources,
        { id: 's2', path: '/media/broll.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true },
      ],
      timeline: {
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }],
        motion: [],
        // anchor at src=90 is past the A-roll's only clip (tl[0,60)<-src[0,60)) -> orphan.
        overlays: [{ id: 'ov1', sourceId: 's2', srcIn: 0, srcOut: 2, anchor: { sourceId: 's1', srcTime: 90 }, audioMode: 'mute' }],
      },
    });
    const r = buildResume(m, '/d', [], []);
    expect(r.orphanedOverlays).toHaveLength(1);
    expect(r.orphanedOverlays[0].id).toBe('ov1');
    expect(r.nextSteps.some((s) => s.includes('orphan') && s.includes('broll-update'))).toBe(true);
  });

  // ---- W8: kit sprites (orphanedSprites) + kit profile highlights ----

  it('orphanedSprites is empty and no nextSteps hint appears when there are no sprites', () => {
    const r = buildResume(manifest(), '/d', [], []);
    expect(r.orphanedSprites).toEqual([]);
    expect(r.nextSteps.some((s) => s.includes('スプライト'))).toBe(false);
  });

  it('surfaces orphaned W8 sprites and a re-anchor nextSteps hint', () => {
    const m = manifest({
      timeline: {
        video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }],
        motion: [],
        // anchor at src=90 is past the A-roll's only clip (tl[0,60)<-src[0,60)) -> orphan.
        sprites: [{ id: 'sp1', assetId: 'char1', anchor: { sourceId: 's1', srcTime: 90 }, duration: 2, position: { x: 0.5, y: 0.9 }, scale: 0.3, opacity: 1 }],
      },
    });
    const r = buildResume(m, '/d', [], []);
    expect(r.orphanedSprites).toHaveLength(1);
    expect(r.orphanedSprites[0].id).toBe('sp1');
    expect(r.nextSteps.some((s) => s.includes('スプライト') && s.includes('sprite-update'))).toBe(true);
  });

  it('kitProfile is null when no kit is passed at all', () => {
    const r = buildResume(manifest(), '/d', [], []);
    expect(r.kitProfile).toBeNull();
  });

  it('kitProfile surfaces the linked kit\'s profile highlights when given an already-loaded kit', () => {
    const r = buildResume(manifest(), '/d', [], [], {
      version: 'vedit-kit/v1',
      profile: { tone_tags: ['calm', 'playful'], spine: ['honest_hook', 'quiet_aftertaste'], pacing: { average_shot_seconds: 4 } },
    });
    expect(r.kitProfile).toEqual({
      tone_tags: ['calm', 'playful'],
      spine: ['honest_hook', 'quiet_aftertaste'],
      pacing: { average_shot_seconds: 4 },
    });
  });

  it('kitProfile is null when a kit is linked but has no profile section', () => {
    const r = buildResume(manifest(), '/d', [], [], { version: 'vedit-kit/v1', styles: [{ id: 's1' }] });
    expect(r.kitProfile).toBeNull();
  });
});

// ---- W-LAZY: "talk-likely but untranscribed" nextSteps hint ----

function sceneFile(sourceId: string, energies: number[]): { sourceId: string; scenes: { t0: number; t1: number; energy: number }[] } {
  return { sourceId, scenes: energies.map((energy, i) => ({ t0: i * 2, t1: i * 2 + 2, energy })) };
}

describe('buildResume: talk-likely untranscribed nextSteps hint (W-LAZY)', () => {
  it('suggests transcribe for an untranscribed, hasAudio source with high mean scene energy', () => {
    const m = manifest({
      sources: [{ id: 's1', path: '/media/loud.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false }],
    });
    const r = buildResume(m, '/d', [], [], null, [sceneFile('s1', [0.2, 0.25])]);
    const hint = r.nextSteps.find((s) => s.includes('未転写'));
    expect(hint).toBeDefined();
    expect(hint).toContain('vedit transcribe s1');
  });

  it('does not suggest it once the source is already transcribed', () => {
    const m = manifest({
      sources: [{ id: 's1', path: '/media/loud.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: true }],
    });
    const r = buildResume(m, '/d', [], [], null, [sceneFile('s1', [0.2, 0.25])]);
    expect(r.nextSteps.some((s) => s.includes('未転写'))).toBe(false);
  });

  it('does not suggest it for a source with no audio, however loud its scenes read', () => {
    const m = manifest({
      sources: [{ id: 's1', path: '/media/silent.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: false, transcribed: false }],
    });
    const r = buildResume(m, '/d', [], [], null, [sceneFile('s1', [0.9, 0.9])]);
    expect(r.nextSteps.some((s) => s.includes('未転写'))).toBe(false);
  });

  it('does not suggest it when mean scene energy is low (quiet B-roll)', () => {
    const m = manifest({
      sources: [{ id: 's1', path: '/media/quiet.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false }],
    });
    const r = buildResume(m, '/d', [], [], null, [sceneFile('s1', [0.01, 0.02])]);
    expect(r.nextSteps.some((s) => s.includes('未転写'))).toBe(false);
  });

  it('does not suggest it when no sceneFiles are passed at all (defaults to [])', () => {
    const m = manifest({
      sources: [{ id: 's1', path: '/media/loud.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false }],
    });
    const r = buildResume(m, '/d', [], []); // no sceneFiles argument at all
    expect(r.nextSteps.some((s) => s.includes('未転写'))).toBe(false);
  });

  it('does not suggest it for a source with no detected scenes yet', () => {
    const m = manifest({
      sources: [{ id: 's1', path: '/media/loud.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false }],
    });
    const r = buildResume(m, '/d', [], [], null, []); // sceneFiles passed but empty
    expect(r.nextSteps.some((s) => s.includes('未転写'))).toBe(false);
  });

  it('lists every qualifying sourceId and suggests "vedit transcribe all" for more than one', () => {
    const m = manifest({
      sources: [
        { id: 's1', path: '/media/a.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false },
        { id: 's2', path: '/media/b.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false },
      ],
    });
    const r = buildResume(m, '/d', [], [], null, [sceneFile('s1', [0.3]), sceneFile('s2', [0.3])]);
    const hint = r.nextSteps.find((s) => s.includes('未転写'));
    expect(hint).toBeDefined();
    expect(hint).toContain('s1, s2');
    expect(hint).toContain('vedit transcribe all');
  });

  it('is subject to the same 3-item nextSteps cap as every other hint', () => {
    const m = manifest({
      captions: { enabled: false, style: 'clean', maxChars: 24 },
      sources: [
        { id: 's1', path: '/media/hlg.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true, transcribed: false, color: { transfer: 'smpte2084' } },
      ],
    });
    const cands = [candidate({ id: 'c1', kind: 'silence', status: 'proposed' })];
    const r = buildResume(m, '/d', [], cands, null, [sceneFile('s1', [0.3])]);
    expect(r.nextSteps.length).toBeLessThanOrEqual(3);
  });
});

// ---- NOTES.md excerpt (buildResume's optional `notes` param) ----

function note(partial: Partial<NoteEntry> & { type: string }): NoteEntry {
  return { ts: '2026-07-17 09:00', text: '', ...partial };
}

describe('buildResume: NOTES.md excerpt', () => {
  it('omits `notes` entirely with no NOTES.md, and surfaces the latest policy/pref + all unfinished todos + latest 2 decisions when mixed entries are given', () => {
    expect(buildResume(manifest(), '/d', [], []).notes).toBeUndefined();

    const notes: NoteEntry[] = [
      note({ type: 'policy', ts: '2026-07-17 09:00', rev: 3, text: '最初は落ち着いたトーン' }),
      note({ type: 'decision', ts: '2026-07-17 09:10', rev: 4, text: '古い判断1' }),
      note({ type: 'decision', ts: '2026-07-17 09:20', rev: 5, text: '古い判断2' }),
      note({ type: 'decision', ts: '2026-07-17 09:30', rev: 6, text: '最新の判断' }),
      note({
        type: 'todo',
        ts: '2026-07-17 09:40',
        text: '- [ ] a\n- [x] b',
        todos: [
          { done: false, text: 'a' },
          { done: true, text: 'b' },
        ],
      }),
      note({ type: 'pref', ts: '2026-07-17 09:50', text: 'テンポ重視が好み' }),
      note({ type: 'policy', ts: '2026-07-17 10:00', rev: 7, text: '後半はしっとり路線に変更' }),
    ];
    const r = buildResume(manifest(), '/d', [], [], null, [], notes);
    expect(r.notes).toEqual({
      policy: { ts: '2026-07-17 10:00', rev: 7, text: '後半はしっとり路線に変更' },
      pref: { ts: '2026-07-17 09:50', text: 'テンポ重視が好み' },
      todos: [{ text: 'a' }],
      recentDecisions: [
        { ts: '2026-07-17 09:20', rev: 5, text: '古い判断2' },
        { ts: '2026-07-17 09:30', rev: 6, text: '最新の判断' },
      ],
    });
  });
});
