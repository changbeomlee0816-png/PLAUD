import * as db from './db.js';
import { LANGUAGES, langLabel, suggestLangFromDevice, suggestLangFromCoords } from './i18n.js';
import { AudioRecorder } from './recorder.js';
import { Transcriber, isSupported as sttSupported } from './transcriber.js';
import { summarize, fmtTime } from './summarizer.js';

const $ = (id) => document.getElementById(id);
const el = {
  // views
  listView: $('listView'), recordView: $('recordView'), detailView: $('detailView'),
  recordingList: $('recordingList'), listEmpty: $('listEmpty'),
  // storage
  storageText: $('storageText'), storageBtn: $('storageBtn'),
  // record
  langSelect: $('langSelect'), detectLangBtn: $('detectLangBtn'),
  waveCanvas: $('waveCanvas'), recTimer: $('recTimer'), recStatus: $('recStatus'),
  liveTranscript: $('liveTranscript'),
  recToggleBtn: $('recToggleBtn'), pauseRecBtn: $('pauseRecBtn'), cancelRecBtn: $('cancelRecBtn'),
  // detail
  backBtn: $('backBtn'), titleInput: $('titleInput'), detailMeta: $('detailMeta'),
  player: $('player'), reLangBtn: $('reLangBtn'), deleteBtn: $('deleteBtn'),
  tabSummary: $('tabSummary'), tabTimeline: $('tabTimeline'), tabTranscript: $('tabTranscript'),
  // nav
  navList: $('navList'), navRecord: $('navRecord'), navSettings: $('navSettings'),
  // settings
  settingsSheet: $('settingsSheet'), closeSettings: $('closeSettings'),
  capInput: $('capInput'), defaultLangSelect: $('defaultLangSelect'),
  apiEndpointInput: $('apiEndpointInput'), usageDetail: $('usageDetail'), usageFill: $('usageFill'),
  clearAllBtn: $('clearAllBtn'),
  toast: $('toast'),
};

const state = {
  recorder: null,
  transcriber: null,
  segments: [],
  recording: false,
  paused: false,
  startTs: 0,
  pausedMs: 0,
  pauseStart: 0,
  timerId: null,
  currentId: null, // detail view recording id
  capHours: 200,
};

// ---------- utilities ----------
let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- view switching ----------
function showView(name) {
  for (const v of [el.listView, el.recordView, el.detailView]) v.classList.remove('active');
  ({ list: el.listView, record: el.recordView, detail: el.detailView })[name].classList.add('active');
  el.navList.classList.toggle('active', name === 'list');
}

// ---------- language selects ----------
function fillLangSelect(select, selected) {
  select.innerHTML = '';
  for (const l of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.label;
    if (l.code === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

// ---------- storage indicator ----------
async function refreshStorageIndicator() {
  const totalSec = await db.totalDurationSec();
  const hours = totalSec / 3600;
  el.storageText.textContent = hours < 1 ? `${Math.round(totalSec / 60)}m` : `${hours.toFixed(1)}h`;
  el.storageBtn.querySelector('.storage-sub').textContent = `/ ${state.capHours}h`;

  const pct = Math.min(100, (hours / state.capHours) * 100);
  el.usageFill.style.width = pct + '%';
  el.usageFill.classList.toggle('warn', pct > 80);
  el.usageDetail.textContent = `${hours.toFixed(1)}h / ${state.capHours}h`;
}

// ---------- list ----------
async function renderList() {
  const all = await db.getAllRecordings();
  el.listEmpty.style.display = all.length ? 'none' : 'block';
  el.recordingList.innerHTML = '';
  for (const r of all) {
    const li = document.createElement('li');
    li.className = 'rec-card';
    const snippet = (r.summary && r.summary.overview) ||
      (r.segments && r.segments.map((s) => s.text).join(' ')) || '전사 내용이 없습니다.';
    li.innerHTML = `
      <div class="rc-top">
        <span class="rc-title">${escapeHtml(r.title || '제목 없음')}</span>
        <span class="rc-dur">${fmtDuration(r.durationSec)}</span>
      </div>
      <div class="rc-snip">${escapeHtml(snippet)}</div>
      <div class="rc-meta">
        <span class="chip lang">${escapeHtml(langLabel(r.language))}</span>
        ${r.location ? `<span class="chip">📍 ${escapeHtml(r.location)}</span>` : ''}
        <span>${fmtDate(r.createdAt)}</span>
      </div>`;
    li.addEventListener('click', () => openDetail(r.id));
    el.recordingList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- recording flow ----------
function resetRecordUI() {
  state.segments = [];
  state.paused = false;
  state.pausedMs = 0;
  state._pendingLocation = '';
  el.liveTranscript.innerHTML = '<span class="muted">녹음을 시작하면 실시간 전사가 여기에 표시됩니다.</span>';
  el.recTimer.textContent = '00:00';
  el.recStatus.textContent = '준비됨';
  el.recStatus.classList.remove('live');
  el.recToggleBtn.classList.add('idle');
  el.pauseRecBtn.disabled = true;
  el.pauseRecBtn.textContent = '⏸';
  el.navRecord.classList.remove('recording');
}

function renderLive(interim = '') {
  const parts = state.segments.map(
    (s) => `<div class="seg"><span class="seg-time">${fmtClock(s.t)}</span>${escapeHtml(s.text)}</div>`
  );
  if (interim) parts.push(`<div class="seg interim">${escapeHtml(interim)}</div>`);
  el.liveTranscript.innerHTML = parts.join('') ||
    '<span class="muted">음성을 기다리는 중…</span>';
  el.liveTranscript.scrollTop = el.liveTranscript.scrollHeight;
}

function tickTimer() {
  const elapsed = (Date.now() - state.startTs - state.pausedMs) / 1000;
  el.recTimer.textContent = fmtClock(elapsed);
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('이 브라우저는 마이크 녹음을 지원하지 않습니다.');
    return;
  }
  const lang = el.langSelect.value;
  state.recorder = new AudioRecorder(el.waveCanvas);
  try {
    await state.recorder.start();
  } catch (e) {
    toast('마이크 권한이 필요합니다.');
    return;
  }

  state.segments = [];
  state.startTs = Date.now();
  state.pausedMs = 0;
  state.recording = true;
  state.paused = false;

  // Live transcription (best-effort; audio is still saved if unsupported).
  if (sttSupported()) {
    state.transcriber = new Transcriber({
      lang,
      onSegment: (seg) => { state.segments.push(seg); renderLive(); },
      onInterim: (txt) => renderLive(txt),
      onError: (err) => {
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          toast('음성 인식 권한이 거부되었습니다. 오디오만 저장됩니다.');
        }
      },
    });
    state.transcriber.start();
  } else {
    el.liveTranscript.innerHTML =
      '<span class="muted">이 브라우저는 실시간 전사를 지원하지 않습니다. 오디오는 정상 저장됩니다.</span>';
  }

  el.recStatus.textContent = '● 녹음 중';
  el.recStatus.classList.add('live');
  el.recToggleBtn.classList.remove('idle');
  el.pauseRecBtn.disabled = false;
  el.navRecord.classList.add('recording');
  el.langSelect.disabled = true;

  state.timerId = setInterval(tickTimer, 250);
  renderLive();
}

function pauseRecording() {
  if (!state.recording || state.paused) return;
  state.paused = true;
  state.pauseStart = Date.now();
  state.recorder.pause();
  if (state.transcriber) state.transcriber.pause();
  clearInterval(state.timerId);
  el.recStatus.textContent = '⏸ 일시정지';
  el.recStatus.classList.remove('live');
  el.pauseRecBtn.textContent = '▶';
}

function resumeRecording() {
  if (!state.recording || !state.paused) return;
  state.paused = false;
  state.pausedMs += Date.now() - state.pauseStart;
  state.recorder.resume();
  if (state.transcriber) state.transcriber.resume();
  state.timerId = setInterval(tickTimer, 250);
  el.recStatus.textContent = '● 녹음 중';
  el.recStatus.classList.add('live');
  el.pauseRecBtn.textContent = '⏸';
}

async function stopAndSave() {
  if (!state.recording) return;
  clearInterval(state.timerId);
  const durationSec = Math.max(1, Math.round((Date.now() - state.startTs - state.pausedMs) / 1000));
  const lang = el.langSelect.value;

  if (state.transcriber) state.transcriber.stop();
  el.recStatus.textContent = '저장 중…';
  el.recStatus.classList.remove('live');

  const blob = await state.recorder.stop();
  state.recording = false;
  el.langSelect.disabled = false;
  el.navRecord.classList.remove('recording');

  const segments = state.segments.slice();
  const apiEndpoint = await db.getSetting('apiEndpoint');
  const summary = await summarize(segments, { apiEndpoint, language: lang });

  const title = deriveTitle(segments, summary);
  const rec = {
    id: uid(),
    title,
    createdAt: Date.now(),
    durationSec,
    language: lang,
    location: state._pendingLocation || '',
    audio: blob,
    mime: blob ? blob.type : '',
    segments,
    summary,
  };
  await db.saveRecording(rec);

  // Enforce the 200-hour (configurable) cap: delete oldest first.
  const deleted = await db.enforceCap();
  if (deleted.length) {
    toast(`저장 한도(${state.capHours}h) 초과 — 오래된 녹음 ${deleted.length}개 삭제됨`);
  } else {
    toast('녹음이 저장되었습니다.');
  }

  await refreshStorageIndicator();
  resetRecordUI();
  await renderList();
  openDetail(rec.id);
}

function cancelRecording() {
  if (!state.recording) { showView('list'); return; }
  if (!confirm('녹음을 취소할까요? 저장되지 않습니다.')) return;
  clearInterval(state.timerId);
  if (state.transcriber) state.transcriber.stop();
  if (state.recorder) state.recorder.cancel();
  state.recording = false;
  el.langSelect.disabled = false;
  resetRecordUI();
  showView('list');
}

function deriveTitle(segments, summary) {
  const now = new Date();
  const base = now.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) + ' 회의';
  if (summary && summary.keywords && summary.keywords.length) {
    return summary.keywords.slice(0, 3).join(', ');
  }
  if (segments.length) return segments[0].text.slice(0, 24);
  return base;
}

// ---------- detail ----------
async function openDetail(id) {
  const rec = await db.getRecording(id);
  if (!rec) { toast('녹음을 찾을 수 없습니다.'); return; }
  state.currentId = id;
  el.titleInput.value = rec.title || '';
  el.detailMeta.innerHTML = [
    fmtDate(rec.createdAt),
    fmtDuration(rec.durationSec),
    langLabel(rec.language),
    rec.location ? '📍 ' + escapeHtml(rec.location) : '',
    rec.summary && rec.summary.source === 'ai' ? 'AI 요약' : '온디바이스 요약',
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join('');

  if (rec.audio) {
    el.player.src = URL.createObjectURL(rec.audio);
    el.player.style.display = 'block';
  } else {
    el.player.style.display = 'none';
  }

  renderSummary(rec);
  renderTimeline(rec);
  renderTranscript(rec);
  setTab('summary');
  showView('detail');
}

function renderSummary(rec) {
  const s = rec.summary || {};
  const parts = [];
  if (s.overview) {
    parts.push(`<div class="summary-block"><h4>한눈에 보기</h4><p>${escapeHtml(s.overview)}</p></div>`);
  }
  if (s.keyPoints && s.keyPoints.length) {
    parts.push(`<div class="summary-block"><h4>핵심 요점</h4><ul>${
      s.keyPoints.map((k) => `<li>${escapeHtml(k)}</li>`).join('')
    }</ul></div>`);
  }
  if (s.actionItems && s.actionItems.length) {
    parts.push(`<div class="summary-block"><h4>액션 아이템</h4>${
      s.actionItems.map((a) =>
        `<div class="action-item"><span class="box">☐</span><span>${escapeHtml(a.text)} <span class="seg-time">${fmtTime(a.t)}</span></span></div>`
      ).join('')
    }</div>`);
  }
  if (!parts.length) {
    parts.push('<p class="muted">전사된 내용이 없어 요약을 만들 수 없습니다.</p>');
  }
  el.tabSummary.innerHTML = parts.join('');
}

function renderTimeline(rec) {
  const topics = (rec.summary && rec.summary.topics) || [];
  if (!topics.length) {
    el.tabTimeline.innerHTML = '<p class="muted">타임라인을 만들 전사 내용이 없습니다.</p>';
    return;
  }
  el.tabTimeline.innerHTML = topics.map((b) => `
    <div class="tl-item">
      <div class="tl-time">${fmtTime(b.t)}</div>
      <div class="tl-text">
        ${b.topic ? `<div class="tl-topic">${escapeHtml(b.topic)}</div>` : ''}
        ${escapeHtml(b.recap || '')}
      </div>
    </div>`).join('');
}

function renderTranscript(rec) {
  const segs = rec.segments || [];
  if (!segs.length) {
    el.tabTranscript.innerHTML = '<p class="muted">전사 내용이 없습니다.</p>';
    return;
  }
  el.tabTranscript.innerHTML = '<div class="transcript-full">' +
    segs.map((s) => `<div class="seg"><span class="seg-time">${fmtTime(s.t)}</span>${escapeHtml(s.text)}</div>`).join('') +
    '</div>';
}

function setTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  el.tabSummary.classList.toggle('active', name === 'summary');
  el.tabTimeline.classList.toggle('active', name === 'timeline');
  el.tabTranscript.classList.toggle('active', name === 'transcript');
}

async function reSummarizeInLanguage() {
  const rec = await db.getRecording(state.currentId);
  if (!rec) return;
  // Let the user pick a different language and re-run summarization.
  const codes = LANGUAGES.map((l) => l.code);
  const current = codes.indexOf(rec.language);
  const choices = LANGUAGES.map((l, i) => `${i + 1}. ${l.label}${l.code === rec.language ? ' (현재)' : ''}`).join('\n');
  const input = prompt(`다시 정리할 언어 번호를 선택하세요:\n\n${choices}`, String(current + 1));
  if (!input) return;
  const idx = parseInt(input, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= LANGUAGES.length) { toast('잘못된 선택입니다.'); return; }

  const newLang = LANGUAGES[idx].code;
  const apiEndpoint = await db.getSetting('apiEndpoint');
  rec.language = newLang;
  rec.summary = await summarize(rec.segments || [], { apiEndpoint, language: newLang });
  await db.saveRecording(rec);
  toast(`${LANGUAGES[idx].label}(으)로 다시 정리했습니다.`);
  openDetail(rec.id);
  refreshStorageIndicator();
}

async function deleteCurrent() {
  if (!state.currentId) return;
  if (!confirm('이 녹음을 삭제할까요?')) return;
  await db.deleteRecording(state.currentId);
  state.currentId = null;
  await refreshStorageIndicator();
  await renderList();
  showView('list');
  toast('삭제되었습니다.');
}

// ---------- location / language detection ----------
async function detectLanguage() {
  el.detectLangBtn.textContent = '⏳ 감지 중…';
  // 1) Try precise location if permitted.
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 6000 }));
      const r = await suggestLangFromCoords(pos.coords.latitude, pos.coords.longitude);
      if (r) {
        applyLangSuggestion(r);
        return;
      }
    } catch (_) { /* denied or unavailable → fall back */ }
  }
  // 2) Device-based fallback (timezone / locale).
  const r = suggestLangFromDevice();
  applyLangSuggestion(r);
}

function applyLangSuggestion(r) {
  el.langSelect.value = r.lang;
  state._pendingLocation = r.source.replace(/^.*?:\s*/, '');
  el.detectLangBtn.textContent = '📍 위치로 추천';
  toast(`${langLabel(r.lang)} 추천 (${r.source})`);
}

// ---------- settings ----------
function openSettings() {
  el.settingsSheet.hidden = false;
  refreshStorageIndicator();
}
function closeSettings() { el.settingsSheet.hidden = true; }

// ---------- init ----------
async function init() {
  // Load settings.
  state.capHours = await db.getSetting('capHours');
  const defaultLang = await db.getSetting('defaultLang');
  const apiEndpoint = await db.getSetting('apiEndpoint');

  fillLangSelect(el.langSelect, defaultLang);
  fillLangSelect(el.defaultLangSelect, defaultLang);
  el.capInput.value = state.capHours;
  el.apiEndpointInput.value = apiEndpoint || '';

  resetRecordUI();
  await renderList();
  await refreshStorageIndicator();
  wireEvents();
}

function wireEvents() {
  // Nav
  el.navList.addEventListener('click', () => { showView('list'); renderList(); });
  el.navSettings.addEventListener('click', openSettings);
  el.navRecord.addEventListener('click', () => {
    if (state.recording) { stopAndSave(); }
    else { showView('record'); resetRecordUI(); }
  });

  // Record controls
  el.recToggleBtn.addEventListener('click', () => {
    if (!state.recording) startRecording();
    else stopAndSave();
  });
  el.pauseRecBtn.addEventListener('click', () => {
    if (state.paused) resumeRecording(); else pauseRecording();
  });
  el.cancelRecBtn.addEventListener('click', cancelRecording);
  el.detectLangBtn.addEventListener('click', detectLanguage);
  el.langSelect.addEventListener('change', () => {
    if (state.transcriber && state.recording) {
      toast('언어는 다음 녹음부터 적용됩니다.');
    }
  });

  // Detail
  el.backBtn.addEventListener('click', () => { showView('list'); renderList(); });
  el.deleteBtn.addEventListener('click', deleteCurrent);
  el.reLangBtn.addEventListener('click', reSummarizeInLanguage);
  el.titleInput.addEventListener('change', async () => {
    const rec = await db.getRecording(state.currentId);
    if (rec) { rec.title = el.titleInput.value.trim() || '제목 없음'; await db.saveRecording(rec); renderList(); }
  });
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => setTab(t.dataset.tab)));

  // Storage pill → settings
  el.storageBtn.addEventListener('click', openSettings);

  // Settings
  el.closeSettings.addEventListener('click', closeSettings);
  el.settingsSheet.addEventListener('click', (e) => { if (e.target === el.settingsSheet) closeSettings(); });
  el.capInput.addEventListener('change', async () => {
    let v = parseInt(el.capInput.value, 10);
    if (isNaN(v) || v < 1) v = 200;
    v = Math.min(1000, v);
    el.capInput.value = v;
    state.capHours = v;
    await db.setSetting('capHours', v);
    const deleted = await db.enforceCap();
    if (deleted.length) toast(`한도 변경 — 오래된 녹음 ${deleted.length}개 삭제됨`);
    await refreshStorageIndicator();
    await renderList();
  });
  el.defaultLangSelect.addEventListener('change', async () => {
    await db.setSetting('defaultLang', el.defaultLangSelect.value);
    el.langSelect.value = el.defaultLangSelect.value;
    toast('기본 언어가 변경되었습니다.');
  });
  el.apiEndpointInput.addEventListener('change', async () => {
    await db.setSetting('apiEndpoint', el.apiEndpointInput.value.trim());
    toast('요약 서버 설정이 저장되었습니다.');
  });
  el.clearAllBtn.addEventListener('click', async () => {
    if (!confirm('모든 녹음을 삭제할까요? 되돌릴 수 없습니다.')) return;
    await db.clearAllRecordings();
    await refreshStorageIndicator();
    await renderList();
    closeSettings();
    toast('모든 녹음이 삭제되었습니다.');
  });
}

// Register service worker for offline / installable PWA.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

init();
