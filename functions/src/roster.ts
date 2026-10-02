import {
  addDays,
  formatTime,
  isoWeek,
  isValidDate,
  parseTime,
  weekKey,
  weeksInYear,
} from "./dates.js";

/** Ein normalisierter Dienstplan-Eintrag, fertig für den Kalender. */
export interface DutyEntry {
  date: string; // Starttag "YYYY-MM-DD"
  allDay: boolean;
  start?: string; // "HH:MM", nur bei Terminen mit Uhrzeit
  end?: string; // "HH:MM"
  endDate?: string; // Endtag (bei Diensten über Mitternacht der Folgetag)
  title: string; // bei unsicheren Einträgen mit "[?] " davor
  location: string;
  responsible: string;
  uniform: string;
  notes: string;
  lowConfidence: boolean;
}

export interface Roster {
  readable: boolean;
  problem: string;
  year: number;
  week: number;
  weekKey: string; // z.B. "2026-W40"
  entries: DutyEntry[];
  skipped: number; // Einträge ohne gültiges Datum
}

export const LOW_CONFIDENCE_PREFIX = "[?] ";

/**
 * Holt das JSON-Objekt aus der Modellantwort. Structured Outputs liefern
 * normalerweise reines JSON, aber Codeblöcke oder Begleittext werden toleriert.
 */
export function parseModelJson(text: string): unknown {
  const cleaned = text.replace(/^﻿/, "").trim();
  const candidates = [cleaned];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  // Äußerste Klammer zuerst: ein Objekt oder ein nacktes Array von Einträgen
  const spans = [
    [cleaned.indexOf("{"), cleaned.lastIndexOf("}")],
    [cleaned.indexOf("["), cleaned.lastIndexOf("]")],
  ]
    .filter(([from, to]) => from! !== -1 && to! > from!)
    .sort((a, b) => a[0]! - b[0]!);
  for (const [from, to] of spans) candidates.push(cleaned.slice(from, to! + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // nächsten Kandidaten probieren
    }
  }
  throw new SyntaxError("Antwort enthält kein gültiges JSON");
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function bool(value: unknown): boolean {
  return value === true || (typeof value === "string" && /^(true|ja|yes)$/i.test(value.trim()));
}

function int(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/** Akzeptiert "2026-10-05", "05.10.2026", "5.10.26" und "05.10." (Jahr ergänzt). */
function parseDate(value: unknown, fallbackYear: number): string | null {
  const s = str(value);
  if (isValidDate(s)) return s;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(s);
  if (!m) return null;
  let year = m[3] ? Number(m[3]) : fallbackYear;
  if (year < 100) year += 2000;
  const iso = `${year}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return isValidDate(iso) ? iso : null;
}

interface Draft {
  date: string;
  allDay: boolean;
  start: number | null;
  end: number | null;
  title: string;
  location: string;
  responsible: string;
  uniform: string;
  notes: string;
  lowConfidence: boolean;
}

/**
 * Macht aus der (potenziell unvollständigen) Modellantwort einen sauberen
 * Dienstplan: prüft Datum und Uhrzeiten, ergänzt fehlende Endzeiten,
 * markiert unsichere Einträge und bestimmt die Kalenderwoche.
 */
export function normalizeRoster(raw: unknown, today: string): Roster {
  const obj: Record<string, unknown> = Array.isArray(raw)
    ? { entries: raw }
    : raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};

  const todayYear = Number(today.slice(0, 4));
  const planYear = int(obj.plan_year);
  const planWeek = int(obj.plan_week);
  const planWeekValid =
    planYear !== null &&
    planWeek !== null &&
    planYear >= 2000 &&
    planYear <= 2100 &&
    planWeek >= 1 &&
    planWeek <= weeksInYear(planYear);

  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  let skipped = 0;
  const drafts: Draft[] = [];

  for (const item of rawEntries) {
    if (!item || typeof item !== "object") {
      skipped++;
      continue;
    }
    const e = item as Record<string, unknown>;
    const date = parseDate(e.date, planWeekValid ? planYear! : todayYear);
    if (!date) {
      skipped++;
      continue;
    }
    let allDay = bool(e.all_day);
    let lowConfidence = /^(low|niedrig|unsicher)$/i.test(str(e.confidence));
    let start = allDay ? null : parseTime(e.start);
    const end = allDay ? null : parseTime(e.end);
    if (start === 1440) start = null;
    if (!allDay && start === null) {
      // Ohne lesbare Startzeit lieber ganztägig und als unsicher markieren
      allDay = true;
      lowConfidence = true;
    }
    drafts.push({
      date,
      allDay,
      start,
      end: allDay ? null : end,
      title: str(e.title) || "Dienst",
      location: str(e.location),
      responsible: str(e.responsible),
      uniform: str(e.uniform),
      notes: str(e.notes),
      lowConfidence,
    });
  }

  fillMissingEnds(drafts);
  const entries = dedupe(drafts.map(toEntry)).sort(compareEntries);

  let year: number;
  let week: number;
  const planWeekMatches =
    planWeekValid &&
    (entries.length === 0 ||
      entries.some((e) => {
        const w = isoWeek(e.date);
        return w.year === planYear && w.week === planWeek;
      }));
  if (planWeekMatches) {
    year = planYear!;
    week = planWeek!;
  } else {
    ({ year, week } = isoWeek(entries[0]?.date ?? today));
  }

  return {
    readable: obj.readable !== false && entries.length > 0,
    problem: str(obj.problem),
    year,
    week,
    weekKey: weekKey(year, week),
    entries,
    skipped,
  };
}

/** Fehlende Endzeit = Beginn des nächsten Eintrags am selben Tag, sonst +60 Minuten. */
function fillMissingEnds(drafts: Draft[]): void {
  const byDate = new Map<string, Draft[]>();
  for (const d of drafts) {
    if (d.allDay) continue;
    const list = byDate.get(d.date) ?? [];
    list.push(d);
    byDate.set(d.date, list);
  }
  for (const list of byDate.values()) {
    const starts = list.map((d) => d.start!).sort((a, b) => a - b);
    for (const d of list) {
      if (d.end !== null) continue;
      const next = starts.find((s) => s > d.start!);
      d.end = next ?? d.start! + 60;
    }
  }
}

function toEntry(d: Draft): DutyEntry {
  const title =
    d.lowConfidence && !d.title.startsWith(LOW_CONFIDENCE_PREFIX.trim())
      ? LOW_CONFIDENCE_PREFIX + d.title
      : d.title;
  const base = {
    date: d.date,
    title,
    location: d.location,
    responsible: d.responsible,
    uniform: d.uniform,
    notes: d.notes,
    lowConfidence: d.lowConfidence,
  };
  if (d.allDay) return { ...base, allDay: true };

  const start = d.start!;
  let end = d.end!;
  // Ende vor Beginn = über Mitternacht (z.B. 22:00-06:00); gleich = 1 Stunde
  if (end < start) end += 1440;
  else if (end === start) end = start + 60;
  return {
    ...base,
    allDay: false,
    start: formatTime(start),
    end: formatTime(end % 1440),
    endDate: addDays(d.date, Math.floor(end / 1440)),
  };
}

function entryKey(e: DutyEntry): string {
  return [e.date, e.allDay, e.start, e.end, e.title.toLowerCase()].join("|");
}

function dedupe(entries: DutyEntry[]): DutyEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = entryKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareEntries(a: DutyEntry, b: DutyEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return (a.start ?? "").localeCompare(b.start ?? "");
}
