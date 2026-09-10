// Rend un calendrier hebdomadaire (lundi-vendredi, 8h-18h).
// Génère une grille avec une colonne "rail horaire" + 5 colonnes jours,
// et positionne les cours en absolute selon leurs heures de début/fin.

import { DAY_NAMES, parseISO, isoAddDays, toISO } from './dates.js';

const GRID_START_HOUR = 8;
const GRID_END_HOUR = 18;
const HOURS = GRID_END_HOUR - GRID_START_HOUR;

// Palette basée sur la couleur d'origine (ARGB Excel).
function colorClass(color, special) {
  if (special) return 'special';
  if (!color) return '';
  switch (color.toUpperCase()) {
    case 'FFFA06B4': return 'c-pink';
    case 'FFFF6600':
    case 'FFFF8837': return 'c-orange';
    case 'FF00B0F0': return 'c-blue';
    case 'FFFF0000': return 'c-red';
    case 'FF00FF99': return 'c-green';
    case 'FFFFFF00':
    case 'FFFFC000': return 'c-yellow';
    default: return '';
  }
}

function hourToOffset(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h - GRID_START_HOUR) + (m / 60);
}

export function renderCalendar(container, {
  weekStart,
  courses,
  today,
  now,
  activeMobileDay,
  onCourseClick,
  onDayTabClick,
}) {
  container.innerHTML = '';

  // Colonne "rail horaire" — cellule d'entête + slots horaires
  const hourHeader = el('div', { class: 'hour-rail-header' });
  container.appendChild(hourHeader);

  const dayHeaders = [];
  const dayCols = [];
  for (let i = 0; i < 5; i++) {
    const dayISO = isoAddDays(weekStart, i);
    const isToday = dayISO === today;
    const isActiveMobile = i === activeMobileDay;

    const dayDate = parseISO(dayISO);
    const header = el('div', {
      class: `day-header${isToday ? ' today' : ''}${!isActiveMobile ? ' hidden-mobile' : ''}`,
    });
    header.innerHTML = `
      <span>${DAY_NAMES[dayDate.getDay()]}</span>
      <strong>${dayDate.getDate()} ${dayDate.toLocaleDateString('fr-FR', { month: 'short' })}</strong>
    `;
    dayHeaders.push(header);
    container.appendChild(header);
  }

  // Rail horaire (slots)
  const rail = el('div', { class: 'hour-rail' });
  for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h++) {
    const slot = el('div', { class: 'hour-rail-slot' });
    slot.textContent = `${h}h`;
    rail.appendChild(slot);
  }
  container.appendChild(rail);

  // Colonnes jours
  for (let i = 0; i < 5; i++) {
    const dayISO = isoAddDays(weekStart, i);
    const isToday = dayISO === today;
    const isActiveMobile = i === activeMobileDay;
    const col = el('div', {
      class: `day-col${isToday ? ' today' : ''}${!isActiveMobile ? ' hidden-mobile' : ''}`,
      'data-day': String(i + 1),
    });
    dayCols.push(col);

    // Cours du jour i
    const dayCourses = courses.filter((c) => c.dayOfWeek === (i + 1));
    for (const c of dayCourses) {
      const top = hourToOffset(c.startTime);
      const bottom = hourToOffset(c.endTime);
      const height = Math.max(bottom - top, 0.5);

      const node = el('div', {
        class: `course ${colorClass(c.color, c.special)}`,
        style: `top: calc(var(--hour-height) * ${top}); height: calc(var(--hour-height) * ${height} - 4px);`,
        'data-id': c.id,
        role: 'button',
        tabindex: '0',
      });

      const meta = [];
      if (c.teacher) meta.push(`<span class="row">👤 ${escapeHtml(c.teacher)}</span>`);
      if (c.room) meta.push(`<span class="row">📍 ${escapeHtml(c.room)}</span>`);
      meta.push(`<span class="row">⏱ ${c.startTime}–${c.endTime}</span>`);
      node.innerHTML = `
        <div class="course-title">${escapeHtml(c.title)}</div>
        <div class="course-meta">${meta.join('')}</div>
      `;
      node.addEventListener('click', () => onCourseClick?.(c));
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter') onCourseClick?.(c); });
      col.appendChild(node);
    }

    // Barre bleue "maintenant"
    if (isToday && now) {
      const hoursNow = now.getHours() + now.getMinutes() / 60;
      if (hoursNow >= GRID_START_HOUR && hoursNow <= GRID_END_HOUR) {
        const line = el('div', {
          class: 'now-line',
          style: `top: calc(var(--hour-height) * ${hoursNow - GRID_START_HOUR});`,
          'aria-label': `Heure actuelle: ${pad(now.getHours())}:${pad(now.getMinutes())}`,
        });
        col.appendChild(line);
      }
    }

    container.appendChild(col);
  }

  return { dayCols, dayHeaders };
}

export function buildMobileDayTabs(container, {
  weekStart,
  today,
  active,
  onSelect,
}) {
  container.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const iso = isoAddDays(weekStart, i);
    const date = parseISO(iso);
    const isToday = iso === today;
    const isActive = i === active;
    const btn = el('button', {
      type: 'button',
      class: `mobile-day-tab${isActive ? ' active' : ''}${isToday ? ' today' : ''}`,
    });
    btn.innerHTML = `${DAY_NAMES[date.getDay()].slice(0,3)}<strong>${date.getDate()}</strong>`;
    btn.addEventListener('click', () => onSelect?.(i));
    container.appendChild(btn);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────
function el(tag, attrs = {}) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  return n;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function pad(n) { return String(n).padStart(2, '0'); }
