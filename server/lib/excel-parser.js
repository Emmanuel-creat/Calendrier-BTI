// Parseur du fichier Excel du planning M2 BTI.
//
// Structure du fichier (feuille 26_27_V5 par défaut):
//  - Ligne 1  : entêtes de jour (Lundi/Mardi/Mercredi/Jeudi/Vendredi)
//  - Ligne 2  : entêtes horaires (DATE + créneaux "8h-9h", "9h-10h", …, "17h-18h")
//  - Ligne 3+ : une ligne = une semaine.
//               - Col A/B : dates de début / fin de la semaine
//               - Col C   : annotation ("semaine ECM", "vacances sco", …)
//               - Puis pour chaque jour un bloc: colonne DATE + 10 colonnes horaires.
//
// Les cours sont des cellules fusionnées qui couvrent plusieurs créneaux horaires.
// Le contenu d'une cellule est du type
//    "Nom du cours \nProfesseur \n(Salle)" ou séparé par ' | '
//
// La couleur de fond d'un cours code (partiellement) le groupe auquel il s'adresse.

import ExcelJS from 'exceljs';

const DAY_BLOCKS = [
  { day: 'Lundi',    dayOfWeek: 1, dateCol: 4,  slotStart: 5,  slotEnd: 14 }, // D + E..N
  { day: 'Mardi',    dayOfWeek: 2, dateCol: 15, slotStart: 16, slotEnd: 25 }, // O + P..Y
  { day: 'Mercredi', dayOfWeek: 3, dateCol: 26, slotStart: 27, slotEnd: 36 }, // Z + AA..AJ
  { day: 'Jeudi',    dayOfWeek: 4, dateCol: 37, slotStart: 38, slotEnd: 47 }, // AK + AL..AU
  { day: 'Vendredi', dayOfWeek: 5, dateCol: 48, slotStart: 49, slotEnd: 58 }, // AV + AW..BF (mais BF est utilisé pour "sem. ECM")
];

// Créneaux 8h à 18h par pas d'1h. slot 0 = 8h-9h, slot 9 = 17h-18h.
const HOUR_SLOTS = [
  { start: '08:00', end: '09:00' },
  { start: '09:00', end: '10:00' },
  { start: '10:00', end: '11:00' },
  { start: '11:00', end: '12:00' },
  { start: '12:00', end: '13:00' },
  { start: '13:00', end: '14:00' },
  { start: '14:00', end: '15:00' },
  { start: '15:00', end: '16:00' },
  { start: '16:00', end: '17:00' },
  { start: '17:00', end: '18:00' },
];

// Chaînes qui, si elles apparaissent seules dans une cellule fusionnée, ne
// représentent pas un cours (marqueurs internes du planning).
const NOISE_VALUES = new Set([
  'ok', 'OK', 'Ok', 'ok ', 'OK ',
  'ok ↓', 'ok →', 'OK->', 'ok->', 'OK->>',
  '?', '²', '',
]);

// Couleurs de fond identifiées empiriquement dans le fichier V5.
// Elles orientent la classification en groupes d'accueil.
const COLOR_HINTS = {
  FFFA06B4: { label: 'Rose (cours communs)',      groups: ['BTI'] },
  FFFF6600: { label: 'Orange (Anatomie/Chir.)',   groups: ['BTI'] },
  FF00B0F0: { label: 'Bleu (Projet/Réglementaire)', groups: ['BTI'] },
  FF00FF99: { label: 'Vert (événements)',         groups: ['BTI'] },
  FFFF0000: { label: 'Rouge (spécial)',           groups: ['BTI'] },
  FFFF8837: { label: 'Orange soutenu (SAE examen)', groups: ['BTI'] },
  FFFFC000: { label: 'Jaune (entêtes)',           groups: [] },
  FFFFFF00: { label: 'Jaune vif (dates)',         groups: [] },
};

// Motifs textuels qui aident à identifier les groupes / origines / sous-groupes
// mentionnés dans le libellé.
const ORIGIN_PATTERNS = [
  { re: /\bstaps\b/i,                  origin: 'STAPS' },
  { re: /\bcentrale\b|\bECM\b/i,       origin: 'ECM' },
  { re: /\bpolytech\b/i,               origin: 'PolyTech' },
  { re: /\bclinic|\bclinicien/i,       origin: 'Clinicien' },
];

const SUBGROUP_PATTERNS = [
  { re: /GROUPE\s*A|Grp\s*1|Groupe\s*1/i, subgroup: 'A' },
  { re: /GROUPE\s*B|Grp\s*2|Groupe\s*2/i, subgroup: 'B' },
  { re: /GROUPE\s*C|Grp\s*3|Groupe\s*3/i, subgroup: 'C' },
  { re: /GROUPE\s*D|Grp\s*4|Groupe\s*4/i, subgroup: 'D' },
];

function cellFillColor(cell) {
  const fg = cell.fill?.fgColor;
  if (!fg) return null;
  if (fg.argb) return fg.argb.toUpperCase();
  if (fg.theme !== undefined) return `THEME_${fg.theme}`;
  return null;
}

function unwrap(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !(value instanceof Date)) {
    if (Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text || '').join('');
    }
    if (value.result !== undefined) return unwrap(value.result);
    if (value.text !== undefined) return value.text;
    if (value.formula !== undefined) return null;
  }
  return value;
}

function toIsoDate(value) {
  const v = unwrap(value);
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function textOf(value) {
  const v = unwrap(value);
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function splitFields(text) {
  // Sépare le contenu d'une cellule par "|" ou par saut de ligne.
  return text
    .split(/[\n|]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const ROOM_HINT = /\b(?:salle|amphi|luminy|timone|sainte[- ]marguerite|ergolab|polytech|centrale|château gombert|ch\.? gombert|iut aix|iut d'aix|hopital|hôpital|zoom|visio|giboc|locaux|st charles|st\.? charles|campus|faculté|fac\b|imus?ti|fss|1er étage)/i;

function splitTeacherRoom(segment) {
  // Sépare "Prénom NOM (Salle)" ou "Prof / Prof2 (Salle)" en {teacher, room}.
  const parenMatch = segment.match(/^(.*?)\s*\((.+?)\)\s*$/);
  if (parenMatch) {
    return { teacher: parenMatch[1].trim(), room: parenMatch[2].trim() };
  }
  return null;
}

function parseCourseContent(rawText) {
  const parts = splitFields(rawText);
  if (!parts.length) {
    return { title: '', teacher: '', room: '', notes: '' };
  }

  let title = parts.shift() || '';
  let teacher = '';
  let room = '';
  const notes = [];

  for (const part of parts) {
    // Un segment qui est "(quelque chose)" est une salle
    const m = part.match(/^\((.+)\)\s*$/);
    if (m) {
      if (!room) room = m[1].trim();
      else notes.push(part);
      continue;
    }
    // Un segment "Prof (Salle)" combiné
    const tr = splitTeacherRoom(part);
    if (tr) {
      if (!teacher) teacher = tr.teacher;
      else notes.push(tr.teacher);
      if (!room) room = tr.room;
      else notes.push(`(${tr.room})`);
      continue;
    }
    // Détection heuristique de salle
    if (!room && ROOM_HINT.test(part)) {
      room = part.trim();
      continue;
    }
    // Sinon, considérons ça comme un prof/complément
    if (!teacher) teacher = part;
    else notes.push(part);
  }

  return { title, teacher, room, notes: notes.join(' | ') };
}

function detectGroups(rawText, color) {
  const groups = new Set();

  // Couleur => hint
  const hint = COLOR_HINTS[color];
  if (hint) hint.groups.forEach((g) => groups.add(g));

  // Origines détectées dans le texte
  const origins = [];
  for (const { re, origin } of ORIGIN_PATTERNS) {
    if (re.test(rawText)) origins.push(origin);
  }
  origins.forEach((o) => groups.add(o));

  // Sous-groupes
  const subgroups = [];
  for (const { re, subgroup } of SUBGROUP_PATTERNS) {
    if (re.test(rawText)) subgroups.push(`Groupe ${subgroup}`);
  }
  subgroups.forEach((s) => groups.add(s));

  // Marqueurs particuliers
  if (/M1\s*BTI/i.test(rawText)) groups.add('M1 BTI');
  if (/SAE\b/.test(rawText)) groups.add('SAE');

  // Par défaut, tout cours identifié concerne la promo BTI si aucun groupe précis.
  if (groups.size === 0) groups.add('BTI');
  return [...groups];
}

function isSpecialEvent(text) {
  if (!text) return null;
  const norm = text.trim().toLowerCase();
  if (norm.includes('vacances')) return 'vacances';
  if (norm.includes('ferie') || norm.includes('férié')) return 'ferie';
  if (norm.startsWith('jour de révisions') || norm.startsWith('jour de revisions')) return 'revisions';
  if (norm.startsWith('examen') || norm.startsWith('exam')) return 'examen';
  if (norm.startsWith('sae examen')) return 'examen';
  if (norm.startsWith('soutenances')) return 'soutenance';
  if (norm.startsWith('conseil')) return 'conseil';
  if (norm.startsWith('rencontres') || norm.startsWith('recontres')) return 'evenement';
  if (norm.startsWith('afterwork') || norm.startsWith('afterwok')) return 'evenement';
  if (norm.includes('live surgery')) return 'evenement';
  return null;
}

function stableId(...parts) {
  // Hash simple et déterministe.
  const str = parts.filter(Boolean).join('|');
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return `c_${(h >>> 0).toString(36)}`;
}

function findMergeAt(ws, row, col) {
  // ExcelJS ne fournit pas d'API simple pour retrouver la fusion contenant
  // une cellule. On lit `_merges` (map interne).
  const merges = ws._merges || {};
  for (const key of Object.keys(merges)) {
    const m = merges[key].model || merges[key];
    if (
      row >= m.top && row <= m.bottom &&
      col >= m.left && col <= m.right
    ) {
      return { top: m.top, left: m.left, bottom: m.bottom, right: m.right };
    }
  }
  return null;
}

export function parseWorkbook(workbook, sheetName = '26_27_V5') {
  const ws = workbook.getWorksheet(sheetName);
  if (!ws) throw new Error(`Feuille introuvable: ${sheetName}`);

  const courses = [];
  const weeks = new Map(); // key = ISO du lundi
  const warnings = [];

  // On parcourt chaque ligne à partir de la 3.
  for (let row = 3; row <= ws.rowCount; row++) {
    const weekStartRawExcel = toIsoDate(ws.getCell(row, 1).value);
    const weekEndRawExcel   = toIsoDate(ws.getCell(row, 2).value);
    if (!weekStartRawExcel) continue;

    // Le fichier Excel V5 contient un décalage : la cellule « Lundi » d'une
    // semaine porte parfois la date du dimanche précédent. On aligne
    // systématiquement la semaine sur le lundi réel (jour ISO 1).
    const lundiExcel = toIsoDate(ws.getCell(row, DAY_BLOCKS[0].dateCol).value);
    const weekStart = alignToRealMonday(lundiExcel || weekStartRawExcel);
    const weekEnd = weekEndRawExcel
      ? alignToRealFriday(weekEndRawExcel, weekStart)
      : addIsoDays(weekStart, 4);
    const annotation = textOf(ws.getCell(row, 3).value).trim() || null;

    weeks.set(weekStart, {
      weekStart,
      weekEnd,
      annotation,
      row,
      excelWeekStart: weekStartRawExcel,
    });

    // Balaye chaque jour et chaque créneau horaire.
    for (const block of DAY_BLOCKS) {
      // La date « officielle » du cours est calculée depuis weekStart aligné
      // (source d'autorité = étiquette Lundi/Mardi… + numéro de semaine).
      const dayISO = addIsoDays(weekStart, block.dayOfWeek - 1);

      // Pour ne pas doubler les cours fusionnés, on note ceux déjà traités.
      const seenMerges = new Set();

      for (let col = block.slotStart; col <= block.slotEnd; col++) {
        const cell = ws.getCell(row, col);
        const val = cell.value;
        const raw = textOf(val).trim();
        if (!raw) continue;

        // Position de la cellule maîtresse s'il s'agit d'une fusion
        let left = col;
        let right = col;
        if (cell.isMerged) {
          const master = cell.master;
          const merge = findMergeAt(ws, row, col);
          if (merge) {
            left = merge.left;
            right = merge.right;
          } else if (master) {
            const mAddr = master.address;
            const mCol = ws.getColumn(master.col || mAddr).number;
            left = mCol;
            right = mCol;
          }
          const key = `${row}:${left}:${right}`;
          if (seenMerges.has(key)) continue;
          seenMerges.add(key);
        }

        // Bornes horaires à partir des colonnes couvertes.
        const slotFrom = Math.max(left, block.slotStart) - block.slotStart;
        const slotTo   = Math.min(right, block.slotEnd)   - block.slotStart;
        if (slotFrom < 0 || slotTo < 0 || slotFrom > 9) continue;
        const clampedFrom = Math.max(0, slotFrom);
        const clampedTo   = Math.min(9, slotTo);
        const startTime = HOUR_SLOTS[clampedFrom].start;
        const endTime   = HOUR_SLOTS[clampedTo].end;

        // Cellules "marqueur" (ok, ?, …) — on ignore.
        if (NOISE_VALUES.has(raw) || raw.length <= 3) continue;

        const color = cellFillColor(cell);
        const special = isSpecialEvent(raw);
        const parsed = special ? { title: raw, teacher: '', room: '', notes: '' } : parseCourseContent(raw);
        const groups = detectGroups(raw, color);

        const id = stableId(
          weekStart, block.dayOfWeek, startTime, endTime,
          parsed.title || raw, parsed.room, parsed.teacher
        );

        courses.push({
          id,
          weekStart,
          date: dayISO,
          dayOfWeek: block.dayOfWeek,
          day: block.day,
          startTime,
          endTime,
          title: parsed.title || raw,
          teacher: parsed.teacher,
          room: parsed.room,
          notes: parsed.notes,
          groups,
          color,
          special: special || null,
          raw,
          source: {
            sheet: sheetName,
            row,
            col: left,
          },
        });
      }
    }
  }

  return {
    courses,
    weeks: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    warnings,
    sheetName,
  };
}

function alignToRealMonday(iso) {
  // Retourne l'ISO du lundi effectif de la semaine contenant `iso`.
  // Utilise le calendrier réel (getDay: 0=dimanche, 1=lundi).
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0..6
  const offset = dow === 0 ? 1 : (1 - dow); // dimanche => +1, mardi => -1, …
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function alignToRealFriday(iso, weekStart) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const offset = 5 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  const aligned = d.toISOString().slice(0, 10);
  // Cohérence : vendredi = lundi + 4
  return addIsoDays(weekStart, 4) === aligned ? aligned : addIsoDays(weekStart, 4);
}

function addIsoDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function parseExcelFile(filePath, sheetName = '26_27_V5') {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return parseWorkbook(wb, sheetName);
}
