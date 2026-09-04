# Changelog

## Unreleased

- Rename the technical adapter ID and package from `familienplan` to `familyplan`.
- Added compatibility with FamilienPlan API 0.1.82.
- Removed all assumptions about the former calendar, child and location `type` field.
- Switched routing, filtering, aggregations and triggers to `event_type`.
- Added stable keys for generated default `STAY` entries with `id=null`.
- Merge adjacent generated default stays split at API query chunk boundaries without merging explicit stays.
- Updated the admin event filters, tests and documentation for the new API model.
- Use normalized child names as child object IDs and child names in trigger filters.
- Removed redundant child states from birthday previews and separate birthday/waste preview-day limits.
- Simplified trigger rules: the name is the ID, offsets support seconds, and catch-up is configured in seconds.
- Exclude already active events from `next`/`nextAfter` projections.
- Always import every waste type returned by the API; remove the obsolete waste-type filter.
- Create all queryable trigger states as soon as a rule is configured and remove stale rule folders.
- Show a busy state on the admin refresh button until the adapter acknowledges completion.
- Evaluate trigger rules every second and expose `active` as the configured pulse instead of the rule-enabled flag.

## 0.1.0 - 2026-09-03

- Initial release.
