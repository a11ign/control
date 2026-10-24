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

import { PLAYBOOKS, patchRefusal, patchOutcome, patchPlan, patchBoxOf,
  patchTargetOf, patchTargetExtraVars, patchTargetLine, patchTargetReadCommand, patchFollowBudgetMs, fleetTopBuild,
  compareBuilds, PLAYBOOK_TIMEOUT_MS,
  sequenceHoldGate, activeFleetHolds, linkGateFor, osRollbackRefusal } from "./fleet-playbook.ts";
import type { PatchBox, PatchTargetReading } from "./fleet-playbook.ts";

const idle = (name: string): PatchBox => ({ name, reachable: true, busy: false, build: "26100.4061" });
const FLEET = ["a11y-worker-2", "a11y-worker-3", "a11y-worker-4"].map(idle);
const NO_TARGET: PatchTargetReading = { target: null, why: "not read in this test" };

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
  const dry = patchPlan({ boxes: FLEET, limitFlag: undefined, apply: false, target: NO_TARGET }).join("\n");
  for (const { name } of FLEET) assert.match(dry, new RegExp(`${name}\\s{2}would patch`));
  assert.match(dry, /dry: nothing is changed/);
  const applied = patchPlan({ boxes: FLEET, limitFlag: "a11y-worker-3", apply: true, target: NO_TARGET }).join("\n");
  assert.match(applied, /a11y-worker-3\s{2}will patch/);
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
  const refusal = patchRefusal({ apply: true, limitFlag: undefined, boxes: busy, allowOffline: [] });
  assert.match(String(refusal), /a11y-worker-3 is busy/);
  assert.equal(patchRefusal({ apply: true, limitFlag: undefined, boxes: FLEET, allowOffline: [] }), null);
});

test("#4446: a box that did not answer refuses it too, and --allow-offline names one a human accepted", () => {
  const silent = [idle("a11y-worker-2"), { name: "a11y-worker-5", reachable: false, busy: false, build: null }];
  assert.match(String(patchRefusal({ apply: true, limitFlag: undefined, boxes: silent, allowOffline: [] })), /a11y-worker-5 did not answer/);
  assert.equal(patchRefusal({ apply: true, limitFlag: undefined, boxes: silent, allowOffline: ["a11y-worker-5"] }), null);
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
  assert.match(String(patchRefusal({ apply: false, limitFlag: many, boxes: FLEET, allowOffline: [] })), /without --apply/);
  assert.equal(patchRefusal({ apply: true, limitFlag: many, boxes: FLEET, allowOffline: [] }), null);
  assert.equal(patchRefusal({ apply: false, limitFlag: "a11y-worker-2", boxes: FLEET, allowOffline: [] }), null);
  assert.equal(patchRefusal({ apply: false, limitFlag: undefined, boxes: FLEET, allowOffline: [] }), null,
    "no --limit is the whole-fleet PLAN, which is the dry run's job");
  assert.match(String(patchRefusal({ apply: false, limitFlag: "a11y_workers", boxes: FLEET, allowOffline: [] })), /3 boxes/);
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
// 6. #4905: THE TARGET THE WINDOW BRINGS A BOX UP TO, READ FROM THE FLEET AND HANDED TO patch.yml
// ---------------------------------------------------------------------------------------------------------------------

const PATCH_YML = readFileSync(fileURLToPath(new URL("../ansible/patch.yml", import.meta.url)), "utf8");
const PLAYBOOK_SOURCE = readFileSync(fileURLToPath(new URL("./fleet-playbook.ts", import.meta.url)), "utf8");

/** `/health`'s `windowsVersion` is `Win32_OperatingSystem.Version`: `<major>.<minor>.<CurrentBuild>`, never a UBR. */
const onBuild = (name: string, currentBuild: number, extra: Partial<PatchBox> = {}): PatchBox =>
  ({ name, reachable: true, busy: false, build: `10.0.${currentBuild}`, ...extra });
const adHoc = (...reads: [string, string][]) =>
  reads.map(([name, line]) => `${name} | CHANGED | rc=0 >>\n${line}\r\n`).join("\n");
const MIXED = [onBuild("a11y-worker-2", 22631), onBuild("a11y-worker-7", 26100), onBuild("a11y-worker-10", 26200),
  onBuild("a11y-worker-12", 26200)];

test("#4905: guests reporting builds yield a target, and BOTH -e reach the argv -- read off the top build's boxes only", () => {
  const asked: string[] = [];
  const reading = patchTargetOf({ boxes: MIXED, read: (command) => {
    asked.push(command);
    return adHoc(["a11y-worker-10", "26200.9457 25H2"], ["a11y-worker-12", "26200.9457 25H2"]);
  } });
  assert.deepEqual(reading.target, { release: "25H2", build: "26200.9457" });
  assert.equal(asked.length, 1);
  assert.match(asked[0], / ansible a11y-worker-10,a11y-worker-12 -m ansible\.windows\.win_shell /,
    "only the boxes on the fleet's highest build are asked, and nothing is written to them");
  assert.doesNotMatch(asked[0], /a11y-worker-2|a11y-worker-7/);
  assert.equal(patchTargetExtraVars(reading.target), " -e patch_target_release=25H2 -e patch_target_build=26200.9457");
});

test("#4905 NEGATIVE CONTROL: a fleet that reports no readable build passes NEITHER -e, and never asks a box", () => {
  let called = false;
  const silent = [onBuild("a11y-worker-2", 0, { build: null }), onBuild("a11y-worker-3", 0, { build: "10.0.26200", reachable: false })];
  const reading = patchTargetOf({ boxes: silent, read: () => { called = true; return ""; } });
  assert.equal(reading.target, null);
  assert.equal(called, false);
  assert.equal(patchTargetExtraVars(reading.target), "", "no target is the play exactly as it was");
  assert.match(patchTargetLine(reading), /^target: NONE \(no box that answered reported a readable build\)/);
  assert.equal(fleetTopBuild(silent), null);
});

test("#4905: a read that fails, or answers in a shape patch.yml would refuse, passes none and says why", () => {
  const one = [onBuild("a11y-worker-10", 26200)];
  const failed = patchTargetOf({ boxes: one, read: () => { throw new Error("ssh: connect timed out\nsecond line"); } });
  assert.equal(failed.target, null);
  assert.match(failed.why, /read of a11y-worker-10 failed: ssh: connect timed out$/, "one line, the first");
  for (const [label, line] of [["no release", "26200.9457 "], ["lowercase release", "26200.9457 25h2"], ["no UBR", "26200 25H2"]]) {
    const refused = patchTargetOf({ boxes: one, read: () => adHoc(["a11y-worker-10", line]) });
    assert.equal(refused.target, null, label);
  }
  const unreachable = patchTargetOf({ boxes: one, read: () => "a11y-worker-10 | UNREACHABLE! => {\n  \"msg\": \"timed out\"\n}" });
  assert.equal(unreachable.target, null);
  // positive control for the three above: the same call with a well-formed line yields a target.
  assert.notEqual(patchTargetOf({ boxes: one, read: () => adHoc(["a11y-worker-10", "26200.9457 25H2"]) }).target, null);
});

test("#4905: the highest UBR wins as a NUMBER, a box that did not answer is named, and a moved build is not read", () => {
  const boxes = [onBuild("a11y-worker-10", 26200), onBuild("a11y-worker-11", 26200), onBuild("a11y-worker-12", 26200)];
  const reading = patchTargetOf({ boxes, read: () => adHoc(["a11y-worker-10", "26200.9457 25H2"], ["a11y-worker-11", "26200.10000 25H2"]) });
  assert.equal(reading.target?.build, "26200.10000", "'9457' sorts above '10000' as text");
  assert.ok(compareBuilds("26200.10000", "26200.9457") > 0);
  assert.match(reading.why, /2 of 3 box\(es\), a11y-worker-12 did not answer/);
  const moved = patchTargetOf({ boxes: [onBuild("a11y-worker-10", 26200)], read: () => adHoc(["a11y-worker-10", "26300.1 26H1"]) });
  assert.equal(moved.target, null, "the box answered for another CurrentBuild than /health did: the fleet moved mid-read");
  const split = patchTargetOf({ boxes, read: () => adHoc(["a11y-worker-10", "26200.9457 25H2"], ["a11y-worker-11", "26200.9457 24H2"]) });
  assert.equal(split.target, null, "one build, two release names: nothing is guessed");
});

test("#4905: what the wrapper passes satisfies patch.yml's own input assertions, which are read from the file", () => {
  assert.ok(PATCH_YML.includes("'^[0-9]{2}H[12]$'"), "patch.yml still validates the release name in this shape");
  assert.ok(PATCH_YML.includes("'^[0-9]+\\.[0-9]+$'"), "patch.yml still validates the build in this shape");
  const { target } = patchTargetOf({ boxes: MIXED, read: () => adHoc(["a11y-worker-10", "26200.9457 25H2"]) });
  assert.match(target?.release ?? "", /^[0-9]{2}H[12]$/);
  assert.match(target?.build ?? "", /^[0-9]+\.[0-9]+$/);
});

test("#4905: the read is one read-only win_shell call whose payload survives single quotes on the remote shell", () => {
  const command = patchTargetReadCommand(["a11y-worker-10", "a11y-worker-12"]);
  const payload = command.slice(command.indexOf(" -a '") + 5, -1);
  assert.doesNotMatch(payload, /'/, "a single quote inside would end the remote shell's quoting");
  for (const part of ["CurrentBuild", "UBR", "DisplayVersion", "Windows NT\\CurrentVersion"]) assert.ok(payload.includes(part), part);
  assert.doesNotMatch(payload, /Set-|New-|Remove-|Restart-/, "a read");
});

test("#4905: the plan names the target it would pass, or that none could be read", () => {
  const read = patchTargetOf({ boxes: MIXED, read: () => adHoc(["a11y-worker-10", "26200.9457 25H2"]) });
  const named = patchPlan({ boxes: MIXED, limitFlag: undefined, apply: false, target: read }).join("\n");
  assert.match(named, /target: 25H2 26200\.9457 .*-e patch_target_release\/-e patch_target_build/);
  const none = patchPlan({ boxes: MIXED, limitFlag: undefined, apply: false,
    target: { target: null, why: "the read of a11y-worker-10 failed: nope" } }).join("\n");
  assert.match(none, /target: NONE \(the read of a11y-worker-10 failed: nope\) -- patch\.yml runs without one/);
  assert.doesNotMatch(none, /target: 25H2/);
});

test("#4905: the follow budget grows with the boxes below the top build only when a target is passed, and never below 4 h", () => {
  const cumulative = PLAYBOOK_TIMEOUT_MS["patch.yml"];
  const target = { release: "25H2", build: "26200.9457" };
  const fourteenBelow = [onBuild("a11y-worker-10", 26200),
    ...Array.from({ length: 14 }, (_, i) => onBuild(`a11y-worker-${i + 2}`, 26100))];
  const HOUR = 60 * 60 * 1000;
  assert.equal(patchFollowBudgetMs({ boxes: fourteenBelow, limitFlag: undefined, target }), 14 * 2.5 * HOUR);
  assert.equal(patchFollowBudgetMs({ boxes: fourteenBelow, limitFlag: undefined, target: null }), cumulative,
    "negative control: no target, no feature update, the budget as it was");
  assert.equal(patchFollowBudgetMs({ boxes: MIXED, limitFlag: "a11y-worker-10", target }), cumulative,
    "a box already on the top build is not below it: the floor holds");
  assert.equal(patchFollowBudgetMs({ boxes: fourteenBelow, limitFlag: "a11y-worker-2", target }), cumulative,
    "one box below, at 2.5 h, is under the floor");
  assert.equal(patchFollowBudgetMs({ boxes: fourteenBelow, limitFlag: "a11y-worker-2,a11y-worker-3", target }), 2 * 2.5 * HOUR,
    "two boxes are over it: --limit counts only the boxes the run touches");
});

test("#4905: the dispatch CALLS the target's extra vars and the gate's budget -- a pure function nobody calls is the defect", () => {
  const start = PLAYBOOK_SOURCE.indexOf("systemd-run --unit=");
  const end = PLAYBOOK_SOURCE.indexOf("{ timeoutMs: PLAYBOOK_TIMEOUT_MS[chosen]", start);
  assert.ok(start > 0 && end > start, "the argv builder's anchors have drifted");
  assert.match(PLAYBOOK_SOURCE.slice(start, end), /\+ patchTargetExtraVars\(patchTarget\)/);
  assert.match(PLAYBOOK_SOURCE, /startPlaybookUnit\(\{[^}]*patchTarget: patchGate\.target[^}]*\}\)/);
  assert.match(PLAYBOOK_SOURCE, /followUnit\(unit, patchGate\.followBudgetMs\)/);
});
