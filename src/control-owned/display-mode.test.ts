// The control half of fleet-layer/display-mode.test.ts (a11ign/a11ign#5345): the YAML tests and the `pwsh` section, which imports control's TestHelpers.psm1 through the harness. The `set-display-mode.ps1` source tests moved to a11ign/screenreader-fleet (src/display-mode.test.ts, #5350).
/**
 * THE DISPLAY MODE COMES FROM `defaults/main.yml`, NEVER HARDCODED IN THE TASK. #1567's own Region names
 * this file for exactly that reason: `tasks/display.yml` is EXEMPT from the provision stamp's
 * `$ENVIRONMENT_FILES` (see `provision-stamp-inputs.test.ts`) only because the VALUE it applies already
 * lives in `defaults/main.yml`, which the stamp already hashes -- the same argument that file makes for
 * `policy.yml`. A width or height typed directly into the task instead would move the environment with
 * nothing hashing it, and `provisionRevision` would stay equal across a fleet that had actually diverged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// THIS FILE DECLARED A WALK SCOPE UNTIL IT STARTED RUNNING POWERSHELL, and it cannot honestly declare one
// now. The tests at the bottom spawn `pwsh`, and `walk-scope.mjs` records a child process as
// `(the whole repository)` on purpose -- what a subprocess reads is not visible to the observer, so no
// narrower declaration could be checked, and `readsOutsideScope` refuses that marker whatever the scope
// says. Its own message offers exactly two ways out, widen or remove, and only the second is available.
// Undeclared is unbounded: `narrowByDeclaredScope` keeps an undeclared guard on every diff, which is the
// direction that fails safe -- see `declared-walk-scope.test.ts`, whose second pinned property this is.

const DEFAULTS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/defaults/main.yml", import.meta.url)), "utf8");
const DISPLAY_TASK = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/display.yml", import.meta.url)), "utf8");

/** `worker_display_mode`'s own width/height, read from defaults -- never restated as a copy. */
function displayMode(): { width: string; height: string } {
  const block = /^worker_display_mode:\n((?:[ \t]+\S.*\n?)+)/m.exec(DEFAULTS)?.[1];
  assert.ok(block, "worker_display_mode is gone from defaults/main.yml -- this test examines nothing");
  const width = /width:\s*(\d+)/.exec(block!)?.[1];
  const height = /height:\s*(\d+)/.exec(block!)?.[1];
  assert.ok(width && height, "worker_display_mode no longer declares both width and height");
  return { width: width!, height: height! };
}

test("worker_display_mode defaults to the mode the calibration corpus and workers 2-6 already sit at", () => {
  // `ceo`'s #1561 ruling (b): this is not a preference picked here, it is what already runs and is
  // measured to be safe -- a WIDER mode needs its own read showing it holds on every adapter first.
  const { width, height } = displayMode();
  assert.equal(width, "1024", "1024 is not chosen in this file -- it is read off what already runs");
  assert.equal(height, "768", "768 is not chosen in this file -- it is read off what already runs");
});

test("display.yml reads the mode from defaults; it does not carry its own width or height", () => {
  assert.match(DISPLAY_TASK, /worker_display_mode\.width/,
    "display.yml must template Width from worker_display_mode.width -- a hardcoded value here would move "
    + "the environment with nothing hashing it, and provisionRevision would stay equal across a fleet that "
    + "had actually diverged");
  assert.match(DISPLAY_TASK, /worker_display_mode\.height/,
    "same as Width, for Height -- see the message above");
});

/** `worker_display_driver_*`'s own url/sha256, read from defaults -- never restated as a copy. */
function displayDriverPin(): { url: string; sha256: string } {
  const url = /^worker_display_driver_url:\s*"([^"]+)"/m.exec(DEFAULTS)?.[1];
  const sha256 = /^worker_display_driver_sha256:\s*"([^"]+)"/m.exec(DEFAULTS)?.[1];
  assert.ok(url && sha256, "worker_display_driver_url/_sha256 are gone from defaults/main.yml");
  return { url: url!, sha256: sha256! };
}

test("worker_display_driver_sha256 is the value #1782 sourced through Intel's real Download Center", () => {
  // #1567's own refusal: no third-party-mirror hash, and none invented here. This pins the exact value
  // the chairman sourced and this checkout independently re-verified -- see #1782 and display.yml's own
  // header comment. A future re-pin (a newer Intel package) is expected to change this test, not to leave
  // it matching stale prose.
  const { sha256 } = displayDriverPin();
  assert.equal(sha256, "a88862682e00bc203cf4be9ff6057e400e94a1dcca48e1f07a67718f5b99c423",
    "worker_display_driver_sha256 no longer matches the value #1782 sourced and this checkout verified");
});

test("display.yml fetches the driver with win_get_url's own checksum, never installs an unverified download", () => {
  assert.match(DISPLAY_TASK, /win_get_url:[\s\S]{0,200}checksum:\s*"\{\{\s*worker_display_driver_sha256\s*\}\}"/,
    "display.yml must pass worker_display_driver_sha256 to win_get_url's checksum -- fetching the pinned "
    + "URL without it would install whatever bytes are actually served, not the value #1782 verified");
});

/**
 * One task of `display.yml`, from its `- name:` line to the next one -- because the whole file cannot
 * answer "WHICH task says this".
 *
 * The same lesson the script's declaration/body split records (screenreader-fleet, #5350), and #2065 is where it bit this half of the file:
 * every clause below is about which of two ADJACENT tasks carries a condition, and a match against
 * `DISPLAY_TASK` is satisfied by either. `when: not display_driver_ok` appears on six tasks here; an
 * assertion that the proof read is not gated on the installer's exit code has to read the proof read.
 *
 * Comment lines are kept: this file's conditions are not in its comments, and stripping them would be
 * work for nothing. The block ends at the next task's `- name:` at column 0, which is the only place
 * that string appears unindented.
 */
function taskBlock(name: string): string {
  const at = DISPLAY_TASK.indexOf(`- name: ${name}`);
  assert.notEqual(at, -1, `the task '${name}' is gone from display.yml -- this test examines nothing`);
  const next = DISPLAY_TASK.indexOf("\n- name: ", at + 1);
  return next === -1 ? DISPLAY_TASK.slice(at) : DISPLAY_TASK.slice(at, next);
}

test("display.yml treats installer exit codes 17/18 (shutdown required) as failures, never as success", () => {
  // The package's own installation_readme.txt: 2/14 mean a software-controlled restart, safe for
  // win_reboot; 17/18 mean the box is shutting down and, per the same readme, may need a human to press
  // its power button. This fleet is bare-metal with nobody guaranteed on site -- a green result here must
  // not be the thing that leaves a worker dark.
  //
  // #2065 changed the SHAPE of this line and not this claim: it used to read `rc not in [0, 2, 14]`,
  // which caught 17/18 as a side effect of catching everything unlisted. It now names them, so what the
  // install task fails on is what somebody decided it should fail on.
  const install = taskBlock("Install it silently, without a reboot the installer sprung itself");
  assert.match(install, /failed_when:\s*display_driver_install\.rc in \[17,\s*18\]/,
    "display.yml's install task no longer refuses exit codes 17/18 -- a shutdown-required outcome would "
    + "read as success, and this fleet has nobody on site to press a power button");
  // AND IT STILL FAILS BEFORE ANY REBOOT HANDLING. `failed_when` on the install task is what stops the
  // host; the reboot task below it is the first thing that would act on a 17/18 box, so the order of
  // these two in the file is the claim, not just the presence of the line above.
  assert.ok(DISPLAY_TASK.indexOf("- name: Install it silently") <
    DISPLAY_TASK.indexOf("- name: Reboot if the install asked for a software-controlled restart"),
    "the install task must come BEFORE the reboot task -- 17/18 has to end the play on that host before "
    + "anything tries to restart a box that is already shutting itself down");
});

test("an installer exit code nobody has decoded does not, by itself, remove the host from the play", () => {
  // #2065, and it is measured rather than argued. `failed_when` read `rc not in [0, 2, 14]` until
  // 2026-09-23, so UNDOCUMENTED and FAILED were the same word: live on the fleet the installer returned
  // `rc 1014` on all five of a11y-worker-7..11, all five left the play at the install, and the adapter
  // proof below -- the ONLY task that could say what the install achieved -- never ran on any of them.
  // `orchestrator`'s read on 2026-09-23T07:46Z: all five on `Intel Corporation 31.0.101.2141`,
  // `CM_PROB_NONE`. The install had worked. Nothing in the play could say so.
  const install = taskBlock("Install it silently, without a reboot the installer sprung itself");
  const failedWhen = /failed_when:([^\n]*)/.exec(install)?.[1];
  assert.ok(failedWhen, "the install task has no failed_when at all -- win_command would then fail on "
    + "every non-zero rc, which is the defect this test is about with the default doing it");
  assert.doesNotMatch(failedWhen!, /not in/,
    "the install task's failed_when must name the codes that FAIL, never the ones that pass: a deny-list "
    + "of successes spells 'undocumented' and 'dangerous' the same word, and `rc 1014` is what that cost");
  // The positive control for the line above, and the reason it is not just "nothing fails here": the
  // reboot task next door still reads the DOCUMENTED-success codes off the same register, so a mutation
  // that emptied every exit-code condition in this file is red here rather than vacuously green.
  assert.match(taskBlock("Reboot if the install asked for a software-controlled restart"),
    /display_driver_install\.rc in \[2,\s*14\]/,
    "the reboot task must still fire only on 2/14, the readme's software-controlled restart codes");
});

test("an undocumented exit code is reported by name and by number, never folded into the documented ones", () => {
  // Not failing it is only half. A code nobody has decoded that passes SILENTLY is the same defect in the
  // other direction -- it would read as a clean install in the play's own output. So it is said out loud,
  // with the number in it, and the reader is sent to the adapter read that follows.
  const report = taskBlock(
    "An exit code nobody has decoded is UNKNOWN, and is said out loud rather than folded into success");
  assert.match(report, /when:\s*not display_driver_ok and display_driver_install\.rc not in \[0,\s*2,\s*14,\s*17,\s*18\]/,
    "the undocumented-code report must fire exactly on a code outside the readme's documented set, and "
    + "only where the driver half touched this host");
  assert.match(report, /\{\{\s*display_driver_install\.rc\s*\}\}/,
    "the report must carry the actual number -- 'an undocumented code' without the code sends the next "
    + "reader back to the box to find out which one, which is the eleven hours #2065 records");
  assert.match(report, /UNDOCUMENTED/,
    "the report must say UNDOCUMENTED in the message a reader lands on: 'unknown' and 'failed' printing "
    + "the same word is the defect, and so is 'unknown' printing nothing");
});

test("the adapter proof read is NOT gated behind the install's own exit code", () => {
  // THE LOAD-BEARING CLAUSE OF #2065. The proof read is the only thing in this role that measures what
  // the install achieved; gating it behind the install's own verdict leaves that verdict unchecked on
  // exactly the hosts where it is in doubt. It is gated on ONE thing -- whether the driver half touched
  // this host at all -- so workers 2-6 stay untouched and every host that got an install gets measured.
  const proof = taskBlock("Refuse to call this provisioned unless the adapter reads clean afterwards");
  const when = /^\s*when:([^\n]*)/m.exec(proof)?.[1];
  assert.ok(when, "the adapter proof task has no when: at all -- it would then run on workers 2-6, which "
    + "this role must never touch");
  assert.equal(when!.trim(), "not display_driver_ok",
    "the adapter proof's when: must be `not display_driver_ok` and nothing else -- any mention of the "
    + "install's result makes the measurement conditional on the claim it exists to check");
  // The positive control: `display_driver_install` IS read elsewhere in this file, so this assertion
  // distinguishes 'this task does not gate on it' from 'no task in the file mentions it'. Deleting the
  // register entirely would leave the clause above green and this one red.
  assert.match(DISPLAY_TASK, /register:\s*display_driver_install/,
    "positive control for the clause above -- display_driver_install must still be registered somewhere, "
    + "or the proof read is 'ungated' only because there is nothing left to gate on");
  // And it must still be the thing that FAILS a host. Not-gated and not-deciding would move the verdict
  // from a declaration to nowhere at all.
  assert.match(proof, /\$Ansible\.Failed = \$true/,
    "the adapter proof must still fail the host whose adapter does not read clean -- it is the verdict "
    + "now, not a report");
  assert.match(proof, /CM_PROB_NONE/,
    "and it must still be CM_PROB_NONE on an Intel driver that it checks for");
});

test("the adapter proof read comes AFTER the install, so what it measures is the install's result", () => {
  // Reachability is half the claim; order is the other half. A proof read moved above the install would
  // satisfy every clause in the test above while measuring the state the install was about to change.
  const installAt = DISPLAY_TASK.indexOf("- name: Install it silently");
  const proofAt = DISPLAY_TASK.indexOf(
    "- name: Refuse to call this provisioned unless the adapter reads clean afterwards");
  assert.ok(installAt >= 0 && proofAt >= 0, "the install or the adapter proof task is gone from display.yml");
  assert.ok(proofAt > installAt,
    "the adapter proof must come AFTER the install -- read before it, it reports the fault the install "
    + "was run to fix and calls that the install's outcome");
});

test("display.yml's final debug never reads display_driver_proof.output unconditionally", () => {
  // `display_driver_proof` is only REGISTERED by the task above it, guarded `when: not display_driver_ok`.
  // On workers 2-6 (already a problem-free Intel driver) that task is skipped and the registered result
  // has no `.output` -- reading it unconditionally fails Ansible's strict templating there, which is
  // exactly the requirement this role must not violate: workers 2-6 are never touched. Reviewer's
  // blocker on #1819 (2026-09-20T21:39:58Z) caught this by reading the play, not by running it.
  const block = /- name: Say what the display adapter is on[\s\S]*?msg:[\s\S]*?(?=\n- name:|\n*$)/.exec(DISPLAY_TASK)?.[0];
  assert.ok(block, "the final 'Say what the display adapter is on' debug task is gone from display.yml");
  assert.match(block!, /display_driver_proof\.output \| first if not display_driver_ok/,
    "the debug's msg must guard display_driver_proof.output behind 'if not display_driver_ok' -- an "
    + "unconditional read broke workers 2-6, which never register that variable");
});

test("the display mode is set through run-interactive.yml, never a direct win_powershell call over SSH", () => {
  // #1567, 2026-09-21: a direct `win_powershell` task calling EnumDisplaySettings failed on all 10 real
  // workers -- SSH does not attach to the interactive window station GDI calls need, the same fact
  // `tasks/run-interactive.yml`'s own header names for SystemParametersInfo. A regression back to a direct
  // call would reintroduce that live failure with nothing here to catch it before the next real run.
  const block = /- name: The display mode the fleet pins[\s\S]*?(?=\n- name:|\n*$)/.exec(DISPLAY_TASK)?.[0];
  assert.ok(block, "'The display mode the fleet pins' task is gone from display.yml");
  assert.match(block!, /include_tasks:\s*"\{\{\s*playbook_dir\s*\}\}\/tasks\/run-interactive\.yml"/,
    "the display-mode task must run through tasks/run-interactive.yml's interactive scheduled task, not "
    + "a direct win_powershell call -- see this task's own header comment for why");
  assert.doesNotMatch(block!, /ansible\.windows\.win_powershell/,
    "the display-mode task must not call win_powershell directly -- that is the mechanism that failed "
    + "live against the real fleet");
});

test("display.yml passes both env vars into set-display-mode.ps1 from worker_display_mode", () => {
  const block = /- name: The display mode the fleet pins[\s\S]*?(?=\n- name:|\n*$)/.exec(DISPLAY_TASK)?.[0];
  assert.ok(block, "'The display mode the fleet pins' task is gone from display.yml");
  assert.match(block!, /A11Y_DISPLAY_WIDTH = '\{\{\s*worker_display_mode\.width\s*\}\}'/,
    "display.yml must set A11Y_DISPLAY_WIDTH from worker_display_mode.width before invoking the script");
  assert.match(block!, /A11Y_DISPLAY_HEIGHT = '\{\{\s*worker_display_mode\.height\s*\}\}'/,
    "display.yml must set A11Y_DISPLAY_HEIGHT from worker_display_mode.height before invoking the script");
  assert.match(block!, /set-display-mode\.ps1/, "display.yml must invoke set-display-mode.ps1");
});

test("display.yml pins the display mode AFTER the driver install, never before it", () => {
  // #1955, measured on a11y-worker-7 2026-09-22T19:07Z: with the device-name fix in place the mode READS
  // (640x480, the Microsoft Basic Display Adapter's fallback) and ChangeDisplaySettingsEx returns -2,
  // DISP_CHANGE_FAILED -- a basic adapter cannot do 1024x768. With the mode task running first, the play
  // failed there and the Intel driver install below it never ran: the one step that would have made the
  // mode settable. Workers 2-6, already on a problem-free Intel driver, passed the same task in the same
  // run, which is what makes this an ordering fault and not a second defect in the script.
  const modeAt = DISPLAY_TASK.indexOf("- name: The display mode the fleet pins");
  const installAt = DISPLAY_TASK.indexOf("- name: Install it silently");
  assert.ok(modeAt >= 0, "'The display mode the fleet pins' task is gone from display.yml");
  assert.ok(installAt >= 0, "the display-driver install task is gone from display.yml");
  assert.ok(modeAt > installAt,
    "display.yml must pin the display mode AFTER installing the display driver -- ordered the other way, "
    + "workers 7-11 fail the mode pin on a basic display adapter and never reach the install that fixes it");
});

/**
 * #4441 (part b of #4405): THE MODE IS RE-ASSERTED AT EVERY LOGON, NOT ONLY AT PROVISION.
 *
 * Every predicate below takes the text it reads, so each test runs it on the real file (positive control)
 * AND on a copy with exactly the one thing it asserts taken out (negative control). Text that merely
 * MENTIONS the thing is not the thing: the task's own comments name `type: logon` and `interactive_token`,
 * so a predicate over the raw block would be satisfied by prose. `registrationOf` drops comment lines first,
 * and the controls prove that matters -- deleting the trigger leaves its comment behind.
 */
const TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/tasks.yml", import.meta.url)), "utf8");
const LOGON_TASK = "a11y-display-mode-logon";

/** The named task's registration with its comment lines removed, so only what Ansible would read is left. */
function registrationOf(file: string, name: string): string {
  const at = file.indexOf(`- name: ${name}`);
  assert.notEqual(at, -1, `the task '${name}' is gone -- this test examines nothing`);
  const next = file.indexOf("\n- name: ", at + 1);
  const block = next === -1 ? file.slice(at) : file.slice(at, next);
  return block.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

const logonRegistration = (file: string): string => registrationOf(file, "Register the display-mode logon task");
const hasLogonTrigger = (text: string): boolean => /triggers:\s*\n\s*- type: logon\b/.test(text);
const invokesScript = (text: string): boolean => /set-display-mode\.ps1/.test(text);
const takesModeFromDefaults = (text: string): boolean =>
  /A11Y_DISPLAY_WIDTH = '\{\{\s*worker_display_mode\.width\s*\}\}'/.test(text)
  && /A11Y_DISPLAY_HEIGHT = '\{\{\s*worker_display_mode\.height\s*\}\}'/.test(text);
const isInteractiveToken = (text: string): boolean => /logon_type:\s*interactive_token\b/.test(text);
const surfacesTheExitCode = (text: string): boolean => /set-display-mode\.ps1'?;?\s+exit \$LASTEXITCODE/.test(text);

test("tasks.yml registers a LOGON-triggered task that invokes set-display-mode.ps1", () => {
  const real = logonRegistration(TASKS);
  assert.ok(real.includes(`name: ${LOGON_TASK}`), `the task must be named ${LOGON_TASK}`);
  assert.ok(hasLogonTrigger(real), "the task must carry a `type: logon` trigger -- without one it is the "
    + "provision-time one-shot over again, and a box that loses the mode stays off the pin");
  assert.ok(invokesScript(real), "the task must invoke set-display-mode.ps1");
  // Negative controls: each predicate must go red when its one thing is taken out.
  assert.ok(!hasLogonTrigger(real.replace("- type: logon", "- type: boot")), "the trigger check is vacuous");
  assert.ok(!hasLogonTrigger(real.replace(/triggers:[\s\S]*?(?=\n {4}\S)/, "")), "deleting the trigger block "
    + "must fail the trigger check even though the comments still say 'logon'");
  assert.ok(!invokesScript(real.replace(/set-display-mode\.ps1/g, "other.ps1")), "the script check is vacuous");
});

test("the logon task takes its width and height from worker_display_mode, never from literals", () => {
  const real = logonRegistration(TASKS);
  assert.ok(takesModeFromDefaults(real), "both A11Y_DISPLAY_WIDTH and A11Y_DISPLAY_HEIGHT must be templated "
    + "from worker_display_mode -- a literal here would move the environment with nothing hashing it");
  const { width, height } = displayMode();
  assert.doesNotMatch(real, new RegExp(`\\b(${width}|${height})\\b`),
    "the registration must not restate the pinned width or height");
  const literal = real.replace(/\{\{\s*worker_display_mode\.width\s*\}\}/, width);
  assert.ok(!takesModeFromDefaults(literal), "a literal width must fail the check -- it is vacuous");
  assert.ok(!takesModeFromDefaults(real.replace(/worker_display_mode\.height/, "worker_display_height")),
    "a height not read from worker_display_mode must fail the check -- it is vacuous");
});

test("the logon task is interactive_token, the logon type the display call needs", () => {
  // The display call fails outside the interactive window station (see this file's tests above and
  // display.yml's header), so any other logon type registers cleanly and fails at the first logon.
  const real = logonRegistration(TASKS);
  assert.ok(isInteractiveToken(real), "the logon task must be logon_type: interactive_token");
  assert.ok(!isInteractiveToken(real.replace("interactive_token", "service_account")), "the check is vacuous");
  assert.ok(!isInteractiveToken(real.replace(/ {4}logon_type:.*\n/, "")), "an absent logon_type must fail it");
});

test("the logon task SURFACES a failing read-back as a non-zero exit, never swallows it", () => {
  // set-display-mode.ps1 reads the mode back after writing it and `exit 1`s on a disagreement (asserted
  // in screenreader-fleet's display-mode.test.ts, #5350). `powershell.exe -Command` ends 0 unless told otherwise, so without `exit $LASTEXITCODE` the
  // task would report success for a box still off the pin.
  const real = logonRegistration(TASKS);
  assert.ok(surfacesTheExitCode(real), "the action must end with `exit $LASTEXITCODE` straight after the script");
  assert.ok(!surfacesTheExitCode(real.replace(/;\s+exit \$LASTEXITCODE/, "")), "the check is vacuous");
  assert.ok(!surfacesTheExitCode(real.replace(/exit \$LASTEXITCODE/, "exit 0")),
    "a hard-coded `exit 0` swallows the failure and must fail the check");
});

test("display.yml's provision-time task is still present: the logon task is ADDED, not swapped", () => {
  const oneShot = registrationOf(DISPLAY_TASK, "The display mode the fleet pins");
  const pinsAtProvision = (text: string): boolean =>
    /interactive_name:\s*a11y-display-mode\s*\n/.test(text) && invokesScript(text);
  assert.ok(pinsAtProvision(oneShot), "display.yml must still run set-display-mode.ps1 as the a11y-display-mode "
    + "one-shot -- the play needs the mode pinned before it moves on");
  assert.ok(!pinsAtProvision(oneShot.replace("interactive_name: a11y-display-mode", "interactive_name: gone")),
    "the one-shot check is vacuous");
  assert.notEqual(LOGON_TASK, "a11y-display-mode", "the two tasks must be different registrations");
  assert.ok(logonRegistration(TASKS).includes(LOGON_TASK), "and the logon task must be present beside it");
});

test("fleet:provision's report names the logon task, so its registration is printed", () => {
  const report = registrationOf(TASKS, "Report what was registered");
  const namesIt = (text: string): boolean => text.includes(`'${LOGON_TASK}'`);
  assert.ok(namesIt(report), "'Report what was registered' must read the logon task back");
  assert.ok(!namesIt(report.replace(LOGON_TASK, "other-task")), "the check is vacuous");
});

/**
 * EVERYTHING ABOVE THIS LINE READS THE SCRIPT AS TEXT, AND TEXT CANNOT ANSWER THE QUESTION BELOW.
 *
 * reviewer-2's blocker on #1968 at `a58c7e44`: the same-API positive control was in the file and did not
 * run. A textual assertion cannot tell "the control is written" from "the control ran" -- it is the same
 * distinction the first verdict named at `:204`, one level up. So these tests hand the real script to a
 * real PowerShell, with the one Windows API it needs replaced by a stub whose population is settable, and
 * read what it actually wrote. `display-mode-harness.ps1` carries the how and why.
 *
 * `pwsh` is REQUIRED, and these tests fail rather than skip when it is missing. A control that quietly
 * does not run is the exact defect this whole section exists to answer, and writing that defect into the
 * test for it would be the same mistake with a longer fuse. GitHub's ubuntu runners ship PowerShell 7.6.5,
 * so CI has it; `A11Y_PWSH` names a different binary where it is not on PATH.
 */
const PWSH = process.env.A11Y_PWSH ?? "pwsh";
const HARNESS = fileURLToPath(new URL("../../../worker-fleet/src/display-mode-harness.ps1", import.meta.url));
// The published package ships the script; the harness is NOT in any published version (see the report on #5374).
const SCRIPT_PATH = join(dirname(createRequire(import.meta.url).resolve("@a11ign/screenreader-fleet")), "..", "src", "provisioning", "set-display-mode.ps1");
// `Get-ModuleFunctionScriptBlock`, which returns a function's literal text from the PARSED file. Imported
// rather than retyped: a second copy of a predicate drifts from the first.
const AST_HELPERS = fileURLToPath(new URL(
  "../../ansible/collections/ansible_collections/a11y/worker/tests/unit/plugins/modules/TestHelpers.psm1",
  import.meta.url));

function pwsh(args: string[]): string {
  const run = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", ...args], { encoding: "utf8" });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    assert.fail(`no PowerShell at \`${PWSH}\`, and these tests do not skip without one. Install it (`
      + "`curl -sSL https://github.com/PowerShell/PowerShell/releases/latest` -> the linux-x64 tar.gz, "
      + "extracted anywhere) and either put `pwsh` on PATH or set A11Y_PWSH to the binary. The tests "
      + "below are the only thing here that can tell a control that RAN from one that was merely written");
  }
  assert.equal(run.status, 0, `${PWSH} exited ${run.status}:\n${run.stderr}`);
  return run.stdout;
}

interface Enumeration {
  name: string;
  nullDevices: number;
  namedDevices: number;
  primary: string | null;
  /** What `EnumDisplayDevices` was asked for at index 0, per call: `NULL` or the quoted device name. */
  askedFor: string[];
  lines: string[];
}

let harnessOutput: Enumeration[] | undefined;

/** Every scenario, run once -- the harness is one pwsh start, and four of them is three too many. */
function enumerations(): Enumeration[] {
  harnessOutput ??= JSON.parse(pwsh(
    ["-File", HARNESS, "-ScriptPath", SCRIPT_PATH, "-HelperModule", AST_HELPERS])) as Enumeration[];
  return harnessOutput;
}

function scenario(name: string): Enumeration {
  const found = enumerations().find((run) => run.name === name);
  assert.ok(found, `display-mode-harness.ps1 no longer runs a '${name}' scenario -- named explicitly so a `
    + "rename there fails loudly rather than silently testing nothing");
  return found!;
}

/** The number the script CLAIMED it enumerated, read back off its own output line. */
function claimed(run: Enumeration, unit: "adapter" | "monitor"): number | undefined {
  const claim = run.lines.map((line) => new RegExp(`enumerated (\\d+) ${unit}\\(s\\)`).exec(line))
    .find((match) => match !== null);
  return claim ? Number(claim[1]) : undefined;
}

test("set-display-mode.ps1 PARSES -- the whole file, under a real PowerShell", () => {
  // Found by running the thing: at `0c4f39b1d` this file had FOURTEEN parse errors and every test here
  // was green, because every test here matched text. `Write-Output ("a"` followed by a line starting
  // `+ "b"` is not a continuation in PowerShell -- a complete expression ends at the newline, so the
  // operator has to END the previous line. A script that cannot be parsed does nothing at all on a
  // worker, and the next fleet run is a poor place to learn that.
  const errors = pwsh(["-Command",
    "$parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("
    + `'${SCRIPT_PATH}', [ref] $null, [ref] $parseErrors); `
    + "$parseErrors | ForEach-Object { $_.ToString() }"]);
  assert.equal(errors.trim(), "",
    `set-display-mode.ps1 does not parse:\n${errors}\nNothing else in this file can catch that -- a `
    + "syntax error leaves every textual assertion here passing over a script Windows will refuse to run");
});

test("the nameless arm passes a REAL null, never PowerShell's empty string", () => {
  // PowerShell binds `$null` to a `string` parameter as `[string]::Empty`; only `[NullString]::Value`
  // sends a genuine NULL. That is what the stub records, so this is measured at the boundary rather than
  // inferred from the script's source. The previous version of this script asked every "default device"
  // question with `""` -- a device no machine has -- which is the cheaper explanation for the ten-host
  // failure that #1968's first telling missed entirely.
  for (const run of enumerations()) {
    assert.equal(run.askedFor[0], "NULL",
      `the '${run.name}' scenario asked EnumDisplayDevices for ${run.askedFor[0]} rather than NULL: the `
      + "nameless arm is asking about a device NAMED \"\", so the whole reading is about the wrong call");
  }
});

test("the count Write-DisplayDevices reports IS the count of devices it enumerated", () => {
  // reviewer-2's blocker, and the defect was worse than the report. `Get-EnumeratedDevices` returned
  // `,$lines` while the caller counted `@(...)`: PowerShell's unary comma emits the collection as ONE
  // pipeline object, so `.Count` was 1 for EVERY population -- measured 0 -> 1, 1 -> 1, 3 -> 1. The
  // non-empty case is the half no fleet reading can supply, because every real worker measured so far
  // enumerates nothing, which is exactly the population that cannot tell a broken counter from a good one.
  const many = scenario("nonEmptyNull");
  const deviceLines = many.lines.filter((line) => /^context: device\[/.test(line));
  assert.equal(deviceLines.length, many.nullDevices,
    `the stub gave ${many.nullDevices} devices and the script printed ${deviceLines.length} lines`);
  assert.equal(claimed(many, "adapter"), deviceLines.length,
    `the script printed ${deviceLines.length} device lines and claimed ${claimed(many, "adapter")}: a `
    + "count that crosses a function boundary as a collection is a count of the wrapper");
  assert.ok(!many.lines.some((line) => /enumerated NOTHING/.test(line)),
    "a non-empty enumeration must not also claim it found nothing");
});

test("the same-API control RUNS when the nameless enumeration comes back empty", () => {
  // The invariant blocker 2 asked for, asserted on behaviour: with the NULL arm empty, the NAMED arm has
  // to have been CALLED, and its own outcome has to reach the message. The old code returned before ever
  // reaching it, which is why "the control is in the file" was true and worthless.
  const empty = scenario("emptyNullAnsweringControl");
  assert.equal(empty.askedFor.length, 2,
    `the control did not run: EnumDisplayDevices was asked ${JSON.stringify(empty.askedFor)}, and an `
    + "empty population with no same-API control cannot tell an absent display from a refused call");
  assert.match(empty.askedFor[1]!, /DISPLAY1/,
    "the control has to be the SAME API given a device NAME -- a different API answers a different question");
  assert.equal(claimed(empty, "monitor"), empty.namedDevices,
    "the control's own outcome has to be the number it actually enumerated");
  assert.equal(claimed(empty, "adapter"), undefined,
    "an empty nameless enumeration must never report an adapter population -- that claim is the defect");
});

test("when the control refuses too, the script says so instead of claiming the stronger finding", () => {
  // The other half of the same invariant, and the one that keeps this honest: a refusing control means
  // the reading is about the FUNCTION, not about the argument, and over-claiming there is what the
  // should-fix on #1968 was about.
  const both = scenario("emptyNullRefusingControl");
  assert.equal(both.askedFor.length, 2, "the control must still be attempted when the NULL arm is empty");
  assert.ok(both.lines.some((line) => /the control refused too/.test(line)),
    `both arms enumerated nothing and the script wrote: ${JSON.stringify(both.lines)}`);

  const unnameable = scenario("emptyNullNoControlPossible");
  assert.equal(unnameable.askedFor.length, 1,
    "with no primary device name there is nothing to control WITH, so the named call must not be invented");
  assert.ok(unnameable.lines.some((line) => /no NAMED control could be run/.test(line)),
    `no control was possible and the script wrote: ${JSON.stringify(unnameable.lines)}`);
});

test("every empty-population claim in the harness output names the control's own outcome", () => {
  // The runtime twin of the textual invariant above: over the real output lines rather than the source.
  const claims = enumerations().flatMap((run) => run.lines.filter((line) => /enumerated NOTHING/.test(line)));
  assert.ok(claims.length > 0,
    "positive control for the loop below -- no scenario produced an empty-population claim at all, so "
    + "this test passes over nothing");
  for (const claim of claims) {
    assert.match(claim, /NAMED/,
      `this line claims an empty enumeration without naming the control's own outcome: ${claim}`);
  }
});
