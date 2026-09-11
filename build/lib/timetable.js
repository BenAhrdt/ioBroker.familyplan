"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTimetable = parseTimetable;
const zod_1 = require("zod");
const date = zod_1.z.iso.date();
const time = zod_1.z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const lessonSchema = zod_1.z
    .object({
    weekday: zod_1.z.number().int().min(0).max(6),
    start: time,
    end: time,
    subject: zod_1.z.string(),
    room: zod_1.z.string(),
    teacher: zod_1.z.string(),
})
    .passthrough();
const timetableSchema = zod_1.z
    .object({
    childId: zod_1.z.number().int(),
    childName: zod_1.z.string(),
    status: zod_1.z.enum([
        "lesson",
        "break",
        "before_school",
        "finished",
        "no_school",
        "not_configured",
        "outside_validity",
    ]),
    statusText: zod_1.z.string(),
    evaluatedAt: zod_1.z.iso.datetime({ offset: true }),
    statusDate: date,
    date,
    timezone: zod_1.z.string().min(1),
    currentLesson: lessonSchema.nullable(),
    nextLesson: lessonSchema.nullable(),
    dailySchedule: zod_1.z.array(lessonSchema),
    weeklySchedule: zod_1.z.array(lessonSchema),
    configured: zod_1.z.boolean(),
    basis: zod_1.z.literal("planned"),
    plan: zod_1.z
        .object({
        timezone: zod_1.z.string().min(1),
        valid_from: date.nullable(),
        valid_until: date.nullable(),
        days_off: zod_1.z.array(date),
        lessons: zod_1.z.array(lessonSchema),
    })
        .passthrough(),
})
    .passthrough();
function parseTimetable(value) {
    const result = timetableSchema.safeParse(value);
    if (!result.success) {
        throw new Error("Ungültige Stundenplan-Antwort vom Server.");
    }
    return result.data;
}
//# sourceMappingURL=timetable.js.map