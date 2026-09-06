import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deployedToNothing } from "./fleet-playbook.mjs";

const ANSIBLE = join(import.meta.dirname, "../ansible");

/**
 * A DEPLOY TO NOTHING IS NOT A SUCCESSFUL DEPLOY, and ansible cannot tell you that.
 *
 * Measured 2026-09-06. The control plane's checkout pulled main; `inventory.yml` is untracked and
 * gitignored, so the pull DELETED it there. `fleet:deploy` then printed `skipping: no hosts matched` and
 * **exited 0**, and the wrapper reported completion. Ten workers untouched.
 *
 * Ansible's exit status answers "did the tasks I ran fail". With no hosts there are no tasks, so 0 is a
 * true answer to a question nobody asked — the shape this repo records more than any other, arriving in
 * the one command that puts code on the machines that produce all the evidence.
 *
 * The only thing that caught it was `worker:code` run out of habit. Without that the next capture would
 * have refused with `10 stale worker(s)`, an hour later, pointing at the fleet rather than at the deploy.
 */

test("the real log that exited 0 is refused, and names the inventory it could not parse", () => {
  const real = [
    "[WARNING]: Unable to parse /root/a11y-witness/packages/control/ansible/inventory.yml as an inventory source",
    "[WARNING]: No inventory was parsed, only implicit localhost is available",
    "[WARNING]: Could not match supplied host pattern, ignoring: a11y_workers",
    "PLAY [Deploy the worker code to the fleet]",
    "skipping: no hosts matched",
  ].join("\n");
  const why = String(deployedToNothing(real) ?? "");
  assert.ok(why, "the exact log that shipped nothing and exited 0 must be refused");
  assert.match(why, /inventory\.yml could not be parsed/);
  assert.match(why, /CONTROL PLANE/, "it must say WHICH machine, since the file is fine on the laptop");
});

test("each cause is named separately — they need different fixes", () => {
  // Unparseable, absent, and a pattern matching nothing are three causes of one silence. Collapsing them
  // into "no hosts" would leave the reader to guess which, which is what the message exists to prevent.
  assert.match(String(deployedToNothing("Could not match supplied host pattern, ignoring: a11y_workers\nskipping: no hosts matched")),
    /host pattern 'a11y_workers' matched nothing/);
  assert.match(String(deployedToNothing("No inventory was parsed\nprovided hosts list is empty")),
    /no inventory was parsed/);
  assert.match(String(deployedToNothing("skipping: no hosts matched")),
    /does not say why/, "an unexplained zero-host run is still refused, and says it is unexplained");
});

test("a healthy deploy is NOT refused", () => {
  // The half that makes the guard usable: a real run must pass, or it gets bypassed within a day.
  assert.equal(deployedToNothing("PLAY RECAP\na11y-worker-2 : ok=18 changed=5 unreachable=0 failed=0"), null);
  assert.equal(deployedToNothing(""), null);
  assert.equal(deployedToNothing(undefined as never), null);
});

/**
 * Playbooks that target `a11y_workers` and are dispatched somewhere OTHER than `fleet-playbook.mjs`, or
 * not at all. Declared so a NEW one cannot hide among them.
 *
 * My first version of the test below asserted that every such playbook must be named in the wrapper. That
 * premise is simply false — this repo has several dispatchers on purpose — and the test found four
 * playbooks one at a time while I widened an exemption list to accommodate a rule that was wrong. Naming
 * the dispatcher is the honest property; "must be in the wrapper" was me asserting a design that is not
 * the design.
 */
const DISPATCHED_ELSEWHERE: Record<string, string> = {
  "wake.yml": "`fleet:wake` runs it through `fleet-wake.mjs`, its own dispatcher.",
  "ssh-key.yml": "bootstrap, run once by hand when a box is first built; there is no fleet to be stale.",
  "restart.yml":
    "EXEMPT BY DESIGN, the same reason it is exempt from the busy-worker guard: it acts on a worker that "
    + "is busy AND wedged, so a refusal would block its only case.",
  "provision.yml":
    "SUPERSEDED — `fleet:provision` runs `provision-role.yml`. Kept while parity with the PowerShell path "
    + "is proven (`roles/worker/`'s README says not to delete either until then), reachable from no script.",
  "collect-logs.yml":
    "ORPHAN — no npm script runs it and no wrapper names it, so it cannot be dispatched at all. Wire it up "
    + "or delete it; that is a backlog row, not something to fix by widening this test.",
};

test("every a11y_workers playbook is dispatched by the wrapper (and so refuses) or is declared elsewhere", () => {
  const playbooks = readdirSync(ANSIBLE).filter((f) => f.endsWith(".yml"));
  const targeting = playbooks.filter((f) =>
    /^\s*hosts:\s*a11y_workers\s*$/m.test(readFileSync(join(ANSIBLE, f), "utf8")));
  // ANTI-VACUITY: a change to the `hosts:` spelling would make this examine nothing and pass.
  assert.ok(targeting.length >= 5,
    `only ${targeting.length} playbook(s) target a11y_workers; the scan has gone blind rather than the `
    + "fleet being small.");

  const wrapper = readFileSync(join(import.meta.dirname, "fleet-playbook.mjs"), "utf8");
  // The refusal must actually be wired into the wrapper, or "dispatched by the wrapper" proves nothing.
  assert.match(wrapper, /deployedToNothing\(outcome\.log\)/,
    "the wrapper must CALL the refusal; naming the playbooks is not the guard");

  const unaccounted = targeting
    .filter((f) => !new RegExp(f.replace(".", "\\.")).test(wrapper))
    .filter((f) => !(f in DISPATCHED_ELSEWHERE))
    .sort();
  assert.deepEqual(unaccounted, [],
    "these target the fleet, are not dispatched through the wrapper that refuses a zero-host run, and are "
    + "declared nowhere. Say which dispatcher runs each — a playbook nobody can name a runner for is one "
    + "that exits 0 having done nothing:\n  " + unaccounted.join("\n  "));
});

test("nothing is declared elsewhere that the wrapper actually dispatches", () => {
  // The stale half: an entry claiming another dispatcher, for a playbook the wrapper has since adopted,
  // would exempt it from the check it now passes.
  const wrapper = readFileSync(join(import.meta.dirname, "fleet-playbook.mjs"), "utf8");
  const wrongly = Object.keys(DISPATCHED_ELSEWHERE)
    .filter((f) => new RegExp(f.replace(".", "\\.")).test(wrapper)).sort();
  assert.deepEqual(wrongly, [],
    "these are declared as dispatched elsewhere but the wrapper names them; delete the entry: " + wrongly.join(", "));
});
