Row a11ign/a11ign#5023 (part of a11ign/a11ign#4405, item 5). Eight hand-run provision attempts in a standing seat lost boxes to auto-off and to a re-enabled Edge updater. `src/fleet-converge.ts` is the scripted run: lock (operation `wake`), wake, deploy, provision, `fleet:status`, one result, with bounded retries of the two known causes and one wake of the orchestrator for anything else.

Closes a11ign/a11ign#5023

platform: nothing new built for the plumbing: `takeFleetLock`/`expireFleetLock`, `wakeFleet`, `layerDeclaration`/`separateLayers` and `fleet-playbook.ts` itself (as a subprocess) are the existing ones; `git ls-remote` resolves the tags.

Acceptance:

```bash
cd /home/agent/repos/control && node --test src/fleet-converge.test.ts
```

**The row's own command does not run, and the reason is not this change:** `pnpm exec rstest run src/fleet-converge.test.ts` in the control checkout prints `Command "rstest" not found` (`control/node_modules/.bin` holds `changeset`, `tsc`, `tsserver`, `tsx`), and `rstest` run directly without the toolchain's config reports `No test suites found`, because these tests are `node:test`. The form above is the one `src/fleet-layer/edge-updater-guard.test.ts`'s row used. CI's `checks` job runs the file under the toolchain's config over the core and is the verdict for the whole suite.

**As run (measured, at this branch's head, in `/home/agent/repos/wt-5023-control`):** `tests 21, pass 21, fail 0`.

## The two causes, and the real line each pattern matches (done-when 2)

Read from a11ign#4948's comments (`orchestrator`, 2026-10-11T11:34Z), not guessed:

| cause | what the pattern reads | the real text |
|---|---|---|
| `unreachable` | `fatal: [<box>]: UNREACHABLE!` (ansible's own grammar), else a recap line with `unreachable=N`, N > 0 | `a11y-worker-3 : ok=87 changed=3 unreachable=1 failed=0 ...` |
| `edge-updater-ready` | a `FAILED!` under the task `worker : Refuse to call this provisioned unless Edge is the pinned build and the updater is off` whose message has `scheduled task MicrosoftEdgeUpdate* is Ready, expected Disabled`, and NO `Edge is <v>, expected <w>` | worker-3: `MicrosoftEdgeUpdateTaskMachineCore` and `...UA` are Ready (expected Disabled), service `edgeupdate` Running, `edgeupdatem` Manual |

The Edge pattern excludes a wrong BUILD on purpose: a retry does not move a pin, so that is `unknown`.

## Mutation evidence (each guard broken, and the test that noticed; the file restored byte-identical, `diff` empty)

| mutation | tests that failed |
|---|---|
| cap never fires (`>= 99`) | exhausted-after-3; lock-ended-on-every-exit |
| cap always fires (`>= 1`) | unreachable-retried; Edge-retried; exhausted-after-3; will-not-wake |
| unknown is retried | unmatched-not-retried; one-unknown-among-known; refusal-names-no-box; lock-ended-on-every-exit |
| lock under another name than `wake` | lock-taken-as-wake-before-first-step |
| lock not ended unless the run was ok | lock-ended-on-every-exit |
| a success wakes the orchestrator | unreachable-retried; Edge-retried; clean-run |
| `--layer-ref` pair not passed to the plays | pair-derived-and-both-plays-passed |

The lock negative control uses the REAL `lockTakeStep` and the real lock command over a directory of this machine's: a `wake` lock is taken over by `deploy.yml`, and a lock under `fleet-converge` is refused with `REFUSING deploy.yml: the fleet lock is held by fleet-converge`.

## Corrections to the row's premises

- **`fleet-playbook.ts` IS importable** (its `main` sits behind the entry guard, and `fleet-playbook.test.ts` imports it), contrary to the row's note. The run still starts it as a subprocess, because `main` reads `process.argv` and ends in `process.exit`, so there is no function to call; `lockTakeStep` is imported by the test for the negative control.
- **"The laid tag" is read from the control plane** (`<checkout>/<layer path>/.layer-ref`, over `sshToControlPlane`), not from this machine's tree: it is the tag the control plane's own `laidJudgement` compares a `--layer-ref` against, so it is the only value its move check accepts.

## Not done here
- No live run (the VERIFY row's), no `fleet:*`, no `lab:*`, no worker script.
- `commitOfTag` is a small copy of `qualification-run.ts`'s private one: that file is outside this row's Region and exports neither it nor `RESOLVABLE_TAG`.
- The `fleet:converge` alias in the core `package.json` is the separate row the body says to file at merge.
- `test:python` and the core's `lint` and `typecheck` were not run here: this repository has no ESLint config of its own and typechecks `src/` only inside the core's CI. The two new files were typechecked with the core's `tsc` under `strict` (`tsc --noEmit`, 0 errors); `node -e "import('./src/fleet-converge.ts')"` loads.
