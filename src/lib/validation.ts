import { z } from "zod";
import type {
  CalendarEvent,
  Child,
  LocationState,
  StatusResponse,
} from "./types";

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalid ISO date");
const statusSchema = z.object({
  api_version: z.string(),
  status: z.string(),
  server_time: isoDate,
  scopes: z.array(z.string()),
});
const childSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    default_responsible_user_id: z.number().int().nullable().default(null),
    age: z.number().int().nonnegative().nullable().optional(),
    birth_date: z.string().nullable().optional(),
  })
  .passthrough();
const locationSchema = z.object({
  child_id: z.number().int(),
  at: isoDate,
  responsible_user_id: z.number().int().nullable(),
  responsible_name: z.string().nullable(),
  source: z.string(),
  current_until: isoDate.nullable(),
  next_change_at: isoDate.nullable(),
});
const eventSchema = z
  .object({
    event_type: z.string().min(1),
    id: z.union([z.string(), z.number()]).nullable(),
    title: z.string().nullable(),
    description: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    starts_at: isoDate,
    ends_at: isoDate,
    child_id: z.number().int().nullable().optional(),
    user_id: z.number().int().nullable().optional(),
    custom_type_label: z.string().nullable().optional(),
    all_day: z.boolean().optional(),
    responsible_user_id: z.number().int().nullable().optional(),
    age: z.number().int().nonnegative().nullable().optional(),
    birth_date: z.string().nullable().optional(),
    source: z.string().optional(),
    generated: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    (e) => Date.parse(e.ends_at) > Date.parse(e.starts_at),
    "ends_at must be after starts_at",
  );

export const parseStatus = (value: unknown): StatusResponse =>
  statusSchema.parse(value);
export const parseChildren = (value: unknown): Child[] =>
  z.array(childSchema).parse(value);
export const parseLocation = (value: unknown): LocationState =>
  locationSchema.parse(value);
export function parseEvents(
  value: unknown,
  onInvalid?: (index: number, reason: string) => void,
): CalendarEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("Calendar response is not an array");
  }
  return value.flatMap((item, index) => {
    const result = eventSchema.safeParse(item);
    if (!result.success) {
      onInvalid?.(index, result.error.issues.map((i) => i.message).join(", "));
      return [];
    }
    return [result.data];
  });
}
