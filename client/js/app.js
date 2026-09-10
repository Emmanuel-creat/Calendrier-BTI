import { get } from './api.js';
import {
  mondayOf, toISO, isoAddDays, todayIso, parseISO,
  toWeekInputValue, fromWeekInputValue, isoWeekLabel,
  DAY_NAMES,
} from './dates.js';
import { renderCalendar, buildMobileDayTabs } from './calendar.js';

const state = {
  weekStart: mondayOf(new Date()),
  profile: localStorage.getItem('bti.profile') || 'BTI',
  today: todayIso(),
  now: new Date(),
  activeMobileDay: null, // 0..4
  weeksMeta: [],
  currentWeekMeta: null,
  courses: [],
};

const elCalendar    = document.getElementById('calendar');
const elCalendarWrap = document.getElementById('calendar-wrap');
const elEmpty       = document.getElementById('empty-state');
const elEyebrow     = document.getElementById('topbar-eyebrow');
const elHeading     = document.getElementById('topbar-heading');
const elProfile     = document.getElementById('profile-select');
const elWeekInput   = document.getElementById('week-input');
const elPrev        = document.getElementById('prev-week');
const elNext        = document.getElementById('next-week');
const elToday       = document.getElementById('today-btn');
const elMeta        = document.getElementById('meta-info');
const elPromoMeta   = document.getElementById('promo-meta');
const elPillNow     = document.getElementById('pill-now');
const elPillNext    = document.getElementById('pill-next');
const elModal       = document.getElementById('course-modal');
const elModalBody   = document.getElementById('course-modal-body');

// Onglet mobile jours (créé dynamiquement)
const elMobileTabs = document.createElement('div');
elMobileTabs.className = 'mobile-day-tabs';
elCalendarWrap.insertBefore(elMobileTabs, elCalendar);

// ─── Bootstrap ───────────────────────────────────────────────────────
(async function init() {
  await loadProfiles();
  await refresh();
  wireEvents();
  scheduleNowTick();
})();

async function loadProfiles() {
  const { groups } = await get('/api/profiles');
  const opts = ['BTI', ...groups.filter((g) => g !== 'BTI')];
  elProfile.innerHTML = opts.map((g) => {
    const label = g === 'BTI' ? 'Tous les cours (BTI)' : g;
    return `<option value="${g}"${g === state.profile ? ' selected' : ''}>${label}</option>`;
  }).join('');
}

async function refresh() {
  // Requête sur la semaine courante
  const { courses } = await get(
    `/api/courses?weekStart=${state.weekStart}&profile=${encodeURIComponent(state.profile)}`
  );
  state.courses = courses;

  // Détecter les métadonnées de la semaine (annotation, etc.)
  if (!state.weeksMeta.length) {
    const { weeks } = await get('/api/weeks');
    state.weeksMeta = weeks;
  }
  state.currentWeekMeta = state.weeksMeta.find((w) => w.weekStart === state.weekStart) || null;

  // Choix par défaut du jour actif en mobile: aujourd'hui si visible, sinon lundi.
  const todayIndex = weekDayIndex(state.weekStart, state.today);
  state.activeMobileDay = todayIndex >= 0 ? todayIndex : 0;

  render();
  updateMeta();
  updatePills();
}

function render() {
  elWeekInput.value = toWeekInputValue(state.weekStart);
  const label = isoWeekLabel(state.weekStart);
  const annotation = state.currentWeekMeta?.annotation ? ` · ${state.currentWeekMeta.annotation}` : '';
  const isCurrentWeek = state.weekStart === mondayOf(new Date());
  elEyebrow.textContent = isCurrentWeek ? 'Semaine en cours' : label;
  elHeading.textContent = isCurrentWeek
    ? `Aujourd’hui${annotation}`
    : `Du ${dateShort(state.weekStart)} au ${dateShort(isoAddDays(state.weekStart, 4))}${annotation}`;

  renderCalendar(elCalendar, {
    weekStart: state.weekStart,
    courses: state.courses,
    today: state.today,
    now: state.now,
    activeMobileDay: state.activeMobileDay,
    onCourseClick: openCourseModal,
  });

  buildMobileDayTabs(elMobileTabs, {
    weekStart: state.weekStart,
    today: state.today,
    active: state.activeMobileDay,
    onSelect: (i) => {
      state.activeMobileDay = i;
      render();
    },
  });

  const hasCourses = state.courses.length > 0;
  elCalendar.hidden = !hasCourses;
  elEmpty.hidden = hasCourses;
}

function updateMeta() {
  const s = state.courses.length === 1 ? 'cours' : 'cours';
  elMeta.textContent = `${state.courses.length} ${s} cette semaine`;
  if (elPromoMeta) elPromoMeta.textContent = `Source Excel · ${state.weeksMeta.length} semaines chargées`;
}

function updatePills() {
  const inWeek = state.courses.filter((c) => c.date === state.today);
  const nowMin = state.now.getHours() * 60 + state.now.getMinutes();

  const running = inWeek.find((c) => timeToMin(c.startTime) <= nowMin && timeToMin(c.endTime) > nowMin);
  const next = inWeek
    .filter((c) => timeToMin(c.startTime) > nowMin)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))[0];

  if (running) {
    elPillNow.hidden = false;
    elPillNow.textContent = `${running.title} — jusqu’à ${running.endTime}${running.room ? ' · ' + running.room : ''}`;
  } else elPillNow.hidden = true;

  if (next) {
    elPillNext.hidden = false;
    elPillNext.textContent = `Prochain à ${next.startTime} · ${next.title}`;
  } else elPillNext.hidden = true;
}

function wireEvents() {
  elPrev.addEventListener('click', () => {
    state.weekStart = isoAddDays(state.weekStart, -7);
    refresh();
  });
  elNext.addEventListener('click', () => {
    state.weekStart = isoAddDays(state.weekStart, 7);
    refresh();
  });
  elToday.addEventListener('click', () => {
    state.today = todayIso();
    state.weekStart = mondayOf(new Date());
    refresh();
  });
  elWeekInput.addEventListener('change', () => {
    const iso = fromWeekInputValue(elWeekInput.value);
    if (iso) {
      state.weekStart = iso;
      refresh();
    }
  });
  elProfile.addEventListener('change', () => {
    state.profile = elProfile.value;
    localStorage.setItem('bti.profile', state.profile);
    refresh();
  });

  // Fermer la modale
  elModal.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-modal-close')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // Swipe mobile: navigation entre jours puis semaines
  let touchStartX = 0;
  let touchStartY = 0;
  elCalendarWrap.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; touchStartX = t.clientX; touchStartY = t.clientY;
  }, { passive: true });
  elCalendarWrap.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    if (window.matchMedia('(max-width: 720px)').matches) {
      if (dx < 0 && state.activeMobileDay < 4) { state.activeMobileDay++; render(); }
      else if (dx > 0 && state.activeMobileDay > 0) { state.activeMobileDay--; render(); }
      else if (dx < 0) { state.weekStart = isoAddDays(state.weekStart, 7); refresh(); }
      else { state.weekStart = isoAddDays(state.weekStart, -7); refresh(); }
    } else {
      if (dx < 0) { state.weekStart = isoAddDays(state.weekStart, 7); refresh(); }
      else { state.weekStart = isoAddDays(state.weekStart, -7); refresh(); }
    }
  }, { passive: true });
}

function scheduleNowTick() {
  // Met à jour la barre bleue et les pills toutes les 60 s.
  setInterval(() => {
    state.now = new Date();
    state.today = todayIso();
    // Repositionner uniquement la barre "now" sans tout re-render si possible.
    const nowLines = document.querySelectorAll('.now-line');
    if (nowLines.length) {
      const hoursNow = state.now.getHours() + state.now.getMinutes() / 60;
      nowLines.forEach((line) => {
        line.style.top = `calc(var(--hour-height) * ${hoursNow - 8})`;
      });
    }
    updatePills();
  }, 60_000);
}

function openCourseModal(course) {
  elModalBody.innerHTML = renderCourseDetails(course);
  elModal.hidden = false;
}
function closeModal() { elModal.hidden = true; }

function renderCourseDetails(c) {
  const chips = (c.groups || []).map((g) => `<span class="chip">${escapeHtml(g)}</span>`).join('');
  return `
    <div class="course-details">
      <h2 id="course-modal-title">${escapeHtml(c.title)}</h2>
      <div>${chips}</div>
      <p class="meta-line"><strong>Quand :</strong> ${DAY_NAMES[parseISO(c.date).getDay()]} ${dateLong(c.date)} · ${c.startTime}–${c.endTime}</p>
      ${c.teacher ? `<p class="meta-line"><strong>Enseignant·e :</strong> ${escapeHtml(c.teacher)}</p>` : ''}
      ${c.room ? `<p class="meta-line"><strong>Lieu :</strong> ${escapeHtml(c.room)}</p>` : ''}
      ${c.notes ? `<p class="meta-line"><strong>Notes :</strong> ${escapeHtml(c.notes)}</p>` : ''}
      ${c.special ? `<p class="meta-line"><em>Événement : ${escapeHtml(c.special)}</em></p>` : ''}
    </div>
  `;
}

function dateLong(iso) {
  return parseISO(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
function dateShort(iso) {
  return parseISO(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function weekDayIndex(weekStart, iso) {
  if (!iso) return -1;
  const start = parseISO(weekStart);
  const target = parseISO(iso);
  const diff = Math.round((target - start) / (1000 * 60 * 60 * 24));
  return diff >= 0 && diff <= 4 ? diff : -1;
}
