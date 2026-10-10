---
"@a11ign/control": patch
---

`fleet-watch`'s hourly tick takes the `control-unit-drift` reading (#4714). A control-plane unit that `differs` from the repository's copy, or is `missing-on-host`, is ATTENTION: one `unit-drift: <unit> <kind>` line, posted once and cleared when the unit is re-installed. `not-shipped` is printed and never raised. A host that cannot be read is said on stderr, carries the last lines, and exits `CANNOT_ASK` rather than QUIET. A stale `a11y-fleet-auto-off.service` naming `lay-layer.mjs` failed 316 ticks behind a `-`-prefixed pre-step with nothing on a clock to see it.
