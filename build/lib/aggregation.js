"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dayKey = void 0;
exports.findBirthdayForChild = findBirthdayForChild;
exports.nextLocationChange = nextLocationChange;
exports.futureTimestamp = futureTimestamp;
exports.parseChildIds = parseChildIds;
exports.isEventActive = isEventActive;
exports.occurrenceKey = occurrenceKey;
exports.uniqueOccurrences = uniqueOccurrences;
exports.nextOccurrences = nextOccurrences;
exports.eventsForDay = eventsForDay;
exports.timelineText = timelineText;
exports.birthdayItem = birthdayItem;
exports.wasteType = wasteType;
exports.wasteItem = wasteItem;
exports.renderRelative = renderRelative;
exports.completeEvent = completeEvent;
const luxon_1 = require("luxon");
const birthdays_1 = require("./birthdays");
/** Only an explicit child ID can associate birthday data with a child. */
function findBirthdayForChild(events, child) {
    return events.find((event) => event.event_type.toUpperCase() === "BIRTHDAY" &&
        event.child_id === child.id);
}
/** The next explicit start can be later than the end of the current stay. */
function nextLocationChange(location, now) {
    return ([location.current_until, location.next_change_at]
        .map((value) => futureTimestamp(value, now))
        .filter(Boolean)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? "");
}
function futureTimestamp(value, now) {
    if (!value) {
        return "";
    }
    const parsed = luxon_1.DateTime.fromISO(value, { setZone: true });
    return parsed.isValid && parsed.toMillis() > now.toMillis() ? value : "";
}
const dayKey = (now, offset) => offset === 0 ? "today" : offset === 1 ? "tomorrow" : `days_${offset}`;
exports.dayKey = dayKey;
function parseChildIds(value) {
    return String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map(Number)
        .filter((item) => Number.isInteger(item) && item > 0);
}
function isEventActive(event, now) {
    const start = luxon_1.DateTime.fromISO(event.starts_at).toMillis();
    const end = luxon_1.DateTime.fromISO(event.ends_at).toMillis();
    const current = now.toMillis();
    return start <= current && current < end;
}
/** A stable semantic key for one occurrence, independent of volatile API IDs. */
function occurrenceKey(event) {
    if (event.event_type === "BIRTHDAY") {
        return JSON.stringify([
            event.event_type,
            (0, birthdays_1.birthdayIdentity)(event),
            event.starts_at,
        ]);
    }
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
function uniqueOccurrences(events) {
    const result = new Map();
    const sorted = [...events].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    for (const event of sorted) {
        if (event.event_type === "STAY" && event.generated) {
            const previous = [...result.values()]
                .reverse()
                .find((candidate) => candidate.event_type === "STAY" &&
                candidate.generated &&
                candidate.child_id === event.child_id &&
                candidate.responsible_user_id === event.responsible_user_id &&
                candidate.source === event.source);
            if (previous &&
                Date.parse(previous.ends_at) >= Date.parse(event.starts_at)) {
                result.delete(occurrenceKey(previous));
                const merged = {
                    ...previous,
                    ends_at: Date.parse(previous.ends_at) >= Date.parse(event.ends_at)
                        ? previous.ends_at
                        : event.ends_at,
                };
                result.set(occurrenceKey(merged), merged);
                continue;
            }
        }
        result.set(occurrenceKey(event), event);
    }
    return [...result.values()].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}
/** Return the first two different occurrences; a multi-day event occupies one slot. */
function nextOccurrences(events, now) {
    const future = uniqueOccurrences(events).filter((event) => Date.parse(event.starts_at) >= now.toMillis());
    return [future[0], future[1]];
}
function eventsForDay(events, day, zone) {
    const start = day.setZone(zone).startOf("day"), end = start.plus({ days: 1 });
    return events
        .filter((event) => luxon_1.Interval.fromDateTimes(luxon_1.DateTime.fromISO(event.starts_at), luxon_1.DateTime.fromISO(event.ends_at)).overlaps(luxon_1.Interval.fromDateTimes(start, end)))
        .map((event) => {
        const eventStart = luxon_1.DateTime.fromISO(event.starts_at).setZone(zone), eventEnd = luxon_1.DateTime.fromISO(event.ends_at).setZone(zone);
        return {
            ...event,
            startsThisDay: eventStart >= start && eventStart < end,
            endsThisDay: eventEnd > start && eventEnd <= end,
            continuesThisDay: eventStart < start && eventEnd > end,
        };
    })
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}
function timelineText(entries, template, separator, zone, timeFormat, dateFormat) {
    return entries
        .map((event) => template
        .replaceAll("{title}", event.title ?? "")
        .replaceAll("{time}", luxon_1.DateTime.fromISO(event.starts_at).setZone(zone).toFormat(timeFormat))
        .replaceAll("{date}", luxon_1.DateTime.fromISO(event.starts_at).setZone(zone).toFormat(dateFormat))
        .replaceAll("{type}", event.event_type))
        .join(separator);
}
function birthdayItem(event, now, zone, dateFormat, knownBirthDate) {
    const date = luxon_1.DateTime.fromISO(event.starts_at).setZone(zone);
    const birth = (0, birthdays_1.birthdayBirthDate)(event, zone, knownBirthDate);
    const age = event.age ?? null;
    const birthDate = birth?.toFormat(dateFormat) ?? "";
    return {
        id: event.id,
        name: (0, birthdays_1.birthdayName)(event),
        birthDate,
        date: date.toISODate(),
        age,
        daysUntil: Math.round(date.startOf("day").diff(now.setZone(zone).startOf("day"), "days").days),
    };
}
function wasteType(title) {
    return title.split(/\s+(?:in|am|für)\s+/i)[0].trim();
}
function wasteItem(event, now, zone, mappings) {
    const date = luxon_1.DateTime.fromISO(event.starts_at).setZone(zone);
    const title = event.title ?? "";
    const raw = wasteType(title);
    const mapped = mappings.find((m) => title.toLocaleLowerCase().includes(m.match.toLocaleLowerCase()))?.name ?? raw;
    return {
        id: event.id,
        title,
        wasteType: mapped,
        date: date.toISODate(),
        daysUntil: Math.round(date.startOf("day").diff(now.setZone(zone).startOf("day"), "days").days),
        startsAt: event.starts_at,
    };
}
function renderRelative(items, days, templates, separator) {
    const template = days === 0
        ? templates.today
        : days === 1
            ? templates.tomorrow
            : templates.future;
    return items
        .map((item) => Object.entries(item).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template.replaceAll("{days}", String(days))))
        .join(separator);
}
/** Preserve the complete API event and provide a description for older responses. */
function completeEvent(event) {
    return {
        ...event,
        description: event.description === undefined
            ? (event.note ?? null)
            : event.description,
    };
}
//# sourceMappingURL=aggregation.js.map