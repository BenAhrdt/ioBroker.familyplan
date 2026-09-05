import { expect } from "chai";
import { DateTime } from "luxon";
import {
  birthdayBirthDate,
  birthdayName,
  birthdaySummaryText,
  upcomingBirthdays,
} from "./birthdays";
import { birthdayItem, occurrenceKey, uniqueOccurrences } from "./aggregation";
import { parseEvents } from "./validation";
import type { CalendarEvent } from "./types";

const zone = "Europe/Berlin";
const today = DateTime.fromISO("2026-09-05T15:00", { zone });
const birthday = (
  id: number | string,
  name: string,
  date: string,
  age: number | null,
): CalendarEvent => ({
  id,
  title: name,
  event_type: "BIRTHDAY",
  age,
  all_day: true,
  starts_at: DateTime.fromISO(date, { zone }).toISO()!,
  ends_at: DateTime.fromISO(date, { zone }).plus({ days: 1 }).toISO()!,
});
const summary = (events: CalendarEvent[], now = today) =>
  upcomingBirthdays(events, now, zone, "dd.MM.yyyy");

describe("FamilienPlan 0.1.100 birthdays", () => {
  it("selects full, composed, display and legacy names in order without changing title", () => {
    const event = birthday("child:1", "Tom", "2026-09-11", 15);
    const variants = [
      {
        full_name: "  Tom Grywnow  ",
        first_name: "Ignored",
        last_name: "Name",
        display_name: "Display",
      },
      {
        full_name: " ",
        first_name: " Tom ",
        last_name: " Grywnow ",
        display_name: "Display",
      },
      { first_name: null, last_name: "Grywnow" },
      { first_name: "", last_name: null, display_name: " Tom Display " },
      { full_name: null, display_name: null },
    ];
    expect(
      variants.map((fields) =>
        birthdayName(parseEvents([{ ...event, ...fields }])[0]),
      ),
    ).deep.eq(["Tom Grywnow", "Tom Grywnow", "Grywnow", "Tom Display", "Tom"]);
    expect(event.title).eq("Tom");
  });
  it("never derives a birth year from the occurrence, even when the age is known", () => {
    for (const birth_date of [undefined, null, "", "invalid"]) {
      const event = { ...birthday(1, "Tom", "2026-09-11", 15), birth_date };
      expect(birthdayBirthDate(event, zone)).eq(undefined);
      expect(birthdayItem(event, today, zone, "dd.MM.yyyy")).include({
        age: 15,
        birthDate: "",
      });
      expect(summary([event])[0]).include({ age: 15, birthDate: "" });
    }
    const event = {
      ...birthday(1, "Tom", "2026-09-11", null),
      birth_date: "2011-09-11",
    };
    expect(birthdayItem(event, today, zone, "dd.MM.yyyy")).include({
      age: null,
      birthDate: "11.09.2011",
    });
    expect(summary([event])[0].age).eq(null);
  });
  it("sorts supplied occurrences from today, deduplicates identities, and excludes expired dates", () => {
    const events = [
      birthday(1, "Gestern", "2026-09-04", 39),
      birthday(1, "Gestern", "2027-09-04", 40),
      birthday(2, "Morgen", "2026-09-06", 40),
      birthday(3, "Heute", "2026-09-05", 50),
      birthday(3, "Heute", "2027-09-05", 51),
    ];
    expect(summary(events).map((item) => item.daysUntil)).deep.eq([0, 1, 364]);
    expect(summary(events)[2]).include({
      age: 40,
      date: "2027-09-04",
      birthDate: "",
    });
    expect(summary([events[0]])).deep.eq([]);
  });
  it("keeps source identities and yearly calendar occurrences separate", () => {
    const base = birthday(1, "Alex", "2026-09-05", 40);
    const events = [
      { ...base, source: "birthday" },
      { ...base, id: "child:1", source: "child", child_id: 1 },
      { ...base, id: "person:1", source: "person", user_id: 1 },
    ];
    expect(summary([...events, ...events])).length(3);
    const nextYear = {
      ...events[1],
      ...birthday("child:1", "Alex", "2027-09-05", 41),
    };
    expect(occurrenceKey(events[1])).not.eq(occurrenceKey(nextYear));
    expect(uniqueOccurrences([...events, nextYear, ...events])).length(4);
  });
  it("joins the nearest day's full names and handles unknown ages", () => {
    const events = [
      {
        ...birthday(1, "Rebecca", "2026-09-05", 39),
        full_name: "Rebecca Bradtke",
      },
      birthday(2, "XY", "2026-09-05", 40),
      birthday(3, "Später", "2026-09-08", 50),
    ];
    expect(birthdaySummaryText(summary(events))).eq(
      "Heute werden Rebecca Bradtke 39 und XY 40.",
    );
    expect(
      birthdaySummaryText(summary([birthday(1, "Tom", "2026-09-08", null)])),
    ).eq("In 3 Tagen hat Tom Geburtstag.");
    expect(birthdaySummaryText([])).eq("");
  });
  it("preserves server leap-day dates, real birth dates and local-day distances across DST", () => {
    const event = {
      ...birthday("child:1", "Tom", "2027-02-28", 15),
      source: "child",
      child_id: 1,
      birth_date: "2012-02-29",
    };
    const next = {
      ...event,
      starts_at: "2028-02-28T23:00:00Z",
      ends_at: "2028-02-29T23:00:00Z",
      age: 16,
    };
    expect(
      summary([event, next], DateTime.fromISO("2027-03-01", { zone }))[0],
    ).include({ date: "2028-02-29", age: 16, birthDate: "29.02.2012" });
    expect(
      summary([event], DateTime.fromISO("2027-02-28T18:00", { zone }))[0],
    ).include({ date: "2027-02-28", daysUntil: 0, birthDate: "29.02.2012" });
    expect(
      summary(
        [birthday(1, "DST", "2026-03-30", 20)],
        DateTime.fromISO("2026-03-28", { zone }),
      )[0].daysUntil,
    ).eq(2);
  });
});
