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
  revisions: [],
  peaks: new Map(), // sourceId -> {rate, peaks}
  currentSeg: -1,
  playing: false,
  selWords: new Set(),
  selAnchor: null,
  selectedClip: null,
};

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
  S.revisions = await api('/api/revisions');
  for (const src of S.manifest.sources) {
    if (src.transcribed && !S.transcripts.has(src.id)) {
      const t = await api(`/api/transcript?full=1&source=${src.id}`);
      S.transcripts.set(src.id, t.words);
    }
    if (src.peaks && !S.peaks.has(src.id)) {
      S.peaks.set(src.id, await api(`/media/peaks/${src.id}`));
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
    $('tc').textContent = `${fmt(tl)} / ${fmt(S.duration)}`;
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

$('playBtn').onclick = () => {
  if (S.playing) { video.pause(); S.playing = false; $('playBtn').textContent = '▶'; }
  else {
    if (S.currentSeg < 0) seekTl(0, { play: true });
    else video.play().catch(() => {});
    S.playing = true; $('playBtn').textContent = '⏸';
  }
};
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
  if (e.code === 'ArrowLeft') seekTl(tlNow() - (e.shiftKey ? 1 / S.manifest.fps : 1));
  if (e.code === 'ArrowRight') seekTl(tlNow() + (e.shiftKey ? 1 / S.manifest.fps : 1));
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

function renderTimeline() {
  const clips = $('clips');
  clips.innerHTML = '';
  for (const s of S.segments) {
    const d = document.createElement('div');
    d.className = 'clip' + (S.selectedClip === s.clipId ? ' sel' : '');
    d.style.left = `${(s.tlStart / S.duration) * 100}%`;
    d.style.width = `${((s.tlEnd - s.tlStart) / S.duration) * 100}%`;
    d.title = `${s.clipId} (${fmt(s.tlEnd - s.tlStart)})`;
    d.onpointerdown = (e) => { e.stopPropagation(); selectClip(s.clipId); seekTl(s.tlStart); };
    clips.appendChild(d);
  }
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

function renderTranscript() {
  const el = $('words');
  el.innerHTML = '';
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
      s.className = 'w' + (kept.has(w.id) ? '' : ' cut') + (S.selWords.has(w.id) ? ' sel' : '');
      s.textContent = w.text;
      s.dataset.id = w.id;
      s.dataset.src = src.id;
      s.title = `${w.id} ${w.t0.toFixed(2)}–${w.t1.toFixed(2)}s`;
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
function renderCandidates() {
  $('candCount').textContent = S.candidates.length ? `(${S.candidates.length})` : '';
  const el = $('candList');
  el.innerHTML = '';
  if (S.candidates.length === 0) el.innerHTML = '<div class="hintText" style="padding:8px">提案はありません。Claude に「無音とフィラーを検出して」と頼むか、CLI で `vedit detect`。</div>';
  for (const c of S.candidates) {
    const d = document.createElement('div');
    d.className = 'cand';
    d.innerHTML = `<span class="kind ${c.kind}">${c.kind}</span><span class="lbl">${esc(c.label)}</span>`;
    d.onclick = () => {
      // seek near the candidate (it may already be cut away)
      const seg = S.segments.find((s) => s.sourceId === c.sourceId && c.t0 >= s.srcStart - 2 && c.t0 <= s.srcStart + (s.tlEnd - s.tlStart) + 2);
      if (seg) seekTl(seg.tlStart + Math.max(0, Math.min(c.t0 - seg.srcStart, seg.tlEnd - seg.tlStart - 0.1)), { play: false });
    };
    const ok = document.createElement('button');
    ok.textContent = '✓';
    ok.title = '承認(カット適用)';
    ok.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'approve'); };
    const ng = document.createElement('button');
    ng.textContent = '✕';
    ng.title = '却下';
    ng.onclick = async (e) => { e.stopPropagation(); await decide([c.id], 'reject'); };
    d.append(ok, ng);
    el.appendChild(d);
  }
}
$('approveAllBtn').onclick = () => decide('all', 'approve');
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
    d.innerHTML = `<b>r${r.rev}</b> [${r.actor}] ${esc(r.summary)}`;
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
}

window.addEventListener('resize', drawWave);
reload().then(() => {
  if (S.segments.length) loadSeg(0, { play: false });
  requestAnimationFrame(tick);
  connectWs();
}).catch((e) => toast(e.message));
