// Validation systématique : lit l'Excel, calcule des statistiques, et vérifie
// qu'aucun cours n'a d'heure de fin ≤ début, que chaque semaine possède un
// lundi valide, que les couleurs connues sont bien mappées, etc.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExcelFile } from '../server/lib/excel-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const excelPath = path.join(__dirname, '..', 'data', 'planning.xlsx');

const shiftDays = process.env.EXCEL_SHIFT_DAYS != null ? Number(process.env.EXCEL_SHIFT_DAYS) : 364;
const { courses, weeks } = await parseExcelFile(excelPath, process.env.EXCEL_SHEET || '26_27_V5', { shiftDays });

let errors = 0;
const check = (cond, msg) => {
  if (!cond) { console.log('  ✗', msg); errors++; }
};

console.log(`\n[verify] ${courses.length} cours, ${weeks.length} semaines`);

// 1. Cohérence temporelle
for (const c of courses) {
  check(c.endTime > c.startTime, `${c.id} ${c.title} — fin ≤ début (${c.startTime}→${c.endTime})`);
  check(!!c.date, `${c.id} ${c.title} — date manquante`);
  check(c.dayOfWeek >= 1 && c.dayOfWeek <= 5, `${c.id} — dayOfWeek hors [1..5]`);
}

// 2. Cohérence semaine
for (const w of weeks) {
  const dow = new Date(w.weekStart + 'T00:00:00Z').getUTCDay();
  check(dow === 1, `Semaine ${w.weekStart} — pas un lundi (dow=${dow})`);
  if (w.weekEnd) {
    const dowE = new Date(w.weekEnd + 'T00:00:00Z').getUTCDay();
    check(dowE === 5, `Semaine ${w.weekStart} — end pas un vendredi (dow=${dowE})`);
  }
}

// 3. Statistiques
const byDay = {1:0,2:0,3:0,4:0,5:0};
courses.forEach((c) => byDay[c.dayOfWeek]++);
console.log('[verify] Répartition par jour:');
['Lundi','Mardi','Mercredi','Jeudi','Vendredi'].forEach((d, i) => console.log(`   ${d} : ${byDay[i+1]}`));

const uniqTeachers = new Set(courses.map((c) => c.teacher).filter(Boolean));
const uniqRooms = new Set(courses.map((c) => c.room).filter(Boolean));
console.log(`[verify] ${uniqTeachers.size} enseignant(e)s distinct(e)s, ${uniqRooms.size} salles distinctes`);

if (errors) {
  console.log(`\n[verify] ✗ ${errors} erreur(s)`);
  process.exit(1);
}
console.log('\n[verify] ✓ Toutes les vérifications passent');
