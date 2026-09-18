// Récupération automatique de l'Excel depuis un partage Nextcloud/AMU Box.
//
// Le dossier partagé est listé via WebDAV public (PROPFIND depth 1),
// on filtre les fichiers .xlsx correspondant au motif "Planning*BTI",
// on prend le plus récent (getlastmodified) et on le télécharge dans
// data/planning.xlsx.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

// URL par défaut vers le partage AMU Box du planning M2 BTI.
export const DEFAULT_REMOTE_URL = 'https://amubox.univ-amu.fr/s/ZFKYA7bMk6a9dbr';

// Dossier Google Drive public (contient les versions les plus récentes).
export const DEFAULT_GDRIVE_FOLDER = '1LWDH8hEdiPINEv7EIQtqWiT9707Tbd_B';

// URL par défaut de l'export iCal ADE (accès anonyme via token embarqué).
export const DEFAULT_ADE_URL =
  'https://agenda-web-consult.univ-amu.fr/jsp/custom/modules/plannings/anonymous_cal.jsp'
  + '?projectId=8&resources=2967&calType=ical&firstDate=2026-08-17&lastDate=2027-08-15';

function parsePublicShareUrl(shareUrl) {
  // Convertit `https://host/s/TOKEN` (page HTML) en endpoint WebDAV public
  // Nextcloud : `https://host/public.php/dav/files/TOKEN/`.
  const m = /^(https?:\/\/[^/]+)\/s\/([^/?#]+)/i.exec(shareUrl);
  if (!m) throw new Error(`URL de partage invalide : ${shareUrl}`);
  const origin = m[1];
  const token = m[2];
  return { origin, token, davUrl: `${origin}/public.php/dav/files/${token}/` };
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: u.protocol,
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Suit les redirections HTTP (jusqu'à 5) — nécessaire pour Google Drive.
async function httpRequestFollow(url, options = {}, maxRedirects = 5) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await httpRequest(current, options);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Trop de redirections depuis ${url}`);
}

// Parse minimal du multistatus WebDAV : on veut juste (href, getlastmodified,
// getcontenttype, getcontentlength) pour chaque `<d:response>`.
function parseMultiStatus(xml) {
  const responses = [];
  const respRegex = /<d:response\b[^>]*>([\s\S]*?)<\/d:response>/gi;
  let m;
  while ((m = respRegex.exec(xml))) {
    const inner = m[1];
    const href = /<d:href>([^<]+)<\/d:href>/i.exec(inner)?.[1] ?? '';
    const lastMod = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/i.exec(inner)?.[1];
    const contentType = /<d:getcontenttype>([^<]+)<\/d:getcontenttype>/i.exec(inner)?.[1];
    const contentLength = /<d:getcontentlength>([^<]+)<\/d:getcontentlength>/i.exec(inner)?.[1];
    const isCollection = /<d:resourcetype>\s*<d:collection\s*\/?>\s*<\/d:resourcetype>/i.test(inner);
    responses.push({
      href: decodeURIComponent(href),
      lastModified: lastMod ? new Date(lastMod) : null,
      contentType,
      contentLength: contentLength ? Number(contentLength) : null,
      isCollection,
    });
  }
  return responses;
}

export async function listRemoteFiles(shareUrl = DEFAULT_REMOTE_URL) {
  const { davUrl } = parsePublicShareUrl(shareUrl);
  const res = await httpRequest(davUrl, {
    method: 'PROPFIND',
    headers: { 'Depth': '1', 'Content-Type': 'application/xml' },
  });
  if (res.status !== 207) {
    throw new Error(`PROPFIND ${davUrl} → HTTP ${res.status}`);
  }
  return parseMultiStatus(res.body.toString('utf8'));
}

export async function pickLatestPlanningXlsx(shareUrl = DEFAULT_REMOTE_URL) {
  const files = await listRemoteFiles(shareUrl);
  const candidates = files
    .filter((f) => !f.isCollection)
    .filter((f) => /\.xlsx$/i.test(f.href))
    .filter((f) => /Planning.*BTI/i.test(f.href));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));
  return candidates[0];
}

// ─── Google Drive : liste + télécharge un dossier public ─────
// Utilise la vue « embeddedfolderview » qui rend un HTML statique avec
// les fichiers et leur ID Drive — aucune API key requise.
export async function listGoogleDriveFolder(folderId) {
  const url = `https://drive.google.com/embeddedfolderview?id=${folderId}`;
  const res = await httpRequest(url);
  if (res.status !== 200) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const html = res.body.toString('utf8');
  const entries = [];
  // On extrait l'ID depuis l'href /file/d/<ID>/view — plus fiable que
  // l'attribut id="entry-N--<ID>" car le préfixe "N--" peut cohabiter
  // avec un ID qui commence lui-même par des chiffres et des tirets.
  const entryRe = /<div class="flip-entry"[^>]*>[\s\S]*?href="https:\/\/drive\.google\.com\/file\/d\/([^\/]+)\/view[^"]*"[\s\S]*?<div class="flip-entry-title"[^>]*>([^<]+)</g;
  let m;
  while ((m = entryRe.exec(html))) {
    const id = m[1];
    const name = m[2].trim();
    entries.push({ id, name });
  }
  return entries;
}

// Extrait le numéro de version d'un nom de fichier "V5_Planning_…" → 5.
export function extractVersion(name) {
  const m = /^V(\d+)/i.exec(String(name || '').trim());
  return m ? Number(m[1]) : 0;
}

// Cherche dans le dossier Google Drive le xlsx "Planning*BTI" ayant la
// version la plus élevée, retourne { id, name, version, downloadUrl }.
export async function pickLatestPlanningFromGDrive(folderId = DEFAULT_GDRIVE_FOLDER) {
  const entries = await listGoogleDriveFolder(folderId);
  const candidates = entries
    .filter((e) => /\.xlsx$/i.test(e.name))
    .filter((e) => /Planning.*BTI/i.test(e.name))
    .map((e) => ({ ...e, version: extractVersion(e.name) }));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.version - a.version);
  const best = candidates[0];
  return {
    source: 'gdrive',
    id: best.id,
    name: best.name,
    version: best.version,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${best.id}`,
  };
}

// Choisit la version la plus élevée entre AMU box et Google Drive.
// Retourne un descripteur commun { source, name, version, ...(métadonnées propres) }.
export async function pickBestPlanning({
  shareUrl = DEFAULT_REMOTE_URL,
  gdriveFolder = DEFAULT_GDRIVE_FOLDER,
} = {}) {
  const results = [];
  try {
    const amu = await pickLatestPlanningXlsx(shareUrl);
    if (amu) {
      results.push({
        source: 'amu',
        name: amu.href.split('/').pop(),
        version: extractVersion(amu.href.split('/').pop()),
        raw: amu,
      });
    }
  } catch (err) {
    console.warn('[sync] AMU box unreachable:', err.message);
  }
  try {
    const gd = await pickLatestPlanningFromGDrive(gdriveFolder);
    if (gd) results.push({ ...gd });
  } catch (err) {
    console.warn('[sync] Google Drive unreachable:', err.message);
  }
  if (!results.length) return null;
  results.sort((a, b) => b.version - a.version);
  return results[0];
}

// Télécharge la meilleure version disponible et la sauve dans targetPath.
export async function syncBestPlanning({
  shareUrl = DEFAULT_REMOTE_URL,
  gdriveFolder = DEFAULT_GDRIVE_FOLDER,
  targetPath,
  stateFile,
} = {}) {
  const best = await pickBestPlanning({ shareUrl, gdriveFolder });
  if (!best) return { updated: false, reason: 'no-file-found' };

  // Ne rien retélécharger si on est déjà sur la même version + source.
  let previous = null;
  if (stateFile) {
    try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch {}
  }
  if (previous && previous.name === best.name && previous.source === best.source
      && (best.source !== 'amu' || previous.lastModified === best.raw.lastModified?.toISOString())) {
    return { updated: false, reason: 'up-to-date', file: best.name, source: best.source, version: best.version };
  }

  // Récupération du fichier selon la source.
  let body;
  if (best.source === 'amu') {
    body = await downloadRemoteFile(best.raw, shareUrl);
  } else {
    const res = await httpRequestFollow(best.downloadUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GDrive → HTTP ${res.status}`);
    }
    body = res.body;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, body);

  if (stateFile) {
    await fs.writeFile(stateFile, JSON.stringify({
      name: best.name,
      source: best.source,
      version: best.version,
      lastModified: best.raw?.lastModified?.toISOString?.() || null,
      size: body.length,
      syncedAt: new Date().toISOString(),
    }, null, 2));
  }
  return { updated: true, file: best.name, source: best.source, version: best.version, size: body.length };
}

function pathJoinDav(origin, davPath) {
  // WebDAV href est déjà absolu (commence par /public.php/…)
  return origin + davPath.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');
}

export async function downloadRemoteFile(file, shareUrl = DEFAULT_REMOTE_URL) {
  const { origin } = parsePublicShareUrl(shareUrl);
  const url = pathJoinDav(origin, file.href);
  const res = await httpRequest(url);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  return res.body;
}

// Point d'entrée principal : synchronise le fichier Excel local avec la
// version la plus récente disponible sur le partage. Retourne une info
// sur ce qui a été fait.
export async function syncRemoteExcel({ shareUrl = DEFAULT_REMOTE_URL, targetPath, stateFile } = {}) {
  const latest = await pickLatestPlanningXlsx(shareUrl);
  if (!latest) return { updated: false, reason: 'no-file-found' };

  // Vérifie si le fichier local est déjà à jour (via un petit fichier
  // d'état qui garde le href + lastModified de la dernière synchro).
  let previous = null;
  if (stateFile) {
    try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch { previous = null; }
  }
  if (previous?.href === latest.href
      && previous?.lastModified === latest.lastModified?.toISOString()) {
    return { updated: false, reason: 'up-to-date', file: latest.href };
  }

  const body = await downloadRemoteFile(latest, shareUrl);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, body);

  if (stateFile) {
    await fs.writeFile(stateFile, JSON.stringify({
      href: latest.href,
      lastModified: latest.lastModified?.toISOString(),
      contentLength: latest.contentLength,
      syncedAt: new Date().toISOString(),
    }, null, 2));
  }

  return { updated: true, file: latest.href, size: body.length, lastModified: latest.lastModified };
}

// Télécharge le flux iCal ADE en direct et le sauvegarde sur disque.
// Retourne { updated, size } ; updated=false si le contenu est identique
// à la version précédente (comparaison par taille + hash court).
export async function syncAdeCalendar({ url = DEFAULT_ADE_URL, targetPath, stateFile } = {}) {
  const res = await httpRequest(url);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  const body = res.body;
  // ADE renvoie un DTSTAMP différent à chaque appel (moment de la génération),
  // même si le contenu du planning n'a pas changé. On hash le corps privé
  // de ces lignes pour détecter les vrais changements uniquement.
  const stripped = body.toString('utf8').replace(/^DTSTAMP:[^\r\n]+\r?\n/gm, '');
  const hash = simpleHash(Buffer.from(stripped));

  let previous = null;
  if (stateFile) {
    try { previous = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch { previous = null; }
  }
  if (previous?.hash === hash) {
    return { updated: false, reason: 'unchanged', size: body.length };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, body);

  if (stateFile) {
    await fs.writeFile(stateFile, JSON.stringify({
      size: body.length,
      hash,
      syncedAt: new Date().toISOString(),
    }, null, 2));
  }
  return { updated: true, size: body.length };
}

function simpleHash(buf) {
  // Hash 32-bit rapide (djb2), suffisant pour détecter un changement.
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) + h) ^ buf[i];
  return (h >>> 0).toString(36);
}
