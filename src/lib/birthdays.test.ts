import { expect } from "chai";
import { DateTime } from "luxon";
import {
  birthdayBirthDate,
  birthdaySummaryText,
  upcomingBirthdays,
} from "./birthdays";
import type { CalendarEvent } from "./types";

const zone = "Europe/Berlin";
const today = DateTime.fromISO("2026-09-05T15:00", { zone });
const birthday = (
  id: number,
  name: string,
  date: string,
  age: number | null,
): CalendarEvent => ({
  id,
  title: name,
  event_type: "BIRTHDAY",
  age,
  starts_at: DateTime.fromISO(date, { zone }).toISO()!,
  ends_at: DateTime.fromISO(date, { zone }).plus({ days: 1 }).toISO()!,
});
const summary = (events: CalendarEvent[], now = today) =>
  upcomingBirthdays(events, now, zone, "dd.MM.yyyy");

describe("Upcoming birthday summary", () => {
  it("starts with today's birthdays and rolls yesterday forward with the next age", () => {
    const items = summary([
      birthday(1, "Gestern", "2026-09-04", 39),
      birthday(2, "Morgen", "2026-09-06", 40),
      birthday(3, "Heute", "2026-09-05", 50),
    ]);
    expect(items.map((item) => item.daysUntil)).deep.eq([0, 1, 364]);
    expect(items[2]).include({
      age: 40,
      date: "2027-09-04",
      birthDate: "04.09.1987",
    });
  });
  it("deduplicates annual occurrences without merging distinct people sharing a name", () => {
    const items = summary([
      birthday(1, "Rebecca", "2025-09-05", 38),
      birthday(1, "Rebecca", "2026-09-05", 39),
      birthday(2, "Rebecca", "2026-09-05", 40),
    ]);
    expect(items).length(2);
    expect(items.map((item) => item.age)).deep.eq([39, 40]);
  });
  it("joins the nearest day's people into one message", () => {
    expect(
      birthdaySummaryText(
        summary([
          birthday(1, "Rebecca", "2026-09-05", 39),
          birthday(2, "XY", "2026-09-05", 40),
          birthday(3, "ABC", "2026-09-05", 50),
          birthday(4, "Später", "2026-09-08", 12),
        ]),
      ),
    ).eq("Heute werden ABC 50, Rebecca 39 und XY 40.");
    expect(
      birthdaySummaryText(summary([birthday(1, "Rebecca", "2026-09-08", 39)])),
    ).eq("In 3 Tagen wird Rebecca 39.");
    expect(birthdaySummaryText([])).eq("");
  });
  it("keeps unknown ages unknown instead of inventing a birth year", () => {
    const event = birthday(1, "Rebecca", "2026-09-05", null);
    expect(birthdayBirthDate(event, zone)).eq(undefined);
    expect(summary([event])[0]).include({ age: null, birthDate: "" });
    expect(birthdaySummaryText(summary([event]))).eq(
      "Heute hat Rebecca Geburtstag.",
    );
  });
  it("uses the explicit birthday for leap years and accounts for DST in day distances", () => {
    const event = {
      ...birthday(1, "Leap", "2026-02-28", 22),
      birth_date: "2004-02-29",
    };
    expect(
      summary([event], DateTime.fromISO("2027-03-01", { zone }))[0],
    ).include({ date: "2028-02-29", age: 24, birthDate: "29.02.2004" });
    expect(
      summary(
        [birthday(2, "DST", "2026-03-30", 20)],
        DateTime.fromISO("2026-03-28", { zone }),
      )[0].daysUntil,
    ).eq(2);
  });
});

describe("Birthday source identity and API leap-day handling", () => {
  it("keeps manual, child and person IDs separate even for identical names and dates", () => {
    const base = birthday(1, "Alex", "2026-09-05", 40);
    const events = [
      { ...base, source: "birthday" },
      { ...base, id: "child:1", source: "child", child_id: 1 },
      { ...base, id: "person:1", source: "person", user_id: 1 },
    ];
    expect(summary(events)).length(3);
    expect(summary([...events, ...events])).length(3);
  });
  it("uses a child's authoritative date when projecting beyond a clamped occurrence", () => {
    const event = {
      ...birthday(1, "Rika", "2027-02-28", 15),
      id: "child:1",
      source: "child",
      child_id: 1,
    };
    const items = upcomingBirthdays(
      [event],
      DateTime.fromISO("2027-03-01", { zone }),
      zone,
      "dd.MM.yyyy",
      [
        {
          id: 1,
          name: "Rika",
          default_responsible_user_id: null,
          birth_date: "2012-02-29",
        },
      ],
    );
    expect(items[0]).include({
      birthDate: "29.02.2012",
      date: "2028-02-29",
      age: 16,
      daysUntil: 365,
    });
  });
});
