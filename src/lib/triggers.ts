import { DateTime } from "luxon";
import { createHash } from "node:crypto";
import { completeEvent, occurrenceKey } from "./aggregation";
import type { CalendarEvent, TriggerRule } from "./types";

const units = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
  days: "days",
} as const;
const secondsPerUnit = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** Keep old rules in seconds; an explicitly empty value means no automatic reset. */
export function triggerLengthSeconds(rule: TriggerRule): number | null {
  const value = rule.catchUpSeconds;
  if (value === null || (typeof value === "string" && !value.trim())) {
    return null;
  }
  const length = Number(value ?? 60);
  return Number.isFinite(length) && length > 0
    ? length * (secondsPerUnit[rule.lengthUnit ?? "seconds"] ?? 1)
    : 60;
}

export function catchUpWindowSeconds(rule: TriggerRule): number {
  // Old rules used one field for both pulse length and catch-up time.
  const legacy =
    rule.lengthUnit === undefined ? Number(rule.catchUpSeconds ?? 60) : 60;
  const value = rule.catchUpWindowSeconds ?? legacy;
  return Number.isFinite(value) && value >= 1 ? value : 60;
}

export function textMatches(
  filter: string | undefined,
  value: string | null | undefined,
  mode: "exact" | "contains" = "exact",
): boolean {
  const expected = (filter ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  const actual = (value ?? "").normalize("NFKC").trim().toLocaleLowerCase();
  return (
    !expected ||
    (mode === "contains" ? actual.includes(expected) : actual === expected)
  );
}

export function triggerIsActive(
  rule: TriggerRule,
  lastTriggered: DateTime,
  now: DateTime,
  wasActive: boolean,
  reset = false,
): boolean {
  const length = triggerLengthSeconds(rule);
  return (
    rule.enabled &&
    wasActive &&
    !reset &&
    lastTriggered.isValid &&
    (length === null ||
      now.toMillis() < lastTriggered.toMillis() + length * 1000)
  );
}

/**
 *
 */
export function ruleMatches(rule: TriggerRule, event: CalendarEvent): boolean {
  const configuredType = rule.eventType?.toUpperCase() || "";
  return (
    rule.enabled &&
    textMatches(rule.title, event.title, rule.titleMatchMode) &&
    textMatches(
      rule.description,
      completeEvent(event).description,
      rule.descriptionMatchMode,
    ) &&
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
      rule.responsibleName.localeCompare(
        typeof event.responsible_name === "string"
          ? event.responsible_name
          : "",
        undefined,
        { sensitivity: "base" },
      ) === 0)
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
    { setZone: true },
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
        now.minus({ seconds: catchUpWindowSeconds(rule) }),
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
