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
const elModalExcel = $('cmp-diff-excel');
const elModalAde = $('cmp-diff-ade');

let cache = null;

(async function init() {
  await loadMeta();
  wireEvents();
  showEmpty();
})();

function wireEvents() {
  elBtn.addEventListener('click', runCompare);
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
    cache = data;
    render(data);
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

function render(data) {
  elEmpty.hidden = true;
  let diffCount = 0;
  const rows = [];
  for (const day of data.days) {
    const analysis = analyseDay(day);
    if (analysis.hasDifference) diffCount++;
    rows.push({ day, analysis });
  }
  elStatDiff.textContent = String(diffCount);
  elStatTotal.textContent = `sur ${data.days.length} jours`;

  elGrid.innerHTML = rows.map(({ day, analysis }, idx) => {
    const d = parseISO(day.date);
    const dayLabel = DAY_NAMES[d.getDay()];
    const dateLabel = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    const cls = analysis.hasDifference ? 'has-diff' : 'is-ok';
    const badge = analysis.hasDifference
      ? `<span class="cmp-tile-badge">${analysis.diffCount} différence${analysis.diffCount>1?'s':''}</span>`
      : `<span class="cmp-tile-badge">Concordant</span>`;
    return `<div class="cmp-tile ${cls}" data-idx="${idx}" role="button" tabindex="0">
      <span class="cmp-tile-day">${dayLabel}</span>
      <span class="cmp-tile-date">${dateLabel}</span>
      <span class="cmp-tile-meta">${day.excel.length} Excel · ${day.ade.length} ADE</span>
      ${badge}
    </div>`;
  }).join('');

  elGrid.querySelectorAll('.cmp-tile').forEach((tile) => {
    tile.addEventListener('click', () => openDetail(rows[Number(tile.dataset.idx)]));
    tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(rows[Number(tile.dataset.idx)]); });
  });
}

// ─── Analyse ─────────────────────────────────────────────────
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
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

// Pour un jour donné : trouve les meilleures paires Excel↔ADE,
// et détecte les différences (cours manquant / horaire divergent).
function analyseDay(day) {
  const excel = day.excel.map((c) => ({ ...c, key: 'e' + Math.random(), matchedWith: null }));
  const ade = day.ade.map((c) => ({ ...c, key: 'a' + Math.random(), matchedWith: null }));

  // Score = similarité titre + bonus si les horaires se chevauchent
  const pairs = [];
  for (const e of excel) for (const a of ade) {
    const sim = similarity(e.title, a.title);
    if (sim < 0.4) continue;
    const eS = timeToMin(e.startTime), eE = timeToMin(e.endTime);
    const aS = timeToMin(a.startTime), aE = timeToMin(a.endTime);
    const overlap = !isNaN(eS) && !isNaN(aS) && Math.min(eE, aE) > Math.max(eS, aS);
    pairs.push({ e, a, score: sim + (overlap ? 0.3 : 0) });
  }
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    if (p.e.matchedWith || p.a.matchedWith) continue;
    p.e.matchedWith = p.a;
    p.a.matchedWith = p.e;
  }

  // Détermine l'état de chaque item
  const items = [];
  for (const e of excel) {
    if (!e.matchedWith) { items.push({ side: 'excel', item: e, state: 'missing_in_ade' }); continue; }
    const a = e.matchedWith;
    const sameStart = e.startTime === a.startTime;
    const sameEnd = e.endTime === a.endTime;
    if (sameStart && sameEnd) items.push({ side: 'both', excel: e, ade: a, state: 'match' });
    else items.push({ side: 'both', excel: e, ade: a, state: 'time_diff' });
  }
  for (const a of ade) if (!a.matchedWith) items.push({ side: 'ade', item: a, state: 'missing_in_excel' });

  const diffCount = items.filter((it) => it.state !== 'match').length;
  return { items, hasDifference: diffCount > 0, diffCount };
}

// ─── Détail journée ───────────────────────────────────────────
function openDetail({ day, analysis }) {
  const d = parseISO(day.date);
  elModalTitle.textContent = `${DAY_NAMES[d.getDay()]} ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  const excelRows = [];
  const adeRows = [];
  for (const it of analysis.items) {
    if (it.state === 'match') {
      excelRows.push(renderItem(it.excel, 'state-match'));
      adeRows.push(renderItem(it.ade, 'state-match'));
    } else if (it.state === 'time_diff') {
      excelRows.push(renderItem(it.excel, 'state-diff'));
      adeRows.push(renderItem(it.ade, 'state-diff'));
    } else if (it.state === 'missing_in_ade') {
      excelRows.push(renderItem(it.item, 'state-diff'));
      adeRows.push(`<div class="cmp-item state-missing">Absent</div>`);
    } else if (it.state === 'missing_in_excel') {
      excelRows.push(`<div class="cmp-item state-missing">Absent</div>`);
      adeRows.push(renderItem(it.item, 'state-diff'));
    }
  }
  elModalExcel.innerHTML = excelRows.length ? excelRows.join('') : '<div class="cmp-empty-col">Rien côté Excel.</div>';
  elModalAde.innerHTML = adeRows.length ? adeRows.join('') : '<div class="cmp-empty-col">Rien côté ADE.</div>';
  elModal.hidden = false;
}

function renderItem(c, cls) {
  return `<div class="cmp-item ${cls}">
    <strong>${escapeHtml(c.title || '(sans titre)')}</strong>
    <div class="row">${escapeHtml(c.startTime)}–${escapeHtml(c.endTime)}${c.teacher ? ' · '+escapeHtml(c.teacher) : ''}</div>
    ${c.room ? `<div class="row">📍 ${escapeHtml(c.room)}</div>` : ''}
  </div>`;
}

function closeModal() { elModal.hidden = true; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
