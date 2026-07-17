// vedit Web NLE v1 — proxy playback mapped through the timeline, DOM overlays
// for captions/motion, transcript selection, candidate approve/reject.
// All mutations go through the same revision-checked API Claude uses.
//
// This is the "相棒画面" (partner screen) for a Claude Desktop conversation
// running alongside it — not a standalone mini-NLE. Two features exist
// specifically to serve that: the WS 'show' channel (Claude can point at a
// spot on this screen while talking — see handleShowDirective) and the
// drag-and-drop ingest flow (see the "drag-and-drop ingest" section).
//
// Loaded as an ES module (see index.html's <script type="module">) so pure
// logic can live in separate, unit-testable files: dragLogic.js (timeline
// drag -> op conversion) and ingestLogic.js (D&D fingerprint/plan helpers).

import {
  anchoredBlockMoveOp,
  blockMoveOp,
  clipMoveOp,
  dropIndexForX,
  trimDragOp,
} from './dragLogic.js';
import {
  bufferToHex,
  fingerprintRanges,
  formatBytes,
  isVideoFileName,
  planSummary,
} from './ingestLogic.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const videoOverlay = $('videoOverlay');
const basename = (p) => String(p ?? '').split('/').pop();

const S = {
  manifest: null,
  segments: [],
  duration: 0,
  overlays: [], // B-roll V2 (W3): [{overlay, tlStart}] from /api/project; tlStart null = orphan
  sprites: [], // W8 kit sprites: [{sprite, tlStart}] from /api/project; tlStart null = orphan
  kit: { path: null, kit: null }, // W8: /api/kit response (kit.json content, or null when unlinked/unreadable)
  transcripts: new Map(), // sourceId -> words[]
  cues: [],
  candidates: [],
  candidatesAll: [], // includes approved/rejected, for the "ignored word" overlay
  revisions: [],
  peaks: new Map(), // sourceId -> {rate, peaks}
  scenes: new Map(), // sourceId -> Scene[]
  currentSeg: -1,
  playing: false,
  // Transcript selection: composite "sourceId:wordId" keys throughout, since
  // word ids restart at w0000 per source and are NOT globally unique.
  selWords: new Set(),
  selAnchor: null, // "sourceId:wordId"
  selSourceId: null, // source locked for the CURRENT selection; used for delete so
  // we never have to re-derive it from a possibly-stale DOM query.
  focusKey: null, // "sourceId:wordId" — roving-tabindex focus stop in #words
  activeWordKey: null, // "sourceId:wordId" currently playback-highlighted
  // W-UI IA v2 波2 §1: unified timeline-object selection — { kind: 'clip'|
  // 'broll'|'motion'|'sprite'|'dialogue'|'music', id } | null. Selecting
  // anything switches the aside from #tabsView to #inspectorView (see
  // selectItem/renderInspector). Caption cues are NOT tracked here — they
  // open the existing captionStyleDialog directly (see buildCueEl).
  selection: null,
  // W-UI IA v2 波2 §9/追補#3, 波2.5: revision a mutate() response's
  // `warning` field (or a committed-but-refresh-failed notice) was already
  // surfaced for, via toast — connectWs()'s generic "変更 #N" confirmation
  // skips that SAME revision once so it doesn't immediately clobber the
  // warning with a bland confirmation.
  lastWarningRevision: null,
  detectMinGap: 0.7,
  // W-UI IA v2 §5(c): best-effort "which of the 4 zero-candidate empty
  // states are we in" signal — see renderCandidatesGroup's doc for why this
  // is only an approximation (daemon exposes no "has detection ever run"
  // flag, so a fresh page load can't distinguish 未検出 from 問題なし).
  detecting: false, // true only while THIS tab's own redetectBtn click is in flight
  detectRanEmpty: false, // true once THIS session has seen a completed detect that found nothing
  rateIdx: 0, // index into PLAY_RATES, cycled by repeated L presses
  rangeIn: null, // timeline seconds
  rangeOut: null, // timeline seconds
  previewStopAt: null, // timeline seconds; candidate "前後を再生" auto-stop point
  loadState: 'loading', // 'loading' | 'ok' | 'no-project' | 'error'
  // Media pool panel (source preview mode): while non-null, #video plays the
  // raw source proxy from an arbitrary point instead of the timeline mix.
  // returnTl is the timeline position to restore on exit.
  sourcePreview: null, // { sourceId, returnTl } | null
  mediaFocusKey: null, // sourceId — roving-tabindex focus stop in #mediaList
  expandedScenes: new Set(), // sourceIds whose scene grid is expanded
  sceneFocus: new Map(), // sourceId -> sceneId, roving-tabindex focus stop within one expanded scene grid
  musicEls: new Map(), // musicItemId -> <audio> element driving background-music preview
  expandedMedia: new Set(), // W-UI §3: sourceIds whose row detail (badges/usage bar/scene button) is expanded
  showWordKeys: new Set(), // "sourceId:wordId" — W-UI §0 "show words" highlight, separate from selWords (no delete side effect)
  activeTask: null, // W-UI §1 claudeStrip: { label } | null — current long-running background task, from WS progress events
  transcribing: new Set(), // W-LAZY: sourceIds with an in-flight `vedit transcribe` background job (seeded from /api/project's `transcribing`, kept live via transcribe-progress/-done/-error WS messages)
  timelineDrag: null, // in-progress timeline drag/trim (see startClipReorderDrag/startTrimDrag/startBlockDrag)
  fontsList: null, // W-CAP: /api/fonts response ({kit:[{name,family?,path}], system:[{family}]}), refreshed every reload()
  qc: { issues: [], counts: { errors: 0, warnings: 0, infos: 0 } }, // W9: /api/qc static report, refreshed every reload()
  // 波2.5: GET /api/export-results — NOT refreshed by reload()/every mutate();
  // fetched only when the 確認 tab is shown + a light 30s poll while it stays
  // active (see fetchExportResults). Holds at most 1 record (the latest).
  exportResults: [],
  // Codex 統合レビュー P2-6: a failed re-fetch used to silently wipe the card
  // (S.exportResults = []). Now the last successful result is kept and this
  // flag drives a small "更新できませんでした" note instead — see
  // fetchExportResults/renderExportResultCard.
  exportResultsStale: false,
  takesCache: new Map(), // W-INTENT/W11: sourceId -> TakeGroup[], fetched on demand (GET /api/takes) when a "show takes" directive arrives
  // ---- W-ANIME: composition (source-less "sprite anime" production mode) ----
  backgroundIntervals: [], // [{t0,t1,ref}] from /api/project — the resolved "紙芝居"; empty for a non-composition project
  dialogue: [], // Timeline.dialogue verbatim from /api/project (already absolute-placed, no resolution needed)
  speechBubbleStyle: null, // derived once per reload — see deriveSpeechBubbleStyleJS
  // A composition project has no <video> to drive playback (no A-roll at
  // all) — compTl/compClockAnchor/compPlaying implement an independent
  // requestAnimationFrame-driven virtual clock; see compTlNow()/tickComposition().
  compTl: 0,
  compClockAnchor: null,
};
const PLAY_RATES = [1, 1.5, 2];

// ---------- data ----------
async function api(path, init) {
  const r = await fetch(path, init);
  const t = await r.text();
  const b = t ? JSON.parse(t) : {};
  if (!r.ok) throw Object.assign(new Error(b.error || r.statusText), { status: r.status });
  return b;
}

async function reload() {
  let pr;
  try {
    pr = await api('/api/project');
  } catch (e) {
    S.loadState = e.status === 400 && /no project open/.test(e.message ?? '') ? 'no-project' : 'error';
    renderStageState();
    throw e;
  }
  try {
    S.manifest = pr.manifest;
    S.segments = pr.segments;
    S.duration = pr.duration;
    S.overlays = pr.overlays ?? [];
    S.sprites = pr.sprites ?? [];
    S.dialogue = pr.dialogue ?? []; // W-ANIME
    S.backgroundIntervals = pr.backgroundIntervals ?? []; // W-ANIME
    S.transcribing = new Set(pr.transcribing ?? []); // W-LAZY: live job state (see /api/project in daemon.ts), not part of the manifest
    S.kit = await api('/api/kit').catch(() => ({ path: null, kit: null }));
    // W-ANIME: derive the speech-bubble palette once per reload — a kit
    // style tagged use_for:['dialogue'|'speech-bubble'] wins, else the
    // active captions style, else a neutral default (see
    // deriveSpeechBubbleStyleJS, a hand-kept-in-sync port of kit.ts's
    // deriveSpeechBubbleStyle).
    {
      const styles = S.kit?.kit?.styles ?? [];
      const dialogueStyle =
        styles.find((s) => (s.use_for ?? []).some((u) => u === 'dialogue' || u === 'speech-bubble')) ??
        styles.find((s) => s.id === S.manifest.captions.style);
      S.speechBubbleStyle = deriveSpeechBubbleStyleJS(dialogueStyle);
    }
    // W-CAP: fetched once per reload (daemon-side memory+disk cached, see
    // GET /api/fonts in daemon.ts) rather than only on popover-open, so
    // renderCaption can resolve an ALREADY-set overrides.font's @font-face
    // (if it's a kit font) even before the user ever opens the popover.
    S.fontsList = await api('/api/fonts').catch(() => ({ kit: [], system: [] }));
    S.cues = await api('/api/captions');
    S.candidates = await api('/api/candidates');
    S.candidatesAll = await api('/api/candidates?all=1');
    S.revisions = await api('/api/revisions');
    // W9: static-only QC pass (cheap — see daemon.ts's GET /api/qc doc), merged into renderInbox() below.
    S.qc = await api('/api/qc').catch(() => ({ issues: [], counts: { errors: 0, warnings: 0, infos: 0 } }));
    for (const src of S.manifest.sources) {
      if (src.transcribed && !S.transcripts.has(src.id)) {
        const t = await api(`/api/transcript?full=1&source=${src.id}`);
        S.transcripts.set(src.id, t.words);
      }
      if (src.peaks && !S.peaks.has(src.id)) {
        S.peaks.set(src.id, await api(`/media/peaks/${src.id}`));
      }
      try {
        const f = await api(`/api/scenes?source=${src.id}&full=1`);
        if (f.scenes && f.scenes.length) S.scenes.set(src.id, f.scenes);
        else S.scenes.delete(src.id);
      } catch {
        S.scenes.delete(src.id); // no scenes detected yet for this source
      }
    }
    S.loadState = 'ok';
    renderAll();
  } catch (e) {
    S.loadState = 'error';
    renderStageState();
    throw e;
  }
}

// ---------- stage empty/failure states (persistent, not just a toast) ----------
// W-UI IA v2 §5(a): a normal (source-driven, see W-ANIME's Manifest.
// composition doc) project with zero sources is the single "brand new
// project" state — both the stage's 3-line onboarding message AND the 確認
// tab's "確認するものはまだありません" short-circuit (see renderInbox) key
// off this same predicate, so the two panels never disagree about it.
function isProjectEmpty() {
  return Boolean(S.manifest) && !S.manifest.composition && (S.manifest.sources?.length ?? 0) === 0;
}
function renderStageState() {
  const el = $('stageEmpty');
  const msg = $('stageEmptyMsg');
  const retry = $('stageEmptyRetry');
  msg.innerHTML = '';
  const addLine = (text, cls) => {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    p.textContent = text;
    msg.appendChild(p);
  };
  if (S.loadState === 'error') {
    el.hidden = false;
    addLine('読み込みに失敗しました');
    retry.hidden = false;
  } else if (S.loadState === 'no-project') {
    el.hidden = false;
    addLine('プロジェクト未選択');
    retry.hidden = true;
  } else if (isProjectEmpty()) {
    el.hidden = false;
    addLine('最初の動画を追加', 'stageEmptyLead');
    addLine('ここに動画をドロップするか、Claude に「この動画を編集して」と伝えてください');
    addLine('元動画は変更しません');
    retry.hidden = true;
  } else {
    el.hidden = true;
  }
}
$('stageEmptyRetry').onclick = () => { reload().catch(() => {}); };

// ---------- playback: timeline time <-> proxy time ----------
function segAt(tl) {
  return S.segments.findIndex((s) => tl >= s.tlStart && tl < s.tlEnd);
}
function tlNow() {
  if (isComposition()) return compTlNow();
  const i = S.currentSeg;
  if (i < 0 || !S.segments[i]) return 0;
  const s = S.segments[i];
  return Math.min(s.tlEnd, s.tlStart + Math.max(0, video.currentTime - s.srcStart));
}
function proxyUrl(sourceId) {
  return `/media/proxy/${sourceId}`;
}
function loadSeg(i, { play = false, offset = 0 } = {}) {
  const s = S.segments[i];
  if (!s) return;
  S.currentSeg = i;
  const url = proxyUrl(s.sourceId);
  const target = s.srcStart + offset;
  const apply = () => {
    video.currentTime = target;
    if (play) tryPlay(video);
  };
  if (!video.src.endsWith(url)) {
    video.src = url;
    video.addEventListener('loadedmetadata', apply, { once: true });
  } else apply();
  updateFraming();
}

// manifest.output present -> lock #videoBox to that aspect (object-fit:
// cover) and position the crop window per the CURRENT clip's crop.x/y, so
// the preview matches what export will actually frame. No output -> revert
// to plain letterboxing.
function updateFraming() {
  const wrap = $('videoWrap');
  const out = S.manifest?.output;
  if (!out) {
    wrap.classList.remove('customAspect');
    video.style.objectPosition = '';
    return;
  }
  wrap.classList.add('customAspect');
  wrap.style.setProperty('--out-ar', `${out.width}/${out.height}`);
  const seg = S.segments[S.currentSeg];
  const clip = seg && S.manifest.timeline.video.find((c) => c.id === seg.clipId);
  const x = clip?.crop?.x != null ? Math.round(clip.crop.x * 100) : 50;
  const y = clip?.crop?.y != null ? Math.round(clip.crop.y * 100) : 50;
  video.style.objectPosition = `${x}% ${y}%`;
}
function isComposition() {
  return Boolean(S.manifest?.composition);
}
// W-UI IA v2 波2 §6 "color-adjust のプレビュー近似": exposure/saturation get
// a CSS filter() approximation on the current segment's source; white
// balance has no CSS equivalent (a hue/warmth shift, not a linear
// brightness/saturation transform) and is intentionally left out — the clip
// inspector shows its raw number plus an explicit "書き出しで確認" note
// instead of faking it (見た目の嘘をつかない、という賭けの一部). 2^exposure
// is the standard photographic-EV-to-linear-brightness mapping; sat already
// shares CSS saturate()'s 0..2 (1=neutral) scale 1:1 with
// colorAdjust.sat's own range (see setColorAdjust's validation).
let lastColorFilter = '';
function colorAdjustFilterFor(sourceId) {
  const c = S.manifest?.colorAdjust?.[sourceId];
  if (!c) return '';
  const parts = [];
  if (c.exposure) parts.push(`brightness(${Math.pow(2, c.exposure).toFixed(3)})`);
  if (c.sat != null && c.sat !== 1) parts.push(`saturate(${c.sat})`);
  return parts.join(' ');
}
function applyColorAdjustPreview(sourceId) {
  const filter = colorAdjustFilterFor(sourceId);
  if (filter === lastColorFilter) return;
  lastColorFilter = filter;
  video.style.filter = filter;
}
function seekTl(tl, { play } = {}) {
  // Any timeline seek/scrub ("playhead operation") returns from source
  // preview mode to the timeline, at the position being sought.
  if (S.sourcePreview) { S.sourcePreview = null; renderPreviewBanner(); }
  tl = Math.max(0, Math.min(tl, S.duration - 0.001));
  if (isComposition()) {
    // W-ANIME: no <video>/segments to drive playback at all — just move the
    // virtual-clock anchor (see compTlNow/tickComposition below).
    S.compTl = tl;
    S.compClockAnchor = performance.now();
    if (play !== undefined) {
      S.playing = play;
      setPlayBtnState(play);
    }
    return;
  }
  let i = segAt(tl);
  if (i < 0) i = S.segments.length - 1;
  if (i < 0) return; // no segments at all
  loadSeg(i, { play: play ?? S.playing, offset: tl - S.segments[i].tlStart });
}

// ---------- W-ANIME: composition virtual clock (no <video>/segments to drive playback) ----------
// A composition project has no A-roll at all, so tlNow()'s "map video.
// currentTime through the current segment" approach has nothing to map —
// compTl/compClockAnchor implement an independent requestAnimationFrame
// clock instead, reusing video.playbackRate for J/K/L shuttle speed (the
// <video> element itself stays hidden/src-less in this mode, see
// applyCompositionMode, but its .playbackRate property still holds the
// user's selected shuttle speed harmlessly).
function compTlNow() {
  if (!S.playing || S.compClockAnchor == null) return S.compTl;
  const elapsed = ((performance.now() - S.compClockAnchor) / 1000) * (video.playbackRate || 1);
  return Math.min(S.duration, S.compTl + elapsed);
}
function applyCompositionMode() {
  const comp = isComposition();
  const bg = $('compBgLayer');
  if (bg) bg.hidden = !comp;
  video.hidden = comp;
  if (comp && video.src) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  if (!comp) {
    S.compTl = 0;
    S.compClockAnchor = null;
  }
}
function tickComposition() {
  const tl = compTlNow();
  if (S.playing && tl >= S.duration - 1e-3) {
    S.compTl = S.duration;
    S.compClockAnchor = null;
    S.playing = false;
    setPlayBtnState(false);
  }
  $('playhead').style.left = `${(tl / Math.max(1e-6, S.duration)) * 100}%`;
  $('tc').textContent = `${fmtF(tl)} / ${fmtF(S.duration)}`;
  $('headerTc').textContent = fmt(tl);
  renderCompositionBackground(tl);
  renderMotion(tl);
  renderSprites(tl);
  renderDialogueBubbles(tl);
  syncMusicPlayback(tl);
  if (S.previewStopAt != null && S.playing && tl >= S.previewStopAt) {
    S.previewStopAt = null;
    stopPlayback();
  }
}

// If S.playing is true but the <video> element itself is paused (e.g. a
// segment's source proxy hits its own natural end exactly at the segment
// boundary — the browser fires 'ended'/pauses before our -0.02s lookahead
// gets there — or a play() call got silently interrupted), nothing was
// left to drive video forward again: the old boundary check required
// `!video.paused`, which can never be true again once the browser beats us
// to pausing it. Track how long we've been stuck so we can retry play()
// for a bit, then give up and sync S.playing to reality instead of the UI
// claiming playback forever.
let stalledSince = null;

// The frame loop: cross segment boundaries, drive playhead/captions/motion.
function tick() {
  if (isComposition()) {
    tickComposition();
    requestAnimationFrame(tick);
    return;
  }
  if (S.sourcePreview) {
    // Source preview mode: #video plays a raw source proxy that has no
    // relation to S.segments/S.currentSeg, so skip all timeline-linked
    // rendering (playhead, captions, motion, word highlight) and just show
    // the source-relative timecode.
    $('tc').textContent = `${fmtF(video.currentTime)} / ${fmtF(video.duration || 0)}`;
    $('headerTc').textContent = fmt(video.currentTime);
    syncMusicPlayback(null); // source-preview mode plays a raw source proxy, not the timeline mix
    syncOverlayVideo(null); // source preview owns the stage; hide the B-roll overlay video too
    requestAnimationFrame(tick);
    return;
  }
  const i = S.currentSeg;
  if (i >= 0 && S.segments[i]) {
    const s = S.segments[i];
    // Gate on S.playing (our intent), not video.paused (the DOM's state) —
    // the latter can flip true on its own right at this exact boundary (see
    // stalledSince comment above), and once it does, a `!video.paused` gate
    // would never fire again.
    if (S.playing && video.currentTime >= s.srcStart + (s.tlEnd - s.tlStart) - 0.02) {
      stalledSince = null;
      if (i + 1 < S.segments.length) loadSeg(i + 1, { play: true });
      else { video.pause(); S.playing = false; setPlayBtnState(false); }
    } else if (S.playing && video.paused) {
      // Unexpectedly paused mid-segment (not a boundary crossing above).
      // readyState >= 2 means there's actual data to play from, so this
      // isn't just the normal async gap while loadSeg() waits on
      // 'loadedmetadata' after a cross-source switch.
      if (video.readyState >= 2) {
        if (stalledSince == null) stalledSince = performance.now();
        else if (performance.now() - stalledSince > 800) {
          // Retried for ~800ms with no luck — stop pretending we're playing.
          stalledSince = null;
          S.playing = false;
          setPlayBtnState(false);
        } else {
          tryPlay(video);
        }
      }
    } else {
      stalledSince = null;
    }
    const tl = tlNow();
    $('playhead').style.left = `${(tl / S.duration) * 100}%`;
    $('tc').textContent = `${fmtF(tl)} / ${fmtF(S.duration)}`;
    $('headerTc').textContent = fmt(tl);
    renderCaption(tl);
    renderMotion(tl);
    renderSprites(tl);
    // W-UI IA v2 波2 §5 (spec's wave-2 list, "セリフの通常プロジェクト・
    // プレビュー描画"): dialogue bubbles were only ever driven from
    // tickComposition() — a normal (source-driven) project with dialogue
    // items rendered silent/invisible in the web preview despite the
    // renderer always burning them in (see render.ts's doc on this). Same
    // call tickComposition already makes, just also reachable outside
    // composition mode.
    renderDialogueBubbles(tl);
    applyColorAdjustPreview(s.sourceId);
    highlightWord(tl);
    syncMusicPlayback(tl);
    syncOverlayVideo(tl);
    if (S.previewStopAt != null && S.playing && tl >= S.previewStopAt) {
      S.previewStopAt = null;
      stopPlayback();
    }
  }
  requestAnimationFrame(tick);
}
function fmt(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}
// Frame-accurate timecode, e.g. "0:06.9 (f207)".
function fmtF(t) {
  const fps = S.manifest?.fps ?? 30;
  const frame = Math.round(t * fps);
  return `${fmt(t)} (f${frame})`;
}

function setPlaybackRate(rate) {
  video.playbackRate = rate;
  const lbl = $('rateLabel');
  if (rate === 1) { lbl.hidden = true; }
  else { lbl.hidden = false; lbl.textContent = `${rate}x`; }
}
function setPlayBtnState(playing) {
  const btn = $('playBtn');
  btn.textContent = playing ? '⏸' : '▶';
  btn.setAttribute('aria-pressed', String(playing));
  btn.setAttribute('aria-label', playing ? '一時停止' : '再生');
}
function stopPlayback() {
  if (isComposition()) {
    S.compTl = compTlNow();
    S.compClockAnchor = null;
  } else {
    video.pause();
  }
  S.playing = false;
  setPlayBtnState(false);
  S.rateIdx = 0;
  setPlaybackRate(1);
}
// W-UI IA v2 波2 §7 "再生ボタンの嘘を直す": whether there is anything at all
// to play right now — a composition project needs a positive duration, a
// normal project needs at least one timeline segment. startPlayback() and
// the J-shuttle shortcut both gate on this so S.playing never flips to true
// (pause-icon "lie") when nothing actually starts moving; renderPlayability
// mirrors it onto #playBtn's disabled/title so the lie is prevented at the
// UI level too, not just patched after the fact.
function canPlayTimeline() {
  return isComposition() ? S.duration > 0 : S.segments.length > 0;
}
function renderPlayability() {
  const btn = $('playBtn');
  const playable = canPlayTimeline();
  btn.disabled = !playable;
  btn.title = playable ? '' : 'タイムラインに何もありません — 素材を追加すると再生できます';
}
// Shared video.play() wrapper (W-UI IA v2 波2 追補#4): a rejected play()
// promise (autoplay policy, interrupted load, etc.) used to be silently
// swallowed with no state sync, leaving S.playing/the pause-icon claiming
// playback that never actually started. For the MAIN <video> element this
// now folds back into the same stopped state the boundary-stall retry logic
// (see tick()'s stalledSince) already produces; other elements (background
// music/B-roll overlay <video>s) don't drive the play button at all, so
// their rejection stays a silent no-op — same as before, just via one named
// helper instead of an unexplained empty arrow at every call site.
function tryPlay(el) {
  const p = el.play();
  if (p && typeof p.catch === 'function') {
    p.catch(() => {
      if (el === video) { S.playing = false; setPlayBtnState(false); }
    });
  }
  return p;
}
function startPlayback() {
  if (!canPlayTimeline()) return;
  if (isComposition()) {
    if (S.compTl >= S.duration - 1e-3) S.compTl = 0; // replay from the top once fully played out
    S.compClockAnchor = performance.now();
  } else if (S.currentSeg < 0) {
    seekTl(0, { play: true });
  } else {
    tryPlay(video);
  }
  S.playing = true;
  setPlayBtnState(true);
}

$('playBtn').onclick = () => {
  if (S.playing) stopPlayback();
  else startPlayback();
};

// ---------- 波2 追補#2: 出力比率の変更入口(reframe) ----------
// The header's #stat readout has always SHOWN the output aspect (when
// manifest.output is set) with no way to change it — reframe existed on the
// API/CLI side only. focus stays 'center' (the op's own default); a crop
// window per-clip can still be nudged afterward via each clip's own crop
// display in the inspector (read-only for now — see buildClipInspector).
$('reframeSelect').onchange = async (e) => {
  const spec = e.target.value;
  e.target.value = ''; // this control is a one-shot action, not a persistent state readout
  if (!spec) return;
  if (!confirm(`出力比率を ${spec} に変更します。クロップ位置は後から調整できます。よろしいですか？`)) return;
  await mutate(
    { op: 'reframe', spec, focus: 'center' },
    { conflictMessage: '比率の変更は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: $('reframeSelect') },
  );
};

// Global 1-key shortcuts are disabled while focus is inside a button/select/
// [role=tab]/dialog — those elements have their own key handling (native
// Space/Enter activation, tab arrow-navigation, dialog Esc-to-close), and
// letting the document-level handler also fire would double-trigger or
// hijack keys the control itself needs (see item 15 in the UX/a11y pass).
function globalShortcutsBlocked(target) {
  return !!target?.closest?.('button, select, [role="tab"], [role="button"], dialog');
}
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (globalShortcutsBlocked(e.target)) return;
  if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); return; }
  if (e.code === 'ArrowLeft') { seekTl(tlNow() - (e.shiftKey ? 1 / S.manifest.fps : 1)); return; }
  if (e.code === 'ArrowRight') { seekTl(tlNow() + (e.shiftKey ? 1 / S.manifest.fps : 1)); return; }
  const key = e.key.toLowerCase();
  if (key === 'k') { e.preventDefault(); stopPlayback(); return; }
  if (key === 'l') {
    e.preventDefault();
    if (!S.playing) { S.rateIdx = 0; setPlaybackRate(PLAY_RATES[0]); startPlayback(); }
    else { S.rateIdx = (S.rateIdx + 1) % PLAY_RATES.length; setPlaybackRate(PLAY_RATES[S.rateIdx]); }
    return;
  }
  if (key === 'j') {
    e.preventDefault();
    if (!canPlayTimeline()) return; // 波2 §7: don't lie about playback starting when the timeline is empty
    S.rateIdx = 0;
    setPlaybackRate(1);
    seekTl(tlNow() - 2, { play: true });
    S.playing = true;
    setPlayBtnState(true);
    return;
  }
  if (e.key === ',') { e.preventDefault(); seekTl(tlNow() - 1 / S.manifest.fps); return; }
  if (e.key === '.') { e.preventDefault(); seekTl(tlNow() + 1 / S.manifest.fps); return; }
  if (key === 'i') { e.preventDefault(); setRangePoint('in'); return; }
  if (key === 'o') { e.preventDefault(); setRangePoint('out'); return; }
  if (e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }
  if (e.code === 'Escape') {
    e.preventDefault();
    if (S.sourcePreview) { exitSourcePreview(); return; }
    clearRange();
    return;
  }
});
video.addEventListener('ended', () => {
  if (!S.sourcePreview) return; // timeline-mode end-of-segment is handled in tick()
  S.playing = false;
  setPlayBtnState(false);
});

// ---------- timeline strip ----------
// W-UI IA v2 波2 §2: tlEl points at the TRACK CONTENT container, not the
// outer #timeline (which now also hosts the ruler + gutter — see
// index.html). Every existing row's left/top/width/height % math is
// unchanged; only the containing block moved one level deeper, so this is
// the one place that needs to know that.
const tlEl = $('timelineTracks');
tlEl.addEventListener('pointerdown', (e) => {
  const move = (ev) => {
    const r = tlEl.getBoundingClientRect();
    seekTl(((ev.clientX - r.left) / r.width) * S.duration, { play: false });
  };
  move(e);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
// Alt(Option)+hover scrubs the preview without clicking; plain hover does nothing
// (avoids accidental seeking while just moving the mouse over the strip).
tlEl.addEventListener('mousemove', (e) => {
  if (!e.altKey || !S.duration) return;
  const r = tlEl.getBoundingClientRect();
  seekTl(((e.clientX - r.left) / r.width) * S.duration, { play: false });
});

// ---------- range selection (I/O points) ----------
function setRangePoint(which) {
  if (!S.duration) return;
  const tl = tlNow();
  if (which === 'in') S.rangeIn = tl; else S.rangeOut = tl;
  if (S.rangeIn != null && S.rangeOut != null && S.rangeIn > S.rangeOut) {
    [S.rangeIn, S.rangeOut] = [S.rangeOut, S.rangeIn];
  }
  renderRange();
}
function clearRange() {
  S.rangeIn = null;
  S.rangeOut = null;
  renderRange();
}
function renderRange() {
  const sel = $('rangeSel');
  const bar = $('rangeBar');
  if (S.rangeIn == null && S.rangeOut == null) {
    sel.hidden = true;
    bar.hidden = true;
    return;
  }
  const a = S.rangeIn ?? S.rangeOut;
  const b = S.rangeOut ?? S.rangeIn;
  sel.hidden = false;
  sel.style.left = `${(a / S.duration) * 100}%`;
  sel.style.width = `${Math.max(0, (b - a) / S.duration) * 100}%`;
  if (S.rangeIn != null && S.rangeOut != null) {
    bar.hidden = false;
    $('rangeInfo').textContent = `開始点(IN) ${fmt(S.rangeIn)} – 終了点(OUT) ${fmt(S.rangeOut)} (${fmt(S.rangeOut - S.rangeIn)})`;
  } else {
    bar.hidden = true;
  }
}
$('rangeDeleteBtn').onclick = async () => {
  if (S.rangeIn == null || S.rangeOut == null) return;
  const overlapping = S.segments.filter((s) => s.tlEnd > S.rangeIn && s.tlStart < S.rangeOut);
  if (overlapping.length === 0) return;
  const sourceId = overlapping[0].sourceId;
  if (overlapping.some((s) => s.sourceId !== sourceId)) {
    toast('複数クリップにまたがる範囲は未対応です', { type: 'error' });
    return;
  }
  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  const t0 = first.srcStart + Math.max(0, S.rangeIn - first.tlStart);
  const t1 = last.srcStart + Math.min(last.tlEnd - last.tlStart, S.rangeOut - last.tlStart);
  const btn = $('rangeDeleteBtn');
  clearRange();
  await mutate({ op: 'remove-range', sourceId, t0, t1 }, { trigger: btn });
};

// ---------- shortcuts dialog ----------
let shortcutsInvoker = null;
function openShortcuts() {
  const dlg = $('shortcutsDialog');
  if (dlg.open) return;
  shortcutsInvoker = document.activeElement;
  dlg.showModal();
}
function closeShortcuts() {
  const dlg = $('shortcutsDialog');
  if (dlg.open) dlg.close();
}
function toggleShortcuts() {
  if ($('shortcutsDialog').open) closeShortcuts();
  else openShortcuts();
}
$('shortcutsBtn').onclick = openShortcuts;
$('shortcutsCloseBtn').onclick = closeShortcuts;
$('shortcutsDialog').addEventListener('click', (e) => {
  if (e.target === $('shortcutsDialog')) closeShortcuts();
});
$('shortcutsDialog').addEventListener('close', () => {
  shortcutsInvoker?.focus?.();
  shortcutsInvoker = null;
});

// ---------- timeline direct manipulation (W-UI §2) ----------
// Clip body drag = reorder (clip-move), clip edge (6px) drag = trim (drag is
// preview-only; the API call fires once on drop), B-roll/sprite/motion/BGM
// block drag = time move (B-roll/sprite additionally re-resolve their
// anchor at the drop position). Every drop commits exactly ONE revision.
// The pixel<->seconds/index math is pure and lives in dragLogic.js so it's
// unit-tested there; this section is just the DOM/pointer wiring around it.
const EDGE_PX = 6;

function timelineRect() {
  return tlEl.getBoundingClientRect();
}
function dropIndicatorX(rects, idx) {
  if (rects.length === 0) return 0;
  if (idx <= 0) return rects[0].left;
  if (idx >= rects.length) return rects[rects.length - 1].left + rects[rects.length - 1].width;
  return rects[idx].left;
}
function showDropIndicator(rects, idx, containerWidth) {
  const el = $('dropIndicator');
  el.style.left = `${(dropIndicatorX(rects, idx) / containerWidth) * 100}%`;
  el.hidden = false;
}
function hideDropIndicator() {
  $('dropIndicator').hidden = true;
}

/** Clip-body drag: reorder on drop; a plain click (no movement past the threshold) still selects + seeks, same as before this feature existed. */
function startClipReorderDrag(e, seg, clipEl) {
  const startX = e.clientX;
  const rect = timelineRect();
  let moved = false;
  let otherRects = null;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
    if (!moved) {
      moved = true;
      S.timelineDrag = { kind: 'clip-move', clipId: seg.clipId };
      clipEl.classList.add('dragging');
      otherRects = S.segments
        .filter((s) => s.clipId !== seg.clipId)
        .map((s) => ({
          clipId: s.clipId,
          left: (s.tlStart / S.duration) * rect.width,
          width: ((s.tlEnd - s.tlStart) / S.duration) * rect.width,
        }));
    }
    const idx = dropIndexForX(otherRects, ev.clientX - rect.left);
    showDropIndicator(otherRects, idx, rect.width);
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    hideDropIndicator();
    S.timelineDrag = null;
    if (!moved) {
      selectClip(seg.clipId);
      seekTl(((ev.clientX - rect.left) / rect.width) * S.duration, { play: false });
      return;
    }
    clipEl.classList.remove('dragging');
    const orderedClipIds = [...new Set(S.segments.map((s) => s.clipId))];
    const idx = dropIndexForX(otherRects, ev.clientX - rect.left);
    const op = clipMoveOp(orderedClipIds, seg.clipId, idx);
    if (!op) return; // dropped back at its original slot
    await mutate(op, { conflictMessage: '並べ替えは反映されませんでした。最新状態を確認してもう一度実行してください' });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** Clip edge (6px) drag: preview-only stretch while dragging, one `trim` call on drop. */
function startTrimDrag(e, seg, edge, clipEl) {
  e.stopPropagation(); // never also trigger the strip's own scrub-seek
  const startX = e.clientX;
  const rect = timelineRect();
  const pxPerSecond = rect.width / S.duration;
  const fps = S.manifest?.fps ?? 30;
  selectClip(seg.clipId);
  let moved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 2) return;
    moved = true;
    S.timelineDrag = { kind: 'trim', clipId: seg.clipId, edge };
    const live = document.querySelector(`#clips [data-clip-id="${CSS.escape(seg.clipId)}"]`) ?? clipEl;
    const deltaPct = (dx / rect.width) * 100;
    if (edge === 'out') {
      const w = ((seg.tlEnd - seg.tlStart) / S.duration) * 100 + deltaPct;
      if (w > 0) live.style.width = `${w}%`;
    } else {
      const newLeftPct = (seg.tlStart / S.duration) * 100 + deltaPct;
      const newWidthPct = ((seg.tlEnd - seg.tlStart) / S.duration) * 100 - deltaPct;
      if (newWidthPct > 0) {
        live.style.left = `${newLeftPct}%`;
        live.style.width = `${newWidthPct}%`;
      }
    }
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    S.timelineDrag = null;
    if (!moved) return;
    const deltaSeconds = (ev.clientX - startX) / pxPerSecond;
    const op = trimDragOp(seg.clipId, edge, deltaSeconds, fps);
    if (!op) { renderTimeline(); return; } // rounds to 0 frames: snap the preview stretch back
    const { ok } = await mutate(op, { conflictMessage: 'トリムは反映されませんでした。最新状態を確認してもう一度実行してください' });
    if (!ok) renderTimeline();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function attachClipHandlers(d, seg) {
  d.dataset.clipId = seg.clipId;
  d.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // clip owns seek-on-click itself (see the !moved branch below); the strip's own scrub handler must not also fire
    const rect = d.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    if (offsetX <= EDGE_PX) startTrimDrag(e, seg, 'in', d);
    else if (rect.width - offsetX <= EDGE_PX) startTrimDrag(e, seg, 'out', d);
    else startClipReorderDrag(e, seg, d);
  });
  d.addEventListener('pointermove', (e) => {
    if (S.timelineDrag) return;
    const rect = d.getBoundingClientRect();
    const off = e.clientX - rect.left;
    d.style.cursor = off <= EDGE_PX || rect.width - off <= EDGE_PX ? 'ew-resize' : 'grab';
  });
}

/**
 * Motion/BGM block drag: {op:'motion-update'|'music-update', tlStart}.
 * B-roll/sprite block drag: re-resolves the anchor at the drop position
 * ({op:'broll-update'|'sprite-update', anchor}) — see anchoredBlockMoveOp.
 */
function startBlockDrag(e, kind, id, originalTlStart, blockEl) {
  e.stopPropagation();
  const startX = e.clientX;
  const rect = timelineRect();
  const pxPerSecond = rect.width / S.duration;
  const startLeftPct = parseFloat(blockEl.style.left) || 0;
  let moved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    S.timelineDrag = { kind: 'block-move', blockKind: kind, id };
    blockEl.classList.add('dragging');
    const deltaPct = (dx / rect.width) * 100;
    blockEl.style.left = `${Math.max(0, startLeftPct + deltaPct)}%`;
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    S.timelineDrag = null;
    if (!moved) {
      // W-UI IA v2 波2 §1: a plain click (no drag) selects this block —
      // same "click selects, drag moves" split as the clip row's own
      // startClipReorderDrag.
      selectItem(kind, id);
      return;
    }
    const newTl = originalTlStart + (ev.clientX - startX) / pxPerSecond;
    const op = kind === 'motion' || kind === 'music'
      ? blockMoveOp(kind, id, newTl, originalTlStart)
      : anchoredBlockMoveOp(kind, id, S.segments, newTl);
    if (!op) {
      if (kind === 'broll' || kind === 'sprite') toast('その位置には移動できません(タイムライン範囲外)', { type: 'error' });
      renderTimeline();
      return;
    }
    const { ok } = await mutate(op, { conflictMessage: '移動は反映されませんでした。最新状態を確認してもう一度実行してください' });
    if (!ok) renderTimeline();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// W-UI redesign §2/§6: "素材の表示名 · 長さ" — never the internal clipId.
// Sums every segment sharing this clipId (a clip can be split into several
// non-contiguous timeline segments once an internal remove-words/candidate
// cut lands inside it), so the duration always reads as "how much of this
// clip actually plays", not just one fragment's length.
function clipDisplayLabel(clipId) {
  const segs = S.segments.filter((s) => s.clipId === clipId);
  if (segs.length === 0) return clipId;
  const name = sourceDisplayName(segs[0].sourceId);
  const totalDur = segs.reduce((sum, s) => sum + (s.tlEnd - s.tlStart), 0);
  return `${name} · ${fmt(totalDur)}`;
}
// W-UI redesign §2 "フィルムストリップ": scene thumbnails (S.scenes, from
// GET /api/scenes) that overlap [srcStart, srcEnd) of `sourceId`, as
// left%/width% tiles spanning that range — see renderTimeline's clip loop.
// Sources with no detected scenes return [] (renderTimeline just falls back
// to the plain clip fill).
function sceneThumbTilesFor(sourceId, srcStart, srcEnd) {
  const scenes = S.scenes.get(sourceId);
  const span = srcEnd - srcStart;
  if (!scenes || !scenes.length || !(span > 0)) return [];
  const tiles = [];
  for (const sc of scenes) {
    const a = Math.max(sc.t0, srcStart);
    const b = Math.min(sc.t1, srcEnd);
    if (b <= a) continue;
    tiles.push({
      leftPct: ((a - srcStart) / span) * 100,
      widthPct: ((b - a) / span) * 100,
      url: `/media/scene-thumb/${sourceId}/${sc.id}`,
    });
  }
  return tiles;
}

// Codex 統合レビュー P1-2: 字幕行(renderCaptionRow の asButton)で実装済みの
// tabIndex/role="button"/Enter・Space=クリック相当、というパターンをタイム
// ラインの他ブロック(クリップ/B-roll/モーション/BGM/スプライト/セリフ)にも
// 適用する共有ヘルパー。マウスの pointerdown ハンドラは別途そのまま付ける —
// これは「Tab で到達でき、Enter/Space で選択+シークできる」ことだけを保証する。
function makeBlockKeyboardActivatable(el, onActivate) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); onActivate(); }
  });
}

function renderTimeline() {
  const clips = $('clips');
  clips.innerHTML = '';
  S.segments.forEach((s, idx) => {
    const d = document.createElement('div');
    // Alternate shade per clip (even within the same source) so adjacent clip
    // boundaries stay visible; the boundary itself gets a thin divider line.
    d.className = 'clip' + (idx % 2 ? ' alt' : '') + (isSelected('clip', s.clipId) ? ' sel' : '');
    d.style.left = `${(s.tlStart / S.duration) * 100}%`;
    d.style.width = `${((s.tlEnd - s.tlStart) / S.duration) * 100}%`;
    d.title = `${clipDisplayLabel(s.clipId)} — ドラッグで並べ替え、端(6px)をドラッグでトリム`;
    // W-UI redesign §2 "フィルムストリップ": tile the real-frame scene
    // thumbnails that overlap this segment's [srcStart, srcEnd) source
    // range side by side as a background layer — reuses the poster frames
    // `vedit scenes detect` already wrote to cache/ (served read-only via
    // GET /media/scene-thumb/<sourceId>/<sceneId> in daemon.ts, no new
    // ffmpeg call). Sources with no scene data render as the plain color
    // fill exactly as before (full regression).
    const srcEnd = s.srcStart + (s.tlEnd - s.tlStart);
    for (const t of sceneThumbTilesFor(s.sourceId, s.srcStart, srcEnd)) {
      const tile = document.createElement('div');
      tile.className = 'clipThumb';
      tile.style.left = `${t.leftPct}%`;
      tile.style.width = `${t.widthPct}%`;
      tile.style.backgroundImage = `url("${t.url}")`;
      d.appendChild(tile);
    }
    attachClipHandlers(d, s);
    makeBlockKeyboardActivatable(d, () => { selectClip(s.clipId); seekTl(s.tlStart, { play: false }); });
    clips.appendChild(d);
  });
  renderSceneMarks();
  const mrow = $('motionRow');
  mrow.innerHTML = '';
  for (const mo of S.manifest.timeline.motion) {
    const d = document.createElement('div');
    // W-UI redesign §6: label by motion type, not the internal spec id (mo.id
    // stays available via the title tooltip) — MOTION_TYPE_LABEL is defined
    // with humanizeRevision below but this only runs after full module load.
    const moType = S.motionSpecs?.[mo.id]?.type;
    d.className = 'moBlock' + (isSelected('motion', mo.id) ? ' sel' : '');
    d.style.left = `${(mo.tlStart / S.duration) * 100}%`;
    d.style.width = `${(mo.duration / S.duration) * 100}%`;
    d.textContent = moType ? (MOTION_TYPE_LABEL[moType] ?? moType) : 'モーション';
    let titleText = `${mo.id} (${fmt(mo.duration)}) — ドラッグで移動`;
    // 波2 追補#1: custom-html is preview-only — never burned into the export
    // (see export/motion.ts's doc) — a silent, easy-to-miss data loss if the
    // user never notices until after exporting. A permanent badge (not the
    // tally/warning color — this isn't wrong, just scoped) beats a one-shot
    // toast nobody's watching for.
    if (moType === 'custom-html') {
      const badge = document.createElement('span');
      badge.className = 'exportSkipBadge';
      badge.textContent = '書き出し対象外';
      d.appendChild(document.createTextNode(' '));
      d.appendChild(badge);
      titleText += ' — custom-html は書き出しでは焼き込まれません(プレビューのみ)';
    }
    d.title = titleText;
    d.onpointerdown = (e) => startBlockDrag(e, 'motion', mo.id, mo.tlStart, d);
    makeBlockKeyboardActivatable(d, () => { selectItem('motion', mo.id); seekTl(mo.tlStart, { play: false }); });
    mrow.appendChild(d);
  }
  const murow = $('musicRow');
  murow.innerHTML = '';
  for (const mu of S.manifest.timeline.music ?? []) {
    const d = document.createElement('div');
    d.className = 'muBlock' + (isSelected('music', mu.id) ? ' sel' : '');
    d.style.left = `${(mu.tlStart / S.duration) * 100}%`;
    d.style.width = `${(mu.duration / S.duration) * 100}%`;
    d.title = `${mu.id} ${basename(mu.path)} (${mu.gain}dB${mu.duck ? ', duck' : ''}) — ドラッグで移動`;
    d.textContent = basename(mu.path);
    d.onpointerdown = (e) => startBlockDrag(e, 'music', mu.id, mu.tlStart, d);
    makeBlockKeyboardActivatable(d, () => { selectItem('music', mu.id); seekTl(mu.tlStart, { play: false }); });
    murow.appendChild(d);
  }
  renderOverlayRow();
  renderSpriteRow();
  renderIntentZoneRow();
  renderBgRow();
  renderDialogueRow();
  renderCaptionRow();
  drawWave();
  renderRuler();
  renderTrackGutter();
}

// W-ANIME: background-cut row ("紙芝居") — one block per backgroundIntervals()
// entry, click-to-seek only (no drag/reanchor — a background cut is placed
// at an absolute time, not anchored to anything draggable). Empty for a
// non-composition project.
function bgRefLabel(ref) {
  if (ref.type === 'color') return ref.hex;
  if (ref.type === 'asset') return ref.assetId;
  return basename(ref.path);
}
function renderBgRow() {
  const row = $('bgRow');
  if (!row) return;
  row.innerHTML = '';
  if (!S.duration || !isComposition()) return;
  for (const iv of S.backgroundIntervals) {
    const d = document.createElement('div');
    d.className = 'bgBlock';
    d.style.left = `${(iv.t0 / S.duration) * 100}%`;
    d.style.width = `${Math.max(0, (iv.t1 - iv.t0) / S.duration) * 100}%`;
    const label = bgRefLabel(iv.ref);
    d.title = `背景: ${label} — クリックでシーク`;
    d.textContent = label;
    d.onclick = () => seekTl(iv.t0);
    row.appendChild(d);
  }
}

// W-ANIME: dialogue (speech bubble) row — one block per DialogueItem,
// click-to-seek only (dialogue is placed at an absolute tlStart, no anchor
// to drag/reanchor).
function renderDialogueRow() {
  const row = $('dialogueRow');
  if (!row) return;
  row.innerHTML = '';
  if (!S.duration) return;
  for (const d of S.dialogue ?? []) {
    const el = document.createElement('div');
    el.className = 'dlBlock' + (isSelected('dialogue', d.id) ? ' sel' : '');
    el.style.left = `${(d.tlStart / S.duration) * 100}%`;
    el.style.width = `${Math.max(0, d.duration / S.duration) * 100}%`;
    el.title = `${d.id}: ${d.text}`;
    el.textContent = d.text;
    // W-UI IA v2 波2 §1: click selects (→ inspector) AND seeks — same
    // "selecting always moves the playhead there too" feel as clicking a clip.
    const activate = () => { selectItem('dialogue', d.id); seekTl(d.tlStart); };
    el.onclick = activate;
    makeBlockKeyboardActivatable(el, activate);
    row.appendChild(el);
  }
}

// W-INTENT: map one intentZone (Manifest.intentZones — SOURCE-domain t0/t1)
// onto the current timeline. A JS port of ops.ts's sourceRangeToTimeline
// (pure math kept in sync by hand; same duplication rationale as
// spriteGeometryJS above — the browser has no access to core/ops.js).
// Combines every matching segment into one [tlStart,tlEnd] span (min start /
// max end), same as the engine function — a zone whose source range spans a
// clip that got split by an unrelated cut in between still reads as one
// continuous protected span, matching what `vedit qc --render` protects.
function intentZoneTimelineRanges(zone) {
  let start = null;
  let end = null;
  for (const s of S.segments) {
    if (s.sourceId !== zone.sourceId) continue;
    const segDur = s.tlEnd - s.tlStart;
    const srcEnd = s.srcStart + segDur;
    const a = Math.max(zone.t0, s.srcStart);
    const b = Math.min(zone.t1, srcEnd);
    if (b <= a) continue;
    const tlA = s.tlStart + (a - s.srcStart);
    const tlB = s.tlStart + (b - s.srcStart);
    if (start === null || tlA < start) start = tlA;
    if (end === null || tlB > end) end = tlB;
  }
  return start === null ? null : { tlStart: start, tlEnd: end };
}
function renderIntentZoneRow() {
  const row = $('intentZoneRow');
  if (!row) return;
  row.innerHTML = '';
  if (!S.duration) return;
  for (const zone of S.manifest.intentZones ?? []) {
    const r = intentZoneTimelineRanges(zone);
    if (!r) continue; // fully cut away — nothing to protect anymore
    const d = document.createElement('div');
    d.className = `intentZoneBlock ${zone.kind}`;
    d.style.left = `${(r.tlStart / S.duration) * 100}%`;
    d.style.width = `${Math.max(0, (r.tlEnd - r.tlStart) / S.duration) * 100}%`;
    // W-UI IA v2 波2 §7 "細部の嘘の修正": this bar used to have no click
    // handler at all despite `cursor` implying interactivity — clicking now
    // seeks there, and the title says outright that Claude is the one
    // protecting it (removal is structural — see #intentZonesInfo's
    // "Claude に頼む" chip in the 確認 tab instead of a UI control here).
    d.title = zone.kind === 'quiet'
      ? `Claude が守っている無音: ${zone.label} — クリックでシーク`
      : `Claude が保持している区間: ${zone.label} — クリックでシーク`;
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.onclick = () => seekTl(r.tlStart, { play: false });
    d.onkeydown = (e) => { if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); d.onclick(); } };
    row.appendChild(d);
  }
}

// W-UI IA v2 波2 追補#5: intent zones (保護区間) are a structural edit
// (intent-remove) with no UI control by design — this is where the "Claude
// に頼む" chip for them lives (the timeline bar itself only seeks + explains
// via its title, see renderIntentZoneRow above). Not a warning (nothing is
// wrong), so it's a plain info list, not part of 対応が必要.
function renderIntentZonesInfo() {
  const el = $('intentZonesInfo');
  if (!el) return;
  el.innerHTML = '';
  const zones = S.manifest?.intentZones ?? [];
  if (zones.length === 0 || isProjectEmpty()) { el.hidden = true; return; }
  el.hidden = false;
  for (const zone of zones) {
    const row = document.createElement('div');
    row.className = 'intentZoneInfoRow';
    const label = document.createElement('span');
    const kindLabel = zone.kind === 'quiet' ? '静寂' : '保持';
    label.textContent = `保護区間(${kindLabel}): ${zone.label}`;
    row.appendChild(label);
    row.appendChild(askClaudeChip(`保護区間(${zone.label})を解除して`));
    el.appendChild(row);
  }
}

// B-roll V2 row (W3): one teal block per resolved overlay, positioned like
// musicRow/motionRow's blocks. Orphaned overlays (no resolved tlStart —
// their anchor was cut away) can't be time-positioned, so they render as
// fixed warning chips stacked at the row's left edge instead; clicking one
// explains why via a toast (the reason mirrors ops.ts's orphanedOverlays).
function renderOverlayRow() {
  const row = $('overlayRow');
  row.innerHTML = '';
  if (!S.duration) return;
  let orphanIdx = 0;
  for (const r of S.overlays) {
    const ov = r.overlay;
    const d = document.createElement('div');
    if (r.tlStart == null) {
      d.className = 'ovBlock orphan' + (isSelected('broll', ov.id) ? ' sel' : '');
      d.style.left = `${orphanIdx * 14}px`;
      d.textContent = '!';
      d.title = `配置先を見失っています: ${ov.id} — クリックで詳しく見る`;
      // W-UI IA v2 波2 §1/§8: opens the inspector (persistent, with a "Claude
      // に頼む" copy chip) instead of a one-shot toast that's gone the moment
      // the user looks away.
      d.onclick = (e) => { e.stopPropagation(); selectItem('broll', ov.id); };
      makeBlockKeyboardActivatable(d, () => selectItem('broll', ov.id));
      orphanIdx++;
    } else {
      const dur = ov.srcOut - ov.srcIn;
      const ovSrc = S.manifest.sources.find((s) => s.id === ov.sourceId);
      d.className = 'ovBlock' + (isSelected('broll', ov.id) ? ' sel' : '');
      d.style.left = `${(r.tlStart / S.duration) * 100}%`;
      d.style.width = `${(dur / S.duration) * 100}%`;
      // W-UI polish: raw filename lives in the title (hover) alongside the
      // existing id/dur/audioMode debug info; the block's own text stays
      // the short "素材N · HH:MM" alias — see sourceLabel's doc.
      d.title = `${ovSrc ? basename(ovSrc.path) : ov.sourceId} — ${ov.id} (${dur.toFixed(1)}s, ${ov.audioMode}) — ドラッグで移動`;
      d.textContent = sourceLabel(ovSrc); // W-UI redesign §6: display name, not the internal overlay id (full filename in title)
      d.onpointerdown = (e) => startBlockDrag(e, 'broll', ov.id, r.tlStart, d);
      makeBlockKeyboardActivatable(d, () => { selectItem('broll', ov.id); seekTl(r.tlStart, { play: false }); });
    }
    row.appendChild(d);
  }
}

// W8 kit sprite row: one pink block per resolved sprite, same shape as
// renderOverlayRow above (orphans as fixed left-edge warning chips). Sprites
// may overlap each other (unlike the exclusive B-roll V2 track), so blocks
// simply stack visually via z-order — no collision handling needed.
function renderSpriteRow() {
  const row = $('spriteRow');
  if (!row) return;
  row.innerHTML = '';
  if (!S.duration) return;
  let orphanIdx = 0;
  for (const r of S.sprites) {
    const sp = r.sprite;
    const d = document.createElement('div');
    if (r.tlStart == null) {
      d.className = 'spBlock orphan' + (isSelected('sprite', sp.id) ? ' sel' : '');
      d.style.left = `${orphanIdx * 14}px`;
      d.textContent = '!';
      d.title = `配置先を見失っています: ${sp.id} — クリックで詳しく見る`;
      d.onclick = (e) => { e.stopPropagation(); selectItem('sprite', sp.id); };
      makeBlockKeyboardActivatable(d, () => selectItem('sprite', sp.id));
      orphanIdx++;
    } else {
      d.className = 'spBlock' + (isSelected('sprite', sp.id) ? ' sel' : '');
      d.style.left = `${(r.tlStart / S.duration) * 100}%`;
      d.style.width = `${(sp.duration / S.duration) * 100}%`;
      d.title = `${sp.id} (${sp.assetId}, ${sp.duration.toFixed(1)}s) — ドラッグで移動`;
      d.textContent = sp.assetId;
      d.onpointerdown = (e) => startBlockDrag(e, 'sprite', sp.id, r.tlStart, d);
      makeBlockKeyboardActivatable(d, () => { selectItem('sprite', sp.id); seekTl(r.tlStart, { play: false }); });
    }
    row.appendChild(d);
  }
}

// Thin tick marks at scene boundaries (source-of-truth: scenes-<sourceId>.json).
// Click to seek; the culling/source-drawer UI itself is a later phase.
function renderSceneMarks() {
  const el = $('sceneMarks');
  el.innerHTML = '';
  if (!S.duration) return;
  for (const seg of S.segments) {
    const scenes = S.scenes.get(seg.sourceId);
    if (!scenes) continue;
    const segDur = seg.tlEnd - seg.tlStart;
    for (const sc of scenes) {
      if (sc.t0 <= seg.srcStart + 1e-6 || sc.t0 >= seg.srcStart + segDur) continue; // skip marks at/after the clip's own boundary
      const tl = seg.tlStart + (sc.t0 - seg.srcStart);
      const d = document.createElement('div');
      d.className = 'sceneMark';
      d.style.left = `${(tl / S.duration) * 100}%`;
      d.title = `${sc.id} ${fmt(sc.t0)}`;
      d.onpointerdown = (e) => { e.stopPropagation(); seekTl(tl, { play: false }); };
      el.appendChild(d);
    }
  }
}

// ---------- W-UI IA v2 波2 §5: T1 テロップ行 ----------
// A permanent click entry point into the caption style dialog — present
// even when there are zero cues (captions.enabled=false, or an enabled
// project with nothing transcribed yet), which is the exact deadlock the
// spec calls out: turning captions off used to remove every path back to
// turning them on. openCaptionStylePopover's `cue` argument is only ever
// read by the per-cue drag/text-edit code (see buildCueEl) — it's fine to
// pass null here (see also the T1 row's own click handler below).
function renderCaptionRow() {
  const row = $('captionRow');
  if (!row) return;
  row.innerHTML = '';
  if (!S.duration || isComposition()) return;
  const openDialog = (e) => { e?.stopPropagation?.(); openCaptionStylePopover(null); };
  const asButton = (el) => {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.onclick = openDialog;
    el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.code === 'Space') { ev.preventDefault(); openDialog(); } };
  };
  if (!S.manifest.captions.enabled) {
    const d = document.createElement('div');
    d.className = 'capRowBlock capRowOff';
    d.textContent = '字幕: オフ — クリックでオンにする';
    d.title = 'クリックで字幕のオン/オフやデザインを設定できます';
    asButton(d);
    row.appendChild(d);
    return;
  }
  if (S.cues.length === 0) {
    const d = document.createElement('div');
    d.className = 'capRowBlock capRowEmpty';
    d.textContent = '字幕: 表示できるcueがありません — クリックでデザインを設定';
    d.title = '文字起こしが無い、または全て無音として除去されています。クリックで字幕のデザインを設定できます';
    asButton(d);
    row.appendChild(d);
    return;
  }
  for (const c of S.cues) {
    const d = document.createElement('div');
    d.className = 'capRowBlock';
    d.style.left = `${(c.tlStart / S.duration) * 100}%`;
    d.style.width = `${Math.max(0.3, ((c.tlEnd - c.tlStart) / S.duration) * 100)}%`;
    d.title = c.text;
    asButton(d);
    d.onclick = (e) => { e.stopPropagation(); openCaptionStylePopover(c); };
    row.appendChild(d);
  }
}

// ---------- W-UI IA v2 波2 §2: 時間目盛り + トラックラベルガター ----------
const RULER_NICE_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
function renderRuler() {
  const el = $('timeRuler');
  if (!el) return;
  el.innerHTML = '';
  if (!S.duration) return;
  const width = tlEl.getBoundingClientRect().width || el.getBoundingClientRect().width;
  if (!width) return;
  const targetPx = 70; // aim for a tick roughly every 70px, never crowded
  const rawStep = S.duration / Math.max(1, width / targetPx);
  const step = RULER_NICE_STEPS.find((s) => s >= rawStep) ?? RULER_NICE_STEPS[RULER_NICE_STEPS.length - 1];
  for (let t = 0; t <= S.duration + 1e-6; t += step) {
    const tick = document.createElement('div');
    tick.className = 'rulerTick';
    tick.style.left = `${Math.min(100, (t / S.duration) * 100)}%`;
    tick.textContent = fmt(t);
    el.appendChild(tick);
  }
}
// Gutter labels use the EXACT same top/height (or bottom/height) values as
// their corresponding row's own CSS rule (style.css) — percent-based rows
// stay pixel-aligned automatically as the timeline resizes; px-based rows
// (T1/A2, anchored to the bottom of the now-104px-tall #timelineTracks) are
// copied 1:1 from #captionRow/#musicRow's own bottom/height. Only rendered
// when the underlying row actually has something in it (存在する行のみ).
function renderTrackGutter() {
  const el = $('trackGutter');
  if (!el) return;
  el.innerHTML = '';
  const composition = isComposition();
  const addLabel = (text, style) => {
    const d = document.createElement('div');
    d.className = 'gutterLabel';
    d.textContent = text;
    Object.assign(d.style, style);
    el.appendChild(d);
  };
  if (S.overlays.length > 0) addLabel('V2 B-roll', { top: '0%', height: '12%' });
  // Codex 統合レビュー P2-8: 非compositionプロジェクトで V1/A1/T1 を常時
  // 表示していた(素材ゼロの真新しいプロジェクトでもラベルだけ出る)。他の
  // 行(V2/A2)と同じ「データがある行だけ出す」ルールに揃える — T1 は
  // captionRow 自体が字幕オフでも常設の入口として残る(renderCaptionRow の
  // doc参照)ため、ここではガターの「T1」ラベルだけを字幕有効時に絞る。
  const hasClips = S.segments.length > 0;
  if (!composition && hasClips) {
    addLabel('V1 本編', { top: '12%', height: '25%' });
    addLabel('A1 音声', { top: '37%', height: '25%' });
  }
  if (!composition && S.manifest?.captions?.enabled) addLabel('T1 テロップ', { bottom: '0px', height: '12px' });
  if ((S.manifest?.timeline.music ?? []).length > 0) addLabel('A2 BGM', { bottom: '30px', height: '12px' });
}

function drawWave() {
  const c = $('wave');
  const r = tlEl.getBoundingClientRect();
  c.width = r.width * devicePixelRatio;
  c.height = r.height * devicePixelRatio;
  const g = c.getContext('2d');
  g.scale(devicePixelRatio, devicePixelRatio);
  g.clearRect(0, 0, r.width, r.height);
  g.fillStyle = '#637287';
  const mid = r.height * 0.62;
  for (const s of S.segments) {
    const pk = S.peaks.get(s.sourceId);
    if (!pk) continue;
    const x0 = (s.tlStart / S.duration) * r.width;
    const x1 = (s.tlEnd / S.duration) * r.width;
    for (let x = x0; x < x1; x += 2) {
      const srcT = s.srcStart + ((x - x0) / (x1 - x0)) * (s.tlEnd - s.tlStart);
      const v = pk.peaks[Math.floor(srcT * pk.rate)] ?? 0;
      const h = Math.max(1, v * r.height * 0.55);
      g.fillRect(x, mid - h / 2, 1.4, h);
    }
  }
}

// ---------- background music preview ----------
// One <audio> element per timeline.music item, kept in sync with the video
// via rAF in tick() (see syncMusicPlayback). No Web Audio / GainNode: plain
// audio.volume, clamped to [0,1] — a gain above 0dB can't be represented
// this way, which is an accepted preview-only approximation (the real
// render's ffmpeg volume filter has no such ceiling).
function dbToLinear(db) {
  return Math.pow(10, db / 20);
}
function musicUrl(id) {
  return `/media/music/${id}`;
}
// Add/remove <audio> elements so they track the current manifest's music
// list; called on every reload() so ingest/undo/music-add etc. stay in sync.
function syncMusicElements() {
  const music = S.manifest?.timeline.music ?? [];
  const ids = new Set(music.map((mu) => mu.id));
  for (const [id, el] of S.musicEls) {
    if (ids.has(id)) continue;
    el.pause();
    el.remove();
    S.musicEls.delete(id);
  }
  for (const mu of music) {
    if (S.musicEls.has(mu.id)) continue;
    const el = document.createElement('audio');
    el.src = musicUrl(mu.id);
    el.preload = 'auto';
    el.style.display = 'none';
    document.body.appendChild(el);
    S.musicEls.set(mu.id, el);
  }
}
// Whether timeline second `tl` falls inside a caption cue — used as a cheap
// stand-in for "speech is playing right now" (keptWords' time bucketing,
// pre-computed server-side into S.cues) so duck=true music items dip without
// needing a separate word-level lookup in the browser.
function speechActiveAt(tl) {
  return S.cues.some((c) => tl >= c.tlStart && tl < c.tlEnd);
}
// Drive every music <audio> element's currentTime/play-state/volume from the
// current timeline position `tl` (null while source-preview mode owns #video,
// since the timeline mix isn't what's playing then — pauses everything).
function syncMusicPlayback(tl) {
  if (S.musicEls.size === 0) return;
  const duckAmount = S.manifest?.audioMix?.duckAmount ?? -10;
  for (const [id, el] of S.musicEls) {
    const mu = (S.manifest?.timeline.music ?? []).find((m) => m.id === id);
    const active = mu != null && tl != null && tl >= mu.tlStart && tl < mu.tlStart + mu.duration;
    if (!active) {
      if (!el.paused) el.pause();
      continue;
    }
    const localT = tl - mu.tlStart + mu.srcIn;
    if (Math.abs(el.currentTime - localT) > 0.3) el.currentTime = localT;
    if (S.playing && el.paused) tryPlay(el);
    if (!S.playing && !el.paused) el.pause();
    const fadeIn = mu.fadeIn > 0 ? Math.max(0, Math.min(1, (tl - mu.tlStart) / mu.fadeIn)) : 1;
    const fadeOut = mu.fadeOut > 0 ? Math.max(0, Math.min(1, (mu.tlStart + mu.duration - tl) / mu.fadeOut)) : 1;
    let vol = dbToLinear(mu.gain) * fadeIn * fadeOut;
    if (mu.duck && speechActiveAt(tl)) vol *= dbToLinear(duckAmount);
    el.volume = Math.max(0, Math.min(1, vol));
  }
}

// ---------- B-roll V2 overlay preview (W3) ----------
// #videoOverlay is a second <video> stacked over #video (see style.css),
// shown only while the playhead sits inside a resolved (non-orphan) overlay's
// [tlStart, tlEnd). It plays the B-roll source's own proxy independently of
// #video, mirroring how enterSourcePreview drives an unrelated proxy — but
// as its OWN element, so it never fights source-preview mode for #video.
function activeOverlayAt(tl) {
  if (tl == null) return null;
  for (const r of S.overlays) {
    if (r.tlStart == null) continue; // orphan: excluded from preview, same as render/OTIO
    const dur = r.overlay.srcOut - r.overlay.srcIn;
    if (tl >= r.tlStart && tl < r.tlStart + dur) return r;
  }
  return null;
}
function syncOverlayVideo(tl) {
  const r = activeOverlayAt(tl);
  if (!r) {
    if (!videoOverlay.hidden) { videoOverlay.hidden = true; videoOverlay.pause(); }
    return;
  }
  const ov = r.overlay;
  const target = ov.srcIn + (tl - r.tlStart);
  const url = proxyUrl(ov.sourceId);
  if (!videoOverlay.src.endsWith(url)) {
    videoOverlay.src = url;
    videoOverlay.addEventListener('loadedmetadata', () => { videoOverlay.currentTime = target; }, { once: true });
  } else if (Math.abs(videoOverlay.currentTime - target) > 0.3) {
    videoOverlay.currentTime = target;
  }
  videoOverlay.hidden = false;
  if (S.playing && videoOverlay.paused) tryPlay(videoOverlay);
  if (!S.playing && !videoOverlay.paused) videoOverlay.pause();
  // audioMode=mute: main video's audio continues untouched, second video
  // stays muted. mix/replace: approximated by unmuting the second video at
  // the overlay's gain — precisely ducking/replacing the MAIN track's audio
  // in the browser isn't attempted (spec: "近似でよい").
  if (ov.audioMode === 'mute') {
    videoOverlay.muted = true;
  } else {
    videoOverlay.muted = false;
    videoOverlay.volume = Math.max(0, Math.min(1, dbToLinear(ov.gainDb ?? -18)));
  }
}

// ---------- source preview mode (media pool "行クリック") ----------
function renderPreviewBanner() {
  const active = !!S.sourcePreview;
  $('previewBanner').hidden = !active;
  $('timeline').classList.toggle('previewing', active);
  // Reflect which (if any) media-pool row is the one currently previewing,
  // without a full renderMediaPanel() (which would rebuild the DOM and drop
  // focus/scroll position for no reason — nothing else about the row list
  // changed).
  for (const r of document.querySelectorAll('#mediaList .srcRow')) {
    const previewing = S.sourcePreview?.sourceId === r.dataset.source;
    r.classList.toggle('previewing', previewing);
    r.setAttribute('aria-selected', String(previewing));
  }
}
// Switch #video to source `sourceId`'s raw proxy at source-time `at` (default
// 0) and start playing — independent of the timeline mix. Re-entrant: calling
// again while already previewing (e.g. clicking a different scene/source)
// keeps the ORIGINAL returnTl so Esc always restores the pre-preview position.
function enterSourcePreview(sourceId, { at = 0 } = {}) {
  const src = S.manifest?.sources.find((s) => s.id === sourceId);
  if (!src) return;
  if (!src.proxy) { toast('プロキシが未生成のため再生できません', { type: 'error' }); return; }
  const returnTl = S.sourcePreview ? S.sourcePreview.returnTl : tlNow();
  S.sourcePreview = { sourceId, returnTl };
  renderPreviewBanner();
  // Stale overlays/crop framing from timeline mode shouldn't linger over the
  // preview video — it's the raw source, not a specific timeline clip.
  const cap = $('captionLayer'); cap.innerHTML = ''; cap.dataset.cur = '';
  const mo = $('motionLayer'); mo.innerHTML = ''; mo.dataset.cur = '';
  const sp = $('spriteLayer'); if (sp) { sp.innerHTML = ''; sp.dataset.cur = ''; } // W8 sprites don't apply to raw source preview either
  video.style.objectPosition = '50% 50%';
  video.pause();
  if (!videoOverlay.hidden) { videoOverlay.hidden = true; videoOverlay.pause(); } // B-roll V2 preview doesn't apply to raw source preview

  const url = proxyUrl(sourceId);
  const apply = () => { video.currentTime = at; tryPlay(video); };
  if (!video.src.endsWith(url)) { video.src = url; video.addEventListener('loadedmetadata', apply, { once: true }); }
  else apply();
  S.playing = true;
  setPlayBtnState(true);
}
function exitSourcePreview() {
  if (!S.sourcePreview) return;
  seekTl(S.sourcePreview.returnTl, { play: false }); // clears S.sourcePreview internally
}
$('previewBannerExit').onclick = exitSourcePreview;

// ---------- media pool panel ("素材") ----------
function sourceUsageSeconds(sourceId) {
  return S.segments
    .filter((s) => s.sourceId === sourceId)
    .reduce((sum, s) => sum + (s.tlEnd - s.tlStart), 0);
}
// ---- 3-state scene culling (keep/reject/unreviewed) ----
// Review state lives on the manifest (S.manifest.culling[sourceId][sceneId]),
// mirroring core/ops.ts's setSceneReview/cullingStats — read-only mirrors
// here, all writes go through mutate({ op: 'scene-review', ... }).
function reviewFor(sourceId, sceneId) {
  return S.manifest?.culling?.[sourceId]?.[sceneId];
}
function cullingCounts(sourceId) {
  const scenes = S.scenes.get(sourceId) ?? [];
  let keep = 0;
  let reject = 0;
  for (const sc of scenes) {
    const r = reviewFor(sourceId, sc.id);
    if (r === 'keep') keep++;
    else if (r === 'reject') reject++;
  }
  return { total: scenes.length, keep, reject, unreviewed: scenes.length - keep - reject };
}
async function setSceneReviewUi(sourceId, sceneId, review, trigger) {
  // Set the roving-tabindex target before the mutation so the reload()
  // triggered by mutate() re-renders the grid with this scene already the
  // tabbable stop; DOM focus itself still needs reclaiming afterward since
  // mutate() rebuilds the panel from scratch.
  S.sceneFocus.set(sourceId, sceneId);
  await mutate(
    { op: 'scene-review', sourceId, sceneIds: [sceneId], review },
    { conflictMessage: '選別状態の更新は反映されませんでした。最新状態を確認してもう一度実行してください', trigger },
  );
  document.querySelector(`.sceneItem[data-source="${CSS.escape(sourceId)}"][data-scene="${CSS.escape(sceneId)}"]`)?.focus();
}
function setMediaFocus(sourceId, { focus = true } = {}) {
  S.mediaFocusKey = sourceId;
  for (const r of document.querySelectorAll('#mediaList .srcRow')) {
    r.tabIndex = r.dataset.source === sourceId ? 0 : -1;
  }
  if (focus) document.querySelector(`.srcRow[data-source="${CSS.escape(sourceId)}"]`)?.focus();
}
async function addSourceToTimeline(src, trigger) {
  const name = basename(src.path);
  const { ok } = await mutate({ op: 'clip-add', sourceId: src.id }, { trigger });
  if (ok) toast(`${name} を追加 (+${src.duration.toFixed(1)}s)`);
}
async function addSceneToTimeline(src, sc, trigger) {
  const name = basename(src.path);
  const dur = Math.max(0, sc.t1 - sc.t0);
  const { ok } = await mutate({ op: 'clip-add', sourceId: src.id, in: sc.t0, out: sc.t1 }, { trigger });
  if (ok) toast(`${name} ${sc.id} を追加 (+${dur.toFixed(1)}s)`);
}
function toggleScenes(sourceId) {
  if (S.expandedScenes.has(sourceId)) S.expandedScenes.delete(sourceId);
  else S.expandedScenes.add(sourceId);
  renderMediaPanel();
  document.querySelector(`.srcRow[data-source="${CSS.escape(sourceId)}"] .btn-viewScenes`)?.focus();
}
function sceneGridRow(src, scenes) {
  const wrap = document.createElement('div');
  wrap.className = 'sceneGrid';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `${basename(src.path)} のシーン一覧`);
  let focusId = S.sceneFocus.get(src.id);
  if (!focusId || !scenes.some((sc) => sc.id === focusId)) focusId = scenes[0]?.id;
  for (const sc of scenes) {
    const dur = Math.max(0, sc.t1 - sc.t0);
    const review = reviewFor(src.id, sc.id);
    const item = document.createElement('div');
    item.className = 'sceneItem' + (review ? ` review-${review}` : '');
    item.dataset.source = src.id;
    item.dataset.scene = sc.id;
    item.tabIndex = sc.id === focusId ? 0 : -1;

    const reviewRow = document.createElement('div');
    reviewRow.className = 'sceneReview';
    const keepBtn = document.createElement('button');
    keepBtn.className = 'btn-sceneKeep';
    keepBtn.textContent = '✓';
    keepBtn.setAttribute('aria-pressed', String(review === 'keep'));
    keepBtn.setAttribute('aria-label', `${sc.id} を採用にする`);
    keepBtn.onclick = (e) => { e.stopPropagation(); setSceneReviewUi(src.id, sc.id, review === 'keep' ? 'clear' : 'keep', keepBtn); };
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-sceneReject';
    rejectBtn.textContent = '✕';
    rejectBtn.setAttribute('aria-pressed', String(review === 'reject'));
    rejectBtn.setAttribute('aria-label', `${sc.id} を不採用にする`);
    rejectBtn.onclick = (e) => { e.stopPropagation(); setSceneReviewUi(src.id, sc.id, review === 'reject' ? 'clear' : 'reject', rejectBtn); };
    reviewRow.append(keepBtn, rejectBtn);
    item.appendChild(reviewRow);

    const seekBtn = document.createElement('button');
    seekBtn.className = 'btn-sceneSeek';
    seekBtn.textContent = `${sc.id} (${dur.toFixed(1)}s)`;
    seekBtn.setAttribute('aria-label', `${sc.id}(${dur.toFixed(1)}秒)をプレビュー`);
    seekBtn.onclick = () => enterSourcePreview(src.id, { at: sc.t0 });
    item.appendChild(seekBtn);
    if (sc.note?.text) {
      const note = document.createElement('div');
      note.className = 'sceneNote';
      note.textContent = sc.note.text;
      item.appendChild(note);
    }
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-sceneAdd';
    addBtn.textContent = 'この区間を追加';
    addBtn.setAttribute('aria-label', `${sc.id} をタイムラインへ追加`);
    addBtn.onclick = () => addSceneToTimeline(src, sc, addBtn);
    item.appendChild(addBtn);
    wrap.appendChild(item);
  }
  return wrap;
}
// Mirrors core/ops.ts's needsColorTransform (web has no access to the TS
// build, so the judgment is duplicated here — badge display only, never
// used for any actual color transform).
function needsColorTransform(color) {
  if (!color) return false;
  const KNOWN_SDR = new Set(['bt709', 'srgb']);
  const transfer = color.transfer;
  if (transfer && transfer !== 'unknown' && !KNOWN_SDR.has(transfer)) return true;
  if ((!transfer || transfer === 'unknown') && color.primaries === 'bt2020') return true;
  return false;
}
// W-UI §3: simple list by default (thumbnail + name + duration only); a row
// click (or the "▸ 詳細" button) expands badges/usage-bar/scene-button —
// second-order info stays out of the way until asked for. Raw ids
// (sourceId) are shown only inside the expanded detail.
function toggleMediaDetail(sourceId) {
  if (S.expandedMedia.has(sourceId)) S.expandedMedia.delete(sourceId);
  else S.expandedMedia.add(sourceId);
  renderMediaPanel();
  document.querySelector(`.srcRow[data-source="${CSS.escape(sourceId)}"]`)?.focus();
}
function mediaRow(src) {
  const name = basename(src.path);
  const expanded = S.expandedMedia.has(src.id);

  const row = document.createElement('div');
  row.className = 'srcRow' + (S.sourcePreview?.sourceId === src.id ? ' previewing' : '');
  row.dataset.source = src.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(S.sourcePreview?.sourceId === src.id));
  row.tabIndex = src.id === S.mediaFocusKey ? 0 : -1;

  const img = document.createElement('img');
  img.className = 'srcThumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = `/media/thumb/${src.id}`;

  const info = document.createElement('div');
  info.className = 'srcInfo';
  const nameRow = document.createElement('div');
  nameRow.className = 'srcNameRow';
  nameRow.innerHTML = `<span class="srcName">${esc(name)}</span><span class="srcDur">${fmt(src.duration)}</span>`;
  info.appendChild(nameRow);

  if (expanded) {
    const badges = document.createElement('div');
    badges.className = 'srcBadges';
    // W5: a source with an applied colorTransform (type !== 'none') shows
    // "変換済み" instead of the "要色変換" warning — the warning's purpose
    // (flag material that will preview/render flat) no longer applies once
    // `vedit color` has actually set a transform.
    const colorConverted = src.colorTransform && src.colorTransform.type && src.colorTransform.type !== 'none';
    // W-LAZY: transcription is no longer an ingest-time default, so this is
    // a 3-state badge (なし/処理中/済) always shown, not just an "ok" flag
    // that appears once done — S.transcribing is populated from
    // /api/project's `transcribing` field plus live transcribe-progress/
    // -done/-error WS messages (see connectWs below).
    const transcribeBadge = src.transcribed
      ? '<span class="badge ok">文字起こし: 済</span>'
      : S.transcribing.has(src.id)
        ? '<span class="badge warn">文字起こし: 処理中</span>'
        : '<span class="badge">文字起こし: なし</span>';
    badges.innerHTML = [
      transcribeBadge,
      !src.hasAudio ? '<span class="badge warn">音声なし</span>' : '',
      !src.proxy ? '<span class="badge warn">プロキシ未生成</span>' : '',
      colorConverted
        ? '<span class="badge ok">変換済み</span>'
        : needsColorTransform(src.color) ? '<span class="badge warn">要色変換</span>' : '',
    ].join('');
    if (S.scenes.has(src.id)) {
      const c = cullingCounts(src.id);
      const cullBadge = document.createElement('span');
      cullBadge.className = 'badge cullBadge';
      cullBadge.textContent = `未確認 ${c.unreviewed} / 採用 ${c.keep} / 不採用 ${c.reject}`;
      badges.appendChild(cullBadge);
    }
    const used = sourceUsageSeconds(src.id);
    const pct = src.duration > 0 ? Math.min(100, (used / src.duration) * 100) : 0;
    const usage = document.createElement('div');
    usage.className = 'srcUsage';
    usage.innerHTML = `<span class="srcUsageBar"><span class="srcUsageFill" style="width:${pct}%"></span></span><span class="srcUsageLabel">使用 ${used.toFixed(1)}s / ${src.duration.toFixed(1)}s</span>`;
    info.append(badges, usage);
  }

  const actions = document.createElement('div');
  actions.className = 'srcActions';
  const playBtn = document.createElement('button');
  playBtn.textContent = '▶ 再生';
  playBtn.setAttribute('aria-label', `${name} を再生`);
  playBtn.onclick = (e) => { e.stopPropagation(); setMediaFocus(src.id, { focus: false }); enterSourcePreview(src.id); };
  actions.appendChild(playBtn);
  const addBtn = document.createElement('button');
  addBtn.textContent = 'タイムラインへ追加';
  addBtn.setAttribute('aria-label', `${name} をタイムラインへ追加`);
  addBtn.onclick = (e) => { e.stopPropagation(); addSourceToTimeline(src, addBtn); };
  actions.appendChild(addBtn);
  const detailBtn = document.createElement('button');
  detailBtn.className = 'btn-toggleDetail';
  detailBtn.textContent = expanded ? '▾ 詳細' : '▸ 詳細';
  detailBtn.setAttribute('aria-expanded', String(expanded));
  detailBtn.setAttribute('aria-label', `${name} の詳細を${expanded ? '閉じる' : '表示'}`);
  detailBtn.onclick = (e) => { e.stopPropagation(); toggleMediaDetail(src.id); };
  actions.appendChild(detailBtn);
  if (expanded && S.scenes.has(src.id)) {
    const scenesExpanded = S.expandedScenes.has(src.id);
    const scenesBtn = document.createElement('button');
    scenesBtn.className = 'btn-viewScenes';
    scenesBtn.textContent = 'シーンを見る';
    scenesBtn.setAttribute('aria-expanded', String(scenesExpanded));
    scenesBtn.setAttribute('aria-label', `${name} のシーンを${scenesExpanded ? '閉じる' : '見る'}`);
    scenesBtn.onclick = (e) => { e.stopPropagation(); toggleScenes(src.id); };
    actions.appendChild(scenesBtn);
  }

  row.append(img, info, actions);
  row.addEventListener('pointerdown', () => setMediaFocus(src.id, { focus: false }));
  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    setMediaFocus(src.id);
    toggleMediaDetail(src.id);
  });
  return row;
}
// ---------- W-UI IA v2 波2 §7: キットのリンク状態(素材タブ先頭) ----------
// Linked: "キット: 名前 · スタイルN・素材N" info line. Not linked: per
// 追補#5 (Codex レビュー), a "Claude に頼む" chip instead of hiding the area
// outright — kit-link is structural (a filesystem path Claude has to
// resolve), so this is a dead end the same way an orphaned B-roll is.
function renderKitStatus() {
  const el = $('kitStatus');
  if (!el) return;
  const kit = S.kit?.kit;
  if (kit) {
    el.hidden = false;
    el.innerHTML = '';
    const name = kit.name || basename(S.kit.path ?? '') || 'キット';
    const text = document.createElement('span');
    text.textContent = `キット: ${name} · スタイル${(kit.styles ?? []).length}・素材${(kit.assets ?? []).length}`;
    text.title = S.kit.path ?? '';
    el.appendChild(text);
    return;
  }
  if (S.kit?.path) {
    // path is set but the kit.json couldn't be read (see S.kit.error) —
    // that's a broken link, not "no kit"; still worth a chip, different wording.
    el.hidden = false;
    el.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = `キット未読み込み: ${basename(S.kit.path)}`;
    el.appendChild(text);
    el.appendChild(askClaudeChip('キットの連携を確認して(kit.jsonが読み込めません)'));
    return;
  }
  el.hidden = false;
  el.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = 'キット: 未連携';
  el.appendChild(text);
  el.appendChild(askClaudeChip('このプロジェクトにキットを連携して'));
}

// ---------- W-UI IA v2 波2 §4: 音声パネル(プロジェクト全体設定) ----------
function renderAudioPanel() {
  const preset = S.manifest.audioRepair?.preset ?? 'off';
  const presetSel = $('audioRepairPreset');
  if (presetSel && document.activeElement !== presetSel) presetSel.value = preset;
  const deessCb = $('audioRepairDeess');
  if (deessCb && document.activeElement !== deessCb) deessCb.checked = Boolean(S.manifest.audioRepair?.deess);

  const duckAmount = S.manifest.audioMix?.duckAmount ?? -10;
  const duckInput = $('audioMixDuck');
  if (duckInput && document.activeElement !== duckInput) duckInput.value = String(duckAmount);
  $('audioMixDuckVal').textContent = `${duckAmount}dB`;

  const targetLufs = S.manifest.audioMix?.targetLufs ?? -14;
  const lufsInput = $('audioMixLufs');
  if (lufsInput && document.activeElement !== lufsInput) lufsInput.value = String(targetLufs);
  $('audioMixLufsVal').textContent = `${targetLufs}LUFS`;
}
$('audioRepairPreset').onchange = async (e) => {
  await mutate(
    { op: 'audio-repair', preset: e.target.value, deess: $('audioRepairDeess').checked },
    { conflictMessage: '会話リペアの設定は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
$('audioRepairDeess').onchange = async (e) => {
  const preset = S.manifest.audioRepair?.preset ?? 'off';
  await mutate(
    { op: 'audio-repair', preset, deess: e.target.checked },
    { conflictMessage: 'デエッサーの設定は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
$('audioMixDuck').onchange = async (e) => {
  await mutate(
    { op: 'audio-mix', duckAmount: Number(e.target.value) },
    { conflictMessage: 'ダッキング量の変更は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
$('audioMixLufs').onchange = async (e) => {
  await mutate(
    { op: 'audio-mix', targetLufs: Number(e.target.value) },
    { conflictMessage: '目標ラウドネスの変更は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
// Live readout while dragging, before the change commits.
$('audioMixDuck').oninput = (e) => { $('audioMixDuckVal').textContent = `${e.target.value}dB`; };
$('audioMixLufs').oninput = (e) => { $('audioMixLufsVal').textContent = `${e.target.value}LUFS`; };

// ---- BGM追加 (music-add) ----
$('musicAddBtn').onclick = () => {
  const form = $('musicAddForm');
  form.hidden = !form.hidden;
  if (!form.hidden) $('musicAddPath').focus();
};
$('musicAddCancel').onclick = () => {
  $('musicAddForm').hidden = true;
  $('musicAddPath').value = '';
  $('musicAddSfx').checked = false;
};
async function submitMusicAdd(fileOrPath) {
  let filePath = fileOrPath;
  if (fileOrPath instanceof File) {
    try {
      filePath = (await api(`/api/upload?${new URLSearchParams({ name: fileOrPath.name })}`, { method: 'POST', body: fileOrPath })).path;
    } catch (e) {
      toast(`音声ファイルの取り込みに失敗しました: ${e.message}`, { type: 'error' });
      return;
    }
  }
  filePath = (filePath ?? '').trim();
  if (!filePath) { toast('ファイルのパスを入力してください', { type: 'error' }); return; }
  const sfx = $('musicAddSfx').checked;
  const body = { op: 'music-add', path: filePath, tlStart: tlNow() };
  if (sfx) Object.assign(body, { duck: false, fadeIn: 0.03, fadeOut: 0.03, role: 'sfx' });
  const { ok } = await mutate(body, { conflictMessage: 'BGM/SEの追加は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: $('musicAddSubmit') });
  if (ok) { $('musicAddForm').hidden = true; $('musicAddPath').value = ''; $('musicAddSfx').checked = false; }
}
$('musicAddSubmit').onclick = () => submitMusicAdd($('musicAddPath').value);
// Codex 統合レビュー P2-5: stopPropagation しないと window の動画取り込み
// dragenter/drop ハンドラにもバブって二重発火し(BGMフォームへ音声ファイルを
// ドロップすると「動画ファイルが見つかりませんでした」の誤トーストが出る)、
// このフォームの追加とは無関係な取り込みフローが同時に走ってしまう。
$('musicAddForm').addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
$('musicAddForm').addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer?.files?.[0];
  if (file) submitMusicAdd(file);
});

// ---- 「言い直しを確認」(W-UI IA v2 波2 §7): GET /api/takes をユーザー起点
// で開く — これまで Claude の show directive 経由のみ到達可能だった。
$('takesCheckBtn').onclick = async () => {
  const transcribedSrcs = S.manifest.sources.filter((s) => s.transcribed);
  if (transcribedSrcs.length === 0) { toast('文字起こしがまだありません', { type: 'error' }); return; }
  for (const src of transcribedSrcs) {
    let groups;
    try { groups = await fetchTakesForSource(src.id); } catch { continue; }
    if (groups.length > 0) { renderTakesCard(src.id, groups[0]); return; }
  }
  toast('言い直し候補は見つかりませんでした');
};

function renderMediaPanel() {
  renderKitStatus();
  renderAudioPanel();
  const el = $('mediaList');
  el.innerHTML = '';
  const sources = S.manifest.sources;
  // W-UI IA v2 用語表: 「keepだけで仮タイムライン作成」→「採用シーンで仮編集
  // を作る」、採用>0 のときだけ表示(0のときは押しても意味のあるものが
  // 何もない — 空の仮タイムラインを作られても困惑するだけなので隠す)。
  $('buildSelectsBtn').hidden = totalKeepCount() === 0;
  if (sources.length === 0) {
    el.innerHTML = '<div class="hintText" style="padding:8px">まだ素材がありません — ここに動画をドラッグして取り込み</div>';
    return;
  }
  if (S.mediaFocusKey && !sources.some((s) => s.id === S.mediaFocusKey)) S.mediaFocusKey = null;
  if (!S.mediaFocusKey) S.mediaFocusKey = sources[0].id;
  for (const src of sources) {
    el.appendChild(mediaRow(src));
    if (S.expandedScenes.has(src.id)) {
      const scenes = S.scenes.get(src.id);
      if (scenes) el.appendChild(sceneGridRow(src, scenes));
    }
  }
}
// Scene-grid nav (←→, K/X/U) is scoped to a focused .sceneItem so it never
// collides with the global JKL/arrow-seek shortcuts on document — those are
// blocked while focus sits inside a <button> (see globalShortcutsBlocked),
// and stopPropagation() here additionally keeps the keydown from ever
// bubbling up to that document-level handler at all.
function handleSceneItemKeydown(e, item) {
  const sourceId = item.dataset.source;
  const sceneId = item.dataset.scene;
  const scenes = S.scenes.get(sourceId) ?? [];
  const idx = scenes.findIndex((s) => s.id === sceneId);
  if (idx < 0) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault(); e.stopPropagation();
    S.sceneFocus.set(sourceId, scenes[Math.min(idx + 1, scenes.length - 1)].id);
    renderMediaPanel();
    document.querySelector(`.sceneItem[data-source="${CSS.escape(sourceId)}"][data-scene="${CSS.escape(S.sceneFocus.get(sourceId))}"]`)?.focus();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault(); e.stopPropagation();
    S.sceneFocus.set(sourceId, scenes[Math.max(idx - 1, 0)].id);
    renderMediaPanel();
    document.querySelector(`.sceneItem[data-source="${CSS.escape(sourceId)}"][data-scene="${CSS.escape(S.sceneFocus.get(sourceId))}"]`)?.focus();
  } else if (e.key.toLowerCase() === 'k') {
    e.preventDefault(); e.stopPropagation();
    setSceneReviewUi(sourceId, sceneId, reviewFor(sourceId, sceneId) === 'keep' ? 'clear' : 'keep');
  } else if (e.key.toLowerCase() === 'x') {
    e.preventDefault(); e.stopPropagation();
    setSceneReviewUi(sourceId, sceneId, reviewFor(sourceId, sceneId) === 'reject' ? 'clear' : 'reject');
  } else if (e.key.toLowerCase() === 'u') {
    e.preventDefault(); e.stopPropagation();
    setSceneReviewUi(sourceId, sceneId, 'clear');
  }
}
$('mediaList').addEventListener('keydown', (e) => {
  const sceneItem = e.target.closest('.sceneItem');
  if (sceneItem) { handleSceneItemKeydown(e, sceneItem); return; }
  const row = e.target.closest('.srcRow');
  if (!row) return;
  const sources = S.manifest.sources;
  const idx = sources.findIndex((s) => s.id === row.dataset.source);
  if (idx < 0) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setMediaFocus(sources[Math.min(idx + 1, sources.length - 1)].id); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setMediaFocus(sources[Math.max(idx - 1, 0)].id); }
  else if (e.key === 'Home') { e.preventDefault(); setMediaFocus(sources[0].id); }
  else if (e.key === 'End') { e.preventDefault(); setMediaFocus(sources[sources.length - 1].id); }
  else if (e.key === 'Enter') { e.preventDefault(); toggleMediaDetail(row.dataset.source); }
});
// W-UI IA v2 用語表: keep/reject/未確認 → 採用/不採用/未確認。「採用」に
// 設定した合計シーン数 — buildSelectsBtn の表示条件(採用>0のときだけ表示)
// と、クリック時の件数表示の両方で使う共有カウント。
function totalKeepCount() {
  let n = 0;
  for (const s of S.manifest.sources) {
    if (!S.scenes.has(s.id)) continue;
    for (const sc of S.scenes.get(s.id)) {
      if (reviewFor(s.id, sc.id) === 'keep') n++;
    }
  }
  return n;
}
$('buildSelectsBtn').onclick = async () => {
  const keepCount = totalKeepCount();
  if (keepCount === 0) return; // button is hidden whenever this is 0 (see renderMediaPanel) — defensive only
  const currentClips = S.manifest.timeline.video.length;
  const ok = confirm(
    `現在のタイムライン(クリップ ${currentClips} 本)を、採用にした ${keepCount} シーンだけの仮タイムラインに置き換えます。\n元のタイムラインは undo で戻せます。よろしいですか？`,
  );
  if (!ok) return;
  const { ok: applied } = await mutate(
    { op: 'selects' },
    { conflictMessage: '仮タイムラインの作成は適用されませんでした。最新状態を確認してもう一度実行してください', trigger: $('buildSelectsBtn') },
  );
  if (applied) toast(`採用 ${keepCount} シーンで仮タイムラインを作成しました`);
};

// ---------- W-UI IA v2 波2 §1: selection inspector ----------
// Clicking a clip/B-roll/motion/sprite/dialogue/BGM block on the timeline
// switches the aside from #tabsView to #inspectorView (temporarily — "←
// 確認に戻る" returns). Caption cues are the one exception in the spec's
// object list: they keep opening the existing captionStyleDialog directly
// (see buildCueEl/openCaptionStylePopover) rather than duplicating that
// dialog's font/palette/position controls into the narrow aside.
function selectItem(kind, id) {
  S.selection = id ? { kind, id } : null;
  renderTimeline(); // updates .sel highlight classes on the timeline blocks
  renderInspector();
}
function deselect() { selectItem(null, null); }
function isSelected(kind, id) {
  return S.selection?.kind === kind && S.selection?.id === id;
}
// Back-compat name: clip selection is reached from several timeline drag
// handlers under this name (startClipReorderDrag/startTrimDrag) — kept as a
// thin wrapper onto the generalized path rather than touching every call site.
function selectClip(clipId) { selectItem('clip', clipId); }

$('inspectorBack').onclick = deselect;

function inspField(labelText, valueText) {
  const wrap = document.createElement('div');
  wrap.className = 'inspField';
  const l = document.createElement('label');
  l.textContent = labelText;
  wrap.appendChild(l);
  if (valueText != null) {
    const v = document.createElement('div');
    v.className = 'inspMeta';
    v.textContent = valueText;
    wrap.appendChild(v);
  }
  return wrap;
}
function inspDivider(body) {
  const d = document.createElement('div');
  d.className = 'inspDivider';
  body.appendChild(d);
}
/** A labeled <input type=range> with a live-updating value readout, committing via `onCommit` only on release (change), not every drag tick — same "preview locally, commit on release" shape as the caption-style popover's sliders. Shared by the clip inspector's color-adjust fields and the BGM inspector's gain/fade fields. */
function inspSlider(labelText, { min, max, step, value, format = String, onCommit }) {
  const wrap = document.createElement('div');
  wrap.className = 'inspField';
  const l = document.createElement('label');
  const valSpan = document.createElement('span');
  valSpan.className = 'mono';
  valSpan.textContent = format(value);
  l.append(`${labelText} `, valSpan);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.oninput = () => { valSpan.textContent = format(Number(input.value)); };
  // 波2.5: disabled for the pending round-trip (prevents re-dragging the
  // same slider again before the previous commit resolves) — onCommit's own
  // mutate() call doesn't see this slider directly, so the disable/enable
  // happens here instead of via mutate()'s opts.trigger.
  input.onchange = async () => {
    input.disabled = true;
    try { await onCommit(Number(input.value)); } finally { input.disabled = false; }
  };
  wrap.append(l, input);
  return wrap;
}
function inspRemoveButton(labelText, confirmText, onConfirm) {
  const btn = document.createElement('button');
  btn.className = 'btn-reject';
  btn.textContent = labelText;
  btn.onclick = async () => {
    if (!confirm(confirmText)) return;
    deselect();
    btn.disabled = true; // 波2.5: pending 中の連打防止(rebuilt by the inspector re-render on success anyway; only matters if the mutation fails and this DOM survives)
    try { await onConfirm(); } finally { btn.disabled = false; }
  };
  return btn;
}

function buildClipInspector(body, clipId) {
  const segs = S.segments.filter((s) => s.clipId === clipId);
  if (segs.length === 0) { deselect(); return; }
  const clip = S.manifest.timeline.video.find((c) => c.id === clipId);
  const label = document.createElement('div');
  label.className = 'inspLabel';
  label.textContent = clipDisplayLabel(clipId);
  label.title = clipId; // internal id kept as a tooltip only — see clipDisplayLabel's doc
  body.appendChild(label);

  body.appendChild(inspField('タイムライン位置', segs.map((s) => `${fmt(s.tlStart)}–${fmt(s.tlEnd)}`).join(', ')));
  if (clip) {
    body.appendChild(inspField('使用範囲(素材内)', `${fmt(clip.srcIn)}–${fmt(clip.srcOut)}`));
    const cropText = S.manifest.output
      ? `X ${Math.round((clip.crop?.x ?? 0.5) * 100)}% / Y ${Math.round((clip.crop?.y ?? 0.5) * 100)}%`
      : '出力比率が既定のため未使用';
    body.appendChild(inspField('クロップ位置', cropText));
  }
  inspDivider(body);

  const trimRow = (rowLabel, edge) => {
    const row = document.createElement('div');
    row.className = 'inspTrimRow';
    const l = document.createElement('span');
    l.textContent = rowLabel;
    l.className = 'inspMeta';
    row.appendChild(l);
    for (const [df, txt] of [[-1, '−1f'], [1, '+1f']]) {
      const b = document.createElement('button');
      b.textContent = txt;
      b.setAttribute('aria-label', `${rowLabel}を${df > 0 ? '1フレーム進める' : '1フレーム戻す'}`);
      b.onclick = async () => { await mutate({ op: 'trim', clipId, edge, frames: df }, { trigger: b }); };
      row.appendChild(b);
    }
    return row;
  };
  body.appendChild(trimRow('開始点(IN)', 'in'));
  body.appendChild(trimRow('終了点(OUT)', 'out'));

  // W-UI IA v2 波2 §6: color-adjust lives on the clip inspector (the source
  // this clip plays from), rather than adding a 7th selection kind —
  // exposure/saturation get a CSS approximation live in the preview (see
  // colorAdjustFilterFor/tick()); white balance has no CSS equivalent, so it
  // stays a plain number + an explicit "書き出しで確認" note (no dishonest
  // approximation).
  if (clip) {
    inspDivider(body);
    const colorHeading = document.createElement('div');
    colorHeading.className = 'inspLabel';
    colorHeading.textContent = '色調整(この素材全体)';
    body.appendChild(colorHeading);
    const sourceId = clip.sourceId;
    const cur = S.manifest.colorAdjust?.[sourceId] ?? {};
    body.appendChild(inspSlider('露出', {
      min: -2, max: 2, step: 0.1, value: cur.exposure ?? 0,
      format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}EV`,
      onCommit: async (v) => { await mutate({ op: 'color-adjust', sourceId, exposure: v }); },
    }));
    body.appendChild(inspSlider('彩度', {
      min: 0, max: 2, step: 0.05, value: cur.sat ?? 1,
      format: (v) => `${Math.round(v * 100)}%`,
      onCommit: async (v) => { await mutate({ op: 'color-adjust', sourceId, sat: v }); },
    }));
    const wbWrap = inspSlider('色温度', {
      min: -100, max: 100, step: 5, value: cur.wb ?? 0,
      format: (v) => String(v),
      onCommit: async (v) => { await mutate({ op: 'color-adjust', sourceId, wb: v }); },
    });
    const wbBadge = document.createElement('span');
    wbBadge.className = 'exportOnlyBadge';
    wbBadge.title = '色温度の変化はプレビューでは近似できません。実際の色味は書き出しで確認してください';
    wbBadge.textContent = '色温度は書き出しで確認';
    wbWrap.appendChild(wbBadge);
    body.appendChild(wbWrap);
  }

  inspDivider(body);
  body.appendChild(inspRemoveButton(
    'タイムラインから外す', 'このクリップをタイムラインから外しますか？(素材は残ります)',
    async () => { await mutate({ op: 'clip-remove', clipId }); },
  ));
}

function buildBrollInspector(body, id) {
  const r = S.overlays.find((x) => x.overlay.id === id);
  if (!r) { deselect(); return; }
  const ov = r.overlay;
  const src = S.manifest.sources.find((s) => s.id === ov.sourceId);
  const label = document.createElement('div');
  label.className = 'inspLabel';
  label.textContent = `B-roll: ${sourceLabel(src)}`;
  label.title = src ? basename(src.path) : ov.sourceId;
  body.appendChild(label);
  if (r.tlStart != null) {
    const dur = ov.srcOut - ov.srcIn;
    body.appendChild(inspField('タイムライン位置', `${fmt(r.tlStart)}–${fmt(r.tlStart + dur)}`));
    body.appendChild(inspField('使用範囲(素材内)', `${fmt(ov.srcIn)}–${fmt(ov.srcOut)}`));
    body.appendChild(inspField('音声モード', ov.audioMode));
  } else {
    const anchorSrc = S.manifest.sources.find((s) => s.id === ov.anchor.sourceId);
    const warn = document.createElement('div');
    warn.className = 'inboxWarn';
    warn.textContent = `配置先を見失っています — 元の位置(${sourceLabel(anchorSrc)} の ${fmt(ov.anchor.srcTime)} 付近)がカットで失われました`;
    body.appendChild(warn);
    body.appendChild(askClaudeChip(`B-roll(${sourceLabel(anchorSrc)} の ${fmt(ov.anchor.srcTime)} 付近)を置き直して`));
  }
  inspDivider(body);
  body.appendChild(inspRemoveButton(
    'タイムラインから外す', 'このB-rollをタイムラインから外しますか？',
    async () => { await mutate({ op: 'broll-remove', id }); },
  ));
}

function buildMotionInspector(body, id) {
  const mo = S.manifest.timeline.motion.find((m) => m.id === id);
  if (!mo) { deselect(); return; }
  const spec = S.motionSpecs?.[id];
  const label = document.createElement('div');
  label.className = 'inspLabel';
  label.textContent = spec?.type ? (MOTION_TYPE_LABEL[spec.type] ?? spec.type) : 'モーション演出';
  body.appendChild(label);
  body.appendChild(inspField('タイムライン位置', `${fmt(mo.tlStart)}–${fmt(mo.tlStart + mo.duration)}`));
  if (spec?.type === 'custom-html') {
    const badge = document.createElement('span');
    badge.className = 'exportOnlyBadge';
    badge.title = 'custom-html のモーションは書き出し時に焼き込まれません(警告付きでスキップされます)';
    badge.textContent = '書き出し対象外(プレビューのみ)';
    body.appendChild(badge);
  }
  inspDivider(body);
  body.appendChild(inspRemoveButton(
    'タイムラインから外す', 'このモーション演出をタイムラインから外しますか？',
    async () => { await mutate({ op: 'motion-remove', id }); },
  ));
}

function buildSpriteInspector(body, id) {
  const r = S.sprites.find((x) => x.sprite.id === id);
  if (!r) { deselect(); return; }
  const sp = r.sprite;
  const label = document.createElement('div');
  label.className = 'inspLabel';
  label.textContent = `キャラクター: ${sp.assetId}`;
  body.appendChild(label);
  if (r.tlStart != null) {
    body.appendChild(inspField('タイムライン位置', `${fmt(r.tlStart)}–${fmt(r.tlStart + sp.duration)}`));
  } else {
    const anchorSrc = S.manifest.sources.find((s) => s.id === sp.anchor.sourceId);
    const warn = document.createElement('div');
    warn.className = 'inboxWarn';
    warn.textContent = `配置先を見失っています — 元の位置(${sourceLabel(anchorSrc)} の ${fmt(sp.anchor.srcTime)} 付近)がカットで失われました`;
    body.appendChild(warn);
    body.appendChild(askClaudeChip(`キャラクター(${sp.assetId} · ${sourceLabel(anchorSrc)} の ${fmt(sp.anchor.srcTime)} 付近)を置き直して`));
  }
  inspDivider(body);
  body.appendChild(inspRemoveButton(
    'タイムラインから外す', 'このキャラクターをタイムラインから外しますか？',
    async () => { await mutate({ op: 'sprite-remove', id }); },
  ));
}

function buildDialogueInspector(body, id) {
  const d = (S.dialogue ?? []).find((x) => x.id === id);
  if (!d) { deselect(); return; }
  const label = document.createElement('div');
  label.className = 'inspLabel';
  label.textContent = `セリフ: "${d.text}"`;
  body.appendChild(label);
  body.appendChild(inspField('タイムライン位置', `${fmt(d.tlStart)}–${fmt(d.tlStart + d.duration)}`));
  inspDivider(body);
  body.appendChild(inspRemoveButton(
    'タイムラインから外す', 'このセリフをタイムラインから外しますか？',
    async () => { await mutate({ op: 'dialogue-remove', id }); },
  ));
}

function buildMusicInspector(body, id) {
  const mu = (S.manifest.timeline.music ?? []).find((m) => m.id === id);
  if (!mu) { deselect(); return; }
  const label = document.createElement('div');
  label.className = 'inspLabel';
  label.textContent = `${mu.role === 'sfx' ? 'SE' : 'BGM'}: ${basename(mu.path)}`;
  label.title = mu.path;
  body.appendChild(label);
  body.appendChild(inspField('タイムライン位置', `${fmt(mu.tlStart)}–${fmt(mu.tlStart + mu.duration)}`));
  inspDivider(body);
  body.appendChild(inspSlider('音量', {
    min: -40, max: 12, step: 1, value: mu.gain,
    format: (v) => `${v > 0 ? '+' : ''}${v}dB`,
    onCommit: async (v) => { await mutate({ op: 'music-update', id, gain: v }); },
  }));
  body.appendChild(inspSlider('フェードイン', {
    min: 0, max: 10, step: 0.5, value: mu.fadeIn,
    format: (v) => `${v.toFixed(1)}s`,
    onCommit: async (v) => { await mutate({ op: 'music-update', id, fadeIn: v }); },
  }));
  body.appendChild(inspSlider('フェードアウト', {
    min: 0, max: 10, step: 0.5, value: mu.fadeOut,
    format: (v) => `${v.toFixed(1)}s`,
    onCommit: async (v) => { await mutate({ op: 'music-update', id, fadeOut: v }); },
  }));
  const duckRow = document.createElement('label');
  duckRow.className = 'audioCheck';
  const duckCb = document.createElement('input');
  duckCb.type = 'checkbox';
  duckCb.checked = mu.duck;
  duckCb.onchange = async () => { await mutate({ op: 'music-update', id, duck: duckCb.checked }, { trigger: duckCb }); };
  duckRow.append(duckCb, ' 会話中は自動で下げる');
  body.appendChild(duckRow);
  inspDivider(body);
  body.appendChild(inspRemoveButton('削除', 'このBGM/SEを削除しますか？', async () => { await mutate({ op: 'music-remove', id }); }));
}

const INSPECTOR_BUILDERS = {
  clip: buildClipInspector,
  broll: buildBrollInspector,
  motion: buildMotionInspector,
  sprite: buildSpriteInspector,
  dialogue: buildDialogueInspector,
  music: buildMusicInspector,
};
const INSPECTOR_TITLE = { clip: 'クリップ', broll: 'B-roll', motion: 'モーション', sprite: 'キャラクター', dialogue: 'セリフ', music: 'BGM/SE' };

function renderInspector() {
  const view = $('inspectorView');
  const tabsView = $('tabsView');
  if (!S.selection) {
    view.hidden = true;
    tabsView.hidden = false;
    return;
  }
  tabsView.hidden = true;
  view.hidden = false;
  $('inspectorTitle').textContent = INSPECTOR_TITLE[S.selection.kind] ?? S.selection.kind;
  const body = $('inspectorBody');
  body.innerHTML = '';
  const builder = INSPECTOR_BUILDERS[S.selection.kind];
  if (builder) builder(body, S.selection.id);
  else deselect();
}

// ---------- W8 kit: caption style palette/font + sprite stage rendering ----------

// One shared <style> element carrying every @font-face rule registered so
// far this session (fonts are served from the kit via /media/kit/<relPath>,
// sandboxed to the kit root server-side — see serveKitMedia in daemon.ts).
// The family name is the font FILE's basename without extension — the SAME
// convention render.ts's toAss/kitAssStyle uses for the ASS Fontname, so the
// web preview and the burned-in captions resolve to visually the same font.
const kitFontFamilies = new Set();
function ensureKitFontFace(fontRelPath) {
  const family = fontRelPath.split('/').pop().replace(/\.[^.]+$/, '');
  if (!kitFontFamilies.has(family)) {
    kitFontFamilies.add(family);
    let styleEl = document.getElementById('kitFontFaces');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'kitFontFaces';
      document.head.appendChild(styleEl);
    }
    const url = `/media/kit/${fontRelPath.split('/').map(encodeURIComponent).join('/')}`;
    styleEl.appendChild(document.createTextNode(`@font-face { font-family: '${family}'; src: url('${url}'); }\n`));
  }
  return family;
}
function kitStyleFor(styleId) {
  return (S.kit?.kit?.styles ?? []).find((s) => s.id === styleId) ?? null;
}

// ---------- captions & motion overlays ----------
//
// W-CAP "NLE 内での字幕編集": a caption cue in the stage is clickable (opens
// the style popover: font/palette/size/outline/background), draggable
// (vertical position — see startCaptionDrag), and double-clickable (inline
// contenteditable text correction — see startCaptionTextEdit). Every commit
// goes through the same revision-checked mutate() path as everything else
// in this file; style-popover edits preview live by temporarily patching
// S.manifest.captions.overrides in place (no revision) until 適用/キャンセル.
function renderCaption(tl) {
  const layer = $('captionLayer');
  const styleId = S.manifest?.captions.style ?? 'clean';
  const kitStyle = kitStyleFor(styleId);
  if (kitStyle) {
    // Kit style: approximate the ASS palette/font as CSS custom properties
    // (see #captionLayer.style-kit in style.css) rather than a fixed named
    // class — kit style ids are arbitrary, unlike the built-in presets.
    layer.className = 'style-kit';
    const p = kitStyle.palette ?? {};
    layer.style.setProperty('--kit-text', p.text || '#fff');
    layer.style.setProperty('--kit-outline', p.outline || 'transparent');
    layer.style.setProperty('--kit-box', p.box || 'rgba(0,0,0,0.55)');
    const bgOpacity = kitStyle.caption?.background_opacity;
    layer.style.setProperty('--kit-box-opacity', bgOpacity != null ? String(bgOpacity) : '1');
    if (kitStyle.caption?.font) {
      layer.style.setProperty('--kit-font', `'${ensureKitFontFace(kitStyle.caption.font)}'`);
    } else {
      layer.style.removeProperty('--kit-font');
    }
  } else {
    layer.className = `style-${styleId}`;
  }
  const overrides = S.manifest?.captions.overrides;
  // Default 0.94 mirrors CaptionSettings.overrides.position's documented
  // default and export/render.ts's toAss MarginV formula exactly — see the
  // `bottom: calc((1 - var(--cap-position-v, 0.94)) * 100%)` rule in
  // style.css.
  layer.style.setProperty('--cap-position-v', String(overrides?.position?.v ?? 0.94));

  const cue = S.manifest?.captions.enabled ? S.cues.find((c) => tl >= c.tlStart && tl < c.tlEnd) : null;
  const text = cue ? cue.text : '';
  // Cache key includes the cue's key (not just its text) so a genuinely
  // different cue that happens to render the same text still gets a freshly
  // wired DOM element (fresh event handlers bound to the right cue object).
  const cacheKey = `${cue?.key ?? ''}:${text}`;
  if (layer.dataset.cur !== cacheKey) {
    layer.dataset.cur = cacheKey;
    layer.innerHTML = '';
    if (cue && text) layer.appendChild(buildCueEl(cue));
  }
  // Style overrides can change independently of text/key (live popover
  // preview, or just a plain style-only patch after undo/redo) — reapply to
  // whichever cue element currently exists every frame; cheap (a handful of
  // inline style writes), and skipped entirely while the user is mid text
  // edit so it never fights the contenteditable caret/selection.
  const cueEl = layer.querySelector('.cue');
  if (cueEl && !cueEl.isContentEditable) applyCueOverrideStyles(cueEl, overrides);
}

/** (Re)fill a cue <span>'s content: its text, plus the "✎修正済み" marker when a caption-text correction is active. Shared by buildCueEl and startCaptionTextEdit's cancel path so both stay in sync. */
function renderCueContent(span, cue) {
  span.textContent = cue.text;
  if (cue.originalText) {
    const mark = document.createElement('span');
    mark.className = 'cueEditedMark';
    mark.textContent = '✎修正済み';
    mark.title = `元のテキスト: ${cue.originalText}`;
    span.appendChild(mark);
  }
}

function buildCueEl(cue) {
  const span = document.createElement('span');
  span.className = 'cue';
  renderCueContent(span, cue);
  span.dataset.key = cue.key ?? '';
  span.tabIndex = 0;
  span.setAttribute('role', 'button');
  span.setAttribute('aria-label', '字幕: クリックでスタイル編集、ドラッグで縦位置変更、ダブルクリックでテキスト修正');
  span.addEventListener('pointerdown', (e) => startCaptionDrag(e, cue, span));
  span.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    clearTimeout(cueClickTimer);
    cueClickTimer = null;
    startCaptionTextEdit(cue, span);
  });
  span.addEventListener('keydown', (e) => {
    // Guard against text-edit mode: this listener stays attached for the
    // element's whole lifetime, including while startCaptionTextEdit has
    // made it contenteditable — without this check, typing a plain space
    // while correcting a cue's text would ALSO reopen the style popover
    // (addEventListener doesn't let an earlier listener's stopPropagation
    // suppress a later listener on the very same element).
    if (e.target.isContentEditable) return;
    // Scoped to this element — never reaches the document-level 1-letter
    // shortcut handler regardless (globalShortcutsBlocked already treats
    // [role="button"] as blocked), but stopPropagation keeps intent explicit.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openCaptionStylePopover(cue);
    }
  });
  return span;
}

/** Apply CaptionSettings.overrides as inline styles on a cue <span> — a JS mirror of applyCaptionOverrides in export/render.ts (see that function's doc for the field-by-field mapping); only fields actually set on `overrides` touch anything, so an override with just e.g. sizeScale never disturbs the active style's own colors. */
function applyCueOverrideStyles(cueEl, overrides) {
  cueEl.style.color = overrides?.palette?.text || '';
  cueEl.style.fontSize = overrides?.sizeScale != null ? `calc(clamp(14px, 2.6vw, 26px) * ${overrides.sizeScale})` : '';
  cueEl.style.webkitTextStroke =
    overrides?.outlineWidth != null || overrides?.palette?.outline
      ? `${overrides?.outlineWidth ?? 1}px ${overrides?.palette?.outline || 'transparent'}`
      : '';
  // Box background: set as an INLINE `background` (not a stylesheet class)
  // so it reliably wins over #captionLayer.style-kit .cue's own background
  // rule — an ID-selector rule beats a class-only one on specificity alone,
  // no matter the source order, so a class toggle here would silently lose
  // to the kit style's background when both are active at once.
  const hasBoxOverride = Boolean(overrides?.palette?.box) || overrides?.bgOpacity != null;
  if (hasBoxOverride) {
    cueEl.style.setProperty('--cap-box', overrides?.palette?.box || '#000000');
    cueEl.style.setProperty('--cap-box-opacity', overrides?.bgOpacity != null ? String(overrides.bgOpacity) : '0.55');
    cueEl.style.background = 'color-mix(in srgb, var(--cap-box) calc(var(--cap-box-opacity) * 100%), transparent)';
  } else {
    cueEl.style.removeProperty('--cap-box');
    cueEl.style.removeProperty('--cap-box-opacity');
    cueEl.style.background = '';
  }
  if (overrides?.font) {
    // overrides.font is either a kit font FILE name (with or without
    // extension) or a plain system family name (see CaptionSettings
    // .overrides.font's doc in types.ts) — match it against S.fontsList.kit
    // the same way export/render.ts's resolveKitFontFile does (extension-
    // insensitive) to decide whether it needs a @font-face registration.
    const base = overrides.font.replace(/\.[^./]+$/, '');
    const kitMatch = S.fontsList?.kit?.find((f) => f.name === overrides.font || f.name === base);
    cueEl.style.fontFamily = kitMatch ? `'${ensureKitFontFace(kitMatch.path)}'` : overrides.font;
  } else {
    cueEl.style.fontFamily = '';
  }
}

// ---- drag-to-reposition (vertical only) ----
// Mirrors the click-vs-drag threshold pattern used by startClipReorderDrag
// et al elsewhere in this file: a pointerdown that never moves past 4px is
// treated as a click (opens the style popover, after a short delay so a
// dblclick isn't misread as two single clicks — see cueClickTimer).
let cueClickTimer = null;
function startCaptionDrag(e, cue, cueEl) {
  if (cueEl.isContentEditable) return; // mid text-edit: let native caret/selection handle pointer events
  e.stopPropagation();
  const startY = e.clientY;
  const box = $('videoBox').getBoundingClientRect();
  const guide = $('captionDragGuide');
  let moved = false;

  const onMove = (ev) => {
    const dy = ev.clientY - startY;
    if (!moved && Math.abs(dy) < 4) return;
    if (!moved) {
      moved = true;
      S.timelineDrag = { kind: 'caption-position' };
      guide.hidden = false;
    }
    const v = Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height));
    $('captionLayer').style.setProperty('--cap-position-v', String(v));
    guide.style.top = `${v * 100}%`;
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    S.timelineDrag = null;
    guide.hidden = true;
    if (!moved) {
      clearTimeout(cueClickTimer);
      cueClickTimer = setTimeout(() => {
        cueClickTimer = null;
        openCaptionStylePopover(cue);
      }, 260); // dblclick threshold — canceled by buildCueEl's dblclick handler
      return;
    }
    const v = Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height));
    const { ok } = await mutate(
      { op: 'captions', patch: { overrides: { position: { v: Math.round(v * 100) / 100 } } } },
      { conflictMessage: '字幕の位置変更は反映されませんでした。最新状態を確認してもう一度実行してください' },
    );
    if (!ok) renderCaption(tlNow());
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

// ---- inline text edit (dblclick) ----
function startCaptionTextEdit(cue, span) {
  if (!cue.key) {
    toast('この字幕は編集できません(単語情報がありません)', { type: 'error' });
    return;
  }
  const original = cue.text;
  span.textContent = original; // drop the "✎修正済み" mark node while editing raw text
  span.contentEditable = 'true';
  span.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let finished = false;
  const cleanup = () => {
    span.contentEditable = 'false';
    span.removeEventListener('keydown', onKeydown);
    span.removeEventListener('blur', onBlur);
  };
  const commit = async () => {
    if (finished) return;
    finished = true;
    cleanup();
    const newText = span.textContent.trim();
    if (newText === original) {
      renderCueContent(span, cue); // no-op edit: just restore the ✎ mark, if any
      return;
    }
    await mutate(
      { op: 'caption-text', key: cue.key, text: newText },
      { conflictMessage: '字幕テキストの修正は反映されませんでした。最新状態を確認してもう一度実行してください' },
    );
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    cleanup();
    renderCueContent(span, cue);
  };
  const onKeydown = (e) => {
    e.stopPropagation(); // never let this reach the document-level 1-letter shortcut handler
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  const onBlur = () => commit();
  span.addEventListener('keydown', onKeydown);
  span.addEventListener('blur', onBlur);
}

// ---- style popover (click) ----
async function loadFontOptions(selectEl, currentValue) {
  let fonts = S.fontsList;
  if (!fonts) {
    fonts = await api('/api/fonts').catch(() => ({ kit: [], system: [] }));
    S.fontsList = fonts;
  }
  selectEl.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(既定のフォント)';
  selectEl.appendChild(none);
  if (fonts.kit?.length) {
    const g = document.createElement('optgroup');
    g.label = 'キット';
    for (const f of fonts.kit) {
      const opt = document.createElement('option');
      opt.value = f.name;
      opt.textContent = f.family && f.family !== f.name ? `${f.name} (${f.family})` : f.name;
      g.appendChild(opt);
    }
    selectEl.appendChild(g);
  }
  if (fonts.system?.length) {
    const g = document.createElement('optgroup');
    g.label = 'システム';
    for (const f of fonts.system) {
      const opt = document.createElement('option');
      opt.value = f.family;
      opt.textContent = f.family;
      g.appendChild(opt);
    }
    selectEl.appendChild(g);
  }
  selectEl.value = currentValue || '';
  // currentValue not among the listed options (e.g. set on another machine,
  // or the font was since removed) — keep it selectable instead of silently
  // discarding the setting when the popover just happens to open.
  if (currentValue && selectEl.value !== currentValue) {
    const opt = document.createElement('option');
    opt.value = currentValue;
    opt.textContent = `${currentValue} (未検出)`;
    selectEl.appendChild(opt);
    selectEl.value = currentValue;
  }
}

// W-UI IA v2 波2 §5: 4 built-in presets (see export/render.ts's
// ASS_STYLE_PRESETS — clean/bold/outline/boxed always exist there) plus any
// linked kit's own styles, which are equally valid captions.style ids (see
// kitStyleFor in renderCaption).
const CAPTION_STYLE_PRESETS = [['clean', 'クリーン'], ['bold', 'ボールド'], ['outline', 'アウトライン'], ['boxed', 'ボックス']];
function populateCaptionStylePresetSelect(selectEl, current) {
  selectEl.innerHTML = '';
  for (const [id, label] of CAPTION_STYLE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    selectEl.appendChild(opt);
  }
  const kitStyles = S.kit?.kit?.styles ?? [];
  if (kitStyles.length) {
    const g = document.createElement('optgroup');
    g.label = 'キット';
    for (const s of kitStyles) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label || s.id;
      g.appendChild(opt);
    }
    selectEl.appendChild(g);
  }
  selectEl.value = current || 'clean';
  if (selectEl.value !== current && current) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current}(未検出)`;
    selectEl.appendChild(opt);
    selectEl.value = current;
  }
}

function cloneCaptionOverrides(o) {
  if (!o) return {};
  const clone = { ...o };
  if (o.palette) clone.palette = { ...o.palette };
  if (o.position) clone.position = { ...o.position };
  return clone;
}

let captionPopoverInvoker = null;
let captionOverridesOriginal; // S.manifest.captions.overrides as of dialog-open, restored on cancel
let captionOverridesDraft = {};
let captionResetRequested = false;
let captionApplied = false;

function previewCaptionOverrides() {
  S.manifest.captions.overrides = captionResetRequested ? undefined : captionOverridesDraft;
  renderCaption(tlNow());
}

function syncCaptionPopoverControls() {
  // W-UI IA v2 波2 §5: enabled/style/maxChars are plain project settings
  // (captions.enabled/.style/.maxChars), not part of the overrides draft —
  // they always reflect S.manifest.captions directly and commit immediately
  // on change (see the 3 onchange handlers below), independent of this
  // dialog's 適用/キャンセル flow for the overrides fields.
  $('capEnabledToggle').checked = Boolean(S.manifest.captions.enabled);
  populateCaptionStylePresetSelect($('capStylePreset'), S.manifest.captions.style);
  $('capMaxChars').value = String(S.manifest.captions.maxChars ?? 24);
  const d = captionOverridesDraft;
  loadFontOptions($('capFont'), d.font);
  $('capTextColor').value = d.palette?.text || '#ffffff';
  $('capOutlineColor').value = d.palette?.outline || '#000000';
  $('capBoxColor').value = d.palette?.box || '#000000';
  const sizeScale = d.sizeScale ?? 1;
  $('capSizeScale').value = String(sizeScale);
  $('capSizeScaleVal').textContent = `${sizeScale.toFixed(2)}x`;
  const outlineWidth = d.outlineWidth ?? 3;
  $('capOutlineWidth').value = String(outlineWidth);
  $('capOutlineWidthVal').textContent = `${outlineWidth}px`;
  const bgOpacity = d.bgOpacity ?? 0.55;
  $('capBgOpacity').value = String(bgOpacity);
  $('capBgOpacityVal').textContent = `${Math.round(bgOpacity * 100)}%`;
}

function openCaptionStylePopover(cue) {
  const dlg = $('captionStyleDialog');
  if (dlg.open) return;
  captionOverridesOriginal = S.manifest.captions.overrides;
  captionOverridesDraft = cloneCaptionOverrides(captionOverridesOriginal);
  captionResetRequested = false;
  captionApplied = false;
  captionPopoverInvoker = document.activeElement;
  syncCaptionPopoverControls();
  dlg.showModal();
}
function closeCaptionStylePopover() {
  const dlg = $('captionStyleDialog');
  if (dlg.open) dlg.close();
}
$('capFont').onchange = (e) => {
  captionResetRequested = false;
  if (e.target.value) captionOverridesDraft.font = e.target.value;
  else delete captionOverridesDraft.font;
  previewCaptionOverrides();
};
function wireCapColorInput(id, field) {
  $(id).oninput = (e) => {
    captionResetRequested = false;
    captionOverridesDraft.palette = { ...captionOverridesDraft.palette, [field]: e.target.value };
    previewCaptionOverrides();
  };
}
wireCapColorInput('capTextColor', 'text');
wireCapColorInput('capOutlineColor', 'outline');
wireCapColorInput('capBoxColor', 'box');
// W-UI IA v2 波2 §5: enabled/style/maxChars commit immediately (project
// settings, not part of the overrides draft/適用/キャンセル flow) — the
// dialog stays open so the effect (cue reappearing, style/width changing)
// is visible right away, same live-update pattern the rest of the app uses.
$('capEnabledToggle').onchange = async (e) => {
  await mutate(
    { op: 'captions', patch: { enabled: e.target.checked } },
    { conflictMessage: '字幕の表示切り替えは反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
$('capStylePreset').onchange = async (e) => {
  await mutate(
    { op: 'captions', patch: { style: e.target.value } },
    { conflictMessage: '字幕プリセットの変更は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
$('capMaxChars').onchange = async (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || v < 1) { syncCaptionPopoverControls(); return; }
  await mutate(
    { op: 'captions', patch: { maxChars: Math.round(v) } },
    { conflictMessage: '1行の最大文字数の変更は反映されませんでした。最新状態を確認してもう一度実行してください', trigger: e.target },
  );
};
$('capSizeScale').oninput = (e) => {
  captionResetRequested = false;
  captionOverridesDraft.sizeScale = Number(e.target.value);
  $('capSizeScaleVal').textContent = `${captionOverridesDraft.sizeScale.toFixed(2)}x`;
  previewCaptionOverrides();
};
$('capOutlineWidth').oninput = (e) => {
  captionResetRequested = false;
  captionOverridesDraft.outlineWidth = Number(e.target.value);
  $('capOutlineWidthVal').textContent = `${captionOverridesDraft.outlineWidth}px`;
  previewCaptionOverrides();
};
$('capBgOpacity').oninput = (e) => {
  captionResetRequested = false;
  captionOverridesDraft.bgOpacity = Number(e.target.value);
  $('capBgOpacityVal').textContent = `${Math.round(captionOverridesDraft.bgOpacity * 100)}%`;
  previewCaptionOverrides();
};
$('capResetBtn').onclick = () => {
  captionResetRequested = true;
  captionOverridesDraft = {};
  syncCaptionPopoverControls();
  previewCaptionOverrides();
};
$('capCancelBtn').onclick = () => closeCaptionStylePopover();
$('capApplyBtn').onclick = async () => {
  // Nothing actually changed (opened, looked, closed without touching
  // anything) — skip the round trip / no-op revision entirely.
  if (!captionResetRequested && Object.keys(captionOverridesDraft).length === 0) {
    closeCaptionStylePopover();
    return;
  }
  captionApplied = true;
  const patchOverrides = captionResetRequested ? null : captionOverridesDraft;
  closeCaptionStylePopover();
  await mutate(
    { op: 'captions', patch: { overrides: patchOverrides } },
    { conflictMessage: '字幕スタイルの変更は反映されませんでした。最新状態を確認してもう一度実行してください' },
  );
};
$('captionStyleDialog').addEventListener('click', (e) => {
  if (e.target === $('captionStyleDialog')) closeCaptionStylePopover();
});
$('captionStyleDialog').addEventListener('close', () => {
  if (!captionApplied) {
    // Esc, backdrop click, or キャンセル — revert the live preview back to
    // whatever was actually saved (mutate() on 適用 already reloads, so this
    // branch only ever needs to undo a NOT-applied draft).
    S.manifest.captions.overrides = captionOverridesOriginal;
    renderCaption(tlNow());
  }
  captionPopoverInvoker?.focus?.();
  captionPopoverInvoker = null;
});

// Absolute-positioned <img> per resolved (non-orphan) sprite active at `tl`
// — a JS port of ops.ts's spriteGeometry (pure math kept in sync by hand;
// see that function's doc for the placement rationale). Orphans are simply
// excluded, same as render/OTIO. Positions are expressed as % of the
// videoBox so they track reframe/letterboxing the same way captionLayer
// does (both are children of #videoBox, sized to the OUTPUT aspect).
function spriteGeometryJS(asset, position, scale, outputWH, flip) {
  const bounds = asset.visible_bounds_normalized ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const anchor = asset.ground_anchor_normalized ?? { x: 0.5, y: 1 };
  const aspect = asset.width && asset.height ? asset.width / asset.height : 1;
  const visibleHeightFrac = Math.max(1e-6, bounds.y1 - bounds.y0);
  const displayHeight = Math.max(0, scale) * outputWH.height;
  const fullHeight = displayHeight / visibleHeightFrac;
  const fullWidth = fullHeight * aspect;
  const anchorXFrac = flip ? 1 - anchor.x : anchor.x;
  const anchorX = position.x * outputWH.width;
  const anchorY = position.y * outputWH.height;
  const x = anchorX - anchorXFrac * fullWidth;
  const y = anchorY - anchor.y * fullHeight;
  return { x, y, width: fullWidth, height: fullHeight, anchorX, anchorY };
}

// W-ANIME: per-frame NUMERIC port of ops.ts's spriteMotionPlan (enterTerms/
// exitTerms/loopTerms) — pure math kept in sync by hand (same duplication
// convention as spriteGeometryJS above). Unlike the render pipeline (which
// builds ffmpeg expression STRINGS evaluated once by ffmpeg), the browser
// just recomputes this every rendered frame directly in JS — simpler than
// generating CSS @keyframes, and exactly as accurate to the same formulas.
// Constants (transition duration, loop amplitudes, breathe amplitude) MUST
// stay numerically identical to ops.ts's SPRITE_TRANSITION_SECONDS /
// SPRITE_BREATHE_AMPLITUDE / the sway/bob/hop literals for timing to match
// per the spec's "タイミングのみ一致保証" contract.
const SPRITE_TRANSITION_SECONDS = 0.35;
const SPRITE_BREATHE_AMPLITUDE = 0.012;
function spriteMotionOffsetJS(motion, tl, tlStart, tlEnd, geo) {
  let dx = 0, dy = 0, alpha = 1, scaleMul = 1;
  const D = SPRITE_TRANSITION_SECONDS;
  const ramp = (t, t0) => Math.min(1, Math.max(0, (t - t0) / D));
  const travelX = geo.width * 0.6;
  const travelY = geo.height * 0.5;
  const bounceY = geo.height * 0.05;
  if (motion?.enter && tl < tlStart + D) {
    const p = ramp(tl, tlStart);
    if (motion.enter === 'slide-left') dx += travelX * (1 - p);
    else if (motion.enter === 'slide-right') dx -= travelX * (1 - p);
    else if (motion.enter === 'hop-in') dy += travelY * (1 - p) * (1 - p);
    else if (motion.enter === 'pop') { dy -= bounceY * Math.sin(Math.PI * p); alpha *= p; }
    else if (motion.enter === 'fade') alpha *= p;
  }
  if (motion?.exit && tl > tlEnd - D) {
    const p = ramp(tl, tlEnd - D);
    if (motion.exit === 'slide-left') dx -= travelX * p;
    else if (motion.exit === 'slide-right') dx += travelX * p;
    else if (motion.exit === 'hop-in') dy += travelY * p * p;
    else if (motion.exit === 'pop') { dy -= bounceY * Math.sin(Math.PI * (1 - p)); alpha *= (1 - p); }
    else if (motion.exit === 'fade') alpha *= (1 - p);
  }
  if (motion?.loop && motion.loop !== 'none') {
    const lt = tl - tlStart;
    if (motion.loop === 'sway') dx += 8 * Math.sin((2 * Math.PI * lt) / 3);
    else if (motion.loop === 'bob') dy += 6 * Math.sin((2 * Math.PI * lt) / 2.4);
    else if (motion.loop === 'hop') dy -= 10 * Math.abs(Math.sin((2 * Math.PI * lt) / 1));
    else if (motion.loop === 'breathe') scaleMul = 1 + SPRITE_BREATHE_AMPLITUDE * Math.sin((2 * Math.PI * lt) / 2);
  }
  return { dx, dy, alpha: Math.max(0, Math.min(1, alpha)), scaleMul };
}

// W-ANIME: which of a sprite's asset images is showing at sprite-local time
// `tl - tlStart` — a JS port of ops.ts's emoteWindows (last emoteAt entry
// with t <= localT wins; no emoteAt at all just returns the base assetId).
function activeSpriteAssetId(sp, tl, tlStart) {
  const emoteAt = sp.motion?.emoteAt;
  if (!emoteAt || emoteAt.length === 0) return sp.assetId;
  const localT = tl - tlStart;
  const sorted = [...emoteAt]
    .filter((e) => Number.isFinite(e.t) && e.t >= 0 && e.t < sp.duration)
    .sort((a, b) => a.t - b.t);
  let active = sp.assetId;
  for (const e of sorted) {
    if (e.t <= localT) active = e.assetId;
    else break;
  }
  return active;
}

function renderSprites(tl) {
  const layer = $('spriteLayer');
  if (!layer) return;
  const active = S.sprites.filter((r) => r.tlStart != null && tl >= r.tlStart && tl < r.tlStart + r.sprite.duration);
  const key = active.map((r) => r.sprite.id).join(',');
  const assets = S.kit?.kit?.assets ?? [];
  if (layer.dataset.cur !== key) {
    layer.dataset.cur = key;
    layer.innerHTML = '';
    layer._entries = [];
    for (const r of active) {
      const img = document.createElement('img');
      img.className = 'spriteImg';
      img.alt = '';
      layer.appendChild(img);
      layer._entries.push({ img, r, curAssetId: null });
    }
  }
  const entries = layer._entries ?? [];
  if (entries.length === 0) return;
  const out = S.manifest?.output ?? { width: S.manifest?.width ?? 1920, height: S.manifest?.height ?? 1080 };
  for (const entry of entries) {
    const sp = entry.r.sprite;
    const tlStart = entry.r.tlStart;
    const tlEnd = tlStart + sp.duration;
    // W-ANIME "表情差分": which asset shows can change mid-sprite (emoteAt).
    const assetId = activeSpriteAssetId(sp, tl, tlStart);
    const asset = assets.find((a) => a.id === assetId);
    if (!asset) continue;
    if (entry.curAssetId !== assetId) {
      entry.curAssetId = assetId;
      entry.img.src = `/media/kit/${asset.path.split('/').map(encodeURIComponent).join('/')}`;
    }
    const geo = spriteGeometryJS(asset, sp.position, sp.scale, out, sp.flip);
    const off = spriteMotionOffsetJS(sp.motion, tl, tlStart, tlEnd, geo);
    const w = geo.width * off.scaleMul;
    const h = geo.height * off.scaleMul;
    let x, y;
    if (sp.motion?.loop === 'breathe') {
      // Keep the anchor point (feet) fixed as the sprite "breathes" — same
      // fraction-of-box compensation as ops.ts's spriteMotionPlan.
      const fracX = geo.width > 0 ? (geo.anchorX - geo.x) / geo.width : 0.5;
      const fracY = geo.height > 0 ? (geo.anchorY - geo.y) / geo.height : 1;
      x = geo.anchorX - fracX * w + off.dx;
      y = geo.anchorY - fracY * h + off.dy;
    } else {
      x = geo.x + off.dx;
      y = geo.y + off.dy;
    }
    entry.img.style.left = `${(x / out.width) * 100}%`;
    entry.img.style.top = `${(y / out.height) * 100}%`;
    entry.img.style.width = `${(w / out.width) * 100}%`;
    entry.img.style.height = `${(h / out.height) * 100}%`;
    entry.img.style.opacity = String(sp.opacity * off.alpha);
    entry.img.style.transform = sp.flip ? 'scaleX(-1)' : '';
  }
}

// ---------- W-ANIME: composition background/ambient + dialogue speech bubbles ----------

function renderCompositionBackground(tl) {
  const layer = $('compBgLayer');
  if (!layer) return;
  const iv =
    S.backgroundIntervals.find((v) => tl >= v.t0 && tl < v.t1) ?? S.backgroundIntervals[S.backgroundIntervals.length - 1];
  const ambient = (S.kit?.kit?.assets ?? []).find((a) => a.type === 'ambient');
  const key = `${iv ? `${iv.t0}:${JSON.stringify(iv.ref)}` : 'none'}|${ambient?.id ?? ''}`;
  if (layer.dataset.cur === key) return;
  layer.dataset.cur = key;
  layer.innerHTML = '';
  layer.style.background = '';
  const kitMediaUrl = (relPath) => `/media/kit/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  if (iv) {
    const ref = iv.ref;
    if (ref.type === 'color') {
      layer.style.background = ref.hex;
    } else if (ref.type === 'asset') {
      const asset = (S.kit?.kit?.assets ?? []).find((a) => a.id === ref.assetId);
      if (asset) {
        const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(asset.path);
        const el = document.createElement(isVideo ? 'video' : 'img');
        el.className = 'compBgMedia';
        el.src = kitMediaUrl(asset.path);
        if (isVideo) { el.loop = true; el.autoplay = true; el.muted = true; el.playsInline = true; }
        else el.alt = '';
        layer.appendChild(el);
      } else {
        layer.style.background = '#000';
      }
    } else {
      // type 'video' (arbitrary absolute file path): not yet previewable in
      // the web UI — see the W-ANIME implementation report. The RENDER
      // pipeline (buildCompositionFilterGraph) plays it correctly either way.
      const ph = document.createElement('div');
      ph.className = 'compBgPlaceholder';
      ph.textContent = '🎥 動画背景(プレビュー未対応・レンダーには反映されます)';
      layer.appendChild(ph);
    }
  }
  if (ambient) {
    const v = document.createElement('video');
    v.className = 'compAmbientMedia';
    v.src = kitMediaUrl(ambient.path);
    v.loop = true;
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    layer.appendChild(v);
  }
}

// A JS port of kit.ts's deriveSpeechBubbleStyle (pure, kept in sync by hand).
function deriveSpeechBubbleStyleJS(style) {
  const DEFAULT = { palette: { text: '#111111', outline: '#111111', box: '#ffffff', accent: '#ff6b81' }, cornerRadiusFrac: 0.28 };
  if (!style) return DEFAULT;
  const palette = style.palette ?? {};
  const outlineWidth = style.caption?.outline_width ?? style.title?.outline_width ?? 3;
  return {
    palette: {
      text: palette.text ?? DEFAULT.palette.text,
      outline: palette.outline ?? DEFAULT.palette.outline,
      box: palette.box ?? DEFAULT.palette.box,
      accent: palette.accent ?? DEFAULT.palette.accent,
    },
    cornerRadiusFrac: Math.max(0.16, Math.min(0.4, 0.2 + outlineWidth * 0.02)),
  };
}
// A JS port of kit.ts's speechBubbleTailDirection.
function speechBubbleTailDirectionJS(bubblePos, spritePos) {
  const dx = spritePos.x - bubblePos.x;
  const dy = spritePos.y - bubblePos.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? 'bottom' : 'top';
  return dx >= 0 ? 'right' : 'left';
}
// A JS port of render.ts's dialogueAnchorPixels.
function dialogueAnchorPx(d, out) {
  const sprite = d.spriteId ? (S.manifest.timeline.sprites ?? []).find((s) => s.id === d.spriteId) : undefined;
  const asset = sprite ? (S.kit?.kit?.assets ?? []).find((a) => a.id === sprite.assetId) : undefined;
  if (sprite && asset) {
    const geo = spriteGeometryJS(asset, sprite.position, sprite.scale, out, sprite.flip);
    // geo.y is the FULL image top (transparent headroom included) — anchor
    // off the visible top like render.ts, or the bubble floats too high.
    const visibleTop = geo.y + (asset.visible_bounds_normalized?.y0 ?? 0) * geo.height;
    return { x: geo.anchorX, y: Math.max(out.height * 0.08, visibleTop - out.height * 0.04), sprite };
  }
  return { x: out.width / 2, y: out.height * 0.15, sprite: undefined };
}
function renderDialogueBubbles(tl) {
  const layer = $('dialogueLayer');
  if (!layer) return;
  const active = (S.dialogue ?? []).filter((d) => tl >= d.tlStart && tl < d.tlStart + d.duration);
  const key = active.map((d) => d.id).join(',');
  if (layer.dataset.cur === key) return;
  layer.dataset.cur = key;
  layer.innerHTML = '';
  if (active.length === 0) return;
  const out = S.manifest?.output ?? { width: S.manifest?.width ?? 1920, height: S.manifest?.height ?? 1080 };
  const style = S.speechBubbleStyle ?? deriveSpeechBubbleStyleJS(null);
  for (const d of active) {
    const { x, y, sprite } = dialogueAnchorPx(d, out);
    const bubble = document.createElement('div');
    bubble.className = 'dialogueBubble';
    bubble.style.left = `${(x / out.width) * 100}%`;
    bubble.style.top = `${(y / out.height) * 100}%`;
    bubble.style.color = style.palette.text;
    bubble.style.borderColor = style.palette.outline;
    bubble.style.background = style.palette.box;
    bubble.style.borderRadius = `${Math.round(style.cornerRadiusFrac * 100)}%`;
    bubble.textContent = d.text;
    if (sprite) {
      const dir = speechBubbleTailDirectionJS({ x: x / out.width, y: y / out.height }, sprite.position);
      bubble.classList.add(`tail-${dir}`);
    }
    layer.appendChild(bubble);
  }
}
function renderMotion(tl) {
  const layer = $('motionLayer');
  const active = (S.manifest?.timeline.motion ?? []).filter((m) => tl >= m.tlStart && tl < m.tlStart + m.duration);
  const key = active.map((m) => m.id).join(',');
  if (layer.dataset.cur === key) return;
  layer.dataset.cur = key;
  layer.innerHTML = '';
  for (const mo of active) {
    const spec = S.motionSpecs?.[mo.id];
    if (!spec) continue;
    layer.appendChild(motionNode(spec));
  }
}
function motionNode(spec) {
  const d = document.createElement('div');
  const p = spec.params || {};
  if (spec.type === 'custom-html' && spec.html) {
    d.innerHTML = spec.html; // local-only project data
    return d;
  }
  d.className = `mo-${spec.type}`;
  if (spec.type === 'chapter-card') {
    d.innerHTML = `<h1>${esc(p.text ?? '')}</h1><div class="bar"></div>${p.subtitle ? `<p>${esc(p.subtitle)}</p>` : ''}`;
  } else if (spec.type === 'lower-third') {
    d.innerHTML = `<h1>${esc(p.text ?? '')}</h1>${p.subtitle ? `<p>${esc(p.subtitle)}</p>` : ''}`;
  } else {
    d.textContent = p.text ?? '';
  }
  if (p.palette) d.style.setProperty('--accent', p.palette);
  return d;
}
async function loadMotionSpecs() {
  S.motionSpecs = {};
  for (const mo of S.manifest.timeline.motion) {
    try { S.motionSpecs[mo.id] = await api(`/api/motion/${mo.id}`); } catch { /* ignore */ }
  }
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- transcript panel ----------
function keptSet(sourceId) {
  const kept = new Set();
  const words = S.transcripts.get(sourceId) ?? [];
  const segs = S.segments.filter((s) => s.sourceId === sourceId);
  for (const w of words) {
    const mid = (w.t0 + w.t1) / 2;
    if (segs.some((s) => mid >= s.srcStart && mid < s.srcStart + (s.tlEnd - s.tlStart))) kept.add(w.id);
  }
  return kept;
}

// "sourceId:wordId" -> rejected candidate (for the non-destructive "ignored"
// overlay: a rejected cut candidate stays visible, struck through faintly,
// rather than disappearing without a trace).
function rejectedWordMap() {
  const m = new Map();
  for (const c of S.candidatesAll) {
    if (c.status !== 'rejected') continue;
    for (const id of c.wordIds ?? []) m.set(`${c.sourceId}:${id}`, c);
  }
  return m;
}

// W-UI IA v2 §5b: 素材ごとの文字起こし状況 — 未実行/処理中/完了の3状態。
const TRANSCRIBE_STATUS_LABEL = { done: '完了', processing: '処理中', pending: '未実行' };
function sourceTranscribeStatus(src) {
  if (src.transcribed) return 'done';
  if (S.transcribing.has(src.id)) return 'processing';
  return 'pending';
}
/**
 * Punch-list follow-up: the empty/partial states used to only ever tell the
 * user to ask Claude — there was no in-UI way to actually start a transcribe
 * job, so a D&D-ingested source with nobody around to ask Claude would sit
 * un-transcribed forever. POSTs /api/transcribe (daemon.ts, async job —
 * progress arrives over the same WS transcribe-progress/-done/-error
 * messages connectWs already listens for) for this one source. Optimistic
 * S.transcribing add + re-render so the row flips to "処理中" immediately,
 * not just whenever the first WS progress message happens to land.
 */
async function startTranscribe(sourceId) {
  try {
    const r = await api('/api/transcribe', { method: 'POST', body: JSON.stringify({ sourceId }) });
    if (r.started?.includes(sourceId)) {
      S.transcribing.add(sourceId);
      renderTranscript();
      renderMediaPanel();
    }
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}
// One source's 未実行/処理中/完了 row — 未実行 sources (with audio) get a
// button that starts that source's transcribe job directly, so "ask Claude"
// is a suggestion, not the only path (W-UI IA v2 §5b follow-up).
function transcribeStatusRow(src) {
  const status = sourceTranscribeStatus(src);
  const row = document.createElement('div');
  row.className = 'transcribeStatusRow';
  const label = document.createElement('span');
  label.textContent = `${basename(src.path)}: ${TRANSCRIBE_STATUS_LABEL[status]}`;
  row.appendChild(label);
  if (status === 'pending') {
    if (src.hasAudio) {
      const btn = document.createElement('button');
      btn.className = 'btn-transcribeSource';
      btn.textContent = 'この素材を文字起こし';
      btn.setAttribute('aria-label', `${basename(src.path)} を文字起こし`);
      btn.onclick = () => startTranscribe(src.id);
      row.appendChild(btn);
    } else {
      const note = document.createElement('span');
      note.className = 'hintText';
      note.textContent = '(音声なし)';
      row.appendChild(note);
    }
  }
  return row;
}
/**
 * W-LAZY empty state: transcription is no longer an ingest-time default, so
 * "no source has a transcript yet" is now a normal, expected state (not just
 * a brief moment right after ingest) — tell the user how to get one instead
 * of silently rendering nothing. Lists every source's own 未実行/処理中/完了
 * status (W-UI IA v2 §5b) rather than one aggregate line, with a per-source
 * start button, and never surfaces the CLI form (`vedit transcribe ...`) —
 * asking Claude is offered as an alternative, not the only path (W-UI IA v2
 * §6).
 */
function renderTranscriptEmptyState(el) {
  const list = document.createElement('div');
  list.className = 'hintText transcribeStatusList';
  for (const src of S.manifest.sources) list.appendChild(transcribeStatusRow(src));
  el.appendChild(list);
  const msg = document.createElement('div');
  msg.className = 'hintText';
  msg.style.padding = '8px';
  msg.textContent = S.transcribing.size > 0
    ? '文字起こし中です — 完了までお待ちください'
    : '文字起こしは任意です(字幕づくりやこのタブでの発言単位の編集に使います)。上のボタンで直接始めるか、Claude に「この素材を文字起こしして」と伝えてください';
  el.appendChild(msg);
}
function renderTranscript() {
  const el = $('words');
  el.innerHTML = '';
  if (!S.manifest.sources.some((src) => S.transcripts.has(src.id))) {
    renderTranscriptEmptyState(el);
    return;
  }
  const ignored = rejectedWordMap();
  // If the roving-tabindex stop points at a word that no longer exists
  // (e.g. it was just deleted), fall back to the first available word so the
  // listbox always has exactly one tabbable stop.
  if (S.focusKey) {
    const [fSrc, fId] = S.focusKey.split(':');
    if (!(S.transcripts.get(fSrc) ?? []).some((w) => w.id === fId)) S.focusKey = null;
  }
  for (const src of S.manifest.sources) {
    const words = S.transcripts.get(src.id);
    if (!words) continue;
    const heading = document.createElement('div');
    heading.className = 'srcHeading';
    heading.setAttribute('role', 'presentation');
    heading.textContent = `📄 ${sourceLabel(src)}`;
    heading.title = basename(src.path);
    el.appendChild(heading);
    const kept = keptSet(src.id);
    let prev = null;
    for (const w of words) {
      if (prev && w.t0 - prev.t1 >= 0.7) {
        const g = document.createElement('span');
        g.className = 'gap';
        g.setAttribute('role', 'presentation');
        g.textContent = `〔${(w.t0 - prev.t1).toFixed(1)}s〕`;
        el.appendChild(g);
      }
      const key = `${src.id}:${w.id}`;
      const cand = ignored.get(key);
      const selected = S.selWords.has(key);
      const shown = S.showWordKeys.has(key); // W-UI §0 "show words" highlight — separate from selection
      const s = document.createElement('span');
      s.className = 'w' + (kept.has(w.id) ? '' : ' cut') + (selected ? ' sel' : '') + (cand ? ' ignored' : '') + (shown ? ' shown' : '');
      s.textContent = w.text;
      s.dataset.id = w.id;
      s.dataset.src = src.id;
      s.setAttribute('role', 'option');
      s.setAttribute('aria-selected', String(selected));
      if (!S.focusKey) S.focusKey = key; // default roving-tabindex stop: first word
      s.tabIndex = key === S.focusKey ? 0 : -1;
      s.title = cand
        ? `「残す」を選択済み: ${humanizeCandidateLabel(cand.label, Math.max(0, cand.t1 - cand.t0))}(再検出で再提案されます)`
        : `${w.t0.toFixed(2)}–${w.t1.toFixed(2)}s`;
      el.appendChild(s);
      prev = w;
    }
  }
  // W-UI IA v2 §5b: some (not all) sources transcribed — a compact status
  // footer (with the same per-source start button as the full-empty state)
  // for the ones still pending/processing, so a partially-transcribed
  // project doesn't silently omit the sources it has nothing to show for.
  const notYet = S.manifest.sources.filter((src) => !S.transcripts.has(src.id));
  if (notYet.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'hintText';
    heading.style.padding = '8px 8px 0';
    heading.textContent = '未文字起こし:';
    el.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'hintText transcribeStatusList';
    for (const src of notYet) list.appendChild(transcribeStatusRow(src));
    el.appendChild(list);
  }
}

function wordTl(srcId, w) {
  const seg = S.segments.find((s) => s.sourceId === srcId && (w.t0 + w.t1) / 2 >= s.srcStart && (w.t0 + w.t1) / 2 < s.srcStart + (s.tlEnd - s.tlStart));
  if (!seg) return null;
  return seg.tlStart + (w.t0 + w.t1) / 2 - seg.srcStart;
}
function seekToWord(srcId, w) {
  const tl = wordTl(srcId, w);
  if (tl != null) seekTl(tl, { play: false });
}
function focusWordEl(srcId, id) {
  document.querySelector(`.w[data-src="${CSS.escape(srcId)}"][data-id="${CSS.escape(id)}"]`)?.focus();
}

// selection: pointerdown starts, drag extends, click seeks. Shift+click
// (without a drag) extends the range from the last anchor — the non-drag
// "click start, shift+click end" alternative. Selection is always
// single-source: extending into a different source is blocked with a toast.
let dragging = false;
$('words').addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.w');
  if (!t) return;
  S.showWordKeys.clear(); // a manual selection supersedes any "show words" highlight
  const srcId = t.dataset.src;
  const key = `${srcId}:${t.dataset.id}`;
  if (e.shiftKey && S.selAnchor) {
    const anchorSrc = S.selAnchor.split(':')[0];
    if (anchorSrc !== srcId) { toast('ソースをまたぐ選択はできません', { type: 'error' }); return; }
    const words = S.transcripts.get(srcId) ?? [];
    const ids = words.map((w) => `${srcId}:${w.id}`);
    const a = ids.indexOf(S.selAnchor);
    const b = ids.indexOf(key);
    if (a >= 0 && b >= 0) {
      S.selWords = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
      S.selSourceId = srcId;
    }
    S.focusKey = key;
    renderTranscript();
    updateSelBtn();
    // renderTranscript() rebuilds #words' DOM, so the element the mouse
    // actually clicked no longer exists — the browser's native "click
    // focuses this element" doesn't carry over. Re-focus the replacement so
    // a keyboard user can immediately continue with arrow keys.
    focusWordEl(srcId, t.dataset.id);
    return;
  }
  dragging = true;
  S.selAnchor = key;
  S.selSourceId = srcId;
  S.focusKey = key;
  S.selWords = new Set([key]);
  renderTranscript();
  updateSelBtn();
  focusWordEl(srcId, t.dataset.id);
});
$('words').addEventListener('pointerover', (e) => {
  if (!dragging) return;
  const t = e.target.closest('.w');
  if (!t) return;
  const srcId = t.dataset.src;
  if (srcId !== S.selSourceId) { toast('ソースをまたぐ選択はできません', { type: 'error' }); return; }
  const words = S.transcripts.get(srcId) ?? [];
  const ids = words.map((w) => `${srcId}:${w.id}`);
  const a = ids.indexOf(S.selAnchor);
  const b = ids.indexOf(`${srcId}:${t.dataset.id}`);
  if (a < 0 || b < 0) return;
  S.selWords = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  S.focusKey = `${srcId}:${t.dataset.id}`;
  renderTranscript();
  updateSelBtn();
  focusWordEl(srcId, t.dataset.id);
});
window.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (S.selWords.size === 1) {
    // treat as click: seek to word if it's on the timeline
    const key = [...S.selWords][0];
    const [srcId, id] = key.split(':');
    const w = (S.transcripts.get(srcId) ?? []).find((x) => x.id === id);
    if (w) seekToWord(srcId, w);
    S.selWords.clear();
    S.selSourceId = null;
    renderTranscript();
    focusWordEl(srcId, id);
  }
  updateSelBtn();
});

// ---------- transcript keyboard nav (WAI-ARIA listbox pattern) ----------
function toggleWordSelection(srcId, id) {
  if (S.selSourceId && S.selSourceId !== srcId && S.selWords.size) {
    toast('ソースをまたぐ選択はできません', { type: 'error' });
    return;
  }
  S.showWordKeys.clear();
  const key = `${srcId}:${id}`;
  if (S.selWords.has(key)) {
    S.selWords.delete(key);
    if (S.selWords.size === 0) S.selSourceId = null;
  } else {
    S.selWords.add(key);
    S.selSourceId = srcId;
    S.selAnchor = key;
  }
  S.focusKey = key;
  renderTranscript();
  updateSelBtn();
  focusWordEl(srcId, id); // renderTranscript() rebuilt the DOM; reclaim focus so Space/arrows keep working
}
// All words across all sources, in the same order they render in — used so
// plain (non-extending) arrow-key focus movement can cross a source
// boundary freely; only EXTENDING a selection (shift+arrow) is blocked at
// the boundary (mirrors the mouse-drag behavior in the pointerover handler).
function flattenedWords() {
  const out = [];
  for (const src of S.manifest.sources) {
    const words = S.transcripts.get(src.id);
    if (!words) continue;
    for (const w of words) out.push({ srcId: src.id, id: w.id, t0: w.t0, t1: w.t1 });
  }
  return out;
}
function moveWordFocus(flat, newIdx, extend) {
  if (newIdx < 0 || newIdx >= flat.length) return;
  const entry = flat[newIdx];
  const newKey = `${entry.srcId}:${entry.id}`;
  if (extend) {
    if (!S.selAnchor) S.selAnchor = S.focusKey ?? newKey;
    const anchorSrc = S.selAnchor.split(':')[0];
    if (anchorSrc !== entry.srcId) { toast('ソースをまたぐ選択はできません', { type: 'error' }); return; }
    const anchorIdx = flat.findIndex((w) => `${w.srcId}:${w.id}` === S.selAnchor);
    if (anchorIdx >= 0) {
      const lo = Math.min(anchorIdx, newIdx), hi = Math.max(anchorIdx, newIdx);
      S.selWords = new Set(flat.slice(lo, hi + 1).map((w) => `${w.srcId}:${w.id}`));
      S.selSourceId = entry.srcId;
    }
  }
  S.focusKey = newKey;
  renderTranscript();
  updateSelBtn();
  focusWordEl(entry.srcId, entry.id);
}
async function deleteSelectedWords() {
  if (S.selWords.size === 0) return;
  const srcId = S.selSourceId;
  const ids = [...S.selWords].map((k) => k.split(':')[1]);
  const { ok } = await mutate(
    { op: 'remove-words', ids, sourceId: srcId },
    { conflictMessage: '削除は適用されませんでした。最新状態を確認してもう一度実行してください', trigger: $('removeSelBtn') },
  );
  if (ok) {
    S.selWords.clear();
    S.selSourceId = null;
    updateSelBtn();
  }
  // on failure S.selWords/S.selSourceId are left intact so the user's
  // selection survives the re-render and they can just retry.
  // Either way, mutate()'s reload() rebuilt #words' DOM; reclaim focus onto
  // the current roving-tabindex stop so keyboard navigation can continue.
  if (S.focusKey) {
    const [fSrc, fId] = S.focusKey.split(':');
    focusWordEl(fSrc, fId);
  } else {
    $('transcriptPanel').focus();
  }
}
$('words').addEventListener('keydown', (e) => {
  const t = e.target.closest('.w');
  if (!t) return;
  const srcId = t.dataset.src;
  const flat = flattenedWords();
  const idx = flat.findIndex((w) => w.srcId === srcId && w.id === t.dataset.id);
  if (idx < 0) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault(); e.stopPropagation();
    moveWordFocus(flat, idx + 1, e.shiftKey);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    moveWordFocus(flat, idx - 1, e.shiftKey);
  } else if (e.code === 'Space') {
    e.preventDefault(); e.stopPropagation();
    toggleWordSelection(srcId, t.dataset.id);
  } else if (e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    seekToWord(srcId, flat[idx]);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault(); e.stopPropagation();
    deleteSelectedWords();
  }
});

function updateSelBtn() {
  const n = S.selWords.size;
  $('removeSelBtn').disabled = n < 1;
  $('removeSelBtn').textContent = n > 0 ? `選択を削除 (${n}語)` : '選択を削除';
  $('selStatus').textContent = n > 0 ? `${n}語選択中` : '選択解除';
}
$('removeSelBtn').onclick = deleteSelectedWords;

function highlightWord(tl) {
  const i = S.currentSeg;
  if (i < 0) return;
  const s = S.segments[i];
  const srcT = s.srcStart + (tl - s.tlStart);
  const words = S.transcripts.get(s.sourceId) ?? [];
  const w = words.find((x) => srcT >= x.t0 && srcT < x.t1);
  const key = w ? `${s.sourceId}:${w.id}` : null;
  if (S.activeWordKey === key) return;
  if (S.activeWordKey) {
    const [ps, pid] = S.activeWordKey.split(':');
    document.querySelector(`.w[data-src="${CSS.escape(ps)}"][data-id="${CSS.escape(pid)}"]`)?.classList.remove('active');
  }
  S.activeWordKey = key;
  if (key) document.querySelector(`.w[data-src="${CSS.escape(s.sourceId)}"][data-id="${CSS.escape(w.id)}"]`)?.classList.add('active');
}

// ---------- candidates ----------
const KIND_LABEL = { silence: '無音', filler: 'フィラー', retake: '言い直し', 'low-energy': '低テンション' };
const KIND_ORDER = ['silence', 'filler', 'retake', 'low-energy'];

// W9: QC categories (see export/qc.js's QcCategory) surfaced in the 確認
// inbox — every OTHER category (candidates/scene-review/overlay-orphan/
// sprite-orphan/color) already has its own dedicated inbox surface, so
// merging those too would double-count the same issue (see renderInbox).
// W-UI IA v2 波2 §7: kit-asset-missing added — previously invisible through
// every path (not one of the pre-existing dedicated surfaces either).
const QC_INBOX_CATEGORIES = new Set(['captions', 'source-missing', 'kit-duration', 'kit-asset-missing']);

// Map a candidate's (padded) source-time point to a timeline seconds value,
// clamped to the segment that currently contains its source range — used by
// both the row's seek-on-click and the "前後を再生" preview.
function candidateTl(t, c) {
  const seg = S.segments.find((s) => s.sourceId === c.sourceId && t >= s.srcStart - 2 && t <= s.srcStart + (s.tlEnd - s.tlStart) + 2);
  if (!seg) return null;
  const clamped = Math.max(seg.srcStart, Math.min(t, seg.srcStart + (seg.tlEnd - seg.tlStart)));
  return seg.tlStart + (clamped - seg.srcStart);
}

/**
 * detect.ts (src/core/detect.ts) emits candidate labels as English template
 * sentences ("0.6s silence after \"...\"", "filler \"...\"", etc.) — fine
 * for logs, not for a Japanese UI. This turns each known template into a
 * Japanese sentence that ALSO states what "cutting this saves" in words
 * (W-UI IA v2 §4: "-X.Xs の意味を文中に含める"), so the separate compact
 * duration chip (.dur, still shown for at-a-glance scanning of a long list)
 * is never the ONLY place that number's meaning is explained. Falls back to
 * the raw label, suffixed the same way, for any template this hasn't been
 * taught yet (e.g. a future retake/low-energy format).
 */
function humanizeCandidateLabel(label, dur) {
  const cutNote = `詰めると −${dur.toFixed(1)}秒`;
  let m;
  if ((m = /^([\d.]+)s silence after "(.*)"$/.exec(label))) {
    return `"${m[2]}"の後の無音 ${Number(m[1]).toFixed(1)}秒 — ${cutNote}`;
  }
  if ((m = /^([\d.]+)s leading silence$/.exec(label))) {
    return `冒頭の無音 ${Number(m[1]).toFixed(1)}秒 — ${cutNote}`;
  }
  if ((m = /^filler "(.*)"$/.exec(label))) {
    return `フィラー "${m[1]}" — ${cutNote}`;
  }
  if ((m = /^([\d.]+)s silence \(waveform(.*)\)$/.exec(label))) {
    const conflict = /transcript disagrees/.test(m[2]);
    return `無音 ${Number(m[1]).toFixed(1)}秒(波形検出)${conflict ? ' — 文字起こしと一致しません、確認してから決めてください' : ''} — ${cutNote}`;
  }
  return `${label} — ${cutNote}`;
}
function candRow(c) {
  const d = document.createElement('div');
  d.className = 'cand';
  d.tabIndex = 0;
  const dur = Math.max(0, c.t1 - c.t0);
  const label = humanizeCandidateLabel(c.label, dur);
  const src = S.manifest.sources.find((s) => s.id === c.sourceId);
  const srcName = sourceLabel(src);
  const srcTitle = src ? basename(src.path) : c.sourceId;
  const timeRange = `${fmt(c.t0)}–${fmt(c.t1)}`;
  // W-UI IA v2 §4: the humanized label is now a full sentence (kind name +
  // what/where + the cut-savings meaning of −X.X秒) — long enough that the
  // compact row's CSS ellipsis (.cand .lbl) can clip it, so a title tooltip
  // keeps the full sentence one hover away rather than only reachable via
  // aria-label or the candidate card.
  d.innerHTML = `<span class="kind ${c.kind}">${esc(KIND_LABEL[c.kind] ?? c.kind)}</span><span class="lbl" title="${esc(label)}">${esc(label)}</span><span class="srcTag" title="${esc(srcTitle)}">${esc(srcName)} ${timeRange}</span><span class="dur">−${dur.toFixed(1)}秒</span>`;
  d.setAttribute('aria-label', `${KIND_LABEL[c.kind] ?? c.kind}: ${label}(${srcName} ${timeRange})`);
  const seekHere = () => {
    const tl = candidateTl(c.t0, c);
    if (tl != null) seekTl(Math.max(0, Math.min(tl, S.duration - 0.1)), { play: false });
  };
  d.onclick = seekHere;
  d.onkeydown = (e) => {
    if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); seekHere(); }
  };
  const preview = document.createElement('button');
  preview.className = 'btn-preview';
  preview.textContent = '前後を再生';
  preview.title = '候補の1秒前から再生し、終端+1秒で自動停止';
  preview.setAttribute('aria-label', `${label} の前後を再生`);
  preview.onclick = (e) => {
    e.stopPropagation();
    const startTl = candidateTl(c.t0 - 1, c);
    const endTl = candidateTl(c.t1 + 1, c);
    if (startTl == null) return;
    S.previewStopAt = endTl;
    seekTl(startTl, { play: true });
    S.playing = true;
    setPlayBtnState(true);
  };
  const ok = document.createElement('button');
  ok.className = 'btn-approve';
  ok.textContent = 'カットする';
  ok.setAttribute('aria-label', `${label} をカットする`);
  ok.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'approve'); };
  const ng = document.createElement('button');
  ng.className = 'btn-reject';
  ng.textContent = '残す';
  ng.setAttribute('aria-label', `${label} を残す`);
  ng.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'reject'); };
  const actions = document.createElement('div');
  actions.className = 'candActions';
  actions.append(preview, ok, ng);
  d.append(actions);
  return d;
}

// ---------- inbox (W-UI IA v2 §2/§3: 確認タブ = 「Claude の編集提案」(pending candidates) + 「対応が必要」(アンカー切れ・色警告・聞き取り確認・QC) 2群) ----------
function lowConfidenceCounts() {
  const out = [];
  for (const src of S.manifest.sources) {
    const words = S.transcripts.get(src.id);
    if (!words) continue;
    const n = words.filter((w) => w.p < 0.4).length;
    if (n > 0) out.push({ sourceId: src.id, count: n });
  }
  return out;
}
function colorWarningSources() {
  return S.manifest.sources.filter((src) => {
    const converted = src.colorTransform && src.colorTransform.type && src.colorTransform.type !== 'none';
    return !converted && needsColorTransform(src.color);
  });
}
function inboxWarningRow(text, opts = {}) {
  const d = document.createElement('div');
  d.className = 'inboxWarn';
  // W-UI IA v2 波2 §8: an optional "Claude に頼む" chip alongside the
  // warning text (structural fixes — a color correction, a re-placement —
  // are conversation, not a UI control here).
  if (opts.askPrompt) {
    const line = document.createElement('div');
    line.textContent = text;
    d.appendChild(line);
    d.appendChild(askClaudeChip(opts.askPrompt));
  } else {
    d.textContent = text;
  }
  if (opts.title) d.title = opts.title; // internal id/detail, kept out of the visible text — see the anchor-orphan warnings below
  if (opts.onClick) {
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    d.onclick = opts.onClick;
    d.onkeydown = (e) => { if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); opts.onClick(); } };
  }
  return d;
}
// KIND_LABEL + "候補" (e.g. "無音候補") — the noun the group-header bulk
// button's result-explicit label uses (W-UI IA v2 §2: 「無音候補2件をカット
// (−2.4秒)」replaces the old static「まとめて承認」).
const KIND_CANDIDATE_NOUN = Object.fromEntries(Object.entries(KIND_LABEL).map(([k, v]) => [k, `${v}候補`]));
/**
 * Builds the "Claude の編集提案" group's content: one sub-group per
 * candidate kind (unchanged structure), OR — when there are zero pending
 * candidates — one of 4 distinguishable empty messages (W-UI IA v2 §5c).
 * The 4th state's distinction from the 1st is a best-effort approximation:
 * the daemon has no "has detection ever run" flag, so a fresh page load
 * that has never seen a completed /api/detect this session defaults to
 * "未検出" even if Claude ran `vedit detect` (found nothing) in an earlier
 * session — see S.detecting/S.detectRanEmpty's doc at the top of the file.
 */
function renderCandidatesGroup(el) {
  el.innerHTML = '';
  const candCount = S.candidates.length;
  $('detectSettings').hidden = candCount === 0;
  if (candCount === 0) {
    const msg = document.createElement('div');
    msg.className = 'hintText inboxEmpty';
    if (S.detecting) {
      msg.textContent = 'Claude が無音や言い直しを確認しています…';
    } else if (S.candidatesAll.length > 0) {
      msg.textContent = '✓ 提案はすべて確認済みです';
    } else if (S.detectRanEmpty) {
      msg.textContent = '無音や言い直しなどの編集提案は見つかりませんでした';
    } else {
      msg.textContent = '編集提案はまだ作られていません — Claude に「動画を編集して」のように伝えてください';
    }
    el.appendChild(msg);
    $('candidatesCount').textContent = '';
    return;
  }
  const byKind = new Map();
  for (const c of S.candidates) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind).push(c);
  }
  const kinds = [...byKind.keys()].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a), ib = KIND_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const kind of kinds) {
    const list = byKind.get(kind);
    const totalDur = list.reduce((sum, c) => sum + Math.max(0, c.t1 - c.t0), 0);
    const group = document.createElement('div');
    group.className = 'candGroup';
    const header = document.createElement('div');
    header.className = 'candGroupHeader';
    header.innerHTML = `<span class="kind ${kind}">${KIND_LABEL[kind] ?? kind}</span><span class="spacer"></span>`;
    // W-UI IA v2 §2: the group's ONE bulk action is a result-explicit label
    // ("無音候補2件をカット(−2.4秒)") instead of a plain "まとめて承認" —
    // what it does and what it's worth are both readable without a click.
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn-approve';
    approveBtn.textContent = `${KIND_CANDIDATE_NOUN[kind] ?? `${KIND_LABEL[kind] ?? kind}候補`}${list.length}件をカット(−${totalDur.toFixed(1)}秒)`;
    approveBtn.onclick = () => decide(list.map((c) => c.id), 'approve');
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-reject';
    rejectBtn.textContent = 'まとめて残す';
    rejectBtn.onclick = () => decide(list.map((c) => c.id), 'reject');
    header.append(approveBtn, rejectBtn);
    group.appendChild(header);
    for (const c of list) group.appendChild(candRow(c));
    el.appendChild(group);
  }
  const parts = kinds.map((k) => `${KIND_LABEL[k] ?? k}${byKind.get(k).length}`);
  $('candidatesCount').textContent = `${candCount}件(${parts.join('・')})`;
}
/**
 * Builds the "対応が必要" group: anchor-lost B-roll/sprites, color warnings,
 * low-confidence-transcript warnings, and the 3 QC categories not already
 * surfaced elsewhere (see QC_INBOX_CATEGORIES's doc). Returns the item count
 * so the caller can compute the tab badge total (candidates + this).
 */
function renderWarningsGroup(el) {
  el.innerHTML = '';
  let count = 0;
  const kindCounts = { anchor: 0, color: 0, transcript: 0, qc: 0 };

  // orphaned B-roll / sprites — display term "配置先を見失った" (W-UI IA v2
  // 用語表: アンカー切れ → 配置先を見失った B-roll/画像); "orphan"/anchor
  // stays in the CLI/API vocabulary only, never surfaced to the user.
  for (const r of S.overlays) {
    if (r.tlStart != null) continue;
    count++; kindCounts.anchor++;
    const ov = r.overlay;
    // Codex 統合レビュー P2-4: title に生の overlay id / sourceId を出していた
    // — 表示文にすでに素材別名(sourceDisplayName)が入っているので internal
    // id の title は不要、丸ごと削除。
    el.appendChild(inboxWarningRow(
      `⚠ 配置先を見失ったB-roll: ${sourceDisplayName(ov.sourceId)} — 元の位置(${sourceDisplayName(ov.anchor.sourceId)} ${ov.anchor.srcTime.toFixed(2)}秒)がカットで失われました。Claude に伝えて配置し直してください`,
    ));
  }
  for (const r of S.sprites) {
    if (r.tlStart != null) continue;
    count++; kindCounts.anchor++;
    const sp = r.sprite;
    el.appendChild(inboxWarningRow(
      `⚠ 配置先を見失ったキャラクター: ${sp.assetId} — 元の位置(${sourceDisplayName(sp.anchor.sourceId)} ${sp.anchor.srcTime.toFixed(2)}秒)がカットで失われました。Claude に伝えて配置し直してください`,
    ));
  }

  // color warnings
  for (const src of colorWarningSources()) {
    count++; kindCounts.color++;
    el.appendChild(inboxWarningRow(`⚠ 要色変換: ${sourceLabel(src)} — Log/HLG/PQ 素材のため浅い色で見えています。`, {
      title: basename(src.path),
      onClick: () => { activateTab($('tab-mediaPanel'), { focus: false }); setMediaFocus(src.id, { focus: false }); },
      askPrompt: `${sourceLabel(src)}の色を直して`,
    }));
  }

  // low-confidence transcript warnings
  for (const lc of lowConfidenceCounts()) {
    count++; kindCounts.transcript++;
    const src = S.manifest.sources.find((s) => s.id === lc.sourceId);
    const name = sourceLabel(src);
    el.appendChild(inboxWarningRow(`⚠ 聞き取りを確認したい箇所: ${name} に${lc.count}語(文字起こしタブの"?"付きを確認)`, {
      title: src ? basename(src.path) : lc.sourceId,
      onClick: () => activateTab($('tab-transcriptPanel'), { focus: false }),
    }));
  }

  // W9: QC-derived warnings (字幕重複/速すぎ・素材欠落・kit尺乖離) — see
  // QC_INBOX_CATEGORIES's doc above for why only these three categories.
  for (const issue of S.qc?.issues ?? []) {
    if (!QC_INBOX_CATEGORIES.has(issue.category)) continue;
    count++; kindCounts.qc++;
    el.appendChild(inboxWarningRow(`⚠ ${issue.message}`, {
      onClick: issue.category === 'captions' ? () => activateTab($('tab-transcriptPanel'), { focus: false }) : undefined,
    }));
  }

  const parts = [];
  if (kindCounts.anchor) parts.push(`配置切れ${kindCounts.anchor}`);
  if (kindCounts.color) parts.push(`要色変換${kindCounts.color}`);
  if (kindCounts.transcript) parts.push(`聞き取り確認${kindCounts.transcript}`);
  if (kindCounts.qc) parts.push(`QC${kindCounts.qc}`);
  $('warningsCount').textContent = count > 0 ? `${count}件(${parts.join('・')})` : '';
  $('warningsEmpty').hidden = count > 0;
  el.hidden = count === 0;
  return count;
}
// ---------- 波2.5: 「最後の書き出し」カード ----------
// GET /api/export-results is read-only (docs/product-bet-sensory-vs-
// structural.md: 構造系〔書き出し〕に必要なのは操作ではなく結果の可視化) —
// no export-trigger UI lives here, on purpose. `vedit export *` /
// `vedit publish-pack` (CLI-only) are what actually write a record; this
// just surfaces the latest one. Fetched on 確認 tab display + a light 30s
// poll while that tab stays active (see fetchExportResults' one caller at
// the bottom of this file and activateTab above) — NOT tied to reload()/WS,
// since exports don't go through mutate() and polling every commit would be
// wasted work for something this low-frequency.
const EXPORT_KIND_LABEL = {
  render: 'MP4書き出し',
  otio: 'OTIO(Resolve)',
  srt: 'SRT字幕',
  ass: 'ASS字幕',
  fcp7xml: 'FCP XML(Premiere)',
  'publish-pack': '公開パック',
};
async function fetchExportResults() {
  try {
    S.exportResults = await api('/api/export-results?n=1');
    S.exportResultsStale = false;
  } catch {
    // best-effort: keep whatever was last successfully fetched instead of
    // wiping the card (Codex 統合レビュー P2-6) — renderExportResultCard
    // appends a small "更新できませんでした" note when this flag is set.
    S.exportResultsStale = true;
  }
  renderExportResultCard();
}
function renderExportResultCard() {
  const el = $('exportResultCard');
  if (!el) return;
  const rec = S.exportResults[0];
  // レコード0件・プロジェクト空のいずれでも非表示(空状態の文言は出さない —
  // 波2.5 スコープの明示指定)。
  if (!rec || isProjectEmpty()) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'inboxHeading';
  heading.innerHTML = '<span>最後の書き出し</span>';
  el.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'exportResultRow' + (rec.ok ? '' : ' fail');
  const kindLabel = EXPORT_KIND_LABEL[rec.kind] ?? rec.kind;
  const fileName = basename(rec.file);
  const title = document.createElement('div');
  title.className = 'showCardLbl';
  title.textContent = `${rec.ok ? '✓' : '✕'} ${kindLabel}: ${fileName}`;
  title.title = rec.file;
  row.appendChild(title);

  const ts = new Date(rec.ts);
  const meta = document.createElement('div');
  meta.className = 'hintText';
  meta.textContent = `${Number.isNaN(ts.getTime()) ? rec.ts : ts.toLocaleString('ja-JP', { hour12: false })} · 版 ${rec.revision}`;
  row.appendChild(meta);

  if (!rec.ok && rec.error) {
    const err = document.createElement('div');
    err.className = 'hintText';
    err.textContent = `失敗理由: ${rec.error}`;
    row.appendChild(err);
  }

  // 字幕・セリフ焼き込み状況(render 以外の kind では両フィールドとも
  // undefined のまま — その場合は何も表示しない)。
  const burnBits = [];
  if (typeof rec.captionsBurned === 'boolean') {
    burnBits.push(rec.captionsBurned ? `字幕焼き込み済み(${rec.captionCueCount ?? 0}件)` : '字幕なし');
  }
  if (typeof rec.dialogueBurned === 'boolean') {
    burnBits.push(rec.dialogueBurned ? `セリフ焼き込み済み(${rec.dialogueCount ?? 0}件)` : 'セリフなし');
  }
  if (burnBits.length) {
    const b = document.createElement('div');
    b.className = 'hintText';
    b.textContent = burnBits.join(' · ');
    row.appendChild(b);
  }

  if (rec.warnings?.length) {
    for (const w of rec.warnings) {
      const li = document.createElement('div');
      li.className = 'hintText exportResultWarning';
      li.textContent = `⚠ ${w}`;
      row.appendChild(li);
    }
  }
  el.appendChild(row);

  // レコードの revision が現在の revision と食い違う = それ以降の編集が
  // まだ反映されていない古い版の書き出し(--tally, 警告専用トーン)。
  if (S.manifest && rec.revision !== S.manifest.revision) {
    el.appendChild(inboxWarningRow(
      '古い版の書き出しです — 最新の内容で書き出すには Claude に伝えてください',
      { askPrompt: 'MP4を書き出して' },
    ));
  }
  // Codex 統合レビュー P2-6: 直近の再取得(30秒ポーリング等)が失敗していても
  // カードは消さず、保持している最後の結果の下に小さく添えるだけに留める。
  if (S.exportResultsStale) {
    const stale = document.createElement('div');
    stale.className = 'hintText';
    stale.textContent = '更新できませんでした(表示は最後に取得できた結果です)';
    el.appendChild(stale);
  }
}
function renderInbox() {
  // W-UI IA v2 §5a: a brand-new (zero-source) project has nothing to review
  // yet — the whole 確認 tab collapses to one sentence instead of showing
  // two empty groups + detection controls that don't apply yet.
  const projectEmpty = isProjectEmpty();
  $('confirmEmptyProject').hidden = !projectEmpty;
  $('candidatesSection').hidden = projectEmpty;
  $('warningsSection').hidden = projectEmpty;
  // 波2.5: re-render from the already-fetched S.exportResults on every pass
  // (revision may have just changed via reload(), which flips the "古い版"
  // banner) — this does NOT re-fetch; see fetchExportResults for that.
  renderExportResultCard();
  const badge = $('inboxCount');
  if (projectEmpty) { badge.hidden = true; return; }

  renderCandidatesGroup($('inboxList'));
  const warnCount = renderWarningsGroup($('warningsList'));
  const total = S.candidates.length + warnCount;
  if (total > 0) { badge.hidden = false; badge.textContent = String(total); } else { badge.hidden = true; }
}

// ---------- detection threshold ----------
$('minGapRange').oninput = (e) => {
  S.detectMinGap = Number(e.target.value);
  $('minGapVal').textContent = `${S.detectMinGap.toFixed(1)}s`;
};
$('redetectBtn').onclick = async () => {
  S.detecting = true;
  renderInbox();
  try {
    await api('/api/detect', { method: 'POST', body: JSON.stringify({ minGap: S.detectMinGap }) });
    toast(`最短時間 ${S.detectMinGap.toFixed(1)}秒でこの条件の候補を作り直しました`);
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
  S.detecting = false;
  await reload().catch(() => {});
  // reload() re-fetches S.candidates — a completed run that still landed on
  // zero pending (and nothing in candidatesAll either) is the "問題なし" empty
  // state; see renderCandidatesGroup's doc for why this is session-local only.
  if (S.candidates.length === 0 && S.candidatesAll.length === 0) S.detectRanEmpty = true;
  renderInbox();
};

// Moves focus to the "next" candidate row after a decide()/reload() re-render
// (the decided rows disappear from the list), or to the panel itself if none
// remain — so keyboard/screen-reader users never lose their place.
function focusAfterCandidateDecision(anchorIdx) {
  const rows = [...document.querySelectorAll('#inboxList .cand')];
  if (rows.length === 0) { $('nowPanel').focus(); return; }
  const idx = Math.max(0, Math.min(anchorIdx, rows.length - 1));
  rows[idx].focus();
}
async function decide(ids, decision) {
  const idList = ids === 'all' ? S.candidates.map((c) => c.id) : ids;
  const lastId = idList[idList.length - 1];
  const anchorIdx = Math.max(0, S.candidates.findIndex((c) => c.id === lastId));
  try {
    await api('/api/candidates/decide', {
      method: 'POST',
      body: JSON.stringify({ ids, decision, actor: 'ui', baseRev: S.manifest.revision }),
    });
  } catch (e) {
    toast(e.status === 409 ? '他の編集と競合しました。最新状態を再読込します' : e.message, { type: 'error' });
  }
  await reload().catch(() => {});
  focusAfterCandidateDecision(anchorIdx);
  hideCandidateCard();
}

// ---------- activity feed / undo (W-UI IA v2 §1: 独立した「履歴」タブの中身 — 各エントリは "rev" を表示上「変更 #」と呼ぶ。CLI/API の語彙(rev/r12)はそのまま) ----------
const ACTOR_LABEL = { claude: 'Claude', ui: 'あなた', system: 'システム' };

// ---------- op -> human-readable Japanese summary (W-UI redesign §4) ----------
// `entry.op`/`entry.params` are exactly the wire vocabulary daemon.ts's
// `/api/edit` dispatch uses (the `b.op === '...'` branches in
// src/server/daemon.ts) — internal, never meant for a user to read directly.
// This turns each op into a short Japanese sentence; the raw op/summary the
// server generated is preserved as a title tooltip by the callers
// (renderActivityFeed/renderCompareCard) so nothing is lost, it's just not
// the primary reading. Falls back to the server's raw summary for any op
// added later that this map hasn't caught up with yet.
// W-UI polish "素材の短い別名": raw camera/phone filenames (e.g.
// dji_mimo_20260710_212922_20260710212922_1783773924674_video.MP4) aren't
// meaningful to read at a glance, so every UI surface that names a source
// shows "素材N" (N = 1-based registration order in manifest.sources — ingest
// always appends, never reorders/removes sources, so this stays stable)
// plus "· HH:MM" when a shooting time can be parsed out of the filename.
// The raw filename itself is never dropped — callers put it in a `title`
// attribute for hover discovery instead (see candRow/renderCandidateCard/
// renderOverlayRow/humanizeRevision's 'ingest' case).
function sourceLabel(source) {
  if (!source) return '素材';
  const idx = (S.manifest?.sources ?? []).findIndex((s) => s.id === source.id);
  const n = idx >= 0 ? idx + 1 : '?';
  const hhmm = shootTimeFromFilename(basename(source.path ?? ''));
  return hhmm ? `素材${n} · ${hhmm}` : `素材${n}`;
}
// Best-effort HH:MM extraction from a filename with an embedded capture
// timestamp. Consumer camera/phone naming conventions commonly embed a
// YYYYMMDD date run next to (or fused with) an HHMMSS time run — e.g.
// "..._20260710_212922_20260710212922_...". Rather than parse a specific
// vendor format, just look for any standalone 6-digit run (not part of a
// longer digit run, so an 8-digit date or a 13-digit epoch-ms don't match)
// whose first 4 digits are a plausible HH:MM. Returns null — falling back
// to the plain sequence number — when nothing plausible is found.
function shootTimeFromFilename(name) {
  for (const run of name.match(/\d+/g) ?? []) {
    if (run.length !== 6) continue;
    const hh = Number(run.slice(0, 2));
    const mm = Number(run.slice(2, 4));
    if (hh < 24 && mm < 60) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  return null;
}
function sourceDisplayName(sourceId) {
  return sourceLabel(S.manifest?.sources?.find((s) => s.id === sourceId));
}
const MOTION_TYPE_LABEL = {
  'chapter-card': 'チャプターカード', 'lower-third': 'ローワーサード', callout: 'コールアウト', cta: 'CTA',
};
const COLOR_TYPE_LABEL = { hlg: 'HLG', pq: 'PQ', lut: 'LUT', none: '素材そのまま' };
function humanizeRevision(entry) {
  const op = entry.op;
  const p = entry.params ?? {};
  const summary = entry.summary ?? '';
  switch (op) {
    case 'ingest': {
      // p.file is the absolute path passed to ingestFile (see
      // src/ingest/ingest.ts's project.commit call) — sources never get
      // reordered/removed, so it should still be findable in the live
      // manifest by exact path match. Raw path stays available via the
      // activity feed's own `info.title = ${op}: ${summary}` (summary
      // already embeds the full path — see daemon.ts's ingest broadcast).
      const file = typeof p.file === 'string' ? p.file : null;
      const ingestedSrc = file ? S.manifest.sources.find((s) => s.path === file) : null;
      const label = ingestedSrc ? sourceLabel(ingestedSrc) : (file ? basename(file) : summary);
      return `素材を追加(${label})`;
    }
    case 'apply-candidates': {
      const ids = Array.isArray(p.ids) ? p.ids : [];
      const kinds = new Set(ids.map((id) => S.candidatesAll.find((c) => c.id === id)?.kind).filter(Boolean));
      const label = kinds.size === 1 ? (KIND_LABEL[[...kinds][0]] ?? '') : '';
      const secs = summary.match(/-([\d.]+)s\)/)?.[1];
      // W-UI IA v2 用語表: 承認/却下 → カットする/残す — 履歴の表示も「承認」
      // を使わない言い回しに揃える。
      const bits = [ids.length > 0 ? `${ids.length}件` : '', secs ? `−${secs}秒` : ''].filter(Boolean).join(', ');
      return `${label}候補をカット${bits ? `(${bits})` : ''}`;
    }
    case 'remove-words': {
      const secs = summary.match(/\(([\d.]+)s\)/)?.[1];
      const n = Array.isArray(p.ids) ? p.ids.length : null;
      return `発言を削除(${n != null ? `${n}語` : ''}${secs ? `, -${secs}s` : ''})`;
    }
    case 'remove-range': {
      const range = typeof p.t0 === 'number' && typeof p.t1 === 'number' ? `${fmt(p.t0)}–${fmt(p.t1)}` : '';
      const src = p.sourceId ? sourceDisplayName(p.sourceId) : '';
      const bits = [src, range].filter(Boolean).join(' ');
      return `範囲を削除${bits ? `(${bits})` : ''}`;
    }
    case 'trim': {
      const edgeLabel = p.edge === 'in' ? 'IN側' : p.edge === 'out' ? 'OUT側' : '';
      const frames = typeof p.frames === 'number' ? `${p.frames > 0 ? '+' : ''}${p.frames}f` : '';
      const bits = [edgeLabel, frames].filter(Boolean).join(' ');
      return `クリップをトリム${bits ? `(${bits})` : ''}`;
    }
    case 'captions':
      return '字幕設定を変更';
    case 'caption-text':
      return p.text === null ? '字幕修正を解除' : '字幕テキストを修正';
    case 'motion-add': {
      const typeLabel = p.spec?.type ? (MOTION_TYPE_LABEL[p.spec.type] ?? p.spec.type) : '';
      const at = typeof p.tlStart === 'number' ? ` @ ${fmt(p.tlStart)}` : '';
      return `モーション演出を追加${typeLabel || at ? `(${typeLabel}${at})` : ''}`;
    }
    case 'motion-update':
      return 'モーション演出を調整';
    case 'motion-remove':
      return 'モーション演出を削除';
    case 'music-add': {
      const name = typeof p.path === 'string' && p.path ? basename(p.path) : '';
      const at = typeof p.tlStart === 'number' ? ` @ ${fmt(p.tlStart)}` : '';
      return `BGM/SEを追加${name || at ? `(${name}${at})` : ''}`;
    }
    case 'music-update':
      return 'BGM/SEを調整';
    case 'music-remove':
      return 'BGM/SEを削除';
    case 'broll-add':
      return `B-rollを追加${typeof p.in === 'number' && typeof p.out === 'number' ? `(${fmt(p.in)}–${fmt(p.out)})` : ''}`;
    case 'broll-update':
      return 'B-rollを調整';
    case 'broll-remove':
      return 'B-rollを削除';
    case 'sprite-add':
      return 'キャラクターを追加';
    case 'sprite-update':
      return 'キャラクターを調整';
    case 'sprite-remove':
      return 'キャラクターを削除';
    case 'compose':
      return `構成モードを設定${typeof p.width === 'number' && typeof p.height === 'number' ? `(${p.width}×${p.height}, ${p.duration}s)` : ''}`;
    case 'bg-set':
      return `背景を切り替え${typeof p.t === 'number' ? `(${fmt(p.t)}〜)` : ''}`;
    case 'bg-remove':
      return '背景の切り替えを削除';
    case 'shift': {
      // W-ANIME composition-only op (src/core/ops.ts's shiftComposition) —
      // params are the raw request body: from/by seconds, optional
      // keepDuration. Punch-list follow-up: this case was missing, so
      // 'shift' fell through to the raw internal summary in the 履歴 feed.
      const fmtSec = (n) => { const s = n.toFixed(1); return s.endsWith('.0') ? s.slice(0, -2) : s; };
      const from = typeof p.from === 'number' ? `${fmtSec(p.from)}秒地点から` : '';
      const by = typeof p.by === 'number' ? `${p.by > 0 ? '+' : ''}${fmtSec(p.by)}秒` : '';
      const bits = [from, by].filter(Boolean).join(' ');
      return `タイムラインを一括シフト${bits ? `(${bits})` : ''}`;
    }
    case 'dialogue-add':
      return `セリフを追加${typeof p.text === 'string' && p.text ? `("${p.text.slice(0, 16)}")` : ''}`;
    case 'dialogue-update':
      return 'セリフを調整';
    case 'dialogue-remove':
      return 'セリフを削除';
    case 'audio-mix':
      return '音量バランスを調整';
    case 'audio-repair':
      return `音声を補正(${p.preset ?? ''}${p.deess ? ' + 歯擦音抑制' : ''})`;
    case 'color-transform': {
      const typeLabel = p.type ? (COLOR_TYPE_LABEL[p.type] ?? p.type) : '';
      const src = p.sourceId ? sourceDisplayName(p.sourceId) : '';
      return `色変換を適用${src || typeLabel ? `(${src}${src && typeLabel ? ' → ' : ''}${typeLabel})` : ''}`;
    }
    case 'color-adjust':
      return `色を調整${p.sourceId ? `(${sourceDisplayName(p.sourceId)})` : ''}`;
    case 'clip-add':
      return `クリップを追加${p.sourceId ? `(${sourceDisplayName(p.sourceId)})` : ''}`;
    case 'clip-remove':
      return 'タイムラインから外す';
    case 'clip-move':
      return 'クリップを並べ替え';
    case 'reframe':
      return `画面比率を変更${p.spec ? `(${p.spec})` : ''}`;
    case 'clip-crop':
      return 'クリップの位置を調整';
    case 'scene-review': {
      const n = Array.isArray(p.sceneIds) ? p.sceneIds.length : (p.sceneId ? 1 : null);
      const label = p.review === 'keep' ? '採用' : p.review === 'reject' ? '不採用' : p.review === 'clear' ? '未確認' : '';
      return `シーンを${label ? `${label}に設定` : '見直し'}${n != null ? `(${n}件)` : ''}`;
    }
    case 'selects':
      return '採用シーンだけで仮タイムラインを作成';
    case 'kit-link':
      return 'キットを連携';
    case 'kit-unlink':
      return 'キットの連携を解除';
    case 'intent-add':
      return `保護区間を追加${typeof p.label === 'string' && p.label ? `("${p.label}")` : ''}`;
    case 'intent-remove':
      return '保護区間を削除';
    case 'restore':
      return `変更 #${typeof p.rev === 'number' ? p.rev : '?'}の状態に復元`;
    case 'transcribe':
      return '文字起こしを実行';
    default:
      return summary || op || '';
  }
}

function focusAfterHistoryAction() {
  const rows = [...document.querySelectorAll('#activityFeed .restoreBtn')];
  // W-UI IA v2 §1: 編集履歴 now lives in its own 履歴 tab, not #nowPanel(確認).
  if (rows.length === 0) { $('historyPanel').focus(); return; }
  rows[0].focus();
}
async function restoreToRevision(rev, trigger) {
  const { ok } = await mutate({ op: 'restore', rev }, { trigger });
  if (ok) toast(`変更 #${rev} の状態に戻しました`);
  // renderActivityFeed() always rebuilds #activityFeed's DOM on reload, so
  // the clicked button is stale either way — always re-focus something so
  // focus never silently drops to <body>, on both success and (post-reload)
  // failure.
  focusAfterHistoryAction();
}
/**
 * Best-effort "where did this change happen" -> a timeline range, from a
 * revision entry's recorded op params — powers each activity-feed card's
 * "▶この変更を見る" button (an internal call into the same show-range
 * plumbing `vedit show range` drives, per W-UI §0/§1). Uses CURRENT
 * segments/timeline state, not a historical reconstruction — a nearby,
 * present-day anchor is all "show me roughly where that was" needs. Returns
 * null when nothing usable can be derived (button is omitted then).
 */
function revisionShowTarget(entry) {
  const p = entry.params ?? {};
  if (typeof p.tlStart === 'number') {
    const dur = typeof p.duration === 'number' ? p.duration : 2;
    return { tlStart: p.tlStart, tlEnd: p.tlStart + dur };
  }
  if (typeof p.clipId === 'string') {
    const seg = S.segments.find((s) => s.clipId === p.clipId);
    if (seg) return { tlStart: seg.tlStart, tlEnd: seg.tlEnd };
  }
  if (typeof p.id === 'string') {
    const mo = S.manifest.timeline.motion.find((m) => m.id === p.id);
    if (mo) return { tlStart: mo.tlStart, tlEnd: mo.tlStart + mo.duration };
    const mu = (S.manifest.timeline.music ?? []).find((m) => m.id === p.id);
    if (mu) return { tlStart: mu.tlStart, tlEnd: mu.tlStart + mu.duration };
    const ov = S.overlays.find((r) => r.overlay.id === p.id && r.tlStart != null);
    if (ov) return { tlStart: ov.tlStart, tlEnd: ov.tlStart + (ov.overlay.srcOut - ov.overlay.srcIn) };
    const sp = S.sprites.find((r) => r.sprite.id === p.id && r.tlStart != null);
    if (sp) return { tlStart: sp.tlStart, tlEnd: sp.tlStart + sp.sprite.duration };
  }
  // Cut ops (remove-words/remove-range/apply-candidates): the cut range
  // itself no longer exists on the timeline, so land on the join point —
  // the first remaining segment of that source at/after t0, or its last
  // segment if the cut was at the very end.
  if (typeof p.sourceId === 'string' && typeof p.t0 === 'number') {
    const seg = S.segments.find((s) => s.sourceId === p.sourceId && s.srcStart >= p.t0)
      ?? [...S.segments].reverse().find((s) => s.sourceId === p.sourceId);
    if (seg) return { tlStart: seg.tlStart, tlEnd: Math.min(S.duration, seg.tlStart + 2) };
  }
  return null;
}
function renderActivityFeed() {
  const el = $('activityFeed');
  el.innerHTML = '';
  for (const r of [...S.revisions].reverse()) {
    const card = document.createElement('div');
    card.className = 'activityCard';
    const info = document.createElement('div');
    info.className = 'activityInfo';
    info.title = `${r.op}: ${r.summary}`; // raw op/summary (internal vocabulary) — tooltip only, see humanizeRevision's doc
    info.innerHTML = `<b>変更 #${r.rev}</b> <span class="activityActor">[${esc(ACTOR_LABEL[r.actor] ?? r.actor)}]</span> ${esc(humanizeRevision(r))}`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'activityActions';
    const target = revisionShowTarget(r);
    if (target) {
      const showBtn = document.createElement('button');
      showBtn.className = 'btn-activityShow';
      showBtn.textContent = '▶この変更を見る';
      showBtn.onclick = () => showRangeInternal(target.tlStart, target.tlEnd);
      actions.appendChild(showBtn);
    }
    if (r.rev >= 2) {
      const btn = document.createElement('button');
      btn.className = 'restoreBtn';
      btn.textContent = '⟲この編集より前に戻す';
      btn.onclick = async () => {
        if (!confirm(`変更 #${r.rev}「${r.summary}」より前の状態に戻しますか？(これ以降の変更も一緒に戻ります)`)) return;
        await restoreToRevision(r.rev - 1, btn);
      };
      actions.appendChild(btn);
    }
    if (actions.childElementCount) card.appendChild(actions);
    el.appendChild(card);
  }
}
// ---------- shared mutation path (波2.5: mutation 状態機械) ----------
// Every mutate() call moves through: idle -> pending -> committed -> either
// succeeded (reload OK) or committed-but-refresh-failed (POST /api/edit
// applied the op, but the follow-up reload() that repaints the UI threw) —
// OR, if the POST itself never lands, failed-before-commit (nothing was
// saved; safe to just report and let the caller retry).
//
// This split exists because the two failure points look identical from a
// naive try/catch (both throw) but mean opposite things to the user: a
// failed-before-commit really is "何も保存されなかった", while a
// committed-but-refresh-failed already succeeded server-side — showing the
// same "編集に失敗しました" for both (the pre-波2.5 bug, docs/polish-backlog.md
// 「保存成功なのに再読込失敗を編集失敗と誤表示」) is dishonest. The returned
// `ok` stays false in both failure cases (existing callers use it to decide
// whether to re-render/keep local state around for a retry, which is still
// the right call when the view couldn't be refreshed), but the TOAST text —
// and `committed`/`refreshed` for any caller that wants the distinction —
// now tells them apart.
//
// opts.trigger (an element, or an array of elements — typically the button/
// checkbox/select that started this mutation) is disabled for the duration
// of the pending phase to prevent double-submission from a second click
// before the first round-trip resolves; re-enabled once settled (a no-op if
// reload()'s re-render already replaced/detached the element).
async function mutate(body, opts = {}) {
  const triggers = opts.trigger ? (Array.isArray(opts.trigger) ? opts.trigger : [opts.trigger]) : [];
  for (const el of triggers) if (el) el.disabled = true;
  try {
    // ---- idle -> pending -> (failed-before-commit | committed) ----
    let res;
    try {
      res = await api('/api/edit', {
        method: 'POST',
        body: JSON.stringify({ baseRev: S.manifest.revision, actor: 'ui', ...body }),
      });
    } catch (e) {
      // failed-before-commit: the server never applied this op — nothing
      // to reconcile, just report it and best-effort resync (e.g. a 409
      // means someone else moved the revision out from under us).
      const conflict = e.status === 409;
      const msg = conflict ? (opts.conflictMessage ?? '他の編集と競合しました。最新状態を再読み込みしました') : e.message;
      toast(msg, { type: 'error' });
      await reload().catch(() => {});
      return { ok: false, conflict, committed: false };
    }
    // ---- committed -> syncing -> (succeeded | committed-but-refresh-failed) ----
    // Everything past this point is a *display refresh* problem, not an
    // edit failure — the op is already durably saved.
    const revision = res?.state?.revision ?? null;
    try {
      await reload();
    } catch {
      toast('保存済みです。画面の更新に失敗しました — ページを再読み込みしてください', { type: 'warn' });
      // The reload that would have shown the real "変更 #N" summary is the
      // very thing that just failed, so there's nothing better to show —
      // suppress the WS broadcast's generic confirmation for this revision
      // too (same dedupe S.lastWarningRevision already does for `warning`,
      // below) rather than let it flash a bare "変更 #N: " once the socket
      // catches up.
      if (revision != null) S.lastWarningRevision = revision;
      return { ok: false, conflict: false, result: res, committed: true, refreshed: false };
    }
    // W-UI IA v2 波2 追補#3: some ops (music-add/-update's duckWarningFor)
    // return a non-fatal `warning` alongside a 200 — previously dropped on
    // the floor entirely. Surface it, and remember which revision it was
    // for so the WS "変更 #N" confirmation toast (connectWs below) doesn't
    // immediately clobber it with a bland one for the very same commit.
    if (res && typeof res.warning === 'string' && res.warning) {
      toast(res.warning, { type: 'warn' });
      S.lastWarningRevision = revision ?? S.manifest.revision;
    }
    return { ok: true, conflict: false, result: res, committed: true, refreshed: true };
  } finally {
    for (const el of triggers) if (el) el.disabled = false;
  }
}

let toastTimer;
// W-UI IA v2 波2 §9/追補#3: a third `warn` variant, alongside the existing
// plain/error ones — for a successful mutation that still comes with a
// caveat (e.g. music-add/-update's duckWarningFor, surfaced from the /api
// /edit response body — see mutate()). Amber like the inbox's warning rows,
// closable + longer-lived than a plain confirmation since it's meant to
// actually be read, but never role="alert" (nothing failed).
function toast(msg, opts = {}) {
  const t = $('toast');
  const variant = opts.type === 'error' ? 'error' : opts.type === 'warn' ? 'warn' : 'plain';
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (variant !== 'plain') {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toastClose';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.onclick = () => { t.hidden = true; };
    t.appendChild(closeBtn);
  }
  t.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  if (variant === 'plain') t.removeAttribute('data-variant'); else t.setAttribute('data-variant', variant);
  t.hidden = false;
  clearTimeout(toastTimer);
  if (variant === 'plain') {
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  } else if (variant === 'warn') {
    toastTimer = setTimeout(() => (t.hidden = true), 7000);
  }
}

// ---------- W-UI IA v2 波2 §8: 「Claude に頼む」チップ ----------
// Structural dead ends (orphaned B-roll/sprites, an unlinked kit, a
// protected zone with no removal UI, custom-html-only motion, …) get a
// precise, ready-to-send request copied to the clipboard instead of a UI
// control — see docs/product-bet-sensory-vs-structural.md: 構造は会話.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
    return true;
  } catch {
    toast('コピーに失敗しました。手動でコピーしてください', { type: 'error' });
    return false;
  }
}
function askClaudeChip(promptText) {
  const btn = document.createElement('button');
  btn.className = 'askChip';
  // Codex 統合レビュー 受け入れ基準残差#3: 「Claude への導線」が title だけに
  // 頼っていた(可視ラベルは「『依頼文』をコピー」で誰に頼むのか不明瞭) —
  // 固定プレフィックスで可視化する。
  btn.textContent = `Claude に頼む: 「${promptText}」をコピー`;
  btn.title = 'クリックでこの依頼文をクリップボードにコピーします。Claude に伝えてください';
  btn.onclick = (e) => { e.stopPropagation(); copyToClipboard(promptText); };
  return btn;
}

// ---------- tabs (WAI-ARIA Tabs pattern: automatic activation) ----------
const tabList = document.querySelector('.tabs');
const tabs = [...document.querySelectorAll('.tab')];
function activateTab(tab, { focus = true } = {}) {
  for (const tEl of tabs) {
    const selected = tEl === tab;
    tEl.classList.toggle('active', selected);
    tEl.setAttribute('aria-selected', String(selected));
    tEl.tabIndex = selected ? 0 : -1;
  }
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $(tab.dataset.panel).classList.add('active');
  if (focus) tab.focus();
  // 波2.5: 確認タブが表示されるたび「最後の書き出し」カードを最新化(30秒
  // ポーリングの他に、タブを開いた瞬間も反映されるようにする一手 — see
  // fetchExportResults's doc).
  if (tab.dataset.panel === 'nowPanel') fetchExportResults().catch(() => {});
}
for (const tab of tabs) {
  tab.onclick = () => activateTab(tab, { focus: false });
}
// Left/right (and Home/End) move + activate a tab, scoped to the tablist so
// they never fall through to the global seek shortcuts.
tabList.addEventListener('keydown', (e) => {
  const idx = tabs.indexOf(document.activeElement);
  if (idx < 0) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); activateTab(tabs[(idx + 1) % tabs.length]); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); activateTab(tabs[(idx - 1 + tabs.length) % tabs.length]); }
  else if (e.key === 'Home') { e.preventDefault(); activateTab(tabs[0]); }
  else if (e.key === 'End') { e.preventDefault(); activateTab(tabs[tabs.length - 1]); }
});

// ---------- W-UI companion channel (show directives) — W-UI §0 ----------
// Claude calls `vedit show <kind> ...`, which POSTs /api/show and broadcasts
// {type:'show', directive} to every connected browser (no revision, no
// actor — purely a UI cue). This is the core of the "相棒" feel: when Claude
// talks about a specific spot, this screen jumps/highlights/opens it so a
// user watching alongside the chat sees exactly what's being discussed.
let showHighlightTimer;
function handleShowDirective(d) {
  if (!d || !d.kind) return;
  // Codex 統合レビュー P1-1: クリップ等を選択してインスペクタ表示中
  // (#tabsView が hidden)に show 系 WS メッセージが来ると、対象のタブ側は
  // 更新されてもインスペクタの裏に隠れたまま不可視だった。Claude の提示は
  // ユーザーへの割り込みとして最優先 — 選択を解除してインスペクタを閉じ、
  // #tabsView を表示してから各 kind のハンドラ(activateTab 等)に委ねる。
  // 選択中だった対象を show 後に再選択する必要はない。
  if (S.selection) deselect();
  if (d.kind === 'range') return showRangeDirective(d);
  if (d.kind === 'words') return showWordsDirective(d);
  if (d.kind === 'candidate') return showCandidateDirective(d);
  if (d.kind === 'compare') return showCompareDirective(d);
  if (d.kind === 'source') return showSourceDirective(d);
  if (d.kind === 'takes') return showTakesDirective(d);
}
// Jump to `tlStart`, highlight [tlStart,tlEnd] on the strip (a dedicated
// #showHighlight element — deliberately NOT the I/O range-selection UI,
// which would also surface its "この範囲を削除" action bar), autoplay from
// 1s before tlStart, auto-stop 1s after tlEnd. Also used directly (not via
// the WS message) by the activity feed's "▶この変更を見る" button.
function showRangeInternal(tlStart, tlEnd) {
  if (!Number.isFinite(tlStart) || !Number.isFinite(tlEnd) || !S.duration) return;
  const a = Math.max(0, Math.min(tlStart, tlEnd));
  const b = Math.max(tlStart, tlEnd);
  const el = $('showHighlight');
  el.hidden = false;
  el.style.left = `${(a / S.duration) * 100}%`;
  el.style.width = `${Math.max(0, (b - a) / S.duration) * 100}%`;
  clearTimeout(showHighlightTimer);
  showHighlightTimer = setTimeout(() => { el.hidden = true; }, 6000);
  const startTl = Math.max(0, a - 1);
  S.previewStopAt = Math.min(S.duration, b + 1);
  seekTl(startTl, { play: true });
  S.playing = true;
  setPlayBtnState(true);
}
function showRangeDirective(d) {
  showRangeInternal(Number(d.tlStart), Number(d.tlEnd));
}
// Switch to Transcript, highlight+scroll to the words (a separate
// S.showWordKeys set — NOT S.selWords, so "showing" a word never enables the
// delete-selection button as a side effect), and seek to the first one.
function showWordsDirective(d) {
  const sourceId = d.sourceId;
  const ids = Array.isArray(d.ids) ? d.ids : [];
  if (!sourceId || ids.length === 0) return;
  activateTab($('tab-transcriptPanel'), { focus: false });
  S.showWordKeys = new Set(ids.map((id) => `${sourceId}:${id}`));
  renderTranscript();
  const words = S.transcripts.get(sourceId) ?? [];
  const first = words.find((w) => ids.includes(w.id));
  if (first) {
    document.querySelector(`.w[data-src="${CSS.escape(sourceId)}"][data-id="${CSS.escape(first.id)}"]`)?.scrollIntoView({ block: 'center' });
    seekToWord(sourceId, first);
  }
}
// Candidate card: shown front-and-center over the stage (independent of the
// いま tab's inbox rows), with prev/next-play + apply/keep — reuses the same
// candidateTl/decide() plumbing the inbox's candRow uses.
function renderCandidateCard(c) {
  const body = $('candidateCardBody');
  const dur = Math.max(0, c.t1 - c.t0);
  const label = humanizeCandidateLabel(c.label, dur);
  const src = S.manifest.sources.find((s) => s.id === c.sourceId);
  const srcName = sourceLabel(src);
  const srcTitle = src ? basename(src.path) : c.sourceId;
  body.innerHTML = `<div><span class="kind ${c.kind}">${esc(KIND_LABEL[c.kind] ?? c.kind)}</span></div>` +
    `<div class="showCardLbl">${esc(label)}</div>` +
    `<div class="hintText" title="${esc(srcTitle)}">${esc(srcName)} ${fmt(c.t0)}–${fmt(c.t1)}</div>`;
  const actions = document.createElement('div');
  actions.className = 'candActions';
  const preview = document.createElement('button');
  preview.className = 'btn-preview';
  preview.textContent = '前後を再生';
  preview.onclick = () => {
    const startTl = candidateTl(c.t0 - 1, c);
    const endTl = candidateTl(c.t1 + 1, c);
    if (startTl == null) return;
    S.previewStopAt = endTl;
    seekTl(startTl, { play: true });
    S.playing = true;
    setPlayBtnState(true);
  };
  const ok = document.createElement('button');
  ok.className = 'btn-approve';
  ok.textContent = 'カットする';
  ok.onclick = async () => { await decide([c.id], 'approve'); };
  const ng = document.createElement('button');
  ng.className = 'btn-wash'; // 候補カード: 残すは状態色ではなくニュートラル(--wash) — 「カットする」は現状の --keep のまま
  ng.textContent = '残す';
  ng.onclick = async () => { await decide([c.id], 'reject'); };
  actions.append(preview, ok, ng);
  body.appendChild(actions);
  $('candidateCard').hidden = false;
}
function hideCandidateCard() { $('candidateCard').hidden = true; }
$('candidateCardClose').onclick = hideCandidateCard;
function showCandidateDirective(d) {
  const c = S.candidatesAll.find((x) => x.id === d.id);
  if (!c) { toast(`候補 ${d.id} が見つかりません`, { type: 'error' }); return; }
  renderCandidateCard(c);
}
// Compare card: server precomputes durationA/durationB/deltaSeconds/ops (see
// daemon.ts's /api/show kind=compare) — this just renders it, no parallel
// video playback (out of scope per spec; a text diff is enough).
function renderCompareCard(d) {
  const body = $('compareCardBody');
  const deltaLabel = `${d.deltaSeconds >= 0 ? '+' : ''}${d.deltaSeconds.toFixed(1)}s`;
  const opsHtml = (d.ops ?? [])
    .map((o) => `<li title="${esc(`${o.op}: ${o.summary}`)}"><b>変更 #${o.rev}</b> [${esc(ACTOR_LABEL[o.actor] ?? o.actor)}] ${esc(humanizeRevision(o))}</li>`)
    .join('');
  body.innerHTML =
    `<div class="showCardLbl">変更 #${d.revA}(${fmt(d.durationA)}) → 変更 #${d.revB}(${fmt(d.durationB)}): ${deltaLabel}</div>` +
    `<ul class="compareOps">${opsHtml || '<li class="hintText">変更なし</li>'}</ul>`;
  $('compareCard').hidden = false;
}
function hideCompareCard() { $('compareCard').hidden = true; }
$('compareCardClose').onclick = hideCompareCard;
function showCompareDirective(d) {
  renderCompareCard(d);
}

// Takes card (W-INTENT/W11): a card STACK — one row per detected take in the
// group, each with 前後再生 (reuses candidateTl's segment-lookup math, fed a
// {sourceId} stand-in since it only reads that field) and 「これを残す」
// (deletes every OTHER take's words via the same remove-words op the
// Transcript panel's delete-selection uses — see mutate() below; confirm()
// first since it's destructive and spans possibly multiple utterances).
async function fetchTakesForSource(sourceId) {
  if (!S.takesCache.has(sourceId)) {
    S.takesCache.set(sourceId, await api(`/api/takes?source=${encodeURIComponent(sourceId)}`));
  }
  return S.takesCache.get(sourceId);
}
function renderTakesCard(sourceId, group) {
  const body = $('takesCardBody');
  body.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'showCardLbl';
  header.textContent = `言い直し候補 — ${group.utterances.length}テイク検出(★は推薦)`;
  body.appendChild(header);
  const hint = document.createElement('div');
  hint.className = 'hintText';
  hint.textContent = group.recommendation.reason;
  body.appendChild(hint);

  group.utterances.forEach((u, idx) => {
    const isRecommended = idx === group.recommendation.utteranceIndex;
    const row = document.createElement('div');
    row.className = 'takeRow' + (isRecommended ? ' recommended' : '');
    const confPct = Math.round((1 - u.features.lowConfidenceRatio) * 100);
    row.innerHTML =
      `<div class="showCardLbl">${isRecommended ? '★ ' : ''}"${esc(u.text)}"</div>` +
      `<div class="hintText">${fmt(u.t0)}–${fmt(u.t1)} conf=${confPct}%</div>`;
    const actions = document.createElement('div');
    actions.className = 'candActions';
    const preview = document.createElement('button');
    preview.className = 'btn-preview';
    preview.textContent = '前後を再生';
    preview.onclick = () => {
      const startTl = candidateTl(Math.max(0, u.t0 - 1), { sourceId });
      const endTl = candidateTl(u.t1 + 1, { sourceId });
      if (startTl == null) return;
      S.previewStopAt = endTl;
      seekTl(startTl, { play: true });
      S.playing = true;
      setPlayBtnState(true);
    };
    const keep = document.createElement('button');
    keep.className = 'btn-approve';
    keep.textContent = 'これを残す';
    keep.onclick = async () => {
      const others = group.utterances.filter((_, i) => i !== idx);
      const wordIds = others.flatMap((o) => o.wordIds);
      if (wordIds.length === 0) return;
      if (!confirm(`他の${others.length}テイクを削除します。よろしいですか？`)) return;
      const { ok } = await mutate({ op: 'remove-words', ids: wordIds, sourceId }, { trigger: keep });
      if (ok) hideTakesCard();
    };
    actions.append(preview, keep);
    row.appendChild(actions);
    body.appendChild(row);
  });
  $('takesCard').hidden = false;
}
function hideTakesCard() { $('takesCard').hidden = true; }
$('takesCardClose').onclick = hideTakesCard;
async function showTakesDirective(d) {
  if (!d.sourceId || !d.groupId) return;
  let groups;
  try {
    groups = await fetchTakesForSource(d.sourceId);
  } catch (e) {
    toast(e.message, { type: 'error' });
    return;
  }
  const group = groups.find((g) => g.id === d.groupId);
  if (!group) { toast(`テイクグループ ${d.groupId} が見つかりません`, { type: 'error' }); return; }
  renderTakesCard(d.sourceId, group);
}

// Source preview mode, opened from a "show" directive (Claude directing
// attention to raw, uncut material).
function showSourceDirective(d) {
  if (!d.sourceId) return;
  activateTab($('tab-mediaPanel'), { focus: false });
  setMediaFocus(d.sourceId, { focus: false });
  enterSourcePreview(d.sourceId, { at: d.at ?? 0 });
}

// ---------- Claude presence strip (W-UI §1) ----------
// Surfaces ingest/transcribe/upload/color-transform progress at the top of
// the いま tab's feed, from the same WS progress events the stage's
// #ingestOverlay spinner already listens to.
function setClaudeTask(label) {
  S.activeTask = label ? { label } : null;
  const strip = $('claudeStrip');
  strip.hidden = !label;
  if (label) $('claudeStripText').textContent = label;
  renderClaudeStatus();
}

// ---------- W-UI IA v2 波2 §3: Claude 状態の常設表示(ヘッダー) ----------
// Promotes the いま/確認 タブ内 claudeStrip's "is Claude doing something
// right now" signal to a permanent header readout with 3 states, derived
// from data the daemon already exposes (no new API): WS activity (S.
// activeTask, same signal claudeStrip already used) means 編集中; otherwise
// the 確認 タブ's own pending-count badge (candidates + 対応が必要) means
// あなたの確認待ち; otherwise 待機中. Reads the badge AFTER renderInbox() has
// run (see renderAll) rather than recomputing the same anchor/color/
// low-confidence/QC scan a second time here.
function renderClaudeStatus() {
  const el = $('claudeStatus');
  if (!el) return;
  if (S.activeTask) {
    el.textContent = 'Claude: 編集中';
    el.className = 'claudeStatus busy';
    el.title = S.activeTask.label;
    return;
  }
  const badge = $('inboxCount');
  const pending = badge && !badge.hidden ? Number(badge.textContent || '0') : 0;
  if (pending > 0) {
    el.textContent = 'Claude: あなたの確認待ち';
    el.className = 'claudeStatus waiting';
    el.title = `${pending}件の確認待ち — 確認タブを開いてください`;
  } else {
    el.textContent = 'Claude: 待機中';
    el.className = 'claudeStatus idle';
    el.title = '';
  }
}

// ---------- websocket live updates ----------
// Codex 統合レビュー P2-7: 切断中に見逃した transcribe-done/update 等の WS
// メッセージのせいで、再接続後も activeTask/S.transcribing/取り込み
// オーバーレイがローカルに残留し続けることがあった。wsEverConnected で
// 「今回の open が最初の接続か、切断からの再接続か」を区別し、再接続の
// ときだけローカル状態をクリアして reload() で最新状態に同期し直す。
let wsEverConnected = false;
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    const el = $('conn');
    el.classList.add('up');
    el.title = '接続済み';
    el.setAttribute('aria-label', '接続状態: 接続済み');
    if (wsEverConnected) {
      S.transcribing = new Set();
      setClaudeTask(null);
      $('ingestOverlay').hidden = true;
      $('stage').removeAttribute('aria-busy');
      if (S.manifest) reload().catch((e) => toast(e.message, { type: 'error' }));
    }
    wsEverConnected = true;
  };
  ws.onclose = () => {
    const el = $('conn');
    el.classList.remove('up');
    el.title = '再接続中';
    el.setAttribute('aria-label', '接続状態: 再接続中');
    setTimeout(connectWs, 1500);
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'show') { handleShowDirective(msg.directive); return; }
    if (msg.type === 'ingest-start') {
      $('ingestOverlay').hidden = false;
      $('ingestStep').textContent = '取り込み中...';
      $('stage').setAttribute('aria-busy', 'true');
      setClaudeTask(`取り込み中: ${basename(msg.file ?? '')}`);
    }
    if (msg.type === 'ingest-progress') {
      $('ingestStep').textContent = msg.step;
      setClaudeTask(msg.step);
    }
    if (msg.type === 'upload-start') setClaudeTask(`取り込み中(アップロード): ${msg.name}`);
    if (msg.type === 'upload-progress') {
      if (msg.done) setClaudeTask(null);
      else setClaudeTask(`取り込み中(アップロード): ${msg.name} — ${formatBytes(msg.bytes ?? 0)}`);
    }
    if (msg.type === 'color-transform-progress') setClaudeTask(`色変換中: ${msg.sourceId} — ${msg.step}`);
    // W-LAZY: `vedit transcribe` background job progress (POST
    // /api/transcribe in daemon.ts). transcribe-done is always followed by a
    // separate 'update' broadcast (the source.transcribed=true commit),
    // which the generic handler below already reloads+clears the strip for
    // — S.transcribing is updated here too just so the media-pool badge and
    // Transcript-tab empty state flip instantly instead of waiting on that
    // second message. transcribe-error has no accompanying commit/'update',
    // so it clears the strip and surfaces the failure itself.
    if (msg.type === 'transcribe-progress') {
      S.transcribing.add(msg.sourceId);
      const src = S.manifest?.sources.find((s) => s.id === msg.sourceId);
      setClaudeTask(`文字起こし中: ${basename(src ? src.path : msg.sourceId)} …`);
      if (S.manifest) { renderMediaPanel(); renderTranscript(); }
    }
    if (msg.type === 'transcribe-done') {
      S.transcribing.delete(msg.sourceId);
      if (S.manifest) renderMediaPanel();
    }
    if (msg.type === 'transcribe-error') {
      S.transcribing.delete(msg.sourceId);
      setClaudeTask(null);
      if (S.manifest) { renderMediaPanel(); renderTranscript(); }
      toast(`文字起こしに失敗しました (${msg.sourceId}): ${msg.error}`, { type: 'error' });
    }
    if (msg.type === 'update' || msg.type === 'candidates' || msg.type === 'project') {
      $('ingestOverlay').hidden = true;
      $('stage').removeAttribute('aria-busy');
      setClaudeTask(null);
      // tlNow() assumes #video is playing the timeline mix; during source
      // preview mode it plays an unrelated source proxy, so fall back to the
      // saved pre-preview position instead of deriving a bogus value from it.
      const tl = S.sourcePreview ? S.sourcePreview.returnTl : tlNow();
      try {
        await reload();
        if (msg.type === 'update') seekTl(Math.min(tl, S.duration - 0.01), { play: false });
      } catch (e) {
        toast(e.message, { type: 'error' });
      }
      // W-UI IA v2 波2 §9: every successful mutation (from ANY actor, since
      // this browser's own websocket also receives its own broadcast —
      // src/server/daemon.ts's broadcast() has no sender-exclusion) lands
      // here, so this is the "控えめな確認" for direct UI edits too — no
      // separate success-toast plumbing needed at each call site. Previously
      // this echoed the daemon's raw internal summary (op names/ids/English)
      // verbatim, straight past the "CLI構文をUI文言に出さない" rule; look
      // the same revision back up in the just-reloaded S.revisions and run
      // it through humanizeRevision() instead. Skipped once if mutate()
      // already surfaced a `warning` toast for this exact revision, so the
      // warning isn't immediately overwritten by a bland confirmation.
      if (msg.type === 'update' && msg.summary) {
        if (msg.revision === S.lastWarningRevision) {
          S.lastWarningRevision = null;
        } else {
          const entry = S.revisions.find((r) => r.rev === msg.revision);
          const text = entry ? humanizeRevision(entry) : msg.summary;
          toast(`変更 #${msg.revision ?? ''}: ${text}`);
        }
      }
    }
  };
}

// ---------- drag-and-drop ingest (W-UI §4) ----------
// Window-wide dropzone: drop a video file or a folder of them anywhere in
// the window to ingest it. Prefers LINKING the original file on disk (found
// via /api/locate-media's mdfind + head/tail fingerprint match — see
// src/ingest/locate.ts) over copying; falls back to a streamed upload
// (/api/upload) into project/media/ only when nothing on disk matches.
function readEntryFiles(entry) {
  return new Promise((resolve) => {
    if (!entry) return resolve([]);
    if (entry.isFile) {
      entry.file((file) => resolve([file]), () => resolve([]));
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            const nested = await Promise.all(collected.map(readEntryFiles));
            resolve(nested.flat());
            return;
          }
          collected.push(...batch);
          readBatch(); // readEntries must be called repeatedly until it returns [] (browsers cap a single call's results)
        }, () => resolve([]));
      };
      readBatch();
      return;
    }
    resolve([]);
  });
}
async function collectDroppedVideoFiles(dataTransfer) {
  const items = dataTransfer.items ? [...dataTransfer.items] : [];
  let files = [];
  if (items.length && items[0].webkitGetAsEntry) {
    const entries = items.map((it) => it.webkitGetAsEntry()).filter(Boolean);
    const nested = await Promise.all(entries.map(readEntryFiles));
    files = nested.flat();
  }
  // Fall back to the flat file list whenever the entries API yielded nothing
  // (folders need it for recursion, but a plain flat drop doesn't — and some
  // browsers/sources don't back every item with a real filesystem entry).
  if (files.length === 0) files = [...(dataTransfer.files ?? [])];
  return files.filter((f) => isVideoFileName(f.name));
}
async function computeFileFingerprint(file) {
  const { headStart, headLen, tailStart, tailLen } = fingerprintRanges(file.size);
  const headBuf = headLen > 0 ? await file.slice(headStart, headStart + headLen).arrayBuffer() : new ArrayBuffer(0);
  const tailBuf = tailLen > 0 ? await file.slice(tailStart, tailStart + tailLen).arrayBuffer() : new ArrayBuffer(0);
  const [headDigest, tailDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', headBuf),
    crypto.subtle.digest('SHA-256', tailBuf),
  ]);
  return { size: file.size, headSha256: bufferToHex(headDigest), tailSha256: bufferToHex(tailDigest) };
}

function renderIngestFlowCard(message, buttons) {
  const body = $('ingestFlowBody');
  body.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'showCardLbl';
  p.textContent = message;
  body.appendChild(p);
  if (buttons.length) {
    const actions = document.createElement('div');
    actions.className = 'candActions';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) btn.className = 'btn-approve';
      btn.onclick = b.onClick;
      actions.appendChild(btn);
    }
    body.appendChild(actions);
  }
  $('ingestFlowCard').hidden = false;
}
function hideIngestFlowCard() {
  $('ingestFlowCard').hidden = true;
}
$('ingestFlowClose').onclick = hideIngestFlowCard;

async function ingestByLink(path) {
  await api('/api/ingest', { method: 'POST', body: JSON.stringify({ file: path }) });
}
async function ingestByUpload(file) {
  const uploaded = await api(`/api/upload?${new URLSearchParams({ name: file.name })}`, { method: 'POST', body: file });
  await api('/api/ingest', { method: 'POST', body: JSON.stringify({ file: uploaded.path }) });
}

async function startSingleFileIngestFlow(file) {
  renderIngestFlowCard(`${file.name} を確認しています…`, []);
  let fp;
  try {
    fp = await computeFileFingerprint(file);
  } catch (e) {
    hideIngestFlowCard();
    toast(`${file.name} の読み取りに失敗しました: ${e.message}`, { type: 'error' });
    return;
  }
  let located = { found: false };
  try {
    located = await api('/api/locate-media', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, size: fp.size, mtime: file.lastModified, headSha256: fp.headSha256, tailSha256: fp.tailSha256 }),
    });
  } catch { /* locate is best-effort; fall through to the upload offer */ }

  if (located.found) {
    renderIngestFlowCard(`${file.name} を見つけました → 取り込む(コピーなし)`, [
      {
        label: '取り込む', primary: true,
        onClick: async () => {
          hideIngestFlowCard();
          try { await ingestByLink(located.path); toast(`${file.name} を取り込みました(コピーなし)`); }
          catch (e) { toast(`${file.name} の取り込みに失敗しました: ${e.message}`, { type: 'error' }); }
        },
      },
      { label: 'キャンセル', onClick: hideIngestFlowCard },
    ]);
  } else {
    renderIngestFlowCard(`${file.name} は手元では見つかりませんでした`, [
      {
        label: `コピーして取り込む(${formatBytes(fp.size)} 使用)`, primary: true,
        onClick: async () => {
          hideIngestFlowCard();
          try { await ingestByUpload(file); toast(`${file.name} を取り込みました(コピー)`); }
          catch (e) { toast(`${file.name} のアップロードに失敗しました: ${e.message}`, { type: 'error' }); }
        },
      },
      {
        label: 'Claude に場所を伝える',
        onClick: () => { hideIngestFlowCard(); toast('チャットで元ファイルの場所を伝えてください — Claude が取り込みます'); },
      },
      { label: 'キャンセル', onClick: hideIngestFlowCard },
    ]);
  }
}

async function startMultiFileIngestFlow(files) {
  const summary = planSummary(files);
  renderIngestFlowCard(`${summary.count}件・合計 ${summary.totalBytesLabel} を取り込みますか？(手元にある素材はコピーせずリンク、無ければコピー)`, [
    { label: '取り込む', primary: true, onClick: () => runMultiFileIngest(files) },
    { label: 'キャンセル', onClick: hideIngestFlowCard },
  ]);
}
async function runMultiFileIngest(files) {
  let done = 0;
  const failed = [];
  for (const file of files) {
    renderIngestFlowCard(`取り込み中 ${done + 1}/${files.length}: ${file.name}`, []);
    try {
      const fp = await computeFileFingerprint(file);
      let located = { found: false };
      try {
        located = await api('/api/locate-media', {
          method: 'POST',
          body: JSON.stringify({ name: file.name, size: fp.size, mtime: file.lastModified, headSha256: fp.headSha256, tailSha256: fp.tailSha256 }),
        });
      } catch { /* fall back to upload below */ }
      if (located.found) await ingestByLink(located.path);
      else await ingestByUpload(file);
      done++;
    } catch (e) {
      failed.push({ name: file.name, error: e?.message ?? String(e) });
    }
  }
  hideIngestFlowCard();
  if (failed.length) toast(`${done}/${files.length}件を取り込みました(失敗: ${failed.map((f) => f.name).join(', ')})`, { type: 'error' });
  else toast(`${done}件を取り込みました`);
}

let dropDragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dropDragCounter++;
  $('dropOverlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dropDragCounter = Math.max(0, dropDragCounter - 1);
  if (dropDragCounter === 0) $('dropOverlay').hidden = true;
});
window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dropDragCounter = 0;
  $('dropOverlay').hidden = true;
  const files = await collectDroppedVideoFiles(e.dataTransfer);
  if (files.length === 0) {
    toast('動画ファイル(.mp4/.mov/.m4v)が見つかりませんでした', { type: 'error' });
    return;
  }
  if (files.length === 1) startSingleFileIngestFlow(files[0]);
  else startMultiFileIngestFlow(files);
});

// ---------- render root ----------
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function aspectLabel(w, h) {
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}
// W-UI §1 "ヘッダー薄型情報": current duration, plus "/ 目標 M:SS" when the
// linked kit declares a duration target (profile.duration_seconds.target).
function durationTargetLabel() {
  const target = S.kit?.kit?.profile?.duration_seconds?.target;
  return typeof target === 'number' ? ` / 目標 ${fmt(target)}` : '';
}
function renderStat() {
  const m = S.manifest;
  const out = m.output;
  const base = out
    ? `${fmt(S.duration)} / 出力 ${out.width}×${out.height} (${aspectLabel(out.width, out.height)}) · 素材 ${m.width}×${m.height} ${Math.round(m.fps)}fps`
    : `${fmt(S.duration)} / ${m.width}×${m.height} ${Math.round(m.fps)}fps`;
  // W-UI redesign: this line is deliberately a small/dim secondary readout
  // (see header CSS) — output res/material spec/fps are useful but shouldn't
  // compete with the project name + live timecode for attention. The full
  // text is also the title tooltip, so it's fully readable on hover even at
  // a truncated width.
  const full = base + durationTargetLabel();
  const statEl = $('stat');
  statEl.textContent = full;
  statEl.title = full;
}
async function renderAll() {
  const m = S.manifest;
  $('projName').textContent = m.name;
  renderStat();
  // W-UI IA v2 用語表: 「変更 #7」→「現在の版 7」(ヘッダー右端の弱表示)。
  // 波2 §7: 「自動保存」を明示 — 「保存」という語が UI に一度も出ない状態の解消。
  $('revLabel').textContent = `現在の版 ${m.revision} · 自動保存`;
  applyCompositionMode();
  await loadMotionSpecs();
  syncMusicElements();
  renderTimeline();
  renderTranscript();
  renderInbox();
  renderActivityFeed();
  renderMediaPanel();
  renderRange();
  updateFraming();
  renderStageState();
  renderInspector();
  renderPlayability();
  renderClaudeStatus(); // after renderInbox() — reads its badge, see the doc above
  renderIntentZonesInfo();
}

window.addEventListener('resize', () => { drawWave(); renderRuler(); });
// Connect the socket and start the frame loop unconditionally — tick() is a
// no-op until a segment is loaded — so that if the initial /api/project call
// fails (e.g. "no project open"), the UI still hears about a project being
// opened later (via `vedit open`) instead of being stuck until a manual
// browser refresh.
connectWs();
// 波2.5: 確認タブは既定で最初から表示されている(index.html の .tab.active)
// ので、activateTab を経由しない初回だけここで明示的に1回フェッチする。
// その後は 30秒ごとに確認タブが表示中のときだけポーリング(「軽い」— 他の
// タブを見ている間は叩かない)。
fetchExportResults().catch(() => {});
setInterval(() => {
  if ($('tab-nowPanel')?.classList.contains('active')) fetchExportResults().catch(() => {});
}, 30000);
requestAnimationFrame(tick);
reload().then(() => {
  if (S.segments.length) loadSeg(0, { play: false });
}).catch((e) => toast(e.message, { type: 'error' }));

// ---------- resizable sidebar (pane divider) ----------
(() => {
  const divider = $('paneDivider');
  if (!divider) return;
  const KEY = 'vedit.asideW';
  const DEFAULT_W = 340;
  const clampW = (w) => Math.max(240, Math.min(window.innerWidth * 0.7, w));
  const apply = (w) => {
    document.documentElement.style.setProperty('--aside-w', `${clampW(w)}px`);
    drawWave(); // timeline canvas depends on stage width
    renderRuler(); // same — tick spacing depends on the same width
  };
  const saved = Number(localStorage.getItem(KEY));
  if (saved) apply(saved);
  const current = () => document.querySelector('aside').getBoundingClientRect().width;

  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    divider.classList.add('dragging');
    divider.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = current();
    const move = (ev) => apply(startW + (startX - ev.clientX)); // divider left = aside grows
    const up = () => {
      divider.classList.remove('dragging');
      localStorage.setItem(KEY, String(Math.round(current())));
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
  });
  divider.addEventListener('dblclick', () => {
    apply(DEFAULT_W);
    localStorage.removeItem(KEY);
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    apply(current() + (e.key === 'ArrowLeft' ? 16 : -16));
    localStorage.setItem(KEY, String(Math.round(current())));
  });
  window.addEventListener('resize', () => apply(current()));
})();
