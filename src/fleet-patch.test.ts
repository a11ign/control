// no-token: gh -- every test below drives pure functions (`patchRefusal`, `patchOutcome`, `patchScheduleDecision`,
// `scheduledPatchRun`, `sequenceHoldGate`, `linkGateFor`) or reads `patch-schedule.yml` as text; none calls
// `enforceSequenceHold` or `readFleetGatedIssues`, so fleet-playbook.ts's own `gh` call is never reached.
/**
 * #4446: `fleet:patch` -- the command with the fleet's safeties, and the schedule that runs it.
 *
 * Each requirement carries a positive AND a negative control: a refusal test that also shows the same input passing
 * once the cause is removed, so "refused" is not what an empty or broken population would print anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLAYBOOKS, patchRefusal, patchOutcome, patchPlan, patchBoxOf, patchRunRecordCommand, PATCH_RUN_RECORD,
  patchTargetOf, patchTargetExtraVars, patchTargetLine, patchTargetReadCommand, patchFollowBudgetMs, fleetTopBuild,
  compareBuilds, PLAYBOOK_TIMEOUT_MS,
  patchScheduleDecision, scheduledPatchRun, scheduleOrRefuse, patchHealthLine, PATCH_WINDOW_MISSED_EXIT_CODE,
  sequenceHoldGate, activeFleetHolds, linkGateFor, osRollbackRefusal } from "./fleet-playbook.ts";
import type { PatchBox, PatchSchedule, PatchTargetReading } from "./fleet-playbook.ts";
import { PATCH_RUN_PATH, parsePatchRun } from "./fleet-watch.ts";

const SCHEDULE_YML = readFileSync(fileURLToPath(new URL("../ansible/patch-schedule.yml", import.meta.url)), "utf8");

const idle = (name: string): PatchBox => ({ name, reachable: true, busy: false, build: "26100.4061" });
const FLEET = ["a11y-worker-2", "a11y-worker-3", "a11y-worker-4"].map(idle);
const NO_TARGET: PatchTargetReading = { target: null, why: "not read in this test" };
const SCHEDULE: PatchSchedule = { windowDays: 28, retryDays: 7, weekday: 6, startHour: 2, endHour: 6 };

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
// 4. THE TIMER UNIT CALLS --apply AND TAKES ITS WINDOW FROM A VARIABLE
// ---------------------------------------------------------------------------------------------------------------------

const execStartOf = (yml: string) => yml.split("\n").find((line) => /^\s*ExecStart=/.test(line)) ?? "";

test("#4446: the timer's service passes --apply (and --scheduled), and a unit without it is caught by the same reading", () => {
  const exec = execStartOf(SCHEDULE_YML);
  assert.match(exec, /fleet-playbook\.ts --playbook=patch\.yml --apply --scheduled /);
  const withoutApply = exec.replace(" --apply", "");
  assert.doesNotMatch(withoutApply, / --apply /, "negative control: the pattern above fails on a unit that lacks the flag");
});

test("#4446: every number of the window is a variable reference in the unit, with its value declared once", () => {
  const exec = execStartOf(SCHEDULE_YML);
  for (const flag of ["window-days", "retry-days", "weekday", "window-start-hour", "window-end-hour"]) {
    assert.match(exec, new RegExp(`--${flag}=\\{\\{ patch_window_[a-z_]+ \\}\\}`), flag);
    assert.doesNotMatch(exec, new RegExp(`--${flag}=[0-9]`), `${flag}: a digit here would be a constant in the unit`);
  }
  assert.match(SCHEDULE_YML, /OnCalendar=\*-\*-\* \{\{ '%02d' \| format\(patch_window_start_hour \| int\) \}\}:00:00/);
  for (const variable of ["patch_window_days: 28", "patch_window_retry_days: 7", "patch_window_weekday: 6",
    "patch_window_start_hour: 2", "patch_window_end_hour: 6"]) {
    assert.equal(SCHEDULE_YML.split(variable).length - 1, 1, `${variable} is declared exactly once`);
  }
});

test("#4446: the trigger unit is not named for the transient unit the dispatcher stops and resets", () => {
  assert.doesNotMatch(SCHEDULE_YML, /name: a11y-fleet-patch\.(service|timer)/);
  assert.match(SCHEDULE_YML, /name: a11y-fleet-patch-window\.timer/);
});

test("#4446: --scheduled refuses without --apply, off patch.yml, and with a window left out", () => {
  const messages: string[] = [];
  const refuse = (message: string) => { messages.push(message); };
  const flags = ["--scheduled", "--window-days=28", "--retry-days=7", "--weekday=6", "--window-start-hour=2", "--window-end-hour=6"];
  assert.deepEqual(scheduleOrRefuse({ chosen: "patch.yml", apply: true, argv: ["--playbook=patch.yml", "--apply", ...flags], refuse }),
    SCHEDULE);
  assert.deepEqual(messages, [], "positive control: the full spelling is accepted");
  scheduleOrRefuse({ chosen: "patch.yml", apply: false, argv: flags, refuse });
  assert.match(messages.pop() ?? "", /without --apply: a timer that passes no --apply is a report on a clock/);
  scheduleOrRefuse({ chosen: "deploy.yml", apply: true, argv: flags, refuse });
  assert.match(messages.shift() ?? "", /only patch\.yml has a window/);
  messages.length = 0;
  scheduleOrRefuse({ chosen: "patch.yml", apply: true, argv: flags.filter((flag) => !flag.startsWith("--retry-days")), refuse });
  assert.match(messages[0] ?? "", /--retry-days=<integer> is required/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. A REFUSAL INSIDE THE WINDOW RETRIES THE NEXT DAY; THE LAST DAY RAISES THE HEALTH LINE
// ---------------------------------------------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
/** Saturday 2026-10-10 02:30 local, the window's first Saturday when the last run was 21 days before it. */
const SATURDAY = new Date(2026, 9, 10, 2, 30);
const lastRunDaysBefore = (now: Date, days: number) => now.getTime() - days * DAY;
const at = (daysAfterSaturday: number) => new Date(SATURDAY.getTime() + daysAfterSaturday * DAY);

function run(now: Date, lastRunAtMs: number | null, status: number) {
  let attempts = 0;
  const result = scheduledPatchRun({ now, lastRunAtMs, schedule: SCHEDULE, runApply: () => {
    attempts += 1;
    return { status, refusal: status === 0 ? "" : "REFUSING patch.yml: a11y-worker-3 is busy. A reboot destroys a capture." };
  } });
  return { ...result, attempts };
}

test("#4446: before the window opens nothing is attempted; on its Saturday a refusal is logged and retried tomorrow", () => {
  const lastRun = lastRunDaysBefore(SATURDAY, 21);
  const early = run(at(-1), lastRun, 2);
  assert.equal(early.attempts, 0, "day 20: the window has not opened");
  assert.equal(early.exit, 0);
  const refused = run(SATURDAY, lastRun, 2);
  assert.equal(refused.attempts, 1);
  assert.equal(refused.exit, 0, "a refusal inside the window is not a failure");
  assert.match(refused.lines.join("\n"), /retrying tomorrow/);
  assert.doesNotMatch(refused.lines.join("\n"), /patch-window-missed/);
});

test("#4446: the day after a refusal attempts again, every day to the window's end, and not before the weekday", () => {
  const lastRun = lastRunDaysBefore(SATURDAY, 21);
  for (const day of [1, 2, 3, 4, 5]) assert.equal(run(at(day), lastRun, 2).attempts, 1, `day ${21 + day}`);
  // A window that opened on a Tuesday waits for the Saturday, as the weekday is what opens the attempts.
  const tuesdayRun = lastRunDaysBefore(at(-4), 21); // the Tuesday before: age 21 on Tuesday
  assert.equal(run(at(-4), tuesdayRun, 2).attempts, 0, "Tuesday of an open window: not the weekday yet");
  assert.equal(run(SATURDAY, tuesdayRun, 2).attempts, 1, "and the Saturday attempts");
});

test("#4446: the LAST day's refusal raises the health line and fails the unit; the day before does not", () => {
  const lastDay = at(7); // age 28 from a Saturday run: the window's end
  const dayBefore = run(at(6), lastRunDaysBefore(at(6), 27), 2);
  assert.equal(dayBefore.exit, 0, "age 27: a retry, not the line");
  assert.doesNotMatch(dayBefore.lines.join("\n"), /patch-window-missed/);
  const closing = run(lastDay, lastRunDaysBefore(lastDay, 28), 2);
  assert.equal(closing.attempts, 1);
  assert.equal(closing.exit, PATCH_WINDOW_MISSED_EXIT_CODE);
  assert.match(closing.lines.join("\n"), /^fleet-health: patch-window-missed: last patch run 2026-\d\d-\d\d, window 28 days, still refused on the last day: REFUSING patch\.yml: a11y-worker-3 is busy/);
});

test("#4446: a completed run on the last day is a success, and a host with no run on record raises no line", () => {
  assert.equal(run(at(7), lastRunDaysBefore(at(7), 28), 0).exit, 0);
  const never = run(SATURDAY, null, 2);
  assert.equal(never.attempts, 1, "a never-patched host is attempted");
  assert.equal(never.exit, 0, "and a refusal is retried, since `patchWindowMissed` gives it no window it could have missed");
});

test("#4446: an attempt starts only inside the window's hours", () => {
  const lastRun = lastRunDaysBefore(SATURDAY, 21);
  const noon = new Date(2026, 9, 10, 12, 0);
  assert.equal(patchScheduleDecision({ now: noon, lastRunAtMs: lastRun, schedule: SCHEDULE }).attempt, false);
  assert.equal(patchScheduleDecision({ now: SATURDAY, lastRunAtMs: lastRun, schedule: SCHEDULE }).attempt, true,
    "negative control: 02:30 on the same day attempts");
  assert.equal(patchScheduleDecision({ now: new Date(2026, 9, 10, 6, 0), lastRunAtMs: lastRun, schedule: SCHEDULE }).attempt, false,
    "the end hour is exclusive");
});

test("#4446: the window moves with the variables -- another weekday and cadence, same code", () => {
  const sunday = new Date(2026, 9, 11, 2, 30);
  const moved: PatchSchedule = { ...SCHEDULE, weekday: 0, windowDays: 14, retryDays: 3 };
  const lastRun = lastRunDaysBefore(sunday, 11);
  assert.equal(patchScheduleDecision({ now: sunday, lastRunAtMs: lastRun, schedule: moved }).attempt, true);
  assert.equal(patchScheduleDecision({ now: sunday, lastRunAtMs: lastRun, schedule: SCHEDULE }).attempt, false,
    "negative control: the default cadence does not open at day 11");
});

// ---------------------------------------------------------------------------------------------------------------------
// THE RECORD fleet-watch READS
// ---------------------------------------------------------------------------------------------------------------------

test("#4446: a completed run is written where fleet-watch reads it, in the shape it parses", () => {
  assert.equal(PATCH_RUN_RECORD, PATCH_RUN_PATH, "the writer and the reader name one file");
  const command = patchRunRecordCommand(1_791_000_000_000);
  assert.match(command, new RegExp(`> ${PATCH_RUN_PATH.replace(/\./g, "\\.")}$`));
  const body = /printf '([^']*)'/.exec(command)?.[1] ?? "";
  const written = body.replace("%d", "1791000000000").replace("\\n", "");
  assert.equal(parsePatchRun(written), 1_791_000_000_000);
  assert.equal(parsePatchRun("{}"), null, "negative control: no record is no run");
});

test("#4446: the health line speaks patch-window-missed's own words", () => {
  const line = patchHealthLine({ lastRunAtMs: Date.UTC(2026, 8, 12), schedule: SCHEDULE, refusal: "REFUSING patch.yml: x\nsecond line" });
  assert.match(line, /^fleet-health: patch-window-missed: last patch run 2026-09-12, window 28 days, still refused on the last day: REFUSING patch\.yml: x$/);
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

// RENDERED, NOT READ (#5506, reviewer-control-100): the real play's own `vars` go through the real `ansible-playbook`
// templating on localhost, and the unit file it would lay is what is asserted.
function renderPatchServiceUnit(planeKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), "patch-unit-"));
  const out = join(dir, "unit.service");
  const extract = spawnSync("python3", ["-I", "-c",
    "import sys,json,yaml;plays=yaml.safe_load(open(sys.argv[1]));"
    + "print(json.dumps(next(p for p in plays if 'patch_service_unit' in p.get('vars',{}))['vars']))",
    fileURLToPath(new URL("../ansible/patch-schedule.yml", import.meta.url))], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const playbook = [{ hosts: "localhost", connection: "local", gather_facts: false, vars: JSON.parse(extract.stdout),
    tasks: [{ "ansible.builtin.copy": { content: "{{ patch_service_unit }}", dest: out } }] }];
  writeFileSync(join(dir, "play.json"), JSON.stringify(playbook));
  const run = spawnSync("ansible-playbook", ["-i", "localhost,", "-e", JSON.stringify({ patch_plane_key: planeKey }), join(dir, "play.json")],
    { encoding: "utf8", env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: "false" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const unit = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return unit;
}

test("#5506: the RENDERED patch-window unit carries the key path it was given, and ExecStart is control's checkout", () => {
  const unit = renderPatchServiceUnit("/plane/key_for_test");
  assert.match(unit, /^Environment=A11Y_PVE_KEY=\/plane\/key_for_test$/m);
  assert.match(unit, /^ExecStart=.*\/root\/control\/src\/fleet-playbook\.ts --playbook=patch\.yml/m);
  assert.doesNotMatch(unit, /a11y-witness\/packages\/control/);
});

// The guard's own task is lifted out of the real first play and run by the real `ansible-playbook`, with and without the
// variable: the refusal is executed, and the passing run is its negative control.
function runKeyGuard(extraVars: Record<string, string>): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "patch-guard-"));
  const lift = spawnSync("python3", ["-I", "-c",
    "import sys,json,yaml;plays=yaml.safe_load(open(sys.argv[1]));"
    + "print(json.dumps([t for t in plays[0]['tasks'] if 'patch_plane_key' in json.dumps(t)]))",
    fileURLToPath(new URL("../ansible/patch-schedule.yml", import.meta.url))], { encoding: "utf8" });
  assert.equal(lift.status, 0, lift.stderr);
  const tasks = JSON.parse(lift.stdout);
  assert.equal(tasks.length, 1, "exactly one task in the first play guards patch_plane_key");
  writeFileSync(join(dir, "play.json"), JSON.stringify([{ hosts: "localhost", connection: "local", gather_facts: false, tasks }]));
  const run = spawnSync("ansible-playbook", ["-i", "localhost,", "-e", JSON.stringify(extraVars), join(dir, "play.json")],
    { encoding: "utf8", env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: "false" } });
  rmSync(dir, { recursive: true, force: true });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("#5506: the first play REFUSES an empty or absent key path, and passes a given one", () => {
  const empty = runKeyGuard({ patch_plane_key: "" });
  assert.notEqual(empty.status, 0, empty.output);
  assert.match(empty.output, /patch_plane_key. is empty/);
  const absent = runKeyGuard({});
  assert.notEqual(absent.status, 0, absent.output);
  const given = runKeyGuard({ patch_plane_key: "/plane/key_for_test" });
  assert.equal(given.status, 0, given.output);
});
