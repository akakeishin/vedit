import { freshId } from './ops.js';
// ---- text normalization / similarity (pure, no I/O) ----
const isCjkChar = (s) => /[぀-ヿ㐀-䶿一-鿿]/u.test(s);
/** Join an utterance's words into display text: no separator for CJK (matches detect.ts's detectFillers convention), space-joined otherwise. */
function joinDisplayText(words) {
    const hasCjk = words.some((w) => isCjkChar(w.text));
    return hasCjk ? words.map((w) => w.text).join('') : words.map((w) => w.text).join(' ');
}
/**
 * NFKC-normalize and strip whitespace/punctuation before bigram-comparing
 * two utterances — retakes routinely differ in whisper's punctuation
 * placement or case even when the spoken words are identical, and that
 * shouldn't tank the similarity score.
 */
function normalizeForMatch(s) {
    return s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s、。,.!?！？「」『』・…\-—~〜]/gu, '');
}
/** Character 2-gram set of a normalized string; a single character falls back to itself so very short utterances aren't silently unmatchable. */
function charBigrams(s) {
    const grams = new Set();
    if (s.length === 0)
        return grams;
    if (s.length === 1) {
        grams.add(s);
        return grams;
    }
    for (let i = 0; i < s.length - 1; i++)
        grams.add(s.slice(i, i + 2));
    return grams;
}
/** Dice coefficient: 2·|A∩B| / (|A|+|B|). Either set empty → 0 (no basis for a match, not a vacuous 1). */
function diceCoefficient(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const g of small)
        if (large.has(g))
            inter++;
    return (2 * inter) / (a.size + b.size);
}
/** True when `text`, NFKC-normalized and trimmed, ends with a sentence-final mark. */
function endsSentence(text) {
    const t = text.normalize('NFKC').trim();
    if (!t)
        return false;
    return ['。', '！', '？', '.', '!', '?'].includes(t[t.length - 1]);
}
// ---- utterance splitting ----
/**
 * Split a word stream into "utterance units" on long pauses or (a shorter
 * pause after) a sentence-final mark. Assumes `words` is already time-sorted
 * (same assumption detect.ts's gap-based detectors make about Transcript.words).
 */
function splitIntoUtterances(words, longPauseSeconds, sentenceEndPauseSeconds) {
    const out = [];
    let current = [];
    for (let i = 0; i < words.length; i++) {
        current.push(words[i]);
        const next = words[i + 1];
        if (!next)
            continue;
        const gap = next.t0 - words[i].t1;
        const splitGap = endsSentence(words[i].text) ? sentenceEndPauseSeconds : longPauseSeconds;
        if (gap >= splitGap) {
            out.push(current);
            current = [];
        }
    }
    if (current.length > 0)
        out.push(current);
    return out;
}
// ---- utterance quality features ----
// Deliberately NOT detect.ts's FILLERS_JA/FILLERS_EN + flanking-gap logic —
// this is a much smaller, single-token membership check used only to shape
// a take-quality signal (TakeFeatures.fillerCount), never to emit a cut
// candidate, so it doesn't need that dictionary's precision/ambiguity rules.
const MINIMAL_FILLERS = new Set(['えー', 'えーと', 'えっと', 'あの', 'あのー', 'まあ', 'なんか', 'その', 'um', 'uh', 'like', 'you know'].map((s) => s.normalize('NFKC').trim().toLowerCase()));
function normalizeToken(text) {
    return text
        .normalize('NFKC')
        .trim()
        .toLowerCase()
        .replace(/[、。,.!?]+$/u, '');
}
function isMinimalFiller(text) {
    return MINIMAL_FILLERS.has(normalizeToken(text));
}
/** 言い淀み proxy: fraction of adjacent word pairs that are the exact same normalized token (stutter/false-start repeats like "渋谷渋谷に"). */
function wordRepetitionRatio(words) {
    if (words.length < 2)
        return 0;
    let repeats = 0;
    for (let i = 1; i < words.length; i++) {
        const a = normalizeToken(words[i - 1].text);
        const b = normalizeToken(words[i].text);
        if (a && a === b)
            repeats++;
    }
    return repeats / (words.length - 1);
}
function computeFeatures(words, lowConfidenceThreshold) {
    const duration = words[words.length - 1].t1 - words[0].t0;
    const lowConfCount = words.filter((w) => w.p < lowConfidenceThreshold).length;
    const fillerCount = words.filter((w) => isMinimalFiller(w.text)).length;
    return {
        duration,
        lowConfidenceRatio: words.length ? lowConfCount / words.length : 0,
        fillerCount,
        repetitionRatio: wordRepetitionRatio(words),
    };
}
// ---- union-find (chain clustering) ----
//
// Plain parent-array functions rather than a class, matching this codebase's
// function-only style in ops.ts/detect.ts (no classes elsewhere in src/core).
function dsuFind(parent, x) {
    while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    return x;
}
function dsuUnion(parent, a, b) {
    const ra = dsuFind(parent, a);
    const rb = dsuFind(parent, b);
    if (ra !== rb)
        parent[ra] = rb;
}
// ---- recommendation ----
/**
 * "低品質" cutoff for the recommendation rule: a lowConfidenceRatio above
 * this disqualifies a take from being the default pick even if it's the
 * most recent one. 0.3 (30% of words flagged low-confidence), per spec —
 * deliberately a single, simple signal rather than folding in fillerCount/
 * repetitionRatio too: the spec's "等" (etc.) leaves room for that, but
 * combining three loosely-related signals into one cutoff without real
 * footage to calibrate against would be guessing, not a rule — better to
 * ship the one signal that's well-understood (packTranscript already
 * treats p<0.4 as "flagged") and surface the other two as data on
 * TakeFeatures for the director to weigh themselves.
 */
export const LOW_CONFIDENCE_RECOMMEND_THRESHOLD = 0.3;
/**
 * "Last take wins, unless it's low quality" — walks backward from the most
 * recent utterance; if it clears the confidence bar, it's the pick. If not,
 * the most recent EARLIER utterance with a strictly better (lower)
 * lowConfidenceRatio becomes the next-best pick (ties keep the more recent
 * candidate, since recency is still a tiebreaker signal — a director
 * re-recording usually does so because the later take is what they meant to
 * keep). If nothing beats the last take, it stays the pick — it's still the
 * least-bad option on hand.
 */
function recommend(utterances) {
    const lastIdx = utterances.length - 1;
    const last = utterances[lastIdx];
    const pct = (r) => `${Math.round(r * 100)}%`;
    if (last.features.lowConfidenceRatio <= LOW_CONFIDENCE_RECOMMEND_THRESHOLD) {
        return {
            utteranceIndex: lastIdx,
            reason: `最後のテイク(${lastIdx + 1}/${utterances.length})を推薦 — 低confidence語率${pct(last.features.lowConfidenceRatio)}は閾値(${pct(LOW_CONFIDENCE_RECOMMEND_THRESHOLD)})以下`,
        };
    }
    let bestIdx = lastIdx;
    for (let i = lastIdx - 1; i >= 0; i--) {
        if (utterances[i].features.lowConfidenceRatio < utterances[bestIdx].features.lowConfidenceRatio)
            bestIdx = i;
    }
    if (bestIdx === lastIdx) {
        return {
            utteranceIndex: lastIdx,
            reason: `最後のテイク(${lastIdx + 1}/${utterances.length})を推薦 — 低confidence語率${pct(last.features.lowConfidenceRatio)}は閾値超過だが他のテイクも同等以下`,
        };
    }
    return {
        utteranceIndex: bestIdx,
        reason: `最後のテイク(${lastIdx + 1}/${utterances.length})は低confidence語率${pct(last.features.lowConfidenceRatio)}で閾値(${pct(LOW_CONFIDENCE_RECOMMEND_THRESHOLD)})超過のため、次点として${bestIdx + 1}/${utterances.length}番目のテイク(低confidence語率${pct(utterances[bestIdx].features.lowConfidenceRatio)})を推薦`,
    };
}
// ---- detection entry point ----
/**
 * Detect candidate multi-take groups in a transcript: split into utterances,
 * then chain-link (union-find) any pair whose character-bigram Dice
 * coefficient clears `simThreshold` AND whose time gap is within
 * `windowSeconds` — linking is transitive, so A~B~C group together into one
 * take even if A and C alone fall under the threshold (a "chain", per spec).
 * Groups of exactly one utterance (nothing else matched it) are dropped —
 * a single occurrence isn't a "multi-take" situation.
 *
 * This function is pure detection/proposal — it never edits the manifest or
 * transcript. Turning a recommendation into an actual cut is the caller's
 * job via ops.ts (e.g. removeSourceRange over the rejected takes' word
 * ranges), same division of labor as detect.ts's CutCandidate queue.
 */
export function detectTakes(t, opts = {}) {
    const longPauseSeconds = opts.longPauseSeconds ?? 1.0;
    const sentenceEndPauseSeconds = opts.sentenceEndPauseSeconds ?? 0.4;
    const windowSeconds = opts.windowSeconds ?? 30;
    const simThreshold = opts.simThreshold ?? 0.55;
    const lowConfidenceThreshold = opts.lowConfidenceThreshold ?? 0.4;
    const chunks = splitIntoUtterances(t.words, longPauseSeconds, sentenceEndPauseSeconds);
    if (chunks.length < 2)
        return [];
    const units = chunks.map((words) => {
        const text = joinDisplayText(words);
        return {
            words,
            wordIds: words.map((w) => w.id),
            t0: words[0].t0,
            t1: words[words.length - 1].t1,
            text,
            bigrams: charBigrams(normalizeForMatch(text)),
            features: computeFeatures(words, lowConfidenceThreshold),
        };
    });
    const parent = units.map((_, i) => i);
    for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
            // units[].t0 is non-decreasing (chunks come from one time-sorted word
            // stream in order), so this gap only grows as j increases — safe to
            // stop scanning the rest of the row once it clears the window. This
            // is what keeps the pairwise scan from being a full O(n²) walk.
            const gap = units[j].t0 - units[i].t1;
            if (gap > windowSeconds)
                break;
            if (diceCoefficient(units[i].bigrams, units[j].bigrams) >= simThreshold)
                dsuUnion(parent, i, j);
        }
    }
    const clusters = new Map();
    for (let i = 0; i < units.length; i++) {
        const root = dsuFind(parent, i);
        const bucket = clusters.get(root);
        if (bucket)
            bucket.push(i);
        else
            clusters.set(root, [i]);
    }
    const groups = [];
    for (const idxs of clusters.values()) {
        if (idxs.length < 2)
            continue; // 単発発話はグループ化しない
        idxs.sort((a, b) => units[a].t0 - units[b].t0);
        const utterances = idxs.map((i) => ({
            wordIds: units[i].wordIds,
            text: units[i].text,
            t0: units[i].t0,
            t1: units[i].t1,
            features: units[i].features,
        }));
        groups.push({ id: freshId('take'), utterances, recommendation: recommend(utterances) });
    }
    groups.sort((a, b) => a.utterances[0].t0 - b.utterances[0].t0);
    return groups;
}
// ---- director-facing compact text ----
function ts(t) {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
}
/**
 * Compact text view of detected take groups for the director to read and
 * decide from — same "packed" spirit as pack.ts's packTranscript, but for
 * take groups instead of the raw word stream. Never applies anything;
 * purely a rendering of `detectTakes`'s output.
 */
export function packTakes(groups) {
    if (groups.length === 0)
        return '(no multi-take groups detected)';
    const lines = [`# multi-take groups (${groups.length} detected — proposals only, nothing auto-applied)`];
    groups.forEach((g, gi) => {
        lines.push('');
        lines.push(`## group ${gi + 1} — ${g.id} (${g.utterances.length} takes)`);
        g.utterances.forEach((u, ui) => {
            const mark = ui === g.recommendation.utteranceIndex ? '★' : ' ';
            const f = u.features;
            const confPct = Math.round((1 - f.lowConfidenceRatio) * 100);
            const stutterPct = Math.round(f.repetitionRatio * 100);
            lines.push(`${mark} [${ts(u.t0)}–${ts(u.t1)}] "${u.text}" conf=${confPct}% filler=${f.fillerCount} stutter=${stutterPct}%`);
        });
        lines.push(`  → 推薦: ${g.recommendation.reason}`);
    });
    return lines.join('\n');
}
