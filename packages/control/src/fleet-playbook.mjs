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
 * `protocol-version-file.test.ts` pins this name against the file that actually exports the constant, so
 * the next move breaks a test instead of the fleet.
 */
export const PROTOCOL_VERSION_FILE = "protocol-version.mjs";

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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { sandboxGitEnv } from "../../../scripts/git-env.mjs";
// RELATIVE, NEVER `@a11ign/worker-fleet/cli-flags`. A package-name import resolves through
// `node_modules`, and the control plane deliberately has none — ADR 0012 keeps npm's transitive surface
// away from the key that can reconfigure twelve auto-logging-in Windows boxes. So this package runs from a
// RAW GIT CHECKOUT, and every import it makes has to work without an install.
// `control-has-no-dependencies.test.ts` asserts that, because the same claim in prose was violated on both
// machines it described.
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
// #1204: the guests' own report of their OS, the same reading `fleet:status` takes.
import { fleetToProbe, probeWorker } from "./fleet-status.mjs";
import { WORKER_GROUP, groupPerLine } from "../../worker-fleet/src/fleet-env.mjs";
import { protocolVerdict, servedProtocols } from "../../worker-fleet/src/protocol-guard.mjs";
// BY PATH, never by package name, AND TRANSITIVELY SO. The control plane has no `node_modules` — ADR
// 0012's boundary — so a path import is not enough on its own: what it imports must obey the rule too.
// The first version of this reached `workerUrls` in `check-worker-code.mjs`, which imports
// `@a11ign/nvda-worker` by package name, and `fleet:deploy` died on the control plane with
// ERR_MODULE_NOT_FOUND while passing on a laptop that has node_modules. A gate that does not exercise
// what ships, for the fifth time in this repo.
//
// `fleet-env.mjs` imports only node builtins and its own siblings. And the inventory is the RIGHT source
// here regardless: the control plane deploys to the fleet in `inventory.yml`, never to a local UTM pool
// that cannot exist there.
import { workerSourceDir } from "../../nvda-worker/src/code-version.mjs";
import { inventoryWorkerUrls } from "../../worker-fleet/src/fleet-env.mjs";
import { CONTROL_PLANE_CHECKOUT } from "./control-plane-checkout.mjs";
import { requireControlPlaneHost, requireControlPlaneKey } from "./control-plane-host.mjs";

/**
 * `--serial=` and `--limit=` decide how many of twelve machines an operation touches at once, and
 * `--ref=` decides what code they end up running. `--abbrev-ref`, `--all`, `--ff-only` and `--quiet`
 * appear in this file because it passes them to GIT; they are not its own.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(
  ["--playbook=", "--ref=", "--limit=", "--serial=", "--allow-protocol-change", "--allow-edge-downgrade", "--apply"],
  { entry: import.meta.url, command: "npm run fleet:deploy" });

/** CT 120. Named here rather than parsed out of the inventory, which needs Ansible to read properly. */
/** How often to ask the control plane how its unit is doing. A poll INTERVAL, never a sleep-and-hope. */
const FOLLOW_POLL_MS = 5_000;

// No default: see control-plane-host.mjs -- this used to fall back to a real, specific LAN address (#83).
// Resolved by `requireControlPlaneHost()` at the top of `main()`, not at import: env var first, then the
// durable file it installs (#285, `fleet:control-host-install`), then a loud refusal. A bare env read
// here would miss the file entirely, so this is reassigned once resolved rather than only validated.
/** @type {string} */
let CONTROL_PLANE;
/** The playbooks, in THIS checkout — where a bootstrap's source file actually is. */
const ANSIBLE_DIR = resolve(import.meta.dirname, "../ansible");
// The control plane's checkout, from the ONE place that knows its name. This was a bare literal
// and `e435ac17` moved it, which made every play `cd` into a directory that does not exist -- see
// `control-plane-checkout.mjs` for why four sweeps missed it. Relative, because `ssh()` above lands
// in `/root` first.
const CHECKOUT = CONTROL_PLANE_CHECKOUT;

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
const PLAYBOOKS = ["deploy.yml", "sleep.yml", "provision-role.yml", "recover.yml", "inventory-install.yml",
  "control-host-install.yml", "os-rollback.yml"];

/** Exactly one worker, by name -- what `os-rollback.yml` needs where every other playbook takes a list. */
const ONE_WORKER = /^a11y-worker-[0-9]{1,3}$/;

/**
 * THE TWO REFUSALS THAT BELONG TO AN OS CHANGE, and to nothing else in this allowlist (#921).
 *
 * `--limit` is optional everywhere else because omitting it means "the fleet", which is what a deploy
 * wants. For a Windows rollback, "the fleet" is the one target that must never be expressible, so the
 * flag is required and must name exactly ONE worker. `--apply` is the switch that turns the playbook's
 * read-only dry run into the change; on any other playbook it would be accepted and ignored, which is the
 * silently-discarded-flag shape `refuseUnknownFlags` exists for, so it is refused there by name.
 *
 * @param {{ chosen: string, limitFlag: string | undefined, apply: boolean }} args
 * @returns {string | null} the refusal to print, or null when the combination is allowed
 */
function osRollbackRefusal({ chosen, limitFlag, apply }) {
  if (apply && chosen !== "os-rollback.yml") {
    return `refusing --apply with --playbook=${chosen}: only os-rollback.yml has a change it holds back.`;
  }
  if (chosen === "os-rollback.yml" && !ONE_WORKER.test(limitFlag ?? "")) {
    return "refusing os-rollback.yml without --limit=<one worker>: it changes ONE box's operating system, "
      + `and "${limitFlag ?? "(no --limit, i.e. the whole fleet)"}" is not one worker.`;
  }
  return null;
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
 * Read as TEXT rather than through a YAML parser, matching `inventoryHosts` in `fleet-discover.mjs` —
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
 * imported rather than re-derived — `fleet-discover.mjs` made the same call for the same reason, and a
 * second group parser there is what once reported the lab container as a fifth worker. `WORKER_GROUP` is
 * likewise not restated.
 *
 * @param {string} inventoryText
 * @returns {string | null} the declared build, or null when the WORKER GROUP declares none
 */
export function pinnedBuild(inventoryText) {
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
 *
 * @param {string | null | undefined} windowsVersion
 * @returns {string | null}
 */
export function buildOf(windowsVersion) {
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
 *
 * @param {{ name: string, windowsVersion?: string | null }[]} guests
 * @param {string} pinned
 * @returns {{ compliant: string[], drifted: {name: string, build: string}[], unreadable: string[] }}
 */
export function buildStates(guests, pinned) {
  /** @type {{ compliant: string[], drifted: {name: string, build: string}[], unreadable: string[] }} */
  const states = { compliant: [], drifted: [], unreadable: [] };
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
 * call site needs each guest's `/health` reading, which lives in `fleet-status.mjs` and not in the
 * playbook runner. **That wiring is #921's half** — the row this was split out of, whose acceptance is a
 * run against the real fleet. A function that is perfect and never reached is the defect this repository
 * has hit three times in a week, so the unwired surface is named rather than left for a reviewer to find.
 *
 * @param {{ guests: {name: string, windowsVersion?: string | null}[], pinned: string | null }} input
 * @returns {{ refusal: string | null, notice: string | null }}
 */
export function buildAssertion({ guests, pinned }) {
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
 *
 * @param {{ name: string, health?: Record<string, any> }[]} probes
 * @returns {{ name: string, windowsVersion: string | null }[]}
 */
export function guestBuilds(probes) {
  return probes.map((p) => ({
    name: p.name,
    windowsVersion: p.health?.environment?.windowsVersion ?? null,
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
 *
 * @param {{ chosen: string, inventoryText: string,
 *           guests: {name: string, windowsVersion?: string | null}[] }} input
 * @returns {{ refusal: string | null, notice: string | null }}
 */
export function buildGate({ chosen, inventoryText, guests }) {
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
/** @param {string} ref */
function validRef(ref) {
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
 *
 * @type {Record<string, number>}
 */
// `os-rollback.yml`: a Windows rollback runs inside a restart that can take the better part of an hour, and
// the play waits for it (`win_reboot`'s own ceiling is 90 minutes), so the default would kill a working one.
const PLAYBOOK_TIMEOUT_MS = { "provision-role.yml": 4 * 60 * 60 * 1000, "os-rollback.yml": 2 * 60 * 60 * 1000 };
const DEFAULT_PLAYBOOK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * ARE WE ALREADY ON THE CONTROL PLANE?
 *
 * `lab:pipeline` dispatches itself to the control plane as a systemd unit and re-runs there with
 * `--local`, so every stage of a fleet-bearing pipeline executes ON the box this script otherwise SSHes
 * to. Root-to-root over the lab key is not authorised there — nor should it be — and the failure reads
 * `Permission denied (publickey,password)`, which looks like a broken key rather than a machine talking
 * to itself.
 *
 * Detected from the interfaces rather than the hostname: `A11Y_CONTROL_HOST` is an address, a hostname
 * may not resolve to it, and the question being asked is literally "is that address mine".
 *
 * @param {Record<string, {address?: string}[] | undefined>} [interfaces] injectable, so this is testable
 *        off the control plane — the alternative is a function whose only test is running it there
 * @param {string} [host]
 * @returns {boolean}
 */
function onTheControlPlane(interfaces = networkInterfaces(), host = CONTROL_PLANE) {
  return Object.values(interfaces).flat().some((iface) => iface?.address === host);
}

/**
 * @param {string} command
 * @param {{ capture?: boolean, timeoutMs?: number }} [options]
 */
function ssh(command, { capture = false, timeoutMs = DEFAULT_PLAYBOOK_TIMEOUT_MS } = {}) {
  // Locally when this IS the control plane. `sh -c` and not the ssh path, because ssh to yourself needs a
  // key you should not have to install to talk to your own filesystem.
  if (onTheControlPlane()) {
    return execFileSync("sh", ["-c", `cd /root && ${command}`], {
      encoding: "utf8", stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"], timeout: timeoutMs,
    });
  }
  // requireControlPlaneKey(), not the raw env var: no default (see control-plane-host.mjs, #85), and
  // calling it here rather than caching a module-level constant is what keeps the return type `string`
  // rather than `string | undefined` at the point this array needs a real path.
  const args = ["-i", requireControlPlaneKey(), "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    // The connection must survive a long silent stretch: an NVDA install prints nothing for minutes and a
    // dropped SSH would read as a failed provision. Keepalives are cheap and the alternative is a
    // diagnosis of the wrong thing.
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=20",
    `root@${CONTROL_PLANE}`, command];
  return execFileSync("ssh", args, {
    encoding: "utf8", stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"], timeout: timeoutMs,
  });
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
 * @param {string} rev
 * @returns {string | null}
 */
function resolveOrNull(rev) {
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
const argOf = (/** @type {string} */ name) => flagValue(process.argv, name);

/**
 * Every argument, validated, or a refusal that names which one and what shape it wanted.
 *
 * Extracted from `main` because it grew past the complexity gate as flags were added — and the gate was
 * right: dispatching a playbook and deciding whether the arguments are safe are two things, and each of
 * these refusals exists because the value reaches a shell on the box holding the fleet SSH key.
 *
 * @returns {{chosen: string, limitFlag: string|undefined, serialFlag: string|undefined, ref: string,
 *            allowEdgeDowngrade: boolean, apply: boolean}}
 */
function parseArgs() {
  const refuse = (/** @type {string} */ message) => {
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
  const ref = argOf("ref") ?? localBranch();
  if (!validRef(ref)) refuse(`refusing --ref=${ref}: a commit or simple branch name only.`);

  return { chosen, limitFlag, serialFlag, ref, allowEdgeDowngrade, apply };
}

/**
 * Would this deploy change the protocol the fleet is serving? — asked BEFORE anything is pushed.
 *
 * Only `deploy.yml` ships worker code. `sleep.yml` and `provision-role.yml` cannot move
 * `CAPTURE_PROTOCOL_VERSION`, so gating them would be a guard that fires where the risk is not.
 *
 * Imported from the worker package rather than restated here: the version lives beside the capture code,
 * and a second copy of "what the current protocol is" is precisely the fact-stated-twice shape.
 *
 * @param {string} chosen the playbook about to run
 * @returns {Promise<void>} resolves if the deploy may proceed; exits the process if not
 */
async function guardProtocolChange(chosen) {
  if (chosen !== "deploy.yml") return;
  // READ AS TEXT, NEVER IMPORTED. `capture-core.mjs` imports guidepup, which throws
  // `No available supported screen readers` at import on any host without one — and on a Mac VoiceOver
  // makes that throw invisible, which is exactly why `deploy-worker.mjs` carries the same warning and why
  // `no-win32-imports.test.ts` had to find it. A control-plane script must not depend on the operator's
  // machine having a screen reader. `code-version` is a safe subpath; the version itself is a regex.
  const local = /CAPTURE_PROTOCOL_VERSION = (\d+)/.exec(
    readFileSync(resolve(workerSourceDir(), PROTOCOL_VERSION_FILE), "utf8"))?.[1] ?? null;
  // THE INVENTORY, DIRECTLY — deliberately not `resolveWorkerPool`, and this is the one place that is
  // right. That resolver answers "which workers should I use", and honours `A11Y_WORKER(S)` first because
  // naming workers means you are managing them. This guard asks a different question: "am I about to
  // change the protocol on the machines THIS DEPLOY WILL TOUCH", and Ansible takes its hosts from
  // inventory.yml regardless of anything in the environment. An env var left set would point the guard at
  // machines the deploy is not going to reach, and pass.
  //
  // The SOURCE is still reported, because "the fleet agrees" means nothing until you know which fleet was
  // asked. It is a literal here precisely because there is no choice being made.
  const urls = inventoryWorkerUrls();
  const source = "inventory.yml";
  const verdict = protocolVerdict({
    local,
    served: await servedProtocols(urls),
    allowed: process.argv.includes("--allow-protocol-change"),
    source: PROTOCOL_VERSION_FILE,
  });
  if (verdict.message) process.stdout.write(`${verdict.message}  asked ${urls.length} worker(s) from ${source}.\n`);
  if (verdict.refuse) process.exit(3);
}

/**
 * Does this playbook declare itself a control-plane BOOTSTRAP?
 *
 * The marker lives in the playbook (`# a11y_bootstrap: true`) rather than in a list here, so a second one
 * cannot acquire the exception by being added to an array nobody re-argues. `bootstrap-playbooks-are-
 * declared.test.ts` discovers every carrier and refuses one that also targets `a11y_workers` or
 * `control_plane` — groups that come from the very file a bootstrap installs.
 *
 * @param {string} chosen @returns {boolean}
 */
export function declaresBootstrap(chosen, read = readFileSync) {
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
 *
 * @param {string} chosen @returns {void}
 */
function runBootstrapFromHere(chosen) {
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
 * @param {{ chosen: string, ref: string, expected: string, limitFlag: string|undefined,
 *           serialFlag: string|undefined, allowEdgeDowngrade: boolean, apply: boolean }} spec
 * @returns {string} the unit name
 */
function startPlaybookUnit({ chosen, ref, expected, limitFlag, serialFlag, allowEdgeDowngrade, apply }) {
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
try {
  // `-e a11y_git_ref` is what the GUESTS fetch. Without it they default to `main` and stay exactly where
  // they were, while the control plane sits on the branch you asked for — so `expected_code` is computed
  // from your code and `served_code` from theirs, and the deploy fails with a mismatch that reads like a
  // corrupted guest checkout. Measured 2026-08-24: all four workers held 1f7cb7e88070235d against an
  // expected c6e66caa481b76c0, having faithfully fetched a branch nobody had changed.
  ssh(`systemctl stop ${unit} 2>/dev/null; systemctl reset-failed ${unit} 2>/dev/null; `
    + `systemd-run --unit=${unit} --remain-after-exit --working-directory=${CHECKOUT}/packages/control/ansible `
    + `--setenv=ANSIBLE_CONFIG=ansible.cfg `
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
    + `ansible-playbook ${chosen} -e a11y_git_ref=${ref}`
    // The COMMIT that ref resolves to here, so each guest can assert it landed on it rather than the
    // deploy inferring success from a shell that exited 0. The 2026-08-24 note above fixed WHICH ref
    // the guests fetch; this catches the fetch silently not taking.
    + ` -e a11y_expected_commit=${expected}`
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
    + (apply ? " -e a11y_os_rollback_apply=true" : ""),
  { timeoutMs: PLAYBOOK_TIMEOUT_MS[chosen] ?? DEFAULT_PLAYBOOK_TIMEOUT_MS });
} catch (cause) {
  // `execFileSync` throws an Error carrying the child's exit status, which node's types do not describe.
  // The status is what this block exists to surface AND to exit with, so it is load-bearing.
  const failure = /** @type {{ status?: number }} */ (cause);
  process.stderr.write(`\n  ${chosen} FAILED TO START (exit ${failure.status ?? "?"}).\n`);
  process.exit(failure.status ?? 1);
}
  return unit;
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
 * @param {string} ref the branch name to be ON -- `HEAD` on a detached checkout, which is a no-op checkout
 * @param {string} expected the commit resolved ONCE, here, and the only thing the read-back compares
 * @returns {string} the shell command to run on the control plane
 */
export function controlPlaneCheckout(ref, expected) {
  return `cd ${CHECKOUT} && git fetch --quiet --all && git checkout --quiet ${ref} `
    + `&& git merge --ff-only --quiet ${expected}`;
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
 * @param {{ ref: string, local: string, origin: string | null }} resolved
 * @returns {string | null} the refusal to print, or `null` when the two agree
 */
export function staleRefRefusal({ ref, local, origin }) {
  if (origin === local) return null;
  const short = (/** @type {string} */ sha) => sha.slice(0, 12);
  if (origin === null) {
    return [
      `REFUSING: --ref=${ref} resolves to ${short(local)} here, and \`origin/${ref}\` does not resolve.`,
      "There is nothing to compare it against, and the control plane has no such branch to check out --",
      "its own `git checkout` would fail in git's words, naming neither the flag nor the reason.",
      "",
      `  Push the branch:   git push -u origin ${ref}`,
      "  Or name one origin already has:   --ref=main   (with `npm run primary:update` run first)",
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
    "  To deploy origin's tip:      npm run primary:update   (then re-run this)",
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
 *
 * @param {string} ref
 * @param {string} expected
 */
function requireCommitIsOnOrigin(ref, expected) {
  const remotes = execFileSync("git", ["branch", "-r", "--contains", expected],
    { encoding: "utf8", env: sandboxGitEnv() }).trim();
  if (remotes) return;
  process.stderr.write([
    `REFUSING: ${expected.slice(0, 12)} (${ref}) is on no remote-tracking branch, so the control plane`,
    "cannot fetch it and the deploy would fail on a git message naming neither the flag nor the reason.",
    "  Push the commit first, or `npm run primary:update` if you meant to deploy origin/main.",
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
 *
 * @returns {string}
 */
function inventoryTextOrEmpty() {
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
async function enforceBuildPin(chosen) {
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
 *
 * @param {string} ref
 */
function refuseCommitShapedRef(ref) {
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

async function main() {
  // Throws before anything else if neither A11Y_CONTROL_HOST nor its installed file exist -- see #83, #285.
  CONTROL_PLANE = requireControlPlaneHost();
  requireControlPlaneKey(); // same, for A11Y_PVE_KEY -- see #85
  const { chosen, limitFlag, serialFlag, ref, allowEdgeDowngrade, apply } = parseArgs();
  await guardProtocolChange(chosen);

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
  ssh(controlPlaneCheckout(ref, expected));

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
  const unit = startPlaybookUnit({ chosen, ref, expected, limitFlag, serialFlag, allowEdgeDowngrade, apply });

  process.stdout.write(`  started as ${unit} on ${CONTROL_PLANE}. It now outlives this terminal.\n`
    + `  if this command dies, the deploy does not — follow it again with the same command, or:\n`
    + `    ssh root@${CONTROL_PLANE} 'systemctl status ${unit}'\n\n`);
  const outcome = await followUnit(unit, PLAYBOOK_TIMEOUT_MS[chosen] ?? DEFAULT_PLAYBOOK_TIMEOUT_MS);

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
 *
 * @param {string} unit @param {string} invocation
 * @returns {string}
 */
function journalScope(unit, invocation) {
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
export function deployedToNothing(log) {
  const text = String(log ?? "");
  if (!/skipping: no hosts matched|provided hosts list is empty/.test(text)) return null;
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
 *
 * @param {string} unit @param {number} budgetMs
 * @returns {Promise<{ status: number, log: string }>}
 */
async function followUnit(unit, budgetMs) {
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

export { validRef, PLAYBOOKS, LIMIT_PATTERN, SERIAL_PATTERN, PLAYBOOK_TIMEOUT_MS,
  DEFAULT_PLAYBOOK_TIMEOUT_MS, onTheControlPlane, journalScope, osRollbackRefusal };
