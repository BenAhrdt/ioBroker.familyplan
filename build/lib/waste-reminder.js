"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wasteReminder = wasteReminder;
const luxon_1 = require("luxon");
const aggregation_1 = require("./aggregation");
/** Show the latest due group until expiry or replacement by a newly due group. */
function wasteReminder(events, now, config, acknowledgedDates = []) {
    const zone = config.timezone || "Europe/Berlin";
    const today = now.setZone(zone).startOf("day");
    const groups = new Map();
    for (const event of (0, aggregation_1.uniqueOccurrences)(events)) {
        if (event.event_type !== "WASTE") {
            continue;
        }
        const date = luxon_1.DateTime.fromISO(event.starts_at).setZone(zone);
        if (!date.isValid || date.startOf("day") < today) {
            continue;
        }
        const key = date.toISODate();
        groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const configuredDays = Number(config.wasteReminderDays ?? 1);
    const days = Number.isFinite(configuredDays)
        ? Math.max(0, Math.floor(configuredDays))
        : 1;
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.wasteReminderTime ?? "")
        ? config.wasteReminderTime
        : "15:00";
    const [hour, minute] = time.split(":").map(Number);
    const keys = [...groups.keys()].sort();
    const key = keys
        .filter((value) => luxon_1.DateTime.fromISO(value, { zone })
        .minus({ days })
        .set({ hour, minute }) <= now)
        .at(-1) ?? keys[0];
    if (!key) {
        return undefined;
    }
    const entries = groups.get(key);
    const date = luxon_1.DateTime.fromISO(key, { zone });
    const remindAt = date.minus({ days }).set({ hour, minute });
    const expiresAt = date.plus({ days: 1 });
    const types = [
        ...new Set(entries.map((event) => (0, aggregation_1.wasteItem)(event, now, zone, config.wasteMappings || []).wasteType ||
            "Abfall")),
    ];
    const names = types.length > 1
        ? `${types.slice(0, -1).join(", ")} und ${types[types.length - 1]}`
        : types[0];
    const daysLeft = Math.round(date.diff(today, "days").days);
    const relative = daysLeft === 0
        ? "Heute"
        : daysLeft === 1
            ? "Morgen"
            : `In ${daysLeft} Tagen`;
    const acknowledged = acknowledgedDates.includes(key);
    return {
        key,
        entries,
        types,
        date,
        daysLeft,
        remindAt,
        expiresAt,
        acknowledged,
        active: now >= remindAt && now < expiresAt && !acknowledged,
        text: `${relative} ${types.length === 1 ? "wird" : "werden"} ${names} abgeholt.`,
    };
}
//# sourceMappingURL=waste-reminder.js.map