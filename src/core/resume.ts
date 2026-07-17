import path from 'node:path';
import { COLOR_WARNING_MESSAGE, needsColorTransform, orphanedOverlays, orphanedSprites, timelineDuration } from './ops.js';
import { kitProfileHighlights, type KitProfileHighlights } from './kit.js';
import type { CutCandidate, KitFile, Manifest, RevisionEntry, Scene } from './types.js';

/**
 * Heuristic "this untranscribed source probably has meaningful talk in it"
 * signal for nextSteps below (W-LAZY): mean scene energy (see computeEnergy
 * in core/scenes.ts — a 0..1 waveform-peak average) above this bar reads as
 * "louder/more active than ambient room tone or wind noise", which for
 * camera audio usually means someone is talking on-mic rather than just
 * ambience. Deliberately NOT a real speech classifier — just cheap enough to
 * avoid nagging the user to transcribe obviously-quiet B-roll. Sits well
 * above adaptiveThreshold's silence-floor ceiling (0.02..0.12, see
 * core/detect.ts) so it doesn't fire on merely "not dead silent" footage.
 */
const TALK_LIKELY_ENERGY_THRESHOLD = 0.08;

/** Duration-weighted mean scene energy, so one long quiet scene isn't drowned out by several short loud ones (or vice versa). */
function meanSceneEnergy(scenes: Pick<Scene, 't0' | 't1' | 'energy'>[]): number {
  let totalDur = 0;
  let weighted = 0;
  for (const s of scenes) {
    const dur = Math.max(0, s.t1 - s.t0);
    totalDur += dur;
    weighted += s.energy * dur;
  }
  return totalDur > 0 ? weighted / totalDur : 0;
}

/** A revision log entry as returned by `Project.revisions()` (no snapshot/motionSpecs). */
export type ResumeRevisionEntry = Omit<RevisionEntry, 'snapshot' | 'motionSpecs'>;

export interface ResumeRevisionSummary {
  rev: number;
  actor: RevisionEntry['actor'];
  summary: string;
}

export interface ResumeSummary {
  project: {
    name: string;
    dir: string;
    revision: number;
    duration: number;
    output: { width: number; height: number } | null;
  };
  lastSession: {
    /** Most recent 5 revisions, oldest first (same order as `Project.revisions()`). */
    revisions: ResumeRevisionSummary[];
    updatedAt: string | null;
  };
  /** Non-claude edits made after the most recent claude-authored revision — the "did the user touch this in the UI" signal. */
  userEditsSinceClaude: ResumeRevisionSummary[];
  pendingCandidates: { total: number; byKind: Record<string, number> };
  sources: { id: string; file: string; transcribed: boolean; colorWarning?: string }[];
  /** B-roll (V2) overlays whose anchor was cut away — see ops.ts's orphanedOverlays. */
  orphanedOverlays: { id: string; reason: string }[];
  /** W8 kit sprites whose anchor was cut away — see ops.ts's orphanedSprites. */
  orphanedSprites: { id: string; reason: string }[];
  /** Linked kit's profile highlights (tone_tags/duration/pacing/spine/quiet_pause_policy), when a kit is linked AND it has a profile section. */
  kitProfile: KitProfileHighlights | null;
  /** Up to 3 mechanically-derivable next actions. */
  nextSteps: string[];
}

function toSummary(r: ResumeRevisionEntry): ResumeRevisionSummary {
  return { rev: r.rev, actor: r.actor, summary: r.summary };
}

/**
 * Pure computation behind `vedit resume`: given the manifest, the full
 * revision log, and the candidate queue (all already read by the caller —
 * this function does no I/O), build the read-only session-resume summary.
 * `dir` is the project directory, passed through verbatim for display.
 * `kit`, when given, is the already-loaded kit.json (see readKitFile in
 * kit.ts) for `m.kit` — buildResume itself stays I/O-free. `sceneFiles`
 * (W-LAZY), when given, is every already-read SceneFile (see
 * `Project.scenes`) — used only for the "talk-likely but untranscribed"
 * nextSteps hint below; defaults to `[]` (no hint) for callers that don't
 * have scene data handy.
 */
export function buildResume(
  m: Manifest,
  dir: string,
  revisions: ResumeRevisionEntry[],
  candidates: CutCandidate[],
  kit?: KitFile | null,
  sceneFiles: { sourceId: string; scenes: Pick<Scene, 't0' | 't1' | 'energy'>[] }[] = [],
): ResumeSummary {
  const last5 = revisions.slice(-5).map(toSummary);
  const updatedAt = revisions.length ? revisions[revisions.length - 1].ts : null;

  // Non-claude edits since the most recent claude-authored revision: the
  // "did the user touch this in the UI while I wasn't looking" signal. When
  // no claude revision exists yet, every non-claude revision counts.
  let lastClaudeIdx = -1;
  for (let i = revisions.length - 1; i >= 0; i--) {
    if (revisions[i].actor === 'claude') {
      lastClaudeIdx = i;
      break;
    }
  }
  const userEditsSinceClaude = revisions
    .slice(lastClaudeIdx + 1)
    .filter((r) => r.actor !== 'claude')
    .map(toSummary);

  const pending = candidates.filter((c) => c.status === 'proposed');
  const byKind: Record<string, number> = {};
  for (const c of pending) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;

  const sources = m.sources.map((s) => ({
    id: s.id,
    file: path.basename(s.path),
    transcribed: !!s.transcribed,
    ...(needsColorTransform(s.color) ? { colorWarning: COLOR_WARNING_MESSAGE } : {}),
  }));

  const orphans = orphanedOverlays(m);
  const spriteOrphans = orphanedSprites(m);
  const kitProfile = kitProfileHighlights(kit);

  // W-LAZY: sources that look talk-heavy by waveform energy but have never
  // been transcribed — surfaced as a nudge rather than auto-triggered,
  // since transcription is now an explicit, opt-in background job
  // (`vedit transcribe`) rather than the ingest-time default.
  const talkLikelyUntranscribed = m.sources.filter((s) => {
    if (s.transcribed || !s.hasAudio) return false;
    const sf = sceneFiles.find((f) => f.sourceId === s.id);
    return !!sf && sf.scenes.length > 0 && meanSceneEnergy(sf.scenes) > TALK_LIKELY_ENERGY_THRESHOLD;
  });

  const nextSteps: string[] = [];
  if (pending.length > 0) nextSteps.push(`保留中の候補 ${pending.length} 件を確認する (vedit candidates)`);
  if (!m.captions.enabled) nextSteps.push('字幕が無効です — 必要なら vedit captions --enabled true');
  if (sources.some((s) => s.colorWarning)) nextSteps.push('Log/HLG素材があります — プレビュー・レンダーの色が浅く見える点に注意');
  if (talkLikelyUntranscribed.length > 0) {
    nextSteps.push(
      `トーク素材らしいのに未転写: ${talkLikelyUntranscribed.map((s) => s.id).join(', ')} — 文字起こしを検討 (vedit transcribe ${talkLikelyUntranscribed.length === 1 ? talkLikelyUntranscribed[0].id : 'all'})`,
    );
  }
  if (orphans.length > 0) nextSteps.push(`B-roll オーバーレイ ${orphans.length} 件が orphan です — 再アンカーしてください (vedit broll-update)`);
  if (spriteOrphans.length > 0) nextSteps.push(`スプライト ${spriteOrphans.length} 件が orphan です — 再アンカーしてください (vedit sprite-update)`);
  if (nextSteps.length < 3 && m.timeline.video.length === 0) nextSteps.push('素材を ingest してタイムラインを作成する');

  return {
    project: { name: m.name, dir, revision: m.revision, duration: timelineDuration(m), output: m.output ?? null },
    lastSession: { revisions: last5, updatedAt },
    userEditsSinceClaude,
    pendingCandidates: { total: pending.length, byKind },
    sources,
    orphanedOverlays: orphans,
    orphanedSprites: spriteOrphans,
    kitProfile,
    nextSteps: nextSteps.slice(0, 3),
  };
}
