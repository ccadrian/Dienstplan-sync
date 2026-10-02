/**
 * Reine Datumsfunktionen auf "YYYY-MM-DD"-Strings. Gerechnet wird in UTC,
 * damit Sommer-/Winterzeit keine Tage verschiebt. Die Zeitzone Europe/Berlin
 * setzt erst der Kalender-Termin.
 */

export const TIME_ZONE = "Europe/Berlin";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtc(date: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Ungültiges Datum: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  return fromUtc(toUtc(date)) === date; // fängt 2026-02-30 usw. ab
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** Heutiges Datum in Berlin als "YYYY-MM-DD". */
export function berlinToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** ISO-8601 Kalenderwoche (Montag = Wochenbeginn, KW 1 enthält den 4. Januar). */
export function isoWeek(date: string): { year: number; week: number } {
  const d = toUtc(date);
  const weekday = d.getUTCDay() || 7; // So = 7
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // Donnerstag derselben Woche
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((d.getTime() - jan1) / 86_400_000 / 7) + 1;
  return { year, week };
}

export function weeksInYear(year: number): number {
  return isoWeek(`${year}-12-28`).week;
}

export function mondayOfIsoWeek(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() || 7;
  jan4.setUTCDate(jan4.getUTCDate() - (weekday - 1) + (week - 1) * 7);
  return fromUtc(jan4);
}

export function weekKey(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function weekdayShort(date: string): string {
  return WEEKDAYS[toUtc(date).getUTCDay()]!;
}

/**
 * Liest Uhrzeiten wie "7:30", "07.30", "0730", "7 Uhr", "7:30 Uhr", "07h30".
 * Ergebnis: Minuten seit Mitternacht (0 bis 1440, "24:00" ist erlaubt) oder null.
 */
export function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/\s*uhr$/, "");
  if (!s) return null;
  const m = /^(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?$/.exec(s) ?? /^(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
