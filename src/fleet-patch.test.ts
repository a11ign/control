// no-token: gh -- every test below drives pure functions (`patchRefusal`, `patchOutcome`, `sequenceHoldGate`, `linkGateFor`) or reads
// a file as text; none calls `enforceSequenceHold` or `readFleetGatedIssues`, so fleet-playbook.ts's own `gh` call is never reached.
/**
 * #4446, A11-205: `fleet:patch` -- the deliberate upgrade as a command, with the fleet's safeties. There is no schedule that runs it.
 *
 * Each requirement carries a positive AND a negative control: a refusal test that also shows the same input passing
 * once the cause is removed, so "refused" is not what an empty or broken population would print anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PLAYBOOKS, patchRefusal, patchOutcome, patchPlan, patchBoxOf, patchTargetLine, patchFollowBudgetMs, boxAgainstManifest,
  PLAYBOOK_TIMEOUT_MS, sequenceHoldGate, activeFleetHolds, linkGateFor, osRollbackRefusal } from "./fleet-playbook.ts";
import type { PatchBox, PatchTarget } from "./fleet-playbook.ts";
import { readFleetPins } from "./fleet-pins.ts";
import { upgradeStepsOf, failedBoxesOf, stoppedLine, closingRefusal, runUpgrade } from "./fleet-upgrade.ts";
import type { StepResult, UpgradeStep } from "./fleet-upgrade.ts";
import { driftRecordOf } from "./fleet-drift.ts";
import type { WorkerProbe } from "./fleet-status.ts";

/** The manifest's own Windows pin: no test here restates a version, so none can disagree with `deploy-pins.json`. */
const TARGET: PatchTarget = readFleetPins().windows;
const CURRENT_BUILD = Number(TARGET.build.split(".")[0]);

/** `/health`'s `windowsVersion` is `Win32_OperatingSystem.Version`: `<major>.<minor>.<CurrentBuild>`, never a UBR. */
const onBuild = (name: string, currentBuild: number, extra: Partial<PatchBox> = {}): PatchBox =>
  ({ name, reachable: true, busy: false, build: `10.0.${currentBuild}`, ...extra });
const idle = (name: string): PatchBox => onBuild(name, CURRENT_BUILD);
const FLEET = ["a11y-worker-2", "a11y-worker-3", "a11y-worker-4"].map(idle);

// ---------------------------------------------------------------------------------------------------------------------
// 1. DRY BY DEFAULT, AND --apply RUNS
// ---------------------------------------------------------------------------------------------------------------------

test("#4446: patch.yml is a playbook the wrapper may run, and --apply is allowed for it and refused for a deploy", () => {
  assert.ok(PLAYBOOKS.includes("patch.yml"));
  assert.equal(osRollbackRefusal({ chosen: "patch.yml", limitFlag: undefined, apply: true }), null);
  assert.match(osRollbackRefusal({ chosen: "deploy.yml", limitFlag: undefined, apply: true }) ?? "", /refusing --apply/,
    "negative control: the flag is still refused where nothing is held back");
});

test("#4446: no --apply is a PLAN and ends; --apply goes on to run; a refusal beats both", () => {
  assert.equal(patchOutcome({ apply: false, refusal: null }), "plan");
  assert.equal(patchOutcome({ apply: true, refusal: null }), "run");
  assert.equal(patchOutcome({ apply: false, refusal: "REFUSING" }), "refuse");
  assert.equal(patchOutcome({ apply: true, refusal: "REFUSING" }), "refuse");
});

test("#4446: the plan names EVERY box, says dry or apply, and leaves a box outside --limit alone", () => {
  const dry = patchPlan({ boxes: FLEET, limitFlag: undefined, apply: false, target: TARGET }).join("\n");
  for (const { name } of FLEET) assert.match(dry, new RegExp(`${name}\\s{2}would upgrade`));
  assert.match(dry, /dry: nothing is changed/);
  const applied = patchPlan({ boxes: FLEET, limitFlag: "a11y-worker-3", apply: true, target: TARGET }).join("\n");
  assert.match(applied, /a11y-worker-3\s{2}will upgrade/);
  assert.match(applied, /a11y-worker-2\s{2}left alone \(outside --limit\)/, "negative control: a box not named is not planned");
  assert.doesNotMatch(applied, /dry: nothing is changed/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. REFUSED UNDER A FUTURE Fleet-hold-until, ALLOWED ONCE IT HAS PASSED
// ---------------------------------------------------------------------------------------------------------------------

test("#4446: a future Fleet-hold-until refuses patch.yml, and the same hold allows it once the time has passed", () => {
  const until = "2026-10-12T06:00:00Z";
  const issues = [{ number: 4400, body: `Fleet-hold-until: ${until}` }];
  const before = activeFleetHolds(issues, Date.parse("2026-10-11T00:00:00Z"));
  const refused = sequenceHoldGate({ chosen: "patch.yml", holds: before, allowHold: [] });
  assert.match(String(refused.refusal), /#4400/);
  const after = activeFleetHolds(issues, Date.parse("2026-10-13T00:00:00Z"));
  assert.deepEqual(after, [], "the hold is read as over");
  assert.deepEqual(sequenceHoldGate({ chosen: "patch.yml", holds: after, allowHold: [] }), { refusal: null, notice: null });
});

test("#4446: a fleet that cannot be asked refuses patch.yml, in the link gate's words, rather than patching a subset", async () => {
  const unreadable = await linkGateFor({ chosen: "patch.yml", argv: ["--playbook=patch.yml"],
    ansibleCfgText: "[defaults]\ninventory = /etc/a11ign/inventory.yml\n", groupVarsText: "",
    readInventories: () => { throw new Error("ssh to the control plane failed: no route"); } });
  assert.match(String(unreadable.refusal), /REFUSING patch\.yml: .*Could not ask is not may proceed/);
  const control = await linkGateFor({ chosen: "recover.yml", argv: [], ansibleCfgText: "", groupVarsText: "",
    readInventories: () => { throw new Error("must not be called"); } });
  assert.equal(control.refusal, null, "negative control: an ungated playbook never asks, so the refusal above is patch.yml's own");
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. REFUSED WHEN A BOX IS BUSY
// ---------------------------------------------------------------------------------------------------------------------

test("#4446: a busy box refuses the run, and the same fleet passes once it is idle", () => {
  const busy = [idle("a11y-worker-2"), { ...idle("a11y-worker-3"), busy: true }];
  const refusal = patchRefusal({ apply: true, limitFlag: undefined, boxes: busy, allowOffline: [], target: TARGET });
  assert.match(String(refusal), /a11y-worker-3 is busy/);
  assert.equal(patchRefusal({ apply: true, limitFlag: undefined, boxes: FLEET, allowOffline: [], target: TARGET }), null);
});

test("#4446: a box that did not answer refuses it too, and --allow-offline names one a human accepted", () => {
  const silent = [idle("a11y-worker-2"), { name: "a11y-worker-5", reachable: false, busy: false, build: null }];
  assert.match(String(patchRefusal({ apply: true, limitFlag: undefined, boxes: silent, allowOffline: [], target: TARGET })), /a11y-worker-5 did not answer/);
  assert.equal(patchRefusal({ apply: true, limitFlag: undefined, boxes: silent, allowOffline: ["a11y-worker-5"], target: TARGET }), null);
});

test("#4446: a payload that does not SAY it is idle is busy -- the playbook's own `busy | default(true)`", () => {
  const unsaid = patchBoxOf({ name: "a11y-worker-2", reachable: true, health: {}, progress: {} });
  assert.equal(unsaid.busy, true);
  assert.equal(patchBoxOf({ name: "a11y-worker-2", reachable: true, health: { busy: false }, progress: { busy: false } }).busy, false);
  assert.equal(patchBoxOf({ name: "a11y-worker-2", reachable: true, health: { busy: false }, progress: { busy: true } }).busy, true,
    "progress outranks health: one instant, not two");
});

test("#4446: --limit naming more than one box needs --apply; one box, or --apply, does not", () => {
  const many = "a11y-worker-2,a11y-worker-3";
  assert.match(String(patchRefusal({ apply: false, limitFlag: many, boxes: FLEET, allowOffline: [], target: TARGET })), /without --apply/);
  assert.equal(patchRefusal({ apply: true, limitFlag: many, boxes: FLEET, allowOffline: [], target: TARGET }), null);
  assert.equal(patchRefusal({ apply: false, limitFlag: "a11y-worker-2", boxes: FLEET, allowOffline: [], target: TARGET }), null);
  assert.equal(patchRefusal({ apply: false, limitFlag: undefined, boxes: FLEET, allowOffline: [], target: TARGET }), null,
    "no --limit is the whole-fleet PLAN, which is the dry run's job");
  assert.match(String(patchRefusal({ apply: false, limitFlag: "a11y_workers", boxes: FLEET, allowOffline: [], target: TARGET })), /3 boxes/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. THERE IS NO PATCH WINDOW (A11-205): NOTHING RUNS patch.yml ON A CLOCK, AND THE WRAPPER CANNOT BE ASKED TO
// ---------------------------------------------------------------------------------------------------------------------

const REFUSED_FLAGS = ["--scheduled", "--window-days=28", "--retry-days=7", "--weekday=6", "--window-start-hour=2", "--window-end-hour=6"];
const WRAPPER = fileURLToPath(new URL("./fleet-playbook.ts", import.meta.url));

test("A11-205: the wrapper refuses every flag of the patch window, so a unit that still passes one fails instead of running", () => {
  for (const flag of REFUSED_FLAGS) {
    const run = spawnSync(process.execPath, [WRAPPER, "--playbook=patch.yml", "--apply", flag],
      { encoding: "utf8", env: { ...process.env, A11Y_CONTROL_HOST: "", A11Y_PVE_KEY: "" } });
    assert.notEqual(run.status, 0, flag);
    assert.match(run.stderr, /unknown flag|refusing|unrecognised/i, `${flag} must be refused by name: ${run.stderr}`);
  }
  // The negative control: the same command line without the flag does not stop at the flag. It goes on to the control-plane
  // lookup, which has no host here, and refuses THERE.
  const clean = spawnSync(process.execPath, [WRAPPER, "--playbook=patch.yml", "--apply"],
    { encoding: "utf8", env: { ...process.env, A11Y_CONTROL_HOST: "", A11Y_PVE_KEY: "" } });
  assert.doesNotMatch(clean.stderr, /unknown flag|unrecognised/i);
});

test("A11-205: the patch window's playbook, its record and its health line are gone from the code", () => {
  assert.equal(existsSync(fileURLToPath(new URL("../ansible/patch-schedule.yml", import.meta.url))), false, "patch-schedule.yml is deleted");
  for (const name of ["PATCH_RUN_RECORD", "patchRunRecordCommand", "scheduledPatchRun", "patchScheduleDecision", "scheduleOrRefuse", "patchHealthLine", "PATCH_WINDOW_MISSED_EXIT_CODE"]) {
    assert.doesNotMatch(PLAYBOOK_SOURCE, new RegExp(`\\b${name}\\b`), `${name} is still in fleet-playbook.ts`);
  }
  const watch = readFileSync(fileURLToPath(new URL("./fleet-watch.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(watch, /patch-window-missed|PATCH_RUN_PATH|fleet-patch-last-run/, "fleet-watch no longer reads a patch window");
  // That `fleet:patch-schedule` is gone from the package scripts is pinned in `scripts/control-commands.test.ts`: the package.json laid inside the core carries no `scripts`.
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. A11-205: THE TARGET IS THE MANIFEST'S. THE WRAPPER READS NO TARGET FROM THE FLEET AND HANDS patch.yml NONE.
// ---------------------------------------------------------------------------------------------------------------------

const PLAYBOOK_SOURCE = readFileSync(fileURLToPath(new URL("./fleet-playbook.ts", import.meta.url)), "utf8");
const MIXED = [onBuild("a11y-worker-2", 22631), onBuild("a11y-worker-7", CURRENT_BUILD), onBuild("a11y-worker-10", CURRENT_BUILD + 100)];

test("A11-205: the code that took the fleet's newest build as the target is deleted, and so are its tests' subjects", () => {
  for (const name of ["fleetTopBuild", "patchTargetOf", "parsePatchTargetRead", "patchTargetReadCommand", "patchTargetExtraVars", "PATCH_TARGET_READ_TIMEOUT_MS", "PatchTargetReading"]) {
    assert.doesNotMatch(PLAYBOOK_SOURCE, new RegExp(`\\b${name}\\b`), `${name} is still in fleet-playbook.ts`);
  }
});

test("A11-205: where a box stands against the manifest is judged on the CurrentBuild /health reports, and an unreadable build is `unread`", () => {
  assert.equal(boxAgainstManifest(onBuild("a", CURRENT_BUILD - 1), TARGET), "below");
  assert.equal(boxAgainstManifest(onBuild("a", CURRENT_BUILD), TARGET), "same");
  assert.equal(boxAgainstManifest(onBuild("a", CURRENT_BUILD + 1), TARGET), "above");
  assert.equal(boxAgainstManifest(onBuild("a", 0, { build: null }), TARGET), "unread");
  assert.equal(boxAgainstManifest(onBuild("a", CURRENT_BUILD * 10), TARGET), "above", "numbers, not text");
});

test("A11-205: the plan names the manifest's target and marks the boxes that need a feature update or are above it", () => {
  const plan = patchPlan({ boxes: MIXED, limitFlag: undefined, apply: false, target: TARGET }).join("\n");
  assert.ok(plan.includes(patchTargetLine(TARGET)));
  assert.match(plan, new RegExp(`target: Windows ${TARGET.release} ${TARGET.build.replace(/\./g, "\\.")} \\(${TARGET.kb}\\), from deploy-pins\\.json`));
  assert.match(plan, /a11y-worker-2\s+would upgrade\s+\[10\.0\.22631\] \(a feature update first\)/);
  assert.match(plan, /a11y-worker-10\s+would upgrade\s+\[10\.0\.\d+\] \(ABOVE the manifest: refused, never rolled back\)/);
  assert.doesNotMatch(plan.split("\n").find((line) => line.includes("a11y-worker-7")) ?? "", /feature update|ABOVE/, "a box on the manifest's build carries no note");
  assert.doesNotMatch(plan, /newest|highest|-e patch_target/);
});

test("A11-205: with the boxes read against the manifest, the plan says which have nothing to upgrade and what each other box is missing", () => {
  const boxes = [idle("a11y-worker-2"), idle("a11y-worker-3"), onBuild("a11y-worker-5", 22631)];
  const differences = [{ box: "a11y-worker-3", field: "Edge", has: "155.0.4283.62", wants: "156.0.4314.42" },
    { box: "a11y-worker-5", field: "Windows", has: "22631.6199", wants: TARGET.build }];
  const plan = patchPlan({ boxes, limitFlag: undefined, apply: false, target: TARGET, differences }).join("\n");
  assert.match(plan, /a11y-worker-2\s+on the manifest, nothing to upgrade\s+\[10\.0\.\d+\]\n/);
  assert.match(plan, /a11y-worker-3\s+would upgrade\s+\[10\.0\.\d+\] -- Edge 155\.0\.4283\.62 -> 156\.0\.4314\.42\n/);
  assert.match(plan, /a11y-worker-5\s+would upgrade\s+\[10\.0\.22631\] \(a feature update first\) -- Windows 22631\.6199 -> /);
  // negative controls: a plan made without the reading claims nothing, and a box that was not asked about is never "on the manifest"
  const unread = patchPlan({ boxes, limitFlag: undefined, apply: false, target: TARGET }).join("\n");
  assert.doesNotMatch(unread, /nothing to upgrade/);
  const unreported = patchPlan({ boxes: [idle("a11y-worker-2")], limitFlag: undefined, apply: false, target: TARGET,
    differences: [{ box: "a11y-worker-2", field: "NVDA", has: null, wants: "2026.1.1" }] }).join("\n");
  assert.match(unreported, /a11y-worker-2\s+would upgrade.* -- NVDA unreported -> 2026\.1\.1/);
  assert.match(patchPlan({ boxes: [{ ...idle("a11y-worker-2"), busy: true }], limitFlag: undefined, apply: true, target: TARGET, differences: [] }).join("\n"),
    /a11y-worker-2\s+on the manifest, nothing to upgrade \(BUSY\)/);
});

test("A11-205: a box ABOVE the manifest refuses the run before anything is touched, naming it; it is never rolled back", () => {
  const refusal = patchRefusal({ apply: true, limitFlag: undefined, boxes: MIXED, allowOffline: [], target: TARGET });
  assert.match(String(refusal), /REFUSING patch\.yml: a11y-worker-10 \(build 10\.0\.\d+\) is ABOVE the manifest's Windows build /);
  assert.match(String(refusal), /never rolled back/);
  const onManifest = MIXED.filter((box) => box.name !== "a11y-worker-10");
  assert.equal(patchRefusal({ apply: true, limitFlag: undefined, boxes: onManifest, allowOffline: [], target: TARGET }), null,
    "negative control: the same fleet without the box above the manifest runs (a box BELOW it is what the run is for)");
  assert.equal(patchRefusal({ apply: true, limitFlag: "a11y-worker-2", boxes: MIXED, allowOffline: [], target: TARGET }), null,
    "a box above the manifest outside --limit is not touched by this run");
});

test("A11-205: the follow budget is the sum over the boxes the run touches: a feature update's budget below the manifest, an hour otherwise, never under 4 h", () => {
  const cumulative = PLAYBOOK_TIMEOUT_MS["patch.yml"];
  const HOUR = 60 * 60 * 1000;
  const fifteenBelow = Array.from({ length: 15 }, (_, i) => onBuild(`a11y-worker-${i + 2}`, CURRENT_BUILD - 100));
  const fifteenCurrent = Array.from({ length: 15 }, (_, i) => onBuild(`a11y-worker-${i + 2}`, CURRENT_BUILD));
  assert.equal(patchFollowBudgetMs({ boxes: fifteenBelow, limitFlag: undefined, target: TARGET }), 15 * 2.5 * HOUR);
  assert.equal(patchFollowBudgetMs({ boxes: fifteenCurrent, limitFlag: undefined, target: TARGET }), Math.max(cumulative, 15 * HOUR),
    "a fleet already on the manifest's release still reads, installs and checks every box");
  assert.equal(patchFollowBudgetMs({ boxes: fifteenBelow, limitFlag: "a11y-worker-2", target: TARGET }), cumulative, "one box, 2.5 h, is under the floor");
  assert.equal(patchFollowBudgetMs({ boxes: fifteenBelow, limitFlag: "a11y-worker-2,a11y-worker-3", target: TARGET }), 5 * HOUR,
    "two boxes are over it: --limit counts only the boxes the run touches");
});

test("A11-205: the dispatch hands patch.yml no target, and the gate's budget is the one the unit is followed for", () => {
  const start = PLAYBOOK_SOURCE.indexOf("systemd-run --unit=");
  const end = PLAYBOOK_SOURCE.indexOf("{ timeoutMs: PLAYBOOK_TIMEOUT_MS[chosen]", start);
  assert.ok(start > 0 && end > start, "the argv builder's anchors have drifted");
  assert.doesNotMatch(PLAYBOOK_SOURCE.slice(start, end), /patch_target/, "no -e target reaches the play: it reads the manifest itself");
  assert.match(PLAYBOOK_SOURCE, /followUnit\(unit, patchGate\.followBudgetMs\)/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. A11-205: THE DELIBERATE UPGRADE IS A CHAIN -- deploy.yml, patch.yml, THEN A READ OF EVERY BOX -- AND IT STOPS AT THE FIRST FAILURE, NAMING THE BOX
// ---------------------------------------------------------------------------------------------------------------------

const RECAP = (rows: Record<string, { failed?: number; unreachable?: number; }>) =>
  `PLAY RECAP *********************************************************************\n${Object.entries(rows).map(([box, { failed = 0, unreachable = 0 }]) =>
    `${box.padEnd(26)}: ok=18   changed=2    unreachable=${unreachable}    failed=${failed}    skipped=3    rescued=0    ignored=0`).join("\n")}\n`;
const OK: StepResult = { status: 0, output: RECAP({ "a11y-worker-2": {}, "a11y-worker-3": {} }) };

const reading = (n: number, ...[edge]: [string?]): WorkerProbe => ({
  name: `a11y-worker-${n}`, url: `http://192.0.2.${n}:8765`, reachable: true,
  health: { code: "c0de", environment: { browserVersion: edge ?? "156.0.4314.42", screenReaderVersion: "2026.1.1", windowsBuild: "26300.9711" } } });
const EXPECTED = { Windows: "26300.9711", Edge: "156.0.4314.42", NVDA: "2026.1.1", "Worker code": "c0de" };
const recordOver = async (probes: WorkerProbe[]) => {
  const { readFleetDrift } = await import("./fleet-drift.ts");
  return driftRecordOf({ ...await readFleetDrift({ workers: () => probes.map(({ name, url }) => ({ name, url })),
    probe: async (worker) => probes.find((p) => p.name === worker.name) as WorkerProbe, expected: () => EXPECTED }), previous: null, freeze: null, now: new Date("2026-10-25T10:00:00Z") });
};

/** `runUpgrade` over scripted plays: the steps it ran, what it said, and its exit code. */
async function chain(args: string[], results: Record<string, StepResult>, probes: WorkerProbe[] = [reading(2), reading(3)]) {
  const ran: string[] = [];
  const said: string[] = [];
  let read = 0;
  const code = await runUpgrade(args, {
    run: async (step: UpgradeStep) => { ran.push(`${step.playbook} ${step.args.join(" ")}`.trim()); return results[step.playbook] ?? OK; },
    read: async () => { read += 1; return recordOver(probes); },
    say: (line) => said.push(line),
  });
  return { code, ran, said: said.join(""), read };
}

test("A11-205: without --apply only patch.yml runs, to print its plan, and no box is read", async () => {
  assert.deepEqual(upgradeStepsOf([]), [{ playbook: "patch.yml", args: [] }]);
  const run = await chain([], {});
  assert.deepEqual(run.ran, ["patch.yml"]);
  assert.equal(run.read, 0);
  assert.equal(run.code, 0);
  assert.match(run.said, /This was the plan/);
});

test("A11-205: --apply runs deploy.yml (which refuses --apply), then patch.yml, then reads every box; the other arguments go to both plays", async () => {
  const steps = upgradeStepsOf(["--apply", "--limit=a11y-worker-2,a11y-worker-3", "--allow-offline=a11y-worker-5"]);
  assert.deepEqual(steps.map(({ playbook }) => playbook), ["deploy.yml", "patch.yml"]);
  assert.deepEqual(steps[0].args, ["--limit=a11y-worker-2,a11y-worker-3", "--allow-offline=a11y-worker-5"], "deploy.yml is not asked for --apply");
  assert.deepEqual(steps[1].args, ["--apply", "--limit=a11y-worker-2,a11y-worker-3", "--allow-offline=a11y-worker-5"]);
  const run = await chain(["--apply"], {});
  assert.deepEqual(run.ran, ["deploy.yml", "patch.yml --apply"]);
  assert.equal(run.read, 1);
  assert.equal(run.code, 0);
  assert.match(run.said, /fleet on the manifest — /);
  assert.match(run.said, /fleet:patch completed: every box was read back and is on the manifest/);
});

test("A11-205: a failing deploy.yml stops the run: patch.yml never starts, no box is read, and the box is named", async () => {
  const run = await chain(["--apply"], { "deploy.yml": { status: 2, output: RECAP({ "a11y-worker-2": {}, "a11y-worker-4": { failed: 1 } }) } });
  assert.deepEqual(run.ran, ["deploy.yml"], "negative control for the next case: patch.yml is the play that did not run");
  assert.equal(run.read, 0);
  assert.equal(run.code, 2, "the play's own exit code");
  assert.match(run.said, /fleet:patch STOPPED at deploy\.yml \(exit 2\): a11y-worker-4 is the box it stopped on\. Nothing was rolled back and nothing after this step ran/);
});

test("A11-205: a failing patch.yml stops the run at that box, names it, and does not read the fleet as if it had finished", async () => {
  const run = await chain(["--apply"], { "patch.yml": { status: 2,
    output: `fatal: [a11y-worker-7]: FAILED! => {"msg": "a11y-worker-7 is on 26300.10000, ABOVE the manifest's build"}\n${RECAP({ "a11y-worker-2": {}, "a11y-worker-7": { failed: 1 } })}` } });
  assert.deepEqual(run.ran, ["deploy.yml", "patch.yml --apply"]);
  assert.equal(run.read, 0);
  assert.equal(run.code, 2);
  assert.match(run.said, /STOPPED at patch\.yml \(exit 2\): a11y-worker-7 is the box it stopped on/);
});

test("A11-205: an unreachable box in the recap is named too, and a refusal before any play names none", () => {
  assert.deepEqual(failedBoxesOf(RECAP({ "a11y-worker-3": { unreachable: 1 }, "a11y-worker-12": { failed: 2 }, "a11y-worker-2": {} })), ["a11y-worker-3", "a11y-worker-12"]);
  assert.deepEqual(failedBoxesOf(RECAP({ "a11y-worker-2": {}, "a11y-worker-3": {} })), [], "negative control: a clean recap names nobody");
  assert.deepEqual(failedBoxesOf("REFUSING patch.yml: a11y-worker-5 is busy."), []);
  assert.match(stoppedLine({ playbook: "patch.yml", args: [] }, { status: 2, output: "REFUSING patch.yml: a11y-worker-5 is busy." }), /the output above names no box/);
  assert.match(stoppedLine({ playbook: "patch.yml", args: [] }, { status: 2, output: RECAP({ "a11y-worker-3": { failed: 1 }, "a11y-worker-4": { failed: 1 } }) }),
    /a11y-worker-3, a11y-worker-4 are the boxes it stopped on/);
});

test("A11-205: the run ends by reading EVERY box: a box that differs, or does not answer, fails the run even though both plays succeeded", async () => {
  const differs = await chain(["--apply"], {}, [reading(2), reading(3, "157.0.1.1")]);
  assert.equal(differs.code, 3);
  assert.match(differs.said, /fleet OFF THE MANIFEST — a11y-worker-3 Edge has 157\.0\.1\.1, the manifest wants 156\.0\.4314\.42/);
  assert.match(differs.said, /fleet:patch FAILED its closing read/);
  assert.doesNotMatch(differs.said, /completed/);
  const silent: WorkerProbe = { name: "a11y-worker-3", url: "http://192.0.2.3:8765", reachable: false, error: "ETIMEDOUT" };
  const unread = await chain(["--apply"], {}, [reading(2), silent]);
  assert.equal(unread.code, 3, "a box nobody could read has not been shown to be on the manifest");
  assert.match(unread.said, /not read at the end of the upgrade \(so not shown to be on the manifest\): a11y-worker-3/);
  assert.equal(closingRefusal(await recordOver([reading(2), reading(3)])), null, "negative control: every box answered and agrees");
});

test("A11-205: the package script runs the chain, and `fleet:drift` runs the reading", () => {
  const scripts = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { scripts: Record<string, string>; }).scripts;
  assert.equal(scripts["fleet:patch"], "node src/fleet-upgrade.ts");
  assert.equal(scripts["fleet:drift"], "node src/fleet-drift.ts");
});
