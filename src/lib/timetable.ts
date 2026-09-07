import { z } from "zod";

const date = z.iso.date();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const lessonSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start: time,
    end: time,
    subject: z.string(),
    room: z.string(),
    teacher: z.string(),
  })
  .passthrough();
const timetableSchema = z
  .object({
    childId: z.number().int(),
    childName: z.string(),
    status: z.enum([
      "lesson",
      "break",
      "before_school",
      "finished",
      "no_school",
      "not_configured",
      "outside_validity",
    ]),
    statusText: z.string(),
    evaluatedAt: z.iso.datetime({ offset: true }),
    statusDate: date,
    date,
    timezone: z.string().min(1),
    currentLesson: lessonSchema.nullable(),
    nextLesson: lessonSchema.nullable(),
    dailySchedule: z.array(lessonSchema),
    weeklySchedule: z.array(lessonSchema),
    configured: z.boolean(),
    basis: z.literal("planned"),
    plan: z
      .object({
        timezone: z.string().min(1),
        valid_from: date.nullable(),
        valid_until: date.nullable(),
        days_off: z.array(date),
        lessons: z.array(lessonSchema),
      })
      .passthrough(),
  })
  .passthrough();

export type Timetable = z.infer<typeof timetableSchema>;
export type Lesson = z.infer<typeof lessonSchema>;

export function parseTimetable(value: unknown): Timetable {
  const result = timetableSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Ungültige Stundenplan-Antwort vom Server.");
  }
  return result.data;
}
