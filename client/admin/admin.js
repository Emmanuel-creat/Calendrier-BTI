import { get, post, put, del } from '/js/api.js';
import { parseISO, toISO, isoAddDays, isoWeekNumber } from '/js/dates.js';

const state = {
  courses: [],
  weeks: [],
  groups: [],
  filter: { week: '', search: '', group: '' },
  authenticated: false,
  // Sélection de semaines dans la modale d'édition
  weeksSelected: new Set(),
  dragging: false,
  dragMode: null, // 'add' | 'remove'
};

const $ = (id) => document.getElementById(id);

// ─── Login ──────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const r = await get('/api/admin/status');
    return !!r.authenticated;
  } catch { return false; }
}

async function login(password) {
  const err = $('login-error');
  err.hidden = true;
  try {
    await post('/api/admin/login', { password });
    state.authenticated = true;
    showAdmin();
  } catch (e) {
    err.textContent = 'Mot de passe incorrect.';
    err.hidden = false;
  }
}

async function logout() {
  await post('/api/admin/logout');
  state.authenticated = false;
  location.reload();
}

// ─── Data ──────────────────────────────────────────────────────
async function loadAll() {
  const [meta, wk, prof, cs] = await Promise.all([
    get('/api/meta'),
    get('/api/weeks'),
    get('/api/profiles'),
    get('/api/courses'),
  ]);
  state.weeks = wk.weeks;
  state.groups = prof.groups;
  state.courses = cs.courses;
  $('admin-meta').textContent =
    `Excel: ${meta.sheetName} · Cours: ${state.courses.length} · Overrides: ${meta.overrideCount}` +
    (meta.overridesUpdatedAt ? ` · Dernière modif: ${new Date(meta.overridesUpdatedAt).toLocaleString('fr-FR')}` : '');
  populateFilters();
  renderList();
}

function populateFilters() {
  const w = $('filter-week');
  w.innerHTML = `<option value="">Toutes les semaines</option>` +
    state.weeks.map((wk) => `<option value="${wk.weekStart}">Sem. ${isoWeekNumber(wk.weekStart)} · ${dateFrToShort(wk.weekStart)}${wk.annotation ? ' — '+esc(wk.annotation) : ''}</option>`).join('');

  const g = $('filter-group');
  g.innerHTML = `<option value="">Tous les groupes</option>` +
    state.groups.map((gr) => `<option value="${esc(gr)}">${esc(gr)}</option>`).join('');
}

function renderList() {
  const tbody = $('admin-tbody');
  const { week, search, group } = state.filter;
  const s = search.toLowerCase();
  const filtered = state.courses.filter((c) => {
    if (week && c.weekStart !== week) return false;
    if (group && !(c.groups || []).includes(group)) return false;
    if (s) {
      const hay = `${c.title} ${c.teacher} ${c.room} ${(c.groups||[]).join(' ')}`.toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });
  $('course-count').textContent = `${filtered.length} / ${state.courses.length} cours`;

  tbody.innerHTML = filtered.map((c) => `
    <tr data-id="${c.id}">
      <td>${dateFrToShort(c.weekStart)}<div class="muted">Sem. ${isoWeekNumber(c.weekStart)}</div></td>
      <td>${esc(c.day || dayLabel(c.dayOfWeek))}<div class="muted">${dateFrToShort(c.date)}</div></td>
      <td>${c.startTime}<br>${c.endTime}</td>
      <td><strong>${esc(c.title)}</strong>${c.notes ? `<div class="muted">${esc(c.notes)}</div>` : ''}</td>
      <td>${esc(c.teacher || '—')}</td>
      <td>${esc(c.room || '—')}</td>
      <td>${(c.groups||[]).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</td>
      <td class="origin-${esc(c.origin || 'excel')}">${esc(c.origin || 'excel')}</td>
      <td class="row-actions">
        <button data-act="edit">Éditer</button>
        <button data-act="delete" class="danger">×</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      const id = tr.getAttribute('data-id');
      const c = state.courses.find((x) => x.id === id);
      if (!c) return;
      if (btn.dataset.act === 'edit') openEdit(c);
      else if (btn.dataset.act === 'delete') deleteCourse(c);
    });
  });
}

// ─── CRUD ─────────────────────────────────────────────────────
async function deleteCourse(c) {
  if (!confirm(`Supprimer « ${c.title} » (${c.day} ${c.startTime})\nCette action n’affecte que cette occurrence.`)) return;
  await del(`/api/admin/courses/${c.id}`);
  await loadAll();
}

function openEdit(c = null) {
  const modal = $('edit-modal');
  const f = $('edit-form');
  const err = $('edit-error');
  err.hidden = true;
  $('edit-title').textContent = c ? 'Éditer un cours' : 'Nouveau cours';
  $('edit-delete').hidden = !c;

  // Reset
  f.reset();
  f.courseId.value = c?.id || '';
  f.title.value = c?.title || '';
  f.teacher.value = c?.teacher || '';
  f.room.value = c?.room || '';
  f.notes.value = c?.notes || '';
  f.groups.value = (c?.groups || ['BTI']).join(', ');
  f.dayOfWeek.value = String(c?.dayOfWeek || 1);
  f.startTime.value = c?.startTime || '09:00';
  f.endTime.value = c?.endTime || '12:00';

  state.weeksSelected = new Set(c ? [c.weekStart] : [state.weeks[0]?.weekStart].filter(Boolean));
  renderWeeksGrid();
  modal.hidden = false;
}

function renderWeeksGrid() {
  const grid = $('weeks-grid');
  grid.innerHTML = state.weeks.map((w) => {
    const sel = state.weeksSelected.has(w.weekStart) ? ' selected' : '';
    return `<div class="week-chip${sel}" data-week="${w.weekStart}">
      ${dateFrToShort(w.weekStart)}
      <span class="num">Sem. ${isoWeekNumber(w.weekStart)}${w.annotation ? ' · '+esc(w.annotation.slice(0,10)) : ''}</span>
    </div>`;
  }).join('');

  const chips = grid.querySelectorAll('.week-chip');
  chips.forEach((chip) => {
    chip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const wk = chip.dataset.week;
      state.dragging = true;
      state.dragMode = state.weeksSelected.has(wk) ? 'remove' : 'add';
      toggleWeek(wk, state.dragMode === 'add');
      chip.setPointerCapture?.(e.pointerId);
    });
    chip.addEventListener('pointerenter', () => {
      if (state.dragging) toggleWeek(chip.dataset.week, state.dragMode === 'add');
    });
  });
  document.addEventListener('pointerup', () => { state.dragging = false; }, { once: true });

  // Buttons: all / none / future
  grid.parentElement.querySelectorAll('button[data-weeks]').forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.weeks;
      if (mode === 'all') state.weeksSelected = new Set(state.weeks.map((w) => w.weekStart));
      else if (mode === 'none') state.weeksSelected.clear();
      else if (mode === 'future') {
        const first = [...state.weeksSelected].sort()[0] || state.weeks[0]?.weekStart;
        if (first) state.weeksSelected = new Set(state.weeks.filter((w) => w.weekStart >= first).map((w) => w.weekStart));
      }
      renderWeeksGrid();
    };
  });
}

function toggleWeek(wk, on) {
  if (on) state.weeksSelected.add(wk);
  else state.weeksSelected.delete(wk);
  const chip = document.querySelector(`.week-chip[data-week="${wk}"]`);
  if (chip) chip.classList.toggle('selected', on);
}

async function saveCourse(e) {
  e.preventDefault();
  const f = e.target;
  const err = $('edit-error');
  err.hidden = true;
  const data = {
    id: f.courseId.value,
    title: f.title.value.trim(),
    teacher: f.teacher.value.trim(),
    room: f.room.value.trim(),
    notes: f.notes.value.trim(),
    groups: f.groups.value.split(',').map((s) => s.trim()).filter(Boolean),
    dayOfWeek: Number(f.dayOfWeek.value),
    startTime: f.startTime.value,
    endTime: f.endTime.value,
  };
  if (!data.title) return showError(err, 'Le titre est requis.');
  if (data.endTime <= data.startTime) return showError(err, 'L’heure de fin doit être après le début.');
  if (!state.weeksSelected.size) return showError(err, 'Sélectionne au moins une semaine.');
  if (!data.groups.length) data.groups = ['BTI'];

  const weeks = [...state.weeksSelected].sort();

  try {
    if (data.id) {
      // Édition : on modifie l'occurrence existante (semaine actuelle)
      // + on crée dans les autres semaines sélectionnées si besoin.
      const cur = state.courses.find((c) => c.id === data.id);
      const patch = { ...data };
      delete patch.id;
      patch.weekStart = cur?.weekStart;
      patch.date = computeDate(cur?.weekStart, data.dayOfWeek);
      await put(`/api/admin/courses/${data.id}`, patch);
      // Répliquer dans les autres semaines sélectionnées
      const others = weeks.filter((w) => w !== cur?.weekStart);
      if (others.length) {
        await post('/api/admin/courses', { ...data, weeks: others });
      }
    } else {
      await post('/api/admin/courses', { ...data, weeks });
    }
    $('edit-modal').hidden = true;
    await loadAll();
  } catch (e2) {
    showError(err, `Erreur : ${e2.message}`);
  }
}

function showError(el, msg) { el.textContent = msg; el.hidden = false; }

// ─── Diff Excel ─────────────────────────────────────────────
async function showDiff() {
  const d = await get('/api/admin/diff');
  const body = $('diff-body');
  body.innerHTML = `
    <section class="diff-section"><h3 class="diff-added">Ajoutés (${d.added.length})</h3>
      <ul>${d.added.map(descLine).join('')}</ul></section>
    <section class="diff-section"><h3 class="diff-removed">Supprimés (${d.removed.length})</h3>
      <ul>${d.removed.map(descLine).join('')}</ul></section>
    <section class="diff-section"><h3 class="diff-modified">Modifiés (${d.modified.length})</h3>
      <ul>${d.modified.map(descChange).join('')}</ul></section>
  `;
  $('diff-modal').hidden = false;
}

function descLine(c) {
  return `<li>${esc(c.title)} — ${esc(c.day || dayLabel(c.dayOfWeek))} ${esc(c.startTime)}–${esc(c.endTime)} (sem. du ${esc(dateFrToShort(c.weekStart))})</li>`;
}
function descChange(m) {
  const cur = m.current;
  const changes = m.changes.map((ch) => `${ch.field}: ${JSON.stringify(ch.from)} → ${JSON.stringify(ch.to)}`).join('; ');
  return `<li>${esc(cur.title)} (sem. ${esc(dateFrToShort(cur.weekStart))}) — ${esc(changes)}</li>`;
}

// ─── Helpers ─────────────────────────────────────────────────
function dayLabel(n) { return ['','Lundi','Mardi','Mercredi','Jeudi','Vendredi'][n] || ''; }
function computeDate(weekStart, dow) {
  if (!weekStart || !dow) return null;
  return isoAddDays(weekStart, dow - 1);
}
function dateFrToShort(iso) {
  if (!iso) return '—';
  return parseISO(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[ch]));
}

// ─── Bootstrap ───────────────────────────────────────────────
function showAdmin() {
  $('login-view').hidden = true;
  $('admin-view').hidden = false;
  loadAll();
}

$('login-form').addEventListener('submit', (e) => { e.preventDefault(); login($('login-password').value); });
$('btn-logout').addEventListener('click', logout);
$('btn-new-course').addEventListener('click', () => openEdit());
$('btn-diff').addEventListener('click', showDiff);
$('btn-reimport').addEventListener('click', async () => {
  if (!confirm('Recharger complètement l’Excel ? Les overrides restent.')) return;
  await post('/api/admin/reimport');
  await loadAll();
});
$('btn-reset').addEventListener('click', async () => {
  if (!confirm('⚠ Supprimer TOUS les overrides et revenir à l’Excel ?')) return;
  await post('/api/admin/reset');
  await loadAll();
});

$('filter-week').addEventListener('change', (e) => { state.filter.week = e.target.value; renderList(); });
$('filter-group').addEventListener('change', (e) => { state.filter.group = e.target.value; renderList(); });
$('filter-search').addEventListener('input', (e) => { state.filter.search = e.target.value; renderList(); });

document.addEventListener('click', (e) => {
  const t = e.target;
  if (t instanceof Element && t.hasAttribute('data-modal-close')) {
    $('edit-modal').hidden = true;
    $('diff-modal').hidden = true;
  }
});

$('edit-form').addEventListener('submit', saveCourse);
$('edit-delete').addEventListener('click', async () => {
  const id = $('edit-form').courseId.value;
  if (!id) return;
  if (!confirm('Supprimer cette occurrence ?')) return;
  await del(`/api/admin/courses/${id}`);
  $('edit-modal').hidden = true;
  await loadAll();
});

(async () => {
  if (await checkAuth()) showAdmin();
})();
