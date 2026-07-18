import path from 'node:path';
import { COLOR_WARNING_MESSAGE, needsColorTransform, orphanedOverlays, orphanedSprites, timelineDuration } from './ops.js';
import { kitProfileHighlights } from './kit.js';
import { isAgentActor } from './types.js';
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
function meanSceneEnergy(scenes) {
    let totalDur = 0;
    let weighted = 0;
    for (const s of scenes) {
        const dur = Math.max(0, s.t1 - s.t0);
        totalDur += dur;
        weighted += s.energy * dur;
    }
    return totalDur > 0 ? weighted / totalDur : 0;
}
function toSummary(r) {
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
 * have scene data handy. `notes`, when given, is the already-read NOTES.md
 * (see `readNotes` in notes.ts) — defaults to `[]` (no notes section) for
 * callers that don't have it handy.
 */
export function buildResume(m, dir, revisions, candidates, kit, sceneFiles = [], notes = []) {
    const last5 = revisions.slice(-5).map(toSummary);
    const updatedAt = revisions.length ? revisions[revisions.length - 1].ts : null;
    // Non-agent edits since the most recent AI-authored revision: the
    // "did the user touch this in the UI while I wasn't looking" signal. When
    // no agent revision exists yet, every non-agent revision counts. Legacy
    // actor="claude" entries are agent edits too.
    let lastAgentIdx = -1;
    for (let i = revisions.length - 1; i >= 0; i--) {
        if (isAgentActor(revisions[i].actor)) {
            lastAgentIdx = i;
            break;
        }
    }
    const userEditsSinceAgent = revisions
        .slice(lastAgentIdx + 1)
        .filter((r) => !isAgentActor(r.actor))
        .map(toSummary);
    const pending = candidates.filter((c) => c.status === 'proposed');
    const byKind = {};
    for (const c of pending)
        byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
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
        if (s.transcribed || !s.hasAudio)
            return false;
        const sf = sceneFiles.find((f) => f.sourceId === s.id);
        return !!sf && sf.scenes.length > 0 && meanSceneEnergy(sf.scenes) > TALK_LIKELY_ENERGY_THRESHOLD;
    });
    const nextSteps = [];
    if (pending.length > 0)
        nextSteps.push(`保留中の候補 ${pending.length} 件を確認する (vedit candidates)`);
    if (!m.captions.enabled)
        nextSteps.push('字幕が無効です — 必要なら vedit captions --enabled true');
    if (sources.some((s) => s.colorWarning))
        nextSteps.push('Log/HLG素材があります — プレビュー・レンダーの色が浅く見える点に注意');
    if (talkLikelyUntranscribed.length > 0) {
        nextSteps.push(`トーク素材らしいのに未転写: ${talkLikelyUntranscribed.map((s) => s.id).join(', ')} — 文字起こしを検討 (vedit transcribe ${talkLikelyUntranscribed.length === 1 ? talkLikelyUntranscribed[0].id : 'all'})`);
    }
    if (orphans.length > 0)
        nextSteps.push(`B-roll オーバーレイ ${orphans.length} 件が orphan です — 再アンカーしてください (vedit broll-update)`);
    if (spriteOrphans.length > 0)
        nextSteps.push(`スプライト ${spriteOrphans.length} 件が orphan です — 再アンカーしてください (vedit sprite-update)`);
    // W-ANIME: a composition project has NO video sources by design (see
    // Manifest.composition's doc) — "ingest a file" is meaningless there;
    // nudge toward placing sprites instead when the composition is still empty.
    if (m.composition) {
        if (nextSteps.length < 3 && (m.timeline.sprites ?? []).length === 0) {
            nextSteps.push('スプライトを配置する (vedit sprite-add <assetId> --at <t> --base <rev>)');
        }
    }
    else if (nextSteps.length < 3 && m.timeline.video.length === 0) {
        nextSteps.push('素材を ingest してタイムラインを作成する');
    }
    // NOTES.md excerpt: latest policy/pref (1 each), every unfinished todo,
    // and the latest 2 decisions — see ResumeNotesSummary's doc for why this
    // stays a small excerpt rather than the whole file.
    const toRef = (n) => ({ ts: n.ts, ...(n.rev !== undefined ? { rev: n.rev } : {}), text: n.text });
    const latestOfType = (type) => {
        for (let i = notes.length - 1; i >= 0; i--)
            if (notes[i].type === type)
                return notes[i];
        return undefined;
    };
    const policy = latestOfType('policy');
    const pref = latestOfType('pref');
    const todos = notes.flatMap((n) => (n.todos ?? []).filter((t) => !t.done).map((t) => ({ text: t.text })));
    const recentDecisions = notes.filter((n) => n.type === 'decision').slice(-2).map(toRef);
    const notesSummary = notes.length > 0
        ? { ...(policy ? { policy: toRef(policy) } : {}), ...(pref ? { pref: toRef(pref) } : {}), todos, recentDecisions }
        : undefined;
    return {
        project: { name: m.name, dir, revision: m.revision, duration: timelineDuration(m), output: m.output ?? null },
        lastSession: { revisions: last5, updatedAt },
        userEditsSinceAgent,
        userEditsSinceClaude: userEditsSinceAgent,
        pendingCandidates: { total: pending.length, byKind },
        sources,
        orphanedOverlays: orphans,
        orphanedSprites: spriteOrphans,
        kitProfile,
        ...(notesSummary ? { notes: notesSummary } : {}),
        nextSteps: nextSteps.slice(0, 3),
    };
}
