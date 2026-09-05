import { DateTime, Interval } from "luxon";
import type {
  BirthdayAggregation,
  CalendarEvent,
  Child,
  TimelineEntry,
  WasteAggregation,
} from "./types";

/** Only an explicit child ID can associate birthday data with a child. */
export function findBirthdayForChild(
  events: CalendarEvent[],
  child: Child,
): CalendarEvent | undefined {
  return events.find(
    (event) =>
      event.event_type.toUpperCase() === "BIRTHDAY" &&
      event.child_id === child.id,
  );
}

/** The next explicit start can be later than the end of the current stay. */
export function nextLocationChange(
  location: { current_until: string | null; next_change_at: string | null },
  now: DateTime,
): string {
  return (
    [location.current_until, location.next_change_at]
      .map((value) => futureTimestamp(value, now))
      .filter(Boolean)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? ""
  );
}

export function futureTimestamp(
  value: string | null | undefined,
  now: DateTime,
): string {
  if (!value) {
    return "";
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid && parsed.toMillis() > now.toMillis() ? value : "";
}

export const dayKey = (now: DateTime, offset: number): string =>
  offset === 0 ? "today" : offset === 1 ? "tomorrow" : `days_${offset}`;
export function parseChildIds(value: string | undefined): number[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(Number)
    .filter((item) => Number.isInteger(item) && item > 0);
}
export function isEventActive(event: CalendarEvent, now: DateTime): boolean {
  const start = DateTime.fromISO(event.starts_at).toMillis();
  const end = DateTime.fromISO(event.ends_at).toMillis();
  const current = now.toMillis();
  return start <= current && current < end;
}
/** A stable semantic key for one occurrence, independent of volatile API IDs. */
export function occurrenceKey(event: CalendarEvent): string {
  if (event.event_type === "STAY" && event.generated) {
    return [
      event.child_id ?? "",
      event.responsible_user_id ?? "",
      event.starts_at,
      event.ends_at,
      event.source ?? "",
    ].join("|");
  }
  return [
    event.event_type,
    event.id ?? "",
    event.title?.trim().toLocaleLowerCase() ?? "",
    event.child_id ?? "",
    event.starts_at,
    event.ends_at,
  ].join("|");
}

/** Remove duplicate API rows without collapsing later recurring occurrences. */
export function uniqueOccurrences(events: CalendarEvent[]): CalendarEvent[] {
  const result = new Map<string, CalendarEvent>();
  const sorted = [...events].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
  for (const event of sorted) {
    if (event.event_type === "STAY" && event.generated) {
      const previous = [...result.values()]
        .reverse()
        .find(
          (candidate) =>
            candidate.event_type === "STAY" &&
            candidate.generated &&
            candidate.child_id === event.child_id &&
            candidate.responsible_user_id === event.responsible_user_id &&
            candidate.source === event.source,
        );
      if (
        previous &&
        Date.parse(previous.ends_at) >= Date.parse(event.starts_at)
      ) {
        result.delete(occurrenceKey(previous));
        const merged = {
          ...previous,
          ends_at:
            Date.parse(previous.ends_at) >= Date.parse(event.ends_at)
              ? previous.ends_at
              : event.ends_at,
        };
        result.set(occurrenceKey(merged), merged);
        continue;
      }
    }
    result.set(occurrenceKey(event), event);
  }
  return [...result.values()].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
}

/** Return the first two different occurrences; a multi-day event occupies one slot. */
export function nextOccurrences(
  events: CalendarEvent[],
  now: DateTime,
): [CalendarEvent | undefined, CalendarEvent | undefined] {
  const future = uniqueOccurrences(events).filter(
    (event) => Date.parse(event.starts_at) >= now.toMillis(),
  );
  return [future[0], future[1]];
}
export function eventsForDay(
  events: CalendarEvent[],
  day: DateTime,
  zone: string,
): TimelineEntry[] {
  const start = day.setZone(zone).startOf("day"),
    end = start.plus({ days: 1 });
  return events
    .filter((event) =>
      Interval.fromDateTimes(
        DateTime.fromISO(event.starts_at),
        DateTime.fromISO(event.ends_at),
      ).overlaps(Interval.fromDateTimes(start, end)),
    )
    .map((event) => {
      const eventStart = DateTime.fromISO(event.starts_at).setZone(zone),
        eventEnd = DateTime.fromISO(event.ends_at).setZone(zone);
      return {
        ...event,
        startsThisDay: eventStart >= start && eventStart < end,
        endsThisDay: eventEnd > start && eventEnd <= end,
        continuesThisDay: eventStart < start && eventEnd > end,
      };
    })
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}
export function timelineText(
  entries: TimelineEntry[],
  template: string,
  separator: string,
  zone: string,
  timeFormat: string,
  dateFormat: string,
): string {
  return entries
    .map((event) =>
      template
        .replaceAll("{title}", event.title ?? "")
        .replaceAll(
          "{time}",
          DateTime.fromISO(event.starts_at).setZone(zone).toFormat(timeFormat),
        )
        .replaceAll(
          "{date}",
          DateTime.fromISO(event.starts_at).setZone(zone).toFormat(dateFormat),
        )
        .replaceAll("{type}", event.event_type),
    )
    .join(separator);
}
export function birthdayItem(
  event: CalendarEvent,
  now: DateTime,
  zone: string,
  dateFormat: string,
): BirthdayAggregation {
  const date = DateTime.fromISO(event.starts_at).setZone(zone);
  const age = Number(event.age ?? 0);
  const birthDate =
    typeof event.birth_date === "string"
      ? DateTime.fromISO(event.birth_date).toFormat(dateFormat)
      : date.set({ year: date.year - age }).toFormat(dateFormat);
  return {
    id: event.id,
    name: event.title ?? "",
    birthDate,
    date: date.toISODate()!,
    age,
    daysUntil: Math.round(
      date.startOf("day").diff(now.setZone(zone).startOf("day"), "days").days,
    ),
  };
}
export function wasteType(title: string): string {
  return title.split(/\s+(?:in|am|für)\s+/i)[0].trim();
}
export function wasteItem(
  event: CalendarEvent,
  now: DateTime,
  zone: string,
  mappings: Array<{
    match: string;
    name: string;
  }>,
): WasteAggregation {
  const date = DateTime.fromISO(event.starts_at).setZone(zone);
  const title = event.title ?? "";
  const raw = wasteType(title);
  const mapped =
    mappings.find((m) =>
      title.toLocaleLowerCase().includes(m.match.toLocaleLowerCase()),
    )?.name ?? raw;
  return {
    id: event.id,
    title,
    wasteType: mapped,
    date: date.toISODate()!,
    daysUntil: Math.round(
      date.startOf("day").diff(now.setZone(zone).startOf("day"), "days").days,
    ),
    startsAt: event.starts_at,
  };
}
export function renderRelative(
  items: Array<Record<string, unknown>>,
  days: number,
  templates: {
    today: string;
    tomorrow: string;
    future: string;
  },
  separator: string,
): string {
  const template =
    days === 0
      ? templates.today
      : days === 1
        ? templates.tomorrow
        : templates.future;
  return items
    .map((item) =>
      Object.entries(item).reduce(
        (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
        template.replaceAll("{days}", String(days)),
      ),
    )
    .join(separator);
}

/** Preserve the complete API event and provide a description for older responses. */
export function completeEvent(event: CalendarEvent): CalendarEvent {
  return {
    ...event,
    description:
      event.description === undefined
        ? (event.note ?? null)
        : event.description,
  };
}
