// Parseur du fichier ADECal.vcs (export vCalendar/iCalendar) d'ADE.
//
// L'Excel reste la source de vérité du planning. Ce fichier n'est utilisé
// que pour ENRICHIR la salle quand l'Excel note un lieu générique
// "FSS STAPS Luminy" (ou similaire) et qu'ADE connaît la vraie salle.

import fs from 'node:fs/promises';

function unfold(text) {
  // vCard/iCalendar : les lignes "pliées" commencent par un espace ou
  // une tabulation ; on les recolle à la précédente.
  return text.replace(/\r?\n[ \t]/g, '');
}

function parseVcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur || !line) continue;
    const m = /^([A-Z-]+)(?:;[^:]*)?:(.*)$/.exec(line);
    if (m) cur[m[1]] = m[2];
  }
  return events;
}

// "20260909T070000Z" → { dateISO, hhmm } en heure locale Europe/Paris.
function utcToParis(utcString) {
  const y = utcString.slice(0, 4);
  const mo = utcString.slice(4, 6);
  const d = utcString.slice(6, 8);
  const hh = utcString.slice(9, 11);
  const mm = utcString.slice(11, 13);
  const ss = utcString.slice(13, 15);
  const utc = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss || '00'}Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(utc).reduce((o, p) => (o[p.type] = p.value, o), {});
  const hour24 = parts.hour === '24' ? '00' : parts.hour;
  return {
    dateISO: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${hour24}:${parts.minute}`,
  };
}

// Indexation par "YYYY-MM-DD|HH:MM" pour un match direct.
function buildRoomIndex(events) {
  const idx = new Map();
  for (const e of events) {
    if (!e.DTSTART || !e.LOCATION) continue;
    const { dateISO, hhmm } = utcToParis(e.DTSTART);
    const location = (e.LOCATION || '').replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
    const summary = (e.SUMMARY || '').replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
    if (!location) continue;
    idx.set(`${dateISO}|${hhmm}`, { location, summary, dateISO, hhmm });
  }
  return idx;
}

// Retourne un événement normalisé et exploitable :
// { title, room, teacher, date, startTime, endTime, dayOfWeek }.
function cleanText(s) {
  return String(s || '').replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractTeacher(description) {
  if (!description) return '';
  const cleaned = cleanText(description);
  // Format typique : "M2 BTI CANDONI Stephane (Modifié le:04/06/2026 …)"
  const m = /M2\s*BTI\s+([^\(]*?)\s*(?:\(|$)/i.exec(cleaned);
  if (!m) return '';
  return m[1].trim().replace(/^\W+|\W+$/g, '');
}
export function normalizeAdeEvent(e) {
  if (!e?.DTSTART) return null;
  const start = utcToParis(e.DTSTART);
  const end = e.DTEND ? utcToParis(e.DTEND) : null;
  const dow = new Date(start.dateISO + 'T00:00:00Z').getUTCDay() || 7; // 1..7
  return {
    title: cleanText(e.SUMMARY),
    room: cleanText(e.LOCATION),
    teacher: extractTeacher(e.DESCRIPTION),
    date: start.dateISO,
    startTime: start.hhmm,
    endTime: end?.hhmm || null,
    dayOfWeek: dow,
  };
}

// ─── Lexique enseignants (déduit d'ADE) ─────────────────────
// Extrait le "nom de famille" candidat d'un texte : le mot le plus long,
// ou tout mot entièrement en majuscules (convention nom de famille FR).
export function extractSurname(name) {
  if (!name) return null;
  const norm = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = norm.split(/[\s.\-\/,]+/).filter((w) => w.length >= 3);
  if (!words.length) return null;
  const upper = words.filter((w) => w === w.toUpperCase());
  if (upper.length === 1) return upper[0].toLowerCase();
  // sinon on prend le mot le plus long comme heuristique
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
  return longest.toLowerCase();
}

// Un nom "abrégé" ressemble à "S Roffino", "I. ABOUT", "T.Krieger", ou
// juste un nom seul (pas de prénom).
export function looksAbbreviated(name) {
  if (!name) return true;
  const t = String(name).trim();
  const words = t.split(/[\s.]+/).filter(Boolean);
  if (words.length === 1) return true;
  if (words.some((w) => /^[A-Z]$/i.test(w))) return true;
  return false;
}

// Bascule "TAILLEBOT Virginie" → "Virginie TAILLEBOT" (convention FR).
export function displayNameFR(name) {
  if (!name) return name;
  const words = String(name).trim().split(/\s+/);
  if (words.length < 2) return name;
  // On considère qu'un mot est "surname" s'il est entièrement en majuscules
  // (au moins 2 caractères, en ignorant les accents).
  const isUpper = (w) => {
    const stripped = w.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return stripped.length >= 2 && stripped === stripped.toUpperCase() && /[A-Z]/.test(stripped);
  };
  const upperWords = words.filter(isUpper);
  if (upperWords.length !== 1) return name;
  const surname = upperWords[0];
  const rest = words.filter((w) => w !== surname);
  return `${rest.join(' ')} ${surname}`;
}

export function buildTeacherLexicon(normalized) {
  const lex = new Map();
  for (const e of normalized) {
    if (!e.teacher) continue;
    const surname = extractSurname(e.teacher);
    if (!surname) continue;
    // On garde la première forme rencontrée, en la basculant FR.
    if (!lex.has(surname)) lex.set(surname, displayNameFR(e.teacher));
  }
  return lex;
}

export async function loadAdeIndex(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const events = parseVcs(text);
    const normalized = events.map(normalizeAdeEvent).filter(Boolean);
    const teacherLexicon = buildTeacherLexicon(normalized);
    return { events, index: buildRoomIndex(events), normalized, teacherLexicon };
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], index: new Map(), normalized: [], teacherLexicon: new Map() };
    throw err;
  }
}

// Chaîne test pour "l'Excel a mis un lieu générique FSS ?"
const GENERIC_FSS_RE = /\bFSS\b(?:.*(?:STAPS|Luminy))?/i;
export function isGenericFssRoom(room) {
  if (!room) return false;
  return GENERIC_FSS_RE.test(room);
}

// Cherche une salle plus précise dans ADE pour un cours (date + heure début).
// Retourne { location, source: 'ade' } si trouvé, sinon null.
export function findAdeRoom(adeIndex, dateISO, hhmm, currentRoom) {
  if (!adeIndex || !dateISO || !hhmm) return null;
  const key = `${dateISO}|${hhmm}`;
  const hit = adeIndex.get(key);
  if (!hit) return null;
  // On garde le résultat s'il est plus précis que "FSS générique".
  if (isGenericFssRoom(hit.location)) return null;
  if (hit.location.toLowerCase() === (currentRoom || '').toLowerCase()) return null;
  return { location: hit.location, source: 'ade', summary: hit.summary };
}
