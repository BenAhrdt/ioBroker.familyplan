import { expect } from "chai";
import { DateTime } from "luxon";
import type {} from "./adapter-config";
import type * as AdapterModule from "../main";
import type { CalendarEvent, Child } from "./types";
import { nextLocationChange, uniqueOccurrences } from "./aggregation";
import { parseEvents, parseChildren } from "./validation";

// Stub only the ioBroker base class; exercise the adapter's real projections.
const corePath = require.resolve("@iobroker/adapter-core");
const originalCore = require.cache[corePath];
require.cache[corePath] = { exports: { Adapter: class {} } } as NodeModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FamilienPlan } = require("../main") as typeof AdapterModule;
if (originalCore) {
  require.cache[corePath] = originalCore;
} else {
  delete require.cache[corePath];
}

type Value = string | number | boolean | null;
interface ProjectionAdapter {
  events: CalendarEvent[];
  childrenData: Child[];
  childBirthdayEvents: CalendarEvent[];
  writeEvents(events: CalendarEvent[], now: DateTime): Promise<void>;
  writeChildrenFromEvents(children: Child[], now: DateTime): Promise<void>;
}
const now = DateTime.fromISO("2026-09-05T00:00:00+02:00");
const stay: CalendarEvent = {
  event_type: "STAY",
  id: 42,
  child_id: 1,
  responsible_user_id: 3,
  starts_at: "2026-09-05T08:00:00+02:00",
  ends_at: "2026-09-05T18:00:00+02:00",
  title: "Papa-Wochenende",
  description: "Bitte Sportsachen mitgeben",
  source: "stay",
  generated: false,
};
function harness(): { adapter: ProjectionAdapter; states: Map<string, Value> } {
  const states = new Map<string, Value>();
  const objects = new Map<string, { type: string }>();
  const adapter = Object.assign(Object.create(FamilienPlan.prototype), {
    config: {
      timezone: "Europe/Berlin",
      dateFormat: "dd.MM.yyyy",
      fetchLocations: false,
    },
    childrenData: parseChildren([
      { id: 1, name: "Emma", default_responsible_user_id: null },
    ]),
    childBirthdayEvents: [],
    events: [],
    writtenStates: new Map(),
    responsibleNames: new Map(),
    stayResponsibleNames: new Map(),
    extendObjectAsync: async (id: string, object: { type: string }) => {
      objects.set(id, object);
    },
    getObjectAsync: async (id: string) => objects.get(id),
    setStateAsync: async (id: string, value: Value) => {
      states.set(id, value);
    },
    folderIds: async (root: string) =>
      [...objects]
        .filter(
          ([id, object]) =>
            object.type === "folder" && id.startsWith(`${root}.`),
        )
        .map(([id]) => id),
    delObjectAsync: async (root: string) => {
      for (const id of [...objects.keys()]) {
        if (id === root || id.startsWith(`${root}.`)) {
          objects.delete(id);
          states.delete(id);
        }
      }
    },
  }) as ProjectionAdapter;
  return { adapter, states };
}

describe("FamilienPlan 0.1.95 API contract", () => {
  it("writes API stay titles and descriptions and clears removed notes on refresh", async () => {
    const { adapter, states } = harness();
    for (const title of ["Papa-Wochenende", "Emma bei Papa"]) {
      await adapter.writeEvents(parseEvents([{ ...stay, title }]), now);
      expect(states.get("appointments.next.title")).eq(title);
      expect(states.get("appointments.next.description")).eq(stay.description);
      expect(states.get("appointments.next.note")).eq(stay.description);
      expect(states.get("appointments.count")).eq(1);
    }
    for (const description of [null, "", undefined]) {
      await adapter.writeEvents(parseEvents([{ ...stay, description }]), now);
      expect(states.get("appointments.next.note")).eq("");
      expect(states.get("appointments.next.description")).eq("");
    }
    await adapter.writeEvents(
      parseEvents([
        { ...stay, description: null, note: "Obsolete legacy note" },
      ]),
      now,
    );
    expect(states.get("appointments.next.note")).eq("");
  });
  it("keeps separate generated intervals and removes disappeared stays on refresh", async () => {
    const { adapter, states } = harness();
    const first = {
      ...stay,
      id: null,
      source: "default",
      generated: true,
      responsible_user_id: 2,
      title: "(Standard) Emma bei Mama",
      description: null,
      starts_at: "2026-09-05T00:00:00+02:00",
      ends_at: stay.starts_at,
    };
    const last = {
      ...first,
      starts_at: stay.ends_at,
      ends_at: "2026-09-06T00:00:00+02:00",
    };
    const events = uniqueOccurrences(parseEvents([first, stay, last]));
    expect(events).length(3);
    await adapter.writeEvents(events, now);
    expect(JSON.parse(String(states.get("appointments.json")))).length(3);
    expect(states.get("appointments.next.title")).eq(first.title);
    await adapter.writeEvents([stay], now);
    expect(JSON.parse(String(states.get("appointments.json")))).deep.eq([
      {
        ...stay,
        starts_at: "2026-09-05T08:00:00.000+02:00",
        ends_at: "2026-09-05T18:00:00.000+02:00",
        child_name: "Emma",
      },
    ]);
    await adapter.writeEvents([], now);
    expect(states.get("appointments.json")).eq("[]");
    expect(states.get("appointments.next.json")).eq("{}");
    expect(states.has("events.appointment.stay.json")).eq(false);
    await adapter.writeEvents([stay], now);
    expect(states.get("events.appointment.stay.next.note")).eq(
      stay.description,
    );
  });
  it("accepts general events and birthdays without stay-specific or optional fields", async () => {
    const { adapter, states } = harness();
    const general = {
      event_type: "GENERAL",
      id: 7,
      child_id: null,
      title: "Fußballtraining",
      starts_at: stay.starts_at,
      ends_at: stay.ends_at,
    };
    const birthday = {
      event_type: "BIRTHDAY",
      id: 7,
      title: "Oma",
      starts_at: stay.starts_at,
      ends_at: stay.ends_at,
      age: 65,
    };
    for (const description of ["Trinkflasche mitnehmen", undefined]) {
      const events = uniqueOccurrences(
        parseEvents([{ ...general, description }, birthday]),
      );
      expect(events).length(2);
      await adapter.writeEvents(events, now);
      expect(states.get("events.appointment.general.next.note")).eq(
        description ?? "",
      );
      const output = JSON.parse(
        String(states.get("events.appointment.birthday.next.json")),
      );
      expect(output).include({ title: "Oma", age: 65, description: null });
      expect(output).not.have.property("child_id");
    }
  });
  it("does not fabricate child age or birth date from unrelated birthday IDs or titles", async () => {
    const { adapter, states } = harness();
    adapter.childBirthdayEvents = [
      {
        ...stay,
        event_type: "BIRTHDAY",
        child_id: undefined,
        id: 1,
        title: "Emma",
        age: 12,
      },
    ];
    await adapter.writeChildrenFromEvents(adapter.childrenData, now);
    expect(states.get("children.emma.age")).eq(null);
    expect(states.get("children.emma.birthDate")).eq("");
    expect(JSON.parse(String(states.get("children.emma.json")))).include({
      id: 1,
      default_responsible_user_id: null,
      age: null,
    });
  });
  it("includes the current stay's end when the next explicit stay is absent or later", () => {
    for (const next_change_at of [null, "2026-09-07T10:00:00Z"]) {
      expect(
        nextLocationChange(
          { current_until: stay.ends_at, next_change_at },
          now,
        ),
      ).eq(stay.ends_at);
    }
    expect(
      nextLocationChange({ current_until: null, next_change_at: null }, now),
    ).eq("");
  });
});
