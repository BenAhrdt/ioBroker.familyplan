import { DateTime } from "luxon";
import type { CalendarEvent, Child } from "./types";

/** Keep manual birthdays, children and people in separate identity namespaces. */
export function birthdayIdentity(event: CalendarEvent): string {
  if (event.source === "child" || String(event.id).startsWith("child:")) {
    return `child:${event.child_id ?? String(event.id).replace(/^child:/, "")}`;
  }
  if (event.source === "person" || String(event.id).startsWith("person:")) {
    return `person:${event.user_id ?? String(event.id).replace(/^person:/, "")}`;
  }
  if (event.child_id != null && !event.source) {
    return `child:${event.child_id}`;
  }
  return event.id != null
    ? `${event.source || "birthday"}:${typeof event.id}:${event.id}`
    : `name:${event.title?.trim().toLocaleLowerCase() ?? ""}:${event.starts_at.slice(5, 10)}`;
}

export interface UpcomingBirthday {
  event: CalendarEvent;
  name: string;
  birthDate: string;
  date: string;
  age: number | null;
  daysUntil: number;
}

/** Prefer an explicit birth date; otherwise derive it only from a known birthday age. */
export function birthdayBirthDate(
  event: CalendarEvent,
  zone: string,
  knownBirthDate?: string | null,
): DateTime | undefined {
  for (const value of [knownBirthDate, event.birth_date]) {
    const explicit =
      typeof value === "string" ? DateTime.fromISO(value, { zone }) : undefined;
    if (explicit?.isValid) {
      return explicit.startOf("day");
    }
  }
  const occurrence = DateTime.fromISO(event.starts_at).setZone(zone);
  if (!occurrence.isValid || typeof event.age !== "number") {
    return undefined;
  }
  return occurrence.startOf("day").set({ year: occurrence.year - event.age });
}

/** One annual preview per source identity, including today and never negative days. */
export function upcomingBirthdays(
  events: CalendarEvent[],
  now: DateTime,
  zone: string,
  dateFormat: string,
  children: Child[] = [],
): UpcomingBirthday[] {
  const today = now.setZone(zone).startOf("day");
  const people = new Map<string, UpcomingBirthday>();
  for (const event of events) {
    if (event.event_type.toUpperCase() !== "BIRTHDAY") {
      continue;
    }
    const sourceDate = DateTime.fromISO(event.starts_at).setZone(zone);
    if (!sourceDate.isValid) {
      continue;
    }
    const child =
      event.child_id != null
        ? children.find((item) => item.id === event.child_id)
        : undefined;
    const birthDate = birthdayBirthDate(event, zone, child?.birth_date);
    const anniversary = birthDate ?? sourceDate;
    // Luxon clamps February 29 to February 28 in non-leap years.
    let date = anniversary.set({ year: today.year }).startOf("day");
    if (date < today) {
      date = anniversary.set({ year: today.year + 1 }).startOf("day");
    }
    const name = event.title ?? "";
    const identity = birthdayIdentity(event);
    const item = {
      event,
      name,
      birthDate: birthDate?.toFormat(dateFormat) ?? "",
      date: date.toISODate()!,
      age: birthDate ? date.year - birthDate.year : null,
      daysUntil: Math.round(date.diff(today, "days").days),
    };
    const previous = people.get(identity);
    // Prefer the source occurrence nearest the upcoming anniversary.
    if (
      !previous ||
      Math.abs(sourceDate.toMillis() - date.toMillis()) <
        Math.abs(
          DateTime.fromISO(previous.event.starts_at).toMillis() -
            date.toMillis(),
        )
    ) {
      people.set(identity, item);
    }
  }
  return [...people.values()].sort(
    (a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, "de"),
  );
}

/** A joint message for the nearest birthday day. Unknown ages are omitted. */
export function birthdaySummaryText(items: UpcomingBirthday[]): string {
  if (!items.length) {
    return "";
  }
  const first = items[0];
  const people = items.filter((item) => item.daysUntil === first.daysUntil);
  const names = people.map((item) =>
    item.age == null ? item.name : `${item.name} ${item.age}`,
  );
  const joined =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} und ${names.at(-1)}`;
  const when =
    first.daysUntil === 0
      ? "Heute"
      : first.daysUntil === 1
        ? "Morgen"
        : `In ${first.daysUntil} Tagen`;
  if (people.some((item) => item.age == null)) {
    return `${when} ${people.length === 1 ? "hat" : "haben"} ${people.map((item) => item.name).join(", ")} Geburtstag.`;
  }
  return `${when} ${people.length === 1 ? "wird" : "werden"} ${joined}.`;
}
