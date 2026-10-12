Closes a11ign/a11ign#5183's Region only: `src/fleet-wake.ts` no longer reaches `../../worker-fleet`. Parent a11ign/a11ign#4425.

Acceptance:

```bash
cd /home/agent/repos/wt-5183-control && bash -c 'test "$(git grep -cE "from \"\.\./\.\./" -- src/fleet-wake.ts | wc -l)" = 0'
```

**As run (measured, 2026-10-12):** exit 0. Before the change the same command exits 1 (2 matching lines).

## What changed

- `src/fleet-wake.ts`: dropped the `worker-http.ts` and `cli-flags.ts` imports. Route chosen: the module carries its own GET-with-total-deadline `requestJson` and a zero-flag `refuseAnyFlag`, because a package-name import is refused by `control-has-no-dependencies.test.ts` and a declared dependency by ADR 0012, so no ruling is needed to build this.
- `.changeset/control-s-fleet-wake-5183.md` (outside the Region; `ci.yml` requires a changeset).

## Measured

- `node --test src/fleet-wake.test.ts src/control-has-no-dependencies.test.ts`: 46 pass, 0 fail.
- `node src/fleet-wake.ts --bogus` prints the refusal and "It takes no flags at all."; `probeWorker('http://127.0.0.1:9')` returns `refused` (hand-run; no test covers the flag refusal, and no mutation check was run on it).

## Not done here (premise of done-when 3 does not hold from this row alone)

- `fleet-wake.ts` still imports `fleet-discover.ts`, `fleet-status.ts` and `with-control-plane-fleet.ts`, which import `../../worker-fleet/src/{worker-http,cli-flags,fleet-env,worker-health}.ts`. So the lab's `fleet-wake` consumers still fail at load outside a core checkout. Filed as a row; this PR does not make done-when 3 true.
- `pnpm run typecheck`/lint not run: this worktree has no `node_modules`.

Closes: none -- a11ign/a11ign#5183 lives in another repository; `product-manager` closes it at merge.
