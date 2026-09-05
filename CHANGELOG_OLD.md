# Older changelog

There are no older releases yet. Current release notes are maintained in the
[README changelog](README.md#changelog).
## 0.1.6 (2026-09-04)

- (BenAhrdt) Recalculate child custody projections every minute from cached `STAY` events so `responsibleName`, `nextChangeAt`, `next`, and `nextAfter` advance without an API synchronization.
- (BenAhrdt) Accept nullable birthday fields, match child names embedded in birthday titles, and keep the child age current from the derived birth date.

## 0.1.5 (2026-09-04)

- (BenAhrdt) Fix child location projections by querying the current point in time and suppressing expired `nextChangeAt` values.
- (BenAhrdt) Populate child `birthDate` and `age` states more reliably by matching birthday events through child IDs or names and deriving the age from the birth date when necessary.

## 0.1.4 (2026-09-04)

- (BenAhrdt) Expand the English documentation with step-by-step instructions for connecting ioBroker to the FamilienPlan API.

## 0.1.3 (2026-09-04)

- (BenAhrdt) Preserve calendar-event time-zone offsets when calculating trigger times.

## 0.1.2 (2026-09-04)

- (BenAhrdt) Add per-rule active/reset trigger events and a shared JSON event stream for all trigger transitions.
- (BenAhrdt) Include appointment notes and child names in projected event data while omitting internal child IDs.
- (BenAhrdt) Build automatically for GitHub installations and fix unit-test discovery on Windows.

## 0.1.1 (2026-09-04)

- (BenAhrdt) Require Node.js 22 and Admin 8.0.11 or newer.
- (BenAhrdt) Add the official ioBroker test/release workflow and release-script configuration.
- (BenAhrdt) Add compatibility with FamilienPlan API 0.1.82 and use `event_type` throughout.
- (BenAhrdt) Add stable generated stays, range-boundary merging, event projections, persistent triggers, and administration views.

## 0.1.0 (2026-09-03)

- (BenAhrdt) Initial release.
