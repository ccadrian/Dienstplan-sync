import { describe, expect, it } from "vitest";
import { normalizeRoster, parseModelJson } from "../src/roster.js";

const TODAY = "2026-10-02";

describe("parseModelJson", () => {
  it("liest reines JSON", () => {
    expect(parseModelJson('{"entries": []}')).toEqual({ entries: [] });
  });

  it("toleriert Codeblöcke und Begleittext", () => {
    expect(parseModelJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Hier ist das Ergebnis:\n{"a": 1}\nViel Erfolg!')).toEqual({ a: 1 });
    expect(parseModelJson('﻿  {"a": 1}  ')).toEqual({ a: 1 });
    expect(parseModelJson('Liste: [{"date": "2026-10-05"}]')).toEqual([{ date: "2026-10-05" }]);
  });

  it("wirft bei kaputtem JSON", () => {
    expect(() => parseModelJson("Ich kann das Bild nicht lesen.")).toThrow(SyntaxError);
    expect(() => parseModelJson('{"entries": [')).toThrow(SyntaxError);
  });
});

describe("normalizeRoster", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    date: "2026-10-05",
    start: "07:30",
    end: "08:00",
    title: "Antreten",
    location: "Exerzierplatz",
    responsible: "Hptm Müller",
    uniform: "Feldanzug",
    notes: "",
    all_day: false,
    confidence: "high",
    ...over,
  });

  it("übernimmt vollständige Einträge und die KW aus dem Plan", () => {
    const r = normalizeRoster({ readable: true, plan_year: 2026, plan_week: 41, entries: [entry()] }, TODAY);
    expect(r.readable).toBe(true);
    expect(r.weekKey).toBe("2026-W41");
    expect(r.entries).toEqual([
      {
        date: "2026-10-05",
        allDay: false,
        start: "07:30",
        end: "08:00",
        endDate: "2026-10-05",
        title: "Antreten",
        location: "Exerzierplatz",
        responsible: "Hptm Müller",
        uniform: "Feldanzug",
        notes: "",
        lowConfidence: false,
      },
    ]);
  });

  it("nimmt bei fehlender Endzeit den Beginn des nächsten Eintrags am selben Tag", () => {
    const r = normalizeRoster(
      {
        entries: [
          entry({ start: "07:30", end: "", title: "Antreten" }),
          entry({ start: "08:00", end: "", title: "Ausbildung" }),
          entry({ start: "12:00", end: "13:00", title: "Mittag" }),
          entry({ start: "13:00", end: null, title: "Sport" }),
          entry({ date: "2026-10-06", start: "07:00", end: "", title: "Antreten" }),
        ],
      },
      TODAY,
    );
    const ends = r.entries.map((e) => `${e.date} ${e.title} ${e.start}-${e.end}`);
    expect(ends).toEqual([
      "2026-10-05 Antreten 07:30-08:00",
      "2026-10-05 Ausbildung 08:00-12:00",
      "2026-10-05 Mittag 12:00-13:00",
      "2026-10-05 Sport 13:00-14:00", // letzter Eintrag des Tages: +60 Minuten
      "2026-10-06 Antreten 07:00-08:00",
    ]);
  });

  it("behandelt Dienste über Mitternacht und 24:00", () => {
    const r = normalizeRoster(
      {
        entries: [
          entry({ start: "22:00", end: "06:00", title: "Nachtdienst" }),
          entry({ date: "2026-10-06", start: "18:00", end: "24:00", title: "Bereitschaft" }),
        ],
      },
      TODAY,
    );
    expect(r.entries[0]).toMatchObject({ date: "2026-10-05", start: "22:00", end: "06:00", endDate: "2026-10-06" });
    expect(r.entries[1]).toMatchObject({ date: "2026-10-06", start: "18:00", end: "00:00", endDate: "2026-10-07" });
  });

  it("markiert unsichere Einträge mit [?] und Ganztägiges ohne Uhrzeit", () => {
    const r = normalizeRoster(
      {
        entries: [
          entry({ title: "Schießen", confidence: "low" }),
          entry({ date: "2026-10-07", title: "GvD", all_day: true, start: "07:00", end: "07:00" }),
          entry({ date: "2026-10-08", title: "[?] Unklar", confidence: "low" }),
        ],
      },
      TODAY,
    );
    expect(r.entries[0]).toMatchObject({ title: "[?] Schießen", lowConfidence: true });
    expect(r.entries[1]).toEqual(expect.objectContaining({ title: "GvD", allDay: true }));
    expect(r.entries[1]).not.toHaveProperty("start");
    expect(r.entries[2]!.title).toBe("[?] Unklar"); // kein doppeltes Präfix
  });

  it("macht Termine ohne lesbare Startzeit ganztägig und unsicher", () => {
    const r = normalizeRoster({ entries: [entry({ start: "morgens", end: "" })] }, TODAY);
    expect(r.entries[0]).toMatchObject({ allDay: true, lowConfidence: true, title: "[?] Antreten" });
  });

  it("akzeptiert deutsche Datumsformate und überspringt ungültige Einträge", () => {
    const r = normalizeRoster(
      {
        plan_year: 2026,
        plan_week: 41,
        entries: [
          entry({ date: "06.10.2026" }),
          entry({ date: "7.10." }),
          entry({ date: "irgendwann" }),
          entry({ date: "2026-02-30" }),
          "kaputt",
          null,
        ],
      },
      TODAY,
    );
    expect(r.entries.map((e) => e.date)).toEqual(["2026-10-06", "2026-10-07"]);
    expect(r.skipped).toBe(4);
  });

  it("entfernt doppelte Einträge und sortiert nach Tag und Uhrzeit", () => {
    const r = normalizeRoster(
      {
        entries: [
          entry({ date: "2026-10-06", start: "09:00" }),
          entry({ date: "2026-10-05", start: "10:00", end: "11:00" }),
          entry({ date: "2026-10-05", title: "Urlaub", all_day: true }),
          entry({ date: "2026-10-06", start: "09:00" }),
        ],
      },
      TODAY,
    );
    expect(r.entries.map((e) => `${e.date} ${e.allDay ? "ganztags" : e.start}`)).toEqual([
      "2026-10-05 ganztags",
      "2026-10-05 10:00",
      "2026-10-06 09:00",
    ]);
  });

  it("leitet die KW aus den Daten ab, wenn der Plan keine (passende) KW hat", () => {
    expect(normalizeRoster({ entries: [entry()] }, TODAY).weekKey).toBe("2026-W41");
    // KW 12 passt zu keinem Eintrag -> Daten gewinnen
    expect(normalizeRoster({ plan_year: 2026, plan_week: 12, entries: [entry()] }, TODAY).weekKey).toBe("2026-W41");
    // KW 99 ist ungültig
    expect(normalizeRoster({ plan_year: 2026, plan_week: 99, entries: [entry()] }, TODAY).weekKey).toBe("2026-W41");
  });

  it("meldet unlesbare Pläne", () => {
    const empty = normalizeRoster({ readable: false, problem: "Bild unscharf", entries: [] }, TODAY);
    expect(empty).toMatchObject({ readable: false, problem: "Bild unscharf", weekKey: "2026-W40" });
    expect(normalizeRoster({ readable: true, entries: [] }, TODAY).readable).toBe(false);
    expect(normalizeRoster("Unsinn", TODAY).readable).toBe(false);
    expect(normalizeRoster(null, TODAY).readable).toBe(false);
  });

  it("akzeptiert ein nacktes Array als Eintragsliste", () => {
    expect(normalizeRoster([entry()], TODAY).entries).toHaveLength(1);
  });
});
