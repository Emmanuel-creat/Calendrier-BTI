import { get } from './api.js';
import { parseISO, DAY_NAMES } from './dates.js';

const $ = (id) => document.getElementById(id);
const elGrid = $('cmp-grid');
const elEmpty = $('cmp-empty');
const elBtn = $('btn-compare');
const elSrcExcel = $('src-excel');
const elSrcAde = $('src-ade');
const elStatDiff = $('stat-diff');
const elStatTotal = $('stat-total');
const elModal = $('cmp-modal');
const elModalTitle = $('cmp-modal-title');
const elDayGrid = $('cmp-day-grid');
const elFields = $('cmp-fields');

const state = {
  data: null,
  fields: { horaires: true, matieres: true, prof: true },
  analysis: null,
};

const GRID_START_HOUR = 8;
const GRID_END_HOUR = 18;

(async function init() {
  await loadMeta();
  wireEvents();
  showEmpty();
})();

function wireEvents() {
  elBtn.addEventListener('click', runCompare);
  elFields.addEventListener('change', (e) => {
    const field = e.target?.dataset?.field;
    if (!field) return;
    state.fields[field] = e.target.checked;
    if (state.data) renderAll();
  });
  elModal.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-modal-close')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
}

async function loadMeta() {
  try {
    const meta = await get('/api/meta');
    if (meta?.remote?.fileName) elSrcExcel.textContent = meta.remote.fileName;
    else if (meta?.sheetName) elSrcExcel.textContent = meta.sheetName;
    if (meta?.ade?.syncedAt) {
      const d = new Date(meta.ade.syncedAt);
      elSrcAde.textContent = `${d.toLocaleString('fr-FR')} · ${meta.ade.eventCount || 0} évén.`;
    }
  } catch { /* ignore */ }
}

async function runCompare() {
  elBtn.disabled = true;
  elBtn.textContent = 'Analyse…';
  try {
    const data = await get('/api/comparator');
    state.data = data;
    renderAll();
  } catch (e) {
    elGrid.innerHTML = `<div class="cmp-empty-col">Erreur : ${escapeHtml(e.message)}</div>`;
  } finally {
    elBtn.disabled = false;
    elBtn.textContent = 'Recomparer';
  }
}

function showEmpty() {
  elGrid.innerHTML = '';
  elEmpty.hidden = false;
  elStatDiff.textContent = '—';
  elStatTotal.textContent = '';
}

function renderAll() {
  if (!state.data) return;
  elEmpty.hidden = true;
  state.analysis = state.data.days.map((day) => ({ day, ...analyseDay(day) }));

  const diffCount = state.analysis.filter((a) => a.hasDifference).length;
  elStatDiff.textContent = String(diffCount);
  elStatTotal.textContent = `sur ${state.data.days.length} jours`;

  elGrid.innerHTML = state.analysis.map(({ day, hasDifference, diffCount }, idx) => {
    const d = parseISO(day.date);
    const dayLabel = DAY_NAMES[d.getDay()];
    const dateLabel = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const cls = hasDifference ? 'has-diff' : 'is-ok';
    const badge = hasDifference
      ? `<span class="cmp-tile-badge">${diffCount} différence${diffCount>1?'s':''}</span>`
      : `<span class="cmp-tile-badge">Concordant</span>`;
    return `<div class="cmp-tile ${cls}" data-idx="${idx}" role="button" tabindex="0">
      <span class="cmp-tile-day">${dayLabel}</span>
      <span class="cmp-tile-date">${dateLabel}</span>
      <span class="cmp-tile-meta">${day.excel.length} Excel · ${day.ade.length} ADE</span>
      ${badge}
    </div>`;
  }).join('');

  elGrid.querySelectorAll('.cmp-tile').forEach((tile) => {
    tile.addEventListener('click', () => openDetail(state.analysis[Number(tile.dataset.idx)]));
    tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(state.analysis[Number(tile.dataset.idx)]); });
  });
}

// ─── Comparaison ────────────────────────────────────────────
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function normalizeTeacher(s) {
  // "TAILLEBOT Virginie" vs "Virginie TAILLEBOT" → même
  return normalizeText(s).split(' ').filter(Boolean).sort().join(' ');
}
function jaccard(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}
function timeToMin(t) {
  if (!t) return NaN;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Analyse un jour : appariement Excel↔ADE + détermination des diffs
// selon les champs cochés dans la sidebar.
function analyseDay(day) {
  const excel = day.excel.map((c, i) => ({ ...c, _key: 'e'+i, matched: null }));
  const ade = day.ade.map((c, i) => ({ ...c, _key: 'a'+i, matched: null }));

  // Appariement par similarité de titre + chevauchement horaire.
  const pairs = [];
  for (const e of excel) for (const a of ade) {
    const sim = jaccard(e.title, a.title);
    if (sim < 0.4) continue;
    const eS = timeToMin(e.startTime), eE = timeToMin(e.endTime);
    const aS = timeToMin(a.startTime), aE = timeToMin(a.endTime);
    const overlap = !isNaN(eS) && !isNaN(aS) && Math.min(eE, aE) > Math.max(eS, aS);
    pairs.push({ e, a, score: sim + (overlap ? 0.3 : 0) });
  }
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    if (p.e.matched || p.a.matched) continue;
    p.e.matched = p.a;
    p.a.matched = p.e;
  }

  // Diff par champ actif
  const f = state.fields;
  const items = [];
  let diffCount = 0;

  for (const e of excel) {
    if (!e.matched) {
      // Manque dans ADE : compte comme diff seulement si "matieres" est coché
      // (car c'est une différence de matière : elle est présente Excel, absente ADE)
      const isDiff = !!f.matieres;
      if (isDiff) diffCount++;
      items.push({ kind: 'missing_ade', excel: e, isDiff });
    } else {
      const reasons = [];
      if (f.horaires && (e.startTime !== e.matched.startTime || e.endTime !== e.matched.endTime)) reasons.push('horaires');
      if (f.matieres && jaccard(e.title, e.matched.title) < 0.95) reasons.push('matières');
      if (f.prof && (e.teacher || e.matched.teacher) &&
          normalizeTeacher(e.teacher) !== normalizeTeacher(e.matched.teacher)) reasons.push('prof');
      const isDiff = reasons.length > 0;
      if (isDiff) diffCount++;
      items.push({ kind: 'pair', excel: e, ade: e.matched, isDiff, reasons });
    }
  }
  for (const a of ade) {
    if (!a.matched) {
      const isDiff = !!f.matieres;
      if (isDiff) diffCount++;
      items.push({ kind: 'missing_excel', ade: a, isDiff });
    }
  }

  return { items, hasDifference: diffCount > 0, diffCount };
}

// ─── Détail : mini-agenda de la journée ────────────────────
function openDetail(entry) {
  const { day, items } = entry;
  const d = parseISO(day.date);
  elModalTitle.textContent = `${DAY_NAMES[d.getDay()]} ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  const excelBlocks = [];
  const adeBlocks = [];
  for (const it of items) {
    if (it.kind === 'pair') {
      excelBlocks.push(makeBlock(it.excel, it.isDiff ? 'diff' : '', it.reasons));
      adeBlocks.push(makeBlock(it.ade, it.isDiff ? 'diff' : '', it.reasons));
    } else if (it.kind === 'missing_ade') {
      excelBlocks.push(makeBlock(it.excel, it.isDiff ? 'diff' : '', ['manque ADE']));
    } else if (it.kind === 'missing_excel') {
      adeBlocks.push(makeBlock(it.ade, it.isDiff ? 'diff' : '', ['manque Excel']));
    }
  }

  const railSlots = [];
  for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h++) railSlots.push(`<div class="cmp-dg-rail-slot">${h}h</div>`);
  railSlots.push(`<div class="cmp-dg-rail-end">${GRID_END_HOUR}h</div>`);

  elDayGrid.innerHTML = `
    <div class="cmp-dg-head"> </div>
    <div class="cmp-dg-head">Excel</div>
    <div class="cmp-dg-head">ADE</div>
    <div class="cmp-dg-rail">${railSlots.join('')}</div>
    <div class="cmp-dg-col">${excelBlocks.join('')}</div>
    <div class="cmp-dg-col">${adeBlocks.join('')}</div>
  `;

  elModal.hidden = false;
}

function makeBlock(c, diffClass, reasons) {
  if (!c) return '';
  const startH = hourValue(c.startTime);
  const endH = hourValue(c.endTime);
  if (startH == null || endH == null) return '';
  const top = Math.max(0, startH - GRID_START_HOUR);
  const height = Math.max(0.4, endH - startH);
  const tag = reasons?.length ? `<span class="diff-tag">${escapeHtml(reasons.join(' · '))}</span>` : '';
  return `<div class="cmp-block ${diffClass}"
    style="top: calc(var(--dg-hour-height) * ${top}); height: calc(var(--dg-hour-height) * ${height} - 4px);">
    <span class="cmp-block-title">${escapeHtml(c.title || '(sans titre)')}</span>
    <span class="cmp-block-meta">${escapeHtml(c.startTime)}–${escapeHtml(c.endTime)}${c.teacher ? ' · '+escapeHtml(c.teacher) : ''}</span>
    ${c.room ? `<span class="cmp-block-meta">📍 ${escapeHtml(c.room)}</span>` : ''}
    ${tag}
  </div>`;
}

function hourValue(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (isNaN(h)) return null;
  return h + (m || 0) / 60;
}

function closeModal() { elModal.hidden = true; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
