import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanningStore } from './lib/store.js';
import { apiRoutes } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const EXCEL_PATH = process.env.EXCEL_PATH || path.join(root, 'data', 'planning.xlsx');
const CACHE_PATH = process.env.CACHE_PATH || path.join(DATA_DIR, 'planning-cache.json');
const OVERRIDES_PATH = process.env.OVERRIDES_PATH || path.join(DATA_DIR, 'overrides.json');
const EXCEL_SHEET = process.env.EXCEL_SHEET || '26_27_V5';

const store = new PlanningStore({
  excelPath: EXCEL_PATH,
  cachePath: CACHE_PATH,
  overridesPath: OVERRIDES_PATH,
  sheetName: EXCEL_SHEET,
});
await store.init();

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

app.use('/api', apiRoutes(store));

// Interface constructeur (URL non annoncée dans l'UI publique).
app.use('/constructeur', express.static(path.join(root, 'client', 'admin')));
app.get('/constructeur', (_req, res) => {
  res.sendFile(path.join(root, 'client', 'admin', 'index.html'));
});

// Fichiers statiques de l'application publique
app.use(express.static(path.join(root, 'client'), {
  extensions: ['html'],
}));
app.get('/', (_req, res) => {
  res.sendFile(path.join(root, 'client', 'index.html'));
});

// Health-check (Render)
app.get('/healthz', (_req, res) => res.json({ ok: true, ...store.meta() }));

app.listen(PORT, () => {
  console.log(`[bti] écoute sur http://localhost:${PORT}`);
  const meta = store.meta();
  console.log(`[bti] source Excel: ${EXCEL_PATH} (feuille ${meta.sheetName})`);
  console.log(`[bti] cours: ${store.getCourses().length} — semaines: ${store.getWeeks().length}`);
  if (!process.env.CONSTRUCTOR_PASSWORD) {
    console.warn('[bti] ⚠ CONSTRUCTOR_PASSWORD non défini — l\'espace constructeur restera inaccessible.');
  }
});
