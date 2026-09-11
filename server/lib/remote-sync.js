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
