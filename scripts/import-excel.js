// Utilitaire ligne de commande : lit le fichier Excel du planning et écrit
// un cache JSON exploité par le serveur.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExcelFile } from '../server/lib/excel-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const excelPath = process.env.EXCEL_PATH || path.join(root, 'data', 'planning.xlsx');
const cachePath = process.env.CACHE_PATH || path.join(root, 'data', 'planning-cache.json');
const sheetName = process.env.EXCEL_SHEET || '26_27_V5';

console.log(`[import] Lecture   : ${excelPath}`);
console.log(`[import] Feuille   : ${sheetName}`);

const shiftDays = process.env.EXCEL_SHIFT_DAYS != null ? Number(process.env.EXCEL_SHIFT_DAYS) : 364;
console.log(`[import] Décalage : ${shiftDays} jours`);
const result = await parseExcelFile(excelPath, sheetName, { shiftDays });
console.log(`[import] Cours     : ${result.courses.length}`);
console.log(`[import] Semaines  : ${result.weeks.length}`);
if (result.warnings.length) {
  console.log('[import] Avertissements:');
  for (const w of result.warnings) console.log('  -', w);
}

await fs.mkdir(path.dirname(cachePath), { recursive: true });
await fs.writeFile(cachePath, JSON.stringify({
  parsedAt: new Date().toISOString(),
  sheetName,
  ...result,
}, null, 2), 'utf8');
console.log(`[import] Cache écrit: ${cachePath}`);
