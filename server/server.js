import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanningStore } from './lib/store.js';
import { apiRoutes } from './routes/api.js';
import { syncRemoteExcel, DEFAULT_REMOTE_URL } from './lib/remote-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const EXCEL_PATH = process.env.EXCEL_PATH || path.join(root, 'data', 'planning.xlsx');
const CACHE_PATH = process.env.CACHE_PATH || path.join(DATA_DIR, 'planning-cache.json');
const OVERRIDES_PATH = process.env.OVERRIDES_PATH || path.join(DATA_DIR, 'overrides.json');
// Si non défini, le parseur choisira automatiquement la feuille "V<N>" la
// plus élevée du fichier — utile quand l'Excel amont ajoute une révision.
const EXCEL_SHEET = process.env.EXCEL_SHEET || undefined;

// Auto-sync avec le partage public AMU Box.
const REMOTE_URL = process.env.REMOTE_URL || DEFAULT_REMOTE_URL;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 30 * 60 * 1000);
const SYNC_ENABLED = process.env.REMOTE_SYNC !== '0';
const SYNC_STATE_PATH = path.join(DATA_DIR, 'remote-sync.json');

const store = new PlanningStore({
  excelPath: EXCEL_PATH,
  cachePath: CACHE_PATH,
  overridesPath: OVERRIDES_PATH,
  sheetName: EXCEL_SHEET,
  shiftDays: process.env.EXCEL_SHIFT_DAYS != null ? Number(process.env.EXCEL_SHIFT_DAYS) : undefined,
});

async function syncAndRebuild() {
  try {
    const res = await syncRemoteExcel({
      shareUrl: REMOTE_URL,
      targetPath: EXCEL_PATH,
      stateFile: SYNC_STATE_PATH,
    });
    if (res.updated) {
      console.log(`[sync] nouvel Excel récupéré : ${res.file} (${res.size} B, ${res.lastModified?.toISOString?.() || '—'})`);
      await store.reimportFromExcel();
    } else {
      console.log(`[sync] à jour (${res.reason})`);
    }
    return res;
  } catch (err) {
    console.error(`[sync] erreur :`, err.message);
    return { updated: false, error: err.message };
  }
}

// Synchro initiale AVANT le init pour partir sur la version distante si
// possible ; en cas d'échec on retombe sur le fichier local existant.
if (SYNC_ENABLED) {
  await syncAndRebuild();
}
await store.init();

// Timer périodique 30 min par défaut.
if (SYNC_ENABLED && SYNC_INTERVAL_MS > 0) {
  setInterval(syncAndRebuild, SYNC_INTERVAL_MS).unref();
}

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

app.use('/api', apiRoutes(store, { syncAndRebuild }));

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
