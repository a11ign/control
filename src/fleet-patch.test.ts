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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PLAYBOOKS, patchRefusal, patchOutcome, patchPlan, patchBoxOf, patchRunRecordCommand, PATCH_RUN_RECORD,
  patchScheduleDecision, scheduledPatchRun, scheduleOrRefuse, patchHealthLine, PATCH_WINDOW_MISSED_EXIT_CODE,
  sequenceHoldGate, activeFleetHolds, linkGateFor, osRollbackRefusal } from "./fleet-playbook.ts";
import type { PatchBox, PatchSchedule } from "./fleet-playbook.ts";
import { PATCH_RUN_PATH, parsePatchRun } from "./fleet-watch.ts";

const SCHEDULE_YML = readFileSync(fileURLToPath(new URL("../ansible/patch-schedule.yml", import.meta.url)), "utf8");

const idle = (name: string): PatchBox => ({ name, reachable: true, busy: false, build: "26100.4061" });
const FLEET = ["a11y-worker-2", "a11y-worker-3", "a11y-worker-4"].map(idle);
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
  const dry = patchPlan({ boxes: FLEET, limitFlag: undefined, apply: false }).join("\n");
  for (const { name } of FLEET) assert.match(dry, new RegExp(`${name}\\s{2}would patch`));
  assert.match(dry, /dry: nothing is changed/);
  const applied = patchPlan({ boxes: FLEET, limitFlag: "a11y-worker-3", apply: true }).join("\n");
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
