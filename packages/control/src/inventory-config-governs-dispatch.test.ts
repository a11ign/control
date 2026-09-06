import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WRAPPER = readFileSync(join(import.meta.dirname, "fleet-playbook.mjs"), "utf8");
const CFG = readFileSync(join(import.meta.dirname, "../ansible/ansible.cfg"), "utf8");

/**
 * `ansible.cfg` MUST GOVERN THE INVENTORY ON THE PATH THAT ACTUALLY DISPATCHES.
 *
 * The config reads `/etc/a11ign/inventory.yml` first so the fleet definition survives a `git pull` — the
 * file is gitignored, and a pull on the control plane deleted it, after which `fleet:deploy` reached zero
 * hosts and exited 0.
 *
 * That fix was inert. The systemd unit passed `-i inventory.yml` on the command line, and an explicit `-i`
 * OVERRIDES the config entirely — so every playbook the wrapper dispatched read the in-tree path, the one
 * a pull removes. Measured minutes after installing and verifying the durable copy: still
 * `Unable to parse .../packages/control/ansible/inventory.yml`, still no hosts matched.
 *
 * **I had verified that config in four states with `ansible-inventory --list`, which reads the config.
 * The dispatch path does not.** A verification exercising a different invocation from the one that ships is
 * this repo's most-recorded defect, and this test is the part of the fix that keeps it fixed.
 */

test("the dispatched command does NOT pass -i, so the config's search order applies", () => {
  const dispatch = WRAPPER.split("\n").find((l) => l.includes("ansible-playbook") && l.includes("${chosen}"));
  assert.ok(dispatch, "could not find the dispatched ansible-playbook line; this test has gone blind");
  assert.doesNotMatch(dispatch, /\s-i\s/,
    "the dispatch passes -i, which OVERRIDES ansible.cfg — the durable /etc path would never be read, "
    + "which is the state that let a deploy reach zero hosts and exit 0");
});

test("and the config still names the durable path FIRST, or removing -i achieves nothing", () => {
  // The two halves only work together: no -i, and a config whose first source is outside the checkout.
  const line = CFG.split("\n").find((l) => /^inventory\s*=/.test(l)) ?? "";
  const sources = line.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(sources[0]?.startsWith("/"),
    `first inventory source is '${sources[0]}', which is inside the checkout a pull deletes`);
});

test("the BOOTSTRAP path is the deliberate exception and still passes its own -i", () => {
  // It cannot use the config: it targets the control plane by address precisely because the inventory is
  // missing there. Asserting this keeps the two paths distinguishable rather than looking inconsistent.
  assert.match(WRAPPER, /"-i", `root@\$\{CONTROL_PLANE\},`/,
    "the bootstrap must name its target on the command line — it runs when the inventory is absent");
});
