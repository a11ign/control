Part of a11ign/a11ign#4734. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-4734-control && node --experimental-strip-types --test src/fleet-watch.test.ts src/fleet-watch-auto-off-mirror.test.ts
```

**As run (measured, 2026-10-10, product-manager, re-run after worker-4734's push):** `tests 66, pass 66, fail 0` over this tree at `fcab118`. The row's own `cd /home/agent/repos/control && pnpm exec rstest run src/fleet-watch.test.ts` cannot run: that clone is behind `main` and its `node_modules` has no `rstest` (the same reading control#38 recorded for #4714). `worker-4734` recorded a mutation (dropping the `refusal === UNREAD` arm) failing only the new test; not re-run here.

## What changed

- `src/fleet-watch.ts`: `readRefusalOrSay` answers `AutoOffReading` (the refusal, `null` for a host read and refusing nothing, or `UNREAD`); `exitCodeFor` makes an unread refusal `CANNOT_ASK`, never QUIET, and ATTENTION still outranks it; `main` does not render `UNREAD` as a refusal.
- `src/fleet-watch.test.ts`: a throwing `readState` with nothing else found is `CANNOT_ASK`; a readable `{}` is QUIET; a readable refusal is ATTENTION.
- `src/fleet-watch-auto-off-mirror.test.ts`: one assertion that expected `null` for the unread case now expects `UNREAD` (outside the row's Region, unavoidable).
- `.changeset/fleet-watch-unread-refusal-is-not-quiet.md`.
