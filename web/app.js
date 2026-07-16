// vedit Web NLE v1 — proxy playback mapped through the timeline, DOM overlays
// for captions/motion, transcript selection, candidate approve/reject.
// All mutations go through the same revision-checked API Claude uses.

const $ = (id) => document.getElementById(id);
const video = $('video');
const basename = (p) => String(p ?? '').split('/').pop();

const S = {
  manifest: null,
  segments: [],
  duration: 0,
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
  selectedClip: null,
  detectMinGap: 0.7,
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
    S.cues = await api('/api/captions');
    S.candidates = await api('/api/candidates');
    S.candidatesAll = await api('/api/candidates?all=1');
    S.revisions = await api('/api/revisions');
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
function renderStageState() {
  const el = $('stageEmpty');
  const msg = $('stageEmptyMsg');
  const retry = $('stageEmptyRetry');
  if (S.loadState === 'error') {
    el.hidden = false;
    msg.textContent = '読み込みに失敗しました';
    retry.hidden = false;
  } else if (S.loadState === 'no-project') {
    el.hidden = false;
    msg.textContent = 'プロジェクト未選択';
    retry.hidden = true;
  } else if (S.manifest && (S.manifest.sources?.length ?? 0) === 0) {
    el.hidden = false;
    msg.textContent = '素材がありません — `vedit ingest <file>` で取り込み';
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
    if (play) video.play().catch(() => {});
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
function seekTl(tl, { play } = {}) {
  // Any timeline seek/scrub ("playhead operation") returns from source
  // preview mode to the timeline, at the position being sought.
  if (S.sourcePreview) { S.sourcePreview = null; renderPreviewBanner(); }
  tl = Math.max(0, Math.min(tl, S.duration - 0.001));
  let i = segAt(tl);
  if (i < 0) i = S.segments.length - 1;
  if (i < 0) return; // no segments at all
  loadSeg(i, { play: play ?? S.playing, offset: tl - S.segments[i].tlStart });
}

// The frame loop: cross segment boundaries, drive playhead/captions/motion.
function tick() {
  if (S.sourcePreview) {
    // Source preview mode: #video plays a raw source proxy that has no
    // relation to S.segments/S.currentSeg, so skip all timeline-linked
    // rendering (playhead, captions, motion, word highlight) and just show
    // the source-relative timecode.
    $('tc').textContent = `${fmtF(video.currentTime)} / ${fmtF(video.duration || 0)}`;
    requestAnimationFrame(tick);
    return;
  }
  const i = S.currentSeg;
  if (i >= 0 && S.segments[i]) {
    const s = S.segments[i];
    if (!video.paused && video.currentTime >= s.srcStart + (s.tlEnd - s.tlStart) - 0.02) {
      if (i + 1 < S.segments.length) loadSeg(i + 1, { play: true });
      else { video.pause(); S.playing = false; setPlayBtnState(false); }
    }
    const tl = tlNow();
    $('playhead').style.left = `${(tl / S.duration) * 100}%`;
    $('tc').textContent = `${fmtF(tl)} / ${fmtF(S.duration)}`;
    renderCaption(tl);
    renderMotion(tl);
    highlightWord(tl);
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
  video.pause();
  S.playing = false;
  setPlayBtnState(false);
  S.rateIdx = 0;
  setPlaybackRate(1);
}
function startPlayback() {
  if (S.currentSeg < 0) seekTl(0, { play: true });
  else video.play().catch(() => {});
  S.playing = true;
  setPlayBtnState(true);
}

$('playBtn').onclick = () => {
  if (S.playing) stopPlayback();
  else startPlayback();
};

// Global 1-key shortcuts are disabled while focus is inside a button/select/
// [role=tab]/dialog — those elements have their own key handling (native
// Space/Enter activation, tab arrow-navigation, dialog Esc-to-close), and
// letting the document-level handler also fire would double-trigger or
// hijack keys the control itself needs (see item 15 in the UX/a11y pass).
function globalShortcutsBlocked(target) {
  return !!target?.closest?.('button, select, [role="tab"], dialog');
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
const tlEl = $('timeline');
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
    $('rangeInfo').textContent = `IN ${fmt(S.rangeIn)} – OUT ${fmt(S.rangeOut)} (${fmt(S.rangeOut - S.rangeIn)})`;
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
  clearRange();
  await mutate({ op: 'remove-range', sourceId, t0, t1 });
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

function renderTimeline() {
  const clips = $('clips');
  clips.innerHTML = '';
  S.segments.forEach((s, idx) => {
    const d = document.createElement('div');
    // Alternate shade per clip (even within the same source) so adjacent clip
    // boundaries stay visible; the boundary itself gets a thin divider line.
    d.className = 'clip' + (idx % 2 ? ' alt' : '') + (S.selectedClip === s.clipId ? ' sel' : '');
    d.style.left = `${(s.tlStart / S.duration) * 100}%`;
    d.style.width = `${((s.tlEnd - s.tlStart) / S.duration) * 100}%`;
    d.title = `${s.clipId} (${fmt(s.tlEnd - s.tlStart)})`;
    // Select on click but let the event bubble so the strip's scrub handler
    // still seeks to the pointer position.
    d.onpointerdown = () => selectClip(s.clipId);
    clips.appendChild(d);
  });
  renderSceneMarks();
  const mrow = $('motionRow');
  mrow.innerHTML = '';
  for (const mo of S.manifest.timeline.motion) {
    const d = document.createElement('div');
    d.className = 'moBlock';
    d.style.left = `${(mo.tlStart / S.duration) * 100}%`;
    d.style.width = `${(mo.duration / S.duration) * 100}%`;
    d.textContent = mo.id;
    mrow.appendChild(d);
  }
  drawWave();
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
  video.style.objectPosition = '50% 50%';
  video.pause();
  const url = proxyUrl(sourceId);
  const apply = () => { video.currentTime = at; video.play().catch(() => {}); };
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
function setMediaFocus(sourceId, { focus = true } = {}) {
  S.mediaFocusKey = sourceId;
  for (const r of document.querySelectorAll('#mediaList .srcRow')) {
    r.tabIndex = r.dataset.source === sourceId ? 0 : -1;
  }
  if (focus) document.querySelector(`.srcRow[data-source="${CSS.escape(sourceId)}"]`)?.focus();
}
async function addSourceToTimeline(src) {
  const name = basename(src.path);
  const { ok } = await mutate({ op: 'clip-add', sourceId: src.id });
  if (ok) toast(`${name} を追加 (+${src.duration.toFixed(1)}s)`);
}
async function addSceneToTimeline(src, sc) {
  const name = basename(src.path);
  const dur = Math.max(0, sc.t1 - sc.t0);
  const { ok } = await mutate({ op: 'clip-add', sourceId: src.id, in: sc.t0, out: sc.t1 });
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
  for (const sc of scenes) {
    const dur = Math.max(0, sc.t1 - sc.t0);
    const item = document.createElement('div');
    item.className = 'sceneItem';
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
    addBtn.onclick = () => addSceneToTimeline(src, sc);
    item.appendChild(addBtn);
    wrap.appendChild(item);
  }
  return wrap;
}
function mediaRow(src) {
  const name = basename(src.path);
  const used = sourceUsageSeconds(src.id);
  const pct = src.duration > 0 ? Math.min(100, (used / src.duration) * 100) : 0;

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
  const badges = document.createElement('div');
  badges.className = 'srcBadges';
  badges.innerHTML = [
    src.transcribed ? '<span class="badge ok">文字起こし済み</span>' : '',
    !src.hasAudio ? '<span class="badge warn">音声なし</span>' : '',
    !src.proxy ? '<span class="badge warn">プロキシ未生成</span>' : '',
  ].join('');
  const usage = document.createElement('div');
  usage.className = 'srcUsage';
  usage.innerHTML = `<span class="srcUsageBar"><span class="srcUsageFill" style="width:${pct}%"></span></span><span class="srcUsageLabel">使用 ${used.toFixed(1)}s / ${src.duration.toFixed(1)}s</span>`;
  info.append(nameRow, badges, usage);

  const actions = document.createElement('div');
  actions.className = 'srcActions';
  const addBtn = document.createElement('button');
  addBtn.textContent = 'タイムラインへ追加';
  addBtn.setAttribute('aria-label', `${name} をタイムラインへ追加`);
  addBtn.onclick = (e) => { e.stopPropagation(); addSourceToTimeline(src); };
  actions.appendChild(addBtn);
  if (S.scenes.has(src.id)) {
    const expanded = S.expandedScenes.has(src.id);
    const scenesBtn = document.createElement('button');
    scenesBtn.className = 'btn-viewScenes';
    scenesBtn.textContent = 'シーンを見る';
    scenesBtn.setAttribute('aria-expanded', String(expanded));
    scenesBtn.setAttribute('aria-label', `${name} のシーンを${expanded ? '閉じる' : '見る'}`);
    scenesBtn.onclick = (e) => { e.stopPropagation(); toggleScenes(src.id); };
    actions.appendChild(scenesBtn);
  }

  row.append(img, info, actions);
  row.addEventListener('pointerdown', () => setMediaFocus(src.id, { focus: false }));
  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    setMediaFocus(src.id);
    enterSourcePreview(src.id);
  });
  return row;
}
function renderMediaPanel() {
  const el = $('mediaList');
  el.innerHTML = '';
  const sources = S.manifest.sources;
  if (sources.length === 0) {
    el.innerHTML = '<div class="hintText" style="padding:8px">素材がありません — `vedit ingest <file>` で取り込み</div>';
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
$('mediaList').addEventListener('keydown', (e) => {
  const row = e.target.closest('.srcRow');
  if (!row) return;
  const sources = S.manifest.sources;
  const idx = sources.findIndex((s) => s.id === row.dataset.source);
  if (idx < 0) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setMediaFocus(sources[Math.min(idx + 1, sources.length - 1)].id); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setMediaFocus(sources[Math.max(idx - 1, 0)].id); }
  else if (e.key === 'Home') { e.preventDefault(); setMediaFocus(sources[0].id); }
  else if (e.key === 'End') { e.preventDefault(); setMediaFocus(sources[sources.length - 1].id); }
  else if (e.key === 'Enter') { e.preventDefault(); enterSourcePreview(row.dataset.source); }
});

// ---------- clip inspector (±frame trim) ----------
function selectClip(clipId) {
  S.selectedClip = clipId;
  $('clipInspector').hidden = !clipId;
  if (clipId) $('clipLabel').textContent = clipId;
  renderTimeline();
}
$('clipClose').onclick = () => selectClip(null);
for (const b of document.querySelectorAll('[data-trim]')) {
  b.onclick = async () => {
    if (!S.selectedClip) return;
    const [edge, f] = b.dataset.trim.split(':');
    await mutate({ op: 'trim', clipId: S.selectedClip, edge, frames: Number(f) });
  };
}
$('clipRemoveBtn').onclick = async () => {
  if (!S.selectedClip) return;
  if (!confirm('このクリップをタイムラインから外しますか？(素材は残ります)')) return;
  const clipId = S.selectedClip;
  selectClip(null);
  await mutate({ op: 'clip-remove', clipId });
};

// ---------- captions & motion overlays ----------
function renderCaption(tl) {
  const layer = $('captionLayer');
  layer.className = `style-${S.manifest?.captions.style ?? 'clean'}`;
  const cue = S.manifest?.captions.enabled ? S.cues.find((c) => tl >= c.tlStart && tl < c.tlEnd) : null;
  const text = cue ? cue.text : '';
  if (layer.dataset.cur !== text) {
    layer.dataset.cur = text;
    layer.innerHTML = text ? `<span class="cue">${esc(text)}</span>` : '';
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

function renderTranscript() {
  const el = $('words');
  el.innerHTML = '';
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
    heading.textContent = `📄 ${basename(src.path)} (${src.id})`;
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
      const s = document.createElement('span');
      s.className = 'w' + (kept.has(w.id) ? '' : ' cut') + (selected ? ' sel' : '') + (cand ? ' ignored' : '');
      s.textContent = w.text;
      s.dataset.id = w.id;
      s.dataset.src = src.id;
      s.setAttribute('role', 'option');
      s.setAttribute('aria-selected', String(selected));
      if (!S.focusKey) S.focusKey = key; // default roving-tabindex stop: first word
      s.tabIndex = key === S.focusKey ? 0 : -1;
      s.title = cand
        ? `却下済み: ${cand.label}(再検出で再提案されます)`
        : `${w.id} ${w.t0.toFixed(2)}–${w.t1.toFixed(2)}s`;
      el.appendChild(s);
      prev = w;
    }
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
    { conflictMessage: '削除は適用されませんでした。最新状態を確認してもう一度実行してください' },
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

// Map a candidate's (padded) source-time point to a timeline seconds value,
// clamped to the segment that currently contains its source range — used by
// both the row's seek-on-click and the "前後を再生" preview.
function candidateTl(t, c) {
  const seg = S.segments.find((s) => s.sourceId === c.sourceId && t >= s.srcStart - 2 && t <= s.srcStart + (s.tlEnd - s.tlStart) + 2);
  if (!seg) return null;
  const clamped = Math.max(seg.srcStart, Math.min(t, seg.srcStart + (seg.tlEnd - seg.tlStart)));
  return seg.tlStart + (clamped - seg.srcStart);
}

function candRow(c) {
  const d = document.createElement('div');
  d.className = 'cand';
  d.tabIndex = 0;
  const dur = Math.max(0, c.t1 - c.t0);
  const src = S.manifest.sources.find((s) => s.id === c.sourceId);
  const srcName = src ? basename(src.path) : c.sourceId;
  const timeRange = `${fmt(c.t0)}–${fmt(c.t1)}`;
  d.innerHTML = `<span class="kind ${c.kind}">${esc(KIND_LABEL[c.kind] ?? c.kind)}</span><span class="lbl">${esc(c.label)}</span><span class="srcTag">${esc(srcName)} ${timeRange}</span><span class="dur">-${dur.toFixed(1)}s</span>`;
  d.setAttribute('aria-label', `${KIND_LABEL[c.kind] ?? c.kind}: ${c.label}(${srcName} ${timeRange}, -${dur.toFixed(1)}秒)`);
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
  preview.setAttribute('aria-label', `${c.label} の前後を再生`);
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
  ok.textContent = 'カット適用';
  ok.setAttribute('aria-label', `${c.label} をカット適用`);
  ok.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'approve'); };
  const ng = document.createElement('button');
  ng.className = 'btn-reject';
  ng.textContent = '残す';
  ng.setAttribute('aria-label', `${c.label} を残す(却下)`);
  ng.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'reject'); };
  const actions = document.createElement('div');
  actions.className = 'candActions';
  actions.append(preview, ok, ng);
  d.append(actions);
  return d;
}

function renderCandidates() {
  $('candCount').textContent = S.candidates.length ? `(${S.candidates.length})` : '';
  const el = $('candList');
  el.innerHTML = '';
  if (S.candidates.length === 0) { el.innerHTML = '<div class="hintText" style="padding:8px">提案はありません。Claude に「無音とフィラーを検出して」と頼むか、CLI で `vedit detect`。</div>'; return; }

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
    header.innerHTML = `<span class="kind ${kind}">${KIND_LABEL[kind] ?? kind}</span><span class="hintText">${list.length}件 / 計-${totalDur.toFixed(1)}s</span><span class="spacer"></span>`;
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn-approve';
    approveBtn.textContent = 'まとめて承認';
    approveBtn.onclick = () => decide(list.map((c) => c.id), 'approve');
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn-reject';
    rejectBtn.textContent = 'まとめて却下';
    rejectBtn.onclick = () => decide(list.map((c) => c.id), 'reject');
    header.append(approveBtn, rejectBtn);
    group.appendChild(header);
    for (const c of list) group.appendChild(candRow(c));
    el.appendChild(group);
  }
}
$('approveAllBtn').onclick = () => {
  const n = S.candidates.length;
  if (n === 0) return;
  const totalDur = S.candidates.reduce((sum, c) => sum + Math.max(0, c.t1 - c.t0), 0);
  if (!confirm(`${n}件・合計−${totalDur.toFixed(1)}s を適用します`)) return;
  decide('all', 'approve');
};

// ---------- detection threshold ----------
$('minGapRange').oninput = (e) => {
  S.detectMinGap = Number(e.target.value);
  $('minGapVal').textContent = `${S.detectMinGap.toFixed(1)}s`;
};
$('redetectBtn').onclick = async () => {
  try {
    await api('/api/detect', { method: 'POST', body: JSON.stringify({ minGap: S.detectMinGap }) });
    toast(`しきい値 ${S.detectMinGap.toFixed(1)}s で再検出しました`);
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
  await reload().catch(() => {});
};

// Moves focus to the "next" candidate row after a decide()/reload() re-render
// (the decided rows disappear from the list), or to the panel itself if none
// remain — so keyboard/screen-reader users never lose their place.
function focusAfterCandidateDecision(anchorIdx) {
  const rows = [...document.querySelectorAll('#candList .cand')];
  if (rows.length === 0) { $('candPanel').focus(); return; }
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
}

// ---------- history / undo ----------
function focusAfterHistoryAction() {
  const rows = [...document.querySelectorAll('#histList .restoreBtn')];
  if (rows.length === 0) { $('histPanel').focus(); return; }
  rows[0].focus();
}
async function restoreToRevision(rev) {
  const { ok } = await mutate({ op: 'restore', rev });
  if (ok) toast(`r${rev} に戻しました。ほかの版を確認するには「履歴」タブを開いてください`);
  // renderHistory() always rebuilds #histList's DOM on reload, so the
  // clicked button is stale either way — always re-focus something so focus
  // never silently drops to <body>, on both success and (post-reload) failure.
  focusAfterHistoryAction();
}
function renderHistory() {
  const el = $('histList');
  el.innerHTML = '';
  for (const r of [...S.revisions].reverse()) {
    const d = document.createElement('div');
    d.className = 'hist';
    const info = document.createElement('span');
    info.innerHTML = `<b>r${r.rev}</b> [${r.actor}] ${esc(r.summary)}`;
    d.appendChild(info);
    if (r.rev !== S.manifest.revision) {
      const btn = document.createElement('button');
      btn.className = 'restoreBtn';
      btn.textContent = 'ここに戻す';
      btn.onclick = async () => {
        if (!confirm(`r${r.rev} 「${r.summary}」に戻しますか？`)) return;
        await restoreToRevision(r.rev);
      };
      d.appendChild(btn);
    }
    el.appendChild(d);
  }
}
function updateUndoBtn() {
  const btn = $('undoBtn');
  const rev = S.manifest?.revision ?? 0;
  if (rev <= 1) {
    btn.textContent = '⟲ 戻せません';
    btn.disabled = true;
    btn.setAttribute('aria-label', '戻せるリビジョンがありません');
  } else {
    btn.textContent = `⟲ r${rev - 1}へ戻す`;
    btn.disabled = false;
    btn.setAttribute('aria-label', `r${rev - 1}へ戻す`);
  }
}
$('undoBtn').onclick = async () => {
  const rev = S.manifest?.revision ?? 0;
  if (rev <= 1) { toast('戻せるリビジョンがありません', { type: 'error' }); return; }
  await restoreToRevision(rev - 1);
};

// ---------- shared mutation path ----------
// Returns {ok, conflict} instead of throwing so callers can decide what to
// preserve (e.g. keep the transcript selection alive) when a 409 happens.
async function mutate(body, opts = {}) {
  try {
    await api('/api/edit', {
      method: 'POST',
      body: JSON.stringify({ baseRev: S.manifest.revision, actor: 'ui', ...body }),
    });
    await reload();
    return { ok: true, conflict: false };
  } catch (e) {
    const conflict = e.status === 409;
    const msg = conflict ? (opts.conflictMessage ?? '他の編集と競合しました。最新状態を再読み込みしました') : e.message;
    toast(msg, { type: 'error' });
    await reload().catch(() => {});
    return { ok: false, conflict };
  }
}

let toastTimer;
function toast(msg, opts = {}) {
  const t = $('toast');
  const isError = opts.type === 'error';
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (isError) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toastClose';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    closeBtn.onclick = () => { t.hidden = true; };
    t.appendChild(closeBtn);
  }
  t.setAttribute('role', isError ? 'alert' : 'status');
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!isError) {
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }
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

// ---------- websocket live updates ----------
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    const el = $('conn');
    el.classList.add('up');
    el.textContent = '● 接続済み';
    el.title = '接続済み';
  };
  ws.onclose = () => {
    const el = $('conn');
    el.classList.remove('up');
    el.textContent = '● 再接続中';
    el.title = '再接続中';
    setTimeout(connectWs, 1500);
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ingest-start') {
      $('ingestOverlay').hidden = false;
      $('ingestStep').textContent = '取り込み中...';
      $('stage').setAttribute('aria-busy', 'true');
    }
    if (msg.type === 'ingest-progress') $('ingestStep').textContent = msg.step;
    if (msg.type === 'update' || msg.type === 'candidates' || msg.type === 'project') {
      $('ingestOverlay').hidden = true;
      $('stage').removeAttribute('aria-busy');
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
      if (msg.summary) toast(`r${msg.revision ?? ''}: ${msg.summary}`);
    }
  };
}

// ---------- render root ----------
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function aspectLabel(w, h) {
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}
function renderStat() {
  const m = S.manifest;
  const out = m.output;
  $('stat').textContent = out
    ? `${fmt(S.duration)} / 出力 ${out.width}×${out.height} (${aspectLabel(out.width, out.height)}) · 素材 ${m.width}×${m.height} ${Math.round(m.fps)}fps`
    : `${fmt(S.duration)} / ${m.width}×${m.height} ${Math.round(m.fps)}fps`;
}
async function renderAll() {
  const m = S.manifest;
  $('projName').textContent = m.name;
  renderStat();
  $('revLabel').textContent = `rev ${m.revision}`;
  updateUndoBtn();
  await loadMotionSpecs();
  renderTimeline();
  renderTranscript();
  renderCandidates();
  renderHistory();
  renderMediaPanel();
  renderRange();
  updateFraming();
  renderStageState();
}

window.addEventListener('resize', drawWave);
// Connect the socket and start the frame loop unconditionally — tick() is a
// no-op until a segment is loaded — so that if the initial /api/project call
// fails (e.g. "no project open"), the UI still hears about a project being
// opened later (via `vedit open`) instead of being stuck until a manual
// browser refresh.
connectWs();
requestAnimationFrame(tick);
reload().then(() => {
  if (S.segments.length) loadSeg(0, { play: false });
}).catch((e) => toast(e.message, { type: 'error' }));
