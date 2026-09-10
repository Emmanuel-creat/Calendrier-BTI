import { get } from './api.js';
import {
  mondayOf, toISO, isoAddDays, todayIso, parseISO,
  toWeekInputValue, fromWeekInputValue, isoWeekLabel,
  DAY_NAMES,
} from './dates.js';
import { renderCalendar, buildMobileDayTabs } from './calendar.js';

const ALLOWED_PROFILES = new Set(['BTI', 'PolyTech', 'ECM', 'Clinicien']);
const storedProfile = localStorage.getItem('bti.profile');
const state = {
  weekStart: mondayOf(new Date()),
  profile: storedProfile && ALLOWED_PROFILES.has(storedProfile) ? storedProfile : 'BTI',
  today: todayIso(),
  now: new Date(),
  activeMobileDay: null,
  weeksMeta: [],
  currentWeekMeta: null,
  courses: [],
};

const $ = (id) => document.getElementById(id);
const elCalendar    = $('calendar');
const elCalendarWrap = $('calendar-wrap');
const elEmpty       = $('empty-state');
const elEyebrow     = $('topbar-eyebrow');
const elHeading     = $('topbar-heading');
const elWeekInput   = $('week-input');
const elPrev        = $('prev-week');
const elNext        = $('next-week');
const elToday       = $('today-btn');
const elStatCount   = $('stat-count');
const elPillNow     = $('pill-now');
const elPillNext    = $('pill-next');
const elModal       = $('course-modal');
const elModalBody   = $('course-modal-body');

// Mobile
const elMTB        = document.querySelector('.mobile-topbar');
const elMHeading   = $('m-heading');
const elMPrev      = $('m-prev');
const elMNext      = $('m-next');
const elMMenu      = $('m-open-menu');
const elMSheet     = $('mobile-sheet');
const elMPrevWeek  = $('m-prev-week');
const elMNextWeek  = $('m-next-week');
const elMWeekInput = $('m-week-input');
const elMTodayBtn  = $('m-today-btn');
const elMProfileBtns = $('profile-btns-mobile');

// Onglets jours mobile insérés dynamiquement dans la card calendrier
const elMobileTabs = document.createElement('div');
elMobileTabs.className = 'mobile-day-tabs';
elCalendarWrap.insertBefore(elMobileTabs, elCalendar);

// ─── Bootstrap ───────────────────────────────────────────────
(async function init() {
  await refresh();
  wireEvents();
  renderProfileButtons();
  scheduleNowTick();
})();

async function refresh() {
  const { courses } = await get(
    `/api/courses?weekStart=${state.weekStart}&profile=${encodeURIComponent(state.profile)}`
  );
  state.courses = courses;

  if (!state.weeksMeta.length) {
    const { weeks } = await get('/api/weeks');
    state.weeksMeta = weeks;
  }
  state.currentWeekMeta = state.weeksMeta.find((w) => w.weekStart === state.weekStart) || null;

  const todayIndex = weekDayIndex(state.weekStart, state.today);
  state.activeMobileDay = todayIndex >= 0 ? todayIndex : 0;

  render();
  updateMeta();
  updatePills();
}

function render() {
  elWeekInput.value = toWeekInputValue(state.weekStart);
  if (elMWeekInput) elMWeekInput.value = toWeekInputValue(state.weekStart);

  const label = isoWeekLabel(state.weekStart);
  const annotation = state.currentWeekMeta?.annotation ? ` · ${state.currentWeekMeta.annotation}` : '';
  const isCurrentWeek = state.weekStart === mondayOf(new Date());
  elEyebrow.textContent = isCurrentWeek ? 'Semaine en cours' : label;
  elHeading.textContent = isCurrentWeek
    ? `Aujourd’hui${annotation}`
    : `Du ${dateShort(state.weekStart)} au ${dateShort(isoAddDays(state.weekStart, 4))}${annotation}`;

  // Titre mobile compact
  if (elMHeading) {
    if (isCurrentWeek) elMHeading.textContent = 'Aujourd’hui';
    else elMHeading.textContent = `${dateShort(state.weekStart)} – ${dateShort(isoAddDays(state.weekStart, 4))}`;
  }

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

  // Reflect active profile in both sets of buttons
  document.querySelectorAll('.profile-btns .pbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.profile === state.profile);
  });
}

function updateMeta() {
  if (elStatCount) elStatCount.textContent = state.courses.length;
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

// Reflect / handle profile buttons (desktop + mobile)
function renderProfileButtons() {
  // Duplique le contenu desktop dans le sheet mobile.
  if (elMProfileBtns) {
    const desktop = document.getElementById('profile-btns');
    if (desktop) elMProfileBtns.innerHTML = desktop.innerHTML;
  }
  document.querySelectorAll('.profile-btns .pbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.profile = btn.dataset.profile || 'BTI';
      localStorage.setItem('bti.profile', state.profile);
      refresh();
    });
  });
}

function wireEvents() {
  const goPrev  = () => { state.weekStart = isoAddDays(state.weekStart, -7); refresh(); };
  const goNext  = () => { state.weekStart = isoAddDays(state.weekStart, 7); refresh(); };
  const goToday = () => {
    state.today = todayIso();
    state.weekStart = mondayOf(new Date());
    refresh();
  };
  elPrev.addEventListener('click', goPrev);
  elNext.addEventListener('click', goNext);
  elToday.addEventListener('click', goToday);
  if (elMPrev)     elMPrev.addEventListener('click', goPrev);
  if (elMNext)     elMNext.addEventListener('click', goNext);
  if (elMPrevWeek) elMPrevWeek.addEventListener('click', goPrev);
  if (elMNextWeek) elMNextWeek.addEventListener('click', goNext);
  if (elMTodayBtn) elMTodayBtn.addEventListener('click', () => { goToday(); closeMobileSheet(); });
  if (elMHeading)  elMHeading.addEventListener('click', () => openMobileSheet());
  if (elMMenu)     elMMenu.addEventListener('click', () => openMobileSheet());

  const onWeekChange = (input) => {
    const iso = fromWeekInputValue(input.value);
    if (iso) { state.weekStart = iso; refresh(); }
  };
  elWeekInput.addEventListener('change', () => onWeekChange(elWeekInput));
  if (elMWeekInput) elMWeekInput.addEventListener('change', () => onWeekChange(elMWeekInput));

  // Fermer les modales / sheets
  elModal.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-modal-close')) closeModal();
  });
  if (elMSheet) elMSheet.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.hasAttribute('data-sheet-close')) closeMobileSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeMobileSheet(); }
  });

  // Swipe mobile
  let touchStartX = 0, touchStartY = 0;
  elCalendarWrap.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; touchStartX = t.clientX; touchStartY = t.clientY;
  }, { passive: true });
  elCalendarWrap.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    if (mobile) {
      if (dx < 0 && state.activeMobileDay < 4) { state.activeMobileDay++; render(); }
      else if (dx > 0 && state.activeMobileDay > 0) { state.activeMobileDay--; render(); }
      else if (dx < 0) { goNext(); }
      else { goPrev(); }
    } else {
      if (dx < 0) goNext(); else goPrev();
    }
  }, { passive: true });
}

function openMobileSheet() {
  if (!elMSheet) return;
  elMSheet.hidden = false;
}
function closeMobileSheet() {
  if (elMSheet) elMSheet.hidden = true;
}

function scheduleNowTick() {
  setInterval(() => {
    state.now = new Date();
    state.today = todayIso();
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
