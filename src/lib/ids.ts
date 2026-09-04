import { createHash } from "node:crypto";
import type { CalendarEvent } from "./types";

/**
 *
 */
export function normalizeId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return normalized || "unknown";
}
/**
 *
 */
export function stableSegment(
  label: string,
  existing: Map<string, string>,
): string {
  const base = normalizeId(label);
  const owner = existing.get(base);
  if (!owner || owner === label) {
    existing.set(base, label);
    return base;
  }
  return `${base}_${createHash("sha1").update(label).digest("hex").slice(0, 8)}`;
}

/** Resolve all segments independent of input order, including real collisions. */
export function stableSegments(labels: Iterable<string>): Map<string, string> {
  const unique = [...new Set(labels)].sort((a, b) => a.localeCompare(b));
  const groups = new Map<string, string[]>();
  for (const label of unique) {
    const base = normalizeId(label);
    groups.set(base, [...(groups.get(base) ?? []), label]);
  }
  const result = new Map<string, string>();
  for (const [base, labelsInGroup] of groups) {
    const group = labelsInGroup.sort((a, b) => {
      const aCanonical = a.toLowerCase() === base ? 0 : 1;
      const bCanonical = b.toLowerCase() === base ? 0 : 1;
      return aCanonical - bCanonical || a.localeCompare(b);
    });
    for (const [index, label] of group.entries()) {
      result.set(
        label,
        index === 0
          ? base
          : `${base}_${createHash("sha1").update(label).digest("hex").slice(0, 8)}`,
      );
    }
  }
  return result;
}
/**
 *
 */
export function eventFolder(
  event: CalendarEvent,
  segments?: {
    eventTypes?: Map<string, string>;
    customTypes?: Map<string, string>;
  },
): string {
  const rawEventType = event.event_type;
  const eventType =
    segments?.eventTypes?.get(rawEventType) ?? normalizeId(rawEventType);
  if (rawEventType.toUpperCase() !== "OTHER") {
    return `events.appointment.${eventType}`;
  }
  const rawCustomType =
    typeof event.custom_type_label === "string"
      ? event.custom_type_label
      : "unknown";
  return `events.appointment.other.${segments?.customTypes?.get(rawCustomType) ?? normalizeId(rawCustomType)}`;
}
/**
 *
 */
export function eventObjectId(
  event: CalendarEvent,
  idSegment = normalizeId(String(event.id)),
): string {
  if (event.id != null) {
    return `event_${idSegment}`;
  }
  return `generated_${createHash("sha1")
    .update(
      [
        event.child_id ?? "",
        event.responsible_user_id ?? "",
        event.starts_at,
        event.ends_at,
        event.source ?? "",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 12)}`;
}
