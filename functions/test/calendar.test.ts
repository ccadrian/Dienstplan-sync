import { describe, expect, it } from "vitest";
import {
  buildEvent,
  calendarWeekUrl,
  ensureCalendar,
  eventId,
  mapGoogleError,
  replaceWeek,
} from "../src/calendar.js";
import type { DutyEntry } from "../src/roster.js";
import { FakeCalendar } from "./helpers/fakeCalendar.js";

const timed: DutyEntry = {
  date: "2026-10-05",
  allDay: false,
  start: "07:30",
  end: "08:00",
  endDate: "2026-10-05",
  title: "Antreten",
  location: "Exerzierplatz",
  responsible: "Hptm Müller",
  uniform: "Feldanzug",
  notes: "Waffe mitbringen",
  lowConfidence: false,
};

const allDay: DutyEntry = {
  date: "2026-10-07",
  allDay: true,
  title: "[?] GvD",
  location: "",
  responsible: "",
  uniform: "",
  notes: "",
  lowConfidence: true,
};

const meta = { weekKey: "2026-W41", uploadId: "abc123", index: 0 };

describe("buildEvent", () => {
  it("baut einen Termin mit Uhrzeit, Zeitzone, Beschreibung und 30 Min Erinnerung", () => {
    expect(buildEvent(timed, meta)).toEqual({
      id: "abc123000",
      summary: "Antreten",
      location: "Exerzierplatz",
      description: "Verantwortlich: Hptm Müller\nAnzug: Feldanzug\nHinweise: Waffe mitbringen",
      start: { dateTime: "2026-10-05T07:30:00", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-10-05T08:00:00", timeZone: "Europe/Berlin" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
      extendedProperties: { private: { source: "dienstplan-sync", week: "2026-W41", upload: "abc123" } },
    });
  });

  it("baut Ganztagstermine mit Erinnerung am Vorabend um 19:00", () => {
    const e = buildEvent(allDay, { ...meta, index: 7 });
    expect(e.start).toEqual({ date: "2026-10-07" });
    expect(e.end).toEqual({ date: "2026-10-08" });
    expect(e.reminders?.overrides).toEqual([{ method: "popup", minutes: 300 }]);
    expect(e.summary).toBe("[?] GvD");
    expect(e.description).toContain("Unsicher erkannt");
    expect(e.location).toBeUndefined();
    expect(e.id).toBe("abc123007");
  });

  it("setzt das Enddatum bei Diensten über Mitternacht", () => {
    const e = buildEvent({ ...timed, start: "22:00", end: "06:00", endDate: "2026-10-06" }, meta);
    expect(e.end).toEqual({ dateTime: "2026-10-06T06:00:00", timeZone: "Europe/Berlin" });
  });

  it("erzeugt gültige Google Event-IDs (a-v, 0-9)", () => {
    expect(eventId("0123456789abcdef", 12)).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe("ensureCalendar", () => {
  it("legt den Kalender 'Dienst' an, wenn er fehlt, und merkt sich die ID", async () => {
    const api = new FakeCalendar();
    const saved: string[] = [];
    const id = await ensureCalendar(api, null, async (x) => void saved.push(x));
    expect(id).toMatch(/^dienst-/);
    expect(saved).toEqual([id]);
    // zweiter Aufruf: vorhandener Kalender wird genutzt
    expect(await ensureCalendar(api, id, async () => expect.fail("nicht speichern"))).toBe(id);
  });

  it("legt ihn neu an, wenn er im Kalender gelöscht wurde", async () => {
    const api = new FakeCalendar();
    const id = await ensureCalendar(api, "geloescht@group.calendar.google.com", async () => {});
    expect(id).not.toBe("geloescht@group.calendar.google.com");
  });
});

describe("replaceWeek", () => {
  async function setup() {
    const api = new FakeCalendar();
    const cal = await api.createCalendar("Dienst");
    return { api, cal };
  }
  const events = (uploadId: string, weekKey: string, entries: DutyEntry[]) =>
    entries.map((e, index) => buildEvent(e, { weekKey, uploadId, index }));

  it("trägt alle Termine ein", async () => {
    const { api, cal } = await setup();
    const res = await replaceWeek(api, cal, "2026-W41", "u1", events("u1", "2026-W41", [timed, allDay]));
    expect(res).toEqual({ created: 2, removed: 0, removeFailed: 0 });
    expect(api.events(cal)).toHaveLength(2);
  });

  it("ersetzt bei erneutem Upload derselben KW die alten Termine, andere KWs bleiben", async () => {
    const { api, cal } = await setup();
    await replaceWeek(api, cal, "2026-W41", "u1", events("u1", "2026-W41", [timed, allDay]));
    await replaceWeek(api, cal, "2026-W42", "u2", events("u2", "2026-W42", [{ ...timed, date: "2026-10-12" }]));
    const res = await replaceWeek(api, cal, "2026-W41", "u3", events("u3", "2026-W41", [{ ...timed, title: "Neu" }]));
    expect(res).toEqual({ created: 1, removed: 2, removeFailed: 0 });
    const titles = api.events(cal).map((e) => `${e.extendedProperties!.private!.week} ${e.summary}`).sort();
    expect(titles).toEqual(["2026-W41 Neu", "2026-W42 Antreten"]);
  });

  it("lässt fremde Termine im Kalender unangetastet", async () => {
    const { api, cal } = await setup();
    await api.insertEvent(cal, { summary: "Privat", extendedProperties: { private: { week: "2026-W41" } } });
    await replaceWeek(api, cal, "2026-W41", "u1", events("u1", "2026-W41", [timed]));
    await replaceWeek(api, cal, "2026-W41", "u2", events("u2", "2026-W41", [timed]));
    expect(api.events(cal).map((e) => e.summary).sort()).toEqual(["Antreten", "Privat"]);
  });

  it("rollt bei einem Fehler zurück und behält die alten Termine", async () => {
    const { api, cal } = await setup();
    await replaceWeek(api, cal, "2026-W41", "u1", events("u1", "2026-W41", [timed, allDay]));
    api.failInsertAfter = api.inserts + 3; // 4. neuer Termin schlägt fehl
    const many = Array.from({ length: 6 }, (_, i) => ({ ...timed, title: `Neu ${i}` }));
    await expect(replaceWeek(api, cal, "2026-W41", "u2", events("u2", "2026-W41", many))).rejects.toThrow("boom");
    expect(api.events(cal).map((e) => e.summary).sort()).toEqual(["Antreten", "[?] GvD"]);
  });

  it("meldet alte Termine, die nicht gelöscht werden konnten", async () => {
    const { api, cal } = await setup();
    await replaceWeek(api, cal, "2026-W41", "u1", events("u1", "2026-W41", [timed, allDay]));
    api.failDeleteIds.add(eventId("u1", 0));
    const res = await replaceWeek(api, cal, "2026-W41", "u2", events("u2", "2026-W41", [timed]));
    expect(res).toEqual({ created: 1, removed: 1, removeFailed: 1 });
  });
});

describe("Fehler und Links", () => {
  it("erkennt abgelaufene Google-Zugänge", () => {
    const invalidGrant = { response: { status: 400, data: { error: "invalid_grant" } } };
    expect(mapGoogleError(invalidGrant).code).toBe("reauth");
    expect(mapGoogleError({ response: { status: 401, data: {} } }).code).toBe("reauth");
    const noScope = { response: { status: 403, data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } };
    expect(mapGoogleError(noScope).code).toBe("reauth");
    const rate = { response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } };
    expect(mapGoogleError(rate)).toMatchObject({ code: "calendar", message: expect.stringContaining("überlastet") });
    expect(mapGoogleError(new Error("x")).code).toBe("calendar");
  });

  it("verlinkt die Wochenansicht", () => {
    expect(calendarWeekUrl("2026-10-05")).toBe("https://calendar.google.com/calendar/r/week/2026/10/5");
  });
});
