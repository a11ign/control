// @ts-check
/**
 * The worker file that DECLARES `CAPTURE_PROTOCOL_VERSION`, named once.
 *
 * It was `capture-core.mjs` until 2026-09-06, when that file was split three ways and the constant moved
 * to its own module. The guard went on scraping the old file, found nothing, and refused EVERY deploy
 * with "cannot read CAPTURE_PROTOCOL_VERSION ... That is a broken guard, not a clean one" — which is the
 * guard behaving exactly right (it refuses rather than deploying blind) while being pointed at the wrong
 * place. A remedy reaching one path and not the other, this repo's most expensive recurring shape, with
 * the twist that the surviving path was a REFUSAL and so looked like a working guard from a distance.
 *
 * It was `protocol-version.mjs` until the layer moved to TypeScript (#4708) and the same refusal came back.
 * `protocol-guard.test.ts` pins that a clone holding either name is read.
 */
export const PROTOCOL_VERSION_FILE = "protocol-version.ts";

/**
 * The names the layer has shipped it under, newest first. `screenreader-worker` v0.9.0 ships `protocol-version.ts`
 * and the guard still named `.mjs`, so `fleet:deploy` refused "the worker layer is not checked out" with a full
 * clone present (#4708). The `.mjs` name is kept for one release so an older layer tag stays deployable.
 */
export const PROTOCOL_VERSION_FILES = [PROTOCOL_VERSION_FILE, "protocol-version.mjs"];

/** What `guardProtocolChange` exits with on every refusal it makes. */
const PROTOCOL_REFUSAL_EXIT_CODE = 3;

/**
 * Run a fleet playbook from the one machine allowed to run it.
 *
 * `worker:deploy` is `utmctl file push` and reaches UTM VMs on a Mac only. The physical boxes are
 * git-cloned and deploy by pulling, which is what `ansible/deploy.yml` does — but that playbook cannot
 * run from a laptop, and the reason is structural rather than incidental. `inventory.yml` says it:
 *
 *   "This is the half of ADR 0012's split that holds the fleet SSH key, which is why worker playbooks
 *    can only be run from here and not from a developer's Mac."
 *
 * Measured 2026-08-24: every worker answers `/health` on :8765 in ~17ms from this Mac and every one
 * TIMES OUT on port 22. So a local `ansible-playbook deploy.yml` does not fail with a key error that
 * points at the cause — it reports four hosts UNREACHABLE, which reads like a sleeping fleet. `fleet:wake`
 * then says "already up", because it asks over HTTP. Two tools, two true answers, one wrong conclusion.
 *
 * So this drives Ansible where the key lives, and the npm script is the interface either way.
 *
 * `fleet:wake` is NOT here and should not be: it sends Wake-on-LAN magic packets, which are UDP
 * broadcasts on the LAN and need no SSH at all. Everything that has to talk TO a worker does.
 *
 *   npm run fleet:deploy                       # ship this checkout's worker code
 *   npm run fleet:deploy -- --ref=<commit>     # default: the commit this checkout is on
 *   npm run fleet:deploy -- --layer-ref=<layer>=<sha>   # a layer in its OWN repository is pinned beside the core (#3395)
 *   npm run fleet:sleep                        # power the fleet down, REFUSING any box mid-capture
 *   npm run fleet:provision                    # the ROLE: NVDA, Edge pin, policies, and the stamp
 *   npm run fleet:provision -- --serial=0      # all boxes at once; 1 (default) is fail-fast on a role change
 *
 * `provision-role.yml` is here because adding a box makes it necessary, and it was reachable only by
 * typing `ansible-playbook` on the control plane — the hand-crank this file exists to remove. It runs
 * `serial: 1`, so the fleet is never all-unavailable at once.
 *
 * **Run it across the WHOLE fleet, never `--limit` to the new box.** `provisionRevision` is
 * `<git-sha>-<hash of four environment files>` and it is a CAPTURE CACHE KEY that `fleet-consistency`
 * also treats as MUST_MATCH. A box stamped at a different commit from its peers makes the fleet read
 * INCONSISTENT and capture runs refuse to start — `stamp-provision-revision.ps1` records exactly that
 * happening, four boxes reporting four revisions "purely because each first-booted at a different commit
 * during one afternoon".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./git-safe-env.ts";
// The CARRIED copy of `cli-flags`, not `@a11ign/screenreader-fleet/cli-flags` (a11ign#87, ceo's ruling on a11ign#5306).
// Since ADR 0045 cut 9 the two pinned layers ARE installed here and may be imported by package name — the git, protocol,
// code-drift and pnpm helpers above are — but ADR 0012's surface rule stands for anything else:
// `control-has-no-dependencies.test.ts` allows no other package-name import, and asserts it transitively.
import { refuseUnknownFlags, flagValue, WORKER_GROUP, groupPerLine } from "./worker-fleet-carried.ts";
import { LAYER_PINNED, installedLayersJudged, installedLayersRead, manifestOf, layerCheckoutMove, layerCommitsExtraVars, layerPinsFor, layerRefValues } from "./layer-checkouts.ts";
import { makeStage, readDeployPins, resolvePublished, type GitRun } from "./layer-pins.ts";
// #1204: the guests' own report of their OS, the same reading `fleet:status` takes.
import { fleetToProbe, probeWorker, fleetStatus } from "./fleet-status.ts";
// A11-205: what `patch.yml` upgrades Windows to is `deploy-pins.json`'s, read by `fleet-pins.ts` alone.
import { readFleetPins } from "./fleet-pins.ts";
import { readFleetDrift } from "./fleet-drift.ts";
import type { WorkerHealth } from "./fleet-status.ts";
import { protocolVerdict, servedProtocols } from "@a11ign/screenreader-fleet/protocol-guard";
// BY PATH, never by package name, AND TRANSITIVELY SO. The control plane has no `node_modules` — ADR
// 0012's boundary — so a path import is not enough on its own: what it imports must obey the rule too.
// The first version of this reached `workerUrls` in `check-worker-code.mjs`, which imports
// `@a11ign/screenreader-worker` by package name, and `fleet:deploy` died on the control plane with
// ERR_MODULE_NOT_FOUND while passing on a laptop that has node_modules. A gate that does not exercise
// what ships, for the fifth time in this repo.
//
// `fleet-env.mjs` imports only node builtins and its own siblings. And the inventory is the RIGHT source
// here regardless: the control plane deploys to the fleet in `inventory.yml`, never to a local UTM pool
// that cannot exist there.
import { layerDeclaration } from "./layer-checkouts.ts";
import { CONTROL_PLANE_CHECKOUT } from "./control-plane-checkout.ts";
import { FLEET_LOCK_PLAYBOOKS, LOCK_GRACE_MINUTES, takeFleetLock, expireFleetLock, fleetLockRefusal } from "./fleet-lock.ts";
import { WAKE_LOCK_OPERATION } from "./fleet-wake.ts";
// #2832: WHAT PROVES A MOVED WORKER'S IDENTITY BEFORE A WRITE LANDS. A sibling and builtin-only, so ADR 0012's
// no-`npm install` property is unchanged.
import { overrideInventory, overridePath, installOverrideCommand, inventoryEnvironment, knownHostsReadScript,
  parseKnownHostsRead, seedPlan, seedCommand, seedReport, identityProbeScript, parseIdentityProbe,
  identityGate } from "./fleet-host-identity.ts";
import { requireControlPlaneHost, requireControlPlaneKey } from "./control-plane-host.ts";
// #1356: THE SHARED SHAPE, moved out of this file so every other operator-host reader of "which boxes are
// the fleet" (fleet-status.ts, fleet-wake.ts, fleet-discover.ts, lab-job.ts) can ask the control
// plane's own inventory the same way, instead of a checkout's `inventory.yml` -- gitignored, and absent
// on the machine that actually drives the fleet. `onTheControlPlane`/`sshToControlPlane` are re-exported
// below at their PRE-#1356 names (`onTheControlPlane`, and `ssh` via the local wrapper above) so nothing
// that already imports them from this file changes.
import { onTheControlPlane, sshToControlPlane, inventorySources, inventoryReadScript, parseInventoryReads,
  controlPlaneFleet, readControlPlaneFleet } from "./control-plane-fleet.ts";
// Re-exported at this file's own PRE-#1356 names -- every existing `import { inventorySources, ... } from
// "./fleet-playbook.ts"` (this file's own tests) keeps working unchanged.
export { inventorySources, inventoryReadScript, parseInventoryReads };

/**
 * `--serial=` and `--limit=` decide how many of twelve machines an operation touches at once, and
 * `--ref=` decides what code they end up running. `--abbrev-ref`, `--all`, `--ff-only` and `--quiet`
 * appear in this file because it passes them to GIT; they are not its own.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(
  ["--playbook=", "--ref=", "--limit=", "--serial=", "--allow-protocol-change", "--allow-edge-downgrade", "--apply",
    "--allow-offline=", "--allow-hold=",
    "--display-mode=", "--layer-ref="],
  { entry: import.meta.url, command: "npm run fleet:deploy" });

/** CT 120. Named here rather than parsed out of the inventory, which needs Ansible to read properly. */
/** How often to ask the control plane how its unit is doing. A poll INTERVAL, never a sleep-and-hope. */
const FOLLOW_POLL_MS = 5_000;

// No default: see control-plane-host.ts -- this used to fall back to a real, specific LAN address (#83).
// Resolved by `requireControlPlaneHost()` at the top of `main()`, not at import: env var first, then the
// durable file it installs (#285, `fleet:control-host-install`), then a loud refusal. A bare env read
// here would miss the file entirely, so this is reassigned once resolved rather than only validated.
let CONTROL_PLANE: string;
/** The playbooks, in THIS checkout — where a bootstrap's source file actually is. */
const ANSIBLE_DIR = resolve(import.meta.dirname, "../ansible");
// The control plane's checkout, from the ONE place that knows its name. This was a bare literal
// and `e435ac17` moved it, which made every play `cd` into a directory that does not exist -- see
// `control-plane-checkout.ts` for why four sweeps missed it. Relative, because `ssh()` above lands
// in `/root` first.
const CHECKOUT = CONTROL_PLANE_CHECKOUT;
// The playbooks' own directory on the plane. The checkout IS the control repository now (a11ign#5306), so
// its `ansible/` sits at the top, not under `packages/control/`: the old `packages/control/ansible` path
// names a directory that is not there, and a play that `cd`s or `--working-directory`s into it fails.
// Exported so the test can pin it against the `WorkingDirectory` of `ansible/files/a11y-fleet-freeze-daily.service` (a11ign#5310; it was the patch window's `patch_checkout` until A11-205).
export const ANSIBLE_ON_THE_PLANE = `${CHECKOUT}/ansible`;

/**
 * The head of the `systemd-run` that starts a playbook unit, up to (and including) the trailing space the
 * caller's next flag follows. Its own function so the test can run it: the unit runs from the directory
 * `ANSIBLE_ON_THE_PLANE` names, and a `--working-directory` that drifts from it fails only on the plane.
 */
export function planeUnitStart(unit: string): string {
  return `systemd-run --unit=${unit} --remain-after-exit --working-directory=${ANSIBLE_ON_THE_PLANE} `;
}

/**
 * Playbooks this may run, by NAME. Not a path, and not free text: the value is interpolated into a
 * command a remote shell interprets, on the box holding the fleet SSH key. Same containment as
 * `-e out=<name>` in `lab-job.yml`, for the same reason.
 */
// `inventory-install.yml` is here rather than run by hand FOR THE REASON THIS FILE EXISTS: an operation
// that matters is CLI-invocable and reviewable, or it is done differently every time by whoever is at the
// keyboard. It also inherits the zero-host refusal below, which is the guard whose absence let a deploy to
// nothing exit 0 -- though it targets `control_plane`, not `a11y_workers`, so an empty fleet is not its
// failure mode.
// `os-rollback.yml` (#921) is the one entry that changes a box's OPERATING SYSTEM, so it is also the one
// that refuses to run without `--limit=<one worker>` and does nothing but read without `--apply`
// (`osRollbackRefusal` below, and the playbook's own guards).
// `collect-logs.yml` (#1216) is READ-ONLY on the guest -- it fetches `server.log`, its one rotation back,
// and NVDA's two logs, and writes only to the control plane. It is here rather than as a bare
// `ansible-playbook` script because it targets `a11y_workers`: the `lab:*` scripts skip this wrapper
// because their plays are `hosts: localhost`, and that is the line, not how simple the playbook is.
// `freeze.yml` and `freeze-proof.yml` (A11-205) are the freeze's two plays: the first re-applies the levers that stop a box upgrading itself, the second shows on
// ONE box that each holds. Neither installs anything, and neither is gated like a deploy: the freeze may run on a box that is capturing, and the proof
// refuses a busy one itself.
const PLAYBOOKS = ["deploy.yml", "sleep.yml", "provision-role.yml", "recover.yml", "inventory-install.yml",
  "control-host-install.yml", "os-rollback.yml", "collect-logs.yml", "patch.yml", "freeze.yml", "freeze-proof.yml"];

/** Exactly one worker, by name -- what `os-rollback.yml` needs where every other playbook takes a list. */
const ONE_WORKER = /^a11y-worker-[0-9]{1,3}$/;

/**
 * Playbooks whose `--limit` must name exactly ONE worker, never the fleet and never a list (#1829).
 *
 * `os-rollback.yml` earned this first (#921): it changes a box's OS. `recover.yml` joins it for a
 * different reason that lands on the same shape -- it is EXEMPT from the capturing-worker guard on
 * purpose (`busy-worker-guard.test.ts`; "the fault it exists for cannot be reached any other way"), so
 * omitting `--limit` does not just widen a deploy, it makes a worker a DIFFERENT session is mid-capture on
 * right now reachable by a reboot that guard would otherwise have refused.
 *
 * The other playbook with this exact exemption (see `DISPATCHED_ELSEWHERE` in
 * `deploy-reached-no-hosts.test.ts`, whose own name is deliberately not spelled out here -- that test
 * asserts this file never names it) has the identical exposure but no entry in `PLAYBOOKS` and never has
 * had one; it is dispatched as a bare `ansible-playbook` call on the control plane, so this file cannot
 * refuse it before it runs. Its own play asserts the same one-host rule directly, which is the only place
 * left that sees every invocation of it.
 */
const ONE_WORKER_REQUIRED = ["os-rollback.yml", "recover.yml", "freeze-proof.yml"];

/**
 * Why EACH entry in `ONE_WORKER_REQUIRED` needs it -- one playbook, one reason, never restated as one.
 */
const ONE_WORKER_REASON: Record<string, string> = {
  "os-rollback.yml": "it changes ONE box's operating system",
  "recover.yml": "it kills the worker process and reboots, exempt from the capturing-worker guard on "
    + "purpose -- an omitted or fleet-wide --limit could reboot a box a DIFFERENT session is mid-capture "
    + "on right now",
  "freeze-proof.yml": "it starts services and runs an updater on the box to show they achieve nothing, "
    + "which is a change to ONE box and never a look at the fleet",
};

/** The playbooks whose change waits behind `--apply` (#921, and `patch.yml` from #4446, whose dry run is the plan this wrapper prints). */
const APPLY_PLAYBOOKS = ["os-rollback.yml", "patch.yml"];

/**
 * THE REFUSALS THAT BELONG TO THE MOST DESTRUCTIVE ENTRIES, and to nothing else in this allowlist (#921,
 * #1829).
 *
 * `--limit` is optional everywhere else because omitting it means "the fleet", which is what a deploy
 * wants. For the playbooks in `ONE_WORKER_REQUIRED`, "the fleet" is the one target that must never be
 * expressible, so the flag is required and must name exactly ONE worker. `--apply` is the switch that
 * turns `os-rollback.yml`'s read-only dry run into the change; on any other playbook it would be accepted
 * and ignored, which is the silently-discarded-flag shape `refuseUnknownFlags` exists for, so it is
 * refused there by name.
 *
 *
 * @returns {string | null} the refusal to print, or null when the combination is allowed
 */
function osRollbackRefusal({ chosen, limitFlag, apply }: { chosen: string; limitFlag: string | undefined; apply: boolean; }): string | null {
  if (apply && !APPLY_PLAYBOOKS.includes(chosen)) {
    return `refusing --apply with --playbook=${chosen}: only ${APPLY_PLAYBOOKS.join(" and ")} hold a change back.`;
  }
  if (ONE_WORKER_REQUIRED.includes(chosen) && !ONE_WORKER.test(limitFlag ?? "")) {
    return `refusing ${chosen} without --limit=<one worker>: ${ONE_WORKER_REASON[chosen]}, `
      + `and "${limitFlag ?? "(no --limit, i.e. the whole fleet)"}" is not one worker.`;
  }
  return null;
}

/**
 * A display mode as `<width>x<height>`, digits only.
 *
 * 3-4 digits each, so 100x100 is the smallest expressible mode and 9999x9999 the largest. Not because
 * anything here knows the adapter's capabilities -- `ChangeDisplaySettingsEx` decides that and returns
 * `DISP_CHANGE_BADMODE` when it disagrees -- but because a value outside that range is a typo rather than
 * a mode, and this one reaches a shell on the box holding the fleet SSH key. DIGITS ONLY is what makes
 * `displayModeExtraVars` safe to build by interpolation: a value that matches this cannot carry a quote,
 * a brace or a space.
 */
const DISPLAY_MODE_PATTERN = /^([0-9]{3,4})x([0-9]{3,4})$/;

/**
 * THE ONLY WAY TO DRIVE THE FLEET OFF ITS PINNED MODE, AND IT IS DELIBERATELY HARD TO POINT AT THE FLEET.
 *
 * #1955 done-when 3 cannot be read without this flag. `display.yml`'s mode task takes
 * `worker_display_mode` from `defaults/main.yml` (1024x768), so every run so far has asked for the mode
 * the box was already on and taken the `already 1024 x 768` early return -- `ChangeDisplaySettingsEx` has
 * never executed on this fleet, and "the mode step passes" has been a reading of a no-op on 10 of 10
 * (2026-09-23T08:15-08:21Z). Reading whether the task can RECOVER a mode means first putting a box on a
 * different one.
 *
 * `-e worker_display_mode=...` typed on this command does nothing -- `refuseUnknownFlags` now says so
 * rather than ignoring it, and this wrapper builds ansible's argv itself. So this is a NAMED flag
 * forwarded as one `-e`, the shape `--allow-edge-downgrade` already established here.
 *
 * ONE WORKER, ALWAYS, and this is the load-bearing refusal rather than a courtesy. `displayMode` is a
 * `MUST_MATCH` field (#1953): a fleet-wide off-pin mode makes every box INCONSISTENT with every capture
 * taken before it, and the corpus cannot tell a deliberate probe from a drifted worker. `os-rollback.yml`
 * and `recover.yml` earned the same `--limit=<one worker>` guard for destructive reasons; this one earns
 * it for an evidential reason that is just as unrecoverable -- a wrong mode is not undone by setting the
 * mode back, because the captures taken meanwhile carry it.
 *
 *
 * @returns {string | null} the refusal to print, or null when there is nothing to refuse
 */
function displayModeRefusal({ chosen, limitFlag, displayMode }: { chosen: string; limitFlag: string | undefined; displayMode: string | undefined; }): string | null {
  if (displayMode === undefined) return null;
  if (!DISPLAY_MODE_PATTERN.test(displayMode)) {
    return `refusing --display-mode=${displayMode}: <width>x<height>, digits only, e.g. 800x600.`;
  }
  if (chosen !== "provision-role.yml") {
    return `refusing --display-mode with --playbook=${chosen}: only provision-role.yml pins the display. `
      + "Use `npm run fleet:provision -- --display-mode=800x600 --limit=a11y-worker-2`.";
  }
  if (!ONE_WORKER.test(limitFlag ?? "")) {
    return "refusing --display-mode without --limit=<one worker>: displayMode is a MUST_MATCH field, so an "
      + "off-pin mode across the fleet makes every worker inconsistent with every capture already taken, "
      + `and "${limitFlag ?? "(no --limit, i.e. the whole fleet)"}" is not one worker.`;
  }
  return null;
}

/**
 * The one `-e` that carries an operator's `--display-mode`, or the empty string when none was given.
 *
 * A JSON `-e`, not `key=value`, because `worker_display_mode` is a DICT -- `display.yml` reads
 * `worker_display_mode.width` and `.height` -- and ansible has no command-line spelling for one key of a
 * dict. Single-quoted because this string is assembled into a command that a REMOTE shell parses; the
 * JSON's braces and double quotes are inert inside single quotes, and `DISPLAY_MODE_PATTERN` has already
 * guaranteed the interpolated halves are digits, so no value reaching here can close that quote.
 *
 * @param {string | undefined} displayMode a value that has passed `displayModeRefusal`
 * @returns {string} the argv fragment, leading space included, or ""
 */
function displayModeExtraVars(displayMode: string | undefined): string {
  const match = DISPLAY_MODE_PATTERN.exec(displayMode ?? "");
  if (!match) return "";
  return ` -e '{"worker_display_mode":{"width":${match[1]},"height":${match[2]}}}'`;
}

/**
 * #1084: THE PINNED WINDOWS BUILD, READ FROM THE INVENTORY AND NEVER RESTATED HERE.
 *
 * The OS is a capture-cache key, so a box on a different build is a box producing evidence that must not
 * blend with the rest. Writing the build into this file would make it a SECOND COPY of the value that
 * keys the cache — the fact-stated-twice defect on the one value where it costs a corpus.
 *
 * **MEASURED 2026-09-12: THE INVENTORY DECLARES NO PIN YET** (`31611ef4`). That is why `null` is a state
 * with its own name below rather than a falsy nothing: a guard that reads an absent key and concludes
 * "nothing to compare" is off, silently, in exactly the fleet it was written for.
 *
 * Read as TEXT rather than through a YAML parser, matching `inventoryHosts` in `fleet-discover.ts` —
 * half the value of `inventory.yml` is its comments, and a round-trip loses them.
 *
 * A TRAILING COMMENT IS PART OF THE DECLARATION, NOT A DIFFERENT LINE — worker-judge reviewing #1091.
 * The first version required end-of-line after the value, so
 * `windows_build: "<build>"  # the pin, #921` read as **no pin at all** and fell through to the branch
 * that deliberately does not refuse: a pinned fleet would compare nothing while the notice said the file
 * declares no pin, which is false about the file. **And the notice is an instruction**, so it would send
 * somebody to add a key that is already there. The natural way anyone records a pinned OS build is with
 * the reason beside it — it is the one value whose *why* costs a corpus — and this function's own
 * argument for text-parsing is that the comments are half the point.
 *
 * SCOPED TO THE WORKER GROUP, because the message says it is. A `windows_build` under `a11y_lab`, or on
 * one host, read as the fleet pin; with `/m` and `exec` the tiebreak was FILE ORDER. `groupPerLine` is
 * imported rather than re-derived — `fleet-discover.ts` made the same call for the same reason, and a
 * second group parser there is what once reported the lab container as a fifth worker. `WORKER_GROUP` is
 * likewise not restated.
 *
 *
 * @returns {string | null} the declared build, or null when the WORKER GROUP declares none
 */
export function pinnedBuild(inventoryText: string): string | null {
  const groups = groupPerLine(inventoryText);
  for (const [index, line] of inventoryText.split(/\r?\n/).entries()) {
    if (groups[index] !== WORKER_GROUP) continue;
    // The value, then optionally a comment. A line whose `#` comes FIRST is a commented-out declaration
    // and matches nothing — which is the mirror trap, and the reason a comment is allowed only AFTER.
    const found = /^\s*windows_build\s*:\s*["']?([0-9][0-9.]*)["']?\s*(?:#.*)?$/.exec(line);
    if (found) return found[1];
  }
  return null;
}

/**
 * The build out of a guest's reported `windowsVersion` -- the trailing `<major>.<minor>.<build>` of a
 * string like `Microsoft Windows 11 Pro <build>`. **No real build is written here, in code OR in this
 * comment:** a value in a doc example is a copy a reader takes as authoritative, and this file must
 * state the pin nowhere.
 *
 * Returns null rather than a guess when there is no build-shaped token: an unparseable reading is "could
 * not ask", not "a different build", and those are the two this row exists to keep apart.
 */
export function buildOf(windowsVersion: string | null | undefined): string | null {
  const found = /\b([0-9]+\.[0-9]+\.[0-9]+)\b/.exec(windowsVersion ?? "");
  return found ? found[1] : null;
}

/**
 * #1084: EVERY GUEST SORTED INTO THE THREE STATES THIS ROW EXISTS TO KEEP APART.
 *
 * `compliant` — its build equals the pin.
 * `drifted`   — it reported a build and the build is not the pin. **Named for a REBUILD**, because
 *               `fleet:provision` installs the ROLE and not the OS: a line saying a box is "now
 *               compliant" would be a claim provisioning cannot make true.
 * `unreadable` — it reported no build we could parse. **"Could not ask" is not "the answer is no"**, and
 *               this repo has paid for that distinction more than once; folding these into `drifted`
 *               would send somebody to rebuild a box that may be fine, and into `compliant` would hide
 *               the box that is not.
 */
export function buildStates(guests: { name: string; windowsVersion?: string | null; }[], pinned: string): { compliant: string[]; drifted: { name: string; build: string; }[]; unreadable: string[]; } {
  const states: { compliant: string[]; drifted: { name: string; build: string; }[]; unreadable: string[]; } = { compliant: [], drifted: [], unreadable: [] };
  for (const guest of guests) {
    const build = buildOf(guest.windowsVersion);
    if (build === null) states.unreadable.push(guest.name);
    else if (build === pinned) states.compliant.push(guest.name);
    else states.drifted.push({ name: guest.name, build });
  }
  return states;
}

/**
 * #1084: THE REFUSAL `fleet:provision` PRINTS, or null when there is nothing to say.
 *
 * A WARNING IS NOT THE ACCEPTANCE. The pin is a MUST_MATCH cache key and `provisionRevision`'s own design
 * is that a canary box IS the failure mode — so a mismatch refuses, and the message names the box and
 * BOTH builds, because "a box has drifted" without the two values is not something anybody can act on.
 *
 * **AN UNDECLARED PIN IS A FOURTH STATE AND IT DOES NOT REFUSE — today, deliberately.** Provisioning is
 * how a drifted fleet gets its role back, so a guard that refuses every run until somebody edits a file
 * on the control plane bricks the repair path. It is loud on every run instead, and it names the key to
 * add. #1084 carries the decision; the day the pin lands, this branch stops being reachable.
 *
 * **NOTHING CALLS THIS YET, AND SAYING SO IS THE POINT.** The comparison is pure and testable here; the
 * call site needs each guest's `/health` reading, which lives in `fleet-status.ts` and not in the
 * playbook runner. **That wiring is #921's half** — the row this was split out of, whose acceptance is a
 * run against the real fleet. A function that is perfect and never reached is the defect this repository
 * has hit three times in a week, so the unwired surface is named rather than left for a reviewer to find.
 */
export function buildAssertion({ guests, pinned }: { guests: { name: string; windowsVersion?: string | null; }[]; pinned: string | null; }): { refusal: string | null; notice: string | null; } {
  if (pinned === null) {
    return { refusal: null, notice: "NO PINNED IMAGE: `inventory.yml` declares no `windows_build` for "
      + "`a11y_workers`, so this run compared nothing. The OS is a capture-cache key and an unpinned "
      + "fleet cannot be checked against it -- add `windows_build: \"<build>\"` to the group's vars. "
      + "NOT a clean result: no comparison was made." };
  }
  const { compliant, drifted, unreadable } = buildStates(guests, pinned);
  // THE CENSUS IS ALWAYS PRINTED, whatever the verdict. "No box drifted" and "no box was asked" are
  // different facts and a bare clean verdict spells them the same -- this repo's own rule about a count
  // that cannot say what it examined.
  const census = `build vs pinned ${pinned}: ${compliant.length} on the pin, ${drifted.length} drifted, `
    + `${unreadable.length} unreadable, of ${guests.length} asked.`;
  const unread = unreadable.length === 0 ? null
    : `COULD NOT READ the build of ${unreadable.join(", ")} -- neither compliant nor drifted, and not `
      + "evidence either way. Ask those boxes before concluding anything about them.";
  if (drifted.length === 0) {
    return { refusal: null, notice: unread === null ? census : `${census}\n${unread}` };
  }
  const these = drifted.length === 1 ? "this box" : "these boxes";
  const named = drifted.map(({ name, build }) => `${name} is on ${build}`).join(", ");
  const refusal = `REFUSING: ${named}, and the pinned image is ${pinned}. The OS is a capture-cache key, `
    + `so ${these} ${drifted.length === 1 ? "is" : "are"} producing evidence that must not blend with the `
    + `rest. THE REPAIR IS A REBUILD (PXE + autounattend.xml): \`fleet:provision\` installs the ROLE, not `
    + `the OS, so it cannot make ${these} compliant and does not claim to.\n${census}`;
  return { refusal: unread === null ? refusal : `${refusal}\n${unread}`, notice: null };
}

/**
 * #1204: THE GUESTS' BUILDS, OUT OF WHAT `/health` REPORTED. Pure, so the extraction is testable without
 * a fleet -- the probes are passed in.
 *
 * A probe that did not reach the box yields `windowsVersion: null`, which `buildStates` classes as
 * UNREADABLE rather than as agreement. *"I could not ask"* and *"it matches"* must not collapse, and the
 * place they would collapse is here, in the mapping -- a missing field read as an empty string would land
 * in `compliant` and report a box nobody reached as on the pin.
 */
export function guestBuilds(probes: { name: string; health?: WorkerHealth; }[]): { name: string; windowsVersion: string | null; }[] {
  return probes.map((p) => ({
    name: p.name,
    windowsVersion: (p.health?.environment?.windowsVersion as string | undefined) ?? null,
  }));
}

/**
 * #1204: WHETHER THIS RUN IS GATED ON THE BUILD PIN, AND WHAT IT PRINTS. Pure and injected.
 *
 * #1084 built `buildAssertion` and its own header said the quiet part: **"NOTHING CALLS THIS YET, AND
 * SAYING SO IS THE POINT … A function that is perfect and never reached is the defect this repository
 * has hit three times in a week."** This is the call.
 *
 * SCOPED TO THE PROVISIONING PLAYBOOK, not applied to every run. `deploy.yml` pulls code onto boxes that
 * already exist and `recover.yml` acts on a box that is already wedged -- refusing those on a build
 * mismatch would block the repair paths, which is the same trade `fleet:deploy`'s own busy-worker guard
 * makes in the other direction. The pin is about what a box PRODUCES, and provisioning is when a box
 * joins the fleet that produces it.
 */
export function buildGate({ chosen, inventoryText, guests }: {
        chosen: string; inventoryText: string;
        guests: { name: string; windowsVersion?: string | null; }[];
    }): { refusal: string | null; notice: string | null; } {
  if (chosen !== "provision-role.yml") return { refusal: null, notice: null };
  return buildAssertion({ guests, pinned: pinnedBuild(inventoryText) });
}

/**
 * Ansible host patterns this may target, by SHAPE. Same containment as the playbook list, and needed for
 * the same reason: `--limit` reaches a shell on the box holding the fleet key. Worker names and the group
 * name, nothing else — `all` is not special-cased because omitting the flag already means all.
 */
const LIMIT_PATTERN = /^(a11y-worker-[0-9]{1,3})(,a11y-worker-[0-9]{1,3})*$|^a11y_workers$/;

/**
 * How many boxes a provisioning run touches at once. `0` means all of them.
 *
 * A plain small integer, contained by SHAPE like everything else that reaches a shell on the box holding
 * the fleet key. `serial: 1` is the default and its only remaining justification is fail-fast on a role
 * you have just changed — the availability argument died when `provision-role.yml` gained a refusal for a
 * worker mid-capture, which is the thing serialising was standing in for.
 */
const SERIAL_PATTERN = /^(0|[1-9][0-9]?)$/;

/**
 * A commit or a simple branch name, and nothing else.
 *
 * This value is interpolated into a command a remote shell interprets — ssh joins its arguments into one
 * string whatever you pass — so it is the one place a shell metacharacter could reach the box holding the
 * fleet key. Containment by SHAPE, the same rule `isValidCaptureId` follows: `;rm -rf /` is inexpressible
 * rather than rejected.
 */
function validRef(ref: string) {
  return /^[0-9a-zA-Z._/-]{1,64}$/.test(ref) && !ref.includes("..");
}

/**
 * How long each playbook may take, because 30 minutes is not one number that fits all of them.
 *
 * `deploy.yml` is a pull and a restart per box. `provision-role.yml` INSTALLS NVDA and an Edge MSI, one
 * box at a time (`serial: 1`), so five boxes is five sequential installs — comfortably past 30 minutes, and
 * a killed SSH mid-provision leaves a box half-configured with a stamp that may or may not have been
 * written. That is the worst state to be in, because `fleet:status` would then report INCONSISTENT and
 * the cause would look like a provisioning bug rather than a timeout.
 *
 * The budget is a CEILING, not a cost: a deadline that expires early turns "still working" into "failed",
 * which is the rule `run-interactive.yml` and `run-job.yml` already state.
 */
/**
 * Per-playbook ceilings; anything absent takes the default below.
 *
 * `Record<string, number>` and not the inferred one-key object: a lookup keyed by the CHOSEN playbook is
 * the whole point, and the inferred type made every other playbook name a type error at the lookup while
 * the runtime happily returned undefined and fell through to the default.
 */
// `os-rollback.yml`: a Windows rollback runs inside a restart that can take the better part of an hour, and
// the play waits for it (`win_reboot`'s own ceiling is 90 minutes), so the default would kill a working one.
const PLAYBOOK_TIMEOUT_MS: Record<string, number> = { "provision-role.yml": 4 * 60 * 60 * 1000, "os-rollback.yml": 2 * 60 * 60 * 1000,
  // One box at a time, each installing and rebooting (#4446): the same budget as the role, which is the other play that walks the fleet.
  "patch.yml": 4 * 60 * 60 * 1000 };
const DEFAULT_PLAYBOOK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * ONE SSH TO THE CONTROL PLANE, at THIS file's own default timeout -- `sshToControlPlane`
 * (`control-plane-fleet.ts`, #1356) is the shared transport every operator-host reader now uses, and
 * this is the thin wrapper that keeps THIS file's own long-running calls (a provision, a checkout move)
 * at their existing 30-minute default rather than the shared module's short, read-a-file-sized one.
 * `onTheControlPlane`'s local-shortcut and the key/host resolution live in the shared module now; this
 * wrapper adds nothing but the default.
 */
function ssh(command: string, { capture = false, timeoutMs = DEFAULT_PLAYBOOK_TIMEOUT_MS }: { capture?: boolean; timeoutMs?: number; } = {}) {
  return sshToControlPlane(command, { capture, timeoutMs });
}

/**
 * The current BRANCH, not the commit, and that distinction is load-bearing.
 *
 * `deploy.yml` fast-forwards each guest with `git merge --ff-only origin/{{ a11y_git_ref }}`, so the ref
 * has to be something `origin/<ref>` resolves to. A commit does not: this repo has already spent a run on
 * `-e ref=<sha>` becoming an unresolvable `origin/<sha>`, and two of the uses had `failed_when: false`, so
 * the empty read was taken for a zero.
 */
/**
 * #971: what a revision resolves to in THIS checkout, or `null` when it does not resolve at all.
 *
 * `null` rather than a throw, because a missing `origin/<ref>` is a state the caller decides about, not an
 * error to unwind on -- and rather than the empty string, because `""` compares falsy-equal to too many
 * things and this value is compared for EQUALITY with another SHA.
 */
function resolveOrNull(rev: string): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
      { encoding: "utf8", env: sandboxGitEnv() }).trim();
    return sha === "" ? null : sha;
  } catch {
    // `rev-parse --verify --quiet` exits 1 on an unresolvable revision, which is the ANSWER here rather
    // than a failure -- and swallowing it is safe only because the answer is `null`, which this file's
    // callers refuse rather than treat as agreement.
    return null;
  }
}

function localBranch() {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", env: sandboxGitEnv() }).trim();
}

// audit §9 "argv parsing": was its own copy of the fifteen-file idiom, now the shared, tested extractor.
const argOf = (name: string) => flagValue(process.argv, name);

/**
 * Every argument, validated, or a refusal that names which one and what shape it wanted.
 *
 * Extracted from `main` because it grew past the complexity gate as flags were added — and the gate was
 * right: dispatching a playbook and deciding whether the arguments are safe are two things, and each of
 * these refusals exists because the value reaches a shell on the box holding the fleet SSH key.
 */
function parseArgs(): {
    chosen: string; limitFlag: string | undefined; serialFlag: string | undefined; ref: string;
    allowEdgeDowngrade: boolean; apply: boolean; displayMode: string | undefined;
    layerCommits: Record<string, string>; publishedWorkerDir: string | null;
} {
  const refuse = (message: string) => {
    process.stderr.write(`${message}\n`);
    process.exit(2);
  };

  const chosen = argOf("playbook") ?? "deploy.yml";
  if (!PLAYBOOKS.includes(chosen)) refuse(`refusing --playbook=${chosen}: one of ${PLAYBOOKS.join(", ")}.`);

  const limitFlag = argOf("limit");
  if (limitFlag !== undefined && !LIMIT_PATTERN.test(limitFlag)) {
    refuse(`refusing --limit=${limitFlag}: worker names only, e.g. a11y-worker-3,a11y-worker-4.`);
  }

  const serialFlag = argOf("serial");
  if (serialFlag !== undefined && !SERIAL_PATTERN.test(serialFlag)) {
    refuse(`refusing --serial=${serialFlag}: 0 (all at once) or 1-99.`);
  }

  // Lifts `edge-version.yml`'s refusal for a box that has drifted PAST the pin, installing the pinned MSI
  // with Microsoft's supported ALLOWDOWNGRADE=1. Opt-in because it moves a working box to an older browser.
  const allowEdgeDowngrade = process.argv.includes("--allow-edge-downgrade");
  // The same refusal `--serial=` makes, for the same reason: the operator asked for something, watched a
  // different thing happen, and nothing said so. Only the role can act on this.
  if (allowEdgeDowngrade && chosen !== "provision-role.yml") {
    refuse("refusing --allow-edge-downgrade: only provision-role.yml installs Edge. "
      + "Use `npm run fleet:provision -- --allow-edge-downgrade`.");
  }
  // Silently ignoring it would be worse than refusing: the operator asked for a batch size, watched
  // something else happen, and nothing said so.
  if (serialFlag !== undefined && chosen !== "provision-role.yml") {
    refuse(`refusing --serial with --playbook=${chosen}: only provision-role.yml batches.`);
  }

  const apply = process.argv.includes("--apply");
  const osRefusal = osRollbackRefusal({ chosen, limitFlag, apply });
  if (osRefusal) refuse(osRefusal);
  // Every refusal this flag needs lives in one place, so the shape check, the playbook check and the
  // one-worker check cannot drift apart or be reached in a different order from the test's.
  const displayMode = argOf("display-mode");
  const displayModeIssue = displayModeRefusal({ chosen, limitFlag, displayMode });
  if (displayModeIssue) refuse(displayModeIssue);
  const ref = argOf("ref") ?? localBranch();
  if (!validRef(ref)) refuse(`refusing --ref=${ref}: a commit or simple branch name only.`);
  const { layerCommits, publishedWorkerDir } = layerCommitsOrRefuse({ chosen, refuse });

  return { chosen, limitFlag, serialFlag, ref, allowEdgeDowngrade, apply, displayMode, layerCommits, publishedWorkerDir };
}

/**
 * THE DECISION, pure -- given the local version, the resolved fleet (or its own refusal), and what those
 * workers serve. `guardProtocolChange` below is this plus the real reads, the real health probe, and the
 * exit, matching `linkGateFor`/`enforceLinkGate`'s own split (#1343).
 *
 * #1356: `fleet.refusal` -- no source, unparseable, or unreachable -- is reported in ITS OWN words and
 * refuses BEFORE `protocolVerdict` ever runs, never falling through to "no worker answered /health": that
 * message implies the fleet went quiet, when a checkout with no control-plane inventory never had an
 * address to try in the first place. Could not ask is not may proceed.
 */
export function protocolGuardVerdict({ chosen, local, fleet, served, allowed }: {
        chosen: string; local: string | null;
        fleet: { workers: { name: string; url: string; }[]; refusal: string | null; };
        served: { worker: string; protocol: string | number | null; }[]; allowed: boolean;
    }): { refuse: boolean; message: string; } {
  if (fleet.refusal) {
    return { refuse: true, message: `REFUSING ${chosen}: could not learn which boxes this deploy will `
      + `touch -- ${fleet.refusal}. Could not ask is not may proceed.` };
  }
  const verdict = protocolVerdict({ local, served, allowed, source: PROTOCOL_VERSION_FILE });
  if (!verdict.message) return { refuse: verdict.refuse, message: "" };
  return { refuse: verdict.refuse,
    message: `${verdict.message}  asked ${fleet.workers.length} worker(s) from the control plane's inventory.` };
}

/** The first of `paths` that reads; ENOENT on the last is rethrown, any other failure at once. */
function readFirstPresent(readFile: (path: string, encoding: "utf8") => string, paths: string[]): string {
  for (const path of paths.slice(0, -1)) {
    try { return readFile(path, "utf8"); } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    }
  }
  return readFile(paths[paths.length - 1], "utf8");
}

/**
 * THE PROTOCOL VERSION THIS CHECKOUT WOULD DEPLOY, read from the operator's own clone of the worker layer, or
 * the refusal to print when there is no clone to read (#3761).
 *
 * The layer left this repository in #3447, so a primary checkout holds at most a `node_modules` where
 * `packages/nvda-worker/src` used to be, and the read died with an `ENOENT` stack that named neither the layer
 * nor the remedy. A missing clone is the ONE absence refused here; any other failure (permissions, say) is
 * rethrown, because "could not read" is not "there is no clone".
 *
 * READ AS TEXT, NEVER IMPORTED. `capture-core.mjs` imports guidepup, which throws
 * `No available supported screen readers` at import on any host without one — and on a Mac VoiceOver
 * makes that throw invisible, which is exactly why `deploy-worker.mjs` carries the same warning and why
 * `no-win32-imports.test.ts` had to find it. A control-plane script must not depend on the operator's
 * machine having a screen reader. `code-version` is a safe subpath; the version itself is a regex.
 *
 * The clone is NOT checked against the pin (`--layer-ref`): this answers "what does my clone say", as the
 * guard did when the layer lived in the core.
 *
 * @param {{ readFile?: (path: string, encoding: "utf8") => string,
 *           declaration?: typeof layerDeclaration }} [deps] injectable, like `guardProtocolChange`'s `readFleet`
 */
export function readLocalProtocol({ readFile = readFileSync, declaration = layerDeclaration, publishedDir = null }: {
    readFile?: (path: string, encoding: "utf8") => string;
    declaration?: typeof layerDeclaration;
    publishedDir?: string | null;
} = {}): { local: string | null; refusal: string | null; } {
  if (publishedDir !== null) return readPublishedProtocol({ readFile, publishedDir });
  const { name, path, remote, dir } = declaration("nvda-worker");
  try {
    const text = readFirstPresent(readFile, PROTOCOL_VERSION_FILES.map((file) => resolve(dir, "src", file)));
    return { local: /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(text)?.[1] ?? null, refusal: null };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    return { local: null, refusal: `the worker layer "${name}" is not checked out at ${path}, so this checkout `
      + `cannot say which protocol the deploy would put on the workers (${dir}/src/ holds none of ${PROTOCOL_VERSION_FILES.join(", ")}`
      + `). Its repository is ${remote ?? "inside this checkout (deploy-pins.json declares no remote)"}; `
      + "git refuses a non-empty destination, so move aside anything left at that path first (a primary checkout "
      + `keeps a node_modules there); then create the clone with: git clone ${remote ?? "<its repository>"} ${dir}` };
  }
}

/** Where the published worker keeps the protocol version: `dist/`, built from the `src` file `PROTOCOL_VERSION_FILE` names. */
const PUBLISHED_PROTOCOL_FILE = "dist/protocol-version.mjs";

/**
 * THE PROTOCOL THE PUBLISHED WORKER WOULD PUT ON THE FLEET (#5085): read as text from the package `stagePublished` unpacked after its
 * tarball matched the pin, so the answer is the pinned release's and no clone's. A package that does not hold the file, or whose
 * file says no version, is a REFUSAL: "could not read" is never "no change".
 */
function readPublishedProtocol({ readFile, publishedDir }: { readFile: (path: string, encoding: "utf8") => string; publishedDir: string; }): { local: string | null; refusal: string | null; } {
  const file = resolve(publishedDir, PUBLISHED_PROTOCOL_FILE);
  try {
    const local = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(readFile(file, "utf8"))?.[1] ?? null;
    return local === null
      ? { local, refusal: `${file} names no CAPTURE_PROTOCOL_VERSION, so the published worker cannot say which protocol the deploy would put on the workers` }
      : { local, refusal: null };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    return { local: null, refusal: `the published worker holds no ${PUBLISHED_PROTOCOL_FILE} (${file}), so it cannot say which protocol the deploy would put on the workers` };
  }
}

/**
 * Would this deploy change the protocol the fleet is serving? — asked BEFORE anything is pushed.
 *
 * Only `deploy.yml` ships worker code. `sleep.yml` and `provision-role.yml` cannot move
 * `CAPTURE_PROTOCOL_VERSION`, so gating them would be a guard that fires where the risk is not.
 *
 * Read from the layer's clone rather than restated here: the version lives beside the capture code,
 * and a second copy of "what the current protocol is" is precisely the fact-stated-twice shape.
 *
 * #1356: `readFleet` is INJECTABLE, defaulting to the real `readControlPlaneFleet` -- called lazily,
 * inside the body, after the `chosen !== "deploy.yml"` early return, so every OTHER playbook does not pay
 * for a control-plane ssh round trip it never needed. A test drives this with a fake `readFleet` returning
 * either `{ workers, refusal: null }` or a refusal, the same shape `linkGateFor` already tests with
 * injected reads (#1343).
 *
 * #3761: `readLocal` and `exit` are injectable for the same reason. A missing clone refuses (exit 3, the
 * guard's own refusal code) BEFORE `readFleet`, so a checkout with nothing to compare never pays an ssh round trip.
 *
 * @param {string} chosen the playbook about to run
 *
 * @returns {Promise<void>} resolves if the deploy may proceed; exits the process if not
 */
export async function guardProtocolChange(chosen: string,
  { readFleet = readControlPlaneFleet, readLocal = readLocalProtocol, exit = process.exit }: {
      readFleet?: () => { workers: { name: string; url: string; }[]; refusal: string | null; };
      readLocal?: typeof readLocalProtocol; exit?: (code: number) => void;
  } = {}): Promise<void> {
  if (chosen !== "deploy.yml") return;
  const { local, refusal } = readLocal();
  if (refusal) {
    process.stdout.write(`REFUSING ${chosen}: ${refusal}\n`);
    return exit(PROTOCOL_REFUSAL_EXIT_CODE);
  }
  // THE CONTROL PLANE'S OWN INVENTORY, DIRECTLY — deliberately not `resolveWorkerPool`, and this is the
  // one place that is right. That resolver answers "which workers should I use", and honours
  // `A11Y_WORKER(S)` first because naming workers means you are managing them. This guard asks a different
  // question: "am I about to change the protocol on the machines THIS DEPLOY WILL TOUCH", and Ansible
  // takes its hosts from the control plane's inventory regardless of anything in the environment. An env
  // var left set would point the guard at machines the deploy is not going to reach, and pass.
  //
  // #1356: NEVER a checkout's own `inventory.yml` — gitignored, and absent on the operator host that
  // actually drives the fleet.
  const fleet = readFleet();
  const served = fleet.refusal ? [] : await servedProtocols(fleet.workers.map((w) => w.url));
  const verdict = protocolGuardVerdict({
    chosen, local, fleet, served, allowed: process.argv.includes("--allow-protocol-change"),
  });
  if (verdict.message) process.stdout.write(`${verdict.message}\n`);
  if (verdict.refuse) exit(PROTOCOL_REFUSAL_EXIT_CODE);
}

/**
 * Does this playbook declare itself a control-plane BOOTSTRAP?
 *
 * The marker lives in the playbook (`# a11y_bootstrap: true`) rather than in a list here, so a second one
 * cannot acquire the exception by being added to an array nobody re-argues. `bootstrap-playbooks-are-
 * declared.test.ts` discovers every carrier and refuses one that also targets `a11y_workers` or
 * `control_plane` — groups that come from the very file a bootstrap installs.
 */
export function declaresBootstrap(chosen: string, read = readFileSync): boolean {
  try {
    return /^#\s*a11y_bootstrap:\s*true\s*$/m.test(String(read(`${ANSIBLE_DIR}/${chosen}`, "utf8")));
  } catch {
    return false;
  }
}

/**
 * Run a bootstrap playbook from THIS machine, with the control plane named on the command line.
 *
 * A bootstrap step must depend on nothing it is bootstrapping, and `inventory-install.yml` found both ways
 * that can fail, in order: `hosts: control_plane` needs the inventory it installs to resolve its target,
 * and `hosts: localhost` under the unit-based path means the control plane — where the source file is
 * missing, which is the incident. `-i '<host>,'` takes the target from argv and the source from here.
 */
function runBootstrapFromHere(chosen: string): void {
  process.stdout.write(`  running ${chosen} FROM THIS MACHINE against ${CONTROL_PLANE}\n`
    + "  (it declares `a11y_bootstrap`, and a bootstrap cannot run on what it bootstraps)\n\n");
  // `root@`, and the bare host is not enough. Ansible defaults an unqualified `-i '<host>,'` to the LOCAL
  // username, so it tried `danielbeck@` and got `Permission denied (publickey)` — a credentials failure
  // that reads like a missing key rather than a wrong user. Everything else in this file already reaches
  // the control plane as root (`ssh()` builds `root@${CONTROL_PLANE}`); this is the same fact, and it has
  // to be stated again because `-i` does not inherit it.
  // AND THE KEY. `ssh()` twenty lines up passes `-i requireControlPlaneKey()` explicitly, because the control plane is
  // a separate credential domain (ADR 0012) and the operator's default identity does not open it. Ansible
  // has its own name for the same thing, so the fact is stated a third time in a third spelling —
  // `root@` in the host, `--private-key` here — and neither inherits from the other.
  //
  // Without it: `root@<host>: Permission denied (publickey,password)`, which reads as a MISSING key rather
  // than an unpassed one. The key is present and correct; nothing asked for it.
  const result = spawnSync("ansible-playbook",
    ["-i", `root@${CONTROL_PLANE},`, "--private-key", requireControlPlaneKey(), chosen],
    { cwd: ANSIBLE_DIR, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`\n  could not run ansible-playbook here: ${result.error.message}\n`);
    process.exit(2);
  }
  if (result.status !== 0) {
    process.stderr.write(`\n  ${chosen} FAILED (ansible exit ${result.status}); its output is above.\n`);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`\n  ${chosen} completed.\n`);
}

/**
 * THE FLEET LOCK STEPS (a11ign#5014, #4405 item 2). `deploy.yml`, `provision-role.yml` and `patch.yml` -- the plays that walk
 * the whole fleet and are re-run in sequence when one box fails -- take `fleet-lock.ts`'s lock before their unit starts,
 * so auto-off keeps every box between attempts, which the unit alone cannot: a run that FAILS is `finished` to it.
 *
 * `longestRunMs` is the budget this command itself watches the unit for (`followBudgetMs`: `PLAYBOOK_TIMEOUT_MS[chosen]`,
 * the default for a play without one, and for `patch.yml` the larger per-box feature-update budget), so no run length is
 * copied here: a lock that expired under a run still being watched would be the lock failing at its one job.
 *
 * Returns the refusal, when a different operation's lock is fresh and not ended, and a notice for the operator otherwise.
 * `take` and `end` are injectable so a test supplies the control plane.
 *
 * A `wake` LOCK IS A KEEP, NOT A CLAIM (a11ign#5030, #4405 item 2). `fleet:wake` takes the lock for the boxes it woke so
 * the provision or patch typed next meets them awake; refusing that provision for the very lock that was taken to serve it
 * would defeat the lock. So a fresh `wake` lock is ENDED by its own holder's name and the take is made again: an ended
 * lock refuses nobody (`fleet-lock.ts`), and the second take is the one that decides, atomically, so two operations
 * starting together still have one winner. This stays here, and `fleet-lock.ts`'s take is not taught `wake`, because the
 * lock's refusal rule is the same for every operation and the exception belongs to the plays that may override a keep.
 */
export function lockTakeStep({ chosen, followBudgetMs, now, take = takeFleetLock, end = expireFleetLock }: {
  chosen: string; followBudgetMs: number; now: number; take?: typeof takeFleetLock; end?: typeof expireFleetLock;
}): { refusal: string | null; notice: string | null } {
  if (!FLEET_LOCK_PLAYBOOKS.includes(chosen)) return { refusal: null, notice: null };
  const takeAgain = () => take({ operation: chosen, longestRunMs: followBudgetMs, now });
  let outcome = takeAgain();
  let tookOver = false;
  // Bounded: a second wake landing between our end and our take is met by one more pass, and no more than that.
  for (let pass = 0; !outcome.taken && outcome.held.operation === WAKE_LOCK_OPERATION && pass < WAKE_TAKE_OVER_PASSES; pass += 1) {
    // `ended: false` (the lock is gone, or another wake's) needs no handling: the take below is what says who holds the fleet.
    end({ operation: outcome.held.operation, holder: outcome.held.holder, now });
    tookOver = true;
    outcome = takeAgain();
  }
  if (!outcome.taken) return { refusal: fleetLockRefusal({ held: outcome.held, wanted: chosen, now }), notice: null };
  const replaced = outcome.replacedUnreadable ? " (it replaced a fleet lock file that could not be read)" : "";
  const over = tookOver ? " (it took over the lock fleet:wake held for the boxes it woke)" : "";
  return { refusal: null, notice: `  fleet lock taken for ${chosen}${replaced}${over}: auto-off keeps every box until `
    + `${new Date(outcome.lock.expiresAt).toISOString()}, or ${LOCK_GRACE_MINUTES} min after this unit ends.\n` };
}

const WAKE_TAKE_OVER_PASSES = 2;

/**
 * The unit ended, on any exit: shorten the lock to its grace and mark it ended, never clear it, so the next attempt meets
 * awake boxes. It never turns a finished run into a failed one: a control plane that cannot be asked leaves the lock to
 * expire on its own, and says so (`failed`), because bookkeeping that cannot be written must not read as written.
 */
export function lockEndStep({ chosen, now, end = expireFleetLock }: {
  chosen: string; now: number; end?: typeof expireFleetLock;
}): { notice: string | null; failed: boolean } {
  if (!FLEET_LOCK_PLAYBOOKS.includes(chosen)) return { notice: null, failed: false };
  try {
    const ended = end({ operation: chosen, now });
    return ended.ended
      ? { notice: `  fleet lock for ${chosen} shortened: auto-off keeps every box for ${LOCK_GRACE_MINUTES} min more, then lets go.\n`, failed: false }
      : { notice: `  fleet lock: not shortened, it is no longer this run's (gone, or taken by another run of ${chosen}).\n`, failed: false };
  } catch (cause) {
    return { notice: `  fleet lock for ${chosen} NOT shortened (${cause instanceof Error ? cause.message : String(cause)}): `
      + "it expires on its own at its operation's longest run.\n", failed: true };
  }
}

function takeFleetLockOrExit({ chosen, followBudgetMs }: { chosen: string; followBudgetMs: number; }) {
  try {
    const step = lockTakeStep({ chosen, followBudgetMs, now: Date.now() });
    if (step.refusal) {
      process.stderr.write(`${step.refusal}\n`);
      process.exit(2);
    }
    if (step.notice) process.stdout.write(step.notice);
  } catch (cause) {
    process.stderr.write(`\n  ${chosen} NOT STARTED: the fleet lock could not be taken (${cause instanceof Error ? cause.message : String(cause)}), `
      + "and a run that auto-off may power the boxes out from under is not started.\n");
    process.exit(1);
  }
}

function endFleetLock(chosen: string) {
  const { notice, failed } = lockEndStep({ chosen, now: Date.now() });
  if (notice) (failed ? process.stderr : process.stdout).write(notice);
}

/**
 * THE PLAYS WHOSE GUEST CHECKOUT IS THE CORE'S, NOT CONTROL'S (#5512). `ref` and `expected` are resolved in THIS repository
 * (control), and a guest's `a11y-witness` checkout is a clone of the core, whose history holds no control commit: asked to
 * `merge --ff-only` one, `provision-role.yml` failed inside a one-shell script whose exit status was its last command's, and
 * all 15 boxes said `provisioning from 5fcf95e0a` while sitting on a checkout five days stale (read 2026-10-15).
 *
 * So a play that fast-forwards the CORE is never handed a control commit. Until #5515 it was handed nothing, and the guest
 * resolved its own `origin/main`, which moves while a `--serial` run is in flight. Now both core plays are handed the core commit
 * `deploy-pins.json` declares, so every guest in a run lands on the same one (`deploy.yml` also gets `a11y_git_ref`, which it checks out first).
 */
const CORE_FAST_FORWARD_PLAYBOOKS = ["provision-role.yml"];

/** The `-e` pair a guest's core checkout is put on: the DECLARED core commit (#5515), and the ref only for a play that checks one out. */
export function guestCommitVars({ chosen, ref, core }: { chosen: string; ref: string; core: string; }): string {
  const expected = ` -e a11y_expected_commit=${core}`;
  return CORE_FAST_FORWARD_PLAYBOOKS.includes(chosen) ? expected : ` -e a11y_git_ref=${ref}${expected}`;
}

/** The core commit `deploy-pins.json` declares: read at the start of a run, and refused by name when it declares none. */
function declaredCoreCommit(): string {
  const { core } = readDeployPins();
  if (core === undefined) {
    process.stderr.write("deploy-pins.json declares no core commit, so there is no commit to put a guest's core checkout on (#5515).\n");
    process.exit(2);
  }
  return core.commit;
}

/**
 * What `startPlaybookUnit` reaches outside the process for, so a test can run it and read the command it built (#5515): the
 * ssh to the control plane, the fleet lock it takes, and the core pin it reads. The defaults are the real ones.
 */
export interface StartPlaybookDeps {
  ssh: (command: string, options?: { capture?: boolean; timeoutMs?: number }) => unknown;
  takeLock: (call: { chosen: string; followBudgetMs: number }) => void;
  declaredCore: () => string;
}
const REAL_START_DEPS: StartPlaybookDeps = { ssh, takeLock: takeFleetLockOrExit, declaredCore: declaredCoreCommit };

/**
 * The first WRITE to the control plane (#5515): it is put on the commit the run is for, and only after the guests' core pin has been
 * read, so a deploy that declares none refuses with the control plane untouched. The value is not kept: `startPlaybookUnit` reads the
 * pin again where it is used, so none travels between the two. A function of its own so a test can observe that the refusal comes
 * BEFORE the write, by what `ssh` was asked, rather than by where two lines sit in `main`.
 */
export function moveControlPlane({ ref, expected, layerCommits }: { ref: string; expected: string; layerCommits: Record<string, string>; },
  deps: Pick<StartPlaybookDeps, "ssh" | "declaredCore"> & PlaneRefusal = REAL_START_DEPS): void {
  deps.declaredCore();
  // #5556: the installed layers are READ here, in the function every run's first write goes through, so the order is observable by what `ssh` is asked.
  // #5155 follow-up: the one lag a frozen install repairs is repaired here, and the read is asked again after it before anything is written.
  const first = installedLayersReading(deps);
  const lagging = first.repairable ? installLayersAndReread(deps) : first.refusal;
  if (lagging) {
    (deps.refuse ?? refuseWithExit)(lagging);
    return;
  }
  deps.ssh(controlPlaneCheckout(ref, expected, layerCommits));
}

/** How a refusal is said and ended: the notes go to stderr and the run exits 2. A test replaces both, and `refuse` may throw. */
interface PlaneRefusal {
  say?: (line: string) => void;
  refuse?: (text: string) => never;
}
function refuseWithExit(text: string): never {
  process.stderr.write(`${text}\n`);
  return process.exit(2);
}

/**
 * The plane's installed layers against its own lockfile, asked by `moveControlPlane` BEFORE it writes, and only read (#5556). A merged pin bump reaches the
 * plane's HEAD by `git merge --ff-only` and nothing installs afterwards, so HEAD can hold a lockfile that `node_modules/` does not: the move's
 * own judgement then refuses AFTER the merge, spending the first write of a covered run on a fact one read could have named. Where the plane is
 * in that state this says both release numbers and that `pnpm install --frozen-lockfile` is the remedy, which is a write to the control plane
 * and is NOT made here. Returns the refusal to print, or null; notes are printed either way.
 */
export function installedLayersRefusal(deps: Pick<StartPlaybookDeps, "ssh"> & Pick<PlaneRefusal, "say"> = REAL_START_DEPS): string | null {
  return installedLayersReading(deps).refusal;
}

/** The read and its judgement together, so `moveControlPlane` can tell a repairable lag from a refusal (#5155). Notes are printed here. */
function installedLayersReading(deps: Pick<StartPlaybookDeps, "ssh"> & Pick<PlaneRefusal, "say">): ReturnType<typeof installedLayersJudged> {
  const manifest = manifestOf(readDeployPins());
  const read = String(deps.ssh(installedLayersRead(manifest), { capture: true }));
  const judged = installedLayersJudged(manifest, read);
  for (const note of judged.notes) (deps.say ?? ((line) => process.stderr.write(`${line}\n`)))(`  note: ${note}`);
  return judged;
}

/**
 * The repair (#5155): `pnpm install --frozen-lockfile` on the plane, for a lockfile that declares the release and a `node_modules/` that does not hold it.
 * It lays only what the tracked lockfile already names, and changes no tracked file. Returns the refusal after the install, or null once the layers agree:
 * an install that does not bring them into step is still a refusal, so nothing is written to the plane on a disagreement.
 */
function installLayersAndReread(deps: Pick<StartPlaybookDeps, "ssh"> & Pick<PlaneRefusal, "say">): string | null {
  process.stdout.write(`  installed layers lag the plane's lockfile: running pnpm install --frozen-lockfile in ${CHECKOUT} (lays only what the tracked lockfile names)\n`);
  deps.ssh(`cd ${CHECKOUT} && pnpm install --frozen-lockfile`);
  const again = installedLayersReading(deps).refusal;
  return again && `fleet:deploy ran pnpm install --frozen-lockfile in ${CHECKOUT} and the layers still disagree. ${again}`;
}

/**
 * Start the playbook on the control plane as a named systemd unit, and return that unit's name.
 *
 * A PHASE, not a name restating its code: "get it running somewhere it will survive me" is a distinct
 * step from "watch it and report what it did", and separating them is what lets `main` read as
 * resolve-ref -> verify-landed -> start -> follow. Extracted when the PHYSICAL-line budget refused
 * `main` at 92 lines — a check ESLint cannot make, since `skipComments: true` lets a comment-dense
 * function run to twice its 70-line lint budget.
 *
 * ONE OBJECT, not seven positionals — `max-params` is 4 here and the repo's rule is to bundle cohesive
 * arguments rather than raise the ceiling. These seven are one thing: what to deploy and how.
 *
 *
 *   `layerCommits` is the layers' half of the commit pair (#3395): `{ layer: sha }`, empty while none has its own repository.
 *   `aim` is where each MOVED worker is aimed this run, already identity-checked (#2832); empty for a healthy fleet.
 * @returns {string} the unit name
 */
export function startPlaybookUnit({ chosen, ref, limitFlag, serialFlag, allowEdgeDowngrade, apply,
  displayMode, layerCommits, aim, followBudgetMs }: {
        chosen: string; ref: string; limitFlag: string | undefined;
        serialFlag: string | undefined; allowEdgeDowngrade: boolean; apply: boolean;
        displayMode: string | undefined; layerCommits: Record<string, string>;
        aim: { addresses: Record<string, string>; workers: string[]; };
        followBudgetMs: number;
    }, deps: StartPlaybookDeps = REAL_START_DEPS): string {
  // The guests' core commit, read HERE where it is used (#5515): no value travels from `main` to this call, so there is no
  // call site that can hand a guest control's own commit. `main` still reads it first, for the refusal, before the control plane moves.
  const core = deps.declaredCore();
  // SUPERVISED, NOT FOREGROUND — and this is the whole reason a deploy can no longer be half-done.
//
// It used to be one synchronous `ssh ... ansible-playbook`, so the ten-machine reboot was only as
// durable as the terminal that started it. Measured 2026-09-05: the caller was killed 100 s in, ssh
// closed, ansible took SIGHUP mid-`Reboot`, and the fleet was left SPLIT — some boxes on the new code,
// one unreachable, no PLAY RECAP, and nothing anywhere recording that a deploy had been interrupted.
// The next capture refused with `10 stale worker(s)`, which is the safety net working one step too
// late: you learn from a job refusing rather than from the fleet saying so.
//
// `systemd-run --remain-after-exit` parents it to PID 1, exactly as `run-job.yml` does for lab jobs and
// `tailscale.yml` for the login — whose comment already states the rule this file did not follow: "the
// work must outlive the connection that started it".
//
// `--remain-after-exit` and NOT `--collect`, for the reason lab-job.test.ts pins: without it the exit
// code is discarded at the moment it matters. And the unit is stopped and `reset-failed` first, because
// `systemd-run` refuses a name that is still loaded — a SUCCEEDED run keeps its name just as a failed
// one does.
const unit = `a11y-fleet-${chosen.replace(/\.yml$/, "")}`;
deps.takeLock({ chosen, followBudgetMs }); // #5014: before the unit exists; exits 2 on a refusal and 1 if it cannot be written
// #2832: THE ADDRESS OVERRIDE, if any worker moved and was identified. `install` makes the per-unit file hold
// exactly this run's override or nothing, and a failure to write it ENDS the command (`|| exit 1`): a `;`
// after an `&&` chain would carry on and start the unit without the override it was meant to have.
const override = overrideUnitParts({ unit, aim,
  ansibleCfgText: readFileSync(resolve(ANSIBLE_DIR, "ansible.cfg"), "utf8") });
try {
  // `-e a11y_git_ref` is what the GUESTS fetch. Without it they default to `main` and stay exactly where
  // they were, while the control plane sits on the branch you asked for — so `expected_code` is computed
  // from your code and `served_code` from theirs, and the deploy fails with a mismatch that reads like a
  // corrupted guest checkout. Measured 2026-08-24: all four workers held 1f7cb7e88070235d against an
  // expected c6e66caa481b76c0, having faithfully fetched a branch nobody had changed.
  deps.ssh(`${override.install} || exit 1; systemctl stop ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null; `
    + planeUnitStart(unit)
    + `--setenv=ANSIBLE_CONFIG=ansible.cfg${override.setenv} `
    // NO `-i` HERE. `ansible.cfg` sets `inventory = /etc/a11ign/inventory.yml,inventory.yml` so the
    // durable copy is read FIRST -- and an explicit `-i` on the command line OVERRIDES that config
    // entirely, which made the whole outside-the-checkout fix inert on the one path that dispatches
    // everything.
    //
    // Measured 2026-09-06, minutes after installing and verifying the durable copy: `fleet:deploy` still
    // printed `Unable to parse .../packages/control/ansible/inventory.yml` and matched no hosts. The
    // config was correct, on main, and on the control plane -- and unread, because this line outranked it.
    //
    // I VERIFIED THAT CONFIG IN FOUR STATES WITH `ansible-inventory --list`, which READS the config. The
    // dispatch path does not. A verification that exercises a different invocation from the one that ships
    // is this repo's most-recorded defect, and it is the reason to remove the flag rather than to point it
    // at the new path: one source of truth, in the file every playbook already honours.
    // The CORE commit `deploy-pins.json` declares (#5515), not the one control's checkout resolves the ref to: control's
    // sha is not an object in the core's repository. Each guest asserts it landed on this one rather than inferring
    // success from a shell that exited 0. The 2026-08-24 note above fixed WHICH ref the guests fetch; this catches the
    // fetch silently not taking.
    + `ansible-playbook ${chosen}${guestCommitVars({ chosen, ref, core })}`
    // The pair's second half: each layer that lives in its own repository, pinned to ITS commit (#3395).
    + layerCommitsExtraVars(layerCommits)
    // The control-plane address ALREADY resolved above (env var or its installed file, #285), so
    // `control-host-install.yml` never has to read the environment itself -- it just records what got
    // used to reach this machine. Harmless for every other playbook, which does not read this var.
    + ` -e a11y_control_host=${CONTROL_PLANE}`
    + (limitFlag ? ` -l ${limitFlag}` : "")
    + (serialFlag !== undefined ? ` -e worker_provision_serial=${serialFlag}` : "")
    // A NAMED FLAG, because the obvious spelling silently did nothing. `-e worker_edge_allow_downgrade=true`
    // typed on this command is not forwarded — this wrapper builds ansible's argv itself and passes on
    // only what it recognises — and `refuseUnknownFlags` inspected only `--` arguments, so the whole
    // fleet was provisioned believing an authorisation had been given that never arrived. Both halves
    // are fixed; this is the half that gives the operator something real to type.
    + (allowEdgeDowngrade ? " -e worker_edge_allow_downgrade=true" : "")
    // The same NAMED-flag shape as the line above, for the same reason: `-e worker_display_mode=...`
    // typed here is not forwarded. This one is a dict rather than a scalar, so it goes as JSON --
    // `displayModeExtraVars` holds the quoting and the why.
    + displayModeExtraVars(displayMode)
    + (apply && chosen === "os-rollback.yml" ? " -e a11y_os_rollback_apply=true" : ""),
  { timeoutMs: PLAYBOOK_TIMEOUT_MS[chosen] ?? DEFAULT_PLAYBOOK_TIMEOUT_MS });
} catch (cause) {
  exitUnitFailedToStart(chosen, cause);
}
  return unit;
}

/**
 * `execFileSync` throws an Error carrying the child's exit status, which node's types do not describe. The status is what
 * this exists to surface AND to exit with, so it is load-bearing. A unit that never started holds nobody awake (#5014), so
 * the lock its start took is shortened to the grace first.
 */
function exitUnitFailedToStart(chosen: string, cause: unknown): never {
  const failure = (cause as { status?: number });
  process.stderr.write(`\n  ${chosen} FAILED TO START (exit ${failure.status ?? "?"}).\n`);
  endFleetLock(chosen);
  return process.exit(failure.status ?? 1);
}

/**
 * THE COMMAND THAT PUTS THE CONTROL PLANE ON THE COMMIT THIS OPERATOR ASKED FOR -- a SHA, never a name.
 *
 * #666. This used to end `git merge --ff-only origin/${ref}`, and the two sides of the deploy then
 * resolved the ref INDEPENDENTLY, at different instants: `expected` from the operator's local checkout,
 * `origin/<ref>` from a fetch the control plane performs seconds later. They are equal only when nothing
 * merged in between.
 *
 * That is not a rare race here, it is the DEFAULT PATH. `localBranch()` returns the literal string
 * `"HEAD"` on a detached checkout, and the primary checkout -- the one this command is meant to be run
 * from -- is detached by design and by hook. So the control plane fetches `origin/HEAD`, which is main's
 * tip NOW, and the read-back compares it to the operator's tip THEN.
 *
 * Measured 2026-09-09, with main merging every few minutes: three attempts, three failures, nine healthy
 * boxes throughout. The middle one is the one that names the shape -- `the control plane is on
 * 673ef5c7eb2b, not 68b2bedd9c6f` -- the control plane was NEWER than the operator's checkout, not older.
 * A staleness problem has a direction; this does not.
 *
 * `--ref=main` is not the fix and makes it worse: `expected` becomes the LOCAL `main` branch, which on a
 * machine with worktrees sits wherever the last worktree left it -- 11d77ade against an origin/main of
 * d2729386 on the day this was written. That is the `fleet:recover` trap CLAUDE.md already records.
 *
 * THE REF IS STILL A NAME IN THE CHECKOUT, because it has to be: a checkout of `<sha>` would leave the
 * control plane detached, and `localBranch()`'s own comment records what a bare SHA costs anything doing
 * `origin/<ref>`. The name selects the branch; the SHA decides where it lands. Only the second is
 * compared, and `--ff-only` still refuses anything that is not a fast-forward.
 *
 * This is CLAUDE.md's `lab:pipeline` rule -- "ONE ref, resolved once and given to both halves" -- reaching
 * a second pair of halves. The first pair was `fleet:deploy`'s `a11y_git_ref` and `lab:job`'s `ref`
 * defaulting independently, which put the fleet and the lab on different commits and read as a corrupted
 * guest checkout.
 *
 * THE CHECKOUT IS NOT A PARAMETER, and that is `control-plane-checkout-is-one-fact.test.ts`'s rule rather
 * than a style choice. Taking it as an argument made this site enter `${checkout}` -- a name that is
 * neither the source of truth's export nor a classified other directory -- and the guard failed it BY
 * NAME, which is exactly the distinction it exists to keep: "a different directory" and "somebody wrote a
 * second way to say this one" must never look alike. `CHECKOUT` is `CONTROL_PLANE_CHECKOUT`, aliased once,
 * at the top of this file. There is only one control plane checkout, so there is nothing to pass.
 *
 * THE PAIR REACHES THE CONTROL PLANE TOO (ADR 0039 item 6, row 6c, #3396). A layer that lives in its own
 * repository is a second checkout beside this one, and `layerCommits` is its half of the pair: each is put on
 * its pinned commit and compared with `rev-parse HEAD` in the same command, or the command fails. A checkout
 * that is absent refuses, naming the layer and the path, instead of the core's tree answering for it.
 *
 * @param {string} ref the branch name to be ON -- `HEAD` on a detached checkout, which is a no-op checkout
 * @param {string} expected the commit resolved ONCE, here, and the only thing the read-back compares
 * @param {Record<string, string>} [layerCommits] the layers' half of the pair, `{ layer: sha }`; empty while none has its own repository
 * @returns {string} the shell command to run on the control plane
 */
export function controlPlaneCheckout(ref: string, expected: string, layerCommits: Record<string, string> = {}): string {
  return `cd ${CHECKOUT} && git fetch --quiet --all && git checkout --quiet ${ref} `
    + `&& git merge --ff-only --quiet ${expected}${layerCheckoutMove(layerCommits)}`;
}

/**
 * REFUSE A REF THAT MEANS SOMETHING DIFFERENT HERE THAN IT DOES ON ORIGIN -- pure, over two SHAs (#971).
 *
 * `expected` is resolved with `git rev-parse <ref>` IN THIS CHECKOUT, and on a machine with worktrees a
 * local branch sits wherever the last worktree left it. Measured 2026-09-11: `primary:update` put the
 * local `main` on `f0d69cb7` at 05:44Z; by the deploy, `origin/main` was `25a5f680`. **The control plane
 * shipped `f0d69cb7` and the read-back passed** -- everything internally consistent and one merge stale.
 * `worker:code` found it afterwards as 10 of 10 STALE.
 *
 * The trap was already documented thirty lines up ("`--ref=main` is not the fix and makes it worse") and
 * nothing refused it. A fact recorded in a comment is a fact somebody has to remember, which is the same
 * sentence the SHA refusal below this one was written under.
 *
 * `origin === null` -- `origin/<ref>` does not resolve -- IS ALSO A REFUSAL, and deliberately so. "Could
 * not ask" answering "clear" is this repository's most expensive recurring shape, and it is the rule the
 * two guards either side of this one already follow (`requireCommitIsOnOrigin`'s empty answer is the
 * refusal; `armDecision`'s null labels are refused rather than read as unheld). It also fails EARLIER
 * than the alternative: the control plane's own `git checkout <ref>` would fail on a branch it does not
 * have, in git's words, naming neither the flag nor the reason.
 *
 * THE MESSAGE NAMES BOTH WAYS OUT rather than guessing which. A local tip that differs may be BEHIND
 * origin (deploy origin's tip: `primary:update`) or AHEAD of it (deploy your own commit: push it and name
 * its branch). Telling an operator to fast-forward when they meant to ship unpushed work is a refusal
 * that cannot be followed, and this file's neighbours already treat that as the defect rather than a
 * wording preference.
 *
 *
 * @returns {string | null} the refusal to print, or `null` when the two agree
 */
export function staleRefRefusal({ ref, local, origin }: { ref: string; local: string; origin: string | null; }): string | null {
  if (origin === local) return null;
  const short = (sha: string) => sha.slice(0, 12);
  if (origin === null) {
    return [
      `REFUSING: --ref=${ref} resolves to ${short(local)} here, and \`origin/${ref}\` does not resolve.`,
      "There is nothing to compare it against, and the control plane has no such branch to check out --",
      "its own `git checkout` would fail in git's words, naming neither the flag nor the reason.",
      "",
      `  Push the branch:   git push -u origin ${ref}`,
      "  Or name one origin already has:   --ref=main   (with `agent-org primary:update` run first)",
      "",
    ].join("\n");
  }
  // Both SHAs on their own line and COLUMN-ALIGNED, so the eye lands on the digits that differ rather than
  // on two 12-character strings buried in prose. `padEnd` to whichever label is longer, so it is the SHORT
  // one that moves -- computing a pad for one side only misaligns by the difference, which is how the
  // first version of this shipped and what its own test caught.
  const labels = ["  this checkout:", `  origin/${ref}:`];
  const column = Math.max(...labels.map((l) => l.length)) + 1;
  return [
    `REFUSING: --ref=${ref} means a DIFFERENT COMMIT here than on origin.`,
    `${labels[0].padEnd(column)}${short(local)}`,
    `${labels[1].padEnd(column)}${short(origin)}`,
    "",
    "Deploying would ship the local one and the read-back would PASS, because both halves of that check",
    "use the same stale SHA -- internally consistent and a merge behind. That is how 10 of 10 boxes went",
    "stale on 2026-09-11 with every check green.",
    "",
    "  To deploy origin's tip:      agent-org primary:update   (then re-run this)",
    "  To deploy your own commit:   push it, and pass --ref=<that branch>",
    "",
  ].join("\n");
}

/**
 * REFUSE A COMMIT THE CONTROL PLANE CANNOT FETCH, rather than letting `merge --ff-only` say it in git's
 * words. An operator on an unpushed commit is the ordinary case -- work in a worktree, deploy from the
 * primary -- and `fatal: not something we can merge` names neither the flag nor the reason, which is this
 * repo's own definition of a guard that gets distrusted and then bypassed.
 *
 * `git branch -r --contains` rather than a fetch of our own: the question is whether THIS checkout has
 * already seen the commit on a remote-tracking branch, which is the same thing the control plane's fetch
 * will find. An empty answer is the refusal; it is never read as a yes.
 */
function requireCommitIsOnOrigin(ref: string, expected: string) {
  const remotes = execFileSync("git", ["branch", "-r", "--contains", expected],
    { encoding: "utf8", env: sandboxGitEnv() }).trim();
  if (remotes) return;
  process.stderr.write([
    `REFUSING: ${expected.slice(0, 12)} (${ref}) is on no remote-tracking branch, so the control plane`,
    "cannot fetch it and the deploy would fail on a git message naming neither the flag nor the reason.",
    "  Push the commit first, or `agent-org primary:update` if you meant to deploy origin/main.",
    "",
  ].join("\n"));
  process.exit(2);
}

/**
 * #1204: `inventory.yml`'s text, or empty when there is none.
 *
 * **THE FILE IS NOT IN THE REPOSITORY** — it holds real host addresses, and `fleetToProbe` already wraps
 * its own read of it in a `try` for exactly this reason. A bare `readFileSync` here threw ENOENT on every
 * run, which I found by driving it rather than by reading: a crash, not a refusal, on the path this row
 * exists to make refuse.
 *
 * Empty text means `pinnedBuild` finds no pin, which `buildAssertion` already treats as a fourth state —
 * LOUD on every run and non-refusing, because provisioning is how a drifted fleet gets its role back and
 * a guard that blocks every run until somebody edits a control-plane file bricks the repair path. So the
 * absent-inventory case lands in a state that was already designed, rather than needing a new one.
 */
function inventoryTextOrEmpty(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url)), "utf8");
  } catch {
    // Not swallowed: the empty string routes to `buildAssertion`'s NO PINNED IMAGE notice, which says on
    // stdout that this run compared nothing and names the key to add.
    return "";
  }
}

/**
 * #1204: THE BUILD PIN, ASKED BEFORE THE ROLE IS INSTALLED — the call #1084 said was missing.
 *
 * #1084 built `buildAssertion` and its own header named the gap: **"NOTHING CALLS THIS YET, AND SAYING
 * SO IS THE POINT … A function that is perfect and never reached is the defect this repository has hit
 * three times in a week."** This is the call, and it runs before any playbook touches a box, because a
 * refusal that arrives mid-provision has already changed the guest it is refusing.
 *
 * PROBED OVER `/health`, the same reading `fleet:status` takes, rather than asking Ansible: the OS is a
 * capture-cache key and the authoritative answer is what the worker reports about itself, not what the
 * inventory says it should be. A box that cannot be reached lands in `unreadable` and is SAID, never
 * counted as agreement.
 *
 * Extracted rather than inlined in `main`, which it took to 112 physical lines against a limit of 90.
 *
 * @param {string} chosen the playbook this run will execute
 */
async function enforceBuildPin(chosen: string) {
  const gate = buildGate({
    chosen,
    inventoryText: inventoryTextOrEmpty(),
    guests: guestBuilds(await Promise.all(fleetToProbe().map((w) => probeWorker(w)))),
  });
  if (gate.notice) process.stdout.write(`${gate.notice}\n\n`);
  if (gate.refusal) {
    process.stderr.write(`${gate.refusal}\n`);
    process.exit(2);
  }
}

/** #1313: the two playbooks that change what a box runs. Repair paths (`recover.yml`) and `sleep.yml` are not gated. */
// `patch.yml` joins them (#4446): it moves the build a box runs, so a box that cannot be asked, or a row holding the fleet,
// must refuse it exactly as it refuses a deploy.
const LINK_GATED = ["deploy.yml", "provision-role.yml", "patch.yml"];

/** Every `--allow-offline=<name>`, in order. REPEATABLE, which `flagValue` (first match only) is not. */
export function allowOfflineNames(argv: string[]): string[] {
  const prefix = "--allow-offline=";
  return argv.filter((argument) => argument.startsWith(prefix)).map((argument) => argument.slice(prefix.length));
}

/** `git`, sandboxed, as `layer-pins.ts` is handed it: what `ls-remote` asks a layer's repository for a release's commit. */
const sandboxedGit: GitRun = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * THE PAIR'S SECOND HALF, AND THE PATH A HOST TAKES (#5085). Two ways in, and which one is the operator's to say:
 *
 *   - `--layer-ref=<layer>=<sha>` for every layer: the commits the operator typed, put on the guests as before (the old path, which
 *     deploys whatever those commits hold and checks nothing about a registry artifact).
 *   - NO `--layer-ref` on a playbook that pins layers: `deploy-pins.json`'s releases. Each tarball is fetched and compared with its
 *     pinned `integrity` and the run is REFUSED, naming the layer, before the control plane or a box is touched; the commits are the
 *     ones the releases' tags name. The unpacked worker is where the protocol guard reads its version.
 *
 * `--layer-ref` on a playbook that pins none stays the refusal it was. The unpacked packages live in a directory of this process's
 * own and go with it.
 */
function layerCommitsOrRefuse({ chosen, refuse }: { chosen: string; refuse: (message: string) => void; }): { layerCommits: Record<string, string>; publishedWorkerDir: string | null; } {
  const given = layerRefValues(process.argv);
  if (given.length === 0 && LAYER_PINNED.includes(chosen)) {
    const stage = makeStage();
    process.once("exit", () => rmSync(stage, { recursive: true, force: true }));
    const resolved = resolvePublished({ pins: readDeployPins(), into: stage, git: sandboxedGit });
    if ("refusal" in resolved) {
      refuse(`REFUSING ${chosen}: ${resolved.refusal}`);
      return { layerCommits: {}, publishedWorkerDir: null };
    }
    return { layerCommits: resolved.commits, publishedWorkerDir: resolved.dirs["nvda-worker"] ?? null };
  }
  const { pins, refusal } = layerPinsFor({ chosen, given });
  if (refusal) refuse(refusal);
  return { layerCommits: pins, publishedWorkerDir: null };
}

/**
 * The refusal text for a HOLD with boxes still unnamed -- OFF and UNKNOWN in separate lists, because one is
 * a walk to a machine and the other is a better read.
 */
function holdRefusal({ chosen, off, unknown, named }: { chosen: string; off: string[]; unknown: string[]; named: string[]; }): string {
  return [
    `REFUSING ${chosen}: fleet:status holds this write at layer 2 (#1313).`,
    `  off the network:  ${off.join(", ") || "none"}`,
    `  unknown:          ${unknown.join(", ") || "none"}`,
    ...(named.length ? [`  already named with --allow-offline: ${named.join(", ")}`] : []),
    "  An OFF box is a walk only the chairman can make: after one `npm run fleet:wake -- <name>`, label the row",
    "  `needs:chairman` and @-mention `@DanBeckDev` in the brief naming the box by inventory name (the label is read;",
    "  a sentence is not). An UNKNOWN box needs a better read: `npm run fleet:link-view`.",
    "  To proceed past them deliberately, name each one: --allow-offline=<name> (repeatable).",
  ].join("\n");
}

/**
 * #1313: A LAYER-2 HOLD REFUSES THE WRITE -- `ceo`'s ruling on #1311, the second half of #1298.
 *
 * #1298 made `fleet:status` print `fleet write: HOLD`. **A HOLD line nobody reads is the "recorded, unread,
 * acted past" shape**, so `fleet:deploy` and `fleet:provision` read the gate themselves. UNKNOWN holds
 * exactly as OFF does (the amendment on #1298), and the flag lifts the refusal only when EVERY held box is
 * named -- a name for a box that was never held is refused, not quietly accepted.
 *
 * PURE, the way `buildGate` is, so every case is driven without a fleet; `enforceLinkGate` is the call.
 */
export function linkGate({ chosen, gate, allowOffline }: {
        chosen: string; gate: {
            hold: boolean; off: string[]; unknown: string[];
            moved?: { name: string; movedTo: string; }[];
        } | null;
        allowOffline: string[];
    }): { refusal: string | null; notice: string | null; } {
  if (!LINK_GATED.includes(chosen)) {
    return { refusal: allowOffline.length
      ? `refusing --allow-offline with --playbook=${chosen}: only ${LINK_GATED.join(" and ")} read the layer-2 gate.`
      : null, notice: null };
  }
  const held = gate?.hold ? [...gate.off, ...gate.unknown] : [];
  // #2832: a MOVED worker is not held (it answers by MAC elsewhere) but it IS a name this flag may take: an
  // unidentified one refuses the run, and `--allow-offline=<name>` is how a human proceeds without it
  // (`identityGate`). The flag is still refused for a name that is neither held nor moved.
  const moved = (gate?.moved ?? []).map(({ name }) => name);
  const stray = allowOffline.filter((name) => !held.includes(name) && !moved.includes(name));
  if (stray.length) {
    const why = held.length ? `not held (the hold is ${held.join(", ")})` : "no box is held";
    return { refusal: `refusing --allow-offline=${stray.join(", --allow-offline=")}: ${why}. `
      + "A name for a box that was never held would be accepted and ignored."
      + (moved.length ? ` (Moved by MAC, and so nameable: ${moved.join(", ")}.)` : ""), notice: null };
  }
  if (!gate?.hold) return { refusal: null, notice: null };
  const unnamed = (names: string[]) => names.filter((name) => !allowOffline.includes(name));
  const off = unnamed(gate.off);
  const unknown = unnamed(gate.unknown);
  if (off.length || unknown.length) {
    return { refusal: holdRefusal({ chosen, off, unknown, named: allowOffline }), notice: null };
  }
  return { refusal: null, notice: `  proceeding past a layer-2 HOLD: ${held.join(", ")}, each named with `
    + "--allow-offline. Ansible will report them UNREACHABLE, and that is the expected result." };
}

/** A `cat` of one or two small files; minutes would mean the control plane is not answering. */
const INVENTORY_READ_TIMEOUT_MS = 60_000;

// #1356: `inventorySources`, `inventoryReadScript`, `parseInventoryReads` and the pure fleet-resolution
// logic MOVED to `control-plane-fleet.ts`, imported above -- every operator-host reader needs the exact
// same shape `gateFleet` pioneered here (#1343), not a second copy of it. `gateFleet` below is now this
// file's own WORDING wrapped around the shared, generic resolver.

/**
 * The fleet the playbook will target, or the refusal saying why it cannot be known -- `gateFleet`'s own
 * words (`REFUSING {chosen}: the layer-2 gate ...`) wrapped around `controlPlaneFleet`'s generic reason.
 */
export function gateFleet({ chosen, reads, sources, groupVarsText }: { chosen: string; reads: { path: string; text: string; }[]; sources: string[]; groupVarsText: string; }): { workers: { name: string; url: string; }[]; refusal: string | null; } {
  const result = controlPlaneFleet({ reads, sources, groupVarsText });
  if (!result.refusal) return result;
  return { workers: [], refusal: `REFUSING ${chosen}: the layer-2 gate cannot know which boxes this `
    + `playbook targets -- ${result.refusal}. Could not ask is not may proceed.\n`
    + "  Install the inventory on the control plane with `npm run fleet:inventory-install`, then re-run." };
}

/**
 * #2832: THE WORKERS THE LAYER-2 READ FOUND ELSEWHERE, each with the pin it left, for the identity check that
 * decides whether a write may be aimed at the new address. Present ONLY when something moved, the way
 * `gate.moved` is, so a healthy fleet's result is exactly what it was.
 */
function movedWorkers(gate: { moved?: { name: string; movedTo: string; }[]; } | null, workers: { name: string; url: string; }[]): { moved?: { name: string; movedTo: string; pin: string; }[]; } {
  if (!gate?.moved?.length) return {};
  const pinOf = (name: string) => {
    const url = workers.find((w) => w.name === name)?.url;
    return url ? new URL(url).hostname : "";
  };
  return { moved: gate.moved.map(({ name, movedTo }) => ({ name, movedTo, pin: pinOf(name) })) };
}

/**
 * #1313, AS THE REVIEW ASKED: THE WHOLE GATE, WITH ITS READS INJECTED, so the enforce path is driven by a test
 * and not only its pure decision. `enforceLinkGate` is this plus the real reads and the exits.
 */
export async function linkGateFor({ chosen, argv, ansibleCfgText, groupVarsText, readInventories, status = fleetStatus }: {
        chosen: string; argv: string[]; ansibleCfgText: string; groupVarsText: string;
        readInventories: (paths: string[]) => { path: string; text: string; }[];
        status?: (deps: { workers: () => { name: string; url: string; }[]; }) => Promise<{
            linkLayer: {
                lines: string[]; gate: {
                    hold: boolean; off: string[]; unknown: string[];
                    moved?: { name: string; movedTo: string; }[];
                } | null;
            };
        }>;
    }): Promise<{
    refusal: string | null; notice: string | null; lines: string[];
    moved?: { name: string; movedTo: string; pin: string; }[];
}> {
  const allowOffline = allowOfflineNames(argv);
  if (!LINK_GATED.includes(chosen)) return { ...linkGate({ chosen, gate: null, allowOffline }), lines: [] };
  const couldNotAsk = (error: unknown, what: string) => ({ refusal: `REFUSING ${chosen}: `
    + `${what} (${String((error as Error).message).split("\n")[0]}). Could not ask is not may proceed.`,
  notice: null, lines: [] });
  let fleet: { workers: { name: string; url: string; }[]; refusal: string | null; };
  try {
    const sources = inventorySources(ansibleCfgText);
    fleet = gateFleet({ chosen, reads: readInventories(sources), sources, groupVarsText });
  } catch (error) {
    return couldNotAsk(error, "the control plane's inventory could not be read");
  }
  if (fleet.refusal) return { refusal: fleet.refusal, notice: null, lines: [] };
  try {
    const { linkLayer } = await status({ workers: () => fleet.workers });
    return { ...linkGate({ chosen, gate: linkLayer.gate, allowOffline }), lines: linkLayer.lines,
      ...movedWorkers(linkLayer.gate, fleet.workers) };
  } catch (error) {
    return couldNotAsk(error, "the layer-2 gate could not be read");
  }
}

/**
 * #1313: THE GATE, ASKED OF THE FLEET THIS PLAYBOOK WILL TOUCH, before the control plane is asked to move.
 *
 * THE CONTROL PLANE'S INVENTORY, read over the same `ssh` every other step here uses: not `A11Y_WORKERS`, for
 * `guardProtocolChange`'s reason (a stale variable would pass while Ansible targets the dead box), and not this
 * checkout's in-tree file, which is gitignored and absent where the fleet is driven from. The error carries
 * ssh's stderr, not its argv, so a refusal never prints the key path.
 *
 *
 * @returns {Promise<{ moved: { name: string, movedTo: string, pin: string }[] }>} the workers found elsewhere (#2832)
 */
function readControlPlaneInventories(paths: string[]): { path: string; text: string; }[] {
  try {
    return parseInventoryReads(ssh(inventoryReadScript(paths), { capture: true, timeoutMs: INVENTORY_READ_TIMEOUT_MS }));
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop();
    throw new Error(`ssh to the control plane failed: ${stderr || "no stderr"}`, { cause: error });
  }
}

async function enforceLinkGate(chosen: string): Promise<{ moved: { name: string; movedTo: string; pin: string; }[]; }> {
  const { refusal, notice, lines, moved } = await linkGateFor({
    chosen,
    argv: process.argv.slice(2),
    ansibleCfgText: readFileSync(resolve(ANSIBLE_DIR, "ansible.cfg"), "utf8"),
    groupVarsText: readFileSync(resolve(ANSIBLE_DIR, "group_vars/a11y_workers.yml"), "utf8"),
    readInventories: readControlPlaneInventories,
  });
  if (lines.length) process.stdout.write(`${lines.map((line) => `  ${line}`).join("\n")}\n`);
  if (notice) process.stdout.write(`${notice}\n\n`);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(2);
  }
  return { moved: moved ?? [] };
}

// #2832: THE WRITE-IDENTITY STEP, AFTER THE GATES THAT ASK THE LEAST OF THE CONTROL PLANE AND BEFORE ANYTHING
// IS SHIPPED. It sits here, in `fleet-playbook.ts`, because it is the one place that both knows which workers
// this run touches and builds the Ansible invocation, so an address override cannot be built without having
// passed it.

/**
 * Playbooks that target the CONTROL PLANE, not the workers: no worker is written to, so there is no worker
 * identity to check, and `inventory-install.yml` runs when no inventory exists to read. Pinned against each
 * playbook's own `hosts:` line by `fleet-playbook.test.ts`, so an entry cannot drift out of its class.
 */
const CONTROL_PLANE_ONLY = ["inventory-install.yml", "control-host-install.yml"];

/** Two minutes: one strict handshake per moved worker, each bounded by its own 10 s connect timeout. */
const IDENTITY_STEP_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Is a worker inside what this run's `--limit` touches? A moved worker the run will not touch must not refuse
 * it: the identity of a box nobody is writing to is nobody's concern here.
 */
export function limitTouches(name: string, limitFlag: string | undefined) {
  return limitFlag === undefined || limitFlag === "a11y_workers" || limitFlag.split(",").includes(name);
}

/**
 * THE WHOLE STEP, WITH THE CONTROL PLANE INJECTED (the `linkGateFor` split): record each worker's key by NAME
 * where a key is already recorded for its current pin, check each moved worker's identity with a strict
 * handshake, and say which it will aim where -- or refuse the run. `control` runs one command on the control
 * plane and returns its stdout; a throw is the caller's "could not ask".
 */
export function writeIdentityFor({ chosen, argv, limitFlag, moved, fleet, answering, control }: {
        chosen: string; argv: string[]; limitFlag: string | undefined;
        moved: { name: string; movedTo: string; pin?: string; }[];
        fleet: { name: string; address: string; }[]; answering: Set<string>;
        control: (command: string) => string;
    }): { refusal: string | null; notice: string | null; lines: string[]; addresses: Record<string, string>; } {
  if (CONTROL_PLANE_ONLY.includes(chosen)) return { refusal: null, notice: null, lines: [], addresses: {} };
  const plan = seedPlan({ workers: fleet, answering, records: parseKnownHostsRead(control(knownHostsReadScript(fleet))) });
  const recordKeys = seedCommand(plan.lines);
  if (recordKeys) control(recordKeys);
  const touched = moved.filter(({ name }) => limitTouches(name, limitFlag));
  const allowOffline = allowOfflineNames(argv);
  const toCheck = touched.filter(({ name }) => !allowOffline.includes(name));
  const verdicts = toCheck.length
    ? parseIdentityProbe(control(identityProbeScript(toCheck.map(({ name, movedTo }) => ({ name, address: movedTo })))))
    : new Map();
  return { ...identityGate({ moved: touched, allowOffline, verdicts }), lines: seedReport(plan) };
}

/**
 * The two things a run adds to the unit's command for its address override: the command that makes the
 * override file hold exactly this run's override or NOTHING (so a stale one from an earlier run can never aim
 * this one), and the `ANSIBLE_INVENTORY` that appends it after the config's own sources -- present only when
 * an address was resolved, so a healthy fleet's unit is exactly what it was.
 */
export function overrideUnitParts({ unit, aim, ansibleCfgText }: {
        unit: string; aim: { addresses: Record<string, string>; workers: string[]; };
        ansibleCfgText: string;
    }): { install: string; setenv: string; } {
  const path = overridePath(unit);
  const yaml = overrideInventory({ addresses: aim.addresses, workers: aim.workers });
  return {
    install: installOverrideCommand({ path, yaml }),
    setenv: yaml === null ? ""
      : ` --setenv=ANSIBLE_INVENTORY=${inventoryEnvironment({ sources: inventorySources(ansibleCfgText), path })}`,
  };
}

/**
 * WHAT A FAILURE TO READ OR RECORD THE KEYS MEANS, by playbook. `deploy.yml` and `provision-role.yml` already
 * refuse when the control plane's inventory cannot be read (the layer-2 gate, #1313), so for them this adds no
 * new way to fail and "could not ask is not may proceed" holds. Every other worker playbook is a repair or a
 * read (`recover.yml` is exempt from the busy-worker guard BECAUSE it must work on a box that is wedged), and
 * refusing one of those over a keys read would block exactly the run that is needed when things are broken:
 * it warns, and connects with whatever is recorded, as it did before this step existed.
 */
export function identityStepFailure({ chosen, message }: { chosen: string; message: string; }): { refuse: boolean; message: string; } {
  const what = `the workers' host keys could not be read or recorded on the control plane (${message})`;
  return LINK_GATED.includes(chosen)
    ? { refuse: true, message: `REFUSING ${chosen}: ${what}. Could not ask is not may proceed.` }
    : { refuse: false, message: `WARNING ${chosen}: ${what}. This run connects with whatever is recorded, as it did before #2832.` };
}

/** @returns {Promise<{ addresses: Record<string, string>, workers: string[] }>} where each moved worker is aimed */
async function enforceWriteIdentity(chosen: string, { moved, limitFlag }: { moved: { name: string; movedTo: string; pin: string; }[]; limitFlag: string | undefined; }): Promise<{ addresses: Record<string, string>; workers: string[]; }> {
  if (CONTROL_PLANE_ONLY.includes(chosen)) return { addresses: {}, workers: [] };
  let result: ReturnType<typeof writeIdentityFor>;
  let workers: string[];
  try {
    const read = readControlPlaneFleet();
    if (read.refusal) throw new Error(read.refusal);
    workers = read.workers.map(({ name }) => name);
    const probes = await Promise.all(read.workers.map((worker) => probeWorker(worker)));
    result = writeIdentityFor({ chosen, argv: process.argv.slice(2), limitFlag, moved,
      fleet: read.workers.map(({ name, url }) => ({ name, address: new URL(url).hostname })),
      answering: new Set(probes.filter((probe) => probe.reachable).map((probe) => probe.name)),
      control: (command) => ssh(command, { capture: true, timeoutMs: IDENTITY_STEP_TIMEOUT_MS }) });
  } catch (error) {
    const failure = identityStepFailure({ chosen, message: String((error as Error).message).split("\n")[0] });
    process.stderr.write(`${failure.message}\n`);
    if (failure.refuse) process.exit(2);
    return { addresses: {}, workers: [] };
  }
  if (result.lines.length) process.stdout.write(`${result.lines.join("\n")}\n`);
  if (result.notice) process.stdout.write(`${result.notice}\n\n`);
  if (result.refusal) {
    process.stderr.write(`${result.refusal}\n`);
    process.exit(2);
  }
  return { addresses: result.addresses, workers };
}

/**
 * #1839: A MULTI-ROUND SAME-BUILD CAPTURE SEQUENCE HELD ITS OWN `fleet:deploy`/`fleet:provision` WINDOW
 * IN A ROW COMMENT, TWICE, AND LOST -- #1767 and #1768 both had their baseline moved out from under them
 * by an ordinary merge landing between rounds. Neither was anyone ignoring the hold: the sentence lived
 * in a row comment, and nothing that runs a deploy reads row comments. `.claude/rules/agent-practices.md`
 * names the shape -- "a condition recorded in prose that nothing can evaluate" -- and #1839's own body
 * says none of that file's three machine-readable shapes (`blockedBy`, a date, an `answer:<session>`
 * label) expresses "waiting on an ACTION". This is the fourth.
 *
 * THE FIELD: `Fleet-hold-until: <ISO-8601 UTC timestamp>` in an OPEN row's body, scoped to `fleet-gated`
 * -- the label #1839's own open-check query used, and the only population a fleet hold could ever apply
 * to (a row whose acceptance needs the fleet). Modelled on `waiting-condition.mjs`'s `Not-before:`
 * (same declared-body-field pattern `Acceptance:`/`Closes:` proved first), but carrying a full
 * timestamp rather than a date: a capture round's window is minutes to hours wide, not a whole day.
 *
 * SELF-CLEARING, TWICE OVER, exactly the property `blocked` lacks and `Not-before:` has: the hold lapses
 * the moment `now` passes the timestamp, with no edit to anyone's row, and it vanishes again the moment
 * the row closes, because the query below asks only `--state open`. A hold that outlives its sequence
 * does not need a human to remember it.
 */

/**
 * THE READER IS THE TOOL'S, AND THIS IS ITS TWIN (#2975). `Fleet-hold-until:` is a WAITING CONDITION, so the tool's `waiting-condition.mjs`
 * reads it for the work gate (#2027: when it was declared only here, the gate's fleet batch dispatched rows that were holding the fleet, one
 * field over from #2005's defect). `fleetHoldUntil`/`fleetHoldWorkers` below are those two functions, copied, because this package may import
 * NOTHING BY NAME: ADR 0012's control plane runs from a raw git checkout with no `npm install`, and `control-has-no-dependencies.test.ts`
 * walks this graph to prove it. While the tool lived in this repository a relative import was the one kind this package may have; the tool is
 * a pinned dependency now, so there is no relative path to it.
 *
 * THE TWO READERS CANNOT DRIFT SILENTLY: `fleet-hold-readers-agree.test.ts` (in `lab`, the one package that may import both) runs the same
 * bodies through this copy and the tool's and requires identical answers, so the #2027 defect -- a second reader that disagrees -- is a red
 * test, not a rows-stranded-in-production discovery. `activeFleetHolds` below, this package's own tests and `fleet:deploy`/`fleet:provision`
 * keep importing both from here.
 */
const FLEET_HOLD_LINE = /^[ \t]*#{0,6}[ \t]*Fleet-hold-until:[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?:[ \t]+(a11y-worker-[0-9]{1,3}(?:,a11y-worker-[0-9]{1,3})*))?[ \t]*$/im;

/** `Date.parse` rolls `2026-02-31` over to March rather than refusing it, so the matched text is round-tripped and a date `Date` had to repair is refused (#1841). */
function roundTripsUtc(iso: string) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 19) === iso.slice(0, 19);
}

/**
 * The `Fleet-hold-until:` timestamp, or `null`. A MALFORMED TIMESTAMP IS NOT A HOLD: it fails OPEN, so a typo leaves the row visible to a human
 * and never hides a live sequence.
 */
export function fleetHoldUntil(body: string | null | undefined): string | null {
  const m = FLEET_HOLD_LINE.exec(String(body ?? ""));
  if (!m) return null;
  return roundTripsUtc(m[1]) ? m[1] : null;
}

/**
 * The workers the line names, or `[]` -- which MEANS "the whole fleet". A typo'd worker name fails the whole LINE (`FLEET_HOLD_LINE` matches the
 * list or nothing), so a hold never silently widens to the whole fleet because of a typo.
 */
export function fleetHoldWorkers(body: string | null | undefined): string[] {
  const m = FLEET_HOLD_LINE.exec(String(body ?? ""));
  if (!m || !roundTripsUtc(m[1])) return [];
  return m[2] ? m[2].split(",") : [];
}

/**
 * Every row still holding the fleet, RIGHT NOW -- pure, over issues the caller has already scoped to
 * `--state open --label fleet-gated` (`readFleetGatedIssues` below is the one real read).
 *
 * `nowMs` is INJECTED rather than read here with `Date.now()`, the same reason `todayIso` takes `now` as
 * a parameter in `waiting-condition.mjs`: a test moves the clock without threading it through every call.
 *
 * COMPARED AS PARSED TIME, never lexically -- see `fleetHoldUntil`'s own comment on why a timestamp
 * (unlike a ten-character date) cannot be compared as text.
 *
 * `workers` IS `fleetHoldWorkers`'s OWN READING, CARRIED THROUGH RATHER THAN RE-DERIVED (ceo's #928
 * ruling, point 2): `[]` means the row names none and so holds the whole fleet, unchanged from before this
 * field existed. `sequenceHoldGate` is what narrows a hold's reach to an operation's own `--limit`; this
 * function stays a plain read of "what is live right now", the same shape it always was.
 */
export function activeFleetHolds(issues: { number?: number; body?: string; }[], nowMs: number): { number: number; until: string; workers: string[]; }[] {
  const holds = [];
  for (const issue of issues ?? []) {
    const until = fleetHoldUntil(issue?.body);
    if (until === null) continue;
    if (Date.parse(until) > nowMs) holds.push({ number: Number(issue.number), until, workers: fleetHoldWorkers(issue?.body) });
  }
  return holds;
}

/**
 * Every `--allow-hold=<row>`, in order -- REPEATABLE, matching `allowOfflineNames` above for the
 * identical reason (`flagValue` reads only the first match).
 */
export function allowHoldNumbers(argv: string[]): number[] {
  const prefix = "--allow-hold=";
  return argv.filter((argument) => argument.startsWith(prefix)).map((argument) => Number(argument.slice(prefix.length)));
}

/**
 * The refusal text for one or more active holds, naming each row, the timestamp it clears at, and (ceo's
 * #928 ruling, point 2) the workers it names, when it names any -- `[]` says nothing extra, matching every
 * hold declared before that field existed.
 */
function sequenceHoldRefusal({ chosen, unnamed }: { chosen: string; unnamed: { number: number; until: string; workers?: string[]; }[]; }): string {
  return [
    `REFUSING ${chosen}: a fleet-hold sequence is active (#1839).`,
    ...unnamed.map(({ number, until, workers }) => `  held by #${number} until ${until}`
      + ((workers ?? []).length ? ` (${(workers ?? []).join(", ")})` : "")),
    "  This protects a multi-round same-build capture sequence -- deploying or provisioning now would",
    "  strand it the way #1767 and #1768 did, purely from ordinary merge cadence. Read the row before",
    "  proceeding: it names what it is protecting and when the hold clears itself.",
    "  To proceed past it deliberately, name each one: --allow-hold=<row> (repeatable).",
  ].join("\n");
}

/**
 * Whether a hold whose own worker scope is `holdWorkers` reaches an operation whose target is `limitFlag`
 * -- `ceo`'s #928 ruling (point 2): #1839's own reasoning protects a capture sequence's OWN workers
 * between rounds, and nothing in it needs the rest of the fleet (typically ~12 idle boxes) held too.
 *
 * UNSCOPED (`holdWorkers.length === 0`) REACHES EVERY TARGET -- #928's OWN REQUIRED BACK-COMPAT: every row
 * that already carries an unscoped `Fleet-hold-until:` keeps holding the whole fleet, unchanged, which is
 * why this is the first branch and short-circuits before `limitFlag` is even read.
 *
 * A SCOPED HOLD REACHES ONLY AN OPERATION THAT TOUCHES ONE OF ITS NAMED WORKERS. `limitFlag` absent, or
 * the whole-fleet group name `parseArgs` already accepts for it (`a11y_workers`), means the operation's
 * own target IS the fleet -- the same default `--limit` already has -- so it reaches every scoped hold
 * too, for the identical reason an unscoped hold reaches every target: neither one is naming anything
 * narrower to be safe from.
 */
export function fleetHoldReachesTarget(holdWorkers: string[], limitFlag: string | undefined): boolean {
  if (holdWorkers.length === 0) return true;
  if (!limitFlag || limitFlag === WORKER_GROUP) return true;
  const targets = limitFlag.split(",");
  return holdWorkers.some((worker) => targets.includes(worker));
}

/**
 * #1839: THE DECISION, pure -- given which rows currently hold the fleet and which the operator named.
 * `linkGate`'s own shape, one gate over: only `deploy.yml` and `provision-role.yml` read it (the two
 * playbooks LINK_GATED already names, for the identical reason -- they are what CHANGES what a box
 * runs, and a mid-sequence deploy is what stranded #1767 and #1768), a name for a row that is not
 * holding anything is refused rather than silently accepted, and proceeding past a real hold says so
 * rather than staying quiet about it.
 *
 * NARROWED BY `limitFlag` BEFORE ANYTHING ELSE RUNS (ceo's #928 ruling, point 2): `fleetHoldReachesTarget`
 * drops a hold whose named workers do not overlap this operation's own `--limit`, so a stray/unnamed/held
 * verdict below is already computed over "holds this operation could actually collide with" -- the same
 * reduction whether `holds` came from a fleet-wide default or a fully-scoped fixture, and callers that
 * never pass `limitFlag` see every hold reach them, unchanged from before this parameter existed.
 */
export function sequenceHoldGate({ chosen, holds, allowHold, limitFlag }: {
        chosen: string; holds: { number: number; until: string; workers?: string[]; }[];
        allowHold: number[]; limitFlag?: string;
    }): { refusal: string | null; notice: string | null; } {
  if (!LINK_GATED.includes(chosen)) {
    return { refusal: allowHold.length
      ? `refusing --allow-hold with --playbook=${chosen}: only ${LINK_GATED.join(" and ")} read the fleet-hold gate.`
      : null, notice: null };
  }
  const reaching = holds.filter((h) => fleetHoldReachesTarget(h.workers ?? [], limitFlag));
  const heldNumbers = reaching.map((h) => h.number);
  const stray = allowHold.filter((n) => !heldNumbers.includes(n));
  if (stray.length) {
    const why = heldNumbers.length ? `not held (the hold is #${heldNumbers.join(", #")})` : "no row holds the fleet";
    return { refusal: `refusing --allow-hold=${stray.join(", --allow-hold=")}: ${why}. `
      + "A number for a row that is not holding the fleet would be accepted and ignored.", notice: null };
  }
  const unnamed = reaching.filter((h) => !allowHold.includes(h.number));
  if (unnamed.length) return { refusal: sequenceHoldRefusal({ chosen, unnamed }), notice: null };
  if (reaching.length === 0) return { refusal: null, notice: null };
  return { refusal: null, notice: `  proceeding past a fleet-hold sequence: ${reaching.map((h) => `#${h.number}`).join(", ")}, `
    + "each named with --allow-hold." };
}

/** The repository the rows, and so the fleet holds, live in (#5307). Not the checkout's remote: control's own checkout has issues disabled. */
const ROWS_REPO = "a11ign/a11ign";

/**
 * The rows that could be holding the fleet, RIGHT NOW -- `gh issue list`, scoped exactly as #1839's own
 * open-check does: `--state open --label fleet-gated`, because that is the only population a fleet hold
 * could ever apply to (a row whose acceptance needs the fleet).
 *
 * `--repo` IS STATED (#5307). It was left to `gh` to resolve from the checkout's remote, which is right
 * for the core and wrong for control's own checkout, whose remote is `a11ign/control` with issues disabled:
 * a write play run from there refused on the hold read before it reached the plane.
 *
 * A FAILURE CARRIES `tokenSet`: whether the environment `gh` actually ran in held a token. It is
 * `ghEnvironment`'s own answer, not a second derivation of it, so a blank token file (which `ghEnvironment`
 * and bootstrap's `[ ! -s ]` both treat as absent) is tokenless here too. The earlier `existsSync` called
 * it credentialed and passed gh's `gh auth login` hint through (reviewer-2 on #1910).
 *
 * A MANAGER'S LIST IS READ FROM THE GATE'S SNAPSHOT (#5575). The host's `gh` refuses a manager's `issue list --json body` before any call
 * is made, and says so; that refusal is the answer to "read it from the snapshot", not a failed read, so it is followed rather than refused.
 */
export function readFleetGatedIssues({ env = process.env, readToken = readGhTokenFile, run = execFileSync, readSnapshot = readGateSnapshot }: { env?: NodeJS.ProcessEnv; readToken?: () => string; run?: typeof execFileSync; readSnapshot?: () => GateSnapshot; } = {}): { number: number; body: string; }[] {
  const ghEnv = ghEnvironment(env, readToken);
  try {
    return JSON.parse(String(run("gh",
      ["issue", "list", "--state", "open", "--label", "fleet-gated", "--json", "number,body", "--limit", "100", "--repo", ROWS_REPO],
      // stderr PIPED, not inherited: on a tokenless control plane gh's own text is "please run: gh auth
      // login", which is the wrong advice for a root box (#1875) -- `fleetHoldReadRefusal` says what to do.
      { encoding: "utf8", env: ghEnv, stdio: ["ignore", "pipe", "pipe"] })));
  } catch (error) {
    if (MANAGER_LIST_REFUSAL.test(String((error as { stderr?: unknown }).stderr ?? ""))) return gatedRowsFromSnapshot(readSnapshot());
    throw Object.assign((error as Error), { tokenSet: Boolean(ghEnv.GH_TOKEN) });
  }
}

/** The longest a gate snapshot may be before a hold read from it is "could not ask". The gate's tick is two minutes (`work-tick.timer.in`), so a snapshot inside this bound is a few ticks old at most; past it the list may be missing a hold, and it is not trusted. */
const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

/** The wrapper's refusal of a manager's list. Matched on its words because the wrapper alone decides who is a manager: re-deriving that here from `GH_CONFIG_DIR` misses a manager routed by `workspaces.txt`. */
const MANAGER_LIST_REFUSAL = /a manager's list is read from the gate's snapshot/;

type GateSnapshot = { ageMs: number; rows: { number: number; labels: string[] | null; body: string | null; }[]; };

/** `agent-org gate-snapshot-read rows --json`, the command the wrapper's refusal names. It makes no `gh` call. A reader that cannot run or cannot parse throws, and the caller refuses: an unreadable snapshot is "could not ask". */
export function readGateSnapshot(run: typeof execFileSync = execFileSync): GateSnapshot {
  let stdout: string;
  try {
    stdout = String(run("agent-org", ["gate-snapshot-read", "rows", "--repo", ROWS_REPO, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    throw gateSnapshotReadFailure(error);
  }
  return JSON.parse(stdout);
}

/** The longest first stderr line of a failed snapshot read that is quoted into the refusal (#5586). Past it the line is cut and marked. */
const SNAPSHOT_STDERR_LINE_MAX = 200;

/**
 * #5586: a failed snapshot read says WHAT failed in the child's FIRST stderr line. `agent-org` writes the cause there and its stack below
 * it, and the LAST line -- what `fleetHoldReadRefusal` quotes for gh -- is Node's `Node.js v24.21.0` footer, which names nothing. The
 * message carries the child's own words (the exit status too), so nothing is invented: with no stderr it says the status and stops there.
 */
function gateSnapshotReadFailure(error: unknown): Error {
  const failure = error as { status?: number | null; stderr?: string | Buffer; message?: string };
  const exit = typeof failure.status === "number" ? `exited ${failure.status}` : "failed";
  const firstLine = String(failure.stderr ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  if (firstLine !== undefined) {
    const quoted = firstLine.length > SNAPSHOT_STDERR_LINE_MAX ? `${firstLine.slice(0, SNAPSHOT_STDERR_LINE_MAX)}... (cut)` : firstLine;
    return new Error(`agent-org gate-snapshot-read ${exit}: "${quoted}"`, { cause: error });
  }
  const detail = typeof failure.status === "number" ? `${exit} and printed nothing on stderr` : `${exit}: ${String(failure.message ?? "").split("\n")[0]}`;
  return new Error(`agent-org gate-snapshot-read ${detail}`, { cause: error });
}

/**
 * The open `fleet-gated` rows the gate last stored, shaped as the live read returns them. FAILS CLOSED, every way the answer can be missing:
 * a snapshot older than `SNAPSHOT_MAX_AGE_MS`; a row whose labels the store lacks (it cannot be told from a fleet-gated one); and a
 * fleet-gated row whose body the store lacks (a `null` body is "could not ask", never "no hold", #1839).
 */
function gatedRowsFromSnapshot(snapshot: GateSnapshot): { number: number; body: string; }[] {
  if (snapshot.ageMs > SNAPSHOT_MAX_AGE_MS) {
    throw new Error(`the gate's snapshot is ${Math.floor(snapshot.ageMs / 60_000)} min old, past its ${SNAPSHOT_MAX_AGE_MS / 60_000} min bound`);
  }
  const gated: { number: number; body: string; }[] = [];
  for (const row of snapshot.rows) {
    if (row.labels === null) throw new Error(`the gate's snapshot lists #${row.number} without its labels, so it cannot say whether that row is fleet-gated`);
    if (!row.labels.includes("fleet-gated")) continue;
    if (row.body === null) throw new Error(`the gate's snapshot lists fleet-gated #${row.number} without its body`);
    gated.push({ number: row.number, body: row.body });
  }
  return gated;
}

/**
 * #1875: whether a failed fleet-hold read had a token, from the stamp `readFleetGatedIssues` puts on its
 * failure. With no stamp the credential was never classified: the token file was unreadable
 * (`readGhTokenFile` rethrows everything but ENOENT) or the reader was injected. That reads as PRESENT, so
 * the refusal keeps gh's own reason rather than claiming a file is missing when it is not.
 */
export function tokenSetOf(error: unknown): boolean {
  const stamped = (error as { tokenSet?: unknown } | null)?.tokenSet;
  return typeof stamped === "boolean" ? stamped : true;
}

/**
 * #1875: WHERE THE CONTROL PLANE'S GITHUB CREDENTIAL LIVES -- `ceo`'s ruling of 2026-09-22 on that row. A
 * fine-grained PAT minted by `a11ign-ai-workers` with public-repositories read-only access and NO
 * permissions: the fleet-hold read is of a public repo's open issues, so the token exists only because
 * `gh` refuses to run unauthenticated, and a leak of it can write nothing anywhere. `root:root 0600`,
 * never in git, the same posture as the fleet SSH key beside it. `homedir()` rather than a literal
 * `/root`, because a `systemd-run` unit is not promised a `HOME` and `homedir()` falls back to the passwd
 * entry.
 */
export const GH_TOKEN_FILE = join(homedir(), ".config", "a11y-witness", "gh-token");

/** @returns {string} the token file's contents, or "" when it is absent or unreadable. */
function readGhTokenFile(): string {
  try {
    return readFileSync(GH_TOKEN_FILE, "utf8");
  } catch (error) {
    // ABSENT IS AN ANSWER, not a swallowed error: the refusal below names this file when the read fails.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * #1875: the environment `gh` runs in -- the token file's contents as `GH_TOKEN` when the caller has not
 * already set one. An explicit `GH_TOKEN` wins, and a host with neither (the agents host, logged in
 * through `gh auth login`) is handed back its environment unchanged, so this changes nothing anywhere the
 * file does not exist. PURE over its reader, so both branches are testable without a control plane.
 */
export function ghEnvironment(env: NodeJS.ProcessEnv, readToken: () => string): NodeJS.ProcessEnv {
  if (env.GH_TOKEN) return env;
  const token = readToken().trim();
  return token ? { ...env, GH_TOKEN: token } : env;
}

/**
 * #1875: the refusal when the fleet-hold read fails. When no token was supplied AND gh says it has no
 * login either (its own "gh auth login" hint -- gh's wording, matched because it names the mechanism), it
 * names the token file and the row that decided what goes in it INSTEAD of that hint: an interactive login
 * on a shared root box is the option the ruling rejected. Otherwise gh's own last line is the useful part
 * (an expired token, GitHub unreachable), so it is kept -- and a host logged in the ordinary way, the
 * agents host, never reads advice about a file it was never meant to have.
 */
export function fleetHoldReadRefusal({ chosen, error, tokenSet }: { chosen: string; error: { message?: string; stderr?: string | Buffer; }; tokenSet: boolean; }): string {
  const lead = `REFUSING ${chosen}: could not ask whether a fleet-hold sequence is active`;
  const stderr = String(error.stderr ?? "");
  if (!tokenSet && stderr.includes("gh auth login")) {
    return `${lead}: this host has no GitHub credential -- GH_TOKEN is unset and ${GH_TOKEN_FILE} `
      + "is missing or empty. Write the read-only token there (root:root 0600, never in git); it is read into "
      + "GH_TOKEN for this check (#1875). Could not ask is not may proceed.";
  }
  const ghSaid = stderr.trim().split("\n").filter(Boolean).at(-1)
    ?? String(error.message ?? "").split("\n")[0];
  return `${lead} (${ghSaid}). Could not ask is not may proceed.`;
}

/**
 * #1839: THE GATE, ASKED BEFORE THE CONTROL PLANE IS TOLD TO MOVE -- `enforceLinkGate`'s own shape.
 *
 * `readIssues`/`nowMs` INJECTABLE so the IO is driven by a test, matching `linkGateFor`/`enforceLinkGate`
 * (#1313, "as the review asked").
 *
 * FAILS CLOSED on a `gh` failure -- "Could not ask is not may proceed" is this file's own rule already,
 * stated identically in `protocolGuardVerdict` and `gateFleet` for the same reason: a fleet hold that
 * silently reads as absent because GitHub was unreachable is the exact defect this row exists to remove,
 * one layer down.
 *
 * `limitFlag` PASSED THROUGH FROM `parseArgs` (ceo's #928 ruling, point 2): it is this operation's own
 * `--limit`, and `sequenceHoldGate` is what narrows a hold's reach by it. Undefined here means the same
 * thing it means to `parseArgs` -- no `--limit`, i.e. the whole fleet -- so an operation that never named
 * one still collides with every scoped hold, exactly as it always collided with every unscoped one.
 */
async function enforceSequenceHold(chosen: string, { readIssues = readFleetGatedIssues, nowMs = Date.now(), limitFlag }: { readIssues?: () => { number: number; body: string; }[]; nowMs?: number; limitFlag?: string; } = {}) {
  const allowHold = allowHoldNumbers(process.argv.slice(2));
  if (!LINK_GATED.includes(chosen)) {
    const { refusal } = sequenceHoldGate({ chosen, holds: [], allowHold, limitFlag });
    if (refusal) { process.stderr.write(`${refusal}\n`); process.exit(2); }
    return;
  }
  let issues;
  try {
    issues = readIssues();
  } catch (error) {
    // The read's own answer (`tokenSetOf`), never a re-read: an unreadable file already failed above, and
    // re-reading it here would throw past this refusal.
    const tokenSet = tokenSetOf(error);
    process.stderr.write(`${fleetHoldReadRefusal({ chosen, error: (error as { message?: string; stderr?: string | Buffer }), tokenSet })}\n`);
    process.exit(2);
    return;
  }
  const { refusal, notice } = sequenceHoldGate({ chosen, holds: activeFleetHolds(issues, nowMs), allowHold, limitFlag });
  if (notice) process.stdout.write(`${notice}\n\n`);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(2);
  }
}

/**
 * A SHA IS NOT A REF THIS CAN DEPLOY, AND THE COMMENT SAYING SO WAS NOT A GUARD.
 *
 * `deploy.yml` fast-forwards each guest with `git merge --ff-only origin/{{ a11y_git_ref }}`, so the ref
 * must be something `origin/<ref>` resolves to. `localBranch()`'s comment has recorded that since the run
 * it cost -- "this repo has already spent a run on `-e ref=<sha>` becoming an unresolvable `origin/<sha>`"
 * -- and it guarded only the DEFAULT. Passing `--ref=<sha>` explicitly walks straight past it, and
 * 2026-09-06 spent another run doing exactly that: the checkout SUCCEEDS, the merge fails with a git
 * message naming neither the flag nor the reason, and the deploy is a stack trace.
 *
 * A fact recorded in a comment is a fact somebody has to remember.
 *
 * EXTRACTED BY #1204, not rewritten: `main` sat at exactly the 90-line limit, so adding the build gate
 * took it to 92 and the change had to pay for itself. This block was the most self-contained step in it.
 */
function refuseCommitShapedRef(ref: string) {
if (/^[0-9a-f]{7,40}$/i.test(ref)) {
  process.stderr.write([
    `REFUSING: --ref=${ref} looks like a COMMIT.`,
    "This deploys by fast-forwarding each guest to `origin/<ref>`, which a commit does not resolve to.",
    "The checkout would succeed and the merge would fail on a message that names neither the flag nor",
    "the reason.",
    "  Pass a BRANCH name. To deploy one commit, push it as a branch first.",
    "",
  ].join("\n"));
  process.exit(2);
}
}

// ---------------------------------------------------------------------------------------------------------------------
// #4446, A11-205: `fleet:patch` -- THE DELIBERATE UPGRADE AS A COMMAND, WITH THE FLEET'S SAFETIES. THERE IS NO SCHEDULE.
//
// `patch.yml` lifts the Windows levers of the freeze on one box, installs, reboots and freezes it again, one box at a time. Nothing runs it on a clock any more
// (the 28-day patch window, its timer, its `--scheduled` flags and its run record are gone): a person runs it, and this is the command around it, what it
// refuses and what it prints.
// ---------------------------------------------------------------------------------------------------------------------

/** One box as the patch gate reads it: whether it answered, and whether it is capturing. */
export type PatchBox = { name: string; reachable: boolean; busy: boolean; build: string | null };

/**
 * A probe, as a `PatchBox`. **Busy unless the box said it is not**, as `patch.yml`'s own check reads it
 * (`busy | default(true)`): a payload with no `busy` field is a box whose state is not known, and a reboot on a guess is
 * the one thing this refuses. `progress.busy` before `health.busy` for `activityOf`'s reason (one instant, not two).
 */
export function patchBoxOf(probe: { name: string; reachable: boolean; health?: WorkerHealth; progress?: { busy?: boolean } }): PatchBox {
  const busy = (probe.progress?.busy ?? probe.health?.busy) !== false;
  const windowsVersion = probe.health?.environment?.windowsVersion;
  return { name: probe.name, reachable: probe.reachable, busy: probe.reachable && busy,
    build: buildOf(typeof windowsVersion === "string" ? windowsVersion : null) };
}

/**
 * WHAT REFUSES A PATCH RUN, in the order a person would fix them. `null` when the run may go.
 *
 * - **More than one box under `--limit`, without `--apply`.** A dry run is read for ONE box, the way `patch.yml`'s own
 *   header reads the first run (`--check --limit <one idle box>`); a list is a change to several boxes and has to say so.
 * - **A box that cannot be asked.** Not a skipped box: `patch.yml` counts an unanswered box as busy, and a window that
 *   patched the nine it could reach would leave the fleet on two builds, which is the drift the window exists to end.
 *   `--allow-offline=<name>` (the link gate's own flag) names one a human has accepted.
 * - **A box that is busy.** A reboot destroys 12-520 s of a screen reader's work, and a different session may own it.
 * - **A box above the manifest's Windows build.** Never rolled back (the standing rule, ADR 0001): `patch.yml` refuses it by name too, but it refuses it only
 *   after `deploy.yml` has already put new code on every box, so the wrapper says it before anything is touched.
 *
 * The fleet being UNKNOWN (no inventory, or unreadable) is not here: it is the link gate's refusal, which `patch.yml`
 * now sits behind, in its own words, before any box is probed.
 */
export function patchRefusal({ apply, limitFlag, boxes, allowOffline, target }: {
  apply: boolean; limitFlag: string | undefined; boxes: PatchBox[]; allowOffline: string[]; target: PatchTarget;
}): string | null {
  const named = limitFlag === "a11y_workers" ? boxes.map(({ name }) => name) : (limitFlag ?? "").split(",").filter(Boolean);
  if (!apply && named.length > 1) {
    return `REFUSING patch.yml --limit=${limitFlag} without --apply: ${named.length} boxes are a change, not a look. `
      + "Name ONE box for the dry run, or pass --apply.";
  }
  const unanswered = boxes.filter((box) => !box.reachable && !allowOffline.includes(box.name));
  if (unanswered.length) {
    return `REFUSING patch.yml: ${unanswered.map(({ name }) => name).join(", ")} did not answer, so the fleet cannot be `
      + "patched as one. Patching the boxes that did would leave two builds. Wake them, or name each one with "
      + "--allow-offline=<name>.";
  }
  const busy = boxes.filter((box) => box.busy);
  if (busy.length) {
    return `REFUSING patch.yml: ${busy.map(({ name }) => name).join(", ")} ${busy.length === 1 ? "is" : "are"} busy. `
      + "A reboot destroys a capture in flight. Re-run when it has finished (`npm run fleet:status`).";
  }
  const above = boxes.filter((box) => limitTouches(box.name, limitFlag) && boxAgainstManifest(box, target) === "above");
  if (above.length) {
    return `REFUSING patch.yml: ${above.map(({ name }) => `${name} (build ${above.find((box) => box.name === name)?.build})`).join(", ")} ${above.length === 1 ? "is" : "are"} ABOVE the manifest's Windows build `
      + `${target.build} (deploy-pins.json). A box is never rolled back to an older build: edit the manifest to a build no box is above, or decide what becomes of the box.`;
  }
  return null;
}

/**
 * What the command does once the gate has spoken: a refusal wins over everything, then dry (the DEFAULT) prints the plan
 * and ends, and only `--apply` goes on to move the control plane and run the play.
 */
export function patchOutcome({ apply, refusal }: { apply: boolean; refusal: string | null }): "refuse" | "plan" | "run" {
  if (refusal) return "refuse";
  return apply ? "run" : "plan";
}

/** What `patch.yml` upgrades Windows to, as `deploy-pins.json` says it: the release, the `<CurrentBuild>.<UBR>` build and the cumulative update that produces it. */
export type PatchTarget = { release: string; build: string; kb: string };

/**
 * Where a box stands against the manifest's Windows build, as far as `/health` can say. `/health` reports `Win32_OperatingSystem.Version` --
 * `<major>.<minor>.<CurrentBuild>`, no UBR -- so only the CurrentBuild is comparable here: `below` needs the feature route, `above` is refused (never rolled back),
 * and `same` may still be a revision behind, which `patch.yml` reads from the registry itself.
 */
export function boxAgainstManifest(box: PatchBox, target: PatchTarget): "below" | "same" | "above" | "unread" {
  if (box.build === null) return "unread";
  const difference = Number(box.build.split(".").pop()) - Number(target.build.split(".")[0]);
  if (difference === 0) return "same";
  return difference < 0 ? "below" : "above";
}

/** The plan, one line per box in the order `serial: 1` takes them -- what a dry run prints and `--apply` is about to do. */
export function patchPlan({ boxes, limitFlag, apply, target, differences }: {
  boxes: PatchBox[]; limitFlag: string | undefined; apply: boolean; target: PatchTarget;
  /** What `fleet:drift` reads off the boxes now: a box with none and on the manifest's Windows build has nothing to upgrade, and the plan says so. Absent: not read, and no box is claimed to be on the manifest. */
  differences?: { box: string; field: string; has: string | null; wants: string; }[];
}): string[] {
  const verb = apply ? "will upgrade" : "would upgrade";
  const lines = boxes.map((box) => {
    const build = box.build ?? "build unreadable";
    if (!limitTouches(box.name, limitFlag)) return `  ${box.name}  left alone (outside --limit)  [${build}]`;
    if (!box.reachable) return `  ${box.name}  ${verb}: DID NOT ANSWER`;
    const against = boxAgainstManifest(box, target);
    const differs = (differences ?? []).filter((difference) => difference.box === box.name);
    if (differences !== undefined && differs.length === 0 && against === "same") return `  ${box.name}  on the manifest, nothing to upgrade${box.busy ? " (BUSY)" : ""}  [${build}]`;
    const note = against === "below" ? " (a feature update first)" : against === "above" ? " (ABOVE the manifest: refused, never rolled back)" : "";
    const reasons = differs.length === 0 ? "" : ` -- ${differs.map(({ field, has, wants }) => `${field} ${has ?? "unreported"} -> ${wants}`).join("; ")}`;
    return `  ${box.name}  ${verb}${box.busy ? ": BUSY" : ""}  [${build}]${note}${reasons}`;
  });
  return [`  patch.yml ${apply ? "--apply" : "(dry: nothing is changed; pass --apply)"} -- ${boxes.length} box(es), one at a time:`,
    ...lines, `  ${patchTargetLine(target)}`];
}

/** The plan's line, and the log's: the target is the manifest's, edited in a pull request, never the newest build any box reports. */
export function patchTargetLine(target: PatchTarget): string {
  return `target: Windows ${target.release} ${target.build} (${target.kb}), from deploy-pins.json -- the manifest's Node, NVDA, Edge and display driver go with it`;
}

/**
 * `patch.yml`'s own ceiling per box, DERIVED from the play's ceilings and not measured (a11ign#4897 calls 7200 s "a guess"): the 7200 s `win_reboot` and 1800 s for the
 * install and margin for a box that needs a feature update, and an hour for one that needs a cumulative update and the role's Node, NVDA and Edge installs.
 */
const PATCH_FEATURE_BOX_MS = (7200 + 1800) * 1000;
const PATCH_BOX_MS = 60 * 60 * 1000;

/**
 * How long this command watches the unit. `followUnit` giving up does NOT stop the play, and the next attempt stops the unit before it starts one, so a budget below
 * the run is a run killed in flight. The play walks the boxes one at a time, so the budget is the sum over the boxes under `--limit`, never below the cumulative one.
 */
export function patchFollowBudgetMs({ boxes, limitFlag, target }: { boxes: PatchBox[]; limitFlag: string | undefined; target: PatchTarget; }): number {
  const total = boxes.filter((box) => limitTouches(box.name, limitFlag))
    .reduce((sum, box) => sum + (boxAgainstManifest(box, target) === "below" ? PATCH_FEATURE_BOX_MS : PATCH_BOX_MS), 0);
  return Math.max(PLAYBOOK_TIMEOUT_MS["patch.yml"], total);
}

/** What the patch gate leaves for `main`: whether the command is done (a dry run), and how long to watch. */
type PatchGate = { dryRun: boolean; followBudgetMs: number };

/**
 * The patch gate and, without `--apply`, the plan -- BEFORE the control plane is asked to move or anything is written.
 * `dryRun` is `true` when this was a dry run and the command is done. The manifest is read here, in a dry run too: it is a read, and the plan is what says
 * the target the run would take every box to.
 */
async function enforcePatchGate({ chosen, limitFlag, apply }: { chosen: string; limitFlag: string | undefined; apply: boolean }): Promise<PatchGate> {
  const ordinary = { dryRun: false, followBudgetMs: PLAYBOOK_TIMEOUT_MS[chosen] ?? DEFAULT_PLAYBOOK_TIMEOUT_MS };
  if (chosen !== "patch.yml") return ordinary;
  const sources = inventorySources(readFileSync(resolve(ANSIBLE_DIR, "ansible.cfg"), "utf8"));
  const fleet = gateFleet({ chosen, reads: readControlPlaneInventories(sources), sources,
    groupVarsText: readFileSync(resolve(ANSIBLE_DIR, "group_vars/a11y_workers.yml"), "utf8") });
  if (fleet.refusal) { process.stderr.write(`${fleet.refusal}\n`); process.exit(2); }
  const boxes = (await Promise.all(fleet.workers.map((worker) => probeWorker(worker)))).map(patchBoxOf);
  const target = readFleetPins().windows;
  // What each box differs in NOW, so the plan says which boxes the run has something to do for. A manifest that cannot be read refuses: with no expectation
  // every box would read as on it.
  const { drift } = await readFleetDrift({ workers: () => fleet.workers });
  if (drift.unreadable !== null) { process.stderr.write(`REFUSING patch.yml: the manifest cannot be compared with the boxes (${drift.unreadable}).\n`); process.exit(2); }
  process.stdout.write(`${patchPlan({ boxes, limitFlag, apply, target, differences: drift.differences }).join("\n")}\n\n`);
  const refusal = patchRefusal({ apply, limitFlag, boxes, allowOffline: allowOfflineNames(process.argv.slice(2)), target });
  const outcome = patchOutcome({ apply, refusal });
  if (refusal) { process.stderr.write(`${refusal}\n`); process.exit(2); }
  return { dryRun: outcome === "plan", followBudgetMs: patchFollowBudgetMs({ boxes, limitFlag, target }) };
}

async function main() {
  // Throws before anything else if neither A11Y_CONTROL_HOST nor its installed file exist -- see #83, #285.
  CONTROL_PLANE = requireControlPlaneHost();
  requireControlPlaneKey(); // same, for A11Y_PVE_KEY -- see #85
  const { chosen, limitFlag, serialFlag, ref, allowEdgeDowngrade, apply, displayMode, layerCommits, publishedWorkerDir } = parseArgs();
  await guardProtocolChange(chosen, { readLocal: () => readLocalProtocol({ publishedDir: publishedWorkerDir }) });
  const { moved } = await enforceLinkGate(chosen);
  await enforceSequenceHold(chosen, { limitFlag });
  // #4446: AFTER the gates that ask least of the control plane, BEFORE anything is written to it. A dry run ends HERE.
  const patchGate = await enforcePatchGate({ chosen, limitFlag, apply });
  if (patchGate.dryRun) return;
  // #2832: AFTER every gate that can refuse cheaply, BEFORE the control plane moves: a moved worker is aimed
  // at its new address only once its host key, recorded under its NAME, has been verified strictly.
  const aim = await enforceWriteIdentity(chosen, { moved, limitFlag });

  // What that ref means HERE, resolved before anything is asked of the control plane. Comparing a commit
  // to a commit is the only comparison that settles "is it running my code?" — the first version compared
  // the remote's resolved SHA against the branch NAME, which can never match, and refused a control plane
  // that was already correct.
  const expected = execFileSync("git", ["rev-parse", ref], { encoding: "utf8", env: sandboxGitEnv() }).trim();
  refuseCommitShapedRef(ref);

  // #971: WHAT THAT REF MEANS ON ORIGIN, asked before anything is shipped. `null` when `origin/<ref>`
  // does not resolve, which `staleRefRefusal` refuses rather than reads as agreement.
  const onOrigin = resolveOrNull(`origin/${ref}`);
  const stale = staleRefRefusal({ ref, local: expected, origin: onOrigin });
  if (stale) {
    process.stderr.write(stale);
    process.exit(2);
  }

  process.stdout.write(`\n  control plane: ${CONTROL_PLANE}   playbook: ${chosen}\n`
    + `  ref: ${ref} (${expected.slice(0, 12)})\n\n`);
  requireCommitIsOnOrigin(ref, expected);
  moveControlPlane({ ref, expected, layerCommits });

  // READ BACK, never infer. A control plane left on an older commit would deploy that commit and report
  // success — this project's most expensive recurring shape, and the reason `deploy.yml` verifies each
  // worker over HTTP rather than trusting the push.
  const landed = ssh(`cd ${CHECKOUT} && git rev-parse HEAD`, { capture: true }).trim();
  if (landed !== expected) {
    process.stderr.write(`the control plane is on ${landed.slice(0, 12)}, not ${expected.slice(0, 12)}. `
      + "Not deploying.\n");
    process.exit(1);
  }

  await enforceBuildPin(chosen);

  // A BOOTSTRAP PLAYBOOK RUNS FROM HERE. The playbook declares it; this reads the declaration.
  if (declaresBootstrap(chosen)) {
    runBootstrapFromHere(chosen);
    return;
  }

  // A failed deploy must READ like a failed deploy. `execFileSync` throws an Error whose message is the
  // whole command line and whose stack is node's internals, which buries "which box failed" under twelve
  // lines of module loader — and the wrapper around it then reported success. Ansible has already printed
  // its own PLAY RECAP by this point; the job here is to exit with its status and say so in one line.
  const unit = startPlaybookUnit({ chosen, ref, limitFlag, serialFlag, allowEdgeDowngrade, apply,
    displayMode, layerCommits, followBudgetMs: patchGate.followBudgetMs, aim });

  process.stdout.write(`  started as ${unit} on ${CONTROL_PLANE}. It now outlives this terminal.\n`
    + `  if this command dies, the deploy does not — follow it again with the same command, or:\n`
    + `    ssh root@${CONTROL_PLANE} 'systemctl status ${unit}'\n\n`);
  const outcome = await followUnit(unit, patchGate.followBudgetMs);
  // #5014: the unit is done whatever it said, so the lock is shortened BEFORE any exit below; a failed run is the case it is for.
  endFleetLock(chosen);

  if (outcome.status !== 0) {
    process.stderr.write(`\n  ${chosen} FAILED (ansible exit ${outcome.status}). The PLAY RECAP above `
      + "names which hosts; nothing was rolled back, so re-running is safe.\n");
    process.exit(outcome.status);
  }
  const nothing = deployedToNothing(outcome.log);
  if (nothing) {
    process.stderr.write(`\n  ${chosen} REACHED NO HOSTS and ansible still exited 0: ${nothing}\n`
      + "  Nothing was deployed. This is NOT a successful run, and the fleet is on whatever code it had.\n"
      + "  Verify with `npm run worker:code` before trusting any capture.\n");
    process.exit(5);
  }
  process.stdout.write(`\n  ${chosen} completed; the PLAY RECAP above is the per-host result.\n`);
}

/**
 * Which journal to read: THIS invocation when systemd knows one, the whole unit otherwise.
 *
 * A pure function so the choice can be tested without a control plane. The id is 32 hex characters from
 * `systemctl show`; anything else is refused rather than interpolated into a remote shell command, on the
 * machine that holds the fleet SSH key — the same rule `validRef` follows and for the same reason.
 */
function journalScope(unit: string, invocation: string): string {
  return /^[0-9a-f]{32}$/.test(invocation) ? `_SYSTEMD_INVOCATION_ID=${invocation}` : `-u ${unit}`;
}

/**
 * Did this playbook run against NO HOSTS? Ansible says so and exits 0.
 *
 * Measured 2026-09-06: the control plane's checkout pulled main, `inventory.yml` is untracked and
 * gitignored so the pull DELETED it, and `fleet:deploy` then printed
 *
 *     [WARNING]: Unable to parse .../inventory.yml as an inventory source
 *     [WARNING]: Could not match supplied host pattern, ignoring: a11y_workers
 *     PLAY [Deploy the worker code to the fleet]
 *     skipping: no hosts matched
 *
 * and exited **0**. Ten workers untouched, the wrapper reporting completion. The only thing that caught it
 * was running `worker:code` out of habit; otherwise the next capture would have refused with
 * `10 stale worker(s)` and the cause would have been an hour old and elsewhere.
 *
 * A DEPLOY TO NOTHING IS NOT A SUCCESSFUL DEPLOY. Ansible's exit status answers "did the tasks I ran
 * fail", and with no hosts there are no tasks — a true answer to a question nobody asked. This asks the
 * one that matters.
 *
 * Matches on ANY of the four signatures rather than one, because they appear in different combinations:
 * an unparseable inventory, an empty one, and a pattern that matched nothing are three different causes
 * of the same silence, and naming which is what makes the message actionable.
 *
 * @param {string} log the unit's journal
 * @returns {string | null} why it deployed to nothing, or null if it reached hosts
 */
export function deployedToNothing(log: string): string | null {
  const text = String(log ?? "");
  if (!/skipping: no hosts matched|provided hosts list is empty/.test(text)) return null;
  // A host in the PLAY RECAP that ran tasks IS a run that reached hosts: the warning and the "no hosts matched" belong to
  // the in-tree fallback inventory being absent (or one play whose pattern was empty), and the installed inventory matched.
  // Measured 2026-10-17: `patch.yml --limit` one box finished ok=18 failed=0 and the wrapper exited 5 anyway.
  if (recapHostRan(text)) return null;
  const unparseable = text.match(/Unable to parse (\S+) as an inventory source/);
  if (unparseable) {
    return `the inventory at ${unparseable[1]} could not be parsed — on the CONTROL PLANE, not here. `
      + "It is gitignored, so a `git pull` there deletes it.";
  }
  if (/No inventory was parsed/.test(text)) return "no inventory was parsed at all on the control plane";
  const pattern = text.match(/Could not match supplied host pattern, ignoring: (\S+)/);
  if (pattern) return `the host pattern '${pattern[1]}' matched nothing in the inventory`;
  return "the play matched no hosts, and the journal does not say why";
}

/**
 * True when a host line UNDER a `PLAY RECAP` heading shows `ok=` above 0. The `ok=` text alone proves nothing:
 * any journal line shaped `name: ok=1` would otherwise lift the no-hosts refusal (reviewer-control-117). The
 * journal is read with `-o cat`, so the heading starts its line.
 */
function recapHostRan(text: string): boolean {
  const recap = text.split(/^PLAY RECAP\b.*$/m).slice(1).join("\n");
  return /^\S+\s*:\s*ok=[1-9]\d*\b/m.test(recap);
}

/**
 * Wait for a control-plane unit to finish, streaming what it says, and return ITS status.
 *
 * WAIT FOR `SubState` TO LEAVE `running`, never for it to EQUAL a terminal value. A unit has several
 * terminal SubStates — `exited`, `failed`, `dead` — and which one you get depends on how it ended and
 * whether anything reaped it. `lab-job.test.ts` pins that rule and two waiters written an hour apart
 * still hung on jobs that had long since finished, because they polled for the terminal values their
 * authors happened to think of.
 *
 * `ExecMainStatus` is populated WHILE a unit runs and means nothing until `SubState` has left `running`,
 * which is why it is read only after the loop.
 *
 * AND THE JOURNAL IS BOUNDED TO **THIS** INVOCATION. `journalctl -u <unit>` returns every run since boot,
 * oldest first, so the first poll printed a PREVIOUS deploy's PLAY RECAP above this one's and only a
 * timestamp told them apart. Measured 2026-09-05: a deploy that correctly REFUSED a busy fleet
 * (`failed=1`, `changed=0`) was read as having deployed, because the recap sitting above the refusal was
 * the successful run from seven minutes earlier. That is this repo's oldest diagnostic defect —
 * *"`journalctl -u <unit> --since <ExecMainStartTimestamp>` is the PREVIOUS run's window once the unit has
 * exited"*, recorded as having cost three wrong readings — arriving in the one place that had no bound at
 * all. `lab-status.yml`'s task *"Whether that journal is ONE run or the unit's whole history"* is the
 * remedy being copied.
 *
 * The id survives here where it does not for `lab:job`: this unit is `--remain-after-exit`, so systemd
 * keeps its `InvocationID` after it finishes, and `main` stops and `reset-failed`s the unit before
 * `systemd-run`, so the id is necessarily new. An EMPTY id still falls back to the whole unit journal and
 * SAYS SO, because showing nothing where there is plenty is worse than showing too much.
 */
async function followUnit(unit: string, budgetMs: number): Promise<{ status: number; log: string; }> {
  const deadline = Date.now() + budgetMs;
  let shown = 0;
  const invocation = ssh(`systemctl show -p InvocationID --value ${unit} 2>/dev/null || true`,
    { capture: true }).trim();
  const scope = journalScope(unit, invocation);
  if (!invocation) {
    process.stdout.write("  (this unit has no InvocationID, so the journal below is its WHOLE history, "
      + "not just this run — read the timestamps)\n");
  }
  /** The journal as last read, kept so the caller can ask what the run actually did. */
  let lastLog;
  for (;;) {
    const sub = ssh(`systemctl show -p SubState --value ${unit} 2>/dev/null || echo unknown`,
      { capture: true }).trim();
    // The journal so far, minus what has already been printed — so a caller that reconnects to a running
    // deploy sees it progress rather than a silent wait.
    const log = ssh(`journalctl ${scope} --no-pager -o cat 2>/dev/null || true`, { capture: true });
    lastLog = log;
    const lines = log.split("\n");
    if (lines.length > shown) { process.stdout.write(lines.slice(shown).join("\n")); shown = lines.length; }
    if (sub !== "running" && sub !== "unknown") break;
    if (Date.now() > deadline) {
      process.stderr.write(`\n  ${unit} is STILL RUNNING past its ${Math.round(budgetMs / 60000)} min `
        + `budget. It has NOT been stopped — this command gave up watching, which is not the same thing. `
        + `Check it with: ssh root@${CONTROL_PLANE} 'systemctl status ${unit}'\n`);
      process.exit(4);
    }
    await new Promise((r) => setTimeout(r, FOLLOW_POLL_MS));
  }
  const code = ssh(`systemctl show -p ExecMainStatus --value ${unit} 2>/dev/null || echo 1`,
    { capture: true }).trim();
  return { status: Number(code) || 0, log: lastLog };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

export { validRef, PLAYBOOKS, LIMIT_PATTERN, SERIAL_PATTERN, DISPLAY_MODE_PATTERN,
  displayModeRefusal, displayModeExtraVars, PLAYBOOK_TIMEOUT_MS,
  DEFAULT_PLAYBOOK_TIMEOUT_MS, onTheControlPlane, journalScope, osRollbackRefusal };
