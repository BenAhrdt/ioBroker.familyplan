"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseLocation = exports.parseChildren = exports.parseStatus = void 0;
exports.parseEvents = parseEvents;
const zod_1 = require("zod");
const isoDate = zod_1.z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "invalid ISO date");
const statusSchema = zod_1.z.object({
    api_version: zod_1.z.string(),
    status: zod_1.z.string(),
    server_time: isoDate,
    scopes: zod_1.z.array(zod_1.z.string()),
});
const childSchema = zod_1.z
    .object({
    id: zod_1.z.number().int(),
    name: zod_1.z.string(),
    default_responsible_user_id: zod_1.z.number().int().nullable().default(null),
    age: zod_1.z.number().int().nonnegative().nullable().optional(),
    birth_date: zod_1.z.string().nullable().optional(),
})
    .passthrough();
const locationSchema = zod_1.z.object({
    child_id: zod_1.z.number().int(),
    at: isoDate,
    responsible_user_id: zod_1.z.number().int().nullable(),
    responsible_name: zod_1.z.string().nullable(),
    source: zod_1.z.string(),
    current_until: isoDate.nullable(),
    next_change_at: isoDate.nullable(),
});
const eventSchema = zod_1.z
    .object({
    event_type: zod_1.z.string().min(1),
    id: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).nullable(),
    title: zod_1.z.string().nullable(),
    first_name: zod_1.z.string().nullable().optional(),
    last_name: zod_1.z.string().nullable().optional(),
    display_name: zod_1.z.string().nullable().optional(),
    full_name: zod_1.z.string().nullable().optional(),
    description: zod_1.z.string().nullable().optional(),
    note: zod_1.z.string().nullable().optional(),
    starts_at: isoDate,
    ends_at: isoDate,
    child_id: zod_1.z.number().int().nullable().optional(),
    user_id: zod_1.z.number().int().nullable().optional(),
    custom_type_label: zod_1.z.string().nullable().optional(),
    all_day: zod_1.z.boolean().optional(),
    responsible_user_id: zod_1.z.number().int().nullable().optional(),
    age: zod_1.z.number().int().nonnegative().nullable().optional(),
    birth_date: zod_1.z.string().nullable().optional(),
    source: zod_1.z.string().optional(),
    generated: zod_1.z.boolean().optional(),
})
    .passthrough()
    .refine((e) => Date.parse(e.ends_at) > Date.parse(e.starts_at), "ends_at must be after starts_at");
const parseStatus = (value) => statusSchema.parse(value);
exports.parseStatus = parseStatus;
const parseChildren = (value) => zod_1.z.array(childSchema).parse(value);
exports.parseChildren = parseChildren;
const parseLocation = (value) => locationSchema.parse(value);
exports.parseLocation = parseLocation;
function parseEvents(value, onInvalid) {
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
//# sourceMappingURL=validation.js.map