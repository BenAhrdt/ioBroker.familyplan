"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerLengthSeconds = triggerLengthSeconds;
exports.catchUpWindowSeconds = catchUpWindowSeconds;
exports.textMatches = textMatches;
exports.triggerIsActive = triggerIsActive;
exports.ruleMatches = ruleMatches;
exports.scheduledFor = scheduledFor;
exports.triggerKey = triggerKey;
exports.dueTriggers = dueTriggers;
exports.futureTriggers = futureTriggers;
const luxon_1 = require("luxon");
const node_crypto_1 = require("node:crypto");
const aggregation_1 = require("./aggregation");
const units = {
    seconds: "seconds",
    minutes: "minutes",
    hours: "hours",
    days: "days",
};
const secondsPerUnit = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
/** Keep old rules in seconds; an explicitly empty value means no automatic reset. */
function triggerLengthSeconds(rule) {
    const value = rule.catchUpSeconds;
    if (value === null || (typeof value === "string" && !value.trim())) {
        return null;
    }
    const length = Number(value ?? 60);
    return Number.isFinite(length) && length > 0
        ? length * (secondsPerUnit[rule.lengthUnit ?? "seconds"] ?? 1)
        : 60;
}
function catchUpWindowSeconds(rule) {
    // Old rules used one field for both pulse length and catch-up time.
    const legacy = rule.lengthUnit === undefined ? Number(rule.catchUpSeconds ?? 60) : 60;
    const value = rule.catchUpWindowSeconds ?? legacy;
    return Number.isFinite(value) && value >= 1 ? value : 60;
}
function textMatches(filter, value, mode = "exact") {
    const expected = (filter ?? "").normalize("NFKC").trim().toLocaleLowerCase();
    const actual = (value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
    return (!expected ||
        (mode === "contains" ? actual.includes(expected) : actual === expected));
}
function triggerIsActive(rule, lastTriggered, now, wasActive, reset = false) {
    const length = triggerLengthSeconds(rule);
    return (rule.enabled &&
        wasActive &&
        !reset &&
        lastTriggered.isValid &&
        (length === null ||
            now.toMillis() < lastTriggered.toMillis() + length * 1000));
}
/**
 *
 */
function ruleMatches(rule, event) {
    const configuredType = rule.eventType?.toUpperCase() || "";
    return (rule.enabled &&
        textMatches(rule.title, event.title, rule.titleMatchMode) &&
        textMatches(rule.description, (0, aggregation_1.completeEvent)(event).description, rule.descriptionMatchMode) &&
        (!configuredType || configuredType === event.event_type.toUpperCase()) &&
        (configuredType !== "OTHER" ||
            !rule.customTypeLabel ||
            rule.customTypeLabel
                .trim()
                .localeCompare(event.custom_type_label?.trim() ?? "", undefined, {
                sensitivity: "base",
            }) === 0) &&
        (!rule.childName ||
            rule.childName.localeCompare(event.child_name ?? "", undefined, {
                sensitivity: "base",
            }) === 0) &&
        (!rule.responsibleName ||
            rule.responsibleName.localeCompare(typeof event.responsible_name === "string"
                ? event.responsible_name
                : "", undefined, { sensitivity: "base" }) === 0));
}
/**
 *
 */
function scheduledFor(rule, event) {
    const base = luxon_1.DateTime.fromISO(rule.position.endsWith("Start") ? event.starts_at : event.ends_at, { setZone: true });
    const sign = rule.position.startsWith("before") ? -1 : 1;
    return base.plus({ [units[rule.unit]]: sign * Math.abs(rule.offset) });
}
/**
 *
 */
function triggerKey(rule, event) {
    return (0, node_crypto_1.createHash)("sha256")
        .update([
        rule.name,
        rule.eventType ?? "",
        rule.customTypeLabel ?? "",
        rule.childName ?? "",
        rule.responsibleName ?? "",
        event.event_type,
        event.id,
        event.starts_at,
        event.ends_at,
        rule.position,
        rule.offset,
        rule.unit,
        ...(rule.title?.trim() || rule.description?.trim()
            ? [
                rule.title?.trim() ?? "",
                rule.titleMatchMode ?? "exact",
                rule.description?.trim() ?? "",
                rule.descriptionMatchMode ?? "exact",
            ]
            : []),
    ].join("|"))
        .digest("hex");
}
/**
 *
 */
function dueTriggers(rules, events, lastCheck, now, fired) {
    const result = [];
    const seen = new Set(fired);
    for (const rule of rules) {
        for (const event of events) {
            if (!ruleMatches(rule, event)) {
                continue;
            }
            const scheduled = scheduledFor(rule, event);
            const key = triggerKey(rule, event);
            const effectiveStart = luxon_1.DateTime.max(lastCheck, now.minus({ seconds: catchUpWindowSeconds(rule) }));
            if (scheduled >= effectiveStart && scheduled <= now && !seen.has(key)) {
                result.push({ rule, event, scheduled, key });
                seen.add(key);
            }
        }
    }
    return result.sort((a, b) => a.scheduled.toMillis() - b.scheduled.toMillis());
}
/**
 *
 */
function futureTriggers(rules, events, now) {
    return rules
        .flatMap((rule) => events
        .filter((event) => ruleMatches(rule, event))
        .map((event) => ({
        ruleId: rule.name,
        eventId: event.id ?? (0, aggregation_1.occurrenceKey)(event),
        scheduledFor: scheduledFor(rule, event).toISO(),
        triggered: scheduledFor(rule, event) <= now,
    })))
        .filter((item) => Date.parse(item.scheduledFor) >= now.minus({ days: 1 }).toMillis())
        .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}
//# sourceMappingURL=triggers.js.map