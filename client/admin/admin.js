import { get, post, put, del } from '/js/api.js';
import { parseISO, toISO, isoAddDays, isoWeekNumber, mondayOf, toWeekInputValue, fromWeekInputValue } from '/js/dates.js';
import { renderCalendar } from '/js/calendar.js';

const state = {
  courses: [],
  weeks: [],
  groups: [],
  filter: { week: '', search: '', group: '' },
  authenticated: false,
  view: 'list',
  agendaWeek: mondayOf(new Date()),
  occurrences: [],
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
  if (state.view === 'agenda') renderAgenda();
}

function populateFilters() {
  const w = $('filter-week');
  w.innerHTML = `<option value="">Toutes les semaines</option>` +
    state.weeks.map((wk) => `<option value="${wk.weekStart}">Sem. ${isoWeekNumber(wk.weekStart)} · ${dateFrToShort(wk.weekStart)}${wk.annotation ? ' — '+esc(wk.annotation) : ''}</option>`).join('');

  const g = $('filter-group');
  g.innerHTML = `<option value="">Tous les groupes</option>` +
    state.groups.map((gr) => `<option value="${esc(gr)}">${esc(gr)}</option>`).join('');
}

// ─── Tabs Liste / Agenda ─────────────────────────────────
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.vtab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('view-list').hidden = view !== 'list';
  document.querySelector('.admin-toolbar').hidden = view !== 'list';
  $('view-agenda').hidden = view !== 'agenda';
  if (view === 'agenda') renderAgenda();
}

// ─── Agenda ───────────────────────────────────────────────
function renderAgenda() {
  const cal = $('agenda-calendar');
  const weekStart = state.agendaWeek;
  const today = toISO(new Date());
  const weekCourses = state.courses.filter((c) => c.weekStart === weekStart);

  renderCalendar(cal, {
    weekStart,
    courses: weekCourses,
    today,
    now: new Date(),
    activeMobileDay: 0,
    onCourseClick: (c) => openEdit(c),
  });

  $('agenda-week-input').value = toWeekInputValue(weekStart);

  bindAgendaDrag(cal, weekStart);
}

function bindAgendaDrag(cal, weekStart) {
  const HOUR_HEIGHT = 58;
  const cols = cal.querySelectorAll('.day-col');
  cols.forEach((col, dayIndex) => {
    let startY = null;
    let preview = null;
    let dayOfWeek = dayIndex + 1;

    const cleanup = () => { if (preview) preview.remove(); preview = null; startY = null; };

    col.addEventListener('mousedown', (e) => {
      if (e.target.closest('.course')) return;
      e.preventDefault();
      const rect = col.getBoundingClientRect();
      startY = snapToQuarter(e.clientY - rect.top);
      preview = document.createElement('div');
      preview.className = 'agenda-preview';
      preview.style.top = `${startY}px`;
      preview.style.height = `${HOUR_HEIGHT}px`;
      preview.textContent = formatRange(startY, startY + HOUR_HEIGHT);
      col.appendChild(preview);
    });

    col.addEventListener('mousemove', (e) => {
      if (startY == null || !preview) return;
      const rect = col.getBoundingClientRect();
      const y = snapToQuarter(e.clientY - rect.top);
      const top = Math.max(0, Math.min(startY, y));
      const bottom = Math.min(HOUR_HEIGHT * 10, Math.max(startY, y));
      preview.style.top = `${top}px`;
      preview.style.height = `${Math.max(HOUR_HEIGHT * 0.5, bottom - top)}px`;
      preview.textContent = formatRange(top, top + Math.max(HOUR_HEIGHT * 0.5, bottom - top));
    });

    const finalize = (clientY) => {
      if (startY == null) return;
      const rect = col.getBoundingClientRect();
      const y = snapToQuarter(clientY - rect.top);
      const top = Math.max(0, Math.min(startY, y));
      const bottom = Math.min(HOUR_HEIGHT * 10, Math.max(startY, y));
      const height = Math.max(HOUR_HEIGHT, bottom - top);
      cleanup();

      const startHour = 8 + (top / HOUR_HEIGHT);
      const endHour = 8 + ((top + height) / HOUR_HEIGHT);
      openEdit(null, {
        weekStart,
        dayOfWeek,
        startTime: hoursToHhmm(startHour),
        endTime: hoursToHhmm(endHour),
      });
    };

    col.addEventListener('mouseup', (e) => finalize(e.clientY));
    col.addEventListener('mouseleave', () => cleanup());
  });

  function snapToQuarter(y) {
    const q = HOUR_HEIGHT / 4;
    return Math.round(y / q) * q;
  }
  function formatRange(top, bottom) {
    return `${hoursToHhmm(8 + top / HOUR_HEIGHT)} – ${hoursToHhmm(8 + bottom / HOUR_HEIGHT)}`;
  }
}

function hoursToHhmm(h) {
  h = Math.max(8, Math.min(18, h));
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
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

function openEdit(c = null, prefill = null) {
  const modal = $('edit-modal');
  const f = $('edit-form');
  const err = $('edit-error');
  err.hidden = true;
  $('edit-title').textContent = c ? 'Éditer un cours' : 'Nouveau cours';
  $('edit-delete').hidden = !c;

  f.reset();
  f.courseId.value = c?.id || '';
  f.title.value = c?.title || '';
  f.teacher.value = c?.teacher || '';
  f.room.value = c?.room || '';
  f.notes.value = c?.notes || '';
  const initialProfiles = new Set((c?.groups || ['BTI']).filter((g) => ['BTI', 'PolyTech', 'ECM', 'Clinicien'].includes(g)));
  if (initialProfiles.size === 0) initialProfiles.add('BTI');
  document.querySelectorAll('#edit-profile-chips .pchip').forEach((chip) => {
    chip.classList.toggle('active', initialProfiles.has(chip.dataset.profile));
  });

  // Un cours a UN créneau initial (jour/heure/semaines). L'utilisateur peut
  // en ajouter d'autres pour couvrir des jours ou horaires différents.
  const initialOccurrence = {
    id: `occ_${Date.now()}`,
    dayOfWeek: prefill?.dayOfWeek || c?.dayOfWeek || 1,
    startTime: prefill?.startTime || c?.startTime || '09:00',
    endTime: prefill?.endTime || c?.endTime || '12:00',
    weeks: new Set([prefill?.weekStart || c?.weekStart || state.weeks[0]?.weekStart].filter(Boolean)),
  };
  state.occurrences = [initialOccurrence];
  renderOccurrences();
  modal.hidden = false;
}

function renderOccurrences() {
  const wrap = $('occurrences');
  wrap.innerHTML = '';
  state.occurrences.forEach((occ, idx) => {
    const block = document.createElement('div');
    block.className = 'occurrence';
    block.dataset.occId = occ.id;
    block.innerHTML = `
      <div class="occurrence-head">
        <span class="occurrence-title">Créneau ${idx + 1}</span>
        ${state.occurrences.length > 1 ? `<button type="button" class="occurrence-remove">× Retirer</button>` : ''}
      </div>
      <div class="grid-2">
        <label>
          <span>Jour <span class="req">*</span></span>
          <select class="occ-day">
            <option value="1"${occ.dayOfWeek===1?' selected':''}>Lundi</option>
            <option value="2"${occ.dayOfWeek===2?' selected':''}>Mardi</option>
            <option value="3"${occ.dayOfWeek===3?' selected':''}>Mercredi</option>
            <option value="4"${occ.dayOfWeek===4?' selected':''}>Jeudi</option>
            <option value="5"${occ.dayOfWeek===5?' selected':''}>Vendredi</option>
          </select>
        </label>
        <label>
          <span>Créneau <span class="req">*</span></span>
          <span class="times">
            <input type="time" step="900" class="occ-start" value="${occ.startTime}" required />
            <span>→</span>
            <input type="time" step="900" class="occ-end" value="${occ.endTime}" required />
          </span>
        </label>
      </div>
      <div class="field-block">
        <span class="field-label small">Semaines <span class="req">*</span> <span class="hint">— clique ou fais glisser pour sélectionner</span></span>
        <div class="weeks-actions">
          <button type="button" data-weeks="all">Toutes</button>
          <button type="button" data-weeks="none">Aucune</button>
        </div>
        <div class="weeks-grid" data-weeks-for="${occ.id}"></div>
      </div>
    `;
    wrap.appendChild(block);
    renderWeeksInBlock(block, occ);

    // Wiring interne du block
    block.querySelector('.occ-day').addEventListener('change', (e) => { occ.dayOfWeek = Number(e.target.value); });
    block.querySelector('.occ-start').addEventListener('change', (e) => { occ.startTime = e.target.value; });
    block.querySelector('.occ-end').addEventListener('change', (e) => { occ.endTime = e.target.value; });
    const remove = block.querySelector('.occurrence-remove');
    if (remove) remove.addEventListener('click', () => {
      state.occurrences = state.occurrences.filter((o) => o.id !== occ.id);
      renderOccurrences();
    });
    block.querySelectorAll('button[data-weeks]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.weeks;
        if (mode === 'all') occ.weeks = new Set(state.weeks.map((w) => w.weekStart));
        else if (mode === 'none') occ.weeks = new Set();
        renderWeeksInBlock(block, occ);
      });
    });
  });
}

function renderWeeksInBlock(block, occ) {
  const grid = block.querySelector('.weeks-grid');
  grid.innerHTML = state.weeks.map((w) => {
    const sel = occ.weeks.has(w.weekStart) ? ' selected' : '';
    return `<div class="week-chip${sel}" data-week="${w.weekStart}">
      ${dateFrToShort(w.weekStart)}
      <span class="num">Sem. ${isoWeekNumber(w.weekStart)}${w.annotation ? ' · '+esc(w.annotation.slice(0,10)) : ''}</span>
    </div>`;
  }).join('');
  wireGridDrag(grid, occ);
}

// Comportement du drag des chips :
//   - Clic pur (< 6 px de mouvement) → toggle la case cliquée uniquement.
//   - Clic + drag > 6 px → toggle chaque case survolée en mode déterminé
//     par la case initiale (add si non sélectionnée, remove sinon).
const DRAG_THRESHOLD_PX = 6;

// Câble le drag sur un grid particulier lié à une occurrence.
// Modifie la Set `occ.weeks` et met à jour les classes des chips.
function wireGridDrag(grid, occ) {
  let armedAt = null;
  let lastToggled = null;
  let mode = null;
  let dragging = false;

  const chipsForGrid = () => [...grid.querySelectorAll('.week-chip[data-week]')];
  const chipAtLocal = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const chip = el?.closest?.('.week-chip[data-week]');
    if (!chip || chip.parentElement !== grid) return null;
    return chip;
  };
  const setChip = (wk, on) => {
    if (on) occ.weeks.add(wk); else occ.weeks.delete(wk);
    const chip = grid.querySelector(`.week-chip[data-week="${wk}"]`);
    if (chip) chip.classList.toggle('selected', on);
  };

  const onDown = (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const chip = chipAtLocal(e.clientX, e.clientY);
    if (!chip) return;
    e.preventDefault();
    const wk = chip.dataset.week;
    armedAt = { x: e.clientX, y: e.clientY };
    mode = occ.weeks.has(wk) ? 'remove' : 'add';
    setChip(wk, mode === 'add');
    lastToggled = wk;
    dragging = false;
  };

  const onMove = (e) => {
    if (!armedAt && !dragging) return;
    if (armedAt && !dragging) {
      const dx = e.clientX - armedAt.x;
      const dy = e.clientY - armedAt.y;
      if ((dx * dx + dy * dy) < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      dragging = true;
    }
    const chip = chipAtLocal(e.clientX, e.clientY);
    if (!chip) return;
    const wk = chip.dataset.week;
    if (wk === lastToggled) return;
    lastToggled = wk;
    setChip(wk, mode === 'add');
  };

  const stop = () => { dragging = false; mode = null; armedAt = null; lastToggled = null; };

  // Retire les listeners de l'appel précédent avant d'en poser de nouveaux
  // (grid.innerHTML a détruit les enfants mais pas la grille elle-même).
  if (grid._boundDown) grid.removeEventListener('pointerdown', grid._boundDown);
  if (grid._boundMove) window.removeEventListener('pointermove', grid._boundMove);
  if (grid._boundStop) {
    window.removeEventListener('pointerup', grid._boundStop);
    window.removeEventListener('pointercancel', grid._boundStop);
    window.removeEventListener('blur', grid._boundStop);
  }
  grid._boundDown = onDown;
  grid._boundMove = onMove;
  grid._boundStop = stop;
  grid.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
}

async function saveCourse(e) {
  e.preventDefault();
  const f = e.target;
  const err = $('edit-error');
  err.hidden = true;
  const chosen = [...document.querySelectorAll('#edit-profile-chips .pchip.active')].map((c) => c.dataset.profile);
  const common = {
    title: f.title.value.trim(),
    teacher: f.teacher.value.trim(),
    room: f.room.value.trim(),
    notes: f.notes.value.trim(),
    groups: chosen.length ? chosen : ['BTI'],
  };
  if (!common.title) return showError(err, 'Le titre est requis.');
  if (!state.occurrences.length) return showError(err, 'Ajoute au moins un créneau.');

  // Validation par créneau
  for (const [i, o] of state.occurrences.entries()) {
    if (!o.startTime || !o.endTime) return showError(err, `Créneau ${i+1}: heures manquantes.`);
    if (o.endTime <= o.startTime) return showError(err, `Créneau ${i+1}: l’heure de fin doit être après le début.`);
    if (!o.weeks.size) return showError(err, `Créneau ${i+1}: sélectionne au moins une semaine.`);
  }

  const editingId = f.courseId.value;
  try {
    if (editingId) {
      // Édition d'un cours existant : mise à jour de cette occurrence (1er
      // créneau + 1re semaine) et création des autres.
      const cur = state.courses.find((c) => c.id === editingId);
      const [first, ...rest] = state.occurrences;
      const firstWeeks = [...first.weeks].sort();
      const primaryWeek = firstWeeks.includes(cur?.weekStart) ? cur.weekStart : firstWeeks[0];

      await put(`/api/admin/courses/${editingId}`, {
        ...common,
        dayOfWeek: first.dayOfWeek,
        startTime: first.startTime,
        endTime: first.endTime,
        weekStart: primaryWeek,
        date: computeDate(primaryWeek, first.dayOfWeek),
      });

      const otherFirst = firstWeeks.filter((w) => w !== primaryWeek);
      if (otherFirst.length) {
        await post('/api/admin/courses', {
          ...common,
          dayOfWeek: first.dayOfWeek,
          startTime: first.startTime,
          endTime: first.endTime,
          weeks: otherFirst,
        });
      }
      for (const o of rest) {
        await post('/api/admin/courses', {
          ...common,
          dayOfWeek: o.dayOfWeek,
          startTime: o.startTime,
          endTime: o.endTime,
          weeks: [...o.weeks].sort(),
        });
      }
    } else {
      for (const o of state.occurrences) {
        await post('/api/admin/courses', {
          ...common,
          dayOfWeek: o.dayOfWeek,
          startTime: o.startTime,
          endTime: o.endTime,
          weeks: [...o.weeks].sort(),
        });
      }
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
$('btn-sync').addEventListener('click', async () => {
  const r = await post('/api/admin/sync');
  alert(r.result?.updated
    ? `Synchro OK : ${r.result.file}\n${r.result.size} B\n${r.result.lastModified || ''}`
    : `Aucune mise à jour (${r.result?.reason || 'inconnu'}).`);
  await loadAll();
});
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

// Chips profils dans la modale édition (toggle)
document.querySelectorAll('#edit-profile-chips .pchip').forEach((chip) => {
  chip.addEventListener('click', () => chip.classList.toggle('active'));
});

// Bouton "+ Ajouter un créneau" dans la modale
$('add-occurrence').addEventListener('click', () => {
  const last = state.occurrences[state.occurrences.length - 1];
  state.occurrences.push({
    id: `occ_${Date.now()}`,
    dayOfWeek: last?.dayOfWeek || 1,
    startTime: last?.startTime || '09:00',
    endTime: last?.endTime || '12:00',
    weeks: new Set(last ? [...last.weeks] : []),
  });
  renderOccurrences();
});

// Tabs Liste / Agenda
document.querySelectorAll('.vtab').forEach((t) => {
  t.addEventListener('click', () => switchView(t.dataset.view));
});

// Contrôles agenda
$('agenda-prev').addEventListener('click', () => { state.agendaWeek = isoAddDays(state.agendaWeek, -7); renderAgenda(); });
$('agenda-next').addEventListener('click', () => { state.agendaWeek = isoAddDays(state.agendaWeek, 7); renderAgenda(); });
$('agenda-today').addEventListener('click', () => { state.agendaWeek = mondayOf(new Date()); renderAgenda(); });
$('agenda-week-input').addEventListener('change', (e) => {
  const iso = fromWeekInputValue(e.target.value);
  if (iso) { state.agendaWeek = iso; renderAgenda(); }
});

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
