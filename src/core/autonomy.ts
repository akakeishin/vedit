import { removeSourceRange, timelineDuration } from './ops.js';
import type { AbsorbedFragment } from './ops.js';
import type { CutCandidate, Manifest } from './types.js';

export type AutonomyReasonCode =
  | 'corroborated-silence'
  | 'preference-required'
  | 'insufficient-evidence'
  | 'transcript-conflict'
  | 'pacing-sensitive'
  | 'protected-intent'
  | 'fragmentation-risk'
  | 'no-timeline-effect'
  | 'invalid-range'
  | 'already-decided';

export interface CandidateAutonomyDecision {
  candidate: CutCandidate;
  reasonCode: AutonomyReasonCode;
  reason: string;
  removedSeconds?: number;
}

export interface AutonomousCandidatePlan {
  autoApply: CandidateAutonomyDecision[];
  needsDecision: CandidateAutonomyDecision[];
  excluded: CandidateAutonomyDecision[];
  removedSeconds: number;
  fragmentsAbsorbed: AbsorbedFragment[];
}

export interface FirstDraftApiResult {
  autoApplied?: number;
  removedSeconds?: number;
  questionCount?: number;
  needsDecision?: CandidateAutonomyDecision[];
  evidenceGate?: string;
  state?: {
    revision?: number;
    duration?: number;
    clips?: number;
    pendingCandidates?: number;
    sources?: unknown[];
  };
}

export interface DetectionApiResult {
  pending?: unknown[];
  excludedByIntentZones?: number;
  warnings?: unknown[];
}

/**
 * Keep `vedit first-draft` useful in an agent terminal even for a many-hour
 * project. The daemon response intentionally retains every question for the
 * web UI, while the CLI prints aggregate truth plus a bounded preview and
 * points callers at `vedit candidates` for the complete list.
 */
export function summarizeFirstDraftForCli(
  draft: FirstDraftApiResult,
  detected: DetectionApiResult,
  exampleLimit = 5,
): Record<string, unknown> {
  const questions = Array.isArray(draft.needsDecision) ? draft.needsDecision : [];
  const questionCount = Number.isFinite(draft.questionCount)
    ? Math.max(0, Number(draft.questionCount))
    : questions.length;
  const reasonCounts = Object.fromEntries(
    [...questions.reduce((counts, item) => {
      const reason = item?.reasonCode || 'unknown';
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
      return counts;
    }, new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b)),
  );
  const limit = Number.isFinite(exampleLimit) ? Math.max(0, Math.floor(exampleLimit)) : 5;
  const questionExamples = questions.slice(0, limit).map((item) => ({
    id: item.candidate.id,
    sourceId: item.candidate.sourceId,
    t0: item.candidate.t0,
    t1: item.candidate.t1,
    label: item.candidate.label,
    reasonCode: item.reasonCode,
    reason: item.reason,
  }));
  const state = draft.state ?? {};
  const compactState = {
    revision: state.revision,
    duration: state.duration,
    clips: state.clips,
    sourceCount: Array.isArray(state.sources) ? state.sources.length : undefined,
    pendingCandidates: state.pendingCandidates,
  };

  return {
    autoApplied: Number(draft.autoApplied ?? 0),
    removedSeconds: Number(draft.removedSeconds ?? 0),
    questionCount,
    questionReasons: reasonCounts,
    questionExamples,
    moreQuestions: Math.max(0, questionCount - questionExamples.length),
    evidenceGate: draft.evidenceGate,
    detected: Array.isArray(detected.pending) ? detected.pending.length : 0,
    ...(detected.excludedByIntentZones ? { excludedByIntentZones: detected.excludedByIntentZones } : {}),
    ...(Array.isArray(detected.warnings) && detected.warnings.length ? { warnings: detected.warnings } : {}),
    state: compactState,
    hint: questionCount > 0
      ? 'AI初稿を適用済み。上は確認事項の一部です。全件は `vedit candidates`、回答はWebの「AIから確認」で行えます'
      : 'AI初稿を適用済み。確認が必要な候補はありません',
  };
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

function baseDecision(m: Manifest, c: CutCandidate): CandidateAutonomyDecision {
  if (c.status !== 'proposed') {
    return { candidate: c, reasonCode: 'already-decided', reason: 'すでに判断済みです' };
  }
  if (!Number.isFinite(c.t0) || !Number.isFinite(c.t1) || c.t1 <= c.t0) {
    return { candidate: c, reasonCode: 'invalid-range', reason: '候補区間が不正なため自動処理できません' };
  }
  if ((m.intentZones ?? []).some((z) => z.sourceId === c.sourceId && overlaps(z.t0, z.t1, c.t0, c.t1))) {
    return { candidate: c, reasonCode: 'protected-intent', reason: '余韻・見せ場として保護された区間です' };
  }
  if (c.kind !== 'silence') {
    return { candidate: c, reasonCode: 'preference-required', reason: '話し方やテンポの好みで判断が分かれます' };
  }
  if (c.evidence?.edge === 'leading' || c.evidence?.edge === 'trailing') {
    return { candidate: c, reasonCode: 'pacing-sensitive', reason: '冒頭・末尾の間は演出判断が必要です' };
  }
  if (c.evidence?.transcriptConflict) {
    return { candidate: c, reasonCode: 'transcript-conflict', reason: '波形と文字起こしが一致していません' };
  }
  if (!c.evidence?.transcriptGap || !c.evidence?.waveform) {
    return { candidate: c, reasonCode: 'insufficient-evidence', reason: '文字起こしと波形の両方では裏づけられていません' };
  }
  return { candidate: c, reasonCode: 'corroborated-silence', reason: '文字起こしの語間と波形が一致した明白な無音です' };
}

/**
 * Conservative, deterministic first-draft policy. The function simulates
 * every accepted cut against a throwaway manifest, so "safe" also means the
 * batch has a real timeline effect and does not trigger short-fragment
 * absorption. Nothing is persisted here; the daemon applies the returned
 * ids together in one revision after optimistic-concurrency revalidation.
 */
export function planAutonomousCandidateBatch(m: Manifest, candidates: CutCandidate[]): AutonomousCandidatePlan {
  const autoApply: CandidateAutonomyDecision[] = [];
  const needsDecision: CandidateAutonomyDecision[] = [];
  const excluded: CandidateAutonomyDecision[] = [];
  const fragmentsAbsorbed: AbsorbedFragment[] = [];
  let preview = m;

  const ordered = [...candidates].sort(
    (a, b) => a.sourceId.localeCompare(b.sourceId) || a.t0 - b.t0 || a.t1 - b.t1 || a.id.localeCompare(b.id),
  );
  for (const c of ordered) {
    const decision = baseDecision(m, c);
    if (
      decision.reasonCode === 'already-decided' ||
      decision.reasonCode === 'invalid-range' ||
      decision.reasonCode === 'protected-intent'
    ) {
      excluded.push(decision);
      continue;
    }
    // Prove the range still has a real effect before asking a person about
    // taste/evidence.  Candidates can outlive timeline edits, and a pool-only
    // source can legitimately have detections; neither should generate an
    // unanswerable AI question.  This simulation is non-persistent and does
    // not advance `preview` unless the candidate is later auto-applied.
    let next: Manifest;
    try {
      next = removeSourceRange(preview, c.sourceId, c.t0, c.t1);
    } catch {
      excluded.push({ candidate: c, reasonCode: 'no-timeline-effect', reason: '現在のタイムラインには適用対象がありません' });
      continue;
    }
    const absorbed = (next as Manifest & { fragmentsAbsorbed?: AbsorbedFragment[] }).fragmentsAbsorbed ?? [];
    if (absorbed.length > 0) {
      fragmentsAbsorbed.push(...absorbed);
      needsDecision.push({ candidate: c, reasonCode: 'fragmentation-risk', reason: '短い断片を巻き込むため確認が必要です' });
      continue;
    }
    const removedSeconds = timelineDuration(preview) - timelineDuration(next);
    if (!(removedSeconds > 0)) {
      excluded.push({ candidate: c, reasonCode: 'no-timeline-effect', reason: '現在のタイムラインでは尺が変わりません' });
      continue;
    }
    if (decision.reasonCode !== 'corroborated-silence') {
      needsDecision.push(decision);
      continue;
    }
    autoApply.push({ ...decision, removedSeconds });
    preview = next;
  }

  return {
    autoApply,
    needsDecision,
    excluded,
    removedSeconds: timelineDuration(m) - timelineDuration(preview),
    fragmentsAbsorbed,
  };
}
