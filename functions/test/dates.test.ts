import { describe, expect, it } from "vitest";
import {
  addDays,
  berlinToday,
  formatTime,
  isoWeek,
  isValidDate,
  mondayOfIsoWeek,
  parseTime,
  weekKey,
  weekdayShort,
  weeksInYear,
} from "../src/dates.js";

describe("dates", () => {
  it("validiert Datumsstrings", () => {
    expect(isValidDate("2026-10-05")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("05.10.2026")).toBe(false);
    expect(isValidDate(42)).toBe(false);
  });

  it("rechnet Tage über Monats- und Jahresgrenzen", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30"); // Zeitumstellung
  });

  it("bestimmt ISO-Kalenderwochen", () => {
    expect(isoWeek("2026-10-02")).toEqual({ year: 2026, week: 40 });
    expect(isoWeek("2026-01-01")).toEqual({ year: 2026, week: 1 });
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 });
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2025)).toBe(52);
    expect(mondayOfIsoWeek(2026, 40)).toBe("2026-09-28");
    expect(mondayOfIsoWeek(2025, 1)).toBe("2024-12-30");
    expect(weekKey(2026, 5)).toBe("2026-W05");
  });

  it("liefert Wochentage und das Berliner Datum", () => {
    expect(weekdayShort("2026-10-05")).toBe("Mo");
    expect(weekdayShort("2026-10-04")).toBe("So");
    // 23:30 UTC am 2.10. ist in Berlin schon der 3.10.
    expect(berlinToday(new Date("2026-10-02T23:30:00Z"))).toBe("2026-10-03");
  });

  it("liest verschiedene Uhrzeitformate", () => {
    expect(parseTime("7:30")).toBe(450);
    expect(parseTime("07.30")).toBe(450);
    expect(parseTime("0730")).toBe(450);
    expect(parseTime("7 Uhr")).toBe(420);
    expect(parseTime("7:30 Uhr")).toBe(450);
    expect(parseTime("07h30")).toBe(450);
    expect(parseTime("24:00")).toBe(1440);
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("7:61")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("abends")).toBeNull();
    expect(parseTime(null)).toBeNull();
    expect(formatTime(450)).toBe("07:30");
  });
});
