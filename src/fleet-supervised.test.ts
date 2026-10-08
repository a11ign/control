/**
 * A TEN-MACHINE REBOOT MUST NOT BE ONLY AS DURABLE AS THE TERMINAL THAT STARTED IT.
 *
 * `fleet:deploy` ran `ssh ... ansible-playbook` synchronously, so any caller dying mid-run took the
 * deploy with it. Measured 2026-09-05: the caller was killed 100 s in, ssh closed, ansible took SIGHUP
 * mid-`Reboot`, and the fleet was left SPLIT with no PLAY RECAP and no record that a deploy had been
 * interrupted.
 *
 * The remedy is the one this repo already uses twice and never applied here — `run-job.yml` for lab jobs
 * and `tailscale.yml` for the login, whose comment states the rule outright: "the work must outlive the
 * connection that started it". This pins that it is applied, because the failure it prevents is invisible
 * until a fleet is already half-deployed.
 *
 * Source text, with the anti-vacuity guard that requires: the deploy path cannot be exercised without a
 * control plane and ten machines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(import.meta.dirname, "./fleet-playbook.mjs"), "utf8")
  // Comments stripped: every claim below is also EXPLAINED in prose directly above the code that makes
  // it, so matching raw source would match the explanation and pass with the code removed. Three guards
  // written today had exactly that defect and one passed with its subject deleted.
  .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("the playbook is started as a supervised unit, not in the foreground", () => {
  assert.ok(SOURCE.includes("ansible-playbook"),
    "fleet-playbook.mjs no longer runs ansible-playbook -- this test examines nothing");
  assert.match(SOURCE, /systemd-run\s+--unit=/,
    "the playbook must be started with `systemd-run --unit=`, so a dead caller cannot kill a ten-machine "
    + "reboot. It ran in the foreground once and left the fleet split with no record.");
  assert.ok(SOURCE.includes("--remain-after-exit"),
    "`--remain-after-exit`, never `--collect`: without it the exit code is discarded at the moment it "
    + "matters, which lab-job.test.ts pins for the same reason");
});

test("the unit name is cleared before reuse, or systemd-run refuses it", () => {
  // A SUCCEEDED unit keeps its name just as a failed one does, so `reset-failed` alone is not enough and
  // neither is `stop` alone. tailscale.yml's comment records the same discovery.
  assert.ok(SOURCE.includes("systemctl stop") && SOURCE.includes("reset-failed"),
    "both `systemctl stop` and `reset-failed` must precede systemd-run, or a second deploy fails on the "
    + "name the first one left loaded");
});

test("completion is decided by SubState LEAVING running, never by equalling a terminal value", () => {
  // A unit has several terminal SubStates -- exited, failed, dead -- and which one you get depends on how
  // it ended and whether anything reaped it. Two waiters written an hour apart both hung indefinitely on
  // finished jobs by polling for the values their authors thought of. lab-job.test.ts pins the rule; this
  // pins that the fleet path follows it.
  assert.match(SOURCE, /!==\s*"running"/,
    "the follower must wait for SubState to LEAVE `running`. Polling for `exited` or `exited|failed` "
    + "hangs forever on a unit that ended any other way.");
  assert.ok(SOURCE.includes("ExecMainStatus"),
    "the deploy's own exit status must be read from the unit, not inferred from the launcher -- "
    + "systemd-run returns 0 the moment it starts something");
});

test("giving up watching is not the same as stopping the deploy, and says so", () => {
  // The budget bounds THIS COMMAND, not the unit. Reporting a timeout as a failed deploy would send an
  // operator to re-run something still running, which is how a fleet gets two deploys at once.
  assert.match(SOURCE, /STILL RUNNING|has NOT been stopped/,
    "on timeout the message must distinguish `this command gave up watching` from `the deploy failed`");
});
