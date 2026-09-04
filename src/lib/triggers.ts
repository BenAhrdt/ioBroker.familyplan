import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import { occurrenceKey } from "./aggregation";
import type { CalendarEvent, TriggerRule } from "./types";

const units = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
  days: "days",
} as const;
/**
 *
 */
export function ruleMatches(rule: TriggerRule, event: CalendarEvent): boolean {
  const configuredType = rule.eventType?.toUpperCase() || "";
  return (
    rule.enabled &&
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
      }) === 0)
  );
}
/**
 *
 */
export function scheduledFor(
  rule: TriggerRule,
  event: CalendarEvent,
): DateTime {
  const base = DateTime.fromISO(
    rule.position.endsWith("Start") ? event.starts_at : event.ends_at,
  );
  const sign = rule.position.startsWith("before") ? -1 : 1;
  return base.plus({ [units[rule.unit]]: sign * Math.abs(rule.offset) });
}
/**
 *
 */
export function triggerKey(rule: TriggerRule, event: CalendarEvent): string {
  return createHash("sha256")
    .update(
      [
        rule.name,
        rule.eventType ?? "",
        rule.customTypeLabel ?? "",
        rule.childName ?? "",
        event.event_type,
        event.id,
        event.starts_at,
        event.ends_at,
        rule.position,
        rule.offset,
        rule.unit,
      ].join("|"),
    )
    .digest("hex");
}
/**
 *
 */
export function dueTriggers(
  rules: TriggerRule[],
  events: CalendarEvent[],
  lastCheck: DateTime,
  now: DateTime,
  fired: Set<string>,
): Array<{
  /**
   *
   */
  rule: TriggerRule;
  /**
   *
   */
  event: CalendarEvent;
  /**
   *
   */
  scheduled: DateTime;
  /**
   *
   */
  key: string;
}> {
  const result: Array<{
    /**
     *
     */
    rule: TriggerRule;
    /**
     *
     */
    event: CalendarEvent;
    /**
     *
     */
    scheduled: DateTime;
    /**
     *
     */
    key: string;
  }> = [];
  const seen = new Set(fired);
  for (const rule of rules) {
    for (const event of events) {
      if (!ruleMatches(rule, event)) {
        continue;
      }
      const scheduled = scheduledFor(rule, event);
      const key = triggerKey(rule, event);
      const effectiveStart = DateTime.max(
        lastCheck,
        now.minus({ seconds: rule.catchUpSeconds ?? 60 }),
      );
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
export function futureTriggers(
  rules: TriggerRule[],
  events: CalendarEvent[],
  now: DateTime,
): Array<{
  /**
   *
   */
  ruleId: string;
  /**
   *
   */
  eventId: string | number;
  /**
   *
   */
  scheduledFor: string;
  /**
   *
   */
  triggered: boolean;
}> {
  return rules
    .flatMap((rule) =>
      events
        .filter((event) => ruleMatches(rule, event))
        .map((event) => ({
          ruleId: rule.name,
          eventId: event.id ?? occurrenceKey(event),
          scheduledFor: scheduledFor(rule, event).toISO()!,
          triggered: scheduledFor(rule, event) <= now,
        })),
    )
    .filter(
      (item) =>
        Date.parse(item.scheduledFor) >= now.minus({ days: 1 }).toMillis(),
    )
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}
