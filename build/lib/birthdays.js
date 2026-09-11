"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.birthdayIdentity = birthdayIdentity;
exports.birthdayName = birthdayName;
exports.birthdayBirthDate = birthdayBirthDate;
exports.upcomingBirthdays = upcomingBirthdays;
exports.birthdaySummaryText = birthdaySummaryText;
const luxon_1 = require("luxon");
/** Keep manual birthdays, children and people in separate identity namespaces. */
function birthdayIdentity(event) {
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
/** Resolve the public birthday name without modifying the calendar title. */
function birthdayName(event) {
    const clean = (value) => typeof value === "string" ? value.trim() : "";
    return (clean(event.full_name) ||
        [clean(event.first_name), clean(event.last_name)]
            .filter(Boolean)
            .join(" ") ||
        clean(event.display_name) ||
        clean(event.title));
}
/** Only explicit dates are birth dates; an annual occurrence cannot establish a birth year. */
function birthdayBirthDate(event, zone, knownBirthDate) {
    for (const value of [event.birth_date, knownBirthDate]) {
        const explicit = typeof value === "string" ? luxon_1.DateTime.fromISO(value, { zone }) : undefined;
        if (explicit?.isValid) {
            return explicit.startOf("day");
        }
    }
    return undefined;
}
/** One annual preview per source identity, including today and never negative days. */
function upcomingBirthdays(events, now, zone, dateFormat, children = []) {
    const today = now.setZone(zone).startOf("day");
    const people = new Map();
    for (const event of events) {
        if (event.event_type.toUpperCase() !== "BIRTHDAY") {
            continue;
        }
        const sourceDate = luxon_1.DateTime.fromISO(event.starts_at).setZone(zone);
        if (!sourceDate.isValid) {
            continue;
        }
        const child = event.child_id != null
            ? children.find((item) => item.id === event.child_id)
            : undefined;
        const birthDate = birthdayBirthDate(event, zone, child?.birth_date);
        const date = sourceDate.startOf("day");
        if (date < today) {
            continue;
        }
        const name = birthdayName(event);
        const identity = birthdayIdentity(event);
        const item = {
            event,
            name,
            birthDate: birthDate?.toFormat(dateFormat) ?? "",
            date: date.toISODate(),
            age: event.age ?? null,
            daysUntil: Math.round(date.diff(today, "days").days),
        };
        const previous = people.get(identity);
        // Recurrence dates and ages come from the server, including leap-day adjustments.
        if (!previous || item.date < previous.date) {
            people.set(identity, item);
        }
    }
    return [...people.values()].sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, "de"));
}
/** A joint message for the nearest birthday day. Unknown ages are omitted. */
function birthdaySummaryText(items) {
    if (!items.length) {
        return "";
    }
    const first = items[0];
    const people = items.filter((item) => item.daysUntil === first.daysUntil);
    const names = people.map((item) => item.age == null ? item.name : `${item.name} ${item.age}`);
    const joined = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} und ${names.at(-1)}`;
    const when = first.daysUntil === 0
        ? "Heute"
        : first.daysUntil === 1
            ? "Morgen"
            : `In ${first.daysUntil} Tagen`;
    if (people.some((item) => item.age == null)) {
        return `${when} ${people.length === 1 ? "hat" : "haben"} ${people.map((item) => item.name).join(", ")} Geburtstag.`;
    }
    return `${when} ${people.length === 1 ? "wird" : "werden"} ${joined}.`;
}
//# sourceMappingURL=birthdays.js.map