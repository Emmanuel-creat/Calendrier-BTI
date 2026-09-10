// Utilitaires de dates. Les dates du planning sont en heure locale de France
// (les dates ISO YYYY-MM-DD renvoyées par le serveur représentent des jours
// « civil ») — on manipule uniquement des dates locales pour éviter les
// décalages liés au fuseau horaire.

export const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
export const DAY_NAMES_SHORT = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

export function pad2(n) { return String(n).padStart(2, '0'); }

export function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isoAddDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function mondayOf(date) {
  // Retourne le lundi (ISO) de la semaine contenant `date` (0=dim => -6, 1=lun => 0, …).
  const d = new Date(date);
  const day = d.getDay(); // 0..6
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return toISO(d);
}

export function todayIso() {
  return toISO(new Date());
}

export function nowLocal() {
  return new Date();
}

export function isoWeekLabel(iso) {
  // "Semaine du 8 sept. 2025"
  const d = parseISO(iso);
  return `Semaine du ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function isoDay(iso) {
  const d = parseISO(iso);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function isoWeekNumber(iso) {
  // Numéro de semaine ISO 8601
  const d = parseISO(iso);
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diff = target - firstThursday;
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

export function toWeekInputValue(iso) {
  // Retourne "YYYY-Www" pour <input type=week>
  const w = isoWeekNumber(iso);
  const year = parseISO(iso).getFullYear();
  // Correction si semaine 52/53 débordant sur l'année précédente/suivante
  return `${year}-W${pad2(w)}`;
}

export function fromWeekInputValue(v) {
  // "YYYY-Www" -> ISO du lundi de cette semaine
  const m = /^(\d{4})-W(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const w = Number(m[2]);
  // Semaine 1 = semaine contenant le 4 janvier
  const jan4 = new Date(y, 0, 4);
  const jan4Day = (jan4.getDay() + 6) % 7; // 0=lun
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4Day + (w - 1) * 7);
  return toISO(monday);
}
