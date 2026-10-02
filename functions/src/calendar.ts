import { calendar as calendarApi, type calendar_v3 } from "@googleapis/calendar";
import type { OAuth2Client } from "google-auth-library";
import { addDays, TIME_ZONE } from "./dates.js";
import { AppError, errors } from "./errors.js";
import type { DutyEntry } from "./roster.js";

export const SOURCE = "dienstplan-sync";
export const CALENDAR_NAME = "Dienst";
export const REMINDER_MINUTES = 30;
/** Ganztägig beginnt um 00:00, 300 Minuten vorher = 19:00 am Vorabend. */
export const ALL_DAY_REMINDER_MINUTES = 5 * 60;

export type CalendarEvent = calendar_v3.Schema$Event;

/** Schmale Schnittstelle zur Google Calendar API (erleichtert Tests). */
export interface CalendarApi {
  calendarExists(calendarId: string): Promise<boolean>;
  createCalendar(summary: string): Promise<string>;
  /** IDs + Upload-Kennung aller Termine mit den angegebenen privaten Properties. */
  listEvents(calendarId: string, props: Record<string, string>): Promise<{ id: string; upload?: string }[]>;
  insertEvent(calendarId: string, event: CalendarEvent): Promise<string>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

export function buildDescription(entry: DutyEntry): string {
  const lines: string[] = [];
  if (entry.responsible) lines.push(`Verantwortlich: ${entry.responsible}`);
  if (entry.uniform) lines.push(`Anzug: ${entry.uniform}`);
  if (entry.notes) lines.push(`Hinweise: ${entry.notes}`);
  if (entry.lowConfidence) lines.push("", "⚠ Unsicher erkannt, bitte mit dem Dienstplan abgleichen.");
  return lines.join("\n").trim();
}

/**
 * Feste Termin-ID pro Upload und Position. Google erlaubt die Zeichen a-v und 0-9;
 * die Upload-ID ist hex. Dadurch erzeugt ein wiederholter Einfüge-Versuch nach
 * einem Netzwerkfehler keinen doppelten Termin, sondern ein 409.
 */
export function eventId(uploadId: string, index: number): string {
  return `${uploadId}${String(index).padStart(3, "0")}`;
}

export function buildEvent(
  entry: DutyEntry,
  meta: { weekKey: string; uploadId: string; index: number },
): CalendarEvent {
  const event: CalendarEvent = {
    id: eventId(meta.uploadId, meta.index),
    summary: entry.title,
    description: buildDescription(entry) || undefined,
    location: entry.location || undefined,
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: entry.allDay ? ALL_DAY_REMINDER_MINUTES : REMINDER_MINUTES }],
    },
    extendedProperties: {
      private: { source: SOURCE, week: meta.weekKey, upload: meta.uploadId },
    },
  };
  if (entry.allDay) {
    event.start = { date: entry.date };
    event.end = { date: addDays(entry.date, 1) };
  } else {
    event.start = { dateTime: `${entry.date}T${entry.start}:00`, timeZone: TIME_ZONE };
    event.end = { dateTime: `${entry.endDate ?? entry.date}T${entry.end}:00`, timeZone: TIME_ZONE };
  }
  return event;
}

export async function ensureCalendar(
  api: CalendarApi,
  knownId: string | null,
  saveId: (id: string) => Promise<void>,
): Promise<string> {
  if (knownId && (await api.calendarExists(knownId))) return knownId;
  const id = await api.createCalendar(CALENDAR_NAME);
  await saveId(id);
  return id;
}

export interface ReplaceResult {
  created: number;
  removed: number;
  removeFailed: number;
}

/**
 * Ersetzt die Termine einer Kalenderwoche: erst alle neuen Termine eintragen,
 * dann die alten dieser Woche löschen. Scheitert das Eintragen, werden die
 * bereits eingetragenen neuen Termine wieder entfernt und die alten bleiben.
 */
export async function replaceWeek(
  api: CalendarApi,
  calendarId: string,
  weekKey: string,
  uploadId: string,
  events: CalendarEvent[],
): Promise<ReplaceResult> {
  const existing = await api.listEvents(calendarId, { source: SOURCE, week: weekKey });

  const attempted: string[] = [];
  try {
    await mapLimit(events, 4, async (event) => {
      if (event.id) attempted.push(event.id);
      const id = await api.insertEvent(calendarId, event);
      if (!event.id) attempted.push(id);
    });
  } catch (err) {
    await mapLimitSettled(attempted, 4, (id) => api.deleteEvent(calendarId, id));
    throw err;
  }

  const old = existing.filter((e) => e.upload !== uploadId);
  const failures = await mapLimitSettled(old, 4, (e) => api.deleteEvent(calendarId, e.id));
  return { created: events.length, removed: old.length - failures, removeFailed: failures };
}

/** Wie mapLimit, bricht aber nicht ab. Liefert die Anzahl der Fehlschläge. */
async function mapLimitSettled<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<number> {
  let failures = 0;
  await mapLimit(items, limit, (item) => fn(item).catch(() => failures++));
  return failures;
}

/**
 * Führt fn mit begrenzter Parallelität aus. Nach dem ersten Fehler werden keine
 * neuen Aufgaben gestartet; laufende werden abgewartet, dann wird der Fehler geworfen.
 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  let firstError: { err: unknown } | null = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!firstError && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        firstError ??= { err };
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw (firstError as { err: unknown }).err;
}

/** Link auf die Wochenansicht im Google Kalender. */
export function calendarWeekUrl(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `https://calendar.google.com/calendar/r/week/${y}/${m}/${d}`;
}

// --- Google API Adapter -----------------------------------------------------

interface GoogleErrorInfo {
  status?: number;
  error?: string; // OAuth-Fehler, z.B. "invalid_grant"
  reason?: string; // Calendar-Fehlergrund, z.B. "rateLimitExceeded"
}

export function googleErrorInfo(err: unknown): GoogleErrorInfo {
  const e = err as {
    status?: number;
    code?: number | string;
    response?: { status?: number; data?: any };
  };
  const data = e?.response?.data;
  return {
    status: e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : undefined),
    error: typeof data?.error === "string" ? data.error : undefined,
    reason: data?.error?.errors?.[0]?.reason ?? data?.error?.status,
  };
}

const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

function isRetryable(info: GoogleErrorInfo): boolean {
  return info.status === 429 || (info.status !== undefined && info.status >= 500) || RETRY_REASONS.has(info.reason ?? "");
}

/** Übersetzt Fehler der Google APIs in App-Fehler (abgelaufener Token -> neu anmelden). */
export function mapGoogleError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const info = googleErrorInfo(err);
  if (info.error === "invalid_grant" || info.status === 401 || info.reason === "insufficientPermissions") {
    return errors.reauth(err);
  }
  if (isRetryable(info)) {
    return new AppError("calendar", "Google Kalender ist gerade überlastet. Bitte versuche es gleich erneut.", {
      cause: err,
    });
  }
  return new AppError("calendar", "Die Termine konnten nicht in den Google Kalender eingetragen werden.", {
    cause: err,
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isRetryable(googleErrorInfo(err))) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1) + Math.random() * 250));
    }
  }
}

export function createGoogleCalendarApi(auth: OAuth2Client): CalendarApi {
  const cal = calendarApi({ version: "v3", auth });
  return {
    async calendarExists(calendarId) {
      try {
        const res = await withRetry(() => cal.calendars.get({ calendarId }));
        return Boolean(res.data.id);
      } catch (err) {
        const { status } = googleErrorInfo(err);
        if (status === 404 || status === 410 || status === 403) return false;
        throw err;
      }
    },
    async createCalendar(summary) {
      const res = await withRetry(() =>
        cal.calendars.insert({
          requestBody: { summary, timeZone: TIME_ZONE, description: "Automatisch gefüllt von Dienstplan Sync" },
        }),
      );
      return res.data.id!;
    },
    async listEvents(calendarId, props) {
      const result: { id: string; upload?: string }[] = [];
      let pageToken: string | undefined;
      do {
        const res = await withRetry(() =>
          cal.events.list({
            calendarId,
            privateExtendedProperty: Object.entries(props).map(([k, v]) => `${k}=${v}`),
            maxResults: 2500,
            pageToken,
            fields: "nextPageToken,items(id,extendedProperties/private)",
          }),
        );
        for (const item of res.data.items ?? []) {
          if (item.id) result.push({ id: item.id, upload: item.extendedProperties?.private?.upload });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return result;
    },
    async insertEvent(calendarId, event) {
      try {
        const res = await withRetry(() => cal.events.insert({ calendarId, requestBody: event, fields: "id" }));
        return res.data.id!;
      } catch (err) {
        // 409 bei fester ID: ein vorheriger Versuch war schon erfolgreich
        if (event.id && googleErrorInfo(err).status === 409) return event.id;
        throw err;
      }
    },
    async deleteEvent(calendarId, eventId) {
      try {
        await withRetry(() => cal.events.delete({ calendarId, eventId }));
      } catch (err) {
        const { status } = googleErrorInfo(err);
        if (status === 404 || status === 410) return; // schon weg
        throw err;
      }
    },
  };
}
