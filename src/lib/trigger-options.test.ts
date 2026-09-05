import { expect } from "chai";
import { DateTime } from "luxon";
import {
  catchUpWindowSeconds,
  dueTriggers,
  ruleMatches,
  triggerKey,
  triggerLengthSeconds,
} from "./triggers";
import type { CalendarEvent, TriggerRule } from "./types";

const event: CalendarEvent = {
  event_type: "STAY",
  id: 42,
  title: "Rika bei Ben",
  description: "Bitte Sportsachen mitbringen",
  starts_at: "2026-09-05T08:00:00+02:00",
  ends_at: "2026-09-05T18:00:00+02:00",
};
const base: TriggerRule = {
  name: "Ankunft",
  enabled: true,
  position: "afterStart",
  offset: 0,
  unit: "seconds",
};
describe("Trigger filters and lengths", () => {
  it("matches exact or contained titles and notes together, case-insensitively", () => {
    expect(
      ruleMatches(
        {
          ...base,
          title: " RIKA BEI BEN ",
          description: "sportsachen",
          descriptionMatchMode: "contains",
        },
        event,
      ),
    ).eq(true);
    expect(
      ruleMatches({ ...base, title: "Rika", titleMatchMode: "exact" }, event),
    ).eq(false);
    expect(
      ruleMatches(
        { ...base, title: "Rika", titleMatchMode: "contains" },
        event,
      ),
    ).eq(true);
    expect(
      ruleMatches(
        {
          ...base,
          title: "Rika",
          titleMatchMode: "contains",
          description: "Trinkflasche",
          descriptionMatchMode: "contains",
        },
        event,
      ),
    ).eq(false);
    expect(
      ruleMatches(
        { ...base, description: "Bitte Sportsachen mitbringen" },
        event,
      ),
    ).eq(true);
  });
  it("treats empty filters as wildcards and respects an explicitly cleared description", () => {
    const empty = { ...event, title: null, description: null, note: "Alt" };
    expect(ruleMatches({ ...base, title: " ", description: "" }, empty)).eq(
      true,
    );
    expect(ruleMatches({ ...base, description: "Alt" }, empty)).eq(false);
    expect(
      ruleMatches(
        { ...base, description: "Alt" },
        { ...empty, description: undefined },
      ),
    ).eq(true);
  });
  it("supports four length units and blank values without changing old seconds", () => {
    for (const [lengthUnit, seconds] of [
      ["seconds", 2],
      ["minutes", 120],
      ["hours", 7200],
      ["days", 172800],
    ] as const) {
      expect(
        triggerLengthSeconds({ ...base, catchUpSeconds: "2", lengthUnit }),
      ).eq(seconds);
    }
    for (const catchUpSeconds of ["", " ", null]) {
      expect(triggerLengthSeconds({ ...base, catchUpSeconds })).eq(null);
    }
    expect(triggerLengthSeconds({ ...base, catchUpSeconds: 20 })).eq(20);
    expect(triggerLengthSeconds(base)).eq(60);
  });
  it("keeps catch-up bounded for unlimited and long triggers, with legacy compatibility", () => {
    const now = DateTime.fromISO(event.starts_at).plus({ minutes: 5 });
    const last = now.minus({ hours: 1 });
    for (const catchUpSeconds of ["", 10]) {
      const rule = {
        ...base,
        catchUpSeconds,
        lengthUnit: "days" as const,
        catchUpWindowSeconds: 60,
      };
      expect(dueTriggers([rule], [event], last, now, new Set())).length(0);
      expect(
        dueTriggers(
          [rule],
          [event],
          last,
          now.minus({ minutes: 4, seconds: 30 }),
          new Set(),
        ),
      ).length(1);
    }
    expect(catchUpWindowSeconds({ ...base, catchUpSeconds: 900 })).eq(900);
    expect(catchUpWindowSeconds({ ...base, catchUpSeconds: null })).eq(60);
  });
  it("does not re-fire unchanged rules just because match modes or lengths acquire defaults", () => {
    expect(
      triggerKey(
        {
          ...base,
          title: "",
          description: "",
          titleMatchMode: "exact",
          descriptionMatchMode: "exact",
          lengthUnit: "seconds",
          catchUpWindowSeconds: 60,
        },
        event,
      ),
    ).eq(triggerKey(base, event));
    expect(
      triggerKey({ ...base, title: "Rika", titleMatchMode: "contains" }, event),
    ).not.eq(triggerKey(base, event));
  });
});
