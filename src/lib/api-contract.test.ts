import { expect } from "chai";
import { DateTime } from "luxon";
import type {} from "./adapter-config";
import type * as AdapterModule from "../main";
import type {
  AdapterConfigShape,
  CalendarEvent,
  Child,
  TriggerRule,
} from "./types";
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
  config: Partial<AdapterConfigShape> & { triggerRules: TriggerRule[] };
  updateWasteReminder(
    events: CalendarEvent[],
    now: DateTime,
    reset?: boolean,
  ): Promise<void>;
  triggerResets: Set<string>;
  processTriggers(events: CalendarEvent[], now: DateTime): Promise<void>;
  onStateChange(id: string, state: Partial<ioBroker.State>): Promise<void>;
  events: CalendarEvent[];
  childrenData: Child[];
  childBirthdayEvents: CalendarEvent[];
  writeEvents(events: CalendarEvent[], now: DateTime): Promise<void>;
  writeChildrenFromEvents(children: Child[], now: DateTime): Promise<void>;
  writeBirthdays(events: CalendarEvent[], now: DateTime): Promise<void>;
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
function harness(states = new Map<string, Value>()): {
  adapter: ProjectionAdapter;
  states: Map<string, Value>;
} {
  const objects = new Map<string, { type: string }>();
  const adapter = Object.assign(Object.create(FamilienPlan.prototype), {
    config: {
      timezone: "Europe/Berlin",
      dateFormat: "dd.MM.yyyy",
      birthdayDateFormat: "dd.MM.yyyy",
      birthdayTodayTemplate: "Heute wird {name} {age}.",
      birthdayTomorrowTemplate: "Morgen wird {name} {age}.",
      birthdayFutureTemplate: "In {days} Tagen wird {name} {age}.",
      birthdaySeparator: " ",
      birthdayEmptyText: "",
      fetchLocations: false,
      triggerRules: [],
      triggerHistoryDays: 90,
    },
    childrenData: parseChildren([
      { id: 1, name: "Emma", default_responsible_user_id: null },
    ]),
    childBirthdayEvents: [],
    events: [],
    namespace: "familyplan.0",
    triggerResets: new Set(),
    wasteReminderQueue: Promise.resolve(),
    triggerCounts: new Map(),
    triggerLastTriggered: new Map(),
    log: {
      warn: (message: string) => {
        throw new Error(message);
      },
    },
    getStateAsync: async (id: string) =>
      states.has(id) ? { val: states.get(id) } : null,
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
      default_responsible_username: "",
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

describe("Trigger lifecycle", () => {
  const firedAt = DateTime.fromISO(stay.starts_at);
  const rule: TriggerRule = {
    name: "Ankunft",
    enabled: true,
    position: "afterStart",
    offset: 0,
    unit: "seconds",
    catchUpSeconds: "",
    lengthUnit: "seconds",
    catchUpWindowSeconds: 60,
  };
  it("keeps an unlimited trigger active after restart and updates later firings", async () => {
    const first = harness();
    first.adapter.config.triggerRules = [rule];
    await first.adapter.processTriggers([stay], firedAt);
    expect(first.states.get("triggers.ankunft.active")).eq(true);
    expect(first.states.get("triggers.ankunft.count")).eq(1);
    const restarted = harness(first.states);
    restarted.adapter.config.triggerRules = [rule];
    await restarted.adapter.processTriggers([stay], firedAt.plus({ days: 2 }));
    expect(first.states.get("triggers.ankunft.active")).eq(true);
    expect(first.states.get("triggers.ankunft.count")).eq(1);
    const later = {
      ...stay,
      id: 43,
      starts_at: firedAt.plus({ days: 3 }).toISO()!,
      ends_at: firedAt.plus({ days: 3, hours: 1 }).toISO()!,
    };
    await restarted.adapter.processTriggers([later], firedAt.plus({ days: 3 }));
    expect(first.states.get("triggers.ankunft.count")).eq(2);
    expect(
      JSON.parse(String(first.states.get("triggers.ankunft.event"))).event.id,
    ).eq(43);
  });
  it("resets manually, publishes the reset and remains inactive across restart", async () => {
    const { adapter, states } = harness();
    adapter.config.triggerRules = [rule];
    await adapter.processTriggers([stay], firedAt);
    await adapter.onStateChange("familyplan.0.triggers.ankunft.reset", {
      val: true,
      ack: false,
    });
    expect(states.get("triggers.ankunft.active")).eq(false);
    expect(states.get("triggers.ankunft.reset")).eq(false);
    expect(JSON.parse(String(states.get("triggers.ankunft.event"))).active).eq(
      false,
    );
    expect(JSON.parse(String(states.get("triggers.event"))).active).eq(false);
    const restarted = harness(states);
    restarted.adapter.config.triggerRules = [rule];
    await restarted.adapter.processTriggers([], firedAt.plus({ days: 2 }));
    expect(states.get("triggers.ankunft.active")).eq(false);
  });
  it("expires a finite trigger independently of catch-up and does not reactivate after a manual reset", async () => {
    const { adapter, states } = harness();
    adapter.config.triggerRules = [
      {
        ...rule,
        catchUpSeconds: 2,
        lengthUnit: "minutes",
        catchUpWindowSeconds: 10,
      },
    ];
    await adapter.processTriggers([stay], firedAt);
    await adapter.processTriggers([stay], firedAt.plus({ seconds: 119 }));
    expect(states.get("triggers.ankunft.active")).eq(true);
    await adapter.processTriggers([stay], firedAt.plus({ seconds: 120 }));
    expect(states.get("triggers.ankunft.active")).eq(false);
    expect(JSON.parse(String(states.get("triggers.ankunft.event"))).active).eq(
      false,
    );
    const later = {
      ...stay,
      id: 43,
      starts_at: firedAt.plus({ hours: 1 }).toISO()!,
      ends_at: firedAt.plus({ hours: 2 }).toISO()!,
    };
    await adapter.processTriggers([later], firedAt.plus({ hours: 1 }));
    adapter.triggerResets.add("triggers.ankunft");
    await adapter.processTriggers(
      [later],
      firedAt.plus({ hours: 1, seconds: 10 }),
    );
    await adapter.processTriggers(
      [later],
      firedAt.plus({ hours: 1, seconds: 11 }),
    );
    expect(states.get("triggers.ankunft.active")).eq(false);
  });
  it("removes deleted rules and recreates their states without retaining a latched value", async () => {
    const { adapter, states } = harness();
    adapter.config.triggerRules = [rule];
    await adapter.processTriggers([stay], firedAt);
    adapter.config.triggerRules = [];
    await adapter.processTriggers([], firedAt.plus({ seconds: 1 }));
    expect(states.has("triggers.ankunft.active")).eq(false);
    adapter.config.triggerRules = [rule];
    await adapter.processTriggers([], firedAt.plus({ seconds: 2 }));
    expect(states.get("triggers.ankunft.active")).eq(false);
    expect(states.get("triggers.ankunft.count")).eq(0);
  });
  it("clears a latched trigger when its rule is disabled", async () => {
    const { adapter, states } = harness();
    adapter.config.triggerRules = [rule];
    await adapter.processTriggers([stay], firedAt);
    adapter.config.triggerRules = [{ ...rule, enabled: false }];
    await adapter.processTriggers([stay], firedAt.plus({ seconds: 1 }));
    expect(states.get("triggers.ankunft.active")).eq(false);
  });
});

describe("Persistent waste reminder projection", () => {
  const events: CalendarEvent[] = [
    {
      event_type: "WASTE",
      id: 1,
      title: "Altpapier",
      starts_at: "2026-09-06T00:00:00+02:00",
      ends_at: "2026-09-07T00:00:00+02:00",
    },
  ];
  const due = DateTime.fromISO("2026-09-05T15:00:00+02:00");
  it("persists a reset across restart and expires without another collection", async () => {
    const { adapter, states } = harness();
    adapter.config.wasteEnabled = true;
    await adapter.updateWasteReminder(events, due);
    expect(states.get("waste.reminder.active")).eq(true);
    await adapter.updateWasteReminder(events, due, true);
    expect(states.get("waste.reminder.active")).eq(false);
    expect(states.get("waste.reminder.reset")).eq(false);
    expect(states.get("waste.reminder.acknowledged")).eq(true);
    expect(states.get("waste.reminder.text")).eq(
      "Morgen wird Altpapier abgeholt.",
    );
    const restarted = harness(states).adapter;
    restarted.config.wasteEnabled = true;
    await restarted.updateWasteReminder(events, due.plus({ minutes: 1 }));
    expect(states.get("waste.reminder.active")).eq(false);
    expect(states.get("waste.reminder.acknowledged")).eq(true);
    await restarted.updateWasteReminder(events, due.plus({ days: 2 }));
    expect(states.get("waste.reminder.active")).eq(false);
    expect(states.get("waste.reminder.json")).eq("[]");
  });
  it("ignores premature resets and clears an unacknowledged expired reminder", async () => {
    const { adapter, states } = harness();
    adapter.config.wasteEnabled = true;
    await adapter.updateWasteReminder(events, due.minus({ minutes: 1 }), true);
    await adapter.updateWasteReminder(events, due);
    expect(states.get("waste.reminder.active")).eq(true);
    await adapter.updateWasteReminder(
      events,
      DateTime.fromISO("2026-09-07T00:00:00+02:00"),
    );
    expect(states.get("waste.reminder.active")).eq(false);
    expect(states.get("waste.reminder.text")).eq("");
  });
  it("serializes reset and refresh and recreates states after disabling", async () => {
    const { adapter, states } = harness();
    adapter.config.wasteEnabled = true;
    await adapter.updateWasteReminder(events, due);
    await Promise.all([
      adapter.updateWasteReminder(events, due, true),
      adapter.updateWasteReminder(events, due),
    ]);
    expect(states.get("waste.reminder.active")).eq(false);
    adapter.config.wasteReminderEnabled = false;
    await adapter.updateWasteReminder(events, due);
    expect(states.has("waste.reminder.active")).eq(false);
    adapter.config.wasteReminderEnabled = true;
    await adapter.updateWasteReminder(events, due);
    expect(states.get("waste.reminder.active")).eq(true);
  });
});

describe("Child and birthday display details", () => {
  it("formats an explicit birth date and refreshes current age on the birthday", async () => {
    const { adapter, states } = harness();
    const child = {
      id: 1,
      name: "Rika",
      default_responsible_user_id: 2,
      birth_date: "2014-09-06",
    };
    adapter.events = [
      { ...stay, responsible_user_id: 2, responsible_name: "Ben" },
    ];
    await adapter.writeChildrenFromEvents([child], now);
    expect(states.get("children.rika.birthDate")).eq("06.09.2014");
    expect(states.get("children.rika.age")).eq(11);
    const json = JSON.parse(String(states.get("children.rika.json")));
    expect(json.default_responsible_username).eq("Ben");
    expect(json).not.have.property("default_responsible_user_id");
    await adapter.writeChildrenFromEvents([child], now.plus({ days: 1 }));
    expect(states.get("children.rika.age")).eq(12);
  });
  it("only uses an explicit birth date from linked cached birthdays", async () => {
    const { adapter, states } = harness();
    adapter.events = [
      { ...stay, event_type: "BIRTHDAY", age: 12, child_id: 1 },
    ];
    await adapter.writeChildrenFromEvents(adapter.childrenData, now);
    expect(states.get("children.emma.birthDate")).eq("");
    expect(states.get("children.emma.age")).eq(null);
    adapter.events[0].birth_date = "2014-09-05";
    await adapter.writeChildrenFromEvents(adapter.childrenData, now);
    expect(states.get("children.emma.birthDate")).eq("05.09.2014");
    expect(states.get("children.emma.age")).eq(12);
  });
  it("publishes sorted annual summaries and clears the nearest-day fields", async () => {
    const { adapter, states } = harness();
    adapter.config.birthdaysEnabled = true;
    const events = [
      {
        ...stay,
        child_id: undefined,
        event_type: "BIRTHDAY",
        id: 1,
        title: "Rebecca",
        age: 39,
      },
      {
        ...stay,
        child_id: undefined,
        event_type: "BIRTHDAY",
        id: 2,
        title: "XY",
        age: 40,
      },
      {
        ...stay,
        child_id: undefined,
        event_type: "BIRTHDAY",
        id: 3,
        title: "Gestern",
        age: 31,
        starts_at: "2027-09-04T00:00:00+02:00",
        ends_at: "2027-09-05T00:00:00+02:00",
      },
    ];
    await adapter.writeBirthdays(events, now);
    const json = JSON.parse(String(states.get("birthdays.summary.json")));
    expect(json.map((item: { daysUntil: number }) => item.daysUntil)).deep.eq([
      0, 0, 364,
    ]);
    expect(json[2].age).eq(31);
    expect(states.get("birthdays.summary.text")).eq(
      "Heute werden Rebecca 39 und XY 40.",
    );
    expect(JSON.parse(String(states.get("birthdays.summary.nextJson")))).length(
      2,
    );
    expect(states.get("birthdays.summary.daysUntil")).eq(0);
    await adapter.writeBirthdays([], now);
    expect(states.get("birthdays.summary.nextJson")).eq("[]");
    expect(states.get("birthdays.summary.daysUntil")).eq(null);
    expect(states.get("birthdays.summary.text")).eq("");
  });
});

describe("FamilienPlan 0.1.99 birthday sources", () => {
  const manual: CalendarEvent = {
    event_type: "BIRTHDAY",
    id: 1,
    source: "birthday",
    title: "Rebecca",
    starts_at: "2026-09-06T00:00:00+02:00",
    ends_at: "2026-09-07T00:00:00+02:00",
    all_day: true,
    age: 39,
  };
  const child: CalendarEvent = {
    ...manual,
    id: "child:1",
    source: "child",
    child_id: 1,
    title: "Rika",
    age: 12,
    starts_at: "2026-09-07T00:00:00+02:00",
    ends_at: "2026-09-08T00:00:00+02:00",
  };
  const person: CalendarEvent = {
    ...manual,
    id: "person:1",
    source: "person",
    user_id: 1,
    title: "Ben",
    age: 40,
    starts_at: "2026-09-08T00:00:00+02:00",
    ends_at: "2026-09-09T00:00:00+02:00",
  };
  it("keeps all sources and successive annual occurrences in calendar and month projections", async () => {
    const { adapter, states } = harness();
    adapter.config.birthdaysEnabled = true;
    adapter.childrenData = parseChildren([
      { id: 1, name: "Rika", birth_date: "2014-09-07" },
    ]);
    const nextYear = {
      ...child,
      age: 13,
      starts_at: "2027-09-07T00:00:00+02:00",
      ends_at: "2027-09-08T00:00:00+02:00",
    };
    const events = uniqueOccurrences(
      parseEvents([manual, child, person, nextYear, child]),
    );
    expect(events).length(4);
    adapter.events = events;
    await adapter.writeEvents(events, now);
    await adapter.writeBirthdays(events, now);
    await adapter.writeChildrenFromEvents(adapter.childrenData, now);
    expect(states.get("events.appointment.birthday.count")).eq(4);
    expect(states.get("birthdays.next.allDay")).eq(true);
    expect(JSON.parse(String(states.get("birthdays.next.json"))).id).eq(1);
    expect(JSON.parse(String(states.get("birthdays.nextAfter.json"))).id).eq(
      "child:1",
    );
    const monthly = JSON.parse(String(states.get("birthdays.month.09.json")));
    expect(monthly).length(4);
    expect(monthly.map((item: CalendarEvent) => item.id)).deep.eq([
      1,
      "child:1",
      "person:1",
      "child:1",
    ]);
    expect(monthly[2]).include({ user_id: 1, source: "person", all_day: true });
    const summary = JSON.parse(String(states.get("birthdays.summary.json")));
    expect(summary).length(3);
    expect(
      summary.map((item: { daysUntil: number }) => item.daysUntil),
    ).deep.eq([1, 2, 3]);
    expect(states.get("children.rika.birthDate")).eq("07.09.2014");
    expect(states.get("children.rika.age")).eq(11);
    expect(adapter.events).length(4);
  });
  it("uses children birth dates without inventing calendar entries or requiring birthday data", async () => {
    const { adapter, states } = harness();
    adapter.config.birthdaysEnabled = true;
    adapter.childrenData = parseChildren([
      { id: 1, name: "Rika", birth_date: "2014-09-07" },
      { id: 2, name: "Null", birth_date: null },
      { id: 3, name: "Legacy" },
    ]);
    await adapter.writeChildrenFromEvents(adapter.childrenData, now);
    await adapter.writeBirthdays(adapter.events, now);
    expect(states.get("children.rika.birthDate")).eq("07.09.2014");
    expect(JSON.parse(String(states.get("children.rika.json"))).birth_date).eq(
      "2014-09-07",
    );
    expect(states.get("children.null.age")).eq(null);
    expect(states.get("children.legacy.birthDate")).eq("");
    expect(states.get("birthdays.summary.count")).eq(0);
    expect(adapter.events).length(0);
    adapter.childrenData = parseChildren([
      { id: 1, name: "Rika", birth_date: null },
    ]);
    await adapter.writeChildrenFromEvents(adapter.childrenData, now);
    expect(states.get("children.rika.birthDate")).eq("");
    expect(states.get("children.rika.age")).eq(null);
  });
  it("keeps the real February 29 birth date while respecting the server's February 28 occurrence", async () => {
    const { adapter, states } = harness();
    adapter.config.birthdaysEnabled = true;
    adapter.childrenData = parseChildren([
      { id: 1, name: "Rika", birth_date: "2012-02-29" },
    ]);
    const event = {
      ...child,
      age: 14,
      starts_at: "2026-02-27T23:00:00Z",
      ends_at: "2026-02-28T23:00:00Z",
    };
    const before = DateTime.fromISO("2026-02-27T22:59:59Z");
    adapter.events = parseEvents([event]);
    await adapter.writeChildrenFromEvents(adapter.childrenData, before);
    expect(states.get("children.rika.age")).eq(13);
    await adapter.writeBirthdays(adapter.events, before);
    expect(states.get("birthdays.next.birthDate")).eq("29.02.2012");
    expect(states.get("birthdays.next.date")).eq("28.02.2026");
    expect(
      JSON.parse(String(states.get("birthdays.month.02.json")))[0].birthDate,
    ).eq("29.02.2012");
    await adapter.writeChildrenFromEvents(
      adapter.childrenData,
      before.plus({ seconds: 1 }),
    );
    expect(states.get("children.rika.age")).eq(14);
    expect(adapter.events[0].starts_at).eq(event.starts_at);
  });
  it("accepts older birthdays without source or optional data and leaves unknown ages null", async () => {
    const { adapter, states } = harness();
    adapter.config.birthdaysEnabled = true;
    const old = {
      event_type: "BIRTHDAY",
      id: 7,
      title: "Oma",
      starts_at: manual.starts_at,
      ends_at: manual.ends_at,
    };
    await adapter.writeBirthdays(parseEvents([old]), now);
    expect(states.get("birthdays.next.age")).eq(null);
    expect(states.get("birthdays.next.birthDate")).eq("");
    expect(states.get("birthdays.next.text")).eq("Morgen hat Oma Geburtstag.");
    const item = JSON.parse(String(states.get("birthdays.month.09.json")))[0];
    expect(item.age).eq(null);
    expect(item.birthDate).eq("");
  });
});

describe("FamilienPlan 0.1.100 birthday name projections", () => {
  it("publishes names and actual birth dates for all sources while preserving calendar titles", async () => {
    for (const source of ["birthday", "child", "person"] as const) {
      const { adapter, states } = harness();
      adapter.config.birthdaysEnabled = true;
      const raw = {
        event_type: "BIRTHDAY",
        source,
        id: source === "birthday" ? 1 : `${source}:1`,
        ...(source === "child"
          ? { child_id: 1 }
          : source === "person"
            ? { user_id: 1 }
            : {}),
        title: "Tom",
        full_name: "Tom Grywnow",
        first_name: "Tom",
        last_name: "Grywnow",
        display_name: "Tom",
        birth_date: "2011-09-11",
        all_day: true,
        age: 15,
        starts_at: "2026-09-11T00:00:00+02:00",
        ends_at: "2026-09-12T00:00:00+02:00",
      };
      const events = parseEvents([raw]);
      adapter.events = events;
      await adapter.writeEvents(events, now);
      await adapter.writeBirthdays(events, now);
      expect(states.get("birthdays.next.name")).eq("Tom Grywnow");
      expect(states.get("birthdays.next.title")).eq("Tom");
      expect(states.get("birthdays.next.birthDate")).eq("11.09.2011");
      for (const key of [
        "first_name",
        "last_name",
        "display_name",
        "full_name",
        "birth_date",
      ] as const) {
        expect(states.get(`birthdays.next.${key}`)).eq(raw[key]);
      }
      for (const root of ["birthdays.summary", "birthdays.month.09"]) {
        const item = JSON.parse(String(states.get(`${root}.json`)))[0];
        expect(item).include({
          name: "Tom Grywnow",
          title: "Tom",
          first_name: "Tom",
          last_name: "Grywnow",
          full_name: "Tom Grywnow",
          display_name: "Tom",
          birth_date: "2011-09-11",
          birthDate: "11.09.2011",
          age: 15,
        });
      }
      const calendar = JSON.parse(
        String(states.get("events.appointment.birthday.next.json")),
      );
      expect(calendar).include({
        title: "Tom",
        full_name: "Tom Grywnow",
        birth_date: "2011-09-11",
        id: raw.id,
      });
      expect(adapter.events).deep.eq(events);
      const legacy = {
        event_type: "BIRTHDAY",
        id: raw.id,
        title: "Legacy",
        starts_at: raw.starts_at,
        ends_at: raw.ends_at,
      };
      await adapter.writeBirthdays(parseEvents([legacy]), now);
      expect(states.get("birthdays.next.name")).eq("Legacy");
      expect(states.get("birthdays.next.full_name")).eq("");
      expect(states.get("birthdays.next.first_name")).eq("");
      expect(states.get("birthdays.next.birth_date")).eq(null);
      expect(states.get("birthdays.next.birthDate")).eq("");
      expect(states.get("birthdays.next.age")).eq(null);
    }
  });
});
