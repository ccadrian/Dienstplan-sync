import type { CalendarApi, CalendarEvent } from "../../src/calendar.js";

/** Kalender im Speicher, der sich wie die Google Calendar API verhält. */
export class FakeCalendar implements CalendarApi {
  calendars = new Map<string, Map<string, CalendarEvent>>();
  failInsertAfter = Infinity; // ab dem n-ten Insert einen Fehler werfen
  failDeleteIds = new Set<string>();
  inserts = 0;
  private seq = 0;

  async calendarExists(id: string) {
    return this.calendars.has(id);
  }

  async createCalendar(summary: string) {
    const id = `${summary.toLowerCase()}-${++this.seq}@group.calendar.google.com`;
    this.calendars.set(id, new Map());
    return id;
  }

  async listEvents(calendarId: string, props: Record<string, string>) {
    const events = [...(this.calendars.get(calendarId)?.values() ?? [])];
    return events
      .filter((e) => Object.entries(props).every(([k, v]) => e.extendedProperties?.private?.[k] === v))
      .map((e) => ({ id: e.id!, upload: e.extendedProperties?.private?.upload ?? undefined }));
  }

  async insertEvent(calendarId: string, event: CalendarEvent) {
    if (++this.inserts > this.failInsertAfter) throw Object.assign(new Error("boom"), { status: 500 });
    const id = event.id ?? `evt${++this.seq}`;
    this.calendars.get(calendarId)!.set(id, { ...event, id });
    return id;
  }

  async deleteEvent(calendarId: string, eventId: string) {
    if (this.failDeleteIds.has(eventId)) throw new Error("delete failed");
    this.calendars.get(calendarId)?.delete(eventId);
  }

  events(calendarId: string) {
    return [...(this.calendars.get(calendarId)?.values() ?? [])];
  }
}
