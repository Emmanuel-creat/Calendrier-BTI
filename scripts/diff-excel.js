// Compare l'Excel courant avec les données appliquées côté site.
// Utile pour vérifier avant/après une modification.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanningStore } from '../server/lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const store = new PlanningStore({
  excelPath: process.env.EXCEL_PATH || path.join(root, 'data', 'planning.xlsx'),
  cachePath: process.env.CACHE_PATH || path.join(root, 'data', 'planning-cache.json'),
  overridesPath: process.env.OVERRIDES_PATH || path.join(root, 'data', 'overrides.json'),
  sheetName: process.env.EXCEL_SHEET || '26_27_V5',
  shiftDays: process.env.EXCEL_SHIFT_DAYS != null ? Number(process.env.EXCEL_SHIFT_DAYS) : undefined,
});
await store.init();

const diff = store.diffAgainstExcel();
console.log(`[diff] Ajoutés : ${diff.added.length}`);
diff.added.forEach((c) => console.log('  +', c.weekStart, c.day, c.startTime, c.title));
console.log(`[diff] Supprimés : ${diff.removed.length}`);
diff.removed.forEach((c) => console.log('  -', c.weekStart, c.day, c.startTime, c.title));
console.log(`[diff] Modifiés : ${diff.modified.length}`);
diff.modified.forEach((m) => {
  console.log('  ~', m.current.weekStart, m.current.day, m.current.startTime, m.current.title);
  m.changes.forEach((ch) => console.log('      ', ch.field, ':', ch.from, '→', ch.to));
});
