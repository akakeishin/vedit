// vedit Web NLE v1 — proxy playback mapped through the timeline, DOM overlays
// for captions/motion, transcript selection, candidate approve/reject.
// All mutations go through the same revision-checked API Claude uses.

const $ = (id) => document.getElementById(id);
const video = $('video');

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
  selWords: new Set(),
  selAnchor: null,
  selectedClip: null,
  detectMinGap: 0.7,
  rateIdx: 0, // index into PLAY_RATES, cycled by repeated L presses
  rangeIn: null, // timeline seconds
  rangeOut: null, // timeline seconds
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
  const pr = await api('/api/project');
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
  renderAll();
}

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

// manifest.output present -> lock #videoWrap to that aspect (object-fit:
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
  tl = Math.max(0, Math.min(tl, S.duration - 0.001));
  let i = segAt(tl);
  if (i < 0) i = S.segments.length - 1;
  loadSeg(i, { play: play ?? S.playing, offset: tl - S.segments[i].tlStart });
}

// The frame loop: cross segment boundaries, drive playhead/captions/motion.
function tick() {
  const i = S.currentSeg;
  if (i >= 0 && S.segments[i]) {
    const s = S.segments[i];
    if (!video.paused && video.currentTime >= s.srcStart + (s.tlEnd - s.tlStart) - 0.02) {
      if (i + 1 < S.segments.length) loadSeg(i + 1, { play: true });
      else { video.pause(); S.playing = false; $('playBtn').textContent = '▶'; }
    }
    const tl = tlNow();
    $('playhead').style.left = `${(tl / S.duration) * 100}%`;
    $('tc').textContent = `${fmtF(tl)} / ${fmtF(S.duration)}`;
    renderCaption(tl);
    renderMotion(tl);
    highlightWord(tl);
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
function stopPlayback() {
  video.pause();
  S.playing = false;
  $('playBtn').textContent = '▶';
  S.rateIdx = 0;
  setPlaybackRate(1);
}
function startPlayback() {
  if (S.currentSeg < 0) seekTl(0, { play: true });
  else video.play().catch(() => {});
  S.playing = true;
  $('playBtn').textContent = '⏸';
}

$('playBtn').onclick = () => {
  if (S.playing) stopPlayback();
  else startPlayback();
};
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
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
    $('playBtn').textContent = '⏸';
    return;
  }
  if (e.key === ',') { e.preventDefault(); seekTl(tlNow() - 1 / S.manifest.fps); return; }
  if (e.key === '.') { e.preventDefault(); seekTl(tlNow() + 1 / S.manifest.fps); return; }
  if (key === 'i') { e.preventDefault(); setRangePoint('in'); return; }
  if (key === 'o') { e.preventDefault(); setRangePoint('out'); return; }
  if (e.key === '?') { e.preventDefault(); toggleShortcuts(); return; }
  if (e.code === 'Escape') { e.preventDefault(); clearRange(); return; }
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
    toast('複数クリップにまたがる範囲は未対応です');
    return;
  }
  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  const t0 = first.srcStart + Math.max(0, S.rangeIn - first.tlStart);
  const t1 = last.srcStart + Math.min(last.tlEnd - last.tlStart, S.rangeOut - last.tlStart);
  clearRange();
  await mutate({ op: 'remove-range', sourceId, t0, t1 });
};

// ---------- shortcuts overlay ----------
function toggleShortcuts() {
  const el = $('shortcutsOverlay');
  el.hidden = !el.hidden;
}
$('shortcutsBtn').onclick = toggleShortcuts;
$('shortcutsCloseBtn').onclick = toggleShortcuts;
$('shortcutsOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'shortcutsOverlay') toggleShortcuts();
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
  g.fillStyle = '#39424f';
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

// wordId -> rejected candidate (for the non-destructive "ignored" overlay,
// Descript-style: a rejected cut candidate stays visible, struck through faintly,
// rather than disappearing without a trace).
function rejectedWordMap() {
  const m = new Map();
  for (const c of S.candidatesAll) {
    if (c.status !== 'rejected') continue;
    for (const id of c.wordIds ?? []) m.set(id, c);
  }
  return m;
}

function renderTranscript() {
  const el = $('words');
  el.innerHTML = '';
  const ignored = rejectedWordMap();
  for (const src of S.manifest.sources) {
    const words = S.transcripts.get(src.id);
    if (!words) continue;
    const kept = keptSet(src.id);
    let prev = null;
    for (const w of words) {
      if (prev && w.t0 - prev.t1 >= 0.7) {
        const g = document.createElement('span');
        g.className = 'gap';
        g.textContent = `〔${(w.t0 - prev.t1).toFixed(1)}s〕`;
        el.appendChild(g);
      }
      const s = document.createElement('span');
      const cand = ignored.get(w.id);
      s.className = 'w' + (kept.has(w.id) ? '' : ' cut') + (S.selWords.has(w.id) ? ' sel' : '') + (cand ? ' ignored' : '');
      s.textContent = w.text;
      s.dataset.id = w.id;
      s.dataset.src = src.id;
      s.title = cand
        ? `却下済み: ${cand.label}(クリックで復元=再提案)`
        : `${w.id} ${w.t0.toFixed(2)}–${w.t1.toFixed(2)}s`;
      el.appendChild(s);
      prev = w;
    }
  }
}

// selection: pointerdown starts, drag extends, click seeks
let dragging = false;
$('words').addEventListener('pointerdown', (e) => {
  const t = e.target.closest('.w');
  if (!t) return;
  dragging = true;
  S.selAnchor = t.dataset.id;
  S.selWords = new Set([t.dataset.id]);
  renderTranscript();
  updateSelBtn();
});
$('words').addEventListener('pointerover', (e) => {
  if (!dragging) return;
  const t = e.target.closest('.w');
  if (!t) return;
  const srcId = t.dataset.src;
  const words = S.transcripts.get(srcId) ?? [];
  const ids = words.map((w) => w.id);
  const a = ids.indexOf(S.selAnchor);
  const b = ids.indexOf(t.dataset.id);
  if (a < 0 || b < 0) return;
  S.selWords = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  renderTranscript();
  updateSelBtn();
});
window.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (S.selWords.size === 1) {
    // treat as click: seek to word if it's on the timeline
    const id = [...S.selWords][0];
    const t = e.target.closest?.('.w');
    const srcId = t?.dataset.src ?? S.manifest.sources[0].id;
    const w = (S.transcripts.get(srcId) ?? []).find((x) => x.id === id);
    if (w) {
      const seg = S.segments.find((s) => s.sourceId === srcId && (w.t0 + w.t1) / 2 >= s.srcStart && (w.t0 + w.t1) / 2 < s.srcStart + (s.tlEnd - s.tlStart));
      if (seg) seekTl(seg.tlStart + (w.t0 + w.t1) / 2 - seg.srcStart, { play: false });
    }
    S.selWords.clear();
    renderTranscript();
  }
  updateSelBtn();
});
function updateSelBtn() {
  $('removeSelBtn').disabled = S.selWords.size < 1;
  $('removeSelBtn').textContent = S.selWords.size > 0 ? `選択を削除 (${S.selWords.size}語)` : '選択を削除';
}
$('removeSelBtn').onclick = async () => {
  if (S.selWords.size === 0) return;
  const srcId = document.querySelector(`.w[data-id="${[...S.selWords][0]}"]`)?.dataset.src;
  await mutate({ op: 'remove-words', ids: [...S.selWords], sourceId: srcId });
  S.selWords.clear();
  updateSelBtn();
};

function highlightWord(tl) {
  const i = S.currentSeg;
  if (i < 0) return;
  const s = S.segments[i];
  const srcT = s.srcStart + (tl - s.tlStart);
  const words = S.transcripts.get(s.sourceId) ?? [];
  const w = words.find((x) => srcT >= x.t0 && srcT < x.t1);
  const cur = document.querySelector('.w.active');
  if (cur && cur.dataset.id !== w?.id) cur.classList.remove('active');
  if (w) document.querySelector(`.w[data-id="${w.id}"]`)?.classList.add('active');
}

// ---------- candidates ----------
const KIND_LABEL = { silence: '無音', filler: 'フィラー', retake: '言い直し', 'low-energy': '低テンション' };
const KIND_ORDER = ['silence', 'filler', 'retake', 'low-energy'];

function candRow(c) {
  const d = document.createElement('div');
  d.className = 'cand';
  const dur = Math.max(0, c.t1 - c.t0);
  d.innerHTML = `<span class="kind ${c.kind}">${c.kind}</span><span class="lbl">${esc(c.label)}</span><span class="dur">-${dur.toFixed(1)}s</span>`;
  d.onclick = () => {
    // seek near the candidate (it may already be cut away)
    const seg = S.segments.find((s) => s.sourceId === c.sourceId && c.t0 >= s.srcStart - 2 && c.t0 <= s.srcStart + (s.tlEnd - s.tlStart) + 2);
    if (seg) seekTl(seg.tlStart + Math.max(0, Math.min(c.t0 - seg.srcStart, seg.tlEnd - seg.tlStart - 0.1)), { play: false });
  };
  const ok = document.createElement('button');
  ok.className = 'btn-approve';
  ok.textContent = '✓';
  ok.title = '承認(カット適用)';
  ok.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'approve'); };
  const ng = document.createElement('button');
  ng.className = 'btn-reject';
  ng.textContent = '✕';
  ng.title = '却下';
  ng.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'reject'); };
  d.append(ok, ng);
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
$('approveAllBtn').onclick = () => decide('all', 'approve');

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
    toast(e.message);
  }
  await reload();
};
async function decide(ids, decision) {
  try {
    await api('/api/candidates/decide', {
      method: 'POST',
      body: JSON.stringify({ ids, decision, actor: 'ui', baseRev: S.manifest.revision }),
    });
  } catch (e) {
    toast(e.status === 409 ? '他の編集と競合しました。最新状態を再読込します' : e.message);
  }
  await reload();
}

// ---------- history / undo ----------
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
        await mutate({ op: 'restore', rev: r.rev });
      };
      d.appendChild(btn);
    }
    el.appendChild(d);
  }
}
$('undoBtn').onclick = async () => {
  const last = S.revisions.at(-1);
  if (!last || last.rev <= 1) return toast('戻せるリビジョンがありません');
  await mutate({ op: 'restore', rev: last.rev - 1 });
};

// ---------- shared mutation path ----------
async function mutate(body) {
  try {
    await api('/api/edit', {
      method: 'POST',
      body: JSON.stringify({ baseRev: S.manifest.revision, actor: 'ui', ...body }),
    });
  } catch (e) {
    toast(e.status === 409 ? '他の編集と競合しました。再読込しました' : e.message);
  }
  await reload();
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- tabs ----------
for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.panel).classList.add('active');
  };
}

// ---------- websocket live updates ----------
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => $('conn').classList.add('up');
  ws.onclose = () => { $('conn').classList.remove('up'); setTimeout(connectWs, 1500); };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'ingest-start') { $('ingestOverlay').hidden = false; $('ingestStep').textContent = '取り込み中...'; }
    if (msg.type === 'ingest-progress') $('ingestStep').textContent = msg.step;
    if (msg.type === 'update' || msg.type === 'candidates' || msg.type === 'project') {
      $('ingestOverlay').hidden = true;
      const tl = tlNow();
      await reload();
      if (msg.type === 'update') seekTl(Math.min(tl, S.duration - 0.01), { play: false });
      if (msg.summary) toast(`r${msg.revision ?? ''}: ${msg.summary}`);
    }
  };
}

// ---------- render root ----------
async function renderAll() {
  const m = S.manifest;
  $('projName').textContent = m.name;
  $('stat').textContent = `${fmt(S.duration)} / ${m.width}×${m.height} ${Math.round(m.fps)}fps`;
  $('revLabel').textContent = `rev ${m.revision}`;
  await loadMotionSpecs();
  renderTimeline();
  renderTranscript();
  renderCandidates();
  renderHistory();
  renderRange();
  updateFraming();
}

window.addEventListener('resize', drawWave);
reload().then(() => {
  if (S.segments.length) loadSeg(0, { play: false });
  requestAnimationFrame(tick);
  connectWs();
}).catch((e) => toast(e.message));
