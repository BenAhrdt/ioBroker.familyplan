![Logo](admin/familienplan.svg)

# ioBroker.familyplan

[![NPM version](https://img.shields.io/npm/v/iobroker.familyplan.svg)](https://www.npmjs.com/package/iobroker.familyplan)
[![Downloads](https://img.shields.io/npm/dm/iobroker.familyplan.svg)](https://www.npmjs.com/package/iobroker.familyplan)
![Number of installations](https://iobroker.live/badges/familyplan-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/familyplan-stable.svg)
[![Test and Release](https://github.com/BenAhrdt/ioBroker.familyplan/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/BenAhrdt/ioBroker.familyplan/actions/workflows/test-and-release.yml)

## FamilienPlan adapter for ioBroker

This adapter imports calendar data from a [FamilienPlan](https://familienplan.ben-schmidt.net) installation. It provides dynamic ioBroker objects, daily summaries, birthday and waste-collection texts, and persistent automation triggers for JavaScript and Blockly.

## Requirements

- Node.js 22 or newer
- js-controller 6.0.11 or newer
- Admin 8.0.11 or newer
- A FamilienPlan installation with integration API support

## Configuration

Create an integration API key for the FamilienPlan person whose permissions should be used. Enter the installation's base URL and the key in the adapter configuration, test the connection, save the settings, and start the instance.

The configuration contains the following groups:

- **Connection:** base URL, protected API key, connection test, IANA time zone, HTTP timeout, and TLS certificate verification.
- **Polling:** week, month, quarter, or year range with optional days before and after it, polling interval, retry settings, optional child IDs, custody/location information, and object retention.
- **Timeline:** number of days, optional event-type filter, output template, separators, and date/time formats.
- **Birthdays and waste:** relative output templates, separators, empty text, and waste-title mappings. All waste types returned by the API are imported.
- **Triggers:** named rules with event type, optional custom type, child name, trigger position, offset/unit, and catch-up window.

Disabling TLS certificate verification is unsafe and produces an explicit warning. Use it only temporarily in a controlled local environment.

## API

The adapter uses the following integration endpoints:

- `GET /api/v1/integrations/v1/status`
- `GET /api/v1/integrations/v1/children`
- `GET /api/v1/integrations/v1/calendar?from_at=…&to_at=…[&child_id=…]`
- `GET /api/v1/integrations/v1/children/{id}/location`

Authentication is sent exclusively in the `Authorization: Bearer …` header. The API key is never added to a URL.

## Objects

```text
familyplan.0
├── info                 Connection, synchronization, API version, range, and counters
├── control.refresh      Writable manual-refresh button
├── calendar             Valid original API events and currently active events
├── children.<name>      Dynamically detected children, for example children.rika
├── appointments         Shared stable appointment overview
├── events.appointment   Dynamically detected event_type groups
├── timeline             today, tomorrow, days_2, …
├── birthdays            Relative birthday groups
├── waste                Relative waste-collection groups
└── triggers             Rule states, schedule, and persistent history
```

FamilienPlan API 0.1.82 calendar objects use `event_type`; the former `type` property is deliberately ignored. Known types include `GENERAL`, `STAY`, `SCHOOL`, `SCHOOL_HOLIDAY`, `BIRTHDAY`, `PRIVATE`, `WASTE`, `CLEANING`, and `OTHER`. Additional API values are supported dynamically. `OTHER` is grouped further by its normalized `custom_type_label`; events without a label use `unknown`.

Every event-type folder provides summaries, month groups, `next`, and `nextAfter`. The projections contain only events that have not started. An event is active from its inclusive `starts_at` until its exclusive `ends_at` value.

`calendar.current` contains all active events as JSON, their IDs, and their count. Its monotonic `revision` value changes only when an event starts or ends and is therefore suitable as an external automation trigger.

## Timeline, birthdays, and waste collection

Timeline entries are assigned to calendar days in the configured time zone. Multi-day events appear on every affected day. The properties `startsThisDay`, `endsThisDay`, and `continuesThisDay` describe their relation to that day. IANA time zones ensure correct daylight-saving-time handling.

Birthday entries retain the age supplied by the API. If `birth_date` is missing, the displayed date is derived from the day and month of `starts_at` and from `year(starts_at) - age`. This value is a documented display fallback, not an additional API-confirmed birth date.

Waste collection uses `event_type=WASTE`. The waste type is derived from the part of the title before “in”, “am”, or “für”. Configured substring mappings take precedence, while the original title remains available.

Custody entries use `event_type=STAY`. Explicit entries have an ID and `source=stay`. Generated default stays have `id=null`, `source=default`, and `generated=true`. They receive stable internal keys, and matching adjacent default intervals split only by API query chunks are merged again. Explicit and generated entries are never treated as identical.

## Reliable triggers

Supported positions are `beforeStart`, `afterStart`, `beforeEnd`, and `afterEnd`; offsets may use seconds, minutes, hours, or days. Rules filter directly by `event_type`. The `custom_type_label` filter applies only to `OTHER`, and child-name matching is case-insensitive.

The catch-up/pulse duration defines both how long `active` remains true and how long a missed trigger may be fired late. A persistent SHA-256 key made from the rule, event type, event key, start/end, position, and offset prevents duplicate triggers after a restart.

For robust automation, react to the monotonic `triggers.<rule-id>.count` state. Each rule has an `active` state. Its `event` JSON is written both when the trigger becomes active and when it is reset; the payload's `active` property identifies the transition. `triggers.event` receives these transitions from every rule as a common event stream. Event JSON contains `child_name` instead of the internal `child_id` and includes the appointment `note` when supplied by the API. `lastTriggered`, `lastEventId`, and `scheduledFor` provide additional context.

### JavaScript example

```javascript
on(
  { id: "familyplan.0.triggers.waste_before_start_1d.count", change: "ne" },
  () => {
    const payload = JSON.parse(
      getState("familyplan.0.triggers.waste_before_start_1d.event").val,
    );
    sendTo("telegram.0", "send", {
      text: `${payload.event.title} will be collected tomorrow.`,
    });
  },
);
```

### Blockly

Use an “Object changed” block for `familyplan.0.triggers.<rule-id>.count` with the change type “not equal to previous value”. The branch can read the JSON `event` state or use `lastEventId`. To request a manual synchronization, write `true` without acknowledgement to `control.refresh`.

## Troubleshooting and security

- **401:** The API key is missing, incorrect, or revoked.
- **403:** The person associated with the key lacks a required read permission.
- **422:** Check the configured range, time zone, and filters. Large ranges are automatically split into smaller API queries.
- **429/5xx:** Requests are retried with bounded exponential backoff, and the existing data is retained.
- **Timeout/DNS:** Check the base URL, DNS resolution, reachability, and configured timeout.
- **TLS:** Correct the certificate chain. Disable verification only in controlled test environments.

The API key is encrypted through `encryptedNative`, protected through `protectedNative`, and redacted together with authorization headers in error messages. Invalid individual events are skipped without rejecting an otherwise valid response. Never publish diagnostics or configuration exports containing a real key.

## Development

Install the development dependencies and run the full local validation:

```bash
npm install
npm run validate
```

`npm run validate` performs TypeScript checking, ESLint, unit and package tests, and a clean build. HTTP tests use mocks and do not require a FamilienPlan server.

Start the local ioBroker development environment with:

```bash
npm run dev-server setup
npm run dev-server watch
```

The Admin UI is available at `http://127.0.0.1:8081` by default. Local data is stored below `.dev-server/` and is not published.

## Changelog
### 0.1.2 (2026-09-04)

- (BenAhrdt) Add per-rule active/reset trigger events and a shared JSON event stream for all trigger transitions.
- (BenAhrdt) Include appointment notes and child names in projected event data while omitting internal child IDs.
- (BenAhrdt) Build automatically for GitHub installations and fix unit-test discovery on Windows.

### 0.1.1 (2026-09-04)

- (BenAhrdt) Require Node.js 22 and Admin 8.0.11 or newer.
- (BenAhrdt) Add the official ioBroker test/release workflow and release-script configuration.
- (BenAhrdt) Add compatibility with FamilienPlan API 0.1.82 and use `event_type` throughout.
- (BenAhrdt) Add stable generated stays, range-boundary merging, event projections, persistent triggers, and administration views.

### 0.1.0 (2026-09-03)

- (BenAhrdt) Initial release.

Older changes are available in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

MIT License

Copyright (c) 2026 Ben Schmidt
