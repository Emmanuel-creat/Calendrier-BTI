// Authentification très simple pour le mode constructeur.
//
// Le mot de passe est lu dans la variable d'environnement CONSTRUCTOR_PASSWORD.
// Après login, un cookie signé `bti_admin` contient un jeton opaque en mémoire
// serveur (Map jetons -> expiration).

import crypto from 'node:crypto';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 h

const sessions = new Map();

export function getPassword() {
  return process.env.CONSTRUCTOR_PASSWORD || null;
}

export function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function verifyPassword(input) {
  const expected = getPassword();
  if (!expected) return false;
  if (typeof input !== 'string') return false;
  const a = Buffer.from(String(input));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function checkToken(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  // Rolling refresh
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return true;
}

export function revokeToken(token) {
  if (token) sessions.delete(token);
}

export function requireAdmin(req, res, next) {
  const token = req.cookies?.bti_admin;
  if (!checkToken(token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
