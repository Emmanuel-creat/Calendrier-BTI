// Couche de stockage persistant.
//
// La source de vérité "base" du planning provient de l'Excel — parsé au
// démarrage (ou via `npm run import`) et sérialisé dans data/planning-cache.json.
//
// L'administrateur (constructeur) peut modifier le planning depuis l'interface.
// Ses modifications sont stockées séparément dans data/overrides.json sous
// la forme d'une liste d'opérations : create / update / delete.
//
// À la lecture, on part de la base et on applique les overrides dans l'ordre.
// Cela garantit que l'Excel reste la référence, tout en permettant des
// évolutions persistantes indépendantes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseExcelFile } from './excel-parser.js';

export class PlanningStore {
  constructor({ excelPath, cachePath, overridesPath, sheetName = '26_27_V5', shiftDays } = {}) {
    this.excelPath = excelPath;
    this.cachePath = cachePath;
    this.overridesPath = overridesPath;
    this.sheetName = sheetName;
    this.shiftDays = Number.isFinite(shiftDays) ? shiftDays : 364;
    this.base = null;      // { courses, weeks, warnings, parsedAt }
    this.overrides = { ops: [], updatedAt: null };
    this.cache = null;     // Cours effectif (base + overrides appliqués)
  }

  async init() {
    await this.loadCache();
    await this.loadOverrides();
    this.rebuild();
  }

  async loadCache() {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      this.base = JSON.parse(raw);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        await this.reimportFromExcel();
        return true;
      }
      throw err;
    }
  }

  async reimportFromExcel() {
    const result = await parseExcelFile(this.excelPath, this.sheetName, { shiftDays: this.shiftDays });
    this.base = {
      parsedAt: new Date().toISOString(),
      sheetName: this.sheetName,
      shiftDays: this.shiftDays,
      ...result,
    };
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(this.base, null, 2), 'utf8');
    this.rebuild();
    return this.base;
  }

  async loadOverrides() {
    try {
      const raw = await fs.readFile(this.overridesPath, 'utf8');
      this.overrides = JSON.parse(raw);
      if (!Array.isArray(this.overrides.ops)) this.overrides.ops = [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.overrides = { ops: [], updatedAt: null };
    }
  }

  async saveOverrides() {
    await fs.mkdir(path.dirname(this.overridesPath), { recursive: true });
    this.overrides.updatedAt = new Date().toISOString();
    await fs.writeFile(this.overridesPath, JSON.stringify(this.overrides, null, 2), 'utf8');
  }

  rebuild() {
    if (!this.base) return;
    const byId = new Map();
    for (const c of this.base.courses) {
      byId.set(c.id, { ...c, origin: 'excel' });
    }
    for (const op of this.overrides.ops) {
      if (op.type === 'delete') {
        byId.delete(op.id);
      } else if (op.type === 'update') {
        const cur = byId.get(op.id);
        if (cur) byId.set(op.id, { ...cur, ...op.patch, origin: 'override' });
      } else if (op.type === 'create') {
        byId.set(op.course.id, { ...op.course, origin: 'admin' });
      }
    }
    this.cache = {
      parsedAt: this.base.parsedAt,
      overridesUpdatedAt: this.overrides.updatedAt,
      sheetName: this.base.sheetName,
      courses: [...byId.values()].sort(sortCourses),
      weeks: this.deriveWeeks(byId),
    };
  }

  deriveWeeks(byId) {
    const weekMeta = new Map();
    for (const w of this.base.weeks) weekMeta.set(w.weekStart, { ...w });
    for (const c of byId.values()) {
      if (!weekMeta.has(c.weekStart)) {
        // Semaine ajoutée par l'admin (au-delà de l'Excel)
        weekMeta.set(c.weekStart, {
          weekStart: c.weekStart,
          weekEnd: addDaysISO(c.weekStart, 4),
          annotation: null,
        });
      }
    }
    return [...weekMeta.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }

  getCourses() {
    return this.cache?.courses ?? [];
  }

  getWeeks() {
    return this.cache?.weeks ?? [];
  }

  meta() {
    return {
      parsedAt: this.base?.parsedAt ?? null,
      overridesUpdatedAt: this.overrides.updatedAt,
      sheetName: this.base?.sheetName ?? null,
      overrideCount: this.overrides.ops.length,
    };
  }

  async applyOp(op) {
    this.overrides.ops.push({ ...op, at: new Date().toISOString() });
    await this.saveOverrides();
    this.rebuild();
  }

  async createCourse(course) {
    await this.applyOp({ type: 'create', course });
  }

  async updateCourse(id, patch) {
    await this.applyOp({ type: 'update', id, patch });
  }

  async deleteCourse(id) {
    await this.applyOp({ type: 'delete', id });
  }

  async resetOverrides() {
    this.overrides = { ops: [], updatedAt: null };
    await this.saveOverrides();
    this.rebuild();
  }

  // Diff Excel ↔ état effectif (utile pour reporter les changements admin).
  diffAgainstExcel() {
    const excelById = new Map(this.base.courses.map((c) => [c.id, c]));
    const currentById = new Map(this.cache.courses.map((c) => [c.id, c]));

    const added = [];
    const removed = [];
    const modified = [];

    for (const [id, cur] of currentById) {
      const ref = excelById.get(id);
      if (!ref) { added.push(cur); continue; }
      const changes = diffFields(ref, cur, ['title', 'teacher', 'room', 'startTime', 'endTime', 'dayOfWeek', 'weekStart', 'groups']);
      if (changes.length) modified.push({ id, changes, current: cur, reference: ref });
    }
    for (const [id, ref] of excelById) {
      if (!currentById.has(id)) removed.push(ref);
    }
    return { added, removed, modified };
  }
}

function sortCourses(a, b) {
  return a.weekStart.localeCompare(b.weekStart) ||
    (a.dayOfWeek - b.dayOfWeek) ||
    a.startTime.localeCompare(b.startTime) ||
    a.title.localeCompare(b.title);
}

function diffFields(a, b, fields) {
  const changes = [];
  for (const f of fields) {
    const va = JSON.stringify(a[f] ?? null);
    const vb = JSON.stringify(b[f] ?? null);
    if (va !== vb) changes.push({ field: f, from: a[f], to: b[f] });
  }
  return changes;
}

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
