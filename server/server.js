import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanningStore } from './lib/store.js';
import { apiRoutes } from './routes/api.js';
import { syncBestPlanning, syncAdeCalendar, DEFAULT_REMOTE_URL, DEFAULT_GDRIVE_FOLDER, DEFAULT_ADE_URL } from './lib/remote-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
const EXCEL_PATH = process.env.EXCEL_PATH || path.join(root, 'data', 'planning.xlsx');
const CACHE_PATH = process.env.CACHE_PATH || path.join(DATA_DIR, 'planning-cache.json');
const OVERRIDES_PATH = process.env.OVERRIDES_PATH || path.join(DATA_DIR, 'overrides.json');
const ADE_PATH = process.env.ADE_PATH || path.join(root, 'data', 'ade-cal.vcs');
// Si non défini, le parseur choisira automatiquement la feuille "V<N>" la
// plus élevée du fichier — utile quand l'Excel amont ajoute une révision.
const EXCEL_SHEET = process.env.EXCEL_SHEET || undefined;

// Auto-sync avec le partage public AMU Box, le dossier Google Drive, et
// le flux iCal ADE. Le plus élevé Vxx entre AMU Box et Drive gagne.
const REMOTE_URL = process.env.REMOTE_URL || DEFAULT_REMOTE_URL;
const GDRIVE_FOLDER = process.env.GDRIVE_FOLDER || DEFAULT_GDRIVE_FOLDER;
const ADE_URL = process.env.ADE_URL || DEFAULT_ADE_URL;
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 30 * 60 * 1000);
const SYNC_ENABLED = process.env.REMOTE_SYNC !== '0';
const SYNC_STATE_PATH = path.join(DATA_DIR, 'remote-sync.json');
const ADE_SYNC_STATE_PATH = path.join(DATA_DIR, 'ade-sync.json');

// État courant du fichier distant, exposé via /api/meta.
const remoteState = {
  fileName: null,
  href: null,
  lastModified: null,
  syncedAt: null,
};
const adeState = {
  syncedAt: null,
  eventCount: null,
};

const store = new PlanningStore({
  excelPath: EXCEL_PATH,
  cachePath: CACHE_PATH,
  overridesPath: OVERRIDES_PATH,
  adePath: ADE_PATH,
  sheetName: EXCEL_SHEET,
  shiftDays: process.env.EXCEL_SHIFT_DAYS != null ? Number(process.env.EXCEL_SHIFT_DAYS) : undefined,
});

async function syncAndRebuild() {
  const result = { excel: null, ade: null };
  // 1) Choix de la meilleure source Excel (AMU Box vs Google Drive) et
  //    téléchargement de la plus grande version.
  try {
    const res = await syncBestPlanning({
      shareUrl: REMOTE_URL,
      gdriveFolder: GDRIVE_FOLDER,
      targetPath: EXCEL_PATH,
      stateFile: SYNC_STATE_PATH,
    });
    result.excel = res;
    if (res.file) {
      remoteState.href = res.file;
      remoteState.fileName = res.file;
      remoteState.source = res.source;
      remoteState.version = res.version;
      remoteState.syncedAt = new Date().toISOString();
    }
    if (res.updated) {
      console.log(`[sync] nouvel Excel récupéré : ${res.file} (V${res.version} via ${res.source}, ${res.size} B)`);
      await store.reimportFromExcel();
    } else {
      console.log(`[sync] Excel à jour (${res.reason}, source=${res.source || 'n/a'}, V${res.version || '?'})`);
    }
  } catch (err) {
    console.error(`[sync] Excel erreur :`, err.message);
    result.excel = { updated: false, error: err.message };
  }

  // 2) Flux iCal ADE (salles précises en direct)
  try {
    const res = await syncAdeCalendar({
      url: ADE_URL,
      targetPath: ADE_PATH,
      stateFile: ADE_SYNC_STATE_PATH,
    });
    result.ade = res;
    if (res.updated) {
      console.log(`[sync] nouvel ADE récupéré (${res.size} B)`);
      await store.loadAde();
      store.rebuild();
    } else {
      console.log(`[sync] ADE à jour (${res.reason})`);
    }
    adeState.syncedAt = new Date().toISOString();
    adeState.eventCount = store.getAdeEvents?.().length || null;
  } catch (err) {
    console.error(`[sync] ADE erreur :`, err.message);
    result.ade = { updated: false, error: err.message };
  }
  return result;
}

async function loadRemoteStateFromDisk() {
  try {
    const raw = await import('node:fs/promises').then((m) => m.readFile(SYNC_STATE_PATH, 'utf8'));
    const j = JSON.parse(raw);
    if (j.href) {
      remoteState.href = j.href;
      remoteState.fileName = j.href.split('/').pop();
    }
    if (j.lastModified) remoteState.lastModified = j.lastModified;
    if (j.syncedAt) remoteState.syncedAt = j.syncedAt;
  } catch { /* ignore */ }
}

// Charge l'état précédent (nom du fichier + dernière synchro) puis fait
// un check distant. En cas d'échec on retombe sur le fichier local existant.
await loadRemoteStateFromDisk();
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

app.use('/api', apiRoutes(store, { syncAndRebuild, remoteState, adeState }));

// Interface constructeur (URL non annoncée dans l'UI publique).
app.use('/constructeur', express.static(path.join(root, 'client', 'admin')));
app.get('/constructeur', (_req, res) => {
  res.sendFile(path.join(root, 'client', 'admin', 'index.html'));
});

// Page Comparateur ADE ↔ Excel (accepte majuscules et minuscules).
app.get(/^\/[Cc]omparateur$/, (_req, res) => {
  res.sendFile(path.join(root, 'client', 'comparateur.html'));
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
