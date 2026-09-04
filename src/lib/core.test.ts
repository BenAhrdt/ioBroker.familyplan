import { expect } from "chai";
import { DateTime } from "luxon";
import { FamilienPlanApiClient, ApiError } from "./api-client";
import {
  birthdayItem,
  eventsForDay,
  isEventActive,
  nextOccurrences,
  parseChildIds,
  uniqueOccurrences,
  renderRelative,
  wasteItem,
} from "./aggregation";
import {
  eventFolder,
  eventObjectId,
  normalizeId,
  stableSegment,
  stableSegments,
} from "./ids";
import {
  dueTriggers,
  futureTriggers,
  scheduledFor,
  triggerKey,
} from "./triggers";
import { parseChildren, parseEvents, parseLocation } from "./validation";
import type { CalendarEvent, TriggerRule } from "./types";

const event = (extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  event_type: "GENERAL",
  custom_type_label: null,
  id: 525,
  title: "Termin",
  starts_at: "2026-10-25T02:30:00+02:00",
  ends_at: "2026-10-25T03:30:00+01:00",
  all_day: false,
  ...extra,
});
describe("IDs and validation", () => {
  it("normalizes safe stable IDs", () => {
    expect(normalizeId("Müll & Abfall")).eq("muell_abfall");
    expect(normalizeId("Arzt / Therapie")).eq("arzt_therapie");
    expect(normalizeId("###")).eq("unknown");
  });
  it("resolves collisions deterministically", () => {
    const m = new Map<string, string>();
    const a = stableSegment("A-B", m),
      b = stableSegment("A B", m);
    expect(a).eq("a_b");
    expect(b).match(/^a_b_[0-9a-f]{8}$/);
    expect(stableSegment("A B", m)).eq(b);
    const forward = stableSegments(["A-B", "A B"]);
    const reverse = stableSegments(["A B", "A-B"]);
    expect([...forward]).deep.eq([...reverse]);
    expect(new Set(forward.values()).size).eq(2);
    expect(forward.get("A B")).not.eq(forward.get("A-B"));
    const reserved = stableSegments(["OTHER", "other!"]);
    expect(reserved.get("OTHER")).eq("other");
    expect(reserved.get("other!")).match(/^other_[0-9a-f]{8}$/);
  });
  it("routes known, unknown and OTHER events", () => {
    expect(eventFolder(event())).eq("events.appointment.general");
    expect(eventFolder(event({ event_type: "FUTURE" }))).eq(
      "events.appointment.future",
    );
    expect(
      eventFolder(
        event({ event_type: "OTHER", custom_type_label: "Elternabend" }),
      ),
    ).eq("events.appointment.other.elternabend");
    expect(
      eventFolder(event({ event_type: "OTHER", custom_type_label: null })),
    ).eq("events.appointment.other.unknown");
    expect(eventFolder(event({ event_type: "STAY" }))).eq(
      "events.appointment.stay",
    );
    expect(eventFolder(event({ event_type: "SCHOOL" }))).eq(
      "events.appointment.school",
    );
    expect(eventFolder(event({ event_type: "FUTURE_TYPE" }))).eq(
      "events.appointment.future_type",
    );
  });
  it("creates a stable key for generated stays without an ID", () => {
    const generated = event({
      event_type: "STAY",
      id: null,
      child_id: 4,
      responsible_user_id: 12,
      source: "default",
      generated: true,
    });
    expect(eventObjectId(generated)).match(/^generated_[0-9a-f]{12}$/);
    expect(eventObjectId(generated)).eq(eventObjectId({ ...generated }));
  });
  it("keeps supported and unknown event types, skips old or invalid entries", () => {
    let invalid = 0;
    const list = parseEvents(
      [
        event(),
        event({ event_type: "STAY", id: null, title: null }),
        event({ event_type: "BIRTHDAY", age: 44 }),
        event({ event_type: "SCHOOL_HOLIDAY" }),
        event({ event_type: "SCHOOL" }),
        event({ event_type: "NEW_TYPE" }),
        { type: "bad" },
      ],
      () => invalid++,
    );
    expect(list).length(6);
    expect(invalid).eq(1);
  });
  it("parses children and locations without the removed type field", () => {
    expect(
      parseChildren([
        { id: 4, name: "Rika", default_responsible_user_id: 12 },
      ])[0].name,
    ).eq("Rika");
    expect(
      parseLocation({
        child_id: 4,
        at: "2026-09-03T12:00:00Z",
        responsible_user_id: 12,
        responsible_name: "Friederike",
        source: "default",
        current_until: null,
        next_change_at: null,
      }).responsible_name,
    ).eq("Friederike");
  });
});
describe("API client", () => {
  it("sends bearer header and encodes ISO parameters", async () => {
    let url = "",
      auth = "";
    const mock = async (input: string | URL, init?: RequestInit) => {
      url = String(input);
      auth = new Headers(init?.headers).get("Authorization") || "";
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await new FamilienPlanApiClient({
      baseUrl: "https://example.test/",
      apiKey: "secret",
      timeoutMs: 1000,
      verifySsl: true,
      fetchImpl: mock,
    }).calendar("2026-09-05T00:00:00+02:00", "2026-09-06T00:00:00+02:00");
    expect(auth).eq("Bearer secret");
    expect(url).contains("%2B02%3A00");
  });
  it("parses status and maps authorization errors", async () => {
    const ok = async () =>
      new Response(
        JSON.stringify({
          api_version: "v1",
          status: "ok",
          server_time: "2026-01-01T00:00:00Z",
          scopes: [],
        }),
        { status: 200 },
      );
    expect(
      (
        await new FamilienPlanApiClient({
          baseUrl: "https://x",
          apiKey: "x",
          timeoutMs: 100,
          verifySsl: true,
          fetchImpl: ok,
        }).status()
      ).status,
    ).eq("ok");
    const bad = async () => new Response("", { status: 401 });
    try {
      await new FamilienPlanApiClient({
        baseUrl: "https://x",
        apiKey: "secret",
        timeoutMs: 100,
        verifySsl: true,
        fetchImpl: bad,
      }).status();
      expect.fail();
    } catch (e) {
      expect(e).instanceOf(ApiError);
      expect(String(e)).not.contains("secret");
    }
  });
  it("handles forbidden, server errors and timeouts", async () => {
    for (const status of [403, 500]) {
      const mock = async () => new Response("", { status });
      try {
        await new FamilienPlanApiClient({
          baseUrl: "https://x",
          apiKey: "x",
          timeoutMs: 100,
          verifySsl: true,
          fetchImpl: mock,
        }).status();
        expect.fail();
      } catch (e) {
        expect(e).instanceOf(ApiError);
      }
    }
    const timeout = async (_i: string | URL, init?: RequestInit) =>
      new Promise<Response>((_r, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error(), { name: "AbortError" })),
        ),
      );
    try {
      await new FamilienPlanApiClient({
        baseUrl: "https://x",
        apiKey: "x",
        timeoutMs: 2,
        verifySsl: true,
        fetchImpl: timeout,
      }).status();
      expect.fail();
    } catch (e) {
      expect(String(e)).contains("Zeitüberschreitung");
    }
  });
  it("configures an Undici dispatcher only when SSL verification is disabled", async () => {
    let dispatcher: unknown;
    const mock = async (_input: string | URL, init?: RequestInit) => {
      dispatcher = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
      return new Response(
        JSON.stringify({
          api_version: "v1",
          status: "ok",
          server_time: "2026-01-01T00:00:00Z",
          scopes: [],
        }),
        { status: 200 },
      );
    };
    await new FamilienPlanApiClient({
      baseUrl: "https://x",
      apiKey: "x",
      timeoutMs: 100,
      verifySsl: false,
      fetchImpl: mock,
    }).status();
    expect(dispatcher).to.be.an("object");
  });
});
describe("aggregations", () => {
  const now = DateTime.fromISO("2026-09-05T12:00:00+02:00");
  it("treats an empty child selection as all children", () => {
    expect(parseChildIds("")).deep.eq([]);
    expect(parseChildIds("  ")).deep.eq([]);
    expect(parseChildIds(undefined)).deep.eq([]);
    expect(parseChildIds("1, 2")).deep.eq([1, 2]);
  });
  it("groups today, tomorrow and multi-day overlap", () => {
    const multi = event({
      starts_at: "2026-09-04T18:00:00+02:00",
      ends_at: "2026-09-07T08:00:00+02:00",
    });
    expect(eventsForDay([multi], now, "Europe/Berlin")[0].continuesThisDay)
      .true;
    expect(
      eventsForDay([multi], now.plus({ days: 1 }), "Europe/Berlin"),
    ).length(1);
  });
  it("handles all-day and DST days calendar-based", () => {
    const all = event({
      starts_at: "2026-10-25T00:00:00+02:00",
      ends_at: "2026-10-26T00:00:00+01:00",
      all_day: true,
    });
    expect(
      eventsForDay(
        [all],
        DateTime.fromISO("2026-10-25T12:00:00+01:00"),
        "Europe/Berlin",
      ),
    ).length(1);
  });
  it("marks events active only from the inclusive start to the exclusive end", () => {
    const timed = event({
      starts_at: "2026-09-05T10:00:00+02:00",
      ends_at: "2026-09-05T11:00:00+02:00",
    });
    expect(isEventActive(timed, DateTime.fromISO("2026-09-05T09:59:59+02:00")))
      .false;
    expect(isEventActive(timed, DateTime.fromISO("2026-09-05T10:00:00+02:00")))
      .true;
    expect(isEventActive(timed, DateTime.fromISO("2026-09-05T11:00:00+02:00")))
      .false;
  });
  it("excludes active events and uses future events only once", () => {
    const multi = event({
      id: 1,
      title: "Wochenende",
      starts_at: "2026-09-05T10:00:00+02:00",
      ends_at: "2026-09-07T18:00:00+02:00",
    });
    const later = event({
      id: 2,
      title: "Später",
      starts_at: "2026-09-08T10:00:00+02:00",
      ends_at: "2026-09-08T11:00:00+02:00",
    });
    const latest = event({
      id: 3,
      title: "Noch später",
      starts_at: "2026-09-09T10:00:00+02:00",
      ends_at: "2026-09-09T11:00:00+02:00",
    });
    const [next, nextAfter] = nextOccurrences(
      [multi, multi, later, later, latest],
      now,
    );
    expect(next?.title).eq("Später");
    expect(nextAfter?.title).eq("Noch später");
  });
  it("merges adjacent generated default stays but not explicit stays", () => {
    const first = event({
      id: null,
      title: null,
      event_type: "STAY",
      child_id: 4,
      responsible_user_id: 12,
      source: "default",
      generated: true,
      starts_at: "2026-01-01T00:00:00Z",
      ends_at: "2026-06-01T00:00:00Z",
    });
    const second = event({
      ...first,
      starts_at: first.ends_at,
      ends_at: "2026-12-31T00:00:00Z",
    });
    const explicit = event({
      ...second,
      id: 123,
      source: "stay",
      generated: false,
    });
    const merged = uniqueOccurrences([first, second, explicit]);
    expect(merged).length(2);
    expect(merged[0].starts_at).eq(first.starts_at);
    expect(merged[0].ends_at).eq(second.ends_at);
  });
  it("aggregates birthdays, waste and templates", () => {
    const b = birthdayItem(
      event({
        event_type: "BIRTHDAY",
        title: "Ben",
        age: 44,
        starts_at: "2026-09-06T00:00:00+02:00",
      }),
      now,
      "Europe/Berlin",
      "dd.MM.yyyy",
    );
    expect(b.birthDate).eq("06.09.1982");
    const w = wasteItem(
      event({
        title: "Restabfall in Hohenahr",
        starts_at: "2026-09-06T00:00:00+02:00",
      }),
      now,
      "Europe/Berlin",
      [],
    );
    expect(w.wasteType).eq("Restabfall");
    expect(
      renderRelative(
        [b] as unknown as Record<string, unknown>[],
        1,
        { today: "", tomorrow: "Morgen {name} {age}", future: "" },
        " und ",
      ),
    ).eq("Morgen Ben 44");
  });
});
describe("triggers", () => {
  const e = event({
    starts_at: "2026-09-05T10:00:00+02:00",
    ends_at: "2026-09-05T11:00:00+02:00",
  });
  const base = {
    name: "Regel",
    enabled: true,
    eventType: "GENERAL",
    offset: 30,
    unit: "minutes" as const,
    catchUpSeconds: 900,
  };
  it("calculates all four positions", () => {
    for (const [position, time] of [
      ["beforeStart", "09:30"],
      ["afterStart", "10:30"],
      ["beforeEnd", "10:30"],
      ["afterEnd", "11:30"],
    ] as const) {
      expect(scheduledFor({ ...base, position }, e).toFormat("HH:mm")).eq(time);
    }
    expect(
      scheduledFor(
        { ...base, position: "beforeStart", offset: 30, unit: "seconds" },
        e,
      ).toFormat("HH:mm:ss"),
    ).eq("09:59:30");
  });
  it("fires a Berlin before-start trigger once when the clock crosses it", () => {
    const rule: TriggerRule = {
      ...base,
      position: "beforeStart",
      catchUpSeconds: 60,
    };
    const berlinEvent = event({
      starts_at: "2026-09-04T18:00:00+02:00",
      ends_at: "2026-09-04T19:00:00+02:00",
    });
    const scheduled = scheduledFor(rule, berlinEvent);
    const lastCheck = DateTime.fromISO("2026-09-04T17:29:59.900", {
      zone: "Europe/Berlin",
    });
    const now = DateTime.fromISO("2026-09-04T17:30:00.920", {
      zone: "Europe/Berlin",
    });

    expect(scheduled.toISO()).eq("2026-09-04T17:30:00.000+02:00");
    const due = dueTriggers([rule], [berlinEvent], lastCheck, now, new Set());
    expect(due).length(1);
    expect(
      dueTriggers(
        [rule],
        [berlinEvent],
        now,
        now.plus({ seconds: 1 }),
        new Set([due[0].key]),
      ),
    ).deep.eq([]);
  });
  it("catches a before-start trigger when a tick is a few seconds late", () => {
    const rule: TriggerRule = {
      ...base,
      position: "beforeStart",
      catchUpSeconds: 60,
    };
    const berlinEvent = event({
      starts_at: "2026-09-04T18:00:00+02:00",
      ends_at: "2026-09-04T19:00:00+02:00",
    });
    const now = DateTime.fromISO("2026-09-04T17:30:08.000", {
      zone: "Europe/Berlin",
    });

    expect(
      dueTriggers(
        [rule],
        [berlinEvent],
        now.minus({ minutes: 5 }),
        now,
        new Set(),
      ),
    ).length(1);
  });
  it("matches triggers exclusively by event_type", () => {
    const wasteRule: TriggerRule = {
      ...base,
      eventType: "WASTE",
      position: "beforeStart",
    };
    const now = DateTime.fromISO("2026-09-05T09:35:00+02:00");
    expect(
      dueTriggers(
        [wasteRule],
        [event({ ...e, event_type: "WASTE" })],
        now.minus({ minutes: 10 }),
        now,
        new Set(),
      ),
    ).length(1);
    expect(
      dueTriggers(
        [wasteRule],
        [event({ ...e, event_type: "GENERAL" })],
        now.minus({ minutes: 10 }),
        now,
        new Set(),
      ),
    ).deep.eq([]);
  });
  it("matches a configured child by name", () => {
    const now = DateTime.fromISO("2026-09-05T09:35:00+02:00");
    const rule: TriggerRule = {
      ...base,
      childName: "Rika",
      position: "beforeStart",
    };
    expect(
      dueTriggers(
        [rule],
        [event({ ...e, child_name: "Rika" })],
        now.minus({ minutes: 10 }),
        now,
        new Set(),
      ),
    ).length(1);
    expect(
      dueTriggers(
        [rule],
        [event({ ...e, child_name: "Tom" })],
        now.minus({ minutes: 10 }),
        now,
        new Set(),
      ),
    ).deep.eq([]);
  });
  it("matches custom OTHER labels case-insensitively", () => {
    const now = DateTime.fromISO("2026-09-05T09:35:00+02:00");
    const rule: TriggerRule = {
      ...base,
      eventType: "OTHER",
      customTypeLabel: " test ",
      position: "beforeStart",
    };
    expect(
      dueTriggers(
        [rule],
        [
          event({
            ...e,
            event_type: "OTHER",
            custom_type_label: "Test",
          }),
        ],
        now.minus({ minutes: 10 }),
        now,
        new Set(),
      ),
    ).length(1);
  });
  it("catches polling gaps, honors catch-up and deduplicates", () => {
    const rule: TriggerRule = { ...base, position: "beforeStart" };
    const now = DateTime.fromISO("2026-09-05T09:35:00+02:00");
    expect(
      dueTriggers([rule], [e], now.minus({ minutes: 10 }), now, new Set()),
    ).length(1);
    expect(
      dueTriggers([rule], [e], now.minus({ hours: 2 }), now, new Set()),
    ).length(1);
    expect(
      dueTriggers(
        [{ ...rule, catchUpSeconds: 120 }],
        [e],
        now.minus({ hours: 2 }),
        now,
        new Set(),
      ),
    ).length(0);
    expect(
      dueTriggers(
        [rule],
        [e],
        now.minus({ minutes: 10 }),
        now,
        new Set([triggerKey(rule, e)]),
      ),
    ).length(0);
  });
  it("rekeys changed events and permits multiple rules", () => {
    expect(triggerKey({ ...base, position: "beforeStart" }, e)).not.eq(
      triggerKey(
        { ...base, position: "beforeStart" },
        event({ ...e, starts_at: "2026-09-05T10:10:00+02:00" }),
      ),
    );
    expect(
      dueTriggers(
        [
          { ...base, name: "a", position: "beforeStart" },
          { ...base, name: "b", position: "beforeStart" },
        ],
        [e],
        DateTime.fromISO("2026-09-05T09:20:00+02:00"),
        DateTime.fromISO("2026-09-05T09:35:00+02:00"),
        new Set(),
      ),
    ).length(2);
    expect(
      dueTriggers(
        [
          { ...base, position: "beforeStart" },
          { ...base, position: "beforeStart" },
        ],
        [e],
        DateTime.fromISO("2026-09-05T09:20:00+02:00"),
        DateTime.fromISO("2026-09-05T09:35:00+02:00"),
        new Set(),
      ),
    ).length(1);
  });
  it("handles restart catch-up, changed dates and removed events", () => {
    const rule: TriggerRule = { ...base, position: "beforeStart" };
    const now = DateTime.fromISO("2026-09-05T09:35:00+02:00");
    expect(
      dueTriggers([rule], [e], now.minus({ days: 1 }), now, new Set()),
    ).length(1);
    const exactlyDue = DateTime.fromISO("2026-09-05T09:30:00+02:00");
    expect(dueTriggers([rule], [e], exactlyDue, exactlyDue, new Set())).length(
      1,
    );

    const changed = event({
      ...e,
      starts_at: "2026-09-05T10:10:00+02:00",
      ends_at: "2026-09-05T11:10:00+02:00",
    });
    expect(futureTriggers([rule], [changed], now)[0].scheduledFor).contains(
      "09:40:00",
    );
    expect(futureTriggers([rule], [], now)).deep.eq([]);
    expect(
      dueTriggers([rule], [], now.minus({ minutes: 10 }), now, new Set()),
    ).deep.eq([]);
  });
});
