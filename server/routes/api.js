import express from 'express';
import { requireAdmin, verifyPassword, issueToken, revokeToken, checkToken } from '../lib/auth.js';

export function apiRoutes(store, { syncAndRebuild, remoteState } = {}) {
  const router = express.Router();

  // ─── Lecture publique ────────────────────────────────────────────────
  router.get('/meta', (_req, res) => {
    res.json({ ...store.meta(), remote: remoteState || null });
  });

  router.get('/weeks', (_req, res) => {
    res.json({ weeks: store.getWeeks() });
  });

  router.get('/courses', (req, res) => {
    let courses = store.getCourses();
    const { weekStart, from, to, profile } = req.query;
    if (weekStart) courses = courses.filter((c) => c.weekStart === weekStart);
    if (from) courses = courses.filter((c) => c.weekStart >= from);
    if (to) courses = courses.filter((c) => c.weekStart <= to);
    if (profile && profile !== 'ALL') {
      const p = String(profile);
      courses = courses.filter((c) => matchesProfile(c, p));
    }
    res.json({ courses });
  });

  router.get('/profiles', (_req, res) => {
    // Renvoie les profils/groupes disponibles, déduits des cours.
    const groups = new Set();
    for (const c of store.getCourses()) for (const g of c.groups || []) groups.add(g);
    // Profils fixes affichés d'abord
    const priority = ['BTI', 'STAPS', 'PolyTech', 'ECM', 'Clinicien', 'M1 BTI', 'SAE'];
    const orderedFixed = priority.filter((p) => groups.has(p));
    const subgroups = [...groups].filter((g) => /^Groupe [A-D]$/.test(g)).sort();
    const others = [...groups].filter((g) => !priority.includes(g) && !subgroups.includes(g)).sort();
    res.json({ groups: [...orderedFixed, ...subgroups, ...others] });
  });

  // ─── Authentification constructeur ───────────────────────────────────
  router.post('/admin/login', express.json(), (req, res) => {
    const { password } = req.body || {};
    if (!verifyPassword(password)) return res.status(401).json({ error: 'bad-password' });
    const token = issueToken();
    res.cookie('bti_admin', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12,
      path: '/',
    });
    res.json({ ok: true });
  });

  router.post('/admin/logout', (req, res) => {
    const token = req.cookies?.bti_admin;
    revokeToken(token);
    res.clearCookie('bti_admin', { path: '/' });
    res.json({ ok: true });
  });

  router.get('/admin/status', (req, res) => {
    res.json({ authenticated: !!checkToken(req.cookies?.bti_admin) });
  });

  // ─── CRUD des cours (admin) ──────────────────────────────────────────
  router.post('/admin/courses', requireAdmin, express.json(), async (req, res) => {
    const payload = req.body || {};
    // Répétition sur plusieurs semaines : `weeks: [ISO, ISO, ...]`
    const weeks = Array.isArray(payload.weeks) && payload.weeks.length
      ? payload.weeks
      : [payload.weekStart];
    const created = [];
    for (const wk of weeks) {
      if (!wk) continue;
      const course = normalizeCourse({ ...payload, weekStart: wk });
      const err = validateCourse(course);
      if (err) return res.status(400).json({ error: err });
      course.id = generateId(course);
      await store.createCourse(course);
      created.push(course);
    }
    res.json({ created });
  });

  router.put('/admin/courses/:id', requireAdmin, express.json(), async (req, res) => {
    const id = req.params.id;
    const patch = req.body || {};
    if (patch.startTime && patch.endTime && patch.endTime <= patch.startTime) {
      return res.status(400).json({ error: 'end-before-start' });
    }
    await store.updateCourse(id, patch);
    res.json({ ok: true });
  });

  router.delete('/admin/courses/:id', requireAdmin, async (req, res) => {
    await store.deleteCourse(req.params.id);
    res.json({ ok: true });
  });

  router.post('/admin/courses/bulk-delete', requireAdmin, express.json(), async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (const id of ids) await store.deleteCourse(id);
    res.json({ ok: true, count: ids.length });
  });

  router.post('/admin/reset', requireAdmin, async (_req, res) => {
    await store.resetOverrides();
    res.json({ ok: true });
  });

  router.post('/admin/reimport', requireAdmin, async (_req, res) => {
    await store.reimportFromExcel();
    res.json({ ok: true, meta: store.meta() });
  });

  router.post('/admin/sync', requireAdmin, async (_req, res) => {
    if (!syncAndRebuild) return res.status(501).json({ error: 'sync-disabled' });
    const result = await syncAndRebuild();
    res.json({ ok: true, result, meta: store.meta() });
  });

  router.get('/admin/diff', requireAdmin, (_req, res) => {
    res.json(store.diffAgainstExcel());
  });

  return router;
}

function normalizeCourse(input) {
  const c = {
    title: (input.title || '').trim(),
    teacher: (input.teacher || '').trim(),
    room: (input.room || '').trim(),
    notes: (input.notes || '').trim(),
    day: input.day || null,
    dayOfWeek: Number(input.dayOfWeek),
    startTime: input.startTime,
    endTime: input.endTime,
    weekStart: input.weekStart,
    date: computeDate(input.weekStart, Number(input.dayOfWeek)),
    groups: Array.isArray(input.groups) ? input.groups.filter(Boolean) : ['BTI'],
    color: input.color || null,
    special: input.special || null,
    raw: input.raw || '',
    origin: 'admin',
  };
  if (!c.day && c.dayOfWeek) {
    c.day = ['','Lundi','Mardi','Mercredi','Jeudi','Vendredi'][c.dayOfWeek] || null;
  }
  return c;
}

function computeDate(weekStart, dayOfWeek) {
  if (!weekStart || !dayOfWeek) return null;
  const d = new Date(weekStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + (dayOfWeek - 1));
  return d.toISOString().slice(0, 10);
}

function validateCourse(c) {
  if (!c.title) return 'title-required';
  if (!c.weekStart) return 'weekStart-required';
  if (!c.dayOfWeek || c.dayOfWeek < 1 || c.dayOfWeek > 5) return 'dayOfWeek-invalid';
  if (!c.startTime || !c.endTime) return 'time-required';
  if (c.endTime <= c.startTime) return 'end-before-start';
  if (!Array.isArray(c.groups) || !c.groups.length) return 'groups-required';
  return null;
}

function generateId(c) {
  const seed = `${c.weekStart}|${c.dayOfWeek}|${c.startTime}|${c.endTime}|${c.title}|${Math.random()}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  return `c_${(h >>> 0).toString(36)}`;
}

// Un cours est visible pour un profil si son tableau `groups` contient
// ce profil. Les événements sont taggés avec tous les profils par le parseur.
function matchesProfile(course, profile) {
  const g = course.groups || [];
  return g.includes(profile);
}
