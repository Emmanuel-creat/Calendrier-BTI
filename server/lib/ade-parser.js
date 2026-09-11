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

export async function loadAdeIndex(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const events = parseVcs(text);
    return { events, index: buildRoomIndex(events) };
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], index: new Map() };
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
