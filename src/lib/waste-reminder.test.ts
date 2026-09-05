import { expect } from "chai";
import { DateTime } from "luxon";
import { wasteReminder } from "./waste-reminder";
import type { CalendarEvent } from "./types";

const config = { timezone: "Europe/Berlin", wasteMappings: [] };
const at = (value: string) =>
  DateTime.fromISO(value, { zone: config.timezone });
const collection = (
  date: string,
  title = "Altpapier in Berlin",
): CalendarEvent => ({
  id: `${date}-${title}`,
  event_type: "WASTE",
  title,
  starts_at: at(date).toISO()!,
  ends_at: at(date).plus({ days: 1 }).toISO()!,
});

describe("Waste reminders", () => {
  it("groups and deduplicates collections, activating at 15:00 the previous day", () => {
    const paper = collection("2026-09-06");
    const events = [paper, collection("2026-09-06", "Bioabfall"), paper];
    expect(wasteReminder(events, at("2026-09-05T14:59:59"), config)?.active).eq(
      false,
    );
    const reminder = wasteReminder(events, at("2026-09-05T15:00:00"), config)!;
    expect(reminder.active).eq(true);
    expect(reminder.daysLeft).eq(1);
    expect(reminder.entries).length(2);
    expect(reminder.text).eq("Morgen werden Altpapier und Bioabfall abgeholt.");
  });
  it("changes to today and expires at the end of the collection day", () => {
    const events = [collection("2026-09-06")];
    const reminder = wasteReminder(events, at("2026-09-06T23:59:59"), config)!;
    expect(reminder.active).eq(true);
    expect(reminder.text).eq("Heute wird Altpapier abgeholt.");
    expect(wasteReminder(events, at("2026-09-07"), config)).eq(undefined);
  });
  it("keeps acknowledged groups visible and switches when the next group becomes due", () => {
    const events = [collection("2026-09-06"), collection("2026-09-07")];
    const before = wasteReminder(events, at("2026-09-06T14:59"), config, [
      "2026-09-06",
    ])!;
    expect(before.key).eq("2026-09-06");
    expect(before.active).eq(false);
    expect(before.acknowledged).eq(true);
    const next = wasteReminder(events, at("2026-09-06T15:00"), config, [
      "2026-09-06",
    ])!;
    expect(next.key).eq("2026-09-07");
    expect(next.active).eq(true);
  });
  it("supports same-day reminders and multiple days of advance notice", () => {
    const events = [collection("2026-09-06")];
    const sameDay = {
      ...config,
      wasteReminderDays: 0,
      wasteReminderTime: "08:30",
    };
    expect(wasteReminder(events, at("2026-09-06T08:29"), sameDay)?.active).eq(
      false,
    );
    expect(wasteReminder(events, at("2026-09-06T08:30"), sameDay)?.active).eq(
      true,
    );
    expect(
      wasteReminder(events, at("2026-09-04T15:00"), {
        ...config,
        wasteReminderDays: 2,
      })?.text,
    ).eq("In 2 Tagen wird Altpapier abgeholt.");
  });
  it("uses local calendar days across daylight-saving changes and UTC event dates", () => {
    const events = [
      { ...collection("2026-03-30"), starts_at: "2026-03-29T22:00:00Z" },
    ];
    const reminder = wasteReminder(events, at("2026-03-28T15:00"), {
      ...config,
      wasteReminderDays: 2,
    })!;
    expect(reminder.daysLeft).eq(2);
    expect(reminder.active).eq(true);
    expect(reminder.remindAt.toISO()).eq("2026-03-28T15:00:00.000+01:00");
    expect(reminder.expiresAt.toISO()).eq("2026-03-31T00:00:00.000+02:00");
  });
  it("uses configured names and joins three distinct types", () => {
    const events = [
      collection("2026-09-06"),
      collection("2026-09-06", "Bio"),
      collection("2026-09-06", "Rest"),
    ];
    const reminder = wasteReminder(events, at("2026-09-05T15:00"), {
      ...config,
      wasteMappings: [{ match: "Bio", name: "Bioabfall" }],
    })!;
    expect(reminder.text).eq(
      "Morgen werden Altpapier, Bioabfall und Rest abgeholt.",
    );
  });
});
