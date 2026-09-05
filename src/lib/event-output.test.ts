import { expect } from "chai";
import { completeEvent } from "./aggregation";
import { parseEvents, parseChildren } from "./validation";
import type { CalendarEvent } from "./types";

describe("Complete event output", () => {
  const event: CalendarEvent = {
    event_type: "STAY",
    id: null,
    title: "Von der API gelieferte Betreuung",
    description: "Bitte Schulsachen mitbringen",
    starts_at: "2026-08-23T18:00:00+02:00",
    ends_at: "2026-09-11T14:30:00+02:00",
    child_id: 7,
    child_name: "Rika",
    responsible_name: "Friederike",
    responsible_user_id: 2,
    generated: true,
    source: "default",
    extra_api_field: { value: 1 },
  };
  it("preserves API titles, descriptions, identities and additional fields", () => {
    const output = completeEvent(parseEvents([event])[0]);
    expect(output).include({
      title: event.title,
      description: event.description,
      child_id: 7,
      child_name: "Rika",
      responsible_name: "Friederike",
    });
    expect(output.extra_api_field).deep.eq({ value: 1 });
  });
  it("exposes a description for older responses without losing notes", () => {
    expect(
      completeEvent({
        ...event,
        description: undefined,
        note: "Hinweis",
      }),
    ).include({ description: "Hinweis", note: "Hinweis" });
    expect(completeEvent({ ...event, description: undefined }).description).eq(
      null,
    );
    expect(
      completeEvent({ ...event, description: "", note: "Alt" }).description,
    ).eq("");
  });
  it("retains age and birth date from child responses", () => {
    expect(
      parseChildren([
        { id: 7, name: "Rika", age: 12, birth_date: "2014-01-02" },
      ])[0],
    ).include({ age: 12, birth_date: "2014-01-02" });
  });
});
